/* eslint-disable no-console */
/**
 * `[CPA.0.2]` — Refresca `analytics.mv_contpaqi_cierre_mensual`, el semáforo de cierre contable.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * Medido contra prod el 2026-10-12 sobre 9 corridas: **la consulta real del servicio** —`SELECT *`
 * de 13 meses con `ORDER BY`, que es lo que de verdad corre la pantalla— mide **900–1,291 ms**,
 * mediana **1,078**. El gate del proyecto son 500. Antes de materializar se probaron y
 * **descartaron** dos optimizaciones de SQL; el detalle con sus números está en la migración
 * `20261012081551_cierre_mensual_matview.js`.
 *
 * ── Lo que este carril DECLARA (ADR-053) ────────────────────────────────────────────────────
 * El latido reporta **filas entregadas**, no "el proceso corrió". Una matvista que dejó de
 * refrescarse sirve un veredicto viejo **sin un solo error** — y en un semáforo de cierre eso se
 * lee como "todo en orden", que es la peor lectura posible. Por eso:
 *   · si la matvista **no existe** todavía, sale `ok` con nota y NO se pone rojo (la migración
 *     puede no estar aplicada en ese entorno);
 *   · si queda en **CERO filas**, se reporta `error`: cero no es un refresh exitoso;
 *   · cada fila lleva `refrescado_en`, así que el consumidor puede declarar la edad del dato.
 *
 * ⚠️ `REFRESH CONCURRENTLY` y no a secas: un `REFRESH` normal toma `ACCESS EXCLUSIVE` y dejaría
 * la pantalla colgada en cada corrida. Exige el índice UNIQUE que crea la migración.
 *
 * ⚠️ Cadencia de 15 min, no de 1: las fuentes del semáforo son pólizas mensuales y movimientos de
 * banco; su veredicto cambia como mucho un par de veces al día. Refrescar cada minuto sería pagar
 * el cálculo 1,440 veces para publicar lo mismo — justo el defecto que `[CPU.3]` midió y corrigió
 * en el carril de Caja.
 *
 *   node database/importers/contpaqi/refresh-cierre-matview.js            # dry-run
 *   node database/importers/contpaqi/refresh-cierre-matview.js --apply
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const { Client } = require('pg');

/**
 * ⚠️ `.trim()` en cada argumento a propósito: `crontab.feeds` se exportó una vez con CRLF y
 * `argv.includes('--apply')` —comparación exacta— no matcheaba `--apply\r`, así que nueve
 * carriles corrieron EN SECO diciendo "ok" durante horas. Que no vuelva a depender de un \r.
 */
const APPLY = process.argv.slice(2).some((a) => a.trim() === '--apply');

const KEY = 'mv_cierre_refresh';
const MV = 'analytics.mv_contpaqi_cierre_mensual';
const DST = process.env.ODS_HB_URL || process.env.PROD_DB_URL || process.env.DATABASE_URL_NEW;

(async () => {
  if (!DST) { console.error('Falta PROD_DB_URL / DATABASE_URL_NEW.'); process.exit(1); }
  const hb = require(path.join(__dirname, '..', 'lib', 'cron-heartbeat'));
  await hb.begin(KEY, 'Cierre contable — matvista del semáforo (@15 min)').catch(() => {});

  const c = new Client({ connectionString: DST });
  const t0 = Date.now();
  try {
    await c.connect();
    await c.query("SET statement_timeout='120s'");

    const existe = (await c.query(`SELECT to_regclass('${MV}') AS t`)).rows[0].t;
    if (!existe) {
      // No es un fallo del carril: la migración puede no estar aplicada en este entorno.
      const nota = 'la matvista no existe todavía (migración 20261012081551 sin aplicar)';
      console.log(`[CPA.0.2] ${nota}`);
      await hb.end(KEY, { status: 'ok', rows: null, note: nota }).catch(() => {});
      return;
    }

    if (!APPLY) {
      const { rows } = await c.query(`SELECT count(*)::int AS n, max(refrescado_en) AS al FROM ${MV}`);
      console.log(`[CPA.0.2] DRY-RUN — ${rows[0].n} filas, refrescadas ${rows[0].al}. Con --apply se recalcula.`);
      await hb.end(KEY, { status: 'ok', rows: null, note: 'dry-run: no se refrescó' }).catch(() => {});
      return;
    }

    await c.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${MV}`);
    const { rows } = await c.query(`SELECT count(*)::int AS n FROM ${MV}`);
    const n = rows[0].n;
    const ms = Date.now() - t0;
    console.log(`[CPA.0.2] refrescada: ${n} filas en ${ms} ms`);

    if (n === 0) {
      // ⛔ Cero filas no es un refresh exitoso: es el semáforo quedándose mudo.
      await hb.end(KEY, { status: 'error', rows: 0, error: 'la matvista quedó en CERO filas' }).catch(() => {});
      process.exitCode = 1;
      return;
    }
    await hb.end(KEY, { status: 'ok', rows: n, note: `${ms} ms` }).catch(() => {});
  } catch (e) {
    console.error('[CPA.0.2] FALLO:', e.message);
    await hb.end(KEY, { status: 'error', error: e.message }).catch(() => {});
    process.exitCode = 1;
  } finally {
    try { await c.end(); } catch { /* nada que cerrar */ }
  }
})();
