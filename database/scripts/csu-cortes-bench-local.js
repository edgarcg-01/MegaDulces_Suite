/* eslint-disable no-console */
/**
 * `[CSU.10]` Banco de carga LOCAL de Cortes/Sucursales a ESCALA DE PROD: tiempo de la SQL de antes
 * contra la nueva sobre los mismos datos, más la paridad de salida a esa escala.
 *
 *   PGPASSWORD=… node database/scripts/csu-cortes-bench-local.js
 *   ESCALA=0.02 …   corrida corta (2 % de las filas) para probar el script
 *   [--antes=<ref git>]  versión vieja (default: la de antes de CSU.10)
 *
 * ⛔ Medir rendimiento contra una base VACÍA no es medir: todo responde en milisegundos. Esto carga
 * volúmenes tomados de mediciones de prod ya documentadas — `kdm1` ~726k filas / 567 MB (≈870 B por
 * fila, por eso el relleno de `c150`), `kdue` ~480k cargos, ~25k cobros, ~3.8k arqueos — con margen
 * porque las tablas crecen, y los 504 cortes de oct-2026 (la pantalla mostraba 501 el 20-oct).
 * Todo en UNA transacción con ROLLBACK (ANALYZE incluido): no deja filas. Sólo localhost.
 *
 * Lo que NO reproduce y se declara en el resultado: el hardware de `md`, la forma real de `kdud`
 * (clientes) y de los complementos de pago, y el resto de la API (alcance, serialización).
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const L = require('./_lib/csu-cortes-sql');

const ESC = Number(process.env.ESCALA || 1);
const ANTES = (process.argv.find((a) => a.startsWith('--antes=')) || '').slice(8) || L.ANTES_CSU10;
const T = L.TENANT;
const n = (x) => Math.max(1, Math.round(x * ESC));
const SQL_NOM = `SELECT warehouse_code, max(warehouse_name) AS nombre FROM analytics.cash_cuts WHERE tenant_id = $1::uuid GROUP BY 1`;

const CARGA = [
  ['setseed', `SELECT setseed(0.42)`],
  // kdm1: tickets U-D-10 (la gran masa), con relleno para pesar ~870 B/fila como en prod.
  ['kdm1 tickets', `INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c16, c150)
     SELECT s, s, 'U', 'D', 10, 1, lpad(i::text, 7, '0'), timestamp '2025-01-01' + random() * interval '659 days', round((random()*900)::numeric, 2), repeat('x', 700)
       FROM generate_series(1, ${n(780000)}) i, LATERAL (SELECT lpad(((i % 9))::text, 2, '0') s) z`],
  ['kdm1 compras', `INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c16, c150)
     SELECT s, s, 'X', 'A', 15, 1, lpad(i::text, 7, '0'), timestamp '2025-01-01' + random() * interval '659 days', round((random()*90000)::numeric, 2), repeat('x', 700)
       FROM generate_series(1, ${n(60000)}) i, LATERAL (SELECT lpad(((i % 9))::text, 2, '0') s) z`],
  // Cobros U-A-5 de la historia (lo que agrupa la vista erp_collections) y U-A-7 con complemento.
  ['kdm1 cobros', `INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c10, c16, c24, c32, c45, c150)
     SELECT s, s, 'U', 'A', 5, 1, lpad(i::text, 7, '0'), timestamp '2025-01-01' + random() * interval '659 days',
            'C' || lpad((i % 7000)::text, 5, '0'), round((random()*20000)::numeric, 2),
            (ARRAY['PAGO CON TARJETA','DEPOSITO BANCO','EFECTIVO','TRANSFERENCIA SPEI','CHEQUE'])[1 + (i % 5)], 'CLIENTE ' || i, ((i % 20) + 1)::text, repeat('x', 700)
       FROM generate_series(1, ${n(30000)}) i, LATERAL (SELECT lpad(((i % 9))::text, 2, '0') s) z`],
  ['kdm1 cobros cfdi', `INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c10, c16, c24, c32, c45, c150)
     SELECT s, s, 'U', 'A', 7, 1, lpad(i::text, 7, '0'), timestamp '2025-06-01' + random() * interval '500 days',
            'C' || lpad((i % 7000)::text, 5, '0'), round((random()*50000)::numeric, 2), 'PAGO FACTURA', 'CLIENTE ' || i, ((i % 20) + 1)::text, repeat('x', 700)
       FROM generate_series(1, ${n(4000)}) i, LATERAL (SELECT lpad(((i % 9))::text, 2, '0') s) z`],
  ['kdfe33pagm1', `INSERT INTO kepler_ods.kdfe33pagm1 (sucursal, c1, c2, c3, c4, c7, c8, c12)
     SELECT s, s, 'UA0701', lpad(i::text, 7, '0'), 1, (timestamp '2025-06-01' + random() * interval '500 days')::text, (ARRAY['01','02','03'])[1 + (i % 3)], round((random()*50000)::numeric, 2)
       FROM generate_series(1, ${n(4000)}) i, LATERAL (SELECT lpad(((i % 9))::text, 2, '0') s) z`],
  // Devoluciones POS U-A-21 / U-A-25 de la historia (ruido).
  ['kdm1 devoluciones', `INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c16, c24, c32, c43, c67, c80, c81, c150)
     SELECT s, s, 'U', 'A', CASE WHEN i % 3 = 0 THEN 25 ELSE 21 END, 1, lpad(i::text, 7, '0'),
            timestamp '2026-01-01' + random() * interval '293 days', round((random()*900)::numeric, 2), 'DEVOLUCION', 'CLIENTE X',
            CASE WHEN i % 40 = 0 THEN 'C' END, 'CAJ', (1 + (i % 400))::text, (1 + (i % 3))::text, repeat('x', 700)
       FROM generate_series(1, ${n(6000)}) i, LATERAL (SELECT lpad((1 + (i % 8))::text, 2, '0') s) z`],
  ['kdb1', `INSERT INTO kepler_ods.kdb1 (sucursal, c1, c2, c3, c5)
     SELECT lpad(s::text, 2, '0'), k::text, CASE WHEN k = 1 THEN 'CAJA GENERAL' ELSE 'BANCO ' || k END,
            CASE WHEN k = 1 THEN 'EFECTIVO' ELSE lpad(k::text, 18, '0') END, CASE WHEN k > 17 THEN '205-01' ELSE '102-0' || k END
       FROM generate_series(0, 8) s, generate_series(1, 20) k`],
  ['kdud', `INSERT INTO kepler_ods.kdud (sucursal, c2, c3)
     SELECT lpad((i % 9)::text, 2, '0'), 'C' || lpad((i % 7000)::text, 5, '0'), 'CLIENTE ' || (i % 7000)
       FROM generate_series(1, ${n(63000)}) i`],
  // kdue: ruido de cartera (cargos y abonos de 2 años).
  ['kdue ruido', `INSERT INTO kepler_ods.kdue (sucursal, c1, c2, c3, c4, c5, c6, c7, c11, c16, c29)
     SELECT s, s, CASE WHEN i % 4 = 0 THEN 'CONTADO' ELSE 'C' || lpad((i % 7000)::text, 5, '0') END, 'D',
            (ARRAY[10, 1, 21, 5])[1 + (i % 4)], 1, lpad(i::text, 7, '0'), timestamp '2024-10-01' + random() * interval '750 days',
            round((random()*30000)::numeric, 2), 'REF ' || i, CASE WHEN i % 5 = 0 THEN 'A' ELSE 'C' END
       FROM generate_series(1, ${n(600000)}) i, LATERAL (SELECT lpad(((i % 9))::text, 2, '0') s) z`],
  // Los cortes U-D-23 de oct-2026: 8 sucursales × 3 cajas × 21 días = 504 (no se escalan: es el mes).
  ['cortes', `CREATE TEMP TABLE b_cortes ON COMMIT DROP AS
     SELECT lpad(s::text, 2, '0') AS suc, caja, d,
            lpad((row_number() OVER (PARTITION BY s ORDER BY d, caja))::text, 7, '0') AS folio,
            (100 + (extract(day FROM d)::int * 3) + caja)::text AS turno,
            round((5000 + random()*60000)::numeric, 2) AS monto, random() AS r
       FROM generate_series(1, 8) s, generate_series(1, 3) caja, generate_series(date '2026-10-01', date '2026-10-21', '1 day') d`],
  ['kdue cortes', `INSERT INTO kepler_ods.kdue (sucursal, c1, c2, c3, c4, c5, c6, c7, c11, c16, c29)
     SELECT suc, suc, 'CONTADO', 'D', 23, 1, folio, d, monto, 'Caja ' || caja || '-' || turno, 'C' FROM b_cortes`],
  ['devoluciones de cortes', `INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c16, c24, c32, c43, c67, c80, c81, c150)
     SELECT suc, suc, 'U', 'A', 21, 1, 'D' || suc || folio, d + interval '3 hours', round((r * 500)::numeric, 2), 'DEVOLUCION', 'CLIENTE X',
            CASE WHEN r < 0.01 THEN 'C' END, 'CAJ', turno, caja::text, repeat('x', 700)
       FROM b_cortes WHERE r < 0.1`],
  ['arqueos oct', `INSERT INTO analytics.cash_cuts (tenant_id, warehouse_code, warehouse_name, caja, folio, business_date, efectivo_esperado, efectivo_contado, tarjeta_esperado, tarjeta_contado, cajero_cierre)
     SELECT '${T}', suc, 'Sucursal ' || suc, caja::text, turno, d, monto * 0.8, CASE WHEN r < 0.1 THEN monto * 0.7 ELSE monto * 0.8 END, monto * 0.2, monto * 0.2, 'CAJ' || caja FROM b_cortes`],
  ['arqueos historia', `INSERT INTO analytics.cash_cuts (tenant_id, warehouse_code, warehouse_name, caja, folio, business_date, efectivo_esperado, efectivo_contado, cajero_cierre)
     SELECT '${T}', lpad((1 + (i % 8))::text, 2, '0'), 'Sucursal', (1 + (i % 3))::text, (1 + (i % 400))::text, date '2025-10-01' + (i % 365), 10000, 10000, 'H' || i
       FROM generate_series(1, ${n(4500)}) i`],
  // Aplicaciones: ~80 % de los cortes con 1 o 2 cobros (la pantalla mostraba 77.8 % cobrado), con su U-A-5.
  ['aplicaciones', `CREATE TEMP TABLE b_apps ON COMMIT DROP AS
     SELECT c.suc, c.folio, c.d, k, 'X' || c.suc || c.folio || k AS cobro, round((c.monto / (CASE WHEN c.r < 0.5 THEN 1 ELSE 2 END))::numeric, 2) AS monto
       FROM b_cortes c, generate_series(1, 2) k WHERE c.r >= 0.2 AND (k = 1 OR c.r >= 0.5)`],
  ['kdm5 cortes', `INSERT INTO kepler_ods.kdm5 (sucursal, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c13)
     SELECT suc, suc, 'U', 'A', 5, 1, cobro, 1, 'D', 23, 1, folio, monto FROM b_apps`],
  ['kdm1 cobros de cortes', `INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c10, c16, c24, c32, c45, c150)
     SELECT suc, suc, 'U', 'A', 5, 1, cobro, d + interval '1 day', 'CONTADO', monto, (ARRAY['PAGO CON TARJETA','EFECTIVO','TRANSFERENCIA SPEI'])[1 + (k % 3)], 'PUBLICO', (1 + (k % 20))::text, repeat('x', 700) FROM b_apps`],
  ['kdm5 ruido', `INSERT INTO kepler_ods.kdm5 (sucursal, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c13)
     SELECT s, s, 'U', 'A', 5, 1, lpad(i::text, 7, '0'), 1, 'D', (ARRAY[10, 1, 21])[1 + (i % 3)], 1, lpad((i % 50000)::text, 7, '0'), round((random()*9000)::numeric, 2)
       FROM generate_series(1, ${n(400000)}) i, LATERAL (SELECT lpad(((i % 9))::text, 2, '0') s) z`],
];

(async () => {
  const sql = L.sqlNueva();
  const vieja = L.sqlVieja(ANTES);
  const c = new Client({ connectionString: L.urlLocal(), application_name: 'csu10-bench-local' });
  await c.connect();
  try {
    await c.query('BEGIN');
    await L.vistaCobrosAlDia(c);
    await c.query(`CREATE INDEX IF NOT EXISTS ix_kdfe33pagm1_cobro ON kepler_ods.kdfe33pagm1 (btrim(c1), btrim(c3))`);
    const tc = Date.now();
    for (const [nombre, q] of CARGA) {
      const t0 = Date.now();
      const r = await c.query(q);
      if (nombre !== 'setseed') console.log(`  carga ${nombre}: ${r.rowCount ?? ''} filas · ${Date.now() - t0} ms`);
    }
    for (const t of ['kepler_ods.kdm1', 'kepler_ods.kdm5', 'kepler_ods.kdue', 'kepler_ods.kdud', 'kepler_ods.kdb1', 'kepler_ods.kdfe33pagm1', 'analytics.cash_cuts']) {
      await c.query(`ANALYZE ${t}`);
    }
    const tam = (await c.query(`SELECT pg_size_pretty(pg_total_relation_size('kepler_ods.kdm1')) mb, (SELECT count(*) FROM kepler_ods.kdm1) n`)).rows[0];
    console.log(`carga ${Math.round((Date.now() - tc) / 1000)} s · kdm1 ${tam.n} filas, ${tam.mb} · escala ${ESC}`);

    const p = ['2026-10-01', '2026-10-31'];
    const tv = [], tn = [], tnom = [];
    let a, b;
    for (let i = 0; i < 4; i++) {
      let t0 = Date.now();
      a = (await c.query(vieja, L.paramsVieja(...p))).rows;
      tv.push(Date.now() - t0);
      const r = await L.nueva(c, sql, ...p);
      b = r.filas;
      tn.push(r.ms);
      t0 = Date.now();
      await c.query(SQL_NOM, [T]);
      tnom.push(Date.now() - t0);
      console.log(`corrida ${i + 1}${i === 0 ? ' (fría)' : ''}: vieja ${tv[i]} ms · nueva ${r.ms} ms (cortes ${r.msCortes} + cobros ${r.msCobros}) · nombres ${tnom[i]} ms`);
    }
    console.log(`cortes ${a.length} · con cobro ${a.filter((x) => x.cobros).length} · con devolución ${a.filter((x) => x.devoluciones).length} · con arqueo ${a.filter((x) => x.arqueo_fecha).length}`);
    const total = L.mediana(tn.slice(1).map((x, i) => x + tnom[i + 1]));
    console.log(`MEDIANA en caliente (corridas 2-4): vieja ${L.mediana(tv.slice(1))} ms · nueva ${L.mediana(tn.slice(1))} ms · nueva + nombres ${total} ms`);
    console.log(total <= 500 ? 'OBJETIVO ≤ 500 ms: CUMPLE (en local)' : `OBJETIVO ≤ 500 ms: NO CUMPLE (${total} ms)`);
    if (L.iguales(a, L.sinCancelados(b))) console.log('PARIDAD OK a escala: salida idéntica');
    else { console.log('PARIDAD ROTA a escala'); console.log(L.diferencias(a, b).join('\n')); process.exitCode = 1; }
    if (total > 500) process.exitCode = 1;
    const dir = process.env.PLANES_DIR;
    if (dir) {
      for (const [nombre, q, params] of [['vieja', vieja, L.paramsVieja(...p)], ['nueva', sql.SQL, L.paramsNueva(...p)]]) {
        const plan = (await c.query(`EXPLAIN (ANALYZE, BUFFERS) ${q}`, params)).rows.map((x) => x['QUERY PLAN']).join('\n');
        fs.writeFileSync(path.join(dir, `plan-csu-${nombre}.txt`), plan);
      }
      console.log(`planes en ${dir}`);
    }
    console.log('NO REPRODUCE: hardware de md, kdud/complementos reales, resto de la API (alcance, JSON).');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
