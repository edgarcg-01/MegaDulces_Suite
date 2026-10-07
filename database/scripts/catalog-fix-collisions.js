/**
 * Reconciliador de COLISIONES DE CLAVE en catalog.products (Kepler reusa claves).
 *
 * `import-catalog-bulk.js` matchea productos por NOMBRE (no por SKU), así que cuando Kepler
 * reasigna una clave a otro producto (ej. 99040: ACEITE NUTRIOLI → CUBETA MANTECA DE CERDO),
 * el nombre en nuestro catálogo queda STALE — y arrastra a la etiquetera, existencias, reportes.
 *
 * Este script detecta esos casos y refresca el nombre desde Kepler SOLO cuando es una colisión
 * REAL: primera palabra distinta Y **cero palabras significativas en común** (producto totalmente
 * distinto). El churn cosmético (typos, prefijos como "IND ") y las claves promo se dejan. En las
 * colisiones reales, si el barcode del catálogo es un EAN que Kepler ya no tiene para esa clave,
 * se limpia (queda stale, apunta al producto viejo). Por-fila con savepoint: si un refresh choca
 * con el unique (tenant, brand_id, nombre) se salta y se reporta.
 *
 *   node database/scripts/catalog-fix-collisions.js            # DRY-RUN
 *   node database/scripts/catalog-fix-collisions.js --apply    # aplica
 *
 * Fuentes: DATABASE_URL_NEW (Railway) + KEPLER_URL (kp.* concentrada .245).
 */
require('../../node_modules/dotenv').config({ path: __dirname + '/../importers/wincaja/sync.local.env', override: true });
const { Client } = require('../../node_modules/pg');
const APPLY = process.argv.includes('--apply');
if (!/rlwy\.net|railway/.test(process.env.DATABASE_URL_NEW || '')) { console.error('ABORT: DATABASE_URL_NEW no es Railway.'); process.exit(1); }
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const rw = new Client({ connectionString: process.env.DATABASE_URL_NEW, ssl: { rejectUnauthorized: false } });
const kp = new Client({ connectionString: process.env.KEPLER_URL || 'postgresql://postgres:superoot@192.168.0.245:5432/KP_CONCENTRADA', connectionTimeoutMillis: 8000 });

const norm = (s) => String(s || '').trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const fw = (s) => norm(s).split(/[\s/]+/)[0];
const isEan = (c) => /^\d{8}$|^\d{12}$|^\d{13}$/.test(String(c || '').trim());
const promo = (s) => /GRATIS|=|\$|%|X\s?2|2X1|3X2|DCTO|PEGAR/.test(norm(s));
// Placeholder / marcador: no refrescar un nombre real con un "* DESCONTINUADO"/"DUPLICADO"/"." de Kepler.
const placeholder = (s) => { const u = norm(s); return u.length < 3 || /^[.*\-]+$/.test(u) || /DESCONTINUAD|DUPLICAD/.test(u); };
const STOP = new Set(['DE', 'LA', 'EL', 'CON', 'SIN', 'GR', 'KG', 'ML', 'LT', 'PZA', 'PAQ', 'CJA', 'IND', 'CJ', 'CJS', 'BLS', 'EXH', 'Y', 'A', 'S', 'VIT', 'CAR', 'CH', 'CHOC', 'PAL', 'GOMA']);
const toks = (s) => new Set(norm(s).split(/[\s/.\-,()]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
const overlap = (a, b) => { const A = toks(a), B = toks(b); let n = 0; for (const x of A) if (B.has(x)) n++; return n; };

(async () => {
  await rw.connect(); await kp.connect();
  console.log(`\n=== Reconciliador de colisiones de clave (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
  const cat = (await rw.query(`SELECT btrim(sku) sku, nombre, barcode FROM catalog.products WHERE tenant_id=$1 AND activo AND btrim(coalesce(sku,''))<>''`, [T])).rows;
  const kep = new Map((await kp.query(`SELECT DISTINCT ON (btrim(c1)) btrim(c1) sku, btrim(c2) nombre, btrim(c7) bc, btrim(coalesce(c95,'')) bc2 FROM kp.kdii WHERE btrim(coalesce(c1,''))<>'' ORDER BY btrim(c1)`)).rows.map((r) => [r.sku, r]));

  const seen = new Set(), targets = [];
  for (const c of cat) {
    if (seen.has(c.sku)) continue; seen.add(c.sku);
    const k = kep.get(c.sku); if (!k) continue;
    if (fw(c.nombre) === fw(k.nombre)) continue;
    if (promo(c.nombre) || promo(k.nombre) || placeholder(k.nombre)) continue;
    if (overlap(c.nombre, k.nombre) !== 0) continue;
    const clearBc = isEan(c.barcode) && c.barcode !== k.bc && c.barcode !== k.bc2;
    targets.push({ sku: c.sku, from: c.nombre, to: k.nombre, clearBc });
  }
  console.log(`Colisiones reales detectadas: ${targets.length}`);
  targets.forEach((m) => console.log(`  ${m.sku}  "${String(m.from).slice(0, 30)}" → "${String(m.to).slice(0, 30)}"${m.clearBc ? ' [bc→null]' : ''}`));
  if (!targets.length) { console.log('\nNada que reconciliar.'); await rw.end(); await kp.end(); return; }
  if (!APPLY) { console.log('\nDRY-RUN. Corré con --apply para aplicar.'); await rw.end(); await kp.end(); return; }

  await rw.query('BEGIN');
  await rw.query(`SET LOCAL app.tenant_id = '${T}'`);
  let ok = 0; const skipped = [];
  for (const m of targets) {
    try {
      await rw.query('SAVEPOINT s');
      await rw.query(m.clearBc
        ? `UPDATE catalog.products SET nombre=$2, barcode=NULL, updated_at=now() WHERE tenant_id=$1 AND btrim(sku)=$3`
        : `UPDATE catalog.products SET nombre=$2, updated_at=now() WHERE tenant_id=$1 AND btrim(sku)=$3`, [T, m.to, m.sku]);
      await rw.query('RELEASE SAVEPOINT s'); ok++;
    } catch (e) {
      await rw.query('ROLLBACK TO SAVEPOINT s');
      skipped.push({ sku: m.sku, err: e.message.split('\n')[0] });
    }
  }
  await rw.query('COMMIT');
  console.log(`\n[APPLY] COMMIT — corregidas: ${ok} · saltadas (constraint único): ${skipped.length}`);
  skipped.forEach((s) => console.log(`  ⏭  ${s.sku}: ${s.err.slice(0, 60)}`));
  await rw.end(); await kp.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
