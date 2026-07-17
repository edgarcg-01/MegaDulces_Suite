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

// Mismo map que import-in-transit / stock: código de almacén = nº sucursal Kepler (00–05).
// En prod lo sobreescribe STOCK_BRANCH_MAP (runner on-prem con los hosts reales).
const MAP = process.env.STOCK_BRANCH_MAP
  ? JSON.parse(process.env.STOCK_BRANCH_MAP)
  : [
      { code: '00', url: 'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00' },
      { code: '01', url: 'postgresql://platform_ro:kepler123@192.168.10.10:1977/md_01' },
      { code: '02', url: 'postgresql://platform_ro:kepler123@192.168.42.42:5432/md_02' },
      { code: '03', url: 'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03' },
      { code: '04', url: 'postgresql://platform_ro:kepler123@192.168.44.44:5432/md_04' },
      { code: '05', url: 'postgresql://platform_ro:kepler123@192.168.54.54:5432/md_05' },
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

// Fallback estable del catálogo (Kepler system catalog, idéntico entre sucursales) —
// para fuentes que no traen la tabla doctype (p.ej. el consolidado, que solo sincroniza
// kdm1/kdm2). key = 'GENERO|NATURALEZA|TIPO_INT'. dir por naturaleza (A=+ / D=−).
const INV_DOCTYPES_FALLBACK = [
  ['N', 'A', 20, 'InvIn1'], ['U', 'A', 10, 'RtrnEn1'], ['U', 'A', 20, 'Rtrn1'],
  ['X', 'A', 5, 'Purchas1'], ['X', 'A', 40, 'EntryOr1'],
  ['N', 'D', 5, 'InvOut1'], ['N', 'D', 25, 'InvTrsf1'], ['N', 'D', 30, 'PhysInv1'],
  ['U', 'D', 5, 'Sale1'], ['U', 'D', 45, 'Remiss1'], ['X', 'D', 30, 'RtrnPrd1'], ['X', 'D', 40, 'RtrnPur1'],
];
function fallbackMap() {
  const m = new Map();
  for (const [g, nat, tipo, code] of INV_DOCTYPES_FALLBACK) {
    m.set(`${g}|${nat}|${tipo}`, { code, label: LABELS[code] || code, dir: nat === 'A' ? 1 : -1 });
  }
  return m;
}

// Tipos custom Mega Dulces que MUEVEN inventario pero NO están flageados en doctype.k_binv.
// Decode: import-transfers-monthly (fase T) + reconciliación greedy vs kdil 2026-07-10
// (baseline k_binv err=39.2 → +traspasos 26.5 → +NA30 24.7). EXCLUIDOS con prueba:
//   U/D/10 factura (err→295, triplica) · X/A/35|37|20|30 cadena compra papel (err→129)
//   U/D/6 consolidación ruta (err→90, el ×2) · N/A/44 y N/A/45 (err→39, duplican UA50/XA40)
//   UD12/UA21/UD41/UA25/UD40 y pagos/gastos (neutros = no mueven stock).
// Signo por naturaleza (A=+/D=−) igual que el resto.
const CUSTOM_TYPES = [
  ['U', 'A', 50, 'TrsfRcv', 'Recepción de traspaso'],   // lado receptor (entrada)
  ['N', 'A', 6, 'TrsfInBr', 'Entrada por traspaso'],     // entrada traspaso sucursal
  ['N', 'A', 25, 'TrsfInWh', 'Entrada por traspaso'],    // entrada traspaso almacén
  ['U', 'D', 41, 'TrsfShip', 'Traspaso a sucursal'],     // salida CEDIS con detalle producto — reconciliación EXACTA (err 45.2→0.0)
  ['N', 'D', 6, 'TrsfOutBr', 'Salida por traspaso'],     // salida traspaso sucursal (N/D/25 ya viene por k_binv)
  ['N', 'A', 30, 'PhysInvIn', 'Inventario físico (entrada)'], // sobrante del físico (contraparte de ND30)
];
// NO incluir: U/D/13 (factura del traspaso CEDIS — líneas de SERVICIO con el total $, sin
// producto; el detalle real va en U/D/41) ni U/D/40 (pedido, papel de UD41 — sumarlo duplica).

// Tipos INFORMATIVOS (k_binv=0, NO mueven inventario) que se cargan para consulta:
// dir=0 → signed_qty=0 + movement_kind='info'. El service los excluye de KPIs y del
// listado salvo filtro explícito por tipo. XA20 espeja las líneas de su XA40 1:1
// (es el paso contable que genera la CxP al proveedor).
const INFO_TYPES = [
  ['X', 'A', 20, 'ApEntOr1', 'Aplicación de orden de entrada'],
];
function addCustomTypes(map) {
  for (const [g, nat, tipo, code, label] of CUSTOM_TYPES) {
    map.set(`${g}|${nat}|${tipo}`, { code, label, dir: nat === 'A' ? 1 : -1 });
  }
  for (const [g, nat, tipo, code, label] of INFO_TYPES) {
    map.set(`${g}|${nat}|${tipo}`, { code, label, dir: 0 });
  }
  return map;
}

// Catálogo autoritativo: doctypes que afectan inventario, con dirección + etiqueta.
// key = 'GENERO|NATURALEZA|TIPO_INT'  →  { code, label, dir(+1/-1) }. Fallback si no hay tabla.
async function loadDoctypeMap(src, schema) {
  let rows;
  try {
    rows = (await src.query(
      `SELECT k_code, k_dscr,
              substr(k_doc7,1,1) g, substr(k_doc7,2,1) nat, (substr(k_doc7,3,2))::int tipo
       FROM ${schema}.doctype
       WHERE k_binv IS NOT NULL AND k_binv::numeric = 1 AND coalesce(k_doc7,'') <> ''`
    )).rows;
  } catch { rows = []; }
  if (!rows.length) return addCustomTypes(fallbackMap());
  const map = new Map();
  for (const r of rows) {
    map.set(`${r.g}|${r.nat}|${r.tipo}`, {
      code: r.k_code,
      label: LABELS[r.k_code] || r.k_dscr || r.k_code,
      dir: r.nat === 'A' ? 1 : -1,
    });
  }
  return addCustomTypes(map);
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
      warehouse_id uuid, product_id uuid, sku text, doc_date date, genero char(1), naturaleza char(1),
      doc_type text, doc_serie text, doc_code text, movement_kind text, movement_label text, folio text,
      signed_qty numeric, qty numeric, unit_cost numeric, amount numeric,
      parent_group text, parent_serie text, parent_folio text, source_branch text) ON COMMIT DROP`);

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

      const schema = m.schema || 'md';
      let matched = 0, unmatched = 0, lines = 0;
      try {
        const dt = await loadDoctypeMap(src, schema);
        if (!dt.size) { console.log(`  ⚠ ${m.code}: doctype sin tipos de inventario — skip`); await src.end(); continue; }
        // tuplas (genero,naturaleza,tipo) para filtrar en SQL
        const tuples = [...dt.keys()].map((k) => { const [g, n, t] = k.split('|'); return `('${g}','${n}',${t})`; }).join(',');
        // CTE MATERIALIZED: primero reduce cabeceras (pocos miles) y recién ahí joinea kdm2.
        // Sin esto el planner (schemas sync SIN índices) elige nested-loop 182k×2M → 30+ min.
        const SQL = `
          WITH hh AS MATERIALIZED (
            SELECT c1, c2, c3, c4, c5::text serie, c6, c9::date doc_date, c37, c38::text pserie, c39
            FROM ${schema}.kdm1 h
            WHERE h.c1=$1 AND h.c9::date >= $2
              AND (h.c2, h.c3, (h.c4)::int) IN (${tuples})
          )
          SELECT hh.c2 g, hh.c3 nat, hh.c4 tipo, hh.serie, hh.c6 folio, hh.doc_date,
                 hh.c37 pgrp, hh.pserie, hh.c39 pfol, l.c8 sku, l.c9::numeric qty,
                 l.c12::numeric unit_val, l.c13::numeric total_val
          FROM hh
          JOIN ${schema}.kdm2 l ON l.c1=hh.c1 AND l.c2=hh.c2 AND l.c3=hh.c3 AND l.c4=hh.c4 AND l.c6=hh.c6
          WHERE coalesce(l.c11,'') <> 'SER'  -- líneas de SERVICIO (fletes, "VENTAS AL 0%") no son producto`;
        const rows = (await src.query(SQL, [suc, cutoff])).rows;

        const staged = [];
        for (const r of rows) {
          const info = dt.get(`${r.g}|${r.nat}|${parseInt(r.tipo, 10)}`);
          if (!info) continue;
          // SKU fuera de catálogo NO se descarta (rompería los totales del doc y la
          // validación salida↔recepción): product_id NULL + sku denormalizado.
          const pid = skuToId.get(r.sku) || null;
          if (!pid) unmatched++;
          const qty = Math.abs(Number(r.qty) || 0);
          if (qty === 0) continue;
          // kdm2: c12 = precio/costo UNITARIO, c13 = IMPORTE de la línea (c13 = c9×c12,
          // verificado 100% en 18 tipos × 4 sucursales 2026-07-13). NO usar c12 como importe.
          const unit = Math.abs(Number(r.unit_val) || 0);
          const total = Math.abs(Number(r.total_val) || 0) || (unit ? unit * qty : 0);
          staged.push([
            warehouseId, pid, r.sku || null, r.doc_date, r.g, r.nat, String(r.tipo), r.serie || null, info.code,
            info.dir === 0 ? 'info' : info.dir > 0 ? 'entrada' : 'salida', info.label, r.folio,
            info.dir * qty, qty, unit || (total ? total / qty : null), total || null,
            r.pgrp || null, r.pserie || null, r.pfol || null, suc,
          ]);
          matched++; lines++;
        }

        if (!sampleShown && staged.length) {
          console.log(`  muestra ${m.code}:`);
          for (const s of staged.slice(0, 4)) console.log(`    ${s[2].toISOString?.().slice(0,10)||s[2]} ${s[10].padEnd(20)} folio=${s[11]} qty=${s[13]} signed=${s[12]} costo/u=${s[14]?Number(s[14]).toFixed(2):'-'} importe=${s[15]?Number(s[15]).toFixed(2):'-'}`);
          sampleShown = true;
        }

        for (let i = 0; i < staged.length; i += BATCH) {
          const chunk = staged.slice(i, i + BATCH);
          const vals = [], params = [];
          const N = 20;
          chunk.forEach((row, ri) => { vals.push(`(${Array.from({ length: N }, (_, k) => `$${ri * N + k + 1}`).join(',')})`); params.push(...row); });
          await db.query(`INSERT INTO stg_mov (warehouse_id,product_id,sku,doc_date,genero,naturaleza,doc_type,doc_serie,doc_code,movement_kind,movement_label,folio,signed_qty,qty,unit_cost,amount,parent_group,parent_serie,parent_folio,source_branch) VALUES ${vals.join(',')}`, params);
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

    // Merge: reemplaza la ventana de los almacenes tocados. EXCLUYE las filas de
    // origen Wincaja (source_branch 'W%', histórico pre-migración cargado por
    // import-wincaja-stock-movements) — no las toca este feed Kepler.
    const wh = touched.map((_, i) => `$${i + 2}`).join(',');
    await db.query(
      `DELETE FROM analytics.stock_movements WHERE tenant_id=$1 AND doc_date >= $${touched.length + 2}
         AND warehouse_id IN (${wh}) AND coalesce(source_branch,'') NOT LIKE 'W%'`,
      [M, ...touched, cutoff]
    );
    const ins = await db.query(`
      INSERT INTO analytics.stock_movements
        (tenant_id,warehouse_id,product_id,sku,doc_date,genero,naturaleza,doc_type,doc_serie,doc_code,movement_kind,movement_label,folio,signed_qty,qty,unit_cost,amount,parent_group,parent_serie,parent_folio,source_branch)
      SELECT $1,warehouse_id,product_id,sku,doc_date,genero,naturaleza,doc_type,doc_serie,doc_code,movement_kind,movement_label,folio,signed_qty,qty,unit_cost,amount,parent_group,parent_serie,parent_folio,source_branch
      FROM stg_mov`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${ins.rowCount} líneas de movimiento insertadas (${summary.length} almacenes).`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
})();
