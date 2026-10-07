import { Injectable } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

export interface DiotRow {
  rfc: string; nombre: string | null; tipo_tercero: string; tipo_operacion: string;
  base: number; iva16: number; iva_retenido: number; num_cfdis: number;
}

/**
 * FISCAL.8.1 — DIOT (Declaración Informativa de Operaciones con Terceros) + IVA.
 *
 * Se arma desde fiscal.cfdis (recibidas) con IVA **efectivamente pagado** (flujo):
 *   - PUE  → se paga al emitirse: cuenta en el mes de la factura.
 *   - PPD  → cuenta en el mes del pago (REP), prorrateando el IVA por ImpPagado
 *            (fiscal.cfdi_payment_links). Es la regla correcta de acreditamiento.
 * Determinista, sin LLM. RLS vía tk.run.
 *
 * Nota: tipo_operacion default '85' (otros) — clasificar 03/06 requiere el mapeo
 * cuenta contable→tipo, diferido. tipo_tercero se infiere del RFC.
 */
@Injectable()
export class DiotService {
  constructor(private readonly tk: TenantKnexService) {}

  /** DIOT del periodo (YYYY-MM): un renglón por proveedor. */
  async build(period: string): Promise<{ period: string; rows: DiotRow[]; totales: { base: number; iva16: number; iva_retenido: number; proveedores: number } }> {
    const p = this.normPeriod(period);
    const rows = await this.tk.run(async (trx) => {
      const r = await trx.raw(this.pagadoSql('recibidas', 'agg'), { period: p });
      return r.rows as any[];
    });
    const out: DiotRow[] = rows.map((r) => ({
      rfc: r.rfc,
      nombre: r.nombre,
      tipo_tercero: this.tipoTercero(r.rfc),
      tipo_operacion: '85',
      base: Number(r.base || 0),
      iva16: Number(r.iva || 0),
      iva_retenido: Number(r.ret || 0),
      num_cfdis: Number(r.n || 0),
    }));
    const totales = out.reduce((a, x) => ({
      base: a.base + x.base, iva16: a.iva16 + x.iva16, iva_retenido: a.iva_retenido + x.iva_retenido, proveedores: a.proveedores + 1,
    }), { base: 0, iva16: 0, iva_retenido: 0, proveedores: 0 });
    return { period: p, rows: out, totales };
  }

  /** Resumen de IVA del periodo: acreditable (recibidas pagado) vs trasladado (emitidas cobrado). */
  async ivaResumen(period: string) {
    const p = this.normPeriod(period);
    return this.tk.run(async (trx) => {
      const acred = (await trx.raw(this.pagadoSql('recibidas', 'sum'), { period: p })).rows[0];
      const trasl = (await trx.raw(this.pagadoSql('emitidas', 'sum'), { period: p })).rows[0];
      const acreditable = Number(acred?.iva || 0);
      const trasladado = Number(trasl?.iva || 0);
      const retenido = Number(acred?.ret || 0);
      const saldo = trasladado - acreditable; // + = IVA a cargo · − = a favor
      return {
        period: p, iva_acreditable: acreditable, iva_trasladado: trasladado, iva_retenido: retenido,
        iva_a_cargo: saldo > 0 ? saldo : 0, iva_a_favor: saldo < 0 ? -saldo : 0,
      };
    });
  }

  /**
   * SQL del IVA efectivamente pagado por rol. mode='agg' agrupa por RFC (DIOT);
   * mode='sum' devuelve un solo total (resumen de IVA).
   */
  private pagadoSql(rol: 'recibidas' | 'emitidas', mode: 'agg' | 'sum'): string {
    const rfcCol = rol === 'recibidas' ? 'emisor_rfc' : 'receptor_rfc';
    const nombreCol = rol === 'recibidas' ? 'emisor_nombre' : 'receptor_nombre';
    const union = `
      SELECT ${rfcCol} AS rfc, ${nombreCol} AS nombre,
             COALESCE(subtotal,0) AS base, COALESCE(total_trasladados,0) AS iva, COALESCE(total_retenidos,0) AS ret,
             1 AS n
        FROM fiscal.cfdis
       WHERE rol = '${rol}' AND tipo_comprobante IN ('I','E') AND estatus_sat <> 'cancelado'
         AND COALESCE(metodo_pago,'PUE') <> 'PPD'
         AND to_char(fecha, 'YYYY-MM') = :period
      UNION ALL
      SELECT c.${rfcCol} AS rfc, c.${nombreCol} AS nombre,
             l.imp_pagado * (COALESCE(c.subtotal,0)         / NULLIF(c.total,0)) AS base,
             l.imp_pagado * (COALESCE(c.total_trasladados,0)/ NULLIF(c.total,0)) AS iva,
             l.imp_pagado * (COALESCE(c.total_retenidos,0)  / NULLIF(c.total,0)) AS ret,
             1 AS n
        FROM fiscal.cfdi_payment_links l
        JOIN fiscal.cfdis c ON c.uuid = l.docto_uuid
       WHERE c.rol = '${rol}' AND c.tipo_comprobante IN ('I','E') AND c.estatus_sat <> 'cancelado'
         AND COALESCE(c.metodo_pago,'PUE') = 'PPD'
         AND to_char(l.fecha_pago, 'YYYY-MM') = :period`;
    if (mode === 'sum') {
      return `SELECT COALESCE(SUM(base),0) AS base, COALESCE(SUM(iva),0) AS iva, COALESCE(SUM(ret),0) AS ret FROM (${union}) t`;
    }
    return `SELECT rfc, MAX(nombre) AS nombre, SUM(base) AS base, SUM(iva) AS iva, SUM(ret) AS ret, COUNT(*) AS n
              FROM (${union}) t
             WHERE rfc IS NOT NULL
             GROUP BY rfc
             ORDER BY iva DESC`;
  }

  /** Tipo de tercero DIOT: 15 global · 05 extranjero · 04 nacional. */
  private tipoTercero(rfc: string | null): string {
    const r = (rfc || '').toUpperCase();
    if (r === 'XAXX010101000') return '15'; // público en general
    if (r === 'XEXX010101000' || !/^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/.test(r)) return '05'; // extranjero / no estándar
    return '04'; // nacional
  }

  private normPeriod(period: string): string {
    const m = String(period || '').match(/^(\d{4})-(\d{2})$/);
    if (!m) throw new Error(`period inválido (esperado YYYY-MM): ${period}`);
    return `${m[1]}-${m[2]}`;
  }
}
