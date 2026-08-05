/* eslint-disable no-console */
/**
 * Fase RE — Ajustes de compra de Kepler (X-D-40 + X-D-55) → analytics.erp_purchase_adjustments.
 *
 * Lee de `md.kdm1` los dos doctypes que explican el descuadre Factura-vs-Compra y
 * capturan los descuentos de proveedor (verificado con 3 PDFs, 2026-08-05):
 *   - X-D-40 "Devolución compra"  → OPERACIONAL (faltante/no-solicitado/mal-estado).  Sin IVA.
 *   - X-D-55 "Nota crédito"       → mayormente COMERCIAL (descuento/pronto pago/apoyo). Con IVA (c82).
 * El MOTIVO vive en `c24` (texto libre). El doctype NO es el clasificador → se
 * categoriza por keyword sobre el motivo (Haiku afinará los tersos en RE.2/RE.10).
 * Campos: c6=folio, c9=fecha, c10=prov code, c32=prov nombre, c22=RFC, c11=ref factura,
 * c39=folio entrada (cuando existe), c16=monto, c82=IVA, c24=motivo.
 * NO toca Kepler (solo SELECT). Idempotente: UPSERT-solo-cambios, sin DELETE.
 *
 *   node database/importers/kepler/import-purchase-adjustments.js            # dry-run
 *   node database/importers/kepler/import-purchase-adjustments.js --apply    # commit
 *   node database/importers/kepler/import-purchase-adjustments.js --apply --from 2026-01-01
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const SRC = process.env.ADJ_SRC || 'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00';
const APPLY = process.argv.includes('--apply');
const fromIx = process.argv.indexOf('--from');
const FROM = fromIx > -1 ? process.argv[fromIx + 1] : '2026-01-01';
const SOURCE_BRANCH = (SRC.match(/\/(md_\d+)/) || [])[1] || 'md_00';

const money = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; };
const DOCTYPE = { 40: 'XD40', 55: 'XD55' };

// Clasificador de motivo (c24). Verificado sobre X-D-40 + X-D-55 (2026-08-05, muestra
// de los motivos reales incl. el bucket "otro"). Orden: operacional (recepción física)
// → error de captura → comercial (descuentos/apoyos). El doctype NO clasifica; el motivo sí.
function categorize(m) {
  const s = String(m || '').toUpperCase();
  if (!s.trim()) return null; // sin motivo
  // Operacional (recepción física)
  if (/NO SE SOLICIT|NO SOLICIT/.test(s)) return 'no_solicitado';
  if (/MAL ESTADO|DA[ÑN]AD|CADUC|ROTO|PONCH|PES[OÓ] DE MENOS|MALTRAT/.test(s)) return 'mal_estado';
  if (/FALT/.test(s)) return 'faltante';
  if (/CAMBIAD|EQUIVOC|LLEGO CAMB|NO TRA[IÍ]A/.test(s)) return 'cambiada';
  // Error de captura / facturación (NO es descuento — no inflar el canal comercial)
  if (/DUPLICAD|FACTURAS DOBLES|COMPRAS DOBLES|DOBLE FACTUR/.test(s)) return 'factura_duplicada';
  if (/DIFERENCIA (EN|DE) (MONTO|PRECIO)|DIF\.? (MONTO|PRECIO)|MAL APLICAD/.test(s)) return 'diferencia_monto';
  // Comercial (descuentos / apoyos / rebates)
  if (/PRONTO PAGO|\bPP\b|%\s?PP|PP\s?\d/.test(s)) return 'pronto_pago';
  if (/APOYO|MKT|MARKETING|MERCADOTECNIA/.test(s)) return 'apoyo_marca';
  if (/RAPPEL|INCENTIVO|PROMOCION|\bPROMO\b|NEGOCIAD/.test(s)) return 'descuento_comercial';
  if (/DESCUENTO|DESCEUNTO|DESCUETO|DESCUNTO|DESCTO|\bDESC\b|\bDTO\b|PLAN|PAQUETE|GRANEL|BONIF|\d\s?%/.test(s)) return 'descuento_comercial';
  if (/SALDO A FAVOR/.test(s)) return 'saldo_favor';
  if (/DEVOL|REGRES/.test(s)) return 'devolucion_otra';
  return 'otro';
}

(async () => {
  console.log(`\n=== Ajustes de compra Kepler (${SOURCE_BRANCH}, X-D-40 + X-D-55) → analytics.erp_purchase_adjustments (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

  const src = new Client({ connectionString: SRC, connectionTimeoutMillis: 8000 });
  await src.connect();
  let rows;
  try {
    const q = await src.query(
      `SELECT trim(c4::text) AS dt, c1 AS suc, c6 AS folio, c9::date AS fecha,
              c10 AS prov_code, c32 AS prov_nombre, c22 AS prov_rfc,
              NULLIF(btrim(c11),'') AS factura_ref, NULLIF(btrim(c39),'') AS entrada_folio,
              c16 AS monto, c82 AS iva, c24 AS motivo
         FROM md.kdm1
        WHERE c2='X' AND c3='D' AND trim(c4::text) IN ('40','55') AND c9::date >= $1`,
      [FROM]);
    rows = q.rows;
  } finally { await src.end().catch(() => {}); }

  // Dedupe por (doctype, suc, folio) — el folio NO es único entre doctypes.
  const byKey = new Map();
  for (const r of rows) {
    if (!DOCTYPE[r.dt] || !r.suc || !r.folio) continue;
    byKey.set(`${r.dt}|${String(r.suc).trim()}|${String(r.folio).trim()}`, r);
  }
  const staged = [...byKey.values()].map((r) => {
    const motivo = (r.motivo || '').toString().replace(/\s+/g, ' ').trim() || null;
    const cat = categorize(motivo);
    // source='keyword' solo cuando la regla dio una categoría específica; 'otro'/blank
    // quedan sin source para que el enriquecimiento (llm/doctype_default) los tome.
    const catSource = cat && cat !== 'otro' ? 'keyword' : null;
    return [
      DOCTYPE[r.dt], String(r.suc).trim(), String(r.folio).trim(),
      r.fecha || null,
      (r.prov_code || '').trim() || null,
      (r.prov_nombre || '').trim() || null,
      (r.prov_rfc || '').trim() || null,
      (r.factura_ref || '').trim() || null,
      (r.entrada_folio || '').trim() || null,
      money(r.monto), money(r.iva),
      motivo, cat, catSource, SOURCE_BRANCH,
    ];
  });

  // Resumen por doctype + categoría (para verificar el dry-run contra el análisis).
  const byCat = {};
  let tot = 0;
  for (const r of staged) {
    const key = `${r[0]}/${r[12] || '(sin motivo)'}`;
    byCat[key] = byCat[key] || { n: 0, monto: 0 };
    byCat[key].n += 1; byCat[key].monto += r[9]; tot += r[9];
  }
  console.log(`  ${staged.length} ajustes leídos (desde ${FROM}) · $${tot.toLocaleString('es-MX', { minimumFractionDigits: 2 })}`);
  console.log('  por doctype/categoría:');
  Object.entries(byCat).sort((a, b) => b[1].monto - a[1].monto).forEach(([k, v]) => {
    console.log(`    ${k.padEnd(28)} ${String(v.n).padStart(5)}  $${Math.round(v.monto).toLocaleString('en-US')}`);
  });

  if (!APPLY) { console.log('\n[DRY-RUN] nada cambió. Corré con --apply para escribir.'); return; }
  if (!staged.length) { console.log('\n[APPLY] 0 ajustes leídos (¿fuente caída?) — tabla intacta.'); return; }

  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE stg_pa (
      doctype text, sucursal text, folio text, adjustment_date date, proveedor_code text,
      proveedor_nombre text, proveedor_rfc text, factura_ref text, entrada_folio text,
      monto numeric, iva numeric, motivo text, categoria text, categoria_source text, source_branch text
    ) ON COMMIT DROP`);
    const NC = 15;
    for (let i = 0; i < staged.length; i += 1000) {
      const chunk = staged.slice(i, i + 1000);
      const vals = chunk.map((_, ri) => `(${Array.from({ length: NC }, (_, k) => `$${ri * NC + k + 1}`).join(',')})`);
      const params = [];
      chunk.forEach((row) => params.push(...row));
      await db.query(`INSERT INTO stg_pa (doctype,sucursal,folio,adjustment_date,proveedor_code,proveedor_nombre,proveedor_rfc,factura_ref,entrada_folio,monto,iva,motivo,categoria,categoria_source,source_branch) VALUES ${vals.join(',')}`, params);
    }
    const up = await db.query(
      `INSERT INTO analytics.erp_purchase_adjustments AS t
         (tenant_id, doctype, sucursal, folio, adjustment_date, proveedor_code, proveedor_nombre, proveedor_rfc, factura_ref, entrada_folio, monto, iva, motivo, categoria, categoria_source, source_branch, computed_at)
       SELECT $1, doctype, sucursal, folio, adjustment_date, proveedor_code, proveedor_nombre, proveedor_rfc, factura_ref, entrada_folio, monto, iva, motivo, categoria, categoria_source, source_branch, now()
         FROM stg_pa
       ON CONFLICT (tenant_id, doctype, sucursal, folio) DO UPDATE SET
         adjustment_date=EXCLUDED.adjustment_date, proveedor_code=EXCLUDED.proveedor_code,
         proveedor_nombre=EXCLUDED.proveedor_nombre, proveedor_rfc=EXCLUDED.proveedor_rfc,
         factura_ref=EXCLUDED.factura_ref, entrada_folio=EXCLUDED.entrada_folio,
         monto=EXCLUDED.monto, iva=EXCLUDED.iva, motivo=EXCLUDED.motivo,
         -- preserva el enriquecimiento (llm/doctype_default); el keyword sí se refresca.
         categoria = CASE WHEN t.categoria_source IN ('llm','doctype_default') THEN t.categoria ELSE EXCLUDED.categoria END,
         categoria_source = CASE WHEN t.categoria_source IN ('llm','doctype_default') THEN t.categoria_source ELSE EXCLUDED.categoria_source END,
         source_branch=EXCLUDED.source_branch, computed_at=now()
       WHERE (t.adjustment_date, t.proveedor_code, t.proveedor_nombre, t.proveedor_rfc, t.factura_ref, t.entrada_folio, t.monto, t.iva, t.motivo)
             IS DISTINCT FROM
             (EXCLUDED.adjustment_date, EXCLUDED.proveedor_code, EXCLUDED.proveedor_nombre, EXCLUDED.proveedor_rfc, EXCLUDED.factura_ref, EXCLUDED.entrada_folio, EXCLUDED.monto, EXCLUDED.iva, EXCLUDED.motivo)`,
      [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} ajustes (nuevos/cambiados) de ${staged.length} en origen. Sin DELETE (ledger append-only).`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
