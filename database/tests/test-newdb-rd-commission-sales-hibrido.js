/* eslint-disable no-console */
/**
 * `[RD.54]` CANDADO: el insumo de la comisión lee la matvista **sin cambiar ni un centavo**.
 *
 * ── Lo que esto impide ───────────────────────────────────────────────────────────────────
 * `v_rd_commission_sales` pasó de leer `v_rd_route_daily` (viva) a `v_rd_route_daily_rapido`
 * (matvista donde la hay, viva donde no). Medido: **Q20 de 1,096 ms a 20 ms**, 55x. El riesgo
 * de un cambio así no es que ande lento: es que **devuelva de menos y nadie lo note**, porque
 * la pantalla se ve igual con una venta más chica.
 *
 * Tres formas de romperlo, y las tres se prueban:
 *
 * **1. La quincena A CABALLO.** La matvista cubre desde el 2026-03-23 y **la Q6 (12-25 mar)
 * cruza ese límite**. Si el corte fuera por periodo en vez de por fila, esa quincena saldría
 * incompleta o duplicada. Se compara fila por fila contra la viva.
 *
 * **2. ⛔ La matvista VACÍA.** `business_date < NULL` es NULL, así que un híbrido sin guarda
 * devuelve **CERO filas** y el motor calcularía venta cero para todos **en silencio**. Se
 * simula con `WHERE false` y se exige que el resultado siga siendo el de la vista viva.
 *
 * **3. El traslape.** Una fila no puede venir de las dos ramas: se cuenta el total y tiene que
 * coincidir exacto con la viva, no "parecido".
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-rd-commission-sales-hibrido.js
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
const n2 = (x) => (x === null || x === undefined ? null : Number(x).toFixed(2));

/** El agregado que de verdad usa el motor, sobre la fuente que se le pase. */
const AGG = (fuente) => `
  SELECT round(sum(subtotal)::numeric, 2) sub, round(sum(venta)::numeric, 2) venta,
         count(*)::int filas, count(DISTINCT route_code)::int rutas
    FROM ${fuente} WHERE business_date BETWEEN $1 AND $2`;

(async () => {
  const db = new Client({
    connectionString: URL, statement_timeout: 300000,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await db.connect();
  await db.query('SET default_transaction_read_only = on');
  console.log(`\n=== [RD.54] el hibrido del insumo · ${URL.replace(/:\/\/[^@]*@/, '://***@')} ===`);

  if (!(await db.query(`SELECT to_regclass('analytics.v_rd_route_daily_rapido') v`)).rows[0].v) {
    noMedido('la vista hibrida', 'no existe en este destino (falta 20261008133332)');
    console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`);
    await db.end(); process.exit(fail ? 1 : 0);
  }

  const { rows: [cob] } = await db.query(
    `SELECT to_char(min(business_date), 'YYYY-MM-DD') desde,
            to_char(max(business_date), 'YYYY-MM-DD') hasta, count(*)::int filas
       FROM analytics.mv_rd_route_daily_200d`);
  console.log(`      matvista: ${cob.desde} → ${cob.hasta} · ${cob.filas} fila(s)`);
  check('la matvista no esta vacia', cob.filas > 0);

  // ── Los tres casos, elegidos por donde caen respecto del limite ───────────────────────────
  const { rows: periodos } = await db.query(
    `SELECT p.period_no,
            to_char(p.date_from, 'YYYY-MM-DD') f, to_char(p.date_to, 'YYYY-MM-DD') t,
            CASE
              WHEN p.date_from >= m.desde THEN 'dentro'
              WHEN p.date_to   <  m.desde THEN 'fuera'
              ELSE                              'a_caballo'
            END AS lado
       FROM commercial.commission_periods p,
            (SELECT min(business_date) desde FROM analytics.mv_rd_route_daily_200d) m
      WHERE p.anio = 2026 AND p.deleted_at IS NULL AND p.date_to < current_date
      ORDER BY p.period_no`);

  const porLado = new Map();
  for (const p of periodos) if (!porLado.has(p.lado)) porLado.set(p.lado, p);
  const aCaballo = periodos.filter((p) => p.lado === 'a_caballo');
  check('hay exactamente UNA quincena a caballo del limite', aCaballo.length === 1,
    `hay ${aCaballo.length}: ${aCaballo.map((p) => 'Q' + p.period_no).join(', ')}`);

  for (const lado of ['dentro', 'a_caballo', 'fuera']) {
    const p = porLado.get(lado);
    if (!p) { noMedido(`paridad ${lado}`, 'no hay ninguna quincena de ese lado'); continue; }

    const t0 = Date.now();
    const { rows: [viva] } = await db.query(AGG('analytics.v_rd_route_daily'), [p.f, p.t]);
    const tViva = Date.now() - t0;
    const t1 = Date.now();
    const { rows: [hib] } = await db.query(AGG('analytics.v_rd_route_daily_rapido'), [p.f, p.t]);
    const tHib = Date.now() - t1;

    const igual = n2(viva.sub) === n2(hib.sub) && n2(viva.venta) === n2(hib.venta)
      && viva.filas === hib.filas && viva.rutas === hib.rutas;
    check(`Q${p.period_no} (${lado}): el hibrido da EXACTO lo mismo que la viva`, igual,
      `viva ${n2(viva.sub)}/${viva.filas}f · hibrido ${n2(hib.sub)}/${hib.filas}f`);
    console.log(`      Q${p.period_no} ${lado.padEnd(10)} ${String(tViva).padStart(6)} ms → ${String(tHib).padStart(6)} ms`);
  }

  // ── ⛔ PRUEBA NEGATIVA: la matvista VACIA no puede silenciar la venta ──────────────────────
  // Se simula con `WHERE false`. Sin el COALESCE a 'infinity' esto devuelve CERO filas, y una
  // corrida de nomina saldria en ceros sin un solo error.
  const p = porLado.get('dentro');
  if (!p) {
    noMedido('prueba negativa de la matvista vacia', 'no hay una quincena dentro de la matvista');
  } else {
    const { rows: [viva] } = await db.query(AGG('analytics.v_rd_route_daily'), [p.f, p.t]);

    const SIN_GUARDA = `(
      SELECT * FROM analytics.mv_rd_route_daily_200d WHERE false
      UNION ALL
      SELECT * FROM analytics.v_rd_route_daily
       WHERE business_date < (SELECT min(business_date) FROM analytics.mv_rd_route_daily_200d WHERE false))`;
    const CON_GUARDA = `(
      SELECT * FROM analytics.mv_rd_route_daily_200d WHERE false
      UNION ALL
      SELECT * FROM analytics.v_rd_route_daily
       WHERE business_date < COALESCE(
         (SELECT min(business_date) FROM analytics.mv_rd_route_daily_200d WHERE false),
         'infinity'::date))`;

    const { rows: [sinG] } = await db.query(AGG(`${SIN_GUARDA} z`), [p.f, p.t]);
    const { rows: [conG] } = await db.query(AGG(`${CON_GUARDA} z`), [p.f, p.t]);

    check('MUTACION: sin la guarda, una matvista vacia devuelve CERO filas', sinG.filas === 0,
      `devolvio ${sinG.filas} — si esto no da cero, la prueba no esta midiendo lo que dice`);
    check('con la guarda, una matvista vacia cae entera a la vista viva',
      conG.filas === viva.filas && n2(conG.sub) === n2(viva.sub),
      `guarda ${n2(conG.sub)}/${conG.filas}f vs viva ${n2(viva.sub)}/${viva.filas}f`);
  }

  // ── El consumidor real: `v_rd_commission_sales` tiene que leer el hibrido ──────────────────
  const { rows: [def] } = await db.query(
    `SELECT pg_get_viewdef('analytics.v_rd_commission_sales'::regclass, true) d`);
  check('v_rd_commission_sales lee la vista rapida', /v_rd_route_daily_rapido/.test(def.d),
    'sigue leyendo la vista viva: el cambio no llego al consumidor');

  const { rows: [meta] } = await db.query(
    `SELECT c.reloptions::text o,
            has_table_privilege('app_runtime', 'analytics.v_rd_route_daily_rapido', 'SELECT') g
       FROM pg_class c WHERE c.oid = 'analytics.v_rd_route_daily_rapido'::regclass`);
  check('la vista rapida conserva security_invoker y su GRANT',
    /security_invoker=true/.test(meta.o || '') && meta.g === true, meta.o);

  console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
