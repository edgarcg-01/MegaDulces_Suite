/* eslint-disable no-console */
/**
 * DM.11d — Auto-liga transfer_dest_map.warehouse_id por VERDAD DE RECEPCIÓN.
 *
 * El bucket "sucursal" del filtro Destino (y la resolución del destino en transfers-check)
 * dependen de que cada dest_code de traspaso apunte a un almacén (transfer_dest_map.warehouse_id).
 * Antes solo estaban curados los 'TI###' → los traspasos con dest_code = nº de sucursal caían
 * en "cliente" y desaparecían al filtrar Sucursal.
 *
 * Este script NO adivina por código ni por nombre (frágil entre entornos): usa la VERDAD
 * EMPÍRICA — el almacén que EFECTIVAMENTE recibe los envíos de cada dest_code, pareando
 * TrsfShip→TrsfRcv por (folio, serie, ventana 15d) igual que el reporte transfers-check.
 *
 * - Solo lee/escribe la PLATFORM DB (analytics.stock_movements + transfer_dest_map).
 *   NO necesita las DBs de sucursal → se puede correr directo contra Railway/prod.
 * - Respeta la curación humana: solo llena warehouse_id donde está NULL.
 * - Excluye destinos de RUTA (aunque tengan almacén asociado).
 * - Idempotente: correrlo N veces converge al mismo estado.
 *
 * Uso:
 *   DATABASE_URL_NEW='postgresql://…railway' node database/scripts/backfill-transfer-dest-warehouse.js [--apply]
 *   (sin --apply = dry-run: muestra qué ligaría sin escribir)
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW;
if (!DST) { console.error('Falta DATABASE_URL_NEW'); process.exit(2); }
const APPLY = process.argv.includes('--apply');

// dest_code → almacén receptor modal (excluye rutas). Reusable para dry-run y apply.
const BEST_CTE = `
  WITH ship AS (
    SELECT folio, doc_serie, warehouse_id, doc_date, dest_code
    FROM analytics.stock_movements
    WHERE tenant_id=$1 AND doc_code='TrsfShip' AND dest_code IS NOT NULL
      AND dest_code !~* '^\\s*(R\\.[DV]|R[DV]|RUTA)'
  ), pair AS (
    SELECT s.dest_code, r.warehouse_id AS rcv_wh, count(*)::int n
    FROM ship s
    JOIN LATERAL (
      SELECT rr.warehouse_id FROM analytics.stock_movements rr
      WHERE rr.tenant_id=$1 AND rr.doc_code='TrsfRcv' AND rr.parent_group='41'
        AND rr.parent_folio=s.folio AND coalesce(rr.parent_serie,'')=coalesce(s.doc_serie,'')
        AND rr.warehouse_id <> s.warehouse_id
        AND rr.doc_date >= s.doc_date AND rr.doc_date <= s.doc_date + 15
      GROUP BY rr.warehouse_id
    ) r ON true
    GROUP BY s.dest_code, r.warehouse_id
  ), best AS (
    SELECT DISTINCT ON (dest_code) dest_code, rcv_wh, n
    FROM pair ORDER BY dest_code, n DESC
  )`;

(async () => {
  const db = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await db.connect();
  try {
    // Dry-run: qué dest_code (hoy sin warehouse_id) se ligarían y a dónde.
    const preview = (await db.query(`
      ${BEST_CTE}
      SELECT dm.dest_code, dm.dest_label, b.rcv_wh, coalesce(w.name, w.code) AS wh, b.n AS recepciones
      FROM best b
      JOIN commercial.warehouses w ON w.id=b.rcv_wh AND w.tenant_id=$1 AND w.code NOT ILIKE 'RUTA%'
      JOIN analytics.transfer_dest_map dm ON dm.tenant_id=$1 AND dm.dest_code=b.dest_code AND dm.warehouse_id IS NULL
      ORDER BY b.n DESC`, [M])).rows;

    console.log(`\n=== ${APPLY ? 'APPLY' : 'DRY-RUN'} — ${preview.length} dest_code a ligar por recepción ===`);
    for (const r of preview) {
      console.log(`  ${String(r.dest_code).padEnd(14)} | ${String(r.dest_label || '').padEnd(34)} → ${r.wh}  (${r.recepciones} recepciones)`);
    }

    if (APPLY && preview.length) {
      const res = await db.query(`
        ${BEST_CTE}
        UPDATE analytics.transfer_dest_map dm
          SET warehouse_id=b.rcv_wh, updated_at=now()
        FROM best b
        JOIN commercial.warehouses w ON w.id=b.rcv_wh AND w.tenant_id=$1 AND w.code NOT ILIKE 'RUTA%'
        WHERE dm.tenant_id=$1 AND dm.dest_code=b.dest_code AND dm.warehouse_id IS NULL`, [M]);
      console.log(`\n✅ ${res.rowCount} dest_code ligados a su almacén.`);
    } else if (!APPLY) {
      console.log(`\n(dry-run — nada escrito; agregá --apply para persistir)`);
    }

    const chk = (await db.query(`
      SELECT count(*) FILTER (WHERE warehouse_id IS NOT NULL) con, count(*) tot
      FROM analytics.transfer_dest_map WHERE tenant_id=$1`, [M])).rows[0];
    console.log(`\n=== transfer_dest_map: ${chk.con}/${chk.tot} dest_code con almacén ligado ===`);
  } catch (e) {
    console.error('ERROR:', e.message); process.exitCode = 1;
  } finally { await db.end(); }
})();
