/**
 * CG.22.3 — Refresca `analytics.mv_caja_movimientos`, el corte de caja materializado.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * Medido contra prod el 2026-09-22: la bandeja de `/finanzas/caja-general` tardaba **415–720 ms
 * por consulta** tocando **~565,000 páginas de buffer**, porque `analytics.kepler_bank_movements`
 * tiene que leer las **651,450 filas / 567 MB** de `kepler_ods.kdm1` para clasificar cada
 * movimiento. Con la lista materializada, la misma consulta cuesta **0.4 ms y 99 páginas** —
 * 1,085× menos. El corte entero son 12,237 filas y armarlo cuesta ~0.5–2 s.
 *
 * Dos hipótesis más baratas se probaron y se REFUTARON antes de llegar a esto: un índice (existe
 * `idx_kdm1_tesoreria_c45` y con `enable_seqscan=off` el plan no cambia) y desmaterializar el CTE
 * `flj` (`NOT MATERIALIZED` salió PEOR: 501 ms y el doble de páginas). El detalle está en la
 * migración `20260923130000_mv_caja_movimientos.js`.
 *
 * ── Lo que este carril DECLARA ──────────────────────────────────────────────────────────────
 * El latido reporta **filas entregadas**, no "el proceso corrió" (ADR-053). Un matview que dejó
 * de refrescarse sirve datos viejos **sin un solo error**, y en una bandeja de caja eso se lee
 * como "no hay trabajo" — que es la peor lectura posible. Por eso:
 *   · si el matview no existe todavía, sale en `ok` con nota y NO se pone rojo (la migración
 *     puede no estar aplicada aún en ese entorno);
 *   · si queda en CERO filas, se reporta `error` — cero no es un refresh exitoso;
 *   · cada fila lleva `refrescado_en`, así que el consumidor puede declarar la edad del dato.
 *
 *   node database/importers/kepler/refresh-caja-matview.js --apply
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const { Client } = require('pg');

// ⚠️ `.trim()` en cada argumento a propósito: el `crontab.feeds` se exportó una vez con CRLF y
// `argv.includes('--apply')` —comparación exacta— no matcheaba `--apply\r`, así que NUEVE carriles
// corrieron en seco diciendo "ok" durante horas. Que no vuelva a depender de un retorno de carro.
const APPLY = process.argv.slice(2).some((a) => a.trim() === '--apply');
const KEY = 'mv_caja_refresh';
const MV = 'analytics.mv_caja_movimientos';

function conexion() {
  const cs = process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;
  if (!cs) throw new Error('sin DATABASE_URL_NEW/DATABASE_URL');
  return new Client({
    connectionString: cs,
    ssl: cs.includes('localhost') || cs.includes('pg-prod') ? false : { rejectUnauthorized: false },
    statement_timeout: 120000,
  });
}

async function ciclo() {
  const c = conexion();
  await c.connect();
  try {
    const existe = await c.query(`SELECT to_regclass($1) AS t`, [MV]);
    if (!existe.rows[0] || !existe.rows[0].t) {
      return { filas: null, nota: `${MV} todavía no existe (migración sin aplicar en este entorno)` };
    }

    const t0 = Date.now();
    // CONCURRENTLY para no tomar el lock exclusivo: sin esto la bandeja queda EN BLANCO mientras
    // corre el refresh. Requiere el índice UNIQUE que crea la migración.
    await c.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${MV}`);
    const ms = Date.now() - t0;

    const r = await c.query(`SELECT count(*)::int n, max(refrescado_en) AS al FROM ${MV}`);
    const filas = r.rows[0].n;
    if (!filas) throw new Error(`${MV} quedó con 0 filas: eso no es un refresh exitoso`);
    return { filas, ms, al: r.rows[0].al };
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
  await hb.begin(KEY, 'Caja — refresca mv_caja_movimientos').catch(() => {});
  try {
    const r = await ciclo();
    if (r.filas == null) {
      console.log(r.nota);
      await hb.end(KEY, { status: 'ok', rows: 0, note: r.nota }).catch(() => {});
      return;
    }
    console.log(`refrescado: ${r.filas} filas en ${r.ms} ms (al ${r.al})`);
    await hb.end(KEY, { status: 'ok', rows: r.filas }).catch(() => {});
  } catch (e) {
    console.error('falló:', e.message);
    await hb.end(KEY, { status: 'error', error: e.message }).catch(() => {});
    process.exitCode = 1;
  }
})();
