/* eslint-disable no-console */
/**
 * Fase CC (extensión) — Pagos a proveedor de Kepler → analytics.erp_supplier_payments.
 *
 * Lee los documentos de PAGO A PROVEEDOR de Kepler (`XD2501` = "Payment1" /
 * Aplicación de pago, asiento C 201 / A 102 = sale dinero) desde el encabezado
 * `md.kdm1` y los refleja en `analytics.erp_supplier_payments`. Es la lista de la
 * que el capturista elige el pago para adjuntarle el comprobante de transferencia.
 * NO toca Kepler (solo SELECT) ni crea pagos.
 *
 * OJO decode (verificado en vivo 2026-08-03): el pago-a-proveedor limpio es
 * `XD2501` (RFC + razón social + montos reales). `XD2601` es otra cosa (caja
 * chica / gastos NF con c16 a menudo 0) → NO se incluye aquí; eso es Egresos (GX).
 *
 * Fuente = CEDIS md_00 (centraliza los pagos; `(suc,folio)` único en XD2501).
 * Filtro exacto: c2='X' (género) AND c3='D' (naturaleza) AND c4=25 (grupo).
 * Idempotente: UPSERT-solo-cambios, sin DELETE (ledger append-only).
 *
 *   node database/importers/kepler/import-supplier-payments.js            # dry-run
 *   node database/importers/kepler/import-supplier-payments.js --apply    # commit
 *   node database/importers/kepler/import-supplier-payments.js --apply --from 2026-01-01
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const SRC = process.env.PAYMENTS_SRC || 'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00';
const APPLY = process.argv.includes('--apply');
const fromIx = process.argv.indexOf('--from');
const FROM = fromIx > -1 ? process.argv[fromIx + 1] : null;
const SOURCE_BRANCH = (SRC.match(/\/(md_\d+)/) || [])[1] || 'md_00';

/** Parseo defensivo de importe (un row basura no debe abortar todo el import). */
const money = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; };

(async () => {
  console.log(`\n=== Pagos a proveedor Kepler (${SOURCE_BRANCH}, XD2501) → analytics.erp_supplier_payments (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

  const src = new Client({ connectionString: SRC, connectionTimeoutMillis: 8000 });
  await src.connect();
  let rows;
  try {
    const params = [];
    let where = `c2='X' AND c3='D' AND trim(c4::text)='25'`;
    if (FROM) { params.push(FROM); where += ` AND c9::date >= $1`; }
    const q = await src.query(
      `SELECT c1 AS suc, c6 AS folio, c9::date AS fecha, c10 AS prov_code,
              c32 AS prov_nombre, c22 AS rfc, c24 AS concepto, c16 AS monto
         FROM md.kdm1 WHERE ${where}`, params);
    rows = q.rows;
  } finally { await src.end().catch(() => {}); }

  const staged = rows
    .filter((r) => r.suc && r.folio)
    .map((r) => [
      String(r.suc).trim(), String(r.folio).trim(), 'XD2501',
      r.fecha || null,
      (r.prov_code || '').trim() || null,
      (r.prov_nombre || '').trim() || null,
      (r.rfc || '').trim() || null,
      (r.concepto || '').trim() || null,
      money(r.monto),
      SOURCE_BRANCH,
    ]);

  const tot = staged.reduce((s, r) => s + r[8], 0);
  const conRfc = staged.filter((r) => r[6]).length;
  console.log(`  ${staged.length} pagos leídos ${FROM ? `(desde ${FROM}) ` : ''}· $${tot.toLocaleString('es-MX', { minimumFractionDigits: 2 })} · con RFC: ${conRfc}`);

  if (!APPLY) { console.log('\n[DRY-RUN] nada cambió. Corré con --apply para escribir.'); return; }
  if (!staged.length) { console.log('\n[APPLY] 0 pagos leídos (¿fuente caída?) — tabla intacta.'); return; }

  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE stg_pay (
      sucursal text, folio text, doc_prefix text, pago_date date, proveedor_code text,
      proveedor_nombre text, proveedor_rfc text, concepto text, monto numeric, source_branch text
    ) ON COMMIT DROP`);
    const NC = 10;
    for (let i = 0; i < staged.length; i += 1000) {
      const chunk = staged.slice(i, i + 1000);
      const vals = chunk.map((_, ri) => `(${Array.from({ length: NC }, (_, k) => `$${ri * NC + k + 1}`).join(',')})`);
      const params = [];
      chunk.forEach((row) => params.push(...row));
      await db.query(`INSERT INTO stg_pay (sucursal,folio,doc_prefix,pago_date,proveedor_code,proveedor_nombre,proveedor_rfc,concepto,monto,source_branch) VALUES ${vals.join(',')}`, params);
    }
    const up = await db.query(
      `INSERT INTO analytics.erp_supplier_payments AS t
         (tenant_id, sucursal, folio, doc_prefix, pago_date, proveedor_code, proveedor_nombre, proveedor_rfc, concepto, monto, source_branch, computed_at)
       SELECT $1, sucursal, folio, doc_prefix, pago_date, proveedor_code, proveedor_nombre, proveedor_rfc, concepto, monto, source_branch, now()
         FROM stg_pay
       ON CONFLICT (tenant_id, sucursal, folio) DO UPDATE SET
         doc_prefix=EXCLUDED.doc_prefix, pago_date=EXCLUDED.pago_date,
         proveedor_code=EXCLUDED.proveedor_code, proveedor_nombre=EXCLUDED.proveedor_nombre,
         proveedor_rfc=EXCLUDED.proveedor_rfc, concepto=EXCLUDED.concepto, monto=EXCLUDED.monto,
         source_branch=EXCLUDED.source_branch, computed_at=now()
       WHERE (t.pago_date, t.proveedor_code, t.proveedor_nombre, t.proveedor_rfc, t.concepto, t.monto)
             IS DISTINCT FROM
             (EXCLUDED.pago_date, EXCLUDED.proveedor_code, EXCLUDED.proveedor_nombre, EXCLUDED.proveedor_rfc, EXCLUDED.concepto, EXCLUDED.monto)`,
      [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} escritas (nuevas/cambiadas) de ${staged.length} en origen. Sin DELETE (ledger append-only).`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
