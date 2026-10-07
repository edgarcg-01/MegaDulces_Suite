/**
 * CB.4.1 — Postings del `102` (bancos/caja) de Kepler a nivel transacción, para el
 * matching por-transacción banco↔Kepler. Espejo read-only de las pólizas 102:
 *   - XD2601/XD2501 (abono = sale dinero, pago a proveedor; c6=beneficiario)
 *   - UA0501 (cargo = entra dinero, cobranza; c6=plaza)
 * Lo puebla `import-bank-postings.js` (CEDIS md_00 centraliza el 102). analytics.*
 * sin RLS → filtro tenant explícito. Aditiva, idempotente.
 *
 * PK = client_uuid (hash de contenido + ocurrencia): los folios de Kepler se
 * reinician cada mes y las pólizas de cobranza no traen folio → una clave natural
 * (doc_tipo,folio,linea) colisiona. Mismo patrón que finance.bank_movements.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (!(await knex.schema.withSchema('analytics').hasTable('bank_postings'))) {
    await knex.raw(`
      CREATE TABLE analytics.bank_postings (
        tenant_id    uuid NOT NULL,
        client_uuid  text NOT NULL,           -- hash contenido + ocurrencia (idempotencia)
        sucursal     text NOT NULL,
        doc_tipo     text NOT NULL,           -- XD2601 | XD2501 | UA0501 | 0000 | …
        folio        text,
        linea        int,
        fecha        date,
        anio_mes     text NOT NULL,           -- 'YYYY-MM' (tabla mensual, canónico)
        cargo_abono  char(1) NOT NULL,        -- 'C' entra (cobranza) | 'A' sale (pago)
        importe      numeric NOT NULL DEFAULT 0,
        contraparte  text,                    -- c6 (proveedor/plaza)
        forma        text,                    -- c7 (EFECTIVO / fecha / referencia)
        computed_at  timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, client_uuid)
      )`);
    await knex.raw(`CREATE INDEX ix_bankpost_match ON analytics.bank_postings (tenant_id, anio_mes, cargo_abono, importe)`);
    await knex.raw(`CREATE INDEX ix_bankpost_fecha ON analytics.bank_postings (tenant_id, fecha)`);
    await knex.raw(`GRANT SELECT ON analytics.bank_postings TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('bank_postings');
};
