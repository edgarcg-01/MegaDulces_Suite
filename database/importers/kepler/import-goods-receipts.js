/* eslint-disable no-console */
/**
 * Fase CC (extensión) — Órdenes de entrada de Kepler → analytics.erp_goods_receipts.
 *
 * Lee las ÓRDENES DE ENTRADA de Kepler (`X-A-40` = "EntryOr1", la que suma
 * inventario) desde `md.kdm1`, enriquecidas con su VALE de entrada `X-A-37`
 * (razón social completa + RFC + folio de la OC X-A-35) vía el back-pointer
 * c37='37'/c39. Es la lista de la que el capturista elige la entrada para
 * adjuntarle la remisión/factura del proveedor. NO toca Kepler (solo SELECT).
 *
 * Cadena de compras (FASE_RA §2.5): Requisición X-A-30 → OC X-A-35 →
 * Vale X-A-37 → Orden de entrada X-A-40 (AQUÍ suma existencia). El vale trae
 * el mejor dato del proveedor; el enlace es oe.c37='37' AND oe.c39=vale.c6
 * (cobertura verificada 8360/8360 en CEDIS).
 *
 * Fuente = CEDIS md_00 (centraliza compras; `(suc,folio)` único en XA4001).
 * Idempotente: UPSERT-solo-cambios, sin DELETE (ledger append-only).
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
const fromIx = process.argv.indexOf('--from');
const FROM = fromIx > -1 ? process.argv[fromIx + 1] : null;
const SOURCE_BRANCH = (SRC.match(/\/(md_\d+)/) || [])[1] || 'md_00';

const money = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; };

(async () => {
  console.log(`\n=== Órdenes de entrada Kepler (${SOURCE_BRANCH}, X-A-40 ⋈ X-A-37) → analytics.erp_goods_receipts (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

  const src = new Client({ connectionString: SRC, connectionTimeoutMillis: 8000 });
  await src.connect();
  let rows, lineRows;
  try {
    const params = [];
    let where = `oe.c2='X' AND oe.c3='A' AND trim(oe.c4::text)='40' AND oe.c37='37'`;
    if (FROM) { params.push(FROM); where += ` AND oe.c9::date >= $1`; }
    const q = await src.query(
      `SELECT oe.c1 AS suc, oe.c6 AS folio, oe.c9::date AS fecha, oe.c10 AS prov_code,
              oe.c16 AS monto, oe.c24 AS concepto, oe.c39 AS vale_folio,
              COALESCE(NULLIF(btrim(v.c32), ''), oe.c32) AS prov_nombre,
              NULLIF(btrim(v.c22), '') AS prov_rfc,
              NULLIF(btrim(v.c39), '') AS oc_folio
         FROM md.kdm1 oe
         LEFT JOIN md.kdm1 v
           ON v.c1=oe.c1 AND v.c2='X' AND v.c3='A' AND v.c4='37' AND v.c6=oe.c39
        WHERE ${where}`, params);
    rows = q.rows;
    // Líneas del documento (kdm2) para el detalle por renglón (auditoría).
    const ql = await src.query(
      `SELECT oe.c1 AS suc, oe.c6 AS folio, l.c7 AS linea, l.c8 AS sku, l.c10 AS nombre,
              l.c9 AS cantidad, l.c11 AS unidad, l.c12 AS costo, l.c13 AS importe
         FROM md.kdm1 oe
         JOIN md.kdm2 l ON l.c1=oe.c1 AND l.c2=oe.c2 AND l.c3=oe.c3 AND l.c4=oe.c4 AND l.c6=oe.c6
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
    String(r.suc).trim(), String(r.folio).trim(), 'XA4001',
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
