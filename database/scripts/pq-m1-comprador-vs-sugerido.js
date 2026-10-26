"use strict";

/**
 * [PQ.M1] — Cuando el comprador corrige el sugerido, ¿mejora, repite o empeora?
 *
 * Sólo lectura contra prod. Para cada renglón de requisición (approved/ordered/received) mira lo
 * que pasó DESPUÉS del pedido en ese SKU × sucursal, leído del ODS derivado:
 *
 *   venta posterior   → `analytics.sales_daily.units` (todos los canales) en (f, f+W]
 *   existencia        → `analytics.stock_snapshots.unidades` en f y en f+W; un día sin fila para el
 *                       par pero con el almacén en `stock_snapshot_coverage` = CERO real (agotado);
 *                       sin el almacén en coverage = NO MEDIDO (se excluye, no se cuenta como cero).
 *   cajas → piezas    → `analytics.v_warehouse_box_factor.box_factor` (el resolvedor canónico).
 *   ventana W         → cadencia del canal (`replenishment_channel.cadence_days`), acotada 7–30 d,
 *                       14 d si el canal no tiene cadencia. Lead time está en 0 en los 2,313 canales.
 *
 * ⛔ El árbitro es la venta POSTERIOR, nunca la demanda que ya usó el motor.
 * ⛔ Las fotos de existencia arrancan el 2026-09-24: sólo se juzgan renglones cuya ventana entera
 *    cae dentro de las fotos. El resto es «sin medir», no «normal».
 * ⚠️ Se juzga lo que PASÓ en la sucursal, no si el pedido llegó: un pedido que nunca salió a Kepler
 *    (PQ.M2) también cuenta. Lo que se mide es la decisión + su ejecución, juntas.
 *
 * Uso: $env:PROD_DATABASE_URL='postgresql://…'; node database/scripts/pq-m1-comprador-vs-sugerido.js [--detalle]
 */
const { Client } = require('pg');

const URL = process.env.PROD_DATABASE_URL || process.env.PROD_DB_URL;
if (!URL) { console.error('Falta PROD_DATABASE_URL'); process.exit(1); }
const DETALLE = process.argv.includes('--detalle');
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SOBRESTOCK_DIAS = 45; // tope de cobertura del propio motor: arriba de eso es capital inmovilizado
const n = (v) => (v == null ? null : Number(v));
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)} %` : 'NO MEDIDO');

/** Qué pasó en la sucursal durante la ventana, independientemente de quién decidió. */
function desenlace(x) {
  if (x.dias_cubiertos === 0 || x.e1 == null) return 'sin_medir';
  if (!x.llego) return 'no_llego';
  if (x.e1 === 0) return 'agotado';
  if (x.venta <= 0) return 'sin_venta';            // hay existencia y nadie compró: no se puede juzgar la cantidad
  const diaria = x.venta / x.w;
  if (x.e1 / diaria > SOBRESTOCK_DIAS) return 'sobrestock';
  return 'sano';
}

/** Veredicto de la CORRECCIÓN: ¿qué habría pasado con el sugerido solo? */
function veredicto(x, des) {
  if (des === 'sin_medir' || des === 'sin_venta' || des === 'no_llego') return 'sin_medir';
  if (x.delta_pz === 0) return 'igual';
  const diaria = x.venta / x.w;
  // Existencia final hipotética si se hubiera pedido lo sugerido (quitando la diferencia).
  const e1_sug = x.e1 - x.delta_pz;
  if (x.delta_pz > 0) { // subió
    if (des === 'sobrestock') return 'peor';
    if (des === 'agotado') return 'normal';          // subió y aun así faltó: la corrección no alcanzó, no empeoró
    if (e1_sug < 0) return 'mejor';                   // con el sugerido solo habría agotado
    return 'normal';
  }
  // bajó
  if (des === 'agotado') return 'peor';
  if (e1_sug / diaria > SOBRESTOCK_DIAS) return 'mejor'; // con el sugerido habría sobrado
  return 'normal';
}

(async () => {
  const c = new Client({ connectionString: URL, ssl: { rejectUnauthorized: false }, statement_timeout: 600000 });
  await c.connect();
  await c.query('SET default_transaction_read_only = on');
  const id = (await c.query("SELECT system_identifier::text sid, current_database() db, now()::text t FROM pg_control_system()")).rows[0];
  const fotos = (await c.query('SELECT min(fecha_corte)::text d0, max(fecha_corte)::text d1 FROM analytics.stock_snapshot_coverage')).rows[0];
  console.log(`# [PQ.M1] comprador vs sugerido · ${id.db} · system_identifier ${id.sid} · ${id.t}`);
  console.log(`# fotos de existencia: ${fotos.d0} → ${fotos.d1} · sobrestock = >${SOBRESTOCK_DIAS} d de cobertura al cierre de la ventana\n`);

  const ucols = (await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='identity' AND table_name='users'")).rows.map((r) => r.column_name);
  const ucol = ['username', 'email', 'name'].find((k) => ucols.includes(k));
  const userExpr = ucol ? `COALESCE(u.${ucol}, r.created_by::text)` : 'r.created_by::text';

  const rows = (await c.query(`
    WITH ln AS (
      SELECT r.id AS rid, r.folio, r.source_type, r.estado, ${userExpr} AS comprador, s.name AS prov,
             COALESCE(l.destination_warehouse_id, r.warehouse_id) AS wid, l.product_id, p.sku,
             l.suggested_qty::numeric AS s_cajas, l.final_qty::numeric AS f_cajas, l.unit_cost::numeric AS costo_caja,
             (r.created_at AT TIME ZONE 'America/Mexico_City')::date AS f,
             LEAST(30, GREATEST(7, ROUND(COALESCE(rc.cadence_days, 14))))::int AS w
        FROM commercial.purchase_requisitions r
        JOIN commercial.purchase_requisition_lines l ON l.requisition_id = r.id
        JOIN catalog.products p ON p.id = l.product_id
        LEFT JOIN catalog.suppliers s ON s.id = r.supplier_id
        LEFT JOIN identity.users u ON u.id = r.created_by
        LEFT JOIN LATERAL (
          SELECT rc.cadence_days FROM commercial.replenishment_channel rc
           WHERE rc.tenant_id = r.tenant_id AND rc.warehouse_id = COALESCE(l.destination_warehouse_id, r.warehouse_id)
             AND ((r.source_type = 'supplier' AND rc.supplier_id = r.supplier_id AND rc.via = 'purchase')
               OR (r.source_type = 'branch' AND rc.source_warehouse_id = r.source_warehouse_id AND rc.via = 'transfer'))
           ORDER BY rc.cadence_source DESC LIMIT 1) rc ON true
       WHERE r.tenant_id = $1 AND r.estado IN ('approved','ordered','received')
         AND (r.created_at AT TIME ZONE 'America/Mexico_City')::date >= $2::date
    ), bf AS (
      -- El resolvedor canónico se evalúa UNA vez para los pares del universo (por renglón, como LATERAL, tardó >10 min).
      SELECT v.warehouse_id, v.product_id, max(v.box_factor) AS box_factor
        FROM analytics.v_warehouse_box_factor v
       WHERE v.tenant_id = $1 AND (v.warehouse_id, v.product_id) IN (SELECT DISTINCT wid, product_id FROM ln)
       GROUP BY 1, 2
    ), med AS (
      SELECT ln.*, (ln.f + ln.w)::text AS fin, ln.f::text AS f_txt, bf.box_factor,
             (SELECT COALESCE(sum(sd.units), 0) FROM analytics.sales_daily sd
               WHERE sd.tenant_id = $1 AND sd.product_id = ln.product_id AND sd.warehouse_id = ln.wid
                 AND sd.sale_date > ln.f AND sd.sale_date <= ln.f + ln.w) AS venta,
             (SELECT ss.unidades FROM analytics.stock_snapshots ss
               WHERE ss.tenant_id = $1 AND ss.product_id = ln.product_id AND ss.warehouse_id = ln.wid AND ss.fecha_corte = ln.f) AS e0_fila,
             EXISTS (SELECT 1 FROM analytics.stock_snapshot_coverage cv WHERE cv.tenant_id = $1 AND cv.warehouse_id = ln.wid AND cv.fecha_corte = ln.f) AS e0_cubierto,
             (SELECT ss.unidades FROM analytics.stock_snapshots ss
               WHERE ss.tenant_id = $1 AND ss.product_id = ln.product_id AND ss.warehouse_id = ln.wid AND ss.fecha_corte = ln.f + ln.w) AS e1_fila,
             EXISTS (SELECT 1 FROM analytics.stock_snapshot_coverage cv WHERE cv.tenant_id = $1 AND cv.warehouse_id = ln.wid AND cv.fecha_corte = ln.f + ln.w) AS e1_cubierto,
             (SELECT count(*) FROM analytics.stock_snapshot_coverage cv
               WHERE cv.tenant_id = $1 AND cv.warehouse_id = ln.wid AND cv.fecha_corte > ln.f AND cv.fecha_corte <= ln.f + ln.w) AS dias_cubiertos,
             -- ¿LLEGÓ? Por DOCUMENTO del ERP, no por la foto: X-A-40 (orden de entrada) para la compra,
             -- U-A-50 (recepción de traspaso) para el traspaso, en [f, f+w]. La foto no sirve de árbitro:
             -- el CEDIS tiene 196 SKUs fotografiados y la entrada del mismo día del pedido queda fuera de (f, f+w].
             EXISTS (SELECT 1 FROM analytics.stock_movements m
               WHERE m.tenant_id = $1 AND m.product_id = ln.product_id AND m.warehouse_id = ln.wid
                 AND m.doc_date >= ln.f AND m.doc_date <= ln.f + ln.w
                 AND ((ln.source_type = 'supplier' AND m.genero = 'X' AND m.naturaleza = 'A' AND m.doc_type = '40')
                   OR (ln.source_type = 'branch' AND m.genero = 'U' AND m.naturaleza = 'A' AND m.doc_type = '50'))) AS llego_doc,
             (SELECT count(DISTINCT ss.product_id) FROM analytics.stock_snapshots ss WHERE ss.tenant_id = $1 AND ss.warehouse_id = ln.wid AND ss.fecha_corte = ln.f + ln.w) AS skus_foto_almacen,
             (SELECT count(*) FROM analytics.stock_snapshot_coverage cv
               WHERE cv.tenant_id = $1 AND cv.warehouse_id = ln.wid AND cv.fecha_corte > ln.f AND cv.fecha_corte <= ln.f + ln.w
                 AND NOT EXISTS (SELECT 1 FROM analytics.stock_snapshots ss WHERE ss.tenant_id = $1 AND ss.product_id = ln.product_id AND ss.warehouse_id = ln.wid AND ss.fecha_corte = cv.fecha_corte AND ss.unidades > 0)) AS dias_cero
        FROM ln
        LEFT JOIN bf ON bf.warehouse_id = ln.wid AND bf.product_id = ln.product_id
    )
    SELECT * FROM med`, [TENANT, fotos.d0])).rows;

  const hoyFotos = fotos.d1;
  const X = rows.map((r) => {
    const w = n(r.w), bf = n(r.box_factor);
    const s = n(r.s_cajas), f = n(r.f_cajas);
    const ventanaCompleta = r.fin <= hoyFotos;
    const x = {
      folio: r.folio, tipo: r.source_type, comprador: r.comprador, prov: r.prov, sku: r.sku, f: r.f_txt, w,
      s_cajas: s, f_cajas: f, delta_cajas: f - s, bf,
      delta_pz: bf ? (f - s) * bf : null,
      venta: n(r.venta), dias_cubiertos: n(r.dias_cubiertos), dias_cero: n(r.dias_cero),
      e0: r.e0_cubierto ? n(r.e0_fila) ?? 0 : null,
      e1: r.e1_cubierto ? n(r.e1_fila) ?? 0 : null,
      llego_doc: !!r.llego_doc, skus_foto_almacen: n(r.skus_foto_almacen), estado: r.estado,
      dinero_delta: (f - s) * n(r.costo_caja),
      grupo: f > s ? 'subió' : f < s ? 'bajó' : 'igual',
    };
    if (!ventanaCompleta || !bf) { x.des = 'sin_medir'; x.ver = 'sin_medir'; x.motivo = !bf ? 'sin factor de caja' : 'ventana incompleta'; return x; }
    x.llego = x.llego_doc;
    // Un almacén con menos de 500 SKUs fotografiados no está medido (el CEDIS: 196). Ahí la ausencia
    // de fila NO es cero (ADR-056): el desenlace queda sin medir, aunque «llegó» sí se sepa por documento.
    if (x.skus_foto_almacen < 500) { x.des = 'sin_medir'; x.ver = 'sin_medir'; x.motivo = 'almacén sin foto de existencia (CEDIS)'; return x; }
    x.agotado_al_pedir = x.e0 === 0;
    x.des = desenlace(x);
    x.ver = x.grupo === 'igual' ? 'igual' : veredicto(x, x.des);
    if (x.ver === 'sin_medir') x.motivo = x.des === 'sin_venta' ? 'sin venta posterior' : x.des === 'no_llego' ? 'no llegó mercancía en la ventana' : 'sin foto del almacén';
    return x;
  });

  const cnt = (arr, k) => arr.reduce((m, x) => { m[x[k]] = (m[x[k]] || 0) + 1; return m; }, {});
  const tabla = (arr, k, label) => Object.entries(cnt(arr, k)).sort((a, b) => b[1] - a[1]).map(([v, c2]) => ({ [label]: v, renglones: c2, pct: pct(c2, arr.length) }));

  console.log(`renglones desde ${fotos.d0}: ${X.length} · con ventana completa y factor: ${X.filter((x) => x.motivo !== 'ventana incompleta' && x.motivo !== 'sin factor de caja').length}`);
  console.log('\n## Por qué un renglón queda sin medir'); console.table(tabla(X.filter((x) => x.ver === 'sin_medir'), 'motivo', 'motivo'));

  const M = X.filter((x) => x.des !== 'sin_medir');
  console.log(`\n## Desenlace en la sucursal (sobre ${M.length} renglones medidos), por grupo — «igual» es el CONTROL: lo que pasa cuando el comprador no toca el sugerido`);
  const grupos = ['igual', 'subió', 'bajó'];
  console.table(grupos.map((g) => { const G = M.filter((x) => x.grupo === g); const k = cnt(G, 'des'); return { grupo: g, renglones: G.length, no_llego: pct(k.no_llego || 0, G.length), 'agotado al cierre': pct(k.agotado || 0, G.length), sobrestock: pct(k.sobrestock || 0, G.length), sano: pct(k.sano || 0, G.length), sin_venta: pct(k.sin_venta || 0, G.length) }; }));

  console.log('\n## Estado al PEDIR y si llegó mercancía en la ventana, por grupo');
  console.table(grupos.map((g) => { const G = X.filter((x) => x.grupo === g && x.motivo !== 'ventana incompleta' && x.motivo !== 'sin factor de caja'); const Gf = G.filter((x) => x.agotado_al_pedir !== undefined); return { grupo: g, renglones: G.length, 'agotado al pedir (con foto)': pct(Gf.filter((x) => x.agotado_al_pedir).length, Gf.length), 'llegó (documento ERP)': pct(G.filter((x) => x.llego).length, G.length) }; }));
  const ctrl = X.filter((x) => x.estado === 'received' && x.motivo !== 'ventana incompleta' && x.motivo !== 'sin factor de caja');
  console.log('\n## CONTROL del instrumento: renglones de requisiciones RECIBIDAS (' + ctrl.length + ') → «llegó» debe ser alto: ' + pct(ctrl.filter((x) => x.llego).length, ctrl.length));
  const J = M.filter((x) => x.grupo !== 'igual' && x.ver !== 'sin_medir');
  console.log(`\n## Veredicto de la corrección (sobre ${J.length} renglones corregidos y juzgables)`);
  console.table(grupos.slice(1).map((g) => { const G = J.filter((x) => x.grupo === g); const k = cnt(G, 'ver'); const dinero = G.reduce((a, x) => a + (x.dinero_delta || 0), 0); return { grupo: g, renglones: G.length, mejor: pct(k.mejor || 0, G.length), normal: pct(k.normal || 0, G.length), peor: pct(k.peor || 0, G.length), 'Δ dinero (F−S)': `$${Math.round(dinero).toLocaleString('en-US')}` }; }));

  const porDim = (dim, min = 20) => {
    const g = {};
    for (const x of J) { const k = x[dim] || '—'; (g[k] ||= { [dim]: k, n: 0, mejor: 0, normal: 0, peor: 0 }); g[k].n++; g[k][x.ver]++; }
    return Object.values(g).filter((r) => r.n >= min).sort((a, b) => b.n - a.n).map((r) => ({ ...r, mejor: pct(r.mejor, r.n), normal: pct(r.normal, r.n), peor: pct(r.peor, r.n) }));
  };
  console.log('\n## Por comprador (≥20 renglones juzgados)'); console.table(porDim('comprador'));
  console.log('\n## Por tipo'); console.table(porDim('tipo', 1));
  console.log('\n## Por proveedor (≥20 renglones juzgados, top)'); console.table(porDim('prov', 20).slice(0, 12));

  console.log('\n## Lo que este veredicto NO sabe (declarado)');
  console.log('  · Si el pedido llegó: juzga la decisión junto con su ejecución. Cruzar con PQ.M2 separa las dos.');
  console.log('  · Lead time real: está en 0 en los 2,313 canales; la ventana es la cadencia (7–30 d) o 14 d.');
  console.log('  · «sin_venta» con existencia no se juzga: no hay demanda con qué medir la cantidad.');
  console.log(`  · Sólo renglones con ventana dentro de las fotos (${fotos.d0} → ${fotos.d1}).`);
  if (DETALLE) console.table(J.slice(0, 200));
  await c.end();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
