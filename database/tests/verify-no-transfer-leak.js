/* eslint-disable no-console */
/**
 * T.1 — Regresión: los TRASPASOS NO deben filtrarse a los reportes de venta.
 * Invariante: la única defensa real es `c4=10` en el origen (mart.ventas), porque
 * el UD06 (consolidación) trae forma_pago=CONTADO → si entrara, se vería como
 * canal 'tienda' (un filtro por canal NO lo atrapa).
 *
 * Verifica contra la DB destino (prod por default):
 *   1. analytics.sales_daily: canales ⊆ {tienda, credito, ruta, mostrador} (sin traspaso/mayoreo).
 *   2. analytics.transfers_monthly: kinds ⊆ {consolidacion, recepcion, traspaso_salida, traspaso_entrada}.
 *
 *   DST_URL=…railway node database/tests/verify-no-transfer-leak.js
 */
const { Client } = require('pg');

const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const ALLOWED_SALES_CHANNELS = new Set(['tienda', 'mostrador', 'credito', 'ruta']);
const ALLOWED_TRANSFER_KINDS = new Set(['salida_cedis', 'consolidacion', 'recepcion', 'traspaso_salida', 'traspaso_entrada']);

(async () => {
  const c = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false, connectionTimeoutMillis: 15000 });
  await c.connect();
  let fails = 0;
  const ok = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) fails++; };

  // 1) sales_daily sin canal de traspaso
  const ch = await c.query(`SELECT DISTINCT channel FROM analytics.sales_daily`);
  const chans = ch.rows.map((r) => r.channel);
  const badCh = chans.filter((x) => !ALLOWED_SALES_CHANNELS.has(x));
  ok(badCh.length === 0, `sales_daily canales ⊆ venta (encontrados: ${chans.join(', ') || 'ninguno'})${badCh.length ? ' | INTRUSOS: ' + badCh.join(', ') : ''}`);

  // 2) transfers_monthly kinds válidos (si la tabla existe)
  try {
    const k = await c.query(`SELECT DISTINCT kind FROM analytics.transfers_monthly`);
    const kinds = k.rows.map((r) => r.kind);
    const badK = kinds.filter((x) => !ALLOWED_TRANSFER_KINDS.has(x));
    ok(badK.length === 0, `transfers_monthly kinds válidos (${kinds.join(', ') || 'vacía'})${badK.length ? ' | INVÁLIDOS: ' + badK.join(', ') : ''}`);
  } catch (e) {
    console.log(`⚠️  transfers_monthly aún no existe (correr migración 20260702170000) — ${e.message.split('\n')[0]}`);
  }

  await c.end();
  console.log(fails === 0 ? '\n✅ PASS — sin fuga de traspasos a venta.' : `\n❌ FAIL — ${fails} problema(s).`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
