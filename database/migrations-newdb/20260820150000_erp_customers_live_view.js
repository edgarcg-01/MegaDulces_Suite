/**
 * FKJ (copia → vista) — `analytics.erp_customers` de tabla materializada → VISTA derive-no-copy
 * sobre `kepler_ods.kdud`. Mismo patrón que erp_collections/goods_receipts/supplier_payments/
 * expense_documents. Mata 2 findings del audit (commercial-analytics:2270 erpCustomers +
 * thot-tools:397 resolveEntity leían la copia nightly → drift entre corridas).
 *
 * Fuente (idéntica al importer import-erp-customers.js KV.3): md.kdud c2=code, c3=name, c10=rfc,
 * c6=city; erp_code = c2 normalizado (numérico → lpad 5); excluye 'NO USAR%'/'NO USUAR%'; dedup por
 * código (DISTINCT ON prefiriendo fila con RFC, luego menor sucursal). Contrato de 6 columnas
 * idéntico (tenant_id, erp_code, name, rfc, city, computed_at). El ODS ya viene fresco vía CDC →
 * sin importer que se atrase. Idempotente (guard relkind). Reversible. La tabla queda como backup.
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

const VIEW = `
  CREATE VIEW analytics.erp_customers AS
  SELECT DISTINCT ON (k.norm_code)
    '${M}'::uuid                        AS tenant_id,
    k.norm_code                         AS erp_code,
    btrim(k.c3::text)                   AS name,
    NULLIF(btrim(k.c10::text),'')       AS rfc,
    NULLIF(btrim(k.c6::text),'')        AS city,
    now()                               AS computed_at
  FROM (
    SELECT sucursal,
           CASE WHEN btrim(c2::text) ~ '^[0-9]+$' THEN lpad(btrim(c2::text),5,'0') ELSE btrim(c2::text) END AS norm_code,
           c3, c10, c6
      FROM kepler_ods.kdud
     WHERE btrim(coalesce(c2::text,'')) <> '' AND c3 IS NOT NULL
       AND c3 NOT ILIKE 'NO USAR%' AND c3 NOT ILIKE 'NO USUAR%'
  ) k
  ORDER BY k.norm_code, (k.c10 IS NOT NULL) DESC, k.sucursal
`;

exports.up = async function (knex) {
  const rk = await knex.raw(`SELECT relkind FROM pg_class WHERE oid=to_regclass('analytics.erp_customers')`);
  const kind = rk.rows[0] && rk.rows[0].relkind;
  if (kind === 'v') return;   // ya es vista
  if (kind === 'r') {
    await knex.raw('ALTER TABLE analytics.erp_customers RENAME TO erp_customers_snapshot_bak');
  }
  await knex.raw(VIEW);
  await knex.raw('GRANT SELECT ON analytics.erp_customers TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.erp_customers IS
    'Vista derive-no-copy: dim de clientes EN VIVO desde kepler_ods.kdud (c2=code norm lpad5, c3=name, c10=rfc, c6=city; excluye NO USAR; dedup DISTINCT ON code). Reemplaza la copia nightly (import-erp-customers.js retirado). Backup: erp_customers_snapshot_bak.'`);
};

exports.down = async function (knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_customers');
  const bak = await knex.raw(`SELECT 1 FROM pg_class WHERE oid=to_regclass('analytics.erp_customers_snapshot_bak')`);
  if (bak.rows.length) {
    await knex.raw('ALTER TABLE analytics.erp_customers_snapshot_bak RENAME TO erp_customers');
  }
};
