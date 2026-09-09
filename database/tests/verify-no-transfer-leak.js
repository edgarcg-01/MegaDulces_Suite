/* eslint-disable no-console */
/**
 * T.1 — Regresión: los TRASPASOS NO deben filtrarse a los reportes de venta.
 * Invariante: la defensa real vive en el corte de doctypes del origen (`mart.ventas`), porque
 * el UD06 (consolidación) trae forma_pago=CONTADO → si entrara, se vería como
 * canal 'tienda' (un filtro por canal NO lo atrapa).
 *
 * Verifica contra la DB destino (prod por default):
 *   1. analytics.sales_daily: los canales son de VENTA (nada de traspaso).
 *   2. analytics.transfers_monthly: kinds ⊆ {consolidacion, recepcion, traspaso_salida, traspaso_entrada}.
 *
 * ── ⭐ K.3 (2026-09-08): la lista blanca estaba desactualizada en DOS frentes ───────────────
 *
 * Este candado venía **rojo desde antes** de K.3, y no por un traspaso: por los cuatro canales
 * `wincaja_*` (mostrador/credito/ruta/preventa), que son venta real del POS Wincaja y llevan
 * meses en `sales_daily`. Un candado rojo permanente no vigila nada — se lee como ruido.
 *
 * Y `mayoreo`: la lista lo tenía como INTRUSO porque el único `mayoreo` que existía venía de la
 * rama `forma_pago LIKE 'TI%'`, que el comentario de `mart_ventas_enriched.sql` describía como
 * "transferencias/CEDIS mayoreo". Eso era correcto sobre `TI%` — medido en `kepler_ods.kdm1`
 * (nov-2025 → hoy): sus documentos U-D son 1,360 `U-D-40` **Pedido** y 1,254 `U-D-41`
 * **Embarque**, y `TI001`/`TI002` ni existen como clientes en `kdud`.
 *
 * Desde K.3 la ÚNICA vía a `mayoreo` es el doctype **`U-D-8`**, que el catálogo `kdmm` llama
 * literalmente **"Factura Telemarketing"** — una factura a un cliente, o sea VENTA (y es la
 * decisión de negocio de Edgar del 2026-09-02, ya horneada en `mv_kepler_sales_daily`). La rama
 * `TI%` se retiró del CASE, con delta medido cero. El traspaso de verdad es `U-D-13` ("Factura
 * Cred No Fiscal", el traspaso al CEDIS) y **sigue fuera del corte** — eso es lo que este
 * candado protege, y sigue protegiéndolo.
 *
 *   DST_URL=…railway node database/tests/verify-no-transfer-leak.js
 */
const { Client } = require('pg');

const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
// Canales de VENTA. `mayoreo` = U-D-8 Factura Telemarketing (K.3). Los `wincaja_*` son el POS.
const ALLOWED_SALES_CHANNELS = new Set([
  'tienda', 'mostrador', 'credito', 'ruta', 'mayoreo',
  'wincaja_mostrador', 'wincaja_credito', 'wincaja_ruta', 'wincaja_preventa',
]);
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
