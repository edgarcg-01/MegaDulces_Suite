/**
 * `[PGP.139]` **¿Este pago tiene un anticipo sin aplicar que se pueda descontar?** Pura, para probarla sin montar el
 * Calendario. La regla de qué anticipo se le puede aplicar a cada factura (mismo acreedor, SU sucursal, lo ya
 * apartado) vive en el componente (`anticiposOfrecidos`); aquí sólo se decide qué decir y si se ofrece «Aplicar».
 *
 *  - Sólo un pago **pendiente**: uno pagado o cancelado ya no cambia lo que se transfiere.
 *  - La primera factura que todavía no lleva su renglón «Anticipo» y tiene algo libre.
 *  - Un pago **autorizado** está congelado (`[PGP.113]`): se avisa, sin botón.
 */
export interface FacturaConAnticipo<T> {
  it: T;
  /** Lo libre en anticipos para esta factura (su acreedor, su sucursal). */
  libre: number;
  /** La factura ya lleva un renglón «Anticipo». */
  yaTiene: boolean;
}

export interface AvisoAnticipo<T> {
  /** La factura a la que se le aplica; `null` = sólo se avisa (pago autorizado). */
  it: T | null;
  libre: number;
  autorizado: boolean;
}

const CENTAVO = 0.005;

export function avisoAnticipoDelPago<T>(status: string, autorizado: boolean, facturas: readonly FacturaConAnticipo<T>[]): AvisoAnticipo<T> | null {
  if (status !== 'pending') return null;
  const f = facturas.find((x) => !x.yaTiene && x.libre > CENTAVO);
  if (!f) return null;
  return { it: autorizado ? null : f.it, libre: f.libre, autorizado };
}
