/**
 * [EX-PERF.2] Refresca las dos copias materializadas que usa `/compras/existencia`:
 * `analytics.mv_warehouse_box_factor` y `analytics.mv_kepler_unit_cost`.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * Medido contra prod el 2026-09-24: la pantalla tardaba **27 s de LCP**. La consulta —sacada del
 * log de Postgres con sus parámetros, no una parecida— tocaba **939,977 páginas (~7.5 GB) para
 * devolver 50 filas**, y dos de sus joins aportaban 281,730 de esas páginas porque las vistas se
 * calculaban ENTERAS en cada carga sólo para armar el hash:
 *
 *     v_warehouse_box_factor .... 194,173 paginas  ·  180,272 filas  ·  994 ms sola
 *     v_kepler_unit_cost ........  87,557 paginas  ·   28,138 filas  ·  500 ms sola
 *
 * Con las dos materializadas la consulta real bajó de **4,910 a 1,353 ms (3.6x)**, medido con
 * tablas TEMP dentro de un ROLLBACK **antes** de construir nada.
 *
 * ── Lo que este carril DECLARA ──────────────────────────────────────────────────────────────
 * El latido reporta **filas entregadas**, no "el proceso corrió" (ADR-053). Un materializado que
 * dejó de refrescarse sirve un factor de caja y un costo viejos **sin un solo error**, y eso en
 * una pantalla de compras vale dinero: el factor manda la cantidad que se pide y el costo, la
 * valuación del inventario. Por eso:
 *   · si los materializados no existen todavía, sale en `ok` con nota y NO se pone rojo (la
 *     migración puede no estar aplicada aún, y el servicio sabe leer las vistas vivas);
 *   · si alguno queda en CERO filas, se reporta `error` — cero no es un refresh exitoso;
 *   · la edad vive en `analytics.cron_run_log`, no en una columna de la vista.
 *
 * ⛔⛔ Ninguna de las dos trae columna de reloj, y se verificó antes de materializarlas.
 * `REFRESH ... CONCURRENTLY` compara la FILA COMPLETA con `(y.*) IS DISTINCT FROM (x.*)`: una
 * sola columna que cambie por construcción hace que el 100 % parezca distinto y CONCURRENTLY
 * termine aplicando la tabla entera. Le costó a `mv_caja_movimientos` 12.3 GB de WAL por día.
 *
 *   node database/importers/kepler/refresh-existencia-aux.js --apply
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const { Client } = require('pg');

// ⚠️ `.trim()` en cada argumento a propósito: el `crontab.feeds` se exportó una vez con CRLF y
// `argv.includes('--apply')` —comparación exacta— no matcheaba `--apply\r`, así que NUEVE carriles
// corrieron en seco diciendo "ok" durante horas. Que no vuelva a depender de un retorno de carro.
const APPLY = process.argv.slice(2).some((a) => a.trim() === '--apply');
const KEY = 'mv_existencia_aux_refresh';
const MVS = ['analytics.mv_warehouse_box_factor', 'analytics.mv_kepler_unit_cost'];

function conexion() {
  const cs = process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;
  if (!cs) throw new Error('sin DATABASE_URL_NEW/DATABASE_URL');
  return new Client({
    connectionString: cs,
    ssl: cs.includes('localhost') || cs.includes('pg-prod') ? false : { rejectUnauthorized: false },
    statement_timeout: 300000,
  });
}

async function ciclo() {
  const c = conexion();
  await c.connect();
  try {
    // ⛔ O las DOS o ninguna: el servicio decide por el par, no por cada una. Si sólo existiera
    // una, refrescarla dejaría al otro join leyendo la vista viva y el número de la pantalla
    // saldría de dos fotos con edades distintas.
    const falta = [];
    for (const mv of MVS) {
      const r = await c.query(`SELECT to_regclass($1) AS t`, [mv]);
      if (!r.rows[0] || !r.rows[0].t) falta.push(mv);
    }
    if (falta.length) {
      return { filas: null, nota: `sin materializar todavía: ${falta.join(', ')} (migración sin aplicar)` };
    }

    // JIT apagado por el mismo motivo medido en `[EX-PERF.1]`: a este volumen la compilación no
    // se amortiza (821 funciones para la consulta de la pantalla).
    await c.query(`SET jit = off`);

    let total = 0;
    const detalle = [];
    for (const mv of MVS) {
      const t0 = Date.now();
      // CONCURRENTLY para no tomar el lock exclusivo: sin esto la pantalla queda EN BLANCO
      // mientras corre. Requiere el índice UNIQUE que crea la migración.
      await c.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv}`);
      const ms = Date.now() - t0;
      const n = (await c.query(`SELECT count(*)::int n FROM ${mv}`)).rows[0].n;
      if (!n) throw new Error(`${mv} quedó con 0 filas: eso no es un refresh exitoso`);
      total += n;
      detalle.push(`${mv.split('.').pop()} ${n} en ${ms} ms`);
    }
    return { filas: total, detalle };
  } finally {
    await c.end().catch(() => {});
  }
}

(async () => {
  if (!APPLY) {
    console.log('dry-run: no se refresca nada. Agregá --apply.');
    return;
  }
  const hb = require(path.join(__dirname, '..', 'lib', 'cron-heartbeat'));
  await hb.begin(KEY, 'Existencia — refresca factor de caja y costo Kepler').catch(() => {});
  try {
    const r = await ciclo();
    if (r.filas == null) {
      console.log(r.nota);
      await hb.end(KEY, { status: 'ok', rows: 0, note: r.nota }).catch(() => {});
      return;
    }
    console.log(`refrescado: ${r.detalle.join(' · ')}`);
    await hb.end(KEY, { status: 'ok', rows: r.filas }).catch(() => {});
  } catch (e) {
    console.error('falló:', e.message);
    await hb.end(KEY, { status: 'error', error: e.message }).catch(() => {});
    process.exitCode = 1;
  }
})();
