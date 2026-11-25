import { sqlKeplerPayableId } from '@megadulces/contracts/finance/kepler-payable-key';

/**
 * `[PGP.194]` **Las lecturas del aviso de pago al proveedor.** Vive aparte del servicio para que el texto que corre en
 * producción sea el MISMO que se prueba. Sin tablas nuevas de datos (regla 1): el pago, su comprobante, el documento de
 * Kepler de cada factura (la MISMA llave que el cierre `[PGP.94]` y el CFDI `[PGP.108]`) y lo que Kepler le aplicó
 * (`SQL_CIERRE_KEPLER`, importado, no copiado).
 */

/** El pago. Parámetros: `[tenant, allocation_id]`. */
export const SQL_PAGO_DEL_AVISO = `
SELECT a.id::text AS id, a.status, a.amount_assigned::float8 AS importe, a.payment_method AS metodo,
       to_char(l.lot_date, 'YYYY-MM-DD') AS dia, a.destination_account_text AS destino_texto,
       b.bank AS origen_banco, b.alias AS origen_alias, b.account_label AS origen_cuenta,
       sa.clabe AS destino_clabe, sa.account_number AS destino_numero
  FROM finance.payment_allocations a
  JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
  LEFT JOIN finance.bank_accounts b ON b.id = a.bank_account_id
  LEFT JOIN commercial.supplier_payment_accounts sa ON sa.id = a.supplier_payment_account_id
 WHERE a.tenant_id = ? AND a.id = ?`;

/**
 * El comprobante de la transferencia del pago: el que lo pagó (`paid_proof_id`), el `CAL` que espera al worker, o el
 * de su documento de Kepler (Comprobantes de pago). Uno, el validado primero. Parámetros: `[tenant, allocation_id]`.
 */
export const SQL_COMPROBANTE_DEL_AVISO = `
SELECT p.id::text AS id, nullif(btrim(p.ocr_referencia), '') AS rastreo,
       to_char(coalesce(p.ocr_fecha, p.pago_date), 'YYYY-MM-DD') AS fecha,
       p.ocr_cuenta_origen AS cuenta_origen, p.ocr_cuenta_dest AS cuenta_destino, p.files
  FROM finance.payment_allocations a
  JOIN finance.supplier_payment_proofs p ON p.tenant_id = a.tenant_id AND p.status <> 'rechazado'
   AND (p.id = a.paid_proof_id
        OR (p.doc_prefix = 'CAL' AND p.folio = a.id::text)
        OR (a.kepler_payment_folio IS NOT NULL AND p.sucursal = a.kepler_payment_sucursal
            AND p.doc_prefix = a.kepler_payment_doc_prefix AND p.folio = a.kepler_payment_folio))
 WHERE a.tenant_id = ? AND a.id = ?
 ORDER BY (p.id = a.paid_proof_id) DESC, (p.status = 'validado') DESC, p.created_at DESC
 LIMIT 1`;

/**
 * `[PGP.208]` **La salida del banco que pagó este pago, tal como la trae la descarga del banco**: la clave de rastreo y
 * la cuenta que recibió. Es el respaldo del comprobante: un pago que el estado de cuenta probó (`paid_bank_movement_id`)
 * ya tiene su transferencia identificada aunque nadie haya subido el PDF. El movimiento sale de la descarga con
 * `client_uuid = 'banco:' || line_key` (`[CB.60b]`); se busca por la llave única de la descarga (tenant, cuenta, llave).
 * Medido el 2026-11-24: de 275 pagos ejecutados, 53 traían la clave del comprobante; con esto, 29 más (Santander). Las
 * descargas de BBVA, Banorte y BanBajío no traen clave (traspasos del mismo banco, cheques, servicios): ésos la declaran.
 * Parámetros: `[tenant, allocation_id]`.
 */
export const SQL_BANCO_DEL_AVISO = `
SELECT nullif(btrim(s.tracking_key), '') AS rastreo, nullif(btrim(s.counterparty_account), '') AS cuenta_destino,
       to_char(s.movement_date, 'YYYY-MM-DD') AS fecha
  FROM finance.payment_allocations a
  JOIN finance.bank_movements m ON m.id = a.paid_bank_movement_id AND m.tenant_id = a.tenant_id
  JOIN finance.bank_statement_lines s ON s.tenant_id = m.tenant_id AND s.bank_account_id = m.bank_account_id
   AND m.client_uuid LIKE 'banco:%' AND s.line_key = substring(m.client_uuid FROM 7)
 WHERE a.tenant_id = ? AND a.id = ?
 LIMIT 1`;

/** Los renglones del pago, en su orden. Parámetros: `[tenant, allocation_id]`. */
export const SQL_RENGLONES_DEL_AVISO = `
SELECT i.id::text AS item_id, i.applied_amount::float8 AS pagado, coalesce(i.discount_amount, 0)::float8 AS descuento
  FROM finance.payment_allocation_items i
 WHERE i.tenant_id = ? AND i.allocation_id = ?
 ORDER BY i.created_at, i.id`;

/**
 * El documento de Kepler de cada factura, con su folio y su referencia (`kdxe.c16`, casi siempre el folio del
 * proveedor) — la misma forma que `SQL_DOCUMENTOS_KEPLER` de `[PGP.108]`, más esas dos columnas. Parámetros: `[llaves (uuid[])]`.
 */
export const SQL_FACTURAS_DEL_AVISO = `
SELECT k.oid::text AS oid, k.sucursal, k.acreedor, k.doc_tipo::int AS doc_tipo, k.doc_sub::int AS doc_sub, k.folio,
       k.referencia, k.importe::float8 AS importe, to_char(k.fecha, 'YYYY-MM-DD') AS fecha
  FROM (SELECT ${sqlKeplerPayableId('d')} AS oid, d.*
          FROM (SELECT kdxe.sucursal, btrim(kdxe.c2) AS acreedor, kdxe.c4 AS doc_tipo, kdxe.c5 AS doc_sub,
                       btrim(kdxe.c6) AS folio, nullif(btrim(kdxe.c16), '') AS referencia, kdxe.c11 AS importe, kdxe.c7 AS fecha
                  FROM kepler_ods.kdxe
                 WHERE btrim(kdxe.c1) = kdxe.sucursal AND kdxe.c3 = 'A') d) k
 WHERE k.oid = ANY(?::uuid[])`;

/**
 * La referencia de los documentos que Kepler le aplicó a las facturas (notas de crédito, devoluciones): el folio que
 * el proveedor reconoce. Parámetros: `[sucursales (text[]), tipos (int[]), subtipos (int[]), folios (text[])]`.
 */
export const SQL_REFERENCIAS_DE_APLICACIONES = `
SELECT d.sucursal, d.c4::int AS tipo, d.c5::int AS sub, btrim(d.c6) AS folio, nullif(btrim(d.c16), '') AS referencia
  FROM unnest(?::text[], ?::int[], ?::int[], ?::text[]) AS u(suc, tipo, sub, folio)
  JOIN kepler_ods.kdxe d
    ON d.sucursal = u.suc AND btrim(d.c1) = d.sucursal AND d.c3 = 'D'
   AND d.c4::int = u.tipo AND d.c5::int = u.sub AND btrim(d.c6) = u.folio`;

/** El nombre y RFC del acreedor (la vista que ya usa `[PGP.108]`). Parámetros: `[acreedores (text[])]`. */
export const SQL_ACREEDOR_DEL_AVISO = `
SELECT proveedor_code, proveedor_nombre, rfc FROM analytics.v_supplier_rfc WHERE proveedor_code = ANY(?::text[])`;

/** Los avisos que ya se mandaron de este pago, el más nuevo primero. Parámetros: `[tenant, allocation_id]`. */
export const SQL_AVISOS_DEL_PAGO = `
SELECT canal, destino, created_by AS por, to_char(created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD"T"HH24:MI') AS el
  FROM finance.payment_notices
 WHERE tenant_id = ? AND allocation_id = ? AND revoked_at IS NULL
 ORDER BY created_at DESC`;
