/* eslint-disable no-console */
/**
 * `[PR.M4]` — Candado de la competencia censada por DENUE.
 *
 * ⛔ Lo que más puede romperse acá no es el dato: es la **separación**. `ProspectsService.dedup()`
 * purga del tablero todo lo que caiga fuera de la geocerca de 100 km y corre en un cron nocturno.
 * Sin el filtro por `rol`, la primera pasada se lleva a los competidores de Guadalajara y León —
 * justo los más grandes — y nadie se entera, porque un tablero vacío se lee igual que "no hay
 * competencia". Por eso la aserción central es que los tres roles **no se mezclan**.
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
  const col = await q(`SELECT a.attname FROM pg_attribute a
    JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='commercial' AND c.relname='prospect_stores'
      AND a.attname IN ('rol','propios_1km','propios_5km','proximidad_medida_at')`);
  check(col.length === 4, 'prospect_stores tiene rol y las tres columnas de proximidad');
  const chk = await q(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint
    WHERE conname='prospect_stores_rol_chk'`);
  check(chk.length === 1 && /prospecto/.test(chk[0].d) && /competidor/.test(chk[0].d) && /propio/.test(chk[0].d),
    'el CHECK encierra los tres roles: prospecto, competidor y propio');
  const vis = await q(`SELECT c.reloptions::text o FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='commercial' AND c.relname='v_competidores'`);
  check(vis.length === 1 && /security_invoker=(true|on)/.test(vis[0].o || ''),
    'v_competidores existe y tiene security_invoker');

  console.log('\n[2] ⛔ Los tres roles NO se mezclan');
  const rol = await q(`SELECT rol, count(*)::int n FROM commercial.prospect_stores
    GROUP BY 1 ORDER BY 2 DESC`);
  if (!rol.length) { skip('prospect_stores vacia'); }
  else {
    rol.forEach((r) => console.log(`     ${String(r.rol).padEnd(11)} ${r.n}`));
    const m = Object.fromEntries(rol.map((r) => [r.rol, r.n]));
    check((m.competidor || 0) > 100, `hay ${m.competidor || 0} competidores censados`);
    check((m.prospecto || 0) > 100, `y ${m.prospecto || 0} prospectos, que son otra cosa`);
    check((m.propio || 0) > 0,
      `${m.propio || 0} unidades son NUESTRAS: DENUE nos ve, y si no se marcan cuentan como competencia`);
    const enVista = await q('SELECT count(*)::int n FROM commercial.v_competidores');
    check(enVista[0].n === (m.competidor || 0),
      'la vista publica exactamente los competidores, ni uno de otro rol');
  }

  console.log('\n[3] ⭐ La cercanía se midió, y se sabe contra qué');
  const prox = await q(`SELECT
      count(*)::int n,
      count(*) FILTER (WHERE proximidad_medida_at IS NOT NULL)::int medidos,
      count(*) FILTER (WHERE propios_5km > 0)::int con_clientes,
      max(propios_5km) max5
    FROM commercial.v_competidores`);
  if (!prox[0].n) { skip('sin competidores cargados'); }
  else {
    const p = prox[0];
    console.log(`     ${p.medidos} de ${p.n} medidos · ${p.con_clientes} tienen clientes nuestros a 5 km`
      + ` · el que más, ${p.max5}`);
    check(p.medidos === p.n, 'todos los competidores tienen la proximidad medida');
    check(p.con_clientes > 0, 'hay competidores parados junto a nuestros clientes');
    // ⛔ NULL cuando no se puede medir, nunca 0: un cero se lee como "no tiene a nadie cerca".
    const nulos = await q(`SELECT count(*)::int n FROM commercial.v_competidores
      WHERE proximidad_medida_at IS NULL AND propios_5km IS NOT NULL`);
    check(nulos[0].n === 0, 'ninguno publica un conteo de cercanía sin haberlo medido');
  }

  console.log('\n[4] ⛔ Lo que DENUE no dice, y no se inventa');
  const cols = await q(`SELECT count(*)::int n FROM information_schema.columns
    WHERE table_schema='commercial' AND table_name='prospect_stores'
      AND (column_name ILIKE '%venta%' OR column_name ILIKE '%revenue%'
        OR column_name ILIKE '%precio%' OR column_name ILIKE '%share%')`);
  check(cols[0].n === 0,
    'no hay columna de venta ni de precio del competidor: DENUE es un censo, eso no esta ahi');

  console.log('\n[5] ⚠️ Lo que quedó DECLARADO, no resuelto');
  const sucios = await q(`SELECT scian, count(*)::int n, max(whitespace_score) peor
    FROM commercial.prospect_stores WHERE rol='prospecto' AND scian LIKE '4311%'
    GROUP BY 1 ORDER BY 2 DESC`);
  if (!sucios.length) {
    console.log('     ningun prospecto lleva SCIAN de mayoreo');
    ok++;
  } else {
    const t = sucios.reduce((a, r) => a + r.n, 0);
    const peor = Math.max(...sucios.map((r) => Number(r.peor) || 0));
    console.log(`     ${t} prospectos llevan SCIAN de MAYOREO (4311xx), el mejor puntuado con `
      + `${peor} de 100 — entre ellos una dulcería al por mayor y tiendas de cadena.`);
    console.log('     No se reclasifican solos: si un abarrotero mayorista es cliente o rival es');
    console.log('     criterio comercial, no de este candado. Queda MEDIDO para que no se pierda.');
    // ⚠️ Es una medida, no una falla: se vigila que no CREZCA sin que nadie lo note.
    check(t <= 20, `son ${t}, dentro de la banda medida el 2026-10-01 (eran 11); si crece, alguien amplió la cosecha`);
  }

  console.log('\n[6] La pantalla tiene que poder leerla');
  const t0 = Date.now();
  await q(`SELECT * FROM commercial.v_competidores
    ORDER BY propios_5km DESC NULLS LAST, tamano_orden DESC NULLS LAST LIMIT 200`);
  const ms = Date.now() - t0;
  check(ms < 1000, `los 200 competidores mas relevantes en ${ms} ms (la compuerta es 1 s)`);

  await db.end();
  console.log(`\n${ok} ✓ / ${fail} ✗ / ${nomedido} no medido`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
