'use strict';
/**
 * `[CGS.18][CGS.17]` — Un corte cerrado se puede OBSERVAR (devolver con motivo) y RESPONDER, y la
 * autorización guarda su nota.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_CGS_SUPERVISION_DE_CAJA.md` §2.4.
 *
 * ── Lo medido antes (prod, `dev_ro`, 2026-10-21) ────────────────────────────────────────────
 *  · 7 cortes cerrados, 0 autorizados. **4 de 7** con esperado negativo (`esperado_imposible`):
 *    firmarlos sería dar por bueno un número que no significa nada, y hasta hoy autorizar era la
 *    ÚNICA acción de la supervisora. No había forma de decir «lo revisé y está mal».
 *  · Los 7 tienen diferencias de cinco o seis cifras y ninguno trae explicación.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  · Estado nuevo **`observado`**: la supervisora lo revisó y encontró algo. Queda estacionado con
 *    su observación hasta que la cajera responda; al responder vuelve a `cerrado` (por revisar).
 *  · Columnas: quién observó, cuándo y qué; quién respondió, cuándo y qué; y la **nota de la
 *    autorización** (`authorization_note`), que el servicio exige cuando hay diferencia.
 *  · ⛔ Observar **no mueve ninguna cifra**: la guardia `cash_cut_guardia` ya congela todo corte
 *    que no es borrador, y las columnas nuevas no están en su lista. Las rondas anteriores de
 *    observación/respuesta quedan en `analytics.master_data_history` (CGS.10).
 *  · Quien observa no es quien cerró (`cut_observa_ajeno_chk`), igual que la doble llave.
 *
 * El `up` se prueba a sí mismo contra un corte real en SAVEPOINTs deshechos.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const COLUMNAS = [
  ['observed_by', (t) => t.uuid('observed_by').nullable()],
  ['observed_by_username', (t) => t.text('observed_by_username').nullable()],
  ['observed_at', (t) => t.timestamp('observed_at', { useTz: true }).nullable()],
  ['observacion', (t) => t.text('observacion').nullable()],
  ['responded_by', (t) => t.uuid('responded_by').nullable()],
  ['responded_by_username', (t) => t.text('responded_by_username').nullable()],
  ['responded_at', (t) => t.timestamp('responded_at', { useTz: true }).nullable()],
  ['respuesta', (t) => t.text('respuesta').nullable()],
  ['authorization_note', (t) => t.text('authorization_note').nullable()],
];

async function hayConstraint(knex, nombre) {
  const { rows } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = 'finance.cash_ledger_cuts'::regclass`, [nombre]);
  return rows.length > 0;
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  for (const [col, def] of COLUMNAS) {
    if (!(await knex.schema.withSchema('finance').hasColumn('cash_ledger_cuts', col))) {
      await knex.schema.withSchema('finance').alterTable('cash_ledger_cuts', def);
    }
  }

  // El estado admite `observado`. Se reemplaza el CHECK con el mismo nombre.
  await knex.raw(`ALTER TABLE finance.cash_ledger_cuts DROP CONSTRAINT IF EXISTS cut_estado_chk`);
  await knex.raw(`
    ALTER TABLE finance.cash_ledger_cuts ADD CONSTRAINT cut_estado_chk
      CHECK (estado = ANY (ARRAY['borrador'::text, 'cerrado'::text, 'observado'::text, 'autorizado'::text]))`);

  if (!(await hayConstraint(knex, 'cut_observado_completo_chk'))) {
    await knex.raw(`
      ALTER TABLE finance.cash_ledger_cuts ADD CONSTRAINT cut_observado_completo_chk CHECK (
        estado <> 'observado'
        OR (observed_by IS NOT NULL AND observed_at IS NOT NULL
            AND length(btrim(coalesce(observacion, ''))) >= 10))`);
  }
  if (!(await hayConstraint(knex, 'cut_observa_ajeno_chk'))) {
    await knex.raw(`
      ALTER TABLE finance.cash_ledger_cuts ADD CONSTRAINT cut_observa_ajeno_chk CHECK (
        observed_by IS NULL OR closed_by IS NULL OR observed_by <> closed_by)`);
  }
  if (!(await hayConstraint(knex, 'cut_respuesta_completa_chk'))) {
    await knex.raw(`
      ALTER TABLE finance.cash_ledger_cuts ADD CONSTRAINT cut_respuesta_completa_chk CHECK (
        responded_at IS NULL
        OR (responded_by IS NOT NULL AND length(btrim(coalesce(respuesta, ''))) >= 10))`);
  }

  // El historial del corte (CGS.10) también guarda cada ronda: sin esto, la segunda observación
  // pisaría a la primera sin rastro. Se recrea el mismo trigger con la lista ampliada.
  const VIGILADAS = [
    'estado', 'fecha', 'sucursal', 'fondo_inicial', 'fondo_origen', 'total_ingresos',
    'total_gastos', 'total_depositos', 'esperado', 'contado', 'morralla', 'diferencia', 'nota',
    'closed_by', 'closed_at', 'authorized_by', 'authorized_at', 'conteo_previo',
    'reconteo_motivo', 'corrected_by', 'corrected_at',
    ...COLUMNAS.map(([c]) => c),
  ];
  const { rows: fn } = await knex.raw(`SELECT to_regprocedure('analytics.log_master_data_change()') AS f`);
  if (!fn[0].f) throw new Error('[CGS.18] falta analytics.log_master_data_change (VP.3.1): aplicar antes 20261021110252.');
  await knex.raw(`DROP TRIGGER IF EXISTS trg_master_data_history ON finance.cash_ledger_cuts`);
  await knex.raw(`
    CREATE TRIGGER trg_master_data_history
      AFTER UPDATE OR DELETE ON finance.cash_ledger_cuts
      FOR EACH ROW EXECUTE FUNCTION analytics.log_master_data_change(${VIGILADAS.map((c) => `'${c}'`).join(', ')})`);

  await knex.raw(`COMMENT ON COLUMN finance.cash_ledger_cuts.observacion IS
    '[CGS.18] Lo que la supervisora encontro al revisar el corte. Las rondas anteriores quedan en analytics.master_data_history.'`);
  await knex.raw(`COMMENT ON COLUMN finance.cash_ledger_cuts.authorization_note IS
    '[CGS.17] La nota con la que se autorizo. El servicio la exige cuando la diferencia no es cero.'`);

  await probar(knex);
};

async function probar(knex) {
  const { rows } = await knex.raw(
    `SELECT c.id, c.folio, c.closed_by,
            (SELECT u.id FROM identity.users u
              WHERE u.tenant_id = c.tenant_id AND u.id <> c.closed_by LIMIT 1) AS otra
       FROM finance.cash_ledger_cuts c
      WHERE c.estado = 'cerrado' ORDER BY c.fecha DESC LIMIT 1`);
  if (!rows.length || !rows[0].otra) {
    console.log('  ⚠️ [CGS.18] NO MEDIDO: no hay un corte cerrado contra el cual probar el estado observado.');
    return;
  }
  const c = rows[0];
  const MOT = 'Prueba del candado [CGS.18], revertida';
  const OBS = (u, mot) => `UPDATE finance.cash_ledger_cuts SET estado = 'observado', observed_by = '${u}',
    observed_by_username = 'prueba_cgs18', observed_at = now(), observacion = '${mot}' WHERE id = '${c.id}'`;
  const casos = [
    ['observar con motivo', 'PASA', [OBS(c.otra, MOT)]],
    ['observar con motivo de menos de 10', 'FALLA', [OBS(c.otra, 'mal')]],
    ['observar quien cerró', 'FALLA', [OBS(c.closed_by, MOT)]],
    ['observado y cambiar el esperado', 'FALLA',
      [OBS(c.otra, MOT), `UPDATE finance.cash_ledger_cuts SET esperado = coalesce(esperado, 0) + 1 WHERE id = '${c.id}'`]],
    ['observado y reabrirlo a borrador', 'FALLA',
      [OBS(c.otra, MOT), `UPDATE finance.cash_ledger_cuts SET estado = 'borrador' WHERE id = '${c.id}'`]],
    ['responder y volver a cerrado', 'PASA',
      [OBS(c.otra, MOT), `UPDATE finance.cash_ledger_cuts SET estado = 'cerrado', responded_by = closed_by,
        responded_at = now(), respuesta = '${MOT}' WHERE id = '${c.id}'`]],
    ['responder sin texto', 'FALLA',
      [OBS(c.otra, MOT), `UPDATE finance.cash_ledger_cuts SET estado = 'cerrado', responded_by = closed_by,
        responded_at = now(), respuesta = '' WHERE id = '${c.id}'`]],
  ];
  const fallos = [];
  for (const [nombre, espera, sqls] of casos) {
    await knex.raw('SAVEPOINT cgs18_prueba');
    let real;
    try { for (const s of sqls) await knex.raw(s); real = 'PASA'; } catch { real = 'FALLA'; }
    await knex.raw('ROLLBACK TO SAVEPOINT cgs18_prueba');
    await knex.raw('RELEASE SAVEPOINT cgs18_prueba');
    if (real !== espera) fallos.push(`«${nombre}»: se esperaba ${espera} y dio ${real}`);
  }
  if (fallos.length) {
    throw new Error(`[CGS.18] el estado observado no se comporta como debe sobre ${c.folio}:\n    - ${fallos.join('\n    - ')}`);
  }
  console.log(`  ✔ [CGS.18] ${casos.length} casos probados sobre ${c.folio}, todos revertidos.`);
}

/**
 * Deshace las reglas y el estado. ⛔ Las COLUMNAS se quedan a propósito (regla del proyecto: no se
 * borran columnas sin confirmación): pueden traer observaciones reales. Falla si hay cortes
 * observados, para no dejarlos con un estado inválido.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM finance.cash_ledger_cuts WHERE estado = 'observado'`);
  if (rows[0].n > 0) {
    throw new Error(`[CGS.18] hay ${rows[0].n} corte(s) observados: bajar la migración los dejaría con un estado inválido.`);
  }
  for (const n of ['cut_respuesta_completa_chk', 'cut_observa_ajeno_chk', 'cut_observado_completo_chk']) {
    await knex.raw(`ALTER TABLE finance.cash_ledger_cuts DROP CONSTRAINT IF EXISTS ${n}`);
  }
  await knex.raw(`ALTER TABLE finance.cash_ledger_cuts DROP CONSTRAINT IF EXISTS cut_estado_chk`);
  await knex.raw(`
    ALTER TABLE finance.cash_ledger_cuts ADD CONSTRAINT cut_estado_chk
      CHECK (estado = ANY (ARRAY['borrador'::text, 'cerrado'::text, 'autorizado'::text]))`);
};
