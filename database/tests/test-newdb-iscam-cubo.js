/* eslint-disable no-console */
/**
 * `[PR.M5]` — Candado del Cubo de ISCAM: NUESTRA venta por producto y sucursal, 31 meses.
 *
 * ⭐⭐ La aserción que más vale es el **cruce entre los dos archivos de la entrega**: el Cubo y
 * el SURF son ficheros distintos, armados por ISCAM por caminos distintos, y el total del Cubo
 * para un mes tiene que reproducir el `MedActMayo` que el SURF publica para ese mismo mes. Si
 * los dos coincidieran por construcción no probaría nada; no lo son, y por eso prueba.
 *
 * ⛔ Y vigila el defecto que este cargador ya tuvo: un lector que busca TODO en el diccionario
 * de la tabla dinámica devuelve `undefined` para las medidas y las carga como **cero**, sin
 * fallar. Un mes en cero no es un mes malo: es el lector roto.
 */
'use strict';

const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); }
catch { /* en el contenedor la URL viene del entorno */ }
const { Client } = require('pg');

const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
let ok = 0, fail = 0, nomedido = 0;
const check = (c, m) => { if (c) { ok++; console.log('  ✔ ' + m); } else { fail++; console.log('  ✘ ' + m); } };
const skip = (m) => { nomedido++; console.log('  — NO MEDIDO: ' + m); };

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL_NEW });
  await db.connect();
  await db.query(`SET app.tenant_id = '${TENANT}'`);
  const q = async (s, p) => (await db.query(s, p)).rows;

  console.log('\n[1] La forma');
  const rls = await q(`
    SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='analytics' AND c.relname='iscam_sales'`);
  check(rls.length === 1, 'la tabla analytics.iscam_sales existe');
  check(rls.length === 1 && rls[0].relrowsecurity && rls[0].relforcerowsecurity,
    'RLS habilitado Y forzado (sin FORCE, el dueño de la tabla la lee entera)');
  const vi = await q(`
    SELECT c.reloptions::text o FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='analytics' AND c.relname='v_iscam_vs_libros'`);
  check(vi.length === 1 && /security_invoker=(true|on)/.test(vi[0].o || ''),
    'v_iscam_vs_libros tiene security_invoker');

  console.log('\n[2] Lo cargado');
  const car = await q(`SELECT count(*)::int n, count(DISTINCT periodo)::int meses,
      min(periodo)::text a, max(periodo)::text b,
      count(DISTINCT sucursal_iscam)::int sucs, round(sum(val)/1e6,2) mdp
    FROM analytics.iscam_sales`);
  if (!car[0].n) {
    skip('no hay nada cargado todavia — el resto no se puede medir');
  } else {
    const c = car[0];
    console.log(`     ${c.n.toLocaleString('es-MX')} celdas · ${c.meses} meses (${c.a} → ${c.b})`
      + ` · ${c.sucs} sucursales · $${c.mdp}M`);
    check(c.meses >= 24, `hay ${c.meses} meses de historia`);
    check(Number(c.mdp) > 1000, `el valor cargado es $${c.mdp}M`);

    // ⛔ Un mes en cero delata al lector, no al mes. Es el bug que este cargador ya tuvo.
    const cero = await q(`SELECT periodo::text p FROM analytics.iscam_sales
      GROUP BY 1 HAVING sum(val) = 0 ORDER BY 1`);
    check(cero.length === 0,
      `ningun mes suma cero (${cero.length} lo hacen: un mes en cero es el lector roto, no el mes)`);
  }

  console.log('\n[3] ⭐⭐ El cruce entre los DOS archivos de la entrega');
  const cru = await q(`
    WITH cubo AS (
      SELECT periodo, sum(val) v FROM analytics.iscam_sales GROUP BY 1),
    surf AS (
      SELECT periodo, sum(med_act_mayo) v FROM analytics.iscam_market
      WHERE region='Región III' AND subcanal='Mayoreo Puro' AND mercado='DULCES'
        AND tipo_medida='valor' GROUP BY 1)
    SELECT c.periodo::text p, round(c.v,2) cubo, round(s.v,2) surf, round(abs(c.v - s.v),2) dif
    FROM cubo c JOIN surf s USING (periodo)`);
  if (!cru.length) {
    skip('no hay un periodo con Cubo Y SURF cargados: el cruce no se puede medir');
  } else {
    cru.forEach((r) => console.log(`     ${r.p}  cubo $${(r.cubo / 1e6).toFixed(2)}M`
      + `  surf $${(r.surf / 1e6).toFixed(2)}M  dif $${r.dif}`));
    check(cru.every((r) => Number(r.dif) <= 1),
      'el total del Cubo reproduce el MedActMayo del SURF al peso — son dos archivos distintos');
  }

  console.log('\n[4] ⛔ El mapeo declara lo que no puede mapear');
  const map = await q(`SELECT sucursal_iscam s, warehouse_code w, mapeo_nota nota,
      count(*)::int n, round(sum(val)/1e6,2) mdp
    FROM analytics.iscam_sales GROUP BY 1,2,3 ORDER BY 5 DESC`);
  if (!map.length) { skip('sin filas: el mapeo no se puede medir'); }
  else {
    map.forEach((r) => console.log(`     ${String(r.s).padEnd(28)} ${(r.w || '—').padEnd(4)}`
      + ` $${String(r.mdp).padStart(7)}M`));
    const sinMapa = map.filter((r) => !r.w);
    check(sinMapa.length > 0 && sinMapa.every((r) => r.nota),
      'las plazas agregadas quedan SIN almacen y CON motivo, en vez de asignarles uno inventado');
    check(map.filter((r) => r.w).length >= 6,
      `${map.filter((r) => r.w).length} nombres de ISCAM sí mapean a un almacen nuestro`);
  }

  console.log('\n[5] ⭐ El hueco que esta carga viene a tapar');
  const hueco = await q(`
    SELECT estado, count(*)::int celdas, round(sum(val_iscam)/1e6,2) iscam_mdp
    FROM analytics.v_iscam_vs_libros GROUP BY 1 ORDER BY 3 DESC NULLS LAST`);
  if (!hueco.length) { skip('v_iscam_vs_libros sin filas'); }
  else {
    hueco.forEach((r) => console.log(`     ${String(r.estado).padEnd(12)} ${String(r.celdas).padStart(4)}`
      + ` · ISCAM $${r.iscam_mdp === null ? '  —' : r.iscam_mdp + 'M'}`));
    const sl = hueco.find((r) => r.estado === 'sin_libros');
    check(!!sl && Number(sl.iscam_mdp) > 0,
      `hay $${sl ? sl.iscam_mdp : 0}M de venta nuestra que SOLO existe en ISCAM: es la razon de cargar esto`);
  }

  console.log('\n[6] El empaque y el gramaje, crudos y declarados');
  const emp = await q(`SELECT
      count(*) FILTER (WHERE empaque_d IS NOT NULL)::int con_dp,
      count(*) FILTER (WHERE gramaje IS NOT NULL)::int con_gr,
      count(*)::int n FROM analytics.iscam_sales`);
  if (!emp[0].n) { skip('sin filas'); }
  else {
    const p = (x) => (100 * x / emp[0].n).toFixed(1);
    console.log(`     empaque ${p(emp[0].con_dp)}% · gramaje ${p(emp[0].con_gr)}%`);
    check(emp[0].con_dp / emp[0].n > 0.99, 'el empaque se desglosa en practicamente todas las filas');
    // ⛔ Se guarda, NO se usa: que D y P sean display y pieza es lo que parece, no lo verificado.
    const usos = await q(`SELECT count(*)::int n FROM pg_views
      WHERE schemaname='analytics' AND definition ILIKE '%empaque_d%'`);
    check(usos[0].n === 0,
      'ninguna vista usa empaque_d todavia: el significado de D y P no se ha probado contra el dinero');
  }

  console.log('\n[7] La pantalla tiene que poder leerla');
  const t0 = Date.now();
  await q(`SELECT warehouse_code, sum(val) v FROM analytics.iscam_sales
    WHERE periodo >= (SELECT max(periodo) FROM analytics.iscam_sales) - interval '11 months'
    GROUP BY 1 ORDER BY 2 DESC NULLS LAST`);
  const ms = Date.now() - t0;
  check(ms < 1000, `doce meses por sucursal en ${ms} ms (la compuerta de la pantalla es 1 s)`);

  await db.end();
  console.log(`\n${ok} ✓ / ${fail} ✗ / ${nomedido} no medido`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
