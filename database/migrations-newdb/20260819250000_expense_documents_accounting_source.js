/**
 * GX (corrección de importe) — la vista `analytics.expense_documents` (mig 20260819210000)
 * tomaba `importe`/`iva` de `kepler_ods.kdm1.c16/c14` (el MOVIMIENTO). Verificado en prod
 * (2026-08-19): para recepciones XA2001 ese c16 diverge de la contabilidad — ej. sucursal 02
 * folio 0000482: c16=$207,314.84 vs póliza costo $382,041.48 + IVA $32,588.20 = **$414,629.68**
 * (= abono a proveedor = cargo total, la póliza cuadra). La conciliación fiscal (poliza-cruce)
 * casa `importe` contra `cfdis.total` (CON IVA) ±$1 → el valor correcto es el TOTAL contable.
 * El backup-tabla NO era mejor: el importer también lo poblaba de c16 → "se deshacía solo".
 *
 * Fix: la verdad contable vive en las pólizas mensuales `kdc2YYMM` (crecen mes a mes → una vista
 * estática no las puede enumerar). Se consolida por documento en `analytics.expense_doc_accounting`
 * (agregado month-agnostic, refrescado desde el ODS por import-expenses-polizas). La vista hace
 * `importe = COALESCE(contable, c16)` · `iva = COALESCE(iva_contable, c14)`:
 *   - 2,596 docs con póliza en el ODS → importe CONTABLE (corrige los c16 rotos).
 *   - resto (histórico fuera de la ventana kdc2) → cae a c16 (status quo, sin regresión).
 * Cobertura crece conforme el ODS acumula meses de kdc2. Contrato de 18 columnas intacto
 * (CREATE OR REPLACE: solo cambian las expresiones de importe/iva + LEFT JOIN al agregado).
 *
 * Formula contable (verificada): costo (511 / 6xx) + IVA acreditable (122x), lado cargo (c4='C'),
 * por documento = total de la factura = CFDI total. Idempotente. Reversible (down deja c16).
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  // 1) tabla agregada consolidada por documento (verdad contable, month-agnostic)
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.expense_doc_accounting (
      tenant_id        uuid NOT NULL,
      sucursal         text NOT NULL,
      doc_tipo         text NOT NULL,
      doc_folio        text NOT NULL,
      importe_contable numeric,
      iva_contable     numeric,
      computed_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, sucursal, doc_tipo, doc_folio)
    )`);
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.expense_doc_accounting TO app_runtime');
  await knex.raw(`COMMENT ON TABLE analytics.expense_doc_accounting IS
    'Agregado contable por documento (costo 511/6xx + IVA 122x, lado cargo) desde kepler_ods.kdc2YYMM. Consolidado month-agnostic — lo refresca import-expenses-polizas. Fuente del importe/iva de la vista analytics.expense_documents (COALESCE con c16 para docs fuera de la ventana kdc2).'`);

  // 2) backfill inline desde el ODS (si existe kepler_ods en este entorno). Enumera kdc2YYMM en runtime.
  const kdc = await knex.raw(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='kepler_ods' AND table_name ~ '^kdc2[0-9]{4}$' ORDER BY 1`);
  const tabs = kdc.rows.map((r) => r.table_name);
  if (tabs.length) {
    const union = tabs.map((t) =>
      `SELECT c14::text suc,(c15||c16||lpad(btrim(c17::text),2,'0')||lpad(btrim(c18::text),2,'0')) tipo,` +
      `btrim(c19::text) folio,btrim(c3::text) cuenta,c4 ca,` +
      `coalesce(nullif(regexp_replace(c5::text,'[^0-9.-]','','g'),'')::numeric,0) imp FROM kepler_ods.${t}`).join(' UNION ALL ');
    await knex.raw(`
      INSERT INTO analytics.expense_doc_accounting AS t (tenant_id,sucursal,doc_tipo,doc_folio,importe_contable,iva_contable,computed_at)
      SELECT ?::uuid, suc, tipo, folio,
             round(sum(imp) FILTER (WHERE ca='C' AND (cuenta='511' OR cuenta LIKE '6%' OR cuenta LIKE '122%')),2),
             round(sum(imp) FILTER (WHERE ca='C' AND cuenta LIKE '122%'),2),
             now()
        FROM (${union}) p
       WHERE tipo IN ('XA1001','XA2001') AND folio <> ''
       GROUP BY suc,tipo,folio
      ON CONFLICT (tenant_id,sucursal,doc_tipo,doc_folio) DO UPDATE
        SET importe_contable=EXCLUDED.importe_contable, iva_contable=EXCLUDED.iva_contable, computed_at=now()`, [M]);
  }

  // 3) redefinir la vista: importe/iva = COALESCE(contable, c16/c14). Mismo contrato de 18 columnas.
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.expense_documents AS
    SELECT
      '${M}'::uuid                                       AS tenant_id,
      d.sucursal::text                                  AS sucursal,
      (d.c2||d.c3||lpad(btrim(d.c4::text),2,'0')||lpad(btrim(d.c5::text),2,'0')) AS doc_tipo,
      btrim(d.c6::text)                                 AS doc_folio,
      d.c9::date                                        AS fecha,
      d.c18::date                                       AS fecha_doc,
      NULLIF(btrim(d.c32::text),'')                     AS beneficiario,
      NULLIF(btrim(d.c22::text),'')                     AS rfc,
      NULLIF(btrim(d.c24::text),'')                     AS concepto,
      NULLIF(upper(regexp_replace(btrim(d.c48::text),'\\s+',' ','g')),'') AS area,
      COALESCE(acc.importe_contable,
               round(coalesce(nullif(regexp_replace(d.c16::text,'[^0-9.-]','','g'),'')::numeric,0),2)) AS importe,
      COALESCE(acc.iva_contable,
               round(coalesce(nullif(regexp_replace(d.c14::text,'[^0-9.-]','','g'),'')::numeric,0),2)) AS iva,
      NULLIF(btrim(d.c67::text),'')                     AS usuario,
      CASE WHEN btrim(d.c4::text)='10' AND NULLIF(btrim(d.c39::text),'') IS NOT NULL THEN 'XA1501' END AS solicitud_tipo,
      CASE WHEN btrim(d.c4::text)='10' THEN NULLIF(btrim(d.c39::text),'') END AS solicitud_folio,
      NULLIF(btrim(d.c31::text),'')                     AS clase,
      now()                                             AS computed_at,
      w.id                                              AS warehouse_id
    FROM kepler_ods.kdm1 d
    LEFT JOIN commercial.warehouses w
      ON w.tenant_id='${M}'::uuid AND w.code=d.sucursal::text AND w.deleted_at IS NULL
    LEFT JOIN analytics.expense_doc_accounting acc
      ON acc.tenant_id='${M}'::uuid AND acc.sucursal=d.sucursal::text
     AND acc.doc_tipo=(d.c2||d.c3||lpad(btrim(d.c4::text),2,'0')||lpad(btrim(d.c5::text),2,'0'))
     AND acc.doc_folio=btrim(d.c6::text)
    WHERE d.c2='X' AND d.c3='A' AND btrim(d.c4::text) IN ('10','20') AND btrim(d.c5::text)='1'
      AND btrim(d.c1::text)=d.sucursal::text AND btrim(d.c6::text) <> ''
  `);
  await knex.raw('GRANT SELECT ON analytics.expense_documents TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.expense_documents IS
    'Vista derive-no-copy: gastos (XA1001) y órdenes de entrada (XA2001) EN VIVO desde kepler_ods.kdm1. importe/iva = COALESCE(agregado contable expense_doc_accounting, c16/c14 del movimiento). solicitud_tipo/folio de c39. warehouse_id via commercial.warehouses.code. Backup tabla: expense_documents_snapshot_bak.'`);
};

exports.down = async function (knex) {
  // vuelve importe/iva a c16/c14 (sin el JOIN al agregado); conserva la tabla agregada.
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.expense_documents AS
    SELECT
      '${M}'::uuid                                       AS tenant_id,
      d.sucursal::text                                  AS sucursal,
      (d.c2||d.c3||lpad(btrim(d.c4::text),2,'0')||lpad(btrim(d.c5::text),2,'0')) AS doc_tipo,
      btrim(d.c6::text)                                 AS doc_folio,
      d.c9::date                                        AS fecha,
      d.c18::date                                       AS fecha_doc,
      NULLIF(btrim(d.c32::text),'')                     AS beneficiario,
      NULLIF(btrim(d.c22::text),'')                     AS rfc,
      NULLIF(btrim(d.c24::text),'')                     AS concepto,
      NULLIF(upper(regexp_replace(btrim(d.c48::text),'\\s+',' ','g')),'') AS area,
      round(coalesce(nullif(regexp_replace(d.c16::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS importe,
      round(coalesce(nullif(regexp_replace(d.c14::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS iva,
      NULLIF(btrim(d.c67::text),'')                     AS usuario,
      CASE WHEN btrim(d.c4::text)='10' AND NULLIF(btrim(d.c39::text),'') IS NOT NULL THEN 'XA1501' END AS solicitud_tipo,
      CASE WHEN btrim(d.c4::text)='10' THEN NULLIF(btrim(d.c39::text),'') END AS solicitud_folio,
      NULLIF(btrim(d.c31::text),'')                     AS clase,
      now()                                             AS computed_at,
      w.id                                              AS warehouse_id
    FROM kepler_ods.kdm1 d
    LEFT JOIN commercial.warehouses w
      ON w.tenant_id='${M}'::uuid AND w.code=d.sucursal::text AND w.deleted_at IS NULL
    WHERE d.c2='X' AND d.c3='A' AND btrim(d.c4::text) IN ('10','20') AND btrim(d.c5::text)='1'
      AND btrim(d.c1::text)=d.sucursal::text AND btrim(d.c6::text) <> ''
  `);
  await knex.raw('GRANT SELECT ON analytics.expense_documents TO app_runtime');
};
