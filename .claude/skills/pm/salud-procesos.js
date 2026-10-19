#!/usr/bin/env node
// Salud de los procesos de ingesta — lo que el PM revisa para cerrar la tarjeta [OPS].
//   node .claude/skills/pm/salud-procesos.js
// SÓLO LECTURA contra pg-prod (verifica system_identifier). Usa PROD_DB_URL del .env.
// Cada proceso de la lista tiene un "esperado": se marca HECHO cuando prod ya lo cumple.
const path = require('path');
const raiz = path.resolve(__dirname, '..', '..', '..');
require(path.join(raiz, 'node_modules/dotenv')).config({ path: path.join(raiz, '.env'), quiet: true });
const { Client } = require(path.join(raiz, 'node_modules/pg'));

const PROD_ID = '7688376744939610156';
// esperado: 'sin_fila' = la fila del latido debe desaparecer · 'sano' = ok y con latido < umbral horas
const LISTA = [
  ['rd_commission_runner', 'sin_fila', 'retirado 2026-10-07'],
  ['fact_replenishment_plan', 'sin_fila', 'llave vieja (vive en _stock/_nightly)'],
  ['feed_route_stock', 'sin_fila', 'reemplazado por v_rd_route_photo'],
  ['prueba_no_usar', 'sin_fila', 'prueba manual'],
  ['ui_usage_flush', 'sano', 'chequeo: sin tráfico ≠ error', 2],
  ['ods_publish_tienda', 'sano', 'chequeo: hash de texto', 1],
  ['caos_ingreso_conciliar', 'sano', 'CAOS — dos cálculos del día', 2],
  ['feed_catalog', 'sano', 'semanal (sáb 02:00)', 180],
  ['cdc_reconcile_full', 'sano', 'freno DELETE >60 %', 26],
  ['kepler_sales_fact_full', 'sano', 'se queda en running', 26],
  ['caja_autollenado', 'decision', 'decide Edgar (apagado en manifiesto)'],
  ['caja_general_ship', 'decision', 'copia un Access muerto desde 10-oct'],
  ['caja_general_replica_all', 'decision', 'copia un Access muerto desde 10-oct'],
];

(async () => {
  if (!process.env.PROD_DB_URL) { console.error('NO MEDIDO: falta PROD_DB_URL en .env'); process.exit(2); }
  const c = new Client({ connectionString: process.env.PROD_DB_URL, statement_timeout: 20000 });
  await c.connect();
  try {
    await c.query('BEGIN READ ONLY');
    const id = (await c.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
    if (id !== PROD_ID) { console.error(`⛔ No es pg-prod (system_identifier ${id}). No mido.`); process.exit(3); }
    const r = await c.query(
      `SELECT job_key, status, round(extract(epoch FROM now()-coalesce(last_finish,last_start))/3600) AS horas,
              left(coalesce(error, note, ''), 70) AS detalle
         FROM analytics.cron_runs WHERE job_key = ANY($1)`, [LISTA.map((x) => x[0])]);
    const fila = Object.fromEntries(r.rows.map((x) => [x.job_key, x]));
    let hechos = 0;
    console.log(`Salud de procesos — ${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })} (pg-prod ✔)\n`);
    for (const [job, esperado, nota, umbral] of LISTA) {
      const f = fila[job];
      let estado;
      if (esperado === 'sin_fila') estado = f ? `PENDIENTE — la fila sigue (${f.status}, hace ${f.horas} h)` : 'HECHO — la fila ya no está';
      else if (esperado === 'sano') estado = !f ? 'NO MEDIDO — no hay fila de latido'
        : (f.status === 'ok' || f.status === 'success') && Number(f.horas) <= umbral ? `HECHO — ok hace ${f.horas} h`
        : `PENDIENTE — ${f.status} hace ${f.horas} h · ${f.detalle}`;
      else estado = f ? `DECISIÓN — ${f.status} hace ${f.horas} h` : 'DECISIÓN — sin fila';
      if (estado.startsWith('HECHO')) hechos++;
      console.log(`${job.padEnd(26)} ${estado}\n${' '.repeat(27)}(${nota})`);
    }
    const medibles = LISTA.filter((x) => x[1] !== 'decision').length;
    console.log(`\n${hechos}/${medibles} hechos · ${LISTA.length - medibles} esperan decisión de Edgar`);
    await c.query('ROLLBACK');
  } finally { await c.end(); }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
