/* eslint-disable no-console */
/**
 * [RA-PERF.1] EL REPARTO DE TRÁNSITO POR VENTANA — con su prueba NEGATIVA.
 *
 * ── Qué protege ─────────────────────────────────────────────────────────────────────────────
 * `import-replenishment-plan.js` repartía el tránsito de un almacén padre entre sus hijos con un
 * `LEFT JOIN` contra un CTE agregado (`tr_sub`). El planner lo inlineaba como lado INTERNO de un
 * Nested Loop porque estimaba el lado externo en **1 fila cuando trae 13,532** (la cadena
 * Kepler-ODS de `tr` no es estimable), y terminaba re-escaneando el agregado 13,532 veces:
 * **171,538,214 filas tiradas por el Join Filter = 100.3 s de los 153.9 s** de la corrida.
 *
 * El arreglo saca el denominador por VENTANA (`sum(...) OVER (PARTITION BY ...)`). Medido en
 * prod: 153,890 → 25,332 ms (6.08×) con los buffers **sin moverse** (1,744,443 → 1,745,288,
 * +0.05%): lo que desaparece es CPU, no lecturas.
 *
 * ── Por qué este test existe, y por qué es NEGATIVO ─────────────────────────────────────────
 * La equivalencia cuelga de UN invariante: **`tr` tiene que ser único por (warehouse_id,
 * product_id)**. Hoy lo es porque `tr` termina en `GROUP BY 1,2`. Si alguien toca ese GROUP BY,
 * la ventana suma el denominador de más y el tránsito se **sub-acredita en silencio** — no falla
 * nada, sólo sale un número más chico. La regla del proyecto es que un gate sin prueba negativa
 * es una intención, así que acá se rompe a propósito y se comprueba que el resultado SE MUEVE.
 *
 * ⛔ Y el fragmento NO se copia: se LEE del importer con una expresión regular sobre el fuente y
 * se ejecuta tal cual. Un test que copia la consulta que vigila deja de vigilarla el día que la
 * consulta cambia — y se queda verde.
 *
 * Corre contra `DATABASE_URL_NEW` usando sólo tablas TEMP: no lee ni escribe un solo dato real.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); }
catch { /* dotenv opcional: el runner puede traer el env ya cargado */ }

const IMPORTER = path.join(__dirname, '..', 'importers', 'kepler', 'import-replenishment-plan.js');

let ok = 0; let fail = 0;
const A = (cond, msg) => { if (cond) { ok++; console.log(`  ✔ ${msg}`); } else { fail++; console.log(`  ✖ ${msg}`); } };

/** Saca el fragmento `tr_x AS (...), tr_eff AS (...)` del importer, tal como se ejecuta. */
function fragmento() {
  const src = fs.readFileSync(IMPORTER, 'utf8');
  const i = src.indexOf('  tr_x AS (');
  const j = src.indexOf('  whs AS (', i);
  if (i < 0 || j < 0) {
    throw new Error('No encontré el bloque tr_x..tr_eff en import-replenishment-plan.js. ' +
      'Si se renombró, este test dejó de vigilar lo que dice vigilar: actualizá el ancla.');
  }
  return src.slice(i, j).replace(/,\s*$/, '');
}

(async () => {
  console.log('\n=== [RA-PERF.1] reparto de tránsito por ventana ===\n');

  // Este test NO lee un solo dato real: la maqueta es toda `VALUES`. Le sirve cualquier Postgres
  // alcanzable, así que se prueban varios en orden en vez de exigir uno — si no, el test se salta
  // en las máquinas que no alcanzan la base de turno, y un test que no corre no protege nada.
  const candidatos = [
    ['RPLAN_TEST_DB_URL', process.env.RPLAN_TEST_DB_URL],
    ['DATABASE_URL_NEW', process.env.DATABASE_URL_NEW],
    ['DATABASE_URL_KEPLER_CONSOLIDADO', process.env.DATABASE_URL_KEPLER_CONSOLIDADO],
    ['KEPLER_REPLICA_BASE', process.env.KEPLER_REPLICA_BASE],
    ['DATABASE_URL', process.env.DATABASE_URL],
  ].filter(([, v]) => v);
  let c = null; const fallos = [];
  for (const [nombre, cs] of candidatos) {
    const cli = new Client({ connectionString: cs, connectionTimeoutMillis: 8000,
      ssl: /rlwy|railway|proxy/i.test(cs) ? { rejectUnauthorized: false } : false });
    try { await cli.connect(); c = cli; console.log(`  (conectado por ${nombre})`); break; }
    catch (e) { fallos.push(`${nombre}: ${e.message.slice(0, 60)}`); await cli.end().catch(() => {}); }
  }
  if (!c) {
    console.log('  NO MEDIDO — ninguna base alcanzable:\n    ' + fallos.join('\n    '));
    process.exit(1);
  }

  const frag = fragmento();
  A(/OVER \(PARTITION BY tr\.warehouse_id, tr\.product_id\)/.test(frag),
    'el importer sigue repartiendo por ventana (y no volvió al LEFT JOIN contra un agregado)');

  // Maqueta mínima: un padre (P) con dos hijos (H1, H2) y demanda 3:1, más tránsito propio.
  const maqueta = (trFilas) => `
    WITH whtree(anc, des) AS (VALUES
      ('P'::text,'P'::text), ('P','H1'), ('P','H2'), ('H1','H1'), ('H2','H2')),
    dem(warehouse_id, product_id, daily_pieces) AS (VALUES
      ('H1'::text,'SKU'::text, 30::numeric), ('H2','SKU', 10::numeric), ('P','SKU', 0::numeric)),
    tr(warehouse_id, product_id, t, te) AS (VALUES ${trFilas}),
    ${frag}
    SELECT warehouse_id, round(t,4) AS t, round(te,4) AS te FROM tr_eff ORDER BY 1`;

  // ── 1) el camino feliz: 40 unidades en tránsito del padre se reparten 30/10 ──────────────
  const sano = (await c.query(maqueta("('P','SKU', 40::numeric, 40::numeric)"))).rows;
  const porAlm = Object.fromEntries(sano.map((r) => [r.warehouse_id, Number(r.t)]));
  console.log('  reparto sano:', JSON.stringify(porAlm));
  A(Math.abs(porAlm.H1 - 30) < 0.001, 'H1 (demanda 30 de 40) se lleva 30 del tránsito del padre');
  A(Math.abs(porAlm.H2 - 10) < 0.001, 'H2 (demanda 10 de 40) se lleva 10');
  A(Math.abs((porAlm.H1 + porAlm.H2 + (porAlm.P || 0)) - 40) < 0.001,
    'el reparto CONSERVA el total: nada se inventa ni se pierde');

  // ── 2) sin demanda en el subárbol, el tránsito se queda en el propio almacén ─────────────
  const sinDem = (await c.query(`
    WITH whtree(anc, des) AS (VALUES ('P'::text,'P'::text), ('P','H1')),
    dem(warehouse_id, product_id, daily_pieces) AS (VALUES ('X'::text,'OTRO'::text, 5::numeric)),
    tr(warehouse_id, product_id, t, te) AS (VALUES ('P'::text,'SKU'::text, 7::numeric, 7::numeric)),
    ${frag}
    SELECT warehouse_id, round(t,4) AS t FROM tr_eff ORDER BY 1`)).rows;
  // ⚠️ Emite TAMBIÉN la fila del hijo en 0, y eso es correcto: la forma vieja hacía lo mismo
  // (mismo GROUP BY sobre el mismo join). Lo que importa es dónde queda el tránsito, no cuántas
  // filas salen — mi primera versión de esta aserción exigía una sola fila y fallaba por eso.
  const propio = sinDem.find((r) => r.warehouse_id === 'P');
  const totalSinDem = sinDem.reduce((s, r) => s + Number(r.t), 0);
  A(propio && Math.abs(Number(propio.t) - 7) < 0.001,
    'sin demanda en el subárbol el tránsito NO se evapora: se acredita al propio almacén');
  A(Math.abs(totalSinDem - 7) < 0.001,
    'y no se duplica hacia el hijo: el total sigue siendo 7');

  // ── 3) ⛔ LA NEGATIVA: `tr` duplicado sub-acredita EN SILENCIO ───────────────────────────
  // Es exactamente el modo de falla que el comentario del importer declara. Si esto dejara de
  // divergir, el invariante habría dejado de importar y el comentario estaría mintiendo.
  const dup = (await c.query(maqueta(
    "('P','SKU', 20::numeric, 20::numeric), ('P','SKU', 20::numeric, 20::numeric)"))).rows;
  const totalDup = dup.reduce((s, r) => s + Number(r.t), 0);
  console.log(`  con 'tr' duplicado el total reparte ${totalDup.toFixed(2)} en vez de 40.00`);
  A(Math.abs(totalDup - 40) > 0.001,
    'DUPLICAR tr SÍ mueve el resultado — o sea el invariante (warehouse_id, product_id) es REAL');
  A(totalDup < 40,
    'y lo mueve hacia ABAJO: sub-acredita el tránsito, que es la falla peligrosa (pide de más)');

  // ── 4) el guardián del invariante, sobre la misma maqueta ────────────────────────────────
  const guard = async (filas) => Number((await c.query(`
    WITH tr(warehouse_id, product_id, t, te) AS (VALUES ${filas})
    SELECT count(*) FILTER (WHERE n > 1)::int AS repetidos
      FROM (SELECT warehouse_id, product_id, count(*) n FROM tr GROUP BY 1,2) x`)).rows[0].repetidos);
  A(await guard("('P'::text,'SKU'::text, 40::numeric, 40::numeric)") === 0,
    'el guardián NO se queja del caso sano');
  A(await guard("('P'::text,'SKU'::text, 20::numeric, 20::numeric), ('P','SKU', 20::numeric, 20::numeric)") === 1,
    'el guardián SÍ detecta el `tr` duplicado (si diera 0 sería decoración)');

  await c.end();
  console.log(`\n=== ${ok} ✔ · ${fail} ✖ ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
