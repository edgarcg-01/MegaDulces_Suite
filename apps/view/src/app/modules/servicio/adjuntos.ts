/**
 * `[MS.ADJ.3.x]` Reglas de los adjuntos de la Mesa de Servicio, del lado de la pantalla. Funciones puras (sin DOM).
 *
 * ⚠️ El que DECIDE es el servidor (`libs/service-desk`: firma del archivo, tope de 22 MB, enlace de Google normalizado).
 * Esto sólo da la respuesta inmediata —«eso no es una imagen ni un PDF»— antes de subir nada. Si una regla cambia allá y no
 * acá, el servidor sigue mandando y su mensaje se muestra tal cual. Duplicado declarado: deuda ADJ.1.4 (que el catálogo
 * entregue la política y la pantalla deje de repetirla).
 */

/** Máximo de archivos por envío: el mismo tope que el servidor (`MAX_ADJUNTOS_POR_ENVIO`). */
export const MAX_ARCHIVOS = 5;
/** Máximo de enlaces de Google por envío: el mismo tope que el servidor (`MAX_ENLACES_POR_ENVIO`). */
export const MAX_ENLACES = 3;

const TIPOS_OK = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf)$/i;
// Windows deja `type` vacío en algunos archivos (HEIC, a veces PDF): se acepta por extensión y el servidor valida por FIRMA.
const EXTENSION_OK = /\.(jpe?g|png|webp|gif|heic|heif|pdf)$/i;

export interface ArchivoMinimo {
  name: string;
  type: string;
}

/** ¿Es una imagen o un PDF? Lo que no, no se sube: se comparte por enlace. */
export function esAceptable(f: ArchivoMinimo): boolean {
  return f.type ? TIPOS_OK.test(f.type) : EXTENSION_OK.test(f.name);
}

export function separar<T extends ArchivoMinimo>(archivos: readonly T[]): { buenos: T[]; malos: T[] } {
  const buenos: T[] = [];
  const malos: T[] = [];
  for (const f of archivos) (esAceptable(f) ? buenos : malos).push(f);
  return { buenos, malos };
}

/** El aviso cuando se rechaza algo: dice qué sí se puede y a dónde ir con lo demás. */
export function avisoRechazados(malos: readonly ArchivoMinimo[]): string {
  const nombres = malos.slice(0, 3).map((f) => f.name || 'archivo sin nombre').join(', ') + (malos.length > 3 ? ` y ${malos.length - 3} más` : '');
  return `Sólo se adjuntan imágenes y PDF (${nombres}). Para otro tipo de archivo, compártelo con un enlace de Google.`;
}

/** Suma lo nuevo a lo que ya hay, sin pasar del tope. `excedio` dice si se tiró algo. */
export function unirArchivos<T>(actuales: readonly T[], nuevos: readonly T[], max = MAX_ARCHIVOS): { lista: T[]; excedio: boolean } {
  const todos = [...actuales, ...nuevos];
  return { lista: todos.slice(0, max), excedio: todos.length > max };
}

const HOSTS = new Set(['docs.google.com', 'drive.google.com']);

export type EnlaceLocal = { ok: true; url: string } | { ok: false; motivo: string };

/** Primer filtro del enlace (el servidor lo normaliza y lo vuelve a validar): https, host EXACTO de Google, sin credenciales. */
export function revisarEnlace(texto: string): EnlaceLocal {
  const t = String(texto ?? '').trim();
  if (!t) return { ok: false, motivo: 'Pega el enlace de Google.' };
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return { ok: false, motivo: 'Eso no parece un enlace.' };
  }
  if (u.protocol !== 'https:' || !HOSTS.has(u.hostname) || u.username || u.password || u.port) {
    return { ok: false, motivo: 'Sólo se aceptan enlaces de Google Docs, Hojas, Presentaciones, Formularios o Drive (https://docs.google.com/… o https://drive.google.com/…).' };
  }
  return { ok: true, url: u.toString() };
}

export const ETIQUETA_ENLACE: Readonly<Record<string, string>> = {
  documento: 'Documento de Google',
  hoja: 'Hoja de cálculo de Google',
  presentacion: 'Presentación de Google',
  formulario: 'Formulario de Google',
  archivo: 'Archivo de Drive',
  carpeta: 'Carpeta de Drive',
};

export const ICONO_ENLACE: Readonly<Record<string, string>> = {
  documento: 'pi pi-file',
  hoja: 'pi pi-table',
  presentacion: 'pi pi-desktop',
  formulario: 'pi pi-list-check',
  archivo: 'pi pi-file',
  carpeta: 'pi pi-folder',
};
