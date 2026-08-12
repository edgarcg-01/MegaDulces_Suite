import { Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService, applySmartSearch } from '@megadulces/platform-core';

/**
 * Fase CG.3 — Caja General (control venta diaria → depósito bancario + arqueo).
 *
 * Read-only sobre analytics.caja_* (espejo del sistema Access de Finanzas "Base
 * Movimientos" + arqueo "BMovimientosCajas", cargado por import-caja-general.js).
 * analytics.* NO tiene RLS → filtro tenant EXPLÍCITO dentro de tk.run().
 *
 * Tolerancias de conciliación (heredadas de CB/CC, ver bancos-shared):
 *   · MATCH_EPS   = ±$1     → casar un movimiento contra el banco (efectivo exacto).
 *   · CUADRE_EPS  = ±$1,000 → cuadre de TOTALES (absorbe centavos/redondeo).
 * El descuadre venta→depósito NO usa tolerancia: el hueco es la señal.
 */
const MATCH_EPS = 1;
const CUADRE_EPS = 1000;
const TENDERS = ['efectivo', 'morralla', 'cheques', 'tarjeta', 'caja_chica', 'sobregiro'];

export interface CajaQuery {
  month?: string;        // 'YYYY-MM'
  from?: string;         // 'YYYY-MM-DD'
  to?: string;           // 'YYYY-MM-DD'
  instance?: string;     // SI | NO
  banco?: string;        // banco_name
  almacen?: string;
  tipo?: string;         // arqueos: Arqueo/Retiro/Corte/…
  search?: string;
  limit?: number;
}

@Injectable()
export class CajaGeneralService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Deriva [from,to] (date) desde month o from/to; default = mes en curso. */
  private range(q: CajaQuery): [string, string] {
    if (q.from && q.to) return [q.from, q.to];
    const m = q.month && /^\d{4}-\d{2}$/.test(q.month) ? q.month : new Date().toISOString().slice(0, 7);
    const [y, mo] = m.split('-').map(Number);
    const last = new Date(y, mo, 0).getDate();
    return [`${m}-01`, `${m}-${String(last).padStart(2, '0')}`];
  }

  private inst(q: CajaQuery) { return (q.instance || 'SI').toUpperCase(); }

  /** KPIs del periodo: venta vs depositado por forma de pago + descuadre. */
  async overview(q: CajaQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const [from, to] = this.range(q);
    const inst = this.inst(q);
    return this.tk.run(async (trx) => {
      const tenderSel = TENDERS.flatMap((t) => [
        trx.raw(`coalesce(sum(${t}),0)::numeric AS ${t}`),
        trx.raw(`coalesce(sum(${t}_deposito),0)::numeric AS ${t}_dep`),
      ]);
      const [vd] = await trx('analytics.caja_ventas_diarias')
        .where({ tenant_id: tenantId, source_instance: inst }).whereBetween('venta_date', [from, to]).where('eliminado', false)
        .select(
          trx.raw('count(*)::int AS dias'),
          trx.raw('count(distinct almacen)::int AS sucursales'),
          trx.raw('coalesce(sum(venta_total),0)::numeric AS venta_total'),
          ...tenderSel);
      const [dep] = await trx('analytics.caja_depositos')
        .where({ tenant_id: tenantId, source_instance: inst }).whereBetween('deposito_date', [from, to]).where('eliminado', false)
        .select(
          trx.raw('count(*)::int AS n'),
          trx.raw('coalesce(sum(total_deposito),0)::numeric AS total'),
          trx.raw('coalesce(sum(total_deposito_real),0)::numeric AS total_real'),
          trx.raw('coalesce(sum(comision),0)::numeric AS comision'));

      const tenders = TENDERS.map((t) => ({
        tender: t, vendido: Number(vd[t]), depositado: Number(vd[`${t}_dep`]),
        descuadre: Number(vd[t]) - Number(vd[`${t}_dep`]),
      }));
      const vendido = tenders.reduce((s, r) => s + r.vendido, 0);
      const depositado = tenders.reduce((s, r) => s + r.depositado, 0);
      return {
        period: { from, to, instance: inst },
        venta_total: Number(vd.venta_total), dias: Number(vd.dias), sucursales: Number(vd.sucursales),
        vendido, depositado, descuadre: vendido - depositado,
        depositos: { n: Number(dep.n), total: Number(dep.total), total_real: Number(dep.total_real), comision: Number(dep.comision) },
        tenders,
      };
    });
  }

  /** Tabla por sucursal: venta vs depositado, descuadre, %. */
  async porSucursal(q: CajaQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const [from, to] = this.range(q);
    const inst = this.inst(q);
    return this.tk.run(async (trx) => {
      const depSum = TENDERS.map((t) => `${t}_deposito`).join('+');
      const rows = await trx('analytics.caja_ventas_diarias as vd')
        .leftJoin('analytics.caja_sucursales_catalog as sc', function () {
          this.on('sc.tenant_id', 'vd.tenant_id').andOn('sc.source_instance', 'vd.source_instance').andOn('sc.almacen', 'vd.almacen');
        })
        .where({ 'vd.tenant_id': tenantId, 'vd.source_instance': inst }).whereBetween('vd.venta_date', [from, to]).where('vd.eliminado', false)
        .groupBy('vd.almacen', 'sc.empresa', 'sc.nombre')
        .select('vd.almacen', 'sc.empresa', 'sc.nombre',
          trx.raw('count(*)::int AS dias'),
          trx.raw('coalesce(sum(vd.venta_total),0)::numeric AS venta'),
          trx.raw(`coalesce(sum(${depSum}),0)::numeric AS depositado`),
          trx.raw('max(vd.venta_date) AS ultima'))
        .orderByRaw('venta desc');
      return rows.map((r: any) => {
        const venta = Number(r.venta); const depositado = Number(r.depositado);
        return {
          almacen: r.almacen, empresa: r.empresa, nombre: r.nombre, dias: Number(r.dias),
          venta, depositado, descuadre: venta - depositado,
          pct_depositado: venta ? Math.round((depositado / venta) * 100) : 0, ultima: r.ultima,
        };
      });
    });
  }

  /** Ledger de depósitos + KPIs + desglose por banco. */
  async depositos(q: CajaQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const [from, to] = this.range(q);
    const inst = this.inst(q);
    const limit = Math.min(3000, Math.max(1, Number(q.limit) || 500));
    return this.tk.run(async (trx) => {
      const base = () => {
        const b = trx('analytics.caja_depositos')
          .where({ tenant_id: tenantId, source_instance: inst }).whereBetween('deposito_date', [from, to]).where('eliminado', false);
        if (q.banco) b.where('banco_name', q.banco);
        if (q.almacen) b.where('almacen', q.almacen);
        if (q.search && q.search.trim()) applySmartSearch(b, q.search.trim(), { columns: ['banco_name', 'observaciones', 'banco_cuenta'] });
        return b;
      };
      const rows = await base()
        .select('deposito_id', 'control', 'almacen', 'banco_code', 'banco_name', 'banco_cuenta',
          'deposito_date', 'deposito_date_real', 'tipo_pago', 'total_deposito', 'total_deposito_real', 'comision', 'iva', 'observaciones')
        .orderBy([{ column: 'deposito_date', order: 'desc' }, { column: 'deposito_id', order: 'desc' }]).limit(limit);
      const [tot] = await base().select(
        trx.raw('count(*)::int AS n'),
        trx.raw('coalesce(sum(total_deposito),0)::numeric AS total'),
        trx.raw('coalesce(sum(total_deposito_real),0)::numeric AS total_real'),
        trx.raw('coalesce(sum(comision),0)::numeric AS comision'));
      const byBank = await base().select('banco_name').count({ n: '*' }).sum({ total_real: 'total_deposito_real' }).groupBy('banco_name').orderBy('total_real', 'desc');
      return {
        rows,
        totals: { n: Number(tot.n), total: Number(tot.total), total_real: Number(tot.total_real), comision: Number(tot.comision) },
        by_bank: byBank.map((r: any) => ({ banco: r.banco_name, n: Number(r.n), total_real: Number(r.total_real) })),
      };
    });
  }

  /** Arqueos de caja (Sistema A) — conteo por denominación. */
  async arqueos(q: CajaQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const [from, to] = this.range(q);
    const limit = Math.min(3000, Math.max(1, Number(q.limit) || 500));
    return this.tk.run(async (trx) => {
      const base = () => {
        const b = trx('analytics.caja_arqueos').where({ tenant_id: tenantId }).whereBetween('arqueo_date', [from, to]);
        if (q.tipo) b.where('tipo', q.tipo);
        if (q.almacen) b.where('source_caja', q.almacen);
        if (q.search && q.search.trim()) applySmartSearch(b, q.search.trim(), { columns: ['folio', 'observaciones', 'capturo'] });
        return b;
      };
      const rows = await base()
        .select('mov_id', 'source_caja', 'folio', 'tipo', 'almacen', 'caja', 'arqueo_date', 'capturo',
          'total_billetes', 'total_monedas', 'total_efectivo', 'total_cheques', 'total_tarjeta', 'mov_total', 'denom', 'revisado', 'cancelado', 'observaciones')
        .orderBy([{ column: 'arqueo_date', order: 'desc' }, { column: 'mov_id', order: 'desc' }]).limit(limit);
      const byTipo = await base().select('tipo').count({ n: '*' }).sum({ monto: 'mov_total' }).groupBy('tipo').orderBy('n', 'desc');
      return { rows, by_tipo: byTipo.map((r: any) => ({ tipo: r.tipo, n: Number(r.n), monto: Number(r.monto) })) };
    });
  }

  /**
   * Conciliación depósitos de caja ↔ ingresos del banco (CB) por banco/mes.
   * Universos NO idénticos (caja = lo que Finanzas registró depositar; CB = estado de
   * cuenta real) → el delta es informativo. Cuadre por TOTALES con ±$1,000.
   */
  async conciliacion(q: CajaQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const [from, to] = this.range(q);
    const inst = this.inst(q);
    return this.tk.run(async (trx) => {
      const caja = await trx('analytics.caja_depositos')
        .where({ tenant_id: tenantId, source_instance: inst }).whereBetween('deposito_date', [from, to]).where('eliminado', false)
        .groupBy('banco_name').select('banco_name')
        .count({ n: '*' }).sum({ real: 'total_deposito_real' });
      let cb: any[] = [];
      try {
        cb = await trx('finance.bank_movements as bm')
          .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
          .where('bm.tenant_id', tenantId).where('bm.amount_in', '>', 0).whereBetween('bm.movement_date', [from, to])
          .groupBy('ba.bank').select('ba.bank').count({ n: '*' }).sum({ monto: 'bm.amount_in' });
      } catch { cb = []; }
      const cbByBank = new Map(cb.map((r: any) => [String(r.bank || '').toUpperCase(), { n: Number(r.n), monto: Number(r.monto) }]));
      const norm = (s: string) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
      // match laxo por nombre de banco (BBVA/Banorte/Bajío/Santander…)
      const pick = (name: string) => {
        const n = norm(name);
        for (const [k, v] of cbByBank) { if (k.includes(n.split(' ')[0]) || n.includes(k.split(' ')[0])) return v; }
        return null;
      };
      const por_banco = caja.map((r: any) => {
        const cajaReal = Number(r.real); const m = pick(r.banco_name);
        const cbMonto = m ? m.monto : 0; const delta = cajaReal - cbMonto;
        return {
          banco: r.banco_name, caja_n: Number(r.n), caja_real: cajaReal,
          cb_n: m ? m.n : 0, cb_in: cbMonto, delta, cuadra: Math.abs(delta) <= CUADRE_EPS, cb_disponible: !!m,
        };
      }).sort((a, b) => b.caja_real - a.caja_real);
      const cbTotal = cb.reduce((s: number, r: any) => s + Number(r.monto), 0);
      const cajaTotal = caja.reduce((s: number, r: any) => s + Number(r.real), 0);
      return {
        period: { from, to, instance: inst },
        totals: { caja_real: cajaTotal, cb_in: cbTotal, delta: cajaTotal - cbTotal, cb_disponible: cb.length > 0 },
        por_banco, match_eps: MATCH_EPS, cuadre_eps: CUADRE_EPS,
      };
    });
  }

  /** Facetas para filtros. */
  async facets() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const meses = (await trx('analytics.caja_ventas_diarias').where('tenant_id', tenantId).whereNotNull('venta_date')
        .select(trx.raw(`distinct to_char(venta_date,'YYYY-MM') AS m`)).orderBy('m', 'desc')).map((r: any) => r.m);
      const bancos = (await trx('analytics.caja_depositos').where('tenant_id', tenantId).whereNotNull('banco_name').distinct('banco_name').orderBy('banco_name')).map((r: any) => r.banco_name);
      const empresas = (await trx('analytics.caja_sucursales_catalog').where('tenant_id', tenantId).whereNotNull('empresa').distinct('empresa').orderBy('empresa')).map((r: any) => r.empresa);
      const cajas = (await trx('analytics.caja_arqueos').where('tenant_id', tenantId).distinct('source_caja').orderBy('source_caja')).map((r: any) => r.source_caja);
      return { meses, bancos, empresas, cajas };
    });
  }
}
