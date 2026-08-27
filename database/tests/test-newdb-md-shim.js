/* eslint-disable no-console */
/**
 * Smoke CDC.8 — el shim `md` (vistas sobre `kepler_ods` filtradas por la sucursal de la sesión).
 *
 * Es la pieza que permite repointear importers al ODS sin tocarles el SQL, así que hay tres cosas
 * que NO se pueden romper en silencio:
 *
 *   1) FALLA CERRADA. Sin `app.kepler_sucursal` seteado, las vistas devuelven **0 filas**. Si algún
 *      día devolvieran todo, cada importer repointeado sumaría las 7 copias de cada rama → doble
 *      conteo silencioso (exactamente lo que el `c1=$1` de los importers existe para evitar).
 *   2) EQUIVALENCIA. Con el GUC en X, `md.<t>` == `kepler_ods.<t> WHERE sucursal=X`, fila por fila.
 *   3) EL ÍNDICE. El filtro es igualdad plana contra `current_setting(...)` justamente para que el
 *      planner use la PK (que arranca con `sucursal`). Si alguien lo cambia a `btrim(sucursal)`,
 *      cada query pasa a scan completo y el repointeo se vuelve inusable. El test mira el plan.
 *
 *   node database/tests/test-newdb-md-shim.js
 *   DATABASE_URL_NEW=<prod> node database/tests/test-newdb-md-shim.js
 */
const { Client } = require('pg');

const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';

let ok = 0; const fallos = [];
const chk = (cond, msg) => { cond ? ok++ : fallos.push(msg); };

(async () => {
  const db = new Client({
    connectionString: DST,
    ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false,
    statement_timeout: 300000,
  });
  await db.connect();
  console.log('\n=== Smoke CDC.8 — shim md sobre kepler_ods ===\n');

  if (!(await db.query(`SELECT 1 FROM pg_namespace WHERE nspname='md'`)).rows.length) {
    console.log('SKIP — no existe el esquema md; falta la migración 20260827130000 en esta DB.');
    await db.end(); process.exit(0);
  }

  // Cobertura: una vista por tabla del ODS que tenga columna sucursal.
  const cob = (await db.query(`
    SELECT
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='md' AND c.relkind='v')::int vistas,
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='kepler_ods' AND c.relkind='r'
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='sucursal'
                        AND a.attnum>0 AND NOT a.attisdropped))::int elegibles`)).rows[0];
  chk(cob.vistas === cob.elegibles,
    `cobertura incompleta: ${cob.vistas} vistas para ${cob.elegibles} tablas elegibles (corré SELECT md.refresh_shim())`);
  console.log(`  cobertura: ${cob.vistas}/${cob.elegibles} tablas del ODS con vista`);

  // Tabla de prueba: la mayor con datos en varias sucursales.
  const t = (await db.query(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='md' AND c.relkind='v' AND c.relname IN ('kdm1','kdud','doctype')
    ORDER BY CASE c.relname WHEN 'kdm1' THEN 1 WHEN 'kdud' THEN 2 ELSE 3 END LIMIT 1`)).rows[0];
  if (!t) {
    console.log('SKIP — el shim existe pero sin kdm1/kdud/doctype; nada representativo que probar.');
    await db.end(); process.exit(0);
  }
  const tabla = t.relname;

  // 1) falla cerrada
  await db.query(`SELECT set_config('app.kepler_sucursal', NULL, false)`);
  const sin = Number((await db.query(`SELECT count(*)::bigint n FROM md.${tabla}`)).rows[0].n);
  chk(sin === 0, `sin app.kepler_sucursal, md.${tabla} devolvió ${sin} filas (debe ser 0: falla cerrada)`);

  // 2) equivalencia con el filtro directo, en TODAS las sucursales que tenga el ODS
  const sucs = (await db.query(
    `SELECT DISTINCT sucursal s FROM kepler_ods.${tabla} ORDER BY 1`)).rows.map((r) => r.s);
  chk(sucs.length > 0, `kepler_ods.${tabla} no tiene ninguna sucursal`);
  let iguales = 0;
  for (const s of sucs) {
    await db.query(`SELECT set_config('app.kepler_sucursal', $1, false)`, [s]);
    const via = Number((await db.query(`SELECT count(*)::bigint n FROM md.${tabla}`)).rows[0].n);
    const dir = Number((await db.query(
      `SELECT count(*)::bigint n FROM kepler_ods.${tabla} WHERE sucursal=$1`, [s])).rows[0].n);
    if (via === dir) iguales++;
    else fallos.push(`md.${tabla} con sucursal=${s}: ${via} filas vs ${dir} del filtro directo`);
  }
  if (iguales === sucs.length) ok++;
  console.log(`  falla cerrada: ${sin} filas sin GUC · equivalencia: ${iguales}/${sucs.length} sucursales exactas`);

  // 3) el plan tiene que usar índice, no scan secuencial
  const plan = (await db.query(`EXPLAIN (COSTS OFF) SELECT * FROM md.${tabla} LIMIT 1`)).rows
    .map((r) => r['QUERY PLAN']).join(' ');
  chk(/Index/i.test(plan) && !/Seq Scan/i.test(plan),
    `el plan de md.${tabla} no usa índice (¿alguien puso btrim(sucursal)?): ${plan.slice(0, 120)}`);
  console.log(`  plan: ${plan.split('\n')[0].trim().slice(0, 80)}`);

  // 4) refresh_shim() sin force es barata e idempotente
  const t0 = Date.now();
  const n = Number((await db.query(`SELECT md.refresh_shim() AS n`)).rows[0].n);
  const ms = Date.now() - t0;
  chk(n === 0, `refresh_shim() creó ${n} vistas cuando no debía crear ninguna (¿cobertura desalineada?)`);
  chk(ms < 5000, `refresh_shim() tardó ${ms}ms sin nada que crear (debería ser decenas de ms)`);
  console.log(`  refresh_shim(): ${n} vistas nuevas en ${ms}ms`);

  // 5) el GUC es por sesión: dos conexiones no se pisan
  const otra = new Client({
    connectionString: DST,
    ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false,
  });
  await otra.connect();
  const enOtra = Number((await otra.query(`SELECT count(*)::bigint n FROM md.${tabla}`)).rows[0].n);
  chk(enOtra === 0, `una conexión nueva vio ${enOtra} filas: el GUC no está aislado por sesión`);
  await otra.end();

  console.log(`\n${fallos.length ? '❌' : '✅'} ${ok} aserciones OK${fallos.length ? `, ${fallos.length} fallas:` : ''}`);
  fallos.forEach((f) => console.log('   - ' + f));
  await db.end();
  process.exit(fallos.length ? 1 : 0);
})().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
