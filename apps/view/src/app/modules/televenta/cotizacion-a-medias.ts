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
 *
 * `[COT.50]` Dos huecos que dejaba, medidos el 2026-11-22:
 *   · **La sesión vencida la borraba.** El 401 llama a `logout()`, y `logout()` vacía
 *     `localStorage` salvo las claves del aparato (`[SEG.2]`). Ahora el cierre involuntario la
 *     conserva (`PREFIJOS_TRABAJO_SIN_ENVIAR` en `@megadulces/ui-web`).
 *   · **Una sola ranura por usuario.** Con dos pestañas de «Nueva cotización» (14 días: 10 pares
 *     de sesiones abiertas a la vez en las dos), la vacía BORRABA al ocultarse el respaldo de la
 *     otra, y dos capturas en paralelo se pisaban. Ahora cada pestaña escribe la suya
 *     (`cotizacion-a-medias:<usuario>:<pestaña>`), y el aviso sólo ofrece las de pestañas que ya
 *     no están abiertas: cada pestaña viva sostiene un candado de Web Locks que el navegador
 *     suelta solo al cerrarse o tronar.
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

/** Debe empezar con uno de `PREFIJOS_TRABAJO_SIN_ENVIAR` (`@megadulces/ui-web`): la prueba lo amarra. */
export const PREFIJO_BORRADOR = 'cotizacion-a-medias:';

/** Las claves de un usuario: `<prefijo><usuario>` (la de antes de COT.50) y `<prefijo><usuario>:<pestaña>`. */
export function prefijoUsuario(usuario: string | null | undefined): string {
  return PREFIJO_BORRADOR + (usuario || 'sin-usuario');
}

/** La ranura de UNA pestaña. Sin `pestana`, la clave única de antes de COT.50. */
export function claveBorrador(usuario: string | null | undefined, pestana?: string): string {
  return prefijoUsuario(usuario) + (pestana ? ':' + pestana : '');
}

/** El id de esta pestaña: distinto en cada apertura de la pantalla. */
export function nuevaPestana(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** La pestaña de una clave, o null si es la clave única de antes de COT.50. */
function pestanaDe(clave: string, prefijo: string): string | null {
  return clave.length > prefijo.length ? clave.slice(prefijo.length + 1) : null;
}

export interface BorradorGuardado {
  clave: string;
  borrador: BorradorCotizacion;
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

/**
 * `[COT.50]` Los borradores del usuario que se pueden recuperar, el más nuevo primero: todos los
 * suyos menos los de pestañas que siguen abiertas (`vivas`). Los vencidos o ilegibles se limpian
 * al pasar (lo hace `leerBorrador`).
 */
export function leerBorradores(
  usuario: string | null | undefined,
  vivas: ReadonlySet<string> = new Set(),
  ahora = Date.now(),
  s: Storage | null = almacen(),
): BorradorGuardado[] {
  const prefijo = prefijoUsuario(usuario);
  const claves: string[] = [];
  try {
    for (let i = 0; i < (s?.length ?? 0); i++) {
      const k = s?.key(i);
      if (k && (k === prefijo || k.startsWith(prefijo + ':'))) claves.push(k);
    }
  } catch {
    return [];
  }
  const out: BorradorGuardado[] = [];
  for (const clave of claves) {
    const p = pestanaDe(clave, prefijo);
    if (p && vivas.has(p)) continue;
    const borrador = leerBorrador(clave, ahora, s);
    if (borrador) out.push({ clave, borrador });
  }
  return out.sort((a, b) => b.borrador.guardado - a.borrador.guardado);
}

const CANDADO = 'cotizacion-a-medias:viva:';
type Candados = {
  request(nombre: string, cb: () => Promise<void>): Promise<unknown>;
  query(): Promise<{ held?: Array<{ name?: string }> }>;
};
function candados(): Candados | null {
  try {
    const l = (typeof navigator === 'undefined' ? undefined : (navigator as { locks?: Candados }).locks);
    return l && typeof l.request === 'function' && typeof l.query === 'function' ? l : null;
  } catch {
    return null;
  }
}

/**
 * `[COT.50]` Marca la pestaña como abierta mientras viva la pantalla. Devuelve cómo soltarla.
 * El navegador suelta el candado solo si la pestaña se cierra o truena: por eso es la prueba de
 * vida, y no una marca en `localStorage` que se quedaría puesta después de un apagón.
 */
export function marcarAbierta(pestana: string, l: Candados | null = candados()): () => void {
  if (!l) return () => undefined;
  let soltar: () => void = () => undefined;
  const hasta = new Promise<void>((r) => (soltar = r));
  l.request(CANDADO + pestana, () => hasta).catch(() => undefined);
  return () => soltar();
}

/**
 * `[COT.50]` Las pestañas que siguen abiertas. null = el navegador no sabe decirlo (sin Web Locks):
 * entonces se ofrecen todas, como antes de COT.50.
 */
export async function pestanasAbiertas(l: Candados | null = candados()): Promise<Set<string> | null> {
  if (!l) return null;
  try {
    const q = await l.query();
    return new Set((q.held ?? []).map((x) => x.name ?? '').filter((n) => n.startsWith(CANDADO)).map((n) => n.slice(CANDADO.length)));
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
