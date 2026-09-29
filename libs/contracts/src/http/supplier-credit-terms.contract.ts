/**
 * `[RE.30]` Plazo de pago por proveedor — `GET/PUT /commercial/supplier-credit-terms`.
 *
 * El vencimiento de lo que Compras entrega a Finanzas sale del plazo PACTADO con el proveedor:
 * cuántos días exactos y desde cuándo corren (factura o recepción). Kepler va al lado sólo como
 * comparación — su "de contado" es, casi siempre, un plazo que nunca se capturó.
 *
 * Producer `SupplierCreditTermsController` y consumer `ComprasPlazosPagoComponent` importan de
 * acá: un cambio de forma es error de compilación en los dos lados (ADR-052).
 */

/** Desde cuándo corre el plazo. */
export type CreditTermBase = 'factura' | 'recepcion';

/**
 * Estado del plazo de UN proveedor. Las ausencias no son la misma cosa:
 *   · `sin_plazo`     — nadie lo ha capturado (`credit_days` NULL).
 *   · `sin_confirmar` — hay días (vienen del Excel del programa de pagos) pero nadie los confirmó.
 *   · `confirmado`    — fijado a mano por quien negocia (`COMPRAS_PLAZOS_AUTORIZAR`).
 *   · `interno`       — entidad propia (CEDIS, sucursal, dueño): traspaso, no deuda.
 */
export type CreditTermsStatus = 'sin_plazo' | 'sin_confirmar' | 'confirmado' | 'interno';

/** Filtro de la lista. `pendientes` = sin_plazo + sin_confirmar (el default). */
export type CreditTermsFilter = CreditTermsStatus | 'pendientes' | 'difiere' | 'todos';

export interface SupplierCreditTermsRow {
  id: string;
  code: string;
  name: string;
  /** NULL = sin capturar · 0 = contado confirmado · 1..365 = días exactos de crédito. */
  credit_days: number | null;
  credit_term_base: CreditTermBase | null;
  credit_terms_updated_by: string | null;
  credit_terms_updated_at: string | null;
  is_internal: boolean;
  internal_reason: string | null;
  /** Total con IVA de las órdenes de entrada en la ventana (Kepler; Wincaja fuera, ver summary). */
  received_amount: number;
  received_count: number;
  last_receipt: string | null;
  /** Condición de pago más frecuente en Kepler — referencia, NO fuente. */
  kepler_condition: string | null;
  kepler_days: number | null;
  /** Cuántas condiciones distintas tiene Kepler para este proveedor (>1 = capturado disparejo). */
  kepler_variants: number;
  status: CreditTermsStatus;
  /** Sólo sobre lo confirmado: días distintos a Kepler por más de la tolerancia (su "30 días" es mes). */
  differs_from_kepler: boolean;
}

/** Resumen sobre el universo COMPLETO, no sobre el filtro: es lo que dimensiona el trabajo. */
export interface SupplierCreditTermsSummary {
  window_days: number;
  suppliers: number;
  received_amount: number;
  sin_plazo: number;
  sin_confirmar: number;
  confirmado: number;
  interno: number;
  differs_from_kepler: number;
  pending_amount: number;
  /** Cuántos pendientes (en orden de lo recibido) cubren el 80% del dinero pendiente. */
  pending_suppliers_for_80pct: number;
  /** Los proveedores de Wincaja usan otro espacio de códigos: no entran. Declarado, no escondido. */
  wincaja_excluded: true;
  /**
   * `false` mientras no se aplique la migración 20260929140000: la lista se ve (sólo con `credit_days`)
   * pero nada puede figurar como confirmado ni interno, y el PUT responde 503. Declarado, no dibujado.
   */
  schema_ready: boolean;
}

export interface SupplierCreditTermsResponse {
  summary: SupplierCreditTermsSummary;
  rows: SupplierCreditTermsRow[];
}

export interface UpdateSupplierCreditTermsDto {
  /** 0 = contado. Obligatorio salvo que sea interno. */
  credit_days: number | null;
  /** Obligatoria si credit_days > 0. */
  credit_term_base?: CreditTermBase | null;
  is_internal?: boolean;
  /** Obligatorio si is_internal. */
  internal_reason?: string | null;
  note?: string | null;
}

/** Lo que devuelve el PUT: el proveedor con su plazo ya confirmado. */
export interface SupplierCreditTermsUpdated {
  id: string;
  code: string;
  name: string;
  credit_days: number | null;
  credit_term_base: CreditTermBase | null;
  credit_terms_updated_by: string | null;
  credit_terms_updated_at: string | null;
  is_internal: boolean;
  internal_reason: string | null;
}

/** Un cambio del plazo, append-only (`catalog.supplier_credit_terms_history`). */
export interface SupplierCreditTermsHistoryRow {
  id: string;
  supplier_id: string;
  old_credit_days: number | null;
  new_credit_days: number | null;
  old_credit_term_base: CreditTermBase | null;
  new_credit_term_base: CreditTermBase | null;
  old_is_internal: boolean | null;
  new_is_internal: boolean | null;
  note: string | null;
  created_by: string;
  created_at: string;
}
