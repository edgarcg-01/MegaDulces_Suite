/* eslint-disable no-console */
/**
 * NORM (Fase 1.6, interino) — `inventory.products_active` desde `catalog.products` (maestra fresca),
 * NO desde el FDW legacy `erp.productos_activos` (stale/dormido → productos nuevos/reactivados
 * quedaban invisibles; ej. 00281/00295 no aparecían aunque estaban vivos en Kepler con precio+stock).
 *
 * Mantiene `products_active` como TABLA (0 riesgo para los ~6 lectores: search/pricing/portal/
 * ticket-extractor/AI-matcher — no toca RLS ni contexto de tenant). Refresca por TRUNCATE+INSERT
 * de los activos del catálogo. La conversión a VISTA `security_invoker` (Fase 1.6 completa) queda
 * para la sesión enfocada (requiere análisis de contexto-tenant de cada lector).
 *
 * Con --reactivate: además reactiva el DRIFT (source=kepler vivos en kepler_ods, activo=false, no
 * borrados, no DESCONTINUADO) → productos vivos en el ERP vuelven a estar activos.
 *
 *   node database/importers/refresh-products-active.js               # dry-run (cuenta)
 *   node database/importers/refresh-products-active.js --apply       # refresca products_active
 *   node database/importers/refresh-products-active.js --apply --reactivate   # + reactiva el drift
 */
const { Client } = require('pg');
const fs = require('fs');
// [NORM.2] Latido + piso. Este script refresca por TRUNCATE+INSERT una tabla que leen ~9
// consumidores (buscador, pricing, portal, extractor de tickets, AI-matcher) y NO ESTABA AGENDADO.
const hb = require('./lib/cron-heartbeat');
const HB_KEY = 'products_active_refresh';
const HB_LABEL = 'inventory.products_active ← catalog (NORM 1.6)';
// PISO ANTI-VACIADO. El TRUNCATE+INSERT va dentro de UNA transacción, así que un fallo del INSERT
// no puede dejar la tabla vacía — eso ya estaba bien. Lo que NO estaba cubierto es el caso en que
// el origen devuelve legítimamente MUY POCO (un `catalog.products` a medio poblar tras un fallo
// aguas arriba): ahí la transacción commitea una tabla casi vacía y los 9 lectores dejan de
// encontrar productos, sin ningún error. El piso convierte eso en una corrida que ABORTA y late
// en rojo. Medido el 2026-09-23: 9,772 actuales → 9,920 nuevos, o sea el régimen normal crece.
const PISO_FRAC = Number(process.env.PRODUCTS_ACTIVE_MIN_FRAC || 0.5);
const M = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
// OJO: el default DATABASE_URL_NEW (.env) apunta a la copia LOCAL stale (localhost:5433).
// --prod resuelve la URL Railway desde el runner en runtime (NUNCA imprime credenciales).
function prodUrl() {
  const t = fs.readFileSync('C:/KeplerRunner/run-feeds.cmd', 'utf8');
  for (const m of t.matchAll(/(postgres(?:ql)?:\/\/[^\s"']+)/gi)) {
    try { const u = new URL(m[1]); if (/rlwy|railway|proxy/i.test(u.host)) return m[1]; } catch { /* skip */ }
  }
  throw new Error('no encontré URL Railway en el runner');
}
const DST = process.argv.includes('--prod') ? prodUrl()
  : (process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })());
const APPLY = process.argv.includes('--apply');
const REACT = process.argv.includes('--reactivate');

const REACT_WHERE = `p.tenant_id=$1 AND p.source='kepler' AND p.deleted_at IS NULL AND p.activo=false
  AND p.nombre NOT ILIKE '%DESCONTINUADO%'
  AND EXISTS (SELECT 1 FROM kepler_ods.kdii k WHERE btrim(k.c1)=p.sku AND btrim(coalesce(k.c2,'')) <> '')`;

(async () => {
  // Sólo late lo que ESCRIBE: un dry-run no reclama entrega.
  if (APPLY) await hb.begin(HB_KEY, HB_LABEL);
  const c = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false, statement_timeout: 120000 });
  await c.connect();
  try {
    console.log(`\n=== refresh products_active desde catalog.products (${APPLY ? 'APPLY' : 'DRY-RUN'}${REACT ? ' +reactivate' : ''}) ===\n`);

    const reactN = Number((await c.query(`SELECT count(*)::int n FROM catalog.products p WHERE ${REACT_WHERE}`, [M])).rows[0].n);
    console.log(`  drift a reactivar (kepler vivo, activo=false, no descontinuado): ${reactN}`);
    const activos = Number((await c.query(`SELECT count(*)::int n FROM catalog.products WHERE tenant_id=$1 AND activo AND deleted_at IS NULL AND btrim(coalesce(sku,''))<>''`, [M])).rows[0].n);
    const paActual = Number((await c.query(`SELECT count(*)::int n FROM inventory.products_active`)).rows[0].n);
    console.log(`  catalog activos con sku: ${activos}  ·  products_active actual (congelada): ${paActual}`);
    console.log(`  → products_active quedaría con ${REACT ? activos + reactN : activos} filas (activos${REACT ? ' + reactivados' : ''})`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    // El piso corre ANTES de abrir la transacción: abortar es más barato que hacer rollback, y
    // sobre todo deja el motivo en el latido en vez de en un rollback mudo.
    const destino = REACT ? activos + reactN : activos;
    const minimo = Math.floor(paActual * PISO_FRAC);
    if (paActual > 0 && destino < minimo) {
      const msg = `PISO: el origen daría ${destino} filas y la tabla tiene ${paActual} `
        + `(mínimo ${minimo} = ${PISO_FRAC * 100}%). Se ABORTA sin tocar nada — un TRUNCATE con el `
        + `origen a medio poblar deja sin productos a los 9 lectores, y en silencio. `
        + `Si la caída es legítima: PRODUCTS_ACTIVE_MIN_FRAC=<frac>.`;
      console.error(`\n⛔ ${msg}`);
      await hb.end(HB_KEY, { status: 'error', error: msg.slice(0, 400) });
      process.exitCode = 1;
      return;
    }

    await c.query('BEGIN');
    await c.query(`SET LOCAL app.tenant_id = '${M}'`);
    if (REACT) {
      const r = await c.query(`UPDATE catalog.products p SET activo=true, updated_at=now() WHERE ${REACT_WHERE}`, [M]);
      console.log(`\n  ✓ reactivados: ${r.rowCount}`);
    }
    // El FK a inventory.products (tabla paralela frozen-FDW) es obsoleto: ahora derivamos de
    // catalog.products (maestra). Sin dropearlo, los SKUs nuevos del catálogo violan el FK.
    await c.query(`ALTER TABLE inventory.products_active DROP CONSTRAINT IF EXISTS fk_inventory_products_active_sku`);
    await c.query(`TRUNCATE inventory.products_active`);
    // catalog.products es una proyección NORMALIZADA, NO un superset: deja en NULL los campos
    // denormalizados (product_line/department = NULL → la línea vive como brand_id uuid; sin imagen).
    // El SoR de esos campos es inventory.products (FDW denormalizado + Cloudinary). Por eso:
    //   - subfamilia/categoria/image_*  ← SOLO inventory.products (catalog los tiene en 0).
    //   - nombre/descripcion/unidades/barcode ← catalog (más fresco, arregla '***') con fallback a inventory.
    // Copiar estos de catalog a ciegas nulea subfamilia+categoria+imagen (regresión vivida 2026-08-17).
    const ins = await c.query(`
      INSERT INTO inventory.products_active
        (sku, codigo_barras, subfamilia, nombre, descripcion, unidad_compra, unidad_venta, categoria, synced_at, image_url, image_source, image_storage_key, image_updated_at)
      SELECT p.sku,
             COALESCE(NULLIF(btrim(p.barcode),''), ip.codigo_barras),
             ip.subfamilia,
             COALESCE(NULLIF(btrim(p.nombre),''), ip.nombre),
             COALESCE(NULLIF(btrim(p.description),''), ip.descripcion),
             COALESCE(NULLIF(btrim(p.unit_purchase),''), ip.unidad_compra),
             COALESCE(NULLIF(btrim(p.unit_sale),''), ip.unidad_venta),
             ip.categoria,
             now(),
             ip.image_url, ip.image_source, ip.image_storage_key, ip.image_updated_at
        FROM catalog.products p
        LEFT JOIN inventory.products ip ON ip.sku = p.sku
       WHERE p.tenant_id=$1 AND p.activo AND p.deleted_at IS NULL AND btrim(coalesce(p.sku,''))<>''`, [M]);
    await c.query('COMMIT');
    console.log(`  ✓ products_active refrescada: ${ins.rowCount} filas (desde catalog.products).`);
    await hb.end(HB_KEY, { status: 'ok', rows: ins.rowCount, note: `${paActual}→${ins.rowCount} filas${REACT ? ` · ${reactN} reactivados` : ''}` });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    if (APPLY) await hb.end(HB_KEY, { status: 'error', error: e.message }).catch(() => {});
    process.exitCode = 1;
  } finally { await c.end(); }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
