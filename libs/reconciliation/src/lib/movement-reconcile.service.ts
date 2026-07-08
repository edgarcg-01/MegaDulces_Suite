import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * SM.1 — Motor de reconciliación del Supervisor de Movimientos (ADR-029).
 *
 * Detectores DETERMINISTAS (SQL, sin LLM) que leen data curada (analytics.*) y
 * producen descuadres idempotentes (UPSERT por dedup_key) en
 * `reconciliation.discrepancies`. `ensureRules` sincroniza el catálogo desde el
 * código PRESERVANDO la calibración humana (params/enabled/pinned/precision). El
 * aprendizaje L2 (auto-supresión por precisión) lo aplica ReconciliationFindingsService.
 *
 * SM.1 = Plano CAJA (2 reglas). SM.2/SM.3 agregan inventario y cruces.
 * analytics.cash_cuts NO tiene RLS → filtro tenant_id EXPLÍCITO.
 */

interface RuleMeta {
  rule_key: string;
  nombre: string;
  descripcion: string;
  plano: 'inventario' | 'caja' | 'cruce';
  params: Record<string, any>;
}

interface RawDiscrepancy {
  rule_key: string;
  plano: 'inventario' | 'caja' | 'cruce';
  severity: 'info' | 'warn' | 'critical';
  score: number;
  titulo: string;
  resumen: string;
  entity: Record<string, any>;
  periodo: string | null;
  esperado: number | null;
  observado: number | null;
  diferencia: number | null;
  importe: number;
  causa_probable: string | null;
  evidencia: Record<string, any>;
  dedup_key: string;
}

const RULES: RuleMeta[] = [
  {
    rule_key: 'caja_descuadre', plano: 'caja',
    nombre: 'Descuadre de caja', descripcion: 'Corte de caja con diferencia entre efectivo esperado y contado (arqueo) por encima del umbral.',
    params: { umbral: 50, critico: 5000 },
  },
  {
    rule_key: 'cajero_faltante_recurrente', plano: 'caja',
    nombre: 'Faltantes recurrentes por cajero', descripcion: 'Un cajero acumula varios cortes con faltante en una ventana — patrón, no evento aislado.',
    params: { ventana_dias: 30, min_eventos: 3, min_falta: 50, critico_suma: 10000 },
  },
  {
    rule_key: 'descuadre_no_efectivo', plano: 'caja',
    nombre: 'Descuadre tarjeta / transferencia', descripcion: 'Corte con diferencia entre esperado y contado en tarjeta o transferencia por encima del umbral — descuadre que no es de efectivo y hoy pasaría inadvertido.',
    params: { umbral: 50, critico: 2000 },
  },
  {
    rule_key: 'arqueo_no_ciego', plano: 'caja',
    nombre: 'Arqueo no ciego (cuadre exacto sospechoso)', descripcion: 'Un cajero/sucursal cierra la mayoría de sus cortes con contado idéntico al esperado al centavo sobre montos altos — señal de que el conteo no es a ciegas y el "cuadre" no verifica nada.',
    params: { min_monto: 3000, min_cortes: 5, pct_exacto: 0.9 },
  },
  {
    rule_key: 'corte_riesgo_circunstancia', plano: 'caja',
    nombre: 'Corte de riesgo por circunstancia', descripcion: 'Corte que cuadró exacto (posible enmascaramiento) en la circunstancia de mayor riesgo medida: cambio de cajero (abre≠cierra) + turno largo (≥umbral h, donde el descuadre real dobla al normal). Lista corta para auditar a mano — el diff $0 no lo garantiza.',
    params: { min_monto: 5000, shift_largo_h: 10 },
  },
  {
    rule_key: 'arqueo_ciego_divergente', plano: 'caja',
    nombre: 'Arqueo ciego divergente', descripcion: 'El conteo físico capturado a ciegas difiere del efectivo esperado por encima del umbral — el descuadre REAL, independiente del contado de Kepler. Crítico cuando Kepler reportó el corte como cuadrado (enmascaramiento confirmado).',
    params: { umbral: 50, critico: 1000 },
  },
  {
    rule_key: 'merma_inventario', plano: 'inventario',
    nombre: 'Merma / ajuste de salida alto', descripcion: 'Salidas por ajuste/destrucción (merma) del kardex acumuladas por SKU×sucursal×mes por encima del umbral — inventario que sale sin venta.',
    params: { min_monto: 5000, critico: 100000 },
  },
];

const money = (n: number) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

@Injectable()
export class MovementReconcileService {
  private readonly logger = new Logger(MovementReconcileService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private async ensureRules(trx: any, tenantId: string) {
    for (const r of RULES) {
      await trx('reconciliation.rule_registry')
        .insert({ tenant_id: tenantId, rule_key: r.rule_key, nombre: r.nombre, descripcion: r.descripcion, plano: r.plano, params: JSON.stringify(r.params) })
        .onConflict(['tenant_id', 'rule_key'])
        .merge({ nombre: r.nombre, descripcion: r.descripcion, plano: r.plano, updated_at: trx.fn.now() });
    }
  }

  /** Corre los detectores habilitados y no suprimidos; UPSERT idempotente por dedup_key. */
  async scanAll(source = 'manual') {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      await this.ensureRules(trx, tenantId);
      const rules = await trx('reconciliation.rule_registry')
        .where({ tenant_id: tenantId, enabled: true, suppressed_auto: false })
        .select('rule_key', 'plano', 'params');

      const summary: { rule_key: string; nuevos: number; total: number }[] = [];
      const nuevosCriticos: { rule_key: string; titulo: string; importe: number }[] = [];
      let totalNuevos = 0;

      for (const rule of rules) {
        const params = typeof rule.params === 'string' ? JSON.parse(rule.params) : (rule.params || {});
        let found: RawDiscrepancy[] = [];
        try {
          found = await this.runDetector(rule.rule_key, trx, tenantId, params);
        } catch (e: any) {
          this.logger.warn(`Detector ${rule.rule_key} falló: ${e?.message || e}`);
          continue;
        }
        let nuevos = 0;
        for (const d of found) {
          const res = await trx.raw(
            `INSERT INTO reconciliation.discrepancies
               (tenant_id, rule_key, plano, severity, status, score, titulo, resumen, entity, periodo,
                esperado, observado, diferencia, importe, causa_probable, evidencia, dedup_key,
                first_seen, last_seen, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'nuevo', ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, now(), now(), now(), now())
             ON CONFLICT (tenant_id, dedup_key) DO UPDATE
               SET last_seen = now(), importe = EXCLUDED.importe, resumen = EXCLUDED.resumen,
                   severity = EXCLUDED.severity, esperado = EXCLUDED.esperado, observado = EXCLUDED.observado,
                   diferencia = EXCLUDED.diferencia, evidencia = EXCLUDED.evidencia, score = EXCLUDED.score, updated_at = now()
             RETURNING (xmax = 0) AS is_insert`,
            [tenantId, d.rule_key, d.plano, d.severity, d.score, d.titulo, d.resumen, JSON.stringify(d.entity),
              d.periodo, d.esperado, d.observado, d.diferencia, d.importe, d.causa_probable, JSON.stringify(d.evidencia), d.dedup_key],
          );
          if (res.rows?.[0]?.is_insert) {
            nuevos++;
            if (d.severity === 'critical') nuevosCriticos.push({ rule_key: d.rule_key, titulo: d.titulo, importe: d.importe });
          }
        }
        const total = Number((await trx('reconciliation.discrepancies').where({ tenant_id: tenantId, rule_key: rule.rule_key }).count('* as c').first())?.c || 0);
        summary.push({ rule_key: rule.rule_key, nuevos, total });
        totalNuevos += nuevos;
      }
      this.logger.log(`scan (${source}): ${totalNuevos} nuevos descuadres`);
      return { source, total_nuevos: totalNuevos, nuevos_criticos: nuevosCriticos, por_regla: summary };
    });
  }

  private async runDetector(ruleKey: string, trx: any, tenantId: string, params: any): Promise<RawDiscrepancy[]> {
    switch (ruleKey) {
      case 'caja_descuadre': return this.detCajaDescuadre(trx, tenantId, params);
      case 'cajero_faltante_recurrente': return this.detCajeroRecurrente(trx, tenantId, params);
      case 'descuadre_no_efectivo': return this.detDescuadreNoEfectivo(trx, tenantId, params);
      case 'arqueo_no_ciego': return this.detArqueoNoCiego(trx, tenantId, params);
      case 'corte_riesgo_circunstancia': return this.detCorteRiesgoCircunstancia(trx, tenantId, params);
      case 'arqueo_ciego_divergente': return this.detArqueoCiegoDivergente(trx, tenantId, params);
      case 'merma_inventario': return this.detMermaInventario(trx, tenantId, params);
      default: return [];
    }
  }

  /** Cada corte con |efectivo_diff| ≥ umbral. + faltante / − sobrante. */
  private async detCajaDescuadre(trx: any, tenantId: string, params: any): Promise<RawDiscrepancy[]> {
    const umbral = Number(params.umbral) || 50;
    const critico = Number(params.critico) || 5000;
    const rows = await trx('analytics.cash_cuts as cc')
      .where('cc.tenant_id', tenantId)
      .leftJoin('analytics.pos_cashiers as pc', (j: any) => j.on('pc.tenant_id', '=', 'cc.tenant_id').andOn('pc.warehouse_code', '=', 'cc.warehouse_code').andOn('pc.cajero_code', '=', 'cc.cajero_cierre'))
      .whereRaw('abs(cc.efectivo_diff) >= ?', [umbral])
      .select('cc.warehouse_code', 'cc.warehouse_name', 'cc.caja', 'cc.folio', 'cc.business_date',
        'cc.cajero_cierre', trx.raw('pc.nombre AS cajero_nombre'), 'cc.efectivo_esperado', 'cc.efectivo_contado', 'cc.efectivo_diff')
      .orderByRaw('abs(cc.efectivo_diff) DESC')
      .limit(1000);
    return rows.map((r: any) => {
      const diff = Number(r.efectivo_diff);
      const abs = Math.abs(diff);
      const faltante = diff > 0; // esperado − contado > 0 = falta dinero
      const cajero = r.cajero_nombre || r.cajero_cierre || '?';
      const fecha = r.business_date instanceof Date ? r.business_date.toISOString().slice(0, 10) : String(r.business_date).slice(0, 10);
      return {
        rule_key: 'caja_descuadre', plano: 'caja' as const,
        severity: abs >= critico ? 'critical' as const : 'warn' as const,
        score: Math.min(1, abs / (critico * 2)),
        titulo: `${faltante ? 'Faltante' : 'Sobrante'} de caja ${money(abs)} — suc ${r.warehouse_code} caja ${r.caja}`,
        resumen: `Corte ${fecha} (cajero ${cajero}): esperado ${money(Number(r.efectivo_esperado))} vs contado ${money(Number(r.efectivo_contado))}.`,
        entity: { sucursal: r.warehouse_code, sucursal_nombre: r.warehouse_name, caja: r.caja, cajero: r.cajero_cierre, cajero_nombre: r.cajero_nombre, folio: r.folio, fecha },
        periodo: fecha,
        esperado: Number(r.efectivo_esperado), observado: Number(r.efectivo_contado), diferencia: diff,
        importe: abs,
        causa_probable: faltante ? 'faltante_caja' : 'sobrante_caja',
        evidencia: { params: { umbral, critico }, corte: { folio: r.folio, esperado: Number(r.efectivo_esperado), contado: Number(r.efectivo_contado), diff } },
        dedup_key: `caja_descuadre:${r.warehouse_code}:${r.caja}:${fecha}:${r.folio}`,
      };
    });
  }

  /** Cajero con ≥min_eventos cortes con faltante ≥min_falta en la ventana. */
  private async detCajeroRecurrente(trx: any, tenantId: string, params: any): Promise<RawDiscrepancy[]> {
    const ventana = Number(params.ventana_dias) || 30;
    const minEventos = Number(params.min_eventos) || 3;
    const minFalta = Number(params.min_falta) || 50;
    const criticoSuma = Number(params.critico_suma) || 10000;
    const rows = await trx('analytics.cash_cuts as cc')
      .where('cc.tenant_id', tenantId)
      .leftJoin('analytics.pos_cashiers as pc', (j: any) => j.on('pc.tenant_id', '=', 'cc.tenant_id').andOn('pc.warehouse_code', '=', 'cc.warehouse_code').andOn('pc.cajero_code', '=', 'cc.cajero_cierre'))
      .whereNotNull('cc.cajero_cierre')
      .whereRaw('cc.business_date >= (CURRENT_DATE - (? || \' days\')::interval)', [ventana])
      .whereRaw('cc.efectivo_diff >= ?', [minFalta]) // solo faltantes
      .groupBy('cc.warehouse_code', 'cc.cajero_cierre', 'pc.nombre')
      .havingRaw('count(*) >= ?', [minEventos])
      .select('cc.warehouse_code', 'cc.cajero_cierre', trx.raw('pc.nombre AS cajero_nombre'),
        trx.raw('count(*)::int AS eventos'),
        trx.raw('ROUND(SUM(cc.efectivo_diff)::numeric,2) AS suma_falta'),
        trx.raw('ROUND(MAX(cc.efectivo_diff)::numeric,2) AS max_falta'));
    const periodo = (new Date().toISOString().slice(0, 7));
    return rows.map((r: any) => {
      const suma = Number(r.suma_falta);
      const eventos = Number(r.eventos);
      const cajero = r.cajero_nombre || r.cajero_cierre;
      return {
        rule_key: 'cajero_faltante_recurrente', plano: 'caja' as const,
        severity: suma >= criticoSuma ? 'critical' as const : 'warn' as const,
        score: Math.min(1, suma / (criticoSuma * 2)),
        titulo: `Faltantes recurrentes: cajero ${cajero} (suc ${r.warehouse_code}) — ${eventos} cortes, ${money(suma)}`,
        resumen: `${eventos} cortes con faltante en ${ventana} días (mayor ${money(Number(r.max_falta))}). Patrón a revisar.`,
        entity: { sucursal: r.warehouse_code, cajero: r.cajero_cierre, cajero_nombre: r.cajero_nombre, eventos },
        periodo,
        esperado: null, observado: null, diferencia: suma,
        importe: suma,
        causa_probable: 'faltante_recurrente',
        evidencia: { params: { ventana, minEventos, minFalta }, eventos, suma_falta: suma, max_falta: Number(r.max_falta) },
        dedup_key: `cajero_faltante_recurrente:${r.warehouse_code}:${r.cajero_cierre}:${periodo}`,
      };
    });
  }

  /** Corte con descuadre de tarjeta o transferencia ≥ umbral (una fila por forma que descuadra). */
  private async detDescuadreNoEfectivo(trx: any, tenantId: string, params: any): Promise<RawDiscrepancy[]> {
    const umbral = Number(params.umbral) || 50;
    const critico = Number(params.critico) || 2000;
    const rows = await trx('analytics.cash_cuts as cc')
      .where('cc.tenant_id', tenantId)
      .leftJoin('analytics.pos_cashiers as pc', (j: any) => j.on('pc.tenant_id', '=', 'cc.tenant_id').andOn('pc.warehouse_code', '=', 'cc.warehouse_code').andOn('pc.cajero_code', '=', 'cc.cajero_cierre'))
      .whereRaw('(abs(cc.tarjeta_diff) >= ? OR abs(cc.transfer_diff) >= ?)', [umbral, umbral])
      .select('cc.warehouse_code', 'cc.warehouse_name', 'cc.caja', 'cc.folio', 'cc.business_date', 'cc.cajero_cierre', trx.raw('pc.nombre AS cajero_nombre'),
        'cc.tarjeta_esperado', 'cc.tarjeta_contado', 'cc.tarjeta_diff', 'cc.transfer_esperado', 'cc.transfer_contado', 'cc.transfer_diff')
      .orderByRaw('greatest(abs(cc.tarjeta_diff), abs(cc.transfer_diff)) DESC')
      .limit(1000);
    const out: RawDiscrepancy[] = [];
    for (const r of rows) {
      const cajero = r.cajero_nombre || r.cajero_cierre || '?';
      const fecha = r.business_date instanceof Date ? r.business_date.toISOString().slice(0, 10) : String(r.business_date).slice(0, 10);
      for (const forma of ['tarjeta', 'transfer'] as const) {
        const diff = Number(r[`${forma}_diff`]);
        const abs = Math.abs(diff);
        if (abs < umbral) continue;
        const label = forma === 'tarjeta' ? 'Tarjeta' : 'Transferencia';
        const faltante = diff > 0;
        out.push({
          rule_key: 'descuadre_no_efectivo', plano: 'caja',
          severity: abs >= critico ? 'critical' : 'warn',
          score: Math.min(1, abs / (critico * 2)),
          titulo: `${label}: ${faltante ? 'faltante' : 'sobrante'} ${money(abs)} — suc ${r.warehouse_code} caja ${r.caja}`,
          resumen: `Corte ${fecha} (cajero ${cajero}): ${label.toLowerCase()} esperado ${money(Number(r[`${forma}_esperado`]))} vs contado ${money(Number(r[`${forma}_contado`]))}.`,
          entity: { sucursal: r.warehouse_code, sucursal_nombre: r.warehouse_name, caja: r.caja, cajero: r.cajero_cierre, cajero_nombre: r.cajero_nombre, folio: r.folio, fecha, forma },
          periodo: fecha,
          esperado: Number(r[`${forma}_esperado`]), observado: Number(r[`${forma}_contado`]), diferencia: diff,
          importe: abs,
          causa_probable: `descuadre_${forma}`,
          evidencia: { params: { umbral, critico }, forma, esperado: Number(r[`${forma}_esperado`]), contado: Number(r[`${forma}_contado`]), diff },
          dedup_key: `descuadre_no_efectivo:${r.warehouse_code}:${r.caja}:${fecha}:${r.folio}:${forma}`,
        });
      }
    }
    return out;
  }

  /** Cajero×sucursal×mes que cierra ≥pct de sus cortes con contado==esperado exacto sobre montos altos. */
  private async detArqueoNoCiego(trx: any, tenantId: string, params: any): Promise<RawDiscrepancy[]> {
    const minMonto = Number(params.min_monto) || 3000;
    const minCortes = Number(params.min_cortes) || 5;
    const pct = Number(params.pct_exacto) || 0.9;
    const rows = await trx('analytics.cash_cuts as cc')
      .where('cc.tenant_id', tenantId)
      .leftJoin('analytics.pos_cashiers as pc', (j: any) => j.on('pc.tenant_id', '=', 'cc.tenant_id').andOn('pc.warehouse_code', '=', 'cc.warehouse_code').andOn('pc.cajero_code', '=', 'cc.cajero_cierre'))
      .whereNotNull('cc.cajero_cierre')
      .whereRaw('cc.efectivo_esperado >= ?', [minMonto])
      .groupBy('cc.warehouse_code', 'cc.cajero_cierre', 'pc.nombre')
      .groupByRaw("to_char(cc.business_date,'YYYY-MM')")
      .havingRaw('count(*) >= ?', [minCortes])
      .havingRaw('avg((cc.efectivo_diff = 0)::int) >= ?', [pct])
      .select('cc.warehouse_code', 'cc.cajero_cierre', trx.raw('pc.nombre AS cajero_nombre'),
        trx.raw("to_char(cc.business_date,'YYYY-MM') AS periodo"),
        trx.raw('count(*)::int AS cortes'),
        trx.raw('count(*) FILTER (WHERE cc.efectivo_diff = 0)::int AS exactos'),
        trx.raw('ROUND(AVG(cc.efectivo_esperado)::numeric,2) AS monto_prom'));
    return rows.map((r: any) => {
      const cortes = Number(r.cortes);
      const exactos = Number(r.exactos);
      const ratio = cortes ? exactos / cortes : 0;
      const montoProm = Number(r.monto_prom);
      const cajero = r.cajero_nombre || r.cajero_cierre;
      return {
        rule_key: 'arqueo_no_ciego', plano: 'caja' as const,
        severity: ratio >= 0.98 ? 'critical' as const : 'warn' as const,
        score: ratio,
        titulo: `Arqueo no ciego: cajero ${cajero} (suc ${r.warehouse_code}) — ${exactos}/${cortes} cortes cuadran exacto`,
        resumen: `En ${r.periodo}, ${Math.round(ratio * 100)}% de los cortes (monto prom. ${money(montoProm)}) cerraron con contado idéntico al esperado al centavo. El conteo no parece a ciegas — el "cuadre" no está verificando el efectivo.`,
        entity: { sucursal: r.warehouse_code, cajero: r.cajero_cierre, cajero_nombre: r.cajero_nombre, cortes, exactos },
        periodo: r.periodo,
        esperado: null, observado: null, diferencia: null,
        importe: 0,
        causa_probable: 'arqueo_no_ciego',
        evidencia: { params: { min_monto: minMonto, min_cortes: minCortes, pct_exacto: pct }, cortes, exactos, ratio: Math.round(ratio * 100) / 100, monto_promedio: montoProm },
        dedup_key: `arqueo_no_ciego:${r.warehouse_code}:${r.cajero_cierre}:${r.periodo}`,
      };
    });
  }

  /** Corte cuadrado-exacto en circunstancia de riesgo (cambio cajero + turno largo o cierre en cambio de turno). */
  private async detCorteRiesgoCircunstancia(trx: any, tenantId: string, params: any): Promise<RawDiscrepancy[]> {
    const minMonto = Number(params.min_monto) || 5000;
    const shiftLargo = Number(params.shift_largo_h) || 10;
    const rows = await trx('analytics.cash_cuts as cc')
      .where('cc.tenant_id', tenantId)
      .leftJoin('analytics.pos_cashiers as pc', (j: any) => j.on('pc.tenant_id', '=', 'cc.tenant_id').andOn('pc.warehouse_code', '=', 'cc.warehouse_code').andOn('pc.cajero_code', '=', 'cc.cajero_cierre'))
      .whereRaw('cc.efectivo_diff = 0')                       // cuadró exacto (posible enmascaramiento)
      .whereRaw('cc.efectivo_esperado >= ?', [minMonto])
      .whereRaw('cc.cajero_apertura IS DISTINCT FROM cc.cajero_cierre')  // cambio de cajero
      .whereRaw('cc.duracion_horas >= ?', [shiftLargo])        // turno largo (driver medido)
      .select('cc.warehouse_code', 'cc.warehouse_name', 'cc.caja', 'cc.folio', 'cc.business_date', 'cc.cajero_apertura',
        'cc.cajero_cierre', trx.raw('pc.nombre AS cajero_nombre'), 'cc.efectivo_esperado', 'cc.hora_cierre', 'cc.duracion_horas')
      .orderBy('cc.efectivo_esperado', 'desc')
      .limit(300);
    return rows.map((r: any) => {
      const monto = Number(r.efectivo_esperado);
      const dur = r.duracion_horas != null ? Number(r.duracion_horas) : null;
      const cajero = r.cajero_nombre || r.cajero_cierre || '?';
      const fecha = r.business_date instanceof Date ? r.business_date.toISOString().slice(0, 10) : String(r.business_date).slice(0, 10);
      const factores = [
        'cuadre exacto',
        'cambio de cajero',
        ...(dur != null && dur >= shiftLargo ? [`turno ${dur}h`] : []),
        ...(r.hora_cierre ? [`cierre ${String(r.hora_cierre).slice(0, 5)}`] : []),
      ];
      return {
        rule_key: 'corte_riesgo_circunstancia', plano: 'caja' as const,
        severity: 'warn' as const,
        score: Math.min(1, monto / 100000),
        titulo: `Corte a auditar ${money(monto)} — suc ${r.warehouse_code} caja ${r.caja} (${fecha})`,
        resumen: `Cerró exacto (${cajero}) en circunstancia de riesgo: ${factores.join(' · ')}. El diff $0 no lo garantiza — auditar arqueo real.`,
        entity: { sucursal: r.warehouse_code, sucursal_nombre: r.warehouse_name, caja: r.caja, cajero: r.cajero_cierre, cajero_nombre: r.cajero_nombre, abrio: r.cajero_apertura, folio: r.folio, fecha },
        periodo: fecha,
        esperado: monto, observado: monto, diferencia: 0,
        importe: monto,
        causa_probable: 'arqueo_no_ciego',
        evidencia: { params: { min_monto: minMonto, shift_largo_h: shiftLargo }, hora_cierre: r.hora_cierre, duracion_horas: dur, factores },
        dedup_key: `corte_riesgo_circunstancia:${r.warehouse_code}:${r.caja}:${fecha}:${r.folio}`,
      };
    });
  }

  /** Arqueo ciego vs esperado de Kepler: el descuadre REAL. Crítico si Kepler lo reportó cuadrado. */
  private async detArqueoCiegoDivergente(trx: any, tenantId: string, params: any): Promise<RawDiscrepancy[]> {
    const umbral = Number(params.umbral) || 50;
    const critico = Number(params.critico) || 1000;
    const rows = await trx('reconciliation.blind_counts as bc')
      .join('analytics.cash_cuts as cc', function (this: any) {
        this.on('cc.tenant_id', '=', 'bc.tenant_id').andOn('cc.warehouse_code', '=', 'bc.warehouse_code')
          .andOn('cc.caja', '=', 'bc.caja').andOn('cc.business_date', '=', 'bc.business_date')
          .andOn(trx.raw('cc.cajero_cierre IS NOT DISTINCT FROM bc.cajero_code'));
      })
      .leftJoin('analytics.pos_cashiers as pc', function (this: any) {
        this.on('pc.tenant_id', '=', 'bc.tenant_id').andOn('pc.warehouse_code', '=', 'bc.warehouse_code').andOn('pc.cajero_code', '=', 'bc.cajero_code');
      })
      .whereRaw('abs(cc.efectivo_esperado - bc.total_contado) >= ?', [umbral])
      .select('bc.warehouse_code', 'cc.warehouse_name', 'bc.caja', 'cc.folio', 'bc.business_date', 'bc.cajero_code',
        trx.raw('pc.nombre AS cajero_nombre'), trx.raw('bc.total_contado::numeric AS contado_ciego'),
        trx.raw('cc.efectivo_esperado::numeric AS esperado'), trx.raw('cc.efectivo_diff::numeric AS kepler_diff'))
      .limit(1000);
    return rows.map((r: any) => {
      const esperado = Number(r.esperado);
      const contadoCiego = Number(r.contado_ciego);
      const diffReal = Math.round((esperado - contadoCiego) * 100) / 100;
      const abs = Math.abs(diffReal);
      const keplerDiff = Number(r.kepler_diff);
      const enmascaro = Math.abs(keplerDiff) < umbral;   // Kepler dijo cuadrado
      const faltante = diffReal > 0;
      const cajero = r.cajero_nombre || r.cajero_code || '?';
      const fecha = r.business_date instanceof Date ? r.business_date.toISOString().slice(0, 10) : String(r.business_date).slice(0, 10);
      return {
        rule_key: 'arqueo_ciego_divergente', plano: 'caja' as const,
        severity: (enmascaro || abs >= critico) ? 'critical' as const : 'warn' as const,
        score: Math.min(1, abs / (critico * 2)),
        titulo: `Arqueo ciego: ${faltante ? 'faltan' : 'sobran'} ${money(abs)} — suc ${r.warehouse_code} caja ${r.caja}${enmascaro ? ' (Kepler lo dio por cuadrado)' : ''}`,
        resumen: `Corte ${fecha} (${cajero}): conteo ciego ${money(contadoCiego)} vs esperado ${money(esperado)} = ${faltante ? 'faltante' : 'sobrante'} real ${money(abs)}.${enmascaro ? ` Kepler reportó diff ${money(keplerDiff)} — el arqueo ciego destapa lo que el corte ocultó.` : ''}`,
        entity: { sucursal: r.warehouse_code, sucursal_nombre: r.warehouse_name, caja: r.caja, cajero: r.cajero_code, cajero_nombre: r.cajero_nombre, folio: r.folio, fecha },
        periodo: fecha,
        esperado, observado: contadoCiego, diferencia: diffReal,
        importe: abs,
        causa_probable: enmascaro ? 'arqueo_no_ciego' : (faltante ? 'faltante_caja' : 'sobrante_caja'),
        evidencia: { params: { umbral, critico }, contado_ciego: contadoCiego, esperado, kepler_diff: keplerDiff, kepler_enmascaro: enmascaro },
        dedup_key: `arqueo_ciego_divergente:${r.warehouse_code}:${r.caja}:${fecha}:${r.folio}`,
      };
    });
  }

  /** Merma (salida por ajuste/destrucción) acumulada por SKU×sucursal×mes ≥ umbral. */
  private async detMermaInventario(trx: any, tenantId: string, params: any): Promise<RawDiscrepancy[]> {
    const minMonto = Number(params.min_monto) || 5000;
    const critico = Number(params.critico) || 100000;
    const rows = await trx('analytics.stock_ledger')
      .where('tenant_id', tenantId)
      .where('clase_mov', 'merma')
      .groupBy('warehouse_code', 'sku')
      .groupByRaw("to_char(fecha,'YYYY-MM')")
      .havingRaw('SUM(importe) >= ?', [minMonto])
      .select('warehouse_code', 'sku',
        trx.raw("to_char(fecha,'YYYY-MM') AS periodo"),
        trx.raw('COUNT(*)::int AS movs'),
        trx.raw('ROUND(SUM(importe)::numeric,2) AS monto'),
        trx.raw('ROUND(SUM(unidades)::numeric,2) AS unidades'))
      .orderByRaw('SUM(importe) DESC')
      .limit(500);
    return rows.map((r: any) => {
      const monto = Number(r.monto);
      return {
        rule_key: 'merma_inventario', plano: 'inventario' as const,
        severity: monto >= critico ? 'critical' as const : 'warn' as const,
        score: Math.min(1, monto / (critico * 2)),
        titulo: `Merma ${money(monto)} — SKU ${r.sku} suc ${r.warehouse_code} (${r.periodo})`,
        resumen: `${r.movs} salida(s) por ajuste/destrucción en el mes (${Number(r.unidades)} u). Inventario que sale sin venta — revisar motivo.`,
        entity: { sucursal: r.warehouse_code, sku: r.sku, movimientos: Number(r.movs), unidades: Number(r.unidades) },
        periodo: r.periodo,
        esperado: null, observado: null, diferencia: monto,
        importe: monto,
        causa_probable: 'merma',
        evidencia: { params: { min_monto: minMonto, critico }, movimientos: Number(r.movs), unidades: Number(r.unidades), monto },
        dedup_key: `merma_inventario:${r.warehouse_code}:${r.sku}:${r.periodo}`,
      };
    });
  }
}
