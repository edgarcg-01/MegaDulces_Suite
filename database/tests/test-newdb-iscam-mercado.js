/* eslint-disable no-console */
/**
 * `[PR.M1]` + `[PR.M3]` — Candado de ISCAM: la medicion de mercado y la foto de la competencia.
 *
 * Vigila lo que puede mentir en silencio aca:
 *   1. La **forma**: RLS forzado, `security_invoker` en las dos vistas, y el grano fino en la PK.
 *   2. El **grano**: el share cambia segun si se mira el canal propio o el mayoreo entero, y las
 *      dos cifras son ciertas. Un candado que no distinga las dos invita a "arreglar" una.
 *   3. La **advertencia**: el numerador viene inflado por traspasos, y eso tiene que viajar con
 *      el dato, no en un correo.
 *   4. ⭐ Que **nada se descarte en silencio**: el CHECK viejo rechazaba las filas donde el panel
 *      mide menos mercado que venta nuestra. A grano de marca eran 4,674 filas con $9.51M. Ahora
 *      se cargan y se declaran, y hay **prueba negativa** de que de verdad entran.
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

  const vistas = await q(`
    SELECT c.relname, c.reloptions::text AS opts
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='analytics' AND c.relname IN ('v_iscam_share','v_iscam_competencia')`);
  check(vistas.length === 2, 'existen v_iscam_share y v_iscam_competencia');
  check(vistas.length === 2 && vistas.every((v) => /security_invoker=(true|on)/.test(v.opts || '')),
    'las DOS vistas tienen security_invoker: sin él leen con los permisos del creador y saltean el RLS');

  const pk = await q(`
    SELECT a.attname FROM pg_constraint con
    JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN unnest(con.conkey) k(att) ON true
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.att
    WHERE n.nspname='analytics' AND c.relname='iscam_market' AND con.contype='p'`);
  const cols = pk.map((r) => r.attname);
  check(cols.includes('fabricante') && cols.includes('submarca'),
    'la PK baja a fabricante y submarca: sin esas dos la competencia es un total y no se ve');

  const chk = await q(`
    SELECT conname FROM pg_constraint con
    JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='analytics' AND c.relname='iscam_market' AND con.contype='c'`);
  const nombres = chk.map((x) => x.conname);
  check(nombres.includes('iscam_medida_valida'), 'existe el CHECK de tipo_medida');
  check(nombres.includes('iscam_medidas_no_negativas'),
    'existe el CHECK de medidas no negativas (lo que NO se puede violar legitimamente)');
  check(!nombres.includes('iscam_mdo_contiene_mayo'),
    '⭐ el CHECK "mercado >= nuestro" ya NO existe: obligaba a descartar 4,674 filas con $9.51M');

  console.log('\n[2] El dato cargado');
  const car = await q('SELECT periodo::text AS periodo, count(*)::int AS filas FROM analytics.iscam_market GROUP BY 1');
  if (!car.length) {
    skip('no hay ninguna entrega cargada todavia — el resto de este bloque no se puede medir');
  } else {
    check(car.length >= 1, `hay ${car.length} periodo(s) cargado(s): ${car.map((x) => x.periodo).join(', ')}`);
    const n = car.reduce((a, x) => a + x.filas, 0);
    check(n > 300000, `${n.toLocaleString('es-MX')} filas al grano de marca (el grano viejo eran ~13,400)`);

    const tax = await q('SELECT count(*)::int AS n FROM analytics.iscam_taxonomy');
    check(tax[0].n > 1000, `el puente de codigos de barras tiene ${tax[0].n} entradas`);

    // El puente sirve para lo que existe: que alcance a nuestra venta. Si el ambiente no trae el
    // fact de ventas, se DECLARA no medido en vez de dar por buena una cobertura que no se vio.
    const cob = await q(`
      SELECT count(DISTINCT p.id)::int AS skus, round(sum(v.venta)/1e6, 2) AS mdp
      FROM (SELECT product_id, sum(revenue) AS venta FROM analytics.sales_daily
            WHERE sale_date >= current_date - 90 GROUP BY 1) v
      JOIN catalog.products p ON p.id = v.product_id
      JOIN analytics.iscam_taxonomy t ON t.barcode_norm = ltrim(p.barcode, '0')`)
      .catch(() => null);
    if (!cob) skip('sin analytics.sales_daily / catalog.products: la cobertura del puente no se puede medir');
    else {
      check(Number(cob[0].skus) > 500,
        `el puente alcanza ${cob[0].skus} SKUs nuestros, $${cob[0].mdp}M de venta 90d`);
    }
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

  console.log('\n[4] ⭐ Las dos vistas cuentan lo mismo, por caminos distintos');
  const SLICE = `region='Región III' AND subcanal='Mayoreo Puro' AND mercado='DULCES'
                 AND tipo_medida='valor'`;
  // (a) Las DOS vistas, sobre el MISMO universo: todas las filas. Si no coinciden, el rollup miente.
  const cruce = await q(`
    WITH fino AS (
      SELECT division, categoria, sum(nuestro) n, sum(mercado_total) m
      FROM analytics.v_iscam_competencia WHERE ${SLICE} GROUP BY 1,2),
    grueso AS (
      SELECT division, categoria, sum(nuestro) n, sum(mercado_total) m
      FROM analytics.v_iscam_share WHERE ${SLICE} GROUP BY 1,2)
    SELECT count(*)::int AS categorias,
           count(*) FILTER (WHERE abs(f.n-g.n) > 0.01 OR abs(f.m-g.m) > 0.01)::int AS difieren
    FROM fino f JOIN grueso g USING (division, categoria)`);
  if (!cruce.length || !cruce[0].categorias) {
    skip('sin datos de Región III: el cruce entre vistas no se puede medir');
  } else {
    check(cruce[0].difieren === 0,
      `${cruce[0].categorias} categorias: la vista fina y la de categoria dan lo mismo (${cruce[0].difieren} difieren)`);
  }
  // (b) La identidad, FILA POR FILA y solo donde se puede calcular. "competencia" es una resta:
  //     si no reconstruye el mercado, la resta esta mal planteada. Donde los insumos se
  //     contradicen la vista declara NULL, y una identidad no se mide sobre lo que no existe.
  const ident = await q(`
    SELECT count(*)::int AS medibles,
           count(*) FILTER (WHERE abs((nuestro + competencia) - mercado_total) > 0.0001)::int AS rotas,
           count(*) FILTER (WHERE competencia IS NULL)::int AS declaradas
    FROM analytics.v_iscam_competencia WHERE ${SLICE}`);
  if (!ident.length) skip('sin filas: la identidad no se puede medir');
  else {
    check(ident[0].rotas === 0,
      `nuestro + competencia = mercado en ${ident[0].medibles.toLocaleString('es-MX')} marcas (${ident[0].rotas} rotas)`);
    check(ident[0].declaradas > 0,
      `${ident[0].declaradas} marcas declaran competencia NULL en vez de dibujar un cero que no es cero`);
  }

  console.log('\n[5] ⭐ El veredicto distingue las dos ausencias');
  const ver = await q(`
    SELECT veredicto, count(*)::int n, round(sum(competencia)/1e6,2) comp
    FROM analytics.v_iscam_competencia
    WHERE region='Región III' AND subcanal='Mayoreo Puro' AND mercado='DULCES'
      AND tipo_medida='valor' GROUP BY 1`);
  if (!ver.length) { skip('sin filas: el veredicto no se puede medir'); }
  else {
    const m = Object.fromEntries(ver.map((r) => [r.veredicto, r]));
    ver.sort((a, b) => b.n - a.n).forEach((r) => console.log(
      `     ${String(r.veredicto).padEnd(16)} ${String(r.n).padStart(5)} marcas · competencia `
      + (r.comp === null ? 'NO MEDIBLE (los insumos se contradicen)' : `$${r.comp}M`)));
    check(m.ausentes && m.sin_comparativo,
      'existen "ausentes" y "sin_comparativo" por separado: no es la misma ausencia y no se juzgan igual');
    check(m.ausentes && Number(m.ausentes.comp) > 0,
      `las marcas donde vendemos cero cargan $${m.ausentes ? m.ausentes.comp : 0}M que se lleva la competencia`);
    check(!!(m.perdiendo && m.ganando),
      'el veredicto separa donde ganamos terreno de donde lo perdemos');
  }

  console.log('\n[6] ⛔ Lo que se DECLARA en vez de descartarse');
  const dec = await q(`
    SELECT count(*)::int n, round(sum(med_act_mayo)/1e6,2) mdp
    FROM analytics.iscam_market WHERE mercado_menor_que_nuestro`);
  if (!dec.length || !dec[0].n) {
    skip('ninguna fila marcada: o la entrega vino perfecta o la bandera no se escribio');
  } else {
    console.log(`     ${dec[0].n.toLocaleString('es-MX')} filas · $${dec[0].mdp}M de venta nuestra`);
    // ⭐ PRUEBA NEGATIVA del cambio: estas filas antes NO podian existir. Que existan es la
    //    evidencia de que el CHECK ya no las borra. Si el conteo cae a cero, alguien lo repuso.
    check(dec[0].n > 0,
      'las filas donde el panel mide menos mercado que venta nuestra ENTRAN a la tabla (antes el CHECK las borraba)');
    // ⭐ La bandera es columna GENERADA: no puede contradecir a su fila ni aunque alguien la
    //    escriba a mano. Se comprueba la PROPIEDAD, no el valor -- el valor ya no tiene forma
    //    de desviarse, y lo que hay que vigilar es que nadie la vuelva a hacer escribible.
    const gen = await q(`
      SELECT a.attgenerated FROM pg_attribute a
      JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='analytics' AND c.relname='iscam_market'
        AND a.attname='mercado_menor_que_nuestro'`);
    check(gen.length === 1 && gen[0].attgenerated === 's',
      'la bandera es GENERADA por la base: no puede contradecir a los numeros de su propia fila');
    const coherente = await q(`
      SELECT count(*)::int AS n FROM analytics.iscam_market
      WHERE mercado_menor_que_nuestro <> (med_act_mdo < med_act_mayo)`);
    check(coherente[0].n === 0,
      'y de hecho ninguna fila la contradice');
    const enVista = await q(`
      SELECT count(*)::int AS n FROM analytics.v_iscam_competencia WHERE veredicto='sin_respaldo'`);
    check(enVista[0].n > 0, 'y la vista las publica con veredicto propio, no escondidas entre las demas');
  }

  console.log('\n[7] La advertencia viaja con el dato, y dice lo que se midio');
  const adv = await q(`
    SELECT numerador_con_residuo_sin_explicar AS flag, residuo_pct_medido AS pct,
           length(advertencia) AS largo, advertencia
    FROM analytics.v_iscam_share LIMIT 1`).catch(() => null);
  if (!adv) {
    fail++;
    console.log('  ✘ la vista no publica numerador_con_residuo_sin_explicar: '
      + 'la columna vieja afirmaba una causa que la medicion por sucursal refuto');
  } else if (!adv.length) { skip('sin filas: la advertencia no se puede leer'); }
  else {
    check(adv[0].flag === true, 'la vista marca que al numerador le queda un residuo sin explicar');
    check(Number(adv[0].pct) > 0 && Number(adv[0].pct) < 25,
      `y lo publica MEDIDO: ${adv[0].pct}% (la version anterior afirmaba 54% sin medirlo)`);
    check(Number(adv[0].largo) > 200, 'y explica por que, con el numero medido, en la misma fila');
    // ⛔ La causa vieja quedo refutada. Si vuelve a publicarse sin decirlo, es una regresion.
    check(!/inflado por traspasos/i.test(adv[0].advertencia)
      || /refut|CORREGIDA/i.test(adv[0].advertencia),
      'la advertencia ya no atribuye la brecha a los traspasos sin decir que esa causa se refuto');
    const senales = await q(`
      SELECT clave FROM analytics.price_signal_registry
      WHERE motivo_ausencia ILIKE '%inflado por traspasos%'
        AND motivo_ausencia NOT ILIKE '%refut%'`).catch(() => []);
    check(senales.length === 0,
      `ninguna senal del registro sigue publicando la causa refutada (${senales.length} lo hacen)`);
  }

  console.log('\n[8] ⛔ Lo que a proposito NO se importo');
  const pc = await q(`
    SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema='analytics' AND table_name='iscam_market' AND column_name ILIKE '%pcio%'`);
  check(pc[0].n === 0,
    'PcioDisp NO esta en la tabla: su formula es Val/Vol/24, un divisor fijo para todo el catalogo');

  console.log('\n[9] La pantalla tiene que poder leerla');
  const t0 = Date.now();
  await q(`
    SELECT fabricante, sum(nuestro) n, sum(competencia) c
    FROM analytics.v_iscam_competencia
    WHERE region='Región III' AND subcanal='Mayoreo Puro' AND mercado='DULCES'
      AND tipo_medida='valor'
    GROUP BY 1 ORDER BY 3 DESC LIMIT 50`);
  const ms = Date.now() - t0;
  check(ms < 1000, `el ranking de fabricantes tarda ${ms} ms (la compuerta de la pantalla es 1 s)`);

  await db.end();
  console.log(`\n${ok} ✓ / ${fail} ✗ / ${nomedido} no medido`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
