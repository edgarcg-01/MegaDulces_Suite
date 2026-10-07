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
// [NORM.3] EL LATIDO QUE FALTABA. Este era el ÚNICO de los 17 carriles de `ops/vl/crontab.feeds`
// que no escribía en `analytics.cron_runs` — o sea, el único cuyo silencio era indistinguible de
// su buen funcionamiento. Y no es un carril cualquiera: refresca `mart.ventas`, que es la fuente
// de `mart.ventas_enriched`, que es de donde sale TODA la venta publicada (`analytics.sales_daily`
// → Command Center, sell-out, rentabilidad). Si esto se para, los carriles de aguas abajo siguen
// corriendo, siguen diciendo `ok` y siguen publicando — los mismos números de ayer.
// ⚠️ El latido viaja por `DATABASE_URL_NEW` (prod), que NO es el canal que vigila
// (`kepler_consolidado`): la regla de GOTCHAS §18, un latido no puede viajar por el canal que mide.
const hb = require('../lib/cron-heartbeat');
const HB_KEY = 'consolidado_refresh';
const HB_LABEL = 'Consolidado Kepler (mart.refresh_si_cambio)';

const URL = process.env.DATABASE_URL_KEPLER_CONSOLIDADO
  || 'postgresql://postgres:superoot@localhost:5433/kepler_consolidado';
const DAYS = Number(process.env.CONSOLIDADO_DAYS || 7);

// Watchdog: mate el proceso a los 90s pase lo que pase (no depende del ExecutionTimeLimit
// de la tarea, que un wscript detached puede evadir → fue lo que zombificó KP-Concentrate).
const HARD_KILL_MS = 90000;
// [NORM.3] El watchdog ahora DECLARA por qué murió antes de matar. Antes hacía `process.exit(1)`
// seco: el renglón quedaba en `running` para siempre y el tablero lo leía como "colgado", que es
// cierto pero no dice nada. Se le da 5 s para escribir el motivo y se mata igual — la promesa de
// "nunca un zombie" no se negocia, el latido no puede alargarle la vida al proceso.
const watchdog = setTimeout(() => {
  console.error(`⏱ watchdog: ${HARD_KILL_MS}ms sin terminar — mato el proceso (posible cuelgue de red/dblink).`);
  const matar = setTimeout(() => process.exit(1), 5000);
  matar.unref();
  hb.end(HB_KEY, { status: 'error', error: `watchdog: ${HARD_KILL_MS}ms sin terminar (posible cuelgue de red/dblink)` })
    .catch(() => {})
    .finally(() => process.exit(1));
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
  await hb.begin(HB_KEY, HB_LABEL);
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
    // ⚠️ "0 sucursales refrescadas" es ÉXITO, no falla: `refresh_si_cambio` sólo toca la sucursal
    // cuyo marcador cambió, y fuera de horario comercial lo normal es que no cambie ninguna. Por
    // eso el estado es `ok` con `rows` = filas realmente traídas, y la NOTA dice cuál fue cuál —
    // un `error` acá enseñaría a ignorar el tablero todas las noches.
    await hb.end(HB_KEY, {
      status: 'ok',
      rows: refreshed.reduce((s, r) => s + Number(r.filas || 0), 0),
      note: refreshed.length
        ? `${refreshed.length}/${res.rows.length} sucursales — ${refreshed.map((r) => `${r.sucursal}(${r.filas})`).join(', ')}`
        : `sin cambios (${res.rows.length} sucursales consultadas)`,
    });
  } catch (e) {
    console.error(`refresh-consolidado ERROR: ${e.message}`);
    await hb.end(HB_KEY, { status: 'error', error: e.message }).catch(() => {});
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    await c.end().catch(() => {});
  }
})();
