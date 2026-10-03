#!/usr/bin/env node
/**
 * **¿Qué vales de gasto de Kepler tienen su comprobación con CFDI?**
 *
 * Pregunta del usuario (2026-10-02). La respuesta corta, medida sobre el esquema:
 * **Kepler NO guarda el CFDI.** El vale (`X-A-15-1`, la solicitud de gasto) lleva el **RFC**
 * del acreedor y el **IVA**, pero no hay UUID en ninguna parte de su cadena. El CFDI vive en
 * `fiscal.cfdis`, que se llena del **ADD de ContPAQi** (Fase LC.1), no de Kepler.
 *
 * Así que «el vale con su CFDI» no se consulta: **se deriva**. Este script lo deriva y, sobre
 * todo, dice **cuánto vale la derivación**.
 *
 * ## Lo que se cruza, y de dónde sale cada campo (verificado en la definición de la vista)
 *   · `analytics.expense_requests` (vista sobre `kepler_ods.kdm1`, filtro `X-A-15-1`)
 *       `rfc`  ← `kdm1.c22`   · `importe` · `iva` · `fecha` · `beneficiario` · `folio`
 *   · `fiscal.cfdis` (del ADD de ContPAQi)
 *       `uuid` · `emisor_rfc` · `total` · `fecha` · `rol` · `estatus_sat`
 *
 * El puente es **RFC + importe + ventana de fecha**. No hay otro: no existe una llave común.
 *
 * ## ⭐ Por qué este script mide un PLACEBO y no sólo el porcentaje de match
 * Un cruce por importe **siempre** encuentra algo: con suficientes CFDIs, cualquier monto
 * tiene pareja. Un «82 % de coincidencia» no significa nada si el azar ya da 60 %. Por eso se
 * corre el MISMO cruce contra una ventana de fechas **desplazada un año**, donde por
 * construcción no puede haber relación real. **La señal es la diferencia**, no el número.
 *
 * ## ⛔ Lo que este script NO puede hacer
 * Decidir que un vale y un CFDI son el mismo hecho. Un match por RFC+monto es una
 * **candidatura**, no una prueba — y con un proveedor recurrente de importes redondos puede
 * haber varias. Por eso reporta la ambigüedad (`candidatos_por_vale`) en vez de quedarse con
 * el primero y aparentar certeza.
 *
 * Uso (donde VIVAN los datos — ver la nota del final):
 *   DATABASE_URL_NEW=<url> node database/scripts/buscar-vales-con-cfdi.js
 *   ... --dias=5        tolerancia de fecha (default 5)
 *   ... --tol=0.50      tolerancia de importe en pesos (default 0.50)
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);

const arg = (k, def) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split('=')[1] : def;
};
const DIAS = Number(arg('dias', 5));
const TOL = Number(arg('tol', 0.5));
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)} %` : 'sin base');

(async () => {
  console.log('\n¿Qué vales de gasto tienen su CFDI?  (ventana ±' + DIAS + ' días · tolerancia $' + TOL + ')\n');

  // ── 0) ¿Hay con qué medir? Un 0 acá no es «ningún vale tiene CFDI»: es que no hay datos. ──
  const hay = async (rel) => {
    const r = await knex.raw(`select to_regclass(?) x`, [rel]);
    if (!r.rows[0].x) return null;
    const c = await knex.raw(`select count(*)::int n from ${rel}`);
    return c.rows[0].n;
  };
  const nVales = await hay('analytics.expense_requests');
  const nCfdis = await hay('fiscal.cfdis');
  console.log(`   vales de gasto (X-A-15-1) ... ${nVales === null ? 'la vista NO existe' : nVales}`);
  console.log(`   CFDIs (ADD de ContPAQi) ..... ${nCfdis === null ? 'la tabla NO existe' : nCfdis}`);

  if (!nVales || !nCfdis) {
    console.log('\n⛔ NO MEDIDO — falta una de las dos fuentes en esta base.');
    console.log('   Esto NO dice que ningún vale tenga CFDI: dice que acá no se puede preguntar.');
    console.log('   Los datos reales viven en prod (servidor `md`, 192.168.0.222).\n');
    await knex.destroy();
    process.exit(0);
  }

  // ── 1) La precondición: ¿cuántos vales traen siquiera el RFC con el que cruzar? ──────────
  const pre = (await knex.raw(`
    select count(*)::int total,
           count(rfc)::int con_rfc,
           count(*) filter (where coalesce(iva,0) > 0)::int con_iva,
           count(*) filter (where coalesce(importe,0) > 0)::int con_importe
      from analytics.expense_requests where tenant_id = ?`, [T])).rows[0];
  console.log(`\n1) con qué se puede cruzar`);
  console.log(`   vales ................ ${pre.total}`);
  console.log(`   con RFC (kdm1.c22) ... ${pre.con_rfc}  (${pct(pre.con_rfc, pre.total)})`);
  console.log(`   con IVA > 0 .......... ${pre.con_iva}  (${pct(pre.con_iva, pre.total)})`);
  if (pre.con_rfc === 0) {
    console.log('\n   ⛔ Sin RFC no hay puente posible: el cruce por monto solo seria ruido.');
  }

  /**
   * El cruce. `offsetDias` desplaza la ventana: 0 = el real, 365 = el PLACEBO (un año antes,
   * donde no puede haber relacion). La consulta es LA MISMA para que la comparacion valga.
   */
  const cruzar = async (offsetDias) => (await knex.raw(`
    with v as (
      select folio, sucursal, fecha, importe, rfc, beneficiario
        from analytics.expense_requests
       where tenant_id = ? and rfc is not null and coalesce(importe,0) > 0
    )
    select count(*)::int vales,
           count(*) filter (where c.n > 0)::int con_cfdi,
           count(*) filter (where c.n > 1)::int ambiguos,
           coalesce(sum(v.importe) filter (where c.n > 0), 0)::numeric monto_con_cfdi
      from v
      cross join lateral (
        select count(*)::int n
          from fiscal.cfdis f
         where f.tenant_id = ?
           and f.emisor_rfc = v.rfc
           and abs(f.total - v.importe) <= ?
           and f.fecha between (v.fecha - ?::int * interval '1 day' - ?::int * interval '1 day')
                           and (v.fecha + ?::int * interval '1 day' - ?::int * interval '1 day')
      ) c`,
    [T, T, TOL, DIAS, offsetDias, DIAS, offsetDias])).rows[0];

  console.log(`\n2) el cruce RFC + importe + fecha`);
  const real = await cruzar(0);
  console.log(`   vales con al menos un CFDI candidato ... ${real.con_cfdi} de ${real.vales}  (${pct(real.con_cfdi, real.vales)})`);
  console.log(`   de ellos, AMBIGUOS (mas de un CFDI) .... ${real.ambiguos}  (${pct(real.ambiguos, real.con_cfdi)})`);
  console.log(`   monto con candidato ................... $${Number(real.monto_con_cfdi).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`);

  // ── 3) ⭐ El placebo: la misma consulta donde NO puede haber relacion ────────────────────
  console.log(`\n3) ⭐ el placebo (misma consulta, ventana corrida un ano atras)`);
  const placebo = await cruzar(365);
  console.log(`   match por azar ........................ ${placebo.con_cfdi} de ${placebo.vales}  (${pct(placebo.con_cfdi, placebo.vales)})`);
  const señal = real.vales > 0
    ? ((real.con_cfdi - placebo.con_cfdi) / real.vales) * 100
    : 0;
  console.log(`   SENAL (real - placebo) ................ ${señal.toFixed(1)} puntos`);
  if (placebo.con_cfdi > 0 && real.con_cfdi > 0 && placebo.con_cfdi / real.con_cfdi > 0.5) {
    console.log('   ⛔ El piso de ruido es mas de la mitad del match: este cruce NO distingue.');
    console.log('      Publicar el porcentaje de arriba como «vales con CFDI» seria inventar.');
  }

  // ── 4) La muestra, para poder mirarla a ojo ─────────────────────────────────────────────
  const muestra = (await knex.raw(`
    select v.folio, v.sucursal, to_char(v.fecha,'YYYY-MM-DD') fecha, v.importe, v.rfc,
           v.beneficiario, f.uuid, f.serie, f.folio cfdi_folio, f.total, f.estatus_sat
      from analytics.expense_requests v
      join fiscal.cfdis f
        on f.tenant_id = v.tenant_id and f.emisor_rfc = v.rfc
       and abs(f.total - v.importe) <= ?
       and f.fecha between v.fecha - ?::int * interval '1 day' and v.fecha + ?::int * interval '1 day'
     where v.tenant_id = ? and v.rfc is not null
     order by v.fecha desc limit 10`, [TOL, DIAS, DIAS, T])).rows;

  console.log(`\n4) muestra (10 mas recientes)`);
  if (!muestra.length) console.log('   sin coincidencias que mostrar');
  else console.table(muestra.map((r) => ({
    folio: r.folio, suc: r.sucursal, fecha: r.fecha,
    importe: Number(r.importe), rfc: r.rfc,
    uuid: String(r.uuid || '').slice(0, 13) + '…',
    cfdi: `${r.serie || ''}${r.cfdi_folio || ''}`,
    total: Number(r.total), sat: r.estatus_sat,
  })));

  console.log(`\n⚠️  Lo que esto ES: una lista de CANDIDATOS por RFC + monto + fecha.`);
  console.log(`    Lo que NO es: una liga. Kepler no guarda el UUID, asi que ningun vale`);
  console.log(`    «tiene» su CFDI en el sentido de apuntarlo — se parea, y el pareo se juzga`);
  console.log(`    con la senal contra el placebo de arriba.\n`);

  await knex.destroy();
})().catch(async (e) => { console.error('ERR', e.message); await knex.destroy(); process.exit(1); });
