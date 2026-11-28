/**
 * `[ICR.M10]` **El código que el escáner EMITE no es, carácter por carácter, el que está
 * guardado** — y en el cache offline eso pierde el producto.
 *
 * Un lector en modo EAN-13 le agrega un cero adelante a un UPC-A de 12 dígitos. El servidor ya
 * resuelve ese caso (segundo intento normalizado, `inventory-count.service.ts`), pero la caché
 * local busca por la llave exacta `${countId}:${barcode}`, así que **sin red el mismo escaneo
 * que online funciona no reconoce nada**.
 *
 * ⛔ **El recorte `^[0-9]{8,14}$` es la regla, no un detalle.** Quitar ceros a la izquierda crea
 * ambigüedad nueva, y fuera de ese rango la crea de más: hay **336 códigos internos de 5
 * dígitos** donde el cero de adelante sí significa algo. Es el mismo criterio que usa el
 * servidor; si los dos no coinciden, el cache contesta distinto que la API y eso es peor que
 * no tener cache.
 *
 * ⛔ **El SKU no se normaliza nunca**: el cero de más lo pone el escáner sobre un código de
 * barras, no sobre un SKU.
 */

/** La forma que tiene un código de barras de retail (EAN-8/13, UPC-A/E, ITF-14). */
const FORMA_DE_CODIGO = /^[0-9]{8,14}$/;

/**
 * Devuelve el código sin los ceros de la izquierda, o `null` cuando **no hay nada que
 * normalizar** — porque no tiene forma de código de barras, y ahí tocarlo sería inventar.
 *
 * Un código que es todo ceros se normaliza a `'0'`, no a la cadena vacía: el mismo
 * `COALESCE(NULLIF(ltrim(…, '0'), ''), '0')` que hace el servidor.
 */
export function normalizarCodigoDeBarras(code: string | null | undefined): string | null {
  const c = String(code ?? '').trim();
  if (!FORMA_DE_CODIGO.test(c)) return null;
  const sinCeros = c.replace(/^0+/, '');
  return sinCeros === '' ? '0' : sinCeros;
}
