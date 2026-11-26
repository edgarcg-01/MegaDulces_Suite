'use strict';
/**
 * `[PQ.3.17]` — El historial de cambios de las reglas del Calendario de compras (anexo C §10.9, DC25): quién cambió
 * cada regla, cuándo y DE QUÉ A QUÉ.
 *
 * Sin tabla nueva (ADR-056): las reglas se suman al log que ya existe, `analytics.master_data_history` (VP.3.1), con
 * el mismo disparador genérico `analytics.log_master_data_change(<columnas>)` que ya vigila 14 tablas (precios,
 * reorden, caja, libro de efectivo). Una fila por CAMBIO, con el diff en JSONB (`antes` / `despues`) y quién lo hizo
 * en `actor` (el repositorio declara `app.actor` = el usuario en cada escritura).
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-24) ────────────────────────────────────────
 *  · 16 reglas vivas de 2 personas; 2 se tocaron después de crearse (la misma persona) y 0 las cambió otra.
 *  · Hoy la regla sólo guarda el ÚLTIMO `updated_by`/`updated_at`: el patrón anterior se pierde al reemplazarlo, y
 *    «fuera de ciclo» mueve las mismas dos columnas que un cambio de patrón (no se distinguen).
 *  · `analytics.master_data_history` existe; `app_runtime` tiene INSERT, SELECT, la secuencia y el esquema; la
 *    función no es SECURITY DEFINER (escribe con los permisos de quien actualiza: alcanzan).
 *
 * ── Qué se vigila ──────────────────────────────────────────────────────────────────────────
 * El patrón completo (para reconstruirlo antes y después), el responsable, fuera de ciclo, la nota y la baja.
 * ⭐ También `updated_at`: así CADA escritura deja su fila, aun la que guarda lo mismo. Si la regla dice que se
 * cambió y no hay fila, ese cambio es anterior a esta migración — y la pantalla lo dice así, no lo inventa.
 * El alta (INSERT) no se registra aquí: la cuenta la regla misma (`created_by`, `created_at`).
 *
 * ⚠️ Sólo crea un disparador: la compuerta del despliegue no extrae objeto y la clasifica NO_MEDIDO, así que FRENA
 *    hasta que se aplique. Aplicarla ANTES de soltar. Sin ella, la API declara el historial no medido (no lo dibuja
 *    vacío).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'commercial.purchase_review_rules';

/** Las columnas vigiladas. `up()` verifica que existan: una columna mal escrita sería un hueco mudo del disparador. */
const VIGILADAS = [
  'pattern', 'weekdays', 'month_days', 'month_last_day', 'every_n_days', 'weekend_shift',
  'week_interval', 'week_anchor', 'month_week',
  'reviewer_user_id', 'out_of_cycle_until', 'out_of_cycle_reason', 'note', 'deleted_at', 'updated_at',
];

exports.up = async function up(knex) {
  // `CREATE TRIGGER` toma ACCESS EXCLUSIVE (milisegundos, sin reescribir filas): con lock_timeout falla rápido en vez
  // de encolar a todo escritor detrás de una transacción larga.
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: prim } = await knex.raw(`
    SELECT to_regclass('analytics.master_data_history') IS NOT NULL AS tabla,
           to_regprocedure('analytics.log_master_data_change()') IS NOT NULL AS funcion,
           to_regclass(?) IS NOT NULL AS reglas`, [TABLA]);
  if (!prim[0].tabla || !prim[0].funcion) {
    throw new Error('PQ.3.17: falta analytics.master_data_history o su función (VP.3.1, migración 20260907130000).');
  }
  if (!prim[0].reglas) throw new Error(`PQ.3.17: falta ${TABLA} (migración 20261120130156).`);
  const { rows: cols } = await knex.raw(`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'commercial' AND table_name = 'purchase_review_rules'`);
  const hay = new Set(cols.map((c) => c.column_name));
  const faltan = VIGILADAS.filter((c) => !hay.has(c));
  if (faltan.length) throw new Error(`PQ.3.17: ${TABLA} no tiene ${faltan.join(', ')} (¿falta la 20261124133043?).`);

  const args = VIGILADAS.map((c) => `'${c}'`).join(', ');
  await knex.raw(`DROP TRIGGER IF EXISTS trg_master_data_history ON ${TABLA}`);
  await knex.raw(`
    CREATE TRIGGER trg_master_data_history
      AFTER UPDATE OR DELETE ON ${TABLA}
      FOR EACH ROW EXECUTE FUNCTION analytics.log_master_data_change(${args})`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más: quita el disparador; la historia escrita se queda. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_master_data_history ON ${TABLA}`);
};
