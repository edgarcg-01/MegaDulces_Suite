/**
 * `[SB.1]` Candado del **corte Wincaja → Kepler**: que sea un DATO, que lo lean todos, y que no
 * deje ni hueco ni doble conteo.
 *
 * ── Por qué existe ─────────────────────────────────────────────────────────────────────────
 * El corte vivía copiado a mano en TRES lugares —`v_sellout_daily`, `mv_sales_blended` y la
 * constante `CUTOVER` del propio `test-newdb-sellout-parity.js`— y los tres se desincronizaron:
 *
 *   · `mv_sales_blended` nunca recibió a Morelia Abastos `08` (cutover 2026-09-18). Medido en
 *     prod el 2026-09-23: **$1,636,170.10** de venta ausente y creciendo, más todo el histórico
 *     Wincaja de Madero `32`, que se cayó del blend cuando `[RL.10]` le puso el `kepler_code`.
 *   · La constante del candado de paridad seguía en `['01','02','06']`: no vigilaba ni `07` ni
 *     `08`, así que la sucursal que faltaba era justo una de las que nadie miraba.
 *
 * El síntoma que lo destapó fue de pantalla ("en /comercial/salidas al imprimir no sale Morelia
 * Abastos"), no de tablero: **ningún gate lo vio**. Este archivo es ese gate.
 *
 * ── Qué mide, y por qué en este orden ──────────────────────────────────────────────────────
 *   1. El resolvedor existe y **cubre a toda sucursal Kepler que vende**. Ésta es la prueba que
 *      habría gritado el 2026-09-18: una sucursal nueva en `mv_kepler_sales_daily` sin fila en
 *      `v_branch_erp_cutover` es venta que se va a caer del fact.
 *   2. **Prueba negativa del hardcode**: cero literales de corte en las dos vistas. Un gate sin
 *      prueba negativa es una intención (ADR-056), así que acá la intención es explícita —
 *      si alguien vuelve a escribir `source_branch = '0X' AND business_date >= 'fecha'`, rojo.
 *   3. Las dos vistas leen el resolvedor.
 *   4. Por cada corte, contra el dato: cero traslape y cero hueco a los dos lados.
 *   5. `mv_sales_blended` contiene a todas las sucursales del resolvedor (el bug de Abastos,
 *      comprobado del lado del resultado y no sólo del SQL).
 *
 * ⛔ **Lo que no se puede medir se reporta `NO MEDIDO`, nunca ✔.** Con una pierna vacía "cero
 * traslapes" es cierto y no prueba nada — el verde que no midió nada es lo que esta familia de
 * candados persigue.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-branch-cutover.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };

/** Un literal de corte: `source_branch = '0X'` pegado a una comparación de business_date con
 *  una fecha fija. Es la forma exacta que esta fase retira; detectarla es el punto. */
const LITERAL_CORTE = /source_branch\s*=\s*'[^']+'(::text)?\s*AND\s*\w*\.?business_date\s*[<>]=?\s*'\d{4}-\d{2}-\d{2}'/i;

(async () => {
  const c = new Client({
    connectionString: URL,
    ssl: /railway|rlwy|proxy/.test(URL) ? { rejectUnauthorized: false } : undefined,
  });
  await c.connect();
  await c.query(`SET statement_timeout = '180s'`);
  const q = async (sql, p = []) => (await c.query(sql, p)).rows;
  const existe = async (nombre, kinds) => (await q(
    `SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid=cl.relnamespace
      WHERE n.nspname='analytics' AND cl.relname=$1 AND cl.relkind = ANY($2)`, [nombre, kinds])).length > 0;

  console.log(`\n[SB.1] Candado del corte Wincaja→Kepler · ${new Date().toISOString()}`);
  console.log(`  destino: ${(await q(`SELECT current_database() d`))[0].d}\n`);

  // ── 1 · El resolvedor existe y cubre a todo el que vende ──────────────────────────────────
  console.log('1 · Resolvedor único');
  const hayResolvedor = await existe('v_branch_erp_cutover', ['v', 'm']);
  check('analytics.v_branch_erp_cutover existe', hayResolvedor);
  if (!hayResolvedor) {
    console.log('\n  Sin resolvedor no hay nada más que medir. Corré la mig 20260923120000.');
    console.log(`\nRESUMEN · ${ok} OK · ${fail} FALLAS · ${nm} NO MEDIDOS\n`);
    await c.end();
    process.exit(fail ? 1 : 0);
  }

  const cortes = await q(`SELECT kepler_code, wincaja_source_branch AS wc, cutover_date::text AS d
                            FROM analytics.v_branch_erp_cutover ORDER BY kepler_code`);
  check(`el resolvedor declara cortes (${cortes.length})`, cortes.length > 0);
  console.log(`      ${cortes.map((r) => `${r.kepler_code}←${r.wc}@${r.d}`).join(' · ')}`);

  // ⭐ La prueba que habría gritado el día del cutover de Abastos.
  const hayKepler = await existe('mv_kepler_sales_daily', ['m', 'v']);
  if (!hayKepler) {
    noMedido('toda sucursal Kepler que vende está en el resolvedor', 'falta mv_kepler_sales_daily');
  } else {
    const huerfanas = await q(
      `SELECT k.source_branch, count(*)::int n, round(sum(k.monto)::numeric, 2) venta
         FROM analytics.mv_kepler_sales_daily k
        WHERE NOT EXISTS (SELECT 1 FROM analytics.v_branch_erp_cutover x
                           WHERE x.tenant_id = k.tenant_id AND x.kepler_code = k.source_branch)
        GROUP BY 1 ORDER BY 1`);
    check('toda sucursal Kepler que vende está en el resolvedor', huerfanas.length === 0,
      huerfanas.map((r) => `${r.source_branch}: ${r.n} filas / $${r.venta} SIN corte declarado → se cae del fact`).join(' · '));
  }

  // ── 2 · Prueba negativa: cero literales de corte ──────────────────────────────────────────
  console.log('\n2 · Prueba negativa — el corte NO vuelve a escribirse como literal');
  check('el detector de literales funciona (control positivo)',
    LITERAL_CORTE.test(`WHERE k.source_branch = '08'::text AND k.business_date >= '2026-09-18'::date`),
    'el regex no reconoce la forma que debe prohibir — sin esto el punto 2 es un no-op');

  for (const v of ['v_sellout_daily', 'mv_sales_blended']) {
    if (!(await existe(v, ['v', 'm']))) { noMedido(`${v} sin literales de corte`, 'la relación no existe'); continue; }
    const def = (await q(`SELECT pg_get_viewdef('analytics.${v}'::regclass, true) d`))[0].d;
    check(`analytics.${v} sin literales de corte`, !LITERAL_CORTE.test(def),
      'todavía trae `source_branch = ... AND business_date >= fecha` escrito a mano');
    check(`analytics.${v} lee v_branch_erp_cutover`, def.includes('v_branch_erp_cutover'),
      'no consume el resolvedor: su corte puede divergir sin que nadie lo note');
  }

  // ── 3 · Complemento exacto por corte: ni traslape ni hueco ────────────────────────────────
  console.log('\n3 · Complemento EXACTO por sucursal (traslape y hueco, contra el dato)');
  const hayWin = await existe('mv_wincaja_sales_daily', ['m', 'v']);
  for (const r of cortes) {
    const etq = `${r.kepler_code}←${r.wc}`;
    if (r.d === '-infinity' || r.d === 'infinity') {
      console.log(`  · ${etq}: sin corte de fecha (${r.d}) — no aplica complemento.`);
      continue;
    }
    if (!hayKepler || !hayWin) { noMedido(`${etq} complemento`, 'falta una de las dos matvistas'); continue; }

    const [kep] = await q(
      `SELECT count(*)::int n, min(business_date)::text lo, max(business_date)::text hi
         FROM analytics.mv_kepler_sales_daily WHERE source_branch = $1`, [r.kepler_code]);
    const [win] = await q(
      `SELECT count(*)::int n, min(business_date)::text lo, max(business_date)::text hi
         FROM analytics.mv_wincaja_sales_daily WHERE source_branch = $1`, [r.wc]);
    if (!kep.n || !win.n) {
      noMedido(`${etq} complemento en ${r.d}`,
        `una pierna vacía (kepler ${kep.n} · wincaja ${win.n}); "cero traslape" sería cierto y no probaría nada`);
      continue;
    }

    // TRASLAPE: Kepler antes del corte, o Wincaja desde el corte. Ambos son doble conteo.
    const [tr] = await q(
      `SELECT (SELECT count(*)::int FROM analytics.mv_kepler_sales_daily
                WHERE source_branch = $1 AND business_date < $3::date) AS kep_antes,
              (SELECT count(*)::int FROM analytics.mv_wincaja_sales_daily
                WHERE source_branch = $2 AND business_date >= $3::date) AS win_desde`,
      [r.kepler_code, r.wc, r.d]);
    check(`${etq} · sin traslape en ${r.d}`, tr.kep_antes === 0 && tr.win_desde === 0,
      `kepler antes del corte: ${tr.kep_antes} · wincaja desde el corte: ${tr.win_desde}`);

    // HUECO: el traslape se ve, el hueco no. Días con venta en la fuente que el corte descarta.
    const [hu] = await q(
      `SELECT (SELECT count(DISTINCT business_date)::int FROM analytics.mv_wincaja_sales_daily
                WHERE source_branch = $2 AND business_date >= $3::date) AS win_descartado,
              (SELECT count(DISTINCT business_date)::int FROM analytics.mv_kepler_sales_daily
                WHERE source_branch = $1 AND business_date < $3::date) AS kep_descartado`,
      [r.kepler_code, r.wc, r.d]);
    check(`${etq} · sin días descartados alrededor de ${r.d}`,
      hu.win_descartado === 0 && hu.kep_descartado === 0,
      `wincaja con venta >= corte: ${hu.win_descartado} días · kepler con venta < corte: ${hu.kep_descartado} días`
      + ' (venta real que ninguna pierna publica)');
  }

  // ── 4 · Del lado del RESULTADO, no sólo del SQL ───────────────────────────────────────────
  console.log('\n4 · El fact contiene a todas las sucursales declaradas');
  if (!(await existe('mv_sales_blended', ['m']))) {
    noMedido('mv_sales_blended contiene cada sucursal del resolvedor', 'la matvista no existe');
  } else {
    const [{ n: pobladas }] = await q(`SELECT count(*)::int n FROM analytics.mv_sales_blended`);
    if (!pobladas) {
      noMedido('mv_sales_blended contiene cada sucursal del resolvedor',
        'la matvista está WITH NO DATA — falta el REFRESH');
    } else {
      const faltan = await q(
        `SELECT x.kepler_code FROM analytics.v_branch_erp_cutover x
          WHERE NOT EXISTS (
            SELECT 1 FROM analytics.mv_sales_blended b
              JOIN commercial.warehouses w ON w.id = b.warehouse_id
             WHERE w.tenant_id = x.tenant_id AND w.code::text = x.kepler_code)
          ORDER BY 1`);
      check('mv_sales_blended contiene cada sucursal del resolvedor', faltan.length === 0,
        `sin una sola fila: ${faltan.map((r) => r.kepler_code).join(', ')} — es el bug de Abastos repitiéndose`);
    }
  }

  console.log(`\nRESUMEN · ${ok} OK · ${fail} FALLAS · ${nm} NO MEDIDOS\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
