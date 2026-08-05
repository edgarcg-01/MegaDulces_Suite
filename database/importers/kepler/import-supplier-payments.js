/* eslint-disable no-console */
/**
 * Fase CC (extensión) — Pagos a proveedor de Kepler → analytics.erp_supplier_payments.
 *
 * Lee los PAGOS A PROVEEDOR (cargo a la cuenta 201) desde el encabezado `md.kdm1` y
 * los refleja en `analytics.erp_supplier_payments`. Es la lista de la que el capturista
 * elige el pago para adjuntarle el comprobante (transferencia SPEI / cheque escaneado).
 * NO toca Kepler (solo SELECT) ni crea pagos.
 *
 * DECODE verificado en vivo (2026-08-04, con comprobantes BBVA reales de CONVERMEX):
 * `c31` = FORMA/TIPO DE PAGO. El dinero que sale al proveedor vive en TRES doctypes:
 *   · XD2601  c31='Tra'  TRANSFERENCIA   (16,164 docs / $338M) ← el 96% de los pagos
 *   · XD2501  c31='Che'  CHEQUE          (   623 docs / $42.5M)
 *   · XD6001  c31='Ant'  ANTICIPO        (   147 docs / $11.8M) ← adelanto a proveedor
 * El espejo original leía solo XD2501 (cheques). Los otros X-D-* NO son pago: XD5501=nota
 * de crédito/devolución/descuento, XD4001=devolución, XD1001=solicitud ($0) → se excluyen.
 *
 * Alcance = PAGO A PROVEEDOR (compra): `c10 LIKE 'C%'` (Mondelez CM009, Convermex CG028,
 * Ferrero, Pepsico, Bolsas…). Se EXCLUYEN los `G%` (nómina GN, caja chica GG, banco GB,
 * gastos/servicios) — eso es dominio de Egresos (GX), no "pago a proveedor".
 *
 * OJO PK: el folio `c6` NO es único entre los doctypes (623 folios en XD2501 y XD2601). El
 * espejo lleva `doc_prefix` en la PK y el staging deduplica por (suc, doc_prefix, folio).
 *
 * Fuente = CEDIS md_00 (centraliza los pagos). Idempotente: UPSERT-solo-cambios, sin
 * DELETE (ledger append-only). `--reset` limpia el tenant una vez (cambió el alcance de
 * doctypes: la primera corrida tras esta corrección debe resetear).
 *
 *   node database/importers/kepler/import-supplier-payments.js                    # dry-run
 *   node database/importers/kepler/import-supplier-payments.js --apply            # commit
 *   node database/importers/kepler/import-supplier-payments.js --apply --reset    # limpia+recarga
 *   node database/importers/kepler/import-supplier-payments.js --apply --from 2026-01-01
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const SRC = process.env.PAYMENTS_SRC || 'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00';
const APPLY = process.argv.includes('--apply');
const RESET = process.argv.includes('--reset');
const fromIx = process.argv.indexOf('--from');
const FROM = fromIx > -1 ? process.argv[fromIx + 1] : null;
const SOURCE_BRANCH = (SRC.match(/\/(md_\d+)/) || [])[1] || 'md_00';

/** Parseo defensivo de importe (un row basura no debe abortar todo el import). */
const money = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; };
/** c31 → método/tipo normalizado (Tra=transferencia, Che=cheque, Ant=anticipo). */
const metodo = (c31) => { const v = String(c31 ?? '').trim().toLowerCase(); return v.startsWith('tra') ? 'transferencia' : v.startsWith('che') ? 'cheque' : v.startsWith('ant') ? 'anticipo' : null; };
/** grupo (c4) → doc_prefix. */
const docPrefix = (grupo) => { const g = String(grupo).trim(); return g === '26' ? 'XD2601' : g === '60' ? 'XD6001' : 'XD2501'; };

(async () => {
  console.log(`\n=== Pagos a proveedor Kepler (${SOURCE_BRANCH}, XD2601 Tra + XD2501 Che + XD6001 Ant, c10~C%) → analytics.erp_supplier_payments (${APPLY ? (RESET ? 'APPLY+RESET' : 'APPLY') : 'DRY-RUN'}) ===\n`);

  const src = new Client({ connectionString: SRC, connectionTimeoutMillis: 8000 });
  await src.connect();
  let rows;
  try {
    const params = [];
    // c2='X' género, c3='D' naturaleza (egreso), c4 IN (25 cheque, 26 transferencia, 60 anticipo).
    // c10 LIKE 'C%' = proveedor de compra (excluye nómina GN, caja chica GG, banco GB, gastos G*).
    let where = `c2='X' AND c3='D' AND trim(c4::text) IN ('25','26','60') AND btrim(c10::text) ILIKE 'C%'`;
    if (FROM) { params.push(FROM); where += ` AND c9::date >= $1`; }
    const q = await src.query(
      `SELECT c1 AS suc, c6 AS folio, trim(c4::text) AS grupo, c31 AS metodo_raw,
              c9::date AS fecha, c10 AS prov_code, c32 AS prov_nombre, c22 AS rfc,
              c24 AS concepto, c16 AS monto, c84 AS descuento
         FROM md.kdm1 WHERE ${where}`, params);
    rows = q.rows;
  } finally { await src.end().catch(() => {}); }

  // dedupe defensivo por (suc, doc_prefix, folio) — la PK del espejo
  const seen = new Set();
  const staged = [];
  for (const r of rows) {
    if (!r.suc || !r.folio) continue;
    const suc = String(r.suc).trim();
    const folio = String(r.folio).trim();
    const dp = docPrefix(r.grupo);
    const key = `${suc}|${dp}|${folio}`;
    if (seen.has(key)) continue;
    seen.add(key);
    staged.push([
      suc, folio, dp, metodo(r.metodo_raw),
      r.fecha || null,
      (r.prov_code || '').trim() || null,
      (r.prov_nombre || '').trim() || null,
      (r.rfc || '').trim() || null,
      (r.concepto || '').trim() || null,
      money(r.monto),
      money(r.descuento),
      SOURCE_BRANCH,
    ]);
  }

  const tot = staged.reduce((s, r) => s + r[9], 0);
  const totDesc = staged.reduce((s, r) => s + r[10], 0);
  const conDesc = staged.filter((r) => r[10] > 0).length;
  const nTra = staged.filter((r) => r[3] === 'transferencia').length;
  const nChe = staged.filter((r) => r[3] === 'cheque').length;
  const nAnt = staged.filter((r) => r[3] === 'anticipo').length;
  const conRfc = staged.filter((r) => r[7]).length;
  console.log(`  ${staged.length} pagos ${FROM ? `(desde ${FROM}) ` : ''}· $${tot.toLocaleString('es-MX', { minimumFractionDigits: 2 })} · transferencia: ${nTra} · cheque: ${nChe} · anticipo: ${nAnt} · con RFC: ${conRfc}`);
  console.log(`  descuento capturado (c84): ${conDesc} pagos (${(100 * conDesc / (staged.length || 1)).toFixed(1)}%) · $${totDesc.toLocaleString('es-MX', { minimumFractionDigits: 2 })}`);

  if (!APPLY) { console.log('\n[DRY-RUN] nada cambió. Corré con --apply para escribir.'); return; }
  if (!staged.length) { console.log('\n[APPLY] 0 pagos leídos (¿fuente caída?) — tabla intacta.'); return; }

  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    if (RESET) {
      const del = await db.query(`DELETE FROM analytics.erp_supplier_payments WHERE tenant_id = $1`, [M]);
      console.log(`  [RESET] ${del.rowCount} filas previas borradas (cambió el alcance de doctypes).`);
    }
    await db.query(`CREATE TEMP TABLE stg_pay (
      sucursal text, folio text, doc_prefix text, metodo_pago text, pago_date date, proveedor_code text,
      proveedor_nombre text, proveedor_rfc text, concepto text, monto numeric, descuento numeric, source_branch text
    ) ON COMMIT DROP`);
    const NC = 12;
    for (let i = 0; i < staged.length; i += 1000) {
      const chunk = staged.slice(i, i + 1000);
      const vals = chunk.map((_, ri) => `(${Array.from({ length: NC }, (_, k) => `$${ri * NC + k + 1}`).join(',')})`);
      const params = [];
      chunk.forEach((row) => params.push(...row));
      await db.query(`INSERT INTO stg_pay (sucursal,folio,doc_prefix,metodo_pago,pago_date,proveedor_code,proveedor_nombre,proveedor_rfc,concepto,monto,descuento,source_branch) VALUES ${vals.join(',')}`, params);
    }
    const up = await db.query(
      `INSERT INTO analytics.erp_supplier_payments AS t
         (tenant_id, sucursal, folio, doc_prefix, metodo_pago, pago_date, proveedor_code, proveedor_nombre, proveedor_rfc, concepto, monto, descuento, source_branch, computed_at)
       SELECT $1, sucursal, folio, doc_prefix, metodo_pago, pago_date, proveedor_code, proveedor_nombre, proveedor_rfc, concepto, monto, descuento, source_branch, now()
         FROM stg_pay
       ON CONFLICT (tenant_id, sucursal, doc_prefix, folio) DO UPDATE SET
         metodo_pago=EXCLUDED.metodo_pago, pago_date=EXCLUDED.pago_date,
         proveedor_code=EXCLUDED.proveedor_code, proveedor_nombre=EXCLUDED.proveedor_nombre,
         proveedor_rfc=EXCLUDED.proveedor_rfc, concepto=EXCLUDED.concepto, monto=EXCLUDED.monto,
         descuento=EXCLUDED.descuento, source_branch=EXCLUDED.source_branch, computed_at=now()
       WHERE (t.metodo_pago, t.pago_date, t.proveedor_code, t.proveedor_nombre, t.proveedor_rfc, t.concepto, t.monto, t.descuento)
             IS DISTINCT FROM
             (EXCLUDED.metodo_pago, EXCLUDED.pago_date, EXCLUDED.proveedor_code, EXCLUDED.proveedor_nombre, EXCLUDED.proveedor_rfc, EXCLUDED.concepto, EXCLUDED.monto, EXCLUDED.descuento)`,
      [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} escritas (nuevas/cambiadas) de ${staged.length} en origen.${RESET ? '' : ' Sin DELETE (ledger append-only).'}`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
