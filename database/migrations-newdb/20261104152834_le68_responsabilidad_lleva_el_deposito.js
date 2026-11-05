'use strict';
/**
 * `[LE.6.8]` — **Quién lleva el depósito de la reposición** (D35, FASE_LE §5.5).
 *
 * La reposición sale de la Ventanilla en custodia de una persona con nombre, hasta que el banco
 * confirma el depósito. Quién puede ser esa persona es un catálogo con firma: la responsabilidad
 * `finanzas.caja_deposito`, dada a la PERSONA (`identity.user_responsibilities`, el mismo patrón que
 * `compras.requisiciones_sucursal`, AB.29). Darla o quitarla queda en la bitácora de responsabilidades.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────
 *  · Agrega la responsabilidad al catálogo. NO la reparte: a quién se le da lo decide el PM (D35) y
 *    se da desde Administración › Responsabilidades. Mientras nadie la tenga, la Ventanilla no deja
 *    pedir una reposición (lo dice en pantalla).
 *
 * Expand: sólo agrega una fila de catálogo; el código desplegado no la usa todavía.
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const RESPONSABILIDAD = {
  key: 'finanzas.caja_deposito',
  label: 'Caja General: lleva el depósito de la reposición',
  descripcion: 'Recibe en la Ventanilla el dinero de una reposición y lo deposita en la cuenta de la zona. Queda en su custodia hasta que el banco confirma el depósito (D35).',
  orden: 64,
};

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  // La responsabilidad se da a la PERSONA: sin la tabla de responsabilidades por persona no sirve de nada.
  await knex.raw('SELECT 1 FROM identity.user_responsibilities LIMIT 0');
  await knex.raw(`INSERT INTO identity.responsibilities (key, label, descripcion, orden, created_at)
    SELECT v.key, v.label, v.descripcion, v.orden, now()
      FROM (VALUES (?::varchar, ?::varchar, ?::text, ?::int)) v (key, label, descripcion, orden)
     WHERE NOT EXISTS (SELECT 1 FROM identity.responsibilities r WHERE r.key = v.key)`,
  [RESPONSABILIDAD.key, RESPONSABILIDAD.label, RESPONSABILIDAD.descripcion, RESPONSABILIDAD.orden]);
};

exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  // Sólo si nadie la tiene: quitar el catálogo con personas asignadas borraría su historia (CASCADE).
  await knex.raw(`DELETE FROM identity.responsibilities r WHERE r.key = ?
    AND NOT EXISTS (SELECT 1 FROM identity.user_responsibilities u WHERE u.responsibility_key = r.key)
    AND NOT EXISTS (SELECT 1 FROM identity.position_responsibilities p WHERE p.responsibility_key = r.key)`, [RESPONSABILIDAD.key]);
};
