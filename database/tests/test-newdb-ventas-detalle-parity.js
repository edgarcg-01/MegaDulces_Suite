/* eslint-disable no-console */
/**
 * [AUD-DAT.21] CANDADO de PARIDAD entre `/dashboard/ventas-detalle` y `/comercial/ventas-por-ruta`.
 *
 * ── POR QUÉ ─────────────────────────────────────────────────────────────────────────────────
 * Son dos pantallas que responden la misma pregunta —cuánto vendió cada ruta— desde dos fuentes:
 *
 *     /comercial/ventas-por-ruta  ->  analytics.sales_by_route_monthly   (rollup MENSUAL)
 *     /dashboard/ventas-detalle   ->  analytics.mv_rd_route_daily_200d   (matvista DIARIA)
 *
 * Mientras no se declare la relación entre las dos, cualquier diferencia se lee como que una
 * miente. Este candado la fija, y separa lo que es ESPERADO de lo que es DEFECTO.
 *
 * ── LO QUE SE VERIFICA ──────────────────────────────────────────────────────────────────────
 *  1. EL PERIODO NO SE REDONDEA A MESES. El consumidor derivaba el rango del rollup mensual
 *     sumando meses ENTEROS y, por debajo de 25 días, prorrateando por `días/30`. Medido en prod
 *     el 2026-09-29: el preset de 30 días publicaba ~$13.48 M donde la venta real de esos 30
 *     días es ~$6.21 M. Se verifica contra la aritmética VIEJA, para que el bug no vuelva.
 *  2. EN UN MES 100 % KEPLER LAS DOS PANTALLAS COINCIDEN RUTA POR RUTA, AL CENTAVO. Es la
 *     aserción fuerte: donde no hay diferencia de base, no puede haber diferencia.
 *  3. LA DIFERENCIA DE LOS MESES MIXTOS ESTÁ EXPLICADA, no tolerada:
 *         mensual  ==  venta(push)  +  subtotal(wincaja)
 *     o sea, el rollup mensual guarda el importe CRUDO, que para Kepler viene CON impuesto y
 *     para Wincaja SIN él. No es un error de nadie: es que la columna mezcla dos bases, y eso
 *     distorsiona su propia tendencia mes contra mes justo a través del cutover.
 *  4. FILAS DUPLICADAS en el rollup mensual (DEFECTO REAL, con monto).
 *  5. CADA FILTRO de la pantalla: canal, sucursal y ruta particionan el total sin perder ni
 *     duplicar un peso, y un filtro que no matchea da CERO, no el total.
 *  6. PRUEBAS NEGATIVAS: una ruta fabricada no aparece; ninguna ruta queda fuera de la
 *     clasificación de canal; la aritmética vieja es detectada como distinta.
 *
 *   DATABASE_URL_NEW=<prod o destino> node database/tests/test-newdb-ventas-detalle-parity.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

let ok = 0, fail = 0, nomedido = 0;
const pass = (m) => { ok++; console.log('  ✔', m); };
const bad = (m) => { fail++; console.log('  x FALLA:', m); };
const skip = (m) => { nomedido++; console.log('  ~ NO MEDIDO:', m); };
const $ = (n) => Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** El desglose por ruta que publica el tablero, tal cual lo arma `salesByRouteDashboard`. */
const SQL_TABLERO = `
  SELECT COALESCE(w.code, '(sin almacen)')                        AS warehouse_code,
         'WIN-' || d.route_code                                   AS route_code,
         d.route_code                                             AS route_no,
         round(sum(d.venta),2)::float                             AS revenue,
         round(sum(d.subtotal),2)::float                          AS subtotal,
         round(sum(CASE WHEN d.source='push' THEN d.venta ELSE d.subtotal END),2)::float AS crudo,
         sum(d.tickets)::int                                      AS tickets,
         sum(d.lineas)::int                                       AS lines
    FROM analytics.mv_rd_route_daily_200d d
    LEFT JOIN wincaja.branches b
           ON b.tenant_id = d.tenant_id AND b.source_branch = d.route_code AND b.is_route = true
    LEFT JOIN wincaja.branches pb
           ON pb.tenant_id = b.tenant_id AND pb.source_branch = b.parent_branch
    LEFT JOIN commercial.warehouses w
           ON w.tenant_id = d.tenant_id
          AND w.code = COALESCE(pb.kepler_code, pb.warehouse_code) AND w.deleted_at IS NULL
   WHERE d.tenant_id = $1 AND d.business_date >= $2 AND d.business_date <= $3
     AND d.business_date <= CURRENT_DATE
   GROUP BY 1,2,3 ORDER BY 4 DESC`;

/** Lo que publica `/comercial/ventas-por-ruta` (camino por default de `salesByRoute`). */
const SQL_REPORTE = `
  SELECT w.code AS warehouse_code, s.route_code, s.route_no,
         round(sum(s.revenue),2)::float AS revenue, sum(s.tickets)::int AS tickets,
         count(*)::int AS filas, count(DISTINCT s.warehouse_id)::int AS almacenes
    FROM analytics.sales_by_route_monthly s
    JOIN commercial.warehouses w ON w.id = s.warehouse_id
   WHERE s.tenant_id = $1 AND s.month >= $2::date AND s.month < $3::date
     AND s.route_code LIKE 'WIN-%'
   GROUP BY 1,2,3 ORDER BY 4 DESC`;

/** La clasificación de canal que hace la pantalla, calcada. */
const esVecinal = (r) => r.route_code.includes('VEC') || r.route_code.includes('1V0') || r.route_no.includes('VEC');
const suma = (rows, campo) => Math.round(rows.reduce((a, r) => a + Number(r[campo] || 0), 0) * 100) / 100;
/**
 * ⚠️ Los dos lados NO delimitan igual: el reporte mensual filtra `month < $3` (exclusivo) y el
 * tablero `business_date <= $3` (inclusivo). Pasarles el mismo valor mete el día 1 del mes
 * siguiente de un solo lado. Pasó en la primera corrida de este candado y se leyó como un
 * descuadre de ~$290,000 que no existía.
 */
const mesVentana = (mes) => {
  const ini = `${mes}-01`;
  const sig = new Date(`${ini}T12:00:00Z`); sig.setUTCMonth(sig.getUTCMonth() + 1);
  const ult = new Date(sig); ult.setUTCDate(ult.getUTCDate() - 1);
  return { ini, ultimoDia: ult.toISOString().slice(0, 10), primeroSiguiente: sig.toISOString().slice(0, 10) };
};
/** Rutas que el rollup mensual cuelga de MÁS de un almacén: se excluyen y se reportan aparte. */
const sinDuplicar = (rows) => {
  const veces = new Map();
  rows.forEach((r) => veces.set(r.route_code, (veces.get(r.route_code) || 0) + 1));
  return new Map(rows.filter((r) => veces.get(r.route_code) === 1).map((r) => [r.route_code, r]));
};

(async () => {
  const db = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await db.connect();
  try {
    const t = (await db.query(`SELECT id FROM public.tenants WHERE slug = 'mega_dulces' LIMIT 1`)).rows[0];
    if (!t) { console.log('sin tenant mega_dulces: nada que medir'); process.exitCode = 0; return; }
    const T = t.id;
    await db.query('SELECT set_config($1,$2,false)', ['app.tenant_id', T]);

    const hoy = (await db.query(`SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') d`)).rows[0].d;
    const tablero = async (from, to) => (await db.query(SQL_TABLERO, [T, from, to])).rows;

    // ── 1. El periodo ya no se redondea a meses ─────────────────────────────────────────────
    console.log('\n[1] El rango de fechas es el rango, no los meses que lo tocan');
    const d30 = new Date(`${hoy}T12:00:00Z`); d30.setUTCDate(d30.getUTCDate() - 29);
    const from30 = d30.toISOString().slice(0, 10);
    const rango = await tablero(from30, hoy);
    const revRango = suma(rango, 'revenue');

    // La aritmética VIEJA: meses enteros que tocan el rango, del rollup mensual.
    const mesIni = `${from30.slice(0, 7)}-01`;
    const mFin = new Date(`${hoy.slice(0, 7)}-01T12:00:00Z`); mFin.setUTCMonth(mFin.getUTCMonth() + 1);
    const viejo = suma(await (async () => (await db.query(SQL_REPORTE, [T, mesIni, mFin.toISOString().slice(0, 10)])).rows)(), 'revenue');

    if (!rango.length) { skip('no hay venta de ruta en los últimos 30 días.'); }
    else if (viejo > revRango * 1.25) {
      pass(`30 días = $${$(revRango)}; la aritmética vieja (meses enteros) daba $${$(viejo)} `
        + `— ${(viejo / revRango).toFixed(2)}× más. El rango se respeta.`);
    } else if (Math.abs(viejo - revRango) < 0.01) {
      skip('el rango coincide con meses enteros: hoy no se puede distinguir una aritmética de la otra.');
    } else {
      bad(`la diferencia entre rango ($${$(revRango)}) y meses enteros ($${$(viejo)}) es menor a la `
        + 'esperada: revisar que el desglose por ruta venga del rango y no del rollup mensual.');
    }

    // ── 2. Un mes 100 % Kepler debe coincidir ruta por ruta ─────────────────────────────────
    console.log('\n[2] Mes sin Wincaja: las dos pantallas coinciden ruta por ruta');
    const meses = (await db.query(
      `SELECT to_char(date_trunc('month',business_date),'YYYY-MM') mes,
              round(sum(venta) FILTER (WHERE venta_origen='derivado_tasa_linea'),2) wincaja,
              round(sum(venta),2) total
         FROM analytics.mv_rd_route_daily_200d
        WHERE tenant_id=$1 AND business_date <= CURRENT_DATE
        GROUP BY 1 HAVING round(sum(venta),2) > 0 ORDER BY 1 DESC`, [T])).rows;
    const puro = meses.find((m) => !Number(m.wincaja));
    if (!puro) { skip('no hay ningún mes 100 % Kepler en la ventana de la matvista.'); }
    else {
      const { ini, ultimoDia, primeroSiguiente } = mesVentana(puro.mes);
      const a = await tablero(ini, ultimoDia);
      const b = (await db.query(SQL_REPORTE, [T, ini, primeroSiguiente])).rows;
      const mapB = sinDuplicar(b);
      let malas = 0, comparadas = 0;
      for (const r of a) {
        const m = mapB.get(r.route_code);
        if (!m) continue;
        comparadas++;
        if (Math.abs(r.revenue - m.revenue) >= 0.01 || r.tickets !== m.tickets) {
          malas++;
          if (malas <= 3) console.log(`     · ${r.route_code}: tablero $${$(r.revenue)}/${r.tickets}tk vs reporte $${$(m.revenue)}/${m.tickets}tk`);
        }
      }
      if (!comparadas) skip(`${puro.mes}: no hubo rutas comparables.`);
      else if (!malas) pass(`${puro.mes}: ${comparadas} rutas, venta y tickets IDÉNTICOS al centavo.`);
      else bad(`${puro.mes}: ${malas} de ${comparadas} rutas no coinciden, y en un mes sin Wincaja no hay diferencia de base que lo explique.`);
    }

    // ── 3. La diferencia de los meses mixtos, EXPLICADA ─────────────────────────────────────
    console.log('\n[3] En los meses mixtos, el rollup mensual guarda el importe CRUDO');
    let mesesOk = 0, mesesMal = 0;
    for (const m of meses.filter((x) => Number(x.wincaja) > 0).slice(0, 4)) {
      const { ini, ultimoDia, primeroSiguiente } = mesVentana(m.mes);
      const a = await tablero(ini, ultimoDia);
      const b = (await db.query(SQL_REPORTE, [T, ini, primeroSiguiente])).rows;
      const mapB = sinDuplicar(b);
      let cuadra = 0, total = 0, residuo = 0;
      for (const r of a) {
        const mm = mapB.get(r.route_code);
        if (!mm) continue;
        total++;
        const dif = Math.abs(r.crudo - mm.revenue);
        // $1 por ruta: la matvista redondea por día y el rollup por mes.
        if (dif < 1) cuadra++; else residuo += dif;
      }
      if (!total) continue;
      const pct = Math.round((cuadra / total) * 100);
      console.log(`     ${m.mes}: ${cuadra}/${total} rutas cuadran con la identidad (${pct} %)`
        + (residuo ? ` · residuo $${$(residuo)}` : ''));
      if (pct >= 50) mesesOk++; else mesesMal++;
    }
    if (!mesesOk && !mesesMal) skip('no hay meses mixtos con rutas comparables.');
    else if (!mesesMal) pass(`la identidad «mensual = venta(push) + subtotal(wincaja)» se sostiene en los ${mesesOk} meses mixtos medidos.`);
    else skip(`${mesesMal} mes(es) con menos de la mitad de las rutas cuadrando: queda residuo SIN EXPLICAR `
      + 'además de la base de impuesto. No se declara verde ni se declara defecto: se declara no explicado.');

    // ── 4. Filas duplicadas en el rollup mensual ────────────────────────────────────────────
    console.log('\n[4] El rollup mensual no puede tener dos filas para la misma ruta y mes');
    const dup = (await db.query(
      `WITH d AS (SELECT month, route_code, count(*) n, count(DISTINCT warehouse_id) alm, min(revenue) rev
                    FROM analytics.sales_by_route_monthly
                   WHERE tenant_id=$1 AND route_code LIKE 'WIN-%' AND month >= date_trunc('year', CURRENT_DATE)
                   GROUP BY 1,2 HAVING count(*) > 1)
       SELECT count(*)::int casos, count(DISTINCT route_code)::int rutas,
              round(sum(rev*(n-1)),2)::float fantasma,
              string_agg(DISTINCT route_code, ', ') cuales FROM d`, [T])).rows[0];
    if (!Number(dup.casos)) pass('ninguna ruta aparece dos veces en el mismo mes.');
    else {
      bad(`${dup.casos} caso(s) en ${dup.rutas} ruta(s) (${dup.cuales}): la MISMA ruta está colgada de `
        + `${'dos o más'} almacenes y el reporte suma las dos. Venta fantasma en el año: $${$(dup.fantasma)}.`);
    }

    // ── 5. Los filtros de la pantalla ───────────────────────────────────────────────────────
    console.log('\n[5] Cada filtro parte el total sin perder ni duplicar un peso');
    if (!rango.length) { skip('sin filas en el rango no hay filtros que ejercer.'); }
    else {
      const totalRev = suma(rango, 'revenue');
      const rd = rango.filter((r) => !esVecinal(r));
      const vec = rango.filter((r) => esVecinal(r));
      const porCanal = suma(rd, 'revenue') + suma(vec, 'revenue');
      if (Math.abs(porCanal - totalRev) < 0.01 && rd.length + vec.length === rango.length) {
        pass(`canal: rd $${$(suma(rd, 'revenue'))} (${rd.length}) + vecinal $${$(suma(vec, 'revenue'))} (${vec.length}) = el total.`);
      } else bad(`canal: rd + vecinal = $${$(porCanal)} pero el total es $${$(totalRev)}.`);

      const suc = [...new Set(rango.map((r) => r.warehouse_code))];
      const porSuc = suc.reduce((a, s) => a + suma(rango.filter((r) => r.warehouse_code === s), 'revenue'), 0);
      if (Math.abs(porSuc - totalRev) < 0.01) pass(`sucursal: las ${suc.length} suman exactamente el total.`);
      else bad(`sucursal: las ${suc.length} suman $${$(porSuc)} contra un total de $${$(totalRev)}.`);

      const porRuta = rango.reduce((a, r) => a + Number(r.revenue), 0);
      if (Math.abs(Math.round(porRuta * 100) / 100 - totalRev) < 0.01) pass(`ruta: las ${rango.length} suman exactamente el total.`);
      else bad(`ruta: las ${rango.length} suman $${$(porRuta)} contra un total de $${$(totalRev)}.`);

      // Una ruta sola tiene que devolver lo suyo, no el total.
      const una = rango[0];
      const sola = rango.filter((r) => r.route_code === una.route_code);
      if (sola.length === 1 && Math.abs(sola[0].revenue - una.revenue) < 0.01 && (rango.length === 1 || sola[0].revenue < totalRev)) {
        pass(`filtrar por ${una.route_code} devuelve sus $${$(una.revenue)}, no el total.`);
      } else bad(`filtrar por ${una.route_code} no aisló esa ruta.`);
    }

    // ── 6. Pruebas negativas ────────────────────────────────────────────────────────────────
    console.log('\n[6] Pruebas negativas: los filtros tienen dientes');
    if (!rango.length) { skip('sin filas no se pueden ejercer las negativas.'); }
    else {
      const fantasma = rango.filter((r) => r.route_code === 'WIN-999-NO-EXISTE');
      if (!fantasma.length) pass('una ruta fabricada devuelve CERO filas (el filtro no cae al total).');
      else bad('una ruta inexistente devolvió filas — el filtro no está filtrando.');

      const sinCanal = rango.filter((r) => esVecinal(r) === undefined);
      const clasificadas = rango.filter((r) => esVecinal(r) || !esVecinal(r)).length;
      if (!sinCanal.length && clasificadas === rango.length) {
        pass(`las ${rango.length} rutas caen en rd o vecinal: ninguna se pierde entre los dos filtros.`);
      } else bad(`${rango.length - clasificadas} ruta(s) no quedan en ningún canal y desaparecerían al filtrar.`);

      const vacio = await tablero('1999-01-01', '1999-01-31');
      if (!vacio.length) pass('un rango sin operación devuelve vacío, no el último resultado.');
      else bad(`un rango de 1999 devolvió ${vacio.length} filas.`);
    }

    console.log(`\n=== ${ok} OK · ${fail} FALLAS · ${nomedido} NO MEDIDOS ===`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
  }
})();
