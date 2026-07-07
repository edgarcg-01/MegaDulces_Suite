/**
 * MAAT.1 — Data completa para la AI de Finanzas (ADR-028):
 *
 * `analytics.ledger_monthly`    = BALANZA DE COMPROBACIÓN completa (familias 1-9):
 *                                 cargos/abonos/neto por cuenta × sucursal × mes.
 *                                 Granularidad agregada (miles de filas, no millones)
 *                                 — suficiente para P&L, saldos y análisis de
 *                                 tendencia; el detalle de egresos ya vive en
 *                                 expense_entries. Habilita maat_balanza/maat_pnl.
 *
 * `analytics.expense_doc_chain` = CADENA DE APROVISIONAMIENTO por factura de compra
 *                                 (XA2001): orden (XA3501) → recepción (XA3701) →
 *                                 factura → pago programado (XA4001), reconstruida
 *                                 del lineage kdm1.c39 (descifrado 2026-07-06) con
 *                                 validación beneficiario+total. Habilita el
 *                                 timeline del drill de egresos (GX.4.3b absorbido),
 *                                 maat_cadena y el detector `cadena_incompleta`.
 *
 * Los puebla `import-ledger-chain.js`. Aditivas, idempotentes, schema analytics,
 * sin RLS (filtro de tenant explícito, igual que el resto de analytics.*).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  if (!(await knex.schema.withSchema('analytics').hasTable('ledger_monthly'))) {
    await knex.raw(`
      CREATE TABLE analytics.ledger_monthly (
        tenant_id           uuid NOT NULL,
        sucursal            text NOT NULL,
        cuenta              text NOT NULL,       -- mayor ('511') o subcuenta ('601-001'), tal como postea Kepler
        cuenta_nombre       text,
        cuenta_mayor        text,                -- split_part(cuenta,'-',1)
        cuenta_mayor_nombre text,
        familia             text,                -- primer dígito: 1 activo … 9 presupuestos
        anio_mes            text NOT NULL,       -- 'YYYY-MM'
        cargos              numeric NOT NULL DEFAULT 0,
        abonos              numeric NOT NULL DEFAULT 0,
        neto                numeric NOT NULL DEFAULT 0,  -- cargos − abonos
        movs                int NOT NULL DEFAULT 0,
        computed_at         timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, sucursal, cuenta, anio_mes)
      )`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_ledger_fam_mes ON analytics.ledger_monthly (tenant_id, familia, anio_mes)`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_ledger_mayor ON analytics.ledger_monthly (tenant_id, cuenta_mayor, anio_mes)`);
    await knex.raw(`GRANT SELECT ON analytics.ledger_monthly TO app_runtime`);
  }

  if (!(await knex.schema.withSchema('analytics').hasTable('expense_doc_chain'))) {
    await knex.raw(`
      CREATE TABLE analytics.expense_doc_chain (
        tenant_id        uuid NOT NULL,
        sucursal         text NOT NULL,
        factura_folio    text NOT NULL,          -- ancla = XA2001
        factura_fecha    date,
        orden_folio      text,                   -- XA3501
        orden_fecha      date,
        recepcion_folio  text,                   -- XA3701
        recepcion_fecha  date,
        pago_folio       text,                   -- XA4001 (pago PROGRAMADO; el pago con dinero es XD2601 y se batchea → DPO real queda agregado en ap_provider)
        pago_fecha       date,
        beneficiario     text,
        total            numeric DEFAULT 0,
        lead_days        int,                    -- orden → factura
        pago_days        int,                    -- factura → pago programado
        match_confidence text,                   -- 'exact' (puntero c39 + benef+total) | 'inferred' (benef+total+ventana) | 'partial'
        computed_at      timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, sucursal, factura_folio)
      )`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_chain_benef ON analytics.expense_doc_chain (tenant_id, beneficiario)`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_chain_missing ON analytics.expense_doc_chain (tenant_id, sucursal) WHERE recepcion_folio IS NULL`);
    await knex.raw(`GRANT SELECT ON analytics.expense_doc_chain TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('expense_doc_chain');
  await knex.schema.withSchema('analytics').dropTableIfExists('ledger_monthly');
};
