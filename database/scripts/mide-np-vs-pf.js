#!/usr/bin/env node
'use strict';
/**
 * `[PF.14]` — ¿Cuántos productos reciben de Productos nuevos (NP) y de Productos (PF) un veredicto de compra
 * CONTRADICTORIO? (NP.UI.3 / PF.UI.1: «un solo motor de decisión»; lo decide el PM.)
 *
 *   node database/scripts/mide-np-vs-pf.js                                   (base local)
 *   DATABASE_URL_NEW=<url-de-prod> node database/scripts/mide-np-vs-pf.js    (prod, sólo lectura)
 *   node database/scripts/mide-np-vs-pf.js --json                            (además, el detalle por producto)
 *
 * SÓLO LEE: cada consulta corre dentro de una transacción `READ ONLY` (Postgres rechaza cualquier escritura).
 * No es un importer ni guarda nada: llama a los DOS servicios reales (no a una copia de sus reglas) con el
 * mismo producto y compara lo que contestan.
 *
 * ## Qué cuenta como contradicción
 *   · `[NP.20]` (2026-11-03) NP YA NO da veredicto de compra: contesta «¿el lanzamiento funcionó?» (se queda ·
 *     revisar · sacar · agotado · pronto). Lo único que queda opuesto es «PF compra / NP sacar»: Productos pide
 *     reponer y el lanzamiento dejó de venderse con mercancía. El panel de NP lo explica (`cruceCompra`).
 *   · Antes de NP.20 se contaba «NP recompra / PF no compra» y «PF compra / NP esperar, revisar o no recomprar».
 *   · NP `pronto` (todavía no decide) y PF `sin_movimiento` no se cuentan: no hay veredicto que contradecir.
 *   · «PF mueve / NP recompra» se reporta aparte: no es lo mismo (PF dice que alcanza en la red).
 *
 * ## Control (la respuesta ya conocida)
 * El universo comparado es el de NP en seguimiento (los que tienen `recomendacion`). Si NP no está poblada
 * (`mv_new_products`), el script lo dice y sale 2 (NO MEDIDO): cero productos comparados no es «cero
 * contradicciones». Base local del 2026-11-03: la venta de Kepler llega al 23-oct, así que el ritmo de los
 * últimos 30 días de PF sale bajo — la cifra local mide el MECANISMO, no la magnitud de prod.
 */
const path = require('path');
const RAIZ = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(RAIZ, '.env'), quiet: true });
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2022', esModuleInterop: true, moduleResolution: 'node', rootDir: RAIZ,
    experimentalDecorators: true, emitDecoratorMetadata: true, useDefineForClassFields: false, ignoreDeprecations: '6.0' } });
const tsPaths = require('tsconfig-paths');
const cfg = tsPaths.loadConfig(path.join(RAIZ, 'tsconfig.base.json')); // JSON con comentarios: lo lee tsconfig-paths
tsPaths.register({ baseUrl: cfg.absoluteBaseUrl, paths: cfg.paths });
const knex = require('knex')(require('../knexfile-newdb.js').development);

const MEGA = '00000000-0000-0000-0000-00000000d01c';
const { NewProductsService } = require(path.join(RAIZ, 'libs/commercial/src/lib/commercial-products/new-products.service.ts'));
const { ProductFlowService } = require(path.join(RAIZ, 'libs/commercial/src/lib/commercial-products/product-flow.service.ts'));

/** El `TenantKnexService` real fija el tenant en una transacción; éste además la hace de SÓLO LECTURA. */
const tk = {
  run: (a, b) => {
    const cb = typeof a === 'string' ? b : a;
    return knex.transaction(async (trx) => {
      await trx.raw('SET TRANSACTION READ ONLY');
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [MEGA]);
      return cb(trx);
    });
  },
};
const tenantCtx = { requireTenantId: () => MEGA };

// [NP.20] NP ya no dice «comprar»: el conjunto queda vacío a propósito (nada de NP puede contradecir un «no comprar»).
const NP_COMPRA = new Set([]);
const NP_NO = new Set(['sacar']);
const PF_NO = new Set(['esperar', 'sobra', 'no_comprar']);

(async () => {
  const conn = new URL(process.env.DATABASE_URL_NEW || 'postgres://x@desconocido/x');
  const [id] = (await knex.raw('select system_identifier::text si, current_database() db from pg_control_system()')).rows;
  console.log(`\n[PF.14] NP contra PF — base «${id.db}» en ${conn.hostname} (system_identifier ${id.si})\n`);

  const np = new NewProductsService(tk, tenantCtx);
  const pf = new ProductFlowService(tk, tenantCtx, knex);
  const t0 = Date.now();
  const lista = await np.list({ puedeVerCosto: false });
  if (!lista.calculado) {
    console.log('  ⚪ NO MEDIDO — Productos nuevos no está poblada (mv_new_products): no hay universo que comparar.');
    await knex.destroy();
    process.exit(2);
  }
  const conVeredicto = lista.filas.filter((f) => f.recomendacion && f.recomendacion.veredicto !== 'pronto');
  console.log(`  universo: ${lista.filas.length} productos nuevos · ${conVeredicto.length} con veredicto de NP (sin «pronto»)`);
  if (!conVeredicto.length) {
    console.log('  ⚪ NO MEDIDO — ningún producto nuevo tiene veredicto todavía.');
    await knex.destroy();
    process.exit(2);
  }

  const pfPor = new Map();
  const pfTitulo = new Map();
  for (let i = 0; i < conVeredicto.length; i += 200) {
    const r = await pf.list(conVeredicto.slice(i, i + 200).map((f) => f.product_id), { puedeVerCosto: false });
    for (const x of r.productos) { pfPor.set(x.product_id, x.compra.veredicto); pfTitulo.set(x.product_id, x.compra.titulo); }
  }

  const tabla = {};
  const filas = [];
  let npCompraPfNo = 0, pfCompraNpNo = 0, pfMueveNpCompra = 0, sinPf = 0, comparables = 0;
  for (const f of conVeredicto) {
    const a = f.recomendacion.veredicto;
    const b = pfPor.get(f.product_id) ?? 'sin_dato_pf';
    tabla[a] = tabla[a] ?? {};
    tabla[a][b] = (tabla[a][b] ?? 0) + 1;
    if (b === 'sin_dato_pf' || b === 'sin_movimiento') { sinPf++; continue; }
    comparables++;
    let tipo = null;
    if (NP_COMPRA.has(a) && PF_NO.has(b)) { npCompraPfNo++; tipo = 'NP recompra / PF no compra'; }
    else if (b === 'comprar' && NP_NO.has(a)) { pfCompraNpNo++; tipo = 'PF compra / NP no'; }
    else if (NP_COMPRA.has(a) && b === 'traspasar') { pfMueveNpCompra++; tipo = 'NP recompra / PF mueve'; }
    if (tipo) filas.push({ sku: f.sku, nombre: f.nombre, np: a, np_motivo: f.recomendacion.motivos[0], pf: b, pf_titulo: pfTitulo.get(f.product_id), tipo });
  }

  console.log('\n  NP (renglón) × PF (columna):');
  console.table(tabla);
  console.log(`  comparables (con veredicto de los dos): ${comparables} · sin veredicto de PF: ${sinPf}`);
  console.log(`  ❗ contradicen:  NP recompra / PF no compra: ${npCompraPfNo} · PF compra / NP no: ${pfCompraNpNo}`);
  console.log(`  ⚠️  aparte:       NP recompra / PF mueve entre sucursales: ${pfMueveNpCompra}`);
  const total = npCompraPfNo + pfCompraNpNo;
  console.log(`  → ${total} de ${comparables} (${comparables ? Math.round((total / comparables) * 1000) / 10 : 0} %) con veredictos opuestos · ${Date.now() - t0} ms`);
  // Por qué contradicen: agrupado por el titulo de PF y el primer motivo de NP (sin cifras), para ver el MECANISMO.
  const porQue = {};
  for (const x of filas) { const k = String(x.pf_titulo).replace(/[0-9]+/g, 'N') + '  <>  ' + String(x.np_motivo).replace(/[0-9]+/g, 'N'); porQue[k] = (porQue[k] ?? 0) + 1; }
  console.log('\n  por qué (PF  <>  NP):');
  for (const [k, n] of Object.entries(porQue).sort((a, b) => b[1] - a[1])) console.log('   ' + String(n).padStart(4) + '  ' + k);
  if (process.argv.includes('--json')) console.log(JSON.stringify(filas, null, 1));
  await knex.destroy();
})().catch(async (e) => { console.error('❌ el script no pudo correr:', e.message); await knex.destroy().catch(() => undefined); process.exit(1); });
