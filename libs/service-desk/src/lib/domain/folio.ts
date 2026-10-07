/**
 * `[MS.2.3]` El folio del ticket: `SRV-AAAA-NNNNN`. Función pura.
 *
 * El consecutivo lo entrega la base (`servicedesk.request_sequences`, UPSERT atómico) y el formato lo
 * exige un CHECK (`requests_folio_ck`). Esto sólo arma y lee el texto, para que el formato viva en UN
 * lugar del código y no se reescriba en cada pantalla.
 *
 * ⚠️ No es `MD-AAAA-NNNNN`: ese prefijo ya lo usan los pedidos de la tienda (`MD-2026-00012`).
 */
export const FOLIO_PREFIJO = 'SRV';
export const FOLIO_RE = /^SRV-(\d{4})-(\d{5})$/;

export function formatFolio(year: number, numero: number): string {
  if (!Number.isInteger(year) || year < 2000 || year > 2999) throw new Error(`Año de folio inválido: ${year}`);
  if (!Number.isInteger(numero) || numero < 1 || numero > 99999) throw new Error(`Consecutivo de folio fuera de rango: ${numero}`);
  return `${FOLIO_PREFIJO}-${year}-${String(numero).padStart(5, '0')}`;
}

export function parseFolio(folio: string): { year: number; numero: number } | null {
  const m = FOLIO_RE.exec(String(folio ?? '').trim().toUpperCase());
  return m ? { year: Number(m[1]), numero: Number(m[2]) } : null;
}
