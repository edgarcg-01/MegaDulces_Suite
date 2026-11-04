#!/usr/bin/env node
'use strict';
/**
 * `[PF.13]`/`[PF.15]` — El tamaño HOY de las observaciones de diseño de la Fase PF (plan, 2026-10-26) que dependen
 * de datos que sólo prod tiene completos. SÓLO LEE: todo corre en una transacción `READ ONLY`.
 *
 *   node database/scripts/check-pf-ui-prod.js                                   (base local: el CONTROL)
 *   DATABASE_URL_NEW=<url-de-prod> node database/scripts/check-pf-ui-prod.js    (prod)
 *
 * Usa las consultas REALES del servidor (`product-flow.sql.ts`), no una copia.
 *
 *   1. PF.UI.1 — lo que ya viene: órdenes de compra X-A-35 abiertas (criterio del Pedido) y la UNIDAD de su
 *      cantidad: ¿`c9 = c56 × c58` también en la OC, como en la venta? Si no, `TRANSITO_SQL` no está en la base.
 *   2. PF.UI.2 — «No se venden» que su sucursal cargó a camioneta en 30 días (lo que `[PF.15]` saca de la lista).
 *   3. PF.UI.3 — el total de «No se venden» contra el tope de la consulta (si lo alcanza, el total es un mínimo).
 *   4. PF.UI.9 — sucursal × producto con existencia NEGATIVA en Kepler que vendieron en 30 días: hoy salen «Agotado».
 *   5. PF.UI.7 — margen de 30 días sobre qué parte de la venta (cobertura del costo del renglón).
 *
 * Lo que no se puede medir se DECLARA (ADR-056): una consulta que truena sale «NO MEDIDO», nunca cero.
 * CONTROL (2026-11-03, base local): no hay ni un X-A-35 (bloque 1 = 0 órdenes, la identidad «sin renglones»),
 * 7 «No se venden» y Canindo con 194 cargas a camioneta hasta el 9-oct. Si en prod el bloque 1 diera 0 órdenes,
 * revisar la ingesta de X-A-35 antes de concluir «no hay tránsito».
 */
const path = require('path');
const RAIZ = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(RAIZ, '.env'), quiet: true });
require('ts-node').register({ transpileOnly: true, skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' } });
const SQL = require(path.join(RAIZ, 'libs/commercial/src/lib/commercial-products/product-flow.sql.ts'));
const knex = require('knex')(require('../knexfile-newdb.js').development);
const MEGA = '00000000-0000-0000-0000-00000000d01c';

let nomedido = 0;
async function leer(trx, nombre, sql, binds = []) {
  await trx.raw('SAVEPOINT m');
  const t0 = Date.now();
  try {
    const rows = (await trx.raw(sql, binds)).rows;
    await trx.raw('RELEASE SAVEPOINT m');
    return { rows, ms: Date.now() - t0 };
  } catch (e) {
    await trx.raw('ROLLBACK TO SAVEPOINT m');
    console.log(`  ⚪ NO MEDIDO — ${nombre}: ${String(e.message).split('\n')[0].slice(0, 160)}`);
    nomedido++;
    return null;
  }
}
const pesos = (v) => `$${Math.round(Number(v) || 0).toLocaleString('es-MX')}`;

(async () => {
  const trx = await knex.transaction();
  try {
    await trx.raw('SET TRANSACTION READ ONLY');
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [MEGA]);
    const [id] = (await trx.raw('select system_identifier::text si, current_database() db from pg_control_system()')).rows;
    const { hoy } = (await trx.raw(SQL.CORTE_SQL)).rows[0];
    console.log(`\n[PF.UI] Tamaño de las observaciones — base «${id.db}» (system_identifier ${id.si}) · hoy ${hoy}\n`);

    // ── 1. Lo que ya viene ─────────────────────────────────────────────────────────────
    console.log('1) PF.UI.1 — órdenes de compra abiertas (X-A-35, 120 días, sin entrada, estatus no F/C/R)');
    const oc = await leer(trx, 'OC abiertas', `
      SELECT count(DISTINCT (oc.sucursal, oc.folio))::int AS ordenes, count(DISTINCT l.sku)::int AS skus,
             count(*)::int AS renglones,
             count(DISTINCT (oc.sucursal, oc.folio)) FILTER (WHERE oc.dias_abierta <= 14)::int AS recientes,
             count(DISTINCT (oc.sucursal, oc.folio)) FILTER (WHERE oc.dias_abierta > 60)::int AS mas_de_60
        FROM analytics.erp_purchase_orders oc
        JOIN analytics.erp_purchase_doc_lines l ON l.doctype = 'XA3501' AND l.sucursal = oc.sucursal AND l.folio = oc.folio
       WHERE oc.tenant_id = ? AND oc.doc_date >= CURRENT_DATE - 120 AND NOT oc.cerrada AND oc.estatus NOT IN ('F', 'C', 'R')`, [MEGA]);
    if (oc) console.log(`   ${JSON.stringify(oc.rows[0])} · ${oc.ms} ms`);
    const ident = await leer(trx, 'identidad c9 = c56 × c58 en X-A-35', `
      SELECT count(*)::int AS renglones,
             count(*) FILTER (WHERE abs(${N('l.c9')} - ${N('l.c56')} * ${N('l.c58')}) < 0.001)::int AS cumple,
             count(*) FILTER (WHERE ${N('l.c58')} > 1)::int AS en_unidad_mayor
        FROM kepler_ods.kdm1 h
        JOIN kepler_ods.kdm2 l ON l.sucursal = h.sucursal AND l.c1 = h.c1 AND l.c2 = h.c2 AND l.c3 = h.c3 AND l.c4 = h.c4 AND l.c6 = h.c6
       WHERE h.c2 = 'X' AND h.c3 = 'A' AND btrim(h.c4::text) = '35' AND btrim(h.c1) = h.sucursal
         AND h.c9::date >= CURRENT_DATE - 120 AND ${N('l.c56')} IS NOT NULL AND ${N('l.c58')} IS NOT NULL`);
    if (ident) {
      const r = ident.rows[0];
      const pct = r.renglones ? Math.round((r.cumple / r.renglones) * 10000) / 100 : null;
      console.log(`   identidad c9 = c56 × c58: ${r.cumple} de ${r.renglones} (${pct ?? '—'} %) · en unidad mayor: ${r.en_unidad_mayor}`);
      if (!r.renglones) { console.log('   ⚪ NO MEDIDO — sin renglones de X-A-35 en la ventana'); nomedido++; }
      else console.log(pct >= 99 ? '   ✅ la cantidad de la OC está en la unidad base: TRANSITO_SQL suma bien' : '   ❌ la cantidad de la OC NO está en la base: corregir TRANSITO_SQL antes de publicar');
    }
    const t1 = await leer(trx, 'TRANSITO_SQL de un SKU con OC', `
      SELECT l.sku FROM analytics.erp_purchase_orders oc
        JOIN analytics.erp_purchase_doc_lines l ON l.doctype = 'XA3501' AND l.sucursal = oc.sucursal AND l.folio = oc.folio
       WHERE oc.tenant_id = ? AND oc.doc_date >= CURRENT_DATE - 120 AND NOT oc.cerrada AND oc.estatus NOT IN ('F', 'C', 'R')
       LIMIT 1`, [MEGA]);
    if (t1 && t1.rows[0]) {
      const r = await leer(trx, 'TRANSITO_SQL', SQL.TRANSITO_SQL, [t1.rows[0].sku]);
      if (r) console.log(`   TRANSITO_SQL del SKU ${t1.rows[0].sku}: ${r.rows.length} renglones en ${r.ms} ms (el detalle lo paga una vez)`);
    }

    // ── 2 y 3. «No se venden» y las camionetas ────────────────────────────────────────
    console.log('\n2) PF.UI.2 / PF.UI.3 — «No se venden» (30 días o más sin venta en la red)');
    const desde = new Date(Date.parse(`${hoy}T00:00:00Z`) - 365 * 864e5).toISOString().slice(0, 10);
    const tope = 1200;
    const ns = await leer(trx, 'NO_SE_VENDEN_SQL', SQL.NO_SE_VENDEN_SQL, [desde, 30, 90, 100000]);
    if (ns) {
      const filas = ns.rows;
      const valor = filas.reduce((a, f) => a + (Number(f.valor) || 0), 0);
      console.log(`   total sin tope: ${filas.length} productos · ${pesos(valor)} a costo estándar · ${ns.ms} ms`);
      console.log(filas.length >= tope ? `   ⚠️  pasa el tope de la consulta (${tope}): la pantalla publicaría un MÍNIMO` : `   ✅ cabe en el tope de la consulta (${tope})`);
      const d30 = new Date(Date.parse(`${hoy}T00:00:00Z`) - 30 * 864e5).toISOString().slice(0, 10);
      const ruta = await leer(trx, 'SALIDAS_RUTA_SQL', SQL.SALIDAS_RUTA_SQL, [d30, hoy, filas.map((f) => f.sku)]);
      if (ruta) {
        const skus = new Set(ruta.rows.map((r) => r.sku));
        const v = filas.filter((f) => skus.has(f.sku)).reduce((a, f) => a + (Number(f.valor) || 0), 0);
        const porPlaza = ruta.rows.reduce((m, r) => ((m[r.plaza] = (m[r.plaza] || 0) + 1), m), {});
        console.log(`   cargados a camioneta en 30 días: ${skus.size} productos · ${pesos(v)} · por sucursal ${JSON.stringify(porPlaza)} · ${ruta.ms} ms`);
        console.log('   → con [PF.15] salen de «No se venden» y se cuentan aparte (por_camioneta)');
      }
    }
    const cargas = await leer(trx, 'cargas a camioneta por sucursal (30 días)', `
      SELECT btrim(h.sucursal) AS plaza, count(*)::int AS cargas, to_char(max(h.c9::date), 'YYYY-MM-DD') AS ultima
        FROM kepler_ods.kdm1 h
       WHERE h.c2 = 'U' AND h.c3 = 'D' AND h.c4::integer = 41 AND btrim(h.c1) = btrim(h.sucursal)
         AND btrim(h.c10) ~* '^(RUTA|RD) ' AND h.c9::date >= CURRENT_DATE - 30
       GROUP BY 1 ORDER BY 1`);
    if (cargas) console.log(`   cargas a camioneta (U-D-41 a RUTA/RD) por sucursal: ${JSON.stringify(cargas.rows)}`);

    // ── 4. Negativos en Kepler ─────────────────────────────────────────────────────────
    console.log('\n3) PF.UI.9 — existencia NEGATIVA en Kepler con venta en 30 días (hoy la pantalla dice «Agotado»)');
    const neg = await leer(trx, 'negativos', `
      WITH ex AS (
        SELECT btrim(k.c3) AS sku, k.sucursal AS plaza, sum(k.c4 + k.c8 - k.c9) AS q
          FROM kepler_ods.kdil k WHERE k.sucursal = k.c1 GROUP BY 1, 2),
      v AS (
        SELECT p.sku, s.source_branch AS plaza, sum(s.monto) AS monto
          FROM analytics.mv_kepler_sales_daily s JOIN catalog.products p ON p.id = s.product_id
         WHERE s.tenant_id = ? AND s.business_date >= CURRENT_DATE - 30 AND s.units > 0 GROUP BY 1, 2)
      SELECT count(*) FILTER (WHERE ex.q < 0)::int AS negativos, count(*) FILTER (WHERE ex.q = 0)::int AS en_cero,
             count(*) FILTER (WHERE ex.q < 0 AND ex.plaza = '00')::int AS negativos_cedis
        FROM v JOIN ex ON ex.sku = v.sku AND ex.plaza = v.plaza`, [MEGA]);
    if (neg) console.log(`   ${JSON.stringify(neg.rows[0])} · ${neg.ms} ms`);

    // ── 5. Cobertura del margen ───────────────────────────────────────────────────────
    console.log('\n4) PF.UI.7 — margen real de 30 días: ¿sobre qué parte de la venta?');
    const d30 = new Date(Date.parse(`${hoy}T00:00:00Z`) - 30 * 864e5).toISOString().slice(0, 10);
    const ids = await leer(trx, 'productos con venta', `
      SELECT DISTINCT product_id::text AS id FROM analytics.mv_erp_margin_daily
       WHERE tenant_id = ? AND sale_date >= ?::date AND sale_date < ?::date AND NOT es_ruta`, [MEGA, d30, hoy]);
    if (ids) {
      const mg = await leer(trx, 'MARGEN_LISTA_SQL', SQL.MARGEN_LISTA_SQL, [d30, hoy, ids.rows.map((r) => r.id)]);
      if (mg) {
        const c = mg.rows.filter((r) => Number(r.n) > 0).map((r) => Number(r.nc) / Number(r.n));
        const tramo = (a, b) => c.filter((x) => x >= a && x < b).length;
        console.log(`   productos con venta: ${c.length} · cobertura <50 %: ${tramo(0, 0.5)} · 50–90 %: ${tramo(0.5, 0.9)} · ≥90 %: ${tramo(0.9, 9)} · ${mg.ms} ms`);
      }
    }
  } finally {
    await trx.rollback().catch(() => undefined);
    await knex.destroy();
  }
  console.log(nomedido ? `\n⚪ ${nomedido} cosa(s) NO MEDIDA(s)` : '\n✅ todo medido');
  process.exit(nomedido ? 2 : 0);
})().catch((e) => { console.error('❌ el script no pudo correr:', e.message); process.exit(1); });

function N(c) { return `nullif(regexp_replace(${c}::text, '[^0-9.-]', '', 'g'), '')::numeric`; }
