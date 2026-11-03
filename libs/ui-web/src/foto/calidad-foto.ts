/**
 * `[NP.7.L.8b]` ¿La foto salió borrosa, movida o con el lente sucio? Se mide EN EL TELÉFONO, antes de
 * subir, para repetirla en el momento y no tres días después (FASE_NP7 §10b.3 punto 2).
 *
 * Decisión de Francisco (2026-11-02): la resolución no se exige — nos adaptamos a la cámara que haya;
 * lo que importa es que la foto no esté borrosa, movida, con el lente sucio o tomada con la mano
 * temblorosa. Movida y temblorosa son poca NITIDEZ; lente sucio o neblina es poco CONTRASTE.
 *
 *  · nitidez = varianza del laplaciano (4 vecinos) de la luminancia, sobre la imagen reducida a
 *    `LADO_MEDICION` (así el número no depende de la resolución de cada teléfono).
 *  · contraste = desviación estándar de la luminancia.
 *
 * ⚠️ UMBRALES PROVISIONALES, NO CALIBRADOS. El plan pide sacarlos de 50 fotos buenas y 50 movidas
 * reales; todavía no existen. Por eso cada foto guarda su medición (`calidad` en `photos`) y la versión
 * del medidor: con las primeras fotos del piloto se recalibra. Hasta entonces se declara así.
 *
 * Pura: recibe los píxeles RGBA (de un canvas) y no toca el DOM; se prueba sin navegador.
 */

export const CALIDAD_VERSION = 'lap4-v1-provisional';
/** Lado más largo de la imagen sobre la que se mide. */
export const LADO_MEDICION = 640;
/**
 * Debajo de esto, «se ve borrosa o movida». PROVISIONAL (ver arriba): 100 es el valor de referencia
 * común para la varianza del laplaciano; en las imágenes sintéticas de la prueba, una etiqueta nítida da
 * ~14,600 y la misma desenfocada (radio 6) da ~38.
 */
export const UMBRAL_NITIDEZ = 100;
/** Debajo de esto, «se ve opaca: limpia el lente o busca más luz». PROVISIONAL. */
export const UMBRAL_CONTRASTE = 18;

export interface MedicionFoto {
  nitidez: number;
  contraste: number;
}

export type VeredictoFoto =
  | { ok: true }
  | { ok: false; motivo: 'borrosa' | 'opaca'; mensaje: string };

/** Luminancia BT.601 de cada píxel (0–255). */
function luminancia(rgba: ArrayLike<number>, n: number): Float32Array {
  const y = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) y[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  return y;
}

/** Mide nitidez y contraste de una imagen RGBA de `ancho × alto`. */
export function medirFoto(rgba: ArrayLike<number>, ancho: number, alto: number): MedicionFoto {
  const n = ancho * alto;
  if (ancho < 3 || alto < 3 || rgba.length < n * 4) return { nitidez: 0, contraste: 0 };
  const y = luminancia(rgba, n);
  let suma = 0;
  let suma2 = 0;
  for (let i = 0; i < n; i++) { suma += y[i]; suma2 += y[i] * y[i]; }
  const media = suma / n;
  const contraste = Math.sqrt(Math.max(0, suma2 / n - media * media));

  let s = 0;
  let s2 = 0;
  let m = 0;
  for (let fy = 1; fy < alto - 1; fy++) {
    for (let fx = 1; fx < ancho - 1; fx++) {
      const i = fy * ancho + fx;
      const lap = y[i - ancho] + y[i + ancho] + y[i - 1] + y[i + 1] - 4 * y[i];
      s += lap; s2 += lap * lap; m++;
    }
  }
  const mediaLap = s / m;
  const nitidez = Math.max(0, s2 / m - mediaLap * mediaLap);
  return { nitidez: Math.round(nitidez * 10) / 10, contraste: Math.round(contraste * 10) / 10 };
}

/** El veredicto para la persona, en tuteo. Primero lo borroso: es lo que más se repite. */
export function juzgarFoto(m: MedicionFoto, umbrales = { nitidez: UMBRAL_NITIDEZ, contraste: UMBRAL_CONTRASTE }): VeredictoFoto {
  if (m.nitidez < umbrales.nitidez) return { ok: false, motivo: 'borrosa', mensaje: 'Se ve borrosa o movida. Apoya los codos y repítela.' };
  if (m.contraste < umbrales.contraste) return { ok: false, motivo: 'opaca', mensaje: 'Se ve opaca. Limpia el lente o busca más luz y repítela.' };
  return { ok: true };
}

/** Dimensiones para reducir una imagen a `LADO_MEDICION` conservando la proporción. */
export function dimensionesDeMedicion(ancho: number, alto: number): { ancho: number; alto: number } {
  const lado = Math.max(ancho, alto);
  if (lado <= LADO_MEDICION) return { ancho, alto };
  const k = LADO_MEDICION / lado;
  return { ancho: Math.max(1, Math.round(ancho * k)), alto: Math.max(1, Math.round(alto * k)) };
}
