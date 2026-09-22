'use strict';
/**
 * E.12.1 (forward) — condiciones comerciales (snapshot) + procedencia del precio en cotizaciones.
 *
 * ── Por qué esta migración es SEPARADA y no un edit de 20260921190000 ────────────────────────
 * `20260921190000_commercial_quotes.js` YA está aplicada en prod (batch 504, cuando se mergeó
 * #137). Editar su `up()` NO la re-corre (knex la salta) → las columnas no llegarían a prod pero
 * sí a un `migrate:latest` fresco. El candado `database/scripts/check-applied-migrations.js` caza
 * ese patrón; acá se hace lo correcto: una migración NUEVA, idempotente (`hasColumn` + guardas de
 * constraint), que converge en prod y en fresh.
 *
 * ── Qué agrega (medido en `kepler_ods.kdud`/`kdpv_*` el 2026-09-21) ──────────────────────────
 * `commercial.quotes` — las condiciones CON LAS QUE SE COTIZÓ, congeladas: el padrón de mayoreo
 * es POR SUCURSAL y el mismo cliente NO tiene las mismas condiciones en todas (204/1,574 distinto
 * límite, 118 distinto plazo, 57 distinto descuento). Una cotización que no diga de qué sucursal
 * salió su descuento no se puede auditar. `terms_source` DECLARA el origen: NULL en los importes
 * = "no se pudo leer", nunca un 0 que se lea como "sin descuento" (ADR-056).
 *
 * `commercial.quote_lines` — `price_source` dice cuál de los mecanismos de Kepler se aplicó
 * (lista / descuento del cliente / por cantidad `kdpv_descuxq` / por monto `kdpv_descuxm` /
 * regalo `kdpv_gratisxq/xm` / manual / unknown), para que un precio bajo sea explicable. El
 * renglón de REGALO tiene precio cero REAL — se distingue del NULL "no supe" por
 * `price_source='free_goods'`, y `parent_line_number` apunta al renglón que ganó el regalo.
 *
 * @param { import("knex").Knex } knex
 */

async function addConstraint(knex, table, name, check) {
  const { rows } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = ?`, [name]);
  if (!rows.length) {
    await knex.raw(`ALTER TABLE commercial.${table} ADD CONSTRAINT ${name} CHECK (${check})`);
  }
}

exports.up = async function up(knex) {
  const has = (t, c) => knex.schema.withSchema('commercial').hasColumn(t, c);

  if (!(await has('quotes', 'source_branch')))        await knex.raw(`ALTER TABLE commercial.quotes ADD COLUMN source_branch varchar(4)`);
  if (!(await has('quotes', 'terms_discount_pct')))   await knex.raw(`ALTER TABLE commercial.quotes ADD COLUMN terms_discount_pct decimal(6,3)`);
  if (!(await has('quotes', 'terms_credit_limit')))   await knex.raw(`ALTER TABLE commercial.quotes ADD COLUMN terms_credit_limit decimal(14,2)`);
  if (!(await has('quotes', 'terms_payment_days')))   await knex.raw(`ALTER TABLE commercial.quotes ADD COLUMN terms_payment_days integer`);
  if (!(await has('quotes', 'terms_source')))         await knex.raw(`ALTER TABLE commercial.quotes ADD COLUMN terms_source varchar(20) NOT NULL DEFAULT 'unknown'`);
  if (!(await has('quotes', 'delivery_address_key'))) await knex.raw(`ALTER TABLE commercial.quotes ADD COLUMN delivery_address_key varchar(10)`);

  await addConstraint(knex, 'quotes', 'commercial_quotes_terms_source_valid',
    `terms_source IN ('kepler_kdud', 'manual', 'unknown')`);
  // Si dice venir de Kepler, trae la sucursal de la que salió (las condiciones varían por sucursal).
  await addConstraint(knex, 'quotes', 'commercial_quotes_kepler_terms_need_branch',
    `terms_source <> 'kepler_kdud' OR source_branch IS NOT NULL`);

  if (!(await has('quote_lines', 'price_source')))       await knex.raw(`ALTER TABLE commercial.quote_lines ADD COLUMN price_source varchar(24) NOT NULL DEFAULT 'unknown'`);
  if (!(await has('quote_lines', 'parent_line_number'))) await knex.raw(`ALTER TABLE commercial.quote_lines ADD COLUMN parent_line_number integer`);

  await addConstraint(knex, 'quote_lines', 'commercial_quote_lines_price_source_valid',
    `price_source IN ('list','customer_terms','volume_qty','volume_amount','free_goods','manual','unknown')`);
  // El cero sólo es precio legítimo en un regalo; en cualquier otro caso "no supe" es NULL.
  await addConstraint(knex, 'quote_lines', 'commercial_quote_lines_zero_price_only_free_goods',
    `unit_price IS NULL OR unit_price > 0 OR price_source = 'free_goods'`);
  // Un regalo cuelga del renglón que lo ganó, y sólo un regalo cuelga de algo.
  await addConstraint(knex, 'quote_lines', 'commercial_quote_lines_parent_only_free_goods',
    `parent_line_number IS NULL OR price_source = 'free_goods'`);
};

exports.down = async function down(knex) {
  for (const n of ['commercial_quote_lines_parent_only_free_goods',
                   'commercial_quote_lines_zero_price_only_free_goods',
                   'commercial_quote_lines_price_source_valid']) {
    await knex.raw(`ALTER TABLE commercial.quote_lines DROP CONSTRAINT IF EXISTS ${n}`);
  }
  for (const c of ['price_source', 'parent_line_number']) {
    if (await knex.schema.withSchema('commercial').hasColumn('quote_lines', c)) {
      await knex.raw(`ALTER TABLE commercial.quote_lines DROP COLUMN ${c}`);
    }
  }
  for (const n of ['commercial_quotes_kepler_terms_need_branch', 'commercial_quotes_terms_source_valid']) {
    await knex.raw(`ALTER TABLE commercial.quotes DROP CONSTRAINT IF EXISTS ${n}`);
  }
  for (const c of ['source_branch', 'terms_discount_pct', 'terms_credit_limit', 'terms_payment_days', 'terms_source', 'delivery_address_key']) {
    if (await knex.schema.withSchema('commercial').hasColumn('quotes', c)) {
      await knex.raw(`ALTER TABLE commercial.quotes DROP COLUMN ${c}`);
    }
  }
};
