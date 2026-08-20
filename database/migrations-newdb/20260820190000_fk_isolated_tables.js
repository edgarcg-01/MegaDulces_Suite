/**
 * FKJ (cierre) — FK en las tablas AISLADAS que tenían columna-dim sin relación (resto del Grupo A
 * que no se había migrado). 10 FK sobre 8 tablas, **0 huérfanos verificado** en prod (2026-08-20).
 * Regla por semántica: columna NOT NULL → RESTRICT · nullable → SET NULL. Compuesta `(tenant_id,col)`
 * cuando la dim tiene UNIQUE `(tenant_id,id)` y la hija tiene tenant_id (SET NULL usa `SET NULL(col)`
 * PG18 para no nular tenant_id); si no, FK simple a `(id)`. NOT VALID + VALIDATE (try/catch tolerante).
 * NO TRANSACCIONAL (evita acumular ACCESS EXCLUSIVE; VALIDATE no bloquea feeds). Idempotente.
 *
 * NO incluidas (documentado): `public.route_location_pings.route_id` / `route_snapped_tracks.route_id`
 * — sus 18 valores NO casan con ninguna tabla de rutas (logistics.routes/field_routes/
 * vendor_sales_routes) → referencias colgadas sin destino, no FKeables (hueco de modelo).
 * @param { import("knex").Knex } knex
 */
exports.config = { transaction: false };

const SPEC = [
  { t: 'commercial.product_unit_overrides', col: 'product_id', ref: 'catalog.products' },
  { t: 'commercial.push_subscriptions', col: 'customer_id', ref: 'commercial.customers' },
  { t: 'commercial.contact_trust_features', col: 'customer_id', ref: 'commercial.customers' },
  { t: 'fiscal.emission_errors', col: 'order_id', ref: 'commercial.orders' },
  { t: 'logistics.vehicle_positions', col: 'vehicle_id', ref: 'logistics.vehicles' },
  { t: 'catalog.products_top_sellers', col: 'brand_id', ref: 'catalog.brands' },
  { t: 'catalog.products_top_sellers', col: 'category_id', ref: 'catalog.categories' },
  { t: 'catalog.top_sellers_live', col: 'brand_id', ref: 'catalog.brands' },
  { t: 'catalog.top_sellers_live', col: 'category_id', ref: 'catalog.categories' },
  { t: 'trade.stores_route_audit', col: 'store_id', ref: 'trade.stores' },
];
const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';
const fkName = (s) => `fk_${s.t.split('.')[1]}_${s.col}`;

exports.up = async function (knex) {
  const notValidated = [];
  for (const s of SPEC) {
    const [sch, tab] = s.t.split('.');
    const [rsch, rtab] = s.ref.split('.');
    const name = fkName(s);
    const exists = await knex.raw(
      `SELECT 1 FROM pg_constraint WHERE conname=? AND conrelid=to_regclass(?)`, [name, s.t]);
    if (exists.rows.length) continue;

    // nullability de la columna hija
    const nul = (await knex.raw(
      `SELECT is_nullable FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=?`,
      [sch, tab, s.col])).rows[0];
    const nullable = nul && nul.is_nullable === 'YES';

    // ¿la dim tiene UNIQUE/PK (tenant_id,id) y la hija tiene tenant_id? → compuesta
    const refComposite = (await knex.raw(`
      SELECT 1 FROM pg_constraint con
       WHERE con.conrelid=to_regclass(?) AND con.contype IN ('p','u')
         AND (SELECT array_agg(a.attname ORDER BY a.attname) FROM unnest(con.conkey) k(attnum)
                JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.attnum) = ARRAY['id','tenant_id']`,
      [s.ref])).rows.length > 0;
    const childHasTenant = (await knex.raw(
      `SELECT 1 FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name='tenant_id'`,
      [sch, tab])).rows.length > 0;
    const composite = refComposite && childHasTenant;

    const cols = composite ? `(${q('tenant_id')}, ${q(s.col)})` : `(${q(s.col)})`;
    const refCols = composite ? `(${q('tenant_id')}, ${q('id')})` : `(${q('id')})`;
    const onDel = !nullable ? 'RESTRICT'
      : (composite ? `SET NULL (${q(s.col)})` : 'SET NULL');
    const tbl = `${q(sch)}.${q(tab)}`;
    await knex.raw(
      `ALTER TABLE ${tbl} ADD CONSTRAINT ${q(name)} FOREIGN KEY ${cols}
         REFERENCES ${q(rsch)}.${q(rtab)} ${refCols} ON DELETE ${onDel} NOT VALID`);
    try {
      await knex.raw(`ALTER TABLE ${tbl} VALIDATE CONSTRAINT ${q(name)}`);
    } catch (e) {
      notValidated.push(s.t);
      // eslint-disable-next-line no-console
      console.log(`  ⚠ ${s.t}.${s.col}: ${onDel} pero NOT VALID (${e.message.slice(0, 50)})`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[fk isolated] ${SPEC.length} FK procesadas · ${notValidated.length} NOT VALID`);
};

exports.down = async function (knex) {
  for (const s of SPEC) {
    const [sch, tab] = s.t.split('.');
    await knex.raw(`ALTER TABLE ${q(sch)}.${q(tab)} DROP CONSTRAINT IF EXISTS ${q(fkName(s))}`);
  }
};
