/* eslint-disable no-console */
/**
 * KV.8 — Embarques REALES del ERP (md.kdpord) → analytics.erp_shipments, MODO BULK.
 *
 * Lee kdpord de cada sucursal (READ-ONLY), resuelve sku→product_id contra el
 * destino, usa el CÓDIGO de sucursal del map como warehouse_code, y hace refresh
 * full por tenant (DELETE + INSERT agregando por folio×sku). kdpord es chico (~5k),
 * no requiere ventana ni batching agresivo.
 *
 * Mapeo de columnas kdpord (inferido del catálogo; VERIFICAR con el dump de muestra
 * que imprime el dry-run antes de --apply):
 *   c1=folio (PD-…) · c3=SKU · c9=cantidad · c10=unidad · c22=destino/ruta ·
 *   c24=folio doc venta · c35=estado (EMBARCADO)
 * La FECHA de embarque no está confirmada: setear KDPORD_DATE_COL (ej "c8") tras
 * ver el dump; si no se setea, shipped_date queda NULL (el resto carga igual).
 *
 * Env:
 *   DATABASE_URL_NEW          = destino (prod Railway / local)
 *   SHIPMENTS_BRANCH_MAP      = JSON [{code,url}] (default = las 6 sucursales)
 *   KDPORD_DATE_COL           = columna de fecha en kdpord (opcional)
 *
 *   node database/importers/kepler/import-erp-shipments.js          # dry-run (+ muestra)
 *   node database/importers/kepler/import-erp-shipments.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const BATCH = 1000;
const DATE_COL = (process.env.KDPORD_DATE_COL || '').replace(/[^a-z0-9_]/gi, ''); // anti-injection
const MAP = process.env.SHIPMENTS_BRANCH_MAP
  ? JSON.parse(process.env.SHIPMENTS_BRANCH_MAP)
  : [
      { code: '00', url: 'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00' },
      { code: '01', url: 'postgresql://platform_ro:kepler123@192.168.10.10:1977/md_01' },
      { code: '02', url: 'postgresql://platform_ro:kepler123@192.168.42.42:5432/md_02' },
      { code: '03', url: 'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03' },
      { code: '04', url: 'postgresql://platform_ro:kepler123@192.168.44.44:5432/md_04' },
      { code: '05', url: 'postgresql://platform_ro:kepler123@192.168.54.54:5432/md_05' },
    ];

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== Embarques Kepler (kdpord) → analytics.erp_shipments (BULK, ${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    const prods = (await db.query(`SELECT id, sku FROM catalog.products WHERE tenant_id=$1 AND btrim(coalesce(sku,''))<>''`, [M])).rows;
    const skuToId = new Map(prods.map((p) => [p.sku, p.id]));
    console.log(`  catálogo destino con sku: ${skuToId.size}`);

    const dateSel = DATE_COL ? `${DATE_COL}::date` : 'NULL::date';
    const byFolioSku = new Map(); // folio|sku → fila agregada
    let sampled = false;
    const summary = [];

    for (const m of MAP) {
      const src = new Client({ connectionString: m.url });
      try {
        await src.connect();
      } catch (e) {
        console.log(`  ⚠ sucursal ${m.code}: no conecta (${e.message.slice(0, 50)}) — skip`);
        continue;
      }
      try {
        // Dry-run: volcar una muestra CRUDA de una sucursal para calibrar columnas.
        if (!APPLY && !sampled) {
          const smp = await src.query(`SELECT * FROM md.kdpord LIMIT 3`).catch(() => null);
          if (smp && smp.rows.length) {
            console.log(`\n  ── muestra cruda md.kdpord (${m.code}) para verificar mapeo ──`);
            console.log('  columnas:', Object.keys(smp.rows[0]).join(', '));
            console.dir(smp.rows, { depth: null });
            console.log('  ────────────────────────────────────────────────────────\n');
          }
          sampled = true;
        }

        const rows = (await src.query(
          `SELECT c1 AS folio, c3 AS sku, GREATEST(c9,0)::numeric AS qty, c10 AS unit,
                  c22 AS route, c24 AS doc_folio, c35 AS status, ${dateSel} AS shipped_date
             FROM md.kdpord
            WHERE c1 IS NOT NULL AND btrim(coalesce(c3,'')) <> ''`,
        )).rows;

        let matched = 0;
        for (const r of rows) {
          const folio = String(r.folio).trim();
          const sku = String(r.sku).trim();
          const key = `${folio}|${sku}`;
          const prev = byFolioSku.get(key);
          if (prev) { prev.quantity += Number(r.qty) || 0; continue; }
          byFolioSku.set(key, {
            shipment_folio: folio, sku,
            product_id: skuToId.get(sku) || null,
            warehouse_code: m.code,
            route: r.route ? String(r.route).trim() : null,
            status: r.status ? String(r.status).trim() : null,
            doc_folio: r.doc_folio ? String(r.doc_folio).trim() : null,
            shipped_date: r.shipped_date || null,
            quantity: Number(r.qty) || 0,
            unit: r.unit ? String(r.unit).trim() : null,
          });
          if (skuToId.get(sku)) matched++;
        }
        summary.push({ code: m.code, lineas: rows.length, con_sku_match: matched });
      } catch (e) {
        console.log(`  ⚠ sucursal ${m.code}: error leyendo kdpord (${e.message.slice(0, 60)})`);
      } finally {
        await src.end();
      }
    }

    const all = [...byFolioSku.values()];
    console.table(summary);
    const folios = new Set(all.map((r) => r.shipment_folio)).size;
    const noSku = all.filter((r) => !r.product_id).length;
    console.log(`  total líneas: ${all.length} · folios únicos: ${folios} · sin match de sku: ${noSku}`);
    if (!DATE_COL) console.log('  ⚠ KDPORD_DATE_COL no seteado → shipped_date NULL (setealo tras ver la muestra).');

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }
    if (!all.length) { console.log('\n[APPLY] sin filas para cargar — nada que hacer.'); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE stg_ship (shipment_folio text, sku text, product_id uuid, warehouse_code text, route text, status text, doc_folio text, shipped_date date, quantity numeric, unit text) ON COMMIT DROP`);
    for (let i = 0; i < all.length; i += BATCH) {
      const chunk = all.slice(i, i + BATCH);
      const vals = [], params = [];
      chunk.forEach((r, ri) => {
        const b = ri * 10;
        vals.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10})`);
        params.push(r.shipment_folio, r.sku, r.product_id, r.warehouse_code, r.route, r.status, r.doc_folio, r.shipped_date, r.quantity, r.unit);
      });
      await db.query(`INSERT INTO stg_ship VALUES ${vals.join(',')}`, params);
    }
    await db.query(`DELETE FROM analytics.erp_shipments WHERE tenant_id=$1`, [M]);
    const up = await db.query(
      `INSERT INTO analytics.erp_shipments
         (tenant_id, shipment_folio, sku, product_id, warehouse_code, route, status, doc_folio, shipped_date, quantity, unit, computed_at)
       SELECT $1, shipment_folio, sku, product_id, warehouse_code, route, status, doc_folio, shipped_date, quantity, unit, now()
         FROM stg_ship`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} líneas en analytics.erp_shipments.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
