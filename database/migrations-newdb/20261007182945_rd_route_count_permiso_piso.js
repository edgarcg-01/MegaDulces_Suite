'use strict';
/**
 * `[RD.46]` — **El conteo de ruta llega a quien lo va a hacer.**
 *
 * `[RD.31.1]` repartio `COMMERCIAL_ROUTE_COUNT_REGISTRAR` calcando a
 * `COMMERCIAL_INVENTORY_RECONCILIAR`, que es una llave de **Compras**. Quedo bien para capturar
 * un Excel desde una oficina, que era el caso de entonces. Con la pantalla de conteo adentro de
 * Almacen, ese reparto deja a la gente de piso afuera de su propia herramienta.
 *
 * ── Lo medido antes (solo lectura, prod, 2026-10-07) ────────────────────────────────────────
 *
 *  | rol              | personas | conteo_ruta |
 *  |------------------|----------|-------------|
 *  | superadmin       | 8        | true        |
 *  | compras          | 2        | true        |
 *  | gerente_compras  | 2        | true        |
 *  | supervisor       | 1        | true        |
 *  | encargado_tienda | 7        | **ausente** |
 *  | almacenista      | 6        | **ausente** |
 *  | prevencion       | 1        | **ausente** |
 *  | prevencion_aux.  | 2        | **ausente** |
 *
 * O sea: **13 personas pueden y ninguna de ellas esta en una sucursal**; las 16 que trabajan el
 * piso, no. Es el caso de `[LC.6.2]`: un modulo no esta entregado hasta que su permiso esta
 * REPARTIDO, no solo declarado.
 *
 * ── A quien SI, y por que ───────────────────────────────────────────────────────────────────
 *
 * ⭐ El criterio no es "quien trabaja en almacen" sino **quien puede ser testigo independiente**:
 * el conteo de un camion existe para arbitrar lo que ese camion declara de si mismo, asi que el
 * chofer no puede ser el contador. Los cuatro roles que entran estan en la sucursal y **ninguno
 * conduce la ruta**:
 *  · `encargado_tienda` (7) — uno por plaza, es quien recibe y despacha la ruta.
 *  · `prevencion` (1) + `prevencion_auxiliar` (2) — el testigo por oficio.
 *  · `almacenista` (6) — ya es el contador designado del almacen (`COMMERCIAL_INVENTORY_CONTAR`
 *    en `true`). Carga el camion, pero el responsable de la mercancia es el chofer que firma:
 *    contarlo no es revisar su propio trabajo.
 *
 * ⛔ `auxiliar_tienda` (5) queda FUERA a proposito: tiene `COMMERCIAL_INVENTORY_CONTAR` en
 * **`false` explicito**, o sea que alguien ya decidio que no cuenta inventario. Darle una llave
 * de conteo mas fuerte que la que le negaron seria contradecir esa decision de costado.
 *
 * ⚠️ **Es una llave de ESCRITURA destructiva**: un conteo RESETEA el saldo publicado de la ruta
 * y manda a CERO lo que no lista. La pantalla lo contiene exigiendo el conteo completo antes de
 * cerrar, pero la API no — quien tenga la llave puede mandar un conteo parcial por otro medio.
 * Por eso el reparto se deja chico y nominal, y se puede recortar desde `/admin/roles`.
 *
 * ⚠️ Se usa `||` y NO el patron `permissions -> 'KEY' IS NULL`: medido, la clave esta **ausente**
 * en los cuatro roles (no en `false`), asi que ambos funcionarian hoy — pero `IS NULL` se vuelve
 * NO-OP silencioso en cuanto alguien guarde el mapa completo desde `/admin/roles`, que es
 * exactamente como `[LC.6.2]` e `[IC.23]` se rompieron.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const CLAVE = 'COMMERCIAL_ROUTE_COUNT_REGISTRAR';
const ROLES = ['encargado_tienda', 'prevencion', 'prevencion_auxiliar', 'almacenista'];
/** Rol excluido a proposito; el freno comprueba que siga afuera. */
const EXCLUIDO = 'auxiliar_tienda';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const { rows: antes } = await knex.raw(
    `SELECT role_name, permissions ->> ? AS valor
       FROM identity.role_permissions
      WHERE deleted_at IS NULL AND role_name = ANY(?)
      ORDER BY role_name`, [CLAVE, ROLES]);

  // Freno de PREMISA: si los roles no existen, el reparto no reparte nada y la migracion se
  // pondria verde sin darle acceso a una sola persona.
  if (antes.length !== ROLES.length) {
    const faltan = ROLES.filter((r) => !antes.some((a) => a.role_name === r));
    throw new Error(`[RD.46] no existen estos roles en identity.role_permissions: ${faltan.join(', ')}`);
  }
  // Freno de PREMISA 2: si alguno ya la tuviera en `false` EXPLICITO, alguien se la nego a
  // proposito y pisarla de costado seria revertir una decision ajena sin decirlo.
  const negados = antes.filter((a) => a.valor === 'false');
  if (negados.length) {
    throw new Error(`[RD.46] ${negados.map((n) => n.role_name).join(', ')} tiene ${CLAVE} en false EXPLICITO: alguien se la nego, revisar antes de repartir`);
  }
  console.log(`  · [RD.46] antes: ${antes.map((a) => `${a.role_name}=${a.valor ?? 'ausente'}`).join(' · ')}`);

  const { rowCount } = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, true),
            updated_at = now()
      WHERE deleted_at IS NULL AND role_name = ANY(?)
        AND coalesce(permissions ->> ?, 'x') <> 'true'`, [CLAVE, ROLES, CLAVE]);
  console.log(`  · [RD.46] ${rowCount} rol(es) actualizados`);

  // ── Freno 1: los cuatro quedaron en true ─────────────────────────────────────────────────
  const { rows: [post] } = await knex.raw(
    `SELECT count(*) FILTER (WHERE permissions ->> ? = 'true')::int AS con
       FROM identity.role_permissions
      WHERE deleted_at IS NULL AND role_name = ANY(?)`, [CLAVE, ROLES]);
  if (Number(post.con) !== ROLES.length) {
    throw new Error(`[RD.46] solo ${post.con} de ${ROLES.length} roles quedaron con ${CLAVE}`);
  }

  // ── Freno 2 (PRUEBA NEGATIVA): el UPDATE no toco a quien no debia ─────────────────────────
  //
  // Sin esto, un `role_name = ANY(...)` mal escrito repartiria la llave a TODO el mundo y el
  // freno 1 seguiria verde: comprobar que los elegidos la tienen no comprueba que los demas no.
  const { rows: [ex] } = await knex.raw(
    `SELECT coalesce(permissions ->> ?, 'ausente') AS valor
       FROM identity.role_permissions
      WHERE deleted_at IS NULL AND role_name = ?`, [CLAVE, EXCLUIDO]);
  if (ex && ex.valor === 'true') {
    throw new Error(`[RD.46] ${EXCLUIDO} quedo con ${CLAVE} y estaba excluido a proposito: el filtro del UPDATE no acoto`);
  }

  // ── Freno 3: ninguna OTRA clave se movio en los roles tocados ─────────────────────────────
  //
  // `||` reemplaza la clave y conserva el resto, pero eso hay que PROBARLO: un `jsonb_build_object`
  // mal armado reemplazaria el mapa entero y dejaria a 16 personas sin nada.
  const { rows: [tam] } = await knex.raw(
    `SELECT min(jsonb_object_keys_count)::int AS minimo FROM (
       SELECT (SELECT count(*) FROM jsonb_object_keys(permissions)) AS jsonb_object_keys_count
         FROM identity.role_permissions
        WHERE deleted_at IS NULL AND role_name = ANY(?)) s`, [ROLES]);
  if (Number(tam.minimo) < 10) {
    throw new Error(`[RD.46] un rol quedo con solo ${tam.minimo} clave(s): el UPDATE piso el mapa en vez de agregarle una`);
  }
  console.log(`  · [RD.46] OK — ${ROLES.length} roles con la llave, ${EXCLUIDO} sigue afuera, mapas intactos (minimo ${tam.minimo} claves)`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: quita la clave de esos cuatro roles, nada mas. */
exports.down = async function down(knex) {
  await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions - ?::text, updated_at = now()
      WHERE deleted_at IS NULL AND role_name = ANY(?)`, [CLAVE, ROLES]);
};
