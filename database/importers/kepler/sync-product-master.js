/* eslint-disable no-console */
/**
 * FEED CANÓNICO DE IDENTIDAD DE PRODUCTO — `sync-product-master.js`  (normalización clase A).
 *
 * UN feed atómico escribe UNA maestra (`catalog.products`) leyendo UN snapshot determinista
 * de UNA fuente (`kepler_ods.kdii`) en UNA transacción, SIN el gate "solo si el nombre cambió"
 * que dejaba ~1600 barcodes rotos. Reemplaza a `repoint-catalog-presence` + `repoint-catalog-names`
 * + la rama de identidad de `import-catalog-bulk`/`mega_dulces_sync`. Ver docs/PLAN_FUENTE_UNICA.md §1.
 *
 * Por qué no una vista sobre kepler_ods: `catalog.products` tiene RLS + tenant_id + columnas
 * curadas de app (image_url, embedding, rotation_tier, in_planogram, source…) y necesita
 * reconciliar BAJAS (kepler_ods es UPSERT-only, no borra) — una vista no puede nada de eso.
 *
 * MISMA DB fuente y destino (ambas en prod) → todo server-side, egress ~nulo (solo counts).
 *
 * Qué hace, en orden, dentro de 1 trx:
 *   1) REACTIVATE  — source='kepler' borrado pero vivo en el ERP → revive (guarda anti-colisión).
 *   2) UPDATE ident— nombre/barcode/brand de los activos, SIEMPRE que difiera (fix de los barcodes).
 *   3) INSERT      — SKUs del ERP que no existen en el catálogo (guarda unique brand+nombre).
 *   4) RECONCILE   — source='kepler' activo AUSENTE del ERP → soft-delete (activo=false, deleted_at).
 *
 * La marca (c3→code) SOLO se reasigna cuando hay match REAL de código. El fallback SIN-LINEA se
 * usa únicamente para dar marca a INSERTs nuevos (brand_id es NOT NULL); NUNCA reasigna la marca
 * de un producto existente (el UPDATE usa COALESCE → conserva la actual). La marca es una entidad
 * clase A aparte (sync-brand-master) que correrá antes en el ciclo; aquí solo se respeta.
 *
 * Guardas ANTES de escribir (no corromper prod con un read malo):
 *   - Frescura: kepler_ods._sync_status.last_push_at de kdii; si > MAX_AGE_MIN → ABORTA.
 *   - Anti-vaciado: si el snapshot trae < 90% de los productos kepler actuales → ABORTA.
 *   - Cap de bajas: si el reconcile borraría > MAX_DELETE filas → ABORTA (salvo --force).
 *
 * El reconcile SOLO toca source='kepler' → nunca borra los POS-only de Wincaja ni los curados
 * a mano. Por eso la columna `source` (migración 20260815140000) es prerequisito.
 *
 *   DST_URL / DATABASE_URL_NEW = destino y fuente (prod; kepler_ods vive ahí mismo)
 *   node database/importers/kepler/sync-product-master.js            # DRY-RUN (cuenta, no escribe)
 *   node database/importers/kepler/sync-product-master.js --apply    # escribe
 *   node database/importers/kepler/sync-product-master.js --apply --force   # ignora el cap de bajas
 *
 * Env: MAX_AGE_MIN (default 60), MAX_DELETE (default 500), CRON_TENANT_ID.
 */
const { Client } = require('pg');

const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
const MAX_AGE_MIN = Number(process.env.MAX_AGE_MIN || 60);
const MAX_DELETE = Number(process.env.MAX_DELETE || 500);

// Snapshot determinista: una fila por SKU. Precedencia CEDIS (00) primero (autoridad de
// catálogo), luego el resto de sucursales por orden estable. MISMA regla que reusarán los
// feeds hermanos (precio/costo) → cero "dos reglas de dedup". (kepler_ods.kdii NO tiene
// _loaded_at — solo sucursal + cN — por eso el orden es por sucursal, no por fecha de carga.)
const SNAP_SQL = `
  CREATE TEMP TABLE snap ON COMMIT DROP AS
  SELECT DISTINCT ON (btrim(c1))
         btrim(c1)                         AS sku,
         btrim(c2)                         AS nombre,
         nullif(btrim(coalesce(c7,'')),'') AS barcode,
         btrim(c3::text)                   AS linea,
         NULL::uuid                        AS brand_id
    FROM kepler_ods.kdii
   WHERE btrim(coalesce(c1,'')) <> '' AND btrim(coalesce(c2,'')) <> ''
   ORDER BY btrim(c1), (sucursal = '00') DESC, sucursal`;

// Reactivar: borrado, vivo en el ERP, sin gemelo activo del mismo sku, sin colisión de unique.
const REACT_WHERE = `p.tenant_id=$1 AND p.source='kepler' AND p.deleted_at IS NOT NULL AND p.sku=s.sku
  AND NOT EXISTS (SELECT 1 FROM catalog.products a WHERE a.tenant_id=$1 AND a.sku=s.sku AND a.deleted_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM catalog.products c WHERE c.tenant_id=$1 AND c.deleted_at IS NULL
                    AND c.brand_id=p.brand_id AND c.nombre=p.nombre AND c.id<>p.id)`;

// Política de barcode (Edgar 2026-08-17): la plataforma CONSERVA el EAN real; Kepler solo llena si
// está vacío o es placeholder (c7 = SKU con ceros). NUNCA pisa un EAN real con un placeholder.
// MISMA regla que el normalize-al-llegar (services/feeds-ingest/apply-handlers.js) → cero divergencia.
const BARCODE_CASE = `CASE
    WHEN length(coalesce(p.barcode,'')) >= 12
         AND (s.barcode IS NULL OR ltrim(s.barcode,'0') = ltrim(s.sku,'0') OR length(s.barcode) < 8)
      THEN p.barcode
    ELSE COALESCE(nullif(s.barcode,''), p.barcode)
  END`;

// UPDATE de identidad PURA: nombre + barcode de los activos, SIEMPRE que difiera (fix de barcodes).
// NO toca brand_id — la MARCA es su propia entidad clase A (sync-brand-master, mapeo c3→code con
// validación aparte); reasignarla aquí a ciegas movería ~500 productos de marca. La marca actual
// (p.brand_id) se conserva. Guarda anti-colisión contra la unique FULL (tenant, brand_id, nombre):
// como brand_id no cambia, solo puede colisionar si otra fila ya tiene (misma marca, nombre nuevo).
const IDENT_FROM = 'snap s';
const IDENT_WHERE = `p.tenant_id=$1 AND p.deleted_at IS NULL AND p.sku=s.sku
  AND ( p.nombre  IS DISTINCT FROM s.nombre
     OR p.barcode IS DISTINCT FROM ${BARCODE_CASE} )
  AND NOT EXISTS (SELECT 1 FROM catalog.products p2 WHERE p2.tenant_id=$1 AND p2.id<>p.id
                    AND p2.brand_id=p.brand_id AND p2.nombre=s.nombre)`;

// INSERT de nuevos: sku sin NINGUNA fila en el catálogo, marca efectiva = resuelta ∨ fallback
// ($2), (brand,nombre) sin colisión. DISTINCT ON evita colisión intra-lote; IS NOT NULL evita
// insertar sin marca (respeta NOT NULL) si el fallback aún no existe (dry-run sin SIN-LINEA).
const INS_FROM = `(SELECT DISTINCT ON (eff.brand_id, eff.nombre) eff.brand_id, eff.sku, eff.nombre, eff.barcode
     FROM (SELECT sku, nombre, barcode, COALESCE(brand_id, $2::uuid) AS brand_id FROM snap) eff
    WHERE eff.brand_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM catalog.products p  WHERE p.tenant_id=$1  AND p.sku=eff.sku)
      AND NOT EXISTS (SELECT 1 FROM catalog.products p2 WHERE p2.tenant_id=$1 AND p2.brand_id=eff.brand_id AND p2.nombre=eff.nombre)
    ORDER BY eff.brand_id, eff.nombre, eff.sku) d`;

// Reconcile de bajas: source='kepler' activo ausente del snapshot del ERP.
const DEL_WHERE = `p.tenant_id=$1 AND p.source='kepler' AND p.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM snap s WHERE s.sku=p.sku)`;

(async () => {
  const db = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false, statement_timeout: 180000 });
  await db.connect();
  const q = (sql, p) => db.query(sql, p);
  let inTx = false;

  const abort = async (msg) => {
    if (inTx) { await q('ROLLBACK').catch(() => {}); inTx = false; }
    console.error(`\n⛔ ABORT: ${msg}`);
    process.exitCode = 1;
  };

  try {
    console.log(`\n=== sync-product-master (${APPLY ? 'APPLY' : 'DRY-RUN'}${FORCE ? ' --force' : ''}) ===\n`);

    // ---- guarda de frescura ----
    const ss = (await q(`SELECT last_push_at, EXTRACT(EPOCH FROM (now()-last_push_at))/60 AS age_min
                           FROM kepler_ods._sync_status WHERE table_name='kdii'`)).rows[0];
    if (!ss) return abort('kepler_ods._sync_status no tiene fila para kdii — fuente desconocida');
    const ageMin = Number(ss.age_min);
    console.log(`  kdii last_push: ${new Date(ss.last_push_at).toISOString()} (hace ${ageMin.toFixed(1)} min)`);
    if (ageMin > MAX_AGE_MIN) return abort(`kdii STALE (${ageMin.toFixed(1)} min > ${MAX_AGE_MIN}) — no reconciliar sobre dato viejo`);

    await q('BEGIN'); inTx = true;
    await q(`SET LOCAL app.tenant_id = '${TENANT}'`);

    // ---- snapshot server-side ----
    await q(SNAP_SQL);
    const snapCount = Number((await q(`SELECT count(*)::int n FROM snap`)).rows[0].n);
    const withBc = Number((await q(`SELECT count(barcode)::int n FROM snap`)).rows[0].n);
    console.log(`  snapshot: ${snapCount} SKUs (${withBc} con barcode)`);

    // anti-vaciado: comparar contra los productos kepler actuales (activos + inactivos)
    const baseKepler = Number((await q(`SELECT count(*)::int n FROM catalog.products WHERE tenant_id=$1 AND source='kepler'`, [TENANT])).rows[0].n);
    if (snapCount < baseKepler * 0.9) return abort(`snapshot sospechosamente chico: ${snapCount} < 90% de ${baseKepler} kepler actuales`);

    // ---- resolución de marca (solo match real; fallback solo para inserts) ----
    await q(`UPDATE snap s SET brand_id = b.id
               FROM catalog.brands b
              WHERE b.tenant_id=$1 AND b.deleted_at IS NULL AND btrim(b.code)=s.linea`, [TENANT]);
    const sinBrand = Number((await q(`SELECT count(*)::int n FROM snap WHERE brand_id IS NULL`)).rows[0].n);
    let fallback = (await q(`SELECT id FROM catalog.brands WHERE tenant_id=$1 AND code='SIN-LINEA' LIMIT 1`, [TENANT])).rows[0]?.id;
    if (!fallback && APPLY) {
      fallback = (await q(`INSERT INTO catalog.brands (id, tenant_id, code, nombre, created_at, updated_at)
                           VALUES (gen_random_uuid(),$1,'SIN-LINEA','SIN LÍNEA',now(),now())
                           ON CONFLICT DO NOTHING RETURNING id`, [TENANT])).rows[0]?.id
        || (await q(`SELECT id FROM catalog.brands WHERE tenant_id=$1 AND code='SIN-LINEA' LIMIT 1`, [TENANT])).rows[0]?.id;
    }
    if (sinBrand) console.log(`  (${sinBrand} SKUs sin marca resoluble → INSERTs usan fallback SIN-LINEA${!fallback ? ' [no existe aún; se crea en --apply]' : ''})`);
    const insParams = [TENANT, fallback || null];

    // ---- diagnóstico (cuántas filas tocaría cada paso) ----
    const n = {
      reactivate: Number((await q(`SELECT count(*)::int n FROM catalog.products p JOIN snap s ON s.sku=p.sku WHERE ${REACT_WHERE}`, [TENANT])).rows[0].n),
      ident: Number((await q(`SELECT count(*)::int n FROM catalog.products p, ${IDENT_FROM} WHERE ${IDENT_WHERE}`, [TENANT])).rows[0].n),
      insert: Number((await q(`SELECT count(*)::int n FROM ${INS_FROM}`, insParams)).rows[0].n),
      softdelete: Number((await q(`SELECT count(*)::int n FROM catalog.products p WHERE ${DEL_WHERE}`, [TENANT])).rows[0].n),
    };
    console.log(`\n  paso 1 REACTIVATE (borrado→vivo):     ${n.reactivate}`);
    console.log(`  paso 2 UPDATE ident (nombre/barcode): ${n.ident}`);
    console.log(`  paso 3 INSERT (nuevo del ERP):        ${n.insert}`);
    console.log(`  paso 4 SOFT-DELETE (ausente del ERP): ${n.softdelete}`);

    if (n.softdelete > MAX_DELETE && !FORCE) return abort(`el reconcile borraría ${n.softdelete} > cap ${MAX_DELETE}. Revisá el snapshot o corré con --force si es real`);

    if (!APPLY) { await q('ROLLBACK'); inTx = false; console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); return; }

    // ---- APPLY (orden: reactivar → identidad → insertar → reconciliar) ----
    const r1 = await q(`UPDATE catalog.products p SET activo=true, deleted_at=NULL, updated_at=now()
                          FROM snap s WHERE ${REACT_WHERE}`, [TENANT]);
    const r2 = await q(`UPDATE catalog.products p SET
                          nombre   = s.nombre,
                          barcode  = ${BARCODE_CASE},
                          updated_at = now()
                        FROM ${IDENT_FROM} WHERE ${IDENT_WHERE}`, [TENANT]);
    const r3 = await q(`INSERT INTO catalog.products (id, tenant_id, brand_id, sku, nombre, barcode, source, created_at, updated_at)
                        SELECT gen_random_uuid(), $1, d.brand_id, d.sku, d.nombre, d.barcode, 'kepler', now(), now()
                          FROM ${INS_FROM}`, insParams);
    const r4 = await q(`UPDATE catalog.products p SET activo=false, deleted_at=now(), updated_at=now()
                         WHERE ${DEL_WHERE}`, [TENANT]);

    await q('COMMIT'); inTx = false;
    console.log(`\n[APPLY] COMMIT — reactivados ${r1.rowCount} · identidad ${r2.rowCount} · insertados ${r3.rowCount} · baja ${r4.rowCount}.`);
  } catch (e) {
    if (inTx) await q('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
  }
})();
