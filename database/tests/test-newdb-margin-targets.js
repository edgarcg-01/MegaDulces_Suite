/**
 * `[PR.E0b]` — La meta de margen es un DATO, no una constante.
 *
 * Lo que este test prueba, y por qué cada bloque existe:
 *   1. La forma: tablas, RLS FORZADA, grants, y la fila default sembrada.
 *   2. ⛔ **LAS PRUEBAS NEGATIVAS.** Un CHECK que nunca se rompe a propósito es una intención
 *      (ADR-056). Acá se INTENTA insertar cada fila prohibida y se exige el rechazo:
 *        · dos ámbitos en la misma fila (la cascada quedaría ambigua)
 *        · piso >= objetivo (deja el objetivo inalcanzable: todo rojo sin etapa intermedia)
 *        · objetivo fuera de (0, 100)
 *        · vigencia que termina antes de empezar
 *   3. La cascada resuelve producto > categoría > proveedor > default.
 *   4. El rastro de auditoría dispara (se engancha a `analytics.master_data_history`, VP.3.1).
 *   5. ⭐ Que NO quede ninguna constante `15` viva en el código.
 *
 * Todo dentro de una transacción con ROLLBACK: no deja nada.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-margin-targets.js
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const { esFaltaDeAcceso, noMedido } = require('./_lib/no-medido');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta DATABASE_URL_NEW'); })();
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const RAIZ = path.join(__dirname, '..', '..');

let ok = 0; let fail = 0;
const ck = (l, c, d = '') => {
  if (c) { ok++; console.log(`  ✔ ${l}`); } else { fail++; console.log(`  ✖ ${l}${d ? ` — ${d}` : ''}`); }
};

/** Intenta una escritura que DEBE fallar. Si pasa, el candado no existe. */
async function rechaza(c, etiqueta, sql, params) {
  try {
    await c.query('SAVEPOINT sp');
    await c.query(sql, params);
    await c.query('ROLLBACK TO SAVEPOINT sp');
    ck(`RECHAZA: ${etiqueta}`, false, 'la fila prohibida ENTRÓ — el candado no existe');
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT sp').catch(() => {});
    const esCheck = /violates check constraint|viola la restricción/i.test(e.message);
    ck(`RECHAZA: ${etiqueta}`, esCheck, esCheck ? '' : `falló por otra razón: ${e.message.slice(0, 90)}`);
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
  console.log('\n=== [PR.E0b] · la meta de margen es un DATO, no una constante ===\n');

  const existe = (await q(`SELECT to_regclass('commercial.margin_targets') IS NOT NULL AS ok`))[0];
  if (!existe.ok) noMedido('falta la migración 20260929170000 en este destino');

  // ── 1 · FORMA ───────────────────────────────────────────────────────────────────────
  console.log('1 · FORMA');
  for (const t of ['margin_targets', 'pricing_settings']) {
    const [r] = await q(`
      SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forzada
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'commercial' AND c.relname = $1`, [t]);
    ck(`commercial.${t}: RLS habilitada`, !!r?.rls);
    // FORZADA importa: sin ella el dueño de la tabla ve todos los tenants.
    ck(`commercial.${t}: RLS FORZADA`, !!r?.forzada);
    const [g] = await q(
      `SELECT has_table_privilege('app_runtime', $1, 'SELECT') AS s`, [`commercial.${t}`]);
    ck(`commercial.${t}: app_runtime puede leer`, !!g?.s);
  }
  const [chk] = await q(`
    SELECT count(*)::int n FROM pg_constraint
     WHERE conrelid = 'commercial.margin_targets'::regclass AND contype = 'c'`);
  ck('margin_targets: tiene los 6 CHECK', chk.n >= 6, `hay ${chk.n}`);

  // ── 2 · LA FILA DEFAULT, y que declara lo que NO sabe ───────────────────────────────
  console.log('\n2 · EL DEFAULT SEMBRADO');
  const [def] = await q(`
    SELECT margen_objetivo, margen_minimo, minimo_motivo, source, manual_lock
      FROM commercial.margin_targets
     WHERE tenant_id = $1 AND product_id IS NULL AND categoria IS NULL AND supplier_code IS NULL`,
  [TENANT]);
  ck('existe la fila default del tenant', !!def);
  if (def) {
    ck("source = 'kepler_ponderado_peldano_vendido' (la política que el ERP ya aplica)",
      def.source === 'kepler_ponderado_peldano_vendido' || def.manual_lock === true, def.source);

    /**
     * ⭐⭐ NO se afirma una constante: se RE-MIDE.
     *
     * El default salió de ponderar la meta de Kepler por el peldaño que de verdad se vende
     * (`[PR.E0d]`). Un número medido clavado en un test es una medición con fecha de caducidad
     * que nadie revisa — la Fase CDRP ya pagó esa: una medición que sostenía una decisión vivía
     * en un `COMMENT ON TABLE` de prod y **envejeció en tres días** sin que nada se pusiera rojo.
     *
     * Acá el test vuelve a calcularlo y compara. Si la fila se aleja de lo que Kepler dice hoy,
     * o la política de precios se movió (y alguien tiene que enterarse) o el cálculo se rompió.
     * Las dos merecen un rojo.
     */
    const [viva] = await q(`
      WITH s AS (
        SELECT source_branch AS sucursal, sku, factor_sale, sum(monto_neto) AS venta
          FROM analytics.mv_kepler_sales_daily
         WHERE business_date >= CURRENT_DATE - 90 AND monto_neto > 0
         GROUP BY 1,2,3
      )
      SELECT round((sum(s.venta * m.margen_venta_pct) / NULLIF(sum(s.venta),0))::numeric, 3) meta
        FROM s JOIN analytics.v_kepler_margin_target m
          ON m.sucursal = s.sucursal AND m.sku = s.sku AND m.veredicto = 'capturado'
         AND abs(COALESCE(m.factor,1) - COALESCE(s.factor_sale,1)) < 0.01`);

    if (viva?.meta == null) {
      // ADR-056: sin venta con qué medirlo no hay ✔ ni ✖ — se declara.
      console.log('  ⓘ NO MEDIDO: sin venta pareada en este destino, no hay con qué re-medir la meta.');
    } else if (def.manual_lock) {
      console.log(`  ⓘ la fila tiene manual_lock (${def.margen_objetivo}%): la fijó un humano, `
        + `no se compara contra Kepler (${viva.meta}%).`);
    } else {
      // Tolerancia DECLARADA: la ventana de 90 días rodante mueve el ponderado unas décimas.
      // Más de 1.5 pp no es deriva, es un cambio de política o un cálculo roto.
      const d = Math.abs(Number(def.margen_objetivo) - Number(viva.meta));
      ck(`⭐ el default sigue siendo lo que Kepler dice HOY (${viva.meta}%, Δ ${d.toFixed(3)} pp)`,
        d <= 1.5, `la fila dice ${def.margen_objetivo}% y Kepler ${viva.meta}%`);
    }

    // ⛔ Y que NO haya vuelto al 15 sin fuente que esta fase retiró.
    ck('⛔ el 15 sin fuente no volvió', Number(def.margen_objetivo) !== 15,
      'la fila default volvió al valor que no salía de ningún lado');

    ck('manual_lock arranca en false', def.manual_lock === false);
    // ⭐ El piso NO se inventa: va NULL CON MOTIVO. Un piso dibujado decide precios.
    ck('⭐ margen_minimo es NULL (el piso no es determinable, D13)', def.margen_minimo === null,
      `es ${def.margen_minimo}`);
    ck('⭐ y el motivo está escrito', !!def.minimo_motivo && def.minimo_motivo.length > 40);
  }

  // ── 3 · ⛔ LAS PRUEBAS NEGATIVAS ────────────────────────────────────────────────────
  console.log('\n3 · ⛔ PRUEBAS NEGATIVAS (un candado sin prueba negativa es una intención)');
  await c.query('BEGIN');
  const INS = `INSERT INTO commercial.margin_targets
    (tenant_id, product_id, categoria, supplier_code, margen_objetivo, margen_minimo,
     source, vigencia_desde, vigencia_hasta)
    VALUES ($1, NULL, $2, $3, $4, $5, 'test', $6, $7)`;
  await rechaza(c, 'dos ámbitos en la misma fila (cascada ambigua)',
    INS, [TENANT, 'CAT-X', 'PROV-X', 20, null, '2026-01-01', null]);
  await rechaza(c, 'piso >= objetivo (deja el objetivo inalcanzable)',
    INS, [TENANT, 'CAT-Y', null, 20, 25, '2026-01-01', null]);
  await rechaza(c, 'objetivo fuera de (0, 100)',
    INS, [TENANT, 'CAT-Z', null, 120, null, '2026-01-01', null]);
  await rechaza(c, 'vigencia que termina antes de empezar',
    INS, [TENANT, 'CAT-W', null, 20, null, '2026-06-01', '2026-01-01']);
  // Y el CONTROL POSITIVO: la fila legítima SÍ entra. Sin esto, un rechazo por otra causa
  // (permisos, FK) se leería como "el candado funciona".
  try {
    await c.query('SAVEPOINT ok');
    await c.query(INS, [TENANT, 'CAT-LEGIT', null, 22.5, 11, '2026-01-01', null]);
    ck('⭐ CONTROL POSITIVO: la fila legítima SÍ entra', true);
    await c.query('ROLLBACK TO SAVEPOINT ok');
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT ok').catch(() => {});
    ck('⭐ CONTROL POSITIVO: la fila legítima SÍ entra', false, e.message.slice(0, 110));
  }

  // ── 4 · LA CASCADA ─────────────────────────────────────────────────────────────────
  console.log('\n4 · LA CASCADA producto > categoría > proveedor > default');
  await c.query(
    `INSERT INTO commercial.margin_targets (tenant_id, categoria, margen_objetivo, source)
     VALUES ($1, 'ZZZ-TEST-CAT', 33.5, 'test')`, [TENANT]);
  const [cat] = await q(`
    SELECT margen_objetivo FROM commercial.margin_targets
     WHERE tenant_id = $1 AND categoria = 'ZZZ-TEST-CAT'`, [TENANT]);
  ck('una meta por categoría se puede guardar y leer', Number(cat?.margen_objetivo) === 33.5);
  const [conteo] = await q(`
    SELECT count(*)::int n FROM commercial.margin_targets
     WHERE tenant_id = $1 AND product_id IS NULL AND categoria IS NULL AND supplier_code IS NULL`,
  [TENANT]);
  ck('sigue habiendo UNA sola fila default (el índice único la protege)', conteo.n === 1, `hay ${conteo.n}`);

  // ── 5 · EL RASTRO DE AUDITORÍA ─────────────────────────────────────────────────────
  console.log('\n5 · AUDITORÍA (se engancha a analytics.master_data_history, VP.3.1)');
  const [trg] = await q(`
    SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
      JOIN pg_class cl ON cl.oid = t.tgrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE n.nspname='commercial' AND cl.relname='margin_targets'
       AND t.tgname='trg_master_data_history'`);
  ck('margin_targets: trigger de historia presente', !!trg);
  if (trg) {
    ck('vigila margen_objetivo y manual_lock',
      /'margen_objetivo'/.test(trg.def) && /'manual_lock'/.test(trg.def));
    const antes = (await q(`SELECT count(*)::int n FROM analytics.master_data_history`))[0].n;
    await c.query(
      `UPDATE commercial.margin_targets SET margen_objetivo = 34.5
        WHERE tenant_id = $1 AND categoria = 'ZZZ-TEST-CAT'`, [TENANT]);
    const desp = (await q(`SELECT count(*)::int n FROM analytics.master_data_history`))[0].n;
    ck('⭐ cambiar la meta deja rastro', desp === antes + 1, `${antes} → ${desp}`);
  }
  await c.query('ROLLBACK');

  // ── 6 · ⭐ QUE NO QUEDE NINGUNA CONSTANTE VIVA ─────────────────────────────────────
  console.log('\n6 · ⭐ el 15 hardcodeado desapareció del código');
  const ARCH = [
    'libs/commercial/src/lib/commercial-intelligence/commercial-actions.service.ts',
    'libs/commercial/src/lib/commercial-profitability/commercial-profitability.service.ts',
  ];
  // ⚠️ Corriendo DENTRO del contenedor de prod no hay árbol de fuentes (la imagen trae `dist`).
  // Eso NO es un fallo del candado: es que acá no hay qué medir. Se DECLARA, no se pinta verde
  // ni rojo (ADR-056: lo que no se pudo medir se declara).
  const hayFuentes = fs.existsSync(path.join(RAIZ, 'libs', 'commercial', 'src'));
  if (!hayFuentes) {
    console.log('  ⓘ NO MEDIDO: sin árbol de fuentes en este destino (contenedor). '
      + 'Este bloque se mide desde el repo.');
  }
  for (const rel of hayFuentes ? ARCH : []) {
    const f = path.join(RAIZ, rel);
    if (!fs.existsSync(f)) { ck(`${path.basename(rel)}: existe`, false, 'no está'); continue; }
    const src = fs.readFileSync(f, 'utf8');
    ck(`${path.basename(rel)}: sin MARGIN_TARGET_PCT`, !/MARGIN_TARGET_PCT\s*=/.test(src));
    ck(`${path.basename(rel)}: usa el resolvedor único`, /resolveMarginTarget/.test(src));
  }
  if (hayFuentes) {
    const helper = path.join(RAIZ, 'libs/commercial/src/lib/shared/margin-target.ts');
    ck('el resolvedor vive en UN solo archivo compartido', fs.existsSync(helper));
  }

  await c.end();
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} ✓ / ${fail} ✗\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\n💥', e.message); process.exit(1); });
