/* eslint-disable no-console */
/**
 * DM.0 — Diario de movimientos Kepler → analytics.stock_movements (BULK, line-level).
 *
 * Replica/mejora el reporte Kepler "Diario de movimientos" (Almacenes → Reportes →
 * Existencia → Movimientos), que lee md.kdm1 (cabecera) ⋈ md.kdm2 (líneas).
 *
 * Qué mueve inventario lo decide el catálogo AUTORITATIVO md.doctype (k_binv=1) — NO se
 * adivina. El signo sale de la naturaleza del documento (kdm1.c3 / doc7 pos2):
 *   'A' (Acreedora) → ENTRADA (+qty)   [InvIn, Compra, Orden entrada, Devol. de venta]
 *   'D' (Deudora)   → SALIDA  (-qty)   [Venta, Remisión, Traspaso, Devol. a proveedor, InvOut, Físico]
 * La factura U/D/10 NO está en k_binv → se excluye (si no, duplicaría la salida de venta).
 * Validado 2026-07-10: Σ signed ≈ md.kdil existencia (48≈47 / 98≈84 / 18≈15).
 *
 * Grano: una fila por línea. Windowed por fecha (kdm1.c9). Merge = borra la ventana de los
 * almacenes tocados y reinserta (idempotente). analytics.* sin RLS → tenant_id explícito.
 * kdm1 arrastra réplicas de otras sucursales → se filtra c1 = nº sucursal propia.
 *
 *   node database/importers/kepler/import-stock-movements.js               # dry-run, 120d
 *   node database/importers/kepler/import-stock-movements.js --days 90 --apply
 *   STOCK_BRANCH_MAP='[{"code":"KEPLER-03","url":"postgresql://.../md_03","suc":"03"}]' node ... --apply
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const BATCH = 1000;
const daysArg = (() => { const i = process.argv.indexOf('--days'); return i > -1 ? Number(process.argv[i + 1]) : 120; })();

const MAP = process.env.STOCK_BRANCH_MAP
  ? JSON.parse(process.env.STOCK_BRANCH_MAP)
  : [
      { code: 'MD-CEDIS', url: 'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00' },
      { code: 'MD-10', url: 'postgresql://platform_ro:kepler123@192.168.10.10:1977/md_01' },
      { code: 'MD-42', url: 'postgresql://platform_ro:kepler123@192.168.42.42:5432/md_02' },
      { code: 'KEPLER-03', url: 'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03' },
      { code: 'MD-44', url: 'postgresql://platform_ro:kepler123@192.168.44.44:5432/md_04' },
      { code: 'MD-54', url: 'postgresql://platform_ro:kepler123@192.168.54.54:5432/md_05' },
    ];

// Nº de sucursal Kepler (kdm1.c1). Explícito en el map, o derivado del md_NN de la URL.
function branchNum(m) {
  if (m.suc) return String(m.suc);
  const x = /md_(\d+)/i.exec(m.url || '');
  return x ? x[1] : null;
}

// Etiqueta legible ES por k_code (fallback: k_dscr del catálogo).
const LABELS = {
  InvIn1: 'Ajuste de entrada', InvOut1: 'Ajuste de salida', InvTrsf1: 'Traspaso (salida)',
  PhysInv1: 'Inventario físico', RtrnEn1: 'Devolución de venta', Rtrn1: 'Devolución de venta',
  Sale1: 'Venta', Sale2: 'Venta contado', Remiss1: 'Remisión', Purchas1: 'Compra',
  Purchas2: 'Compra contado', EntryOr1: 'Orden de entrada', RtrnPrd1: 'Devolución a proveedor',
  RtrnPur1: 'Devolución de compra',
};

// Catálogo autoritativo: doctypes que afectan inventario, con dirección + etiqueta.
// key = 'GENERO|NATURALEZA|TIPO_INT'  →  { code, label, dir(+1/-1) }
async function loadDoctypeMap(src) {
  const rows = (await src.query(
    `SELECT k_code, k_dscr,
            substr(k_doc7,1,1) g, substr(k_doc7,2,1) nat, (substr(k_doc7,3,2))::int tipo
     FROM md.doctype
     WHERE k_binv IS NOT NULL AND k_binv::numeric = 1 AND coalesce(k_doc7,'') <> ''`
  )).rows;
  const map = new Map();
  for (const r of rows) {
    map.set(`${r.g}|${r.nat}|${r.tipo}`, {
      code: r.k_code,
      label: LABELS[r.k_code] || r.k_dscr || r.k_code,
      dir: r.nat === 'A' ? 1 : -1,
    });
  }
  return map;
}

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== Diario de movimientos Kepler → analytics.stock_movements (BULK, ${APPLY ? 'APPLY' : 'DRY-RUN'}, ${daysArg}d) ===\n`);

    const prods = (await db.query(`SELECT id, sku FROM public.products WHERE tenant_id=$1 AND btrim(coalesce(sku,''))<>''`, [M])).rows;
    const skuToId = new Map(prods.map((p) => [p.sku, p.id]));
    console.log(`  catálogo prod con sku: ${skuToId.size}`);

    const cutoff = new Date(Date.now() - daysArg * 864e5).toISOString().slice(0, 10);
    console.log(`  ventana: doc_date >= ${cutoff}\n`);

    await db.query('BEGIN');
    await db.query(`CREATE TEMP TABLE stg_mov (
      warehouse_id uuid, product_id uuid, doc_date date, genero char(1), naturaleza char(1),
      doc_type text, doc_code text, movement_kind text, movement_label text, folio text,
      signed_qty numeric, qty numeric, unit_cost numeric, amount numeric,
      parent_group text, parent_folio text, source_branch text) ON COMMIT DROP`);

    const touched = [];
    const summary = [];
    let sampleShown = false;

    for (const m of MAP) {
      const whr = (await db.query(`SELECT id FROM commercial.warehouses WHERE tenant_id=$1 AND code=$2`, [M, m.code])).rows;
      if (!whr.length) { console.log(`  ⚠ warehouse ${m.code} no existe — skip`); continue; }
      const warehouseId = whr[0].id;
      const suc = branchNum(m);
      if (!suc) { console.log(`  ⚠ ${m.code}: no pude derivar sucursal — skip`); continue; }

      let src;
      try { src = new Client({ connectionString: m.url }); await src.connect(); }
      catch (e) { console.log(`  ⚠ ${m.code}: sin conexión (${e.message}) — skip`); continue; }

      let matched = 0, unmatched = 0, lines = 0;
      try {
        const dt = await loadDoctypeMap(src);
        if (!dt.size) { console.log(`  ⚠ ${m.code}: doctype sin tipos de inventario — skip`); await src.end(); continue; }
        // tuplas (genero,naturaleza,tipo) para filtrar en SQL
        const tuples = [...dt.keys()].map((k) => { const [g, n, t] = k.split('|'); return `('${g}','${n}',${t})`; }).join(',');
        const SQL = `
          SELECT h.c2 g, h.c3 nat, h.c4 tipo, h.c6 folio, h.c9::date doc_date,
                 h.c37 pgrp, h.c39 pfol, l.c8 sku, l.c9::numeric qty, l.c12::numeric val
          FROM md.kdm1 h
          JOIN md.kdm2 l ON l.c1=h.c1 AND l.c2=h.c2 AND l.c3=h.c3 AND l.c4=h.c4 AND l.c6=h.c6
          WHERE h.c1=$1 AND h.c9::date >= $2
            AND (h.c2, h.c3, (h.c4)::int) IN (${tuples})`;
        const rows = (await src.query(SQL, [suc, cutoff])).rows;

        const staged = [];
        for (const r of rows) {
          const info = dt.get(`${r.g}|${r.nat}|${parseInt(r.tipo, 10)}`);
          if (!info) continue;
          const pid = skuToId.get(r.sku);
          if (!pid) { unmatched++; continue; }
          const qty = Math.abs(Number(r.qty) || 0);
          if (qty === 0) continue;
          const val = Math.abs(Number(r.val) || 0);
          staged.push([
            warehouseId, pid, r.doc_date, r.g, r.nat, String(r.tipo), info.code,
            info.dir > 0 ? 'entrada' : 'salida', info.label, r.folio,
            info.dir * qty, qty, val ? val / qty : null, val || null,
            r.pgrp || null, r.pfol || null, suc,
          ]);
          matched++; lines++;
        }

        if (!sampleShown && staged.length) {
          console.log(`  muestra ${m.code}:`);
          for (const s of staged.slice(0, 4)) console.log(`    ${s[2].toISOString?.().slice(0,10)||s[2]} ${s[8].padEnd(20)} folio=${s[9]} qty=${s[11]} signed=${s[10]} costo/u=${s[12]?Number(s[12]).toFixed(2):'-'}`);
          sampleShown = true;
        }

        for (let i = 0; i < staged.length; i += BATCH) {
          const chunk = staged.slice(i, i + BATCH);
          const vals = [], params = [];
          const N = 17;
          chunk.forEach((row, ri) => { vals.push(`(${Array.from({ length: N }, (_, k) => `$${ri * N + k + 1}`).join(',')})`); params.push(...row); });
          await db.query(`INSERT INTO stg_mov (warehouse_id,product_id,doc_date,genero,naturaleza,doc_type,doc_code,movement_kind,movement_label,folio,signed_qty,qty,unit_cost,amount,parent_group,parent_folio,source_branch) VALUES ${vals.join(',')}`, params);
        }
        touched.push(warehouseId);
        summary.push({ code: m.code, suc, matched, unmatched, lines });
      } catch (e) {
        console.log(`  ⚠ ${m.code}: error leyendo kdm1/kdm2/doctype (${e.message}) — skip`);
      } finally { await src.end(); }
    }
    console.table(summary);

    if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); return; }
    if (!touched.length) { await db.query('ROLLBACK'); console.log('\nSin almacenes tocados — nada que hacer.'); return; }

    // Merge: reemplaza la ventana de los almacenes tocados.
    const wh = touched.map((_, i) => `$${i + 2}`).join(',');
    await db.query(
      `DELETE FROM analytics.stock_movements WHERE tenant_id=$1 AND doc_date >= $${touched.length + 2} AND warehouse_id IN (${wh})`,
      [M, ...touched, cutoff]
    );
    const ins = await db.query(`
      INSERT INTO analytics.stock_movements
        (tenant_id,warehouse_id,product_id,doc_date,genero,naturaleza,doc_type,doc_code,movement_kind,movement_label,folio,signed_qty,qty,unit_cost,amount,parent_group,parent_folio,source_branch)
      SELECT $1,warehouse_id,product_id,doc_date,genero,naturaleza,doc_type,doc_code,movement_kind,movement_label,folio,signed_qty,qty,unit_cost,amount,parent_group,parent_folio,source_branch
      FROM stg_mov`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${ins.rowCount} líneas de movimiento insertadas (${summary.length} almacenes).`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
})();
