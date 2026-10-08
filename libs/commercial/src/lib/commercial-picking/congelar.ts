/**
 * `[GP.3]` Lo que se congela al arrancar una ola. Funciones PURAS (sin base, sin reloj), para
 * probarlas por unidad: de aquí sale contra qué se reparte la mercancía al cerrar la ola.
 *
 * Al arrancar se guardan dos cosas en la base:
 *   · `wave_order_lines`: lo que pidió CADA pedido de cada producto (lo que usa el reparto).
 *   · `wave_lines.qty_presentacion` / `unidad_presentacion`: lo que va a contar el surtidor.
 */

/** Un renglón de pedido tal como lo arma `PickingService.lineasDePedidos`. */
export interface RenglonParaCongelar {
  order_id: string;
  order_code: string;
  product_id: string | null;
  /** En unidad BASE. */
  quantity: number;
  qty_unit: string | null;
  qty_presentacion: number | null;
  unidad_presentacion: string | null;
  delivery_date: string | null;
  confirmed_at: string | null;
}

/** Una fila de `commercial.wave_order_lines` (sin `wave_id` ni auditoría). */
export interface PedidoCongelado {
  order_id: string;
  order_code: string;
  product_id: string;
  qty_requested: number;
  qty_unit: string | null;
  qty_presentacion: number | null;
  unidad_presentacion: string | null;
  delivery_date: string | null;
  confirmed_at: string | null;
}

const mil = (n: number): number => Math.round(n * 1000);
const deMil = (m: number): number => m / 1000;

/**
 * Agrupa por (pedido, producto). Un pedido de Kepler puede traer el MISMO producto en dos
 * renglones: se suman, porque el reparto y `wave_order_lines` tienen UNIQUE por pedido y producto.
 *
 * La presentación sólo se suma si los renglones la traen en la MISMA unidad; si no, queda null
 * (no se inventa un total que mezcle bultos con cajas).
 *
 * Los renglones sin producto (clave fuera del catálogo) no se congelan: `startPicking` ya frena la
 * ola antes de llegar acá.
 */
export function congelarPorPedido(renglones: readonly RenglonParaCongelar[]): PedidoCongelado[] {
  const grupos = new Map<
    string,
    PedidoCongelado & { _mil: number; _pres: number; _upres: Set<string | null>; _presNula: boolean }
  >();
  for (const r of renglones) {
    if (!r.product_id) continue;
    const k = `${r.order_id}|${r.product_id}`;
    let g = grupos.get(k);
    if (!g) {
      g = {
        order_id: r.order_id,
        order_code: r.order_code,
        product_id: r.product_id,
        qty_requested: 0,
        qty_unit: r.qty_unit,
        qty_presentacion: null,
        unidad_presentacion: null,
        delivery_date: r.delivery_date,
        confirmed_at: r.confirmed_at,
        _mil: 0,
        _pres: 0,
        _upres: new Set<string | null>(),
        _presNula: false,
      };
      grupos.set(k, g);
    }
    g._mil += mil(Number(r.quantity) || 0);
    g._upres.add(r.unidad_presentacion);
    if (r.qty_presentacion == null) g._presNula = true;
    else g._pres += mil(Number(r.qty_presentacion));
  }
  return [...grupos.values()]
    .filter((g) => g._mil > 0)
    .map((g) => {
      const unaUnidad = g._upres.size === 1 && !g._presNula ? [...g._upres][0] : null;
      return {
        order_id: g.order_id,
        order_code: g.order_code,
        product_id: g.product_id,
        qty_requested: deMil(g._mil),
        qty_unit: g.qty_unit,
        qty_presentacion: unaUnidad != null ? deMil(g._pres) : null,
        unidad_presentacion: unaUnidad,
        delivery_date: g.delivery_date,
        confirmed_at: g.confirmed_at,
      };
    });
}

/**
 * Lo que va a contar el surtidor de UN producto en la ola: la suma de la presentación de todos
 * los pedidos, sólo si todos la piden en la misma unidad. Si alguno no la trae (pedido de la
 * Suite) o vienen en unidades distintas, devuelve null y la pantalla muestra la unidad base.
 */
export function presentacionDeProducto(
  pedidos: readonly Pick<PedidoCongelado, 'qty_presentacion' | 'unidad_presentacion'>[],
): { cantidad: number; unidad: string } | null {
  if (!pedidos.length) return null;
  const unidades = new Set(pedidos.map((p) => p.unidad_presentacion));
  if (unidades.size !== 1) return null;
  const unidad = [...unidades][0];
  if (unidad == null || pedidos.some((p) => p.qty_presentacion == null)) return null;
  const total = pedidos.reduce((s, p) => s + mil(Number(p.qty_presentacion)), 0);
  return { cantidad: deMil(total), unidad };
}
