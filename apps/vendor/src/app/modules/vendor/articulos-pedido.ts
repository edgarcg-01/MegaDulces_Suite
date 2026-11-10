import type { PresalePickReportLine, PresaleSellerOrder } from '@megadulces/contracts';

/**
 * `[MCP.15]` **Mis pedidos: qué pidió el vendedor y qué le surtieron, artículo por artículo.**
 *
 * Pedido de la operación de rutas vecinales (2026-11-09): «al seleccionar al cliente mostrar qué artículos
 * pidió y qué surtieron». Antes la tarjeta sólo listaba lo que CAMBIÓ («lo que llegó igual no se lista»):
 * quien quería comprobar un pedido completo no tenía dónde.
 *
 * De dónde sale cada número (sin inventar ninguno):
 *  · revisado en caja → `review.lines` (todos los renglones: pidió, surtió y cómo quedó);
 *  · surtido sin revisar → las líneas vivas del pedido (`GET commercial/orders/:id`) + el reporte del surtido:
 *    lo que se ajustó trae su «pidió/surtió»; lo que no aparece en el reporte llegó completo (pidió = surtió);
 *    lo que el surtido quitó vive sólo en `report.removed` (surtió 0);
 *  · sin surtir → las líneas vivas: «surtió» queda pendiente (`null`), no 0.
 * Sin las líneas vivas (no se pudieron leer) devuelve `null`: la pantalla lo DECLARA en vez de pintar algo.
 */

/** Una línea del pedido como la lee la app. `quantity` en unidad BASE. */
export interface LineaDelPedido {
  id: string;
  product_name?: string | null;
  quantity: number | string;
  qty_unit?: string | null;
  qty_factor?: number | string | null;
}

export interface Articulo {
  clave: string;
  producto: string;
  unidad: string;
  /** Lo que pidió. `null` = no lo pidió: el surtidor lo puso en lugar de otro. */
  pidio: number | null;
  /** Lo que surtieron. `null` = todavía no se surte. */
  surtio: number | null;
  /** Cómo quedó después de la caja, sólo si cambió respecto a lo surtido. */
  quedo: number | null;
  /** El producto que faltó y éste reemplazó. */
  enLugarDe: string | null;
  /** Algo no llegó como se pidió (para resaltarlo). */
  cambio: boolean;
}

/** La cantidad en la unidad en que se capturó; la misma regla que el servidor (`cantidadMostrada`). */
export function cantidadMostrada(l: Pick<LineaDelPedido, 'quantity' | 'qty_unit' | 'qty_factor'>): { qty: number; unit: string } {
  const base = Number(l.quantity);
  const f = Number(l.qty_factor);
  const u = String(l.qty_unit ?? '').trim();
  if (u && f > 0) {
    const q = base / f;
    if (Math.abs(q - Math.round(q)) < 1e-6) return { qty: Math.round(q), unit: u };
  }
  return { qty: base, unit: u && !(f > 0) ? u : 'PZA' };
}

/** El renglón del reporte que corresponde a esta línea: por `line_id`; en reportes viejos, por nombre y unidad únicos. */
function delReporte(l: LineaDelPedido, unidad: string, reportadas: readonly PresalePickReportLine[]): PresalePickReportLine | null {
  const exacta = reportadas.find((r) => r.line_id === l.id);
  if (exacta) return exacta;
  const nombre = l.product_name ?? '';
  const candidatas = reportadas.filter((r) => !r.line_id && r.product_name === nombre && r.unit === unidad);
  return candidatas.length === 1 ? candidatas[0] : null;
}

export function articulosDelPedido(p: PresaleSellerOrder, lineas: readonly LineaDelPedido[] | null): Articulo[] | null {
  const sustitutos = new Map((p.report?.substituted ?? []).map((s) => [s.line_id, s.for_product_name]));

  // 1 · Revisado en caja: la revisión trae todos los renglones con sus tres números.
  const revision = p.review?.lines;
  if (revision?.length) {
    return revision.map((l) => ({
      clave: l.key,
      producto: l.product_name,
      unidad: l.unit,
      pidio: sustitutos.has(l.key) ? null : l.ordered,
      surtio: l.picked,
      quedo: l.final !== l.picked ? l.final : null,
      enLugarDe: sustitutos.get(l.key) ?? null,
      cambio: sustitutos.has(l.key) || l.ordered !== l.picked || l.final !== l.picked,
    }));
  }
  if (!lineas) return null;

  // 2 · Sin surtir todavía: lo pedido, y «surtió» pendiente.
  if (!p.finished) {
    return lineas.map((l) => {
      const m = cantidadMostrada(l);
      return { clave: l.id, producto: l.product_name ?? 'Producto', unidad: m.unit, pidio: m.qty, surtio: null, quedo: null, enLugarDe: null, cambio: false };
    });
  }

  // 3 · Surtido sin revisar: líneas vivas + el reporte (lo ajustado, lo quitado y los sustitutos).
  const ajustadas = p.report?.adjusted ?? [];
  const vivas: Articulo[] = lineas.map((l) => {
    const m = cantidadMostrada(l);
    const producto = l.product_name ?? 'Producto';
    if (sustitutos.has(l.id)) {
      return { clave: l.id, producto, unidad: m.unit, pidio: null, surtio: m.qty, quedo: null, enLugarDe: sustitutos.get(l.id) ?? null, cambio: true };
    }
    const a = delReporte(l, m.unit, ajustadas);
    if (a) return { clave: l.id, producto, unidad: a.unit, pidio: a.ordered, surtio: a.picked, quedo: null, enLugarDe: null, cambio: a.ordered !== a.picked };
    return { clave: l.id, producto, unidad: m.unit, pidio: m.qty, surtio: m.qty, quedo: null, enLugarDe: null, cambio: false };
  });
  const quitadas: Articulo[] = (p.report?.removed ?? []).map((r, i) => ({
    clave: `quitado:${i}`, producto: r.product_name, unidad: r.unit, pidio: r.ordered, surtio: 0, quedo: null, enLugarDe: null, cambio: true,
  }));
  return [...vivas, ...quitadas];
}

/** `[MCP.15]` Los pedidos en el orden en que se capturaron: por día de entrega y, dentro, por folio. */
export function enOrdenDeCaptura<T extends Pick<PresaleSellerOrder, 'requested_delivery_date' | 'code'>>(pedidos: readonly T[]): T[] {
  return [...pedidos].sort((a, b) =>
    a.requested_delivery_date === b.requested_delivery_date
      ? a.code.localeCompare(b.code)
      : a.requested_delivery_date < b.requested_delivery_date ? -1 : 1);
}

export type FiltroMisPedidos = 'todos' | 'por_surtir' | 'surtidos';

/** `[MCP.15]` «Por surtir» = aún no lo termina el surtidor; «Surtidos» = ya lo terminó (con o sin revisión). */
export function filtrarPedidos<T extends Pick<PresaleSellerOrder, 'finished' | 'status'>>(pedidos: readonly T[], f: FiltroMisPedidos): T[] {
  if (f === 'por_surtir') return pedidos.filter((p) => !p.finished && p.status !== 'cancelled');
  if (f === 'surtidos') return pedidos.filter((p) => !!p.finished);
  return [...pedidos];
}
