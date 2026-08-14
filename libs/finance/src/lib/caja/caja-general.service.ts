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

  /**
   * CG.2 — CAJA GENERAL VIVA (analytics.caja_general_movimientos, ex-`Doctos`): el hub de
   * efectivo real de Comisionistas. Ingresos (ventas de ruta que entran) vs gastos
   * (remisiones a proveedor / comisiones / gastos por sucursal), por cuenta. Devuelve KPIs
   * + por-mes + por-cuenta + movimientos (filtrables por tipo/búsqueda). Reemplaza la data
   * muerta del Base Movimientos (caja_ventas_diarias/caja_depositos, abandonado Q1-2026).
   */
  async general(q: CajaQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const [from, to] = this.range(q);
    const n = (x: any) => Number(x) || 0;
    const r2 = (v: number) => Math.round(v * 100) / 100;
    return this.tk.run(async (trx) => {
      const T = 'analytics.caja_general_movimientos';
      const inRange = () => trx(T).where('tenant_id', tenantId).whereBetween('fecha', [from, to]);

      const tot: any = await inRange()
        .select(trx.raw('COALESCE(SUM(ingreso),0)::numeric AS ingreso'),
          trx.raw('COALESCE(SUM(gasto),0)::numeric AS gasto'), trx.raw('COUNT(*)::int AS n')).first();
      // Saldo actual = SaldoD del último movimiento (running balance de la caja) — global, no del rango.
      const sal: any = await trx(T).where('tenant_id', tenantId)
        .orderBy([{ column: 'fecha', order: 'desc' }, { column: 'mov_id', order: 'desc' }]).first('saldo', 'fecha');

      const porMes = await trx(T).where('tenant_id', tenantId)
        .select(trx.raw(`to_char(fecha,'YYYY-MM') AS mes`), trx.raw('SUM(ingreso)::numeric AS ingreso'),
          trx.raw('SUM(gasto)::numeric AS gasto'), trx.raw('COUNT(*)::int AS n'))
        .groupByRaw(`to_char(fecha,'YYYY-MM')`).orderByRaw(`to_char(fecha,'YYYY-MM')`);

      const porCuenta = await inRange()
        .select('cuenta', 'cuenta_nombre', trx.raw('SUM(ingreso)::numeric AS ingreso'),
          trx.raw('SUM(gasto)::numeric AS gasto'), trx.raw('COUNT(*)::int AS n'))
        .groupBy('cuenta', 'cuenta_nombre').orderByRaw('SUM(ingreso)+SUM(gasto) DESC').limit(40);

      let movq = inRange()
        .select('mov_id', 'tipo_dto', 'tipo', 'fecha', 'hora', 'usuario', 'cuenta', 'cuenta_nombre',
          'nombre_cliente', 'concepto', 'ingreso', 'gasto', 'saldo', 'denom')
        .orderBy([{ column: 'fecha', order: 'desc' }, { column: 'mov_id', order: 'desc' }]).limit(500);
      if (q.tipo) movq = movq.where('tipo', q.tipo);
      if (q.search) movq = movq.whereRaw(
        '(cuenta_nombre ILIKE ? OR nombre_cliente ILIKE ? OR concepto ILIKE ?)',
        [`%${q.search}%`, `%${q.search}%`, `%${q.search}%`]);
      const movs = await movq;

      return {
        period: { from, to },
        totals: {
          ingreso: r2(n(tot?.ingreso)), gasto: r2(n(tot?.gasto)), neto: r2(n(tot?.ingreso) - n(tot?.gasto)),
          n: n(tot?.n), saldo: r2(n(sal?.saldo)), saldo_fecha: sal?.fecha || null,
        },
        por_mes: (porMes as any[]).map((r) => ({ mes: r.mes, ingreso: r2(n(r.ingreso)), gasto: r2(n(r.gasto)), n: n(r.n) })),
        por_cuenta: (porCuenta as any[]).map((r) => ({ cuenta: r.cuenta, cuenta_nombre: r.cuenta_nombre, ingreso: r2(n(r.ingreso)), gasto: r2(n(r.gasto)), n: n(r.n) })),
        movimientos: (movs as any[]).map((r) => ({
          uid: `${r.tipo_dto}-${r.mov_id}`, ...r,
          ingreso: n(r.ingreso), gasto: n(r.gasto), saldo: n(r.saldo),
        })),
      };
    });
  }

  /**
   * CG.5 — CUADRE de la caja general (Comisionistas). Es un hub de efectivo pass-through:
   * la venta de ruta ENTRA (ingreso) y SALE a pagar proveedores/comisiones/gastos + depósito
   * al banco (gasto). El cuadre = ¿entra lo mismo que sale?  neto = ingreso − gasto (el efectivo
   * que quedó/faltó en caja). Como el saldo de libro no se lleva (SaldoD=0), el arqueo físico
   * (BMovimientosCajas caja 20, el MAYOR conteo del día) va como TESTIGO del efectivo real.
   * Desglosa el gasto en depósito-al-banco (cuentas 1990/40000000) vs el resto (remisiones/gastos).
   */
  async cajaCuadre(q: CajaQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const [from, to] = this.range(q);
    const n = (x: any) => Number(x) || 0;
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const DEP_ACCTS = ['1990', '40000000'];
    return this.tk.run(async (trx) => {
      const dias = await trx('analytics.caja_general_movimientos')
        .where('tenant_id', tenantId).whereBetween('fecha', [from, to])
        .select('fecha',
          trx.raw('SUM(ingreso)::numeric AS ingreso'),
          trx.raw('SUM(gasto)::numeric AS gasto'),
          trx.raw(`SUM(CASE WHEN cuenta IN ('1990','40000000') THEN gasto ELSE 0 END)::numeric AS deposito`),
          trx.raw('COUNT(*)::int AS n'))
        .groupBy('fecha').orderBy('fecha');

      // Arqueo físico por día (caja 20, el MAYOR conteo del día = mejor testigo del efectivo).
      const arq = await trx('analytics.caja_arqueos')
        .where({ tenant_id: tenantId, source_caja: '20', tipo: 'Arqueo' }).whereBetween('arqueo_date', [from, to])
        .select('arqueo_date', trx.raw('MAX(total_efectivo)::numeric AS efectivo'), trx.raw('COUNT(*)::int AS n'))
        .groupBy('arqueo_date');
      const arqByDay = new Map<string, { efectivo: number; n: number }>();
      for (const a of arq as any[]) arqByDay.set(String(a.arqueo_date).slice(0, 10), { efectivo: n(a.efectivo), n: n(a.n) });

      const por_dia = (dias as any[]).map((d) => {
        const key = String(d.fecha).slice(0, 10);
        const a = arqByDay.get(key);
        return {
          fecha: d.fecha, ingreso: r2(n(d.ingreso)), gasto: r2(n(d.gasto)), deposito: r2(n(d.deposito)),
          neto: r2(n(d.ingreso) - n(d.gasto)), n: n(d.n),
          arqueo_efectivo: a ? r2(a.efectivo) : null, arqueo_n: a ? a.n : 0,
        };
      });

      const ingreso = r2(por_dia.reduce((s, d) => s + d.ingreso, 0));
      const gasto = r2(por_dia.reduce((s, d) => s + d.gasto, 0));
      const deposito = r2(por_dia.reduce((s, d) => s + d.deposito, 0));
      const neto = r2(ingreso - gasto);
      // pass-through sano si el neto es chico vs el flujo (todo lo que entró salió). Tolerancia 2%.
      const cuadra = ingreso > 0 ? Math.abs(neto) <= ingreso * 0.02 : Math.abs(neto) < 1000;

      return {
        period: { from, to },
        totals: {
          ingreso, gasto, deposito, remisiones_gastos: r2(gasto - deposito), neto,
          cuadra, dias: por_dia.length,
        },
        por_dia,
      };
    });
  }

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
      // ContPAQi (fiscal/libros): ingreso = flujo 'deposito' en 102xxx; mapea cuenta→banco
      // via crosswalk CB (bank_accounts.contpaqi_cuenta). Es la 4ª vía = el extremo fiscal.
      const cpqCuentaBank = new Map<string, string>();
      try {
        const bax = await trx('finance.bank_accounts').where('tenant_id', tenantId).whereNotNull('contpaqi_cuenta').select('bank', 'contpaqi_cuenta');
        bax.forEach((r: any) => cpqCuentaBank.set(String(r.contpaqi_cuenta), canon(r.bank)));
      } catch { /* sin crosswalk */ }
      let cpq: any[] = [];
      try {
        cpq = await trx('analytics.contpaqi_bank_movements')
          .where('tenant_id', tenantId).where('flujo', 'deposito').whereBetween('fecha', [from, to])
          .groupBy('cuenta').select('cuenta').count({ n: '*' }).sum({ monto: 'importe' });
      } catch { cpq = []; }

      // Acumula las 4 fuentes por clave canónica.
      const M = new Map<string, { banco: string; caja: number; caja_n: number; wb: number; wb_n: number; kep: number; kep_n: number; cpq: number; cpq_n: number }>();
      const get = (k: string, label: string) => { if (!M.has(k)) M.set(k, { banco: label, caja: 0, caja_n: 0, wb: 0, wb_n: 0, kep: 0, kep_n: 0, cpq: 0, cpq_n: 0 }); return M.get(k)!; };
      caja.forEach((r: any) => { const g = get(canon(r.banco_name), canon(r.banco_name)); g.caja += Number(r.real); g.caja_n += Number(r.n); });
      cb.forEach((r: any) => { const g = get(canon(r.bank), canon(r.bank)); g.wb += Number(r.monto); g.wb_n += Number(r.n); });
      kep.forEach((r: any) => { const g = get(canon(r.banco_nombre), canon(r.banco_nombre)); g.kep += Number(r.monto); g.kep_n += Number(r.n); });
      cpq.forEach((r: any) => { const bank = cpqCuentaBank.get(String(r.cuenta)); if (!bank) return; const g = get(bank, bank); g.cpq += Number(r.monto); g.cpq_n += Number(r.n); });

      const por_banco = Array.from(M.values()).map((g) => ({
        banco: g.banco, caja: g.caja, caja_n: g.caja_n, wb: g.wb, wb_n: g.wb_n, kep: g.kep, kep_n: g.kep_n, cpq: g.cpq, cpq_n: g.cpq_n,
        delta_caja_wb: g.caja - g.wb, delta_caja_kep: g.caja - g.kep, delta_wb_kep: g.wb - g.kep, delta_caja_cpq: g.caja - g.cpq, delta_wb_cpq: g.wb - g.cpq,
        cuadra_caja_wb: g.wb > 0 && Math.abs(g.caja - g.wb) <= CUADRE_EPS,
        cuadra_wb_kep: g.wb > 0 && g.kep > 0 && Math.abs(g.wb - g.kep) <= CUADRE_EPS,
        cuadra_wb_cpq: g.wb > 0 && g.cpq > 0 && Math.abs(g.wb - g.cpq) <= CUADRE_EPS,
      })).sort((a, b) => Math.max(b.caja, b.wb, b.kep, b.cpq) - Math.max(a.caja, a.wb, a.kep, a.cpq));

      const sum = (arr: any[], k: string) => arr.reduce((s: number, r: any) => s + Number(r[k] || 0), 0);
      return {
        period: { from, to, instance: inst },
        totals: {
          caja: sum(caja, 'real'), wb: sum(cb, 'monto'), kep: sum(kep, 'monto'), cpq: sum(cpq, 'monto'),
          wb_disponible: cb.length > 0, kep_disponible: kep.length > 0, cpq_disponible: cpq.length > 0,
        },
        por_banco, cuadre_eps: CUADRE_EPS,
      };
    });
  }

  /**
   * CG.8 — Conciliación de INGRESOS a nivel movimiento: depósito de Caja ↔ ingreso del
   * banco (workbook/CB), casados por monto (±$1) + fecha (±3d) dentro del mismo banco.
   * Resuelve el "memo de ingresos" de Bancos y detecta fuga:
   *   · matched     = depósito de Caja que SÍ aparece en el banco.
   *   · caja_only   = depósito registrado en Caja SIN ingreso en banco (fuga/rezago).
   *   · bank_only   = ingreso del banco SIN depósito de Caja (cobranza/transferencia directa).
   * Usa el crosswalk confirmado (account_label) cuando existe; si no, cae a banco canónico.
   */
  async conciliacionDetalle(q: CajaQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const [from, to] = this.range(q);
    const inst = this.inst(q);
    const filterBank = q.banco ? this.canonBank(q.banco) : null;
    return this.tk.run(async (trx) => {
      // crosswalk confirmado: banco_code → account_label
      const xw = await trx('finance.caja_bank_crosswalk').where({ tenant_id: tenantId, source_instance: inst }).whereNotNull('account_label').select('banco_code', 'account_label');
      const codeToLabel = new Map(xw.map((r: any) => [String(r.banco_code), String(r.account_label)]));
      // CB account_label → banco canónico
      const ba = await trx('finance.bank_accounts').where('tenant_id', tenantId).select('bank', 'account_label');
      const labelBank = new Map(ba.map((r: any) => [String(r.account_label), this.canonBank(r.bank)]));

      const cajaRows = await trx('analytics.caja_depositos')
        .where({ tenant_id: tenantId, source_instance: inst }).whereBetween('deposito_date', [from, to]).where('eliminado', false).where('total_deposito_real', '>', 0)
        .select('deposito_id', 'banco_code', 'banco_name', 'almacen', 'deposito_date', 'total_deposito_real');
      let bankRows: any[] = [];
      try {
        bankRows = await trx('finance.bank_movements as bm')
          .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
          .where('bm.tenant_id', tenantId).where('bm.amount_in', '>', 0).whereBetween('bm.movement_date', [from, to])
          .whereNull('bm.deleted_at')
          .select('bm.id', 'ba.bank', 'ba.account_label', 'bm.movement_date', 'bm.amount_in', 'bm.concept');
      } catch { bankRows = []; }

      // indexa ingresos de banco por (canonBank, monto redondeado)
      const bank = bankRows.map((b) => ({ id: b.id, canon: this.canonBank(b.bank), label: String(b.account_label), date: b.movement_date, amt: Number(b.amount_in), concept: b.concept, used: false }));
      const byKey = new Map<string, any[]>();
      for (const b of bank) { const k = `${b.canon}|${Math.round(b.amt)}`; (byKey.get(k) || byKey.set(k, []).get(k))!.push(b); }

      const dayDiff = (a: any, b: any) => Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 864e5);
      const matched: any[] = []; const cajaOnly: any[] = [];
      for (const c of cajaRows) {
        const canon = labelBank.get(codeToLabel.get(String(c.banco_code)) || '') || this.canonBank(c.banco_name);
        if (filterBank && canon !== filterBank) continue;
        const amt = Number(c.total_deposito_real);
        const cands = (byKey.get(`${canon}|${Math.round(amt)}`) || []).filter((b) => !b.used && dayDiff(b.date, c.deposito_date) <= 3).sort((x, y) => dayDiff(x.date, c.deposito_date) - dayDiff(y.date, c.deposito_date));
        if (cands.length) {
          cands[0].used = true;
          matched.push({ canon, caja_id: c.deposito_id, banco: c.banco_name, almacen: c.almacen, fecha: c.deposito_date, monto: amt, bank_id: cands[0].id, bank_fecha: cands[0].date });
        } else {
          cajaOnly.push({ canon, caja_id: c.deposito_id, banco: c.banco_name, almacen: c.almacen, fecha: c.deposito_date, monto: amt });
        }
      }
      const bankOnly = bank.filter((b) => !b.used && (!filterBank || b.canon === filterBank)).map((b) => ({ canon: b.canon, bank_id: b.id, label: b.label, fecha: b.date, monto: b.amt, concept: b.concept, via_cobranza: false }));

      // CG.9 — 2º pase: atribuir el "banco sin Caja" a COBRANZA (cobros Kepler UA0501),
      // por monto (±$1) + fecha (±5d). El cobro no trae banco → match sin banco. Lo que
      // no case queda como residual (transferencia directa / financiero / inter-cuenta).
      let cob: any[] = [];
      try {
        cob = await trx('analytics.erp_collections')
          .where('tenant_id', tenantId).whereBetween('cobro_date', [from, to]).where('monto', '>', 0)
          .select('cobro_date', 'monto');
      } catch { cob = []; }
      const cobByAmt = new Map<number, any[]>();
      for (const x of cob) { const k = Math.round(Number(x.monto)); (cobByAmt.get(k) || cobByAmt.set(k, []).get(k))!.push({ date: x.cobro_date, used: false }); }
      for (const b of bankOnly) {
        const cands = (cobByAmt.get(Math.round(b.monto)) || []).filter((x) => !x.used && dayDiff(x.date, b.fecha) <= 5).sort((x, y) => dayDiff(x.date, b.fecha) - dayDiff(y.date, b.fecha));
        if (cands.length) { cands[0].used = true; b.via_cobranza = true; }
      }
      const cobranza = bankOnly.filter((b) => b.via_cobranza);
      const residual = bankOnly.filter((b) => !b.via_cobranza);

      const sum = (arr: any[]) => arr.reduce((s, r) => s + (r.monto || 0), 0);
      return {
        period: { from, to, instance: inst, banco: filterBank },
        totals: {
          matched_n: matched.length, matched: sum(matched),
          caja_only_n: cajaOnly.length, caja_only: sum(cajaOnly),
          cobranza_n: cobranza.length, cobranza: sum(cobranza),
          residual_n: residual.length, residual: sum(residual),
          bank_only_n: bankOnly.length, bank_only: sum(bankOnly),
        },
        matched: matched.sort((a, b) => b.monto - a.monto).slice(0, 500),
        caja_only: cajaOnly.sort((a, b) => b.monto - a.monto).slice(0, 500),
        bank_only: residual.sort((a, b) => b.monto - a.monto).slice(0, 500),
        match_eps: MATCH_EPS,
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

      // cuentas de Caja = banco_code (=BancoDepositado, 1:1 con banco_name; NO banco_cuenta,
      // que es un campo reusado/inconsistente) + volumen + label ya confirmado
      const accounts = await trx('analytics.caja_depositos as d')
        .leftJoin('finance.caja_bank_crosswalk as x', function () {
          this.on('x.tenant_id', 'd.tenant_id').andOn('x.source_instance', trx.raw('?', [inst])).andOn('x.banco_code', 'd.banco_code');
        })
        .where({ 'd.tenant_id': tenantId, 'd.source_instance': inst }).whereNotNull('d.banco_code')
        .groupBy('d.banco_code', 'x.account_label', 'x.confirmed_by', 'x.confirmed_at')
        .select('d.banco_code as code', trx.raw('max(d.banco_name) as banco_name'),
          'x.account_label as current_label', 'x.confirmed_by', 'x.confirmed_at',
          trx.raw('count(*)::int as deposits'), trx.raw('coalesce(sum(d.total_deposito_real),0)::numeric as monto'));

      // match Kepler por monto+fecha (candidatos por cuenta)
      const m = await trx.raw(
        `with cj as (select banco_code, deposito_date, round(total_deposito_real)::bigint amt
                       from analytics.caja_depositos
                      where tenant_id=? and source_instance=? and eliminado=false and total_deposito_real>100 and banco_code is not null),
              kp as (select account_label, fecha_valor, round(importe)::bigint amt
                       from analytics.kepler_bank_movements
                      where tenant_id=? and signo>0 and es_traspaso=false)
         select cj.banco_code as code, kp.account_label as label, count(*)::int as n
           from cj join kp on cj.amt=kp.amt and kp.fecha_valor between cj.deposito_date-7 and cj.deposito_date+7
          group by cj.banco_code, kp.account_label`, [tenantId, inst, tenantId]);
      const mrows = (m.rows || m) as any[];
      const byCode: Record<string, { label: string; n: number }[]> = {};
      for (const r of mrows) { (byCode[String(r.code)] = byCode[String(r.code)] || []).push({ label: String(r.label), n: Number(r.n) }); }

      return accounts.map((a: any) => {
        const cb = this.canonBank(a.banco_name);
        const opts = bankLabels[cb] || [];
        const cands = (byCode[String(a.code)] || []).filter((x) => labelBank[x.label] === cb).sort((x, y) => y.n - x.n);
        const sug = cands[0] || null;
        // Sugerencia: (1) match Kepler; (2) si el banco tiene UNA sola cuenta CB → determinista.
        const suggested_label = sug?.label || (opts.length === 1 ? opts[0] : null);
        const suggested_reason = sug ? 'kepler' : (opts.length === 1 ? 'unica_cuenta' : null);
        return {
          banco_code: a.code, banco_name: a.banco_name, canon_bank: cb,
          deposits: Number(a.deposits), monto: Number(a.monto),
          current_label: a.current_label || null, confirmed_by: a.confirmed_by || null, confirmed_at: a.confirmed_at || null,
          suggested_label, suggested_matches: sug?.n || 0, suggested_reason,
          alternatives: cands.slice(1, 4), cb_options: opts,
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
      const mesesVd = (await trx('analytics.caja_ventas_diarias').where('tenant_id', tenantId).whereNotNull('venta_date')
        .select(trx.raw(`distinct to_char(venta_date,'YYYY-MM') AS m`))).map((r: any) => r.m);
      // CG.2 — incluir meses de la caja general VIVA (Doctos), que llega más allá del Base Movimientos muerto.
      const mesesCg = (await trx('analytics.caja_general_movimientos').where('tenant_id', tenantId).whereNotNull('fecha')
        .select(trx.raw(`distinct to_char(fecha,'YYYY-MM') AS m`))).map((r: any) => r.m);
      const meses = Array.from(new Set(mesesVd.concat(mesesCg))).sort((a: string, b: string) => b.localeCompare(a));
      const bancos = (await trx('analytics.caja_depositos').where('tenant_id', tenantId).whereNotNull('banco_name').distinct('banco_name').orderBy('banco_name')).map((r: any) => r.banco_name);
      const empresas = (await trx('analytics.caja_sucursales_catalog').where('tenant_id', tenantId).whereNotNull('empresa').distinct('empresa').orderBy('empresa')).map((r: any) => r.empresa);
      const cajas = (await trx('analytics.caja_arqueos').where('tenant_id', tenantId).distinct('source_caja').orderBy('source_caja')).map((r: any) => r.source_caja);
      return { meses, bancos, empresas, cajas };
    });
  }
}
