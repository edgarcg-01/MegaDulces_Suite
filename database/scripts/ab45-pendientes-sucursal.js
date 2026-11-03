'use strict';

/**
 * [AB.45] Pendientes de la sucursal — ejercer las consultas del registro contra pg-prod, SÓLO LECTURA.
 *
 * Carga `sucursal-pendientes.sql.ts` TAL CUAL (jiti), no una copia: lo que se mide es lo que corre.
 * Por cada sucursal de la red y cada consulta: total, días de la más vieja y milisegundos. Una
 * consulta que falla se reporta (no se cuenta como cero).
 *
 * Uso: node database/scripts/ab45-pendientes-sucursal.js     (lee PROD_DB_URL del .env)
 */
const path = require('path');
const R = path.join(__dirname, '..', '..');
require(path.join(R, 'node_modules/dotenv')).config({ path: path.join(R, '.env'), quiet: true });
const jiti = require(path.join(R, 'node_modules/jiti'))(__filename);
const SQL = jiti(path.join(R, 'libs/commercial/src/lib/commercial-replenishment/sucursal-pendientes.sql.ts'));
const knex = require(path.join(R, 'node_modules/knex'))({ client: 'pg', connection: process.env.PROD_DB_URL, pool: { min: 0, max: 1 } });
const T = '00000000-0000-0000-0000-00000000d01c';
const llave = `CASE WHEN w.code ~ '^[0-9]{2}$' THEN w.code ELSE w.wincaja_source_branch END`;

(async () => {
  const consultas = Object.entries(SQL).filter(([k, v]) => k.startsWith('SQL_') && typeof v === 'string');
  await knex.transaction(async (trx) => {
    await trx.raw('SET TRANSACTION READ ONLY');
    await trx.raw("SET LOCAL statement_timeout = '30s'");
    const { rows: sid } = await trx.raw('SELECT system_identifier::text AS s FROM pg_control_system()');
    console.log('system_identifier', sid[0].s, '·', consultas.length, 'consultas');
    const { rows: almacenes } = await trx.raw(
      `SELECT w.id::text AS wh, w.name, ${llave} AS suc, COALESCE(NULLIF(btrim(w.kepler_code), ''), w.code) AS kc
         FROM commercial.warehouses w
        WHERE w.tenant_id = ? AND w.deleted_at IS NULL AND w.active AND (${llave}) ~ '^[0-9]{2}$'
        ORDER BY 3`, [T]);
    // `:sucs` con la MISMA consulta que usa el servicio.
    for (const a of almacenes) a.sucs = (await trx.raw(SQL.SUCURSALES_DEL_ALMACEN_SQL, { t: T, wh: a.wh })).rows[0].sucs;
    const tabla = {};
    const lento = {};
    for (const [k, sql] of consultas) {
      tabla[k] = {};
      for (const a of almacenes) {
        const t0 = Date.now();
        try {
          await trx.raw('SAVEPOINT q');
          // `envolver` = lo MISMO que corre el servicio (consulta + días), no la consulta suelta.
          const { rows } = await trx.raw(SQL.envolver(sql), { t: T, wh: a.wh, suc: a.suc, kc: a.kc, sucs: a.sucs });
          const ms = Date.now() - t0;
          lento[k] = Math.max(lento[k] || 0, ms);
          tabla[k][a.name] = rows.length ? `${rows[0].total}${rows[0].dias != null ? ` (${rows[0].dias}d)` : ''}` : 0;
        } catch (e) {
          await trx.raw('ROLLBACK TO SAVEPOINT q');
          tabla[k][a.name] = 'ERR ' + e.message.slice(0, 80);
        }
      }
    }
    for (const [k, fila] of Object.entries(tabla)) {
      console.log(`${k.padEnd(30)} ${String(lento[k] ?? '-').padStart(5)} ms máx · ` +
        Object.entries(fila).map(([n, v]) => `${n}: ${v}`).join(' | '));
    }
  });
  await knex.destroy();
})().catch(async (e) => { console.error('ERR', e.message); await knex.destroy(); process.exit(1); });
