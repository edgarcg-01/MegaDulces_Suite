/**
 * `[PGP.14]` / `[PGP.17]` — **El crédito a favor de un acreedor**: notas de crédito, notas de
 * crédito CFDI, devoluciones de compra, bonificaciones, anticipos y ajustes de abono.
 *
 * Sirve a `GET /payment-calendar/creditos-a-favor` (el resumen por acreedor) y a
 * `GET /payment-calendar/creditos-a-favor/:proveedor` (el desglose documento por documento).
 *
 * ⚠️ **Las cifras llegan como `number`, no como `string`.** El SQL castea cada importe a
 * `::float8` antes de devolverlo; sin ese casteo, node-pg entrega los `numeric` de Postgres como
 * texto y `toLocaleString` los pinta sin `$` ni comas. Si alguien quita el casteo, este tipo deja
 * de describir la respuesta — el tipo protege al código, no a la consulta.
 *
 * ⛔ Lo que `a_favor` NO es: un número cerrado. Es un **piso**, porque `kdxf` sobre-cuenta lo
 * aplicado por replicación de sucursal. Medido el 2026-10-26: $8,264,176 en 201 documentos.
 */

/** Una fila del resumen: un acreedor con todo su crédito sin aplicar. */
export interface SupplierUnappliedCreditRow {
  /** Código del acreedor en Kepler. */
  proveedor: string;
  /** Razón social. `null` cuando el catálogo no lo tiene — se muestra el código, nunca vacío. */
  proveedor_nombre: string | null;
  /** Lo que queda a favor, en pesos. Piso, no cifra cerrada (ver la nota de arriba). */
  a_favor: number;
  /** Cuántos documentos lo componen. */
  docs: number;
  /** Las clases presentes, ya concatenadas para mostrar («nota de crédito · devolución»). */
  clases: string;
  /** Fecha del documento más viejo, `YYYY-MM-DD`. `null` si ninguno la trae. */
  mas_vieja: string | null;
  /** `true` si además le debemos: eso es lo que se puede netear. */
  con_deuda_viva: boolean;
}

/** Un documento del desglose de UN acreedor, aplicado o no. */
export interface SupplierCreditRow {
  sucursal: string;
  /** Nota de crédito, nota de crédito CFDI, devolución de compra, bonificación, anticipo o ajuste de abono. */
  clase: string;
  folio: string;
  referencia: string | null;
  /** `YYYY-MM-DD`. */
  fecha: string | null;
  importe: number;
  /** Lo que Kepler ya aplicó contra alguna factura. */
  aplicado: number;
  /** `importe - aplicado`. */
  a_favor: number;
  /** `false` cuando ya se aplicó entero. Los aplicados vienen a propósito: sin ellos, un proceso que funciona se lee como que el sistema no hace nada. */
  pendiente: boolean;
}
