'use strict';
/**
 * [IC.2] Que pueda contar quien cuenta, y que no ajuste saldo quien no debe.
 *
 * ── Lo medido en prod (2026-09-28) ─────────────────────────────────────────────────────
 *
 * El módulo de conteo físico está completo desde jun-2026 y **nunca se usó**: 6 folios, todos
 * `cancelled`, cero reconciliados. Una de las causas es de permisos, y es literal:
 *
 *   almacenista (6 personas)  VER=false  CONTAR=false  SUPERVISAR=true   → NO PUEDE NI VER
 *   marketing   (2 personas)  todo=true, incluido RECONCILIAR           → AUTORIZA AJUSTES
 *
 * Quien cuenta físicamente no podía ni abrir la pantalla de inventario, y quien autorizaba el
 * ajuste de saldo —que mueve dinero— era marketing.
 *
 * ── Los tres cambios, y por qué cada uno ───────────────────────────────────────────────
 *
 * 1. `almacenista` gana **VER** y **CONTAR**. Es el rol de piso: es quien va al anaquel.
 *
 * 2. `almacenista` PIERDE **SUPERVISAR**, y esto no es cosmético: rompía el conteo ciego.
 *    `submitCount` nunca devuelve `expected_qty` (Fase I), pero `GET /counts/:id/items` SÍ lo
 *    devuelve y va gateado con SUPERVISAR. Un contador con SUPERVISAR puede leer el teórico
 *    por esa puerta **antes** de contar, y entonces el doble conteo ciego deja de ser ciego —
 *    que es el control entero de la fase. Quien cuenta no supervisa: es la segregación que la
 *    Fase I diseñó y que el reparto real había invertido.
 *    ⚠️ No rompe uso vivo: cero folios en la historia y 1 de los 6 almacenistas ha entrado.
 *
 * 3. `marketing` pierde **RECONCILIAR**. Reconciliar autoriza el ajuste de saldo contra el
 *    físico: es el paso que mueve el dinero del inventario. No es función de marketing.
 *    ⚠️ Los 2 usuarios de marketing SÍ están activos (login el 18 y el 28 de sep), así que es
 *    un cambio sobre gente que usa el sistema — pero sobre un permiso que nunca se ejerció.
 *
 * ── Lo que NO se toca, con motivo ──────────────────────────────────────────────────────
 *
 * · `marketing` conserva CONTAR/SUPERVISAR/ASIGNAR/AJUSTAR. Se quita sólo el que mueve saldo;
 *   el resto es una decisión de negocio, no una falla de segregación, y se declara.
 * · `encargado_tienda` (7 personas) tiene **AJUSTAR sin CONTAR**: puede mover el saldo pero no
 *   contarlo. Es otra incoherencia real, medida, y **queda declarada sin tocar** — cambiarla
 *   afecta la operación de tienda y no es parte de esta rebanada.
 * · `direccion` tiene las claves de conteo en NULL (ausentes, no en false). Un NULL no es un
 *   permiso denegado: es uno que nunca se repartió. Se deja así para no inventarle intención.
 *
 * Quirúrgica con `jsonb_set`: NO reescribe el mapa del rol. Guardar el mapa completo desde
 * /admin/roles deja en `false` las claves nuevas del enum — es como `almacenista` terminó con
 * permisos ajenos en false, y como [LC.6.2] dejó un módulo sin que nadie pudiera abrirlo.
 */

const OTORGAR = [
  { rol: 'almacenista', clave: 'COMMERCIAL_INVENTORY_VER' },
  { rol: 'almacenista', clave: 'COMMERCIAL_INVENTORY_CONTAR' },
];
const REVOCAR = [
  // Conteo ciego: quien cuenta no puede leer el teórico por la puerta del supervisor.
  { rol: 'almacenista', clave: 'COMMERCIAL_INVENTORY_SUPERVISAR' },
  // Mover saldo de inventario no es función de marketing.
  { rol: 'marketing', clave: 'COMMERCIAL_INVENTORY_RECONCILIAR' },
];

exports.up = async function up(knex) {
  for (const { rol, clave } of OTORGAR) {
    const r = await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = jsonb_set(permissions, ARRAY[?::text], 'true'::jsonb, true)
        WHERE role_name = ?
          AND COALESCE((permissions->>?)::boolean, false) IS DISTINCT FROM true`,
      [clave, rol, clave],
    );
    // eslint-disable-next-line no-console
    console.log(`[IC.2] ${rol}.${clave} = true  (${r.rowCount} fila)`);
  }

  for (const { rol, clave } of REVOCAR) {
    const r = await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = jsonb_set(permissions, ARRAY[?::text], 'false'::jsonb, true)
        WHERE role_name = ?
          AND COALESCE((permissions->>?)::boolean, false) IS DISTINCT FROM false`,
      [clave, rol, clave],
    );
    // eslint-disable-next-line no-console
    console.log(`[IC.2] ${rol}.${clave} = false (${r.rowCount} fila)`);
  }

  const { rows } = await knex.raw(
    `SELECT role_name,
            (permissions->>'COMMERCIAL_INVENTORY_VER')        AS ver,
            (permissions->>'COMMERCIAL_INVENTORY_CONTAR')     AS contar,
            (permissions->>'COMMERCIAL_INVENTORY_SUPERVISAR') AS supervisar,
            (permissions->>'COMMERCIAL_INVENTORY_RECONCILIAR') AS reconciliar
       FROM identity.role_permissions
      WHERE role_name IN ('almacenista', 'marketing') ORDER BY 1`);
  for (const r of rows) {
    // eslint-disable-next-line no-console
    console.log(`[IC.2] ${r.role_name}: ver=${r.ver} contar=${r.contar}`
      + ` supervisar=${r.supervisar} reconciliar=${r.reconciliar}`);
  }
};

/**
 * Revierte exactamente lo que `up` cambió. El estado anterior era el medido arriba:
 * almacenista sin VER ni CONTAR y con SUPERVISAR; marketing con RECONCILIAR.
 */
exports.down = async function down(knex) {
  for (const { rol, clave } of OTORGAR) {
    await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = jsonb_set(permissions, ARRAY[?::text], 'false'::jsonb, true)
        WHERE role_name = ?`, [clave, rol]);
  }
  for (const { rol, clave } of REVOCAR) {
    await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = jsonb_set(permissions, ARRAY[?::text], 'true'::jsonb, true)
        WHERE role_name = ?`, [clave, rol]);
  }
};
