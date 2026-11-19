/**
 * `[MKT.30]`/`[MKT.31]` — Los dos rankings de Mercadotecnia, sin base de datos ni Nest.
 *
 * Regla del dev responsable (2026-11-18): son DOS preguntas y no se mezclan.
 *  · RANKING DE PROMOCIONES: ¿qué se vendió y dónde se movió? Cuenta TODA la venta de la semana
 *    (se le haya cargado a un vendedor o no). Filtros: canal · sucursal · zona.
 *  · RANKING DE VENDEDORES: ¿quién vendió más? Cuenta sólo lo que se le CARGÓ a cada uno: en
 *    mostrador, el ticket que la cajera le asignó en su arqueo (`[MKT.18]`); fuera de mostrador, la
 *    ruta o la camioneta del documento (`[MKT.28]`/`[MKT.29]`). Lo que nadie tiene cargado no se
 *    reparte: se cuenta aparte.
 *
 * DINERO (`[MKT.31]`, decisiones D1/D2, opción D medida el 2026-11-18): lo que pagó el cliente
 * (importe con impuestos de la línea de venta) por los productos que ACTIVAN la promoción (los
 * identificados por `[MKT.15]`), en los tickets donde se aplicó. Es un piso («al menos»): una
 * promoción de marca puede llevar más productos de la marca en el ticket. Sin producto identificado
 * el dinero es `null` («sin dato»), nunca 0. En los TOTALES cada producto de cada ticket se cuenta
 * una sola vez aunque active dos promociones (medido: $111,337.44 sin repetir contra $113,251.41
 * sumando por promoción, semana 46).
 */
import { Canal, CANALES } from './mkt-ranking.logic';

/** Una línea de venta ya agregada por ticket y producto (promoción o producto que la activa). */
export interface LineaVenta {
  canal: Canal;
  warehouse_code: string;
  /** La llave del ticket (única entre sucursales y fuentes). */
  ticket: string;
  sku: string;
  qty: number;
  /** Lo que pagó el cliente por esa línea, con impuestos. */
  importe: number;
  /**
   * A quién se le carga el ticket: en mostrador la persona que asignó la cajera (o `null` si no se
   * asignó); fuera de mostrador la clave de la ruta o `ruta:<n>` de la camioneta.
   */
  vendedor: string | null;
}

export interface PromoBase {
  promo_id: string;
  code: string;
  nombre: string;
  /** SKU de los productos que activan la promoción; vacío = sin identificar («sin dato»). */
  productos: string[];
}

export interface ObjetivoParticipante {
  promo_id: string;
  canal: Canal;
  warehouse_code: string;
  objetivo: number;
}

export interface SucursalInfo { nombre: string; zona: string | null }

export interface FiltroVenta {
  canal?: Canal | null;
  sucursal?: string | null;
  /** Nombre de la zona, o `SIN_ZONA` para las sucursales sin zona. */
  zona?: string | null;
}

/** Valor del filtro de zona para las sucursales que no tienen zona asignada (nunca se adivina). */
export const SIN_ZONA = 'Sin zona';

export interface DesglosePromo {
  paquetes: number;
  /** `null` = la promoción no tiene producto identificado. */
  dinero: number | null;
}

export interface PromoVenta extends DesglosePromo {
  promo_id: string;
  code: string;
  nombre: string;
  /** Suma de los objetivos (fijados o dinámicos) dentro del filtro; `null` = nadie tiene. */
  objetivo: number | null;
  /** paquetes ÷ objetivo (sin tope: aquí se ve cuánto se pasó); `null` sin objetivo. */
  avance: number | null;
  por_canal: Array<DesglosePromo & { canal: Canal }>;
  por_sucursal: Array<DesglosePromo & { warehouse_code: string; nombre: string; zona: string; objetivo: number | null }>;
}

export interface PromoDeVendedor {
  code: string;
  nombre: string;
  paquetes: number;
  /** dinero ÷ paquetes: lo que pagó el cliente por un paquete, en promedio. */
  precio: number | null;
  total: number | null;
}

export interface VendedorVenta {
  /** `canal|sucursal|vendedor`. */
  clave: string;
  canal: Canal;
  warehouse_code: string;
  vendedor: string;
  paquetes: number;
  tickets: number;
  /** Lo que pagó el cliente, sin repetir un producto que active dos promociones. Sólo promos con dato. */
  total: number;
  /** Promociones vendidas sin producto identificado: su dinero no entra en `total`. */
  promos_sin_dato: number;
  promos: PromoDeVendedor[];
}

export interface RankingsVenta {
  totales: { paquetes: number; objetivo: number | null; dinero: number; promos: number; promos_sin_dato: number };
  sucursal_top: { warehouse_code: string; nombre: string; zona: string; paquetes: number } | null;
  promos: PromoVenta[];
  vendedores: VendedorVenta[];
  /** Mostrador dentro del filtro: tickets con promoción y cuántos tiene asignados la cajera. */
  mostrador: { tickets_con_promo: number; tickets_asignados: number } | null;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function zonaDe(sucursales: Map<string, SucursalInfo>, w: string): string {
  return sucursales.get(w)?.zona || SIN_ZONA;
}

/** ¿La sucursal (y su canal) entra en el filtro? */
export function enFiltro(f: FiltroVenta, canal: Canal, w: string, sucursales: Map<string, SucursalInfo>): boolean {
  if (f.canal && f.canal !== canal) return false;
  if (f.sucursal && f.sucursal !== w) return false;
  if (f.zona && zonaDe(sucursales, w) !== f.zona) return false;
  return true;
}

/**
 * Arma los dos rankings de la semana. `lineas` trae, de los tickets con alguna promoción, las líneas
 * de los códigos de promoción y las de los productos que las activan (nada más hace falta).
 */
export function armarRankings(p: {
  lineas: LineaVenta[];
  promos: PromoBase[];
  objetivos: ObjetivoParticipante[];
  sucursales: Map<string, SucursalInfo>;
  filtro: FiltroVenta;
}): RankingsVenta {
  const { promos, sucursales, filtro } = p;
  const lineas = p.lineas.filter((l) => enFiltro(filtro, l.canal, l.warehouse_code, sucursales));
  const promoDe = new Map(promos.map((x) => [x.code, x]));
  const nombreSuc = (w: string) => sucursales.get(w)?.nombre ?? `Sucursal ${w}`;

  // Por ticket: las promos aplicadas (con su cantidad) y lo cobrado de cada producto.
  interface Ticket { canal: Canal; w: string; vendedor: string | null; promos: Map<string, number>; importe: Map<string, number> }
  const tickets = new Map<string, Ticket>();
  for (const l of lineas) {
    const t = tickets.get(l.ticket) ?? { canal: l.canal, w: l.warehouse_code, vendedor: l.vendedor, promos: new Map(), importe: new Map() };
    if (promoDe.has(l.sku)) t.promos.set(l.sku, (t.promos.get(l.sku) ?? 0) + l.qty);
    t.importe.set(l.sku, (t.importe.get(l.sku) ?? 0) + l.importe);
    if (t.vendedor === null && l.vendedor !== null) t.vendedor = l.vendedor;
    tickets.set(l.ticket, t);
  }
  const conPromo = [...tickets.entries()].filter(([, t]) => t.promos.size > 0);

  /** Lo cobrado de los productos de una promo en un ticket. */
  const dineroEn = (t: Ticket, pr: PromoBase) => pr.productos.reduce((a, s) => a + (t.importe.get(s) ?? 0), 0);

  // ── Ranking de promociones ──
  interface Acc { paquetes: number; dinero: number }
  const nuevo = (): Acc => ({ paquetes: 0, dinero: 0 });
  const porPromo = new Map<string, { total: Acc; canal: Map<Canal, Acc>; suc: Map<string, Acc> }>();
  const porSucursal = new Map<string, number>();
  const vistoTotal = new Set<string>();
  let dineroTotal = 0;
  for (const [tk, t] of conPromo) {
    for (const [code, qty] of t.promos) {
      const pr = promoDe.get(code)!;
      const a = porPromo.get(code) ?? { total: nuevo(), canal: new Map(), suc: new Map() };
      const d = dineroEn(t, pr);
      const sumar = (x: Acc) => { x.paquetes += qty; x.dinero += d; };
      sumar(a.total);
      const ac = a.canal.get(t.canal) ?? nuevo(); sumar(ac); a.canal.set(t.canal, ac);
      const as = a.suc.get(t.w) ?? nuevo(); sumar(as); a.suc.set(t.w, as);
      porPromo.set(code, a);
      porSucursal.set(t.w, (porSucursal.get(t.w) ?? 0) + qty);
      for (const s of pr.productos) {
        const k = `${tk}|${s}`;
        if (!vistoTotal.has(k) && t.importe.has(s)) { vistoTotal.add(k); dineroTotal += t.importe.get(s)!; }
      }
    }
  }

  // Objetivos dentro del filtro, por promo y por promo × sucursal.
  const objPromo = new Map<string, number>();
  const objSuc = new Map<string, number>();
  for (const o of p.objetivos) {
    if (!(o.objetivo > 0) || !enFiltro(filtro, o.canal, o.warehouse_code, sucursales)) continue;
    objPromo.set(o.promo_id, (objPromo.get(o.promo_id) ?? 0) + o.objetivo);
    const k = `${o.promo_id}|${o.warehouse_code}`;
    objSuc.set(k, (objSuc.get(k) ?? 0) + o.objetivo);
  }

  const dineroO = (pr: PromoBase, v: number) => (pr.productos.length ? r2(v) : null);
  const promosVenta: PromoVenta[] = promos.filter((pr) => porPromo.has(pr.code)).map((pr) => {
    const a = porPromo.get(pr.code)!;
    const objetivo = objPromo.get(pr.promo_id) ?? null;
    return {
      promo_id: pr.promo_id, code: pr.code, nombre: pr.nombre,
      paquetes: a.total.paquetes, dinero: dineroO(pr, a.total.dinero),
      objetivo, avance: objetivo ? a.total.paquetes / objetivo : null,
      por_canal: CANALES.filter((c) => a.canal.has(c)).map((c) => ({ canal: c, paquetes: a.canal.get(c)!.paquetes, dinero: dineroO(pr, a.canal.get(c)!.dinero) })),
      por_sucursal: [...a.suc.entries()].map(([w, x]) => ({
        warehouse_code: w, nombre: nombreSuc(w), zona: zonaDe(sucursales, w),
        paquetes: x.paquetes, dinero: dineroO(pr, x.dinero), objetivo: objSuc.get(`${pr.promo_id}|${w}`) ?? null,
      })).sort((x, y) => y.paquetes - x.paquetes || x.warehouse_code.localeCompare(y.warehouse_code)),
    };
  }).sort((x, y) => y.paquetes - x.paquetes || (y.dinero ?? -1) - (x.dinero ?? -1) || x.nombre.localeCompare(y.nombre, 'es'));

  const top = [...porSucursal.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
  const objetivoTotal = promosVenta.reduce((acc, x) => acc + (x.objetivo ?? 0), 0);

  // ── Ranking de vendedores: sólo lo que se le cargó a cada uno ──
  interface AccV { canal: Canal; w: string; vendedor: string; tickets: Set<string>; promos: Map<string, Acc>; visto: Set<string>; total: number }
  const porVendedor = new Map<string, AccV>();
  for (const [tk, t] of conPromo) {
    if (t.vendedor === null) continue;
    const clave = `${t.canal}|${t.w}|${t.vendedor}`;
    const v = porVendedor.get(clave) ?? { canal: t.canal, w: t.w, vendedor: t.vendedor, tickets: new Set(), promos: new Map(), visto: new Set(), total: 0 };
    v.tickets.add(tk);
    for (const [code, qty] of t.promos) {
      const pr = promoDe.get(code)!;
      const x = v.promos.get(code) ?? nuevo();
      x.paquetes += qty; x.dinero += dineroEn(t, pr);
      v.promos.set(code, x);
      for (const s of pr.productos) {
        const k = `${tk}|${s}`;
        if (!v.visto.has(k) && t.importe.has(s)) { v.visto.add(k); v.total += t.importe.get(s)!; }
      }
    }
    porVendedor.set(clave, v);
  }
  const vendedores: VendedorVenta[] = [...porVendedor.entries()].map(([clave, v]) => {
    const ps: PromoDeVendedor[] = [...v.promos.entries()].map(([code, x]) => {
      const pr = promoDe.get(code)!;
      const total = dineroO(pr, x.dinero);
      return { code, nombre: pr.nombre, paquetes: x.paquetes, total, precio: total !== null && x.paquetes > 0 ? r2(total / x.paquetes) : null };
    }).sort((a, b) => b.paquetes - a.paquetes || (b.total ?? -1) - (a.total ?? -1) || a.nombre.localeCompare(b.nombre, 'es'));
    return {
      clave, canal: v.canal, warehouse_code: v.w, vendedor: v.vendedor, tickets: v.tickets.size,
      paquetes: ps.reduce((a, x) => a + x.paquetes, 0), total: r2(v.total),
      promos_sin_dato: ps.filter((x) => x.total === null).length, promos: ps,
    };
  }).sort((a, b) => b.paquetes - a.paquetes || b.total - a.total || a.clave.localeCompare(b.clave));

  const mostrador = !filtro.canal || filtro.canal === 'mostrador'
    ? conPromo.filter(([, t]) => t.canal === 'mostrador').reduce((a, [, t]) => ({
      tickets_con_promo: a.tickets_con_promo + 1, tickets_asignados: a.tickets_asignados + (t.vendedor !== null ? 1 : 0),
    }), { tickets_con_promo: 0, tickets_asignados: 0 })
    : null;

  return {
    totales: {
      paquetes: promosVenta.reduce((a, x) => a + x.paquetes, 0),
      objetivo: objetivoTotal > 0 ? objetivoTotal : null,
      dinero: r2(dineroTotal),
      promos: promosVenta.length,
      promos_sin_dato: promosVenta.filter((x) => x.dinero === null).length,
    },
    sucursal_top: top ? { warehouse_code: top[0], nombre: nombreSuc(top[0]), zona: zonaDe(sucursales, top[0]), paquetes: top[1] } : null,
    promos: promosVenta,
    vendedores,
    mostrador,
  };
}
