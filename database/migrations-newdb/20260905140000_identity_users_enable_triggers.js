'use strict';
/**
 * `[IDG.6]` — `identity.users` vuelve a tener integridad referencial.
 *
 * En prod, `identity.users` tenía **144 de sus 195 triggers deshabilitados**
 * (`tgenabled='D'`), y era la ÚNICA tabla de toda la base en ese estado. Se
 * descubrió rastreando el usuario `hacker`: un test afirmaba que la FK compuesta
 * de rol rechaza un `role_name` de otro tenant, el INSERT pasó igual, y la fila
 * quedó en el padrón real cinco días.
 *
 * Qué estaba muerto:
 *   - `fk_users_created_by`, `_updated_by`, `_deleted_by`, `fk_users_supervisor`
 *     con sus 4 triggers cada una (son auto-referencias: los dos lados viven en
 *     `identity.users`).
 *   - El lado HIJO de `fk_users_tenant_role` y `users_tenant_id_foreign`, o sea
 *     el chequeo en INSERT/UPDATE. El lado padre (`ON DELETE RESTRICT`) seguía
 *     vivo, por eso sí se podía confiar en que un rol en uso no se borra.
 *   - Los triggers de ACCIÓN de buena parte de las ~96 FK que apuntan a
 *     `identity.users` (los `created_by`/`updated_by` de medio schema): borrar un
 *     usuario dejaba referencias colgadas en vez de aplicar `SET NULL`.
 *
 * ⚠️ **`pg_constraint.convalidated` decía `true` todo el tiempo.** La constraint
 * existía y se creía validada; lo que no disparaba eran sus triggers internos.
 * Cualquier chequeo de metadata daba verde. La verificación de verdad es
 * `pg_trigger.tgenabled` y un INSERT inválido.
 *
 * Origen probable: `database/scripts/local-import-from-railway.sql:25` es el
 * único lugar del repo que hace `ALTER TABLE identity.users DISABLE TRIGGER ALL`.
 * El script está balanceado (14 disable / 14 enable) y es transaccional, así que
 * una corrida completa lo dejaría sano — el estado apunta a una corrida PARCIAL
 * ejecutada contra prod, a pesar de que el nombre dice `local-`. Medido: en la
 * base local los 195 triggers están encendidos y no hay violaciones.
 *
 * ── El orden importa ─────────────────────────────────────────────────────────
 * `ENABLE TRIGGER` **no valida lo ya escrito**. Si queda una fila que viola una
 * FK, la constraint queda con una violación latente que revienta en el próximo
 * UPDATE de esa fila. Por eso esta migración ABORTA si encuentra violaciones, y
 * por eso corre DESPUÉS de `cleanup-test-identity-residue.js`, que saca la
 * única que había (`hacker`, con el rol inexistente `admin_b`).
 *
 * Idempotente: si ya está todo encendido, no hace nada. Reversible sólo en
 * teoría — el `down` volvería a apagar la integridad, así que se deja explícito
 * que no se debe usar salvo para reproducir el incidente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'identity.users';

/** Las 5 columnas cuya FK hay que probar antes de encender. */
const CHEQUEOS = [
  ['role_name', `SELECT count(*)::int n FROM identity.users u
                  WHERE NOT EXISTS (SELECT 1 FROM identity.role_permissions rp
                                     WHERE rp.tenant_id = u.tenant_id AND rp.role_name = u.role_name)`],
  ['created_by', `SELECT count(*)::int n FROM identity.users u WHERE u.created_by IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM identity.users x WHERE x.id = u.created_by)`],
  ['updated_by', `SELECT count(*)::int n FROM identity.users u WHERE u.updated_by IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM identity.users x WHERE x.id = u.updated_by)`],
  ['deleted_by', `SELECT count(*)::int n FROM identity.users u WHERE u.deleted_by IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM identity.users x WHERE x.id = u.deleted_by)`],
  ['supervisor_id', `SELECT count(*)::int n FROM identity.users u WHERE u.supervisor_id IS NOT NULL
                      AND NOT EXISTS (SELECT 1 FROM identity.users x WHERE x.id = u.supervisor_id)`],
  ['tenant_id', `SELECT count(*)::int n FROM identity.users u
                  WHERE NOT EXISTS (SELECT 1 FROM identity.tenants t WHERE t.id = u.tenant_id)`],
];

async function apagados(knex) {
  const { rows } = await knex.raw(
    `SELECT count(*)::int n FROM pg_trigger WHERE tgrelid = ?::regclass AND tgenabled = 'D'`,
    [TABLA],
  );
  return rows[0].n;
}

exports.up = async function up(knex) {
  const antes = await apagados(knex);
  if (antes === 0) {
    console.log(`  ${TABLA}: los triggers ya están todos encendidos — nada que hacer.`);
    return;
  }
  console.log(`  ${TABLA}: ${antes} trigger(s) deshabilitado(s).`);

  // ── Gate: cero violaciones ANTES de encender ───────────────────────────────
  const violaciones = [];
  for (const [col, sql] of CHEQUEOS) {
    const { rows } = await knex.raw(sql);
    if (rows[0].n > 0) violaciones.push(`${col}: ${rows[0].n}`);
  }
  if (violaciones.length) {
    throw new Error(
      `${TABLA} tiene referencias colgadas (${violaciones.join(' · ')}). ` +
        'ENABLE TRIGGER no valida lo ya escrito: quedarían violaciones latentes que revientan ' +
        'en el próximo UPDATE de esas filas. Corré database/scripts/cleanup-test-identity-residue.js ' +
        'y volvé a intentar.',
    );
  }
  console.log('  ✓ cero referencias colgadas en las 6 FK — se puede encender.');

  // `lock_timeout`: ENABLE TRIGGER toma ACCESS EXCLUSIVE sobre la tabla. Son 120
  // filas, pero la referencian ~96 FK y los feeds escriben cada minuto: si no se
  // puede tomar el lock en 15s, es mejor fallar y reintentar que encolar a todos
  // los que vengan detrás.
  await knex.raw(`SET LOCAL lock_timeout = '15s'`);
  await knex.raw(`ALTER TABLE ${TABLA} ENABLE TRIGGER ALL`);

  const despues = await apagados(knex);
  if (despues !== 0) {
    throw new Error(`Quedaron ${despues} trigger(s) deshabilitado(s) en ${TABLA} tras el ENABLE.`);
  }
  console.log(`  ✓ ${antes} trigger(s) re-encendido(s); 0 deshabilitados.`);
};

/**
 * A propósito NO revierte. Bajar esto sería volver a apagar la integridad
 * referencial de la tabla de usuarios — el estado que causó el incidente. Si
 * hace falta reproducirlo, se hace a mano y con intención.
 */
exports.down = async function down() {
  console.log(
    '  down() no hace nada a propósito: re-apagar los triggers de identity.users es el bug, no el rollback.',
  );
};
