#!/usr/bin/env node
/**
 * [PQ.17] SIMULACRO de la escritura a Kepler — ¿qué porcentaje de las requisiciones y traspasos
 * PASARÍA hoy el adaptador, y por qué motivo rebotaría el resto?
 *
 * Pregunta del PM (2026-10-26): «la inserción en Kepler ya está armada, ¿cómo validamos que el 100 %
 * de las requisiciones y traspasos van a pasar?». La respuesta no es una promesa: es correr, SIN
 * ESCRIBIR, las mismas comprobaciones que hace `kepler-requisition-sink.adapter.ts` sobre TODO el
 * universo (aprobadas sin folio de Kepler + pendientes de aprobación), contra el ODS en sólo
 * lectura, y contar por motivo. Lo que el adaptador rechazaría, acá sale con nombre y folio.
 *
 * Qué se replica del adaptador (misma consulta, misma tabla, vía `kepler_ods.*`):
 *   A  el almacén tiene `kepler_code` (compra: destino; traspaso: origen Y destino)
 *   B  la requisición tiene renglones con cantidad > 0
 *   C  compra: código de proveedor presente y CONOCIDO en Kepler en ESA sucursal
 *      (existe un X-A-30 / X-A-35 con ese `c10` en `kdm1`)
 *   D  traspaso: `pv_suc_ip` tiene el `TI###` de la sucursal destino
 * Lo que el adaptador NO comprueba y acá se mide aparte (riesgo, no rechazo):
 *   E  el SKU existe en la ficha `kdii` de la sucursal donde se escribe
 *   F  renglones con cajas fraccionadas (Kepler acepta numérico; se declara)
 * Lo que NO se puede medir desde la base (configuración por servidor) y se declara:
 *   KEPLER_PUSH_URL_NN, plantilla por servidor (la del traspaso no tiene default), pg_hba,
 *   y el tope diario KEPLER_PUSH_MAX_DIA_NN (default 1): se calcula cuántos DÍAS tomaría vaciar
 *   la cola por servidor con ese default.
 *
 * CONTROL (disciplina de instrumento): RQ-2026-01391 (AJEMEX, sucursal 04) fue rechazada de verdad
 * por el adaptador con «Kepler (sucursal 04) no conoce al proveedor CA027». El simulacro tiene que
 * reproducir ese rechazo; si no, el instrumento se tira.
 *
 * Uso:  node database/scripts/pq-simulacro-escritura-kepler.js [--estado=approved|pending|ambos] [--detalle]
 * Sólo lectura: `SET default_transaction_read_only = on`. Lee PROD_DB_URL del .env.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const RAIZ = path.resolve(__dirname, '..', '..');
const env = fs.readFileSync(path.join(RAIZ, '.env'), 'utf8');
const URL = (env.match(/^PROD_DB_URL=(.*)$/m) || [])[1]?.replace(/^["']|["']$/g, '');
if (!URL) { console.error('Falta PROD_DB_URL en .env'); process.exit(2); }
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const ESTADO = args.estado || 'ambos';
const CONTROL_FOLIO = 'RQ-2026-01391';
const CONTROL_MOTIVO = /no conoce al proveedor CA027/;

(async () => {
  const c = new Client({ connectionString: URL, ssl: { rejectUnauthorized: false }, statement_timeout: 280000 });
  await c.connect();
  const sysid = (await c.query('select system_identifier from pg_control_system()')).rows[0].system_identifier;
  if (String(sysid) !== '7688376744939610156') { console.error('No es pg-prod (system_identifier ' + sysid + ')'); process.exit(2); }
  await c.query('SET default_transaction_read_only = on');

  const estados = ESTADO === 'approved' ? ['approved'] : ESTADO === 'pending' ? ['pending_approval'] : ['approved', 'pending_approval'];
  const cab = (await c.query(`
    SELECT r.id, r.folio, r.estado, r.source_type, r.total_cost,
           to_jsonb(r) ->> 'kepler_folio' AS kepler_folio, to_jsonb(r) ->> 'kepler_error' AS kepler_error,
           w.code AS wcode, w.kepler_code, sw.code AS swcode, sw.kepler_code AS origen_kepler_code,
           sup.code AS prov_code, sup.name AS prov_name
      FROM commercial.purchase_requisitions r
      LEFT JOIN commercial.warehouses w  ON w.tenant_id = r.tenant_id AND w.id = r.warehouse_id
      LEFT JOIN commercial.warehouses sw ON sw.tenant_id = r.tenant_id AND sw.id = r.source_warehouse_id
      LEFT JOIN catalog.suppliers sup    ON sup.tenant_id = r.tenant_id AND sup.id = r.supplier_id
     WHERE r.estado = ANY($1) AND to_jsonb(r) ->> 'kepler_folio' IS NULL
     ORDER BY r.created_at`, [estados])).rows;

  const lineas = (await c.query(`
    SELECT l.requisition_id, btrim(p.sku::text) AS sku, l.final_qty::numeric AS cajas
      FROM commercial.purchase_requisition_lines l
      JOIN catalog.products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
     WHERE l.requisition_id = ANY($1) AND COALESCE(l.final_qty, 0) > 0`, [cab.map((r) => r.id)])).rows;
  const porReq = new Map(); for (const l of lineas) { if (!porReq.has(l.requisition_id)) porReq.set(l.requisition_id, []); porReq.get(l.requisition_id).push(l); }

  // C · proveedores conocidos por sucursal en Kepler (X-A-30/35 con ese c10), igual que el adaptador.
  const provKepler = new Set((await c.query(`
    SELECT DISTINCT btrim(sucursal) || '|' || btrim(c10) AS k FROM kepler_ods.kdm1
     WHERE c2 = 'X' AND c3 = 'A' AND btrim(c4::text) IN ('30', '35') AND btrim(coalesce(c10, '')) <> ''`)).rows.map((r) => r.k));
  // D · TI### por sucursal destino.
  const tiPorSuc = new Set((await c.query(`SELECT DISTINCT btrim(c1) AS s FROM kepler_ods.pv_suc_ip WHERE btrim(coalesce(c7, '')) <> ''`)).rows.map((r) => r.s));
  // E · SKU en la ficha de la sucursal.
  const skuSuc = new Set((await c.query(`SELECT DISTINCT btrim(sucursal) || '|' || btrim(c1) AS k FROM kepler_ods.kdii WHERE btrim(coalesce(c1, '')) <> ''`)).rows.map((r) => r.k));
  await c.end();

  const motivos = new Map(); const porSuc = new Map(); const detalle = [];
  const cuenta = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  let pasan = 0, riesgoSku = 0, fraccion = 0;
  const colaPorServidor = new Map();
  for (const r of cab) {
    const tipo = r.source_type === 'branch' ? 'traspaso' : 'compra';
    const ls = porReq.get(r.id) || [];
    const servidor = tipo === 'compra' ? r.kepler_code : r.origen_kepler_code;
    let motivo = null;
    if (!r.kepler_code) motivo = `A · el almacén ${r.wcode || '?'} no tiene kepler_code`;
    else if (tipo === 'traspaso' && !r.origen_kepler_code) motivo = 'A · el traspaso no tiene sucursal ORIGEN con kepler_code';
    else if (!ls.length) motivo = 'B · sin renglones con cantidad > 0';
    else if (tipo === 'compra' && !(r.prov_code || '').trim()) motivo = 'C · sin código de proveedor Kepler';
    else if (tipo === 'compra' && !provKepler.has(`${servidor}|${r.prov_code.trim()}`)) motivo = `C · Kepler (sucursal ${servidor}) no conoce al proveedor ${r.prov_code.trim()}`;
    else if (tipo === 'traspaso' && !tiPorSuc.has(r.kepler_code)) motivo = `D · pv_suc_ip no tiene el TI### de la sucursal ${r.kepler_code}`;
    if (motivo) { cuenta(motivos, motivo.replace(/proveedor \S+$/, 'proveedor <código>').replace(/sucursal \d+/, 'sucursal NN')); }
    else { pasan++; cuenta(colaPorServidor, servidor); }
    cuenta(porSuc, `${servidor || '?'} · ${tipo} · ${motivo ? 'rebota' : 'pasa'}`);
    const sinFicha = ls.filter((l) => servidor && !skuSuc.has(`${servidor}|${l.sku}`)).length;
    if (!motivo && sinFicha) riesgoSku++;
    const frac = ls.filter((l) => Number(l.cajas) % 1 !== 0).length;
    if (!motivo && frac) fraccion++;
    detalle.push({ folio: r.folio, estado: r.estado, tipo, servidor, proveedor: r.prov_code, destino: r.kepler_code, renglones: ls.length, monto: Math.round(Number(r.total_cost) || 0), motivo: motivo || 'pasa', sku_sin_ficha: sinFicha, cajas_fraccion: frac, kepler_error_real: r.kepler_error });
  }

  // ── CONTROL ──────────────────────────────────────────────────────────────────────────────
  const ctl = detalle.find((d) => d.folio === CONTROL_FOLIO);
  const ctlOk = !!ctl && CONTROL_MOTIVO.test(ctl.motivo) && CONTROL_MOTIVO.test(ctl.kepler_error_real || '');
  console.log(`CONTROL ${CONTROL_FOLIO}: simulacro → «${ctl ? ctl.motivo : 'NO ESTÁ EN EL UNIVERSO'}» · adaptador real → «${ctl ? ctl.kepler_error_real : '—'}» → ${ctlOk ? '✓ coincide' : '✗ NO COINCIDE: el instrumento se tira'}`);
  if (!ctlOk) process.exit(2);

  const n = detalle.length;
  console.log(`\nUniverso: ${n} documentos (${estados.join(' + ')}, sin folio de Kepler) · compras ${detalle.filter((d) => d.tipo === 'compra').length} · traspasos ${detalle.filter((d) => d.tipo === 'traspaso').length}`);
  console.log(`PASARÍAN las comprobaciones del adaptador: ${pasan} (${(100 * pasan / n).toFixed(1)} %) · REBOTARÍAN: ${n - pasan}`);
  console.log('\n== Motivos de rebote (como los escribiría el adaptador)');
  console.table([...motivos.entries()].sort((a, b) => b[1] - a[1]).map(([motivo, docs]) => ({ motivo, docs })));
  console.log('\n== Por servidor donde se escribiría');
  console.table([...porSuc.entries()].sort().map(([k, docs]) => ({ servidor_tipo_resultado: k, docs })));
  console.log(`\n== Riesgos que el adaptador NO detiene (se declaran)\n  · documentos que pasan pero traen SKU sin ficha en esa sucursal (kdii): ${riesgoSku}\n  · documentos que pasan con cajas fraccionadas: ${fraccion}`);
  console.log('\n== Tope diario con el default KEPLER_PUSH_MAX_DIA_NN = 1 (días para vaciar la cola de los que pasan)');
  console.table([...colaPorServidor.entries()].sort().map(([s, docs]) => ({ servidor: s, docs_que_pasan: docs, dias_con_tope_1: docs })));
  console.log('\n== NO MEDIDO desde la base: KEPLER_PUSH_URL_NN por servidor, plantilla de compra y de TRASPASO por servidor (la del traspaso no tiene default: sin ella TODOS los traspasos rebotan), pg_hba y la BAJA desde la UI de Kepler (criterio del canario).');
  if (args.detalle) { console.log('\n== Detalle'); console.table(detalle.filter((d) => d.motivo !== 'pasa').slice(0, 60)); }
  const salida = path.join(RAIZ, 'database', 'scripts', 'out'); fs.mkdirSync(salida, { recursive: true });
  const f = path.join(salida, `pq-simulacro-kepler-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(f, JSON.stringify({ generado: new Date().toISOString(), universo: n, pasan, motivos: Object.fromEntries(motivos), detalle }, null, 1));
  console.log(`\nDetalle completo: ${f}`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
