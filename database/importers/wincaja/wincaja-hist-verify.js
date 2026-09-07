/* eslint-disable no-console */
'use strict';
/**
 * Fase WR-hist — VERIFICACIÓN del espejo histórico Wincaja (`hNN.*` en `:5433/wincaja`).
 *
 * Dos chequeos independientes, porque uno solo no alcanza:
 *
 *  A) INTEGRIDAD interna — `ods.wincaja_hist_load.rows_read` (lo que el COPY dijo haber metido)
 *     contra `count(*)` real de la partición en el espejo. Detecta pérdida silenciosa. Un delta
 *     NEGATIVO chico es esperable y sano: las tablas sin PK se identifican por `_row_hash`, así que
 *     filas byte-idénticas (típicamente renglones en $0) colapsan — el mismo −1..−15 documentado en
 *     el carril vivo (FASE_WR §12).
 *
 *  B) CRUCE CONTRA PROD — los mismos cortes ya viven en el bronze `wincaja.*` de Railway, cargados
 *     por OTRO pipeline (`import-wincaja.js`, lector Jet). Comparar Σ de dinero y de piezas por
 *     sucursal es la única verificación realmente independiente que tenemos: si dos lectores
 *     distintos, sobre el mismo `.mdb`, dan el mismo peso, los dos están bien. Requiere
 *     `FLEET_DB_URL` (prod). Se saltea con `--no-prod`.
 *
 * Uso:
 *   node database/importers/wincaja/wincaja-hist-verify.js                    # todo lo cargado
 *   node database/importers/wincaja/wincaja-hist-verify.js --dataset=2025
 *   node database/importers/wincaja/wincaja-hist-verify.js --branch=44 --no-prod
 */
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });
const CFG = require('./wincaja-hist-config');

const argv = process.argv.slice(2);
const val = (n) => (argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || null;
const NO_PROD = argv.includes('--no-prod');
const DATASET = val('dataset');
const BRANCH = val('branch');
const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';

/** Σ de control por tabla: la columna que representa dinero o piezas y hay que cuadrar. */
const CONTROL = {
  DetallesMovAlmacen: ['ValorVenta', 'CantidadRegular'],
  Precios: ['Precio'],
  Existencias: ['Existencia'],
  PagosDia: ['Importe'],
  MovimientoClientes: ['Importe'],
};
/** Equivalente en el bronze de prod (snake_case) para el cruce B. */
const PROD_MAP = {
  DetallesMovAlmacen: { table: 'detalles_mov_almacen', cols: { ValorVenta: 'valor_venta', CantidadRegular: 'cantidad_regular' } },
  Precios: { table: 'precios', cols: { Precio: 'precio' } },
  Existencias: { table: 'existencias', cols: { Existencia: 'existencia' } },
};
/** El corte local `Actuales`/`Concentradas` se llama `actual`/`concentrada` en el bronze. */
const datasetToProd = (d) => ({ Actuales: 'actual', Concentradas: 'concentrada' }[d] || d);

(async () => {
  const c = new Client({ connectionString: CFG.REPLICA_URL, statement_timeout: 0 });
  await c.connect();

  const where = ['status = \'ok\''];
  const params = [];
  if (DATASET) { params.push(DATASET); where.push(`dataset = $${params.length}`); }
  if (BRANCH) { params.push(CFG.histSchema(BRANCH)); where.push(`schema_name = $${params.length}`); }
  const led = await c.query(
    `SELECT schema_name, dataset, table_name, rows_read FROM ods.wincaja_hist_load
      WHERE ${where.join(' AND ')} ORDER BY dataset, schema_name, table_name`, params);
  if (!led.rowCount) { console.log('no hay nada cargado que verificar (¿corriste import-wincaja-hist.js --apply?)'); await c.end(); return; }

  console.log(`\n=== A) INTEGRIDAD — ledger vs espejo (${led.rowCount} particiones tabla×corte) ===`);
  let bad = 0; let collapsed = 0; let okN = 0;
  const perUnit = new Map();
  for (const r of led.rows) {
    let real = 0;
    try {
      real = Number((await c.query(
        `SELECT count(*)::bigint n FROM ${q(r.schema_name)}.${q(r.table_name)} WHERE _dataset = $1`, [r.dataset])).rows[0].n);
    } catch (e) { console.log(`  ✖ ${r.schema_name}.${r.table_name} [${r.dataset}]: ${e.message.slice(0, 90)}`); bad++; continue; }
    const read = Number(r.rows_read || 0);
    const d = real - read;
    const key = `${r.dataset}|${r.schema_name}`;
    const acc = perUnit.get(key) || { read: 0, real: 0, tables: 0, collapsed: 0, over: 0 };
    acc.read += read; acc.real += real; acc.tables++;
    if (d < 0) { acc.collapsed += -d; collapsed++; }
    if (d > 0) { acc.over++; bad++; console.log(`  ✖ ${r.schema_name}.${r.table_name} [${r.dataset}]: espejo ${real} > leídas ${read} (+${d}) — DUPLICADO`); }
    else okN++;
    perUnit.set(key, acc);
  }
  console.log(`  ${okN} particiones sanas · ${collapsed} con filas colapsadas por _row_hash (esperado) · ${bad} con problema`);
  const worst = [...perUnit.entries()].filter(([, a]) => a.collapsed > 0)
    .sort((a, b) => b[1].collapsed - a[1].collapsed).slice(0, 8);
  if (worst.length) {
    console.log('\n  colapso por unidad (filas byte-idénticas, normalmente renglones en $0):');
    for (const [k, a] of worst) {
      const pct = a.read ? (a.collapsed / a.read * 100).toFixed(3) : '0';
      console.log(`    ${k.padEnd(24)} leídas ${a.read.toLocaleString().padStart(10)} · espejo ${a.real.toLocaleString().padStart(10)} · −${a.collapsed} (${pct}%)`);
    }
  }

  console.log(`\n=== Σ de control por corte × sucursal (espejo local) ===`);
  const units = [...new Set(led.rows.map((r) => `${r.dataset}|${r.schema_name}`))];
  const sums = [];
  for (const u of units) {
    const [dataset, schema] = u.split('|');
    const row = { corte: dataset, schema };
    for (const [tbl, cols] of Object.entries(CONTROL)) {
      for (const col of cols) {
        try {
          const r = await c.query(
            `SELECT round(sum(${q(col)}), 2) s FROM ${q(schema)}.${q(tbl)} WHERE _dataset = $1`, [dataset]);
          if (r.rows[0].s !== null) row[`${tbl}.${col}`] = r.rows[0].s;
        } catch { /* la tabla o la columna no existe en ese corte */ }
      }
    }
    sums.push(row);
  }
  console.table(sums.slice(0, 40));
  if (sums.length > 40) console.log(`  … +${sums.length - 40} unidades más`);

  if (NO_PROD || !process.env.FLEET_DB_URL) {
    console.log('\n(B) cruce contra prod: saltado' + (NO_PROD ? ' por --no-prod' : ' — falta FLEET_DB_URL'));
    await c.end(); return;
  }

  console.log(`\n=== B) CRUCE CONTRA PROD — espejo local (mdbtools) vs bronze Railway (Jet) ===`);
  const p = new Client({ connectionString: process.env.FLEET_DB_URL, statement_timeout: 300000 });
  await p.connect();
  let cmp = 0; let match = 0;
  try {
    for (const u of units) {
      const [dataset, schema] = u.split('|');
      const branch = schema.replace(/^h/, '');
      const prodDs = datasetToProd(dataset);
      for (const [tbl, meta] of Object.entries(PROD_MAP)) {
        for (const [localCol, prodCol] of Object.entries(meta.cols)) {
          let loc; let pro;
          try {
            loc = (await c.query(`SELECT round(sum(${q(localCol)}),2) s, count(*)::bigint n
              FROM ${q(schema)}.${q(tbl)} WHERE _dataset = $1`, [dataset])).rows[0];
          } catch { continue; }
          if (loc.s === null) continue;
          try {
            pro = (await p.query(`SELECT round(sum(${prodCol})::numeric,2) s, count(*)::bigint n
              FROM wincaja.${meta.table} WHERE source_branch = $1 AND source_dataset = $2`, [branch, prodDs])).rows[0];
          } catch { continue; }
          if (pro.s === null) { console.log(`  ~ ${branch}/${dataset} ${tbl}.${localCol}: prod no tiene ese corte`); continue; }
          cmp++;
          const dl = Number(loc.s) - Number(pro.s);
          const ok = Math.abs(dl) < 0.01;
          if (ok) match++;
          console.log(`  ${ok ? '✓' : '✖'} ${branch}/${dataset} ${(tbl + '.' + localCol).padEnd(34)}`
            + ` local ${Number(loc.s).toLocaleString().padStart(16)} (${loc.n})`
            + ` · prod ${Number(pro.s).toLocaleString().padStart(16)} (${pro.n})`
            + (ok ? '' : ` · Δ ${dl.toFixed(2)}`));
        }
      }
    }
  } finally { await p.end(); }
  console.log(`\n  ${match}/${cmp} Σ coinciden al centavo entre los dos pipelines`);
  await c.end();
  if (bad || (cmp && match < cmp)) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
