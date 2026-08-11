/* eslint-disable no-console */
/**
 * SYNC.2.3 — smoke del handler 'raw-upsert' (CDC genérico kepler_ods).
 * Prueba la propiedad clave: un re-run idéntico escribe 0 filas (UPSERT sin churn).
 * Usa una tabla desechable kepler_ods._ods_smoke; la dropea al final.
 */
const { Client } = require('pg');
const { applyRawUpsert } = require('../../services/feeds-ingest/apply-handlers');

const URL = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const M = '00000000-0000-0000-0000-00000000d01c';
const T = '_ods_smoke';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ ${msg}`); } }

const META = {
  table: T,
  pk: ['c1', 'c2'],
  columns: [
    { name: 'sucursal', type: 'text' },
    { name: 'c1', type: 'text' },
    { name: 'c2', type: 'integer' },
    { name: 'nombre', type: 'text' },
    { name: 'monto', type: 'numeric' },
  ],
};
const rows = (nombreA) => [
  { sucursal: '00', c1: 'A', c2: 1, nombre: nombreA, monto: 10.5 },
  { sucursal: '00', c1: 'B', c2: 2, nombre: 'beta', monto: 20 },
  { sucursal: '03', c1: 'A', c2: 1, nombre: 'gamma', monto: 30 }, // misma PK-origen, otra sucursal
];

(async () => {
  const c = new Client({ connectionString: URL, ssl: /@(localhost|127|192\.168)/.test(URL) ? false : { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query(`DROP TABLE IF EXISTS kepler_ods.${T}`);

    console.log('\n1) Primer push (crea tabla + inserta 3):');
    let n = await applyRawUpsert(c, M, rows('alfa'), META);
    ok(n === 3, `insertó 3 filas (changed=${n})`);
    const cnt = Number((await c.query(`SELECT count(*) n FROM kepler_ods.${T}`)).rows[0].n);
    ok(cnt === 3, `tabla tiene 3 filas`);
    ok((await c.query(`SELECT 1 FROM information_schema.table_constraints WHERE table_schema='kepler_ods' AND table_name='${T}' AND constraint_type='PRIMARY KEY'`)).rows.length === 1, 'PK compuesta creada');

    console.log('\n2) Re-push IDÉNTICO (debe escribir 0 — sin churn):');
    n = await applyRawUpsert(c, M, rows('alfa'), META);
    ok(n === 0, `re-run escribió 0 filas (changed=${n})  ← prueba UPSERT sin churn`);

    console.log('\n3) Cambia 1 fila (nombre alfa→ALFA):');
    n = await applyRawUpsert(c, M, rows('ALFA'), META);
    ok(n === 1, `sólo 1 fila reescrita (changed=${n})`);
    ok((await c.query(`SELECT nombre FROM kepler_ods.${T} WHERE sucursal='00' AND c1='A' AND c2=1`)).rows[0].nombre === 'ALFA', 'dato actualizado');

    console.log('\n4) Convivencia de PK entre sucursales:');
    const both = Number((await c.query(`SELECT count(*) n FROM kepler_ods.${T} WHERE c1='A' AND c2=1`)).rows[0].n);
    ok(both === 2, `(A,1) existe en 2 sucursales sin colisión (${both})`);

    console.log('\n5) Auto-alter: columna nueva en meta:');
    const meta2 = { ...META, columns: [...META.columns, { name: 'extra', type: 'text' }] };
    n = await applyRawUpsert(c, M, [{ sucursal: '00', c1: 'C', c2: 3, nombre: 'delta', monto: 5, extra: 'x' }], meta2);
    ok(n === 1, `insertó fila con columna nueva (changed=${n})`);
    ok((await c.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='kepler_ods' AND table_name='${T}' AND column_name='extra'`)).rows.length === 1, "columna 'extra' auto-agregada");

    console.log('\n6) _sync_status:');
    const st = (await c.query(`SELECT rows_last, rows_seen FROM kepler_ods._sync_status WHERE table_name='${T}'`)).rows[0];
    ok(!!st, 'marca de frescura escrita');

    await c.query(`DROP TABLE IF EXISTS kepler_ods.${T}`);
    console.log(`\n=== raw-upsert smoke: ${pass} ok, ${fail} fail ===`);
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('\nERROR:', e.message);
    try { await c.query(`DROP TABLE IF EXISTS kepler_ods.${T}`); } catch { /* noop */ }
    process.exit(1);
  } finally { await c.end(); }
})();
