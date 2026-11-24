/**
 * `[MCP.12]` La cotización del vendedor, del lado de la app y sin Angular: qué peldaño se cotiza, qué
 * le llega al cliente por WhatsApp y qué existencia se ve al cotizar. Se prueba sola (cotizacion.spec.ts).
 *
 * El precio NUNCA lo pone la app: lo calcula el servidor de cotizaciones (el mismo de telemarketing,
 * `commercial/quotes`) con los mecanismos de Kepler. Aquí sólo se decide QUÉ y CUÁNTO.
 */
import type { PriceRow } from '../portal/portal.service';
import { ODS_HOT_TOLERANCIA_H } from '@megadulces/contracts';
import { cantidadEnUnidad } from './zona-existencias';

/** Peldaño del motor de cotizaciones: unidad base, paquete o caja. */
export type Rung = 'base' | 'pack' | 'box';

/** Un renglón de la cotización como lo devuelve `GET commercial/quotes/:id` (sólo lo que se usa). */
export interface RenglonCotizado {
  id: string;
  line_number: number;
  product_id: string | null;
  product_name: string | null;
  product_sku: string | null;
  requested_text: string | null;
  quantity: number | string;
  qty_unit: string | null;
  qty_factor: number | string | null;
  unit_price: number | string | null;
  line_total: number | string | null;
  /** Un regalo del ERP («= GRATIS») nace como renglón hijo: su padre es este número. */
  parent_line_number: number | null;
}

export interface CotizacionDetalle {
  id: string;
  code: string;
  status: string;
  valid_until: string | null;
  total: number | string | null;
  recipient_name?: string | null;
  created_by_name?: string | null;
  source_branch?: string | null;
  branch_writable?: boolean;
  /** `[MCP.34]` El pedido en que se volvió (lo trae `GET /commercial/quotes/:id`). */
  order_id?: string | null;
  order_code?: string | null;
  lines: RenglonCotizado[];
}

const RUNGS: ReadonlySet<string> = new Set(['base', 'pack', 'box']);

/** El peldaño de la unidad elegida, según la escalera del producto. Sin escalera, la base. */
export function rungDeUnidad(p: Pick<PriceRow, 'rungs'>, unidad: string | null | undefined): Rung {
  const r = (p.rungs ?? []).find((x) => x.unit === unidad)?.rung;
  return r && RUNGS.has(r) ? (r as Rung) : 'base';
}

/** Los renglones que el vendedor captura (los regalos los pone el motor solo). */
export const renglonesPropios = (ls: RenglonCotizado[]): RenglonCotizado[] => ls.filter((l) => l.parent_line_number == null);

/** El renglón de la cotización de ese producto, si ya está. */
export const renglonDe = (ls: RenglonCotizado[], productId: string): RenglonCotizado | undefined =>
  renglonesPropios(ls).find((l) => l.product_id === productId);

const pesos = (n: number): string => n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });

/** «10 nov 2026» de un `YYYY-MM-DD`, sin pasar por la zona horaria del teléfono. */
export function fechaCorta(f: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(f ?? ''));
  if (!m) return '';
  return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))));
}

/** El texto que se le manda al cliente: lo mismo que ve en el documento, sin datos internos. */
export function mensajeWhatsApp(c: CotizacionDetalle, cliente: string, sucursal: string): string {
  const ls = c.lines.map((l) => {
    const qty = Number(l.quantity);
    const unidad = l.qty_unit || 'PZA';
    const nombre = l.product_name || l.requested_text || 'Producto';
    const regalo = l.parent_line_number != null ? ' (regalo)' : ` · ${pesos(Number(l.line_total) || 0)}`;
    return `• ${qty} ${unidad} ${nombre}${l.product_sku ? ` (SKU ${l.product_sku})` : ''}${regalo}`;
  });
  return [
    `Mega Dulces · Cotización ${c.code}`,
    `Para: ${cliente}`,
    '',
    ...ls,
    '',
    `Total: ${pesos(Number(c.total) || 0)}`,
    c.valid_until ? `Precios de ${sucursal}, válidos hasta el ${fechaCorta(c.valid_until)}.` : `Precios de ${sucursal}.`,
    'La existencia se confirma al levantar el pedido.',
  ].join('\n');
}

/** Número para wa.me: sólo dígitos; un número de 10 dígitos de México lleva el 52. `null` = no hay. */
export function numeroWhatsApp(...candidatos: Array<string | null | undefined>): string | null {
  for (const c of candidatos) {
    const d = String(c ?? '').replace(/\D/g, '');
    if (d.length === 10) return `52${d}`;
    if (d.length >= 11 && d.length <= 13) return d;
  }
  return null;
}

/** El link de WhatsApp: con número, directo al cliente; sin número, que el vendedor elija el chat. */
export function linkWhatsApp(texto: string, numero: string | null): string {
  return `https://wa.me/${numero ?? ''}?text=${encodeURIComponent(texto)}`;
}

/**
 * `[MCP.35]` La existencia de la sucursal junto a cada producto del catálogo de cotizar: la MISMA lectura que
 * «Tomar pedido» (el catálogo del vendedor con `stock_state`), la misma tolerancia de frescura
 * (`ODS_HOT_TOLERANCIA_H`) y la misma forma de decirla (`cantidadEnUnidad`: «14 CJA», o «5 pzas» si no
 * completa una). Así cotizar y pedir no se contradicen. Sin dato se DICE «Sin dato», nunca «0» (ADR-056).
 */
export function existenciaParaCotizar(
  p: Pick<PriceRow, 'stock_available' | 'stock_state' | 'stock_checked_at' | 'rungs' | 'units'>,
  unidad: string,
  ahoraMs: number = Date.now(),
): { texto: string; tono: 'ok' | 'warn' | 'bad' | 'nd' } {
  let st = p.stock_state ?? null;
  if (st && st !== 'sin_dato') {
    const at = p.stock_checked_at ? Date.parse(p.stock_checked_at) : Number.NaN;
    if (Number.isFinite(at) && ahoraMs - at > ODS_HOT_TOLERANCIA_H * 3_600_000) st = 'sin_dato';
  }
  if (st === 'agotado') return { texto: 'Sin existencias', tono: 'bad' };
  if (st === 'no_se_maneja') return { texto: 'No se maneja en tu sucursal', tono: 'nd' };
  if (st === 'sin_dato' || (!st && p.stock_available == null)) return { texto: 'Sin dato de existencia', tono: 'nd' };
  if (p.stock_available == null) return { texto: 'Hay existencias', tono: 'ok' };
  const n = Number(p.stock_available);
  if (!st && !(n > 0)) return { texto: 'Sin existencias', tono: 'bad' };
  const factor = Number((p.rungs ?? []).find((r) => r.unit === unidad)?.factor ?? (p.units ?? []).find((u) => u.unit === unidad)?.factor ?? 1) || 1;
  const base = (p.rungs ?? []).find((r) => Number(r.factor) === 1)?.unit ?? p.units?.[0]?.unit ?? 'PZA';
  return {
    texto: 'Existencias: ' + cantidadEnUnidad(n, factor, unidad, base),
    tono: factor > 1 && Math.floor(n / factor) < 1 ? 'warn' : 'ok',
  };
}
