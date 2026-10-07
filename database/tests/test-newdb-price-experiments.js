/**
 * `[PR.D2]` — El experimento de precio: lo que tiene PROHIBIDO por construcción.
 *
 * Este candado existe porque un experimento mal armado **no falla: concluye mal**. Devuelve un
 * número, con su intervalo, y nadie puede distinguirlo de uno bueno. Así que las prohibiciones
 * viven en la tabla —no en el servicio— y acá se rompen una por una:
 *
 *   ⛔ un **control cuyo precio se mueve** (deja de ser control, y el DiD mide otra cosa)
 *   ⛔ un **tratamiento que no se mueve** (es otro control disfrazado: diluye el efecto)
 *   ⛔ un **resultado sin motivo** (un veredicto sin defensa)
 *   ⛔ **concluir sin fechas** (no se puede saber sobre qué ventana corrió)
 *   ⛔ la **misma celda dos veces** en un experimento (se contaría doble)
 *   ⛔ un **δ fuera de rango**
 *
 * Y el control positivo: la fila legítima SÍ entra. Sin él, un rechazo por permisos o por FK se
 * leería como "el candado funciona" (ADR-056).
 *
 * Todo dentro de una transacción con ROLLBACK: no deja nada.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-price-experiments.js
 */
const { Client } = require('pg');
const { esFaltaDeAcceso, noMedido } = require('./_lib/no-medido');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta DATABASE_URL_NEW'); })();
const TENANT = '00000000-0000-0000-0000-00000000d01c';

let ok = 0; let fail = 0;
const ck = (l, c, d = '') => {
  if (c) { ok++; console.log(`  ✔ ${l}`); } else { fail++; console.log(`  ✖ ${l}${d ? ` — ${d}` : ''}`); }
};

/** Intenta una escritura que DEBE fallar. Si entra, el candado no existe. */
async function rechaza(c, etiqueta, sql, params) {
  try {
    await c.query('SAVEPOINT sp');
    await c.query(sql, params);
    await c.query('ROLLBACK TO SAVEPOINT sp');
    ck(`RECHAZA: ${etiqueta}`, false, 'la fila prohibida ENTRÓ');
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT sp').catch(() => {});
    const esperado = /violates check constraint|viola la restricción|duplicate key|llave duplicada|unique constraint/i.test(e.message);
    ck(`RECHAZA: ${etiqueta}`, esperado, esperado ? '' : `falló por otra razón: ${e.message.slice(0, 90)}`);
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
  console.log('\n=== [PR.D2] · el experimento de precio ===\n');

  const [ex] = await q(`SELECT to_regclass('commercial.price_experiments') IS NOT NULL AS ok`);
  if (!ex.ok) noMedido('falta la migración 20260930140000 en este destino');

  // ── 1 · FORMA ───────────────────────────────────────────────────────────────────────
  console.log('1 · FORMA');
  for (const t of ['price_experiments', 'price_experiment_units']) {
    const [r] = await q(`
      SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forzada
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'commercial' AND c.relname = $1`, [t]);
    // FORZADA importa: sin ella el dueño de la tabla ve todos los tenants.
    ck(`commercial.${t}: RLS FORZADA`, !!r?.forzada && !!r?.rls);
    const [g] = await q(
      `SELECT has_table_privilege('app_runtime', $1, 'SELECT') AS s`, [`commercial.${t}`]);
    ck(`commercial.${t}: app_runtime puede leer`, !!g?.s);
  }

  await c.query('BEGIN');
  await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);

  const EXP_ID = '11111111-2222-3333-4444-555555555555';
  const INS_EXP = `INSERT INTO commercial.price_experiments
    (id, tenant_id, nombre, hipotesis, tipo, metrica, modo_aterrizaje, semilla, estado,
     fecha_inicio, fecha_fin, resultado, resultado_motivo)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`;

  // ── 2 · ⛔ NEGATIVAS DE LA CABECERA ─────────────────────────────────────────────────
  console.log('\n2 · ⛔ NEGATIVAS — la cabecera');
  await rechaza(c, 'un resultado SIN motivo (veredicto sin defensa)', INS_EXP,
    [EXP_ID, TENANT, 'zz-t1', 'h', 'no_inferioridad', 'ln_volumen', '99', 42, 'concluido',
      '2026-01-01', '2026-02-01', 'no_inferior', null]);
  await rechaza(c, 'CONCLUIDO sin fechas (no se sabe sobre qué ventana corrió)', INS_EXP,
    [EXP_ID, TENANT, 'zz-t2', 'h', 'no_inferioridad', 'ln_volumen', '99', 42, 'concluido',
      null, null, 'no_inferior', 'porque sí']);
  await rechaza(c, 'un modo de aterrizaje que no existe', INS_EXP,
    [EXP_ID, TENANT, 'zz-t3', 'h', 'no_inferioridad', 'ln_volumen', '77', 42, 'diseno',
      null, null, null, null]);
  await rechaza(c, 'un tipo de experimento inventado', INS_EXP,
    [EXP_ID, TENANT, 'zz-t4', 'h', 'lo_que_sea', 'ln_volumen', '99', 42, 'diseno',
      null, null, null, null]);

  // El experimento legítimo, del que cuelgan las unidades.
  await c.query(INS_EXP, [EXP_ID, TENANT, 'zz-test-no-inferioridad',
    'El alza de aterrizar a .99 NO hace caer el volumen mas de delta',
    'no_inferioridad', 'ln_volumen', '99', 20260930, 'diseno', null, null, null, null]);
  ck('⭐ CONTROL POSITIVO: el experimento legítimo SÍ entra', true);

  // ── 3 · ⛔ NEGATIVAS DE LA ASIGNACIÓN ───────────────────────────────────────────────
  console.log('\n3 · ⛔ NEGATIVAS — la asignación (acá vive lo que arruinaría el resultado)');
  const INS_U = `INSERT INTO commercial.price_experiment_units
    (tenant_id, experiment_id, sucursal, sku, unit_kind, estrato, delta_pct, rama,
     precio_antes, precio_propuesto)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;

  await rechaza(c, '⭐ un CONTROL cuyo precio se mueve (deja de ser control)', INS_U,
    [TENANT, EXP_ID, '01', 'ZZ-A', 'pieza', 'b', 7.09, 'control', 20.00, 20.99]);
  await rechaza(c, '⭐ un TRATAMIENTO que no se mueve (control disfrazado)', INS_U,
    [TENANT, EXP_ID, '01', 'ZZ-B', 'pieza', 'b', 7.09, 'tratamiento', 20.00, 20.00]);
  await rechaza(c, 'una rama que no existe', INS_U,
    [TENANT, EXP_ID, '01', 'ZZ-C', 'pieza', 'b', 7.09, 'placebo', 20.00, 20.99]);
  await rechaza(c, 'un δ fuera de rango', INS_U,
    [TENANT, EXP_ID, '01', 'ZZ-D', 'pieza', 'b', 140, 'tratamiento', 20.00, 20.99]);
  await rechaza(c, 'un precio en cero', INS_U,
    [TENANT, EXP_ID, '01', 'ZZ-E', 'pieza', 'b', 7.09, 'tratamiento', 0, 20.99]);

  // Dos legítimas — el control positivo de la asignación.
  await c.query(INS_U, [TENANT, EXP_ID, '01', 'ZZ-OK1', 'pieza', 'b', 7.09, 'tratamiento', 20.34, 20.99]);
  await c.query(INS_U, [TENANT, EXP_ID, '01', 'ZZ-OK2', 'pieza', 'b', 7.09, 'control', 20.34, 20.34]);
  ck('⭐ CONTROL POSITIVO: tratamiento y control legítimos SÍ entran', true);

  await rechaza(c, 'la MISMA celda dos veces en el mismo experimento (se contaría doble)', INS_U,
    [TENANT, EXP_ID, '01', 'ZZ-OK1', 'pieza', 'b', 7.09, 'control', 20.34, 20.34]);

  // ── 4 · LO QUE SALVA AL EXPERIMENTO DE MENTIR ───────────────────────────────────────
  console.log('\n4 · ⭐ aplicado_at — la columna que evita la conclusión opuesta a la verdad');
  const [col] = await q(`
    SELECT count(*)::int n FROM information_schema.columns
     WHERE table_schema = 'commercial' AND table_name = 'price_experiment_units'
       AND column_name IN ('aplicado_at', 'aplicado_por', 'no_aplicado_motivo')`);
  ck('existen aplicado_at · aplicado_por · no_aplicado_motivo', col.n === 3, `hay ${col.n}`);
  const [sinAplicar] = await q(`
    SELECT count(*) FILTER (WHERE rama = 'tratamiento' AND aplicado_at IS NULL)::int pendientes
      FROM commercial.price_experiment_units WHERE experiment_id = $1`, [EXP_ID]);
  ck('⭐ un tratamiento recién asignado nace SIN aplicar (Kepler es read-only: lo captura una persona)',
    sinAplicar.pendientes === 1, `${sinAplicar.pendientes}`);

  // ── 5 · LA SEMILLA ──────────────────────────────────────────────────────────────────
  console.log('\n5 · ⭐ la semilla — sin ella el experimento no se puede auditar');
  const [s] = await q(`
    SELECT semilla, hipotesis FROM commercial.price_experiments WHERE id = $1`, [EXP_ID]);
  ck('la semilla quedó guardada', s?.semilla != null);
  ck('la hipótesis quedó escrita ANTES de asignar', !!s?.hipotesis && s.hipotesis.length > 20);
  const [nn] = await q(`
    SELECT count(*)::int n FROM information_schema.columns
     WHERE table_schema='commercial' AND table_name='price_experiments'
       AND column_name='semilla' AND is_nullable='NO'`);
  ck('⛔ y la semilla es NOT NULL: no se puede omitir', nn.n === 1);

  await c.query('ROLLBACK');
  await c.end();
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} ✓ / ${fail} ✗\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\n💥', e.message); process.exit(1); });
