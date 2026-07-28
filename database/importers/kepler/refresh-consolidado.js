/* eslint-disable no-console */
/**
 * Refresh del CONSOLIDADO Kepler (Docker :5433 / kepler_consolidado) → llama
 * `mart.refresh_si_cambio(7)` que trae por FDW las ventas nuevas de las 6 sucursales
 * a `mart.ventas` (base de lo que surte a prod).
 *
 * Antes esto lo hacía SOLO el `@Cron` del módulo NestJS `kepler-consolidado`, que vive
 * dentro del `nx serve api` on-prem → si se cerraba esa terminal, el consolidado dejaba
 * de refrescar EN SILENCIO. Este runner lo vuelve una tarea de Windows independiente
 * (`Kepler\RefreshConsolidado`, cada 2 min) → sobrevive a que se caiga el dev server.
 *
 * `refresh_si_cambio` hace DELETE-then-INSERT por rango y solo refresca la sucursal si
 * su marcador cambió → correrlo en paralelo con el @Cron NO duplica (el DELETE limpia
 * antes de insertar). Idempotente.
 *
 * WATCHDOG DURO: si algo se cuelga (VPN, dblink, lock), el proceso se autotermina a los
 * 90s pase lo que pase — así NUNCA queda un zombie bloqueando (lección KP-Concentrate).
 *
 *   DATABASE_URL_KEPLER_CONSOLIDADO = postgresql://...@localhost:5433/kepler_consolidado
 *   node database/importers/kepler/refresh-consolidado.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_KEPLER_CONSOLIDADO
  || 'postgresql://postgres:superoot@localhost:5433/kepler_consolidado';
const DAYS = Number(process.env.CONSOLIDADO_DAYS || 7);

// Watchdog: mate el proceso a los 90s pase lo que pase (no depende del ExecutionTimeLimit
// de la tarea, que un wscript detached puede evadir → fue lo que zombificó KP-Concentrate).
const HARD_KILL_MS = 90000;
const watchdog = setTimeout(() => {
  console.error(`⏱ watchdog: ${HARD_KILL_MS}ms sin terminar — mato el proceso (posible cuelgue de red/dblink).`);
  process.exit(1);
}, HARD_KILL_MS);
watchdog.unref();

(async () => {
  const c = new Client({
    connectionString: URL,
    connectionTimeoutMillis: 8000,
    statement_timeout: 60000, // refresh_si_cambio con FDW a 6 sucursales; 60s holgado
    query_timeout: 60000,
    keepAlive: true,
  });
  const t0 = Date.now();
  try {
    await c.connect();
    const res = await c.query('SELECT * FROM mart.refresh_si_cambio($1)', [DAYS]);
    const refreshed = res.rows.filter((r) => r.accion === 'REFRESCADO');
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    if (refreshed.length) {
      console.log(`[${stamp}] refresh OK (${Date.now() - t0}ms): ${refreshed.length} sucursal(es) — `
        + refreshed.map((r) => `${r.sucursal}(${r.filas})`).join(', '));
    } else {
      console.log(`[${stamp}] sin cambios (${Date.now() - t0}ms) — heartbeat actualizado.`);
    }
  } catch (e) {
    console.error(`refresh-consolidado ERROR: ${e.message}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    await c.end().catch(() => {});
  }
})();
