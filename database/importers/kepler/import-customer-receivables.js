/* eslint-disable no-console */
/**
 * Fase CXC — Cartera de clientes → analytics.customer_receivables (espejo read-only).
 *
 * Reproduce el `Reporte de partidas vivas` de Kepler (Crédito y cobranza) leyendo
 * `md.kdue` de cada sucursal (md_01..06). `kdue` guarda facturas (c29='C') Y sus
 * aplicaciones (c29='A') como filas separadas → el saldo se COMPUTA:
 *   saldo_cliente = Σ(c11 · signo)   signo = +1 si c29='C', -1 si c29='A'
 * VERIFICADO: cuadra al peso vs el PDF real (suc 01, grupo 1M001, 8/8 clientes).
 *
 * Universo CxC (excluye contado UD10 — neto 0, no es cuenta por cobrar):
 *   cargo:  c29='C' AND c4 IN (8,12,13)   (Factura Telemarketing / venta crédito)
 *   abono:  c29='A' AND c4 IN (7,21,25)   (Cobro CFDI / Nota Créd-Dev / Devolución)
 *
 * NO toca Kepler (solo SELECT). Idempotente: UPSERT-solo-cambios, sin DELETE.
 *
 *   node database/importers/kepler/import-customer-receivables.js            # dry-run
 *   node database/importers/kepler/import-customer-receivables.js --apply    # commit
 *   node database/importers/kepler/import-customer-receivables.js --apply --branch 01
 */
const { Client } = require('pg');
const { salesMap, clientConfig } = require('../lib/kepler-branches');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
// --local: lee los replicas lógicos locales kepler_md_0X (@ :5433) en vez de los POS
// remotos. Útil para test offline y para la máquina de feeds (tiene los replicas al día).
const LOCAL = process.argv.includes('--local');
const REPLICA_BASE = process.env.KEPLER_REPLICA_BASE || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const bIx = process.argv.indexOf('--branch');
const ONLY_BRANCH = bIx > -1 ? process.argv[bIx + 1] : null;
// Sucursales con cartera CxC (crédito por rama). CEDIS '00' se excluye: centraliza
// la cobranza en otra representación (UA05) que duplicaría (ver import-collections).
const localUrl = (code) => { const u = new URL(REPLICA_BASE); u.pathname = `/kepler_md_${code}`; return u.toString(); };
const BRANCHES = salesMap({ cedis: false })
  .filter((b) => !ONLY_BRANCH || b.code === ONLY_BRANCH)
  .map((b) => (LOCAL ? { ...b, url: localUrl(b.code) } : b));

/** Clasifica el documento por (c29, c4). Etiquetas = las del reporte Kepler. */
const classify = (ca, grupo) => {
  const g = Number(grupo);
  if (ca === 'C') {
    if (g === 8) return ['factura', 'Factura Telemarketing'];
    if (g === 12 || g === 13) return ['factura', 'Venta crédito'];
    return ['otro', 'Cargo'];
  }
  if (g === 7) return ['cobro', 'Cobro CFDI'];
  if (g === 21) return ['nota_credito', 'Nota Créd/Dev'];
  if (g === 25) return ['devolucion', 'Devolución'];
  return ['otro', 'Abono'];
};

const pad2 = (v) => String(v == null ? '' : v).trim().padStart(2, '0');

(async () => {
  console.log(`\n=== Cartera CxC Kepler (md.kdue) → analytics.customer_receivables (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
  console.log(`  sucursales: ${BRANCHES.map((b) => b.code).join(', ')}\n`);

  const staged = [];
  for (const b of BRANCHES) {
    const src = new Client(clientConfig(b, { statement_timeout: 120000 }));
    try {
      await src.connect();
      const q = await src.query(
        `SELECT c1 suc, c2 cliente, c4 grupo, c5 serie, c6 folio, c7::date fecha,
                CASE WHEN c29='C' THEN c10::date END vence,
                c11::numeric importe, c8 moneda, c16 referencia, c18 vendedor,
                c28 genero, c29 ca
           FROM md.kdue
          WHERE (c29='C' AND trim(c4::text) IN ('8','12','13'))
             OR (c29='A' AND trim(c4::text) IN ('7','21','25'))`);
      for (const r of q.rows) {
        const [tipo, label] = classify(r.ca, r.grupo);
        const docCode = `${(r.genero || '').trim()}${(r.ca || '').trim()}${pad2(r.grupo)}${pad2(r.serie)}`;
        const suc = String(r.suc || '').trim();
        const folio = String(r.folio || '').trim();
        if (!suc || !folio) continue;
        const importe = Number(r.importe) || 0;
        staged.push([
          suc, docCode, tipo, label, folio,
          `${suc}${docCode}-${folio}`,
          (r.cliente || '').trim() || null,
          r.fecha || null, r.vence || null,
          importe, r.ca, r.ca === 'C' ? importe : -importe,
          (r.referencia || '').trim() || null,
          (r.vendedor || '').trim() || null,
          (r.moneda || '').trim() || null,
          b.db || `md_${b.code}`,
        ]);
      }
      console.log(`  ${b.code} (${b.name}): ${q.rows.length} filas`);
    } catch (e) {
      console.error(`  ${b.code}: ERROR ${e.message}`);
    } finally {
      await src.end().catch(() => {});
    }
  }

  const cargos = staged.filter((r) => r[10] === 'C');
  const abonos = staged.filter((r) => r[10] === 'A');
  const saldo = staged.reduce((s, r) => s + r[11], 0);
  console.log(`\n  total: ${staged.length} filas · cargos ${cargos.length} / abonos ${abonos.length}`);
  console.log(`  saldo neto CxC: $${saldo.toLocaleString('es-MX', { minimumFractionDigits: 2 })}`);

  if (!APPLY) { console.log('\n[DRY-RUN] nada cambió. Corré con --apply para escribir.'); return; }
  if (!staged.length) { console.log('\n[APPLY] 0 filas (¿fuente caída?) — tabla intacta.'); return; }

  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE stg_cxc (
      sucursal text, doc_code text, doc_tipo text, doc_label text, folio text, folio_digital text,
      cliente_code text, fecha date, vencimiento date, importe numeric, cargo_abono char(1),
      signed_amount numeric, referencia text, vendedor text, moneda text, source_branch text
    ) ON COMMIT DROP`);
    const NC = 16;
    for (let i = 0; i < staged.length; i += 1000) {
      const chunk = staged.slice(i, i + 1000);
      const vals = chunk.map((_, ri) => `(${Array.from({ length: NC }, (_, k) => `$${ri * NC + k + 1}`).join(',')})`);
      const params = [];
      chunk.forEach((row) => params.push(...row));
      await db.query(
        `INSERT INTO stg_cxc (sucursal,doc_code,doc_tipo,doc_label,folio,folio_digital,cliente_code,fecha,vencimiento,importe,cargo_abono,signed_amount,referencia,vendedor,moneda,source_branch) VALUES ${vals.join(',')}`,
        params);
    }
    const up = await db.query(
      `INSERT INTO analytics.customer_receivables AS t
         (tenant_id, sucursal, doc_code, doc_tipo, doc_label, folio, folio_digital, cliente_code,
          fecha, vencimiento, importe, cargo_abono, signed_amount, referencia, vendedor, moneda, source_branch, computed_at)
       SELECT $1, sucursal, doc_code, doc_tipo, doc_label, folio, folio_digital, cliente_code,
              fecha, vencimiento, importe, cargo_abono, signed_amount, referencia, vendedor, moneda, source_branch, now()
         FROM stg_cxc
       ON CONFLICT (tenant_id, sucursal, doc_code, folio) DO UPDATE SET
         doc_tipo=EXCLUDED.doc_tipo, doc_label=EXCLUDED.doc_label, folio_digital=EXCLUDED.folio_digital,
         cliente_code=EXCLUDED.cliente_code, fecha=EXCLUDED.fecha, vencimiento=EXCLUDED.vencimiento,
         importe=EXCLUDED.importe, cargo_abono=EXCLUDED.cargo_abono, signed_amount=EXCLUDED.signed_amount,
         referencia=EXCLUDED.referencia, vendedor=EXCLUDED.vendedor, moneda=EXCLUDED.moneda,
         source_branch=EXCLUDED.source_branch, computed_at=now()
       WHERE (t.cliente_code, t.fecha, t.vencimiento, t.importe, t.signed_amount, t.referencia, t.vendedor)
             IS DISTINCT FROM
             (EXCLUDED.cliente_code, EXCLUDED.fecha, EXCLUDED.vencimiento, EXCLUDED.importe, EXCLUDED.signed_amount, EXCLUDED.referencia, EXCLUDED.vendedor)`,
      [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} escritas (nuevas/cambiadas) de ${staged.length}. Sin DELETE (ledger append-only).`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
