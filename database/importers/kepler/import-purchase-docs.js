/* eslint-disable no-console */
/**
 * ER.7 — Órdenes de compra (X-A-35) y Vales de entrada (X-A-37) → analytics.erp_purchase_docs.
 *
 * Cierra el hueco que el panel de ficha venía declarando: `erp_goods_receipts.oc_folio`
 * y `.vale_folio` eran texto suelto, sin documento detrás. Acá se traen los dos papeles
 * de arriba de la cadena para que se puedan ABRIR.
 *
 *   Requisición X-A-30 → **OC X-A-35** → **Vale X-A-37** → Orden entrada X-A-40 → Aplica X-A-20
 *
 * Decode verificado en vivo (CEDIS, 2026-08-20): los dos doctypes comparten shape en
 * kdm1/kdm2, y el vale trae `c31`='Val', `c37`='35' y `c39`= folio de SU orden de compra
 * (la OC trae `c31`='Ord' y c39 vacío). De ahí sale la liga OC↔vale, que es ESTRUCTURAL
 * —no heurística— y por eso vale la pena importarla.
 *
 * MULTI-SUCURSAL: recorre las DBs md_00..md_06 (mismo mapa que stock/recepciones).
 * GOTCHA anti-réplica: cada DB arrastra documentos de OTRAS sucursales → se filtra
 * siempre `h.c1 = <sucursal propia derivada de md_XX>`, si no la PK colisiona.
 * Skip-on-fail: la sucursal que no conecta se reporta y sus filas quedan intactas.
 * LAN: correr desde la máquina de feeds (Railway no alcanza las DBs de sucursal).
 *
 * RETIRADO donde el espejo ya es VISTA (mig 20260820200000, derive-no-copy sobre kepler_ods):
 * ahí no hay nada que copiar y este script sale sin hacer nada. Se conserva para las bases
 * sin ODS y como carga inicial. Motivo del retiro, medido: entre la corrida del importer y
 * dos horas después, Kepler ya tenía 12 documentos nuevos ($1.05M) que la copia no reflejaba.
 *
 * Idempotente: UPSERT-solo-cambios, sin DELETE.
 *
 *   node database/importers/kepler/import-purchase-docs.js            # dry-run
 *   node database/importers/kepler/import-purchase-docs.js --apply
 *   node database/importers/kepler/import-purchase-docs.js --apply --from 2026-01-01
 *   PURCHASE_DOCS_DAYS=7 node ...   # ventana rodante para el poller frecuente
 */

const path = require('path');
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const fromIx = process.argv.indexOf('--from');
let FROM = fromIx > -1 ? process.argv[fromIx + 1] : null;
if (!FROM && process.env.PURCHASE_DOCS_DAYS) {
  const d = new Date(); d.setDate(d.getDate() - Math.max(1, Number(process.env.PURCHASE_DOCS_DAYS) || 7));
  FROM = d.toISOString().slice(0, 10);
}

// c4 de Kepler → doc_prefix que guardamos (y que viaja en el ref del inspector).
const DOCTYPES = [
  { c4: '35', prefix: 'XA3501', label: 'orden de compra' },
  { c4: '37', prefix: 'XA3701', label: 'vale de entrada' },
];

const { stockMap } = require(path.resolve(__dirname, '../lib/kepler-branches'));
const MAP = process.env.PURCHASE_DOCS_BRANCH_MAP
  ? JSON.parse(process.env.PURCHASE_DOCS_BRANCH_MAP)
  : process.env.PURCHASE_DOCS_SRC
    ? [{ code: (process.env.PURCHASE_DOCS_SRC.match(/\/(md_\d+)/) || [])[1] || 'md_00', url: process.env.PURCHASE_DOCS_SRC }]
    : stockMap({ cedis: true });

const money = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; };
const txt = (v) => { const s = (v ?? '').toString().trim(); return s || null; };

async function readBranch(m) {
  const suc = (m.url.match(/md_(\d{2})\b/) || [])[1];
  if (!suc) { console.log(`  ⚠ ${m.code}: no pude derivar sucursal de la URL — skip`); return null; }
  let src;
  try {
    src = new Client({ connectionString: m.url, connectionTimeoutMillis: 8000, statement_timeout: 180000 });
    await src.connect();
  } catch (e) { console.log(`  ⚠ ${m.code}: sin conexión (${e.message}) — skip`); return null; }
  try {
    const heads = [];
    const lines = [];
    for (const dt of DOCTYPES) {
      const params = [suc, dt.c4];
      let where = `h.c2='X' AND h.c3='A' AND btrim(h.c4::text)=$2 AND btrim(h.c1::text)=$1`;
      if (FROM) { params.push(FROM); where += ` AND h.c9::date >= $3`; }
      const q = await src.query(
        `SELECT h.c1 AS suc, h.c6 AS folio, h.c9::date AS fecha, h.c18::date AS vence,
                h.c10 AS prov_code, h.c32 AS prov_nombre, h.c22 AS prov_rfc,
                h.c24 AS concepto, h.c30 AS condicion, h.c11 AS referencia,
                h.c16 AS monto, h.c37 AS ref_doctype, h.c39 AS ref_folio
           FROM md.kdm1 h
          WHERE ${where}`, params);
      const ql = await src.query(
        `SELECT h.c1 AS suc, h.c6 AS folio, l.c7 AS linea, l.c8 AS sku, l.c10 AS nombre,
                l.c9 AS cantidad, l.c11 AS unidad, l.c12 AS costo, l.c13 AS importe
           FROM md.kdm1 h
           JOIN md.kdm2 l ON l.c1=h.c1 AND l.c2=h.c2 AND l.c3=h.c3 AND l.c4=h.c4 AND l.c6=h.c6
          WHERE ${where}`, params);
      heads.push(...q.rows.map((x) => ({ ...x, __doctype: dt.prefix })));
      lines.push(...ql.rows.map((x) => ({ ...x, __doctype: dt.prefix })));
    }
    return { suc, heads, lines };
  } catch (e) {
    console.log(`  ⚠ ${m.code}: error en query (${e.message}) — skip`);
    return null;
  } finally { await src.end().catch(() => {}); }
}

(async () => {
  console.log(`\n=== OC (X-A-35) + Vales (X-A-37) → analytics.erp_purchase_docs (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
  console.log(`  sucursales: ${MAP.map((m) => m.code).join(', ')}${FROM ? ` · desde ${FROM}` : ''}\n`);

  const perBranch = [];
  const heads = [];
  const lines = [];
  for (const m of MAP) {
    const r = await readBranch(m);
    if (!r) { perBranch.push({ sucursal: m.code, estado: 'sin conexión', docs: 0, lineas: 0 }); continue; }
    heads.push(...r.heads.map((x) => ({ ...x, __branch: `md_${r.suc}` })));
    lines.push(...r.lines.map((x) => ({ ...x, __branch: `md_${r.suc}` })));
    perBranch.push({ sucursal: m.code, estado: 'OK', docs: r.heads.length, lineas: r.lines.length });
  }

  const byKey = new Map();
  for (const r of heads) {
    if (!r.suc || !r.folio) continue;
    byKey.set(`${r.__doctype}|${String(r.suc).trim()}|${String(r.folio).trim()}`, r);
  }
  const staged = [...byKey.values()].map((r) => [
    r.__doctype, String(r.suc).trim(), String(r.folio).trim(),
    r.fecha || null, r.vence || null,
    txt(r.prov_code), txt(r.prov_nombre), txt(r.prov_rfc),
    txt(r.concepto), txt(r.condicion), txt(r.referencia),
    money(r.monto), txt(r.ref_doctype), txt(r.ref_folio), r.__branch,
  ]);

  const lineByKey = new Map();
  for (const r of lines) {
    if (!r.suc || !r.folio || r.linea == null) continue;
    lineByKey.set(`${r.__doctype}|${String(r.suc).trim()}|${String(r.folio).trim()}|${String(r.linea).trim()}`, r);
  }
  const stagedLines = [...lineByKey.values()].map((r) => [
    r.__doctype, String(r.suc).trim(), String(r.folio).trim(), String(r.linea).trim(),
    txt(r.sku), txt(r.nombre), money(r.cantidad), txt(r.unidad), money(r.costo), money(r.importe),
  ]);

  console.log('\n  Resumen por sucursal:');
  console.table(perBranch);
  const byDt = {};
  for (const s of staged) { byDt[s[0]] = byDt[s[0]] || { n: 0, monto: 0 }; byDt[s[0]].n++; byDt[s[0]].monto += s[11]; }
  console.log('  Por doctype:', Object.entries(byDt).map(([k, v]) => `${k}:${v.n}/$${Math.round(v.monto).toLocaleString('es-MX')}`).join('  '));
  const valesConOc = staged.filter((s) => s[0] === 'XA3701' && s[13]).length;
  const totVales = staged.filter((s) => s[0] === 'XA3701').length;
  console.log(`  TOTAL ${staged.length} documentos · ${stagedLines.length} líneas · vales con OC ligada: ${valesConOc}/${totVales}`);

  if (!APPLY) { console.log('\n[DRY-RUN] nada cambió. Corré con --apply para escribir.'); return; }
  if (!staged.length) { console.log('\n[APPLY] 0 documentos leídos (¿fuentes caídas?) — tabla intacta.'); return; }

  const sink = require('../lib/sink');
  if (sink.sinkMode() === 'http') {
    const hRows = staged.map((s) => ({ k: 'h', doctype: s[0], sucursal: s[1], folio: s[2], doc_date: s[3], due_date: s[4], proveedor_code: s[5], proveedor_nombre: s[6], proveedor_rfc: s[7], concepto: s[8], condicion_pago: s[9], referencia: s[10], monto: s[11], ref_doctype: s[12], ref_folio: s[13], source_branch: s[14] }));
    const lRows = stagedLines.map((s) => ({ k: 'l', doctype: s[0], sucursal: s[1], folio: s[2], linea: s[3], sku: s[4], nombre: s[5], cantidad: s[6], unidad: s[7], costo_unitario: s[8], importe: s[9] }));
    const r = await sink.ship('erp-purchase-docs', { rows: [...hRows, ...lRows], tenantId: M });
    console.log(`\n[APPLY·http] ${r.rowCount} docs+líneas (nuevas/cambiadas) de ${staged.length}/${stagedLines.length} en origen${r.ms != null ? ` · ${r.ms}ms` : ''}.`);
    return;
  }

  const db = new Client({ connectionString: DST });
  await db.connect();
  // Si el destino ya es una VISTA sobre el ODS, no hay copia que mantener: escribirle
  // fallaría, y aunque no fallara sería volver a introducir el desfase que la vista quitó.
  const kind = await db.query(`SELECT relkind FROM pg_class WHERE oid = to_regclass('analytics.erp_purchase_docs')`);
  if (kind.rows[0] && kind.rows[0].relkind === 'v') {
    console.log('');
    console.log('[SKIP] analytics.erp_purchase_docs ya es una vista en vivo sobre kepler_ods — no hay nada que importar.');
    await db.end();
    return;
  }
  try {
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);

    await db.query(`CREATE TEMP TABLE stg_pd (
      doctype text, sucursal text, folio text, doc_date date, due_date date,
      proveedor_code text, proveedor_nombre text, proveedor_rfc text,
      concepto text, condicion_pago text, referencia text, monto numeric,
      ref_doctype text, ref_folio text, source_branch text
    ) ON COMMIT DROP`);
    const NC = 15;
    for (let i = 0; i < staged.length; i += 1000) {
      const chunk = staged.slice(i, i + 1000);
      const vals = chunk.map((_, ri) => `(${Array.from({ length: NC }, (_, k) => `$${ri * NC + k + 1}`).join(',')})`);
      const params = [];
      chunk.forEach((row) => params.push(...row));
      await db.query(`INSERT INTO stg_pd (doctype,sucursal,folio,doc_date,due_date,proveedor_code,proveedor_nombre,proveedor_rfc,concepto,condicion_pago,referencia,monto,ref_doctype,ref_folio,source_branch) VALUES ${vals.join(',')}`, params);
    }
    const up = await db.query(
      `INSERT INTO analytics.erp_purchase_docs AS t
         (tenant_id, doctype, sucursal, folio, doc_date, due_date, proveedor_code, proveedor_nombre,
          proveedor_rfc, concepto, condicion_pago, referencia, monto, ref_doctype, ref_folio, source_branch, computed_at)
       SELECT $1, doctype, sucursal, folio, doc_date, due_date, proveedor_code, proveedor_nombre,
              proveedor_rfc, concepto, condicion_pago, referencia, monto, ref_doctype, ref_folio, source_branch, now()
         FROM stg_pd
       ON CONFLICT (tenant_id, doctype, sucursal, folio) DO UPDATE SET
         doc_date=EXCLUDED.doc_date, due_date=EXCLUDED.due_date,
         proveedor_code=EXCLUDED.proveedor_code, proveedor_nombre=EXCLUDED.proveedor_nombre,
         proveedor_rfc=EXCLUDED.proveedor_rfc, concepto=EXCLUDED.concepto,
         condicion_pago=EXCLUDED.condicion_pago, referencia=EXCLUDED.referencia, monto=EXCLUDED.monto,
         ref_doctype=EXCLUDED.ref_doctype, ref_folio=EXCLUDED.ref_folio,
         source_branch=EXCLUDED.source_branch, computed_at=now()
       WHERE (t.doc_date, t.due_date, t.proveedor_code, t.proveedor_nombre, t.proveedor_rfc, t.concepto,
              t.condicion_pago, t.referencia, t.monto, t.ref_doctype, t.ref_folio)
             IS DISTINCT FROM
             (EXCLUDED.doc_date, EXCLUDED.due_date, EXCLUDED.proveedor_code, EXCLUDED.proveedor_nombre,
              EXCLUDED.proveedor_rfc, EXCLUDED.concepto, EXCLUDED.condicion_pago, EXCLUDED.referencia,
              EXCLUDED.monto, EXCLUDED.ref_doctype, EXCLUDED.ref_folio)`,
      [M]);

    await db.query(`CREATE TEMP TABLE stg_pdl (
      doctype text, sucursal text, folio text, linea text, sku text, nombre text,
      cantidad numeric, unidad text, costo_unitario numeric, importe numeric
    ) ON COMMIT DROP`);
    const NLC = 10;
    for (let i = 0; i < stagedLines.length; i += 1000) {
      const chunk = stagedLines.slice(i, i + 1000);
      const vals = chunk.map((_, ri) => `(${Array.from({ length: NLC }, (_, k) => `$${ri * NLC + k + 1}`).join(',')})`);
      const params = [];
      chunk.forEach((row) => params.push(...row));
      await db.query(`INSERT INTO stg_pdl (doctype,sucursal,folio,linea,sku,nombre,cantidad,unidad,costo_unitario,importe) VALUES ${vals.join(',')}`, params);
    }
    const upl = await db.query(
      `INSERT INTO analytics.erp_purchase_doc_lines AS t
         (tenant_id, doctype, sucursal, folio, linea, sku, nombre, cantidad, unidad, costo_unitario, importe, computed_at)
       SELECT $1, doctype, sucursal, folio, linea, sku, nombre, cantidad, unidad, costo_unitario, importe, now()
         FROM stg_pdl
       ON CONFLICT (tenant_id, doctype, sucursal, folio, linea) DO UPDATE SET
         sku=EXCLUDED.sku, nombre=EXCLUDED.nombre, cantidad=EXCLUDED.cantidad, unidad=EXCLUDED.unidad,
         costo_unitario=EXCLUDED.costo_unitario, importe=EXCLUDED.importe, computed_at=now()
       WHERE (t.sku, t.nombre, t.cantidad, t.unidad, t.costo_unitario, t.importe)
             IS DISTINCT FROM
             (EXCLUDED.sku, EXCLUDED.nombre, EXCLUDED.cantidad, EXCLUDED.unidad, EXCLUDED.costo_unitario, EXCLUDED.importe)`,
      [M]);

    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} documentos + ${upl.rowCount} líneas (nuevas/cambiadas) de ${staged.length}/${stagedLines.length} en origen. Sin DELETE.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
