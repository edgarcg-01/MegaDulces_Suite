/**
 * `[MS.3.12]` Fotos de campo: se achican ANTES de subirlas.
 *
 * ── Por qué ──────────────────────────────────────────────────────────────────────────────────
 * Quien atiende (o reporta) desde un teléfono sube lo que sale de la cámara: una foto de 12 a 50 MP pesa de 3 a 15 MB.
 * El servidor acepta hasta `max_attachment_mb` por archivo (8 por defecto) y va con base64 (+33 %) por una conexión
 * de sucursal que no siempre es buena. Sin esto, una foto normal de un teléfono reciente se rechaza **después** de
 * haber esperado la subida, con un 400. Para evidencia de un problema basta con que se lea: 2560 px por el lado largo
 * en JPEG de calidad 0.82 deja una foto de 300 KB a 1 MB.
 *
 * ── Qué NO toca ──────────────────────────────────────────────────────────────────────────────
 *  · **PDF y GIF** pasan tal cual (el GIF puede estar animado y un PDF no es una imagen).
 *  · Una foto **chica** (hasta `UMBRAL_BYTES`) pasa tal cual, sin decodificar: no se recomprime lo que ya cabe.
 *  · Si el navegador **no puede decodificar** la imagen (p. ej. un HEIC en un navegador que no lo lee), se sube la
 *    ORIGINAL: el servidor la valida por firma y decide. Nunca se pierde un archivo por no haberlo podido optimizar.
 *  · Si el resultado **no es más chico** que el original, se queda el original.
 *  · La orientación EXIF se respeta (`imageOrientation: 'from-image'`): una foto vertical no sale girada.
 */

/** Lado largo máximo, en píxeles. */
export const LADO_MAX = 2560;
export const CALIDAD_JPEG = 0.82;
/** Hasta este tamaño el archivo se sube sin tocarlo (1.5 MB). */
export const UMBRAL_BYTES = 1.5 * 1024 * 1024;

const OPTIMIZABLES = /^image\/(jpeg|png|webp|heic|heif)$/i;

/** ¿Es un tipo que se optimiza? (GIF y PDF no.) */
export function esOptimizable(tipo: string): boolean {
  return OPTIMIZABLES.test(tipo);
}

/** Escala `w×h` para que el lado largo no pase de `max`, conservando la proporción y SIN agrandar nunca. */
export function ladoEscalado(w: number, h: number, max: number = LADO_MAX): { w: number; h: number } {
  const largo = Math.max(w, h);
  if (!(largo > max) || w <= 0 || h <= 0) return { w, h };
  const k = max / largo;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** Nombre con extensión `.jpg` (la foto optimizada siempre sale JPEG). */
export function nombreJpg(nombre: string): string {
  const base = nombre.replace(/\.[^./\\]+$/, '');
  return `${base || 'foto'}.jpg`;
}

/** ¿Vale la pena optimizar este archivo? Sólo imágenes optimizables que pasan del umbral. */
export function debeOptimizar(f: { type: string; size: number }): boolean {
  return esOptimizable(f.type) && f.size > UMBRAL_BYTES;
}

/**
 * Devuelve el archivo optimizado, o el MISMO `File` si no hace falta o no se pudo (ver el encabezado). Nunca lanza.
 */
export async function optimizarImagen(file: File): Promise<File> {
  if (!debeOptimizar(file)) return file;
  try {
    if (typeof createImageBitmap !== 'function') return file;
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
      const { w, h } = ladoEscalado(bmp.width, bmp.height);
      const usaOffscreen = typeof OffscreenCanvas !== 'undefined';
      const lienzo: OffscreenCanvas | HTMLCanvasElement = usaOffscreen ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
      const ctx = lienzo.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!ctx) return file;
      // Fondo blanco: un PNG con transparencia pasa a JPEG, que no la tiene, y sin esto saldría negro.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      const blob: Blob | null =
        usaOffscreen
          ? await (lienzo as OffscreenCanvas).convertToBlob({ type: 'image/jpeg', quality: CALIDAD_JPEG })
          : await new Promise<Blob | null>((ok) => (lienzo as HTMLCanvasElement).toBlob(ok, 'image/jpeg', CALIDAD_JPEG));
      if (!blob || blob.size >= file.size) return file;
      return new File([blob], nombreJpg(file.name), { type: 'image/jpeg', lastModified: file.lastModified });
    } finally {
      bmp.close();
    }
  } catch {
    return file;
  }
}

/** Optimiza una lista conservando el orden. */
export function optimizarImagenes(files: readonly File[]): Promise<File[]> {
  return Promise.all(files.map(optimizarImagen));
}
