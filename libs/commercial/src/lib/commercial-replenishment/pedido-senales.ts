/**
 * `[RA-PRO.67]` Armado PURO de las señales por SKU del workbook (margen de hoy, de esta compra y
 * con lo pagado; venta perdida verificada contra el precio). Sin base de datos: `skuSignals()` del
 * servicio hace las consultas y le pasa las filas. Aislado para probarlo (ADR-056: lo que decide un
 * número se prueba). Las reglas y su medición están en `replenishment-signals.contract.ts`.
 */
import type { SkuLostBranch, SkuMarginBranch, WorkbookSkuSignals } from '@megadulces/contracts';

export interface SenalesProducto { product_id: string; sku: string; uxc?: number | string | null; pack_size?: number | string | null; caja_cost?: number | string | null }
export interface FilaCostoEstandar {
  sucursal: string; sku: string; margen_real_pct: string | number | null; vende_bajo_costo: boolean | null;
  precio_ficha: string | number | null; impuesto_pct: string | number | null; costo_reposicion_base: string | number | null;
  venta_neta_30d: string | number | null; es_plaza_operativa: boolean;
}
export interface FilaPagado { product_id: string; real_buy_cost: string | number | null; last_purchase: string | null }
export interface FilaPerdidaWincaja { sucursal: string; sku: string; importe: string | number; unidades: string | number; reportes: string | number; ultimo: string | null }
export interface FilaPerdidaMostrador { product_id: string; code: string; reportes: string | number; importe: string | number; ultimo: string | null }

/** Banda del árbitro de la venta perdida: precio implícito ÷ precio de ficha de algún peldaño. */
export const PRECIO_MIN = 0.6;
export const PRECIO_MAX = 1.3;
/** Guarda de unidad del costo de compra contra el costo de reposición. */
export const COSTO_MIN = 0.5;
export const COSTO_MAX = 2;

export function armarSenales(i: {
  rows: SenalesProducto[]; mRows: FilaCostoEstandar[]; pRows: FilaPagado[];
  lRows: FilaPerdidaWincaja[]; fRows: FilaPerdidaMostrador[]; desde: string;
}): Map<string, WorkbookSkuSignals> {
  const { rows, mRows, pRows, lRows, fRows, desde } = i;
  const out = new Map<string, WorkbookSkuSignals>();
  const idBySku = new Map(rows.map((r) => [r.sku, r.product_id] as const));
  // Peldaños del producto (pieza, paquete, caja) para el árbitro de la venta perdida.
  const peldanosBySku = new Map(rows.map((r) => [r.sku, [1, Number(r.pack_size) || 0, Number(r.uxc) || 0].filter((k) => k >= 1)] as const));
  const econBySku = new Map(rows.map((r) => [r.sku, { cc: Number(r.caja_cost) || 0, uxc: Number(r.uxc) || 0 }] as const));
  const n = (v: unknown): number | null => (v == null ? null : Number(v));
  const pagadoByPid = new Map(pRows.map((r) => [r.product_id, { costo: n(r.real_buy_cost), fecha: r.last_purchase }] as const));

  const get = (pid: string): WorkbookSkuSignals => {
    let s = out.get(pid);
    if (!s) { s = { margin: null, lost: null }; out.set(pid, s); }
    return s;
  };
  const emptyLost = () => ({
    desde,
    wincaja: { importe: 0, reportes_sin_verificar: 0, unidades: 0, reportes: 0, ultimo_dato: null as string | null, por_sucursal: {} as Record<string, SkuLostBranch> },
    mostrador: { reportes: 0, importe_estimado: 0, ultimo: null as string | null, por_sucursal: {} as Record<string, SkuLostBranch> },
  });

  // Margen: ponderado por la venta neta de 30 d de cada sucursal. Sin venta en ninguna, el
  // promedio simple de las medidas (el precio de ficha suele ser el mismo en toda la red).
  const bySku = new Map<string, typeof mRows>();
  // El MARGEN deja fuera la plaza 00 (oficinas sin venta, igual que Costo estándar); su ficha sí
  // se usa abajo como árbitro de la venta perdida del CEDIS, que llega con ese mismo código.
  for (const r of mRows) { if (!r.es_plaza_operativa) continue; const a = bySku.get(r.sku); if (a) a.push(r); else bySku.set(r.sku, [r]); }
  for (const [sku, rs] of bySku) {
    const pid = idBySku.get(sku);
    if (!pid) continue;
    const por: Record<string, SkuMarginBranch> = {};
    let wSum = 0, wm = 0, simple = 0, nMed = 0, bajo = 0;
    let lo: number | null = null, hi: number | null = null;
    let top: (typeof rs)[number] | null = null;
    for (const r of rs) {
      const m = n(r.margen_real_pct);
      por[r.sucursal] = { m, bc: r.vende_bajo_costo };
      if (r.vende_bajo_costo) bajo++;
      if (m == null) continue;
      const w = Math.max(0, n(r.venta_neta_30d) ?? 0);
      wSum += w; wm += w * m; simple += m; nMed++;
      lo = lo == null ? m : Math.min(lo, m); hi = hi == null ? m : Math.max(hi, m);
      if (!top || (n(r.venta_neta_30d) ?? 0) > (n(top.venta_neta_30d) ?? 0)) top = r;
    }
    // Margen de ESTA compra: precio neto de la sucursal que más vende contra el costo de caja del
    // pedido por unidad base. Sin impuesto medido no hay precio neto: se declara null.
    const econ = econBySku.get(sku);
    const neto = top && n(top.precio_ficha) != null && n(top.impuesto_pct) != null
      ? (n(top.precio_ficha) as number) / (1 + (n(top.impuesto_pct) as number) / 100) : null;
    let costoCompra = econ && econ.cc > 0 && econ.uxc > 0 ? econ.cc / econ.uxc : null;
    // Guarda de unidad: si el costo de compra por unidad base se aleja más de 2× del costo de
    // reposición de Kepler, el factor de caja y el costo no hablan de la misma unidad (medido
    // 2026-10-02: 83518 con +1,178 % y 70006 con −92 %, los dos con unidad capturada a mano que
    // el costo contradice). Se declara null en vez de publicar un margen imposible.
    const rep = top ? n(top.costo_reposicion_base) : null;
    if (costoCompra != null && rep != null && rep > 0 && (costoCompra / rep < COSTO_MIN || costoCompra / rep > COSTO_MAX)) costoCompra = null;
    const pg = pagadoByPid.get(pid);
    let costoPagado = pg?.costo != null && pg.costo > 0 ? pg.costo : null;
    if (costoPagado != null && rep != null && rep > 0 && (costoPagado / rep < COSTO_MIN || costoPagado / rep > COSTO_MAX)) costoPagado = null;
    const mg = (c: number | null) => (neto != null && c ? Math.round((neto / c - 1) * 10000) / 100 : null);
    get(pid).margin = {
      margen_pct: nMed ? Math.round((wSum > 0 ? wm / wSum : simple / nMed) * 100) / 100 : null,
      margen_compra_pct: mg(costoCompra),
      margen_pagado_pct: mg(costoPagado),
      ultima_compra: pg?.fecha ?? null,
      margen_min: lo, margen_max: hi, sucursales_bajo_costo: bajo,
      precio_ficha: top ? n(top.precio_ficha) : null,
      costo_reposicion_base: top ? n(top.costo_reposicion_base) : null,
      por_sucursal: por,
    };
  }
  // Árbitro de la venta perdida de Wincaja: el precio de la ficha de ESA sucursal (ver contrato).
  const fichaDe = new Map(mRows.map((r) => [`${r.sucursal}|${r.sku}`, n(r.precio_ficha)] as const));
  for (const r of lRows) {
    const pid = idBySku.get(r.sku);
    if (!pid) continue;
    const s = get(pid);
    const l = s.lost ?? (s.lost = emptyLost());
    const imp = Number(r.importe) || 0, uni = Number(r.unidades) || 0, rep = Number(r.reportes) || 0;
    const ficha = fichaDe.get(`${r.sucursal}|${r.sku}`) ?? null;
    const razon = ficha && ficha > 0 && uni > 0 ? imp / uni / ficha : null;
    // Cuadra si el precio implícito corresponde al de ALGÚN peldaño: Wincaja guarda la cantidad en
    // SU unidad de venta (el paquete en los multipack, ADR-055) y la ficha de Kepler está en la base.
    // KINDER DELICE: razón 6.6 contra la pieza = 0.66 contra el paquete de 10.
    const verificado = razon != null
      && (peldanosBySku.get(r.sku) ?? [1]).some((k) => razon / k >= PRECIO_MIN && razon / k <= PRECIO_MAX);
    l.wincaja.reportes += rep;
    if (r.ultimo && (!l.wincaja.ultimo_dato || r.ultimo > l.wincaja.ultimo_dato)) l.wincaja.ultimo_dato = r.ultimo;
    if (!verificado) { l.wincaja.reportes_sin_verificar += rep; continue; }
    l.wincaja.importe += imp; l.wincaja.unidades += uni;
    const b = l.wincaja.por_sucursal[r.sucursal] ?? (l.wincaja.por_sucursal[r.sucursal] = { importe: 0, reportes: 0 });
    b.importe = Math.round((b.importe + imp) * 100) / 100; b.reportes += rep;
  }
  for (const r of fRows) {
    const s = get(r.product_id);
    const l = s.lost ?? (s.lost = emptyLost());
    const imp = Number(r.importe) || 0, rep = Number(r.reportes) || 0;
    l.mostrador.reportes += rep; l.mostrador.importe_estimado += imp;
    if (r.ultimo && (!l.mostrador.ultimo || r.ultimo > l.mostrador.ultimo)) l.mostrador.ultimo = r.ultimo;
    l.mostrador.por_sucursal[r.code] = { importe: Math.round(imp * 100) / 100, reportes: rep };
  }
  for (const s of out.values()) {
    if (!s.lost) continue;
    s.lost.wincaja.importe = Math.round(s.lost.wincaja.importe * 100) / 100;
    s.lost.mostrador.importe_estimado = Math.round(s.lost.mostrador.importe_estimado * 100) / 100;
  }
  return out;
}
