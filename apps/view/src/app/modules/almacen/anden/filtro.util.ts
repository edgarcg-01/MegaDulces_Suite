/**
 * Andén · filtrado de la barra única. **Puro, sin Angular.**
 *
 * La barra hace dos cosas con un solo campo: recibe el disparo de la pistola y
 * filtra la lista mientras se teclea. Dos inputs compitiendo por el foco es
 * exactamente lo que rompe una pistola en modo wedge, así que hay uno solo.
 *
 * El filtro **ignora acentos y mayúsculas**: en un handheld con guantes nadie va
 * a teclear `Mazapán` con tilde, y `mazapan` tiene que encontrarlo igual.
 */

/** Minúsculas y sin diacríticos. `Mazapán` → `mazapan`. */
export function normalizar(s: string | null | undefined): string {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    // Rango de marcas diacríticas combinantes: quita la tilde y deja la letra.
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

/** Campos por los que se busca un renglón. En Ubicación se suma el rack. */
export interface Buscable {
  nombre?: string | null;
  sku?: string | null;
  barcode?: string | null;
  rack?: string | null;
}

/**
 * ¿El renglón coincide con lo tecleado? Todos los términos tienen que aparecer
 * en algún campo (AND entre palabras), así que "mazapan 28" acota de verdad en
 * vez de traer todo lo que diga "mazapan".
 */
export function coincide(item: Buscable, consulta: string): boolean {
  const q = normalizar(consulta);
  if (!q) return true;
  const heno = normalizar([item.nombre, item.sku, item.barcode, item.rack].filter(Boolean).join(' '));
  return q.split(/\s+/).every((t) => heno.includes(t));
}

export function filtrar<T extends Buscable>(items: T[], consulta: string): T[] {
  const q = normalizar(consulta);
  if (!q) return items;
  return items.filter((i) => coincide(i, consulta));
}
