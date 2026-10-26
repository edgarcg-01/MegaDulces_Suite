/**
 * `[MCP.3.6]` Reglas puras del surtido de la RUTA como un pedido global. Sin base ni HTTP: así se
 * prueban solas (presale-route.engine.spec.ts).
 *
 * Dos pasos:
 *  · `consolidar` junta los renglones de todos los pedidos de la ruta en un renglón por producto,
 *    con su total y a quién le toca: es lo que el surtidor recolecta en una vuelta.
 *  · `repartirRuta` toma lo que encontró de cada producto y lo reparte entre los renglones con la
 *    regla fija de `commercial-picking/allocation.ts` (no se copia: se llama). Sale, por pedido,
 *    lo que `planearCierre` espera: así cada pedido se cierra igual que en el surtido por pedido.
 */
import type { RouteBatchProduct } from '@megadulces/contracts';
import { repartirProducto, type PedidoDeProducto } from '../commercial-picking/allocation';
import { CierreInvalido, cantidadMostrada } from './presale-picking.engine';

/** Unidades de peso/volumen: ahí sí hay fracción (misma regla que `planearCierre`). */
const PESABLE = /^(KG|GR|LT|LTS|L|ML)$/i;

/**
 * Qué pedidos son de una ruta, en SQL: los de la misma persona confirmados entre que inició y
 * finalizó, y del MISMO día de trabajo (una ruta que nadie finalizó no se traga los pedidos de
 * mañana). `rd` = `commercial.seller_route_days`, `o` = `commercial.orders`.
 *
 * Lo usan la bandeja de siempre (NOT EXISTS: lo de una ruta no sale suelto) y la ruta (para leer
 * sus pedidos), para que las dos no puedan discrepar.
 */
export const PEDIDO_EN_RUTA_SQL = `rd.tenant_id = o.tenant_id
  AND rd.user_id = o.user_id
  AND rd.deleted_at IS NULL
  AND o.confirmed_at >= rd.started_at
  AND (rd.finished_at IS NULL OR o.confirmed_at <= rd.finished_at)
  AND (o.confirmed_at AT TIME ZONE 'America/Mexico_City')::date = rd.work_date`;

/** Un renglón de un pedido de la ruta. `quantity` en unidad BASE, como `order_lines.quantity`. */
export interface RenglonDeRuta {
  order_id: string;
  code: string;
  customer_name: string | null;
  /** ISO. Desempata el reparto: lo que se confirmó antes se sirve antes. */
  confirmed_at: string | null;
  /** `YYYY-MM-DD`. Lo que se entrega antes se sirve antes. */
  delivery_date: string | null;
  line_id: string;
  product_id: string;
  sku: string | null;
  barcode: string | null;
  product_name: string;
  brand: string | null;
  quantity: number;
  qty_unit: string | null;
  qty_factor: number | null;
}

/** Lo que sale del reparto para un pedido. */
export interface CierreDePedido {
  order_id: string;
  /** Listo para `planearCierre`: en la unidad de cada renglón. */
  marcados: Array<{ line_id: string; picked: number }>;
  /**
   * No le tocó nada en NINGÚN renglón. `planearCierre` rechaza el pedido vacío: este pedido NO se
   * cierra, se reporta para que la vendedora lo cancele.
   */
  sin_mercancia: boolean;
}

/** Redondeo a milésimas, la precisión de `order_lines.quantity`. */
const mil = (n: number): number => Math.round(n * 1000) / 1000;

/** Un producto por renglón, ordenado por marca y nombre (sin marca al final): así se camina. */
export function consolidar(renglones: readonly RenglonDeRuta[]): RouteBatchProduct[] {
  const porProducto = new Map<string, { r0: RenglonDeRuta; filas: Array<{ r: RenglonDeRuta; m: ReturnType<typeof cantidadMostrada> }> }>();
  for (const r of renglones) {
    const m = cantidadMostrada({ quantity: Number(r.quantity), qty_unit: r.qty_unit, qty_factor: r.qty_factor });
    const g = porProducto.get(r.product_id) ?? { r0: r, filas: [] };
    g.filas.push({ r, m });
    porProducto.set(r.product_id, g);
  }
  const productos: RouteBatchProduct[] = [];
  for (const [product_id, { r0, filas }] of porProducto) {
    const base = mil(filas.reduce((s, f) => s + Number(f.r.quantity), 0));
    const u0 = filas[0].m;
    const misma = filas.every((f) => f.m.unit === u0.unit && f.m.factor === u0.factor);
    productos.push({
      product_id,
      sku: r0.sku ?? null,
      barcode: r0.barcode ?? null,
      product_name: r0.product_name,
      brand: r0.brand ?? null,
      // Unidades mezcladas (PAQ y CJA): se recolecta en piezas, que es lo único que suma.
      qty: misma ? mil(filas.reduce((s, f) => s + f.m.qty, 0)) : base,
      unit: misma ? u0.unit : 'PZA',
      factor: misma ? u0.factor : 1,
      base_qty: base,
      clients: filas.map((f) => ({
        order_id: f.r.order_id, code: f.r.code, customer_name: f.r.customer_name ?? null, qty: f.m.qty, unit: f.m.unit,
      })),
    });
  }
  return productos.sort(porMarcaYNombre);
}

function porMarcaYNombre(a: RouteBatchProduct, b: RouteBatchProduct): number {
  const ma = (a.brand ?? '').trim();
  const mb = (b.brand ?? '').trim();
  if (!ma !== !mb) return ma ? -1 : 1;
  const c = ma.localeCompare(mb, 'es', { sensitivity: 'base' });
  if (c !== 0) return c;
  return a.product_name.localeCompare(b.product_name, 'es', { sensitivity: 'base' });
}

/**
 * Reparte lo encontrado entre los renglones de la ruta. Reglas:
 *  · tiene que venir CADA producto del pedido global, una sola vez, y ninguno ajeno;
 *  · lo encontrado va de 0 al total, en la unidad del producto, y entero si no es de peso;
 *  · el reparto es por RENGLÓN (dos renglones del mismo pedido no se pisan) con la regla fija de
 *    `repartirProducto`: primero lo que se entrega antes, luego lo que se confirmó antes, luego el
 *    folio. No a prorrata.
 *
 * ⚠️ Lo asignado a un renglón se expresa en SU unidad con `floor`: si a un renglón en CJA de 12 le
 *    tocan 25 piezas, se le surten 2 CJA y la pieza suelta no se le encaja (ni se pasa a otro: el
 *    reparto ya se decidió). Sólo pasa con unidades mezcladas y surtido incompleto.
 */
export function repartirRuta(
  productos: readonly RouteBatchProduct[],
  renglones: readonly RenglonDeRuta[],
  picked: ReadonlyArray<{ product_id: string; picked: number }>,
): CierreDePedido[] {
  const encontrado = new Map<string, number>();
  for (const p of picked ?? []) {
    if (!p || typeof p.product_id !== 'string') throw new CierreInvalido('Producto sin identificador.');
    if (encontrado.has(p.product_id)) throw new CierreInvalido('Un producto viene repetido.');
    encontrado.set(p.product_id, Number(p.picked));
  }
  const ids = new Set(productos.map((p) => p.product_id));
  for (const id of encontrado.keys()) {
    if (!ids.has(id)) throw new CierreInvalido('Llegó un producto que no es de esta ruta.');
  }

  const renglonesDe = new Map<string, RenglonDeRuta[]>();
  for (const r of renglones) {
    const l = renglonesDe.get(r.product_id) ?? [];
    l.push(r);
    renglonesDe.set(r.product_id, l);
  }

  const asignado = new Map<string, number>(); // line_id → en unidad del renglón
  for (const p of productos) {
    if (!encontrado.has(p.product_id)) throw new CierreInvalido(`Falta marcar «${p.product_name}».`);
    const n = encontrado.get(p.product_id) as number;
    if (!Number.isFinite(n) || n < 0) throw new CierreInvalido(`Cantidad inválida en «${p.product_name}».`);
    if (n > p.qty + 1e-9) throw new CierreInvalido(`«${p.product_name}»: no se puede encontrar más de lo pedido (${p.qty} ${p.unit}).`);
    if (!PESABLE.test(p.unit) && Math.abs(n - Math.round(n)) > 1e-9) {
      throw new CierreInvalido(`«${p.product_name}»: la cantidad en ${p.unit} va entera.`);
    }
    const filas = renglonesDe.get(p.product_id) ?? [];
    const pedidos: PedidoDeProducto[] = filas.map((r) => ({
      // Por renglón: dos líneas del mismo pedido no deben chocar en el reparto.
      order_id: r.line_id,
      order_code: r.code,
      qty_requested: Number(r.quantity),
      delivery_date: r.delivery_date,
      confirmed_at: r.confirmed_at,
    }));
    const reparto = repartirProducto(pedidos, n * p.factor);
    const porLinea = new Map(reparto.map((x) => [x.order_id, x.qty_allocated]));
    for (const r of filas) {
      const m = cantidadMostrada({ quantity: Number(r.quantity), qty_unit: r.qty_unit, qty_factor: r.qty_factor });
      const enBase = porLinea.get(r.line_id) ?? 0;
      const q = enBase / m.factor;
      asignado.set(r.line_id, PESABLE.test(m.unit) ? mil(q) : Math.floor(q + 1e-9));
    }
  }

  // Por pedido, en el orden en que llegan los renglones.
  const porPedido = new Map<string, CierreDePedido>();
  for (const r of renglones) {
    const c = porPedido.get(r.order_id) ?? { order_id: r.order_id, marcados: [], sin_mercancia: true };
    const q = asignado.get(r.line_id) ?? 0;
    c.marcados.push({ line_id: r.line_id, picked: q });
    if (q > 0) c.sin_mercancia = false;
    porPedido.set(r.order_id, c);
  }
  return Array.from(porPedido.values());
}

// ───────────────────────── [MCP.3.13] El surtido de la ruta, por sucursal ─────────────────────────

/** Persona y hora de un paso del surtido, como lo guarda la base. */
export interface PasoDeSurtido {
  by: string;
  name: string;
  at: Date | string;
}

/** Una fila de `commercial.seller_route_day_picks`: el surtido de UNA sucursal en la ruta. */
export interface SurtidoDeSucursal {
  warehouse_id: string;
  pick_started_by: string;
  pick_started_by_name: string;
  pick_started_at: Date | string;
  pick_finished_by: string | null;
  pick_finished_by_name: string | null;
  pick_finished_at: Date | string | null;
}

/** El dueño único de `seller_route_days.pick_*` (antes de [MCP.3.13]). */
export interface SurtidoLegado {
  pick_started_by: string | null;
  pick_started_by_name: string | null;
  pick_started_at: Date | string | null;
  pick_finished_by: string | null;
  pick_finished_by_name: string | null;
  pick_finished_at: Date | string | null;
}

/** Lo que un surtidor ve de la ruta: el surtido de SUS sucursales. */
export interface SurtidoVisto {
  started: PasoDeSurtido | null;
  finished: PasoDeSurtido | null;
}

const ms = (v: Date | string | null | undefined): number => (v ? new Date(v).getTime() : Number.NaN);

/**
 * `[MCP.3.13]` El estado del surtido de la ruta para quien tiene en su alcance `almacenes` (las
 * sucursales de SUS pedidos en esa ruta).
 *
 *  · Ruta sin ninguna fila en `seller_route_day_picks` → se surtió (o se está surtiendo) con el
 *    modelo de un solo dueño: manda `seller_route_days.pick_*`. Así el histórico se sigue viendo.
 *  · Con filas: sólo cuentan las de mis sucursales. Terminada = TODAS mis sucursales terminaron
 *    (empezó el primero, terminó el último). Si alguna sigue abierta, se ve quién la tiene.
 */
export function surtidoVisto(
  legado: SurtidoLegado,
  almacenes: readonly string[],
  filas: readonly SurtidoDeSucursal[],
): SurtidoVisto {
  if (!filas.length) {
    return {
      started: legado.pick_started_at ? { by: legado.pick_started_by ?? '', name: legado.pick_started_by_name ?? '', at: legado.pick_started_at } : null,
      finished: legado.pick_finished_at ? { by: legado.pick_finished_by ?? '', name: legado.pick_finished_by_name ?? '', at: legado.pick_finished_at } : null,
    };
  }
  const mias = filas.filter((f) => almacenes.includes(f.warehouse_id));
  if (!mias.length) return { started: null, finished: null };
  const porInicio = [...mias].sort((a, b) => ms(a.pick_started_at) - ms(b.pick_started_at));
  const abiertas = porInicio.filter((f) => !f.pick_finished_at);
  const todas = almacenes.every((a) => mias.some((f) => f.warehouse_id === a));
  const primero = abiertas[0] ?? porInicio[0];
  const started: PasoDeSurtido = { by: primero.pick_started_by, name: primero.pick_started_by_name, at: primero.pick_started_at };
  if (abiertas.length || !todas) return { started, finished: null };
  const ultimo = [...mias].sort((a, b) => ms(b.pick_finished_at) - ms(a.pick_finished_at))[0];
  return {
    started: { by: porInicio[0].pick_started_by, name: porInicio[0].pick_started_by_name, at: porInicio[0].pick_started_at },
    finished: { by: ultimo.pick_finished_by ?? '', name: ultimo.pick_finished_by_name ?? '', at: ultimo.pick_finished_at as Date | string },
  };
}

/** Etiqueta corta de una sucursal: `short_label`, si no el nombre. */
export function etiquetaSucursal(w: { short_label?: string | null; name?: string | null }): string | null {
  return (w.short_label ?? '').trim() || (w.name ?? '').trim() || null;
}

/** Una parte viva de un pedido agrupado: a qué grupo pertenece y de qué sucursal es. */
export interface ParteDeGrupo {
  group_id: string;
  warehouse_id: string;
  short_label: string | null;
  name: string | null;
}

/**
 * `[MCP.3.13]` Las sucursales que surten OTRAS partes de los pedidos agrupados de una ruta: las de
 * sus grupos que no son las mías (`warehouse_ids` = sucursales de mis pedidos en la ruta).
 * Ordenadas y sin repetir.
 */
export function otrasSucursales(
  ruta: { group_ids: readonly string[]; warehouse_ids: readonly string[] },
  partes: readonly ParteDeGrupo[],
): string[] {
  const grupos = new Set(ruta.group_ids);
  const mias = new Set(ruta.warehouse_ids);
  const etiquetas = new Set<string>();
  for (const p of partes) {
    if (!grupos.has(p.group_id) || mias.has(p.warehouse_id)) continue;
    const e = etiquetaSucursal(p);
    if (e) etiquetas.add(e);
  }
  return [...etiquetas].sort((a, b) => a.localeCompare(b, 'es'));
}
