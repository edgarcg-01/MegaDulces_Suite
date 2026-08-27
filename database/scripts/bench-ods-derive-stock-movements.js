/* eslint-disable no-console */
/**
 * GATE DE COSTO derive-no-copy — ¿`analytics.stock_movements` puede ser VISTA sobre `kepler_ods`?
 *
 * RESPUESTA MEDIDA (prod, 2026-08-26): NO. Se queda materializada.
 *
 *   query (almacén con 57,933 líneas en 120d)      tabla      vista derivada
 *   agregado x producto, 1 almacén, 30d            259 ms     133,807 ms   (517×)
 *   drill-down por folio                           154 ms      13,734 ms    (89×)
 *   serie diaria, 1 almacén, 30d                   239 ms      61,910 ms   (259×)
 *   tipos de documento, 1 almacén, 120d            542 ms      TIMEOUT (>180 s)
 *
 * POR QUÉ: el join a `kdm2` va envuelto en `btrim()` y casts (`(l.c4)::int`), así que ningún índice
 * es aplicable; y `warehouse_id`/`product_id` NACEN del join (con `commercial.warehouses` y
 * `catalog.products`), así que el filtro del consumidor no baja al scan del ODS. Los ~1.9 GB de la
 * tabla no son copia redundante: son una proyección indexada. El importer ya es la versión buena
 * del patrón (todo server-side en un `INSERT...SELECT`, merge por bloques almacén×día con
 * fingerprint md5 → en régimen reprocesa ~1 día, no 120).
 *
 * Y ADEMÁS la tabla es una UNIÓN de fuentes, no un espejo de Kepler: `import-wincaja-stock-movements`
 * escribe las filas `source_branch LIKE 'W%'` (Wincaja vive en otra DB, `:5433/wincaja`) y
 * `services/feeds-ingest` re-deriva bloques desde bronce. Una vista solo podría cubrir la mitad
 * Kepler.
 *
 * Este script existe para que la respuesta sea reproducible en 3 minutos en vez de discutible.
 * Corre en SOLO LECTURA y no crea nada (el derive va inline como CTE).
 *
 *   DATABASE_URL_NEW=<prod> node database/scripts/bench-ods-derive-stock-movements.js
 */
const { Client } = require('pg');

const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const M = '00000000-0000-0000-0000-00000000d01c';
const WINDOW_DAYS = Number(process.env.STOCK_MOVEMENTS_DAYS) || 120;

// El decode que `import-stock-movements.js` arma en JS (doctype k_binv=1 + tipos custom + etiquetas),
// acá en SQL puro para poder medirlo como lo haría una vista.
const DT_MAP = `
dt_base AS (
  SELECT substr(k_doc7,1,1) g, substr(k_doc7,2,1) nat, (substr(k_doc7,3,2))::int tipo,
         k_code code, k_dscr dscr, CASE WHEN substr(k_doc7,2,1)='A' THEN 1 ELSE -1 END dir
  FROM kepler_ods.doctype
  WHERE k_binv IS NOT NULL AND k_binv::numeric = 1 AND coalesce(k_doc7,'') <> ''
),
dt_dedupe AS (SELECT DISTINCT ON (g,nat,tipo) g,nat,tipo,code,dscr,dir FROM dt_base ORDER BY g,nat,tipo,code),
dt_over AS (
  SELECT * FROM (VALUES
    ('U','A',50,'TrsfRcv'  ,'Recepción de traspaso'         , 1),
    ('N','A', 6,'TrsfInBr' ,'Entrada por traspaso'          , 1),
    ('N','A',25,'TrsfInWh' ,'Entrada por traspaso'          , 1),
    ('U','D',41,'TrsfShip' ,'Traspaso a sucursal'           ,-1),
    ('N','D', 6,'TrsfOutBr','Salida por traspaso'           ,-1),
    ('N','A',30,'PhysInvIn','Inventario físico (entrada)'   , 1),
    ('X','A',20,'ApEntOr1' ,'Aplicación de orden de entrada', 0)
  ) v(g,nat,tipo,code,label,dir)
),
dt_labels AS (
  SELECT * FROM (VALUES
    ('InvIn1','Ajuste de entrada'),('InvOut1','Ajuste de salida'),('InvTrsf1','Traspaso (salida)'),
    ('PhysInv1','Inventario físico'),('RtrnEn1','Devolución de venta'),('Rtrn1','Devolución de venta'),
    ('Sale1','Venta'),('Sale2','Venta contado'),('Remiss1','Remisión'),('Purchas1','Compra'),
    ('Purchas2','Compra contado'),('EntryOr1','Orden de entrada'),('RtrnPrd1','Devolución a proveedor'),
    ('RtrnPur1','Devolución de compra')
  ) v(code,label)
),
dt_map AS (
  SELECT g,nat,tipo,code,label,dir FROM dt_over
  UNION ALL
  SELECT d.g,d.nat,d.tipo,d.code, COALESCE(l.label, NULLIF(btrim(d.dscr),''), d.code), d.dir
  FROM dt_dedupe d LEFT JOIN dt_labels l ON l.code=d.code
  WHERE NOT EXISTS (SELECT 1 FROM dt_over o WHERE o.g=d.g AND o.nat=d.nat AND o.tipo=d.tipo)
)`;

// Cuerpo = EXTRACT_SQL del importer, sin MATERIALIZED (una vista necesita que el predicado baje).
const BODY = `
prod AS (
  SELECT DISTINCT ON (btrim(sku)) btrim(sku) sku, id, tenant_id
  FROM catalog.products WHERE btrim(coalesce(sku,'')) <> ''
  ORDER BY btrim(sku), (deleted_at IS NULL) DESC
),
dd AS (
  SELECT DISTINCT ON (btrim(c2::text)) btrim(c2::text) code, c3::text label
  FROM kepler_ods.kdud ORDER BY btrim(c2::text)
),
hdr AS (
  SELECT btrim(h.sucursal) suc, btrim(h.c1) c1, btrim(h.c2) g, btrim(h.c3) nat,
         (h.c4)::int tipo, NULLIF(h.c5::text,'') serie, h.c6 folio,
         h.c9::date doc_date, btrim(h.c10) dest_code,
         NULLIF(h.c37::text,'') pgrp, NULLIF(h.c38::text,'') pserie, h.c39 pfol
  FROM kepler_ods.kdm1 h
  WHERE btrim(h.c1)=btrim(h.sucursal) AND h.c9::date >= current_date - ${WINDOW_DAYS} AND h.c4 IS NOT NULL
),
j AS (
  SELECT hd.suc, hd.g, hd.nat, hd.tipo, hd.serie, hd.folio, hd.doc_date, hd.dest_code,
         hd.pgrp, hd.pserie, hd.pfol,
         w.id warehouse_id, w.tenant_id, dm.code, dm.label, dm.dir, dd.label dest_label,
         btrim(l.c8) sku, abs(coalesce((l.c9)::numeric,0)) qty,
         abs(coalesce(l.c12,0)) u, abs(coalesce(l.c13,0)) t13
  FROM hdr hd
  JOIN dt_map dm ON dm.g=hd.g AND dm.nat=hd.nat AND dm.tipo=hd.tipo
  JOIN commercial.warehouses w ON w.deleted_at IS NULL AND w.code=hd.suc
  JOIN kepler_ods.kdm2 l ON btrim(l.sucursal)=hd.suc AND btrim(l.c1)=hd.c1
        AND btrim(l.c2)=hd.g AND btrim(l.c3)=hd.nat AND (l.c4)::int=hd.tipo AND l.c6=hd.folio
  LEFT JOIN dd ON dd.code=hd.dest_code
  WHERE coalesce(btrim(l.c11),'') <> 'SER'
),
k AS (SELECT j.*, CASE WHEN j.t13<>0 THEN j.t13 WHEN j.u<>0 THEN j.u*j.qty ELSE 0 END t FROM j),
derived AS (
  SELECT k.tenant_id, k.warehouse_id, prod.id product_id, k.sku, k.doc_date,
         k.g genero, k.nat naturaleza, k.tipo::text doc_type, k.serie doc_serie, k.code doc_code,
         CASE WHEN k.dir=0 THEN 'info' WHEN k.dir>0 THEN 'entrada' ELSE 'salida' END movement_kind,
         k.label movement_label, k.folio, k.dir * k.qty signed_qty, k.qty,
         CASE WHEN k.u<>0 THEN k.u WHEN k.t<>0 THEN k.t/k.qty ELSE NULL END unit_cost,
         NULLIF(k.t,0) amount,
         k.pgrp parent_group, k.pserie parent_serie, k.pfol parent_folio, k.suc source_branch,
         CASE WHEN k.code='TrsfShip' THEN k.dest_code ELSE NULL END dest_code,
         CASE WHEN k.code='TrsfShip' THEN COALESCE(k.dest_label, k.dest_code) ELSE NULL END dest_label
  FROM k LEFT JOIN prod ON prod.sku=k.sku AND prod.tenant_id=k.tenant_id
  WHERE k.qty > 0
)`;
const DERIVE = `WITH ${DT_MAP},${BODY}`;

const QUERIES = [
  ['agregado x producto, 1 almacén, 30d', (src, extra) =>
    `SELECT product_id, sum(signed_qty) sq, sum(amount) amt, count(*) n FROM ${src}
      WHERE tenant_id=$1 AND warehouse_id=$2 AND doc_date >= current_date - 30 ${extra}
      GROUP BY 1 ORDER BY 2 LIMIT 50`, 'W'],
  ['drill-down por folio', (src, extra) =>
    `SELECT doc_code, movement_label, sku, qty, signed_qty, amount FROM ${src}
      WHERE tenant_id=$1 AND folio=$2 ${extra} LIMIT 200`, 'F'],
  ['serie diaria, 1 almacén, 30d', (src, extra) =>
    `SELECT doc_date, sum(signed_qty) sq FROM ${src}
      WHERE tenant_id=$1 AND warehouse_id=$2 AND doc_date >= current_date - 30 ${extra}
      GROUP BY 1 ORDER BY 1`, 'W'],
  ['tipos de documento, 1 almacén, 120d', (src, extra) =>
    `SELECT doc_code, count(*) n FROM ${src}
      WHERE tenant_id=$1 AND warehouse_id=$2 ${extra} GROUP BY 1 ORDER BY 2 DESC`, 'W'],
];

(async () => {
  const db = new Client({
    connectionString: DST,
    ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false,
  });
  await db.connect();
  await db.query(`SET statement_timeout = '180s'`);

  const w = (await db.query(`SELECT warehouse_id, count(*)::int n FROM analytics.stock_movements
     WHERE tenant_id=$1 AND doc_date >= current_date - ${WINDOW_DAYS}
       AND coalesce(source_branch,'') NOT LIKE 'W%'
     GROUP BY 1 ORDER BY 2 DESC LIMIT 1`, [M])).rows[0];
  if (!w) { console.log('sin filas Kepler en la ventana — nada que medir.'); await db.end(); return; }
  const folio = (await db.query(`SELECT folio FROM analytics.stock_movements
     WHERE tenant_id=$1 AND warehouse_id=$2 AND doc_date >= current_date - 30
       AND coalesce(source_branch,'') NOT LIKE 'W%' ORDER BY doc_date DESC LIMIT 1`,
  [M, w.warehouse_id])).rows[0];

  console.log(`\n=== Gate derive-no-copy: analytics.stock_movements (ventana ${WINDOW_DAYS}d) ===`);
  console.log(`almacén: ${w.warehouse_id} · ${w.n} líneas · folio de prueba: ${folio && folio.folio}\n`);
  console.log('  query'.padEnd(44) + 'TABLA'.padStart(11) + 'VISTA'.padStart(12) + '   veredicto');

  const time = async (sql, params) => {
    const t0 = Date.now();
    try { const r = await db.query(sql, params); return { ms: Date.now() - t0, rows: r.rows }; }
    catch (e) { return { ms: -1, err: e.message }; }
  };

  for (const [label, build, kind] of QUERIES) {
    const p = [M, kind === 'W' ? w.warehouse_id : folio && folio.folio];
    const t = await time(build('analytics.stock_movements', `AND coalesce(source_branch,'') NOT LIKE 'W%'`), p);
    const v = await time(`${DERIVE} ${build('derived', '')}`, p);
    const ratio = t.ms > 0 && v.ms > 0 ? `${(v.ms / t.ms).toFixed(0)}×` : '—';
    const verdict = v.ms < 0 ? 'TIMEOUT / ERROR' : v.ms < 1500 ? `OK (${ratio})` : `LENTA (${ratio})`;
    console.log('  ' + label.padEnd(42) + `${t.ms}ms`.padStart(11)
      + (v.ms < 0 ? 'timeout' : `${v.ms}ms`).padStart(12) + '   ' + verdict);
  }
  console.log('\nRegla: solo se convierte a vista lo que queda por debajo de ~1.5 s en las formas de');
  console.log('query del consumidor. Si no pasa, se queda materializado con refresh incremental.\n');
  await db.end();
})().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
