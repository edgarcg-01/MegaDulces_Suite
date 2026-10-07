'use strict';
/**
 * `[RH.1.7]` Fase RH (ADR-084) — **el reparto de las claves de asistencia**, con las pantallas `/rh/*` ya
 * construidas. Declarar no es entregar (`[LC.6.2]`): sin esto las pantallas existen y no las abre nadie
 * más que un superadmin.
 *
 * ── De dónde sale el reparto (no se inventa) ─────────────────────────────────────────────────
 *
 * Del flujo que Mega Talento documenta en su propio código (`api/src/incidencias.ts`, cabecera):
 *
 *   · El encargado ENTREGA (capturada) — todavía no mueve el número.
 *   · Servicios al personal CALIFICA o RECHAZA; su propia captura entra ya calificada (marcada
 *     «autocalificada» para la auditoría) salvo que la entregue a otra persona.
 *   · El cierre de semana la pasa a CERRADA.
 *   · Contabilidad AUDITA lo cerrado; no puede auditar lo que ella calificó.
 *
 * Mega Talento no tenía roles: «servicios al personal» y «contabilidad» eran el mismo administrador
 * (su comentario lo dice: *"cuando existan sus roles, se cambia aquí"*). En la Suite los roles SÍ
 * existen, así que se reparte por rol:
 *
 *     recursos_humanos  →  HR_ATTENDANCE_VER, HR_ATTENDANCE_GESTIONAR, HR_INCIDENTS_CAPTURAR,
 *                          HR_INCIDENTS_CALIFICAR, HR_PERIOD_CLOSE, HR_DEVICES_GESTIONAR
 *     contabilidad      →  HR_INCIDENTS_AUDITAR
 *
 * `recursos_humanos` es el rol que `[IDG.8]` (mig `20260907120000`) creó para el personal de RH.
 * La separación de funciones NO depende de este reparto: la hace cumplir el servidor y un CHECK
 * (quien califica no audita, `[RH.1.6]`), así que tener CAPTURAR y CALIFICAR juntos no la rompe — es
 * exactamente lo que Mega Talento permite, con la bandera a la vista.
 *
 * ── Lo que NO se reparte, y por qué ─────────────────────────────────────────────────────────
 *
 * ⛔ **El encargado de tienda (capturar).** En la Suite la captura no está acotada por sitio: quien
 *   tiene `HR_INCIDENTS_CAPTURAR` captura para cualquier sitio. Dársela a los encargados les dejaría
 *   meter incidencias en plazas ajenas. Primero el alcance por sitio, después el reparto.
 * ⛔ **`administracion`**, aunque es el rol por defecto del puesto «Auxiliar de RR-HH» (mig
 *   `20260828140000`): ese rol lo tiene gente que no es de RH, y repartir por ahí sería repartir a ojo.
 *   Quien sea de RH se pasa a `recursos_humanos` desde `/admin/personas`.
 * ⛔ **`superadmin`**: no hace falta, es god-mode por nombre de rol (ADR-054).
 *
 * ── Quién queda alcanzado ───────────────────────────────────────────────────────────────────
 *
 * Medido en prod el 2026-10-06 (mig `20261006350000`): `contabilidad` tiene 4 personas. Cuántas tiene
 * `recursos_humanos` no se pudo medir desde esta sesión (prod vive en `md`): `[IDG.8]` lo creó sin
 * nadie y la asignación es de RH/Sistemas desde `/admin/personas`. La migración CUENTA y lo dice en el
 * log; la compuerta `test-newdb-permission-delivery.js` lo declara mientras sean cero (`SIN_PERSONAS`).
 *
 * ── La trampa medida antes ──────────────────────────────────────────────────────────────────
 *
 * `permissions -> 'KEY' IS NULL` es no-op cuando la clave ya viene en `false` explícito (residuo de
 * guardar el mapa completo desde `/admin/roles`: `[LC.6.2]`, `[IC.23]`). Un `false` NO se pisa — puede
 * ser una decisión — pero se DECLARA en el log en vez de pasar de largo.
 *
 * Idempotente. Los permisos viajan en el JWT → quien gane acceso debe RE-LOGUEAR.
 *
 * @param { import("knex").Knex } knex
 */

const REPARTO = {
  recursos_humanos: [
    'HR_ATTENDANCE_VER', 'HR_ATTENDANCE_GESTIONAR', 'HR_INCIDENTS_CAPTURAR', 'HR_INCIDENTS_CALIFICAR',
    'HR_PERIOD_CLOSE', 'HR_DEVICES_GESTIONAR',
  ],
  contabilidad: ['HR_INCIDENTS_AUDITAR'],
};

exports.up = async function up(knex) {
  for (const [rol, claves] of Object.entries(REPARTO)) {
    for (const perm of claves) {
      const { rows: antes } = await knex.raw(
        `SELECT id, permissions -> ?::text AS ya,
                (SELECT count(*) FROM jsonb_object_keys(permissions)) AS claves
           FROM identity.role_permissions
          WHERE lower(role_name) = ? AND deleted_at IS NULL`,
        [perm, rol]);

      if (!antes.length) {
        console.log(`[RH.1.7] ${perm}: el rol "${rol}" no existe en este destino — no se toca nada.`);
        continue;
      }
      const nuevos = antes.filter((r) => r.ya === null);
      const enFalse = antes.filter((r) => r.ya === false);
      if (enFalse.length) {
        console.log(`[RH.1.7] ⚠️ ${perm}: en FALSE explícito en "${rol}" (${enFalse.length} fila(s)) — NO se pisa. `
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
          throw new Error(`[RH.1.7] ${perm} en "${rol}": la fila pasó de ${previo.get(d.id)} a ${d.claves} claves — `
            + 'se esperaba +1. Abortado: el UPDATE tocó algo que no era esta clave.');
        }
      }
      console.log(`[RH.1.7] ${perm} otorgado a "${rol}" en ${res.rowCount ?? 0} fila(s).`);
    }
  }

  // Cuánta gente queda alcanzada: un rol vacío no le entrega la pantalla a nadie (compuerta [2b]).
  for (const [rol, claves] of Object.entries(REPARTO)) {
    const { rows: con } = await knex.raw(
      `SELECT count(*)::int AS n FROM identity.role_permissions
        WHERE lower(role_name) = ? AND deleted_at IS NULL
          AND (${claves.map(() => `permissions -> ?::text = 'true'::jsonb`).join(' OR ')})`,
      [rol, ...claves]);
    if (!con[0]?.n) {
      console.log(`[RH.1.7] "${rol}" no quedó con ninguna de sus claves en true — nadie gana acceso por esta vía.`);
      continue;
    }
    const { rows } = await knex.raw(
      `SELECT count(*)::int AS n FROM identity.users
        WHERE lower(role_name) = ? AND deleted_at IS NULL`, [rol]);
    const n = rows[0]?.n ?? 0;
    console.log(n
      ? `[RH.1.7] "${rol}": ${n} persona(s) ganan acceso — deben RE-LOGUEAR.`
      : `[RH.1.7] ⚠️ "${rol}" tiene 0 personas: las pantallas de RH no le llegan a nadie por esta vía. `
        + 'Asignar desde /admin/personas.');
  }
};

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
