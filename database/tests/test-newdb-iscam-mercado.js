/* eslint-disable no-console */
/**
 * `[PR.M1]` — Candado de ISCAM: la medicion de mercado que entra al motor de margen.
 *
 * Vigila las tres cosas que pueden mentir en silencio acá:
 *   1. La **forma**: RLS forzado, `security_invoker` en la vista, y el CHECK que impide que el
 *      mercado sea menor que nuestra parte de él.
 *   2. El **grano**: el share cambia segun si se mira el canal propio o el mayoreo entero, y las
 *      dos cifras son ciertas. Un candado que no distinga las dos invita a "arreglar" una.
 *   3. La **advertencia**: el numerador viene inflado por traspasos, y eso tiene que viajar con
 *      el dato, no en un correo.
 */
'use strict';

const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); }
catch { /* en el contenedor la URL viene del entorno */ }
const { Client } = require('pg');

const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
let ok = 0, fail = 0, nomedido = 0;

const check = (cond, msg) => { if (cond) { ok++; console.log('  ✔ ' + msg); } else { fail++; console.log('  ✘ ' + msg); } };
const skip = (msg) => { nomedido++; console.log('  — NO MEDIDO: ' + msg); };

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL_NEW });
  await db.connect();
  await db.query(`SET app.tenant_id = '${TENANT}'`);
  const q = async (sql, p) => (await db.query(sql, p)).rows;

  console.log('\n[1] La forma');
  const rls = await q(`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='analytics' AND c.relname IN ('iscam_market','iscam_taxonomy')`);
  check(rls.length === 2, 'las dos tablas existen');
  check(rls.every((r) => r.relrowsecurity && r.relforcerowsecurity),
    'RLS habilitado Y forzado en las dos (sin FORCE, el dueño de la tabla la lee entera)');

  const vista = await q(`
    SELECT c.reloptions::text AS opts FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='analytics' AND c.relname='v_iscam_share'`);
  check(vista.length === 1 && /security_invoker=(true|on)/.test(vista[0].opts || ''),
    'la vista tiene security_invoker: sin él lee con los permisos del creador y saltea el RLS');

  const chk = await q(`
    SELECT conname FROM pg_constraint con
    JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='analytics' AND c.relname='iscam_market' AND con.contype='c'`);
  check(chk.some((x) => x.conname === 'iscam_mdo_contiene_mayo'),
    'existe el CHECK mercado >= nuestro');
  check(chk.some((x) => x.conname === 'iscam_medida_valida'),
    'existe el CHECK de tipo_medida');

  console.log('\n[2] El dato cargado');
  const car = await q(`SELECT periodo::text AS periodo, count(*)::int AS filas FROM analytics.iscam_market GROUP BY 1`);
  if (!car.length) {
    skip('no hay ninguna entrega cargada todavia — el resto de este bloque no se puede medir');
  } else {
    check(car.length >= 1, `hay ${car.length} periodo(s) cargado(s): ${car.map((x) => x.periodo).join(', ')}`);
    const viola = await q(`SELECT count(*)::int AS n FROM analytics.iscam_market WHERE med_act_mdo < med_act_mayo`);
    check(viola[0].n === 0, 'ninguna fila tiene el mercado por debajo de lo nuestro');

    const tax = await q(`SELECT count(*)::int AS n FROM analytics.iscam_taxonomy`);
    check(tax[0].n > 1000, `el puente de codigos de barras tiene ${tax[0].n} entradas`);

    // ⭐ El puente sirve para lo que existe: que alcance a nuestra venta.
    const cob = await q(`
      SELECT count(DISTINCT p.id)::int AS skus, round(sum(v.venta)/1e6, 2) AS mdp
      FROM (SELECT product_id, sum(revenue) AS venta FROM analytics.sales_daily
            WHERE sale_date >= current_date - 90 GROUP BY 1) v
      JOIN catalog.products p ON p.id = v.product_id
      JOIN analytics.iscam_taxonomy t ON t.barcode_norm = ltrim(p.barcode, '0')`);
    check(Number(cob[0].skus) > 500,
      `el puente alcanza ${cob[0].skus} SKUs nuestros, $${cob[0].mdp}M de venta 90d`);
  }

  console.log('\n[3] ⭐ El grano: dos cifras ciertas, y no son la misma');
  const gr = await q(`
    WITH propio AS (
      SELECT sum(nuestro) n, sum(mercado_total) m FROM analytics.v_iscam_share
      WHERE region='Región III' AND tipo_medida='valor' AND mercado='DULCES'
        AND subcanal='Mayoreo Puro'),
    todo AS (
      SELECT sum(nuestro) n, sum(mercado_total) m FROM analytics.v_iscam_share
      WHERE region='Región III' AND tipo_medida='valor' AND mercado='DULCES')
    SELECT round(100.0*propio.n/nullif(propio.m,0),2) AS share_canal_propio,
           round(100.0*todo.n/nullif(todo.m,0),2) AS share_mayoreo_total,
           round((todo.m - propio.m)/1e6, 1) AS mercado_donde_no_vendemos_mdp
    FROM propio, todo`);
  if (!gr.length || gr[0].share_canal_propio === null) {
    skip('sin datos de Región III: el grano no se puede comprobar');
  } else {
    const g = gr[0];
    console.log(`     canal propio ${g.share_canal_propio}% · mayoreo total ${g.share_mayoreo_total}%`
      + ` · mercado donde no vendemos $${g.mercado_donde_no_vendemos_mdp}M`);
    check(Number(g.share_canal_propio) > Number(g.share_mayoreo_total),
      'el share del canal propio es MAYOR que el del mayoreo total — si se igualaran, alguien aplano el subcanal');
    check(Number(g.mercado_donde_no_vendemos_mdp) > 0,
      'hay mercado medido en subcanales donde no vendemos: es la diferencia entre las dos cifras');
  }

  console.log('\n[4] La advertencia viaja con el dato');
  const adv = await q(`
    SELECT numerador_inflado_por_traspasos AS flag, length(advertencia) AS largo
    FROM analytics.v_iscam_share LIMIT 1`);
  if (!adv.length) { skip('sin filas: la advertencia no se puede leer'); }
  else {
    check(adv[0].flag === true, 'la vista marca que el numerador viene inflado por traspasos');
    check(Number(adv[0].largo) > 200, 'y explica por que, con el numero medido, en la misma fila');
  }

  console.log('\n[5] ⛔ Lo que a proposito NO se importo');
  const cols = await q(`
    SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema='analytics' AND table_name='iscam_market'
      AND column_name ILIKE '%pcio%'`);
  check(cols[0].n === 0,
    'PcioDisp NO esta en la tabla: su formula es Val/Vol/24, un divisor fijo para todo el catalogo');

  await db.end();
  console.log(`\n${ok} ✓ / ${fail} ✗ / ${nomedido} no medido`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
