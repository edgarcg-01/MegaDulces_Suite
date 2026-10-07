'use strict';
/**
 * `[OR.1d]` — Las 3 personas que `[OR.1c]` dejó declaradas, resueltas por el lead.
 *
 * `[OR.1c]` cerró en **97/100 con puesto** y dejó 3 casos afuera porque elegir por ellos habría
 * sido adivinar. El lead los resolvió (2026-09-11):
 *
 *   · `brian_zavala` y `luis_navarro`  ->  puesto `almacenista`.
 *     La ambigüedad era real y tiene causa: **CUATRO puestos comparten el rol `almacenista`**
 *     (`almacenista`, `auxiliar_almacen`, `bodeguero`, `surtidor`), porque la organización tiene
 *     más granularidad que el catálogo de permisos — el rol sólo concede 2 claves
 *     (`COMMERCIAL_INVENTORY_RECIBIR`, `COMMERCIAL_INVENTORY_SUPERVISAR`) y no alcanza para
 *     distinguir bodega de surtido. Ninguno de los dos ha entrado nunca al sistema
 *     (`last_login_at` NULL, alta 2026-07-13).
 *
 *   · `claudia_mata`  ->  **reporte directo a Dirección.**
 *
 * ── Lo que la decisión de claudia_mata destapó: el organigrama no tiene raíz ─────────────────
 * Para que «reporta directo a Dirección» sea representable tiene que existir el nodo Dirección, y
 * **no existía**. Medido: el rol `direccion` SÍ está en el catálogo, con **88 permisos y CERO
 * personas**; los únicos puestos de mando de `direccion_zona` (`jefe_zona`, `supervisor_zona`)
 * están vacíos. O sea que la cúpula estaba definida como permiso y no como lugar en la estructura.
 *
 * Que la cadena viva **entre PUESTOS** es justamente lo que permite arreglarlo: se crea el puesto
 * `direccion` como **raíz del organigrama**, con 0 personas, y eso es correcto y verdadero — un
 * puesto vacante sigue siendo el lugar al que se reporta. Con `supervisor_id` (persona a persona)
 * esto sería inexpresable: no hay a quién apuntar.
 *
 * ── Una distinción que esta migración usa y conviene dejar escrita ───────────────────────────
 * `department_code` = **dónde trabaja**. `reports_to_position_code` = **a quién le responde**.
 * No son lo mismo, y el caso de claudia_mata es el primero donde se separan: sus 19 permisos son
 * todos de inventario, almacén y cuadre (`COMMERCIAL_INVENTORY_*`, `EXISTENCIA_*`,
 * `RECONCILIATION_*`), así que su puesto vive en `almacen`; y reporta a `direccion`, saltándose
 * toda la línea operativa. ⚠️ Si su área resulta ser otra, es UN campo
 * (`positions.department_code` de `supervisor_inventarios`) y no cambia su jefe.
 *
 * Aditiva e idempotente. No toca permisos ni roles.
 *
 * @param { import("knex").Knex } knex
 */

/** Puestos nuevos. [code, name, department_code, default_role, reports_to] */
const PUESTOS = [
  ['direccion', 'Dirección', 'direccion_zona', 'direccion', null],
  ['supervisor_inventarios', 'Supervisor de inventarios', 'almacen', 'supervisor', 'direccion'],
];

/** [username, puesto, department_code a fijar si está vacío, motivo] */
const ASIGNACIONES = [
  ['brian_zavala', 'almacenista', null, 'decision del lead: de los 4 puestos que comparten el rol almacenista, es almacenista'],
  ['luis_navarro', 'almacenista', null, 'decision del lead: de los 4 puestos que comparten el rol almacenista, es almacenista'],
  ['claudia_mata', 'supervisor_inventarios', 'almacen', 'decision del lead: reporte directo a Direccion. El puesto se crea en almacen por sus 19 permisos (todos de inventario/almacen/cuadre) y reporta a direccion'],
];

exports.up = async function up(knex) {
  const tenants = await knex('identity.tenants').where({ activo: true }).pluck('id');

  for (const tenant of tenants) {
    // ── 1. La raíz del organigrama y el puesto que faltaba ────────────────
    let orden = 560;
    for (const [code, name, dept, rol, jefe] of PUESTOS) {
      orden += 10;
      const r = await knex('identity.role_permissions')
        .where({ tenant_id: tenant, role_name: rol })
        .whereNull('deleted_at')
        .first('role_name');
      if (!r) {
        console.log(`     ! el rol "${rol}" no está en el catálogo — ${code} quedaría sin propuesta`);
      }
      const res = await knex.raw(
        `INSERT INTO identity.positions
           (tenant_id, code, name, org_labels, orden, department_code, default_role, reports_to_position_code)
         VALUES (?, ?, ?, '{}', ?, ?, ?, ?)
         ON CONFLICT (tenant_id, code) DO NOTHING`,
        [tenant, code, name, orden, dept, r ? r.role_name : null, jefe],
      );
      console.log(
        res.rowCount
          ? `  [OR.1d] + puesto ${code}${jefe ? ` (reporta a ${jefe})` : ' — RAÍZ del organigrama'}`
          : `  [OR.1d] ${code} ya existía`,
      );
    }

    // ── 2. Las 3 personas ─────────────────────────────────────────────────
    for (const [username, puesto, dept, motivo] of ASIGNACIONES) {
      const u = await knex('identity.users')
        .where({ tenant_id: tenant, username })
        .whereNull('deleted_at')
        .first('id', 'position_code', 'department_code', 'role_name');
      if (!u) { console.log(`     ~ ${username} no existe en este tenant — se salta`); continue; }
      if (u.position_code) {
        console.log(`     ~ ${username} ya tiene puesto (${u.position_code}) — no se pisa`);
        continue;
      }

      const patch = { position_code: puesto, updated_at: knex.fn.now() };
      if (dept && !u.department_code) patch.department_code = dept;

      const n = await knex('identity.users')
        .where({ tenant_id: tenant, id: u.id })
        .whereNull('position_code')
        .update(patch);
      if (!n) { console.log(`     ~ ${username}: otra sesión lo tocó mientras corría — se respeta`); continue; }

      await knex('identity.user_events').insert({
        tenant_id: tenant,
        user_id: u.id,
        event: 'puesto_asignado',
        detalle: JSON.stringify({
          position_code: puesto,
          department_code: patch.department_code || u.department_code,
          origen: 'decision del lead [OR.1d]',
          criterio: motivo,
          role_name: u.role_name,
        }),
        actor_user_id: null,
        actor_username: 'migracion [OR.1d]',
      });
      console.log(`  [OR.1d] + ${String(username).padEnd(16)} -> ${puesto}${patch.department_code ? ` (depto ${patch.department_code})` : ''}`);
    }

    // ── 3. La foto ────────────────────────────────────────────────────────
    const f = await knex.raw(
      `SELECT count(*)::int total, count(position_code)::int con_puesto
         FROM identity.users
        WHERE tenant_id = ? AND activo AND deleted_at IS NULL AND kind = 'interno'`,
      [tenant],
    );
    const x = f.rows[0];
    console.log(`\n  [OR.1d] PADRÓN: ${x.con_puesto}/${x.total} con puesto`);

    const sin = await knex('identity.users')
      .where({ tenant_id: tenant, kind: 'interno', activo: true })
      .whereNull('deleted_at')
      .whereNull('position_code')
      .pluck('username');
    if (sin.length) console.log(`  [OR.1d] todavía sin puesto: ${sin.join(', ')}`);

    // Niveles reales de la cadena, que es lo que [OR.1] vino a conseguir.
    const niv = await knex.raw(
      `WITH RECURSIVE ch AS (
         SELECT code, reports_to_position_code AS jefe, 1 AS nivel
           FROM identity.positions WHERE tenant_id = ? AND deleted_at IS NULL
         UNION ALL
         SELECT p.code, p.reports_to_position_code, ch.nivel + 1
           FROM identity.positions p JOIN ch ON p.code = ch.jefe
          WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND ch.nivel < 20)
       SELECT max(nivel)::int niveles FROM ch`,
      [tenant, tenant]);
    console.log(`  [OR.1d] profundidad máxima de la cadena de mando: ${niv.rows[0].niveles} nivel(es)`);
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  const ev = await knex('identity.user_events')
    .where({ event: 'puesto_asignado', actor_username: 'migracion [OR.1d]' })
    .select('tenant_id', 'user_id');
  for (const e of ev) {
    await knex('identity.users').where({ tenant_id: e.tenant_id, id: e.user_id }).update({ position_code: null });
  }
  for (const tenant of await knex('identity.tenants').pluck('id')) {
    for (const [code] of [...PUESTOS].reverse()) {
      const ocupado = await knex('identity.users')
        .where({ tenant_id: tenant, position_code: code })
        .whereNull('deleted_at')
        .first('id');
      if (ocupado) { console.log(`  [OR.1d] down: ${code} tiene gente — se conserva`); continue; }
      await knex('identity.positions').where({ tenant_id: tenant, code }).del();
    }
  }
  console.log(`  [OR.1d] down: ${ev.length} asignación/es revertida/s.`);
};
