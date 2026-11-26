'use strict';
/**
 * `[PGP.210]` C1 — **El contrato que sustenta cada cargo que el banco cobra solo** (anexo CR §3.1, DCR2 de Francisco:
 * «la Suite debe llevar esos contratos; todos los cargos tienen que estar sustentados por contratos»).
 *
 * Es dato propio, propuesto por el sistema y confirmado por una persona (DCR1): **sí va en tabla** (regla principal:
 * esto no es un importer ni la copia de nada; lo que el banco ya dice se LEE de `finance.v_recurring_bank_charges`).
 *
 *  · `finance.charge_contracts` — quién cobra (`creditor_name`, `kind`), desde qué cuenta (`charge_bank_account_id`),
 *    qué días (`cadence` + `day_from`/`day_to`), su vigencia, su PDF, su acreedor de Kepler (opcional) y en qué va:
 *    `propuesto` → `confirmado` (Tesorería) o `cancelado` (rechazado, con motivo); `confirmado` → `terminado` (con
 *    motivo). `origin` dice si lo propuso la historia del banco (`[PGP.209]`) o lo dio de alta una persona.
 *  · `finance.charge_contract_lines` — cada concepto que cobra (renta, capital, interés, IVA, seguro, comisión) con su
 *    regla de importe: `fijo` (con importe), `tabla` (su tabla de amortización) o `estimado` (lo último que cobró el
 *    banco, DCR10). El interés de tasa variable lleva su referencia, sus puntos y la base de días (DCR8/DCR10).
 *    `series_key` liga el renglón con la serie del banco que lo propuso o que lo cobra.
 *  · `finance.charge_contract_schedule` — la tabla de amortización de un renglón «por tabla»: fecha, importe y saldo
 *    insoluto (para calcular el interés un día antes, DCR8).
 *
 * ── Lo medido antes (sólo lectura, pg-prod `system_identifier` 7688376744939610156, 2026-11-25) ──────────────────
 *  · Las 47 series vigentes de `[PGP.209]` (≈ $512 mil al mes) darían, con `agruparPropuestas` (el TS real),
 *    **41 propuestas con 47 renglones**: 2 créditos de Banorte de 4 renglones cada uno (capital fijo; intereses,
 *    intereses no reales e IVA estimados; ≈ $231 mil al mes), 25 cuotas de comisión (≈ $5.7 mil) y 14 «por clasificar»
 *    (≈ $275 mil: las domiciliaciones de la arrendadora, STM y los seguros: el concepto del banco no dice qué son).
 *  · `finance.financial_commitments` (donde nacerá el cargo de cada mes, `[PGP.211]`) tiene 0 filas.
 *  · Ninguna tabla guarda hoy un contrato de cargo.
 *
 * Tablas nuevas: `tenant_id` + auditoría + RLS forzada (regla 18). El tenant del renglón y de la tabla es el de su
 * contrato (llave foránea compuesta: no se cruza un tenant con otro). `app_runtime` no borra contratos ni renglones
 * (un contrato se termina o se cancela, nunca desaparece); la tabla de amortización sí se puede reemplazar.
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TIPOS = ['arrendamiento', 'credito', 'seguro', 'fonacot', 'cuota_comision', 'servicio', 'nomina', 'por_clasificar'];
const ESTADOS = ['propuesto', 'confirmado', 'terminado', 'cancelado'];
const ORIGENES = ['historia', 'manual'];
const CADENCIAS = ['mensual', 'semanal'];
const CONCEPTOS = ['renta', 'capital', 'interes', 'iva', 'seguro', 'comision', 'otro'];
const REGLAS = ['fijo', 'tabla', 'estimado'];
/** DCR11: los tipos que no se confirman sin el PDF del contrato. */
const TIPOS_CON_DOCUMENTO = ['arrendamiento', 'credito', 'seguro', 'fonacot'];
const lista = (xs) => xs.map((x) => `'${x}'`).join(', ');

const C = 'finance.charge_contracts';
const L = 'finance.charge_contract_lines';
const S = 'finance.charge_contract_schedule';

exports.TIPOS = TIPOS;
exports.ESTADOS = ESTADOS;
exports.ORIGENES = ORIGENES;
exports.CADENCIAS = CADENCIAS;
exports.CONCEPTOS = CONCEPTOS;
exports.REGLAS = REGLAS;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS ${C} (
      id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id              uuid NOT NULL,
      kind                   text NOT NULL DEFAULT 'por_clasificar',
      creditor_name          text NOT NULL,
      reference              text,
      charge_bank_account_id uuid NOT NULL REFERENCES finance.bank_accounts(id),
      cadence                text NOT NULL DEFAULT 'mensual',
      day_from               smallint NOT NULL,
      day_to                 smallint NOT NULL,
      starts_on              date,
      ends_on                date,
      status                 text NOT NULL DEFAULT 'propuesto',
      origin                 text NOT NULL,
      kepler_creditor_code   text,
      sucursal               text,
      document_storage_key   text,
      document_name          text,
      evidence               jsonb,
      notes                  text,
      confirmed_at           timestamptz,
      confirmed_by           text,
      terminated_at          timestamptz,
      terminated_by          text,
      end_reason             text,
      cancelled_at           timestamptz,
      cancelled_by           text,
      cancel_reason          text,
      created_at             timestamptz NOT NULL DEFAULT now(),
      created_by             text NOT NULL,
      updated_at             timestamptz NOT NULL DEFAULT now(),
      updated_by             text,
      CONSTRAINT charge_contracts_tenant_id_ux UNIQUE (tenant_id, id)
    )`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS ${L} (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id          uuid NOT NULL,
      contract_id        uuid NOT NULL,
      concept            text NOT NULL,
      description        text NOT NULL,
      bank_concept_head  text,
      amount_rule        text NOT NULL,
      fixed_amount       numeric(14,2),
      charges_per_period smallint NOT NULL DEFAULT 1,
      rate_reference     text,
      rate_spread        numeric(8,4),
      day_count_basis    smallint,
      series_key         text,
      sort_order         smallint NOT NULL DEFAULT 1,
      created_at         timestamptz NOT NULL DEFAULT now(),
      created_by         text NOT NULL,
      updated_at         timestamptz NOT NULL DEFAULT now(),
      updated_by         text,
      CONSTRAINT charge_contract_lines_tenant_id_ux UNIQUE (tenant_id, id),
      CONSTRAINT charge_contract_lines_contract_fk FOREIGN KEY (tenant_id, contract_id) REFERENCES ${C} (tenant_id, id)
    )`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS ${S} (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id         uuid NOT NULL,
      line_id           uuid NOT NULL,
      due_date          date NOT NULL,
      amount            numeric(14,2) NOT NULL,
      principal_balance numeric(14,2),
      created_at        timestamptz NOT NULL DEFAULT now(),
      created_by        text NOT NULL,
      updated_at        timestamptz NOT NULL DEFAULT now(),
      updated_by        text,
      CONSTRAINT charge_contract_schedule_line_fk FOREIGN KEY (tenant_id, line_id) REFERENCES ${L} (tenant_id, id),
      CONSTRAINT charge_contract_schedule_line_date_ux UNIQUE (line_id, due_date)
    )`);

  const ck = async (tabla, nombre, expr) => {
    const t = tabla.split('.')[1];
    await knex.raw(`ALTER TABLE ${tabla} DROP CONSTRAINT IF EXISTS ${t}_${nombre}`);
    await knex.raw(`ALTER TABLE ${tabla} ADD CONSTRAINT ${t}_${nombre} CHECK (${expr})`);
  };
  // El contrato
  await ck(C, 'kind_ck', `kind IN (${lista(TIPOS)})`);
  await ck(C, 'status_ck', `status IN (${lista(ESTADOS)})`);
  await ck(C, 'origin_ck', `origin IN (${lista(ORIGENES)})`);
  await ck(C, 'cadence_ck', `cadence IN (${lista(CADENCIAS)})`);
  await ck(C, 'days_ck', `(cadence = 'mensual' AND day_from BETWEEN 1 AND 31 AND day_to BETWEEN 1 AND 31)
                       OR (cadence = 'semanal' AND day_from BETWEEN 1 AND 7 AND day_to BETWEEN 1 AND 7)`);
  await ck(C, 'term_ck', `starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on`);
  await ck(C, 'creditor_ck', `length(btrim(creditor_name)) BETWEEN 2 AND 200`);
  // «Por clasificar» sólo vive en una propuesta (o en una rechazada): para confirmar hay que decir qué es.
  await ck(C, 'classified_ck', `kind <> 'por_clasificar' OR status IN ('propuesto', 'cancelado')`);
  await ck(C, 'sucursal_ck', `sucursal IS NULL OR sucursal ~ '^[0-9]{2}$'`);
  await ck(C, 'document_ck', `(document_storage_key IS NULL) = (document_name IS NULL)`);
  // DCR11 (Francisco, 2026-11-26): arrendamiento, crédito, seguro y FONACOT se confirman con el PDF del contrato.
  await ck(C, 'document_required_ck', `NOT (status IN ('confirmado', 'terminado') AND kind IN (${lista(TIPOS_CON_DOCUMENTO)}) AND document_storage_key IS NULL)`);
  // El estado y sus huellas van juntos: quién y cuándo confirmó, terminó (con motivo) o rechazó (con motivo).
  await ck(C, 'state_ck', `
       (status = 'propuesto'  AND confirmed_at IS NULL AND terminated_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'confirmado' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL AND terminated_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'terminado'  AND confirmed_at IS NOT NULL AND terminated_at IS NOT NULL AND terminated_by IS NOT NULL
                              AND length(btrim(coalesce(end_reason, ''))) >= 3 AND cancelled_at IS NULL)
    OR (status = 'cancelado'  AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND terminated_at IS NULL
                              AND length(btrim(coalesce(cancel_reason, ''))) >= 3)`);
  // El renglón
  await ck(L, 'concept_ck', `concept IN (${lista(CONCEPTOS)})`);
  await ck(L, 'rule_ck', `amount_rule IN (${lista(REGLAS)})`);
  await ck(L, 'fixed_ck', `(amount_rule = 'fijo') = (fixed_amount IS NOT NULL)`);
  await ck(L, 'amount_ck', `fixed_amount IS NULL OR fixed_amount > 0`);
  await ck(L, 'charges_ck', `charges_per_period BETWEEN 1 AND 31`);
  await ck(L, 'description_ck', `length(btrim(description)) BETWEEN 2 AND 200`);
  // La tasa variable sólo en un interés, con su referencia y su base de días (DCR8/DCR10).
  await ck(L, 'rate_ck', `(rate_reference IS NULL AND rate_spread IS NULL AND day_count_basis IS NULL)
                       OR (concept = 'interes' AND length(btrim(rate_reference)) >= 2 AND day_count_basis IN (360, 365))`);
  // La tabla
  await ck(S, 'amount_ck', `amount > 0`);
  await ck(S, 'balance_ck', `principal_balance IS NULL OR principal_balance >= 0`);

  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_charge_contracts_status ON ${C} (tenant_id, status)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_charge_contracts_account ON ${C} (tenant_id, charge_bank_account_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_charge_contract_lines_contract ON ${L} (contract_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_charge_contract_lines_series ON ${L} (tenant_id, series_key) WHERE series_key IS NOT NULL`);

  for (const [tabla, permisos] of [[C, 'SELECT, INSERT, UPDATE'], [L, 'SELECT, INSERT, UPDATE'], [S, 'SELECT, INSERT, UPDATE, DELETE']]) {
    const t = tabla.split('.')[1];
    await knex.raw(`ALTER TABLE ${tabla} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${tabla} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS ${t}_tenant ON ${tabla}`);
    await knex.raw(`CREATE POLICY ${t}_tenant ON ${tabla} USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())`);
    await knex.raw(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        REVOKE ALL ON ${tabla} FROM app_runtime;
        GRANT ${permisos} ON ${tabla} TO app_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN GRANT SELECT ON ${tabla} TO dev_ro; END IF;
    END $$`);
  }

  await knex.raw(`COMMENT ON TABLE ${C} IS
    $$[PGP.210] El contrato que sustenta un cargo que el banco cobra solo (DCR2). propuesto (por la historia del banco,
    PGP.209, o por una persona) -> confirmado por Tesoreria (DCR1) o cancelado con motivo; confirmado -> terminado con
    motivo. kind por_clasificar solo en una propuesta. Dato propio (HITL): nunca se borra.$$`);
  await knex.raw(`COMMENT ON TABLE ${L} IS
    $$[PGP.210] Cada concepto que cobra un contrato: regla de importe fijo (con importe), tabla (su tabla de amortizacion)
    o estimado (lo ultimo que cobro el banco, DCR10). series_key = la serie de finance.v_recurring_bank_charges.$$`);
  await knex.raw(`COMMENT ON TABLE ${S} IS
    $$[PGP.210] La tabla de amortizacion de un renglon por tabla (DCR8): fecha, importe y saldo insoluto.$$`);
};

/**
 * Deshace lo que hizo el `up` sin borrar decisiones humanas (regla 5): si ya hay contratos (propuestos o confirmados),
 * las tablas se conservan y se dice; sólo vacías se quitan.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (await knex.schema.withSchema('finance').hasTable('charge_contracts')) {
    // Contar SIN la RLS: con ella, un rol que no es superusuario vería 0 contratos y borraría lo que no ve. Con
    // `row_security = off`, a ese rol la consulta le TRUENA en vez de contar mal: el down se detiene.
    await knex.raw(`SET LOCAL row_security = off`);
    const n = Number((await knex.raw(`SELECT count(*)::int AS n FROM ${C}`)).rows[0].n);
    if (n > 0) {
      // eslint-disable-next-line no-console
      console.log(`[PGP.210] ${C} tiene ${n} contrato(s): se conservan las tres tablas (regla 5).`);
      return;
    }
  }
  await knex.raw(`DROP TABLE IF EXISTS ${S}`);
  await knex.raw(`DROP TABLE IF EXISTS ${L}`);
  await knex.raw(`DROP TABLE IF EXISTS ${C}`);
};
