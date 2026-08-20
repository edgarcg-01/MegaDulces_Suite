/* eslint-disable no-console */
/**
 * Catálogo — REPOINT de PRESENCIA (existencia + activación) desde KP_CONCENTRADA.
 *
 * Problema: el catálogo (`catalog.products`) se llena de `Mega_Dulces.catalogo_completo`
 * (.245), un snapshot EXTERNO que se ATRASA → productos nuevos en Kepler quedan invisibles
 * y productos reactivados quedan borrados. En cambio el PRECIO ya sale de KP_CONCENTRADA
 * (kp.kdii, fresca ~cada 10-40 min). Este feed cierra el hueco del CATÁLOGO desde la MISMA
 * fuente fresca: hermano de `repoint-catalog-names.js` (nombre) y `repoint-catalog-prices.js`
 * (precio). Los tres juntos = catálogo al día sin depender del snapshot atrasado.
 *
 * Hace (server-side, egress mínimo, tenant-scoped):
 *   1) INSERT de SKUs vivos en kp.kdii que NO existen en catalog.products.
 *   2) REACTIVATE (deleted_at=NULL) de SKUs borrados en la plataforma pero vivos en Kepler.
 *
 * Filtros de calidad (NO meter basura):
 *   - c90 > 0.05  → precio real (excluye marcadores de promo $0.01/$0.05).
 *   - nombre no vacío y NOT ILIKE '%DESCONTINUADO%' → la línea 999 de Kepler es el bucket de
 *     descontinuados ("* DESCONTINUADO"); esos NO entran.
 * NO desactiva nada (la señal de "baja" en Kepler es ambigua; hacerlo escondería productos).
 * Marca: c3 → catalog.brands.code; sin marca → fallback "SIN LÍNEA" (igual que catalog-bulk).
 * Anti-colisión: respeta la unique (tenant, brand_id, nombre) y no reactiva si ya hay gemelo activo.
 *
 *   SRC_URL = KP_CONCENTRADA (default .245)  ·  DST_URL / DATABASE_URL_NEW = destino (prod)
 *   node database/importers/kepler/repoint-catalog-presence.js            # dry-run (cuenta)
 *   node database/importers/kepler/repoint-catalog-presence.js --apply
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const SRC = process.env.SRC_URL || process.env.KP_CONCENTRADA_URL || 'postgresql://postgres:superoot@192.168.0.245:5432/KP_CONCENTRADA';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
// CANON.1.3 — fuente por default `ods`: kepler_ods.kdii en el MISMO Postgres de prod. Reconciliación
// retail-first (excluir CEDIS '00' + fallback a CEDIS si el SKU no tiene retail). Fallback `--source=kp`.
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
    console.log(`\n=== REPOINT presencia de catálogo (${useOds ? 'kepler_ods' : 'KP_CONCENTRADA'} → prod) (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
    if (!useOds) {
      try { await src.connect(); }
      catch (e) { console.error(`❌ sin conexión a KP_CONCENTRADA (${e.message}) — abortando`); process.exitCode = 1; return; }
    }

    // Productos vivos frescos por sku, retail-first (excluir CEDIS '00'; fallback a CEDIS si no hay
    // retail). Excluye promos (c90>0.05), descontinuados y placeholders "***".
    const QF = `btrim(coalesce(c1,'')) <> '' AND btrim(coalesce(c2,'')) <> '' AND c90::numeric > 0.05
          AND btrim(c2) NOT ILIKE '%DESCONTINUADO%' AND btrim(c2) !~ '^[*[:space:]]+$'`;
    const fresh = (await readSrc.query(`
      WITH retail AS (
        SELECT DISTINCT ON (btrim(c1)) btrim(c1) AS sku, btrim(c2) AS nombre, btrim(c3::text) AS linea, btrim(coalesce(c7,'')) AS barcode
          FROM ${KSCHEMA}.kdii WHERE ${QF} AND btrim(sucursal) <> '00'
          ORDER BY btrim(c1), c90::numeric DESC),
      cedis AS (
        SELECT DISTINCT ON (btrim(c1)) btrim(c1) AS sku, btrim(c2) AS nombre, btrim(c3::text) AS linea, btrim(coalesce(c7,'')) AS barcode
          FROM ${KSCHEMA}.kdii WHERE ${QF} AND btrim(sucursal) = '00'
          ORDER BY btrim(c1), c90::numeric DESC)
      SELECT sku, nombre, linea, barcode FROM retail
      UNION ALL
      SELECT c.sku, c.nombre, c.linea, c.barcode FROM cedis c WHERE NOT EXISTS (SELECT 1 FROM retail r WHERE r.sku=c.sku)`)).rows;
    console.log(`  ${KSCHEMA}.kdii vivos (precio real, no descontinuados): ${fresh.length} SKUs`);

    // mapa marca (código Kepler línea → brand_id) — único egress notable
    const brandsByCode = new Map(
      (await dst.query(`SELECT btrim(code) AS code, id FROM catalog.brands WHERE tenant_id=$1 AND deleted_at IS NULL`, [M])).rows
        .map((b) => [b.code, b.id]));

    // Fallback SIN-LINEA (igual que catalog-bulk): productos sin marca válida ENTRAN igual.
    let FALLBACK = brandsByCode.get('SIN-LINEA') || null;
    if (!FALLBACK && APPLY) {
      FALLBACK = (await dst.query(
        `INSERT INTO catalog.brands (id, tenant_id, code, nombre, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'SIN-LINEA', 'SIN LÍNEA', now(), now())
         ON CONFLICT DO NOTHING RETURNING id`, [M])).rows[0]?.id
        || (await dst.query(`SELECT id FROM catalog.brands WHERE tenant_id=$1 AND code='SIN-LINEA' LIMIT 1`, [M])).rows[0]?.id;
      if (FALLBACK) { brandsByCode.set('SIN-LINEA', FALLBACK); console.log('  marca fallback "SIN LÍNEA" lista'); }
    }

    let payload = fresh.map((r) => ({
      sku: r.sku, nombre: r.nombre, barcode: clean(r.barcode),
      brand_id: brandsByCode.get(clean(r.linea)) || FALLBACK || null,
    })).filter((r) => r.sku && r.nombre && r.brand_id); // sin brand_id (ni fallback en dry-run) no se puede insertar
    const sinBrand = fresh.length - payload.length;
    if (sinBrand > 0) console.log(`  (${sinBrand} sin marca resoluble${APPLY ? '' : ' — en dry-run sin fallback creado'}))`);

    await dst.query('BEGIN');
    await dst.query(`SET LOCAL app.tenant_id = '${M}'`);
    await dst.query(`CREATE TEMP TABLE tmp_pres (sku text, nombre text, barcode text, brand_id uuid) ON COMMIT DROP`);
    const BATCH = 1000;
    for (let i = 0; i < payload.length; i += BATCH) {
      const chunk = payload.slice(i, i + BATCH);
      const vals = chunk.map((_, ri) => `($${ri * 4 + 1},$${ri * 4 + 2},$${ri * 4 + 3},$${ri * 4 + 4})`);
      const params = [];
      for (const r of chunk) params.push(r.sku, r.nombre, r.barcode, r.brand_id);
      await dst.query(`INSERT INTO tmp_pres (sku, nombre, barcode, brand_id) VALUES ${vals.join(',')}`, params);
    }

    // (1) REACTIVAR: borrado en la plataforma, vivo en KP, SIN gemelo activo del mismo sku,
    //     y sin colisión con la unique (brand_id, nombre) de otra fila activa.
    const REACT_WHERE = `
      p.tenant_id=$1 AND p.deleted_at IS NOT NULL AND p.sku=t.sku
      AND NOT EXISTS (SELECT 1 FROM catalog.products a WHERE a.tenant_id=$1 AND a.sku=t.sku AND a.deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM catalog.products c WHERE c.tenant_id=$1 AND c.deleted_at IS NULL
                        AND c.brand_id=p.brand_id AND c.nombre=p.nombre AND c.id<>p.id)`;
    const reactN = Number((await dst.query(
      `SELECT count(DISTINCT p.id)::int n FROM catalog.products p JOIN tmp_pres t ON t.sku=p.sku WHERE ${REACT_WHERE}`, [M])).rows[0].n);

    // (2) INSERTAR: sku en KP sin NINGUNA fila (activa ni borrada) en el catálogo,
    //     y cuyo (brand_id, nombre) no colisione con una fila activa existente.
    // La unique (tenant, brand_id, nombre) es COMPLETA (incluye borradas) → el guard mira TODAS
    // las filas, no solo activas (si no, un nombre+marca ya usado por una borrada rompe el INSERT).
    const INS_WHERE = `
      NOT EXISTS (SELECT 1 FROM catalog.products p WHERE p.tenant_id=$1 AND p.sku=t.sku)
      AND NOT EXISTS (SELECT 1 FROM catalog.products p2 WHERE p2.tenant_id=$1
                        AND p2.brand_id=t.brand_id AND p2.nombre=t.nombre)`;
    // count por (brand_id, nombre) distinto: la unique (tenant,brand_id,nombre) solo admite uno.
    const insN = Number((await dst.query(
      `SELECT count(*)::int n FROM (SELECT DISTINCT t.brand_id, t.nombre FROM tmp_pres t WHERE ${INS_WHERE}) x`, [M])).rows[0].n);

    console.log(`  a REACTIVAR (borrado→vivo): ${reactN}`);
    console.log(`  a INSERTAR (nuevo): ${insN}`);

    if (!APPLY) { await dst.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); return; }

    const r1 = await dst.query(
      `UPDATE catalog.products p SET deleted_at=NULL, updated_at=now()
         FROM tmp_pres t WHERE ${REACT_WHERE}`, [M]);
    // DISTINCT ON (brand_id, nombre): dos SKUs distintos con idéntico nombre+marca colisionarían
    // ENTRE SÍ en la unique dentro del mismo INSERT → se queda el sku más bajo, el otro se omite.
    const r2 = await dst.query(
      `INSERT INTO catalog.products (id, tenant_id, brand_id, sku, nombre, barcode, created_at, updated_at)
       SELECT gen_random_uuid(), $1, d.brand_id, d.sku, d.nombre, NULLIF(d.barcode,''), now(), now()
         FROM (
           SELECT DISTINCT ON (t.brand_id, t.nombre) t.brand_id, t.sku, t.nombre, t.barcode
             FROM tmp_pres t WHERE ${INS_WHERE}
            ORDER BY t.brand_id, t.nombre, t.sku
         ) d`, [M]);
    await dst.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${r1.rowCount} reactivados + ${r2.rowCount} insertados. (precio/uom/costo los enriquecen sus feeds)`);
  } catch (e) {
    await dst.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    if (src) await src.end().catch(() => {});
    await dst.end().catch(() => {});
  }
})();
