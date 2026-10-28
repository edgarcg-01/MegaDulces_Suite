import { WAREHOUSE_DISPLAY_ORDER } from '@megadulces/contracts';

/**
 * `[CGA-A.59]` La ruta y la sucursal de origen de un movimiento de Caja General, para guardarlas y
 * para buscarlas (Edgar, 2026-10-28: *«que el buscador pueda buscar por ruta, y asociemos cada
 * movimiento a su sucursal: de qué servidor proviene»*).
 *
 * Puras a propósito: deciden qué se guarda y qué se busca, y así se pueden romper en una prueba.
 */

/**
 * De la ruta del documento de la bandeja (`'ruta_501'`, o `'ruta_501 · ruta_502'` si un folio
 * junta varias) al número que guarda el libro (`'501'`).
 *
 * ⛔ Si el documento trae DOS rutas distintas no se elige una: se guarda `null`. Elegir la primera
 * haría que buscar la segunda no lo encuentre, y que la pantalla afirme una sola ruta.
 */
export function rutaDelDocumento(ruta: string | null | undefined): string | null {
  const nums = [...new Set((String(ruta ?? '').match(/ruta_(\d{1,4})/gi) ?? []).map((x) => x.replace(/\D/g, '')))];
  return nums.length === 1 ? nums[0] : null;
}

/**
 * ¿El texto buscado es una ruta? «501», «R501», «r 501», «ruta 501», «Ruta_501» → `'501'`.
 *
 * ⚠️ Un número suelto de 1–4 dígitos también es un pedazo de folio o de importe; por eso la ruta
 * se agrega al OR del buscador, nunca lo reemplaza.
 */
export function rutaBuscada(texto: string | null | undefined): string | null {
  const m = /^\s*(?:r(?:uta)?[\s_-]*)?(\d{1,4})\s*$/i.exec(String(texto ?? ''));
  return m ? String(Number(m[1])) : null;
}

const sinAcentos = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * ¿El texto buscado nombra una sucursal? «canindo», «Padre Hidalgo», «yurecuaro» → sus códigos de
 * servidor Kepler de dos dígitos (`['06']`). Sale de `WAREHOUSE_DISPLAY_ORDER`, el mismo catálogo
 * que nombra la sucursal en pantalla: buscar y mostrar no pueden discrepar.
 *
 * Mínimo 4 letras: «can» no debe traer Canindo y a la vez todo lo que diga «cancelado».
 */
export function codigosDeSucursalBuscada(texto: string | null | undefined): string[] {
  const t = sinAcentos(String(texto ?? ''));
  if (t.length < 4 || /^\d+$/.test(t)) return [];
  const out: string[] = [];
  for (const g of WAREHOUSE_DISPLAY_ORDER) {
    if (!sinAcentos(g.name).includes(t)) continue;
    // Sólo los servidores de Kepler ('00'…'08'). '50', '30', '32' también son de dos dígitos pero
    // son alias de Wincaja: ningún `origen_ref` del libro empieza así (lo atrapó la prueba).
    for (const c of g.codes) if (/^0\d$/.test(c) && !out.includes(c)) out.push(c);
  }
  return out;
}
