/* eslint-disable no-console */
/**
 * Sync de catálogo Kepler → public.products en MODO BULK (rápido contra prod remoto).
 *
 * El importer per-fila (mega_dulces_sync --scope=products) hace ~3 queries por
 * producto → contra Railway (latencia ~1.2s/query) son ~14h. Este hace:
 *   1) lee catalogo_completo de .245 (igual baseQuery que el importer),
 *   2) resuelve brand_id/category_id en memoria (lookup de prod por code),
 *   3) carga a TEMP staging en batches (~14 inserts en vez de ~14k),
 *   4) MERGE server-side: UPDATE existentes por (brand_id,nombre) [setea sku] +
 *      INSERT los nuevos. Corre en el CPU de prod, sin round-trips por fila.
 * → de ~14h a <1 min.
 *
 * Match idéntico al importer: sku primero (vacío en prod → no pega), luego
 * (brand_id, nombre). Skips: sin nombre / sin brand (igual que el original).
 *
 *   node database/importers/import-catalog-bulk.js          # dry-run (reporta update/insert)
 *   node database/importers/import-catalog-bulk.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const SRC = process.env.MEGA_DULCES_URL || 'postgresql://postgres:superoot@192.168.0.245:5432/Mega_Dulces';
const DST = process.env.DATABASE_URL_NEW; // OBLIGATORIO (prod o local)
const APPLY = process.argv.includes('--apply');
const BATCH = 1000;

const clean = (v) => (v == null ? null : String(v).trim() || null);
const numOr = (v) => (v == null || v === '' ? null : Number(v));

// Sucursales Kepler para leer kdig (catálogo de líneas) — solo el fallback por nombre.
const KDIG_BRANCHES = process.env.STOCK_BRANCH_MAP
  ? JSON.parse(process.env.STOCK_BRANCH_MAP).map((b) => b.url || b)
  : [
      'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00',
      'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03',
      'postgresql://platform_ro:kepler123@192.168.42.42:5432/md_02',
    ];

const COLS = [
  'sku','barcode','brand_id','category_id','nombre','description','unit_purchase','unit_sale',
  'factor_purchase','factor_sale','iva_rate','ieps_rate','cost_with_tax','cost_per_case','cost_base',
  'location','location_warehouse','iva_purchase_rate','ieps_purchase_rate','loyalty_points','activo',
];

(async () => {
  if (!DST) throw new Error('DATABASE_URL_NEW obligatorio (target).');
  const src = new Client({ connectionString: SRC });
  const db = new Client({ connectionString: DST });
  await src.connect();
  await db.connect();
  try {
    console.log(`\n=== Catálogo Kepler → products (BULK, ${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    const { rows: srcRows } = await src.query(`
      SELECT cc.articulo, cc.codigo_barras, cc.nombre, cc.descripcion,
             cc.categoria AS categoria_codigo, cc.subfamilia AS subfamilia_codigo,
             cc.unidad_compra, cc.unidad_venta, cc.factor_compra, cc.factor_venta,
             cc.iva_venta, cc.ieps_venta, cc.iva_compra, cc.ieps_compra, cc.ptos_frecuencia,
             pa.costo_civa, pa.costo_x_caja, et.costo_matriz, et.ubicacion, et.ubicacion_bodega,
             et.en_existencia,
             CASE WHEN pa.articulo IS NOT NULL THEN true ELSE false END AS is_activo
      FROM catalogo_completo cc
      LEFT JOIN productos_activos pa  ON pa.articulo = cc.articulo
      LEFT JOIN catalogo_etiquetas et ON et.articulo = cc.articulo
      WHERE cc.nombre IS NOT NULL ORDER BY cc.articulo`);
    console.log(`  source .245: ${srcRows.length} productos`);

    // Lookups de prod (brands/categories por code) — 2 queries.
    const brandsByCode = new Map();
    for (const b of (await db.query(`SELECT id, code FROM catalog.brands WHERE tenant_id=$1 AND code IS NOT NULL`, [M])).rows)
      brandsByCode.set(b.code, b.id);
    const catsByCode = new Map();
    for (const c of (await db.query(`SELECT id, code FROM catalog.categories WHERE tenant_id=$1`, [M])).rows)
      catsByCode.set(c.code, c.id);
    console.log(`  lookup prod: ${brandsByCode.size} brands × ${catsByCode.size} categories`);

    // Fallback para líneas Kepler DUPLICADAS (mismo proveedor con 2+ códigos en
    // kdig, ej. 874 y 928 = JOSE BALTAZAR): si el code no existe como brand, se
    // resuelve por NOMBRE de línea. Sin kdig accesible degrada al match por code.
    const brandsByName = new Map();
    for (const b of (await db.query(`SELECT id, btrim(upper(nombre)) AS nombre FROM catalog.brands WHERE tenant_id=$1 AND deleted_at IS NULL`, [M])).rows)
      brandsByName.set(b.nombre, b.id);
    const lineaName = new Map();
    for (const burl of KDIG_BRANCHES) {
      const k = new Client({ connectionString: burl, connectionTimeoutMillis: 6000 });
      try {
        await k.connect();
        const { rows } = await k.query(`SELECT btrim(c1) AS code, btrim(c2) AS nombre FROM md.kdig WHERE btrim(coalesce(c1,''))<>'' AND btrim(coalesce(c2,''))<>''`);
        for (const r of rows) lineaName.set(r.code, r.nombre.replace(/\s+/g, ' ').trim().toUpperCase());
        console.log(`  kdig (${burl.split('@')[1]}): ${lineaName.size} líneas para fallback por nombre`);
        break;
      } catch { /* siguiente sucursal */ } finally { await k.end().catch(() => {}); }
    }

    // DELTA kdii VIVO — altas de Kepler que la consolidación manual (.245) aún no trae.
    // catalogo_completo/productos_activos son TABLAS snapshot (refresh manual): un producto
    // nuevo en Kepler queda invisible y el feed de ventas TIRA sus unidades (caso línea 795 /
    // Michel Ontiveros 2026-07-14: 4 SKUs vendiendo desde el 29-jun sin existir en catálogo).
    // Solo campos con decode validado (sku/nombre/línea/barcode/unidad); costos/factores NULL
    // — el refresh de la consolidación los completa después (el merge matchea por sku/nombre).
    const knownSkus = new Set(srcRows.map((r) => clean(r.articulo)).filter(Boolean));
    // Un alta puede existir solo en el kdii de SU sucursal → unión de las 6 (no basta una).
    const KDII_BRANCHES = process.env.SALES_BRANCH_MAP
      ? JSON.parse(process.env.SALES_BRANCH_MAP).map((b) => b.url || `postgresql://platform_ro:kepler123@${b.host}:${b.port}/${b.db}`)
      : [
          'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00',
          'postgresql://platform_ro:kepler123@192.168.10.10:1977/md_01',
          'postgresql://platform_ro:kepler123@192.168.42.42:5432/md_02',
          'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03',
          'postgresql://platform_ro:kepler123@192.168.44.44:5432/md_04',
          'postgresql://platform_ro:kepler123@192.168.54.54:5432/md_05',
        ];
    // OVERLAY VIVO (todo el catálogo, no solo altas): costo unitario CIVA = kdik.c16
    // (validado 2026-07-14 vs la regla de precio de la casa: c90 = c16 × 1.2333, exacto
    // en 99651/62064/70307), barcode = kdii.c7, unidad venta = kdii.c11, pzas/caja = c84.
    // El costo se toma por MODA entre sucursales (el kdik del CEDIS trae basura de
    // valuación, ej. 0.00016 en SKUs con costo real $114).
    const deltaRows = new Map();
    const liveBySku = new Map(); // sku → { nombre, linea, barcode, unidad, pzsCaja, costos[] }
    // IVA/IEPS VIVOS = tasa realmente FACTURADA (CFDI 4.0): md.kdfe4imp por concepto
    // (c11='002' IVA / '003' IEPS, c14=tasa, c12='Tasa') ⋈ kdm2 por doc+línea (i.c9=d.c7)
    // → SKU. Decode validado 2026-07-14 (631 SKUs @01; snapshot difiere 16% IVA / 30% IEPS
    // por desfase). Se adopta solo con ≥3 facturas y ≥90% de consistencia.
    const taxAcc = new Map(); // sku → { '002': Map(tasa→n), '003': Map(tasa→n) }
    for (const burl of KDII_BRANCHES) {
      const k = new Client({ connectionString: burl, connectionTimeoutMillis: 6000 });
      const suc = (/md_(\d+)/.exec(burl) || [])[1] || '00';
      try {
        await k.connect();
        const { rows } = await k.query(`
          SELECT btrim(i.c1) AS sku, btrim(i.c2) AS nombre, btrim(i.c3::text) AS linea,
                 btrim(coalesce(i.c7,'')) AS barcode, btrim(coalesce(i.c11,'')) AS unidad,
                 i.c81::numeric AS pz_paq, i.c84::numeric AS pzs_caja,
                 i.c90::numeric AS precio_pza, k.c16::numeric AS costo
          FROM md.kdii i
          LEFT JOIN md.kdik k ON k.c1 = $1 AND k.c2 = i.c1
          WHERE btrim(coalesce(i.c1,'')) <> '' AND btrim(coalesce(i.c2,'')) <> ''`, [suc]);
        let add = 0;
        for (const r of rows) {
          let lv = liveBySku.get(r.sku);
          if (!lv) { lv = { ...r, costos: [] }; liveBySku.set(r.sku, lv); }
          if (!lv.barcode && r.barcode) lv.barcode = r.barcode;
          if (!lv.unidad && r.unidad) lv.unidad = r.unidad;
          if (!(lv.pzs_caja > 0) && r.pzs_caja > 0) lv.pzs_caja = r.pzs_caja;
          if (!(lv.pz_paq > 0) && r.pz_paq > 0) lv.pz_paq = r.pz_paq;
          if (!(lv.precio_pza > 0) && r.precio_pza > 0) lv.precio_pza = r.precio_pza;
          if (r.costo != null && Number(r.costo) > 0) lv.costos.push(Number(r.costo));
          if (!knownSkus.has(r.sku) && !deltaRows.has(r.sku)) { deltaRows.set(r.sku, r); add++; }
        }
        let taxRows = 0;
        try {
          const { rows: tr } = await k.query(`
            SELECT d.c8 AS sku, i.c11 AS imp, i.c14::numeric AS tasa, count(*)::int AS n
            FROM md.kdfe4imp i
            JOIN md.kdm2 d ON d.c1=i.c1 AND d.c2=i.c4 AND d.c3=i.c5 AND d.c4=i.c6 AND d.c5=i.c7 AND d.c6=i.c8 AND d.c7=i.c9
            WHERE i.c12='Tasa' AND i.c11 IN ('002','003')
            GROUP BY 1,2,3`);
          for (const t of tr) {
            let a = taxAcc.get(t.sku);
            if (!a) { a = {}; taxAcc.set(t.sku, a); }
            const m = a[t.imp] || (a[t.imp] = new Map());
            const k4 = Number(t.tasa).toFixed(4);
            m.set(k4, (m.get(k4) || 0) + t.n);
            taxRows += t.n;
          }
        } catch (e) { console.log(`    (impuestos CFDI ${suc}: ${e.message})`); }
        console.log(`  kdii vivo (${burl.split('@')[1]}): ${rows.length} SKUs · +${add} fuera de la consolidación · ${taxRows} impuestos CFDI`);
      } catch (e) { console.log(`  kdii vivo ${burl.split('@')[1]}: sin conexión (${e.message})`); } finally { await k.end().catch(() => {}); }
    }
    // Tasa viva por SKU: null = sin evidencia suficiente (se queda la del snapshot).
    const liveTax = (sku) => {
      const a = taxAcc.get(sku);
      if (!a) return null;
      const pick = (imp) => {
        const m = a[imp];
        if (!m) return { rate: 0, n: 0, share: 1 }; // sin filas de ese impuesto = facturado sin él
        let tot = 0, best = null, bn = 0;
        for (const [r, n] of m) { tot += n; if (n > bn) { bn = n; best = r; } }
        return { rate: Number(best), n: tot, share: bn / tot };
      };
      const iva = pick('002'), ieps = pick('003');
      if (iva.n + ieps.n < 3) return null;
      return {
        iva: iva.share >= 0.9 ? iva.rate : null,
        ieps: ieps.share >= 0.9 ? ieps.rate : null,
      };
    };
    // Costo vivo por MEDIANA entre sucursales (robusta a la basura de valuación de un
    // solo kdik: ej. md_00 traía 906.07 en 83780 cuando el clúster real es ~42, y 610.48
    // en 83785 cuando es ~30). La moda+desempate-al-máximo previa adoptaba justo ese
    // outlier porque el redondeo por sucursal hace que ningún valor colisione a 4dp y
    // todos quedan como singletons. Se rechazan valores >4× o <0.25× de la mediana y se
    // recomputa la mediana de los sobrevivientes.
    const median = (arr) => {
      const s = [...arr].sort((a, b) => a - b);
      const n = s.length;
      return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
    };
    // FALLBACK (sin c16 vivo): precio de la casa c90 = costo × 1.2333 → costo implícito
    // c90/1.2333; si tampoco hay c90, el costo matriz del snapshot.
    // TECHO DE SANIDAD: NO se usa el ancla c90 para OVERRIDE — c90 a veces es precio por
    // CAJA en productos a granel (c81=c84=0), y sobreescribía el c16 correcto (07215: c16
    // real $42.86 → ancla $821.54; 08023: c16 real $8.5 → ancla $90.21). El techo confiable
    // es el costo MATRIZ (per-pieza): si la mediana viva se dispara >5× la matriz, es casi
    // seguro un c16 per-caja metido en UNA sucursal (83718 md_02=$716.94 vs matriz $35) →
    // usa la matriz. El 5× deja pasar el caso inverso legítimo (95207: c16 $40 vs matriz
    // $10, ×3.8, donde la matriz está sub-valuada y el c16 es el correcto).
    const HOUSE = 1.2333;
    const C90_PLACEHOLDER = 50.52; // valor comodín de Kepler propagado a ~20 SKUs (no es precio real)
    const liveCost = (sku, snapMatrix = null) => {
      const lv = liveBySku.get(sku);
      const cs = (lv?.costos || []).filter((c) => c > 0);
      const mtx = snapMatrix != null && Number(snapMatrix) > 0 ? Number(snapMatrix) : null;
      // c90 como ancla solo si NO es el placeholder 50.52.
      const pza = lv?.precio_pza > 0 && Math.abs(Number(lv.precio_pza) - C90_PLACEHOLDER) > 0.01
        ? Number(lv.precio_pza) : 0;
      let val;
      if (cs.length) {
        const m0 = median(cs);
        const kept = cs.filter((c) => c <= m0 * 4 && c >= m0 / 4);
        val = median(kept.length ? kept : cs);
      } else if (pza > 0) {
        val = pza / HOUSE; // sin c16 vivo → costo implícito del precio de la casa
      } else {
        return mtx; // ni c16 ni precio real → matriz (o null → cae al costo_civa afuera)
      }
      // Techo de sanidad per-CAJA: si el estimado (mediana c16 o ancla de precio) se dispara
      // >5× la matriz per-pieza, es casi seguro un valor por caja (c16 de una sucursal en
      // 83718; o c90 por caja en granel) → usa la matriz. El 5× deja pasar el caso inverso
      // legítimo (95207: c16 $40 vs matriz $10, ×3.8, la matriz está sub-valuada).
      if (mtx && val > mtx * 5) val = mtx;
      return val;
    };
    // Factor de caja vivo = UNIDAD DE VENTA = paquete (c81), NO la caja máster (c84).
    // Verificado 2026-07-15: c81 es la caja de venta (salsa→12/24, pasta /20KG→20,
    // Puratos→4/6, y coincide con el factor_venta del snapshot); c84 es el máster que la
    // contiene (TIC TAC /12: c81=12, c84=144=12×12; HALLS /12: c81=30, c84=360). Usar c84
    // inflaba el factor ~12×. Fallback a c84 solo si c81=0 (raro).
    const liveBox = (sku) => {
      const lv = liveBySku.get(sku);
      if (!lv) return null;
      if (lv.pz_paq > 0) return Number(lv.pz_paq);
      if (lv.pzs_caja > 0) return Number(lv.pzs_caja);
      return null;
    };

    // Transformar (mismo mapeo que mega_dulces_sync) + skips.
    const recs = []; let skipName = 0, skipBrand = 0, deltaAdds = 0, costChanged = 0, taxChanged = 0, factorChanged = 0, costOutlierFixed = 0, factorOverride1 = 0;
    const resolveBrand = (lineaCode) => {
      let brand_id = brandsByCode.get(lineaCode);
      if (!brand_id) {
        const nm = lineaName.get(lineaCode);
        if (nm) brand_id = brandsByName.get(nm);
      }
      return brand_id || null;
    };
    for (const d of deltaRows.values()) {
      const brand_id = resolveBrand(clean(d.linea));
      if (!brand_id) { skipBrand++; continue; }
      const cost = liveCost(d.sku);
      const tv = liveTax(d.sku);
      const boxF = liveBox(d.sku);
      recs.push([
        d.sku, clean(d.barcode), brand_id, null, d.nombre, null, null, clean(d.unidad),
        null, boxF, tv?.iva ?? null, tv?.ieps ?? null, cost, cost != null && boxF ? cost * boxF : null,
        null, null, null, null, null, null, true,
      ]);
      deltaAdds++;
    }
    if (deltaRows.size) console.log(`  delta kdii transformado: ${deltaAdds} altas (skip sin-brand: ${deltaRows.size - deltaAdds})`);
    for (const r of srcRows) {
      const sku = clean(r.articulo), nombre = clean(r.nombre);
      if (!sku || !nombre) { skipName++; continue; }
      const brand_id = resolveBrand(clean(r.subfamilia_codigo));
      if (!brand_id) { skipBrand++; continue; }
      // Overlay vivo: el costo actual manda sobre el snapshot; barcode/unidad solo rellenan.
      // Caja: factor vivo (c84→c81); el UXC implícito del snapshot es el fallback.
      const lv = liveBySku.get(sku);
      const cost = liveCost(sku, numOr(r.costo_matriz));
      const uxc = numOr(r.costo_x_caja) > 0 && numOr(r.costo_civa) > 0 ? Number(r.costo_x_caja) / Number(r.costo_civa) : null;
      // El factor_venta del snapshot es la caja de VENTA de Kepler y es confiable cuando
      // ya es >1 (dulces/goma/Puratos/salsas). Solo está mal cuando quedó en 1: los SKUs
      // a granel (pasta /20KG) donde el factor real vive en c81. → conservar snapshot si
      // >1; rellenar desde c81 solo si falta/1.
      const snapFsRaw = numOr(r.factor_venta);
      const boxF = liveBox(sku); // c81 (paquete de venta), fallback c84
      const factorSale = snapFsRaw && snapFsRaw > 1 ? snapFsRaw : (boxF ?? snapFsRaw);
      const baseCost = cost ?? numOr(r.costo_civa);
      const costPerCase = baseCost != null && factorSale > 0 ? baseCost * factorSale
        : (baseCost != null && uxc ? baseCost * uxc : numOr(r.costo_x_caja));
      const tv = liveTax(sku);
      const snapIva = r.iva_venta != null ? Number(r.iva_venta)/100 : null;
      const snapIeps = r.ieps_venta != null ? Number(r.ieps_venta)/100 : null;
      recs.push([
        sku, clean(r.codigo_barras) || (lv?.barcode || null), brand_id, catsByCode.get(clean(r.categoria_codigo)) || null,
        nombre, clean(r.descripcion), clean(r.unidad_compra), clean(r.unidad_venta) || (lv?.unidad || null),
        numOr(r.factor_compra), factorSale,
        tv?.iva ?? snapIva, tv?.ieps ?? snapIeps,
        baseCost, costPerCase, numOr(r.costo_matriz),
        clean(r.ubicacion), clean(r.ubicacion_bodega),
        r.iva_compra != null ? Number(r.iva_compra)/100 : null, r.ieps_compra != null ? Number(r.ieps_compra)/100 : null,
        numOr(r.ptos_frecuencia), r.is_activo === true && r.en_existencia !== false,
      ]);
      if (cost != null && numOr(r.costo_civa) != null && Math.abs(cost - Number(r.costo_civa)) > 0.005) costChanged++;
      if ((tv?.iva != null && tv.iva !== (snapIva ?? 0)) || (tv?.ieps != null && tv.ieps !== (snapIeps ?? 0))) taxChanged++;
      const snapFs = numOr(r.factor_venta);
      if (snapFs != null && Number(factorSale) !== Number(snapFs)) {
        factorChanged++;
        if ((snapFs || 0) > 1) factorOverride1++; // no debería pasar (se conserva snapshot>1)
        if (process.env.DUMP_FACTOR && factorChanged <= 60)
          console.log(`  [fac] ${sku} fs:${snapFs}→${factorSale} u=${clean(r.unidad_venta)} | ${nombre}`);
      }
      if (cost != null && numOr(r.costo_civa) != null && Number(r.costo_civa) > 0 && Number(r.costo_civa) / cost >= 3) costOutlierFixed++;
      if (process.env.DEBUG_SKUS && process.env.DEBUG_SKUS.split(',').includes(sku))
        console.log(`  [dbg] ${sku} fs:${snapFs}→${factorSale} cost:${numOr(r.costo_civa)}→${baseCost} xcaja:${numOr(r.costo_x_caja)}→${costPerCase} | ${nombre}`);
    }
    console.log(`  transformados: ${recs.length} (skip sin-nombre: ${skipName}, sin-brand: ${skipBrand})`);
    console.log(`  overlay costo vivo: ${costChanged} productos con costo distinto al snapshot (${costOutlierFixed} outliers >=3x corregidos por mediana)`);
    console.log(`  overlay factor caja vivo (c84→c81): ${factorChanged} productos con factor_sale distinto al snapshot (${factorOverride1} sobre un factor previo >1)`);
    console.log(`  overlay IVA/IEPS facturado: ${taxChanged} productos con tasa distinta al snapshot`);

    // STAGING temp + carga en batches.
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    // Lock upfront de la tabla: el merge toca ~12k rows y deadlockeaba contra los
    // crons que también escriben products. SHARE ROW EXCLUSIVE no bastó: un proceso
    // con SELECT ... FOR UPDATE (ROW SHARE, compatible) tomaba row-locks y su UPDATE
    // posterior cerraba el ciclo (deadlock reproducible 2026-07-14 en tuple products).
    // EXCLUSIVE también frena los FOR UPDATE; los SELECT normales no se bloquean.
    await db.query(`SET LOCAL lock_timeout = '90s'`);
    await db.query(`LOCK TABLE catalog.products IN EXCLUSIVE MODE`);
    await db.query(`CREATE TEMP TABLE stg2 (${COLS.map((c)=>`${c} text`).join(',')}) ON COMMIT DROP`);
    for (let i = 0; i < recs.length; i += BATCH) {
      const chunk = recs.slice(i, i + BATCH);
      const vals = [], params = [];
      chunk.forEach((row, ri) => {
        vals.push(`(${COLS.map((_, ci) => `$${ri * COLS.length + ci + 1}`).join(',')})`);
        params.push(...row.map((v) => (v === null ? null : String(v))));
      });
      await db.query(`INSERT INTO stg2 (${COLS.join(',')}) VALUES ${vals.join(',')}`, params);
    }
    console.log(`  staging cargado: ${recs.length} filas`);

    // Conteo update vs insert. Match por NOMBRE (el brand_id de prod no alinea
    // con los códigos de subfamilia Kepler; el nombre sí — 99.9% 1:1).
    const { rows: cu } = await db.query(`
      SELECT count(DISTINCT btrim(upper(p.nombre))) AS c
      FROM catalog.products p
      WHERE p.tenant_id=$1 AND EXISTS (
        SELECT 1 FROM stg2 s WHERE btrim(upper(s.nombre))=btrim(upper(p.nombre)))`, [M]);
    const willUpdate = Number(cu[0].c);
    const { rows: ci } = await db.query(`
      SELECT count(*) AS c FROM stg2 s WHERE NOT EXISTS (
        SELECT 1 FROM catalog.products p WHERE p.tenant_id=$1
          AND btrim(upper(p.nombre))=btrim(upper(s.nombre)))`, [M]);
    const willInsert = Number(ci[0].c);
    console.log(`  → UPDATE (match brand+nombre, setea sku): ${willUpdate}`);
    console.log(`  → INSERT (nuevos): ${willInsert}`);

    if (!APPLY) {
      await db.query('ROLLBACK');
      console.log('\n[DRY-RUN] ROLLBACK — nada cambió.');
      return;
    }

    // MERGE server-side. UPDATE existentes.
    const setCols = COLS.filter((c) => c !== 'sku').map((c) => {
      if (['brand_id','category_id'].includes(c)) return `${c}=s.${c}::uuid`;
      if (['factor_purchase','factor_sale','iva_rate','ieps_rate','cost_with_tax','cost_per_case','cost_base','iva_purchase_rate','ieps_purchase_rate','loyalty_points'].includes(c)) return `${c}=NULLIF(s.${c},'')::numeric`;
      if (c === 'activo') return `activo=(s.activo='true')`;
      return `${c}=s.${c}`;
    }).join(', ');
    // UPDATE existentes por NOMBRE, solo a nombres ÚNICOS en prod (evita los 7
    // dup-name que colisionarían en la constraint (brand_id,nombre) al re-marcar).
    // DISTINCT ON source dedupe por nombre (ambiguos toman sku más bajo).
    const upd = await db.query(`
      UPDATE catalog.products p SET sku=s.sku, ${setCols}, updated_at=now()
      FROM (SELECT DISTINCT ON (btrim(upper(nombre))) * FROM stg2 ORDER BY btrim(upper(nombre)), sku) s
      WHERE p.tenant_id=$1 AND btrim(upper(p.nombre))=btrim(upper(s.nombre))
        AND (SELECT count(*) FROM catalog.products p2
               WHERE p2.tenant_id=$1 AND btrim(upper(p2.nombre))=btrim(upper(p.nombre)))=1`, [M]);
    // INSERT respetando la constraint (tenant,brand_id,nombre): dedupe el source
    // por (brand_id,nombre) y excluye los que ya existen por esa misma clave
    // (estado post-UPDATE).
    const ins = await db.query(`
      INSERT INTO catalog.products (id, tenant_id, ${COLS.join(',')}, created_at, updated_at)
      SELECT gen_random_uuid(), $1, sku, barcode, brand_id::uuid, category_id::uuid, nombre, description,
             unit_purchase, unit_sale, NULLIF(factor_purchase,'')::numeric, NULLIF(factor_sale,'')::numeric,
             NULLIF(iva_rate,'')::numeric, NULLIF(ieps_rate,'')::numeric, NULLIF(cost_with_tax,'')::numeric,
             NULLIF(cost_per_case,'')::numeric, NULLIF(cost_base,'')::numeric, location, location_warehouse,
             NULLIF(iva_purchase_rate,'')::numeric, NULLIF(ieps_purchase_rate,'')::numeric,
             NULLIF(loyalty_points,'')::numeric, (activo='true'), now(), now()
      FROM (SELECT DISTINCT ON (brand_id, btrim(upper(nombre))) * FROM stg2
            ORDER BY brand_id, btrim(upper(nombre)), sku) s
      WHERE NOT EXISTS (
        SELECT 1 FROM catalog.products p WHERE p.tenant_id=$1
          AND p.brand_id=s.brand_id::uuid AND btrim(upper(p.nombre))=btrim(upper(s.nombre)))
        -- sku ya existente con OTRO nombre = renombre/reúso de clave Kepler; se
        -- salta (el UPDATE-por-nombre no lo pesca). Fix de fondo: match por SKU + aliases.
        AND NOT EXISTS (
          SELECT 1 FROM catalog.products p3 WHERE p3.tenant_id=$1 AND p3.sku=s.sku)`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — UPDATE ${upd.rowCount} / INSERT ${ins.rowCount}.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    if (e.detail) console.error('  detail:', e.detail);
    if (e.where) console.error('  where:', String(e.where).slice(0, 300));
    process.exitCode = 1;
  } finally {
    await src.end();
    await db.end();
  }
})();
