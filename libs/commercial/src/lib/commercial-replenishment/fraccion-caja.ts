/**
 * `[RA-FIX.3]` — **Qué se considera una fracción de caja, decidido en UN solo lugar.**
 *
 * ## Por qué existe
 *
 * `purchase_requisition_lines.final_qty` está **en cajas**, pero `/compras/pedido` deja capturar
 * en PIEZAS cuando el sugerido no llega a media caja, y eso aterriza en la misma columna como
 * fracción. Medido en prod el 2026-10-19:
 *
 * | | |
 * |---|---:|
 * | renglones con `final_qty` fraccionaria | **170** |
 * | requisiciones afectadas | **63** (22 vivas: 15 `approved` · 5 `ordered` · 2 `received`) |
 * | la más chica | **0.0070** cajas |
 *
 * Dos cosas cuelgan de ahí:
 *
 *  1. ⛔ **El ERP.** El sink escribe `c9` tal cual en `md.kdm2`, así que un renglón de 0.007
 *     produciría `0.007 CJA` en Kepler: un documento que se ve perfecto en pantalla y que nadie
 *     puede surtir.
 *  2. Los **31 renglones** con `line_cost ≠ final_qty × unit_cost` (delta ≤ $0.59) salen todos de
 *     ahí: `final_qty` se guarda a 3 decimales y el importe se calculó con el valor sin redondear.
 *
 * ## Por qué se RECHAZA y no se redondea
 *
 * ⭐ Redondear hacia abajo cambia la cantidad que una persona decidió; hacia arriba inventa
 * compra. Las dos son peores que parar y decir qué arreglar — el mismo criterio que el rechazo
 * por unidad sin resolver del adapter, que también devuelve **cuáles** SKUs.
 *
 * ⚠️ Esto **no arregla** los 170 renglones que ya existen ni decide si la captura en piezas debe
 * seguir existiendo: eso es una decisión de negocio (o se guarda la unidad junto a la cantidad, o
 * se prohíbe la fracción en el renglón). Acá sólo se impide que salga al ERP.
 */

/** Lo mínimo que hace falta saber de un renglón para juzgarlo. */
export interface RenglonCantidad {
  sku: string;
  /** Cantidad en CAJAS. */
  final_qty: number | string;
}

/**
 * Los renglones cuya cantidad no es un número entero de cajas.
 *
 * ⚠️ Acepta `string` porque `numeric` de Postgres llega como texto por node-pg y este repo no
 * registra un type parser para el OID 1700: recibir el número ya convertido es una suposición
 * que acá se paga con un falso negativo (todo pasa el freno).
 */
export function renglonesConFraccion<T extends RenglonCantidad>(lineas: readonly T[]): T[] {
  return (lineas ?? []).filter((l) => {
    const n = Number(l?.final_qty);
    return Number.isFinite(n) && n !== Math.round(n);
  });
}

/** El mensaje del rechazo: dice cuántos son y **cuáles**, que es lo que se arregla. */
export function mensajeFraccion(fraccion: readonly RenglonCantidad[], tope = 5): string {
  const muestra = fraccion.slice(0, tope).map((l) => `${l.sku}=${l.final_qty}`).join(', ');
  return `No se puede escribir en Kepler: ${fraccion.length} renglón(es) traen fracción de caja `
    + `(${muestra}${fraccion.length > tope ? ', …' : ''}). Captura esos renglones en cajas completas.`;
}
