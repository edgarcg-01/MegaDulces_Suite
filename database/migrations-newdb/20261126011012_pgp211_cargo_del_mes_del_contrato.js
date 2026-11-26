'use strict';
/**
 * `[PGP.211]` C1 — **El cargo de cada mes de un contrato confirmado, en el Calendario** (anexo CR §3.3, DCR5). Cada
 * contrato confirmado genera el cargo de su periodo en `finance.financial_commitments`, la fuente que el Calendario ya
 * lee (`legCommitment`), no una nueva (ADR-056).
 *
 *  · `contract_id`, `contract_line_id`, `period` (YYYY-MM) — de qué contrato y renglón, y de qué mes. Únicos por
 *    renglón y periodo: generar dos veces no duplica.
 *  · `amount_basis` — de dónde salió el importe: `fijo`, `tabla` (la tabla de amortización) o `estimado` (lo último
 *    que cobró el banco; DCR8/DCR10: se dice «estimado»).
 *  · Subtipos nuevos además de factoraje, interés, amortización y otro: arrendamiento, seguro, cuota de comisión,
 *    servicio, FONACOT y nómina (`SUBTIPOS_COMPROMISO`, la prueba exige que sean los del CHECK).
 *
 * ── Por qué no rompe nada (regla 14) ──────────────────────────────────────────────────────────────
 *  · Columnas NULLABLE sin default; el CHECK nuevo sólo exige que, SI la fila viene de un contrato, traiga su renglón,
 *    su periodo y su base. Los caminos que insertan hoy (`FinancialCommitmentsService.create`, las pruebas) no las
 *    mandan y quedan en NULL: pasan.
 *  · El CHECK de subtipos se AMPLÍA (los cuatro de siempre siguen).
 *  · Medido el 2026-11-26 (prod, sólo lectura): `finance.financial_commitments` tiene 0 filas.
 *
 * La llave al renglón es compuesta con el tenant (no se cruza un tenant con otro). Va DESPUÉS de `[PGP.210]`.
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const T = 'finance.financial_commitments';
const SUBTIPOS = ['factoraje', 'interes', 'amortizacion', 'otro', 'arrendamiento', 'seguro', 'cuota_comision', 'servicio', 'fonacot', 'nomina'];
const SUBTIPOS_ANTES = ['factoraje', 'interes', 'amortizacion', 'otro'];
const BASES = ['fijo', 'tabla', 'estimado'];
const lista = (xs) => xs.map((x) => `'${x}'`).join(', ');

exports.SUBTIPOS = SUBTIPOS;
exports.BASES = BASES;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.raw(`SELECT to_regclass('finance.charge_contract_lines') IS NOT NULL AS t`)).rows[0].t) {
    throw new Error('[PGP.211] falta finance.charge_contract_lines: aplica antes la migración de PGP.210 (20261126001551).');
  }
  for (const [col, tipo] of [['contract_id', 'uuid'], ['contract_line_id', 'uuid'], ['period', 'text'], ['amount_basis', 'text']]) {
    if (!(await knex.schema.withSchema('finance').hasColumn('financial_commitments', col))) {
      await knex.raw(`ALTER TABLE ${T} ADD COLUMN ${col} ${tipo}`);
    }
  }
  const ck = async (nombre, expr) => {
    await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS ${nombre}`);
    await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT ${nombre} CHECK (${expr})`);
  };
  await ck('financial_commitments_subtype_check', `subtype IN (${lista(SUBTIPOS)})`);
  // Si viene de un contrato trae su renglón, su periodo y la base de su importe; si no, nada de eso.
  await ck('financial_commitments_contract_ck', `
       (contract_id IS NULL AND contract_line_id IS NULL AND period IS NULL AND amount_basis IS NULL)
    OR (contract_id IS NOT NULL AND contract_line_id IS NOT NULL
        AND period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND amount_basis IN (${lista(BASES)}))`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS financial_commitments_contract_fk`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT financial_commitments_contract_fk
                    FOREIGN KEY (tenant_id, contract_id) REFERENCES finance.charge_contracts (tenant_id, id)`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS financial_commitments_contract_line_fk`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT financial_commitments_contract_line_fk
                    FOREIGN KEY (tenant_id, contract_line_id) REFERENCES finance.charge_contract_lines (tenant_id, id)`);
  // Generar dos veces = las mismas filas.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_fin_commitments_line_period
                    ON ${T} (tenant_id, contract_line_id, period) WHERE contract_line_id IS NOT NULL`);
  await knex.raw(`COMMENT ON COLUMN ${T}.contract_line_id IS
    $$[PGP.211] El renglon del contrato (finance.charge_contract_lines) cuyo cargo de este periodo es esta fila. Unico por periodo.$$`);
  await knex.raw(`COMMENT ON COLUMN ${T}.amount_basis IS
    $$[PGP.211] De donde salio el importe: fijo | tabla (amortizacion) | estimado (lo ultimo que cobro el banco, DCR8/DCR10).$$`);
};

/**
 * Deshace lo que hizo el `up` sin borrar cargos generados (regla 5): si ya hay alguno, se conserva todo y se dice.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('finance').hasColumn('financial_commitments', 'contract_line_id'))) return;
  await knex.raw(`SET LOCAL row_security = off`);
  const [{ n, nuevos }] = (await knex.raw(`SELECT count(*) FILTER (WHERE contract_line_id IS NOT NULL)::int AS n,
      count(*) FILTER (WHERE subtype NOT IN (${lista(SUBTIPOS_ANTES)}))::int AS nuevos FROM ${T}`)).rows;
  if (n > 0 || nuevos > 0) {
    // eslint-disable-next-line no-console
    console.log(`[PGP.211] ${T} tiene ${n} cargo(s) de contrato y ${nuevos} con subtipo nuevo: se conserva (regla 5).`);
    return;
  }
  await knex.raw(`DROP INDEX IF EXISTS finance.ux_fin_commitments_line_period`);
  for (const c of ['financial_commitments_contract_line_fk', 'financial_commitments_contract_fk', 'financial_commitments_contract_ck']) {
    await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS ${c}`);
  }
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS financial_commitments_subtype_check`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT financial_commitments_subtype_check CHECK (subtype IN (${lista(SUBTIPOS_ANTES)}))`);
  for (const col of ['amount_basis', 'period', 'contract_line_id', 'contract_id']) await knex.raw(`ALTER TABLE ${T} DROP COLUMN IF EXISTS ${col}`);
};
