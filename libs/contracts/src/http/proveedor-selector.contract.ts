import { diaCorto } from '../finance/dia-corto.contract';

/**
 * `[PGP.154]` La FORMA del wire del buscador de proveedores de *Pago a proveedor*
 * (`GET /commercial/supplier-obligations/suppliers?search=`), que usan «Buscar proveedor» y el
 * diálogo «Solicitar cuenta de pago» de `/finanzas/cuentas-pago`.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 *
 * El buscador leía `catalog.suppliers` tal cual y salía el mismo proveedor repetido. Medido en prod
 * el 2026-11-18 (sólo lectura): de **1,354** proveedores activos, **547 no existen en el catálogo de
 * proveedores de Kepler** (`kepler_ods.kdxd`). Son los de la importación vieja, que leía el catálogo
 * de LÍNEAS (`kdig`) y que el importer actual no borra. «chompys» daba tres renglones (`015`, `039`,
 * `CD022`) y sólo el último existe en Kepler. Ninguna cuenta, solicitud ni obligación cuelga de esos
 * 547 (0 / 0 / 0), así que dejar de ofrecerlos no esconde nada vivo.
 *
 * Además, Kepler mismo tiene fichas gemelas: `CD004 VUMERSOFT` (RFC, 613 documentos, último el
 * 9-nov) y `CV10 VUMERSOFT SAPI DE CV` (sin RFC, **cero** documentos). Las dos son reales en
 * Kepler, así que no se ocultan. Se distinguen por su clave y por su último movimiento, y las que
 * tienen movimiento van primero. 99 de los 807 que quedan no tienen ninguno. No se ocultan porque un
 * proveedor recién dado de alta (por ejemplo, para pedirle un anticipo) tampoco lo tiene.
 */
export interface ProveedorSelectorOpcion {
  /** `catalog.suppliers.id`. */
  id: string;
  name: string;
  /** La clave de Kepler (`kdxd.c2`): la que distingue a dos proveedores con el mismo nombre. */
  code: string;
  is_critical: boolean;
  critical_reason: string | null;
  /**
   * Fecha (`YYYY-MM-DD`) del documento más reciente del proveedor en las cuentas por pagar de
   * Kepler (`kdxe.c7`). `null` = **no tiene ningún documento**, no un dato que no se midió.
   */
  ultimo_movimiento: string | null;
}

/**
 * `[PGP.154]` / `[PGP.155.2]` Cómo se dice el último movimiento junto a la clave, igual en todo buscador de
 * proveedores: «último movimiento 9-nov-2026» o «sin movimientos en Kepler».
 *
 * `null` es **cero documentos** (se dice). `undefined` es que la respuesta no lo trajo: no se midió, así que
 * no se afirma nada y devuelve `null` (ADR-056).
 */
export function textoUltimoMovimiento(ultimo: string | null | undefined): string | null {
  if (ultimo === undefined) return null;
  if (!ultimo) return 'sin movimientos en Kepler';
  return `último movimiento ${diaCorto(ultimo)}-${ultimo.slice(0, 4)}`;
}
