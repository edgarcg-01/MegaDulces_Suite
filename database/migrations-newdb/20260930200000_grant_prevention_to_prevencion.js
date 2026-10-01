/**
 * `[EXP.0]` — Reparte `COMMERCIAL_PREVENTION_VER` / `_GESTIONAR` a los roles de Prevención.
 *
 * ## El equipo de Prevención no podía abrir su propio módulo
 *
 * Medido en prod el 2026-09-30, la clave `COMMERCIAL_PREVENTION_VER` **ni siquiera existe** en
 * el mapa de `prevencion` (1 usuario) ni de `prevencion_auxiliar` (2). En `almacenista` existe
 * pero en **`false`**. El único rol que la tiene en `true` es **`direccion` — 2 personas**.
 *
 * O sea: el módulo de Prevención (Fase PREV.1: expediente de investigación, línea de tiempo del
 * SKU, causa raíz tipificada, monitoreo intensivo) lleva en prod desde agosto y lo pueden abrir
 * dos personas de Dirección, más los 7 `superadmin` que entran por god-mode. **El equipo que le
 * da nombre al rol, no.**
 *
 * Eso explica el número que lo delata: **hay UN solo expediente en toda la historia** de
 * `commercial.inventory_investigations`, y un solo monitoreo — mientras el conteo trimestral de
 * Kepler produjo **7,301 renglones con diferencia sólo en sep-2026**.
 *
 * Es `[LC.6.2]` repetido al pie de la letra: *un módulo no está entregado hasta que su permiso
 * está REPARTIDO en prod, no sólo declarado en el enum*. Y el mecanismo del residuo es el mismo:
 * guardar el mapa completo desde `/admin/roles` aterriza las claves nuevas del enum en `false`
 * para el rol que se guardó (acá, `almacenista`).
 *
 * ## A quién, y por qué así
 *
 * El alcance lo fijó Edgar y es deliberadamente **estrecho**: los dos roles de Prevención, no
 * «todos los que ven inventario». `COMMERCIAL_INVENTORY_VER` lo tienen 11 roles / 34 usuarios —
 * repartir el expediente a todos ellos sería ampliar un permiso de investigación por la puerta
 * de atrás.
 *
 *   · `VER`       → `prevencion` y `prevencion_auxiliar` (el `LIKE` captura hoy exactamente esos
 *                   dos; si mañana nace un `prevencion_*`, entra solo).
 *   · `GESTIONAR` → **sólo `prevencion`.** El auxiliar consulta el expediente; clasificar la
 *                   causa raíz y cerrar el caso mueve el veredicto de una merma, y eso tiene
 *                   dueño.
 *
 * ⛔ **`almacenista` NO se toca, y su `false` no se pisa.** Quien cuenta no investiga — es la
 * misma segregación que IC.2 aplicó al quitarle `SUPERVISAR` (ver el teórico rompería el conteo
 * ciego). Acá el motivo es simétrico: quien produce la diferencia no dictamina su causa.
 *
 * ⚠️ **Queda declarado, no resuelto:** `supervisor` (1 usuario) tampoco tiene la clave en su
 * mapa. No se incluye porque el alcance aprobado fueron los dos roles de Prevención; si se
 * decide sumarlo, va en su propia migración con su propio motivo.
 *
 * ## Mecánica
 *
 * Idempotente y no destructiva: `permissions -> 'KEY' IS NULL` — **NO** el operador `?` de
 * JSONB, que knex no escapa bien (regla de la casa). Sólo agrega donde la clave falta, así que
 * un `false` puesto a mano sobrevive.
 *
 * Se actualiza por `role_name` sin filtrar `tenant_id`, igual que los demás backfills de
 * permisos: es un cambio del **catálogo de roles**, no un permiso puntual a un usuario.
 *
 * Los `retirado_*` quedan fuera: darle un permiso nuevo a un rol dado de baja es ruido que
 * después hay que limpiar.
 *
 * ⚠️ Después de aplicarla, los 3 usuarios afectados tienen que **volver a entrar**: los permisos
 * viajan dentro del JWT y el token ya emitido no los trae.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const ver = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || '{"COMMERCIAL_PREVENTION_VER": true}'::jsonb
      WHERE role_name LIKE 'prevencion%'
        AND role_name NOT LIKE 'retirado%'
        AND permissions -> 'COMMERCIAL_PREVENTION_VER' IS NULL`,
  );

  const gestionar = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || '{"COMMERCIAL_PREVENTION_GESTIONAR": true}'::jsonb
      WHERE role_name = 'prevencion'
        AND permissions -> 'COMMERCIAL_PREVENTION_GESTIONAR' IS NULL`,
  );

  // Se cuenta a quién alcanza DE VERDAD, no cuántas filas se tocaron: un permiso repartido a un
  // rol sin gente es exactamente el defecto que esta migración viene a cerrar.
  const [{ usuarios }] = (await knex.raw(
    `SELECT count(DISTINCT u.id)::int AS usuarios
       FROM identity.role_permissions r
       JOIN identity.users u ON u.role_name = r.role_name AND u.deleted_at IS NULL
      WHERE (r.permissions -> 'COMMERCIAL_PREVENTION_VER') = 'true'::jsonb`)).rows;

  console.log(
    `[grant_prevention_to_prevencion] VER → ${ver.rowCount ?? 0} rol(es) · `
    + `GESTIONAR → ${gestionar.rowCount ?? 0} · ahora el expediente alcanza a ${usuarios} `
    + 'persona(s). Los afectados deben volver a entrar (el JWT trae los permisos).',
  );
};

/**
 * No-op, igual que el resto de los backfills de permisos del repo: revocarlo volvería a dejar al
 * equipo de Prevención fuera de su propio módulo, y un rollback de esquema no debería apagar una
 * pantalla en uso. Para quitarlo, desde `/admin/roles`.
 */
exports.down = async function () {
  console.log('[grant_prevention_to_prevencion] down: no-op');
};
