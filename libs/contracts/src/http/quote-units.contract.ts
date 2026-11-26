/**
 * `[COT.58]` La pieza de un producto pieza · paquete · caja se vende sólo en el piso de ventas (cajas),
 * no en cotización: en cotización va por paquete o por caja. Regla de Francisco (2026-11-24).
 *
 * Medido en prod el 2026-11-24 con la escalera del cotizador (`QuotePricingService.ladders`) en las
 * 8 sucursales: 429 productos ofrecen 3 unidades con precio, y 362 son exactamente PZA · PAQ · CJA
 * (los mismos en las 8). A ésos aplica. Los otros 67 —granel de 250/400/500 g → KG → caja, bulto o
 * cubeta, y 7 fichas con otras unidades— conservan su unidad menor: la regla no habla de ellos.
 *
 * Una sola definición para la pantalla y el servidor. La pantalla la evalúa con la fila del buscador
 * (`v_label_prices`) y el servidor con la escalera; medido ese día, las dos coinciden en las 2,896
 * filas sucursal × producto (0 diferencias).
 *
 * Recibe los rótulos de las tres unidades QUE SE OFRECEN, de menor a mayor: null = esa unidad no
 * existe en la sucursal o no tiene precio.
 */
export function piezaSoloEnPiso(base: string | null | undefined, paquete: string | null | undefined, caja: string | null | undefined): boolean {
  const u = (s: string | null | undefined) => (s ?? '').trim().toUpperCase();
  return u(base) === 'PZA' && u(paquete) === 'PAQ' && u(caja) === 'CJA';
}

/** Lo que dice la pantalla junto a las unidades cuando la pieza no se ofrece. */
export const NOTA_PIEZA_SOLO_EN_PISO = 'Pieza: sólo en piso de ventas';

/** El rechazo del servidor cuando se pide la pieza de uno de estos productos. */
export function motivoPiezaSoloEnPiso(sku: string, nombre: string | null, paquete: number | null, caja: number | null): string {
  const pzas = (n: number | null) => (n && n > 1 ? ` (${n} PZA)` : '');
  return `La pieza de ${sku}${nombre ? ' ' + nombre.trim() : ''} se vende sólo en piso de ventas: en cotización va por paquete${pzas(paquete)} o por caja${pzas(caja)}.`;
}
