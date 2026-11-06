/**
 * `[MV.2]` Reglas puras del Monitoreo vecinal de VENDEDORES. Sin base ni HTTP (vecinal-vendors.engine.spec.ts).
 *
 * De dónde sale cada cosa:
 *  · la visita = `commercial.vendor_visits` (abrió al cliente → `visited_at`; cerró → `ended_at`, con
 *    `had_order` y `no_sale_reason`). Varias aperturas del mismo cliente el mismo día son UNA visita:
 *    la primera llegada y el último cierre (como el monitoreo `[MCP.3.7]`);
 *  · lo LEVANTADO = sus pedidos de la app (`commercial.orders.user_id`), del día y cliente de la visita;
 *  · lo COBRADO = Kepler (`v_kepler_vecinal_sales_docs`): por cliente y día en la visita, y por ruta y
 *    día en el total del vendedor (la regla del tablero del supervisor, `attributeSales`);
 *  · la meta = `commercial.vendor_targets` por catorcena, en proporción a los días con actividad.
 */
import type { VecinalVendorRow, VecinalVendorVisit } from '@megadulces/contracts';
import { catorcenaOf, round2 } from './supervisor-board.engine';

const DIA_MS = 86_400_000;
const sumarDias = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * DIA_MS).toISOString().slice(0, 10);
/** Días con actividad (lunes a sábado) entre dos fechas, inclusive. */
export function habiles(from: string, to: string): number {
  let n = 0;
  for (let f = from; f <= to; f = sumarDias(f, 1)) if (new Date(`${f}T12:00:00Z`).getUTCDay() !== 0) n++;
  return n;
}

/**
 * La meta del periodo: por cada catorcena que toca, su meta × (días con actividad del periodo dentro
 * de ella ÷ días con actividad de la catorcena). Si ALGUNA de esas catorcenas no tiene meta, la del
 * periodo es `null`: sumar sólo las que sí tienen afirmaría una meta menor a la real.
 */
export function metaDelPeriodo(targets: ReadonlyArray<{ period_start: string; amount: number }>, from: string, to: string): number | null {
  const porInicio = new Map(targets.map((t) => [t.period_start, Number(t.amount)]));
  let total = 0;
  for (let ini = catorcenaOf(from).start; ini <= to; ini = sumarDias(ini, 14)) {
    const fin = sumarDias(ini, 13);
    const meta = porInicio.get(ini);
    if (meta == null || !Number.isFinite(meta)) return null;
    const desde = ini > from ? ini : from;
    const hasta = fin < to ? fin : to;
    const parte = habiles(desde, hasta);
    const todos = habiles(ini, fin);
    if (todos > 0 && parte > 0) total += (meta * parte) / todos;
  }
  return round2(total);
}

/** Una apertura de visita, como sale de `vendor_visits`. */
export interface VisitaCruda {
  customer_id: string;
  customer_code: string | null;
  customer_name: string | null;
  /** Día (México) de la apertura. */
  date: string;
  visited_at: string;
  ended_at: string | null;
  had_order: boolean;
  no_sale_reason: string | null;
  notes: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** Un pedido levantado, con sus productos ya en la unidad de captura. */
export interface PedidoLevantado {
  order_id: string;
  code: string;
  customer_id: string | null;
  customer_code: string | null;
  customer_name: string | null;
  /** Día (México) en que se levantó. */
  date: string;
  created_at: string;
  total: number;
  lines: VecinalVendorVisit['orders'][number]['lines'];
}

const llave = (customerId: string | null, date: string) => `${customerId ?? '—'}|${date}`;
const minutos = (a: string | null, b: string | null): number | null => {
  if (!a || !b) return null;
  const m = (Date.parse(b) - Date.parse(a)) / 60000;
  return Number.isFinite(m) && m >= 0 ? Math.round(m) : null;
};

/**
 * Las visitas del periodo con lo que se le levantó y lo que Kepler le cobró a cada cliente ese día,
 * de la más nueva a la más vieja. Un pedido sin visita abierta también sale (`sin_visita`): se le
 * vendió aunque no abrió la visita.
 *
 * `cobrado`: `null` = la fuente no se pudo leer (entonces cada visita dice `charged: null`, no 0).
 */
export function visitasDelPeriodo(
  aperturas: readonly VisitaCruda[],
  pedidos: readonly PedidoLevantado[],
  cobrado: ReadonlyMap<string, number> | null,
): VecinalVendorVisit[] {
  const grupos = new Map<string, VisitaCruda[]>();
  for (const v of aperturas) {
    const k = llave(v.customer_id, v.date);
    (grupos.get(k) ?? grupos.set(k, []).get(k)!).push(v);
  }
  const pedidosDe = new Map<string, PedidoLevantado[]>();
  for (const p of pedidos) {
    const k = llave(p.customer_id, p.date);
    (pedidosDe.get(k) ?? pedidosDe.set(k, []).get(k)!).push(p);
  }
  const out: VecinalVendorVisit[] = [];
  const armar = (vs: VisitaCruda[] | undefined, ps: PedidoLevantado[]) => {
    const orden = [...(vs ?? [])].sort((a, b) => a.visited_at.localeCompare(b.visited_at));
    const primera = orden[0];
    const cierre = [...orden].reverse().find((v) => v.ended_at) ?? null;
    const ultimo = orden[orden.length - 1];
    const abierta = !!ultimo && !ultimo.ended_at;
    const conPedido = ps.length > 0 || orden.some((v) => v.had_order);
    const ref = primera ?? ps[0];
    const date = primera?.date ?? ps[0].date;
    const customerId = primera?.customer_id ?? ps[0].customer_id;
    const motivo = [...orden].reverse().find((v) => v.no_sale_reason)?.no_sale_reason ?? null;
    out.push({
      customer_id: customerId,
      customer_code: ref.customer_code,
      customer_name: ref.customer_name,
      date,
      status: !primera ? 'sin_visita' : conPedido ? 'con_pedido' : abierta ? 'abierta' : 'sin_pedido',
      visited_at: primera?.visited_at ?? null,
      ended_at: abierta ? null : cierre?.ended_at ?? null,
      minutes: abierta ? null : minutos(primera?.visited_at ?? null, cierre?.ended_at ?? null),
      no_sale_reason: conPedido ? null : motivo,
      notes: [...orden].reverse().find((v) => v.notes)?.notes ?? null,
      latitude: primera?.latitude ?? null,
      longitude: primera?.longitude ?? null,
      orders: ps.sort((a, b) => a.created_at.localeCompare(b.created_at)).map((p) => ({ order_id: p.order_id, code: p.code, total: p.total, created_at: p.created_at, lines: p.lines })),
      ordered_total: round2(ps.reduce((a, p) => a + p.total, 0)),
      charged: cobrado === null ? null : customerId ? cobrado.get(`${customerId}|${date}`) ?? 0 : null,
    });
  };
  for (const [k, vs] of grupos) armar(vs, pedidosDe.get(k) ?? []);
  for (const [k, ps] of pedidosDe) if (!grupos.has(k)) armar(undefined, ps);
  return out.sort((a, b) => (b.visited_at ?? b.orders[0]?.created_at ?? b.date).localeCompare(a.visited_at ?? a.orders[0]?.created_at ?? a.date));
}

/** Los conteos de la fila del vendedor, a partir de sus visitas armadas. */
export function conteosDeVisitas(vs: readonly VecinalVendorVisit[]): Pick<VecinalVendorRow,
  'visits' | 'with_order' | 'no_sale_with_reason' | 'no_sale_without_reason' | 'open_visits' | 'avg_visit_minutes' | 'orders' | 'ordered_total'> {
  const abiertas = vs.filter((v) => v.visited_at);
  const cerradas = vs.map((v) => v.minutes).filter((m): m is number => m != null);
  return {
    visits: abiertas.length,
    with_order: vs.filter((v) => v.status === 'con_pedido').length,
    no_sale_with_reason: vs.filter((v) => v.status === 'sin_pedido' && !!v.no_sale_reason).length,
    no_sale_without_reason: vs.filter((v) => v.status === 'sin_pedido' && !v.no_sale_reason).length,
    open_visits: vs.filter((v) => v.status === 'abierta').length,
    avg_visit_minutes: cerradas.length ? Math.round(cerradas.reduce((a, m) => a + m, 0) / cerradas.length) : null,
    orders: vs.reduce((a, v) => a + v.orders.length, 0),
    ordered_total: round2(vs.reduce((a, v) => a + v.ordered_total, 0)),
  };
}
