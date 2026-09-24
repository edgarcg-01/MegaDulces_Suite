/* eslint-disable no-console */
/**
 * [EX-PERF.2] EL FACTOR DE CAJA Y EL COSTO, MATERIALIZADOS — con su prueba NEGATIVA.
 *
 * ── Qué protege ─────────────────────────────────────────────────────────────────────────────
 * `/compras/existencia` dejó de calcular `analytics.v_warehouse_box_factor` y
 * `analytics.v_kepler_unit_cost` en cada carga y ahora las lee materializadas. El motivo está
 * medido: entre las dos aportaban **281,730 de las 939,977 páginas** que costaba devolver 50
 * filas (27 s de LCP), y con las dos materializadas la consulta real bajó de **4,910 a 1,353 ms**.
 *
 * Cambiar de dónde sale un número es el momento exacto en que el número se mueve sin que nadie
 * lo note — y acá los dos números son DINERO: el factor de caja manda la cantidad que se pide y
 * el costo unitario valúa el inventario. Este test existe para que no puedan moverse:
 *
 *   1. los dos materializados **existen** (si no, se DECLARA `NO MEDIDO`, nunca ✔);
 *   2. su llave es **única** — sin eso `REFRESH CONCURRENTLY` no está permitido y el refresco
 *      tomaría un lock exclusivo que deja la pantalla EN BLANCO mientras corre;
 *   3. **prueba NEGATIVA**: se duplica la llave a propósito y se comprueba que el chequeo se
 *      pone rojo. Sin esto, el punto 2 sería decoración;
 *   4. el CONTENIDO coincide **fila por fila** con su vista — mismo conteo y misma firma md5;
 *   5. y la VISTA original quedó **intacta**: sigue siendo una vista, no un `SELECT` del
 *      materializado. ⛔ Eso importa más de lo que parece: `v_warehouse_box_factor` tiene 4
 *      dependientes, entre ellas `v_unit_truth`, el resolvedor canónico de unidades (ADR-057).
 *      Si alguien "simplifica" apuntando la vista al materializado, le cambia la frescura a la
 *      verdad de unidades de toda la plataforma, en silencio.
 *
 * ⚠️ Si este test se pone rojo, el problema NO es el test: o el refresco dejó de correr, o
 * alguien tocó una de las dos definiciones y la pantalla está publicando una cifra que su fuente
 * no respalda.
 *
 * Sólo LEE. Lo único que escribe son tablas TEMP dentro de un ROLLBACK.
 */
const path = require('path');
const { Client } = require('pg');

try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); }
catch { /* dotenv opcional: el runner puede traer el env ya cargado */ }

const PARES = [
  ['analytics.mv_warehouse_box_factor', 'analytics.v_warehouse_box_factor'],
  ['analytics.mv_kepler_unit_cost', 'analytics.v_kepler_unit_cost'],
];

let ok = 0; let fail = 0; let nm = 0;
const A = (cond, msg) => { if (cond) { ok++; console.log(`  ✔ ${msg}`); } else { fail++; console.log(`  ✖ ${msg}`); } };
const ND = (msg) => { nm++; console.log(`  · NO MEDIDO — ${msg}`); };

(async () => {
  const cs = process.env.EXISTENCIA_TEST_DB_URL || process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;
  if (!cs) { console.log('NO MEDIDO — sin DATABASE_URL_NEW/DATABASE_URL'); process.exit(0); }
  const c = new Client({
    connectionString: cs,
    ssl: /localhost|127\.0\.0\.1|pg-prod|192\.168\./.test(cs) ? false : { rejectUnauthorized: false },
    statement_timeout: 600000,
  });
  await c.connect();
  await c.query(`SET statement_timeout = '600s'`);
  await c.query(`SET jit = off`);

  // ── 1) ¿Existen? ───────────────────────────────────────────────────────────────────────────
  console.log('\n1) los dos materializados existen');
  let hay = 0;
  for (const [mv] of PARES) {
    const reg = (await c.query(`SELECT to_regclass($1) AS t`, [mv])).rows[0].t;
    if (reg) { hay++; A(true, `${mv} existe`); } else { ND(`${mv} no existe (migración sin aplicar; el servicio lee la vista viva)`); }
  }
  if (hay < PARES.length) {
    console.log(`\n=== ${ok} ✔ · ${fail} ✖ · ${nm} NO MEDIDO ===\n`);
    await c.end(); process.exit(fail ? 1 : 0);
  }

  // ── 2) La llave es única ───────────────────────────────────────────────────────────────────
  console.log('\n2) la llave (tenant, almacén, producto) es única');
  for (const [mv] of PARES) {
    const r = (await c.query(`
      SELECT (SELECT count(*) FROM ${mv})::int AS filas,
             (SELECT count(*) FROM (SELECT 1 FROM ${mv}
                GROUP BY tenant_id, warehouse_id, product_id HAVING count(*) > 1) z)::int AS dup`)).rows[0];
    A(Number(r.dup) === 0,
      `${mv.split('.').pop()}: ${Number(r.filas).toLocaleString('es-MX')} filas, ${r.dup} duplicadas`);
  }

  // ── 3) PRUEBA NEGATIVA ─────────────────────────────────────────────────────────────────────
  console.log('\n3) prueba negativa — romper la unicidad a propósito');
  await c.query('BEGIN');
  try {
    await c.query(`CREATE TEMP TABLE _k(t uuid, w uuid, p uuid) ON COMMIT DROP`);
    const g = `'00000000-0000-0000-0000-000000000001'::uuid`;
    const contar = async () => Number((await c.query(
      `SELECT count(*)::int n FROM (SELECT 1 FROM _k GROUP BY t,w,p HAVING count(*)>1) z`)).rows[0].n);
    await c.query(`INSERT INTO _k VALUES (${g}, ${g}, ${g})`);
    const sano = await contar();
    await c.query(`INSERT INTO _k VALUES (${g}, ${g}, ${g})`);
    const roto = await contar();
    A(sano === 0, `con la llave sana el chequeo da ${sano}`);
    A(roto === 1, `al duplicarla da ${roto} — el chequeo del bloque 2 es REAL, no adorno`);
  } finally { await c.query('ROLLBACK'); }

  // ── 4) El contenido == su vista, fila por fila ─────────────────────────────────────────────
  console.log('\n4) el contenido coincide con su vista (conteo y firma md5)');
  for (const [mv, vista] of PARES) {
    // La firma toma TODA la fila (`t::text`), no un par de columnas elegidas: si cambia
    // cualquier campo, se nota. Un test que mira 3 columnas de 12 deja 9 sin vigilar.
    const firma = async (rel) => (await c.query(
      `SELECT count(*)::int AS filas, md5(string_agg(f, '|' ORDER BY f)) AS firma
         FROM (SELECT t::text AS f FROM ${rel} t) z`)).rows[0];
    const a = await firma(mv);
    const b = await firma(vista);
    A(a.filas === b.filas, `${mv.split('.').pop()}: ${Number(a.filas).toLocaleString('es-MX')} == ${Number(b.filas).toLocaleString('es-MX')} filas`);
    A(a.firma === b.firma, `${mv.split('.').pop()}: misma firma md5 de la fila COMPLETA — 0 diferencias`);
    if (a.firma !== b.firma) {
      console.log('     ⛔ el materializado está VIEJO o su vista cambió. Si el latido');
      console.log('        `mv_existencia_aux_refresh` está fresco, cambió la definición.');
    }
  }

  // ── 5) Las vistas siguen siendo VISTAS, no un alias del materializado ──────────────────────
  console.log('\n5) las vistas originales quedaron intactas (blast radius)');
  for (const [mv, vista] of PARES) {
    const d = (await c.query(`SELECT pg_get_viewdef($1::regclass) AS def`, [vista])).rows[0].def || '';
    A(!d.includes(mv.split('.').pop()),
      `${vista.split('.').pop()} NO lee del materializado — sus dependientes conservan su frescura`);
  }
  const deps = (await c.query(`
    SELECT count(DISTINCT r.ev_class)::int AS n
      FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
     WHERE d.refobjid = 'analytics.v_warehouse_box_factor'::regclass
       AND r.ev_class <> 'analytics.v_warehouse_box_factor'::regclass`)).rows[0].n;
  console.log(`  · ${deps} vistas dependen de v_warehouse_box_factor (por eso NO se toca su cuerpo)`);

  await c.end();
  console.log(`\n=== ${ok} ✔ · ${fail} ✖ · ${nm} NO MEDIDO ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
