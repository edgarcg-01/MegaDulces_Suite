/**
 * `[TP.18.7]` — **La llave de una factura de Kepler que se programa sin tener tabla propia.**
 *
 * El Calendario de Pagos puede programar deuda **derivada** del ERP (ADR-094): facturas que viven
 * en `analytics.v_supplier_payables` y que nadie capturó como obligación. Esa deuda no tiene un
 * `id` nuestro — su identidad natural es compuesta: `sucursal · doc_tipo · doc_sub · folio`.
 *
 * ⛔ **Y `finance.payment_allocation_items.obligation_id` es `uuid`.** La primera medición de
 * `[TP.18]` falló con `operator does not exist: uuid = text`: la llave natural **no cabía** en el
 * motor. El puente es un uuid **determinístico** — el mismo documento da siempre el mismo id, sin
 * tabla intermedia y sin extensión de Postgres. Se rechazó cambiar el tipo de la columna: tocaría
 * los tres orígenes vivos para resolver lo que una función resuelve sin migrar datos.
 *
 * ## Por qué vive acá y no dentro de un servicio
 *
 * Lo usan **dos** módulos y por motivos distintos: el Calendario para guardar y reencontrar el
 * renglón, y Pronto pago para decirle al Calendario *cuál* factura programar (`[TP.18.3]`). Cuando
 * estaba dentro de `payment-calendar.service.ts`, Pronto pago terminaba importando **un servicio
 * entero por una función pura**. ADR-056: un primitivo que ya tiene dos consumidores vive
 * compartido o queda como deuda con nombre — esto es lo primero.
 *
 * ⚠️⚠️ **Las dos formas tienen que coincidir SIEMPRE**: la de TypeScript ({@link keplerPayableId})
 * y la de SQL ({@link sqlKeplerPayableId}). Si se separan, el síntoma **no es un error**: es un
 * pago guardado que no vuelve a encontrar su factura, una etiqueta en blanco y un saldo que no
 * baja. `payment-calendar-kepler-payable.spec.ts` ancla un vector fijo medido contra Postgres.
 */
import { createHash } from 'node:crypto';

/** El prefijo entra en el hash: dos orígenes derivados distintos nunca comparten id. */
const PREFIJO = 'kepler_payable';

/** La llave, en TypeScript. */
export function keplerPayableId(sucursal: string, docTipo: number | string, docSub: number | string, folio: string): string {
  const h = createHash('md5').update(`${PREFIJO}|${sucursal}|${docTipo}|${docSub}|${folio}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * La MISMA llave, en SQL, para el alias que se le pase de `analytics.v_supplier_payables`.
 * Es función y no constante porque cada servicio consulta la vista con su propio alias.
 */
export function sqlKeplerPayableId(a = 'v'): string {
  return `md5('${PREFIJO}|'||${a}.sucursal||'|'||${a}.doc_tipo||'|'||${a}.doc_sub||'|'||${a}.folio)::uuid`;
}
