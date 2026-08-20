/**
 * FKJ (copia → vista + FIX) — `analytics.erp_shipments` de tabla materializada → VISTA derive-no-copy
 * sobre `kepler_ods.kdpord`, corrigiendo un DOBLE CONTEO pre-existente.
 *
 * Bug de la tabla (import-erp-shipments.js): kdpord está REPLICADO entre sucursales; el importer leía
 * las 6 y sumaba por folio×sku (`qty +=`) → N-contaba las réplicas. Verificado en prod (2026-08-20):
 * 4,983 de 4,991 colisiones cross-branch tienen el MISMO qty (réplicas). Impacto: units 2,718,245 →
 * 2,691,327 con anti-réplica (~1% menos). La vista aplica el anti-réplica `c19 = sucursal` (fila del
 * branch "dueño", patrón c1=sucursal de las otras vistas) → cada embarque cuenta UNA vez.
 *
 * Fuente (idéntica al importer KV.8): kdpord c1=folio, c3=sku, c9=qty, c10=unit, c22=route,
 * c24=doc_folio, c35=status, c6=shipped_date. product_id via LEFT JOIN a catalog.products (se
 * conservan los sin match, como la tabla). warehouse_code = sucursal dueña (c19), warehouse_id via
 * warehouses.code/kepler_code. Colapsa a 1 fila por (folio,sku) — SUM(qty) sobre las filas dueñas
 * (incluye los 8 folios genuinamente compartidos entre branches) — respetando el PK de la tabla.
 * Contrato de 13 columnas intacto. Idempotente (guard relkind). Reversible. Backup: *_snapshot_bak.
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

const VIEW = `
  CREATE VIEW analytics.erp_shipments AS
  SELECT DISTINCT ON (t.folio, t.sku)
    '${M}'::uuid                                       AS tenant_id,
    t.folio                                            AS shipment_folio,
    t.sku                                              AS sku,
    t.product_id                                       AS product_id,
    t.warehouse_code                                   AS warehouse_code,
    t.warehouse_id                                     AS warehouse_id,
    t.route                                            AS route,
    t.status                                           AS status,
    t.doc_folio                                        AS doc_folio,
    t.shipped_date                                     AS shipped_date,
    sum(t.qty) OVER (PARTITION BY t.folio, t.sku)      AS quantity,
    t.unit                                             AS unit,
    now()                                              AS computed_at
  FROM (
    SELECT
      btrim(k.c1::text)                    AS folio,
      btrim(k.c3::text)                    AS sku,
      GREATEST(k.c9::numeric, 0)           AS qty,
      NULLIF(btrim(k.c10::text),'')        AS unit,
      NULLIF(btrim(k.c22::text),'')        AS route,
      NULLIF(btrim(k.c24::text),'')        AS doc_folio,
      NULLIF(btrim(k.c35::text),'')        AS status,
      k.c6::date                           AS shipped_date,
      k.sucursal::text                     AS warehouse_code,
      p.id                                 AS product_id,
      w.id                                 AS warehouse_id,
      k.sucursal                           AS sucursal
    FROM kepler_ods.kdpord k
    LEFT JOIN catalog.products p
      ON p.tenant_id='${M}'::uuid AND btrim(p.sku)=btrim(k.c3::text)
    LEFT JOIN commercial.warehouses w
      ON w.tenant_id='${M}'::uuid AND w.deleted_at IS NULL
     AND (w.code=k.sucursal::text OR w.kepler_code=k.sucursal::text)
    WHERE k.c1 IS NOT NULL AND btrim(coalesce(k.c3::text,'')) <> ''
      AND btrim(k.c19::text) = k.sucursal::text     -- anti-réplica: solo la fila del branch dueño
  ) t
  ORDER BY t.folio, t.sku, t.sucursal
`;

exports.up = async function (knex) {
  const rk = await knex.raw(`SELECT relkind FROM pg_class WHERE oid=to_regclass('analytics.erp_shipments')`);
  const kind = rk.rows[0] && rk.rows[0].relkind;
  if (kind === 'v') return;
  if (kind === 'r') {
    await knex.raw('ALTER TABLE analytics.erp_shipments RENAME TO erp_shipments_snapshot_bak');
  }
  await knex.raw(VIEW);
  await knex.raw('GRANT SELECT ON analytics.erp_shipments TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.erp_shipments IS
    'Vista derive-no-copy: embarques EN VIVO desde kepler_ods.kdpord (KV.8) con anti-réplica c19=sucursal (corrige doble conteo del importer que sumaba réplicas cross-branch, ~1% units). 1 fila por (folio,sku), SUM(qty). Reemplaza import-erp-shipments.js (retirado). Backup: erp_shipments_snapshot_bak.'`);
};

exports.down = async function (knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_shipments');
  const bak = await knex.raw(`SELECT 1 FROM pg_class WHERE oid=to_regclass('analytics.erp_shipments_snapshot_bak')`);
  if (bak.rows.length) await knex.raw('ALTER TABLE analytics.erp_shipments_snapshot_bak RENAME TO erp_shipments');
};
