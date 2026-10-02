/* eslint-disable no-console */
/**
 * `[AUD-DAT.22]` — **Ningun rollup de la venta publica un bucket que el hecho base rechaza.**
 *
 * ── DE DONDE SALE ESTE CANDADO ────────────────────────────────────────────────────────────
 * `analytics.sales_daily` tiene TRES rollups en el mismo carril nocturno y solo UNO declaraba
 * un piso de fechas. Medido en produccion el 2026-10-02:
 *
 *      sales_monthly              NINGUN bucket imposible
 *      sales_boxes_monthly        2000-01 ($238,071) · 2014-06 ($5,737) · 2020-07 · 2020-10 · 2026-12
 *      sales_by_vendor_monthly    los mismos cinco
 *
 * ⭐ Y fallan por razones DISTINTAS, que es justo por lo que un solo arreglo no alcanza:
 *   · `boxes` agrupa TODO `sales_daily` sin filtro -> hereda la basura cada noche.
 *   · `vendor` procesa por lotes mensuales con una ventana de 8 meses, asi que NUNCA VISITA
 *     esos meses: no los re-deriva ni los barre. Estan congelados ahi desde que entraron.
 *   Un candado que solo mirara el filtro del primero daria verde sobre el segundo.
 *
 * ── QUE SON ESAS FILAS (y por que NO se borran del hecho base) ────────────────────────────
 * Las 230 filas de `sales_daily` fuera de ventana son **todas de Wincaja**. No son un defecto
 * del importer: son tickets REALES con la fecha corrompida en el punto de venta — el ano 2000
 * es la firma de un reloj reseteado. Borrarlas perderia venta que ocurrio; publicarlas en su
 * mes falso miente sobre cuando. Por eso el hecho base las CONSERVA y declara (`[AUD-DAT.2]`)
 * y son los ROLLUPS los que no deben publicarlas en un bucket.
 *
 * ── QUE VIGILA ────────────────────────────────────────────────────────────────────────────
 *  1. El piso que declara `database/importers/lib/sales-window.js` es el MISMO que el CHECK
 *     `sales_daily_sale_date_piso_check`. Dos declaraciones del mismo numero que nadie compara
 *     terminan siendo dos numeros.
 *  2. Ningun rollup publica un bucket fuera de la ventana. Se nombra cual, cuantas filas y
 *     cuanto dinero — un conteo sin el monto no deja decidir si urge.
 *  3. El rezago del mes ABIERTO entre el hecho y su rollup se MIDE y se declara. No es falla
 *     (el rollup corre a las 03:00 y el hecho es continuo), pero hoy no lo publica nadie y se
 *     lee como descuadre.
 *
 * ⚠️ SOLO LEE. Contra prod a proposito: el defecto vive en los datos, no en el esquema.
 * ⚠️ Un rollup vacio reporta NO MEDIDO, nunca verde: sin filas no hay con que comprobar.
 */
const path = require('path');
const knexLib = require('knex');

const { PISO } = require(path.join(__dirname, '..', 'importers', 'lib', 'sales-window.js'));
const PISO_YM = PISO.slice(0, 7);

let pass = 0; let fail = 0; let nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✔ ' + m); } else { fail++; console.log('  ✖ ' + m); } };
const noMedido = (m) => { nm++; console.log('  — NO MEDIDO: ' + m); };

// Los tres rollups y como se llama su columna de periodo. ⚠️ No son iguales: dos usan texto
// 'YYYY-MM' y uno usa date. Esa incoherencia es otro hallazgo de la auditoria; aca se respeta
// en vez de uniformarse a la fuerza, porque cambiarla es una migracion, no un test.
const ROLLUPS = [
  { tabla: 'analytics.sales_monthly', col: 'month', tipo: 'date' },
  { tabla: 'analytics.sales_boxes_monthly', col: 'year_month', tipo: 'texto' },
  { tabla: 'analytics.sales_by_vendor_monthly', col: 'year_month', tipo: 'texto' },
];

(async () => {
  const url = process.env.DATABASE_URL_NEW || process.env.PGPROD_URL;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(2); }
  const knex = knexLib({ client: 'pg', connection: url, pool: { min: 0, max: 2 } });
  try {
    console.log('\n[AUD-DAT.22] La ventana de la venta, en los tres rollups\n');

    // ── 1. El piso del modulo y el del CHECK son el MISMO ───────────────────────────────
    const def = await knex.raw(
      'SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint '
      + "WHERE conname = 'sales_daily_sale_date_piso_check' "
      + "AND conrelid = 'analytics.sales_daily'::regclass").then((r) => r.rows[0]);
    if (!def) {
      noMedido('no existe sales_daily_sale_date_piso_check: no hay contra que comparar el piso del modulo');
    } else {
      const enCheck = (String(def.def).match(/\d{4}-\d{2}-\d{2}/) || [])[0];
      ok(enCheck === PISO,
        'el piso del modulo (' + PISO + ') es el MISMO que el del CHECK de la tabla ('
        + (enCheck || 'no pude leerlo') + ')');
    }

    // ── 2. Ningun rollup publica un bucket fuera de ventana ─────────────────────────────
    for (const r of ROLLUPS) {
      const tot = await knex.raw('SELECT count(*)::int AS n FROM ' + r.tabla).then((x) => x.rows[0]);
      if (Number(tot.n) === 0) { noMedido(r.tabla + ' esta vacia: sin filas no hay con que comprobar'); continue; }

      const cond = r.tipo === 'date'
        ? r.col + " < DATE '" + PISO + "' OR " + r.col + " > date_trunc('month', current_date)"
        : r.col + " < '" + PISO_YM + "' OR " + r.col + " > to_char(current_date, 'YYYY-MM')";
      const periodo = r.tipo === 'date' ? "to_char(" + r.col + ", 'YYYY-MM')" : r.col;

      const esquema = r.tabla.split('.')[0];
      const nombre = r.tabla.split('.')[1];
      const tieneDinero = await knex('information_schema.columns')
        .where({ table_schema: esquema, table_name: nombre, column_name: 'revenue' })
        .first().then((x) => Boolean(x));

      const sel = 'SELECT ' + periodo + ' AS bucket, count(*)::int AS filas'
        + (tieneDinero ? ', coalesce(round(sum(revenue)::numeric, 2), 0) AS pesos' : ', NULL AS pesos')
        + ' FROM ' + r.tabla + ' WHERE ' + cond + ' GROUP BY 1 ORDER BY 1';
      const rows = await knex.raw(sel).then((x) => x.rows);

      if (rows.length === 0) {
        ok(true, r.tabla + ': ningun bucket fuera de la ventana (' + tot.n + ' filas revisadas)');
      } else {
        const det = rows.map((x) => x.bucket + ' (' + x.filas + ' filas'
          + (x.pesos === null ? '' : ', $' + x.pesos) + ')').join(' · ');
        ok(false, r.tabla + ' publica ' + rows.length + ' bucket(s) IMPOSIBLE(s): ' + det);
      }
    }

    // ── 3. El rezago del mes ABIERTO, medido y declarado ────────────────────────────────
    const lag = await knex.raw(
      'SELECT (SELECT coalesce(sum(revenue), 0) FROM analytics.sales_daily '
      + "WHERE sale_date >= date_trunc('month', current_date) AND sale_date <= current_date) AS hecho, "
      + '(SELECT coalesce(sum(revenue), 0) FROM analytics.sales_monthly '
      + "WHERE month = date_trunc('month', current_date)) AS rollup").then((x) => x.rows[0]);
    const h = Number(lag.hecho); const ro = Number(lag.rollup);
    if (h === 0) {
      noMedido('el mes abierto no tiene venta en el hecho base todavia: no se puede medir el rezago');
    } else {
      const pct = ((h - ro) / h) * 100;
      noMedido('rezago del mes abierto: hecho $' + h.toFixed(2) + ' vs rollup $' + ro.toFixed(2)
        + ' = ' + pct.toFixed(1) + '% (NO es falla: el rollup corre a las 03:00 y el hecho es '
        + 'continuo. Se declara porque hoy no lo publica ninguna pantalla)');
    }

    // ── 4. PRUEBA NEGATIVA: el comparador tiene que marcar un bucket malo ───────────────
    // Sin esto la regla seria una intencion. Se evalua el MISMO predicado contra valores
    // sinteticos, sin escribir nada en prod.
    const neg = await knex.raw(
      "WITH v(ym) AS (VALUES ('2000-01'), ('2014-06'), ('2026-12'), "
      + "(to_char(current_date, 'YYYY-MM')), ('" + PISO_YM + "')) "
      + "SELECT count(*) FILTER (WHERE ym < '" + PISO_YM + "' OR ym > to_char(current_date, 'YYYY-MM'))::int AS marcados, "
      + "count(*) FILTER (WHERE NOT (ym < '" + PISO_YM + "' OR ym > to_char(current_date, 'YYYY-MM')))::int AS limpios "
      + 'FROM v').then((x) => x.rows[0]);
    ok(Number(neg.marcados) === 3 && Number(neg.limpios) === 2,
      'el comparador marca 2000-01, 2014-06 y 2026-12 y deja pasar el mes actual y el piso ('
      + neg.marcados + ' marcados / ' + neg.limpios + ' limpios)');

    console.log('\nVentana de la venta [AUD-DAT.22]: ' + pass + ' ✔ / ' + fail + ' ✖ / ' + nm + ' NO MEDIDO\n');
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('ERROR', e.message); process.exit(1);
  } finally { await knex.destroy(); }
})();
