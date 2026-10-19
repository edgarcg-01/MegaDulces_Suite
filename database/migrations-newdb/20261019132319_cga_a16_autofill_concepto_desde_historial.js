'use strict';
/**
 * ⭐ `[CGA-A.16]` — **DECLARAR la cuenta de `CP036` (PIÑATAS ANITA), para que se pueda capturar.**
 *
 * ── Qué pasaba, medido en prod el 2026-10-19 ───────────────────────────────────────────────
 *
 * El pago `01|X-D-26|0000218` de **$14,421.00** no se podía capturar: la pantalla decía
 * *«Sin propuesta: captúralo a mano»* y *«Falta la cuenta y el concepto de Kepler: sin eso el
 * movimiento no se puede contabilizar»*.
 *
 * Y la propuesta **existía a medias**:
 *
 *     analytics.mv_caja_autofill_entidad, CP036
 *       kepler_cuenta    511        21 antecedentes · 100% · veredicto 'unanime'
 *       kepler_concepto  NULL   <-- por esto no propone
 *
 * ⛔ `porEntidad()` exige las DOS mitades (*"media cuenta no contabiliza"*), así que una cuenta
 * unánime con 21 antecedentes se publica como **nada**. No es un caso aislado: de las 285 filas
 * de la matvista, **285 tienen cuenta y sólo 44 tienen concepto** — 241 entidades con la mitad de
 * la respuesta. La causa es el *fallback* de la vista, que sólo da concepto cuando la cuenta tiene
 * **exactamente uno** en el catálogo, y `511` tiene varios.
 *
 * ── Por qué se DECLARA y no se toca la matvista ────────────────────────────────────────────
 *
 * `finance.caja_autofill_declarada` es el primer peldaño de `porEntidad()` y gana sobre lo
 * derivado, justo para esto: *"nosotros pongamos las reglas en nuestro sistema"*. Hoy tiene
 * **0 filas** — el mecanismo existe y nunca se usó.
 *
 * ⚠️ Esto **NO arregla las otras 240**: es una declaración para UNA entidad, no la corrección del
 * derivador. Queda como deuda con nombre (`[CGA-A.17]`): que el concepto se derive del historial
 * igual que la cuenta. Declararlo acá es lo que destraba hoy, no lo que cierra el problema.
 *
 * ── De dónde sale el par, y por qué no es una adivinanza ───────────────────────────────────
 *
 *   · `511` — lo dice la propia matvista: 21 antecedentes, unánime.
 *   · `059` — de los **28** movimientos ya capturados con cuenta `511` en `finance.cash_ledger`,
 *     **27 llevan concepto `059`** (COMPRAS A PROVEEDORES). El 28º es `511/511`, que tiene forma
 *     de error de dedo. Su hermano directo `CNFP001` (PIÑATAS TOÑO) se capturó así en
 *     `CG-2026-00029`.
 *
 * ⛔ **No se inserta a ciegas**: el `up` ABORTA si la matvista dejó de decir `511` para `CP036`,
 * o si el historial dejó de respaldar `059`. Una declaración que sobrevive a que su evidencia
 * cambie es exactamente cómo se fabrica un dato falso con aspecto de regla.
 *
 * Idempotente: `ON CONFLICT` sobre la llave de la tabla.
 *
 * @param { import("knex").Knex } knex
 */

const ENTIDAD = 'CP036';
const CUENTA = '511';
const CONCEPTO = '059';
const TENANT = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── Guarda 1: la matvista sigue diciendo 511 para CP036, y con veredicto que propone ──
  const { rows: [mv] } = await knex.raw(
    `SELECT kepler_cuenta, veredicto, support
       FROM analytics.mv_caja_autofill_entidad
      WHERE tenant_id = ?::uuid AND entidad_code = ?`, [TENANT, ENTIDAD]);
  if (!mv) throw new Error(`[A.16] ${ENTIDAD} no está en mv_caja_autofill_entidad. No se declara a ciegas.`);
  if (mv.kepler_cuenta !== CUENTA) {
    throw new Error(`[A.16] la matvista dice cuenta ${mv.kepler_cuenta} para ${ENTIDAD}, no ${CUENTA}. ABORTA.`);
  }
  if (mv.veredicto === 'disperso') {
    throw new Error(`[A.16] ${ENTIDAD} pasó a 'disperso' (${mv.support} antecedentes). Ya no es unánime: ABORTA.`);
  }

  // ── Guarda 2: el historial sigue respaldando 059 como el concepto de la cuenta 511 ──
  const { rows: [h] } = await knex.raw(
    `SELECT count(*) FILTER (WHERE kepler_concepto = ?)::int AS con,
            count(*)::int AS total
       FROM finance.cash_ledger
      WHERE deleted_at IS NULL AND estado <> 'cancelado' AND kepler_cuenta = ?`, [CONCEPTO, CUENTA]);
  if (!h || h.total < 3) {
    throw new Error(`[A.16] sólo ${h ? h.total : 0} capturas con cuenta ${CUENTA}: muy poco para declarar. ABORTA.`);
  }
  if (h.con / h.total < 0.8) {
    throw new Error(`[A.16] sólo ${h.con}/${h.total} usan concepto ${CONCEPTO}. Ya no es dominante: ABORTA.`);
  }

  // ⚠️ El par (cuenta, concepto) tiene que existir en el catálogo vivo, o Kepler lo rechaza
  // al contabilizar y la captura falla igual que hoy, pero más tarde y con el dinero adentro.
  const { rows: [cat] } = await knex.raw(
    `SELECT count(*)::int AS n FROM analytics.v_kepler_conceptos
      WHERE cuenta = ? AND concepto = ?`, [CUENTA, CONCEPTO]);
  if (!cat || cat.n === 0) {
    throw new Error(`[A.16] el par ${CUENTA}/${CONCEPTO} no existe en v_kepler_conceptos. ABORTA.`);
  }

  await knex.raw(
    `INSERT INTO finance.caja_autofill_declarada
       (tenant_id, entidad_code, kepler_cuenta, kepler_concepto, motivo, declarada_por_username)
     VALUES (?::uuid, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, entidad_code) DO UPDATE
        SET kepler_cuenta = EXCLUDED.kepler_cuenta,
            kepler_concepto = EXCLUDED.kepler_concepto,
            motivo = EXCLUDED.motivo,
            updated_at = now()`,
    [TENANT, ENTIDAD, CUENTA, CONCEPTO,
      '[CGA-A.16] La matvista daba cuenta 511 unanime (21 antecedentes) y concepto NULL, '
      + 'asi que no proponia nada y el pago X-D-26 0000218 de $14,421.00 no se podia capturar. '
      + 'El concepto 059 sale de que 27 de 28 capturas con cuenta 511 lo usan.',
      'migracion']);

  console.log(`[A.16] ${ENTIDAD} declarada: ${CUENTA}/${CONCEPTO} `
    + `(matvista: ${mv.veredicto}, ${mv.support} antecedentes · historial: ${h.con}/${h.total})`);
};

/** Quita SÓLO lo que puso el `up`, y sólo si sigue siendo suyo. */
exports.down = async function down(knex) {
  await knex.raw(
    `DELETE FROM finance.caja_autofill_declarada
      WHERE tenant_id = ?::uuid AND entidad_code = ? AND declarada_por_username = 'migracion'`,
    [TENANT, ENTIDAD]);
};
