/**
 * GX (estructura) — `analytics.expense_documents` de tabla materializada → VISTA
 * derive-not-copy sobre `kepler_ods.kdm1`. Mismo patrón que `expense_requests`
 * (20260819160000). Elimina la desincronía del feed: el espejo tenía 6,432 gastos
 * con solo 770 vínculos solicitud↔gasto; el ODS tiene los 7,528 con el 100% del
 * vínculo (gasto XA1001.c39 = folio de la solicitud). La vista lo deriva EN VIVO.
 *
 * Doctypes: XA1001 (gasto, c4=10) + XA2001 (orden de entrada, c4=20) — los dos que
 * la tabla materializaba (finanzas + compras + fiscal + maat dependen de ambos).
 * `solicitud_tipo/folio` se derivan inline de `c39` (solo XA1001). `warehouse_id`
 * por LEFT JOIN a commercial.warehouses (como expense_requests). Contrato de 18
 * columnas idéntico (validado). Usa el índice parcial `idx_kdm1_xa_doc`.
 *
 * Cambio de comportamiento: `fecha` = fecha del documento (`c9`), antes venía de la
 * póliza `kdc2` (suelen coincidir). La tabla queda como `*_snapshot_bak`.
 *
 * Tras esto: `import-expenses-polizas.js` deja de escribir expense_documents (sigue
 * con expense_entries + expense_document_lines) y `import-expense-requests.js` deja
 * de hacer el UPDATE de solicitud_folio (conserva solo los hallazgos).
 * Idempotente (guard relkind='v'). Sin dependientes (verificado). Reversible.
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  const rk = await knex.raw(`SELECT relkind FROM pg_class WHERE oid=to_regclass('analytics.expense_documents')`);
  const kind = rk.rows[0] && rk.rows[0].relkind;
  if (kind === 'v') return;        // ya es vista → idempotente
  if (kind !== 'r') return;        // no existe como tabla (entorno sin la base) → nada que convertir

  // La FK fk_expense_documents_warehouse viaja con el rename al backup; la vista
  // resuelve warehouse_id en vivo (no lleva FK).
  await knex.raw(`ALTER TABLE analytics.expense_documents RENAME TO expense_documents_snapshot_bak`);

  await knex.raw(`
    CREATE VIEW analytics.expense_documents AS
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
  await knex.raw(`COMMENT ON VIEW analytics.expense_documents IS
    'Vista derive-no-copy: documentos de gasto (XA1001) y orden de entrada (XA2001) EN VIVO desde kepler_ods.kdm1 (anti-réplica c1=sucursal). solicitud_tipo/folio derivados de c39 (XA1001). warehouse_id via commercial.warehouses.code. Reemplaza la tabla materializada (feed desincronizado 770/7528). Backup: expense_documents_snapshot_bak.'`);
};

exports.down = async function (knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.expense_documents');
  await knex.raw('ALTER TABLE analytics.expense_documents_snapshot_bak RENAME TO expense_documents');
};
