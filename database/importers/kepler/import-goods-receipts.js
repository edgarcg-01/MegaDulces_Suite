/* eslint-disable no-console */
/**
 * Fase CC (extensión) — Órdenes de entrada de Kepler → analytics.erp_goods_receipts.
 *
 * Lee la "APLICA ORDEN ENTRADA" de Kepler (`X-A-20` = `XA2001` "ApEntOr1") desde
 * `md.kdm1`. ESTE es el documento que el proveedor firma y al que se adjunta la
 * remisión: su `c16` es el TOTAL con IVA (= el total de la remisión) y genera la
 * póliza de compra (511/201/122). Es la lista de la que el capturista elige la
 * entrada para adjuntarle la remisión/factura. NO toca Kepler (solo SELECT).
 *
 * OJO decode (verificado con doc real GRUPO LEVI 0008231, 2026-08-03): el folio NO
 * es único entre doctypes — `X-A-40` (XA4001, "Orden de entrada" que mueve inventario)
 * y `X-A-20` (XA2001, "Aplica") tienen el MISMO folio para transacciones DISTINTAS.
 * El documento que el usuario digitaliza es la **XA2001** (título "Aplica Orden
 * Entrada"); antes se leía por error de XA4001. La XA2001 se enlaza a su orden de
 * entrada física (XA4001, ap.c37='40'/c39) → vale (XA3701) para OC + RFC de respaldo.
 * Cadena: Requisición X-A-30 → OC X-A-35 → Vale X-A-37 → Orden entrada X-A-40 → Aplica X-A-20.
 *
 * Fuente = CEDIS md_00 (centraliza compras; `(suc,folio)` único en XA2001).
 * Idempotente: UPSERT-solo-cambios, sin DELETE. Corré con `--reset` UNA vez al
 * cambiar de doctype (limpia el espejo antes de repoblar).
 *
 *   node database/importers/kepler/import-goods-receipts.js            # dry-run
 *   node database/importers/kepler/import-goods-receipts.js --apply    # commit
 *   node database/importers/kepler/import-goods-receipts.js --apply --from 2026-01-01
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const SRC = process.env.RECEIPTS_SRC || 'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00';
const APPLY = process.argv.includes('--apply');
const RESET = process.argv.includes('--reset'); // limpieza única al cambiar de doctype (XA4001→XA2001)
const fromIx = process.argv.indexOf('--from');
const FROM = fromIx > -1 ? process.argv[fromIx + 1] : null;
const SOURCE_BRANCH = (SRC.match(/\/(md_\d+)/) || [])[1] || 'md_00';

const money = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; };

(async () => {
  console.log(`\n=== Órdenes de entrada Kepler (${SOURCE_BRANCH}, XA2001 "Aplica Orden Entrada") → analytics.erp_goods_receipts (${APPLY ? 'APPLY' : 'DRY-RUN'}${RESET ? ' +RESET' : ''}) ===\n`);

  const src = new Client({ connectionString: SRC, connectionTimeoutMillis: 8000 });
  await src.connect();
  let rows, lineRows;
  try {
    const params = [];
    let where = `ap.c2='X' AND ap.c3='A' AND trim(ap.c4::text)='20'`;
    if (FROM) { params.push(FROM); where += ` AND ap.c9::date >= $1`; }
    // Encabezado = la "Aplica Orden Entrada" (XA2001) — el documento que el proveedor
    // firma y al que se adjunta la remisión; su c16 es el TOTAL (con IVA = la remisión)
    // y su póliza es la compra. Se enriquece con la orden de entrada física (XA4001,
    // vía ap.c37='40'/c39) y su vale (XA3701) para el folio de OC + RFC de respaldo.
    const q = await src.query(
      `SELECT ap.c1 AS suc, ap.c6 AS folio, ap.c9::date AS fecha, ap.c10 AS prov_code,
              ap.c16 AS monto, ap.c24 AS concepto,
              COALESCE(NULLIF(btrim(v.c32), ''), ap.c32) AS prov_nombre,
              COALESCE(NULLIF(btrim(ap.c22), ''), NULLIF(btrim(v.c22), '')) AS prov_rfc,
              NULLIF(btrim(oe.c39), '') AS vale_folio,
              NULLIF(btrim(v.c39), '') AS oc_folio
         FROM md.kdm1 ap
         LEFT JOIN md.kdm1 oe ON oe.c1=ap.c1 AND oe.c2='X' AND oe.c3='A' AND oe.c4='40' AND oe.c6=ap.c39
         LEFT JOIN md.kdm1 v  ON v.c1=oe.c1  AND v.c2='X'  AND v.c3='A'  AND v.c4='37'  AND v.c6=oe.c39
        WHERE ${where}`, params);
    rows = q.rows;
    // Líneas del documento (kdm2 de la XA2001) para el detalle por renglón (auditoría).
    const ql = await src.query(
      `SELECT ap.c1 AS suc, ap.c6 AS folio, l.c7 AS linea, l.c8 AS sku, l.c10 AS nombre,
              l.c9 AS cantidad, l.c11 AS unidad, l.c12 AS costo, l.c13 AS importe
         FROM md.kdm1 ap
         JOIN md.kdm2 l ON l.c1=ap.c1 AND l.c2=ap.c2 AND l.c3=ap.c3 AND l.c4=ap.c4 AND l.c6=ap.c6
        WHERE ${where}`, params);
    lineRows = ql.rows;
  } finally { await src.end().catch(() => {}); }

  // Dedupe por (suc,folio) — el join es 1:1 pero blindamos el ON CONFLICT.
  const byKey = new Map();
  for (const r of rows) {
    if (!r.suc || !r.folio) continue;
    byKey.set(`${String(r.suc).trim()}|${String(r.folio).trim()}`, r);
  }
  const staged = [...byKey.values()].map((r) => [
    String(r.suc).trim(), String(r.folio).trim(), 'XA2001',
    r.fecha || null,
    (r.prov_code || '').trim() || null,
    (r.prov_nombre || '').trim() || null,
    (r.prov_rfc || '').trim() || null,
    (r.vale_folio || '').trim() || null,
    (r.oc_folio || '').trim() || null,
    (r.concepto || '').trim() || null,
    money(r.monto),
    SOURCE_BRANCH,
  ]);

  // Dedupe líneas por (suc,folio,linea) — para el detalle de auditoría.
  const lineByKey = new Map();
  for (const r of (lineRows || [])) {
    if (!r.suc || !r.folio || r.linea == null) continue;
    lineByKey.set(`${String(r.suc).trim()}|${String(r.folio).trim()}|${String(r.linea).trim()}`, r);
  }
  const stagedLines = [...lineByKey.values()].map((r) => [
    String(r.suc).trim(), String(r.folio).trim(), String(r.linea).trim(),
    (r.sku || '').toString().trim() || null,
    (r.nombre || '').toString().trim() || null,
    money(r.cantidad), (r.unidad || '').toString().trim() || null,
    money(r.costo), money(r.importe),
  ]);

  const tot = staged.reduce((s, r) => s + r[10], 0);
  const conRfc = staged.filter((r) => r[6]).length;
  const conOc = staged.filter((r) => r[8]).length;
  console.log(`  ${staged.length} entradas leídas ${FROM ? `(desde ${FROM}) ` : ''}· $${tot.toLocaleString('es-MX', { minimumFractionDigits: 2 })} · con RFC: ${conRfc} · con OC: ${conOc}`);
  console.log(`  ${stagedLines.length} líneas de detalle`);

  if (!APPLY) { console.log('\n[DRY-RUN] nada cambió. Corré con --apply para escribir.'); return; }
  if (!staged.length) { console.log('\n[APPLY] 0 entradas leídas (¿fuente caída?) — tabla intacta.'); return; }

  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    if (RESET) {
      // Cambio de doctype (XA4001→XA2001): el folio no es único entre doctypes, así
      // que hay que limpiar el espejo antes de repoblar (si no, quedan filas mezcladas).
      const dl = await db.query(`DELETE FROM analytics.erp_goods_receipt_lines WHERE tenant_id=$1`, [M]);
      const dh = await db.query(`DELETE FROM analytics.erp_goods_receipts WHERE tenant_id=$1`, [M]);
      console.log(`  [--reset] limpiado: ${dh.rowCount} entradas + ${dl.rowCount} líneas del espejo`);
    }
    await db.query(`CREATE TEMP TABLE stg_gr (
      sucursal text, folio text, doc_prefix text, receipt_date date, proveedor_code text,
      proveedor_nombre text, proveedor_rfc text, vale_folio text, oc_folio text,
      concepto text, monto numeric, source_branch text
    ) ON COMMIT DROP`);
    const NC = 12;
    for (let i = 0; i < staged.length; i += 1000) {
      const chunk = staged.slice(i, i + 1000);
      const vals = chunk.map((_, ri) => `(${Array.from({ length: NC }, (_, k) => `$${ri * NC + k + 1}`).join(',')})`);
      const params = [];
      chunk.forEach((row) => params.push(...row));
      await db.query(`INSERT INTO stg_gr (sucursal,folio,doc_prefix,receipt_date,proveedor_code,proveedor_nombre,proveedor_rfc,vale_folio,oc_folio,concepto,monto,source_branch) VALUES ${vals.join(',')}`, params);
    }
    const up = await db.query(
      `INSERT INTO analytics.erp_goods_receipts AS t
         (tenant_id, sucursal, folio, doc_prefix, receipt_date, proveedor_code, proveedor_nombre, proveedor_rfc, vale_folio, oc_folio, concepto, monto, source_branch, computed_at)
       SELECT $1, sucursal, folio, doc_prefix, receipt_date, proveedor_code, proveedor_nombre, proveedor_rfc, vale_folio, oc_folio, concepto, monto, source_branch, now()
         FROM stg_gr
       ON CONFLICT (tenant_id, sucursal, folio) DO UPDATE SET
         doc_prefix=EXCLUDED.doc_prefix, receipt_date=EXCLUDED.receipt_date,
         proveedor_code=EXCLUDED.proveedor_code, proveedor_nombre=EXCLUDED.proveedor_nombre,
         proveedor_rfc=EXCLUDED.proveedor_rfc, vale_folio=EXCLUDED.vale_folio, oc_folio=EXCLUDED.oc_folio,
         concepto=EXCLUDED.concepto, monto=EXCLUDED.monto, source_branch=EXCLUDED.source_branch, computed_at=now()
       WHERE (t.receipt_date, t.proveedor_code, t.proveedor_nombre, t.proveedor_rfc, t.vale_folio, t.oc_folio, t.concepto, t.monto)
             IS DISTINCT FROM
             (EXCLUDED.receipt_date, EXCLUDED.proveedor_code, EXCLUDED.proveedor_nombre, EXCLUDED.proveedor_rfc, EXCLUDED.vale_folio, EXCLUDED.oc_folio, EXCLUDED.concepto, EXCLUDED.monto)`,
      [M]);

    // Líneas de detalle (auditoría renglón por renglón). UPSERT-solo-cambios, sin DELETE.
    await db.query(`CREATE TEMP TABLE stg_grl (
      sucursal text, folio text, linea text, sku text, nombre text,
      cantidad numeric, unidad text, costo_unitario numeric, importe numeric
    ) ON COMMIT DROP`);
    const NLC = 9;
    for (let i = 0; i < stagedLines.length; i += 1000) {
      const chunk = stagedLines.slice(i, i + 1000);
      const vals = chunk.map((_, ri) => `(${Array.from({ length: NLC }, (_, k) => `$${ri * NLC + k + 1}`).join(',')})`);
      const params = [];
      chunk.forEach((row) => params.push(...row));
      await db.query(`INSERT INTO stg_grl (sucursal,folio,linea,sku,nombre,cantidad,unidad,costo_unitario,importe) VALUES ${vals.join(',')}`, params);
    }
    const upl = await db.query(
      `INSERT INTO analytics.erp_goods_receipt_lines AS t
         (tenant_id, sucursal, folio, linea, sku, nombre, cantidad, unidad, costo_unitario, importe, computed_at)
       SELECT $1, sucursal, folio, linea, sku, nombre, cantidad, unidad, costo_unitario, importe, now()
         FROM stg_grl
       ON CONFLICT (tenant_id, sucursal, folio, linea) DO UPDATE SET
         sku=EXCLUDED.sku, nombre=EXCLUDED.nombre, cantidad=EXCLUDED.cantidad, unidad=EXCLUDED.unidad,
         costo_unitario=EXCLUDED.costo_unitario, importe=EXCLUDED.importe, computed_at=now()
       WHERE (t.sku, t.nombre, t.cantidad, t.unidad, t.costo_unitario, t.importe)
             IS DISTINCT FROM
             (EXCLUDED.sku, EXCLUDED.nombre, EXCLUDED.cantidad, EXCLUDED.unidad, EXCLUDED.costo_unitario, EXCLUDED.importe)`,
      [M]);

    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} entradas + ${upl.rowCount} líneas (nuevas/cambiadas) de ${staged.length}/${stagedLines.length} en origen. Sin DELETE (ledger append-only).`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
