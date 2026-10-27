/**
 * `[E.27]` El descuento de una cotización, desglosado por mecanismo — como Kepler lo aplica.
 *
 *     precio de lista                Σ cantidad × lista de la presentación del renglón
 *   − volumen                        el tramo de kdpv_prod_util (puede ser NEGATIVO: Kepler cobra el
 *                                    tramo aunque esté arriba de la lista, y eso es un recargo)
 *   − promoción                      kdpv_descuxq de la unidad que se cobró
 *   − sin desglose                   renglones cuyo precio guardado ya no reproduce el motor de hoy
 *   ± redondeo                       Kepler cobra a centavos POR UNIDAD BASE (kdm2.c12): 1 CJA de 24
 *                                    PAQ a $753.09 se cobra 24 × $31.38 = $753.12 (+$0.03)
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
  volumen: 'volumen',
  promo_cantidad: 'promoción',
  gratis_cantidad: 'regalo',
};

/**
 * [E.29] Los pasos del precio en una línea: «lista $26.94 → volumen $24.79». Vacío si el precio no
 * pasó por más de un paso (la lista sola no se explica). El alta y el detalle lo escriben igual.
 */
export function pasosDelPrecio(
  aplicados: ReadonlyArray<{ step: string; after: number | null }> | null | undefined,
  dinero: (n: number) => string,
): string {
  const pasos = (aplicados ?? []).filter((p): p is { step: string; after: number } => p.after !== null);
  return pasos.length > 1 ? pasos.map((p) => (ETIQUETA_PASO[p.step] ?? p.step) + ' ' + dinero(p.after)).join(' → ') : '';
}

/**
 * `[E.29]` Qué descuento es, concreto, en este renglón: el texto que el motor ya escribe en cada
 * paso que no es la lista («Precio por volumen de 10 a más PAQ», «50% desde 1 PAQ · vigente hasta
 * 22/11/2026», «Desde 6 PAQ se regalan 1 de 88219»). Las fechas AAAA-MM-DD del servidor salen en
 * dd/mm/aaaa, como el resto de la pantalla.
 */
export function explicacionDelPrecio(
  aplicados: ReadonlyArray<{ step: string; detail?: string | null }> | null | undefined,
): string {
  return (aplicados ?? [])
    .filter((p) => p.step !== 'lista' && !!p.detail)
    .map((p) => String(p.detail).replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, '$3/$2/$1'))
    .join(' · ');
}

/**
 * `[E.29]` El precio de la presentación ANTES del redondeo de Kepler: el último paso del motor con
 * precio (la lista si no hubo descuento). null = no hay pasos con qué saberlo.
 */
export function precioSinRedondear(
  aplicados: ReadonlyArray<{ after: number | null }> | null | undefined,
): number | null {
  const conPrecio = (aplicados ?? []).filter((p) => p.after !== null);
  return conPrecio.length ? (conPrecio[conPrecio.length - 1].after as number) : null;
}

/**
 * `[E.29]` El centavo de Kepler, dicho: guarda el precio POR UNIDAD BASE a centavos, así que la
 * presentación puede quedar un centavo arriba o abajo de su precio («Kepler redondea por PAQ a
 * centavos: $739.21 → 24 × $30.80 = $739.20»). Vacío si no hubo diferencia o no se puede saber.
 */
export function notaRedondeo(
  sinRedondear: number | null,
  precio: number | null,
  base: PasoDesgloseBase | undefined,
  dinero: (n: number) => string,
): string {
  if (sinRedondear === null || precio === null || !base || Math.abs(sinRedondear - precio) < 0.005) return '';
  return `Kepler redondea por ${base.unidad} a centavos: ${dinero(sinRedondear)} → ${base.cantidad} × ${dinero(base.precio)} = ${dinero(precio)}`;
}

/** La entrada de la unidad base del desglose «(24 PAQ $30.80)» (la última). */
interface PasoDesgloseBase { cantidad: number; unidad: string; precio: number }

const cent = (n: number): number => Math.round(n * 100);

export function desgloseDescuento(renglones: RenglonParaDesglose[]): DesgloseDescuento {
  // Todo en centavos: sumar flotantes de dos decimales arrastra error.
  let lista = 0, volumen = 0, promo = 0, sin = 0, importe = 0, n = 0, nSin = 0;
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
        if (p.step === 'volumen') volumen += d;
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
  const redondeo = importe - (lista - volumen - promo - sin);
  return {
    lista: lista / 100,
    volumen: volumen / 100,
    promocion: promo / 100,
    sin_desglose: sin / 100,
    redondeo: redondeo / 100,
    importe: importe / 100,
    renglones: n,
    renglones_sin_desglose: nSin,
  };
}
