/**
 * `[RE.70]` — **La llave de una devolución/nota con su entrada es `(sucursal, entrada_folio)`, nunca
 * el folio solo.** Cada sucursal de Kepler lleva su propio consecutivo de entradas: el folio
 * `0000421` existe en Padre Hidalgo, La Piedad Abastos, 8 Esquinas y Morelia Abastos, y son cuatro recepciones
 * distintas. Ligar por el folio solo pegaba a la entrada de MERENGUE LA MORENITA (Morelia Abastos,
 * 31-oct-2026) la devolución de piñatas de 8 Esquinas (31-mar-2026) y la marcaba «exacto».
 *
 * Medido en prod el 2026-11-13: **1,595 entradas** mostraban como «exacto» un ajuste de OTRA
 * sucursal ($17.99M en ajustes ajenos) contra 1,527 ligas legítimas. El resto del código ya ligaba
 * bien (`AJUSTES_KEPLER_POR_ENTRADA_SQL`, el join de `entradas con ajuste`, `entity-ref`): este era
 * el único camino que no.
 */
export interface LigaEntrada {
  sucursal?: string | null;
  entrada_folio?: string | null;
}

/** ¿El ajuste está ligado por Kepler a ESTA entrada? Sin sucursal no se puede afirmar: `false`. */
export function ligadoAEntrada(
  ajuste: { sucursal?: string | null; entrada_folio?: string | null },
  entrada: LigaEntrada,
): boolean {
  if (!entrada.sucursal || !entrada.entrada_folio) return false;
  return ajuste.sucursal === entrada.sucursal && ajuste.entrada_folio === entrada.entrada_folio;
}
