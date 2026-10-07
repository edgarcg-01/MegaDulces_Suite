'use strict';
/**
 * `[IDG.7]` — Los roles `retirado_*` dejan de conceder permisos.
 *
 * Auditoría del padrón (2026-09-05): de los 50 roles del catálogo, 20 no tienen
 * a nadie. **14 de ellos llevan el prefijo `retirado_` y entre todos siguen
 * concediendo 643 permisos**, encabezados por `retirado_sistemas` con **145 de
 * 167 claves** — o sea, casi god-mode. Basta escribir ese `role_name` en la
 * ficha de un usuario (o que un seed viejo lo haga) para heredarlos.
 *
 * ── Vaciar, no borrar ────────────────────────────────────────────────────────
 * La fila se conserva a propósito, por dos razones:
 *   1. `identity.users.role_name` tiene FK `ON DELETE RESTRICT` a
 *      `role_permissions`, así que borrar el rol es imposible mientras alguien
 *      lo tenga — y el día que se quiera reactivar a una persona con su rol
 *      histórico, el nombre sigue ahí.
 *   2. El nombre es documentación: dice qué puesto existió.
 * Lo que se retira es el PODER, no la etiqueta.
 *
 * ── Gate ─────────────────────────────────────────────────────────────────────
 * Sólo vacía los que tienen **cero** usuarios y **cero** filas en
 * `identity.user_roles` (ni como perfil base ni como complemento). Si alguno
 * tiene gente, la migración ABORTA: significa que a alguien se le asignó un rol
 * retirado desde que se midió, y eso es una decisión que hay que revisar, no
 * revertir en silencio.
 *
 * No se tocan los otros 6 roles sin usuarios (`direccion` con 82 permisos,
 * `auditor_externo` con 17, `analisis_ventas`, `etiquetas_anaquel`,
 * `auxiliar finanzas`, `encargado_bodega`): no llevan el prefijo y parecen
 * perfiles previstos para gente que todavía no tiene cuenta, no residuo.
 *
 * Tampoco se tocan sus 6 reglas de `identity.role_scopes` cada uno: sin
 * permisos el alcance es inerte, y dejarlas hace trivial reactivar el rol.
 *
 * Idempotente. El `down` no restaura los permisos: no se guarda el JSONB previo
 * a propósito — está en el historial de git y en los backups, y "deshacer" esto
 * es volver a poner 145 permisos en un rol sin dueño.
 *
 * @param { import("knex").Knex } knex
 */

const PREFIJO = 'retirado%';

exports.up = async function up(knex) {
  const { rows } = await knex.raw(
    `SELECT rp.tenant_id, rp.role_name,
            (SELECT count(*) FROM jsonb_each(rp.permissions) WHERE value::text = 'true')::int AS otorgados,
            (SELECT count(*) FROM identity.users u
              WHERE u.tenant_id = rp.tenant_id AND lower(u.role_name) = lower(rp.role_name))::int AS usuarios,
            (SELECT count(*) FROM identity.user_roles ur
              WHERE ur.tenant_id = rp.tenant_id AND lower(ur.role_name) = lower(rp.role_name))::int AS complementos
       FROM identity.role_permissions rp
      WHERE rp.role_name LIKE ?
      ORDER BY 3 DESC`,
    [PREFIJO],
  );

  if (!rows.length) {
    console.log('  No hay roles `retirado_*` — nada que hacer.');
    return;
  }

  const ocupados = rows.filter((r) => r.usuarios > 0 || r.complementos > 0);
  if (ocupados.length) {
    throw new Error(
      'Hay roles `retirado_*` CON gente: ' +
        ocupados
          .map((r) => `${r.role_name} (${r.usuarios} usuario(s), ${r.complementos} en user_roles)`)
          .join(' · ') +
        '. Vaciarles los permisos los dejaría sin acceso. Revisá por qué están asignados antes de correr esto.',
    );
  }

  const conPermisos = rows.filter((r) => r.otorgados > 0);
  if (!conPermisos.length) {
    console.log(`  Los ${rows.length} roles \`retirado_*\` ya están vacíos — nada que hacer.`);
    return;
  }

  const total = conPermisos.reduce((a, r) => a + r.otorgados, 0);
  console.log(
    `  ${conPermisos.length} rol(es) retirado(s) con permisos, ${total} concesiones en total:`,
  );
  for (const r of conPermisos) {
    console.log(`    · ${r.role_name.padEnd(34)} ${String(r.otorgados).padStart(4)} permiso(s)`);
  }

  const upd = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = '{}'::jsonb, updated_at = now()
      WHERE role_name LIKE ?
        AND permissions <> '{}'::jsonb`,
    [PREFIJO],
  );
  console.log(`  ✓ ${upd.rowCount} fila(s) vaciada(s). Las filas se conservan como etiqueta histórica.`);

  // Gate de salida: que de verdad no quede ninguno concediendo nada.
  const { rows: resto } = await knex.raw(
    `SELECT count(*)::int n FROM identity.role_permissions rp
      WHERE rp.role_name LIKE ?
        AND (SELECT count(*) FROM jsonb_each(rp.permissions) WHERE value::text = 'true') > 0`,
    [PREFIJO],
  );
  if (resto[0].n > 0) {
    throw new Error(`Quedaron ${resto[0].n} rol(es) \`retirado_*\` concediendo permisos.`);
  }
};

exports.down = async function down() {
  console.log(
    '  down() no restaura los permisos a propósito: el JSONB previo está en git y en los backups, ' +
      'y revertir esto es devolverle 145 permisos a un rol sin dueño.',
  );
};
