'use strict';
/**
 * Fase RH · `[RH.1.4c]` — FUSIÓN y limpieza de los usuarios que creó la carga de personas
 * (`carga-personas-mega-talento.js`, `username LIKE 'mt.%'`, `sin_acceso`, sin contraseña).
 *
 * No es un importer (CLAUDE.md, regla principal): corre UNA vez, verifica lo que movió, y es
 * ENSAYO por omisión (todo en una transacción que se deshace). Con `--aplicar`, la deja.
 *
 * Qué hace, particionando SIEMPRE por sucursal (la plaza del `mt` sale de su username
 * `mt.<sitio>.<codigo>`, mapeada a almacén con `mapeo-personas-mega-talento.json`):
 *
 *   A · Fusiona cada `mt` que tiene UNA cuenta previa de la Suite en su MISMO almacén con el
 *       MISMO nombre completo (igualdad del conjunto de tokens: resuelve el orden invertido de
 *       Mega Talento —«APELLIDO APELLIDO NOMBRE»— sin fusionar hermanas ni homónimos). Re-apunta
 *       a la cuenta de la Suite TODO lo del `mt` (enrolamientos, checadas, alertas, incidencias,
 *       revisiones, horarios, servicedesk, supervisiones…) y borra el `mt`.
 *   B · Colapsa los `mt` DUPLICADOS entre sí en el mismo almacén (la misma persona con su ficha
 *       activa y su vieja ficha del reloj de comida). Gana la activa (invited > enrolamientos > id);
 *       re-apunta las de los perdedores y los borra.
 *
 * Lo que NO toca: los `mt` SIN gemelo seguro (nombre de un token, o sin cuenta previa) — son el
 * único registro de ese empleado. Ni los 3/1 ambiguos. Se declaran en el cuadre, no se borran.
 *
 * La re-asignación recorre DINÁMICAMENTE todas las FK que apuntan a `identity.users` con
 * `ON DELETE` distinto de CASCADE (las CASCADE —roles, scopes, permisos, eventos del propio `mt`—
 * se van solas al borrarlo), y NUNCA toca la columna `tenant_id` de una FK compuesta.
 *
 *   # dentro del pod api de prod (ver RH_CORTE_ASISTENCIA.md §1):
 *   CARGA_URL="$DATABASE_URL_NEW" node /app/database/scripts/rh/fusion-usuarios-mega-talento.js            # ensayo
 *   CARGA_URL="$DATABASE_URL_NEW" node /app/database/scripts/rh/fusion-usuarios-mega-talento.js --aplicar  # deja la fusión
 */
const path = require('path');

const TENANT = '00000000-0000-0000-0000-00000000d01c';
/** Identidad del clúster de PROD (copia de apply-one-migration-prod.js: un destino equivocado triunfa en el lugar equivocado). */
const PROD_CLUSTER_ID = '7688376744939610156';
const SITIOS = require('./mapeo-personas-mega-talento.json').sitios;

/** VALUES (sitio, almacén) sólo de las plazas con almacén: la del `mt` sale de su username. */
const WH_VALUES = Object.entries(SITIOS)
  .filter(([, v]) => v && v.warehouse_code)
  .map(([s, v]) => `('${s}','${v.warehouse_code}')`)
  .join(',');

/** CTE común: tokens normalizados del nombre (mayúsculas, sin acentos ni signos, ORDENADOS → conjunto). */
const CTE = `
  WITH wh(sitio,warehouse_code) AS (VALUES ${WH_VALUES}),
  toks AS (
    SELECT id, username, nombre, status,
      (SELECT array_agg(t ORDER BY t) FROM unnest(
         regexp_split_to_array(btrim(regexp_replace(
           translate(upper(coalesce(nombre,'')),'ÁÉÍÓÚÑÜ','AEIOUNU'),'[^A-Z0-9 ]',' ','g')),'\\s+')) t
       WHERE t <> '') AS tk
    FROM identity.users
    WHERE tenant_id = '${TENANT}'::uuid AND kind IN ('interno','externo') AND deleted_at IS NULL
  ),
  mt AS (
    SELECT t.id, t.username, t.nombre, t.status, t.tk, w.warehouse_code AS wh,
           coalesce(array_length(t.tk,1),0) AS ntok,
           (SELECT count(*) FROM hr.device_enrollments e WHERE e.user_id = t.id) AS enrol
    FROM toks t JOIN wh w ON w.sitio = split_part(t.username,'.',2)
    WHERE t.username LIKE 'mt.%'
  ),
  sui AS (
    SELECT u.id, u.username, u.nombre, t.tk, u.warehouse_code AS wh
    FROM identity.users u
    JOIN toks t ON t.id = u.id
    WHERE u.username NOT LIKE 'mt.%' AND u.warehouse_code IS NOT NULL
  )`;

/** A: cada `mt` con EXACTAMENTE una cuenta Suite del mismo almacén y mismo nombre completo. winner = Suite. */
const SQL_A = `${CTE}
  SELECT mt.id AS loser, s.id AS winner, mt.username AS loser_u, s.username AS winner_u, mt.nombre, mt.wh
  FROM mt
  JOIN LATERAL (SELECT * FROM sui s WHERE s.wh = mt.wh AND s.tk = mt.tk) s ON true
  WHERE mt.ntok >= 2
    AND (SELECT count(*) FROM sui s2 WHERE s2.wh = mt.wh AND s2.tk = mt.tk) = 1
  ORDER BY mt.wh, mt.nombre`;

/**
 * B: `mt` duplicados entre sí (mismo almacén, mismo nombre completo) y SIN cuenta Suite (si la
 * tuvieran, caen en A). Gana invited, luego más enrolamientos, luego menor id.
 */
const SQL_B = `${CTE}
  , g AS (
    SELECT mt.*,
      row_number() OVER (PARTITION BY mt.wh, mt.tk ORDER BY (mt.status='invited') DESC, mt.enrol DESC, mt.id) AS rn,
      first_value(mt.id)       OVER (PARTITION BY mt.wh, mt.tk ORDER BY (mt.status='invited') DESC, mt.enrol DESC, mt.id) AS winner,
      first_value(mt.username) OVER (PARTITION BY mt.wh, mt.tk ORDER BY (mt.status='invited') DESC, mt.enrol DESC, mt.id) AS winner_u,
      count(*) OVER (PARTITION BY mt.wh, mt.tk) AS cnt
    FROM mt
    WHERE mt.ntok >= 2
      AND NOT EXISTS (SELECT 1 FROM sui s WHERE s.wh = mt.wh AND s.tk = mt.tk)
  )
  SELECT g.id AS loser, g.winner, g.username AS loser_u, g.winner_u, g.nombre, g.wh
  FROM g WHERE g.cnt > 1 AND g.rn > 1
  ORDER BY g.wh, g.nombre`;

/** Las FK que apuntan a identity.users con ON DELETE distinto de CASCADE, sin la columna tenant_id. */
async function columnasFk(trx) {
  const { rows } = await trx.raw(`
    SELECT n.nspname||'.'||c.relname AS tbl, a.attname AS col
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_class rc ON rc.oid = k.confrelid
      JOIN pg_namespace rn ON rn.oid = rc.relnamespace
      JOIN unnest(k.conkey) WITH ORDINALITY AS ck(attnum,ord) ON true
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ck.attnum
     WHERE k.contype = 'f' AND rn.nspname = 'identity' AND rc.relname = 'users'
       AND k.confdeltype <> 'c' AND a.attname <> 'tenant_id'`);
  return rows;
}

/** Re-apunta todas las referencias de `loser` a `winner`; suma por tabla.columna en `tally`. */
async function reasignar(trx, fkcols, loser, winner, tally) {
  for (const { tbl, col } of fkcols) {
    const r = await trx.raw(`UPDATE ${tbl} SET "${col}" = ? WHERE "${col}" = ?`, [winner, loser]);
    if (r.rowCount) tally[`${tbl}.${col}`] = (tally[`${tbl}.${col}`] || 0) + r.rowCount;
  }
}

async function fusionar(trx, pares, fkcols, etiqueta, log) {
  const tally = {};
  let borrados = 0;
  for (const p of pares) {
    await reasignar(trx, fkcols, p.loser, p.winner, tally);
    const d = await trx.raw(`DELETE FROM identity.users WHERE id = ? AND tenant_id = ?::uuid`, [p.loser, TENANT]);
    borrados += d.rowCount || 0;
  }
  log(`\n${etiqueta}: ${pares.length} fusión(es), ${borrados} usuario(s) mt borrado(s).`);
  for (const [k, v] of Object.entries(tally).sort()) log(`  reasignado  ${k.padEnd(44)} ${v}`);
  return { pares: pares.length, borrados, tally };
}

/**
 * `[RH.21]` H4 — MODO PARES CONFIRMADOS: `--pares=<sin_acceso>:<con_acceso>,…` (UUIDs, nunca nombres: el repo es público).
 *
 * A y B sólo fusionan lo que es SEGURO por regla (mismo almacén, mismo nombre exacto). Se escaparon 12 personas con dos
 * identidades —una cuenta con acceso que inicia sesión y otra `sin_acceso` que es la que checa— porque la cuenta con
 * acceso no tenía almacén o el nombre variaba (medido el 2026-11-25). Esas las confirmó Edgar una por una, y aquí se
 * fusionan SÓLO esas. Gana la cuenta CON acceso.
 *
 * Distinto de A/B en una cosa: la bitácora (`identity.user_events`, ON DELETE CASCADE) de la que se funde NO se pierde:
 * se re-apunta al ganador, y el ganador recibe el asiento `identidad_fusionada`. Todo par se valida ANTES de mover
 * nada; uno que no cumple frena la corrida entera.
 */
function leerPares(argv) {
  const a = argv.find((x) => x.startsWith('--pares='));
  if (!a) return null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const pares = a.slice('--pares='.length).split(',').filter(Boolean).map((s) => {
    const [loser, winner] = s.split(':');
    if (!uuid.test(loser || '') || !uuid.test(winner || '') || loser === winner) throw new Error(`par inválido: «${s}» (va <sin_acceso>:<con_acceso>)`);
    return { loser, winner };
  });
  if (!pares.length) throw new Error('--pares vacío');
  const vistos = new Set();
  for (const p of pares) {
    if (vistos.has(p.loser)) throw new Error(`la misma identidad sin acceso aparece dos veces: ${p.loser}`);
    vistos.add(p.loser);
  }
  return pares;
}

async function validarPares(trx, pares) {
  const ids = [...new Set(pares.flatMap((p) => [p.loser, p.winner]))];
  // `whereIn`, no `= ANY(?)`: knex expande un arreglo dentro de un `?` y el SQL no compila.
  const rows = await trx('identity.users').where({ tenant_id: TENANT }).whereIn('id', ids)
    .select(trx.raw('id::text AS id'), 'role_name', 'status', 'nombre', 'deleted_at');
  const u = new Map(rows.map((r) => [r.id, r]));
  const errores = [];
  for (const p of pares) {
    const l = u.get(p.loser); const w = u.get(p.winner);
    if (!l || l.deleted_at) errores.push(`${p.loser}: no existe o ya está borrada`);
    else if (l.role_name !== 'sin_acceso') errores.push(`${p.loser}: tiene acceso (${l.role_name}); sólo se funde la sin_acceso`);
    if (!w || w.deleted_at) errores.push(`${p.winner}: no existe o está borrada`);
    else if (w.role_name === 'sin_acceso') errores.push(`${p.winner}: es sin_acceso; el ganador es la cuenta CON acceso`);
  }
  if (errores.length) throw new Error(`pares que no cumplen — no se mueve nada:\n  ${errores.join('\n  ')}`);
  return u;
}

async function fusionarPares(trx, pares, fkcols, log) {
  const u = await validarPares(trx, pares);
  const tally = {};
  let borrados = 0;
  for (const p of pares) {
    await reasignar(trx, fkcols, p.loser, p.winner, tally);
    const ev = await trx.raw(`UPDATE identity.user_events SET user_id = ? WHERE user_id = ?`, [p.winner, p.loser]);
    if (ev.rowCount) tally['identity.user_events.user_id (bitácora)'] = (tally['identity.user_events.user_id (bitácora)'] || 0) + ev.rowCount;
    await trx('identity.user_events').insert({
      tenant_id: TENANT, user_id: p.winner, event: 'identidad_fusionada',
      detalle: JSON.stringify({ fusionada: p.loser, nombre_fusionado: u.get(p.loser).nombre, motivo: '[RH.21] H4: misma persona con dos identidades, confirmada por Edgar' }),
      actor_username: 'fusion-usuarios-mega-talento.js --pares',
    });
    const d = await trx.raw(`DELETE FROM identity.users WHERE id = ? AND tenant_id = ?::uuid`, [p.loser, TENANT]);
    borrados += d.rowCount || 0;
  }
  log(`\nPARES CONFIRMADOS: ${pares.length} fusión(es), ${borrados} identidad(es) sin acceso borrada(s).`);
  for (const [k, v] of Object.entries(tally).sort()) log(`  reasignado  ${k.padEnd(44)} ${v}`);
  // Testigo: ninguna referencia de hr apunta ya a una identidad fundida.
  const losers = pares.map((p) => p.loser);
  const q = {
    enrol: Number((await trx('hr.device_enrollments').whereIn('user_id', losers).count({ n: '*' }))[0].n),
    quedan: Number((await trx('identity.users').whereIn('id', losers).count({ n: '*' }))[0].n),
  };
  log(`  testigo: enrolamientos que aún apuntan a una fundida = ${q.enrol} · identidades fundidas que quedan = ${q.quedan}`);
  if (q.enrol || q.quedan) throw new Error('el testigo no dio cero: se deshace todo');
  return { pares: pares.length, borrados, tally };
}

async function main() {
  const aplicar = process.argv.includes('--aplicar');
  const paresConfirmados = leerPares(process.argv);
  try { require('dotenv').config({ path: process.env.DOTENV_PATH || path.resolve(__dirname, '../../../.env') }); } catch { /* en el pod no hay .env */ }
  const url = process.env.CARGA_URL;
  if (!url) throw new Error('Falta CARGA_URL (dentro del pod: CARGA_URL="$DATABASE_URL_NEW"). Ver RH_CORTE_ASISTENCIA.md §1.');

  const knex = require('knex')({ client: 'pg', connection: url, pool: { min: 0, max: 1 } });
  const DESHACER = new Error('ensayo');
  try {
    // Destino = prod, por identidad del clúster (no por el nombre de la base).
    const { rows: [id] } = await knex.raw(
      'SELECT (SELECT system_identifier::text FROM pg_control_system()) AS id, current_database() AS db');
    if (id.id !== PROD_CLUSTER_ID) {
      throw new Error(`DESTINO EQUIVOCADO — no se escribe nada. Clúster ${id.id} (base "${id.db}"), se esperaba ${PROD_CLUSTER_ID}.`);
    }
    console.log(`destino verificado: prod (clúster ${id.id}, base "${id.db}")`);
    console.log(`Fusión de usuarios mt de Mega Talento → ${aplicar ? 'SE APLICA' : 'ENSAYO (se deshace al final)'}`);

    await knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
      const fkcols = await columnasFk(trx);
      console.log(`\n${fkcols.length} columnas FK (ON DELETE ≠ CASCADE, sin tenant_id) a recorrer por usuario.`);

      // `[RH.21]` Con --pares, SÓLO esos pares (A y B no corren).
      if (paresConfirmados) {
        await fusionarPares(trx, paresConfirmados, fkcols, console.log);
        if (!aplicar) throw DESHACER;
        return;
      }

      // A primero (borra sus mt); B se recalcula sobre los mt que quedan.
      const a = (await trx.raw(SQL_A)).rows;
      const ra = await fusionar(trx, a, fkcols, 'A · fusión a cuenta previa de la Suite', console.log);

      const b = (await trx.raw(SQL_B)).rows;
      const rb = await fusionar(trx, b, fkcols, 'B · colapso de duplicados mt↔mt (ficha de comida → activa)', console.log);

      const mtRestan = (await trx.raw(
        `SELECT count(*)::int n FROM identity.users WHERE tenant_id=?::uuid AND username LIKE 'mt.%' AND deleted_at IS NULL`,
        [TENANT])).rows[0].n;
      console.log(`\nCUADRE: borrados ${ra.borrados + rb.borrados} (A ${ra.borrados} + B ${rb.borrados}) · quedan ${mtRestan} usuarios mt.`);

      if (!aplicar) throw DESHACER;
    });
  } catch (e) {
    if (e !== DESHACER) throw e;
    console.log('\nEnsayo: no quedó nada escrito.');
  } finally {
    await knex.destroy();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}

module.exports = { SQL_A, SQL_B, columnasFk, reasignar, fusionar, leerPares, validarPares, fusionarPares, TENANT, PROD_CLUSTER_ID };
