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

/**
 * [VSO.3] Huecos DECLARADOS — no son una tolerancia, son hechos medidos con nombre, día y monto.
 * Cualquier hueco que no esté acá sigue poniendo el candado en rojo, y si uno de éstos DESAPARECE
 * el candado también falla: una declaración que ya no describe nada es un comentario que envejeció
 * sin avisar.
 */
const HUECOS_DECLARADOS = [
  {
    kepler: '02', dia: '2025-01-01', monto: 21938.45,
    razon: 'carga inicial de Kepler en La Piedad — 307 filas y 307 SKUs DISTINTOS (una por SKU) '
      + 'estampadas en la fecha de arranque de esa rama, que es la única fecha suya anterior a su '
      + 'operación real; Wincaja, que era el POS vivo ese 1-ene, registró $0. No es venta, y traerla '
      + 'exigiría mover el corte 9 meses atrás y doble-contar contra Wincaja.',
  },
];

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

    // ⚠️ [VSO.3] Estos dos bloques medían las piernas CRUDAS, y por eso vivían en rojo sin que el
    // rojo significara nada — lo que entrena a ignorar el tablero. Dos correcciones, medidas:
    //
    //  · «traslape» preguntaba si Kepler tiene filas ANTES del corte. En La Piedad eso es cierto
    //    por NUEVE MESES (Kepler `02` arranca 2025-01-01 y Wincaja `42` siguió siendo el POS vivo
    //    hasta 2025-10-09) y NO es doble conteo: la vista los excluye. El doble conteo real es que
    //    el MISMO (almacén, día) salga PUBLICADO por las dos piernas — eso es lo que se mide ahora.
    //
    //  · «días descartados» contaba lo que el corte tira, sin mirar si la otra pierna lo cubre.
    //    En la zona de traslape descartar es justamente lo correcto. El hueco real es un día con
    //    venta en alguna pierna cruda y NADA publicado — que es como se midieron los $1,953,784.56
    //    que [VSO.3] recuperó. El traslape se ve; el hueco no.
    const [cmp] = await q(
      `WITH k AS (SELECT business_date d, sum(monto) m FROM analytics.mv_kepler_sales_daily
                   WHERE product_deleted = false AND source_branch = $1 GROUP BY 1),
            w AS (SELECT business_date d, sum(monto) m FROM analytics.mv_wincaja_sales_daily
                   WHERE product_deleted = false AND source_branch = $2 GROUP BY 1),
            pk AS (SELECT d, m FROM k WHERE d >= $3::date),
            pw AS (SELECT d, m FROM w WHERE d <  $3::date),
            j AS (SELECT COALESCE(k.d, w.d) AS d,
                         GREATEST(COALESCE(k.m, 0), COALESCE(w.m, 0)) AS crudo,
                         COALESCE(pk.m, 0) + COALESCE(pw.m, 0)        AS pub
                    FROM k FULL JOIN w ON k.d = w.d
                    LEFT JOIN pk ON pk.d = COALESCE(k.d, w.d)
                    LEFT JOIN pw ON pw.d = COALESCE(k.d, w.d))
       SELECT (SELECT count(*)::int FROM pk JOIN pw ON pk.d = pw.d)              AS dias_dobles,
              (SELECT count(*)::int      FROM j WHERE crudo - pub > 1)            AS dias_hueco,
              (SELECT COALESCE(sum(crudo - pub), 0)::numeric(16,2) FROM j WHERE crudo - pub > 1) AS monto_hueco`,
      [r.kepler_code, r.wc, r.d]);

    check(`${etq} · ningún día publicado por las DOS piernas (cero doble conteo) en ${r.d}`,
      Number(cmp.dias_dobles) === 0,
      `${cmp.dias_dobles} día(s) con las dos piernas publicando el mismo almacén`);

    // Residuo DECLARADO (no una tolerancia genérica): un día concreto, de una sucursal concreta,
    // con su monto y su razón MEDIDA. Todo lo demás sigue fallando. Y se comprueba que el residuo
    // declarado SIGA EXISTIENDO: una declaración que ya no describe nada es un comentario que
    // envejeció sin avisar, que es justo lo que este archivo existe para evitar.
    const decl = HUECOS_DECLARADOS.filter((h) => h.kepler === r.kepler_code);
    const declDias = decl.map((h) => h.dia);
    const [res] = declDias.length
      ? await q(
        `WITH k AS (SELECT business_date d, sum(monto) m FROM analytics.mv_kepler_sales_daily
                     WHERE product_deleted = false AND source_branch = $1 GROUP BY 1),
              w AS (SELECT business_date d, sum(monto) m FROM analytics.mv_wincaja_sales_daily
                     WHERE product_deleted = false AND source_branch = $2 GROUP BY 1),
              pk AS (SELECT d, m FROM k WHERE d >= $3::date),
              pw AS (SELECT d, m FROM w WHERE d <  $3::date),
              j AS (SELECT COALESCE(k.d, w.d) AS d,
                           GREATEST(COALESCE(k.m, 0), COALESCE(w.m, 0)) AS crudo,
                           COALESCE(pk.m, 0) + COALESCE(pw.m, 0)        AS pub
                      FROM k FULL JOIN w ON k.d = w.d
                      LEFT JOIN pk ON pk.d = COALESCE(k.d, w.d)
                      LEFT JOIN pw ON pw.d = COALESCE(k.d, w.d))
         SELECT (SELECT count(*)::int FROM j WHERE crudo - pub > 1 AND d::date  = ANY($4::date[])) AS declarados,
                (SELECT count(*)::int FROM j WHERE crudo - pub > 1 AND d::date <> ALL($4::date[])) AS nuevos,
                (SELECT COALESCE(sum(crudo - pub), 0)::numeric(16,2) FROM j
                  WHERE crudo - pub > 1 AND d::date <> ALL($4::date[]))                            AS monto_nuevo`,
        [r.kepler_code, r.wc, r.d, declDias])
      : [{ declarados: 0, nuevos: Number(cmp.dias_hueco), monto_nuevo: cmp.monto_hueco }];

    check(`${etq} · ningún hueco NUEVO (día con venta cruda y nada publicado)`,
      Number(res.nuevos) === 0,
      `${res.nuevos} día(s) · $${Number(res.monto_nuevo).toLocaleString('en-US')} que ninguna pierna publica`
      + ' (mover el corte al traspaso real los cierra — ver [VSO.3])');

    for (const h of decl) {
      console.log(`  ⓘ residuo DECLARADO · ${etq} ${h.dia} · $${h.monto.toLocaleString('en-US')} — ${h.razon}`);
    }
    if (declDias.length) {
      check(`${etq} · el residuo declarado sigue existiendo (la declaración no envejeció)`,
        Number(res.declarados) === declDias.length,
        `declarados ${declDias.length}, encontrados ${res.declarados} — si ya no está, BORRAR la entrada de HUECOS_DECLARADOS`);
    }
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
