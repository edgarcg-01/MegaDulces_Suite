'use strict';
/**
 * `[IDG.9.12]` corrección — `etiquetas_anaquel` dejó de ser un complemento el
 * día que pasó a ser el único rol de las etiqueteras, y el catálogo no se
 * enteró.
 *
 * ── Cómo apareció ────────────────────────────────────────────────────────────
 * No lo encontré leyendo: lo encontró `test-newdb-user-roles.js`, que afirma
 * «nadie tiene una tarea como perfil base» y se puso rojo con las 8
 * `etiquetas.NN`. Es exactamente para lo que existe esa aserción.
 *
 * ── Qué pasó ─────────────────────────────────────────────────────────────────
 * `etiquetas_anaquel` nació en julio como **complemento**: se sumaba encima de
 * `piso_tienda`, que era el perfil base de las etiqueteras. `[IDG.9.12]` invirtió
 * eso —recortó el rol a la sola clave `STORE_LABELS_VER`, lo puso como
 * `role_name` de las 8 cuentas y **borró** la fila de `piso_tienda` de
 * `user_roles`— pero dejó `kind = 'complemento'` en el catálogo.
 *
 * O sea: cambié el USO y no la CLASIFICACIÓN. El resultado es un padrón donde 8
 * cuentas tienen de perfil base un rol que el catálogo declara accesorio, y la
 * pantalla de roles lo ofrece en la lista equivocada.
 *
 * Sacar etiquetas **es** el trabajo completo de esas 8 credenciales, no un
 * agregado a otro puesto. `perfil` es lo que corresponde.
 *
 * Idempotente. Sin efecto sobre permisos ni alcance: `kind` sólo clasifica.
 *
 * @param { import("knex").Knex } knex
 */

const ROL = 'etiquetas_anaquel';

exports.up = async function up(knex) {
  const upd = await knex.raw(
    `UPDATE identity.role_permissions
        SET kind = 'perfil', updated_at = now()
      WHERE role_name = ? AND kind <> 'perfil' AND deleted_at IS NULL`,
    [ROL],
  );
  console.log(`  ${ROL}: complemento → perfil en ${upd.rowCount} tenant(s)`);

  // ── Compuerta: la aserción del smoke, escrita acá ─────────────────────────
  // Afirma el estado y no el rowCount, para que la 2ª corrida siga valiendo.
  const { rows } = await knex.raw(
    `SELECT count(*)::int AS malos
       FROM identity.user_roles ur
       JOIN identity.users u ON u.id = ur.user_id
       JOIN identity.role_permissions rp
         ON rp.tenant_id = ur.tenant_id AND rp.role_name = ur.role_name
      WHERE ur.is_primary AND rp.kind <> 'perfil' AND u.deleted_at IS NULL`,
  );
  if (rows[0].malos !== 0) {
    throw new Error(
      `Quedan ${rows[0].malos} cuenta(s) con un rol no-perfil como base. ` +
        'Si no son etiqueteras, hay otro caso del mismo tipo sin resolver.',
    );
  }
  console.log('  ✓ 0 cuentas con un rol no-perfil como perfil base');
};

exports.down = async function down(knex) {
  await knex.raw(
    `UPDATE identity.role_permissions SET kind = 'complemento', updated_at = now()
      WHERE role_name = ?`,
    [ROL],
  );
  console.log(`  ${ROL} vuelve a complemento — y con eso vuelve el rojo del smoke.`);
};
