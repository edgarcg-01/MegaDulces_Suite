'use strict';
/**
 * ⭐⭐ `[CGS.1]` — **El puesto que revisa el arqueo puede, por fin, autorizarlo.**
 *
 * Pedido de Edgar (2026-10-20): *«que todas las mañanas le llegue una notificación a María
 * Gutiérrez, a su puesto, que tiene que revisar el arqueo de caja general y autorizar»*.
 *
 * ── Lo medido antes, y por qué esto es la pieza que faltaba ─────────────────────────────────
 *
 * `maria_gutierrez` es **María de la Paz Gutiérrez Guzmán**, puesto `tesoreria`, rol `tesoreria`,
 * activa. Y su puesto **ya era responsable PRINCIPAL** de `finanzas.caja` en
 * `identity.position_responsibilities` (junto a `aux_caja_general_zona`).
 *
 * ⛔ **Pero el rol no podía autorizar.** Medido en prod el 2026-10-20:
 *
 *     tesoreria            FINANCE_CAJA_VER ✔   GESTIONAR ✔   AUTORIZAR = NULL
 *     finanzas             VER ✔   GESTIONAR ✔   AUTORIZAR = NULL
 *     contabilidad         VER ✔   GESTIONAR ✔   AUTORIZAR = NULL
 *     direccion            VER ✔   GESTIONAR —   AUTORIZAR ✔   (2 personas)
 *     superadmin           VER ✔   GESTIONAR ✔   AUTORIZAR ✔   (8 personas)
 *
 * O sea que autorizar un arqueo de caja sólo podían Dirección y los superadmin — **ninguno
 * supervisor de caja**. Y el resultado está a la vista: **7 cortes cerrados, CERO autorizados**,
 * del 12 al 19-oct, con diferencias de hasta **−$208,594.59** que nadie miró porque nadie podía.
 *
 * ⭐ **No era desidia: era una responsabilidad sin el permiso que la ejerce.** Es exactamente el
 * punto 7 de la receta de permisos (`reference_add_permission_recipe`): *declararlo en el enum NO
 * le da acceso a nadie*; la clave existía desde `[CG.15]` y nunca se repartió a quien revisa.
 *
 * ── Qué hace, y qué NO ──────────────────────────────────────────────────────────────────────
 *
 * Da `FINANCE_CAJA_AUTORIZAR` al rol **`tesoreria`**, que es el de María. Nada más.
 *
 * ⛔ **No se lo da a `finanzas`**, que es el rol de `carmen_rodriguez` — la que captura y cierra.
 * `cut_doble_llave_chk` prohíbe en la base que quien cerró autorice, así que dárselo no la
 * habilitaría para nada y sí haría creer que la segunda llave está repartida cuando no lo está.
 * **Dos llaves en el mismo llavero no son dos llaves.**
 *
 * ⚠️ **Quién más revisa se configura en `/admin/roles`, no acá.** Edgar pidió *«poder seleccionar
 * quién revisa los arqueos y habilita»*: esa elección es de operación y cambia con la gente, así
 * que vive en la pantalla de roles. Esta migración sólo reparte el arranque medido.
 *
 * ── ⚠️ El gotcha que puede dejarla inerte ───────────────────────────────────────────────────
 *
 * El guard es `permissions -> 'KEY' IS NULL`, que significa **«nunca se tocó»**, no «no lo tiene».
 * `/admin/roles` guarda el JSONB completo, así que si alguien salvó el rol después de que la clave
 * entrara al enum, quedó en `false` y esta migración **lo respeta a propósito** (no pisa una
 * decisión manual). Medido hoy: `tesoreria` lo tiene en **NULL**, así que la migración muerde.
 *
 * ⛔ Y se usa `permissions -> 'KEY' IS NULL`, **nunca el operador `?` de JSONB**: knex no lo
 * escapa bien y la condición se rompe en silencio (regla dura del proyecto).
 *
 * ── Guardas ─────────────────────────────────────────────────────────────────────────────────
 *
 * Aborta entero si: el rol `tesoreria` no existe; ya tiene la clave en `true` (nada que hacer, se
 * sale sin ruido); la tiene en `false` (alguien decidió que no, y pisarlo sería silencioso); o si
 * no hay ninguna persona activa con ese rol — repartir un permiso a un rol vacío es declararlo
 * entregado sin que nadie pueda usarlo, que es el defecto que la receta nombra.
 *
 * ⚠️ **Sólo hace UPDATE: la compuerta del despliegue la clasifica NO_MEDIDO y FRENA al equipo.
 *    Va aplicada ANTES de mergear.**
 *
 * ⚠️ Y hace falta **re-login** de María: el botón del frontend lee el snapshot de permisos del
 * JWT. El backend sí lo lee fresco (permsCache, TTL 30 s).
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ROL = 'tesoreria';
const CLAVE = 'FINANCE_CAJA_AUTORIZAR';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const abortar = (m) => {
    throw new Error(`[CGS.1] ${m} -- migracion abortada, no se toco ninguna fila.`);
  };

  // Guarda 1: el rol existe y sabemos en que estado esta la clave.
  const { rows } = await knex.raw(
    `SELECT (permissions -> ?) AS valor,
            (permissions -> 'FINANCE_CAJA_VER') AS ver,
            (permissions -> 'FINANCE_CAJA_GESTIONAR') AS gestionar
       FROM identity.role_permissions WHERE tenant_id = ? AND role_name = ?`,
    [CLAVE, TENANT, ROL]);
  if (rows.length !== 1) abortar(`el rol ${ROL} no existe (filas: ${rows.length})`);
  const v = rows[0].valor;
  if (v === true) return;                       // ya lo tiene: idempotente, sin ruido
  if (v === false) {
    abortar(`${ROL} tiene ${CLAVE} en FALSE: alguien lo decidio en /admin/roles y pisarlo seria silencioso`);
  }
  // ⛔ Si no puede ni VER la caja, darle AUTORIZAR es incoherente: el permiso abriria una accion
  // sobre una pantalla que no puede abrir.
  if (rows[0].ver !== true) abortar(`${ROL} no tiene FINANCE_CAJA_VER: autorizar sin poder ver no se sostiene`);

  // Guarda 2: hay alguien que de verdad lo va a usar.
  const { rows: gente } = await knex.raw(
    `SELECT count(*)::int AS n FROM identity.users
      WHERE tenant_id = ? AND role_name = ? AND activo AND deleted_at IS NULL`, [TENANT, ROL]);
  if (Number(gente[0].n) === 0) {
    abortar(`no hay ninguna persona activa con rol ${ROL}: repartir el permiso seria declararlo entregado sin que nadie pueda usarlo`);
  }

  // La escritura. `-> IS NULL` = nunca se toco; un `false` explicito NO se pisa (ver cabecera).
  await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = jsonb_set(permissions, ARRAY[?::text], 'true'::jsonb, true),
            updated_at = now()
      WHERE tenant_id = ? AND role_name = ? AND (permissions -> ?) IS NULL`,
    [CLAVE, TENANT, ROL, CLAVE]);

  // Comprobacion: quedo repartido, y hay con quien ejercerlo.
  const { rows: fin } = await knex.raw(
    `SELECT (permissions -> ?) AS valor FROM identity.role_permissions
      WHERE tenant_id = ? AND role_name = ?`, [CLAVE, TENANT, ROL]);
  if (fin[0].valor !== true) abortar(`${CLAVE} no quedo en true para ${ROL}`);

  // ⚠️ Y que la doble llave siga siendo DOS: si el mismo rol cerrara y autorizara, la revision
  // seria la misma persona firmando dos veces. Se DECLARA, no se frena: quien cierra es un
  // usuario, no un rol, y la base ya lo impide por `cut_doble_llave_chk`.
  const { rows: cruce } = await knex.raw(
    `SELECT count(*)::int AS n FROM identity.role_permissions
      WHERE tenant_id = ? AND role_name = ? AND (permissions -> 'FINANCE_CAJA_GESTIONAR') = 'true'::jsonb`,
    [TENANT, ROL]);
  if (Number(cruce[0].n) > 0) {
    // eslint-disable-next-line no-console
    console.log(`  ⚠️ [CGS.1] ${ROL} ahora puede GESTIONAR y AUTORIZAR. La base sigue exigiendo que`
      + ` sean dos PERSONAS distintas (cut_doble_llave_chk); el rol no las separa.`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`: vuelve la clave a NULL, ni una fila mas. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions - ?::text, updated_at = now()
      WHERE tenant_id = ? AND role_name = ? AND (permissions -> ?) = 'true'::jsonb`,
    [CLAVE, TENANT, ROL, CLAVE]);
};
