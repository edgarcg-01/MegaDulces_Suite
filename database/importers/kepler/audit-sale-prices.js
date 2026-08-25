/* eslint-disable no-console */
/**
 * AUDITORÍA full-catálogo del precio de venta. **NO es la vía de frescura.**
 *
 * El precio se recalcula AL MOMENTO vía hop-2: `normalizeSalePrice` está registrado en
 * `ODS_NORMALIZERS` para `kdm2` (una venta nueva → precio nuevo), `kdii` y `kdpv_prod_util`, así que
 * el CDC lo refleja en segundos y no hay cron de por medio
 * (regla `feedback_ods_derived_realtime_no_batch_lag`).
 *
 * Este script sirve para dos cosas:
 *   · sin flags: AUDITAR — cuánto del catálogo sale del PdV y cuánto del respaldo de configuración,
 *     qué se rechaza y por qué, y dónde lo publicado se aparta de lo que la caja cobra.
 *   · `--apply`: reconciliar a mano si el hop-2 se perdió algo (backfill, bug, caída).
 *
 * El cómputo NO vive acá: sale de `salePriceCtes` en `services/feeds-ingest/ods-derived.js`, la misma
 * definición que corre al-momento. Modelo de precios: `docs/IMPLEMENTACION/KEPLER_PRECIOS_MODELO.md`.
 *
 *   node database/importers/kepler/audit-sale-prices.js              # auditoría
 *   node database/importers/kepler/audit-sale-prices.js --rechazados # + lista completa
 *   node database/importers/kepler/audit-sale-prices.js --apply      # reconciliar
 */
const { Client } = require('pg');
const { salePriceCtes, normalizeSalePrice } = require('../../../services/feeds-ingest/ods-derived');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const VER_RECHAZOS = process.argv.includes('--rechazados');

const $ = (n) => (n === null || n === undefined ? '—' : `$${Number(n).toFixed(2)}`);
const num = (n) => Number(n || 0).toLocaleString('es-MX');

(async () => {
  const db = new Client({
    connectionString: DST,
    ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false,
    statement_timeout: 1800000,
  });
  await db.connect();
  try {
    console.log(`\n=== Precio de venta — auditoría full-catálogo (${APPLY ? 'APPLY' : 'SOLO LECTURA'}) ===`);
    console.log('    Fuente: lo que el PdV cobra (kdm2, docs de venta U-D-*, qty 1-2). Respaldo: PV configurado.\n');
    // 128MB y sin workers paralelos: con 512MB Railway truena por memoria compartida (/dev/shm).
    await db.query(`SET work_mem='128MB'`);
    await db.query(`SET max_parallel_workers_per_gather = 0`);
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE ev ON COMMIT DROP AS ${salePriceCtes(false)} SELECT * FROM evaluado`, [M]);

    const s = (await db.query(`
      SELECT count(*)::int total,
             count(*) FILTER (WHERE fuente='pos')::int del_pos,
             count(*) FILTER (WHERE fuente='config')::int del_cfg,
             count(*) FILTER (WHERE rechazo IS NOT NULL)::int rechazados
        FROM ev`)).rows[0];
    const pct = (n) => `${((100 * n) / Math.max(1, s.total)).toFixed(1)}%`;
    console.log(`Evaluados:  ${num(s.total)}`);
    console.log(`  del PUNTO DE VENTA ....... ${num(s.del_pos)}  ${pct(s.del_pos)}`);
    console.log(`  del respaldo de config ... ${num(s.del_cfg)}  ${pct(s.del_cfg)}`);
    console.log(`  rechazados ............... ${num(s.rechazados)}  (todos del respaldo; el PdV no se valida)`);
    (await db.query(`SELECT rechazo, count(*)::int n FROM ev WHERE rechazo IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`))
      .rows.forEach((r) => console.log(`     · ${String(r.rechazo).padEnd(18)} ${num(r.n)}`));

    const d = (await db.query(`
      SELECT count(*) FILTER (WHERE actual IS NULL)::int nuevos,
             count(*) FILTER (WHERE actual IS NOT NULL AND abs(precio-actual) < 0.005)::int iguales,
             count(*) FILTER (WHERE actual IS NOT NULL AND precio > actual + 0.005)::int suben,
             count(*) FILTER (WHERE actual IS NOT NULL AND precio < actual - 0.005)::int bajan
        FROM ev WHERE rechazo IS NULL`)).rows[0];
    console.log(`\nVs lo publicado hoy: ${num(d.iguales)} al día · ${num(d.suben)} suben · ${num(d.bajan)} bajan · ${num(d.nuevos)} sin precio`);

    const top = (await db.query(`
      SELECT sku, nombre, actual, precio, fuente, lineas_pos, pv, cost_base
        FROM ev WHERE rechazo IS NULL AND actual IS NOT NULL AND abs(precio-actual) >= 0.005
         AND fuente='pos'
       ORDER BY lineas_pos DESC NULLS LAST LIMIT 15`)).rows;
    if (top.length) {
      console.log('\n  Lo que el PdV cobra distinto de lo publicado (por volumen de líneas):');
      top.forEach((x) => console.log(`  ${x.sku.padEnd(7)} ${String(x.nombre).slice(0, 30).padEnd(30)} publicado ${$(x.actual).padStart(10)}` +
        ` → cobra ${$(x.precio).padStart(10)} · ${num(x.lineas_pos)} líneas · PV cfg ${$(x.pv)}`));
    }

    const rech = (await db.query(`
      SELECT sku, nombre, actual, pv, cost_base, tier_tope, rechazo
        FROM ev WHERE rechazo IS NOT NULL ORDER BY rechazo, sku ${VER_RECHAZOS ? '' : 'LIMIT 12'}`)).rows;
    if (rech.length) {
      console.log(`\n  Rechazados del respaldo — conservan su precio; se arreglan EN Kepler${VER_RECHAZOS ? '' : ' (primeros 12; --rechazados para todos)'}:`);
      rech.forEach((x) => console.log(`  ${String(x.rechazo).padEnd(17)} ${x.sku.padEnd(7)} ${String(x.nombre).slice(0, 28).padEnd(28)}` +
        ` PV ${$(x.pv).padStart(10)} · actual ${$(x.actual).padStart(10)} · costo ${$(x.cost_base).padStart(9)}` +
        `${x.tier_tope ? ` · escalón ${$(x.tier_tope)}` : ''}`));
    }
    await db.query('ROLLBACK');

    if (!APPLY) { console.log('\n[SOLO LECTURA] nada cambió.\n'); return; }

    const n = await normalizeSalePrice(db, M, null);
    console.log(`\n[APPLY] ${num(n)} precios reconciliados (churn-free) · ${num(s.rechazados)} rechazados.\n`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
  }
})();
