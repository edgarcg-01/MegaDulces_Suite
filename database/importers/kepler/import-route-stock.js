/* eslint-disable no-console */
/**
 * `[RD.32]` — **La foto de existencia del camión: runner → pantalla.**
 *
 * Lee `mart.existencias_ruta` del runner consolidado (lo que cada camioneta empuja con su propio
 * Kepler) y la aterriza en `commercial.route_counts` + `route_count_lines` con `source='kepler'`.
 * De ahí la toma `analytics.v_rd_route_ledger` como **ancla** del saldo.
 *
 *   node database/importers/kepler/import-route-stock.js            (DRY-RUN)
 *   node database/importers/kepler/import-route-stock.js --apply
 *   node database/importers/kepler/import-route-stock.js --apply --days 7
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 *
 * Kepler central no publica saldo de ruta y no hay documento de retorno, así que el inventario
 * del camión se venía RECONSTRUYENDO de embarque menos venta. Medido en la ruta 21 el 2026-10-05:
 * la pantalla publicaba **$18,427** y el camión traía **$37,766** — el 89 % de la diferencia es
 * mercancía que ya traía antes de que pudiéramos ver sus ventas. El camión sí lo sabe; esto lo
 * trae por el canal que ya corre cada 15 minutos.
 *
 * ── Lo que NO hace, y es deliberado ─────────────────────────────────────────────────────────
 *
 * ⛔ **No le quita los ceros de la izquierda al SKU.** Parece al revés: el archivo que destapó
 * esta fase traía `8057` donde el ledger dice `08057`. Medido: las tres fuentes de Kepler los
 * CONSERVAN (`kdik.c2` 480 de 4,514 · `kdii.c1` 1,072 de 9,642 · `kdm2.c8` 6,811 de 65,789).
 * Quien los perdió fue **Excel**, que leyó `08057` como número. Pelarlos acá colapsaría dos SKU
 * distintos — y además el push viaja DB→DB en texto, así que el problema no llega.
 *
 * ⭐ Pero no se asume: cada corrida **mide** cuántos SKU de la foto existen en el vocabulario del
 * ledger de esa ruta y lo **declara**. Una foto que no empalma es peor que no tener foto, porque
 * el ancla mandaría a cero lo que sí está arriba.
 *
 * ⚠️ **Una foto REEMPLAZA.** Los renglones del día se borran y se vuelven a escribir: un producto
 * que el camión ya no trae tiene que desaparecer.
 */
'use strict';
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const M = '00000000-0000-0000-0000-00000000d01c';
const SRC = process.env.SRC_URL || process.env.DATABASE_URL_KEPLER_CONSOLIDADO
  || 'postgresql://postgres:superoot@192.168.0.222:5433/kepler_consolidado';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || (() => {
  throw new Error('falta la URL destino: exporta DATABASE_URL_NEW');
})();
const APPLY = process.argv.includes('--apply');
const di = process.argv.indexOf('--days');
const DAYS = di !== -1 ? Number(process.argv[di + 1]) : 3;
const JOB = 'feed_route_stock';

const money = (v) => '$' + Math.round(Number(v || 0)).toLocaleString('en-US');

(async () => {
  const t0 = Date.now();
  const dst = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await dst.connect();
  const src = new Client({ connectionString: SRC, connectionTimeoutMillis: 8000, statement_timeout: 180000 });
  let estado = 'ok'; let error = null; let filas = 0;
  try {
    console.log(`\n=== [RD.32] existencia de ruta: runner → route_counts (${APPLY ? 'APPLY' : 'DRY-RUN'}, ${DAYS} día(s)) ===\n`);
    try { await src.connect(); } catch (e) {
      // ⛔ Sin runner NO se escribe nada: un cero dibujado aca mandaria a cero el inventario de
      // las once rutas. Que falle la medicion no puede volverse un dato (ADR-056).
      console.error(`❌ sin conexión al runner (${e.message}) — abortando sin tocar nada`);
      estado = 'error'; error = e.message; process.exitCode = 1; return;
    }

    const fotos = (await src.query(
      `SELECT truck, fecha::text AS fecha, count(*)::int AS renglones,
              round(sum(importe),2)::float AS importe
         FROM mart.existencias_ruta
        WHERE fecha >= current_date - $1::int
        GROUP BY 1,2 ORDER BY 1,2`, [DAYS])).rows;
    if (!fotos.length) {
      console.log('  el runner no tiene ninguna foto en la ventana — nada que traer.');
      console.log('  (si ninguna camioneta la manda todavía: ver RUNBOOK_EXISTENCIA_CAMIONETA.md)');
      return;
    }

    // Las rutas que la plataforma conoce, con su almacén. Una foto de un camión que no está acá
    // se DECLARA y se salta: inventar el almacén sería inventar a qué ruta pertenece el dinero.
    const rutas = new Map((await dst.query(
      `SELECT split_part(code,'-',2) AS route_no, id
         FROM commercial.warehouses
        WHERE tenant_id=$1 AND kind='truck' AND deleted_at IS NULL`, [M])).rows.map((r) => [r.route_no, r.id]));

    console.log('camion    fecha       renglones    importe       empalme con el ledger');
    console.log('--------  ----------  ---------  -----------  ------------------------------');
    let saltadas = 0;
    for (const f of fotos) {
      const rt = String(f.truck).split('_')[1];
      const wid = rutas.get(rt);
      if (!wid) { console.log(`${String(f.truck).padEnd(8)}  ${f.fecha}  ⛔ la plataforma no conoce esta ruta — se salta`); saltadas++; continue; }

      const lineas = (await src.query(
        `SELECT sku, unidad, producto, existencia, costo, importe
           FROM mart.existencias_ruta WHERE truck=$1 AND fecha=$2`, [f.truck, f.fecha])).rows;

      // ⭐ La medición que decide si esta foto SIRVE: ¿sus SKU son los mismos que los del ledger?
      // Si el empalme es bajo, el ancla mandaria a cero mercancia que si esta arriba del camion.
      const { rows: [emp] } = await dst.query(
        `WITH foto AS (SELECT unnest($2::text[]) sku, unnest($3::text[]) unidad),
              led  AS (SELECT DISTINCT sku, unidad FROM analytics.mv_rd_route_ledger
                        WHERE tenant_id=$1 AND route_no=$4)
         SELECT count(*)::int total,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM led l WHERE l.sku=f.sku AND l.unidad=f.unidad))::int empalma
           FROM foto f`,
        [M, lineas.map((l) => String(l.sku).trim()), lineas.map((l) => String(l.unidad).trim().toUpperCase()), rt]);
      const pct = emp.total ? (100 * emp.empalma / emp.total) : 0;
      const marca = pct >= 80 ? '✔' : pct >= 50 ? '⚠️' : '⛔';
      console.log(`${String(f.truck).padEnd(8)}  ${f.fecha}  ${String(f.renglones).padStart(9)}  ${money(f.importe).padStart(11)}  ${marca} ${emp.empalma}/${emp.total} (${pct.toFixed(1)}%)`);

      // ⛔ Una foto que casi no empalma NO se escribe. Es exactamente el caso en que escribirla
      // hace mas dano que no tenerla: el ancla resetea, y lo que no lista queda en cero.
      if (pct < 50) { console.log(`           ⛔ empalme por debajo del 50%: NO se escribe (revisar el peldano de la unidad en esa van)`); saltadas++; continue; }
      if (!APPLY) { filas += lineas.length; continue; }

      await dst.query('BEGIN');
      try {
        // ⛔ `SET LOCAL x = $1` NO existe: SET no acepta parametros y Postgres responde
        // "syntax error at or near $1". La forma parametrizable es set_config(), con el
        // tercer argumento en true para que valga solo dentro de esta transaccion.
        await dst.query(`SELECT set_config('app.tenant_id', $1, true)`, [M]);
        const { rows: [cab] } = await dst.query(
          `INSERT INTO commercial.route_counts
             (tenant_id, warehouse_id, count_date, status, source, declared_total, note, counted_by_username)
           VALUES ($1,$2,$3,'active','kepler',$4,$5,'push')
           ON CONFLICT (tenant_id, warehouse_id, count_date) WHERE status <> 'cancelled' AND deleted_at IS NULL
           DO UPDATE SET declared_total = excluded.declared_total, note = excluded.note,
                         source = 'kepler', updated_at = now()
           RETURNING id`,
          [M, wid, f.fecha, f.importe, `push ${f.truck} · empalme ${pct.toFixed(1)}%`]);
        // La foto REEMPLAZA: lo que el camion ya no trae tiene que desaparecer.
        await dst.query(`DELETE FROM commercial.route_count_lines WHERE tenant_id=$1 AND count_id=$2`, [M, cab.id]);
        for (const l of lineas) {
          await dst.query(
            `INSERT INTO commercial.route_count_lines
               (tenant_id, count_id, sku, unidad, descripcion, qty, costo_unitario, importe)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (tenant_id, count_id, sku, unidad) DO UPDATE
               SET qty = excluded.qty, costo_unitario = excluded.costo_unitario, importe = excluded.importe`,
            [M, cab.id, String(l.sku).trim(), String(l.unidad).trim().toUpperCase(),
              l.producto ? String(l.producto).slice(0, 200) : null, l.existencia, l.costo, l.importe]);
        }
        await dst.query('COMMIT');
        filas += lineas.length;
      } catch (e) { await dst.query('ROLLBACK'); throw e; }
    }
    if (saltadas) console.log(`\n  ⚠️ ${saltadas} foto(s) saltada(s): ver la marca de empalme arriba.`);
    console.log(`\n  ${APPLY ? 'escritos' : 'se escribirían'} ${filas} renglón(es) de ${fotos.length - saltadas} foto(s).`);
  } catch (e) {
    estado = 'error'; error = e.message; process.exitCode = 1;
    console.error('ERR', e.message);
  } finally {
    // El latido mide ENTREGA, no "el proceso corrio" (ADR-053). Va aunque falle, y SOLO con --apply:
    // un dry-run que escribiera latido haria creer que el carril esta entregando.
    if (APPLY) {
      try {
        await dst.query(
          `INSERT INTO analytics.cron_runs (tenant_id, job_key, label, last_start, last_finish, status, rows_affected, duration_ms, error)
           VALUES ($1,$2,'RD.32 existencia de ruta (runner -> route_counts)', now(), now(), $3, $4, $5, $6)
           ON CONFLICT (tenant_id, job_key) DO UPDATE
             SET last_start=excluded.last_start, last_finish=excluded.last_finish, status=excluded.status,
                 rows_affected=excluded.rows_affected, duration_ms=excluded.duration_ms,
                 error=excluded.error, updated_at=now()`,
          [M, JOB, estado, filas, Date.now() - t0, error]);
      } catch (e) { console.error('  (no se pudo escribir el latido:', e.message, ')'); }
    }
    try { await src.end(); } catch { /* ya estaba cerrado */ }
    await dst.end();
  }
})();
