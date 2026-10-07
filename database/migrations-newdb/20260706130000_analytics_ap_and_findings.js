/**
 * GX v3 — Tanda 2: auxiliar de proveedores + hallazgos contables navegables.
 *
 * `analytics.ap_provider`     = auxiliar de proveedores reconstruido desde la cuenta
 *                               201 (plana en Kepler): compra, pagos, saldo, #facturas,
 *                               última compra y DPO (días de pago) por proveedor.
 * `analytics.expense_findings`= pólizas de los hallazgos contables, navegables desde
 *                               la UI (antes iban a CSV para finanzas):
 *                                 'iva_bug'      → XD5501 con abono huérfano a 122-001
 *                                 'prov_203'     → provisiones 203 nunca descargadas
 *                                 'anticipo_107' → anticipos a proveedor sin aplicar
 *
 * Los puebla `import-ap-findings.js` (mismo nightly). Aditiva, idempotente,
 * schema analytics, sin RLS (filtro de tenant explícito).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  if (!(await knex.schema.withSchema('analytics').hasTable('ap_provider'))) {
    await knex.raw(`
      CREATE TABLE analytics.ap_provider (
        tenant_id      uuid NOT NULL,
        sucursal       text NOT NULL,
        proveedor_norm text NOT NULL,   -- clave normalizada (agrupa typos/acentos)
        proveedor      text,            -- nombre para mostrar (más frecuente ponderado)
        compra_12m     numeric DEFAULT 0,   -- facturas (abono 201 vía XA2001)
        pagos_12m      numeric DEFAULT 0,   -- pagos con dinero (cargo 201 vía XD2601/XD2501)
        saldo          numeric DEFAULT 0,   -- neto en la ventana (compra − pagos − descuentos)
        num_facturas   int DEFAULT 0,
        ultima_compra  date,
        dpo_dias       int,             -- días de pago aprox = saldo / (compra/365)
        computed_at    timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, sucursal, proveedor_norm)
      )`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_ap_compra ON analytics.ap_provider (tenant_id, compra_12m)`);
    await knex.raw(`GRANT SELECT ON analytics.ap_provider TO app_runtime`);
  }

  if (!(await knex.schema.withSchema('analytics').hasTable('expense_findings'))) {
    await knex.raw(`
      CREATE TABLE analytics.expense_findings (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id    uuid NOT NULL,
        tipo         text NOT NULL,        -- 'iva_bug' | 'prov_203' | 'anticipo_107'
        sucursal     text,
        fecha        date,
        doc_tipo     text,
        doc_folio    text,
        beneficiario text,
        cuenta       text,                 -- cuenta contrapartida / de la provisión
        importe      numeric DEFAULT 0,    -- monto relevante del hallazgo
        nota         text,
        computed_at  timestamptz DEFAULT now()
      )`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_finding_tipo ON analytics.expense_findings (tenant_id, tipo, fecha)`);
    await knex.raw(`GRANT SELECT ON analytics.expense_findings TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('expense_findings');
  await knex.schema.withSchema('analytics').dropTableIfExists('ap_provider');
};
