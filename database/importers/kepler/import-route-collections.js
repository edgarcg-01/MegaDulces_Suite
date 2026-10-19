/* eslint-disable no-console */
/**
 * `[RC.4]` — Los cobros PUE `UA0501` de las camionetas: runner → prod.
 *
 * Último tramo de la cadena que arranca en el Kepler local de cada camioneta:
 *
 *     camioneta (md.kdm1 ⋈ md.kdm5)  →  mart.cobros_ruta (runner, md:5433)  →  ESTE  →
 *     analytics.route_collections (prod)  →  la cola de Caja General, por la vista `[RC.3]`
 *
 * Existe porque el cobro que salda el corte de caja POS **no viaja**: se captura en la laptop de
 * la camioneta y no sincroniza a la plaza. Medido en prod el 2026-10-12, almacén `01-005`: el ODS
 * tiene 1 cobro y la camioneta 7. Por eso la Fase CSU publicaba **1.5% cobrado** sobre $4.53M de
 * cortes.
 *
 * ⚠️ **UPSERT por la llave natural `(tenant_id, truck, cobro_folio, folio_corte)`**, no borrar y
 * reinsertar: la aplicación es N:M (un cobro se parte entre cortes y un corte recibe varios
 * cobros), así que una corrida repetida reescribe los mismos valores en vez de duplicar dinero.
 *
 * ⚠️ NO filtra por cuenta: entran los de caja (`0011`) y los de banco (`2169`). Quién se ofrece
 * para arquear lo decide la VISTA, que sólo toma `0011`. Filtrar acá sería perder el dato sin
 * poder revisarlo.
 *
 *   SRC_URL = runner consolidado (default: md:5433/kepler_consolidado)
 *   DST_URL / DATABASE_URL_NEW = prod
 *   node database/importers/kepler/import-route-collections.js --apply
 */
const { Client } = require('pg');
const hb = require('../lib/cron-heartbeat');

const JOB = 'route_collections';
const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const SRC = process.env.SRC_URL || process.env.DATABASE_URL_KEPLER_CONSOLIDADO
  || 'postgresql://postgres:superoot@192.168.0.222:5433/kepler_consolidado';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;
const APPLY = process.argv.includes('--apply');

(async () => {
  if (!DST) throw new Error('falta la URL de prod: DST_URL / DATABASE_URL_NEW');
  console.log(`\n=== cobros de ruta: runner → prod (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

  // El latido abre ANTES de conectar: si la fuente no responde, el carril tiene que quedar en
  // `error`, no invisible. `begin`/`end` nunca lanzan (contrato del helper).
  if (APPLY) await hb.begin(JOB, 'Cobros de ruta: runner → prod (RC.4)');
  let estado = 'error';
  let nota = null;
  let fallo = 'la corrida no llegó a reportar: falló antes de medir la entrega';
  let filas = null;

  const src = new Client({ connectionString: SRC, connectionTimeoutMillis: 8000, statement_timeout: 60000 });
  const dst = new Client({ connectionString: DST, connectionTimeoutMillis: 8000 });
  await src.connect();
  await dst.connect();
  try {
    await dst.query(`SET app.tenant_id = '${TENANT}'`);

    const { rows } = await src.query(`
      SELECT truck, almacen, cobro_folio, fecha, cuenta, doc_tipo, folio_corte, importe, referencia
        FROM mart.cobros_ruta ORDER BY fecha, truck, cobro_folio, folio_corte`);
    console.log(`runner: ${rows.length} aplicaciones (cobro × corte)`);
    if (!rows.length) {
      // ⚠️ `error`, no `ok`: este carril mide ENTREGA. El runner sin filas significa que el
      // tramo de arriba (camioneta→runner) no trajo nada, que es precisamente el fallo que
      // dejó 36 cortes fuera de todo libro. Un `ok` acá lo volvería invisible otra vez.
      console.log('nada que traer.');
      estado = 'error'; filas = 0; nota = 'el runner no tiene cobros';
      fallo = 'el runner (mart.cobros_ruta) vino vacío: el tramo camioneta→runner no entregó';
      return;
    }

    const porTruck = new Map();
    for (const r of rows) porTruck.set(r.truck, (porTruck.get(r.truck) || 0) + 1);
    for (const [t, n] of porTruck) console.log(`   ${t}: ${n}`);

    if (!APPLY) { console.log('\nDRY-RUN: no se escribió nada. Agregá --apply.'); return; }

    let n = 0;
    for (const r of rows) {
      await dst.query(`
        INSERT INTO analytics.route_collections
          (tenant_id, truck, almacen, cobro_folio, fecha, cuenta, doc_tipo, folio_corte, importe, referencia)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (tenant_id, truck, cobro_folio, folio_corte) DO UPDATE
          SET almacen = EXCLUDED.almacen, fecha = EXCLUDED.fecha, cuenta = EXCLUDED.cuenta,
              doc_tipo = EXCLUDED.doc_tipo, importe = EXCLUDED.importe,
              referencia = EXCLUDED.referencia, updated_at = now()`,
        [TENANT, r.truck, r.almacen, r.cobro_folio, r.fecha, r.cuenta, r.doc_tipo, r.folio_corte, r.importe, r.referencia]);
      n++;
    }
    console.log(`\n✔ ${n} aplicaciones en analytics.route_collections`);

    const [{ cobros, importe }] = (await dst.query(`
      SELECT count(DISTINCT truck || '|' || cobro_folio)::int AS cobros, sum(importe)::numeric AS importe
        FROM analytics.route_collections WHERE tenant_id = $1 AND cuenta = '0011'`, [TENANT])).rows;
    const [{ en_cola }] = (await dst.query(`
      SELECT count(*)::int AS en_cola FROM finance.v_caja_movimientos_pendientes
       WHERE tenant_id = $1 AND sucursal LIKE '%-%'`, [TENANT])).rows;
    console.log(`   a caja (0011): ${cobros} cobros · $${Number(importe || 0).toFixed(2)}`);
    console.log(`   visibles en la cola de Caja General: ${en_cola}`);

    /**
     * Latido: este carril mide ENTREGA, no "el script corrió". Sin umbral, db-health da verde
     * incondicional (ADR-053); sin latido, un carril mudo se cae sin que nadie lo note.
     *
     * ⛔⛔ `[CGA-A.2]` **ESTE LATIDO NUNCA PUDO ESCRIBIRSE, y por eso el carril vivió muerto
     * cuatro días sin que nadie lo viera.** Medido contra prod el 2026-10-16: el `INSERT` que
     * estaba acá nombraba `finished_at` y `detail`, y `analytics.cron_runs` tiene `last_finish`
     * y `note`. El error caía en un `.catch()` que lo imprimía por consola y seguía — o sea que
     * el carril podía fallar en silencio **y además** su propio reporte de fallo era mudo.
     *
     * ⚠️ Y eran DOS defectos, no uno: la PK es `(tenant_id, job_key)`, así que un `INSERT`
     * plano habría dado `23505` en la segunda corrida aunque las columnas hubieran estado bien.
     *
     * ⭐ Se reemplaza por el helper COMPARTIDO `lib/cron-heartbeat`, que ya resuelve el upsert,
     * la duración, el host y la autocuración de una corrida que quedó en `running`. Escribir un
     * cuarto upsert a mano es justo lo que ADR-056 prohíbe.
     */
    estado = en_cola > 0 ? 'ok' : 'error';
    nota = `${cobros} cobros · $${Number(importe || 0).toFixed(2)} · ${en_cola} en cola`;
    filas = n;
    // ⚠️ `error` se limpia SÓLO en el camino bueno. Si queda el texto por defecto, una corrida
    // `ok` arrastraría el mensaje de fallo de la anterior y el tablero diría dos cosas a la vez.
    fallo = estado === 'ok' ? null : `entregó ${n} filas pero la cola de Caja General quedó en 0`;
  } finally {
    await src.end().catch(() => {});
    await dst.end().catch(() => {});
    // Fuera del `try` de las conexiones: el cierre del latido no depende de ellas y es
    // justamente lo que se pierde cuando la red parpadea al terminar.
    if (APPLY) await hb.end(JOB, { status: estado, rows: filas, note: nota, error: fallo });
  }
})().catch((e) => { console.error('FALLA: ' + e.message); process.exit(1); });
