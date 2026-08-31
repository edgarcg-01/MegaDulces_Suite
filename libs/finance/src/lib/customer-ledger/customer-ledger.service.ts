import { Injectable, BadRequestException } from '@nestjs/common';
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
 *
 * OJO multi-tenant: la vista estampa el uuid de mega_dulces como literal (kepler_ods no
 * tiene tenant y es el único con Kepler), igual que el resto de la capa ODS-derivada. El
 * `where tenant_id` de acá NO aísla nada — es forma, no defensa.
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
  sort?: 'saldo' | 'vencido'; // priorización: default saldo; 'vencido' = cola de cobranza
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
      // `saldo_ajustado` (no `saldo_documento`): reparte FIFO el remanente que kdm5 no logró
      // ubicar, así el total cuadra con la fórmula de Kepler. `saldo_cliente` es ese total.
      const rows = await qb.where('r.cargo_abono', 'C').select(
        'r.sucursal', 'r.cliente_code', 'r.vendedor', 'r.grupo', 'r.zona',
        'r.importe', 'r.saldo_ajustado', 'r.saldo_cliente', 'r.dias_pago',
        'r.limite_credito', 'r.dias_credito', 'r.telefono',
        trx.raw('r.vencimiento::text as vencimiento'),
        trx.raw('c.name as cliente_nombre'), trx.raw('c.rfc as rfc'),
      );

      const map = new Map<string, any>();
      for (const r of rows) {
        const k = `${r.sucursal}||${r.cliente_code}`;
        let g = map.get(k);
        if (!g) { g = { sucursal: r.sucursal, cliente_code: r.cliente_code, cliente_nombre: r.cliente_nombre, rfc: r.rfc, vendedor: r.vendedor, grupo: r.grupo, zona: r.zona, limite: r.limite_credito != null ? M2(r.limite_credito) : null, dias_credito: r.dias_credito != null ? Number(r.dias_credito) : null, telefono: r.telefono, saldo_cliente: M2(r.saldo_cliente), cargos: [], pagos: [] }; map.set(k, g); }
        const saldoDoc = r.saldo_ajustado != null ? M2(r.saldo_ajustado) : M2(r.importe);
        g.cargos.push({ saldo: saldoDoc, venc: r.vencimiento || null });
        if (r.dias_pago != null) g.pagos.push(Number(r.dias_pago));
        if (!g.cliente_nombre && r.cliente_nombre) g.cliente_nombre = r.cliente_nombre;
      }

      const clientes: any[] = [];
      const kpi = { total_saldo: 0, total_vencido: 0, n_clientes: 0, n_partidas: 0, n_sobre_linea: 0, total_a_favor: 0, n_a_favor: 0, aging: emptyBucket() };
      for (const g of map.values()) {
        const aging = emptyBucket();
        let saldoDocs = 0; let vencido = 0; let nPartidas = 0; let nSaldadas = 0;
        for (const cg of g.cargos) {
          const residual = Math.round(cg.saldo * 100) / 100;
          if (residual <= 0.005) { nSaldadas += 1; continue; }
          saldoDocs += residual; nPartidas += 1;
          bucketFor(aging, cg.venc, hoy, residual);
          if (cg.venc && Date.parse(hoy) > Date.parse(cg.venc)) vencido += residual;
        }
        saldoDocs = Math.round(saldoDocs * 100) / 100;
        // El total lo manda kdue. Lo que las partidas no alcanzan a explicar (kdm5 aplicó más
        // de lo que kdue justifica: 5 clientes, $41k) se declara, no se esconde ni se reparte.
        const saldo = Math.round(Math.max(M2(g.saldo_cliente), 0) * 100) / 100;
        const sin_documento = Math.round((saldo - saldoDocs) * 100) / 100;
        const saldo_a_favor = Math.round(Math.max(-M2(g.saldo_cliente), 0) * 100) / 100;
        if (saldo_a_favor > 0.005) { kpi.total_a_favor += saldo_a_favor; kpi.n_a_favor += 1; }
        if (saldo <= 0.005 && q.incluir_saldados !== '1') continue;
        const limite = g.limite && g.limite > 0 ? g.limite : null;
        const uso_linea = limite ? Math.round((saldo / limite) * 1000) / 10 : null; // %
        const dias_pago_prom = g.pagos.length
          ? Math.round((g.pagos.reduce((s: number, d: number) => s + d, 0) / g.pagos.length) * 10) / 10 : null;
        clientes.push({
          sucursal: g.sucursal, cliente_code: g.cliente_code, cliente_nombre: g.cliente_nombre || g.cliente_code,
          rfc: g.rfc || null, vendedor: g.vendedor || null, grupo: g.grupo || null, zona: g.zona || null,
          telefono: g.telefono || null, limite_credito: limite, dias_credito: g.dias_credito || null,
          uso_linea, sobre_linea: limite != null && saldo > limite + 0.005,
          saldo, vencido: Math.round(vencido * 100) / 100, n_partidas: nPartidas, n_saldadas: nSaldadas,
          sin_documento: Math.abs(sin_documento) > 0.005 ? sin_documento : 0,
          saldo_a_favor, dias_pago_prom, n_pagos: g.pagos.length, aging,
        });
        kpi.total_saldo += saldo; kpi.total_vencido += vencido; kpi.n_clientes += 1; kpi.n_partidas += nPartidas;
        if (limite != null && saldo > limite + 0.005) kpi.n_sobre_linea += 1;
        (Object.keys(aging) as (keyof Bucket)[]).forEach((k) => { kpi.aging[k] += aging[k]; });
      }
      kpi.total_a_favor = Math.round(kpi.total_a_favor * 100) / 100;
      if (q.sort === 'vencido') clientes.sort((a, b) => b.vencido - a.vencido || b.saldo - a.saldo);
      else clientes.sort((a, b) => b.saldo - a.saldo);
      kpi.total_saldo = Math.round(kpi.total_saldo * 100) / 100;
      kpi.total_vencido = Math.round(kpi.total_vencido * 100) / 100;
      (Object.keys(kpi.aging) as (keyof Bucket)[]).forEach((k) => { kpi.aging[k] = Math.round(kpi.aging[k] * 100) / 100; });
      return { hoy, kpi, clientes: clientes.slice(0, limit), total_clientes: clientes.length };
    });
  }

  /**
   * Resumen gerencial (lo que Kepler no da): DSO (días cartera), concentración top-10,
   * cartera por vendedor y por zona. Answer-first para dirección.
   */
  async resumen(q: { sucursal?: string; grupo?: string; zona?: string; vendedor?: string; search?: string } = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const hoy = await this.hoy(trx);
      // Mismos filtros que `cartera()`: el resumen tiene que hablar del mismo universo
      // que la tabla, o dirección lee dos números distintos en la misma pantalla.
      let qb = trx('analytics.customer_receivables as r')
        .leftJoin('analytics.erp_customers as c', function (this: any) {
          this.on('c.tenant_id', 'r.tenant_id').andOn('c.erp_code', 'r.cliente_code');
        })
        .where({ 'r.tenant_id': tenantId, 'r.cargo_abono': 'C' });
      if (q.sucursal) qb = qb.where('r.sucursal', q.sucursal);
      if (q.grupo) qb = qb.where('r.grupo', q.grupo);
      if (q.zona) qb = qb.where('r.zona', q.zona);
      if (q.vendedor) qb = qb.where('r.vendedor', q.vendedor);
      if (q.search) {
        const s = `%${q.search.trim()}%`;
        qb = qb.where((b: any) => b.whereILike('r.cliente_code', s).orWhereILike('c.name', s).orWhereILike('c.rfc', s));
      }
      const rows = await qb.select('r.cliente_code', 'r.vendedor', 'r.zona', 'r.importe', 'r.saldo_ajustado', 'r.dias_pago',
        trx.raw('r.fecha::text as fecha'), trx.raw('r.vencimiento::text as vencimiento'));

      const desde90 = new Date(Date.parse(hoy) - 90 * 86400000).toISOString().slice(0, 10);
      let saldoTotal = 0; let vencidoTotal = 0; let ventas90 = 0;
      const porCliente = new Map<string, number>();
      const porVend = new Map<string, any>();
      const porZona = new Map<string, any>();
      // Proyección de cobranza (cashflow): lo NO vencido, por cuándo vence.
      const proy = { vencido: 0, d0_7: 0, d8_15: 0, d16_30: 0, d30_plus: 0, sin_fecha: 0 };
      const pagos: number[] = [];
      for (const r of rows) {
        const saldo = r.saldo_ajustado != null ? M2(r.saldo_ajustado) : M2(r.importe);
        const importe = M2(r.importe);
        if (r.dias_pago != null) pagos.push(Number(r.dias_pago));
        if (r.fecha && r.fecha >= desde90) ventas90 += importe;
        if (saldo <= 0.005) continue;
        saldoTotal += saldo;
        const vencido = r.vencimiento && hoy > r.vencimiento ? saldo : 0;
        vencidoTotal += vencido;
        if (vencido > 0) proy.vencido += saldo;
        else if (!r.vencimiento) proy.sin_fecha += saldo;
        else {
          const dd = Math.floor((Date.parse(r.vencimiento) - Date.parse(hoy)) / 86400000);
          if (dd <= 7) proy.d0_7 += saldo; else if (dd <= 15) proy.d8_15 += saldo;
          else if (dd <= 30) proy.d16_30 += saldo; else proy.d30_plus += saldo;
        }
        porCliente.set(r.cliente_code, (porCliente.get(r.cliente_code) || 0) + saldo);
        const v = porVend.get(r.vendedor || '—') || { vendedor: r.vendedor || '—', saldo: 0, vencido: 0, clientes: new Set() };
        v.saldo += saldo; v.vencido += vencido; v.clientes.add(r.cliente_code); porVend.set(r.vendedor || '—', v);
        const z = porZona.get(r.zona || '—') || { zona: r.zona || '—', saldo: 0, vencido: 0 };
        z.saldo += saldo; z.vencido += vencido; porZona.set(r.zona || '—', z);
      }
      const r2 = (n: number) => Math.round(n * 100) / 100;
      const ventasDiarias = ventas90 / 90;
      const dso = ventasDiarias > 0 ? Math.round(saldoTotal / ventasDiarias) : null;
      const topCli = [...porCliente.entries()].map(([cliente_code, saldo]) => ({ cliente_code, saldo: r2(saldo) }))
        .sort((a, b) => b.saldo - a.saldo);
      const top10 = topCli.slice(0, 10);
      const top10Suma = top10.reduce((s, c) => s + c.saldo, 0);
      return {
        hoy,
        saldo_total: r2(saldoTotal), vencido_total: r2(vencidoTotal),
        pct_vencido: saldoTotal > 0 ? Math.round((vencidoTotal / saldoTotal) * 1000) / 10 : 0,
        dso, ventas_90d: r2(ventas90), n_clientes: porCliente.size,
        // Comportamiento de pago real (días entre factura y su último cobro). El DSO dice
        // cuánto tarda la cartera; esto dice cuánto tardan los que SÍ pagan.
        pago: pagos.length ? {
          n: pagos.length,
          promedio: Math.round((pagos.reduce((s, d) => s + d, 0) / pagos.length) * 10) / 10,
          mediana: pagos.slice().sort((a, b) => a - b)[Math.floor(pagos.length / 2)],
          tarde_30d: pagos.filter((d) => d > 30).length,
        } : null,
        concentracion: { top10_pct: saldoTotal > 0 ? Math.round((top10Suma / saldoTotal) * 1000) / 10 : 0, top10 },
        proyeccion: { vencido: r2(proy.vencido), d0_7: r2(proy.d0_7), d8_15: r2(proy.d8_15), d16_30: r2(proy.d16_30), d30_plus: r2(proy.d30_plus), sin_fecha: r2(proy.sin_fecha) },
        por_vendedor: [...porVend.values()].map((v) => ({ vendedor: v.vendedor, saldo: r2(v.saldo), vencido: r2(v.vencido), n_clientes: v.clientes.size })).sort((a, b) => b.saldo - a.saldo),
        por_zona: [...porZona.values()].map((z) => ({ zona: z.zona, saldo: r2(z.saldo), vencido: r2(z.vencido) })).sort((a, b) => b.saldo - a.saldo),
      };
    });
  }

  /** CXC.12 — tendencia de cartera (snapshots diarios). Sin sucursal = red (suma por día). */
  async tendencia(q: { sucursal?: string; dias?: number } = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    const dias = Math.min(Math.max(Number(q.dias) || 90, 1), 730);
    return this.tk.run(async (trx) => {
      let qb = trx('analytics.customer_receivable_snapshots')
        .where('tenant_id', tenantId)
        .andWhereRaw(`snapshot_date >= (now() AT TIME ZONE 'America/Mexico_City')::date - ?::int`, [dias]);
      if (q.sucursal) qb = qb.where('sucursal', q.sucursal);
      const rows = await qb
        .select(trx.raw('snapshot_date::text as fecha'))
        .sum({ saldo_total: 'saldo_total', vencido_total: 'vencido_total', n_clientes: 'n_clientes' })
        .groupBy('snapshot_date').orderBy('snapshot_date');
      return rows.map((r: any) => ({
        fecha: r.fecha, saldo_total: M2(r.saldo_total), vencido_total: M2(r.vencido_total),
        n_clientes: Number(r.n_clientes) || 0,
        pct_vencido: M2(r.saldo_total) > 0 ? Math.round((M2(r.vencido_total) / M2(r.saldo_total)) * 1000) / 10 : 0,
      }));
    });
  }

  /** CXC.13 — compromisos de pago abiertos de un cliente (para el drill). */
  private async promisesOf(trx: any, tenantId: string, sucursal: string, cliente: string) {
    const rows = await trx('finance.collection_promises')
      .where({ tenant_id: tenantId, sucursal, cliente_code: cliente })
      .whereIn('estado', ['abierta', 'incumplida'])
      .orderBy('fecha_promesa', 'asc')
      .select('id', 'monto_prometido', trx.raw('fecha_promesa::text as fecha_promesa'), 'estado', 'nota', 'created_by', trx.raw('created_at::text as created_at'));
    return rows.map((r: any) => ({ ...r, monto_prometido: M2(r.monto_prometido) }));
  }

  /** Registra un compromiso de pago (promesa de cobro). Escribe en tabla propia, NO Kepler. */
  async createPromise(sucursal: string, cliente: string, dto: { monto: number; fecha: string; nota?: string }, username?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!dto?.monto || dto.monto <= 0) throw new BadRequestException('monto inválido');
    if (!dto?.fecha) throw new BadRequestException('fecha requerida');
    return this.tk.run(async (trx) => {
      const snap = (await trx('analytics.customer_receivables as r')
        .leftJoin('analytics.erp_customers as c', function (this: any) { this.on('c.tenant_id', 'r.tenant_id').andOn('c.erp_code', 'r.cliente_code'); })
        .where({ 'r.tenant_id': tenantId, 'r.sucursal': sucursal, 'r.cliente_code': cliente, 'r.cargo_abono': 'C' })
        .select(trx.raw('max(c.name) as nombre'), trx.raw('COALESCE(sum(r.saldo_documento),0) as saldo')).first()) || {};
      const [row] = await trx('finance.collection_promises').insert({
        tenant_id: trx.raw('current_tenant_id()'),
        sucursal, cliente_code: cliente, cliente_nombre: snap.nombre || cliente,
        monto_prometido: dto.monto, fecha_promesa: dto.fecha, saldo_al_registrar: M2(snap.saldo),
        nota: dto.nota || null, created_by: username || null,
      }).returning(['id', 'estado']);
      return row;
    });
  }

  /** Resuelve un compromiso: cumplida | incumplida | cancelada. */
  async resolvePromise(id: string, estado: 'cumplida' | 'incumplida' | 'cancelada', username?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!['cumplida', 'incumplida', 'cancelada'].includes(estado)) throw new BadRequestException('estado inválido');
    return this.tk.run(async (trx) => {
      const n = await trx('finance.collection_promises').where({ tenant_id: tenantId, id })
        .update({ estado, resolved_by: username || null, resolved_at: trx.fn.now(), updated_at: trx.fn.now() });
      if (!n) throw new BadRequestException('compromiso no encontrado');
      return { id, estado };
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

  /**
   * Detalle (auxiliar) de un cliente: partidas con saldo por documento EXACTO (kdm5)
   * + los cobros/notas aplicados a cada factura (como el reporte Kepler). Si falta
   * `saldo_documento` (ramas sin kdm5), cae a `importe` (sin aplicar).
   */
  async detalle(sucursal: string, cliente: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const hoy = await this.hoy(trx);
      const rows = await trx('analytics.customer_receivables as r')
        .leftJoin('analytics.erp_customers as c', function (this: any) {
          this.on('c.tenant_id', 'r.tenant_id').andOn('c.erp_code', 'r.cliente_code');
        })
        .where({ 'r.tenant_id': tenantId, 'r.sucursal': sucursal, 'r.cliente_code': cliente })
        .select('r.doc_tipo', 'r.doc_label', 'r.doc_code', 'r.folio', 'r.folio_digital',
          trx.raw('r.fecha::text as fecha'), trx.raw('r.vencimiento::text as vencimiento'),
          'r.importe', 'r.cargo_abono', 'r.estatus', 'r.vendedor', 'r.saldo_documento', 'r.saldo_ajustado',
          'r.saldo_cliente', 'r.dias_pago', 'r.aplicaciones',
          'r.limite_credito', 'r.dias_credito', 'r.telefono', 'r.grupo', 'r.zona',
          trx.raw('c.name as cliente_nombre'), trx.raw('c.rfc as rfc'))
        .orderBy([{ column: 'r.fecha', order: 'asc' }, { column: 'r.folio', order: 'asc' }]);

      const cargos = rows.filter((r: any) => r.cargo_abono === 'C');
      const abonos = rows.filter((r: any) => r.cargo_abono === 'A');

      const partidas = cargos.map((cg: any) => {
        const importe = M2(cg.importe);
        // El saldo que se muestra es el ajustado (cuadra con kdue); `saldo_kdm5` es lo que
        // dicen las aplicaciones. Difieren cuando hubo un abono que kdm5 no supo ubicar.
        const saldo_kdm5 = cg.saldo_documento != null ? M2(cg.saldo_documento) : importe;
        const saldo_documento = cg.saldo_ajustado != null ? M2(cg.saldo_ajustado) : saldo_kdm5;
        const venc = cg.vencimiento || null;
        const dias = venc ? Math.floor((Date.parse(hoy) - Date.parse(venc)) / 86400000) : null;
        const aplicaciones: any[] = Array.isArray(cg.aplicaciones) ? cg.aplicaciones : (cg.aplicaciones || []);
        const saldada = saldo_documento <= 0.005;
        // Saldada = la última aplicación que la cerró (la vista ya las ordena por fecha).
        const fechas = aplicaciones.map((a) => a?.fecha).filter(Boolean).sort();
        return {
          doc_tipo: cg.doc_tipo, doc_label: cg.doc_label, doc_code: cg.doc_code,
          folio: cg.folio, folio_digital: cg.folio_digital,
          fecha: cg.fecha || null, vencimiento: venc,
          importe, saldo_documento, saldo_kdm5, dias_vencido: dias, vencida: dias != null && dias > 0 && !saldada,
          saldada, pagada_el: saldada && fechas.length ? fechas[fechas.length - 1] : null,
          dias_pago: cg.dias_pago != null ? Number(cg.dias_pago) : null,
          estatus: cg.estatus,
          aplicaciones,
        };
      });
      const head = rows[0] || {};
      const saldoDocs = Math.round(partidas.reduce((s, p) => s + p.saldo_documento, 0) * 100) / 100;
      const saldoCliente = head.saldo_cliente != null ? M2(head.saldo_cliente) : saldoDocs;
      const saldo = Math.round(Math.max(saldoCliente, 0) * 100) / 100;
      const pagos = partidas.map((p) => p.dias_pago).filter((d): d is number => d != null);

      // 360 — cobranza real del cliente (Fase CC): cobros UA0501 + evidencia (ficha/validada).
      // Puente por cliente_code (los cobros de la suc '00' — Oficinas, no el CEDIS: ERP_KEPLER
      // §2.3 — traen el código del cliente). Best-effort.
      let cobranza: any = null;
      try {
        const cc = (await trx.raw(
          `SELECT count(*)::int n, COALESCE(sum(e.monto), 0)::numeric monto, max(e.cobro_date)::text ultimo,
                  count(d.id)::int con_ficha, count(*) FILTER (WHERE d.estado = 'validado')::int validados
             FROM analytics.erp_collections e
             LEFT JOIN finance.collection_deposits d
               ON d.tenant_id = e.tenant_id AND d.sucursal = e.sucursal AND d.folio = e.folio
            WHERE e.tenant_id = ? AND e.cliente_code = ?`,
          [tenantId, cliente])).rows[0];
        if (cc && cc.n > 0) {
          cobranza = { n: cc.n, monto: M2(cc.monto), ultimo: cc.ultimo, con_ficha: cc.con_ficha, validados: cc.validados };
        }
      } catch { /* CC no disponible → sin puente */ }

      let compromisos: any[] = [];
      try { compromisos = await this.promisesOf(trx, tenantId, sucursal, cliente); } catch { /* tabla no migrada aún */ }

      return {
        hoy,
        cobranza,
        compromisos,
        cliente: {
          sucursal, cliente_code: cliente, cliente_nombre: head.cliente_nombre || cliente, rfc: head.rfc || null,
          vendedor: head.vendedor || null, grupo: head.grupo || null, zona: head.zona || null,
          telefono: head.telefono || null,
          limite_credito: head.limite_credito != null && M2(head.limite_credito) > 0 ? M2(head.limite_credito) : null,
          dias_credito: head.dias_credito != null ? Number(head.dias_credito) : null,
        },
        saldo,
        saldo_a_favor: Math.round(Math.max(-saldoCliente, 0) * 100) / 100,
        sin_documento: Math.abs(saldo - saldoDocs) > 0.005 ? Math.round((saldo - saldoDocs) * 100) / 100 : 0,
        dias_pago_prom: pagos.length ? Math.round((pagos.reduce((s, d) => s + d, 0) / pagos.length) * 10) / 10 : null,
        n_pagos: pagos.length,
        vencido: Math.round(partidas.filter((p) => p.vencida).reduce((s, p) => s + p.saldo_documento, 0) * 100) / 100,
        // Van TODAS: la partida saldada es historia de pago del cliente, no ruido. El front
        // las esconde detrás de un toggle para que el default siga siendo "partidas vivas".
        partidas,
        pagadas: partidas.filter((p) => p.saldada).length,
        importe_pagado: Math.round(partidas.filter((p) => p.saldada).reduce((s, p) => s + p.importe, 0) * 100) / 100,
        abonos: abonos.map((r: any) => ({
          doc_label: r.doc_label, folio: r.folio, fecha: r.fecha || null, importe: M2(r.importe),
        })),
      };
    });
  }
}
