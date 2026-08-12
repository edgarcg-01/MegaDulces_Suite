/* eslint-disable no-console */
/**
 * Fase CC — Cobros de Kepler → analytics.erp_collections (espejo read-only).
 *
 * Lee los documentos de COBRANZA de Kepler (`Collect1` / serie `UA0501` =
 * U-A-5-1 "Cobro PUE", asiento C 102 Bancos / A 115 Clientes) desde el
 * encabezado `md.kdm1` y los refleja en `analytics.erp_collections`. Es la lista
 * de la que el capturista elige el cobro para adjuntarle la ficha de depósito.
 * NO toca Kepler (solo SELECT) ni crea cobros.
 *
 * Fuente = CEDIS md_00 (centraliza la cobranza de la red; `(suc,folio)` único).
 * Filtro exacto: c2='U' (género) AND c3='A' (naturaleza abono) AND c4=5 (grupo).
 * Idempotente: UPSERT-solo-cambios, sin DELETE (ledger append-only).
 *
 *   node database/importers/kepler/import-collections.js            # dry-run
 *   node database/importers/kepler/import-collections.js --apply    # commit
 *   node database/importers/kepler/import-collections.js --apply --from 2026-01-01
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const SRC = process.env.COLLECTIONS_SRC || 'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00';
const APPLY = process.argv.includes('--apply');
const fromIx = process.argv.indexOf('--from');
// Ventana rodante para la corrida agendada (COLLECTIONS_DAYS=120 → últimos N días, rápido,
// UPSERT churn-free). Sin la env ni --from = todo el histórico.
const COLLECTIONS_DAYS = Number(process.env.COLLECTIONS_DAYS) || 0;
const FROM = fromIx > -1 ? process.argv[fromIx + 1]
  : (COLLECTIONS_DAYS > 0 ? new Date(Date.now() - COLLECTIONS_DAYS * 864e5).toISOString().slice(0, 10) : null);
const SOURCE_BRANCH = (SRC.match(/\/(md_\d+)/) || [])[1] || 'md_00';

/** Clasifica la cuenta del cobro por el código Kepler (c10). Heurístico. */
const tipoCuenta = (code) => {
  const s = String(code || '').trim();
  if (/^(RUTA|R\.?[DV]\.?|R[DV][\s\-0-9])/i.test(s)) return 'ruta';
  if (/^\d{2}-\d{2}/.test(s)) return 'interno';
  return 'cliente_final';
};

/** Deriva la forma de pago del concepto (c24). Los depósitos/transferencias son los que llevan ficha. */
const formaPago = (concepto) => {
  const s = String(concepto || '').toUpperCase();
  if (/DEP[OÓ]SITO|DEPOSITO|\bDEP\b/.test(s)) return 'deposito';
  if (/TRANSFER|SPEI/.test(s)) return 'transferencia';
  if (/TARJETA|TARJ|TDC|TDD/.test(s)) return 'tarjeta';
  if (/EFECTIVO|EFVO|EFECTICO/.test(s)) return 'efectivo';
  if (/CHEQUE|\bCHQ\b/.test(s)) return 'cheque';
  return 'otro';
};

(async () => {
  console.log(`\n=== Cobros Kepler (${SOURCE_BRANCH}, UA0501) → analytics.erp_collections (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

  const src = new Client({ connectionString: SRC });
  await src.connect();
  let rows;
  try {
    const params = [];
    let where = `c2='U' AND c3='A' AND trim(c4::text)='5'`;
    if (FROM) { params.push(FROM); where += ` AND c9::date >= $1`; }
    const q = await src.query(
      `SELECT c1 AS suc, c6 AS folio, c9::date AS fecha, c10 AS cliente_code,
              c24 AS concepto, c16::numeric AS monto, c32 AS nombre
         FROM md.kdm1 WHERE ${where}`, params);
    rows = q.rows;
  } finally { await src.end().catch(() => {}); }

  const staged = rows
    .filter((r) => r.suc && r.folio)
    .map((r) => [
      String(r.suc).trim(), String(r.folio).trim(), 'UA0501',
      r.fecha || null,
      (r.cliente_code || '').trim() || null,
      (r.nombre || '').trim() || null,
      (r.concepto || '').trim() || null,
      formaPago(r.concepto),
      Number(r.monto) || 0,
      tipoCuenta(r.cliente_code),
      SOURCE_BRANCH,
    ]);

  // Resumen
  const by = (arr, ix) => arr.reduce((m, r) => { m[r[ix]] = (m[r[ix]] || 0) + 1; return m; }, {});
  const money = staged.reduce((s, r) => s + r[8], 0);
  console.log(`  ${staged.length} cobros leídos ${FROM ? `(desde ${FROM}) ` : ''}· $${money.toLocaleString('es-MX', { minimumFractionDigits: 2 })}`);
  console.log(`  por tipo_cuenta:`, by(staged, 9));
  console.log(`  por forma_pago:`, by(staged, 7));

  if (!APPLY) { console.log('\n[DRY-RUN] nada cambió. Corré con --apply para escribir.'); return; }
  if (!staged.length) { console.log('\n[APPLY] 0 cobros leídos (¿fuente caída?) — tabla intacta.'); return; }

  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE stg_coll (
      sucursal text, folio text, doc_prefix text, cobro_date date, cliente_code text,
      cliente_nombre text, concepto text, forma_pago text, monto numeric, tipo_cuenta text, source_branch text
    ) ON COMMIT DROP`);
    const NC = 11;
    for (let i = 0; i < staged.length; i += 1000) {
      const chunk = staged.slice(i, i + 1000);
      const vals = chunk.map((_, ri) => `(${Array.from({ length: NC }, (_, k) => `$${ri * NC + k + 1}`).join(',')})`);
      const params = [];
      chunk.forEach((row) => params.push(...row));
      await db.query(`INSERT INTO stg_coll (sucursal,folio,doc_prefix,cobro_date,cliente_code,cliente_nombre,concepto,forma_pago,monto,tipo_cuenta,source_branch) VALUES ${vals.join(',')}`, params);
    }
    const up = await db.query(
      `INSERT INTO analytics.erp_collections AS t
         (tenant_id, sucursal, folio, doc_prefix, cobro_date, cliente_code, cliente_nombre, concepto, forma_pago, monto, tipo_cuenta, source_branch, computed_at)
       SELECT $1, sucursal, folio, doc_prefix, cobro_date, cliente_code, cliente_nombre, concepto, forma_pago, monto, tipo_cuenta, source_branch, now()
         FROM stg_coll
       ON CONFLICT (tenant_id, sucursal, folio) DO UPDATE SET
         doc_prefix=EXCLUDED.doc_prefix, cobro_date=EXCLUDED.cobro_date,
         cliente_code=EXCLUDED.cliente_code, cliente_nombre=EXCLUDED.cliente_nombre,
         concepto=EXCLUDED.concepto, forma_pago=EXCLUDED.forma_pago, monto=EXCLUDED.monto,
         tipo_cuenta=EXCLUDED.tipo_cuenta, source_branch=EXCLUDED.source_branch, computed_at=now()
       WHERE (t.cobro_date, t.cliente_code, t.cliente_nombre, t.concepto, t.forma_pago, t.monto, t.tipo_cuenta)
             IS DISTINCT FROM
             (EXCLUDED.cobro_date, EXCLUDED.cliente_code, EXCLUDED.cliente_nombre, EXCLUDED.concepto, EXCLUDED.forma_pago, EXCLUDED.monto, EXCLUDED.tipo_cuenta)`,
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
