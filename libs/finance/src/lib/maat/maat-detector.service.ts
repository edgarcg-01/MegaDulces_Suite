import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * MAAT.2 — Motor de patrones de Maat (ADR-028). Formaliza el detector-lite de
 * MAAT.3.1 (`maat_alertas`) en detectores DETERMINISTAS persistidos.
 *
 * Cada detector lee data curada (analytics.*) y produce hallazgos idempotentes
 * (UPSERT por dedup_key) en `finance.findings`. SIN LLM en este camino. Tres
 * clases: riesgo | error_captura | oportunidad. Los umbrales viven en
 * `finance.rule_registry.params` (editables sin deploy); `ensureRules` sincroniza
 * el catálogo desde el código PRESERVANDO la calibración humana (params/enabled/
 * pinned/precision). El aprendizaje L2 (auto-supresión por precisión) lo aplica
 * MaatFindingsService al recibir feedback.
 *
 * Nota de cobertura: algunos detectores dependen de feeds que hoy solo existen en
 * prod (expense_documents/lines, ap_provider, expense_findings v1). En local corren
 * y devuelven 0 sin error; cadena_incompleta y gasto_atipico sí producen local.
 */

interface RuleMeta {
  rule_key: string;
  nombre: string;
  descripcion: string;
  clase: 'riesgo' | 'error_captura' | 'oportunidad';
  params: Record<string, any>;
}

interface RawFinding {
  rule_key: string;
  severity: 'info' | 'warn' | 'critical';
  score: number;
  titulo: string;
  resumen: string;
  entity: Record<string, any>;
  periodo: string | null;
  importe: number;
  evidencia: Record<string, any>;
  dedup_key: string;
}

const RULES: RuleMeta[] = [
  { rule_key: 'cadena_incompleta', clase: 'riesgo', nombre: 'Factura sin recepción', descripcion: 'Facturas de compra (XA2001) pagadas/registradas sin recepción (XA3701) correlacionada — pagar sin comprobante de recibido.', params: { min_monto: 5000, critico_monto: 100000 } },
  { rule_key: 'posible_duplicado', clase: 'riesgo', nombre: 'Posible factura duplicada', descripcion: 'Dos facturas del mismo proveedor con importe casi idéntico en una ventana corta.', params: { tolerancia_pct: 0.5, ventana_dias: 7, min_monto: 500 } },
  { rule_key: 'gasto_atipico', clase: 'riesgo', nombre: 'Gasto mensual atípico', descripcion: 'Gasto de una cuenta mayor en un mes se desvía ≥3σ de su historia (cuenta×sucursal).', params: { z: 3, min_meses: 6, min_monto: 20000 } },
  { rule_key: 'salto_precio_sku', clase: 'riesgo', nombre: 'Salto de precio en SKU', descripcion: 'Costo unitario de un SKU a un proveedor se desvía ≥2σ (z-score) de su promedio histórico.', params: { z: 2, min_compras: 4 } },
  { rule_key: 'dpo_largo', clase: 'riesgo', nombre: 'DPO / saldo alto de proveedor', descripcion: 'Proveedor con saldo por pagar y días de pago (DPO) por encima del umbral.', params: { dpo_max: 60, min_saldo: 10000 } },
  { rule_key: 'proveedor_nuevo_grande', clase: 'riesgo', nombre: 'Proveedor nuevo de monto alto', descripcion: 'Proveedor sin historial previo que entra directo con una compra grande.', params: { antiguedad_dias: 60, min_monto: 50000 } },
  { rule_key: 'iva_capitalizado', clase: 'error_captura', nombre: 'IVA capitalizado (bug XD5501)', descripcion: 'IVA acreditable huérfano por el bug de descuentos XD5501 (partida doble descuadrada).', params: {} },
  { rule_key: 'prov_203_orfano', clase: 'error_captura', nombre: 'Provisión 203 sin descargar', descripcion: 'Provisiones en la cuenta 203 que nunca se descargan (nómina/IMSS/SAT).', params: {} },
  { rule_key: 'anticipo_stale', clase: 'error_captura', nombre: 'Anticipo 107 sin aplicar', descripcion: 'Anticipos a proveedores (107) que nunca se aplican contra factura.', params: {} },
  { rule_key: 'spread_proveedor_sku', clase: 'oportunidad', nombre: 'Ahorro por spread de precio', descripcion: 'Mismo SKU comprado a 2+ proveedores con diferencia de precio relevante — ahorro potencial.', params: { min_spread_pct: 15, min_proveedores: 2, min_compras: 2 } },
];
/** rule_key → tipo de expense_findings v1 (ports de la Fase GX). */
const PORT_TIPO: Record<string, string> = { iva_capitalizado: 'iva_bug', prov_203_orfano: 'prov_203', anticipo_stale: 'anticipo_107' };

const norm = (s: any) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
const money = (n: number) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

@Injectable()
export class MaatDetectorService {
  private readonly logger = new Logger(MaatDetectorService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Sincroniza el catálogo de reglas desde el código sin pisar la calibración humana. */
  private async ensureRules(trx: any, tenantId: string) {
    for (const r of RULES) {
      await trx('finance.rule_registry')
        .insert({ tenant_id: tenantId, rule_key: r.rule_key, nombre: r.nombre, descripcion: r.descripcion, clase: r.clase, params: JSON.stringify(r.params) })
        .onConflict(['tenant_id', 'rule_key'])
        // preserva params/enabled/pinned/precision/suppressed — solo refresca metadata
        .merge({ nombre: r.nombre, descripcion: r.descripcion, clase: r.clase, updated_at: trx.fn.now() });
    }
  }

  /** Corre todos los detectores habilitados y no suprimidos; UPSERT idempotente. */
  async scanAll(source = 'manual') {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      await this.ensureRules(trx, tenantId);
      const rules = await trx('finance.rule_registry')
        .where({ tenant_id: tenantId, enabled: true, suppressed_auto: false })
        .select('rule_key', 'params');

      const summary: { rule_key: string; nuevos: number; total: number }[] = [];
      const nuevosCriticos: { rule_key: string; titulo: string; importe: number }[] = [];
      let totalNuevos = 0;
      for (const rule of rules) {
        const params = typeof rule.params === 'string' ? JSON.parse(rule.params) : (rule.params || {});
        let findings: RawFinding[] = [];
        try {
          findings = await this.runDetector(rule.rule_key, trx, tenantId, params);
        } catch (e: any) {
          this.logger.warn(`Detector ${rule.rule_key} falló: ${e?.message || e}`);
          continue;
        }
        let nuevos = 0;
        for (const f of findings) {
          const clase = RULES.find((r) => r.rule_key === f.rule_key)?.clase || 'riesgo';
          const res = await trx.raw(
            `INSERT INTO finance.findings
               (tenant_id, rule_key, clase, severity, status, score, titulo, resumen, entity, periodo, importe, evidencia, dedup_key, first_seen, last_seen, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'nuevo', ?, ?, ?, ?::jsonb, ?, ?, ?::jsonb, ?, now(), now(), now(), now())
             ON CONFLICT (tenant_id, dedup_key) DO UPDATE
               SET last_seen = now(), importe = EXCLUDED.importe, resumen = EXCLUDED.resumen,
                   severity = EXCLUDED.severity, evidencia = EXCLUDED.evidencia, score = EXCLUDED.score, updated_at = now()
             RETURNING (xmax = 0) AS is_insert`,
            [tenantId, f.rule_key, clase, f.severity, f.score, f.titulo, f.resumen, JSON.stringify(f.entity),
              f.periodo, f.importe, JSON.stringify(f.evidencia), f.dedup_key],
          );
          if (res.rows?.[0]?.is_insert) {
            nuevos++;
            if (f.severity === 'critical') nuevosCriticos.push({ rule_key: f.rule_key, titulo: f.titulo, importe: f.importe });
          }
        }
        const total = Number((await trx('finance.findings').where({ tenant_id: tenantId, rule_key: rule.rule_key }).count('* as c').first())?.c || 0);
        await trx('finance.rule_registry').where({ tenant_id: tenantId, rule_key: rule.rule_key })
          .update({ findings_total: total, updated_at: trx.fn.now() });
        summary.push({ rule_key: rule.rule_key, nuevos, total });
        totalNuevos += nuevos;
      }
      this.logger.log(`scan (${source}): ${totalNuevos} hallazgos nuevos en ${rules.length} reglas activas.`);
      return { source, reglas: rules.length, nuevos: totalNuevos, por_regla: summary, nuevos_criticos: nuevosCriticos };
    });
  }

  private runDetector(key: string, trx: any, tenantId: string, params: any): Promise<RawFinding[]> {
    switch (key) {
      case 'cadena_incompleta': return this.detCadenaIncompleta(trx, tenantId, params);
      case 'posible_duplicado': return this.detDuplicado(trx, tenantId, params);
      case 'gasto_atipico': return this.detGastoAtipico(trx, tenantId, params);
      case 'salto_precio_sku': return this.detSaltoPrecio(trx, tenantId, params);
      case 'dpo_largo': return this.detDpoLargo(trx, tenantId, params);
      case 'proveedor_nuevo_grande': return this.detProveedorNuevo(trx, tenantId, params);
      case 'spread_proveedor_sku': return this.detSpread(trx, tenantId, params);
      case 'iva_capitalizado':
      case 'prov_203_orfano':
      case 'anticipo_stale': return this.detPortFindings(key, trx, tenantId);
      default: return Promise.resolve([]);
    }
  }

  // ── riesgo: facturas sin recepción, agregadas por (sucursal, proveedor) ──
  private async detCadenaIncompleta(trx: any, tenantId: string, p: any): Promise<RawFinding[]> {
    const rows = await trx('analytics.expense_doc_chain')
      .where('tenant_id', tenantId).whereNull('recepcion_folio')
      .groupBy('sucursal', 'beneficiario')
      .havingRaw('SUM(total) >= ?', [Number(p.min_monto) || 5000])
      .select('sucursal', 'beneficiario',
        trx.raw('COUNT(*)::int AS n'), trx.raw('ROUND(SUM(total)::numeric,2) AS monto'),
        trx.raw("(array_agg(factura_folio ORDER BY total DESC))[1:5] AS folios"))
      .orderByRaw('SUM(total) DESC');
    const crit = Number(p.critico_monto) || 100000;
    return rows.map((r: any) => ({
      rule_key: 'cadena_incompleta',
      severity: Number(r.monto) >= crit ? 'critical' : 'warn',
      score: Math.min(1, Number(r.monto) / (crit * 2)),
      titulo: `${r.n} factura(s) sin recepción — ${r.beneficiario || '(sin proveedor)'}`,
      resumen: `${r.beneficiario || '(sin proveedor)'} (suc ${r.sucursal}): ${r.n} factura(s) por ${money(Number(r.monto))} sin recepción registrada (pagar sin comprobante de recibido).`,
      entity: { sucursal: r.sucursal, beneficiario: r.beneficiario },
      periodo: null, importe: Number(r.monto),
      evidencia: { folios: r.folios, num_facturas: r.n },
      dedup_key: `cadena_incompleta|${r.sucursal}|${norm(r.beneficiario)}`,
    }));
  }

  // ── riesgo: pares de facturas casi idénticas (mismo proveedor, ventana corta) ──
  private async detDuplicado(trx: any, tenantId: string, p: any): Promise<RawFinding[]> {
    const tol = (Number(p.tolerancia_pct) || 0.5) / 100;
    const win = Number(p.ventana_dias) || 7;
    const min = Number(p.min_monto) || 500;
    const rows = await trx('analytics.expense_documents as a')
      .join('analytics.expense_documents as b', function (this: any) {
        this.on('a.tenant_id', 'b.tenant_id').andOn('a.sucursal', 'b.sucursal')
          .andOn('a.beneficiario', 'b.beneficiario').andOn('a.doc_folio', '<', 'b.doc_folio');
      })
      .where('a.tenant_id', tenantId)
      .whereRaw('abs(a.importe - b.importe) <= greatest(a.importe,1)*?', [tol])
      .whereRaw('abs(a.fecha - b.fecha) <= ?', [win])
      .whereRaw('a.importe >= ?', [min])
      .select('a.sucursal', 'a.beneficiario', 'a.doc_folio as folio_a', 'b.doc_folio as folio_b',
        trx.raw('a.importe::numeric AS importe'), 'a.fecha as fecha_a', 'b.fecha as fecha_b')
      .orderBy('a.importe', 'desc').limit(200);
    return rows.map((r: any) => ({
      rule_key: 'posible_duplicado', severity: 'critical', score: 0.9,
      titulo: `Posible duplicado — ${r.beneficiario} ${money(Number(r.importe))}`,
      resumen: `${r.beneficiario} (suc ${r.sucursal}): folios ${r.folio_a} y ${r.folio_b} por ${money(Number(r.importe))} con ≤${win} días de diferencia.`,
      entity: { sucursal: r.sucursal, beneficiario: r.beneficiario, doc_tipo: 'XA2001', doc_folio: r.folio_b },
      periodo: String(r.fecha_b).slice(0, 7), importe: Number(r.importe),
      evidencia: { folio_a: r.folio_a, folio_b: r.folio_b, fecha_a: r.fecha_a, fecha_b: r.fecha_b },
      dedup_key: `posible_duplicado|${r.sucursal}|${r.folio_a}|${r.folio_b}`,
    }));
  }

  // ── riesgo: gasto mensual atípico (z-score sobre ledger_monthly) ──
  private async detGastoAtipico(trx: any, tenantId: string, p: any): Promise<RawFinding[]> {
    const minMeses = Number(p.min_meses) || 6;
    const zLim = Number(p.z) || 3;
    const minMonto = Number(p.min_monto) || 20000;
    const rows = await trx('analytics.ledger_monthly')
      .where('tenant_id', tenantId).whereIn('familia', ['5', '6', '7'])
      .select('sucursal', 'cuenta_mayor', 'cuenta_mayor_nombre', 'anio_mes', trx.raw('(cargos - abonos)::numeric AS neto'));
    // agrupa (sucursal, cuenta_mayor) → serie mensual
    const groups = new Map<string, { suc: string; mayor: string; nombre: string; pts: { mes: string; v: number }[] }>();
    for (const r of rows) {
      const k = `${r.sucursal}|${r.cuenta_mayor}`;
      if (!groups.has(k)) groups.set(k, { suc: r.sucursal, mayor: r.cuenta_mayor, nombre: r.cuenta_mayor_nombre, pts: [] });
      groups.get(k)!.pts.push({ mes: r.anio_mes, v: Number(r.neto) });
    }
    const out: RawFinding[] = [];
    for (const g of groups.values()) {
      if (g.pts.length < minMeses) continue;
      g.pts.sort((a, b) => a.mes.localeCompare(b.mes));
      const last = g.pts[g.pts.length - 1];
      const rest = g.pts.slice(0, -1).map((x) => x.v);
      const mean = rest.reduce((a, b) => a + b, 0) / rest.length;
      const sd = Math.sqrt(rest.reduce((a, b) => a + (b - mean) ** 2, 0) / rest.length);
      if (sd <= 0) continue;
      const z = (last.v - mean) / sd;
      if (Math.abs(z) < zLim || Math.abs(last.v) < minMonto) continue;
      out.push({
        rule_key: 'gasto_atipico',
        severity: Math.abs(z) >= zLim + 2 ? 'critical' : 'warn',
        score: Math.min(1, Math.abs(z) / (zLim * 2)),
        titulo: `Gasto atípico — ${g.nombre || g.mayor} (${last.mes})`,
        resumen: `${g.nombre || g.mayor} (suc ${g.suc}) en ${last.mes}: ${money(last.v)} vs promedio ${money(mean)} (${z > 0 ? '+' : ''}${z.toFixed(1)}σ).`,
        entity: { sucursal: g.suc, cuenta_mayor: g.mayor },
        periodo: last.mes, importe: Math.abs(last.v),
        evidencia: { z: +z.toFixed(2), media: Math.round(mean), desv: Math.round(sd), meses: g.pts.length },
        dedup_key: `gasto_atipico|${g.suc}|${g.mayor}|${last.mes}`,
      });
    }
    return out;
  }

  // ── riesgo: salto de precio por SKU (proveedor×sku) ──
  private async detSaltoPrecio(trx: any, tenantId: string, p: any): Promise<RawFinding[]> {
    // MAAT.7 — z-score (stddev poblacional) en vez de factor×avg: el máximo se desvía
    // ≥ z·σ de la media del (proveedor×SKU). Estadístico, no heurístico.
    const z = Number(p.z) || 2;
    const minC = Number(p.min_compras) || 4;
    const rows = await trx('analytics.expense_document_lines as l')
      .join('analytics.expense_documents as d', function (this: any) {
        this.on('d.tenant_id', 'l.tenant_id').andOn('d.sucursal', 'l.sucursal')
          .andOn('d.doc_tipo', 'l.doc_tipo').andOn('d.doc_folio', 'l.doc_folio');
      })
      .where('l.tenant_id', tenantId).whereRaw('l.costo_unitario > 0').whereNotNull('d.beneficiario')
      .groupBy('d.beneficiario', 'l.sku')
      .havingRaw('count(*) >= ?', [minC])
      .havingRaw('stddev_pop(l.costo_unitario) > 0')
      .havingRaw('max(l.costo_unitario) - avg(l.costo_unitario) >= ? * stddev_pop(l.costo_unitario)', [z])
      .select('d.beneficiario', 'l.sku', trx.raw('MAX(l.producto) AS producto'),
        trx.raw('ROUND(MIN(l.costo_unitario)::numeric,2) AS min_c'), trx.raw('ROUND(MAX(l.costo_unitario)::numeric,2) AS max_c'),
        trx.raw('ROUND(AVG(l.costo_unitario)::numeric,2) AS avg_c'), trx.raw('count(*)::int AS n'),
        trx.raw('ROUND(((max(l.costo_unitario) - avg(l.costo_unitario)) / nullif(stddev_pop(l.costo_unitario),0))::numeric,1) AS zscore'))
      .orderByRaw('(max(l.costo_unitario) - avg(l.costo_unitario)) / nullif(stddev_pop(l.costo_unitario),0) DESC').limit(100);
    return rows.map((r: any) => ({
      rule_key: 'salto_precio_sku', severity: Number(r.zscore) >= 3 ? 'critical' : 'warn', score: Math.min(1, Number(r.zscore) / 4),
      titulo: `Salto de precio — SKU ${r.sku} (${r.beneficiario})`,
      resumen: `${r.producto || 'SKU ' + r.sku} de ${r.beneficiario}: costo máx ${money(Number(r.max_c))} se desvía ${Number(r.zscore)}σ del promedio ${money(Number(r.avg_c))} (${r.n} compras).`,
      entity: { beneficiario: r.beneficiario, sku: r.sku },
      periodo: null, importe: Number(r.max_c) - Number(r.avg_c),
      evidencia: { min: Number(r.min_c), max: Number(r.max_c), avg: Number(r.avg_c), z: Number(r.zscore), compras: r.n },
      dedup_key: `salto_precio_sku|${norm(r.beneficiario)}|${r.sku}`,
    }));
  }

  // ── riesgo: DPO largo / saldo alto (ap_provider) ──
  private async detDpoLargo(trx: any, tenantId: string, p: any): Promise<RawFinding[]> {
    const dpoMax = Number(p.dpo_max) || 60;
    const minSaldo = Number(p.min_saldo) || 10000;
    const rows = await trx('analytics.ap_provider').where('tenant_id', tenantId)
      .groupBy('proveedor_norm')
      .select(trx.raw('MAX(proveedor) AS proveedor'), trx.raw('SUM(saldo)::numeric AS saldo'), trx.raw('SUM(compra_12m)::numeric AS compra'))
      .havingRaw('SUM(saldo) >= ?', [minSaldo]);
    const out: RawFinding[] = [];
    for (const r of rows) {
      const compra = Number(r.compra), saldo = Number(r.saldo);
      const dpo = compra > 0 ? Math.round(saldo / (compra / 365)) : null;
      if (dpo == null || dpo <= dpoMax) continue;
      out.push({
        rule_key: 'dpo_largo', severity: dpo > dpoMax * 2 ? 'critical' : 'warn', score: Math.min(1, dpo / (dpoMax * 3)),
        titulo: `DPO ${dpo}d — ${r.proveedor}`,
        resumen: `${r.proveedor}: saldo por pagar ${money(saldo)}, días de pago (DPO) ~${dpo} (umbral ${dpoMax}).`,
        entity: { beneficiario: r.proveedor }, periodo: null, importe: saldo,
        evidencia: { dpo, saldo: Math.round(saldo), compra_12m: Math.round(compra) },
        dedup_key: `dpo_largo|${norm(r.proveedor)}`,
      });
    }
    return out;
  }

  // ── riesgo: proveedor nuevo con compra grande ──
  private async detProveedorNuevo(trx: any, tenantId: string, p: any): Promise<RawFinding[]> {
    const dias = Number(p.antiguedad_dias) || 60;
    const min = Number(p.min_monto) || 50000;
    const rows = await trx('analytics.expense_documents').where('tenant_id', tenantId).whereNotNull('beneficiario')
      .groupBy('beneficiario')
      .havingRaw("min(fecha) >= (CURRENT_DATE - (? || ' days')::interval)", [dias])
      .havingRaw('sum(importe) >= ?', [min])
      .select('beneficiario', trx.raw('MIN(fecha) AS primera'), trx.raw('ROUND(SUM(importe)::numeric,2) AS monto'), trx.raw('count(*)::int AS n'))
      .orderByRaw('sum(importe) DESC').limit(50);
    return rows.map((r: any) => ({
      rule_key: 'proveedor_nuevo_grande', severity: 'warn', score: 0.6,
      titulo: `Proveedor nuevo grande — ${r.beneficiario}`,
      resumen: `${r.beneficiario}: primer registro ${String(r.primera).slice(0, 10)}, ya acumula ${money(Number(r.monto))} en ${r.n} doc(s).`,
      entity: { beneficiario: r.beneficiario }, periodo: String(r.primera).slice(0, 7), importe: Number(r.monto),
      evidencia: { primera_compra: r.primera, num_docs: r.n },
      dedup_key: `proveedor_nuevo_grande|${norm(r.beneficiario)}`,
    }));
  }

  // ── oportunidad: mismo SKU a varios proveedores con spread de precio ──
  private async detSpread(trx: any, tenantId: string, p: any): Promise<RawFinding[]> {
    const minSpread = (Number(p.min_spread_pct) || 15) / 100;
    const minProv = Number(p.min_proveedores) || 2;
    const rows = await trx('analytics.expense_document_lines as l')
      .join('analytics.expense_documents as d', function (this: any) {
        this.on('d.tenant_id', 'l.tenant_id').andOn('d.sucursal', 'l.sucursal')
          .andOn('d.doc_tipo', 'l.doc_tipo').andOn('d.doc_folio', 'l.doc_folio');
      })
      .where('l.tenant_id', tenantId).whereRaw('l.costo_unitario > 0').whereNotNull('d.beneficiario')
      .groupBy('l.sku')
      .havingRaw('count(distinct d.beneficiario) >= ?', [minProv])
      .havingRaw('min(l.costo_unitario) > 0 AND (max(l.costo_unitario)-min(l.costo_unitario))/min(l.costo_unitario) >= ?', [minSpread])
      .select('l.sku', trx.raw('MAX(l.producto) AS producto'),
        trx.raw('ROUND(MIN(l.costo_unitario)::numeric,2) AS min_c'), trx.raw('ROUND(MAX(l.costo_unitario)::numeric,2) AS max_c'),
        trx.raw('count(distinct d.beneficiario)::int AS provs'), trx.raw('SUM(l.cantidad)::numeric AS qty'))
      .orderByRaw('(max(l.costo_unitario)-min(l.costo_unitario))*sum(l.cantidad) DESC').limit(60);
    return rows.map((r: any) => {
      const ahorro = (Number(r.max_c) - Number(r.min_c)) * Number(r.qty || 0);
      const spreadPct = Number(r.min_c) > 0 ? ((Number(r.max_c) - Number(r.min_c)) / Number(r.min_c)) * 100 : 0;
      return {
        rule_key: 'spread_proveedor_sku', severity: 'info', score: Math.min(1, spreadPct / 100),
        titulo: `Ahorro potencial — SKU ${r.sku}`,
        resumen: `${r.producto || 'SKU ' + r.sku}: ${r.provs} proveedores, precio ${money(Number(r.min_c))}–${money(Number(r.max_c))} (spread ${spreadPct.toFixed(0)}%). Comprar al más barato ahorraría ~${money(ahorro)}.`,
        entity: { sku: r.sku }, periodo: null, importe: Math.round(ahorro),
        evidencia: { min: Number(r.min_c), max: Number(r.max_c), proveedores: r.provs, spread_pct: +spreadPct.toFixed(1) },
        dedup_key: `spread_proveedor_sku|${r.sku}`,
      };
    });
  }

  // ── error_captura: ports desde expense_findings v1 (Fase GX), agregados por sucursal ──
  private async detPortFindings(key: string, trx: any, tenantId: string): Promise<RawFinding[]> {
    const tipo = PORT_TIPO[key];
    const rows = await trx('analytics.expense_findings').where({ tenant_id: tenantId, tipo })
      .groupBy('sucursal')
      .select('sucursal', trx.raw('COUNT(*)::int AS n'), trx.raw('ROUND(SUM(importe)::numeric,2) AS monto'))
      .havingRaw('SUM(importe) <> 0');
    const meta = RULES.find((r) => r.rule_key === key)!;
    return rows.map((r: any) => ({
      rule_key: key, severity: 'warn', score: 0.7,
      titulo: `${meta.nombre} — suc ${r.sucursal || '?'}`,
      resumen: `${meta.nombre} (suc ${r.sucursal || '?'}): ${r.n} caso(s) por ${money(Number(r.monto))}.`,
      entity: { sucursal: r.sucursal }, periodo: null, importe: Number(r.monto),
      evidencia: { num_casos: r.n, tipo_v1: tipo },
      dedup_key: `${key}|${r.sucursal || 'all'}`,
    }));
  }
}
