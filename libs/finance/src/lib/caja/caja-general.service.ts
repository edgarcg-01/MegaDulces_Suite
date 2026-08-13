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
   * Conciliación 3 vías por banco: Caja ↔ Workbook (estado de cuenta/CB) ↔ Kepler
   * (tesorería). Alineadas por NOMBRE de banco canónico (caja no trae nº de cuenta;
   * el denominador común de las tres es el banco). Universos NO idénticos → el delta
   * es informativo (el banco/Kepler reciben también transferencias de clientes,
   * cobranza, etc.; caja es solo el depósito de tiendas). Cuadre TOTALES ±$1,000.
   *   · Caja     = analytics.caja_depositos (total_deposito_real).
   *   · Workbook = finance.bank_movements.amount_in (Google Sheet cargado por CB.23).
   *   · Kepler   = analytics.kepler_bank_movements entrada (signo>0, sin traspasos).
   */
  async conciliacion(q: CajaQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const [from, to] = this.range(q);
    const inst = this.inst(q);
    // Nombre de banco → clave canónica común a las 3 fuentes.
    const canon = (s: string): string => {
      const u = String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      if (/BAJIO|BBAJIO/.test(u)) return 'BAJIO';
      if (/BBVA|BANCOMER/.test(u)) return 'BBVA';
      if (/BANORTE/.test(u)) return 'BANORTE';
      if (/SANTANDER/.test(u)) return 'SANTANDER';
      if (/BANAMEX|CITI/.test(u)) return 'BANAMEX';
      if (/AZTECA/.test(u)) return 'AZTECA';
      if (/INBURSA/.test(u)) return 'INBURSA';
      if (/HSBC/.test(u)) return 'HSBC';
      if (/SCOTIA/.test(u)) return 'SCOTIABANK';
      if (/BANREGIO|REGIO/.test(u)) return 'BANREGIO';
      if (/CAJA/.test(u)) return 'CAJA';
      return (u.replace(/\s+/g, ' ').trim().split(' ')[0]) || 'OTRO';
    };
    return this.tk.run(async (trx) => {
      const caja = await trx('analytics.caja_depositos')
        .where({ tenant_id: tenantId, source_instance: inst }).whereBetween('deposito_date', [from, to]).where('eliminado', false)
        .groupBy('banco_name').select('banco_name').count({ n: '*' }).sum({ real: 'total_deposito_real' });
      let cb: any[] = [];
      try {
        cb = await trx('finance.bank_movements as bm')
          .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
          .where('bm.tenant_id', tenantId).where('bm.amount_in', '>', 0).whereBetween('bm.movement_date', [from, to])
          .groupBy('ba.bank').select('ba.bank').count({ n: '*' }).sum({ monto: 'bm.amount_in' });
      } catch { cb = []; }
      let kep: any[] = [];
      try {
        kep = await trx('analytics.kepler_bank_movements')
          .where('tenant_id', tenantId).where('signo', '>', 0).where('es_traspaso', false).whereBetween('fecha_valor', [from, to])
          .groupBy('banco_nombre').select('banco_nombre').count({ n: '*' }).sum({ monto: 'importe' });
      } catch { kep = []; }

      // Acumula las 3 fuentes por clave canónica.
      const M = new Map<string, { banco: string; caja: number; caja_n: number; wb: number; wb_n: number; kep: number; kep_n: number }>();
      const get = (k: string, label: string) => { if (!M.has(k)) M.set(k, { banco: label, caja: 0, caja_n: 0, wb: 0, wb_n: 0, kep: 0, kep_n: 0 }); return M.get(k)!; };
      caja.forEach((r: any) => { const g = get(canon(r.banco_name), canon(r.banco_name)); g.caja += Number(r.real); g.caja_n += Number(r.n); });
      cb.forEach((r: any) => { const g = get(canon(r.bank), canon(r.bank)); g.wb += Number(r.monto); g.wb_n += Number(r.n); });
      kep.forEach((r: any) => { const g = get(canon(r.banco_nombre), canon(r.banco_nombre)); g.kep += Number(r.monto); g.kep_n += Number(r.n); });

      const por_banco = [...M.values()].map((g) => ({
        banco: g.banco, caja: g.caja, caja_n: g.caja_n, wb: g.wb, wb_n: g.wb_n, kep: g.kep, kep_n: g.kep_n,
        delta_caja_wb: g.caja - g.wb, delta_caja_kep: g.caja - g.kep, delta_wb_kep: g.wb - g.kep,
        cuadra_caja_wb: g.wb > 0 && Math.abs(g.caja - g.wb) <= CUADRE_EPS,
        cuadra_wb_kep: g.wb > 0 && g.kep > 0 && Math.abs(g.wb - g.kep) <= CUADRE_EPS,
      })).sort((a, b) => Math.max(b.caja, b.wb, b.kep) - Math.max(a.caja, a.wb, a.kep));

      const sum = (arr: any[], k: string) => arr.reduce((s: number, r: any) => s + Number(r[k] || 0), 0);
      return {
        period: { from, to, instance: inst },
        totals: {
          caja: sum(caja, 'real'), wb: sum(cb, 'monto'), kep: sum(kep, 'monto'),
          wb_disponible: cb.length > 0, kep_disponible: kep.length > 0,
        },
        por_banco, cuadre_eps: CUADRE_EPS,
      };
    });
  }

  /** Nombre de banco → clave canónica común a Caja / CB / Kepler. */
  private canonBank(s: string): string {
    const u = String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (/BAJIO|BBAJIO/.test(u)) return 'BAJIO';
    if (/BBVA|BANCOMER/.test(u)) return 'BBVA';
    if (/BANORTE/.test(u)) return 'BANORTE';
    if (/SANTANDER/.test(u)) return 'SANTANDER';
    if (/BANAMEX|CITI/.test(u)) return 'BANAMEX';
    if (/AZTECA/.test(u)) return 'AZTECA';
    if (/INBURSA/.test(u)) return 'INBURSA';
    if (/HSBC/.test(u)) return 'HSBC';
    if (/CAJA/.test(u)) return 'CAJA';
    return u.replace(/\s+/g, ' ').trim().split(' ')[0] || 'OTRO';
  }

  /**
   * CG.7 — Enlace de cuentas: sugiere el `account_label` (cuenta CB/Kepler) para cada
   * cuenta interna de Caja (`banco_cuenta`), DERIVADO vía Kepler (match de depósitos por
   * monto+fecha, restringido al mismo banco canónico). El match es disperso → sugerencia
   * + confirmación manual. Devuelve estado actual (finance.caja_bank_crosswalk) + sugerencia.
   */
  async crosswalk() {
    const tenantId = this.tenantCtx.requireTenantId();
    const inst = 'SI';
    return this.tk.run(async (trx) => {
      // CB accounts → banco canónico + labels por banco
      const ba = await trx('finance.bank_accounts').where('tenant_id', tenantId).select('bank', 'account_label');
      const labelBank: Record<string, string> = {};
      const bankLabels: Record<string, string[]> = {};
      for (const r of ba) { const cb = this.canonBank(r.bank); labelBank[String(r.account_label)] = cb; (bankLabels[cb] = bankLabels[cb] || []).push(String(r.account_label)); }

      // cuentas de Caja (banco_cuenta que aparecen en depósitos) + volumen + label ya confirmado
      const accounts = await trx('analytics.caja_depositos as d')
        .leftJoin('finance.caja_bank_crosswalk as x', function () {
          this.on('x.tenant_id', 'd.tenant_id').andOn('x.source_instance', trx.raw('?', [inst])).andOn('x.banco_code', 'd.banco_cuenta');
        })
        .where({ 'd.tenant_id': tenantId, 'd.source_instance': inst }).whereNotNull('d.banco_cuenta')
        .groupBy('d.banco_cuenta', 'x.account_label', 'x.confirmed_by', 'x.confirmed_at')
        .select('d.banco_cuenta as code', trx.raw('max(d.banco_name) as banco_name'),
          'x.account_label as current_label', 'x.confirmed_by', 'x.confirmed_at',
          trx.raw('count(*)::int as deposits'), trx.raw('coalesce(sum(d.total_deposito_real),0)::numeric as monto'));

      // match Kepler por monto+fecha (candidatos por cuenta)
      const m = await trx.raw(
        `with cj as (select banco_cuenta, deposito_date, round(total_deposito_real)::bigint amt
                       from analytics.caja_depositos
                      where tenant_id=? and source_instance=? and eliminado=false and total_deposito_real>100 and banco_cuenta is not null),
              kp as (select account_label, fecha_valor, round(importe)::bigint amt
                       from analytics.kepler_bank_movements
                      where tenant_id=? and signo>0 and es_traspaso=false)
         select cj.banco_cuenta as code, kp.account_label as label, count(*)::int as n
           from cj join kp on cj.amt=kp.amt and kp.fecha_valor between cj.deposito_date-7 and cj.deposito_date+7
          group by cj.banco_cuenta, kp.account_label`, [tenantId, inst, tenantId]);
      const mrows = (m.rows || m) as any[];
      const byCode: Record<string, { label: string; n: number }[]> = {};
      for (const r of mrows) { (byCode[String(r.code)] = byCode[String(r.code)] || []).push({ label: String(r.label), n: Number(r.n) }); }

      return accounts.map((a: any) => {
        const cb = this.canonBank(a.banco_name);
        const cands = (byCode[String(a.code)] || []).filter((x) => labelBank[x.label] === cb).sort((x, y) => y.n - x.n);
        const sug = cands[0] || null;
        return {
          banco_code: a.code, banco_name: a.banco_name, canon_bank: cb,
          deposits: Number(a.deposits), monto: Number(a.monto),
          current_label: a.current_label || null, confirmed_by: a.confirmed_by || null, confirmed_at: a.confirmed_at || null,
          suggested_label: sug?.label || null, suggested_matches: sug?.n || 0,
          alternatives: cands.slice(1, 4), cb_options: bankLabels[cb] || [],
        };
      }).sort((x: any, y: any) => y.monto - x.monto);
    });
  }

  /** CG.7 — Persiste el enlace confirmado (UPSERT por banco_code). label null = desenlazar. */
  async crosswalkSet(bancoCode: string, label: string | null, matches: number, username?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      await trx('finance.caja_bank_crosswalk')
        .insert({
          tenant_id: tenantId, source_instance: 'SI', banco_code: String(bancoCode),
          account_label: label || null, match_count: matches || 0, source: 'manual',
          confirmed_by: username || null, confirmed_at: trx.fn.now(), updated_at: trx.fn.now(),
        })
        .onConflict(['tenant_id', 'source_instance', 'banco_code'])
        .merge(['account_label', 'match_count', 'source', 'confirmed_by', 'confirmed_at', 'updated_at']);
      return { banco_code: bancoCode, account_label: label || null };
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
