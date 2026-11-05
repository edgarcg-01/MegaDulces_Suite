/* eslint-disable no-console */
/**
 * `[PQ.69]` + `[PQ.68]` CANDADO DE LA COMPRA APROBADA SIN DOCUMENTO EN KEPLER (D32) — corre el SQL
 * REAL de `compra-sin-documento.ts` (ts-node).
 *
 * ── Por qué existe, medido en prod el 2026-11-04 ────────────────────────────────────────────
 *
 * 85 compras aprobadas sin documento. Por productos solos, 38 «ya estaban» en Kepler, pero el
 * placebo (30 a 90 días antes) también casaba 21: esos proveedores surten lo mismo una y otra vez.
 * Por IMPORTE de renglón casan 25 con un solo documento y el placebo 2 (de un renglón); con la
 * regla quedan 23. Cancelables hoy (antes del 27-oct, 30 días sin nada): 16.
 *
 * ── Las dos mitades ─────────────────────────────────────────────────────────────────────────
 *
 *   1. **SÓLO LECTURA.** Cada liga propuesta se verifica APARTE, renglón por renglón (producto e
 *      importe, en JS), y ninguna OC sale dos veces ni ya está ligada. Cada cancelable se verifica
 *      con una consulta propia: sin renglones de Kepler con sus productos en la ventana. PLACEBO:
 *      con el reloj diez años atrás no hay nada que cancelar. Sin compras aprobadas: NO MEDIDO.
 *   2. **CASOS SINTÉTICOS — ESCRIBEN, con ROLLBACK, sólo contra una base LOCAL** (el CI), en una
 *      sucursal de prueba (`96`) con sus propios documentos de Kepler: liga la que casa completa;
 *      NO liga si un importe se sale, si el mismo pedido ya existía antes (ambiguo), si dos
 *      requisiciones reclaman la misma OC, ni si la OC es de otro proveedor. Cancela la de antes del
 *      27-oct sin nada; NO cancela si hay una entrada de otro proveedor con sus productos, si el
 *      proveedor tiene otro documento, si tiene error de envío ni si se aprobó después del 27-oct.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const fin = async (knexes) => {
  for (const k of knexes) { try { await k.destroy(); } catch { /* nada */ } }
  console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
  process.exit(fail ? 1 : (pass ? 0 : 2));
};

let mod;
try {
  require('ts-node').register({
    transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' },
  });
  mod = require(path.resolve(__dirname, '../../libs/commercial/src/lib/commercial-replenishment/compra-sin-documento.ts'));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar compra-sin-documento.ts con ts-node: ${e.message}`);
  process.exit(2);
}
const { compraSinDocumentoLigas, compraSinDocumentoCancelables, limpiarComprasSinDocumento, MOTIVO_COMPRA_SIN_DOCUMENTO } = mod;
/** Fija AQUÍ, no importada: si el módulo afloja su tolerancia, esta verificación no la sigue. */
const TOLERANCIA = 0.005;

(async () => {
  const knexes = [];
  console.log('\n[PQ.69][PQ.68] Compras aprobadas sin documento en Kepler (D32)\n');

  // ── 1. Sólo lectura ───────────────────────────────────────────────────────────────────────
  console.log('1) Las ligas y las cancelables, verificadas aparte (sólo lectura)');
  const ro = require('knex')(require('../knexfile-newdb.js').development);
  knexes.push(ro);
  try {
    await ro.transaction(async (trx) => {
      await trx.raw('SET TRANSACTION READ ONLY');
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      const hay = Number((await trx.raw(
        `SELECT count(*)::int n FROM commercial.purchase_requisitions WHERE tenant_id = ? AND source_type = 'supplier' AND estado = 'approved' AND kepler_folio IS NULL`, [T])).rows[0].n);
      if (!hay) { noMedido('sin compras aprobadas sin documento en esta base'); throw new Error('__ROLLBACK__'); }
      const ligas = await compraSinDocumentoLigas(trx, T, 1000);
      let bien = 0;
      for (const g of ligas) {
        const rl = (await trx.raw(`SELECT btrim(p.sku) sku, sum(l.line_cost)::float c FROM commercial.purchase_requisition_lines l
            JOIN catalog.products p ON p.id = l.product_id WHERE l.requisition_id = ? AND l.final_qty > 0 GROUP BY 1`, [g.id])).rows;
        const kl = (await trx.raw(`SELECT btrim(c8) sku, sum(c13)::float c FROM kepler_ods.kdm2
            WHERE sucursal = ? AND c2 = 'X' AND c3 = 'A' AND c4 = 35 AND btrim(c6) = ? GROUP BY 1`, [g.suc, g.folio])).rows;
        const m = new Map(kl.map((x) => [x.sku, x.c]));
        if (rl.length && rl.every((x) => m.has(x.sku) && Math.abs(m.get(x.sku) - x.c) <= TOLERANCIA * x.c)) bien++;
      }
      const ocs = ligas.map((g) => `${g.suc}/${g.folio}`);
      console.log(`   ${hay} compra(s) aprobadas sin documento · se ligarían ${ligas.length}`);
      ok(bien === ligas.length, `cada liga casa APARTE renglón por renglón (${bien} de ${ligas.length})`);
      ok(new Set(ocs).size === ocs.length, 'ninguna OC se liga a dos compras');
      if (!ligas.length) noMedido('ninguna liga hoy: la detección positiva no se ejerció con datos reales');

      const canc = await compraSinDocumentoCancelables(trx, T, new Date(), 1000);
      let limpias = 0;
      for (const id of canc) {
        const x = (await trx.raw(`SELECT count(*)::int n
            FROM commercial.purchase_requisitions r
            JOIN commercial.warehouses w ON w.id = r.warehouse_id
            JOIN commercial.purchase_requisition_lines l ON l.requisition_id = r.id AND l.final_qty > 0
            JOIN catalog.products p ON p.id = l.product_id
            JOIN kepler_ods.kdm2 kl ON kl.sucursal = w.kepler_code AND kl.c2 = 'X' AND kl.c3 = 'A' AND kl.c4 IN (30, 35, 40) AND btrim(kl.c8) = btrim(p.sku)
            JOIN kepler_ods.kdm1 k ON k.sucursal = kl.sucursal AND k.c1 = kl.c1 AND k.c2 = 'X' AND k.c3 = 'A' AND k.c4 = kl.c4 AND k.c5 = kl.c5 AND k.c6 = kl.c6
           WHERE r.id = ? AND k.c68 >= r.created_at::date - 2 AND k.c68 < r.created_at::date + 30`, [id])).rows[0].n;
        if (!x) limpias++;
      }
      console.log(`   se cancelarían ${canc.length}`);
      ok(limpias === canc.length, `ninguna cancelable tiene renglones de Kepler con sus productos (${limpias} de ${canc.length})`);
      const atras = await compraSinDocumentoCancelables(trx, T, new Date(Date.now() - 3650 * 86400000), 1000);
      ok(atras.length === 0, `PLACEBO: con el reloj diez años atrás no hay nada que cancelar (${atras.length})`);
      throw new Error('__ROLLBACK__');
    });
  } catch (e) {
    if (!/__ROLLBACK__/.test(e.message)) { fail++; console.log('  ✗ la lectura falló:', e.message); }
  }

  // ── 2. Casos sintéticos: escriben, con rollback, sólo en base local ───────────────────────
  console.log('\n2) Casos sintéticos (escriben con ROLLBACK, sólo base local)');
  const { classify } = require('./_lib/assert-safe-target');
  const url = process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW || null;
  const kind = classify(url).kind;
  if (kind !== 'local') {
    noMedido(`destino ${kind}: los casos que escriben sólo corren contra una base local (el CI)`);
    return fin(knexes);
  }
  const rw = require('knex')({ client: 'pg', connection: url });
  knexes.push(rw);
  try {
    await rw.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      const SUC = '96';
      const prods = (await trx.raw(`SELECT id, btrim(sku) sku FROM catalog.products WHERE tenant_id = ? AND btrim(COALESCE(sku, '')) <> '' ORDER BY id LIMIT 3`, [T])).rows;
      if (prods.length < 3) { noMedido('la base sembrada no trae tres productos con SKU'); throw new Error('__ROLLBACK__'); }
      const [P1, P2, P3] = prods;
      const [wh] = await trx('commercial.warehouses').insert({ tenant_id: T, code: 'PRB96', name: 'Prueba PQ.69', kepler_code: SUC }).returning('id');
      const W = wh.id || wh;
      const [sp] = await trx('catalog.suppliers').insert({ tenant_id: T, code: 'PRB96', name: 'PROVEEDOR PRUEBA 96' }).returning('id');
      const S = sp.id || sp;
      const dia = (base, d) => new Date(new Date(base).getTime() + d * 86400000);
      const HOY = new Date();
      const req = async (o) => {
        const [r] = await trx('commercial.purchase_requisitions').insert({
          tenant_id: T, warehouse_id: W, supplier_id: S, source_type: 'supplier', estado: 'approved', target_basis: 'max',
          folio: `RQ-TEST-${Math.random().toString(36).slice(2, 9)}`, total_lines: o.lineas.length, total_units: 1, total_cost: 0,
          created_at: o.creada, approved_at: o.aprobada || o.creada, kepler_error: o.error || null,
        }).returning('id');
        const id = r.id || r;
        for (const [p, costo] of o.lineas) {
          await trx('commercial.purchase_requisition_lines').insert({ tenant_id: T, requisition_id: id, product_id: p.id, final_qty: 1, suggested_qty: 1, unit_cost: costo, line_cost: costo });
        }
        return id;
      };
      let n = 0;
      const doc = async (c4, prov, fecha, renglones) => {
        const folio = `T${String(++n).padStart(6, '0')}`;
        await trx('kepler_ods.kdm1').insert({ sucursal: SUC, c1: SUC, c2: 'X', c3: 'A', c4, c5: 1, c6: folio, c10: prov, c9: fecha, c68: fecha });
        let i = 0;
        for (const [p, imp] of renglones) {
          await trx('kepler_ods.kdm2').insert({ sucursal: SUC, c1: SUC, c2: 'X', c3: 'A', c4, c5: 1, c6: folio, c7: ++i, c8: p.sku, c9: 1, c13: imp, c32: fecha });
        }
        return folio;
      };
      const est = async (id) => trx('commercial.purchase_requisitions').where({ id }).first('estado', 'oc_sucursal', 'oc_folio', 'rejection_reason', 'rejected_by');

      // Ligar: compras de hace 10 días (fuera del universo de cancelar).
      const c10 = dia(HOY, -10);
      const A = await req({ creada: c10, lineas: [[P1, 100], [P2, 250]] });
      const ocA = await doc(35, 'PRB96', dia(c10, 1), [[P1, 100.2], [P2, 250]]);
      const B = await req({ creada: c10, lineas: [[P1, 500]] });
      await doc(35, 'PRB96', dia(c10, 2), [[P1, 520]]);
      const C = await req({ creada: c10, lineas: [[P3, 77]] });
      await doc(35, 'PRB96', dia(c10, 1), [[P3, 77]]);
      await doc(35, 'PRB96', dia(c10, -60), [[P3, 77]]);
      const D1 = await req({ creada: c10, lineas: [[P2, 300]] });
      const D2 = await req({ creada: c10, lineas: [[P2, 300]] });
      await doc(35, 'PRB96', dia(c10, 3), [[P2, 300]]);
      const E = await req({ creada: c10, lineas: [[P3, 88]] });
      await doc(35, 'OTRO96', dia(c10, 1), [[P3, 88]]);

      // Cancelar: universo de D32 (aprobadas antes del 27-oct), con fechas fijas.
      const F = await req({ creada: new Date('2026-09-20T15:00:00Z'), lineas: [[P1, 10]] });
      const G = await req({ creada: new Date('2026-09-20T15:00:00Z'), lineas: [[P2, 11]] });
      await doc(40, 'OTRO96', new Date('2026-09-25T15:00:00Z'), [[P2, 999]]);
      const H = await req({ creada: new Date('2026-07-01T15:00:00Z'), lineas: [[P3, 12]] });
      await doc(30, 'PRB96', new Date('2026-07-05T15:00:00Z'), [[P1, 5]]);
      const I = await req({ creada: new Date('2026-09-20T15:00:00Z'), lineas: [[P1, 13]], error: 'Kepler no conoce al proveedor' });
      const J = await req({ creada: new Date('2026-09-20T15:00:00Z'), aprobada: new Date('2026-10-28T15:00:00Z'), lineas: [[P1, 14]] });

      const r = await limpiarComprasSinDocumento(trx, T, HOY, 1000);
      const a = await est(A);
      ok(a.estado === 'ordered' && a.oc_sucursal === SUC && a.oc_folio === ocA, `todos los renglones casan por importe (±0.5 %): LIGADA a ${SUC}/${ocA} (${a.estado})`);
      ok((await est(B)).estado === 'approved', 'NEGATIVA: un importe 4 % distinto no liga');
      ok((await est(C)).estado === 'approved', 'NEGATIVA: el mismo pedido ya existía 60 días antes — ambiguo, no liga');
      ok((await est(D1)).estado === 'approved' && (await est(D2)).estado === 'approved', 'NEGATIVA: dos compras reclaman la misma OC — ninguna liga');
      ok((await est(E)).estado === 'approved', 'NEGATIVA: la OC de otro proveedor no liga');
      const f = await est(F);
      ok(f.estado === 'cancelled' && String(f.rejection_reason).startsWith(MOTIVO_COMPRA_SIN_DOCUMENTO) && f.rejected_by === null,
        `antes del 27-oct y 30 días sin nada: CANCELADA, con motivo y sin persona (${f.estado})`);
      ok((await est(G)).estado === 'approved', 'NEGATIVA: una entrada de otro proveedor con su producto la deja viva');
      ok((await est(H)).estado === 'approved', 'NEGATIVA: el proveedor tiene otro documento en la ventana — la deja viva');
      ok((await est(I)).estado === 'approved', 'NEGATIVA: con error de envío se queda para que alguien lo vea');
      ok((await est(J)).estado === 'approved', 'NEGATIVA: aprobada después del 27-oct no es del universo de D32');
      ok(r.ligadas >= 1 && r.canceladas >= 1, `el conteo devuelto cuadra (ligadas ${r.ligadas}, canceladas ${r.canceladas})`);
      const otra = await limpiarComprasSinDocumento(trx, T, HOY, 1000);
      ok(otra.ligadas === 0 && otra.canceladas === 0, 'repetir no toca nada más');
      throw new Error('__ROLLBACK__');
    });
  } catch (e) {
    if (!/__ROLLBACK__/.test(e.message)) { fail++; console.log('  ✗ los casos sintéticos fallaron:', e.message); }
  }
  return fin(knexes);
})().catch(async (e) => { console.error('  ✗', e.message); process.exit(1); });
