/**
 * `[E.27]` El descuento de una cotización, desglosado por mecanismo — como Kepler lo aplica.
 *
 *     precio de lista                Σ cantidad × lista de SU unidad
 *   − unidad mayor prorrateada       la cantidad completa una caja y se cobra a la caja (kdm2.c66)
 *   − volumen                        el tramo de kdpv_prod_util (puede ser NEGATIVO: Kepler cobra el
 *                                    tramo aunque esté arriba de la lista, y eso es un recargo)
 *   − promoción                      kdpv_descuxq de la unidad que se cobró
 *   − sin desglose                   renglones cuyo precio guardado ya no reproduce el motor de hoy
 *   ± redondeo                       Kepler cobra a centavos (kdm2.c12)
 *   = importe de los artículos       Σ importes guardados — EXACTO, por construcción
 *
 * ⚠️ Los pasos sólo valen para un renglón si el motor de HOY da su precio guardado: si Kepler movió
 * el precio, los pasos de hoy no explican el de entonces y el renglón va a «sin desglose»
 * (lista − precio guardados), nunca a un mecanismo inventado.
 */

/** Un paso del motor (`PricedLine.applied`). */
export interface PasoPrecio {
  step: string;
  before: number | null;
  after: number | null;
}

export interface RenglonParaDesglose {
  quantity: number;
  /** Lo guardado. */
  unit_price: number | null;
  list_price: number | null;
  line_total: number | null;
  /** Los pasos del motor de hoy, SÓLO si reproducen el precio guardado; null = sin desglose. */
  pasos: PasoPrecio[] | null;
}

export interface DesgloseDescuento {
  lista: number;
  unidad_mayor: number;
  volumen: number;
  promocion: number;
  sin_desglose: number;
  redondeo: number;
  importe: number;
  renglones: number;
  renglones_sin_desglose: number;
}

export const ETIQUETA_PASO: Record<string, string> = {
  lista: 'lista',
  unidad_mayor: 'unidad mayor',
  volumen: 'volumen',
  volumen_unidad_mayor: 'volumen de la unidad mayor',
  promo_cantidad: 'promoción',
  gratis_cantidad: 'regalo',
};

const cent = (n: number): number => Math.round(n * 100);

export function desgloseDescuento(renglones: RenglonParaDesglose[]): DesgloseDescuento {
  // Todo en centavos: sumar flotantes de dos decimales arrastra error.
  let lista = 0, mayor = 0, volumen = 0, promo = 0, sin = 0, importe = 0, n = 0, nSin = 0;
  for (const r of renglones) {
    if (r.unit_price === null || r.line_total === null) continue; // sin precio: no entra al importe
    n++;
    const q = r.quantity;
    const imp = cent(r.line_total);
    importe += imp;
    const pasoLista = r.pasos?.find((p) => p.step === 'lista');
    if (r.pasos && pasoLista && pasoLista.after !== null) {
      lista += cent(q * pasoLista.after);
      for (const p of r.pasos) {
        if (p.before === null || p.after === null || p.step === 'lista') continue;
        const d = cent(q * (p.before - p.after));
        if (p.step === 'unidad_mayor') mayor += d;
        else if (p.step === 'volumen' || p.step === 'volumen_unidad_mayor') volumen += d;
        else if (p.step === 'promo_cantidad') promo += d;
      }
    } else {
      nSin++;
      const l = r.list_price ?? r.unit_price;
      lista += cent(q * l);
      sin += cent(q * (l - r.unit_price));
    }
  }
  // Lo que falta para cerrar EXACTO contra el importe guardado es el redondeo a centavos.
  const redondeo = importe - (lista - mayor - volumen - promo - sin);
  return {
    lista: lista / 100,
    unidad_mayor: mayor / 100,
    volumen: volumen / 100,
    promocion: promo / 100,
    sin_desglose: sin / 100,
    redondeo: redondeo / 100,
    importe: importe / 100,
    renglones: n,
    renglones_sin_desglose: nSin,
  };
}
