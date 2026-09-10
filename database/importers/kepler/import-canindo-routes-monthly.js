/* eslint-disable no-console */
/**
 * Canindo (RUTAS 501-505) — LA SERIE COMPLETA, compuesta de sus DOS ERAS.
 *
 * Canindo cobró en Wincaja hasta agosto y desde entonces cada camioneta corre SU PROPIO Kepler
 * local. Este feed es el ÚNICO dueño de la llave (warehouse 06, WIN-50N, mes) en
 * analytics.sales_by_route_monthly, y la arma pegando las dos eras por una frontera medida:
 *
 *   ANTES  de la frontera → WINCAJA  (silver wincaja.v_sales_lines, sale_channel='ruta_venta',
 *                                     branches.parent_branch='50'). Vive en el MISMO destino.
 *   DESDE  la frontera    → PUSH     (la base de la propia camioneta: md_06-0NN → agente
 *                                     push-ruta → runner .249 mart.ventas, sucursal='ruta_50N').
 *
 * La frontera se DERIVA por ruta (no se hardcodea): cutover = ultimo dia que cobro Wincaja + 1.
 * Medido 2026-09-10: 501 y 503 cierran el 12-ago (cutover 13), 502/504/505 el 11-ago (cutover 12).
 * Las ventanas quedan DISJUNTAS por construccion: ni hueco ni doble conteo. Lo unico que la
 * frontera deja fuera son las 3 lineas de $6 con que arranco el Kepler local de 502/503/505 el
 * mismo dia en que Wincaja todavia cobraba ($18 en total, declarados).
 *
 * POR QUE NO ES LA REPLICA DE SUCURSAL. Hasta hoy este feed leia kepler_md_06 filtrando
 * kdm1.c67 ~ '500N'. Medido contra prod: esa replica solo ve 3 de las 5 rutas y en ventanas
 * sueltas (5001 solo 18-24 ago, 5003 solo 15-21 ago, 5004 y 5005 nada) porque la venta se
 * captura en la laptop de la van y a la sucursal solo llega lo que se sincroniza. Es un
 * SUBCONJUNTO DEGRADADO: no puede arbitrar nada y su unico efecto posible sobre el gold era
 * ganarle una metrica al push por accidente. Sigue leyendose, pero solo como TESTIGO, en
 * reconcile-route-provenance.js.
 *
 * POR QUE OVERWRITE Y NO GREATEST. El GREATEST ciego publicaba, para agosto, el MAXIMO de dos
 * mitades disjuntas en vez de su suma: faltaban $808,409 de las 5 rutas (la mitad Wincaja del mes
 * de transicion). Y ene-jul quedo congelado el 18-ago, o sea PRE arreglo RD.1
 * (20260907280000: la fecha de negocio de Wincaja venia corrida un dia) — Canindo es la unica
 * ruta Wincaja que no se re-escribio despues del arreglo porque import-wincaja-routes-monthly la
 * excluye. Sintoma visible: la ruta 505 publica $10,882 en MAYO y su primer dia real fue el
 * 1-jun. Esta corrida los reasigna al mes correcto.
 *
 * Salvaguarda: si la composicion queda POR DEBAJO de lo publicado en una llave, NO la escribe y
 * lo declara en el log (una fuente que se degrada no debe bajar el gold en silencio). Se fuerza
 * con --allow-lower cuando la baja es la correccion buscada (ej. la primera corrida, que corrige
 * el corrimiento de un dia de ene-jul).
 *
 *   DST_URL=…railway node database/importers/kepler/import-canindo-routes-monthly.js          # dry-run
 *   DST_URL=…            node database/importers/kepler/import-canindo-routes-monthly.js --apply
 *   ... [--year 2026] [--allow-lower]
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
const SRC_PUSH = process.env.SRC_URL || 'postgresql://postgres:superoot@192.168.0.249:5433/kepler_consolidado';
const APPLY = process.argv.includes('--apply');
const ALLOW_LOWER = process.argv.includes('--allow-lower');
const yi = process.argv.indexOf('--year');
const YEAR = yi !== -1 ? Number(process.argv[yi + 1]) : new Date().getFullYear();

const money = (n) => '$' + Math.round(Number(n || 0)).toLocaleString('en-US');
const ym = (d) => new Date(d).toISOString().slice(0, 7);
const day = (d) => new Date(d).toISOString().slice(0, 10);

// Wincaja: frontera por ruta + la venta ANTERIOR a esa frontera, agregada a ruta x mes.
//
// UN SOLO barrido de la vista. `wincaja.v_sales_lines` es cara (une detalles+maestro+catalogo y
// trae adentro un DISTINCT global sobre maestro_mov_almacen), asi que recorrerla dos veces —una
// para la frontera y otra para el agregado— se pasa de los 300 s. El CTE `d` se referencia dos
// veces, o sea Postgres lo materializa una vez y las dos lecturas salen de ahi.
//
// `business_date <= CURRENT_DATE` es obligatorio: el POS emite fechas corruptas a futuro y una
// sola de ellas correria la frontera meses adelante, tapando el push entero.
const SQL_WINCAJA = `
  WITH d AS (
    SELECT b.source_branch AS rt, sl.business_date AS bd, sl.importe, sl.qty, sl.consecutivo
      FROM wincaja.v_sales_lines sl
      JOIN wincaja.branches b ON b.tenant_id=sl.tenant_id AND b.source_branch=sl.source_branch AND b.is_route
     WHERE sl.tenant_id=$1 AND sl.sale_channel='ruta_venta' AND b.parent_branch='50'
       AND sl.business_date >= $2 AND sl.business_date < $3 AND sl.business_date <= CURRENT_DATE
  ), cut AS (
    SELECT rt, max(bd) + 1 AS cutover FROM d GROUP BY 1
  )
  SELECT d.rt, c.cutover,
         date_trunc('month', d.bd)::date     AS mes,
         sum(d.importe)::numeric             AS revenue,
         sum(d.qty)::numeric                 AS units,
         count(DISTINCT d.consecutivo)::int  AS tickets
    FROM d JOIN cut c ON c.rt = d.rt
   WHERE d.bd < c.cutover
   GROUP BY 1, 2, 3`;

(async () => {
  const db = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false, statement_timeout: 300000 });
  await db.connect();
  try {
    console.log(`\n=== Canindo RUTAS 501-505 — serie compuesta Wincaja + PUSH → analytics.sales_by_route_monthly (${APPLY ? 'APPLY' : 'DRY-RUN'}, año ${YEAR}) ===\n`);
    const wid = (await db.query(
      `SELECT id FROM commercial.warehouses WHERE tenant_id=$1 AND code='06' AND deleted_at IS NULL`, [M])).rows[0]?.id;
    if (!wid) { console.log('  ⚠ no existe warehouse code=06 (¿corriste canindo-identity-06.js?) — abort'); await db.end(); return; }

    const from = `${YEAR}-01-01`, to = `${YEAR + 1}-01-01`;

    // ── era 1: WINCAJA (hasta la frontera) ────────────────────────────────────────────────────
    let t0 = Date.now();
    const win = (await db.query(SQL_WINCAJA, [M, from, to])).rows;
    const cutover = new Map(); // ruta → primer día del PUSH
    for (const r of win) cutover.set(r.rt, day(r.cutover));
    console.log(`  Wincaja (silver, en el destino): ${win.length} filas ruta×mes · ${money(win.reduce((s, r) => s + Number(r.revenue), 0))} (${Date.now() - t0}ms)`);
    console.log(`  frontera medida por ruta: ${[...cutover.entries()].sort().map(([r, c]) => `${r}→${c}`).join(' · ') || '(sin historia Wincaja)'}`);

    // ── era 2: PUSH (desde la frontera) — la base de la propia camioneta ──────────────────────
    const rts = [...cutover.keys()].sort();
    const push = new Client({ connectionString: SRC_PUSH, connectionTimeoutMillis: 8000, statement_timeout: 120000 });
    let pushRows;
    t0 = Date.now();
    try {
      await push.connect();
    } catch (e) {
      console.error(`  ❌ sin conexión al runner .249 (${e.message}) — abort (sin el push la serie quedaría trunca)`);
      await db.end(); process.exitCode = 1; return;
    }
    try {
      // LEFT JOIN contra la lista de fronteras: una ruta sin historia Wincaja entra completa.
      const vals = rts.length ? rts.map((r, i) => `($${i * 2 + 3},$${i * 2 + 4}::date)`).join(',') : `(NULL,NULL::date)`;
      const params = [from, to];
      for (const r of rts) params.push(r, cutover.get(r));
      ({ rows: pushRows } = await push.query(
        `WITH cut(rt, cutover) AS (VALUES ${vals})
         SELECT v.rt,
                date_trunc('month', v.fecha)::date AS mes,
                sum(v.importe)::numeric   AS revenue,
                sum(v.cantidad)::numeric  AS units,
                count(DISTINCT v.folio)::int AS tickets,
                min(v.fecha)::date d0, max(v.fecha)::date d1
           FROM (SELECT substring(sucursal from 'ruta_(.*)') AS rt, fecha, importe, cantidad, folio
                   FROM mart.ventas
                  WHERE sucursal LIKE 'ruta_5%' AND fecha >= $1 AND fecha < $2 AND fecha <= CURRENT_DATE) v
           LEFT JOIN cut c ON c.rt = v.rt
          WHERE v.rt ~ '^50[1-9]$' AND v.fecha >= COALESCE(c.cutover, DATE '1900-01-01')
          GROUP BY 1, 2`, params));
    } finally { await push.end().catch(() => {}); }
    console.log(`  PUSH (runner .249, desde la frontera): ${pushRows.length} filas ruta×mes · ${money(pushRows.reduce((s, r) => s + Number(r.revenue), 0))} (${Date.now() - t0}ms)`);

    // ── composición: suma de ventanas disjuntas ───────────────────────────────────────────────
    const C = new Map(); // 'ruta|mes' → { rt, mes, win, push }
    const put = (rt, mes, era, r) => {
      const k = `${rt}|${ym(mes)}`;
      if (!C.has(k)) C.set(k, { rt, mes: ym(mes) + '-01' });
      C.get(k)[era] = { revenue: +r.revenue || 0, units: +r.units || 0, tickets: +r.tickets || 0 };
    };
    for (const r of win) put(r.rt, r.mes, 'win', r);
    for (const r of pushRows) put(r.rt, r.mes, 'push', r);

    // gold actual, para declarar el delta llave por llave
    const gold = new Map((await db.query(
      `SELECT route_code, to_char(month,'YYYY-MM') mes, revenue, tickets, units
         FROM analytics.sales_by_route_monthly
        WHERE tenant_id=$1 AND warehouse_id=$2 AND route_code LIKE 'WIN-50%'`, [M, wid])).rows
      .map((r) => [`${r.route_code.slice(4)}|${r.mes}`, r]));

    const plan = [], regresiones = [];
    for (const v of [...C.values()].sort((a, b) => (a.rt + a.mes).localeCompare(b.rt + b.mes))) {
      const w = v.win || { revenue: 0, units: 0, tickets: 0 }, p = v.push || { revenue: 0, units: 0, tickets: 0 };
      const row = {
        rt: v.rt, mes: v.mes,
        revenue: w.revenue + p.revenue, units: w.units + p.units, tickets: w.tickets + p.tickets,
        eras: v.win && v.push ? 'compuesto' : v.win ? 'wincaja' : 'push',
      };
      const g = gold.get(`${v.rt}|${v.mes.slice(0, 7)}`);
      row.antes = g ? Number(g.revenue) : null;
      row.delta = row.revenue - (row.antes ?? 0);
      if (g && row.revenue < Number(g.revenue) - 0.01) regresiones.push(row);
      plan.push(row);
    }

    console.log(`\n  ruta  mes      eras        gold hoy        verdad        Δ`);
    for (const r of plan) {
      const mark = r.eras === 'compuesto' ? ' ⟵ mes de transición' : '';
      console.log(`  ${r.rt}  ${r.mes.slice(0, 7)}  ${r.eras.padEnd(10)} ${(r.antes === null ? '—' : money(r.antes)).padStart(12)}  ${money(r.revenue).padStart(12)}  ${(r.delta >= 0 ? '+' : '') + money(r.delta)}${mark}`);
    }
    const totV = plan.reduce((s, r) => s + r.revenue, 0), totG = plan.reduce((s, r) => s + (r.antes ?? 0), 0);
    console.log(`\n  TOTAL ${YEAR}: gold ${money(totG)} → verdad ${money(totV)}  (${totV - totG >= 0 ? '+' : ''}${money(totV - totG)})`);

    if (regresiones.length) {
      console.log(`\n  ⚠ ${regresiones.length} llave(s) quedarían POR DEBAJO de lo publicado${ALLOW_LOWER ? ' — se escriben igual (--allow-lower)' : ' — NO se escriben (usar --allow-lower si la baja es la corrección buscada)'}:`);
      for (const r of regresiones) console.log(`      ${r.rt} ${r.mes.slice(0, 7)}: ${money(r.antes)} → ${money(r.revenue)} (${money(r.delta)})`);
    }

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió (usar --apply).'); await db.end(); return; }

    const escribir = ALLOW_LOWER ? plan : plan.filter((r) => !regresiones.includes(r));
    if (!escribir.length) { console.log('  (nada que escribir)'); await db.end(); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    // OVERWRITE: este feed es el dueño de la llave. La composición ya es la verdad arbitrada;
    // un GREATEST acá volvería a tapar el swap de universo que esta corrida vino a arreglar.
    let ups = 0;
    for (const r of escribir) {
      await db.query(
        `INSERT INTO analytics.sales_by_route_monthly (tenant_id, warehouse_id, route_code, route_no, month, units, revenue, tickets, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT (tenant_id, warehouse_id, route_code, month) DO UPDATE SET
           units=EXCLUDED.units, revenue=EXCLUDED.revenue, tickets=EXCLUDED.tickets,
           route_no=EXCLUDED.route_no, updated_at=now()`,
        [M, wid, `WIN-${r.rt}`, r.rt, r.mes, r.units, r.revenue, r.tickets]);
      ups++;
    }
    await db.query('COMMIT');
    console.log(`\n  ✅ APPLY: ${ups} filas ruta×mes escritas (WIN-50N @ warehouse 06, overwrite).${regresiones.length && !ALLOW_LOWER ? `  ${regresiones.length} omitidas por la salvaguarda.` : ''}`);
    await db.end();
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    await db.end().catch(() => {});
    process.exit(1);
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
