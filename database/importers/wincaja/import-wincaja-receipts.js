/* eslint-disable no-console */
/**
 * RE.0-b — Recepciones de mercancía de las tiendas SOLO-Wincaja → analytics.erp_goods_receipts.
 *
 * Las tiendas que NO están en Kepler (Morelia Abastos '30', Morelia Madero '32', Canindo '50')
 * capturan sus compras en Wincaja, no en Kepler. Su "orden de entrada" vive en
 * `wincaja.movimiento_proveedores` (AP por proveedor). Este feed las trae al mismo espejo
 * unificado que las de Kepler para que Compras 360 / cuadre-proveedor las vean.
 *
 * Transform newdb→newdb (NO toca el .mdb ni la LAN — la landing wincaja.* ya la puebla
 * `import-wincaja.js`). Corre incluso desde Railway.
 *
 * Decode (verificado 2026-08-10):
 *  - tipo `CR` = compra a CRÉDITO (saldo>0), `CC` = compra de CONTADO (saldo=0). Ambas =
 *    RECEPCIÓN de mercancía. `NP` = nota "Por Devolución" (saldo=0) → EXCLUIDA.
 *  - `documento` = folio (ya trae prefijo CR/CC/NP → único entre tipos). `tercero` = código de
 *    proveedor Wincaja → nombre en `wincaja.proveedores`. `valor` = subtotal; total c/IVA =
 *    valor+iva+ieps (comparable al c16 de Kepler). `fecha_vencimiento` nativo.
 *  - Tiendas objetivo = crosswalk `wincaja.branches` con `kepler_code IS NULL AND warehouse_code
 *    LIKE 'MD-%'` (excluye las que ya cubre el feed Kepler y las RUTAS 'RUTA-*'). dataset='actual'
 *    (el más fresco; 'concentrada' es snapshot viejo → no mezclar, evita doble conteo).
 *
 * En erp_goods_receipts: sucursal='30'/'32'/'50' (no colisiona con Kepler '00'..'05'),
 * source_branch='wincaja_XX', doc_prefix='WCJ-CR'/'WCJ-CC'. Sin líneas (movimiento_proveedores
 * es solo encabezado). UPSERT-solo-cambios, sin DELETE.
 *
 *   node database/importers/wincaja/import-wincaja-receipts.js            # dry-run
 *   node database/importers/wincaja/import-wincaja-receipts.js --apply    # commit
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const money = (n) => '$' + (Number(n) || 0).toLocaleString('es-MX', { maximumFractionDigits: 0 });

(async () => {
  console.log(`\n=== Recepciones Wincaja (tiendas solo-Wincaja) → analytics.erp_goods_receipts (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    await db.query(`SET app.tenant_id = '${M}'`).catch(() => {}); // wincaja.* tiene RLS forzado

    const { rows: stores } = await db.query(
      `SELECT source_branch, branch_name, warehouse_code FROM wincaja.branches
        WHERE tenant_id=$1 AND kepler_code IS NULL AND warehouse_code LIKE 'MD-%' ORDER BY source_branch`, [M]);
    if (!stores.length) { console.log('  Sin tiendas solo-Wincaja en el crosswalk — nada que hacer.'); return; }
    console.log(`  Tiendas objetivo: ${stores.map((s) => `${s.source_branch} ${s.branch_name}`).join(' · ')}`);

    const { rows } = await db.query(
      `SELECT mp.source_branch, mp.documento, mp.tipo, mp.tercero,
              COALESCE(NULLIF(btrim(pr.nombre), ''), NULLIF(btrim(mp.referencia), ''), mp.tercero) AS prov_nombre,
              NULLIF(btrim(pr.rfc), '') AS prov_rfc,
              mp.fecha::date AS fecha,
              (COALESCE(mp.valor::numeric, 0) + COALESCE(mp.iva::numeric, 0) + COALESCE(mp.ieps::numeric, 0)) AS monto,
              NULLIF(btrim(mp.observaciones), '') AS concepto
         FROM wincaja.movimiento_proveedores mp
         JOIN wincaja.branches b ON b.tenant_id = mp.tenant_id AND b.source_branch = mp.source_branch
         LEFT JOIN (
            SELECT source_branch, proveedor, max(nombre) AS nombre, max(rfc) AS rfc
              FROM wincaja.proveedores WHERE tenant_id=$1 GROUP BY source_branch, proveedor
         ) pr ON pr.source_branch = mp.source_branch AND pr.proveedor = mp.tercero
        WHERE mp.tenant_id=$1 AND mp.source_dataset='actual' AND mp.tipo IN ('CR','CC')
          AND b.kepler_code IS NULL AND b.warehouse_code LIKE 'MD-%'`, [M]);

    // Dedupe por (sucursal, documento) — documento ya trae prefijo de tipo → único.
    const byKey = new Map();
    for (const r of rows) {
      if (!r.source_branch || !r.documento) continue;
      byKey.set(`${String(r.source_branch).trim()}|${String(r.documento).trim()}`, r);
    }
    const staged = [...byKey.values()].map((r) => [
      String(r.source_branch).trim(),                 // sucursal '30'/'32'/'50'
      String(r.documento).trim(),                     // folio
      `WCJ-${(r.tipo || '').trim()}`,                 // doc_prefix
      r.fecha || null,
      String(r.tercero || '').trim() || null,         // proveedor_code (codespace Wincaja)
      (r.prov_nombre || '').trim() || null,
      (r.prov_rfc || '').trim() || null,
      null,                                            // vale_folio (Wincaja no tiene cadena Kepler)
      null,                                            // oc_folio
      (r.concepto || '').trim() || null,
      Number(r.monto) || 0,
      `wincaja_${String(r.source_branch).trim()}`,     // source_branch
    ]);

    const bySuc = {};
    for (const s of staged) { bySuc[s[0]] = bySuc[s[0]] || { n: 0, monto: 0 }; bySuc[s[0]].n++; bySuc[s[0]].monto += s[10]; }
    console.log('  Staged por sucursal:', Object.entries(bySuc).map(([k, v]) => `${k}:${v.n}/${money(v.monto)}`).join('  '));
    const tot = staged.reduce((s, r) => s + r[10], 0);
    const conNombre = staged.filter((r) => r[5]).length;
    console.log(`  TOTAL ${staged.length} recepciones · ${money(tot)} · con nombre proveedor: ${conNombre}`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió. Corré con --apply para escribir.'); return; }
    if (!staged.length) { console.log('\n[APPLY] 0 recepciones (¿landing wincaja vacía?) — tabla intacta.'); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE stg_wgr (
      sucursal text, folio text, doc_prefix text, receipt_date date, proveedor_code text,
      proveedor_nombre text, proveedor_rfc text, vale_folio text, oc_folio text,
      concepto text, monto numeric, source_branch text
    ) ON COMMIT DROP`);
    const NC = 12;
    for (let i = 0; i < staged.length; i += 1000) {
      const chunk = staged.slice(i, i + 1000);
      const vals = chunk.map((_, ri) => `(${Array.from({ length: NC }, (_, k) => `$${ri * NC + k + 1}`).join(',')})`);
      const params = [];
      chunk.forEach((row) => params.push(...row));
      await db.query(`INSERT INTO stg_wgr (sucursal,folio,doc_prefix,receipt_date,proveedor_code,proveedor_nombre,proveedor_rfc,vale_folio,oc_folio,concepto,monto,source_branch) VALUES ${vals.join(',')}`, params);
    }
    const up = await db.query(
      `INSERT INTO analytics.erp_goods_receipts AS t
         (tenant_id, sucursal, folio, doc_prefix, receipt_date, proveedor_code, proveedor_nombre, proveedor_rfc, vale_folio, oc_folio, concepto, monto, source_branch, computed_at)
       SELECT $1, sucursal, folio, doc_prefix, receipt_date, proveedor_code, proveedor_nombre, proveedor_rfc, vale_folio, oc_folio, concepto, monto, source_branch, now()
         FROM stg_wgr
       ON CONFLICT (tenant_id, sucursal, folio) DO UPDATE SET
         doc_prefix=EXCLUDED.doc_prefix, receipt_date=EXCLUDED.receipt_date,
         proveedor_code=EXCLUDED.proveedor_code, proveedor_nombre=EXCLUDED.proveedor_nombre,
         proveedor_rfc=EXCLUDED.proveedor_rfc, vale_folio=EXCLUDED.vale_folio, oc_folio=EXCLUDED.oc_folio,
         concepto=EXCLUDED.concepto, monto=EXCLUDED.monto, source_branch=EXCLUDED.source_branch, computed_at=now()
       WHERE (t.receipt_date, t.proveedor_code, t.proveedor_nombre, t.proveedor_rfc, t.concepto, t.monto)
             IS DISTINCT FROM
             (EXCLUDED.receipt_date, EXCLUDED.proveedor_code, EXCLUDED.proveedor_nombre, EXCLUDED.proveedor_rfc, EXCLUDED.concepto, EXCLUDED.monto)`,
      [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} recepciones (nuevas/cambiadas) de ${staged.length}. Sin DELETE (ledger append-only).`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
