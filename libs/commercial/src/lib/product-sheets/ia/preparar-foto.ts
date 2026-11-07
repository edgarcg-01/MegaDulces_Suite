/**
 * `[NP.7.L.11d]` Lo que viaja al lector: la foto RECORTADA al producto, reducida y re-codificada.
 *
 * Plan: §10b.3 punto 7, **opción A** de D6 — «el servidor recorta la foto a la silueta antes de
 * enviarla»: lo que está fuera del encuadre del producto (el pasillo, quien pasa, una cara) no sale.
 *
 * ── ⚠️ La silueta NO se pudo ubicar con certeza en la foto (NO VALIDADO con fotos reales) ──────
 * Medido en el código el 2026-11-04:
 *   · `.lv-silueta` (46 % de ancho, 3:4, `levantamiento.component.ts`) es la figura de la pantalla
 *     de captura ANTES de abrir la cámara; no se dibuja sobre la imagen.
 *   · Sobre la vista previa se dibuja otra guía, `.cs-guia` (`camera-shot.component.ts`):
 *     `inset: 18% 14%` del ESCENARIO, con el video en `object-fit: contain`. La foto guardada es el
 *     cuadro completo del video (`drawImage` de `videoWidth × videoHeight`), así que la guía cae
 *     exactamente en la foto sólo si el escenario y el video tienen la misma proporción; si no, hay
 *     franjas negras y la guía se desplaza. Esa proporción no se guarda en la ficha.
 *   · El camino alterno (el selector del sistema cuando se niega la cámara) no tiene guía.
 * Por eso el recorte es GENEROSO: la silueta de la pantalla + 30 % por lado, y nunca menos que la guía
 * de la vista previa (supuesta del tamaño de la foto) — así lo que la persona encuadró dentro de la
 * guía no se corta. ⚠️ Esa guía es tan grande (72 % × 64 %) que «guía + 30 %» sería la foto entera: el
 * margen se aplica sólo a la silueta. Las constantes se calibran con el corpus NP.7.L.11b.
 *
 * Sin metadatos de salida: `sharp` no copia EXIF/GPS si no se le pide (`keepMetadata`).
 */
import type { ModoRecorte } from './lector.config';

// `sharp` se carga como en `expediente-gasto-document.service.ts` y `CloudinaryService`: opcional al
// importar (que el módulo arranque sin él), pero aquí SIN él no se manda nada — una foto sin recortar
// es justo lo que D6 no permite (`sharpDisponible()` lo revisa el worker antes de empezar).
// Con `moduleResolution: bundler` el tipo sale de `index.d.mts` (`export default sharp`); en ejecución
// `require` devuelve la función misma (`index.cjs`).
type Sharp = typeof import('sharp').default;
let sharp: Sharp | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sharp = require('sharp') as Sharp;
} catch {
  sharp = null;
}

export function sharpDisponible(): boolean {
  return sharp != null;
}

/** `.lv-silueta`: 46 % del ancho, proporción 3:4 (ancho:alto), centrada. */
export const SILUETA_ANCHO = 0.46;
export const SILUETA_ALTO_POR_ANCHO = 4 / 3;
/** «La silueta + 30 % por lado» (margen generoso mientras no se valide con fotos reales). */
export const MARGEN_POR_LADO = 0.3;
/** `.cs-guia`: `inset: 18% 14%` (arriba/abajo, izquierda/derecha) del escenario de la cámara. */
export const GUIA_VISOR_INSET_Y = 0.18;
export const GUIA_VISOR_INSET_X = 0.14;
/** Lado largo que la API de visión no reescala; D2 lo puede subir si el corpus lo pide. */
export const LADO_MAX_PX = 1568;
export const CALIDAD_JPEG = 85;

export interface Rectangulo {
  x: number;
  y: number;
  ancho: number;
  alto: number;
}

export interface FotoPreparada {
  base64: string;
  mediaType: 'image/jpeg';
  /** Del JPEG que viaja (después de recortar y reducir). */
  ancho: number;
  alto: number;
  /** El recorte en píxeles de la foto guardada (orientada); `null` = se mandó entera. */
  recorte: Rectangulo | null;
  bytes: number;
}

/**
 * El rectángulo que se manda, en píxeles de la foto. Pura: la geometría se prueba sin imagen.
 * Centrado; ancho = max(silueta × 1.6, guía del visor); alto igual; nunca sale de la imagen.
 */
export function rectanguloDeRecorte(ancho: number, alto: number): Rectangulo {
  const crecer = 1 + 2 * MARGEN_POR_LADO;
  const siluetaW = ancho * SILUETA_ANCHO;
  const siluetaH = siluetaW * SILUETA_ALTO_POR_ANCHO;
  const visorW = ancho * (1 - 2 * GUIA_VISOR_INSET_X);
  const visorH = alto * (1 - 2 * GUIA_VISOR_INSET_Y);
  const w = Math.min(ancho, Math.max(1, Math.round(Math.max(siluetaW * crecer, visorW))));
  const h = Math.min(alto, Math.max(1, Math.round(Math.max(siluetaH * crecer, visorH))));
  return { x: Math.floor((ancho - w) / 2), y: Math.floor((alto - h) / 2), ancho: w, alto: h };
}

/**
 * Orienta (por si quedara EXIF), recorta según `recorte`, reduce a `LADO_MAX_PX` y re-codifica a JPEG
 * `CALIDAD_JPEG`. Lanza si la imagen no se puede decodificar: eso es permanente (la misma foto falla
 * igual mañana), y el worker lo guarda como lectura con error en vez de reintentarlo.
 */
export async function prepararFoto(bytes: Buffer, op: { recorte: ModoRecorte }): Promise<FotoPreparada> {
  if (!sharp) throw new Error('sharp no está disponible: sin recorte no se manda la foto (D6, opción A)');
  // Dos pasos a propósito: con el giro y el recorte en la misma tubería, el orden en que sharp los
  // aplica depende del orden de las llamadas; así el rectángulo siempre es sobre la foto ya orientada.
  const orientada = await sharp(bytes, { failOn: 'error' }).rotate().toBuffer({ resolveWithObject: true });
  const { width, height } = orientada.info;
  const recorte = op.recorte === 'silueta' ? rectanguloDeRecorte(width, height) : null;
  let tuberia = sharp(orientada.data);
  if (recorte) tuberia = tuberia.extract({ left: recorte.x, top: recorte.y, width: recorte.ancho, height: recorte.alto });
  const salida = await tuberia
    .resize({ width: LADO_MAX_PX, height: LADO_MAX_PX, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: CALIDAD_JPEG })
    .toBuffer({ resolveWithObject: true });
  return {
    base64: salida.data.toString('base64'),
    mediaType: 'image/jpeg',
    ancho: salida.info.width,
    alto: salida.info.height,
    recorte,
    bytes: salida.data.length,
  };
}

/** `data:<tipo>;base64,<datos>` → bytes. `null` si no es un data URI en base64. */
export function bytesDeDataUri(dataUri: string | null | undefined): Buffer | null {
  const m = /^data:[^;,]*;base64,(.*)$/s.exec(String(dataUri ?? ''));
  if (!m || !m[1]) return null;
  const b = Buffer.from(m[1], 'base64');
  return b.length ? b : null;
}
