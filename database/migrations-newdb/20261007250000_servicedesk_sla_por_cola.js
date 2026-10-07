'use strict';
/**
 * `[MS.7.2]` — SLA por cola. `FASE_MS7_MANTENIMIENTO.md` (decisión M5).
 *
 * Hasta aquí los plazos eran **por prioridad y globales del tenant** (`UNIQUE (tenant_id, priority)`): una sola tabla de 4
 * filas para toda la empresa. Con varias áreas eso no alcanza: el reloj de TI (la urgente corre corrida) no es el de
 * Mantenimiento (Sistemas decidió **horario hábil**).
 *
 * ── Cómo queda ───────────────────────────────────────────────────────────────────────────────
 * `sla_policies.queue_id` (NULL = la política GENERAL del tenant, la de siempre). La política efectiva de un ticket es la de
 * SU cola para esa prioridad si existe, y si no, la general: una cola puede cambiar sólo algunas prioridades y heredar el
 * resto, y una cola nueva nace heredando todo sin sembrar nada. La unicidad pasa a `(tenant, cola, prioridad)` con NULL
 * tratado como «la general» (índice único de EXPRESIÓN: un UNIQUE normal dejaría repetir `(tenant, NULL, prioridad)`).
 *
 * ⛔ Nada cambia para TI: sus 4 filas conservan `queue_id = NULL` y siguen siendo la política general.
 *
 * ── Los plazos de Mantenimiento (decisión de Sistemas del 2026-10-06: horario hábil) ──────────
 * Se siembran SÓLO si la cola de Mantenimiento existe (`20261007240000`), como **propuesta sin calibrar** (primero miden):
 *   Urgente 60 / 240 · Alta 240 / 480 · Media 480 / 1,440 · Baja 1,440 / 4,800   (minutos HÁBILES: primera respuesta / resolución)
 * con «1 día» = 8 h hábiles = 480 min. ⚠️ Dos lecturas a confirmar con Frank, ambas editables desde la pantalla:
 *  (a) el «24 h» de Alta del plan se tomó como **1 día hábil** (480); leído como 24 horas hábiles serían 1,440 y empataría con Media;
 *  (b) con reloj hábil una **Urgente fuera de horario (noche, domingo) no corre hasta la mañana**; en TI la urgente corre corrida.
 *
 * Aditiva, idempotente y reversible (el `down` retira las filas por cola y restaura la unicidad original).
 *
 * @param { import("knex").Knex } knex
 */

const SIN_COLA = '00000000-0000-0000-0000-000000000000';

/** `[prioridad, 1ª respuesta (min), resolución (min)]` — todo en horario hábil. */
const MANTENIMIENTO = [
  ['urgente', 60, 240],
  ['alta', 240, 480],
  ['media', 480, 1440],
  ['baja', 1440, 4800],
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

  const tiene = await knex.schema.withSchema('servicedesk').hasColumn('sla_policies', 'queue_id');
  if (!tiene) {
    await knex.raw(`ALTER TABLE servicedesk.sla_policies ADD COLUMN queue_id uuid`);
    await knex.raw(`
      ALTER TABLE servicedesk.sla_policies ADD CONSTRAINT sla_policies_queue_fk
        FOREIGN KEY (tenant_id, queue_id) REFERENCES servicedesk.queues (tenant_id, id) ON DELETE RESTRICT`);
  }
  await knex.raw(`ALTER TABLE servicedesk.sla_policies DROP CONSTRAINT IF EXISTS sla_policies_priority_uk`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_sd_sla_cola_prioridad
      ON servicedesk.sla_policies (tenant_id, (COALESCE(queue_id, '${SIN_COLA}'::uuid)), priority)`);
  await knex.raw(
    `COMMENT ON COLUMN servicedesk.sla_policies.queue_id IS 'MS.7.2 — NULL = la política GENERAL del tenant; con valor, la de esa cola para esa prioridad. La efectiva es la de la cola y, si no hay, la general.'`,
  );

  // Los plazos propios de Mantenimiento (sólo si la cola está sembrada).
  let sembradas = 0;
  const colas = await knex('servicedesk.queues').where({ code: 'mantenimiento' }).whereNull('deleted_at').select('id', 'tenant_id');
  for (const q of colas) {
    for (const [prioridad, primera, resolucion] of MANTENIMIENTO) {
      const r = await knex.raw(
        `INSERT INTO servicedesk.sla_policies (tenant_id, queue_id, priority, first_response_minutes, resolution_minutes, clock)
         VALUES (?, ?, ?, ?, ?, 'business')
         ON CONFLICT (tenant_id, (COALESCE(queue_id, '${SIN_COLA}'::uuid)), priority) DO NOTHING`,
        [q.tenant_id, q.id, prioridad, primera, resolucion],
      );
      sembradas += r.rowCount ?? 0;
    }
  }
  // eslint-disable-next-line no-console
  console.log(`  [MS.7.2] sla_policies.queue_id ${tiene ? 'ya existía' : 'agregada'} · plazos propios de Mantenimiento (hábil): ${sembradas} fila(s) nueva(s)`);
};

exports.down = async function down(knex) {
  // Las filas por cola se retiran: la tabla vuelve a ser sólo la general (única por prioridad).
  await knex('servicedesk.sla_policies').whereNotNull('queue_id').del();
  await knex.raw('DROP INDEX IF EXISTS servicedesk.ux_sd_sla_cola_prioridad');
  await knex.raw(`ALTER TABLE servicedesk.sla_policies DROP CONSTRAINT IF EXISTS sla_policies_queue_fk`);
  await knex.raw(`ALTER TABLE servicedesk.sla_policies DROP COLUMN IF EXISTS queue_id`);
  await knex.raw(`ALTER TABLE servicedesk.sla_policies ADD CONSTRAINT sla_policies_priority_uk UNIQUE (tenant_id, priority)`);
};
