/* eslint-disable no-console */
/**
 * `[DM.20]` CANDADO de la mercancía AJENA en el almacén de una sucursal.
 *
 * ── QUÉ PROTEGE ─────────────────────────────────────────────────────────────────────────────
 * Que nadie convierta esta vista en una RESTA. Edgar pidió publicar el inventario del CEDIS
 * "descontando lo que fue de Morelia Abastos y Canindo", y **no se puede**: las salidas no traen
 * centro de compra, así que una vez dentro del almacén el inventario es fungible y restar
 * exigiría suponer un reparto.
 *
 * ── ⭐ EL BLOQUE QUE IMPORTA ES EL 3: VIGILA LA PREMISA ─────────────────────────────────────
 * Toda la decisión de "declarar en vez de restar" se apoya en UN hecho medible: las salidas
 * (`U-D-13`, `U-D-41`) **no** declaran centro de compra. Si algún día lo declararan, la resta
 * pasaría a ser posible y esta vista se quedaría corta — y nadie se enteraría. Por eso el
 * candado mide la premisa, no sólo el resultado. Mismo patrón que `[CE.8]`.
 *
 *   DATABASE_URL_NEW=<prod> node database/tests/test-newdb-warehouse-foreign-intake.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.PROD_DB_URL || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

let ok = 0, fail = 0, nomedido = 0;
const pass = (m) => { ok++; console.log('  ✔', m); };
const bad = (m) => { fail++; console.log('  x FALLA:', m); };
const skip = (m) => { nomedido++; console.log('  ~ NO MEDIDO:', m); };
const num = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

(async () => {
  const db = new Client({ connectionString: URL, ssl: /rlwy|proxy\.rlwy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await db.connect();
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  try {
    await db.query(`SET statement_timeout = '180s'`);
    console.log(`\n[DM.20] Mercancía ajena en el almacén · ${(await q('SELECT current_database() d'))[0].d}`);

    // ── 1. La vista, con security_invoker y GRANT ─────────────────────────────────────────
    console.log('\n[1] La vista existe, es security_invoker y app_runtime la puede leer');
    const [meta] = await q(
      `SELECT EXISTS (SELECT 1 FROM pg_options_to_table(c.reloptions) o
                       WHERE o.option_name='security_invoker' AND o.option_value='true') AS inv,
              has_table_privilege('app_runtime', c.oid, 'SELECT') AS grant_ok
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='analytics' AND c.relname='v_warehouse_foreign_intake'`);
    if (!meta) bad('analytics.v_warehouse_foreign_intake NO existe: falta la migración 20261001320000.');
    else if (meta.inv && meta.grant_ok) pass('security_invoker = true y GRANT a app_runtime (un CREATE OR REPLACE no hereda ninguno).');
    else bad(`security_invoker=${meta.inv} · grant=${meta.grant_ok}.`);

    // ── 2. Todo clasificado, y lo ajeno con su plaza ──────────────────────────────────────
    console.log('\n[2] El CEDIS: qué entró a su almacén y de quién era');
    const cedis = await q(
      `SELECT intake_veredicto, sum(docs)::int docs, sum(unidades) u, sum(importe) imp
         FROM analytics.v_warehouse_foreign_intake WHERE sucursal='00'
        GROUP BY 1 ORDER BY 3 DESC NULLS LAST`);
    if (!cedis.length) { bad('la vista no devolvió filas para el almacén del CEDIS.'); }
    else {
      cedis.forEach((r) => console.log(`     ${String(r.intake_veredicto).padEnd(26)} ${String(r.docs).padStart(6)} docs · ${num(r.u).padStart(12)} u · $${num(r.imp)}`));
      const ajeno = cedis.find((r) => r.intake_veredicto === 'de_otra_plaza');
      const propio = cedis.find((r) => r.intake_veredicto === 'propio');
      if (!ajeno || !propio) {
        skip('falta alguno de los dos veredictos principales: no hay contraste que medir.');
      } else if (Number(ajeno.u) > 0) {
        pass(`${num(ajeno.u)} unidades entraron al almacén del CEDIS por cuenta de otras plazas,`
          + ` contra ${num(propio.u)} propias — y cada una sale con su plaza nombrada.`);
      } else {
        bad('el bucket "de_otra_plaza" quedó en cero: o se arregló el histórico (improbable) o el decode se rompió.');
      }
    }

    // ── 3. ⭐ PREMISA: las SALIDAS no declaran centro de compra ───────────────────────────
    console.log('\n[3] La premisa de "declarar en vez de restar": las salidas no dicen de quién era');
    const [sal] = await q(
      `SELECT count(*)::int docs,
              count(*) FILTER (WHERE btrim(COALESCE(c12,'')) LIKE 'C-%')::int con_centro_de_compra
         FROM kepler_ods.kdm1
        WHERE sucursal='00' AND btrim(c1)='00' AND c2='U' AND c3='D'
          AND btrim(c4::text) IN ('13','41') AND c9::date >= current_date - 365`);
    if (!sal || !sal.docs) {
      skip('no hay salidas del almacén del CEDIS en 365 días: la premisa no se puede comprobar.');
    } else if (sal.con_centro_de_compra === 0) {
      // Si esto cambia, la resta pasa a ser posible y esta vista se queda corta. Que se entere
      // alguien es justamente el punto del candado.
      pass(`${sal.docs} salidas y NINGUNA declara centro de compra: el inventario es fungible`
        + ' y restar exigiría suponer un reparto. La vista declara, no resta. Correcto.');
    } else {
      bad(`${sal.con_centro_de_compra} de ${sal.docs} salidas YA declaran centro de compra (c12 ~ 'C-%'):`
        + ' la premisa cambió y ahora SÍ se podría atribuir la salida. Revisar si esta vista se quedó corta.');
    }

    // ── 4. El corte: ya paró, y se declara el último mes con operación ajena ─────────────
    console.log('\n[4] ¿Sigue pasando? (Edgar: "el problema no es actual")');
    const meses = await q(
      `SELECT to_char(mes,'YYYY-MM') AS mes,
              sum(unidades) FILTER (WHERE intake_veredicto='de_otra_plaza') AS ajeno
         FROM analytics.v_warehouse_foreign_intake
        WHERE sucursal='00' AND mes >= date_trunc('month', current_date) - interval '5 months'
        GROUP BY 1 ORDER BY 1`);
    if (!meses.length) { skip('sin meses recientes que medir.'); }
    else {
      meses.forEach((r) => console.log(`     ${r.mes}  ajeno: ${r.ajeno ? num(r.ajeno) + ' u' : '—'}`));
      const ultimo = meses[meses.length - 1];
      const conAjeno = meses.filter((r) => Number(r.ajeno || 0) > 0);
      if (!conAjeno.length) {
        pass('ningún mes reciente trae mercancía ajena: el corte se sostiene.');
      } else if (Number(ultimo.ajeno || 0) === 0) {
        pass(`el último mes (${ultimo.mes}) va en cero; el último con operación ajena fue`
          + ` ${conAjeno[conAjeno.length - 1].mes}. El corte se sostiene.`);
      } else {
        // No es una FALLA del código: es un hecho de negocio que hay que saber.
        skip(`${ultimo.mes} todavía trae ${num(ultimo.ajeno)} unidades ajenas —`
          + ' alguna plaza sigue cargando al almacén del CEDIS. Es un hallazgo, no un bug.');
      }
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
