/**
 * `[LE.6.7]` — **Recibir un cobro en la Ventanilla** (R3, V5, V7; D17). Puro: decide, con lo que
 * Kepler dice de un U-A-5 de la caja 0011, si se recibe como cobro de RUTA (contra lo que la ruta
 * debe rendir, E-04), como cobro de SUCURSAL (otro ingreso, D17) o si queda detenido, y por qué.
 *
 * Las dos fuentes son las mismas que arman la cola de Captura (`finance.v_caja_movimientos_pendientes`):
 *  · ruta: `analytics.route_collections` (el push de las camionetas; la misma que asienta la cobranza
 *    en el libro, el carril de Kepler de LE.4.4), agregada por cobro;
 *  · sucursal: el ingreso U-A-5 de `analytics.bank_movement_legs` (la que ya usa el pago, LE.4.10).
 *
 * ⛔ Lo que no se sabe no se elige: un cobro que junta varias rutas, que está en dos días o en las
 * dos fuentes queda detenido con su motivo. Elegir una ruta haría que otra deba lo que ya rindió.
 */
import { pesosACentavos } from '@megadulces/contracts';

/** El cobro de ruta agregado por `(almacen, folio)`. `rutas` sin el prefijo `ruta_` ni ceros. */
export interface FilaCobroRuta { almacen: string; folio: string; importe: string; rutas: string; n_rutas: number; n_fechas: number }
/** El ingreso U-A-5 de una sucursal, agregado por `(sucursal, folio)`. */
export interface FilaCobroSucursal { sucursal: string; folio: string; importe: string; n: number }

export type CobroClasificado =
  | { tipo: 'ruta'; ruta: string; esperado: bigint }
  | { tipo: 'sucursal'; sucursal: string; esperado: bigint }
  | { tipo: 'detenido'; motivo: string; esperado: bigint | null };

export const LLAVE_COBRO = /^([0-9]{2}(?:-[0-9]+)?)\|(U-A-5)\|([^|]+)\|(0011)$/;

/** `almacen|U-A-5|folio|0011` → `[almacen, folio]`, o `null` si no es un cobro de la Caja General. */
export function parDelCobro(origenRef: string | null | undefined): [string, string] | null {
  const m = LLAVE_COBRO.exec(String(origenRef ?? '').trim());
  return m ? [m[1], m[3]] : null;
}

export function clasificarCobro(ruta: FilaCobroRuta | undefined, sucursal: FilaCobroSucursal | undefined): CobroClasificado {
  if (ruta && sucursal) {
    return { tipo: 'detenido', esperado: null,
      motivo: 'Kepler tiene este cobro como de ruta y como de sucursal: se aclara antes de recibirlo.' };
  }
  if (ruta) {
    const esperado = pesosACentavos(ruta.importe);
    if (ruta.n_fechas > 1) return { tipo: 'detenido', esperado, motivo: 'El mismo folio de cobro está en más de un día: se aclara en Kepler.' };
    if (ruta.n_rutas !== 1 || !/^\d{1,4}$/.test(ruta.rutas)) {
      return { tipo: 'detenido', esperado, motivo: 'El cobro junta varias rutas: no se sabe cuánto rinde cada una. Se recibe por ruta.' };
    }
    return { tipo: 'ruta', ruta: ruta.rutas, esperado };
  }
  if (sucursal) {
    const esperado = pesosACentavos(sucursal.importe);
    if (sucursal.n !== 1) return { tipo: 'detenido', esperado, motivo: 'Ese cobro tiene más de un renglón en Kepler: no se recibe hasta aclararlo.' };
    return { tipo: 'sucursal', sucursal: sucursal.sucursal, esperado };
  }
  return { tipo: 'detenido', esperado: null, motivo: 'Kepler no tiene ese cobro en la Caja General.' };
}

/** El hecho del libro de un cobro: uno por documento, sea de ruta o de sucursal. */
export const eventoDeCobro = (origenRef: string): string => `cobro:${origenRef}`;
