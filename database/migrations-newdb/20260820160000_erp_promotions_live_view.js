/**
 * FKJ (copia → vista) — `analytics.erp_promotions` de tabla materializada → VISTA derive-no-copy
 * sobre las 4 tablas `kepler_ods.kdpv_*` (promos vigentes). Mismo patrón que erp_customers.
 *
 * Fuente (idéntica al importer import-erp-promos.js KV.6): kdpv_descuxq/gratisxq/descuxm/gratisxm,
 * SOLO vigentes (c8=valid_to >= hoy), de UNA sucursal (promos centrales → sucursal='03', como el
 * importer que leía md_03; las promos se replican entre sucursales). Mapeo: c2=sku, c4=nombre,
 * c5=threshold, c6/c11=benefit, c6=free (solo gratis), c7=valid_from, c8=valid_to, c1=warehouse_code.
 * sku→product_id via JOIN a catalog.products (INNER: el importer descartaba los sin match).
 * Paridad verificada read-only: 794 = 794 (tabla actual). Contrato de 13 columnas intacto.
 *
 * id: no lo consume nadie (los lectores usan sku/nombre/fechas) → uuid determinista md5(natural key)
 * para estabilidad. warehouse_id via warehouses.code/kepler_code. Idempotente (guard relkind).
 * Reversible. Backup: erp_promotions_snapshot_bak.
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';
const SUC = '03';

// (promo_type, tabla, col free|null, col benefit)  — threshold siempre c5, sku c2, nombre c4, vfrom c7, vto c8, suc c1
const SRCS = [
  { type: 'descuento_qty', tbl: 'kdpv_descuxq', free: null, ben: 'c6' },
  { type: 'gratis_qty', tbl: 'kdpv_gratisxq', free: 'c6', ben: 'c11' },
  { type: 'descuento_monto', tbl: 'kdpv_descuxm', free: null, ben: 'c6' },
  { type: 'gratis_monto', tbl: 'kdpv_gratisxm', free: 'c6', ben: 'c11' },
];

const selectFor = (s) => `
  SELECT
    md5(p.id::text||'|${s.type}|'||coalesce(k.c8::text,'')||'|'||coalesce(btrim(k.c1::text),''))::uuid AS id,
    '${M}'::uuid                                       AS tenant_id,
    p.id                                              AS product_id,
    '${s.type}'::text                                 AS promo_type,
    nullif(regexp_replace(k.c5::text,'[^0-9.-]','','g'),'')::numeric  AS threshold,
    nullif(regexp_replace(k.${s.ben}::text,'[^0-9.-]','','g'),'')::numeric AS benefit,
    ${s.free ? 'fp.id' : 'NULL::uuid'}                AS free_product_id,
    k.c7::date                                        AS valid_from,
    k.c8::date                                        AS valid_to,
    NULLIF(btrim(k.c1::text),'')                      AS warehouse_code,
    w.id                                              AS warehouse_id,
    NULLIF(btrim(k.c4::text),'')                      AS raw_name,
    now()                                             AS computed_at
  FROM kepler_ods.${s.tbl} k
  JOIN catalog.products p ON p.tenant_id='${M}'::uuid AND btrim(p.sku)=btrim(k.c2::text)
  ${s.free ? `LEFT JOIN catalog.products fp ON fp.tenant_id='${M}'::uuid AND btrim(fp.sku)=btrim(k.${s.free}::text)` : ''}
  LEFT JOIN commercial.warehouses w ON w.tenant_id='${M}'::uuid AND w.deleted_at IS NULL
       AND (w.code=btrim(k.c1::text) OR w.kepler_code=btrim(k.c1::text))
  WHERE k.sucursal='${SUC}' AND k.c8::date >= current_date`;

const VIEW = `CREATE VIEW analytics.erp_promotions AS\n${SRCS.map(selectFor).join('\n  UNION ALL\n')}`;

exports.up = async function (knex) {
  const rk = await knex.raw(`SELECT relkind FROM pg_class WHERE oid=to_regclass('analytics.erp_promotions')`);
  const kind = rk.rows[0] && rk.rows[0].relkind;
  if (kind === 'v') return;
  if (kind === 'r') {
    await knex.raw('ALTER TABLE analytics.erp_promotions RENAME TO erp_promotions_snapshot_bak');
  }
  await knex.raw(VIEW);
  await knex.raw('GRANT SELECT ON analytics.erp_promotions TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.erp_promotions IS
    'Vista derive-no-copy: promos vigentes EN VIVO desde kepler_ods.kdpv_* (sucursal 03, c8>=hoy; sku->products). Reemplaza la copia nightly (import-erp-promos.js retirado). Backup: erp_promotions_snapshot_bak.'`);
};

exports.down = async function (knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_promotions');
  const bak = await knex.raw(`SELECT 1 FROM pg_class WHERE oid=to_regclass('analytics.erp_promotions_snapshot_bak')`);
  if (bak.rows.length) await knex.raw('ALTER TABLE analytics.erp_promotions_snapshot_bak RENAME TO erp_promotions');
};
