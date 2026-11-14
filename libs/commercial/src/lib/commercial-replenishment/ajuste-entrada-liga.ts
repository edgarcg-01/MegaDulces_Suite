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

/**
 * `[RE.71]` — ¿El ajuste puede figurar como CANDIDATO (proveedor + fecha) de esta entrada? Sólo si
 * es de la misma sucursal y de un proveedor real. Testigo independiente (prod, 2026-11-14): de 1,488
 * ajustes que Kepler liga a una entrada del mismo proveedor, los 1,488 están en la sucursal de la
 * entrada y 0 en otra. Una nota a CEDIS u otra sucursal (`proveedor_interno`) es un traspaso, no
 * algo que el proveedor devolvió. En oct-2026 la regla vieja traía 4,784 candidatos ajenos de
 * 6,878, en 370 de 1,073 entradas. Sin sucursal de la entrada no se puede descartar: se deja pasar
 * (contrato de los llamadores que no la mandan).
 */
export function candidatoDeEntrada(
  ajuste: { sucursal?: string | null; proveedor_interno?: boolean | null },
  entrada: { sucursal?: string | null },
): boolean {
  if (ajuste.proveedor_interno === true) return false;
  return !entrada.sucursal || ajuste.sucursal === entrada.sucursal;
}
