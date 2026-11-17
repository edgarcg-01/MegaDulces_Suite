import type { CreditoPorSucursal } from '@megadulces/contracts';

/**
 * `[PGP.141]` **Notas de crédito aplicables** de un proveedor en UNA sucursal. Edgar, 2026-11-17: *«hay que agregar un
 * texto que diga “este proveedor/factura tiene notas de crédito aplicables”»*. Pura, para probarla sin el Calendario.
 *
 * Aplicable = crédito sin aplicar (notas de crédito, devoluciones, bonificaciones; SIN anticipos, que tienen su propio
 * aviso) **en la sucursal de la factura** y con deuda viva en esa sucursal: Kepler no aplica un crédito de una sucursal
 * contra la factura de otra. Medido en prod el 2026-11-17: las notas de crédito Kepler las aplica casi todas solas; lo
 * que queda son devoluciones de compra ($0.34 M aplicables).
 */
export interface NotaAplicable {
  a_favor: number;
  /** Las clases, en minúsculas, para el texto («devolución de compra»). */
  clases: string;
}

const CENTAVO = 0.005;

export function notaAplicable(porSucursal: readonly CreditoPorSucursal[] | null | undefined, sucursal: string | null | undefined): NotaAplicable | null {
  if (!porSucursal?.length || !sucursal) return null;
  const s = porSucursal.find((x) => x.sucursal === sucursal);
  if (!s || !s.con_deuda || !(Number(s.a_favor) > CENTAVO)) return null;
  return { a_favor: Number(s.a_favor), clases: String(s.clases ?? '').toLowerCase() };
}
