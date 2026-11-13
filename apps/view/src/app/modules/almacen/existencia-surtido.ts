import type { PresaleReviewStock } from '@megadulces/contracts';

/**
 * `[MCP.23]` Lo que dice el sistema de un renglón de preventa mientras se surte, **igual en las dos puertas
 * del surtidor**: «Surtir › Sucursal» (`/almacen/surtir`, donde aterriza y adonde lo lleva la campana) y
 * «Preventa por surtir» (`/almacen/surtir-preventa`). Vivía dentro de la segunda y la primera no lo tenía:
 * el surtidor no lo veía (medido el 2026-11-13 al recorrer la entrada del menú).
 *
 * `stock` viene del servidor (`PresalePickLine.stock`):
 *  · `undefined` = pedido cerrado o servidor anterior: no se pinta nada.
 *  · `null` = no se pudo leer: se DECLARA «sin dato», nunca cero.
 *
 * Puro: se prueba solo (existencia-surtido.spec.ts).
 */

/** «Sistema: hay 40 CJA / no hay / no se maneja aquí / sin dato / menos de 1 CJA»; `null` = no se pinta. */
export function textoSistema(stock: PresaleReviewStock | null | undefined, unidad: string): string | null {
  if (stock === undefined) return null;
  if (!stock || stock.state === 'sin_dato') return 'Sistema: sin dato';
  if (stock.state === 'agotado') return 'Sistema: no hay';
  if (stock.state === 'no_se_maneja') return 'Sistema: no se maneja aquí';
  if (stock.qty == null) return 'Sistema: sí hay';
  if (stock.qty === 0) return `Sistema: menos de 1 ${unidad}`;
  return `Sistema: hay ${stock.qty} ${unidad}`;
}

/** El sistema dice que no hay o que no se maneja: va en negritas (además de la palabra; no depende del color). */
export function sistemaSinProducto(stock: PresaleReviewStock | null | undefined): boolean {
  return stock?.state === 'agotado' || stock?.state === 'no_se_maneja';
}

/**
 * Se marcó menos de lo pedido y el sistema dice que hay al menos una unidad del renglón: que lo busque antes
 * de quitarlo. Medido en prod (30 días al 2026-11-12): en 100 de 159 renglones quitados por «no hubo», el
 * sistema tenía el producto al empezar el día. No bloquea: el anaquel manda.
 */
export function avisoBuscarEnBodega(
  stock: PresaleReviewStock | null | undefined,
  unidad: string,
  marcado: number | null,
  pedido: number,
): string | null {
  if (marcado === null || marcado >= pedido || !stock || stock.state !== 'con_existencia') return null;
  if (stock.qty === 0) return null;
  return stock.qty == null
    ? 'El sistema dice que sí hay: búscalo en bodega antes de quitarlo.'
    : `El sistema dice que hay ${stock.qty} ${unidad}: búscalo en bodega antes de quitarlo.`;
}

/**
 * Una sola vez por pedido: la hora de la lectura y que manda el anaquel (no se repite por renglón).
 * `null` = ningún renglón trae `stock` (pedido cerrado o servidor anterior).
 */
export function lecturaDeExistencia(
  stocks: ReadonlyArray<PresaleReviewStock | null | undefined>,
  horaDe: (iso: string) => string,
): string | null {
  if (!stocks.some((s) => s !== undefined)) return null;
  const horas = stocks.map((s) => s?.checked_at).filter((x): x is string => !!x).sort();
  return horas.length
    ? `«Sistema» es la existencia de Kepler al ${horaDe(horas[0])}; lo que manda es lo que ves en el anaquel.`
    : '«Sistema» es la existencia de Kepler; no se pudo leer ahora. Lo que manda es lo que ves en el anaquel.';
}
