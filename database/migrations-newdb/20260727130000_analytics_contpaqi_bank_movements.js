/**
 * CP.2 — Ledger bancario VIVO de ContPAQi → analytics.contpaqi_bank_movements (Fase CP, ADR-035).
 *
 * El lado-banco autoritativo de la contabilidad: cada movimiento de póliza sobre una cuenta de
 * banco `102xxxxxxx` (afectable) = un depósito (cargo) o retiro (abono), con fecha, importe,
 * folio de póliza, concepto de la póliza y flag EsConciliado. Es el equivalente contable del
 * estado de cuenta del banco → base para conciliar contra el workbook de la Fase CB (que hoy
 * concilia contra el proxy "Kepler 102"), ahora contra cuentas de banco REALES con folio.
 *
 * Nota de decode (2026-07-27): los módulos `Egresos`/`Cheques` de ContPAQi cayeron en desuso
 * (solo 2018-2019) → NO se usan; la verdad viva son los movimientos de póliza. `Referencia`
 * de la línea va vacía → el "a quién/qué" se toma de `Polizas.Concepto` (header).
 *
 * La puebla `database/importers/contpaqi/import-contpaqi-bank-movements.js`. Aditiva,
 * idempotente (PK por Id de movimiento origen), schema analytics, sin RLS (filtro explícito).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  if (!(await knex.schema.withSchema('analytics').hasTable('contpaqi_bank_movements'))) {
    await knex.raw(`
      CREATE TABLE analytics.contpaqi_bank_movements (
        tenant_id       uuid NOT NULL,
        id_movimiento   bigint NOT NULL,        -- MovimientosPoliza.Id (clave estable del origen)
        cuenta          text NOT NULL,          -- cuenta contable de banco '102xxxxxxx'
        cuenta_nombre   text,                   -- ej. 'SANTANDER 65503932169' (trae el número)
        fecha           date NOT NULL,
        flujo           text NOT NULL,          -- 'deposito' (cargo) | 'retiro' (abono) — cuenta de activo
        importe         numeric NOT NULL DEFAULT 0,
        ejercicio       int NOT NULL,
        periodo         int NOT NULL,
        anio_mes        text NOT NULL,          -- 'YYYY-MM'
        poliza_tipo     int,                    -- 1 Ingreso · 2 Egreso · 3 Diario
        poliza_folio    int,
        poliza_guid     text,
        concepto        text,                   -- Polizas.Concepto (header) — mejor pista de beneficiario
        referencia      text,                   -- MovimientosPoliza.Referencia (suele ir vacía)
        es_conciliado   boolean,                -- flag de conciliación de ContPAQi (casi no lo usan)
        computed_at     timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, id_movimiento)
      )`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_cpq_bank_cuenta_mes ON analytics.contpaqi_bank_movements (tenant_id, cuenta, anio_mes)`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_cpq_bank_mes_flujo ON analytics.contpaqi_bank_movements (tenant_id, anio_mes, flujo)`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_cpq_bank_fecha ON analytics.contpaqi_bank_movements (tenant_id, fecha)`);
    await knex.raw(`GRANT SELECT ON analytics.contpaqi_bank_movements TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('contpaqi_bank_movements');
};
