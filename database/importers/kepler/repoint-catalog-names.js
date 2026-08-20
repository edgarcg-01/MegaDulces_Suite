/* eslint-disable no-console */
/**
 * RR/catálogo — REPOINT de identidad: corrige el NOMBRE (y la marca de esa clave) de las claves que
 * Kepler REUSA por campaña, que quedaban stale en `catalog.products` porque `catalog-bulk`
 * lee el snapshot EXTERNO `Mega_Dulces.catalogo_completo` (se atrasa) y su INSERT salta las
 * claves ya existentes (guard por sku). Fuente FRESCA = `KP_CONCENTRADA.kp.kdii` (la refresca
 * concentrate-kepler.js c/4h desde las 6 sucursales vivas).
 *
 * Diseño **UPDATE-only, egress-mínimo** (a propósito, para no gastar ancho de banda de Railway):
 *   - NO borra, NO inserta. Solo `UPDATE ... WHERE sku=... AND nombre difiere`.
 *   - No baja el catálogo al cliente: empuja la identidad fresca a una TEMP en el destino
 *     (ingress barato) y hace UN solo UPDATE server-side con join por sku. El único egress
 *     es el mapa de marcas (~cientos) + el rowcount final.
 *   - Guard anti-colisión contra la unique (brand_id, nombre): si el nuevo par ya existe en
 *     otra fila activa, esa fila se deja como está (no rompe la constraint).
 *
 *   SRC_URL = KP_CONCENTRADA (default .245)  ·  DST_URL / DATABASE_URL_NEW = destino (prod)
 *   node database/importers/kepler/repoint-catalog-names.js            # dry-run (cuenta)
 *   node database/importers/kepler/repoint-catalog-names.js --apply
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const SRC = process.env.SRC_URL || process.env.KP_CONCENTRADA_URL || 'postgresql://postgres:superoot@192.168.0.245:5432/KP_CONCENTRADA';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
// CANON.1.3 — fuente por default `ods`: kepler_ods.kdii en el MISMO Postgres de prod. Reconciliación
// retail-first (excluir CEDIS '00' + fallback a CEDIS si el SKU no tiene retail) → identidad de tienda,
// no de mayoreo (evita traer barcode/línea del CEDIS). El nombre es idéntico entre sucursales (0 diffs).
const SOURCE = (process.argv.find((a) => a.startsWith('--source=')) || '').split('=')[1] || 'ods';
const KSCHEMA = SOURCE === 'ods' ? 'kepler_ods' : 'kp';
const APPLY = process.argv.includes('--apply');
const clean = (v) => { const s = (v == null ? '' : String(v)).trim(); return s === '' ? null : s; };

(async () => {
  const dst = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await dst.connect();
  const useOds = SOURCE === 'ods';
  const src = useOds ? null : new Client({ connectionString: SRC, connectionTimeoutMillis: 8000, statement_timeout: 120000 });
  const readSrc = useOds ? dst : src;
  try {
    console.log(`\n=== REPOINT nombres de catálogo (${useOds ? 'kepler_ods' : 'KP_CONCENTRADA'} → prod, UPDATE-only) (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
    if (!useOds) {
      try { await src.connect(); }
      catch (e) { console.error(`❌ sin conexión a KP_CONCENTRADA (${e.message}) — abortando`); process.exitCode = 1; return; }
    }

    // identidad fresca por sku, retail-first (excluir CEDIS '00'; fallback a CEDIS si no hay retail).
    const fresh = (await readSrc.query(`
      WITH retail AS (
        SELECT DISTINCT ON (btrim(c1)) btrim(c1) AS sku, btrim(c2) AS nombre, btrim(c3::text) AS linea, btrim(coalesce(c7,'')) AS barcode
          FROM ${KSCHEMA}.kdii WHERE btrim(coalesce(c1,'')) <> '' AND btrim(coalesce(c2,'')) <> '' AND btrim(sucursal) <> '00'
          ORDER BY btrim(c1), c90::numeric DESC NULLS LAST),
      cedis AS (
        SELECT DISTINCT ON (btrim(c1)) btrim(c1) AS sku, btrim(c2) AS nombre, btrim(c3::text) AS linea, btrim(coalesce(c7,'')) AS barcode
          FROM ${KSCHEMA}.kdii WHERE btrim(coalesce(c1,'')) <> '' AND btrim(coalesce(c2,'')) <> '' AND btrim(sucursal) = '00'
          ORDER BY btrim(c1), c90::numeric DESC NULLS LAST)
      SELECT sku, nombre, linea, barcode FROM retail
      UNION ALL
      SELECT c.sku, c.nombre, c.linea, c.barcode FROM cedis c WHERE NOT EXISTS (SELECT 1 FROM retail r WHERE r.sku=c.sku)`)).rows;
    console.log(`  ${KSCHEMA}.kdii: ${fresh.length} SKUs`);

    // mapa marca (código Kepler línea → brand_id) — único egress notable, ~cientos de filas
    const brandsByCode = new Map(
      (await dst.query(`SELECT btrim(code) AS code, id FROM catalog.brands WHERE tenant_id=$1 AND deleted_at IS NULL`, [M])).rows
        .map((b) => [b.code, b.id]));

    let payload = fresh.map((r) => ({
      sku: r.sku, nombre: r.nombre, barcode: clean(r.barcode),
      brand_id: brandsByCode.get(clean(r.linea)) || null,
    })).filter((r) => r.sku && r.nombre);
    // dedupe intra-lote por (brand_id, nombre): dos SKUs distintos con idéntico par colisionarían
    // ENTRE SÍ en la unique al actualizarse en el mismo statement (el guard NOT EXISTS solo ve el
    // estado previo). Con brand_id nulo cada fila conserva su marca actual → no aplica.
    const seenBN = new Set();
    payload = payload.filter((r) => {
      if (!r.brand_id) return true;
      const k = `${r.brand_id}|${r.nombre.toUpperCase()}`;
      if (seenBN.has(k)) return false; seenBN.add(k); return true;
    });

    await dst.query('BEGIN');
    await dst.query(`SET LOCAL app.tenant_id = '${M}'`);
    await dst.query(`CREATE TEMP TABLE tmp_fresh (sku text, nombre text, barcode text, brand_id uuid) ON COMMIT DROP`);
    const BATCH = 1000;
    for (let i = 0; i < payload.length; i += BATCH) {
      const chunk = payload.slice(i, i + BATCH);
      const vals = chunk.map((_, ri) => `($${ri * 4 + 1},$${ri * 4 + 2},$${ri * 4 + 3},$${ri * 4 + 4})`);
      const params = [];
      for (const r of chunk) params.push(r.sku, r.nombre, r.barcode, r.brand_id);
      await dst.query(`INSERT INTO tmp_fresh (sku, nombre, barcode, brand_id) VALUES ${vals.join(',')}`, params);
    }

    // predicado: fila activa cuyo NOMBRE difiere y NO colisiona con la unique (tenant, brand_id, nombre).
    // CANON.1.3b — el gate se mantiene por NOMBRE (el brand_id se actualiza junto al nombre por COALESCE;
    // reasignar marca en cambios name-igual movía ~500 filas sin validar → diferido a análisis propio).
    // NO se escribe barcode aquí: es único-escritor de import-label-data (valida c7 + rescata c95); el
    // c7 crudo de este feed es basura para ~1184 SKUs → escribirlo REGRESARÍA barcodes buenos (medido).
    // Guard anti-colisión que ESPEJA la unique FULL (tenant, brand_id, nombre) — mira TODAS las filas.
    const WHERE = `
      p.tenant_id=$1 AND p.deleted_at IS NULL AND p.sku=t.sku
      AND btrim(upper(p.nombre)) <> btrim(upper(t.nombre))
      AND NOT EXISTS (SELECT 1 FROM catalog.products p2
           WHERE p2.tenant_id=$1 AND p2.id<>p.id
             AND p2.brand_id = COALESCE(t.brand_id, p.brand_id)
             AND p2.nombre = t.nombre)`;

    const willCount = Number((await dst.query(
      `SELECT count(*)::int n FROM catalog.products p JOIN tmp_fresh t ON t.sku=p.sku WHERE ${WHERE}`, [M])).rows[0].n);
    console.log(`  a corregir (nombre difiere, sin colisión): ${willCount} filas`);

    if (!APPLY) { await dst.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); return; }

    const res = await dst.query(`
      UPDATE catalog.products p SET
        nombre = t.nombre,
        brand_id = COALESCE(t.brand_id, p.brand_id),
        updated_at = now()
      FROM tmp_fresh t WHERE ${WHERE}`, [M]);
    await dst.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${res.rowCount} identidades corregidas (nombre/marca; UPDATE-only). Barcode = label-data.`);
  } catch (e) {
    await dst.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    if (src) await src.end().catch(() => {});
    await dst.end().catch(() => {});
  }
})();
