/**
 * `[PR.S1/S2]` — Las capas 1 y 2 del motor de margen: el registro de señales y la vista.
 *
 * ⭐ **Lo que este candado hace y un documento no puede:** cruza lo **declarado** contra lo que
 * **existe**. El registro dice que una señal está cableada; el test abre la vista y verifica que
 * la columna esté ahí de verdad. Una promesa sin respaldo se pone roja.
 *
 * Bloques:
 *   1. El registro: forma, los 10 CHECK, y las 46 señales en 7 familias.
 *   2. ⭐⭐ **La regla de oro**: `peso_max ≤ cobertura_pct/100`, rota a propósito.
 *   3. ⛔ El cruce declarado ↔ real, en las dos direcciones.
 *   4. La vista: que las coberturas por familia sean **distintas** — si fueran iguales, algún
 *      LEFT JOIN se estaría comportando como INNER.
 *   5. ⛔ Las ausencias mudas, que son el defecto que ADR-056 persigue.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-price-signals.js
 */
const { Client } = require('pg');
const { esFaltaDeAcceso, noMedido } = require('./_lib/no-medido');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta DATABASE_URL_NEW'); })();

let ok = 0; let fail = 0;
const ck = (l, c, d = '') => {
  if (c) { ok++; console.log(`  ✔ ${l}`); } else { fail++; console.log(`  ✖ ${l}${d ? ` — ${d}` : ''}`); }
};

async function rechaza(c, etiqueta, sql, params) {
  try {
    await c.query('SAVEPOINT sp');
    await c.query(sql, params);
    await c.query('ROLLBACK TO SAVEPOINT sp');
    ck(`RECHAZA: ${etiqueta}`, false, 'la fila prohibida ENTRÓ');
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT sp').catch(() => {});
    const esperado = /violates check constraint|viola la restricción/i.test(e.message);
    ck(`RECHAZA: ${etiqueta}`, esperado, esperado ? '' : e.message.slice(0, 80));
  }
}

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
  console.log('\n=== [PR.S1/S2] · el registro de señales y la vista ===\n');

  const [ex] = await q(`SELECT to_regclass('analytics.price_signal_registry') IS NOT NULL AS ok`);
  if (!ex.ok) noMedido('falta la migración 20260930200000 en este destino');

  // ── 1 · EL REGISTRO ─────────────────────────────────────────────────────────────────
  console.log('1 · EL REGISTRO');
  const [r] = await q(`
    SELECT count(*)::int total, count(DISTINCT familia)::int familias,
           count(*) FILTER (WHERE estado = 'cableada')::int cableadas,
           count(*) FILTER (WHERE estado = 'disponible')::int disponibles,
           count(*) FILTER (WHERE estado = 'no_existe')::int inexistentes,
           count(*) FILTER (WHERE nucleo)::int nucleo
      FROM analytics.price_signal_registry`);
  ck('las 46 señales están declaradas', r.total === 46, `hay ${r.total}`);
  ck('en 7 familias', r.familias === 7, `hay ${r.familias}`);
  ck('la suma cuadra', r.cableadas + r.disponibles + r.inexistentes === 46,
    `${r.cableadas}+${r.disponibles}+${r.inexistentes}`);
  console.log(`     cableadas ${r.cableadas} · disponibles ${r.disponibles} · `
    + `no existen ${r.inexistentes} · núcleo ${r.nucleo}`);

  const [chk] = await q(`
    SELECT count(*)::int n FROM pg_constraint
     WHERE conrelid = 'analytics.price_signal_registry'::regclass AND contype = 'c'`);
  ck('tiene los 10 CHECK', chk.n >= 10, `hay ${chk.n}`);

  // ── 2 · ⭐⭐ LA REGLA DE ORO ─────────────────────────────────────────────────────────
  console.log('\n2 · ⭐⭐ peso_max ≤ cobertura — la regla que sólo una tabla puede imponer');
  await c.query('BEGIN');
  const INS = `INSERT INTO analytics.price_signal_registry
    (clave, familia, nombre, definicion, unidad, direccion, estado,
     cobertura_pct, cobertura_medida_al, fuente_objeto, fuente_columna, motivo_ausencia, peso_max)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`;

  await rechaza(c, '⭐⭐ un peso MAYOR que su cobertura (el defecto que arruina el motor)', INS,
    ['ZZ1', 'cliente', 'x', 'x', 'pct', 'ninguna', 'cableada', 6.0, '2026-09-30',
      'analytics.v_price_signals', 'c2_fuga_pct', null, 0.50]);
  await rechaza(c, 'una señal CABLEADA sin columna (cableada sería una intención)', INS,
    ['ZZ2', 'costo', 'x', 'x', 'mxn', 'ninguna', 'cableada', 50, '2026-09-30', null, null, null, 0.1]);
  await rechaza(c, 'una ausencia SIN motivo (se leería como un olvido)', INS,
    ['ZZ3', 'costo', 'x', 'x', 'mxn', 'ninguna', 'no_existe', 0, null, null, null, null, 0]);
  await rechaza(c, 'algo que NO existe con cobertura', INS,
    ['ZZ4', 'costo', 'x', 'x', 'mxn', 'ninguna', 'no_existe', 40, '2026-09-30', null, null, 'x', 0]);
  await rechaza(c, 'una cobertura SIN fecha (nadie sabría de cuándo es)', INS,
    ['ZZ5', 'costo', 'x', 'x', 'mxn', 'ninguna', 'disponible', 40, null, null, null, 'x', 0.1]);
  await rechaza(c, 'una familia inventada', INS,
    ['ZZ6', 'loquesea', 'x', 'x', 'mxn', 'ninguna', 'no_existe', 0, null, null, null, 'x', 0]);

  // Control positivo: sin él, un rechazo por permisos se leería como candado que funciona.
  try {
    await c.query('SAVEPOINT okp');
    await c.query(INS, ['ZZ9', 'costo', 'legítima', 'una señal bien formada', 'mxn',
      'menos_es_mejor', 'cableada', 38.2, '2026-09-30',
      'analytics.v_price_signals', 'a1_costo_hoy', null, 0.38]);
    ck('⭐ CONTROL POSITIVO: la señal bien formada SÍ entra', true);
    await c.query('ROLLBACK TO SAVEPOINT okp');
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT okp').catch(() => {});
    ck('⭐ CONTROL POSITIVO: la señal bien formada SÍ entra', false, e.message.slice(0, 100));
  }
  await c.query('ROLLBACK');

  // ── 3 · ⛔ DECLARADO ↔ REAL, en las dos direcciones ─────────────────────────────────
  console.log('\n3 · ⛔ el cruce que un documento no puede hacer');
  const [x] = await q(`
    WITH reales AS (
      SELECT a.attname FROM pg_attribute a
       WHERE a.attrelid = 'analytics.v_price_signals'::regclass
         AND a.attnum > 0 AND NOT a.attisdropped
    )
    SELECT count(*) FILTER (WHERE estado = 'cableada'
                              AND fuente_columna NOT IN (SELECT attname FROM reales))::int mentirosas,
           count(*) FILTER (WHERE estado <> 'cableada'
                              AND fuente_columna IS NOT NULL)::int columna_de_mas
      FROM analytics.price_signal_registry`);
  ck('⛔ ninguna señal CABLEADA sin su columna real en la vista', x.mentirosas === 0,
    `${x.mentirosas} mienten`);
  ck('⛔ ninguna señal NO cableada apuntando a una columna', x.columna_de_mas === 0);

  // ── 4 · LA VISTA ────────────────────────────────────────────────────────────────────
  console.log('\n4 · LA VISTA — las coberturas tienen que DIFERIR');
  const t0 = Date.now();
  const [v] = await q(`
    SELECT count(*)::int filas,
           count(*) FILTER (WHERE f1_cobertura = 'completa')::int f1,
           count(*) FILTER (WHERE f2_cobertura = 'completa')::int f2,
           count(*) FILTER (WHERE f3_cobertura = 'completa')::int f3,
           count(*) FILTER (WHERE f4_cobertura = 'completa')::int f4,
           count(*) FILTER (WHERE u1_fuente_peldano = 'vendido')::int p_vendido,
           count(*) FILTER (WHERE u1_fuente_peldano = 'base_sin_venta')::int p_base
      FROM analytics.v_price_signals`);
  const ms = Date.now() - t0;
  const pc = (n) => `${((100 * n) / v.filas).toFixed(1)}%`;
  console.log(`     ${v.filas.toLocaleString()} filas en ${ms} ms · psicología ${pc(v.f1)} · `
    + `meta ${pc(v.f2)} · costo ${pc(v.f3)} · cliente ${pc(v.f4)}`);

  ck('la vista devuelve filas', v.filas > 0);
  /**
   * ⭐ Si psicología y cliente tuvieran la MISMA cobertura, algún LEFT JOIN se estaría
   * comportando como INNER — y el motor creería que el mostrador tiene evidencia de cliente.
   */
  ck('⭐ psicología y cliente NO tienen la misma cobertura', v.f1 !== v.f4,
    'un LEFT JOIN se está comportando como INNER');
  ck('⛔ la cobertura de cliente es mucho menor (el mostrador es anónimo)', v.f4 < v.f1 * 0.5,
    `${pc(v.f4)} contra ${pc(v.f1)}`);
  ck('⭐ el peldaño distingue vendido de respaldo', v.p_vendido > 0 && v.p_base > 0,
    `vendido ${v.p_vendido}, base ${v.p_base}`);

  // ── 5 · ⛔ AUSENCIAS MUDAS ──────────────────────────────────────────────────────────
  console.log('\n5 · ⛔ ninguna ausencia MUDA (ADR-056)');
  const [m] = await q(`
    SELECT count(*) FILTER (WHERE f4_cobertura <> 'completa' AND f4_motivo IS NULL)::int m4,
           count(*) FILTER (WHERE f2_cobertura <> 'completa' AND f2_motivo IS NULL)::int m2,
           count(*) FILTER (WHERE f4_veredicto = 'sin_evidencia_de_cliente'
                              AND c2_fuga_pct IS NOT NULL)::int fuga_fantasma,
           count(*) FILTER (WHERE u1_fuente_peldano = 'base_sin_venta'
                              AND f2_veredicto = 'peldano_claro')::int respaldo_mentiroso
      FROM analytics.v_price_signals`);
  ck('⛔ toda ausencia de cliente lleva motivo', m.m4 === 0, `${m.m4} mudas`);
  ck('⛔ toda ausencia de meta lleva motivo', m.m2 === 0, `${m.m2} mudas`);
  ck('⛔ ninguna fuga publicada sin evidencia (eso no es descuento cero)', m.fuga_fantasma === 0);
  ck('⛔ ningún peldaño de respaldo reportado como claro', m.respaldo_mentiroso === 0);

  if (ms > 8000) {
    console.log(`  ⓘ ${ms} ms — por encima del gate de 1 s para pantalla. Declarado, no oculto.`);
  }

  await c.end();
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} ✓ / ${fail} ✗\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\n💥', e.message); process.exit(1); });
