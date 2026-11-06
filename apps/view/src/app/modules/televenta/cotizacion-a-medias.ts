/**
 * `[COT.32]` La cotización a medias se guarda en el navegador, por usuario.
 *
 * Usuarios de telemarketing reportaron que «se les corta la cotización» (2026-11-06). La causa
 * medida: la bandeja de «Nueva cotización» vivía sólo en memoria, y la app se recarga sola al
 * ocultar la pestaña cuando hay versión nueva (`[SW.2]`; ese día hubo 4 despliegues) — y quien
 * cotiza oculta la pestaña a cada rato para leer el WhatsApp del cliente. También la tiraban la
 * sesión vencida, cerrar el navegador o un apagón.
 *
 * Es un BORRADOR SIN ENVIAR, comodidad de ese navegador (no es el registro: el registro es la
 * cotización creada en el servidor). Por eso vive en `localStorage` y todo acceso va en
 * try/catch: en una ventana privada o con el almacenamiento bloqueado simplemente no hay borrador.
 * Los precios guardados NO se cobran: al crear, el servidor recalcula con SKU, cantidad y unidad,
 * y al recuperar la pantalla los vuelve a pedir.
 */
import type { ItemBandeja } from './pages/televenta-quote-new.component';
import type { QuoteOrigin, WholesaleCustomer } from './quotes.service';

export const VERSION_BORRADOR = 1;
/** Más viejo que esto ya no es «la cotización que se cortó»: se descarta solo. */
export const VIGENCIA_BORRADOR_MS = 7 * 86_400_000;

export interface BorradorCotizacion {
  v: number;
  /** epoch ms del último guardado. */
  guardado: number;
  modo: 'mayoreo' | 'contacto';
  sucursal: string;
  cliente: WholesaleCustomer | null;
  direccion: string | null;
  vendedor: string | null;
  contacto: { nombre: string; tel: string; mail: string };
  origen: QuoteOrigin;
  /** `YYYY-MM-DD` local, o null. */
  vigencia: string | null;
  lista: string;
  observaciones: string;
  bandeja: ItemBandeja[];
}

export function claveBorrador(usuario: string | null | undefined): string {
  return 'cotizacion-a-medias:' + (usuario || 'sin-usuario');
}

/** ¿Hay algo que valga la pena recuperar? Una pantalla recién abierta no es un borrador. */
export function tieneTrabajo(b: Pick<BorradorCotizacion, 'bandeja' | 'cliente' | 'contacto' | 'lista' | 'observaciones'>): boolean {
  return b.bandeja.length > 0 || !!b.cliente || !!b.contacto.nombre.trim() || !!b.lista.trim() || !!b.observaciones.trim();
}

function almacen(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** El borrador guardado, o null si no hay, es de otra versión, está vencido o no se puede leer. */
export function leerBorrador(clave: string, ahora = Date.now(), s: Storage | null = almacen()): BorradorCotizacion | null {
  try {
    const raw = s?.getItem(clave);
    if (!raw) return null;
    const b = JSON.parse(raw) as BorradorCotizacion;
    if (b?.v !== VERSION_BORRADOR || !Array.isArray(b.bandeja) || !(ahora - b.guardado < VIGENCIA_BORRADOR_MS)) {
      s?.removeItem(clave);
      return null;
    }
    return tieneTrabajo(b) ? b : null;
  } catch {
    return null;
  }
}

/** Guarda si hay trabajo; si no, borra (la pantalla vacía no deja un aviso fantasma). */
export function guardarBorrador(clave: string, b: BorradorCotizacion, s: Storage | null = almacen()): void {
  try {
    if (tieneTrabajo(b)) s?.setItem(clave, JSON.stringify(b));
    else s?.removeItem(clave);
  } catch {
    // Lleno o bloqueado: no hay borrador, la pantalla sigue igual.
  }
}

export function borrarBorrador(clave: string, s: Storage | null = almacen()): void {
  try {
    s?.removeItem(clave);
  } catch {
    // nada que hacer
  }
}

/** «hace 12 min», «hace 3 h», «hace 2 días». */
export function haceCuanto(guardado: number, ahora = Date.now()): string {
  const min = Math.max(0, Math.round((ahora - guardado) / 60_000));
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return `hace ${d} ${d === 1 ? 'día' : 'días'}`;
}
