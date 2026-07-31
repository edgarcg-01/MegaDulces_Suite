import { Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * PV.3 (Fase PV, ADR-041) — Lectura del Auditor de Pólizas. Sirve la bandeja de
 * pólizas (con semáforo de cuadre) y el detalle de una póliza (patas + CFDI + hallazgos).
 * Solo lectura sobre analytics.gl_polizas / gl_poliza_lines + finance.findings.
 * analytics.* no tiene RLS → filtro de tenant explícito.
 */
@Injectable()
export class PolizasService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** KPIs de cabecera: totales y descuadre por fuente. */
  async summary(source?: string) {
    const tid = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      let q = trx('analytics.gl_polizas').where('tenant_id', tid);
      if (source) q = q.where('source', source);
      const r = await q.select(
        trx.raw('COUNT(*)::int AS total'),
        trx.raw('COUNT(*) FILTER (WHERE abs(neto) >= 0.01)::int AS descuadradas'),
        trx.raw('ROUND(COALESCE(SUM(abs(neto)) FILTER (WHERE abs(neto) >= 0.01),0)::numeric,2) AS monto_descuadre'),
        trx.raw("COUNT(*) FILTER (WHERE source='contpaqi')::int AS contpaqi"),
        trx.raw("COUNT(*) FILTER (WHERE source='kepler')::int AS kepler"),
        trx.raw('MAX(anio_mes) AS ultimo_mes'),
      ).first();
      return {
        total: Number(r?.total || 0),
        descuadradas: Number(r?.descuadradas || 0),
        monto_descuadre: Number(r?.monto_descuadre || 0),
        contpaqi: Number(r?.contpaqi || 0),
        kepler: Number(r?.kepler || 0),
        ultimo_mes: r?.ultimo_mes || null,
      };
    });
  }

  /** Lista paginada de pólizas con filtros. */
  async list(opts: { source?: string; anio_mes?: string; only_descuadre?: boolean; q?: string; page?: number; page_size?: number }) {
    const tid = this.tenantCtx.requireTenantId();
    const page = Math.max(1, Number(opts.page) || 1);
    const size = Math.min(200, Math.max(10, Number(opts.page_size) || 50));
    return this.tk.run(async (trx) => {
      const base = () => {
        let q = trx('analytics.gl_polizas').where('tenant_id', tid);
        if (opts.source) q = q.where('source', opts.source);
        if (opts.anio_mes) q = q.where('anio_mes', opts.anio_mes);
        if (opts.only_descuadre) q = q.whereRaw('abs(neto) >= 0.01');
        if (opts.q) q = q.whereRaw('(folio ILIKE ? OR concepto ILIKE ?)', [`%${opts.q}%`, `%${opts.q}%`]);
        return q;
      };
      const total = Number((await base().count('* as c').first())?.c || 0);
      const rows = await base()
        .orderByRaw('abs(neto) DESC, anio_mes DESC')
        .limit(size).offset((page - 1) * size)
        .select('source', 'sucursal', 'ejercicio', 'periodo', 'tipo_pol', 'folio', 'anio_mes',
          'fecha', 'concepto', 'cargos', 'abonos', 'neto', 'num_lines', 'guid');
      return {
        page, page_size: size, total,
        rows: rows.map((r: any) => ({
          ...r,
          cargos: Number(r.cargos), abonos: Number(r.abonos), neto: Number(r.neto),
          cuadra: Math.abs(Number(r.neto)) < 0.01,
        })),
      };
    });
  }

  /** Detalle de una póliza: header + patas + CFDIs vinculados + hallazgos abiertos. */
  async detail(k: { source: string; ejercicio: number; periodo: number; tipo_pol: string; folio: string; sucursal?: string }) {
    const tid = this.tenantCtx.requireTenantId();
    const suc = k.sucursal || '00';
    return this.tk.run(async (trx) => {
      const header = await trx('analytics.gl_polizas')
        .where({ tenant_id: tid, source: k.source, ejercicio: k.ejercicio, periodo: k.periodo, tipo_pol: k.tipo_pol, folio: k.folio, sucursal: suc })
        .first();
      const lines = await trx('analytics.gl_poliza_lines')
        .where({ tenant_id: tid, source: k.source, ejercicio: k.ejercicio, periodo: k.periodo, tipo_pol: k.tipo_pol, folio: k.folio, sucursal: suc })
        .orderBy('num_movto')
        .select('num_movto', 'cuenta', 'cuenta_nombre', 'cuenta_afectable', 'cargo_abono', 'importe', 'referencia', 'cfdi_uuid', 'sat_agrupador');
      // Hallazgos de esta póliza (entity contiene tipo_pol/folio).
      const findings = await trx('finance.findings')
        .where('tenant_id', tid).whereNot('status', 'descartado')
        .whereRaw("entity->>'tipo_pol' = ? AND entity->>'folio' = ?", [String(k.tipo_pol), String(k.folio)])
        .select('rule_key', 'severity', 'titulo', 'resumen', 'importe', 'status');
      return {
        header: header ? { ...header, cargos: Number(header.cargos), abonos: Number(header.abonos), neto: Number(header.neto), cuadra: Math.abs(Number(header.neto)) < 0.01 } : null,
        lines: lines.map((l: any) => ({ ...l, importe: Number(l.importe) })),
        findings,
      };
    });
  }
}
