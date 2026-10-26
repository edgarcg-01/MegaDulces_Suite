/**
 * `[AB.40]` LA VENTA DE RUTA ENTRA A `sales_daily` UNA SOLA VEZ — el SQL EXACTO del importer contra una base real.
 *
 * `import-sales-fact.js` mandaba al mismo RUTA-NN la venta de la ruta dos veces: por el Kepler de Padre
 * Hidalgo (almacén `01-00N`, sucursal `01`) y por el envío de la camioneta (sucursal `ruta_NN`, mismo
 * almacén). El filtro deja, de un almacén de ruta que empuja, sólo lo que trae el envío.
 *
 * Esta prueba saca del archivo las DOS consultas de origen (venta y tickets) tal como las arma JS (con
 * sus escapes resueltos) y las ejecuta contra la base LOCAL, sobre un `mart.ventas_enriched` sembrado
 * dentro de una transacción que se revierte. Se niega a correr contra producción.
 *
 *   1. Del almacén de ruta 01-001 sólo queda lo del envío (ruta_21): $100, no $100 + $100.
 *   2. Una sucursal normal (02) no se toca.
 *   3. Un almacén que NO es de ruta aunque se parezca (01) no se toca.
 *   4. Los tickets cuentan sólo los folios del envío.
 *   5. NEGATIVA: con el filtro quitado del texto, la ruta sale al doble (la prueba sí ve el defecto).
 *   6. El comodín: `ruta\_%` es literal — una sucursal `rutaX21` NO pasa por envío.
 *
 * Uso: node database/tests/test-localdb-sales-fact-rutas-una-vez.js
 */
const fs = require('fs');
const path = require('path');

const PROD_SID = '7688376744939610156';
const URL = process.env.REQ_TEST_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres_platform';
const ARCHIVO = path.join(__dirname, '..', 'importers', 'kepler', 'import-sales-fact.js');
let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra !== undefined ? JSON.stringify(extra) : ''); } };

/** Las dos consultas a `mart.ventas_enriched` del archivo, como cadenas de JS ya evaluadas. */
function consultas() {
  const src = fs.readFileSync(ARCHIVO, 'utf8');
  const re = /src\.query\(\s*`([^`]*FROM mart\.ventas_enriched[^`]*)`/g;
  const out = [];
  let m;
  while ((m = re.exec(src))) out.push(new Function(`return \`${m[1]}\`;`)());
  return out;
}

const knex = require('knex')({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
(async () => {
  const sid = (await knex.raw('SELECT system_identifier::text s FROM pg_control_system()')).rows[0].s;
  if (sid === PROD_SID) throw new Error('esta prueba crea objetos: se niega a correr contra producción');
  const [venta, tickets] = consultas();
  ok(!!venta && !!tickets && /ANY\(\$3::text\[\]\)/.test(venta) && /ANY\(\$3::text\[\]\)/.test(tickets), 'el archivo trae el filtro en las dos consultas');
  ok(/'ruta\\_%'/.test(venta), 'el patrón llega a SQL como ruta\\_% (guion bajo literal)', venta.match(/'ruta[^']*'/)?.[0]);

  await knex.transaction(async (trx) => {
    await trx.raw('CREATE SCHEMA IF NOT EXISTS mart');
    await trx.raw('DROP TABLE IF EXISTS mart.ventas_enriched_prueba_ab40');
    // Si la base local ya tiene la vista, no se toca: la prueba usa su propio nombre y reemplaza el FROM.
    await trx.raw(`CREATE TABLE mart.ventas_enriched_prueba_ab40 (sucursal text, almacen text, folio text, fecha date, channel text,
                    sku text, unidad text, cantidad numeric, importe numeric)`);
    await trx.raw(`INSERT INTO mart.ventas_enriched_prueba_ab40 VALUES
      ('01',      '01-001', 'K1', '2026-09-10', 'credito', '97245', 'PZA', 10, 100),
      ('ruta_21', '01-001', 'R1', '2026-09-10', 'credito', '97245', 'PZA', 10, 100),
      ('02',      '02',     'S1', '2026-09-10', 'tienda',  '97245', 'PZA',  5,  50),
      ('01',      '01',     'S2', '2026-09-10', 'tienda',  '97245', 'PZA',  3,  30),
      ('rutaX21', '01-001', 'X1', '2026-09-10', 'credito', '97245', 'PZA',  1,   7)`);
    const de = (q) => q.replace(/FROM mart\.ventas_enriched\b/, 'FROM mart.ventas_enriched_prueba_ab40');
    const p = ['2026-09-01', '2026-10-01', ['01-001']];
    const v = (await trx.raw(de(venta).replace(/\$(\d)/g, (_, n) => `:p${n}`), { p1: p[0], p2: p[1], p3: p[2] })).rows;
    const porAlm = (rs, a) => rs.filter((r) => r.almacen === a).reduce((s, r) => s + Number(r.revenue), 0);
    ok(porAlm(v, '01-001') === 100, `ruta 01-001 = sólo el envío ($${porAlm(v, '01-001')})`);
    ok(porAlm(v, '02') === 50, 'la sucursal 02 no se toca');
    ok(porAlm(v, '01') === 30, 'el almacén 01 (no de ruta) no se toca');
    const t = (await trx.raw(de(tickets).replace(/\$(\d)/g, (_, n) => `:p${n}`), { p1: p[0], p2: p[1], p3: p[2] })).rows;
    ok(t.filter((r) => r.almacen === '01-001').reduce((s, r) => s + r.tickets, 0) === 1, 'los tickets de la ruta cuentan sólo el folio del envío');

    const sinFiltro = de(venta).replace(/\n\s*AND NOT \(almacen = ANY\(\$3::text\[\]\)[^\n]*/, '');
    const vSin = (await trx.raw(sinFiltro.replace(/\$(\d)/g, (_, n) => `:p${n}`), { p1: p[0], p2: p[1], p3: p[2] })).rows;
    ok(porAlm(vSin, '01-001') === 207, `NEGATIVA: sin el filtro la ruta sale al doble ($${porAlm(vSin, '01-001')})`);
    throw new Error('ROLLBACK');
  }).catch((e) => { if (e.message !== 'ROLLBACK') throw e; });
})().catch((e) => { fail++; console.log('  ✗ error:', e.message); })
  .finally(async () => {
    await knex.destroy();
    console.log(`\n  ${pass} ✓ · ${fail} ✗`);
    process.exit(fail ? 1 : 0);
  });
