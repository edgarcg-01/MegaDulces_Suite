import { Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase CXC (ADR-048) — Cartera de clientes / Partidas vivas (Cuentas por Cobrar).
 *
 * Reproduce el `Reporte de partidas vivas` de Kepler leyendo el espejo read-only
 * `analytics.customer_receivables` (derivado de `md.kdue`). El saldo se COMPUTA:
 * `saldo = Σ(signed_amount)` (cargo +, abono −). VERIFICADO cuadra al peso vs el PDF.
 * NO escribe a Kepler.
 *
 * Aging por FIFO: el link exacto cobro→factura (kdm5) aún no se consume, así que el
 * saldo por documento se aproxima aplicando los abonos del cliente a sus cargos más
 * viejos primero (estándar de antigüedad de saldos; el saldo total es exacto).
 */

const M2 = (v: unknown) => Number(v) || 0;

export interface CarteraQuery {
  sucursal?: string;
  cliente?: string;
  vendedor?: string;
  grupo?: string;   // kdud.c13 (ej '1M001' TELEMARKETING LA PIEDAD)
  zona?: string;    // kdud.c14
  from?: string;
  to?: string;
  incluir_saldados?: string; // '1' = incluir clientes con saldo 0
  search?: string;
  limit?: number;
}

interface Bucket { por_vencer: number; d0_30: number; d31_60: number; d61_90: number; d90_plus: number; }
const emptyBucket = (): Bucket => ({ por_vencer: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 });

/** Días vencido (hoy − vencimiento). null/futuro → por vencer. */
function bucketFor(b: Bucket, venc: string | null, hoy: string, monto: number) {
  if (!venc) { b.por_vencer += monto; return; }
  const dias = Math.floor((Date.parse(hoy) - Date.parse(venc)) / 86400000);
  if (dias <= 0) b.por_vencer += monto;
  else if (dias <= 30) b.d0_30 += monto;
  else if (dias <= 60) b.d31_60 += monto;
  else if (dias <= 90) b.d61_90 += monto;
  else b.d90_plus += monto;
}

@Injectable()
export class CustomerLedgerService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private async hoy(trx: any): Promise<string> {
    const r = await trx.raw(`SELECT (now() AT TIME ZONE 'America/Mexico_City')::date::text d`);
    return r.rows[0].d;
  }

  /** Cartera por cliente: saldo + aging + KPIs. Filtros = los del reporte Kepler. */
  async cartera(q: CarteraQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(Math.max(Number(q.limit) || 500, 1), 5000);
    return this.tk.run(async (trx) => {
      const hoy = await this.hoy(trx);
      let qb = trx('analytics.customer_receivables as r')
        .leftJoin('analytics.erp_customers as c', function (this: any) {
          this.on('c.tenant_id', 'r.tenant_id').andOn('c.erp_code', 'r.cliente_code');
        })
        .where('r.tenant_id', tenantId);
      if (q.sucursal) qb = qb.where('r.sucursal', q.sucursal);
      if (q.vendedor) qb = qb.where('r.vendedor', q.vendedor);
      if (q.grupo) qb = qb.where('r.grupo', q.grupo);
      if (q.zona) qb = qb.where('r.zona', q.zona);
      if (q.cliente) qb = qb.where('r.cliente_code', q.cliente);
      if (q.from) qb = qb.where('r.fecha', '>=', q.from);
      if (q.to) qb = qb.where('r.fecha', '<=', q.to);
      if (q.search) {
        const s = `%${q.search.trim()}%`;
        qb = qb.where((b: any) => b.whereILike('r.cliente_code', s).orWhereILike('c.name', s).orWhereILike('c.rfc', s));
      }
      const rows = await qb.select(
        'r.sucursal', 'r.cliente_code', 'r.vendedor', 'r.grupo', 'r.zona', 'r.cargo_abono',
        'r.importe', 'r.signed_amount',
        trx.raw('r.vencimiento::text as vencimiento'),
        trx.raw('c.name as cliente_nombre'), trx.raw('c.rfc as rfc'),
      );

      // Agrupar por (sucursal, cliente) y FIFO abonos → cargos más viejos primero.
      const map = new Map<string, any>();
      for (const r of rows) {
        const k = `${r.sucursal}||${r.cliente_code}`;
        let g = map.get(k);
        if (!g) { g = { sucursal: r.sucursal, cliente_code: r.cliente_code, cliente_nombre: r.cliente_nombre, rfc: r.rfc, vendedor: r.vendedor, grupo: r.grupo, zona: r.zona, cargos: [], abono: 0 }; map.set(k, g); }
        if (r.cargo_abono === 'C') g.cargos.push({ importe: M2(r.importe), venc: r.vencimiento ? String(r.vencimiento).slice(0, 10) : null });
        else g.abono += M2(r.importe);
        if (!g.cliente_nombre && r.cliente_nombre) g.cliente_nombre = r.cliente_nombre;
      }

      const clientes: any[] = [];
      const kpi = { total_saldo: 0, total_vencido: 0, n_clientes: 0, n_partidas: 0, aging: emptyBucket() };
      for (const g of map.values()) {
        g.cargos.sort((a: any, b: any) => (a.venc || '9999').localeCompare(b.venc || '9999'));
        let rem = g.abono;
        const aging = emptyBucket();
        let saldo = 0; let vencido = 0; let nPartidas = 0;
        for (const cg of g.cargos) {
          const pagado = Math.min(rem, cg.importe); rem -= pagado;
          const residual = Math.round((cg.importe - pagado) * 100) / 100;
          if (residual <= 0.005) continue;
          saldo += residual; nPartidas += 1;
          bucketFor(aging, cg.venc, hoy, residual);
          if (cg.venc && Date.parse(hoy) > Date.parse(cg.venc)) vencido += residual;
        }
        saldo = Math.round(saldo * 100) / 100;
        if (saldo <= 0.005 && q.incluir_saldados !== '1') continue;
        clientes.push({
          sucursal: g.sucursal, cliente_code: g.cliente_code, cliente_nombre: g.cliente_nombre || g.cliente_code,
          rfc: g.rfc || null, vendedor: g.vendedor || null, grupo: g.grupo || null, zona: g.zona || null,
          saldo, vencido: Math.round(vencido * 100) / 100, n_partidas: nPartidas, aging,
        });
        kpi.total_saldo += saldo; kpi.total_vencido += vencido; kpi.n_clientes += 1; kpi.n_partidas += nPartidas;
        (Object.keys(aging) as (keyof Bucket)[]).forEach((k) => { kpi.aging[k] += aging[k]; });
      }
      clientes.sort((a, b) => b.saldo - a.saldo);
      kpi.total_saldo = Math.round(kpi.total_saldo * 100) / 100;
      kpi.total_vencido = Math.round(kpi.total_vencido * 100) / 100;
      (Object.keys(kpi.aging) as (keyof Bucket)[]).forEach((k) => { kpi.aging[k] = Math.round(kpi.aging[k] * 100) / 100; });
      return { hoy, kpi, clientes: clientes.slice(0, limit), total_clientes: clientes.length };
    });
  }

  /** Valores distintos para los selects del reporte (sucursal/grupo/zona/vendedor). */
  async filtros() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const distinct = async (col: string) => (await trx('analytics.customer_receivables')
        .where('tenant_id', tenantId).whereNotNull(col).distinct(col).orderBy(col)).map((r: any) => r[col]);
      const [sucursales, grupos, zonas, vendedores] = await Promise.all([
        distinct('sucursal'), distinct('grupo'), distinct('zona'), distinct('vendedor'),
      ]);
      return { sucursales, grupos, zonas, vendedores };
    });
  }

  /** Detalle (auxiliar) de un cliente: partidas con saldo por documento (FIFO) + abonos. */
  async detalle(sucursal: string, cliente: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const hoy = await this.hoy(trx);
      const rows = await trx('analytics.customer_receivables as r')
        .leftJoin('analytics.erp_customers as c', function (this: any) {
          this.on('c.tenant_id', 'r.tenant_id').andOn('c.erp_code', 'r.cliente_code');
        })
        .where({ 'r.tenant_id': tenantId, 'r.sucursal': sucursal, 'r.cliente_code': cliente })
        .select('r.doc_tipo', 'r.doc_label', 'r.folio', 'r.folio_digital',
          trx.raw('r.fecha::text as fecha'), trx.raw('r.vencimiento::text as vencimiento'),
          'r.importe', 'r.cargo_abono', 'r.referencia', 'r.vendedor',
          trx.raw('c.name as cliente_nombre'), trx.raw('c.rfc as rfc'))
        .orderBy([{ column: 'r.fecha', order: 'asc' }, { column: 'r.folio', order: 'asc' }]);

      const cargos = rows.filter((r: any) => r.cargo_abono === 'C')
        .sort((a: any, b: any) => String(a.vencimiento || a.fecha).localeCompare(String(b.vencimiento || b.fecha)));
      const abonos = rows.filter((r: any) => r.cargo_abono === 'A');
      let rem = abonos.reduce((s: number, r: any) => s + M2(r.importe), 0);

      const partidas = cargos.map((cg: any) => {
        const importe = M2(cg.importe);
        const pagado = Math.min(rem, importe); rem -= pagado;
        const saldo_documento = Math.round((importe - pagado) * 100) / 100;
        const venc = cg.vencimiento ? String(cg.vencimiento).slice(0, 10) : null;
        const dias = venc ? Math.floor((Date.parse(hoy) - Date.parse(venc)) / 86400000) : null;
        return {
          doc_tipo: cg.doc_tipo, doc_label: cg.doc_label, folio: cg.folio, folio_digital: cg.folio_digital,
          fecha: cg.fecha ? String(cg.fecha).slice(0, 10) : null, vencimiento: venc,
          importe, saldo_documento, dias_vencido: dias, vencida: dias != null && dias > 0 && saldo_documento > 0.005,
          referencia: cg.referencia,
        };
      });
      const head = rows[0] || {};
      const saldo = Math.round(partidas.reduce((s, p) => s + p.saldo_documento, 0) * 100) / 100;
      return {
        hoy,
        cliente: {
          sucursal, cliente_code: cliente, cliente_nombre: head.cliente_nombre || cliente, rfc: head.rfc || null,
          vendedor: head.vendedor || null,
        },
        saldo,
        vencido: Math.round(partidas.filter((p) => p.vencida).reduce((s, p) => s + p.saldo_documento, 0) * 100) / 100,
        partidas: partidas.filter((p) => p.saldo_documento > 0.005),
        pagadas: partidas.filter((p) => p.saldo_documento <= 0.005).length,
        abonos: abonos.map((r: any) => ({
          doc_label: r.doc_label, folio: r.folio, fecha: r.fecha ? String(r.fecha).slice(0, 10) : null, importe: M2(r.importe),
        })),
      };
    });
  }
}
