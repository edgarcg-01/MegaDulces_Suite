/* eslint-disable no-console */
/**
 * T.2/T.6 — Feed de MOVIMIENTOS que NO son venta (traspasos / consolidación) por
 * sucursal × tipo × destino × mes → Railway (analytics.transfers_monthly). Base del
 * apartado /logistica/traspasos. Mantiene estos docs FUERA de venta.
 *
 * Tipos (kind) y su doc Kepler (kdm1.c2/c3/c4):
 *   salida_cedis     = U/D/13 en CEDIS (md_00): SALIDA a un destino (dest_label del
 *                      catálogo kdud: P.V./TLMKT/RUTA). El flujo real CEDIS→sucursal.
 *   consolidacion    = U/D/6  (serie UD06, CONTADO, sin destino) — causaba el ×2 en venta
 *   recepcion        = U/A/50 ("Recepción Traspaso Suc") — lado receptor
 *   traspaso_salida  = N/D/6, N/D/25 (Salida Traspaso Sucursal/almacén)
 *   traspaso_entrada = N/A/6, N/A/25 (Entrada Traspaso Sucursal/almacén)
 *
 * `dest_label` solo para salida_cedis (destino real); '' en el resto. OJO: NO sumar
 * salida_cedis + recepcion (mismo bien contado 2 veces — son origen y lado receptor).
 *
 * Lee los 6 servidores Kepler de sucursal EN VIVO (192.168.x). Como purgan historia,
 * el upsert es ACUMULATIVO con GREATEST. Aditivo. NO usa mart.ventas ni toca ventas.
 *
 * `[CANON.5.21]` (2026-11-06) — por default lee `kepler_ods` (kdm1, kdm2 y el catálogo kdud
 * dentro de la misma `sucursal`) en la conexión de prod, en vez de los 9 POS. Comparación en seco
 * de 2026 contra la tabla: 1,070 filas idénticas; sumando sin el destino, las 121 combinaciones
 * sucursal × tipo × mes fuera de `00/salida_cedis` cuadran exacto salvo 2 de noviembre con el ODS
 * más alto. Control (la 01 lee el ODS de la 08): rojo.
 * ⚠️ `00/salida_cedis` NO cuadra y el defecto es de la TABLA: el destino se resuelve contra el
 * catálogo `kdud`, que cambió de nombre (p. ej. `RD028` → `123`), y el upsert GREATEST nunca retira
 * la fila con el nombre viejo. El mismo documento queda bajo dos destinos: en enero, 1,110 docs
 * contra 741 folios reales (~$6 M de más por mes en el primer semestre). Esto no lo arregla ni lo
 * empeora el cambio de fuente; lo arregla `--reset` (o volverla vista), y es decisión aparte.
 * `--source=branch` conserva la lectura de cada POS.
 *
 * `[CANON.5.27]` (2026-11-06, D6) — con la fuente ODS el importer REEMPLAZA lo que reconstruye: dentro
 * de su ventana (el año) y por cada sucursal que leyó bien, actualiza lo que cambió y BORRA las llaves
 * que ya no salen (el destino con el nombre viejo). El GREATEST existía porque los POS purgan
 * historia; el ODS no la purga y cubre todos los meses de la tabla, así que con `ods` ya no protege
 * de nada y sólo acumulaba el doble conteo. Con `--source=branch` sigue el GREATEST.
 * Guarda: una sucursal que devuelve 0 filas teniendo filas en la tabla no se toca (un ODS vacío por
 * una falla de replicación no borra su historia).
 *
 *   DST_URL=…railway node database/importers/kepler/import-transfers-monthly.js          # dry-run
 *   DST_URL=…             node database/importers/kepler/import-transfers-monthly.js --apply
 *   ... [--year 2026] [--source=branch]
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
const APPLY = process.argv.includes('--apply');
// --reset: borra las filas del tenant antes de insertar (base 100% limpia). Solo
// para corrida puntual; el nightly corre SIN --reset (UPSERT-acumulativo GREATEST).
const RESET = process.argv.includes('--reset');
const yi = process.argv.indexOf('--year');
const YEAR = yi !== -1 ? Number(process.argv[yi + 1]) : new Date().getFullYear();

// Fuente única del mapa de sucursales (paso 3 normalización almacén). Las 6 (incluye CEDIS).
const { salesMap, clientConfig } = require('../lib/kepler-branches');
const BRANCHES = process.env.SALES_BRANCH_MAP ? JSON.parse(process.env.SALES_BRANCH_MAP) : salesMap();
const SOURCE = (process.argv.find((a) => a.startsWith('--source=')) || '').split('=')[1] || 'ods';
if (!['ods', 'branch'].includes(SOURCE)) throw new Error(`--source desconocido: ${SOURCE} (ods | branch)`);
// En el ODS cada tabla trae su base de origen en `sucursal` ($3): cabecera, renglón y catálogo
// se leen dentro de la misma base, igual que al leer el POS de esa sucursal (ver collect()).

const KIND = `CASE
  WHEN h.c2='U' AND h.c3='D' AND h.c4=13 THEN 'salida_cedis'
  WHEN h.c2='U' AND h.c3='D' AND h.c4=6  THEN 'consolidacion'
  WHEN h.c2='U' AND h.c3='A' AND h.c4=50 THEN 'recepcion'
  WHEN h.c2='N' AND h.c3='D' AND h.c4 IN (6,25) THEN 'traspaso_salida'
  WHEN h.c2='N' AND h.c3='A' AND h.c4 IN (6,25) THEN 'traspaso_entrada'
END`;
const WHERE_TRANSFER = `(
  (h.c2='U' AND h.c3='D' AND h.c4=13) OR
  (h.c2='U' AND h.c3='D' AND h.c4=6) OR
  (h.c2='U' AND h.c3='A' AND h.c4=50) OR
  (h.c2='N' AND h.c4 IN (6,25))
)`;

const mkey = (m) => (m instanceof Date ? m.toISOString().slice(0, 10) : String(m));

/**
 * Lee las sucursales y devuelve lo que el importer escribiría. No escribe nada.
 * @returns {{ rows: Array<[string,string,string,any,number,number,number]>, okWarehouses: string[], from: string, to: string }}
 *   rows = [warehouse_id, kind, dest_label, month, units, value, docs]; okWarehouses = las que leyeron bien.
 */
async function collect(db, { year = YEAR, source = SOURCE, log = console.log } = {}) {
  const sch = source === 'ods' ? 'kepler_ods' : 'md';
  const suc = (alias) => (source === 'ods' ? `AND ${alias}.sucursal = $3` : '');
  const whs = (await db.query(`SELECT id, code FROM commercial.warehouses WHERE tenant_id=$1`, [M])).rows;
  const whTo = new Map(whs.map((w) => [w.code, w.id]));
  log(`  lookup: ${whTo.size} warehouses`);

  const from = `${year}-01-01`;
  const to = `${year + 1}-01-01`;
  const rows = [];
  const okWarehouses = [];

  for (const b of BRANCHES) {
    const wid = whTo.get(b.code);
    if (!wid) { log(`  ⚠️  sucursal ${b.code} sin warehouse en destino — skip`); continue; }
    const src = source === 'ods' ? db : new Client(clientConfig(b, { connectionTimeoutMillis: 8000, statement_timeout: 180000 }));
    const params = source === 'ods' ? [from, to, b.code] : [from, to];
    const t0 = Date.now();
    try {
      if (src !== db) await src.connect();
      const DEST = `CASE WHEN h.c2='U' AND h.c3='D' AND h.c4=13 THEN coalesce(cat.c3, h.c10) ELSE '' END`;
      const CAT = `LEFT JOIN (SELECT DISTINCT ON (c2) c2, c3 FROM ${sch}.kdud k WHERE true ${suc('k')} ORDER BY c2) cat ON cat.c2 = h.c10`;

      // A) VALOR + docs desde el HEADER (kdm1.c16). Correcto para todos los kinds,
      //    incl. U/D/13 (cuyo valor NO está en kdm2 sino en el header).
      const hq = await src.query(
        `SELECT ${KIND} AS kind, ${DEST} AS dest_label,
                date_trunc('month', h.c9)::date AS mes,
                count(DISTINCT h.c6) AS docs, sum(coalesce(h.c16,0))::numeric AS value
           FROM ${sch}.kdm1 h ${CAT}
          WHERE ${WHERE_TRANSFER} AND h.c9 >= $1 AND h.c9 < $2 ${suc('h')}
          GROUP BY 1, 2, 3`, params);

      // B) UNIDADES desde kdm2 (donde haya líneas).
      const uq = await src.query(
        `SELECT ${KIND} AS kind, ${DEST} AS dest_label,
                date_trunc('month', h.c9)::date AS mes, sum(coalesce(d.c9,0))::numeric AS units
           FROM ${sch}.kdm2 d
           JOIN ${sch}.kdm1 h ON h.c1=d.c1 AND h.c2=d.c2 AND h.c3=d.c3 AND h.c4=d.c4 AND h.c5=d.c5 AND h.c6=d.c6
                ${source === 'ods' ? 'AND h.sucursal=d.sucursal' : ''}
           ${CAT}
          WHERE ${WHERE_TRANSFER} AND h.c9 >= $1 AND h.c9 < $2 ${suc('h')}
            AND d.c8 NOT IN ('00001','00002') AND btrim(d.c8) <> ''
          GROUP BY 1, 2, 3`, params);

      const uMap = new Map(uq.rows.filter((r) => r.kind).map((r) => [`${r.kind}|${r.dest_label || ''}|${mkey(r.mes)}`, Number(r.units) || 0]));
      for (const r of hq.rows) {
        if (!r.kind) continue;
        const units = uMap.get(`${r.kind}|${r.dest_label || ''}|${mkey(r.mes)}`) || 0;
        rows.push([wid, r.kind, r.dest_label || '', r.mes, units, Number(r.value) || 0, Number(r.docs) || 0]);
      }
      okWarehouses.push(wid);
      const val = hq.rows.reduce((a, r) => a + (Number(r.value) || 0), 0);
      const kinds = [...new Set(hq.rows.map((r) => r.kind).filter(Boolean))].join('/');
      log(`  ✅ ${b.db} (${b.code}): ${hq.rows.length} filas [${kinds || '-'}] · $${Math.round(val).toLocaleString()} (${Date.now() - t0}ms)`);
    } catch (e) {
      log(`  ❌ ${b.db} (${b.code}): ${e.message}`);
    } finally {
      if (src !== db) { try { await src.end(); } catch { /* noop */ } }
    }
  }
  return { rows, okWarehouses, from, to };
}

/**
 * Llaves de la tabla, dentro de la ventana y de las sucursales que leyeron bien, que la lectura ya no
 * produce. Una sucursal que leyó 0 filas pero tiene filas en la tabla queda fuera (guarda).
 * Es lo que `--apply` borra con la fuente ODS.
 */
async function staleKeys(db, { rows, okWarehouses, from, to }) {
  const conFilas = new Set(rows.map((r) => r[0]));
  const scope = okWarehouses.filter((w) => conFilas.has(w));
  const guardadas = okWarehouses.filter((w) => !conFilas.has(w));
  const keys = rows.map((r) => ({ w: r[0], k: r[1], d: r[2], m: mkey(r[3]) }));
  const res = await db.query(
    `SELECT t.id, t.warehouse_id, t.kind, t.dest_label, t.month, t.value, t.docs
       FROM analytics.transfers_monthly t
      WHERE t.tenant_id = $1 AND t.warehouse_id = ANY($2::uuid[]) AND t.month >= $3::date AND t.month < $4::date
        AND NOT EXISTS (SELECT 1 FROM json_to_recordset($5::json) AS n(w uuid, k text, d text, m date)
                         WHERE n.w = t.warehouse_id AND n.k = t.kind AND n.d = t.dest_label AND n.m = t.month)`,
    [M, scope, from, to, JSON.stringify(keys)]);
  return { stale: res.rows, guardadas };
}

if (require.main === module) {
  (async () => {
    const db = new Client({
      connectionString: DST,
      ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false,
    });
    await db.connect();
    try {
      const REPLACE = SOURCE === 'ods';
      console.log(`\n=== TRASPASOS mensuales → analytics.transfers_monthly (${APPLY ? 'APPLY' : 'DRY-RUN'}, año ${YEAR}, ${REPLACE ? 'reemplaza' : 'GREATEST'}) ===\n`);

      if (APPLY) {
        await db.query(`CREATE SCHEMA IF NOT EXISTS analytics`);
        await db.query(`CREATE TABLE IF NOT EXISTS analytics.transfers_monthly (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
          warehouse_id uuid NOT NULL, kind text NOT NULL, dest_label text NOT NULL DEFAULT '',
          month date NOT NULL, units numeric NOT NULL DEFAULT 0, value numeric NOT NULL DEFAULT 0,
          docs integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now())`);
        await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_transfers_monthly ON analytics.transfers_monthly (tenant_id, warehouse_id, kind, dest_label, month)`);
      }

      const got = await collect(db);
      const all = got.rows;
      console.log(`\n  total a upsert: ${all.length} filas`);
      let stale = [];
      if (REPLACE && !RESET) {
        const s = await staleKeys(db, got);
        stale = s.stale;
        if (s.guardadas.length) console.log(`  ⚠️  ${s.guardadas.length} sucursal(es) leyeron 0 filas: no se borra nada suyo (guarda).`);
        const v = stale.reduce((a, r) => a + Number(r.value || 0), 0);
        console.log(`  llaves que ya no salen (se borran): ${stale.length} · $${Math.round(v).toLocaleString()}`);
      }

      if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

      await db.query('BEGIN');
      await db.query(`SET LOCAL app.tenant_id = '${M}'`);
      if (RESET) {
        const del = await db.query(`DELETE FROM analytics.transfers_monthly WHERE tenant_id = $1`, [M]);
        console.log(`  [--reset] ${del.rowCount} filas previas borradas (base limpia, solo header).`);
      } else if (stale.length) {
        const del = await db.query(`DELETE FROM analytics.transfers_monthly WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [M, stale.map((r) => r.id)]);
        console.log(`  ${del.rowCount} llaves que ya no salen, borradas.`);
      }
      // ODS: el valor nuevo reemplaza al guardado (sólo si cambió, para no reescribir de más).
      // POS: GREATEST, porque purgan historia.
      const SET = REPLACE
        ? `units = EXCLUDED.units, value = EXCLUDED.value, docs = EXCLUDED.docs, updated_at = now()
           WHERE (analytics.transfers_monthly.units, analytics.transfers_monthly.value, analytics.transfers_monthly.docs)
                 IS DISTINCT FROM (EXCLUDED.units, EXCLUDED.value, EXCLUDED.docs)`
        : `units = GREATEST(analytics.transfers_monthly.units, EXCLUDED.units),
           value = GREATEST(analytics.transfers_monthly.value, EXCLUDED.value),
           docs  = GREATEST(analytics.transfers_monthly.docs,  EXCLUDED.docs),
           updated_at = now()
         WHERE EXCLUDED.units > analytics.transfers_monthly.units
            OR EXCLUDED.value > analytics.transfers_monthly.value
            OR EXCLUDED.docs  > analytics.transfers_monthly.docs`;
      const BATCH = 500;
      let upserts = 0;
      for (let i = 0; i < all.length; i += BATCH) {
        const chunk = all.slice(i, i + BATCH);
        const vals = chunk.map((_, ri) => { const b = ri * 8; return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`; });
        const params = []; chunk.forEach((row) => params.push(M, row[0], row[1], row[2], row[3], row[4], row[5], row[6]));
        const res = await db.query(
          `INSERT INTO analytics.transfers_monthly
             (tenant_id, warehouse_id, kind, dest_label, month, units, value, docs)
           VALUES ${vals.join(',')}
           ON CONFLICT (tenant_id, warehouse_id, kind, dest_label, month) DO UPDATE SET ${SET}`, params);
        upserts += res.rowCount;
      }
      await db.query('COMMIT');
      console.log(`\n[APPLY] COMMIT — ${upserts} filas upserted en analytics.transfers_monthly.`);
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      console.error('\nERROR (rollback):', e.message);
      process.exitCode = 1;
    } finally {
      await db.end();
    }
  })();
}

module.exports = { collect, staleKeys };
