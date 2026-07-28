import { Injectable, BadRequestException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * CP.8 (Fase CP, ADR-040) — CFDI ↔ Contabilidad (ContPAQi). Valor fiscal #1: cruza los CFDI
 * RECIBIDOS del periodo (fiscal.cfdis) contra el padrón de proveedores de la contabilidad
 * (analytics.contpaqi_suppliers, por RFC) y contra la lista negra del SAT (fiscal.sat_list_rfcs):
 *
 *   • CFDI de proveedor EN 69B (EFOS)  → CFDI NO deducible: exposición fiscal cuantificada.
 *   • CFDI de proveedor EN 69 (art.69)  → riesgo (incumplido / no localizado).
 *   • CFDI de proveedor NO registrado en ContPAQi → factura recibida no dada de alta en libros.
 *
 * Determinista, sin LLM. fiscal.* con RLS → tk.run; analytics.* sin RLS → filtro tenant explícito;
 * fiscal.sat_list_rfcs es global (padrón SAT, no por tenant).
 */
@Injectable()
export class CfdiContabilidadService {
  constructor(private readonly tk: TenantKnexService, private readonly ctx: TenantContextService) {}

  async overview(period?: string) {
    const p = this.normPeriod(period);
    const tenantId = this.ctx.requireTenantId();
    return this.tk.run(async (trx) => {
      const q = await trx.raw(
        `WITH rec AS (
           SELECT emisor_rfc AS rfc, MAX(emisor_nombre) AS nombre,
                  COUNT(*) AS num_cfdis,
                  SUM(COALESCE(subtotal,0))          AS base,
                  SUM(COALESCE(total_trasladados,0)) AS iva,
                  SUM(COALESCE(total,0))             AS total
             FROM fiscal.cfdis
            WHERE rol='recibidas' AND tipo_comprobante IN ('I','E') AND estatus_sat <> 'cancelado'
              AND to_char(fecha,'YYYY-MM') = :period
            GROUP BY emisor_rfc
         ),
         sup AS (
           SELECT rfc, MIN(codigo) AS codigo, MAX(nombre) AS cpq_nombre
             FROM analytics.contpaqi_suppliers WHERE tenant_id = :tenant AND rfc IS NOT NULL GROUP BY rfc
         ),
         sat AS (
           SELECT rfc, MAX(lista) AS lista, MAX(situacion) AS situacion
             FROM fiscal.sat_list_rfcs GROUP BY rfc
         )
         SELECT rec.rfc, rec.nombre, rec.num_cfdis, rec.base, rec.iva, rec.total,
                (sup.rfc IS NOT NULL) AS en_contpaqi, sup.codigo, sup.cpq_nombre,
                sat.lista AS sat_lista, sat.situacion AS sat_situacion
           FROM rec
           LEFT JOIN sup ON sup.rfc = rec.rfc
           LEFT JOIN sat ON sat.rfc = rec.rfc
          ORDER BY (sat.lista IS NOT NULL) DESC, rec.total DESC`,
        { period: p, tenant: tenantId },
      );

      const rows = (q.rows as any[]).map((r) => {
        const efos = r.sat_lista === '69B';
        const lista69 = r.sat_lista === '69';
        const riesgo = efos ? 'efos' : lista69 ? 'lista69' : !r.en_contpaqi ? 'no_registrado' : 'ok';
        return {
          rfc: r.rfc, nombre: r.nombre || r.cpq_nombre || r.rfc,
          num_cfdis: Number(r.num_cfdis), base: Number(r.base), iva: Number(r.iva), total: Number(r.total),
          en_contpaqi: !!r.en_contpaqi, codigo: r.codigo ? String(r.codigo).trim() : null,
          sat_lista: r.sat_lista || null, sat_situacion: r.sat_situacion || null, riesgo,
        };
      });

      const acc = (pred: (x: any) => boolean) => rows.filter(pred).reduce((s, x) => ({ n: s.n + 1, monto: s.monto + x.total }), { n: 0, monto: 0 });
      const efos = acc((x) => x.riesgo === 'efos');
      const l69 = acc((x) => x.riesgo === 'lista69');
      const noReg = acc((x) => x.riesgo === 'no_registrado');
      const r2 = (v: number) => Math.round(v * 100) / 100;

      return {
        period: p,
        summary: {
          proveedores: rows.length,
          cfdi_count: rows.reduce((s, x) => s + x.num_cfdis, 0),
          cfdi_total: r2(rows.reduce((s, x) => s + x.total, 0)),
          registrados: rows.filter((x) => x.en_contpaqi).length,
          no_registrados: noReg.n, no_registrados_monto: r2(noReg.monto),
          efos_count: efos.n, efos_monto: r2(efos.monto),
          lista69_count: l69.n, lista69_monto: r2(l69.monto),
        },
        rows,
      };
    });
  }

  private normPeriod(period?: string): string {
    const m = String(period || '').match(/^(\d{4})-(\d{2})$/);
    if (!m) throw new BadRequestException(`period inválido (esperado YYYY-MM): ${period}`);
    return `${m[1]}-${m[2]}`;
  }
}
