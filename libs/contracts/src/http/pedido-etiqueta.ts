/**
 * `[MCP.32]` / `[MCP.33]` El código que identifica un PEDIDO de la Suite (`PD-2026-00012`) en su etiqueta,
 * y cómo se lee de vuelta. Lo comparten quien imprime (Surtir y Revisión, en `apps/view`) y quien lee
 * (el lector del vendedor en `apps/vendor` y las listas de la Suite). Sin Angular ni base: se prueba solo.
 *
 * - **QR:** el folio tal cual (`PD-2026-00012`). Sólo el folio: ni cliente ni montos (quien lo lee tiene que
 *   entrar con su usuario para ver de quién es).
 * - **Código de barras:** 12 DÍGITOS `99` + año + número a 6 (`992026000012`). Sólo dígitos y longitud par
 *   para que CODE128 use su juego compacto C (~101 módulos ≈ 25 mm a 0.25 mm/módulo): así cabe en la
 *   etiqueta TSC de 32 mm, igual que las del checado (`checado-etiquetas.ts`). El folio completo
 *   (`PD-2026-00012`, juego B) mediría ~44 mm y no cabe. El `99` lo separa de las etiquetas del checado
 *   (empiezan con el folio de Kepler a 7 dígitos, `000…`) y de un EAN-13 (13 dígitos).
 */

const FOLIO = /^PD-(\d{4})-(\d{1,6})$/;
/**
 * Lo que manda un lector: el folio con cualquier separador (un lector de mano con la distribución de teclado
 * en español escribe `'` en lugar de `-`) o los 12 dígitos del código de barras.
 */
const LEIDO_FOLIO = /^PD[^0-9A-Z]?(\d{4})[^0-9A-Z]?(\d{1,6})$/;
const LEIDO_BARRAS = /^99(\d{4})(\d{6})$/;

/** Los 12 dígitos del código de barras del pedido, o `null` si el folio no tiene la forma de la Suite. */
export function codigoDeBarrasDePedido(folio: string | null | undefined): string | null {
  const m = FOLIO.exec(String(folio ?? '').trim().toUpperCase());
  if (!m) return null;
  return `99${m[1]}${m[2].padStart(6, '0')}`;
}

/**
 * El folio (`PD-2026-00012`) de lo que se leyó en una etiqueta de pedido, o `null` si no es una.
 * Acepta el QR, el código de barras y el folio tecleado a mano.
 */
export function folioDeLectura(texto: string | null | undefined): string | null {
  const t = String(texto ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!t) return null;
  const m = LEIDO_FOLIO.exec(t) ?? LEIDO_BARRAS.exec(t);
  if (!m) return null;
  const numero = Number(m[2]);
  if (!Number.isInteger(numero) || numero <= 0) return null;
  return `PD-${m[1]}-${String(numero).padStart(5, '0')}`;
}
