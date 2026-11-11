/**
 * `[MCP.16]` «Mis cotizaciones» del vendedor, sin Angular: cómo se dice el estado y la vigencia de
 * cada cotización, y qué se le dice cuando la lista no llega. Se prueba en
 * `pages/vendor-mis-cotizaciones.component.spec.ts`.
 *
 * La lista sale de `GET commercial/quotes?mine=true&origin=route_visit` (el mismo servidor de
 * cotizaciones de telemarketing): `{ rows, total }`, más nuevas primero (`created_at DESC`).
 */
import { esSinSenal } from '../../core/http/sin-senal';

/** Estados del servidor (`QuoteStatus` de `commercial-quotes.service.ts`). */
export type EstadoCotizacion = 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired' | 'cancelled';

/** Una fila de la lista tal como la devuelve el servidor (sólo lo que se usa). */
export interface CotizacionDeLista {
  id: string;
  code: string;
  status: EstadoCotizacion | string;
  /** El cliente de la app. `null` = se hizo fuera de la app (contacto suelto o cliente del ERP). */
  customer_id: string | null;
  recipient_name: string | null;
  /** `YYYY-MM-DD`. */
  quote_date: string;
  /** `YYYY-MM-DD`. */
  valid_until: string;
  /** Días para que venza, con la fecha del servidor. Negativo = ya venció. */
  days_to_expiry: number;
  /** `float8` en el servidor; se pasa por `Number()` igual, por si un día llega como texto. */
  total: number | string | null;
  order_code: string | null;
  kepler_folio: string | null;
}

export interface ListaDeCotizaciones {
  rows: CotizacionDeLista[];
  /** Cuántas hay en total con ese filtro, aunque la página traiga menos. */
  total: number;
}

export type Tono = 'ok' | 'warn' | 'bad' | 'neutral';

/** Abierta = el servidor todavía la deja editar (`draft`/`sent`). */
const abierta = (s: string): boolean => s === 'draft' || s === 'sent';

/**
 * La pastilla de la fila. Una abierta se dice por su vigencia (al vendedor «Borrador» no le dice
 * nada: todas las suyas lo son); una cerrada, por cómo se cerró, con el nombre del servidor.
 */
export function estadoDeCotizacion(c: Pick<CotizacionDeLista, 'status' | 'days_to_expiry'>): { texto: string; tono: Tono } {
  if (abierta(c.status)) {
    const d = Number(c.days_to_expiry);
    if (d < 0) return { texto: 'Vencida', tono: 'warn' };
    if (d === 0) return { texto: 'Vence hoy', tono: 'warn' };
    return { texto: 'Vigente', tono: 'ok' };
  }
  switch (c.status) {
    case 'accepted': return { texto: 'Aceptada', tono: 'ok' };
    case 'rejected': return { texto: 'Rechazada', tono: 'bad' };
    case 'expired': return { texto: 'Vencida', tono: 'warn' };
    case 'cancelled': return { texto: 'Cancelada', tono: 'neutral' };
    // Un estado nuevo del servidor se muestra tal cual: no se adivina qué significa.
    default: return { texto: String(c.status), tono: 'neutral' };
  }
}

/** «10 nov» de un `YYYY-MM-DD` (con año si no es el de `hoy`), sin pasar por la zona del teléfono. */
export function diaMes(f: string | null | undefined, hoy: Date = new Date()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(f ?? ''));
  if (!m) return '';
  const y = Number(m[1]);
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', timeZone: 'UTC' };
  if (y !== hoy.getFullYear()) opts.year = 'numeric';
  return new Intl.DateTimeFormat('es-MX', opts).format(new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[3]))));
}

/** El renglón de vigencia: hasta cuándo vale, cuándo venció, o a dónde fue a parar. */
export function vigenciaDe(c: CotizacionDeLista, hoy: Date = new Date()): string {
  if (abierta(c.status)) {
    const d = Number(c.days_to_expiry);
    if (d < 0) return `venció el ${diaMes(c.valid_until, hoy)}`;
    if (d === 0) return 'vence hoy';
    return `vale hasta el ${diaMes(c.valid_until, hoy)}`;
  }
  if (c.kepler_folio) return `pedido en Kepler ${c.kepler_folio}`;
  if (c.order_code) return `pedido ${c.order_code}`;
  return '';
}

export interface Falla {
  texto: string;
  tipo: 'sin_senal' | 'sin_permiso' | 'servidor';
}

/**
 * Qué se dice cuando una LECTURA falla: sin señal ≠ sin permiso ≠ lo que diga el servidor.
 * ⚠️ No usa `TEXTO_SIN_SENAL`: ése dice «no se guardó», que es de una escritura; aquí no se guardaba nada.
 */
export function motivoDeFalla(e: unknown, textos: { generico: string; sinPermiso: string }, enLinea?: boolean): Falla {
  if (esSinSenal(e, enLinea)) return { texto: 'Sin señal: no se pudo cargar. Inténtalo cuando vuelva la señal.', tipo: 'sin_senal' };
  const x = e as { status?: number; error?: { message?: string | string[] } } | null;
  if (x?.status === 403) return { texto: textos.sinPermiso, tipo: 'sin_permiso' };
  const m = x?.error?.message;
  return { texto: (Array.isArray(m) ? m.join(' · ') : m) || textos.generico, tipo: 'servidor' };
}
