import type { Knex } from 'knex';

/**
 * `[PGP.130]` **El comprobante dispara el pago.** Edgar, 2026-11-17 (D1 y D2 del anexo «cero captura»,
 * `FASE_PGP_ANEXO_CERO_CAPTURA.md`): Tesorería sube a la Suite el comprobante de la transferencia el mismo
 * día; la Suite lo casa con su pago del Calendario (`casarComprobantesConPagos`, misma cuenta, ±$1, ±5 días,
 * uno a uno), lo da por pagado y escribe el `X-D-26` en Kepler. El estado de cuenta, que llega días después,
 * deja de ser el disparador y pasa a ser la confirmación.
 *
 * ── Dónde vive el comprobante, sin tabla nueva ──────────────────────────────────────────────────────
 * En `finance.supplier_payment_proofs`, la tabla de los comprobantes de pago. Mientras Kepler no tiene el
 * documento, la fila apunta al pago del Calendario: `doc_prefix = 'CAL'`, `sucursal = 'CAL'` y `folio` = el id
 * del pago (`payment_allocations.id`). Cuando la Suite escribe el `X-D-26`, la fila pasa a apuntar a ese
 * documento (`sucursal`, `doc_prefix` y `folio` de Kepler) y aparece en Comprobantes de pago como cualquier otra.
 * Ninguna lectura de Kepler casa con `CAL`: no hay pago de Kepler con ese prefijo.
 */
export const PREFIJO_CALENDARIO = 'CAL';
export const AUTOR_PAGO_POR_COMPROBANTE = 'sistema:comprobante';
export const EVENTO_PAGADO_POR_COMPROBANTE = 'pagado_por_comprobante';
export const EVENTO_COMPROBANTE_LIGADO = 'comprobante_ligado';

/**
 * El canal por el que un comprobante nuevo despierta al worker (`PagosPorElBancoService`). Propio y no
 * `bancos_movimientos`: ése lo escucha también la conciliación bancaria, que no tiene nada que hacer con un PDF.
 */
export const CANAL_COMPROBANTES = 'pagos_comprobantes';

/** Dentro de la transacción que guardó el comprobante: Postgres sólo entrega el aviso si esa transacción se confirma. */
export async function avisarComprobante(trx: Knex | Knex.Transaction, comprobanteId: string): Promise<void> {
  await trx.raw('select pg_notify(?, ?)', [CANAL_COMPROBANTES, comprobanteId]);
}

/**
 * Los pagos con los que un comprobante puede casar: vigentes (pendientes o ya pagados por el banco), de 5 días
 * antes a 5 después de la fecha del comprobante. Un pago «ya tiene» comprobante si está ligado o si hay uno
 * esperando a ligarse. Parámetros: `[tenant, fecha, fecha]`.
 */
export const SQL_PAGOS_PARA_COMPROBANTE = `
SELECT a.id::text AS id, to_char(l.lot_date, 'YYYY-MM-DD') AS dia, a.amount_assigned::float8 AS importe,
       a.bank_account_id::text AS cuenta_id, a.payment_method AS metodo,
       (a.authorized_at IS NOT NULL OR l.status IN ('released', 'executing', 'closed')) AS autorizado,
       (a.paid_proof_id IS NOT NULL OR EXISTS (
          SELECT 1 FROM finance.supplier_payment_proofs p
           WHERE p.tenant_id = a.tenant_id AND p.doc_prefix = '${PREFIJO_CALENDARIO}' AND p.folio = a.id::text
             AND p.status <> 'rechazado')) AS con_comprobante
  FROM finance.payment_allocations a
  JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
 WHERE a.tenant_id = ? AND a.status IN ('pending', 'executed')
   AND l.lot_date BETWEEN ?::date - 5 AND ?::date + 5`;

/** `[PGP.191]` El PDF lo soltó una persona sobre el renglón de su pago (no lo casó la regla del día). */
export const EVENTO_COMPROBANTE_SOLTADO = 'comprobante_soltado';

/**
 * `[PGP.191]` El pago de UN renglón, visto para ligarle el PDF que soltaron sobre él. «Ya tiene comprobante» también
 * cuenta el que ya está ligado a su documento de Kepler (el de Comprobantes de pago): uno por pago, no dos.
 * Parámetros: `[tenant, allocation_id]`. Se le agrega `FOR UPDATE OF a` cuando se va a guardar.
 */
export const SQL_PAGO_DEL_RENGLON = `
SELECT a.id::text AS id, a.status, a.payment_method AS metodo, a.bank_account_id::text AS cuenta_id,
       a.amount_assigned::float8 AS importe, to_char(l.lot_date, 'YYYY-MM-DD') AS dia,
       (a.authorized_at IS NOT NULL OR l.status IN ('released', 'executing', 'closed')) AS autorizado,
       (a.paid_proof_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM finance.supplier_payment_proofs p
                    WHERE p.tenant_id = a.tenant_id AND p.doc_prefix = '${PREFIJO_CALENDARIO}' AND p.folio = a.id::text
                      AND p.status <> 'rechazado')
        OR EXISTS (SELECT 1 FROM finance.supplier_payment_proofs k
                    WHERE k.tenant_id = a.tenant_id AND a.kepler_payment_folio IS NOT NULL
                      AND k.sucursal = a.kepler_payment_sucursal AND k.doc_prefix = a.kepler_payment_doc_prefix
                      AND k.folio = a.kepler_payment_folio AND k.status <> 'rechazado')) AS con_comprobante
  FROM finance.payment_allocations a
  JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
 WHERE a.tenant_id = ? AND a.id = ?`;

/** Las cuentas propias de banco, para resolver la cuenta de origen que leyó el OCR. Parámetros: `[tenant]`. */
export const SQL_CUENTAS_DE_BANCO = `
SELECT id::text AS cuenta_id, account_label FROM finance.bank_accounts WHERE tenant_id = ? AND kind = 'bank'`;

/**
 * Los comprobantes que casaron con un pago y que el pago todavía no tiene ligado: lo que el worker aplica.
 * Parámetros: `[tenant]`.
 */
export const SQL_COMPROBANTES_POR_APLICAR = `
SELECT p.id::text AS comprobante_id, a.id::text AS id, a.status,
       to_char(p.ocr_fecha, 'YYYY-MM-DD') AS fecha, p.ocr_monto::float8 AS importe, p.ocr_referencia AS rastreo,
       a.kepler_payment_sucursal, a.kepler_payment_doc_prefix, a.kepler_payment_folio
  FROM finance.supplier_payment_proofs p
  JOIN finance.payment_allocations a ON a.tenant_id = p.tenant_id AND a.id::text = p.folio
 WHERE p.tenant_id = ? AND p.doc_prefix = '${PREFIJO_CALENDARIO}' AND p.status = 'validado'
   AND a.paid_proof_id IS NULL AND a.status IN ('pending', 'executed')
 ORDER BY p.created_at`;

/**
 * Cuando el pago ya tiene su documento en Kepler, su comprobante deja de apuntar al Calendario y apunta a ese
 * documento: así aparece en Comprobantes de pago junto a su `X-D-26`. Sólo mueve filas `CAL`.
 */
export async function moverComprobanteAKepler(
  trx: Knex | Knex.Transaction, tenantId: string, allocationId: string,
  kepler: { sucursal: string; doc_prefix: string; folio: string },
): Promise<number> {
  return trx('finance.supplier_payment_proofs')
    .where({ tenant_id: tenantId, doc_prefix: PREFIJO_CALENDARIO, folio: allocationId })
    .whereNot('status', 'rechazado')
    .update({ sucursal: kepler.sucursal, doc_prefix: kepler.doc_prefix, folio: kepler.folio, updated_at: trx.fn.now() });
}

/** `[PGP.130b]` El banco confirmó el pago que pagó el comprobante (liga su salida; el pago ya estaba pagado). */
export const EVENTO_CONFIRMADO_POR_EL_BANCO = 'confirmado_por_el_banco';

/**
 * `[PGP.130b]` Los pagos que pagó su comprobante y que el estado de cuenta todavía no confirma, de los últimos 60 días.
 * El día es la fecha del comprobante (cuando salió el dinero), no la del programa. Parámetros: `[tenant, hoy, hoy]`.
 */
export const SQL_POR_CONFIRMAR_EN_EL_BANCO = `
SELECT a.id::text AS id, to_char(coalesce(p.ocr_fecha, p.pago_date, l.lot_date), 'YYYY-MM-DD') AS dia,
       a.amount_assigned::float8 AS importe, a.payment_method AS metodo, a.bank_account_id::text AS cuenta_planeada
  FROM finance.payment_allocations a
  JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
  LEFT JOIN finance.supplier_payment_proofs p ON p.id = a.paid_proof_id
 WHERE a.tenant_id = ? AND a.status = 'executed' AND a.paid_proof_id IS NOT NULL AND a.paid_bank_movement_id IS NULL
   AND l.lot_date BETWEEN ?::date - 60 AND ?::date`;

// ── [PGP.232] El banco re-afirma lo que escribió el comprobante ─────────────────────────────────────────────
/**
 * `[PGP.232]` Edgar, 2026-11-27: *«cuando se agregue el comprobante se escriba en Kepler y se re-afirme con el movimiento
 * de banco»*. El comprobante dice que el banco ACEPTÓ la orden, no que la liquidó: una transferencia puede rebotar (13 SPEI
 * devueltos desde septiembre, anexo CL R5). `confirmarPorElBanco` liga la salida cuando aparece; esto dice cuándo ya no va
 * a aparecer: el estado de cuenta de ESA cuenta ya cubre la ventana del cruce (`DIAS_PARA_CONFIRMAR` después del
 * comprobante, la misma de `[PGP.121]`) y la salida no está.
 */
export const EVENTO_SIN_SALIDA_EN_EL_BANCO = 'sin_salida_en_el_banco';
export const DIAS_PARA_CONFIRMAR = 3;

export type ConfirmacionDelBanco = 'espera' | 'sin_salida' | 'no_medido';

const masDias = (dia: string, n: number): string => {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Pura. `dia` es la fecha del comprobante; `cobertura`, el último día que trae la descarga del banco de la cuenta del pago.
 * ⛔ Sin descarga de esa cuenta (o sin cuenta) NO se afirma que no salió: `no_medido` (ADR-056), nunca `sin_salida`.
 * Se llama DESPUÉS de `confirmarPorElBanco`: si la salida estaba, el pago ya no llega aquí.
 */
export function decidirSinSalidaEnElBanco(p: { dia: string | null; cobertura: string | null }): ConfirmacionDelBanco {
  if (!p.dia || !/^\d{4}-\d{2}-\d{2}$/.test(p.dia) || !p.cobertura) return 'no_medido';
  return p.cobertura >= masDias(p.dia, DIAS_PARA_CONFIRMAR) ? 'sin_salida' : 'espera';
}

/**
 * `[PGP.232]` Los pagos que pagó su comprobante, sin salida ligada todavía y sin aviso previo, con lo que cubre la descarga
 * de su cuenta y su documento de Kepler (si ya se escribió: es el que habría que cancelar). Parámetros: `[tenant, hoy, hoy]`.
 */
export const SQL_SIN_SALIDA_EN_EL_BANCO = `
SELECT a.id::text AS id, to_char(coalesce(p.ocr_fecha, p.pago_date, l.lot_date), 'YYYY-MM-DD') AS dia,
       a.amount_assigned::float8 AS importe, a.bank_account_id::text AS cuenta,
       (SELECT to_char(max(s.movement_date), 'YYYY-MM-DD') FROM finance.bank_statement_lines s
         WHERE s.tenant_id = a.tenant_id AND s.bank_account_id = a.bank_account_id) AS cobertura,
       a.kepler_payment_sucursal AS sucursal, a.kepler_payment_doc_prefix AS doc_prefix, a.kepler_payment_folio AS folio
  FROM finance.payment_allocations a
  JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
  LEFT JOIN finance.supplier_payment_proofs p ON p.id = a.paid_proof_id
 WHERE a.tenant_id = ? AND a.status = 'executed' AND a.paid_proof_id IS NOT NULL AND a.paid_bank_movement_id IS NULL
   AND l.lot_date BETWEEN ?::date - 60 AND ?::date
   AND NOT EXISTS (SELECT 1 FROM finance.payment_allocation_history h
                    WHERE h.allocation_id = a.id AND h.event = '${EVENTO_SIN_SALIDA_EN_EL_BANCO}')`;
