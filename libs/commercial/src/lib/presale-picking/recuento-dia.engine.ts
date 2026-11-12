import type {
  PresaleSellerOrder,
  SellerDayMissedCustomer,
  SellerDayOrder,
  SellerDayPickState,
  SellerDayPicking,
  SellerDayRecap,
  SellerDayVisits,
  VisitMonitorVendor,
  VisitNoSaleReason,
} from '@megadulces/contracts';

/**
 * `[MCP.19]` El recuento del día, armado sin tocar la base: recibe los pedidos del día, su avance
 * (el mismo de «Mis pedidos») y el día del monitoreo de visitas, y devuelve lo que ven el vendedor y
 * su supervisor. Todo lo que no se pudo leer se DECLARA (`null` + motivo), nunca se pinta como cero.
 */

/** Un pedido de la persona creado ese día, como lo lee el servicio. */
export interface FilaPedidoDelDia {
  id: string;
  code: string;
  customer_id: string | null;
  customer_name: string | null;
  status: string;
  total: number | string;
  created_at: Date | string;
  /** `[MCP.3.13]` El grupo, si lo surten varias sucursales; `null` = suelto. */
  group_id: string | null;
  cancellation_reason?: string | null;
}

export interface EntradaRecuento {
  fecha: string;
  hoy: string;
  userId: string;
  nombre: string | null;
  pedidos: readonly FilaPedidoDelDia[];
  /** El avance de los levantados; `null` = no se pudo leer. */
  avance: readonly PresaleSellerOrder[] | null;
  avanceError: string | null;
  /** El día de la persona en el monitoreo; `null` = sin ruta ni visitas, o no se pudo leer. */
  visitas: VisitMonitorVendor | null;
  visitasError: string | null;
}

/** Ni borrador ni cancelado: el mismo universo que el «Levantado» del Monitoreo vecinal. */
const NO_LEVANTADO = new Set(['draft', 'cancelled']);
/** Lo que sólo existe en la mesa de preventa: lo demás (por aprobar) todavía no se surte. */
const EN_MESA = new Set(['confirmed', 'fulfilled']);

const round2 = (n: number): number => Math.round(n * 100) / 100;
const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

/** Cómo va un pedido en el surtido. Sin su fila de avance = `sin_dato` (no se sabe), salvo lo que aún no llega a la mesa. */
export function estadoDeSurtido(status: string, a: PresaleSellerOrder | undefined, avanceLeido: boolean): SellerDayPickState {
  if (!EN_MESA.has(status)) return 'sin_surtir';
  if (!avanceLeido || !a) return 'sin_dato';
  if (a.finished) return a.finished.outcome;
  if (a.started) return 'surtiendo';
  return 'sin_surtir';
}

/** Cuánto bajó el pedido al surtir y en caja: lo de antes del surtido menos cómo quedó (nunca negativo). */
export function cuantoBajo(a: PresaleSellerOrder | undefined, total: number): number {
  if (!a?.finished) return 0;
  const antes = a.report?.total_before ?? a.review?.total_before ?? total;
  const quedo = a.review?.total_after ?? a.report?.total_after ?? antes;
  return Math.max(0, round2(Number(antes) - Number(quedo)));
}

function pedidoDelDia(f: FilaPedidoDelDia, a: PresaleSellerOrder | undefined, avanceLeido: boolean): SellerDayOrder {
  const total = Number(f.total) || 0;
  return {
    order_id: f.id,
    code: f.code,
    customer_id: f.customer_id,
    customer_name: f.customer_name,
    total,
    created_at: iso(f.created_at),
    status: f.status,
    pick: estadoDeSurtido(f.status, a, avanceLeido),
    removed_total: cuantoBajo(a, total),
    charge: a?.charge?.source ?? null,
    delivered: !!a?.delivered_at,
    reason: f.status === 'cancelled' ? (f.cancellation_reason?.trim() || null) : null,
  };
}

/** Qué tan atrás va un estado: el de un pedido de varias sucursales es el de su parte más atrasada. */
const ATRASO: Record<SellerDayPickState, number> = { sin_dato: 0, sin_surtir: 1, surtiendo: 2, con_faltantes: 3, completo: 4 };

/**
 * `[MCP.3.14]` Un pedido que surten varias sucursales es UN pedido para el vendedor: se juntan sus
 * partes (la suma de sus totales, el estado de la más atrasada; cobrado/entregado sólo si lo están todas).
 */
export function juntarPartes(partes: readonly SellerDayOrder[]): SellerDayOrder {
  if (partes.length === 1) return partes[0];
  const principal = [...partes].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.code.localeCompare(b.code))[0];
  const cobros = partes.map((p) => p.charge);
  // Un completo junto a uno con faltantes queda «con faltantes»: el pedido bajó.
  const pick = partes.reduce<SellerDayPickState>((acc, p) => (ATRASO[p.pick] < ATRASO[acc] ? p.pick : acc), 'completo');
  return {
    ...principal,
    total: round2(partes.reduce((s, p) => s + p.total, 0)),
    pick,
    removed_total: round2(partes.reduce((s, p) => s + p.removed_total, 0)),
    charge: cobros.every((c) => c === 'liga') ? 'liga' : cobros.every((c) => c !== null) ? 'detectado' : null,
    delivered: partes.every((p) => p.delivered),
  };
}

function contarSurtido(ps: readonly SellerDayOrder[]): SellerDayPicking {
  const n = (f: (p: SellerDayOrder) => boolean) => ps.filter(f).length;
  return {
    completo: n((p) => p.pick === 'completo'),
    con_faltantes: n((p) => p.pick === 'con_faltantes'),
    surtiendo: n((p) => p.pick === 'surtiendo'),
    sin_surtir: n((p) => p.pick === 'sin_surtir'),
    sin_dato: n((p) => p.pick === 'sin_dato'),
    removed_total: round2(ps.reduce((s, p) => s + p.removed_total, 0)),
    charged: n((p) => p.charge === 'liga'),
    charged_to_confirm: n((p) => p.charge === 'detectado'),
    delivered: n((p) => p.delivered),
  };
}

const VISITADO = new Set(['con_pedido', 'sin_pedido', 'abierta']);

/** El día de visitas en lo que el recuento necesita. Los conteos salen de los renglones del monitoreo. */
export function visitasDelDia(v: VisitMonitorVendor): SellerDayVisits {
  const deRuta = v.rows.filter((r) => r.on_route);
  const visitadosRuta = deRuta.filter((r) => VISITADO.has(r.status)).length;
  const fuera = v.rows.filter((r) => !r.on_route && VISITADO.has(r.status)).length;
  const motivos = new Map<VisitNoSaleReason | 'sin_motivo', number>();
  for (const r of v.rows) {
    if (r.status !== 'sin_pedido') continue;
    const k = r.no_sale_reason ?? 'sin_motivo';
    motivos.set(k, (motivos.get(k) ?? 0) + 1);
  }
  const noVisitados: SellerDayMissedCustomer[] = deRuta
    .filter((r) => !VISITADO.has(r.status))
    .map((r) => ({ customer_id: r.customer_id, code: r.code, name: r.name, state: r.status }));
  return {
    route_customers: deRuta.length,
    routes: [...v.routes],
    visited: visitadosRuta + fuera,
    visited_on_route: visitadosRuta,
    off_route: fuera,
    with_order: v.rows.filter((r) => r.status === 'con_pedido').length,
    without_order: v.rows.filter((r) => r.status === 'sin_pedido').length,
    open: v.rows.filter((r) => r.status === 'abierta').length,
    missed: deRuta.filter((r) => r.status === 'no_paso' || r.status === 'se_fue_sin_abrir').length,
    pending: deRuta.filter((r) => r.status === 'pendiente').length,
    closed: v.closed,
    not_visited: noVisitados,
    no_sale_reasons: [...motivos.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || String(a.reason).localeCompare(String(b.reason))),
  };
}

export function armarRecuento(e: EntradaRecuento): SellerDayRecap {
  const avanceLeido = e.avance !== null;
  const avanceDe = new Map((e.avance ?? []).map((a) => [a.order_id, a]));
  const porOrden = <T extends { created_at: string; code: string }>(xs: T[]): T[] =>
    xs.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.code.localeCompare(b.code));

  // Los levantados, juntando las partes de un mismo pedido.
  const grupos = new Map<string, SellerDayOrder[]>();
  for (const f of e.pedidos) {
    if (NO_LEVANTADO.has(f.status)) continue;
    const k = f.group_id ?? f.id;
    const p = pedidoDelDia(f, avanceDe.get(f.id), avanceLeido);
    grupos.set(k, [...(grupos.get(k) ?? []), p]);
  }
  const levantados = porOrden([...grupos.values()].map(juntarPartes));
  const solo = (status: string) => porOrden(e.pedidos.filter((f) => f.status === status).map((f) => pedidoDelDia(f, undefined, false)));

  return {
    date: e.fecha,
    today: e.hoy,
    user_id: e.userId,
    name: e.nombre ?? e.visitas?.name ?? null,
    orders: { count: levantados.length, total: round2(levantados.reduce((s, p) => s + p.total, 0)) },
    picking: avanceLeido ? contarSurtido(levantados) : null,
    picking_unmeasured_reason: avanceLeido ? null : (e.avanceError || 'No se pudo leer el surtido.'),
    visits: e.visitas ? visitasDelDia(e.visitas) : null,
    visits_unmeasured_reason: e.visitas ? null : (e.visitasError || 'Sin ruta ni visitas ese día.'),
    pending: {
      drafts: solo('draft'),
      awaiting_approval: levantados.filter((p) => p.status === 'pending_approval'),
    },
    cancelled: solo('cancelled'),
    orders_list: levantados,
  };
}
