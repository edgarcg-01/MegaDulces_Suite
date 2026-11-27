#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * `[RD.C0.2]` — **Llena el snapshot `analytics.rd_dia_cobertura`.**
 *
 * ── Por qué esto no vive dentro de la migración ─────────────────────────────────────────────
 *
 * Medido el 2026-11-27 contra prod: derivar la cobertura de **una** quincena cuesta **35.5 s**
 * en febrero y **1.1 s** en noviembre. La diferencia es la frontera de
 * `analytics.v_rd_route_daily_rapido`: lo reciente sale de la matvista `mv_rd_route_daily_200d`
 * (hoy, 11-may a 06-dic) y lo anterior de la vista **viva**. Un barrido del año entero son ~90 s.
 *
 * ⛔ Eso **no** puede ir dentro de una migración: sostendría el candado de migraciones todo ese
 * rato y frenaría a las demás sesiones (la regla nació de un `CREATE MATERIALIZED VIEW` que lo
 * sostuvo **22 minutos**). Por eso la migración sólo crea la estructura, y mientras el snapshot
 * esté vacío **la causa del contraste se comporta exactamente como antes**.
 *
 * ── Qué escribe ────────────────────────────────────────────────────────────────────────────
 *
 * Una fila por día hábil con venta de ruta: cuántas rutas reportaron, cuántos tickets, la
 * mediana de su vecindad (±9 días naturales) y los dos veredictos:
 *
 *   · `carga_truncada`    — pocas rutas Y las que hay traen **menos de 5 tickets** cada una.
 *                           La carga se cortó a la mitad. (2026: **sólo el 23 de febrero**.)
 *   · `operacion_parcial` — pocas rutas, pero las que salieron trabajaron **normal**.
 *                           Un feriado. (2026: 3 y 4 de abril, 16 de septiembre.)
 *
 * ⛔ Ninguno de los dos afirma que «la fuente perdió el día»: eso no se puede medir desde acá, y
 * el gate `cobertura_dias` ya dice con todas las letras que el motor no distingue un camión que
 * no salió de un día que la fuente perdió. Lo que **sí** se mide es la forma del día.
 *
 * ── Uso ────────────────────────────────────────────────────────────────────────────────────
 *
 *     node scripts/rd-backfill-dia-cobertura.js                      # SECO: no escribe nada
 *     node scripts/rd-backfill-dia-cobertura.js --escribir           # el año corriente
 *     node scripts/rd-backfill-dia-cobertura.js --escribir --desde 2026-11-01 --hasta 2026-11-18
 *
 * ⚠️ En seco por defecto, a propósito. Y conviene correr el barrido ANCHO fuera de horario
 * hábil: lee la vista viva de ventas (regla 9).
 */

const knex = require('knex');
const config = require('../database/knexfile.js');

const MEGA = '00000000-0000-0000-0000-00000000d01c';

const arg = (nombre, porDefecto) => {
  const i = process.argv.indexOf(nombre);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : porDefecto;
};
const ESCRIBE = process.argv.includes('--escribir');
const DESDE = arg('--desde', '2026-01-01');
const HASTA = arg('--hasta', new Date().toISOString().slice(0, 10));
const TENANT = arg('--tenant', MEGA);

/**
 * ⭐ El cálculo sale de `analytics.v_rd_dia_cobertura`, que es **la definición**, para que no
 * existan dos criterios para la misma pregunta. El script no reimplementa la regla.
 *
 * ⚠️ Se pide con un margen de ±9 días a cada lado del rango: la mediana local de los días del
 * borde necesita ver a sus vecinos. Después se recorta, para no escribir días de fuera.
 */
async function medir(db) {
  const { rows } = await db.raw(
    `SELECT * FROM analytics.v_rd_dia_cobertura
      WHERE tenant_id = ?
        AND business_date BETWEEN ?::date - 9 AND ?::date + 9
      ORDER BY business_date`,
    [TENANT, DESDE, HASTA],
  );
  return rows.filter((r) => {
    const d = r.business_date instanceof Date
      ? r.business_date.toISOString().slice(0, 10)
      : String(r.business_date).slice(0, 10);
    return d >= DESDE && d <= HASTA;
  });
}

(async () => {
  const env = process.env.NODE_ENV || 'production';
  const db = knex(config[env]);
  try {
    // ── El CONTROL va primero: una pregunta cuya respuesta ya conocemos por otro camino. ──────
    // Medido el 2026-11-27 en prod, por fuera de este script: el 23-feb-2026 tiene 2 rutas y 2
    // tickets; el 24-feb, 13 rutas. Si el instrumento no acierta esto, se tira el instrumento.
    const { rows: ctl } = await db.raw(
      `SELECT business_date::text AS dia, rutas, tickets, carga_truncada, operacion_parcial
         FROM analytics.v_rd_dia_cobertura
        WHERE tenant_id = ? AND business_date IN ('2026-02-23','2026-02-24')
        ORDER BY business_date`,
      [TENANT],
    );
    const f23 = ctl.find((r) => r.dia === '2026-02-23');
    const f24 = ctl.find((r) => r.dia === '2026-02-24');
    const ok = f23 && f24 && f23.rutas === 2 && f23.tickets === 2
      && f23.carga_truncada === true && f24.carga_truncada === false;
    console.log('CONTROL  23-feb = 2 rutas / 2 tickets / truncado · 24-feb sano  →', ok ? 'OK' : 'FALLÓ');
    if (!ok) {
      console.error('\n⛔ El control no acertó. Lo que devolvió la vista:');
      console.table(ctl);
      console.error('   Se tira el instrumento, no la medición. No se escribe nada.');
      process.exitCode = 1;
      return;
    }

    console.log(`\nMidiendo ${DESDE} … ${HASTA} (tenant ${TENANT})`);
    const t0 = Date.now();
    const filas = await medir(db);
    console.log(`  ${filas.length} días hábiles con venta, en ${((Date.now() - t0) / 1000).toFixed(1)} s`);

    const truncados = filas.filter((r) => r.carga_truncada);
    const parciales = filas.filter((r) => r.operacion_parcial);
    console.log(`\n  carga truncada ...... ${truncados.length}`);
    for (const r of truncados) {
      console.log(`      ${String(r.business_date).slice(0, 10)}  ${r.rutas} rutas · ${r.tickets} tickets · ${r.tickets_por_ruta} por ruta (mediana local ${r.med_local})`);
    }
    console.log(`  operación parcial ... ${parciales.length}`);
    for (const r of parciales) {
      console.log(`      ${String(r.business_date).slice(0, 10)}  ${r.rutas} rutas · ${r.tickets} tickets · ${r.tickets_por_ruta} por ruta (mediana local ${r.med_local})`);
    }

    if (!ESCRIBE) {
      console.log('\n🔎 SECO: no se escribió nada. Agregá --escribir para guardarlo.');
      return;
    }

    const ahora = db.fn.now();
    let escritas = 0;
    await db.transaction(async (trx) => {
      for (const r of filas) {
        await trx('analytics.rd_dia_cobertura')
          .insert({
            tenant_id: TENANT,
            business_date: r.business_date,
            rutas: r.rutas,
            tickets: r.tickets,
            med_local: r.med_local,
            tickets_por_ruta: r.tickets_por_ruta,
            carga_truncada: !!r.carga_truncada,
            operacion_parcial: !!r.operacion_parcial,
            observed_at: ahora,
            updated_at: ahora,
          })
          .onConflict(['tenant_id', 'business_date'])
          .merge(['rutas', 'tickets', 'med_local', 'tickets_por_ruta',
            'carga_truncada', 'operacion_parcial', 'observed_at', 'updated_at']);
        escritas += 1;
      }
    });
    console.log(`\n✓ ${escritas} días escritos en analytics.rd_dia_cobertura`);

    const { rows: despues } = await db.raw(
      `SELECT count(*)::int AS dias,
              count(*) FILTER (WHERE carga_truncada)::int    AS truncados,
              count(*) FILTER (WHERE operacion_parcial)::int AS parciales
         FROM analytics.rd_dia_cobertura WHERE tenant_id = ? AND deleted_at IS NULL`,
      [TENANT],
    );
    console.log('  en la tabla:', JSON.stringify(despues[0]));
  } catch (err) {
    console.error('FALLÓ:', err.message);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
})();
