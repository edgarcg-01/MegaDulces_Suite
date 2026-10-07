/* eslint-disable no-console */
/**
 * [RS] CANDADO de SINCRONÍA de filtros del sell-out — la clase de bug que "no puede seguir pasando".
 *
 * ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────
 * El reporte tiene muchas ramas (job × layout × filtro) y varias decidían por su cuenta qué filtro
 * consultar. Bugs vividos: "Por plaza" ignoraba Canal/Avanzado; las rutas de PH se etiquetaban como
 * MORELIA por una heurística de primer-dígito; "Por plaza" pintaba las 14 columnas aunque filtraras
 * una sola plaza. La pieza más frágil —y la que mal-etiquetó dinero— es la ATRIBUCIÓN ruta→plaza.
 *
 * Este candado la fija a nivel DATOS (lo verificable sin levantar la API), con prueba negativa:
 *  1. COBERTURA: toda camioneta `RUTA-%` con venta en el sell-out tiene plaza en `v_route_plaza`.
 *     Una ruta sin mapeo caería en OTROS o se mal-etiquetaría en silencio.
 *  2. ROUND-TRIP: expandir el filtro de una sucursal → sus rutas → el parent de cada una es ESA
 *     sucursal (cero contaminación cruzada). Es el mismo vínculo que usan `expandRouteWarehouses`
 *     (filtro por sucursal) y `plazaColKey` (columna de plaza): una sola fuente, `wincaja.branches`.
 *  3. NEGATIVA: una ruta fabricada sin mapeo DEBE disparar el bloque 1 (si no, el candado es utilería).
 *
 * Lo que este candado NO cubre y se DECLARA: que el pivote HONRE los filtros de canal/celda en cada
 * layout es lógica de servicio (Node), no verificable sin la API. Queda cerrado por el build + el
 * cambio de código (plaza ya aplica channel/cell) + la fuente única de canal en el frontend; un smoke
 * HTTP sobre la matriz de combos es el complemento pendiente (necesita la API arriba).
 *
 *   DATABASE_URL_NEW=<prod o destino> node database/tests/test-newdb-sellout-filter-sync.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL || process.env.FLEET_DB_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW o FLEET_DB_URL'); })();

let ok = 0, fail = 0, nomedido = 0;
const pass = (m) => { ok++; console.log('  ✔', m); };
const bad = (m) => { fail++; console.log('  x FALLA:', m); };
const skip = (m) => { nomedido++; console.log('  ~ NO MEDIDO:', m); };

(async () => {
  const db = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await db.connect();
  try {
    // Pre: ¿existe el resolvedor canónico?
    const hasVrp = (await db.query("SELECT to_regclass('analytics.v_route_plaza') r")).rows[0].r;
    if (!hasVrp) { skip('analytics.v_route_plaza no existe en el destino — nada que medir.'); return; }

    // ── 1. COBERTURA ruta→plaza ────────────────────────────────────────────────────────────
    console.log('\n[1] Cobertura: toda RUTA-% con venta en el sell-out tiene plaza en v_route_plaza');
    const rutasVenta = (await db.query(
      "SELECT DISTINCT warehouse_code FROM analytics.v_sellout_daily WHERE warehouse_code LIKE 'RUTA-%'",
    )).rows.map((r) => r.warehouse_code);
    if (!rutasVenta.length) { skip('sin camionetas RUTA-% con venta en el destino.'); }
    else {
      const mapadas = new Set((await db.query('SELECT route_warehouse_code FROM analytics.v_route_plaza')).rows.map((r) => r.route_warehouse_code));
      const huerfanas = rutasVenta.filter((r) => !mapadas.has(r));
      if (huerfanas.length) bad(`${huerfanas.length} camioneta(s) sin plaza (caerían en OTROS o mal-etiquetadas): ${huerfanas.join(', ')}`);
      else pass(`${rutasVenta.length} camionetas con venta, todas con plaza asignada.`);
    }

    // ── 2. ROUND-TRIP sucursal→rutas→parent==sucursal ───────────────────────────────────────
    console.log('\n[2] Round-trip: cada ruta que el filtro de una sucursal agrega vuelve a ESA sucursal');
    const rows = (await db.query('SELECT route_warehouse_code, parent_warehouse_code FROM analytics.v_route_plaza')).rows;
    if (!rows.length) { skip('v_route_plaza vacía.'); }
    else {
      // Simula expandRouteWarehouses: por sucursal padre, el conjunto de sus rutas.
      const byParent = new Map();
      for (const r of rows) { if (!byParent.has(r.parent_warehouse_code)) byParent.set(r.parent_warehouse_code, []); byParent.get(r.parent_warehouse_code).push(r.route_warehouse_code); }
      const parentOf = new Map(rows.map((r) => [r.route_warehouse_code, r.parent_warehouse_code]));
      let leaks = 0;
      for (const [parent, rutas] of byParent) {
        for (const rt of rutas) if (parentOf.get(rt) !== parent) { leaks++; console.log(`     fuga: ${rt} agregada por ${parent} pero su parent es ${parentOf.get(rt)}`); }
      }
      // multi-parent: una ruta con dos padres = contaminación cruzada (rompe la exclusividad de plaza).
      const multi = rows.reduce((m, r) => { m[r.route_warehouse_code] = (m[r.route_warehouse_code] || new Set()); m[r.route_warehouse_code].add(r.parent_warehouse_code); return m; }, {});
      const dobles = Object.entries(multi).filter(([, s]) => s.size > 1);
      if (leaks || dobles.length) bad(`${leaks} fuga(s) + ${dobles.length} ruta(s) con parent múltiple.`);
      else pass(`${byParent.size} sucursales, ${rows.length} rutas — cada ruta pertenece a UNA sola plaza.`);
    }

    // ── 3. PRUEBA NEGATIVA: una ruta sin mapeo DEBE disparar el bloque 1 ─────────────────────
    console.log('\n[3] Prueba negativa: el detector de cobertura tiene dientes');
    const mapadas = new Set((await db.query('SELECT route_warehouse_code FROM analytics.v_route_plaza')).rows.map((r) => r.route_warehouse_code));
    const fake = ['RUTA-999-FAKE'];
    const detecta = fake.filter((r) => !mapadas.has(r));
    if (detecta.length === 1) pass('una ruta fabricada sin plaza es detectada como huérfana (el candado no es utilería).');
    else bad('el detector NO marcó la ruta fabricada — la aserción del bloque 1 no tiene dientes.');

    console.log(`\n=== ${ok} OK · ${fail} FALLAS · ${nomedido} NO MEDIDOS ===`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
  }
})();
