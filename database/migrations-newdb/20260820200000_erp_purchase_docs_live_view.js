/**
 * ER.7b — `analytics.erp_purchase_docs` (+ `_lines`): TABLA copiada por importer → **VISTA
 * derivada EN VIVO** del ODS (derive-no-copy), igual que `erp_goods_receipts` (mig 20260819120000).
 *
 * Por qué: la tabla nació ayer y ya reprodujo el problema que esa migración vino a resolver.
 * En prod la migración quedó pendiente, el código la consultaba y `/compras/entradas` tiraba
 * 42P01 en cada ficha. Una copia batch introduce dos formas de quedar mal —no existir todavía,
 * o existir vieja— y ninguna aporta nada: `kepler_ods.kdm1` ya replica TODOS los doctypes X-A
 * al segundo (la vista de recepciones ya hace join contra c4='40' y c4='37' ahí mismo).
 * Regla de la casa: toda tabla se normaliza y deriva de la base central al momento.
 *
 * Fuente: `kepler_ods.kdm1`/`kdm2`, doctypes **X-A-35 (OC)** y **X-A-37 (vale)**, que comparten
 * shape. Anti-réplica `c1 = sucursal` (cada rama arrastra documentos de otras sucursales).
 *
 * NO-OP donde el ODS todavía no está (local sin replicación): se comprueba `to_regclass` y se
 * deja la tabla como está. A propósito — una migración que asume el ODS traba la cola entera de
 * knex en cualquier máquina que no lo tenga, que es justo lo que ya pasa con otra migración de
 * esta tanda. Cuando el ODS aparezca, esta corre sola y sustituye.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';
/** Recorta a numérico lo que Kepler guarda como texto con formato. */
const NUM = (col, dec) => `round(coalesce(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,0),${dec})`;

exports.up = async function (knex) {
  const ods = await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') AS t, to_regclass('kepler_ods.kdm2') AS l`);
  if (!ods.rows[0]?.t || !ods.rows[0]?.l) {
    console.log('  [ER.7b] kepler_ods.kdm1/kdm2 ausente — se deja la tabla espejo tal cual (no-op).');
    return;
  }
  const cur = await knex.raw(`SELECT relkind FROM pg_class WHERE oid = to_regclass('analytics.erp_purchase_docs')`);
  if (cur.rows[0] && cur.rows[0].relkind === 'v') return; // ya es vista

  // El self-scan por doctype/folio ya está cubierto por idx_kdm1_xa_doc (mig 20260819120000);
  // esto solo lo asegura si esta migración corre en una base donde aquella no pasó.
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_kdm1_xa_doc
    ON kepler_ods.kdm1 (sucursal, btrim(c4::text), btrim(c6::text)) WHERE c2='X' AND c3='A'`);

  // Respaldo reversible del snapshot (si existía la tabla).
  if (cur.rows[0]) {
    await knex.raw(`ALTER TABLE analytics.erp_purchase_docs RENAME TO erp_purchase_docs_snapshot_bak`);
    await knex.raw(`ALTER TABLE IF EXISTS analytics.erp_purchase_doc_lines RENAME TO erp_purchase_doc_lines_snapshot_bak`);
  }

  await knex.raw(`
    CREATE VIEW analytics.erp_purchase_docs AS
    SELECT
      '${M}'::uuid                                   AS tenant_id,
      CASE btrim(h.c4::text) WHEN '35' THEN 'XA3501' ELSE 'XA3701' END AS doctype,
      h.sucursal::text                               AS sucursal,
      btrim(h.c6::text)                              AS folio,
      h.c9::date                                     AS doc_date,
      h.c18::date                                    AS due_date,
      NULLIF(btrim(h.c10::text),'')                  AS proveedor_code,
      NULLIF(btrim(h.c32::text),'')                  AS proveedor_nombre,
      NULLIF(btrim(h.c22::text),'')                  AS proveedor_rfc,
      NULLIF(btrim(h.c24::text),'')                  AS concepto,
      NULLIF(btrim(h.c30::text),'')                  AS condicion_pago,
      NULLIF(btrim(h.c11::text),'')                  AS referencia,
      ${NUM('h.c16', 2)}                             AS monto,
      NULLIF(btrim(h.c37::text),'')                  AS ref_doctype,
      NULLIF(btrim(h.c39::text),'')                  AS ref_folio,
      ('md_'||h.sucursal)::text                      AS source_branch,
      now()                                          AS computed_at
    FROM kepler_ods.kdm1 h
    WHERE h.c2='X' AND h.c3='A' AND btrim(h.c4::text) IN ('35','37')
      AND btrim(h.c1::text)=h.sucursal::text
  `);

  await knex.raw(`
    CREATE VIEW analytics.erp_purchase_doc_lines AS
    SELECT
      '${M}'::uuid                                   AS tenant_id,
      CASE btrim(h.c4::text) WHEN '35' THEN 'XA3501' ELSE 'XA3701' END AS doctype,
      h.sucursal::text                               AS sucursal,
      btrim(h.c6::text)                              AS folio,
      btrim(l.c7::text)                              AS linea,
      NULLIF(btrim(l.c8::text),'')                   AS sku,
      NULLIF(btrim(l.c10::text),'')                  AS nombre,
      ${NUM('l.c9', 4)}                              AS cantidad,
      NULLIF(btrim(l.c11::text),'')                  AS unidad,
      ${NUM('l.c12', 4)}                             AS costo_unitario,
      ${NUM('l.c13', 2)}                             AS importe,
      now()                                          AS computed_at
    FROM kepler_ods.kdm1 h
    JOIN kepler_ods.kdm2 l
      ON l.sucursal=h.sucursal AND l.c1=h.c1 AND l.c2=h.c2 AND l.c3=h.c3 AND l.c4=h.c4 AND l.c6=h.c6
    WHERE h.c2='X' AND h.c3='A' AND btrim(h.c4::text) IN ('35','37')
      AND btrim(h.c1::text)=h.sucursal::text
  `);

  await knex.raw('GRANT SELECT ON analytics.erp_purchase_docs TO app_runtime');
  await knex.raw('GRANT SELECT ON analytics.erp_purchase_doc_lines TO app_runtime');

  await knex.raw(`COMMENT ON VIEW analytics.erp_purchase_docs IS
    'Vista derive-no-copy: OC (X-A-35) y vales (X-A-37) EN VIVO desde kepler_ods.kdm1, '
    'anti-réplica c1=sucursal. Los dos doctypes comparten shape; doctype sale de c4. '
    'Reemplaza la tabla + importer batch (ER.7). Backup: *_snapshot_bak.'`);
};

exports.down = async function (knex) {
  const cur = await knex.raw(`SELECT relkind FROM pg_class WHERE oid = to_regclass('analytics.erp_purchase_docs')`);
  if (!cur.rows[0] || cur.rows[0].relkind !== 'v') return;
  await knex.raw(`DROP VIEW IF EXISTS analytics.erp_purchase_doc_lines`);
  await knex.raw(`DROP VIEW IF EXISTS analytics.erp_purchase_docs`);
  if (await knex.schema.withSchema('analytics').hasTable('erp_purchase_docs_snapshot_bak')) {
    await knex.raw(`ALTER TABLE analytics.erp_purchase_docs_snapshot_bak RENAME TO erp_purchase_docs`);
    await knex.raw(`ALTER TABLE IF EXISTS analytics.erp_purchase_doc_lines_snapshot_bak RENAME TO erp_purchase_doc_lines`);
  }
};
