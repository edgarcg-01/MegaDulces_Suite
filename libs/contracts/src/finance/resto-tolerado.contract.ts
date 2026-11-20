/**
 * `[GP.R.1]` **La regla del resto de centavos**, un solo primitivo para los dos lados (ADR-056):
 * proveedores (`[PGP.157]`, `FASES/FASE_PGP_ANEXO_RESIDUOS_DE_CENTAVOS.md`) y clientes
 * (`FASES/FASE_GP_ANEXO_RESTOS_DE_COBRO.md`). Vivía en `cierre-kepler.contract.ts`, que la sigue
 * re-exportando para no mover a sus consumidores.
 *
 * Una factura que **ya tuvo un pago** y sigue viva por centavos cuenta como pagada para DECIDIR (cerrar un
 * pago, autorizar un pedido, ordenar la cola de cobranza). No se esconde: quien la use dice cuánto queda.
 * Una factura que nunca tuvo pago no es resto aunque deba $0.08.
 */

/** Tolerancia de saldo: la misma que `v_supplier_payables` (`pendiente > 0.005`). */
export const SALDO_CERO = 0.005;

/**
 * Lo más que puede deber una factura para contar como resto. Medido el 2026-11-19 (proveedores: 4 pagos
 * detenidos sólo por restos de hasta $1, ninguno de $1 a $10) y el 2026-11-20 (clientes de telemarketing:
 * 176 de 207 restos de hasta $10 son de menos de $1). Es D-C1 (PGP) y D-R1 (GP); si cambia, cambia aquí.
 */
export const RESTO_TOLERADO = 1;

/** ¿Es un resto de centavos: más que cero y hasta {@link RESTO_TOLERADO}? */
export function esRestoTolerado(pendiente: number | null): boolean {
  return pendiente !== null && Number.isFinite(pendiente) && pendiente > SALDO_CERO && pendiente <= RESTO_TOLERADO;
}

/**
 * ¿La factura sigue viva SÓLO por un resto de centavos? Es resto si debe hasta {@link RESTO_TOLERADO} **y**
 * ya recibió algo (lo que debe es menos que su importe). Sin importe confiable no se afirma: `false`.
 */
export function esRestoDeFactura(saldo: number | null, importe: number | null): boolean {
  if (!esRestoTolerado(saldo) || importe === null || !Number.isFinite(importe)) return false;
  return (saldo as number) < importe - SALDO_CERO;
}
