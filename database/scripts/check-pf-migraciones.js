#!/usr/bin/env node
'use strict';
/**
 * `[PF.17]` — ¿Están vivas en esta base las dos piezas de la Fase PF que el tracker daba «sin aplicar en prod»?
 *
 *   node database/scripts/check-pf-migraciones.js                       (base local: el CONTROL)
 *   DATABASE_URL_NEW=<url-de-prod> node database/scripts/check-pf-migraciones.js
 *
 * SÓLO LEE. Ni una escritura (la conexión se abre en una transacción READ ONLY).
 *
 * Las dos piezas:
 *   · PF.6 — `analytics.product_flow_watch` (mig `20261009183328_product_flow_watch`): la foto de
 *     «Para cuidar hoy» que el worker escribe cada minuto.
 *   · PF.8 — `analytics.mv_product_margins_30d` (mig `20261012083236_mv_product_margins_30d`): las
 *     piezas de los tres márgenes de los 30 días cerrados, refrescada en el nocturno (06:20).
 *
 * Para cada una contesta CUATRO cosas, porque cada una puede fallar sola:
 *   1. ¿Existe el objeto? (`to_regclass`)
 *   2. ¿El ledger la registra? Hay DOS `knex_migrations` en prod (RUNBOOK §migraciones): se buscan en
 *      TODOS los esquemas, no sólo en `public`. Objeto sin ledger = aplicada a mano (declararlo).
 *   3. ¿Tiene datos y de cuándo? (foto: `calculado_at` más reciente y variantes; matvista:
 *      `relispopulated`, filas y `hasta` — debe ser AYER).
 *   4. ¿Late su trabajo? (`analytics.cron_runs`, `product_flow_watch` y
 *      `analytics_refresh_product_margins`). Sin latido, una foto parada se vería verde (OBS.1).
 *
 * ⛔ Lo que NO prueba que la foto exista en prod: que «No se venden» diga «los 300 de más dinero detenido, de N en
 * la red» (evidencia del 2026-10-29). Sin la tabla, `cuidar()` calcula EN VIVO y devuelve la misma forma
 * (`leerFoto` atrapa el error): la nota sale igual con o sin migración. Lo que sí la distingue es `origen.fuente`
 * de la respuesta (`foto` / `en_vivo`) o este script.
 *
 * Lo que no se puede medir se DECLARA (ADR-056): si una consulta truena, se dice NO MEDIDO, nunca ✅.
 * Sale 1 si algo está mal, 0 si todo está bien, 2 si hubo algo NO MEDIDO.
 *
 * CONTROL (la respuesta ya conocida), corrido el 2026-11-03 contra la base LOCAL: los dos objetos EXISTEN
 * (to_regclass, comprobado aparte), la foto tiene 2 variantes y late, la matvista llega a ayer — y
 * NINGUNO de los dos ledgers locales (public: 663, identity: 53) los nombra, porque la base local se
 * armó con el arranque de desarrollo. O sea: «objeto sin ledger» es un caso REAL, no un error del script.
 * PRUEBA NEGATIVA: PF17_NEGATIVO=1 cambia los objetos por uno que no existe y el script DEBE salir 1
 * con «el objeto NO existe» (verificado el 2026-11-03).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);

const PIEZAS_REALES = [
  { item: 'PF.6', objeto: 'analytics.product_flow_watch', mig: '20261009183328_product_flow_watch', latido: 'product_flow_watch' },
  { item: 'PF.8', objeto: 'analytics.mv_product_margins_30d', mig: '20261012083236_mv_product_margins_30d', latido: 'analytics_refresh_product_margins' },
];
// Prueba negativa: el mismo recorrido contra un objeto que no existe tiene que ponerse rojo.
const PIEZAS = process.env.PF17_NEGATIVO
  ? PIEZAS_REALES.map((p) => ({ ...p, objeto: 'analytics.no_existe_pf17', mig: '00000000000000_no_existe' }))
  : PIEZAS_REALES;

let fail = 0;
let nomedido = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };
const nm = (m) => { console.log(`  ⚪ NO MEDIDO — ${m}`); nomedido++; };

async function leer(trx, sql, binds = []) {
  // SAVEPOINT por lectura: un error aborta la transacción y, sin él, todo lo que sigue saldría «NO MEDIDO».
  await trx.raw('SAVEPOINT lectura');
  try {
    const rows = (await trx.raw(sql, binds)).rows;
    await trx.raw('RELEASE SAVEPOINT lectura');
    return rows;
  } catch (e) {
    await trx.raw('ROLLBACK TO SAVEPOINT lectura');
    return { error: String(e.message).split('\n')[0].slice(0, 160) };
  }
}

(async () => {
  const trx = await knex.transaction();
  try {
    await trx.raw('SET TRANSACTION READ ONLY');
    const [id] = await leer(trx, 'select system_identifier::text si from pg_control_system()');
    const [db] = await leer(trx, 'select current_database() db, now()::text ahora');
    console.log(`\n[PF.17] Piezas de la Fase PF en la base «${db.db}» (system_identifier ${id ? id.si : 'NO MEDIDO'}) · ${db.ahora}\n`);
    console.log('   ⚠️  El nombre de la base NO identifica prod (la de prod y la vieja se llaman igual): mira el system_identifier.\n');

    const ledgers = await leer(trx, `
      select n.nspname esquema from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relname = 'knex_migrations' and c.relkind = 'r' order by 1`);
    if (ledgers.error) { nm(`no se pudieron listar los ledgers: ${ledgers.error}`); }
    else console.log(`   ledgers de migraciones: ${ledgers.map((l) => `${l.esquema}.knex_migrations`).join(', ') || 'ninguno'}\n`);

    for (const p of PIEZAS) {
      console.log(`${p.item} — ${p.objeto}`);
      const [reg] = await leer(trx, 'select to_regclass(?)::text r', [p.objeto]);
      const existe = !!(reg && reg.r);
      ok(existe, existe ? 'el objeto existe' : 'el objeto NO existe');

      // ¿Qué ledger la registra?
      const en = [];
      for (const l of Array.isArray(ledgers) ? ledgers : []) {
        const r = await leer(trx, `select name, migration_time::text t from "${l.esquema}".knex_migrations where name like ?`, [`${p.mig}%`]);
        if (r.error) nm(`ledger ${l.esquema}: ${r.error}`);
        else if (r.length) en.push(`${l.esquema} (${r[0].t})`);
      }
      if (en.length) console.log(`  ✅ el ledger la registra: ${en.join(' · ')}`);
      else if (existe) console.log('  ⚠️  el objeto existe pero NINGÚN ledger la nombra: se aplicó a mano o desde otro árbol — declararlo');
      else ok(false, 'ningún ledger la registra');

      if (!existe) { console.log(''); continue; }

      if (p.item === 'PF.6') {
        const r = await leer(trx, `select count(*)::int filas, max(calculado_at)::text ultima,
                                          round(extract(epoch from now() - max(calculado_at)) / 60, 1)::text min_atras
                                     from analytics.product_flow_watch`);
        if (r.error) nm(`foto: ${r.error}`);
        else {
          const f = r[0];
          console.log(`     foto: ${f.filas} variantes · última ${f.ultima || '—'} · hace ${f.min_atras ?? '—'} min`);
          ok(f.filas >= 2, 'al menos 2 variantes (con y sin permiso de costo)');
          ok(f.min_atras !== null && Number(f.min_atras) <= 3, 'la foto tiene 3 min o menos (si no, la API calcula en vivo y lo declara)');
        }
      } else {
        const r = await leer(trx, `select c.relispopulated poblada from pg_class c where c.oid = to_regclass(?)`, [p.objeto]);
        if (r.error) nm(`matvista: ${r.error}`);
        else if (!r[0].poblada) ok(false, 'la matvista existe pero NO está poblada (el nocturno no ha corrido): el panel calcula en vivo y lo declara');
        else {
          const m = await leer(trx, `select count(*)::int filas, count(distinct sku)::int productos, max(hasta)::text hasta,
                                            ((now() at time zone 'America/Mexico_City')::date - 1)::text ayer
                                       from analytics.mv_product_margins_30d`);
          if (m.error) nm(`matvista: ${m.error}`);
          else {
            const x = m[0];
            console.log(`     matvista: ${x.filas} filas · ${x.productos} productos · llega hasta ${x.hasta} (ayer: ${x.ayer})`);
            ok(x.filas > 0, 'tiene filas');
            ok(x.hasta === x.ayer, 'llega hasta AYER (antes de las 06:20 puede llegar a anteayer: el panel calcula en vivo y lo dice)');
          }
        }
      }

      const lat = await leer(trx, `select status, last_finish::text fin, rows_affected, left(coalesce(error, ''), 120) error
                                     from analytics.cron_runs where job_key = ? order by last_finish desc nulls last limit 1`, [p.latido]);
      if (lat.error) nm(`latido ${p.latido}: ${lat.error}`);
      else if (!lat.length) nm(`latido ${p.latido}: sin renglón en analytics.cron_runs (el worker nunca lo corrió en esta base)`);
      else console.log(`     latido ${p.latido}: ${lat[0].status} · ${lat[0].fin} · ${lat[0].rows_affected ?? '—'} filas${lat[0].error ? ` · ${lat[0].error}` : ''}`);
      console.log('');
    }
  } finally {
    await trx.rollback().catch(() => undefined);
    await knex.destroy();
  }
  console.log(fail ? `❌ ${fail} hallazgo(s)` : nomedido ? `⚪ ${nomedido} cosa(s) NO MEDIDA(s)` : '✅ las dos piezas vivas');
  process.exit(fail ? 1 : nomedido ? 2 : 0);
})().catch((e) => { console.error('❌ el script no pudo correr:', e.message); process.exit(1); });
