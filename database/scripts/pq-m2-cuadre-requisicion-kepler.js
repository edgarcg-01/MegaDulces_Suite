"use strict";

/**
 * [PQ.M2] — ¿Nuestra requisición es IDÉNTICA al documento que Kepler registró?
 *
 * Sólo lectura contra prod. Cruza cada requisición de la Suite (compra y traspaso) con el
 * documento del ERP que mejor la cubre y compara COLUMNA POR COLUMNA, en la misma unidad:
 *
 *   compra   → `analytics.erp_purchase_docs` / `erp_purchase_doc_lines` (XA3501 orden de compra,
 *              XA3001 requisición), vistas derivadas del ODS — el árbitro de la compra.
 *   traspaso → `kepler_ods.kdm1`/`kdm2` género U-D-40 (pedido de traspaso) creado en el ORIGEN,
 *              con el destino como pseudo-cliente `TI###` resuelto por `kepler_ods.pv_suc_ip`
 *              (c1 sucursal → c7 TI). ⛔ No se infiere del número de sucursal.
 *
 * Control placebo: la misma búsqueda en la ventana [f−30, f−15] días. Si el cuadre por importe
 * no supera al placebo, el cruce es ruido y se dice.
 *
 * Lo que NO cruza se declara (`sin documento`, `sin TI`), nunca cuenta como «no cuadra».
 *
 * Uso: $env:PROD_DATABASE_URL='postgresql://…'; node database/scripts/pq-m2-cuadre-requisicion-kepler.js [--dias 120] [--ventana 15] [--detalle]
 */
const { Client } = require('pg');

const URL = process.env.PROD_DATABASE_URL || process.env.PROD_DB_URL;
if (!URL) { console.error('Falta PROD_DATABASE_URL'); process.exit(1); }
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const DIAS = arg('--dias', 120);
const VENTANA = arg('--ventana', 15);
const DETALLE = process.argv.includes('--detalle');
const TENANT = '00000000-0000-0000-0000-00000000d01c';

const n = (v) => (v == null ? null : Number(v));
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)} %` : 'NO MEDIDO');
const cerca = (a, b, tolRel = 0.005, tolAbs = 0.01) => a != null && b != null && Math.abs(a - b) <= Math.max(tolAbs, tolRel * Math.max(Math.abs(a), Math.abs(b)));
const mdp = (v) => `$${(v / 1e6).toFixed(2)} M`;

/** Elige el documento que más SKUs de la requisición trae; empate → el más cercano en fecha. */
function elegir(cands) {
  if (!cands.length) return null;
  const s = [...cands].sort((a, b) => b.comunes - a.comunes || Math.abs(a.dias) - Math.abs(b.dias));
  const top = s[0];
  const empate = s.filter((c) => c.comunes === top.comunes && c.dias === top.dias).length > 1;
  return { ...top, confianza: top.comunes === 0 ? 'sin_sku' : empate ? 'ambigua' : 'alta' };
}

/** Clasifica UN renglón presente en los dos lados. Cajas de la Suite contra la unidad de Kepler. */
function clasificar(s, k) {
  const upc = k.upc; // unidades_por_caja (kdm2.c58)
  const importeOk = cerca(s.importe, k.importe);
  if (upc == null || upc <= 0) return importeOk ? 'cuadra_sin_factor' : 'sin_factor';
  const qtyOk = cerca(s.cajas * upc, k.cantidad, 0.01, 0.5);
  const costoOk = cerca(s.costo_caja / upc, k.costo, 0.005, 0.005);
  if (importeOk && qtyOk && costoOk) return cerca(s.cajas, k.cantidad, 0, 0.0001) ? 'cuadra' : 'cuadra_via_c58';
  if (qtyOk && !costoOk) return 'costo_movido';
  if (!qtyOk && costoOk) return 'cantidad_cambiada';
  return 'ambos_difieren';
}

(async () => {
  const c = new Client({ connectionString: URL, ssl: { rejectUnauthorized: false }, statement_timeout: 300000 });
  await c.connect();
  await c.query('SET default_transaction_read_only = on');
  const id = (await c.query("SELECT system_identifier::text sid, current_database() db, now()::text t FROM pg_control_system()")).rows[0];
  console.log(`# [PQ.M2] cuadre requisición ↔ Kepler · ${id.db} · system_identifier ${id.sid} · ${id.t}`);
  console.log(`# universo: requisiciones approved/ordered/received creadas en los últimos ${DIAS} d · ventana real [f, f+${VENTANA}] · placebo [f−30, f−15]\n`);

  // ─── Requisiciones con sus renglones (compra y traspaso) ────────────────────────────────────
  const reqs = (await c.query(`
    SELECT r.id, r.folio, r.source_type, r.estado,
           (r.created_at AT TIME ZONE 'America/Mexico_City')::date::text AS fecha,
           r.total_cost::numeric AS total,
           w.kepler_code AS suc, w.name AS suc_nombre,
           ow.kepler_code AS origen, ow.name AS origen_nombre,
           s.code AS prov, s.name AS prov_nombre,
           (SELECT btrim(ip.c7) FROM kepler_ods.pv_suc_ip ip WHERE btrim(ip.c1) = w.kepler_code AND btrim(coalesce(ip.c7,'')) <> '' LIMIT 1) AS ti,
           json_agg(json_build_object('sku', p.sku, 'cajas', l.final_qty, 'costo_caja', l.unit_cost, 'importe', l.line_cost) ORDER BY p.sku) AS lineas
      FROM commercial.purchase_requisitions r
      JOIN commercial.warehouses w ON w.id = r.warehouse_id
      LEFT JOIN commercial.warehouses ow ON ow.id = r.source_warehouse_id
      LEFT JOIN catalog.suppliers s ON s.id = r.supplier_id
      JOIN commercial.purchase_requisition_lines l ON l.requisition_id = r.id
      JOIN catalog.products p ON p.id = l.product_id
     WHERE r.tenant_id = $1 AND r.estado IN ('approved','ordered','received')
       AND r.created_at >= now() - ($2 || ' days')::interval
     GROUP BY r.id, w.kepler_code, w.name, ow.kepler_code, ow.name, s.code, s.name
     ORDER BY r.created_at`, [TENANT, String(DIAS)])).rows;

  const compras = reqs.filter((r) => r.source_type === 'supplier');
  const trasp = reqs.filter((r) => r.source_type === 'branch');
  console.log(`requisiciones: ${reqs.length} (compra ${compras.length} · traspaso ${trasp.length})`);

  // ─── Candidatos de COMPRA: OC y requisición de Kepler del mismo proveedor y sucursal ────────
  async function candidatosCompra(r, desde, hasta) {
    if (!r.suc || !r.prov) return [];
    const skus = r.lineas.map((l) => String(l.sku));
    return (await c.query(`
      SELECT d.doctype, d.sucursal, d.folio, d.doc_date::text AS fecha, d.doc_date - $4::date AS dias, d.monto::numeric AS monto,
             (SELECT count(DISTINCT ln.sku) FROM analytics.erp_purchase_doc_lines ln
               WHERE ln.tenant_id = $1 AND ln.doctype = d.doctype AND ln.sucursal = d.sucursal AND ln.folio = d.folio AND ln.sku = ANY($5)) AS comunes
        FROM analytics.erp_purchase_docs d
       WHERE d.tenant_id = $1 AND d.doctype IN ('XA3501','XA3001') AND d.sucursal = $2 AND d.proveedor_code = $3
         AND d.doc_date BETWEEN $4::date + $6::int AND $4::date + $7::int`,
      [TENANT, r.suc, r.prov, r.fecha, skus, desde, hasta])).rows.map((x) => ({ ...x, dias: n(x.dias), monto: n(x.monto), comunes: n(x.comunes) }));
  }
  async function lineasCompra(d) {
    return (await c.query(`
      SELECT sku, cantidad::numeric AS cantidad, unidad, costo_unitario::numeric AS costo, importe::numeric AS importe, unidades_por_caja::numeric AS upc, unidad_caja
        FROM analytics.erp_purchase_doc_lines WHERE tenant_id = $1 AND doctype = $2 AND sucursal = $3 AND folio = $4`,
      [TENANT, d.doctype, d.sucursal, d.folio])).rows.map((x) => ({ ...x, cantidad: n(x.cantidad), costo: n(x.costo), importe: n(x.importe), upc: n(x.upc) }));
  }

  // ─── Candidatos de TRASPASO: U-D-40 creado en el ORIGEN hacia el TI del destino ─────────────
  async function candidatosTraspaso(r, desde, hasta) {
    if (!r.origen || !r.ti) return [];
    const skus = r.lineas.map((l) => String(l.sku));
    return (await c.query(`
      SELECT 'UD40' AS doctype, h.sucursal, btrim(h.c6::text) AS folio, h.c9::date::text AS fecha, h.c9::date - $3::date AS dias, h.c16::numeric AS monto,
             (SELECT count(DISTINCT btrim(l.c8::text)) FROM kepler_ods.kdm2 l
               WHERE l.sucursal = h.sucursal AND l.c1 = h.c1 AND l.c2 = h.c2 AND l.c3 = h.c3 AND l.c4 = h.c4 AND l.c6 = h.c6 AND btrim(l.c8::text) = ANY($4)) AS comunes
        FROM kepler_ods.kdm1 h
       WHERE h.sucursal = $1 AND h.c2 = 'U' AND h.c3 = 'D' AND h.c4 = '40' AND btrim(h.c10::text) = $2
         AND h.c9::date BETWEEN $3::date + $5::int AND $3::date + $6::int`,
      [r.origen, r.ti, r.fecha, skus, desde, hasta])).rows.map((x) => ({ ...x, dias: n(x.dias), monto: n(x.monto), comunes: n(x.comunes) }));
  }
  async function lineasTraspaso(d) {
    return (await c.query(`
      SELECT btrim(l.c8::text) AS sku, l.c9::numeric AS cantidad, btrim(l.c11::text) AS unidad, l.c12::numeric AS costo, l.c13::numeric AS importe,
             NULLIF(NULLIF(btrim(l.c58::text),''),'0')::numeric AS upc, btrim(l.c55::text) AS unidad_caja
        FROM kepler_ods.kdm1 h JOIN kepler_ods.kdm2 l
          ON l.sucursal = h.sucursal AND l.c1 = h.c1 AND l.c2 = h.c2 AND l.c3 = h.c3 AND l.c4 = h.c4 AND l.c6 = h.c6
       WHERE h.sucursal = $1 AND h.c2 = 'U' AND h.c3 = 'D' AND h.c4 = '40' AND btrim(h.c6::text) = $2`,
      [d.sucursal, d.folio])).rows.map((x) => ({ ...x, cantidad: n(x.cantidad), costo: n(x.costo), importe: n(x.importe), upc: n(x.upc) }));
  }

  // ─── El cruce, por tipo ─────────────────────────────────────────────────────────────────────
  async function cruzar(tipo, lista, cands, lineasDe) {
    const R = { tipo, n: lista.length, sin_llave: 0, real_doc: 0, real_sku: 0, real_total: 0, placebo_doc: 0, placebo_sku: 0, placebo_total: 0,
      cobertura: { '100 %': 0, '70–99 %': 0, '40–69 %': 0, '1–39 %': 0, 'doc sin SKU común': 0, 'sin documento': 0 },
      doc: { fecha_0d: 0, fecha_le3d: 0, total_cuadra: 0, skus_identicos: 0, pares: 0 },
      ren: { comun: 0, solo_suite: 0, solo_kepler: 0, importe: 0, cantidad_cruda: 0, costo_crudo: 0, cantidad_c58: 0, costo_c58: 0 },
      causas: {}, pares: [], solo_suite_skus: {}, dinero_solo_suite: 0, dinero_comun: 0 };
    for (const r of lista) {
      const llave = tipo === 'compra' ? r.suc && r.prov : r.origen && r.ti;
      if (!llave) { R.sin_llave++; R.cobertura['sin documento']++; continue; }
      const pl = elegir(await cands(r, -30, -15));
      if (pl) { R.placebo_doc++; if (pl.comunes > 0) R.placebo_sku++; if (cerca(pl.monto, n(r.total))) R.placebo_total++; }
      const e = elegir(await cands(r, 0, VENTANA));
      if (!e) { R.cobertura['sin documento']++; continue; }
      R.real_doc++;
      const nS = r.lineas.length;
      const cov = e.comunes / nS;
      R.cobertura[cov >= 1 ? '100 %' : cov >= 0.7 ? '70–99 %' : cov >= 0.4 ? '40–69 %' : cov > 0 ? '1–39 %' : 'doc sin SKU común']++;
      if (e.comunes === 0) continue;
      R.real_sku++;
      if (cerca(e.monto, n(r.total))) R.real_total++;
      // Documento
      R.doc.pares++;
      if (e.dias === 0) R.doc.fecha_0d++;
      if (Math.abs(e.dias) <= 3) R.doc.fecha_le3d++;
      if (cerca(e.monto, n(r.total))) R.doc.total_cuadra++;
      // Renglones
      const K = new Map((await lineasDe(e)).map((l) => [String(l.sku), l]));
      const S = new Map(r.lineas.map((l) => [String(l.sku), { cajas: n(l.cajas), costo_caja: n(l.costo_caja), importe: n(l.importe) }]));
      const comunes = [...S.keys()].filter((k) => K.has(k));
      const soloS = [...S.keys()].filter((k) => !K.has(k));
      const soloK = [...K.keys()].filter((k) => !S.has(k));
      if (!soloS.length && !soloK.length) R.doc.skus_identicos++;
      R.ren.comun += comunes.length; R.ren.solo_suite += soloS.length; R.ren.solo_kepler += soloK.length;
      for (const k of soloS) { R.solo_suite_skus[k] = (R.solo_suite_skus[k] || 0) + 1; R.dinero_solo_suite += S.get(k).importe || 0; }
      const causasPar = {};
      for (const k of comunes) {
        const s = S.get(k), kk = K.get(k);
        R.dinero_comun += s.importe || 0;
        if (cerca(s.importe, kk.importe)) R.ren.importe++;
        if (cerca(s.cajas, kk.cantidad, 0, 0.0001)) R.ren.cantidad_cruda++;
        if (cerca(s.costo_caja, kk.costo)) R.ren.costo_crudo++;
        if (kk.upc > 0 && cerca(s.cajas * kk.upc, kk.cantidad, 0.01, 0.5)) R.ren.cantidad_c58++;
        if (kk.upc > 0 && cerca(s.costo_caja / kk.upc, kk.costo, 0.005, 0.005)) R.ren.costo_c58++;
        const cl = clasificar(s, kk);
        R.causas[cl] = (R.causas[cl] || 0) + 1; causasPar[cl] = (causasPar[cl] || 0) + 1;
      }
      R.pares.push({ suite: r.folio, estado: r.estado, fecha: r.fecha, kepler: `${e.sucursal}/${e.doctype}/${e.folio}`, dias: e.dias, confianza: e.confianza,
        skus: `${comunes.length}/${nS}`, solo_suite: soloS.length, solo_kepler: soloK.length, total_suite: n(r.total), total_kepler: e.monto, causas: JSON.stringify(causasPar) });
    }
    return R;
  }

  const RC = await cruzar('compra', compras, candidatosCompra, lineasCompra);
  const RT = await cruzar('traspaso', trasp, candidatosTraspaso, lineasTraspaso);

  for (const R of [RC, RT]) {
    console.log(`\n## ${R.tipo.toUpperCase()} — ${R.n} requisiciones`);
    if (R.sin_llave) console.log(`  ⚠️ ${R.sin_llave} sin llave para buscar (${R.tipo === 'compra' ? 'sin código de proveedor o sucursal Kepler' : 'sin origen o sin TI en pv_suc_ip'}): declaradas, no cuentan como «no cuadra»`);
    console.table([
      { prueba: 'hay documento mismo proveedor/destino y sucursal', real: `${R.real_doc} (${pct(R.real_doc, R.n)})`, placebo: `${R.placebo_doc} (${pct(R.placebo_doc, R.n)})` },
      { prueba: '…y trae al menos un SKU de la requisición', real: `${R.real_sku} (${pct(R.real_sku, R.n)})`, placebo: `${R.placebo_sku} (${pct(R.placebo_sku, R.n)})` },
      { prueba: '…y además el TOTAL cuadra (±0.5 %)', real: `${R.real_total} (${pct(R.real_total, R.n)})`, placebo: `${R.placebo_total} (${pct(R.placebo_total, R.n)})` },
    ]);
    console.log('  cobertura de SKUs por el mejor documento:'); console.table(Object.entries(R.cobertura).map(([k, v]) => ({ tramo: k, requisiciones: v, pct: pct(v, R.n) })));
    const d = R.doc;
    console.log(`  documento (sobre ${d.pares} pares con SKU común):`);
    console.table([
      { columna: 'proveedor / destino', cuadra: `${d.pares}/${d.pares}`, nota: 'por construcción del cruce' },
      { columna: 'sucursal', cuadra: `${d.pares}/${d.pares}`, nota: 'por construcción del cruce' },
      { columna: 'fecha = mismo día', cuadra: `${d.fecha_0d}/${d.pares}`, nota: `≤3 d: ${d.fecha_le3d}` },
      { columna: 'total del documento (±0.5 %)', cuadra: `${d.total_cuadra}/${d.pares}`, nota: '' },
      { columna: 'mismo conjunto de SKUs', cuadra: `${d.skus_identicos}/${d.pares}`, nota: `renglones sólo Suite ${R.ren.solo_suite} (${mdp(R.dinero_solo_suite)}) · sólo Kepler ${R.ren.solo_kepler}` },
    ]);
    const x = R.ren;
    console.log(`  renglón (sobre ${x.comun} SKUs presentes en los dos lados, ${mdp(R.dinero_comun)}):`);
    console.table([
      { columna: 'importe del renglón (±0.5 %)', cuadra: `${x.importe}/${x.comun}`, pct: pct(x.importe, x.comun) },
      { columna: 'cantidad CRUDA (cajas Suite = unidad Kepler)', cuadra: `${x.cantidad_cruda}/${x.comun}`, pct: pct(x.cantidad_cruda, x.comun) },
      { columna: 'cantidad vía c58 (cajas × unidades_por_caja)', cuadra: `${x.cantidad_c58}/${x.comun}`, pct: pct(x.cantidad_c58, x.comun) },
      { columna: 'costo CRUDO (costo caja Suite = costo unidad Kepler)', cuadra: `${x.costo_crudo}/${x.comun}`, pct: pct(x.costo_crudo, x.comun) },
      { columna: 'costo vía c58 (costo caja ÷ unidades_por_caja)', cuadra: `${x.costo_c58}/${x.comun}`, pct: pct(x.costo_c58, x.comun) },
    ]);
    console.log('  causa por renglón común:'); console.table(Object.entries(R.causas).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ causa: k, renglones: v, pct: pct(v, x.comun) })));
    const top = Object.entries(R.solo_suite_skus).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (top.length) { console.log('  SKUs que la Suite pidió y el documento de Kepler NO trae (top):'); console.table(top.map(([k, v]) => ({ sku: k, veces: v }))); }
    if (DETALLE) { console.log('  pares:'); console.table(R.pares); }
  }

  console.log('\n## Lo que este cruce NO mide (declarado)');
  console.log('  · Campos que la Suite publica y Kepler no tiene (fill rate, colchón, clase ABC, «pendiente», IAD, sugerido): son DERIVADOS nuestros. Que la pantalla no los rotule como dato del ERP se verifica a mano (nivel C).');
  console.log('  · Requisiciones de un almacén sin código Kepler: fuera del cruce, no «no cuadra».');
  console.log('  · Un documento elegido con confianza «ambigua» (dos candidatos empatados) puede ser el otro.');
  await c.end();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
