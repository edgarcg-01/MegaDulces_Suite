/**
 * `[BU.4]` ¿Lo que se escribió en un buscador de producto es un CÓDIGO DE BARRAS? Una sola regla para
 * el navegador (la app del vendedor traduce el código antes de filtrar su catálogo) y para la API (el
 * buscador del servidor suma la búsqueda en las casillas de código de Kepler).
 *
 * Medido en prod el 2026-11-14 sobre las 7 casillas de código de `kepler_ods.kdii`
 * (`c7`, `c93`, `c102` base · `c82`, `c95`, `c96` unidad dos · `c85` unidad tres; ERP_KEPLER §3.y.4):
 *
 * | Forma | Casillas | Por qué entra |
 * |---|---:|---|
 * | 8 a 14 dígitos | 71,779 | EAN-8, UPC-A, EAN-13, ITF-14 |
 * | 6 o 7 dígitos | 3,754 | códigos internos como `006001`; la clave de Kepler es de 5, así que no la pisa |
 * | `C` + 5 dígitos | 76,170 | la etiqueta de caja que Kepler imprime al reetiquetar (`kdii-codigo.ts`) |
 *
 * Fuera: 1 a 5 dígitos (eso es una CLAVE y ya la busca el SKU) y todo lo que traiga espacios o
 * letras sueltas (eso es un nombre). Así «gomitas» o «coca 600» no pagan la consulta de códigos.
 */
const FORMA_CODIGO_DE_BARRAS = /^(?:[0-9]{6,14}|[Cc][0-9]{5})$/;

export function pareceCodigoDeBarras(texto: string | null | undefined): boolean {
  return FORMA_CODIGO_DE_BARRAS.test(String(texto ?? '').trim());
}

/** El código como lo guarda Kepler (`btrim`, mayúsculas para la `C` de la etiqueta de caja). */
export function normalizarCodigoDeBarras(texto: string | null | undefined): string {
  return String(texto ?? '').trim().toUpperCase();
}
