/* eslint-disable no-console */
/**
 * [SD-CH] Preservar el canal `mayoreo` — quitar el remapeo `mayoreo→credito` del blend y de v_sellout_daily.
 *
 * ── POR QUÉ ─────────────────────────────────────────────────────────────────────────────────────
 * `mv_sales_blended` y `v_sellout_daily` re-mapean `mayoreo`(U-D-8, telemarketing) → `credito`, lo que
 * (1) esconde mayoreo ($9.9M/30d) y (2) inventa un canal `credito` que en realidad es telemarketing.
 * Decisión de Edgar ("opción a", SD-PAY): mayoreo es CANAL; el crédito es CONDICIÓN DE PAGO (ya modelada
 * en `mv_sales_payment_terms`). Y U-D-12 (lo que se llamaba `credito`) es "Factura Contado No Fiscal".
 *
 * ── QUÉ HACE (cambio quirúrgico) ────────────────────────────────────────────────────────────────
 * En la definición ACTUAL de cada objeto (así preserva el folio-counting de SD.4b en el blend), reemplaza
 *   WHEN 'mayoreo'::text THEN 'credito'::text   →   WHEN 'credito'::text THEN 'contado_nf'::text
 * Con eso `mayoreo` cae al ELSE (se preserva) y U-D-12 pasa de `credito` a `contado_nf`. Nada más cambia.
 *   1. v_sellout_daily: CREATE OR REPLACE VIEW (mismas columnas → barato, sin CASCADE) + REFRESH mv_sellout_monthly.
 *   2. mv_sales_blended: DROP + CREATE (no tiene dependientes) + 4 índices + grant + comment + REFRESH.
 *
 * ⚠️ Cambia lo que VE la pantalla: el desglose por canal pasa a mostrar `mayoreo` (~$9.9M) y `credito`
 *    baja a ~$0.13M rotulado `contado_nf`. Es la taxonomía CORRECTA, pero es visible → validación visual.
 *
 * ── NO es migrate.latest(). Recrear el blend (4.5M filas) + refrescar mv_sellout_monthly = minutos. Ventana.
 *   node database/scripts/may-preserve-mayoreo-channel.js          # dry-run: cuenta reemplazos + EXPLAIN
 *   node database/scripts/may-preserve-mayoreo-channel.js --apply  # aplica (en ventana)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { classify } = require('../../libs/platform-core/src/lib/provenance/target-guard.js');

const APPLY = process.argv.includes('--apply');
const REMAP_OLD = `WHEN 'mayoreo'::text THEN 'credito'::text`;
const REMAP_NEW = `WHEN 'credito'::text THEN 'contado_nf'::text`;

const BLEND_IDX = [
  `CREATE UNIQUE INDEX ux_mv_sales_blended ON analytics.mv_sales_blended (tenant_id, product_id, warehouse_id, channel, sale_date, unit_kind)`,
  `CREATE INDEX ix_mv_sales_blended_cover ON analytics.mv_sales_blended (tenant_id, sale_date) INCLUDE (channel, revenue, cost, units)`,
  `CREATE INDEX ix_mv_sales_blended_date ON analytics.mv_sales_blended (tenant_id, sale_date)`,
  `CREATE INDEX ix_mv_sales_blended_channel ON analytics.mv_sales_blended (tenant_id, channel, sale_date)`,
];

function url() {
  if (process.env.FLEET_DB_URL) return process.env.FLEET_DB_URL;
  const env = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8');
  const m = env.match(/^FLEET_DB_URL=(.*)$/m);
  if (!m) throw new Error('falta FLEET_DB_URL');
  return m[1].trim();
}
const count = (s, sub) => s.split(sub).length - 1;

(async () => {
  const u = url();
  if (classify(u).kind !== 'prod') { console.error('ABORT: destino no es prod'); process.exit(2); }
  const c = new Client({ connectionString: u, ssl: { rejectUnauthorized: false }, statement_timeout: 900000 });
  await c.connect();
  const q = (s) => c.query(s);
  const rows = (s) => c.query(s).then(r => r.rows);
  if ((await rows('select current_database() d'))[0].d !== 'railway') { console.error('ABORT !railway'); process.exit(2); }

  console.log(`\n=== SD-CH preservar mayoreo · ${APPLY ? 'APLICAR' : 'DRY-RUN'} ===\n`);

  const selloutDef = (await rows(`SELECT pg_get_viewdef('analytics.v_sellout_daily'::regclass, true) d`))[0].d;
  const blendDef = (await rows(`SELECT pg_get_viewdef('analytics.mv_sales_blended'::regclass, true) d`))[0].d;
  const nSell = count(selloutDef, REMAP_OLD);
  const nBlend = count(blendDef, REMAP_OLD);
  console.log(`reemplazos de "mayoreo→credito": v_sellout_daily=${nSell} · mv_sales_blended=${nBlend}`);
  if (nSell === 0 || nBlend === 0) { console.error('ABORT: no encontré el remapeo en alguno — la def cambió, revisar a mano.'); await c.end(); process.exit(2); }
  const newSellout = selloutDef.split(REMAP_OLD).join(REMAP_NEW);
  const newBlend = blendDef.split(REMAP_OLD).join(REMAP_NEW);

  if (!APPLY) {
    // Validar sin aplicar: EXPLAIN de los dos SELECT modificados (read-only, resuelve todo)
    let ok = 0, fail = 0;
    for (const [name, sel] of [['v_sellout_daily', newSellout], ['mv_sales_blended', newBlend]]) {
      try { await q('EXPLAIN ' + sel); console.log(`  ✔ EXPLAIN ${name} (modificado) OK`); ok++; }
      catch (e) { console.log(`  ✖ ${name}: ${e.message.split('\n')[0]}`); fail++; }
    }
    // split por canal ANTES (para comparar después)
    console.log('\ncanal ANTES (blend, 30d):');
    for (const r of await rows(`SELECT channel, round(sum(revenue))::numeric m FROM analytics.mv_sales_blended WHERE sale_date>=current_date-30 AND channel NOT LIKE 'wincaja_%' GROUP BY 1 ORDER BY 2 DESC`))
      console.log(`    ${String(r.channel).padEnd(12)} $${Number(r.m).toLocaleString()}`);
    console.log(`\n${ok}/2 EXPLAIN OK · ${fail} falla(s). ⛔ NO aplicado — corré con --apply en ventana.`);
    await c.end(); process.exit(fail ? 1 : 0);
  }

  console.log('[apply] v_sellout_daily: CREATE OR REPLACE VIEW…');
  await q(`CREATE OR REPLACE VIEW analytics.v_sellout_daily AS ${newSellout}`);
  console.log('[apply] REFRESH mv_sellout_monthly…');
  await q(`REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_sellout_monthly`);
  console.log('[apply] mv_sales_blended: DROP + CREATE…');
  await q('BEGIN'); await q(`SET LOCAL lock_timeout = '10s'`);
  await q(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_sales_blended`);
  await q(`CREATE MATERIALIZED VIEW analytics.mv_sales_blended AS ${newBlend} WITH NO DATA`);
  for (const ix of BLEND_IDX) await q(ix);
  await q(`GRANT SELECT ON analytics.mv_sales_blended TO app_runtime`);
  await q('COMMIT');
  console.log('[apply] REFRESH mv_sales_blended…');
  const t0 = Date.now();
  await q(`REFRESH MATERIALIZED VIEW analytics.mv_sales_blended`);
  console.log(`[apply] refresh OK en ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log('\ncanal DESPUÉS (blend, 30d) — debe mostrar mayoreo:');
  for (const r of await rows(`SELECT channel, round(sum(revenue))::numeric m FROM analytics.mv_sales_blended WHERE sale_date>=current_date-30 AND channel NOT LIKE 'wincaja_%' GROUP BY 1 ORDER BY 2 DESC`))
    console.log(`    ${String(r.channel).padEnd(12)} $${Number(r.m).toLocaleString()}`);
  console.log('\n✅ aplicado. Correr el candado: node database/tests/test-newdb-sales-lineage-parity.js (revenue/tickets no cambian; sólo la etiqueta de canal)');
  await c.end(); process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
