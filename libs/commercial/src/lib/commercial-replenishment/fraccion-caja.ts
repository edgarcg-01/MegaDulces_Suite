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

/** Un renglón con su factor de caja (piezas por caja), para juzgarlo también en PIEZAS. */
export interface RenglonCantidadConFactor extends RenglonCantidad {
  /** Piezas por caja del producto en ese almacén; `null`/0 = no medido → sólo valen cajas enteras. */
  piezas_por_caja?: number | string | null;
}

/** Tolerancia: `final_qty` se guarda a 3 decimales (0.4 cj × 50 = 20.0; 0.489 × 45 = 22.005). */
const TOLERANCIA_PIEZAS = 0.02;

/**
 * `[PQ.17]` **Cuántas piezas enteras son estas cajas, o `null` si no son enteras.**
 *
 * La mesa deja capturar en PIEZAS cuando el sugerido no llega a media caja, y eso aterriza en
 * `final_qty` como fracción de caja (0.4 cj de un producto de 10 por caja = 4 pz). Medido en prod
 * el 2026-10-27: los 42 renglones vivos con fracción son TODOS piezas enteras (4, 20, 22, 50…).
 * Kepler captura sus líneas en la unidad del producto el 64 % de las veces (PAQ/PZA, §12.3 del
 * plan PQ): escribir 4 PZA es la fórmula de Kepler; redondear a 1 caja inventa compra (×2.5) y
 * a 0 borra lo que la sucursal pidió.
 */
export function piezasEnteras(l: RenglonCantidadConFactor): number | null {
  const cajas = Number(l?.final_qty);
  const uxc = Number(l?.piezas_por_caja);
  if (!Number.isFinite(cajas) || !Number.isFinite(uxc) || uxc <= 0) return null;
  const pz = cajas * uxc;
  const ent = Math.round(pz);
  return ent > 0 && Math.abs(pz - ent) <= TOLERANCIA_PIEZAS ? ent : null;
}

/**
 * `[PQ.17]` D23 — los renglones que NO se pueden escribir en ninguna unidad: ni cajas enteras ni
 * piezas enteras. Es el freno que reemplaza a `renglonesConFraccion` donde se conoce el factor.
 */
export function renglonesSinUnidadEntera<T extends RenglonCantidadConFactor>(lineas: readonly T[]): T[] {
  return renglonesConFraccion(lineas).filter((l) => piezasEnteras(l) === null);
}

/** El mensaje del rechazo: dice cuántos son y **cuáles**, que es lo que se arregla. */
export function mensajeFraccion(fraccion: readonly RenglonCantidad[], tope = 5): string {
  const muestra = fraccion.slice(0, tope).map((l) => `${l.sku}=${l.final_qty}`).join(', ');
  return `No se puede escribir en Kepler: ${fraccion.length} renglón(es) traen fracción de caja que tampoco es un número entero de piezas `
    + `(${muestra}${fraccion.length > tope ? ', …' : ''}). Captura esos renglones en cajas completas o en piezas enteras.`;
}
