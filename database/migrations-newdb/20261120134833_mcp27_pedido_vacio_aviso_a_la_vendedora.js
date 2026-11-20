'use strict';
/**
 * `[MCP.27]` — Un pedido de preventa en el que no hubo nada: el surtidor avisa a la vendedora y el pedido sale de
 * su cola como «por cancelar» (Edgar, 2026-11-20: «botón de aviso»).
 *
 * La regla de MCP no cambia: un pedido NO se cierra en cero (`presale-picking.engine`, `CierreInvalido`), lo
 * cancela la vendedora. Lo que faltaba era la salida del surtidor: Surtir sólo le repetía el rechazo.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-20) ────────────────────────────────────────
 *  · `surtir_cierre_rechazado` con «No hubo nada de este pedido…»: 8 hoy (11:09–13:19), 7 de una sola persona
 *    en 3 minutos — tocó «Terminé de surtir» una y otra vez.
 *
 * Se extiende la tabla del surtido (regla 2: no otra tabla): quién avisó, cuándo y con su nombre al momento.
 * Los tres juntos o ninguno, y después de empezar. «Sólo en un pedido abierto» lo exige el servicio, NO la base: si
 * aquí se exigiera `finished_at` NULL, un pedido avisado que después sí se pudo surtir reventaría `finish` (regla 14).
 * ⚠️ Con coalesce(…, false): un NULL haría pasar el CHECK.
 *
 * Columnas nuevas NULLABLE: los caminos que insertan en `presale_picks` (start, ruta) no cambian. Compatible
 * con la API desplegada (no las conoce). Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const T = 'commercial.presale_picks';
const CK = 'presale_picks_aviso_vacio_ck';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const cols = [
    ['empty_reported_at', (t) => t.timestamp('empty_reported_at', { useTz: true })],
    ['empty_reported_by', (t) => t.uuid('empty_reported_by')],
    ['empty_reported_by_name', (t) => t.string('empty_reported_by_name', 160)],
  ];
  for (const [col, def] of cols) {
    if (!(await knex.schema.withSchema('commercial').hasColumn('presale_picks', col))) {
      await knex.schema.withSchema('commercial').alterTable('presale_picks', def);
    }
  }
  const { rows } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conrelid = ?::regclass AND conname = ?`, [T, CK]);
  if (!rows.length) {
    await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT ${CK} CHECK (coalesce(
      CASE WHEN empty_reported_at IS NULL THEN empty_reported_by IS NULL AND empty_reported_by_name IS NULL
           ELSE empty_reported_by IS NOT NULL AND empty_reported_by_name IS NOT NULL AND empty_reported_at >= started_at
      END, false))`);
  }
  await knex.raw(`COMMENT ON COLUMN ${T}.empty_reported_at IS
    '[MCP.27] El surtidor avisó a la vendedora que no hubo nada: el pedido queda por cancelar (no se cierra en cero).'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. */
exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS ${CK}`);
  for (const col of ['empty_reported_by_name', 'empty_reported_by', 'empty_reported_at']) {
    if (await knex.schema.withSchema('commercial').hasColumn('presale_picks', col)) {
      await knex.schema.withSchema('commercial').alterTable('presale_picks', (t) => t.dropColumn(col));
    }
  }
};
