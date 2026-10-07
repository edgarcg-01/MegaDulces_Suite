/* eslint-disable no-console */
/**
 * [AX-PERF.1] EL FACTOR DE CAJA DEL ANEXO, MATERIALIZADO — con su prueba NEGATIVA.
 *
 * ── Qué protege ─────────────────────────────────────────────────────────────────────────────
 * `analytics.erp_sales_invoice_lines` dejó de calcular `analytics.v_product_box_factor` **una
 * vez por renglón** y ahora lo lee materializado. El motivo está medido en prod: esa consulta
 * acumulaba **108 llamadas reales con promedio 13,776 ms y máximo 65,716 ms** (1,620,122 páginas
 * para devolver 28 filas), y con la copia da **5.7 ms**.
 *
 * Cambiar de dónde sale un número es el momento exacto en que el número se mueve sin que nadie
 * lo note — y acá el número se IMPRIME Y SE ENTREGA A UN CLIENTE: `box_factor` es el divisor que
 * pone la "equivalencia en cajas" del anexo al CFDI. Este test existe para que no pueda moverse:
 *
 *   1. el materializado **existe** (si no, se DECLARA `NO MEDIDO`, nunca ✔);
 *   2. su llave es **única** — sin eso `REFRESH CONCURRENTLY` no está permitido y el refresco
 *      tomaría un lock exclusivo que deja la pantalla EN BLANCO mientras corre;
 *   3. **prueba NEGATIVA**: se duplica la llave a propósito y se comprueba que el chequeo se
 *      pone rojo. Sin esto, el punto 2 sería decoración;
 *   4. el CONTENIDO coincide **fila por fila** con su vista — mismo conteo y misma firma md5 de
 *      la fila COMPLETA;
 *   5. ⭐ **el número IMPRESO no se movió**: para documentos reales, el `box_factor` que devuelve
 *      la vista de renglones es idéntico, renglón por renglón, al que da el resolvedor VIVO.
 *      Los puntos 1-4 prueban que la copia está bien; sólo éste prueba que el papel dice lo
 *      mismo;
 *   6. la vista de renglones **efectivamente lee el materializado**. ⛔ Esto es el candado contra
 *      el olvido: `erp_sales_invoice_lines` ya fue redefinida por SIETE migraciones, y la octava
 *      que la escriba con la fuente viva devolvería la regresión de 65 s **sin ningún error**.
 *      Acá se pone rojo;
 *   7. y `v_product_box_factor` quedó **intacta**: sigue siendo una vista y NO lee del
 *      materializado. ⛔ Importa más de lo que parece: tiene **7 dependientes**, entre ellos
 *      `v_unit_truth`, el resolvedor canónico de unidades (ADR-057). Si alguien "simplifica"
 *      apuntando la vista al materializado, le cambia la frescura a la verdad de unidades de
 *      toda la plataforma, en silencio.
 *
 * ⚠️ Si este test se pone rojo, el problema NO es el test: o el refresco dejó de correr, o
 * alguien tocó una de las dos definiciones y el anexo está imprimiendo una equivalencia en cajas
 * que su fuente no respalda.
 *
 * Sólo LEE. Lo único que escribe son tablas TEMP dentro de un ROLLBACK.
 */
const path = require('path');
const { Client } = require('pg');

try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); }
catch { /* dotenv opcional: el runner puede traer el env ya cargado */ }

const MV = 'analytics.mv_product_box_factor';
const VISTA = 'analytics.v_product_box_factor';
const LINEAS = 'analytics.erp_sales_invoice_lines';

let ok = 0; let fail = 0; let nm = 0;
const A = (cond, msg) => { if (cond) { ok++; console.log(`  ✔ ${msg}`); } else { fail++; console.log(`  ✖ ${msg}`); } };
const ND = (msg) => { nm++; console.log(`  · NO MEDIDO — ${msg}`); };
const fin = async (c) => {
  await c.end().catch(() => {});
  console.log(`\n=== ${ok} ✔ · ${fail} ✖ · ${nm} NO MEDIDO ===\n`);
  process.exit(fail ? 1 : 0);
};

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

  // ── 1) ¿Existe? ────────────────────────────────────────────────────────────────────────────
  console.log('\n1) el materializado del factor de caja existe');
  if (!(await c.query(`SELECT to_regclass($1) AS t`, [MV])).rows[0].t) {
    ND(`${MV} no existe (migración sin aplicar; la vista de renglones lee el resolvedor vivo)`);
    return fin(c);
  }
  A(true, `${MV} existe`);

  // ── 2) La llave es única ───────────────────────────────────────────────────────────────────
  console.log('\n2) la llave (tenant, producto) es única');
  const u = (await c.query(`
    SELECT (SELECT count(*) FROM ${MV})::int AS filas,
           (SELECT count(*) FROM (SELECT 1 FROM ${MV}
              GROUP BY tenant_id, product_id HAVING count(*) > 1) z)::int AS dup`)).rows[0];
  A(Number(u.dup) === 0,
    `${Number(u.filas).toLocaleString('es-MX')} filas, ${u.dup} duplicadas`);

  // ── 3) PRUEBA NEGATIVA ─────────────────────────────────────────────────────────────────────
  console.log('\n3) prueba negativa — romper la unicidad a propósito');
  await c.query('BEGIN');
  try {
    await c.query(`CREATE TEMP TABLE _k(t uuid, p uuid) ON COMMIT DROP`);
    const g = `'00000000-0000-0000-0000-000000000001'::uuid`;
    const contar = async () => Number((await c.query(
      `SELECT count(*)::int n FROM (SELECT 1 FROM _k GROUP BY t,p HAVING count(*)>1) z`)).rows[0].n);
    await c.query(`INSERT INTO _k VALUES (${g}, ${g})`);
    const sano = await contar();
    await c.query(`INSERT INTO _k VALUES (${g}, ${g})`);
    const roto = await contar();
    A(sano === 0, `con la llave sana el chequeo da ${sano}`);
    A(roto === 1, `al duplicarla da ${roto} — el chequeo del bloque 2 es REAL, no adorno`);
  } finally { await c.query('ROLLBACK'); }

  // ── 4) El contenido == su vista, fila por fila ─────────────────────────────────────────────
  console.log('\n4) el contenido coincide con su vista (conteo y firma md5 de la fila COMPLETA)');
  const firma = async (rel) => (await c.query(
    `SELECT count(*)::int AS filas, md5(string_agg(f, '|' ORDER BY f)) AS firma
       FROM (SELECT t::text AS f FROM ${rel} t) z`)).rows[0];
  const a = await firma(MV);
  const b = await firma(VISTA);
  A(a.filas === b.filas, `${Number(a.filas).toLocaleString('es-MX')} == ${Number(b.filas).toLocaleString('es-MX')} filas`);
  A(a.firma === b.firma, 'misma firma md5 de la fila COMPLETA — 0 diferencias');
  if (a.firma !== b.firma) {
    console.log('     ⛔ el materializado está VIEJO o su vista cambió. Si el latido');
    console.log('        `mv_existencia_aux_refresh` está fresco, cambió la definición.');
  }

  // ── 5) ⭐ El número IMPRESO no se movió ────────────────────────────────────────────────────
  // Se toman documentos REALES y se compara, renglón por renglón, el `box_factor` que sirve la
  // vista (ya leyendo el materializado) contra el que da el resolvedor VIVO. Es la única
  // comprobación que habla del papel que recibe el cliente; las anteriores hablan de la copia.
  console.log('\n5) ⭐ el box_factor que IMPRIME el anexo es el mismo que da el resolvedor vivo');
  const docs = (await c.query(`
    SELECT tenant_id, sucursal, doc_prefix, folio
      FROM analytics.erp_sales_invoices
     ORDER BY fecha DESC
     LIMIT 8`)).rows;
  if (!docs.length) {
    ND('no hay facturas en esta base con qué comprobarlo');
  } else {
    let lineas = 0; let difieren = 0; let conFactor = 0;
    for (const d of docs) {
      const r = (await c.query(`
        SELECT count(*)::int AS n,
               count(*) FILTER (WHERE l.box_factor IS NOT NULL)::int AS con_factor,
               count(*) FILTER (WHERE l.box_factor IS DISTINCT FROM v.box_factor)::int AS dif
          FROM ${LINEAS} l
          LEFT JOIN ${VISTA} v ON v.tenant_id = l.tenant_id AND v.product_id = l.product_id
         WHERE l.tenant_id = $1 AND l.sucursal = $2 AND l.doc_prefix = $3 AND l.folio = $4`,
        [d.tenant_id, d.sucursal, d.doc_prefix, d.folio])).rows[0];
      lineas += Number(r.n); conFactor += Number(r.con_factor); difieren += Number(r.dif);
    }
    // Un 0 de 0 se lee igual que un 0 de 500: si no hubiera ni un renglón con factor, esto
    // estaría verde sin haber comprobado nada. Por eso el conteo se declara y se exige > 0.
    if (!conFactor) {
      ND(`${lineas} renglones en ${docs.length} documentos, pero NINGUNO trae factor: nada que comparar`);
    } else {
      A(difieren === 0,
        `${lineas} renglones de ${docs.length} facturas · ${conFactor} con factor · ${difieren} difieren del resolvedor vivo`);
    }
  }

  // ── 6) La vista de renglones LEE el materializado (candado anti-regresión) ─────────────────
  console.log('\n6) la vista de renglones lee el materializado, no el resolvedor vivo');
  const defL = (await c.query(`SELECT pg_get_viewdef($1::regclass, true) AS d`, [LINEAS])).rows[0].d || '';
  A(/\banalytics\.mv_product_box_factor\b/.test(defL),
    `${LINEAS.split('.').pop()} lee ${MV.split('.').pop()}`);
  A(!/\banalytics\.v_product_box_factor\b/.test(defL),
    'y ya NO referencia el resolvedor vivo — si una migración futura la reescribe, esto se pone rojo');

  // ── 7) La vista original quedó intacta (blast radius) ──────────────────────────────────────
  console.log('\n7) v_product_box_factor quedó intacta (sus 7 dependientes conservan su frescura)');
  const defV = (await c.query(`SELECT pg_get_viewdef($1::regclass, true) AS d`, [VISTA])).rows[0].d || '';
  A(!/\bmv_product_box_factor\b/.test(defV),
    'v_product_box_factor NO lee del materializado');
  const deps = (await c.query(`
    SELECT count(DISTINCT r.ev_class)::int AS n
      FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
     WHERE d.refobjid = $1::regclass AND r.ev_class <> $1::regclass`, [VISTA])).rows[0].n;
  console.log(`  · ${deps} objetos dependen de v_product_box_factor (por eso NO se toca su cuerpo)`);

  return fin(c);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
