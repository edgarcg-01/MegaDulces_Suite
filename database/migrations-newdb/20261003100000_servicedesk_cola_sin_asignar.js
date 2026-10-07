'use strict';
/**
 * `[MS.3.8]` — La cola de tickets SIN asignar llega a «Mi trabajo», con un plazo que se ajusta.
 *
 * ── El pedido ───────────────────────────────────────────────────────────────────────────────
 * «A tu nombre» (MS.3.6) muestra lo que ya te asignaron. Falta lo que NADIE ha tomado: quien reparte no
 * tiene en su portada un aviso de que hay tickets esperando. Esa cola es una BANDEJA, no una tarea (no
 * tiene `assigned_to`), y una bandeja necesita un veredicto: ¿cuánto es demasiado esperar? Es una política,
 * no una medición, y nadie la había fijado. Edgar/Sistemas, 2026-10-02: **1 hora, ajustable.**
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  1. `servicedesk.settings.unassigned_alert_minutes` (default 60, entre 5 y 1440): el plazo, por tenant,
 *     editable desde `/servicio/configuracion`. Está en la tabla de configuración de la mesa y no en una
 *     constante de `me-work.ts` justo para que cambiarlo no exija un despliegue.
 *  2. La clave `servicio.atender` en `identity.responsibilities`, SIN dimensión (la cola no tiene eje
 *     de sucursal: todo el que atiende ve la misma). El candado de `test-newdb-me-context.js` exige que
 *     toda clave del catálogo tenga una cola declarada, y la cola nace en este mismo cambio.
 *
 * ── ⛔ Qué NO hace, a propósito ─────────────────────────────────────────────────────────────
 * **No reparte la clave a ningún puesto ni persona.** Quién responde de repartir los tickets es dato
 * operativo y se administra desde `/admin/personas` (regla de Edgar, 2026-08-27), no por script.
 *
 * ⚠️ **Y mientras nadie la tenga, NADIE ve la bandeja.** La regla de la casa (`[SN.30]`, Edgar 2026-09-14) es
 * que *una cola se te muestra sólo si vos respondés de ella*: el permiso abre la pantalla, no pone la cola en
 * tu portada. Es lo correcto, pero significa que este cambio no tiene efecto visible hasta que alguien
 * reciba `servicio.atender` — es la decisión pendiente, y queda dicha acá y en el PR.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/** [key, label, descripcion, dimension, orden] */
const NUEVAS = [
  [
    'servicio.atender',
    'Solicitudes de servicio por asignar',
    'Tickets de la Mesa de Servicio que nadie ha tomado. Responde quien reparte el trabajo de la cola: ' +
      'la bandeja avisa cuando el más viejo lleva esperando más que el plazo de la configuración.',
    null,
    110,
  ],
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

  const tiene = await knex.schema.withSchema('servicedesk').hasColumn('settings', 'unassigned_alert_minutes');
  if (!tiene) {
    await knex.raw(
      `ALTER TABLE servicedesk.settings ADD COLUMN unassigned_alert_minutes integer NOT NULL DEFAULT 60`,
    );
  }
  const ck = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = 'settings_unassigned_alert_ck'
       AND conrelid = 'servicedesk.settings'::regclass`,
  );
  if (!ck.rows.length) {
    await knex.raw(
      `ALTER TABLE servicedesk.settings ADD CONSTRAINT settings_unassigned_alert_ck
         CHECK (unassigned_alert_minutes BETWEEN 5 AND 1440)`,
    );
  }
  await knex.raw(
    `COMMENT ON COLUMN servicedesk.settings.unassigned_alert_minutes IS 'MS.3.8 — minutos HÁBILES que el ticket más viejo sin asignar puede esperar antes de que Mi trabajo marque la cola como atrasada. Política (arranca en 60), no medición: se ajusta desde /servicio/configuracion.'`,
  );
  console.log(`  [MS.3.8] settings.unassigned_alert_minutes ${tiene ? 'ya existía' : 'agregada (default 60)'}`);

  for (const [key, label, desc, dim, orden] of NUEVAS) {
    await knex.raw(
      `INSERT INTO identity.responsibilities (key, label, descripcion, dimension, orden)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, descripcion = EXCLUDED.descripcion,
                                       dimension = EXCLUDED.dimension, orden = EXCLUDED.orden`,
      [key, label, desc, dim, orden],
    );
  }
  console.log(`  [MS.3.8] catálogo: +${NUEVAS.length} responsabilidad (servicio.atender) — sin repartir a nadie`);
};

exports.down = async function down(knex) {
  await knex('identity.position_responsibilities')
    .whereIn('responsibility_key', NUEVAS.map(([k]) => k))
    .del();
  await knex('identity.responsibilities')
    .whereIn('key', NUEVAS.map(([k]) => k))
    .del();
  await knex.raw(`ALTER TABLE servicedesk.settings DROP CONSTRAINT IF EXISTS settings_unassigned_alert_ck`);
  await knex.raw(`ALTER TABLE servicedesk.settings DROP COLUMN IF EXISTS unassigned_alert_minutes`);
};
