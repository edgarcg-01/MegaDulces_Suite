'use strict';
/**
 * [IC.2] Segregación de funciones del conteo físico.
 *
 * Lo que protege no es un estado: es un INVARIANTE. `submitCount` nunca devuelve
 * `expected_qty`, pero `GET /counts/:id/items` sí, y va gateado con SUPERVISAR. Un rol con
 * **CONTAR y SUPERVISAR a la vez** puede leer el teórico antes de contar, y ahí el doble
 * conteo ciego deja de ser ciego — que es el control entero de la Fase I.
 *
 * Un mapa de permisos se edita desde /admin/roles con dos clics, así que sin un candado esto
 * se deshace sin que nadie lo note y sin que nada falle: la pantalla sigue abriendo.
 *
 *   node database/tests/test-newdb-inventory-segregation.js
 *
 * Sólo lee.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

// Línea base medida en prod el 2026-09-28, ANTES de [IC.2]. Los roles que ya combinaban
// CONTAR+SUPERVISAR y que esta rebanada NO toca. El candado es un TRINQUETE: no exige
// arreglar el pasado, exige que no empeore.
const COMBINAN_BASELINE = ['compras', 'gerente_compras', 'marketing', 'superadmin', 'supervisor'];

let ok = 0, bad = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: { connectionString: url, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false } },
    pool: { min: 0, max: 2 },
  });

  console.log('\n=== [IC.2] segregación de funciones del conteo físico ===\n');

  try {
    const perms = async (rol) => {
      const { rows } = await db.raw(
        `SELECT (permissions->>'COMMERCIAL_INVENTORY_VER')::boolean         AS ver,
                (permissions->>'COMMERCIAL_INVENTORY_CONTAR')::boolean      AS contar,
                (permissions->>'COMMERCIAL_INVENTORY_SUPERVISAR')::boolean  AS supervisar,
                (permissions->>'COMMERCIAL_INVENTORY_RECONCILIAR')::boolean AS reconciliar
           FROM identity.role_permissions WHERE role_name = ?`, [rol]);
      return rows[0] || {};
    };

    // ── 1. ⛔ EL INVARIANTE: quien cuenta no supervisa ─────────────────────────
    // Se mide sobre TODOS los roles, no sobre los que yo esperaba. Un rol nuevo que nazca
    // con los dos permisos tiene que poner esto en rojo.
    const { rows: combinan } = await db.raw(
      `SELECT role_name FROM identity.role_permissions
        WHERE COALESCE((permissions->>'COMMERCIAL_INVENTORY_CONTAR')::boolean, false)
          AND COALESCE((permissions->>'COMMERCIAL_INVENTORY_SUPERVISAR')::boolean, false)
        ORDER BY 1`);
    const nombres = combinan.map((r) => r.role_name);
    const nuevos = nombres.filter((r) => !COMBINAN_BASELINE.includes(r));

    console.log(`     roles que combinan CONTAR+SUPERVISAR: ${nombres.length}`
      + ` (${nombres.join(', ') || 'ninguno'})`);
    t('⛔ TRINQUETE: ningún rol NUEVO combina CONTAR+SUPERVISAR (rompería el conteo ciego)',
      nuevos.length === 0, `apareció: ${nuevos.join(', ')}`);
    t('el trinquete no empeoró respecto de la línea base medida',
      nombres.length <= COMBINAN_BASELINE.length,
      `${nombres.length} contra ${COMBINAN_BASELINE.length} de baseline`);

    // ── 2. El almacenista: el rol de piso ─────────────────────────────────────
    const alm = await perms('almacenista');
    const aplicada = alm.contar === true;
    if (!aplicada) {
      console.log('\n  ⓘ la migración 20260928270000 NO está aplicada en este destino:');
      console.log(`    almacenista → ver=${alm.ver} contar=${alm.contar} supervisar=${alm.supervisar}`);
      console.log('    Las aserciones del estado objetivo quedan NO MEDIDAS (el trinquete sí corrió).');
      console.log('    En su lugar se verifica que la migración APUNTE a las filas correctas:\n');

      // No se puede ejercer el UPDATE (destino de sólo lectura), pero sí comprobar que sus
      // WHERE seleccionan exactamente lo que dicen. Un UPDATE que no matchea ninguna fila se
      // aplica "con éxito" y no cambia nada — el modo de fallo más silencioso de una
      // migración de permisos, y el que dejó a [LC.6.2] con un módulo que nadie podía abrir.
      const { rows: [plan] } = await db.raw(
        `SELECT
           count(*) FILTER (WHERE role_name='almacenista'
             AND COALESCE((permissions->>'COMMERCIAL_INVENTORY_VER')::boolean,false) IS DISTINCT FROM true)::int AS dara_ver,
           count(*) FILTER (WHERE role_name='almacenista'
             AND COALESCE((permissions->>'COMMERCIAL_INVENTORY_CONTAR')::boolean,false) IS DISTINCT FROM true)::int AS dara_contar,
           count(*) FILTER (WHERE role_name='almacenista'
             AND COALESCE((permissions->>'COMMERCIAL_INVENTORY_SUPERVISAR')::boolean,false) IS DISTINCT FROM false)::int AS quitara_super,
           count(*) FILTER (WHERE role_name='marketing'
             AND COALESCE((permissions->>'COMMERCIAL_INVENTORY_RECONCILIAR')::boolean,false) IS DISTINCT FROM false)::int AS quitara_rec
         FROM identity.role_permissions`);
      t('la migración VA a otorgar VER al almacenista (matchea 1 fila)',
        Number(plan.dara_ver) === 1, JSON.stringify(plan));
      t('la migración VA a otorgar CONTAR al almacenista (matchea 1 fila)',
        Number(plan.dara_contar) === 1, JSON.stringify(plan));
      t('la migración VA a quitar SUPERVISAR al almacenista (matchea 1 fila)',
        Number(plan.quitara_super) === 1, JSON.stringify(plan));
      t('la migración VA a quitar RECONCILIAR a marketing (matchea 1 fila)',
        Number(plan.quitara_rec) === 1, JSON.stringify(plan));
      console.log('');
    } else {
      t('almacenista PUEDE ver el inventario', alm.ver === true, JSON.stringify(alm));
      t('almacenista PUEDE contar', alm.contar === true, JSON.stringify(alm));
      t('⛔ almacenista NO supervisa (si no, lee el teórico y el conteo deja de ser ciego)',
        alm.supervisar !== true, JSON.stringify(alm));
      t('almacenista NO reconcilia (no autoriza movimiento de saldo)',
        alm.reconciliar !== true, JSON.stringify(alm));

      const mkt = await perms('marketing');
      t('marketing NO reconcilia (reconciliar mueve el dinero del inventario)',
        mkt.reconciliar !== true, JSON.stringify(mkt));
    }

    // ── 3. Que haya ALGUIEN que pueda contar, con personas detrás ─────────────
    // Un permiso repartido a un rol sin usuarios es el mismo fallo de [LC.6.2] visto al revés.
    const { rows: [quien] } = await db.raw(
      `SELECT count(DISTINCT u.id)::int AS personas,
              count(DISTINCT u.role_name)::int AS roles
         FROM identity.users u
         JOIN identity.role_permissions rp ON rp.role_name = u.role_name
        WHERE u.deleted_at IS NULL
          AND COALESCE((rp.permissions->>'COMMERCIAL_INVENTORY_CONTAR')::boolean, false)`);
    t('hay PERSONAS que pueden contar (no sólo roles con el permiso)',
      Number(quien.personas) > 0, JSON.stringify(quien));
    console.log(`     pueden contar: ${quien.personas} personas en ${quien.roles} roles`);

    // ── 4. ⛔ Alguien tiene que poder reconciliar, o el folio nunca cierra ─────
    const { rows: [rec] } = await db.raw(
      `SELECT count(DISTINCT u.id)::int AS personas
         FROM identity.users u
         JOIN identity.role_permissions rp ON rp.role_name = u.role_name
        WHERE u.deleted_at IS NULL
          AND COALESCE((rp.permissions->>'COMMERCIAL_INVENTORY_RECONCILIAR')::boolean, false)`);
    t('⛔ queda alguien que pueda RECONCILIAR (quitarlo a todos deja el folio sin cerrar)',
      Number(rec.personas) > 0, `${rec.personas} personas`);
    console.log(`     pueden reconciliar: ${rec.personas} personas`);

    // ── 5. Incoherencia declarada, no arreglada ───────────────────────────────
    // encargado_tienda puede AJUSTAR el saldo pero no CONTAR. Es real y medido; queda fuera
    // de esta rebanada porque toca la operación de tienda. Se imprime para que no se olvide.
    const { rows: ajustaSinContar } = await db.raw(
      `SELECT role_name FROM identity.role_permissions
        WHERE COALESCE((permissions->>'COMMERCIAL_INVENTORY_AJUSTAR')::boolean, false)
          AND NOT COALESCE((permissions->>'COMMERCIAL_INVENTORY_CONTAR')::boolean, false)
        ORDER BY 1`);
    if (ajustaSinContar.length) {
      console.log(`\n  ⚠️ DECLARADO (no se arregla acá): ${ajustaSinContar.length} rol(es) pueden`
        + ` AJUSTAR saldo sin poder CONTAR — ${ajustaSinContar.map((r) => r.role_name).join(', ')}`);
    }
  } catch (e) {
    bad++; console.log(`  ✘ excepción: ${e.message}`);
  } finally {
    await db.destroy();
  }

  console.log(`\n=== ${ok} ✓ / ${bad} ✗ ===\n`);
  process.exit(bad === 0 ? 0 : 1);
})();
