/**
 * GX.6 — `analytics.expense_requests`: solicitudes de gasto de Kepler (XA1501,
 * "Expense request"). Cada gasto aplicado (XA1001) nace de una solicitud; el
 * enlace es kdm1.c39 (folio de la solicitud). Esta tabla guarda la cabecera de
 * la solicitud para armar la CADENA solicitud→gasto en el drill y detectar
 * solicitudes SIN APLICAR (aprobadas/pedidas que nunca se volvieron gasto).
 *
 * La puebla `import-expense-requests.js`. Aditiva, idempotente, schema analytics,
 * sin RLS (filtro de tenant explícito, igual que el resto de analytics.*).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (await knex.schema.withSchema('analytics').hasTable('expense_requests')) return;
  await knex.raw(`
    CREATE TABLE analytics.expense_requests (
      tenant_id    uuid NOT NULL,
      sucursal     text NOT NULL,
      folio        text NOT NULL,
      fecha        date,
      importe      numeric DEFAULT 0,
      solicitante  text,             -- kdm1.c48 (quien pide)
      beneficiario text,             -- kdm1.c32 (proveedor/destino)
      concepto     text,             -- kdm1.c24 (glosa)
      estado       text,             -- kdm1.c43: F finalizada · A autorizada · C cancelada · N nueva
      usuario      text,             -- kdm1.c67 (capturó)
      aplicada     boolean DEFAULT false,  -- tiene un gasto XA1001 que la aplica
      computed_at  timestamptz DEFAULT now(),
      PRIMARY KEY (tenant_id, sucursal, folio)
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_exp_req_fecha ON analytics.expense_requests (tenant_id, fecha)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_exp_req_aplicada ON analytics.expense_requests (tenant_id, aplicada)`);
  await knex.raw(`GRANT SELECT ON analytics.expense_requests TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('expense_requests');
};
