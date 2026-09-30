/**
 * `[PR.D1]` — La capa PSICOLÓGICA del precio: dónde aterriza, y qué tiene prohibido hacer.
 *
 * Qué prueba y por qué cada bloque existe:
 *   1. La forma: las 3 funciones, la vista, `security_invoker` y el grant.
 *   2. ⭐ **Las funciones, caso por caso.** Son `IMMUTABLE`, así que se pueden probar aisladas
 *      con valores elegidos — sin datos, sin transacción, sin ambiente. Es la única parte de
 *      este motor que se puede verificar de forma exacta, y por eso se hace.
 *   3. ⛔ **Las SEIS pruebas negativas** contra el catálogo real. Un candado que nunca se
 *      rompe a propósito es una intención (ADR-056).
 *   4. El control positivo: que la vista SÍ encuentre lo que existe.
 *   5. ⭐ La separación honesta: el alza implícita se publica, la señalización se DECLARA.
 *
 * No escribe nada: la vista y las funciones son de sólo lectura.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-price-psychology.js
 */
const { Client } = require('pg');
const { esFaltaDeAcceso, noMedido } = require('./_lib/no-medido');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta DATABASE_URL_NEW'); })();

let ok = 0; let fail = 0;
const ck = (l, c, d = '') => {
  if (c) { ok++; console.log(`  ✔ ${l}`); } else { fail++; console.log(`  ✖ ${l}${d ? ` — ${d}` : ''}`); }
};

(async () => {
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await c.connect().catch((e) => {
    if (esFaltaDeAcceso(e)) noMedido(`no se pudo conectar — ${e.message}`);
    throw e;
  });
  const q = async (s, p) => (await c.query(s, p)).rows;
  console.log('\n=== [PR.D1] · la capa psicológica del precio ===\n');

  const [existe] = await q(`SELECT to_regclass('analytics.v_price_psychology') IS NOT NULL AS ok`);
  if (!existe.ok) noMedido('falta la migración 20260930120000 en este destino');

  // ── 1 · FORMA ───────────────────────────────────────────────────────────────────────
  console.log('1 · FORMA');
  for (const fn of ['fn_precio_escalon', 'fn_precio_umbral_percepcion', 'fn_precio_aterriza']) {
    const [f] = await q(`
      SELECT p.provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'analytics' AND p.proname = $1 LIMIT 1`, [fn]);
    ck(`analytics.${fn} existe`, !!f);
    // IMMUTABLE ('i') importa: permite usarla en índices y garantiza que el mismo insumo
    // siempre dé el mismo precio. Una función de precio VOLATILE sería indefendible.
    if (f) ck(`analytics.${fn} es IMMUTABLE`, f.provolatile === 'i', `es '${f.provolatile}'`);
  }
  const [v] = await q(`
    SELECT c.reloptions, has_table_privilege('app_runtime', c.oid, 'SELECT') AS lee
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'analytics' AND c.relname = 'v_price_psychology'`);
  ck('la vista es security_invoker', (v?.reloptions || []).some((o) => /security_invoker=true/.test(o)));
  ck('app_runtime puede leerla', !!v?.lee);

  // ── 2 · ⭐ LAS FUNCIONES, CASO POR CASO ─────────────────────────────────────────────
  console.log('\n2 · ⭐ LAS FUNCIONES (IMMUTABLE ⇒ se prueban aisladas, con valores elegidos)');

  const casos = [
    // [precio, modo, esperado, por qué]
    [86.88, '00', '87.00', 'redondea al entero'],
    [86.88, '90', '86.90', 'se cuelga del entero de ABAJO'],
    [86.88, '99', '86.99', 'idem .99'],
    [86.88, '50', '87.00', 'medio peso más cercano'],
    [89.40, '90', '89.90', '⭐ NO salta a 90.90: aterrizar no encarece de más'],
    [1523.93, '00', '1520.00', 'el escalón es 10 arriba de $500'],
    [5000.00, '00', '5000.00', '⭐ $5,000 NO aterriza a $4,999.90'],
    [0.01, '00', null, '⛔ PISO: debajo de $1 no se aterriza nada'],
    [0.05, '90', null, '⛔ el marcador del ERP no se convierte en $0.90'],
    [86.88, 'xx', null, 'modo desconocido no inventa un precio'],
    [null, '00', null, 'sin precio no hay aterrizaje'],
  ];
  for (const [precio, modo, esperado, porque] of casos) {
    const [r] = await q(`SELECT analytics.fn_precio_aterriza($1::numeric, $2) AS v`, [precio, modo]);
    const got = r.v === null ? null : Number(r.v).toFixed(2);
    const want = esperado === null ? null : Number(esperado).toFixed(2);
    ck(`aterriza(${precio ?? 'NULL'}, '${modo}') = ${esperado ?? 'NULL'} — ${porque}`,
      got === want, `dio ${got ?? 'NULL'}`);
  }

  for (const [p, esp] of [[5, '0.50'], [50, '1.00'], [200, '5.00'], [1000, '10.00'], [5000, '50.00']]) {
    const [r] = await q(`SELECT analytics.fn_precio_escalon($1::numeric) AS v`, [p]);
    ck(`escalón($${p}) = ${esp}`, Number(r.v).toFixed(2) === Number(esp).toFixed(2), `dio ${r.v}`);
  }
  // ⭐ El umbral NO es constante: si lo fuera, este bloque pasaría con cualquier valor.
  const [u1] = await q(`SELECT analytics.fn_precio_umbral_percepcion(8::numeric) AS v`);
  const [u2] = await q(`SELECT analytics.fn_precio_umbral_percepcion(300::numeric) AS v`);
  ck('⭐ el umbral de percepción CAMBIA con el rango (no es una constante)',
    Number(u1.v) !== Number(u2.v), `$8 → ${u1.v} · $300 → ${u2.v}`);
  ck('  y el de un producto barato es MENOR que el de uno caro',
    Number(u1.v) < Number(u2.v), `${u1.v} vs ${u2.v}`);

  // ── 3 · ⛔ LAS SEIS PRUEBAS NEGATIVAS, contra el catálogo real ──────────────────────
  console.log('\n3 · ⛔ PRUEBAS NEGATIVAS (un candado sin prueba negativa es una intención)');
  const [g] = await q(`
    SELECT count(*)::int filas,
           count(*) FILTER (WHERE cand_90 > precio + 1.0)::int n1,
           count(*) FILTER (WHERE cand_00 <= 0 OR cand_50 <= 0
                              OR cand_90 <= 0 OR cand_99 <= 0)::int n2,
           count(*) FILTER (WHERE centavos = 0 AND terminacion <> 'entero')::int n3,
           count(*) FILTER (WHERE cand_00 IS NULL AND motivo_fuera_de_alcance IS NULL)::int n4,
           count(*) FILTER (WHERE cand_00 IS NOT NULL
                              AND abs(cand_00 - precio) > escalon)::int n5,
           count(*) FILTER (WHERE efecto_senalizacion_pct IS NOT NULL)::int n6,
           count(*) FILTER (WHERE veredicto = 'fuera_de_alcance')::int fuera,
           count(*) FILTER (WHERE terminacion = 'sucio')::int sucios
      FROM analytics.v_price_psychology`);

  ck('⛔ el modo .90 nunca encarece más de $1', g.n1 === 0, `${g.n1} casos`);
  ck('⛔ ningún candidato vale cero ni negativo', g.n2 === 0, `${g.n2} casos`);
  ck('⛔ un precio entero nunca se clasifica como sucio', g.n3 === 0, `${g.n3} casos`);
  ck('⛔ ninguna ausencia MUDA: sin candidato ⇒ con motivo', g.n4 === 0, `${g.n4} casos`);
  ck('⛔ ningún aterrizaje se aleja más de un escalón', g.n5 === 0, `${g.n5} casos`);
  ck('⛔ la señalización NO se inventa: va NULL hasta el A/B', g.n6 === 0, `${g.n6} casos`);

  // ── 4 · CONTROL POSITIVO ────────────────────────────────────────────────────────────
  console.log('\n4 · ⭐ CONTROL POSITIVO (sin esto, un filtro mal puesto se leería como candado)');
  ck('la vista devuelve filas', g.filas > 0, `${g.filas}`);
  ck('⭐ encuentra precios sucios — son la razón de esta capa', g.sucios > 0,
    'cero sucios contradice el 93.4 % medido');
  ck('⭐ el piso de $1 ACTÚA: hay filas fuera de alcance', g.fuera > 0,
    'los marcadores del ERP deberían quedar fuera');

  // ── 5 · ⭐ LA SEPARACIÓN HONESTA ────────────────────────────────────────────────────
  console.log('\n5 · ⭐ el ALZA se publica, la SEÑALIZACIÓN se declara');
  const [s] = await q(`
    SELECT
      round(sum(venta_neta_30d * alza_implicita_00_pct / 100.0)::numeric, 0) AS alza_00,
      round(sum(venta_neta_30d * alza_implicita_99_pct / 100.0)::numeric, 0) AS alza_99,
      count(DISTINCT senalizacion_motivo)::int AS motivos
      FROM analytics.v_price_psychology WHERE venta_neta_30d > 0`);
  console.log(`     modo .00 → $${Number(s.alza_00).toLocaleString()}/30 d   `
    + `modo .99 → $${Number(s.alza_99).toLocaleString()}/30 d`);
  /**
   * ⭐ El modo .00 tiene que ser CASI NEUTRO: redondea hacia abajo tanto como hacia arriba.
   * Si diera un alza grande, el escalón estaría sesgado y la capa estaría subiendo precios
   * con la excusa de redondear. Es la prueba de que la aritmética no tiene el pulgar puesto.
   */
  ck('⭐ el modo .00 es casi neutro (redondea en las dos direcciones)',
    Math.abs(Number(s.alza_00)) < Math.abs(Number(s.alza_99)) / 4,
    `.00 = ${s.alza_00} contra .99 = ${s.alza_99}`);
  ck('el motivo de la señalización no medida está escrito', s.motivos >= 1);

  await c.end();
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} ✓ / ${fail} ✗\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\n💥', e.message); process.exit(1); });
