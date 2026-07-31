import { Injectable } from '@nestjs/common';

/**
 * PV.2 (Fase PV, ADR-041) — Detectores de "¿se subió mal esta póliza?".
 *
 * Leen la partida doble completa por póliza (analytics.gl_polizas / gl_poliza_lines,
 * pobladas por los importers PV.1) y producen hallazgos idempotentes que
 * MaatDetectorService escribe en finance.findings. SIN LLM (ADR-016/028): el motor
 * decide con SQL determinista.
 *
 * Fuente primaria = ContPAQi (verdad fiscal: header con Cargos/Abonos, UUID de CFDI
 * vía AsocCFDIs, flag Afectable). Kepler entra para el detalle por sucursal. La
 * reconciliación Kepler↔ContPAQi se hace a nivel FAMILIA×MES sobre las balanzas
 * mensuales que ya existen (los catálogos de cuenta NO son 1:1 entre sistemas).
 *
 * Estas firmas replican el shape de los detectores inline de MaatDetectorService
 * (reciben trx/tenantId/params, devuelven RawFinding[]).
 */

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

const money = (n: number) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 });

@Injectable()
export class MaatPolizaService {
  // ── error_captura: la póliza no cuadra (Σcargos ≠ Σabonos) ──
  // Fuente ContPAQi (header ya trae los totales). Es EL gap raíz: antes no había tabla
  // con las dos patas por póliza para poder verificarlo.
  async detNoCuadra(trx: any, tenantId: string, p: any): Promise<RawFinding[]> {
    const min = Number(p.min_monto) || 1;
    const rows = await trx('analytics.gl_polizas')
      .where({ tenant_id: tenantId, source: 'contpaqi' })
      .whereRaw('abs(neto) >= ?', [min])
      .orderByRaw('abs(neto) DESC')
      .limit(Number(p.limit) || 300)
      .select('ejercicio', 'periodo', 'tipo_pol', 'folio', 'anio_mes', 'fecha', 'concepto', 'cargos', 'abonos', 'neto', 'num_lines');
    return rows.map((r: any) => {
      const neto = Number(r.neto);
      return {
        rule_key: 'poliza_no_cuadra',
        severity: (Math.abs(neto) >= 1000 ? 'critical' : 'warn') as 'critical' | 'warn',
        score: Math.min(1, Math.abs(neto) / 10000),
        titulo: `Póliza descuadrada ${r.tipo_pol}/${r.folio} — Δ ${money(neto)}`,
        resumen: `Póliza ${r.tipo_pol}/${r.folio} (${r.anio_mes}): cargos ${money(Number(r.cargos))} vs abonos ${money(Number(r.abonos))} → descuadre de ${money(neto)}. Una póliza SIEMPRE debe cuadrar (partida doble); revisá que no falte o sobre una pata.`,
        entity: { source: 'contpaqi', ejercicio: r.ejercicio, periodo: r.periodo, tipo_pol: r.tipo_pol, folio: r.folio },
        periodo: r.anio_mes, importe: Math.abs(neto),
        evidencia: { cargos: Number(r.cargos), abonos: Number(r.abonos), neto, num_lines: r.num_lines, concepto: r.concepto },
        dedup_key: `poliza_no_cuadra|contpaqi|${r.ejercicio}|${r.periodo}|${r.tipo_pol}|${r.folio}`,
      };
    });
  }

  // ── error_captura: pata posteada a cuenta NO afectable (cuenta padre) ──
  async detCuentaNoAfectable(trx: any, tenantId: string, p: any): Promise<RawFinding[]> {
    const rows = await trx('analytics.gl_poliza_lines')
      .where({ tenant_id: tenantId, source: 'contpaqi', cuenta_afectable: false })
      .groupBy('ejercicio', 'periodo', 'tipo_pol', 'folio', 'anio_mes', 'cuenta', 'cuenta_nombre')
      .havingRaw('SUM(importe) >= ?', [Number(p.min_monto) || 1])
      .orderByRaw('SUM(importe) DESC')
      .limit(Number(p.limit) || 200)
      .select('ejercicio', 'periodo', 'tipo_pol', 'folio', 'anio_mes', 'cuenta', 'cuenta_nombre',
        trx.raw('ROUND(SUM(importe)::numeric,2) AS monto'), trx.raw('COUNT(*)::int AS n'));
    return rows.map((r: any) => ({
      rule_key: 'cuenta_no_afectable',
      severity: 'warn' as const,
      score: 0.6,
      titulo: `Posteo a cuenta no afectable ${r.cuenta} — ${r.tipo_pol}/${r.folio}`,
      resumen: `La póliza ${r.tipo_pol}/${r.folio} (${r.anio_mes}) postea ${money(Number(r.monto))} a la cuenta ${r.cuenta} "${r.cuenta_nombre || ''}", que es cuenta de agrupación (no afectable). Los movimientos deben ir a una cuenta de detalle (hoja).`,
      entity: { source: 'contpaqi', ejercicio: r.ejercicio, periodo: r.periodo, tipo_pol: r.tipo_pol, folio: r.folio, cuenta: r.cuenta },
      periodo: r.anio_mes, importe: Number(r.monto),
      evidencia: { cuenta: r.cuenta, cuenta_nombre: r.cuenta_nombre, patas: r.n },
      dedup_key: `cuenta_no_afectable|contpaqi|${r.ejercicio}|${r.periodo}|${r.tipo_pol}|${r.folio}|${r.cuenta}`,
    }));
  }

  // ── error_captura: fecha de la póliza fuera de su periodo (retro-fechada / mes equivocado) ──
  async detPeriodoSospechoso(trx: any, tenantId: string, p: any): Promise<RawFinding[]> {
    const rows = await trx('analytics.gl_polizas')
      .where({ tenant_id: tenantId, source: 'contpaqi' })
      .whereNotNull('fecha')
      .whereRaw('periodo <= 12')
      .whereRaw("(EXTRACT(YEAR FROM fecha)::int <> ejercicio OR EXTRACT(MONTH FROM fecha)::int <> periodo)")
      .whereRaw('(cargos + abonos) >= ?', [Number(p.min_monto) || 1000])
      .orderByRaw('(cargos + abonos) DESC')
      .limit(Number(p.limit) || 200)
      .select('ejercicio', 'periodo', 'tipo_pol', 'folio', 'anio_mes', 'fecha', 'cargos', 'abonos');
    return rows.map((r: any) => ({
      rule_key: 'periodo_sospechoso',
      severity: 'warn' as const,
      score: 0.5,
      titulo: `Fecha fuera de periodo ${r.tipo_pol}/${r.folio}`,
      resumen: `La póliza ${r.tipo_pol}/${r.folio} está registrada en el periodo ${r.anio_mes} pero su fecha es ${String(r.fecha).slice(0, 10)} (otro mes/año). Puede estar retro-fechada o cargada en el periodo equivocado — afecta la balanza del mes.`,
      entity: { source: 'contpaqi', ejercicio: r.ejercicio, periodo: r.periodo, tipo_pol: r.tipo_pol, folio: r.folio },
      periodo: r.anio_mes, importe: Number(r.cargos) + Number(r.abonos),
      evidencia: { periodo_registro: r.anio_mes, fecha_poliza: String(r.fecha).slice(0, 10) },
      dedup_key: `periodo_sospechoso|contpaqi|${r.ejercicio}|${r.periodo}|${r.tipo_pol}|${r.folio}`,
    }));
  }

  // ── riesgo: posible pata duplicada (mismo cargo/abono, cuenta, importe, referencia en folios distintos) ──
  async detDuplicadaExacta(trx: any, tenantId: string, p: any): Promise<RawFinding[]> {
    const min = Number(p.min_monto) || 500;
    const rows = await trx('analytics.gl_poliza_lines')
      .where({ tenant_id: tenantId, source: 'contpaqi' })
      .whereNotNull('referencia')
      .whereRaw("btrim(referencia) <> ''")
      .whereRaw('importe >= ?', [min])
      .groupBy('anio_mes', 'cuenta', 'cargo_abono', 'importe', 'referencia')
      .havingRaw('COUNT(DISTINCT folio) >= 2')
      .orderByRaw('importe * COUNT(*) DESC')
      .limit(Number(p.limit) || 100)
      .select('anio_mes', 'cuenta', 'cargo_abono', 'referencia',
        trx.raw('importe::numeric AS importe'),
        trx.raw('COUNT(DISTINCT folio)::int AS folios'),
        trx.raw("(array_agg(DISTINCT folio))[1:6] AS folio_muestra"));
    return rows.map((r: any) => ({
      rule_key: 'poliza_duplicada_exacta',
      severity: 'warn' as const,
      score: 0.7,
      titulo: `Posible duplicado — ${money(Number(r.importe))} ref ${r.referencia}`,
      resumen: `${r.folios} pólizas distintas (${r.anio_mes}) postean ${money(Number(r.importe))} a la cuenta ${r.cuenta} con la MISMA referencia "${r.referencia}". Puede ser un asiento duplicado.`,
      entity: { source: 'contpaqi', cuenta: r.cuenta, referencia: r.referencia },
      periodo: r.anio_mes, importe: Number(r.importe),
      evidencia: { folios: r.folio_muestra, num_folios: r.folios, cuenta: r.cuenta, cargo_abono: r.cargo_abono },
      dedup_key: `poliza_duplicada_exacta|${r.anio_mes}|${r.cuenta}|${r.importe}|${r.referencia}`,
    }));
  }

  // ── riesgo: importe de la pata ≠ total del CFDI (cruce EXACTO por UUID vía AsocCFDIs) ──
  async detCfdiImporteNoCoincide(trx: any, tenantId: string, p: any): Promise<RawFinding[]> {
    const tol = Number(p.tolerancia) || 1;
    // fiscal.cfdis: cabecera del CFDI con uuid + total. Solo evalúa patas con cfdi_uuid.
    const rows = await trx('analytics.gl_poliza_lines as l')
      .join('fiscal.cfdis as c', function (this: any) {
        this.on('c.tenant_id', 'l.tenant_id').andOn(trx.raw('upper(c.uuid) = upper(l.cfdi_uuid)'));
      })
      .where('l.tenant_id', tenantId).whereNotNull('l.cfdi_uuid')
      .whereRaw('abs(l.importe - c.total) >= ?', [tol])
      .orderByRaw('abs(l.importe - c.total) DESC')
      .limit(Number(p.limit) || 150)
      .select('l.ejercicio', 'l.periodo', 'l.tipo_pol', 'l.folio', 'l.anio_mes', 'l.cuenta', 'l.cfdi_uuid',
        trx.raw('l.importe::numeric AS importe_poliza'), trx.raw('c.total::numeric AS total_cfdi'));
    return rows.map((r: any) => {
      const delta = Number(r.importe_poliza) - Number(r.total_cfdi);
      return {
        rule_key: 'cfdi_importe_no_coincide',
        severity: (Math.abs(delta) >= 1000 ? 'critical' : 'warn') as 'critical' | 'warn',
        score: Math.min(1, Math.abs(delta) / 10000),
        titulo: `Póliza ≠ CFDI ${money(delta)} — ${r.tipo_pol}/${r.folio}`,
        resumen: `La póliza ${r.tipo_pol}/${r.folio} (${r.anio_mes}) postea ${money(Number(r.importe_poliza))} pero el CFDI vinculado (UUID ${String(r.cfdi_uuid).slice(0, 8)}…) tiene total ${money(Number(r.total_cfdi))} → diferencia ${money(delta)}. Cruce EXACTO por UUID.`,
        entity: { source: 'contpaqi', ejercicio: r.ejercicio, periodo: r.periodo, tipo_pol: r.tipo_pol, folio: r.folio, cuenta: r.cuenta },
        periodo: r.anio_mes, importe: Math.abs(delta),
        evidencia: { importe_poliza: Number(r.importe_poliza), total_cfdi: Number(r.total_cfdi), uuid: r.cfdi_uuid },
        dedup_key: `cfdi_importe_no_coincide|${r.tipo_pol}|${r.folio}|${r.cfdi_uuid}`,
      };
    });
  }

  // ── riesgo: la balanza de Kepler no coincide con ContPAQi (familia × mes) ──
  // Los catálogos de cuenta NO son 1:1 entre sistemas → se compara a nivel FAMILIA
  // (primer dígito, estándar MX) × mes, Kepler CEDIS (sucursal '00', consolidado) vs ContPAQi.
  async detKeplerVsContpaqi(trx: any, tenantId: string, p: any): Promise<RawFinding[]> {
    const min = Number(p.min_monto) || 50000;
    const rows = await trx.raw(
      `WITH k AS (
         SELECT familia, anio_mes, SUM(neto)::numeric AS neto
           FROM analytics.ledger_monthly
          WHERE tenant_id = ? AND sucursal = '00'
          GROUP BY familia, anio_mes),
       c AS (
         SELECT familia, anio_mes, SUM(neto)::numeric AS neto
           FROM analytics.contpaqi_ledger_monthly
          WHERE tenant_id = ?
          GROUP BY familia, anio_mes)
       SELECT COALESCE(k.familia,c.familia) AS familia,
              COALESCE(k.anio_mes,c.anio_mes) AS anio_mes,
              COALESCE(k.neto,0) AS kepler, COALESCE(c.neto,0) AS contpaqi,
              COALESCE(k.neto,0) - COALESCE(c.neto,0) AS delta
         FROM k FULL OUTER JOIN c ON k.familia = c.familia AND k.anio_mes = c.anio_mes
        WHERE abs(COALESCE(k.neto,0) - COALESCE(c.neto,0)) >= ?
        ORDER BY abs(COALESCE(k.neto,0) - COALESCE(c.neto,0)) DESC
        LIMIT ?`,
      [tenantId, tenantId, min, Number(p.limit) || 100],
    );
    return (rows.rows as any[]).map((r) => {
      const delta = Number(r.delta);
      return {
        rule_key: 'kepler_vs_contpaqi_descuadre',
        severity: 'info' as const,
        score: Math.min(1, Math.abs(delta) / 1000000),
        titulo: `Kepler ≠ ContPAQi — familia ${r.familia} ${r.anio_mes}`,
        resumen: `En ${r.anio_mes}, la familia ${r.familia} suma neto ${money(Number(r.kepler))} en Kepler (CEDIS) vs ${money(Number(r.contpaqi))} en ContPAQi → diferencia ${money(delta)}. Operación vs libros fiscales no cuadran para ese grupo de cuentas.`,
        entity: { familia: r.familia, anio_mes: r.anio_mes },
        periodo: r.anio_mes, importe: Math.abs(delta),
        evidencia: { kepler: Number(r.kepler), contpaqi: Number(r.contpaqi), delta },
        dedup_key: `kepler_vs_contpaqi_descuadre|${r.familia}|${r.anio_mes}`,
      };
    });
  }
}
