/* eslint-disable no-console */
/**
 * DM.0 — Diario de movimientos Kepler → analytics.stock_movements (BULK, line-level).
 *
 * FUENTE: kepler_ods.* (single-DB, en la MISMA prod). Antes leía PER-BRANCH
 * (md.kdm1⋈kdm2 en las 6 sucursales + CEDIS) con fan-out de conexiones + traía 3.4M
 * líneas a JS para reinsertarlas → el pase 120d NO cabía en el timeout del nightly
 * (lo mataban a los 10 min, exit 124). Ahora todo el pesado corre SERVER-SIDE en un
 * solo INSERT...SELECT sobre kepler_ods (que el CDC WAL mantiene al momento) → sin
 * red per-branch, sin STOCK_BRANCH_MAP, misma salida.
 *
 * Replica el reporte Kepler "Diario de movimientos" (Almacenes → Reportes → Existencia →
 * Movimientos): kdm1 (cabecera) ⋈ kdm2 (líneas). Qué mueve inventario lo decide el catálogo
 * AUTORITATIVO doctype (k_binv=1). El signo sale de la naturaleza (kdm1.c3 / doc7 pos2):
 *   'A' (Acreedora) → ENTRADA (+qty)   [InvIn, Compra, Orden entrada, Devol. de venta]
 *   'D' (Deudora)   → SALIDA  (-qty)   [Venta, Remisión, Traspaso, Devol. a proveedor, InvOut, Físico]
 * La factura U/D/10 NO está en k_binv → se excluye (si no, duplicaría la salida de venta).
 * Validado 2026-07-10: Σ signed ≈ md.kdil existencia (48≈47 / 98≈84 / 18≈15).
 *
 * Grano: una fila por línea. Windowed por fecha (kdm1.c9). Merge = solo reprocesa los BLOQUES
 * (almacén×día) cuyo contenido cambió (fingerprint md5) → churn-free. analytics.* sin RLS →
 * tenant_id explícito. kepler_ods arrastra la RÉPLICA de cada rama en las demás → se dedupe con
 * `c1 = sucursal` (la copia propia de cada rama = exactamente el viejo filtro per-branch c1=suc).
 *
 *   node database/importers/kepler/import-stock-movements.js               # dry-run, 120d
 *   node database/importers/kepler/import-stock-movements.js --days 90 --apply
 *   STOCK_MOVEMENTS_DAYS=7 node database/importers/kepler/import-stock-movements.js --apply  # intradía rodante
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
// Ventana: --days N > STOCK_MOVEMENTS_DAYS (modo intradía, rodante corta) > 120 (nightly, backfill/correcciones).
const daysArg = (() => {
  const i = process.argv.indexOf('--days');
  if (i > -1) return Number(process.argv[i + 1]);
  const env = Number(process.env.STOCK_MOVEMENTS_DAYS);
  return Number.isFinite(env) && env > 0 ? env : 120;
})();

// Etiqueta legible ES por k_code (fallback: k_dscr del catálogo).
const LABELS = {
  InvIn1: 'Ajuste de entrada', InvOut1: 'Ajuste de salida', InvTrsf1: 'Traspaso (salida)',
  PhysInv1: 'Inventario físico', RtrnEn1: 'Devolución de venta', Rtrn1: 'Devolución de venta',
  Sale1: 'Venta', Sale2: 'Venta contado', Remiss1: 'Remisión', Purchas1: 'Compra',
  Purchas2: 'Compra contado', EntryOr1: 'Orden de entrada', RtrnPrd1: 'Devolución a proveedor',
  RtrnPur1: 'Devolución de compra',
};

// Fallback estable del catálogo (Kepler system catalog, idéntico entre sucursales) — si por lo
// que sea no hay tabla doctype. key = 'GENERO|NATURALEZA|TIPO_INT'. dir por naturaleza (A=+ / D=−).
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
// kepler_ods.doctype trae una copia por sucursal (col `sucursal`) del MISMO catálogo → el Map
// dedupe por key (todas las ramas escriben el mismo valor).
async function loadDoctypeMap(src) {
  let rows;
  try {
    rows = (await src.query(
      `SELECT k_code, k_dscr,
              substr(k_doc7,1,1) g, substr(k_doc7,2,1) nat, (substr(k_doc7,3,2))::int tipo
       FROM kepler_ods.doctype
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

// EXTRACT server-side: kepler_ods.kdm1 ⋈ kdm2 (dedupe c1=sucursal) ⋈ dt_map (decode) ⋈ warehouses
// (code=sucursal → mismos warehouse_id que ya usa la tabla, incl. CEDIS '00'='Cedis Oficinas')
// → prod (sku→id, prefiere el producto vivo). Todo el signo/costo/importe se calcula en SQL con
// la MISMA semántica que la versión JS (abs; c13=importe o c12×qty; unit=c12 o importe/qty).
const EXTRACT_SQL = `
INSERT INTO stg_mov (warehouse_id,product_id,sku,doc_date,genero,naturaleza,doc_type,doc_serie,doc_code,
                     movement_kind,movement_label,folio,signed_qty,qty,unit_cost,amount,
                     parent_group,parent_serie,parent_folio,source_branch,dest_code,dest_label)
WITH prod AS (
  SELECT DISTINCT ON (btrim(sku)) btrim(sku) sku, id
  FROM catalog.products WHERE tenant_id=$1 AND btrim(coalesce(sku,''))<>''
  ORDER BY btrim(sku), (deleted_at IS NULL) DESC
),
dd AS (  -- destino del traspaso: kdud c2=code → c3=label (una fila por code)
  SELECT DISTINCT ON (btrim(c2::text)) btrim(c2::text) code, c3::text label
  FROM kepler_ods.kdud ORDER BY btrim(c2::text)
),
-- NOTA de tipos (kepler_ods preserva el tipo del origen): c4/c5/c37/c38 son NUMERIC en kdm1;
-- c4/c12/c13 NUMERIC y c9 DOUBLE en kdm2; c9 de kdm1 es TIMESTAMP. Por eso el tipo (c4) se joinea
-- como int, los importes se usan crudos (sin btrim), y serie/pgrp/pserie van ::text a las cols text.
hdr AS MATERIALIZED (  -- cabeceras de la ventana, SOLO la copia propia de cada rama (c1=sucursal)
  SELECT btrim(h.sucursal) suc, btrim(h.c1) c1, btrim(h.c2) g, btrim(h.c3) nat,
         (h.c4)::int tipo, NULLIF(h.c5::text,'') serie, h.c6 folio,
         h.c9::date doc_date, btrim(h.c10) dest_code,
         NULLIF(h.c37::text,'') pgrp, NULLIF(h.c38::text,'') pserie, h.c39 pfol
  FROM kepler_ods.kdm1 h
  WHERE btrim(h.c1)=btrim(h.sucursal)
    AND h.c9::date >= $2
    AND h.c4 IS NOT NULL
),
j AS (  -- une líneas + decode + almacén; costos crudos (u=c12, t13=c13) para calcular abajo
  SELECT hd.suc, hd.g, hd.nat, hd.tipo, hd.serie, hd.folio, hd.doc_date,
         hd.dest_code, hd.pgrp, hd.pserie, hd.pfol,
         w.id warehouse_id, dm.code, dm.label, dm.dir, dd.label dest_label,
         btrim(l.c8) sku,
         abs(coalesce((l.c9)::numeric,0)) qty,
         abs(coalesce(l.c12,0)) u,
         abs(coalesce(l.c13,0)) t13
  FROM hdr hd
  JOIN dt_map dm ON dm.g=hd.g AND dm.nat=hd.nat AND dm.tipo=hd.tipo
  JOIN commercial.warehouses w ON w.tenant_id=$1 AND w.deleted_at IS NULL AND w.code=hd.suc
  JOIN kepler_ods.kdm2 l ON btrim(l.sucursal)=hd.suc AND btrim(l.c1)=hd.c1
        AND btrim(l.c2)=hd.g AND btrim(l.c3)=hd.nat AND (l.c4)::int=hd.tipo AND l.c6=hd.folio
  LEFT JOIN dd ON dd.code=hd.dest_code
  WHERE coalesce(btrim(l.c11),'')<>'SER'  -- líneas de SERVICIO (fletes, "VENTAS AL 0%") no son producto
),
k AS (  -- importe efectivo t = c13 o (c12×qty); resuelve unit_cost/amount sin repetir el CASE
  SELECT j.*, CASE WHEN j.t13<>0 THEN j.t13 WHEN j.u<>0 THEN j.u*j.qty ELSE 0 END t FROM j
)
SELECT
  k.warehouse_id, prod.id, k.sku, k.doc_date, k.g, k.nat, k.tipo::text, k.serie, k.code,
  CASE WHEN k.dir=0 THEN 'info' WHEN k.dir>0 THEN 'entrada' ELSE 'salida' END,
  k.label, k.folio,
  k.dir * k.qty, k.qty,
  CASE WHEN k.u<>0 THEN k.u WHEN k.t<>0 THEN k.t/k.qty ELSE NULL END,
  NULLIF(k.t,0),
  k.pgrp, k.pserie, k.pfol, k.suc,
  CASE WHEN k.code='TrsfShip' THEN k.dest_code ELSE NULL END,
  CASE WHEN k.code='TrsfShip' THEN COALESCE(k.dest_label, k.dest_code) ELSE NULL END
FROM k LEFT JOIN prod ON prod.sku=k.sku
WHERE k.qty > 0`;

// Crea + puebla la TEMP dt_map (decode) desde el Map de doctypes. Reutilizable por el harness de paridad.
async function buildDtMap(db, dt) {
  await db.query(`CREATE TEMP TABLE dt_map (g char(1), nat char(1), tipo int, code text, label text, dir int) ON COMMIT DROP`);
  const dtRows = [...dt.entries()].map(([key, v]) => { const [g, nat, tipo] = key.split('|'); return [g, nat, parseInt(tipo, 10), v.code, v.label, v.dir]; });
  for (let i = 0; i < dtRows.length; i += 200) {
    const chunk = dtRows.slice(i, i + 200);
    const vals = [], params = [];
    chunk.forEach((row, ri) => { vals.push(`($${ri * 6 + 1},$${ri * 6 + 2},$${ri * 6 + 3},$${ri * 6 + 4},$${ri * 6 + 5},$${ri * 6 + 6})`); params.push(...row); });
    await db.query(`INSERT INTO dt_map (g,nat,tipo,code,label,dir) VALUES ${vals.join(',')}`, params);
  }
}

async function main() {
  const db = new Client({ connectionString: DST });
  await db.connect();
  // Guard anti-pile-up: el merge + auto-ligado toman lock de la tabla; dos corridas a la vez
  // (nightly + intraday, o un catch-up manual) se serializan y, si se matan a medias, dejan
  // backends huérfanos que bloquean. pg_try_advisory_lock NO espera: si ya hay una, esta sale.
  const LOCK_KEY = 4823710; // clave fija de 'import-stock-movements'
  if (APPLY && !(await db.query('SELECT pg_try_advisory_lock($1) ok', [LOCK_KEY])).rows[0].ok) {
    console.log('⏭  otra instancia de import-stock-movements ya corre — skip (evita apilamiento).');
    await db.end();
    return;
  }
  try {
    console.log(`\n=== Diario de movimientos Kepler → analytics.stock_movements (kepler_ods, ${APPLY ? 'APPLY' : 'DRY-RUN'}, ${daysArg}d) ===\n`);

    const dt = await loadDoctypeMap(db);
    console.log(`  doctypes que afectan inventario: ${dt.size}`);
    const cutoff = new Date(Date.now() - daysArg * 864e5).toISOString().slice(0, 10);
    console.log(`  ventana: doc_date >= ${cutoff}\n`);

    await db.query('BEGIN');
    // El EXTRACT hashea kdm2 (~3.6M filas, ~226MB). Con el work_mem default (4MB) spillea a
    // decenas de batches en disco → 217s. Con 128MB spillea a ≤2 batches → ~18s (medido, 7d≈120d
    // porque el costo es el hash de kdm2, no la ventana). SET LOCAL = solo esta transacción, una
    // sola conexión efímera (nightly/intradía) → footprint acotado en la prod de Railway.
    await db.query(`SET LOCAL work_mem = '128MB'`);
    await db.query(`CREATE TEMP TABLE stg_mov (
      warehouse_id uuid, product_id uuid, sku text, doc_date date, genero char(1), naturaleza char(1),
      doc_type text, doc_serie text, doc_code text, movement_kind text, movement_label text, folio text,
      signed_qty numeric, qty numeric, unit_cost numeric, amount numeric,
      parent_group text, parent_serie text, parent_folio text, source_branch text,
      dest_code text, dest_label text) ON COMMIT DROP`);

    // dt_map: el decode (genero|nat|tipo → code/label/dir) como TABLA para joinear server-side.
    await buildDtMap(db, dt);

    // EXTRACT: un solo INSERT...SELECT server-side (sin traer filas a JS).
    const ex = await db.query(EXTRACT_SQL, [M, cutoff]);
    console.log(`  líneas staged: ${ex.rowCount}`);

    const summary = (await db.query(`
      SELECT source_branch suc, count(*)::int lines,
             count(*) FILTER (WHERE product_id IS NOT NULL)::int matched,
             count(*) FILTER (WHERE product_id IS NULL)::int unmatched
      FROM stg_mov GROUP BY source_branch ORDER BY source_branch`)).rows;
    console.table(summary);
    const sample = (await db.query(`SELECT to_char(doc_date,'YYYY-MM-DD') d, doc_code, movement_label, folio, qty, signed_qty, unit_cost, amount, source_branch
      FROM stg_mov ORDER BY doc_date DESC, source_branch LIMIT 5`)).rows;
    if (sample.length) { console.log('  muestra:'); for (const s of sample) console.log(`    ${s.d} ${String(s.movement_label).padEnd(22)} ${s.source_branch} folio=${s.folio} qty=${s.qty} signed=${s.signed_qty} costo/u=${s.unit_cost ? Number(s.unit_cost).toFixed(2) : '-'} importe=${s.amount ? Number(s.amount).toFixed(2) : '-'}`); }

    const touched = (await db.query(`SELECT DISTINCT warehouse_id FROM stg_mov`)).rows.map((r) => r.warehouse_id);

    if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); return; }
    if (!touched.length) { await db.query('ROLLBACK'); console.log('\nSin almacenes tocados — nada que hacer.'); return; }

    // Merge SIN churn: en vez de borrar+reinsertar TODA la ventana (120d) de los almacenes
    // tocados cada noche, solo se reprocesan los BLOQUES (almacén × día) cuyo contenido
    // cambió. Un día de movimientos es inmutable una vez cerrado en Kepler → en régimen solo
    // cambia HOY, así el nightly toca ~1 día en vez de 120 (idéntico output, ~98% menos WAL).
    // Fingerprint por (warehouse_id, doc_date) = md5 del contenido line-level ordenado.
    // EXCLUYE filas Wincaja (source_branch 'W%', histórico que este feed Kepler no toca).
    const FP = `concat_ws('|',
      product_id::text, coalesce(sku,''), genero, naturaleza, doc_type, coalesce(doc_serie,''), doc_code,
      movement_kind, movement_label, folio, signed_qty::text, qty::text,
      coalesce(unit_cost::text,''), coalesce(amount::text,''),
      coalesce(parent_group,''), coalesce(parent_serie,''), coalesce(parent_folio,''),
      source_branch, coalesce(dest_code,''), coalesce(dest_label,''))`;
    const wh = touched.map((_, i) => `$${i + 3}`).join(',');
    await db.query(
      `CREATE TEMP TABLE mov_changed ON COMMIT DROP AS
       WITH s AS (SELECT warehouse_id, doc_date, md5(string_agg(${FP}, E'\\n' ORDER BY ${FP})) fp
                    FROM stg_mov GROUP BY warehouse_id, doc_date),
            t AS (SELECT warehouse_id, doc_date, md5(string_agg(${FP}, E'\\n' ORDER BY ${FP})) fp
                    FROM analytics.stock_movements
                   WHERE tenant_id=$1 AND doc_date >= $2 AND warehouse_id IN (${wh})
                     AND coalesce(source_branch,'') NOT LIKE 'W%'
                   GROUP BY warehouse_id, doc_date)
       SELECT warehouse_id, doc_date
         FROM s FULL OUTER JOIN t USING (warehouse_id, doc_date)
        WHERE s.fp IS DISTINCT FROM t.fp`,
      [M, cutoff, ...touched]
    );
    const chg = (await db.query(`SELECT count(*)::int n FROM mov_changed`)).rows[0].n;
    // Solo borra los bloques (almacén×día) que cambiaron (incl. los que ya no vienen del origen).
    await db.query(
      `DELETE FROM analytics.stock_movements t USING mov_changed c
        WHERE t.tenant_id=$1 AND t.warehouse_id=c.warehouse_id AND t.doc_date=c.doc_date
          AND coalesce(t.source_branch,'') NOT LIKE 'W%'`, [M]);
    const ins = await db.query(`
      INSERT INTO analytics.stock_movements
        (tenant_id,warehouse_id,product_id,sku,doc_date,genero,naturaleza,doc_type,doc_serie,doc_code,movement_kind,movement_label,folio,signed_qty,qty,unit_cost,amount,parent_group,parent_serie,parent_folio,source_branch,dest_code,dest_label)
      SELECT $1,s.warehouse_id,s.product_id,s.sku,s.doc_date,s.genero,s.naturaleza,s.doc_type,s.doc_serie,s.doc_code,s.movement_kind,s.movement_label,s.folio,s.signed_qty,s.qty,s.unit_cost,s.amount,s.parent_group,s.parent_serie,s.parent_folio,s.source_branch,s.dest_code,s.dest_label
      FROM stg_mov s JOIN mov_changed c ON c.warehouse_id=s.warehouse_id AND c.doc_date=s.doc_date`, [M]);
    // DM.11 — auto-descubre destinos (dest_code, dest_label) sin tocar el warehouse_id curado.
    await db.query(`
      INSERT INTO analytics.transfer_dest_map (tenant_id, dest_code, dest_label)
      SELECT $1, dest_code, max(dest_label) FROM stg_mov WHERE dest_code IS NOT NULL
      GROUP BY dest_code
      ON CONFLICT (tenant_id, dest_code) DO UPDATE
        SET dest_label = COALESCE(EXCLUDED.dest_label, analytics.transfer_dest_map.dest_label), updated_at = now()`, [M]);
    // DM.11d — auto-liga warehouse_id por VERDAD DE RECEPCIÓN: el almacén que EFECTIVAMENTE
    // recibe los envíos de cada dest_code (pareo folio+serie+ventana 15d, mismo criterio que
    // transfers-check). Env-agnóstico (no adivina por código ni nombre) y solo usa la platform
    // DB. Respeta la curación humana (WHERE warehouse_id IS NULL) y excluye rutas. Idempotente.
    // DM.11d auto-ligado (ship↔rcv) es MANTENIMIENTO: descubrir el almacén de dest_codes nuevos.
    // NO hace falta cada corrida y su LATERAL escanea la tabla (~9 min, re-intenta ~310 dest_codes
    // viejos sin contraparte —CEDIS/rutas— que nunca ligan → apilaba corridas). Se SALTA en
    // intradía/catch-up (SKIP_AUTOLINK=1 / --no-autolink) y en el nightly se ACOTA a la ventana
    // (ship.doc_date >= cutoff) para no re-escanear 3.5M filas ni re-intentar lo inligable.
    const skipAutolink = process.env.SKIP_AUTOLINK === '1' || process.argv.includes('--no-autolink');
    const linked = skipAutolink ? { rowCount: 0 } : await db.query(`
      WITH ship AS (
        SELECT folio, doc_serie, warehouse_id, doc_date, dest_code
        FROM analytics.stock_movements
        WHERE tenant_id=$1 AND doc_code='TrsfShip' AND dest_code IS NOT NULL
          AND doc_date >= $2
          AND dest_code !~* '^\\s*(R\\.[DV]|R[DV]|RUTA)'
      ), pair AS (
        SELECT s.dest_code, r.warehouse_id AS rcv_wh, count(*)::int n
        FROM ship s
        JOIN LATERAL (
          SELECT rr.warehouse_id FROM analytics.stock_movements rr
          WHERE rr.tenant_id=$1 AND rr.doc_code='TrsfRcv' AND rr.parent_group='41'
            AND rr.parent_folio=s.folio AND coalesce(rr.parent_serie,'')=coalesce(s.doc_serie,'')
            AND rr.warehouse_id <> s.warehouse_id
            AND rr.doc_date >= s.doc_date AND rr.doc_date <= s.doc_date + 15
          GROUP BY rr.warehouse_id
        ) r ON true
        GROUP BY s.dest_code, r.warehouse_id
      ), best AS (
        SELECT DISTINCT ON (dest_code) dest_code, rcv_wh FROM pair ORDER BY dest_code, n DESC
      )
      UPDATE analytics.transfer_dest_map dm
        SET warehouse_id=b.rcv_wh, updated_at=now()
      FROM best b
      JOIN commercial.warehouses w ON w.id=b.rcv_wh AND w.tenant_id=$1 AND w.code NOT ILIKE 'RUTA%'
      WHERE dm.tenant_id=$1 AND dm.dest_code=b.dest_code AND dm.warehouse_id IS NULL`, [M, cutoff]);
    if (linked.rowCount) console.log(`[DM.11d] auto-ligados ${linked.rowCount} dest_code → almacén por recepción.`);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${chg} bloques (almacén×día) cambiados · ${ins.rowCount} líneas reinsertadas. Días sin cambio: intactos.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
}

if (require.main === module) main();
module.exports = { loadDoctypeMap, buildDtMap, EXTRACT_SQL, M };
