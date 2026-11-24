/**
 * `[GP.R.1]` **La regla del resto de centavos**, un solo primitivo para los dos lados (ADR-056):
 * proveedores (`[PGP.157]`, `FASES/FASE_PGP_ANEXO_RESIDUOS_DE_CENTAVOS.md`) y clientes
 * (`FASES/FASE_GP_ANEXO_RESTOS_DE_COBRO.md`). Vivía en `cierre-kepler.contract.ts`, que la sigue
 * re-exportando para no mover a sus consumidores.
 *
 * Una factura que **ya tuvo un pago** y sigue viva por centavos cuenta como pagada para DECIDIR (cerrar un
 * pago, autorizar un pedido, ordenar la cola de cobranza). No se esconde: quien la use dice cuánto queda.
 * Una factura que nunca tuvo pago no es resto aunque deba $0.08.
 *
 * ⛔⛔ **El tope va SIEMPRE explícito en la llamada, y son DOS distintos.** Hasta el 2026-11-24 había una sola
 * constante `RESTO_TOLERADO = 1` cuyo comentario decía «es D-C1 (PGP) y D-R1 (GP)»: **dos decisiones de dos
 * dueños distintos, sobre dinero que entra y dinero que sale, atadas al mismo número.** Cuando Edgar firmó
 * D-R1 en $10 (clientes), subir esa constante habría movido callado el lado de proveedores: medido ese día,
 * **55 documentos por $193.48** habrían pasado a contar como saldados sin que nadie lo decidiera. El default
 * silencioso es lo que permitió la confusión, así que **no hay default**: el tope es un parámetro obligatorio
 * y cada llamada nombra cuál usa.
 */

/** Tolerancia de saldo: la misma que `v_supplier_payables` (`pendiente > 0.005`). */
export const SALDO_CERO = 0.005;

/**
 * **Proveedores (D-C1).** Lo más que puede deber una factura NUESTRA para contar como resto.
 * Medido el 2026-11-19: 4 pagos detenidos sólo por restos de hasta $1.
 * ⚠️ Re-medido el 2026-11-24: entre $1 y $10 hay **55 documentos ($193.48)** — ya no es «ninguno», así que
 * subir este tope **sí** cambiaría a quién se le da por pagado. Si se quiere mover, es decisión de PGP con su
 * propia medición, no un efecto colateral de D-R1.
 */
export const RESTO_TOLERADO_PROVEEDOR = 1;

/**
 * **Clientes (D-R1).** Lo más que puede deber una factura DEL CLIENTE para contar como resto.
 * **$10 por decisión de Edgar del 2026-11-24** («facturas que tengan adeudo de menos de 10 pesos … se genera
 * automáticamente un abono»). La recomendación del anexo era $1, con $1–$10 a firma; medido ese día, la
 * diferencia entre los dos topes son **32 facturas ($108.11)** y **3 clientes** que dejan de verse morosos
 * (de 16 a 19 «morosos sólo por resto», sobre 1,471 clientes con algún vencido).
 */
export const RESTO_TOLERADO_CLIENTE = 10;

/**
 * @deprecated Era el tope único que confundía las dos decisiones. Se conserva **sólo** con el valor de
 * proveedores para no romper a quien todavía lo lea; en código nuevo va `RESTO_TOLERADO_PROVEEDOR` o
 * `RESTO_TOLERADO_CLIENTE`, nombrado.
 */
export const RESTO_TOLERADO = RESTO_TOLERADO_PROVEEDOR;

/** ¿Es un resto de centavos: más que cero y hasta `tope`? El `tope` es obligatorio a propósito. */
export function esRestoTolerado(pendiente: number | null, tope: number): boolean {
  return (
    pendiente !== null &&
    Number.isFinite(pendiente) &&
    Number.isFinite(tope) &&
    pendiente > SALDO_CERO &&
    pendiente <= tope
  );
}

/**
 * ¿La factura sigue viva SÓLO por un resto de centavos? Es resto si debe hasta `tope` **y** ya recibió algo
 * (lo que debe es menos que su importe). Sin importe confiable no se afirma: `false`.
 */
export function esRestoDeFactura(saldo: number | null, importe: number | null, tope: number): boolean {
  if (!esRestoTolerado(saldo, tope) || importe === null || !Number.isFinite(importe)) return false;
  return (saldo as number) < importe - SALDO_CERO;
}
