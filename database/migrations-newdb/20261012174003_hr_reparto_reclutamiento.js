'use strict';
/**
 * `[RH.2.3]` Fase RH — **el reparto de las claves de reclutamiento**, con las pantallas `/rh/reclutamiento/*` ya
 * construidas. Declarar no es entregar (`[LC.6.2]`): sin esto las pantallas existen y sólo las abre un superadmin.
 *
 *     recursos_humanos  →  HR_RECRUITMENT_VER, HR_RECRUITMENT_GESTIONAR
 *
 * ── De dónde sale (no se inventa) ───────────────────────────────────────────────────────────
 * En Mega Talento el portal de reclutamiento lo opera Capital Humano, y no había roles: cualquier usuario del portal
 * movía candidatos, marcaba no recontratables y publicaba vacantes (`requireAuth` sin revisar permisos). En la Suite
 * ese equipo es `recursos_humanos`, el mismo rol al que `[RH.1.7]` (mig `20261008094815`) le repartió la asistencia.
 *
 * ── Lo que NO se reparte, y por qué ─────────────────────────────────────────────────────────
 * ⛔ **Encargados de tienda.** En Mega Talento no tenían acceso al portal; el expediente trae RFC, NSS, cuenta
 *   bancaria y acta de nacimiento. Si una plaza necesita ver a sus candidatos, primero va el alcance por sitio.
 * ⛔ **`administracion`**: ese rol lo tiene gente que no es de RH (ver la cabecera de `20261008094815`).
 * ⛔ **`superadmin`**: no hace falta, es god-mode por nombre de rol (ADR-054).
 *
 * ── La trampa medida antes ──────────────────────────────────────────────────────────────────
 * `permissions -> 'KEY' IS NULL` es no-op cuando la clave ya viene en `false` explícito (residuo de guardar el mapa
 * completo desde `/admin/roles`). Un `false` NO se pisa — puede ser una decisión — pero se DECLARA en el log.
 *
 * ⚠️ Sólo actualiza datos (no crea objetos de esquema): la compuerta del despliegue la clasifica NO_MEDIDO y frena
 *    al equipo hasta que alguien la aplique a mano. **Aplicarla ANTES de mergear.**
 *
 * Idempotente. Los permisos viajan en el JWT → quien gane acceso debe RE-LOGUEAR.
 *
 * @param { import("knex").Knex } knex
 */

const REPARTO = {
  recursos_humanos: ['HR_RECRUITMENT_VER', 'HR_RECRUITMENT_GESTIONAR'],
};

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const [rol, claves] of Object.entries(REPARTO)) {
    for (const perm of claves) {
      const { rows: antes } = await knex.raw(
        `SELECT id, permissions -> ?::text AS ya,
                (SELECT count(*) FROM jsonb_object_keys(permissions)) AS claves
           FROM identity.role_permissions
          WHERE lower(role_name) = ? AND deleted_at IS NULL`,
        [perm, rol]);

      if (!antes.length) {
        console.log(`[RH.2.3] ${perm}: el rol "${rol}" no existe en este destino — no se toca nada.`);
        continue;
      }
      const nuevos = antes.filter((r) => r.ya === null);
      const enFalse = antes.filter((r) => r.ya === false);
      if (enFalse.length) {
        console.log(`[RH.2.3] ⚠️ ${perm}: en FALSE explícito en "${rol}" (${enFalse.length} fila(s)) — NO se pisa. `
          + 'Si la decisión es otorgarlo, desde /admin/roles.');
      }
      if (!nuevos.length) continue;

      const res = await knex.raw(
        `UPDATE identity.role_permissions
            SET permissions = permissions || ?::jsonb, updated_at = now()
          WHERE id = ANY(?) AND deleted_at IS NULL AND permissions -> ?::text IS NULL`,
        [JSON.stringify({ [perm]: true }), nuevos.map((r) => r.id), perm]);

      // Candado de la operación: el `||` sólo puede AGREGAR esta clave.
      const { rows: despues } = await knex.raw(
        `SELECT id, (SELECT count(*) FROM jsonb_object_keys(permissions)) AS claves
           FROM identity.role_permissions WHERE id = ANY(?)`,
        [nuevos.map((r) => r.id)]);
      const previo = new Map(nuevos.map((r) => [r.id, Number(r.claves)]));
      for (const d of despues) {
        if (Number(d.claves) !== previo.get(d.id) + 1) {
          throw new Error(`[RH.2.3] ${perm} en "${rol}": la fila pasó de ${previo.get(d.id)} a ${d.claves} claves — `
            + 'se esperaba +1. Abortado: el UPDATE tocó algo que no era esta clave.');
        }
      }
      console.log(`[RH.2.3] ${perm} otorgado a "${rol}" en ${res.rowCount ?? 0} fila(s).`);
    }
  }

  // Cuánta gente queda alcanzada: un rol vacío no le entrega la pantalla a nadie.
  for (const rol of Object.keys(REPARTO)) {
    const { rows } = await knex.raw(
      `SELECT count(*)::int AS n FROM identity.users WHERE lower(role_name) = ? AND deleted_at IS NULL`, [rol]);
    const n = rows[0]?.n ?? 0;
    console.log(n
      ? `[RH.2.3] "${rol}": ${n} persona(s) ganan acceso a Reclutamiento — deben RE-LOGUEAR.`
      : `[RH.2.3] ⚠️ "${rol}" tiene 0 personas: Reclutamiento no le llega a nadie por esta vía. Asignar desde /admin/personas.`);
  }
};

/** Knex ignora otras exportaciones; queda para quien quiera verificar el reparto. */
exports.REPARTO = REPARTO;

/** Quita sólo lo que esta migración puede haber puesto (en `true`); un `false` manual se respeta. */
exports.down = async function down(knex) {
  for (const [rol, claves] of Object.entries(REPARTO)) {
    for (const perm of claves) {
      await knex.raw(
        `UPDATE identity.role_permissions
            SET permissions = permissions - ?::text, updated_at = now()
          WHERE lower(role_name) = ? AND deleted_at IS NULL AND permissions -> ?::text = 'true'::jsonb`,
        [perm, rol, perm]);
    }
  }
};
