/**
 * SU.6/SU.8 — EL REPARTO DE LO QUE SE LEVANTÓ (ADR-067).
 *
 * Función **pura**: entra lo que cada pedido pidió y lo que el surtidor realmente levantó, sale
 * cuánto le toca a cada uno. Sin base de datos, sin fechas, sin `Math.random` — por eso se puede
 * probar por unidad, que es lo que hace confiable la parte que reparte mercancía escasa entre
 * clientes.
 *
 * ⛔ **El sistema NO aparta** (decisión de Edgar, 2026-09-17). Así que esto NO reparte una reserva
 * previa: reparte **un hecho** —lo que había en el anaquel cuando la persona pasó—, y por eso
 * corre al CERRAR el surtido y no al armar la ola.
 *
 * ── Por qué las reglas, y por qué se registra cuál se usó ────────────────────────────────────
 *
 * §15 del documento origen: *"El surtidor no decidirá arbitrariamente a qué cliente quitar
 * mercancía"*. Cuando alcanza para todos no hay decisión que tomar; cuando no alcanza, alguien se
 * queda corto y **eso tiene que ser explicable**. Por eso cada renglón sale con la regla que lo
 * decidió: sin ese rastro, el cliente que recibió de menos no tiene a quién preguntarle.
 */

/** Lo que UN pedido pide de UN producto. */
export interface PedidoDeProducto {
  order_id: string;
  /** Para desempatar de forma estable y legible (y para el mensaje al cliente). */
  order_code: string;
  /** En unidad BASE, igual que `order_lines.quantity`. */
  qty_requested: number;
  /** Fecha de entrega comprometida (`YYYY-MM-DD`) o null si no tiene. */
  delivery_date?: string | null;
  /** Cuándo se confirmó (ISO). Desempata por antigüedad. */
  confirmed_at?: string | null;
}

/** Cómo se decidió el reparto de un renglón. */
export type ReglaReparto =
  /** Alcanzaba para todos: no hubo que decidir nada. */
  | 'completo'
  /** No alcanzaba. Se sirvió por compromiso de entrega y antigüedad, hasta agotar. */
  | 'prioridad_entrega'
  /** No se levantó nada: nadie recibe. */
  | 'sin_mercancia';

export interface RepartoDeProducto {
  order_id: string;
  order_code: string;
  qty_requested: number;
  qty_allocated: number;
  regla: ReglaReparto;
}

/**
 * Orden de atención cuando NO alcanza. Estable y explicable:
 *   1. el que se entrega ANTES (un pedido de mañana no le gana a uno de hoy),
 *   2. a igual fecha, el que se confirmó primero,
 *   3. y si todo empata, el folio — para que dos corridas den el mismo resultado.
 *
 * ⚠️ NO se ordena por importe ni por "cliente importante": eso es una decisión comercial que
 * nadie tomó, y meterla acá la volvería invisible.
 */
function ordenDeAtencion(a: PedidoDeProducto, b: PedidoDeProducto): number {
  const fa = a.delivery_date || '9999-12-31';
  const fb = b.delivery_date || '9999-12-31';
  if (fa !== fb) return fa < fb ? -1 : 1;
  const ca = a.confirmed_at || '9999';
  const cb = b.confirmed_at || '9999';
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.order_code < b.order_code ? -1 : a.order_code > b.order_code ? 1 : 0;
}

const entero = (n: unknown): number => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/**
 * Reparte `levantado` entre los pedidos que piden ese producto.
 *
 * Garantías (las tres las vigila el spec):
 *   - **Nunca se reparte más de lo que se levantó.**
 *   - **Nadie recibe más de lo que pidió** — el sobrante no se le encaja a nadie.
 *   - El resultado es **determinista**: mismas entradas, mismo reparto.
 *
 * ⚠️ Se sirve **completo y en orden**, no a prorrata. Repartir 10 entre tres que piden 10 cada uno
 * daría 3.33 a cada uno: tres clientes con un pedido inservible en vez de uno servido. En
 * mercadería de reventa, tres cajas incompletas no son mejores que una completa.
 */
export function repartirProducto(
  pedidos: readonly PedidoDeProducto[],
  levantado: number,
): RepartoDeProducto[] {
  const enOrden = [...pedidos].sort(ordenDeAtencion);
  const disponible0 = entero(levantado);
  const total = enOrden.reduce((s, p) => s + entero(p.qty_requested), 0);

  if (disponible0 <= 0) {
    return enOrden.map((p) => ({
      order_id: p.order_id,
      order_code: p.order_code,
      qty_requested: entero(p.qty_requested),
      qty_allocated: 0,
      regla: 'sin_mercancia' as const,
    }));
  }

  // Alcanza para todos (o sobra): nadie decide nada, y el sobrante NO se reparte.
  if (disponible0 >= total) {
    return enOrden.map((p) => ({
      order_id: p.order_id,
      order_code: p.order_code,
      qty_requested: entero(p.qty_requested),
      qty_allocated: entero(p.qty_requested),
      regla: 'completo' as const,
    }));
  }

  let queda = disponible0;
  return enOrden.map((p) => {
    const pide = entero(p.qty_requested);
    const da = Math.min(pide, queda);
    queda -= da;
    return {
      order_id: p.order_id,
      order_code: p.order_code,
      qty_requested: pide,
      qty_allocated: da,
      regla: 'prioridad_entrega' as const,
    };
  });
}

/** Un producto de la ola: lo que se levantó y quiénes lo pidieron. */
export interface RenglonParaRepartir {
  product_id: string;
  /** `null` = el renglón no se tocó. Distinto de 0, que es "se pasó y no había". */
  qty_picked: number | null;
  pedidos: readonly PedidoDeProducto[];
}

export interface RepartoDeOla {
  product_id: string;
  reparto: RepartoDeProducto[];
}

/**
 * Reparte la ola entera.
 *
 * ⚠️ Un renglón con `qty_picked === null` (nadie pasó por ahí) se trata como **cero**, pero el
 * llamador NO debería llegar hasta acá con pendientes: `finishPicking` los rechaza justamente
 * porque "no se caminó" y "no había" son cosas distintas y sólo una es culpa del inventario.
 */
export function repartirOla(renglones: readonly RenglonParaRepartir[]): RepartoDeOla[] {
  return renglones.map((r) => ({
    product_id: r.product_id,
    reparto: repartirProducto(r.pedidos, r.qty_picked ?? 0),
  }));
}

/** Resumen por pedido: sirve para decir "a este cliente le falta algo" sin recorrer todo. */
export function resumenPorPedido(
  ola: readonly RepartoDeOla[],
): Array<{ order_id: string; order_code: string; completo: boolean; renglones_cortos: number }> {
  const porPedido = new Map<string, { order_code: string; cortos: number }>();
  for (const r of ola) {
    for (const a of r.reparto) {
      const cur = porPedido.get(a.order_id) ?? { order_code: a.order_code, cortos: 0 };
      if (a.qty_allocated < a.qty_requested) cur.cortos += 1;
      porPedido.set(a.order_id, cur);
    }
  }
  return Array.from(porPedido, ([order_id, v]) => ({
    order_id,
    order_code: v.order_code,
    completo: v.cortos === 0,
    renglones_cortos: v.cortos,
  }));
}
