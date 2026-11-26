'use strict';
/**
 * `[GP.R.3]` — **Las dos cosas que le faltan al registro del Ajuste Abono, medidas contra prod.**
 *
 * ⛔ **Por qué esto es una migración aparte y no un arreglo de la anterior:** `20261125100145` **ya está aplicada en
 * prod** (batch 1251, 2026-11-25 18:09:26 UTC) — la aplicó otra sesión desde el árbol compartido, **42 minutos antes
 * de que el archivo llegara a `origin/main`**. Una migración aplicada no se toca (Knex compara el ledger con el
 * filesystem), así que lo que le falta entra por su propio renglón.
 *
 * Lo que falta, medido en prod el 2026-11-25 (`information_schema.columns` + `pg_constraint`):
 *
 *  1. **`cfdi_insoluto`** — lo que las facturas del ajuste **siguen debiendo ante el SAT**. La tabla se creó sin ella
 *     porque se aplicó la versión previa del archivo. Y el servicio la escribe: sin esta columna, cerrar el registro
 *     revienta con «column does not exist». `NULL` = **NO MEDIDO**, que no es cero: un Ajuste Abono **no emite CFDI**,
 *     así que cerrar el resto en Kepler **no lo cierra ante el SAT** (220 de los 260 restos vivos son facturas PPD;
 *     1,782 facturas de 2026 ya quedaron así, $729.78). Ver `VERDAD_ABSOLUTA.md` §41.12 y D-F10.
 *  2. ⛔ **`'ya_estaba'` en el CHECK de `estado`** — el defecto más caro de los dos, y lo encontró medir prod, no una
 *     prueba: el `CHECK` nació con `('pendiente','escrito','apagado','rechazado')`, pero el servicio devuelve
 *     **`ya_estaba`** cuando Kepler ya tenía el ajuste con esa referencia (la idempotencia). O sea que **el camino
 *     idempotente habría violado el CHECK al cerrar la fila**, justo en el reintento, que es cuando más importa.
 *     *La prueba del registro ejercía el CHECK con un estado inventado y nunca con éste; ya tiene su control.*
 *
 * Y el `cca_folio_ck` se rehace en consecuencia: un ajuste `ya_estaba` **también** trae folio de Kepler (es el folio
 * que Kepler ya tenía), así que la regla pasa a ser «hay folio ⟺ está escrito **o** ya estaba».
 *
 * Idempotente: `hasColumn` antes de `addColumn`, y las restricciones se leen antes de rehacerlas.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[gpr3_insoluto_sat_y_ya_estaba]';
const TABLA = 'finance.customer_credit_adjustments';
const ESTADOS = ['pendiente', 'escrito', 'ya_estaba', 'apagado', 'rechazado'];
const CON_FOLIO = ['escrito', 'ya_estaba'];

const lista = (xs) => xs.map((x) => `'${x.replace(/[^a-z_]/g, '')}'`).join(', ');

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [t] } = await knex.raw(`SELECT to_regclass(?) IS NOT NULL AS hay`, [TABLA]);
  if (!t.hay) { console.log(`  ${TAG} ⚠️ NO MEDIDO: ${TABLA} no existe (falta 20261125100145): no hay nada que extender.`); return; }

  // ── 1. El insoluto ante el SAT ───────────────────────────────────────────────────────────────
  const hayCol = await knex.schema.withSchema('finance').hasColumn('customer_credit_adjustments', 'cfdi_insoluto');
  if (!hayCol) {
    await knex.raw(`ALTER TABLE ${TABLA} ADD COLUMN cfdi_insoluto numeric(14,2)`);
    await knex.raw(`ALTER TABLE ${TABLA} ADD CONSTRAINT cca_insoluto_ck CHECK (cfdi_insoluto IS NULL OR cfdi_insoluto >= 0)`);
    await knex.raw(`COMMENT ON COLUMN ${TABLA}.cfdi_insoluto IS
      'Lo que las facturas de este ajuste SIGUEN debiendo ante el SAT (ImpSaldoInsoluto de su último complemento). NULL = NO MEDIDO, que no es cero: el Ajuste Abono no emite CFDI. D-F10.'`);
  }

  // ── 2. «ya_estaba», el estado del reintento idempotente ──────────────────────────────────────
  const { rows: ck } = await knex.raw(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = ?::regclass AND conname IN ('customer_credit_adjustments_estado_check', 'cca_folio_ck')`, [TABLA]);
  const defEstado = ck.find((r) => r.conname === 'customer_credit_adjustments_estado_check')?.def ?? '';
  if (!defEstado.includes(`'ya_estaba'`)) {
    // El CHECK se rehace entero a propósito: los cinco estados son el contrato con EstadoAjusteAbono.
    await knex.raw(`ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS customer_credit_adjustments_estado_check`);
    await knex.raw(`ALTER TABLE ${TABLA} ADD CONSTRAINT customer_credit_adjustments_estado_check CHECK (estado IN (${lista(ESTADOS)}))`);
  }
  const defFolio = ck.find((r) => r.conname === 'cca_folio_ck')?.def ?? '';
  if (!defFolio.includes(`'ya_estaba'`)) {
    await knex.raw(`ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS cca_folio_ck`);
    await knex.raw(`ALTER TABLE ${TABLA} ADD CONSTRAINT cca_folio_ck CHECK ((kepler_folio IS NOT NULL) = (estado IN (${lista(CON_FOLIO)})))`);
  }

  // ── Lo que quedó, dicho ──────────────────────────────────────────────────────────────────────
  const { rows: [fin] } = await knex.raw(
    `SELECT (SELECT count(*)::int FROM information_schema.columns
              WHERE table_schema = 'finance' AND table_name = 'customer_credit_adjustments' AND column_name = 'cfdi_insoluto') AS col,
            (SELECT pg_get_constraintdef(oid) FROM pg_constraint
              WHERE conrelid = ?::regclass AND conname = 'customer_credit_adjustments_estado_check') AS estado,
            (SELECT count(*)::int FROM ${TABLA}) AS filas`, [TABLA]);
  if (fin.col !== 1) throw new Error(`${TAG} cfdi_insoluto no quedó`);
  if (!String(fin.estado ?? '').includes(`'ya_estaba'`)) throw new Error(`${TAG} el CHECK de estado no admite 'ya_estaba': el reintento idempotente seguiría reventando`);
  console.log(`  ${TAG} cfdi_insoluto ✓ · estado admite los ${ESTADOS.length} ('ya_estaba' incluido) ✓ · ${fin.filas} ajuste(s) en el registro`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [t] } = await knex.raw(`SELECT to_regclass(?) IS NOT NULL AS hay`, [TABLA]);
  if (!t.hay) return;
  await knex.raw(`ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS cca_insoluto_ck`);
  const hayCol = await knex.schema.withSchema('finance').hasColumn('customer_credit_adjustments', 'cfdi_insoluto');
  if (hayCol) await knex.raw(`ALTER TABLE ${TABLA} DROP COLUMN cfdi_insoluto`);
  // ⚠️ Volver atrás el CHECK dejaría filas 'ya_estaba' fuera de la regla: sólo se estrecha si no hay ninguna.
  const { rows: [n] } = await knex.raw(`SELECT count(*)::int n FROM ${TABLA} WHERE estado = 'ya_estaba'`);
  if (n.n > 0) { console.log(`  ${TAG} hay ${n.n} ajuste(s) 'ya_estaba': el CHECK se conserva`); return; }
  await knex.raw(`ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS customer_credit_adjustments_estado_check`);
  await knex.raw(`ALTER TABLE ${TABLA} ADD CONSTRAINT customer_credit_adjustments_estado_check CHECK (estado IN ('pendiente', 'escrito', 'apagado', 'rechazado'))`);
  await knex.raw(`ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS cca_folio_ck`);
  await knex.raw(`ALTER TABLE ${TABLA} ADD CONSTRAINT cca_folio_ck CHECK ((kepler_folio IS NOT NULL) = (estado = 'escrito'))`);
};
