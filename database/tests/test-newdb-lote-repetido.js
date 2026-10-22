/* eslint-disable no-console */
/**
 * `[RA-UX.1b]` CANDADO DEL LOTE REPETIDO — corre el SQL REAL de `lote-repetido.ts` (ts-node).
 *
 * ── Por qué existe, medido en prod el 2026-10-21 ────────────────────────────────────────────
 *
 * `/compras/pedido` dejaba el botón armado tras «Generar»: 9 de 106 lotes repetían a otro de la
 * misma persona a 1.2 min de mediana; en 5 pares las dos copias seguían vivas ($264,619). El
 * servidor ahora contesta 409 si un lote repite renglones de compra recientes de quien lo manda.
 *
 * ── Las dos mitades, que se comportan distinto a propósito ──────────────────────────────────
 *
 *   1. **REPRODUCCIÓN DE LA HISTORIA — SÓLO LECTURA.** Cada lote real se vuelve a mandar al
 *      candado tal como lo mandó la pantalla (sus documentos de compra, con destino y cantidad),
 *      parado en el instante en que se creó. El resultado se compara contra un TESTIGO
 *      independiente: el cruce por pares con el que se midió el defecto, escrito aparte. Los dos
 *      tienen que señalar EXACTAMENTE los mismos lotes. Placebo: el mismo ejercicio corrido 7
 *      días después tiene que coincidir también con su testigo — y no puede señalarlo todo.
 *      ⚠️ Usa el `estado` de HOY de los lotes previos (uno cancelado después se ve cancelado):
 *      testigo y candado leen lo mismo, así que la comparación es justa; lo que no es, es una
 *      foto exacta de lo que el candado habría dicho aquel día.
 *      Sin historia de lotes (la base sembrada del CI): NO MEDIDO, nunca ✔.
 *   2. **CASOS SINTÉTICOS — ESCRIBEN, con ROLLBACK, sólo contra una base LOCAL** (`classify`):
 *      el repetido se detecta, y NO se detecta si está cancelado, si es de otra persona, si pasó
 *      la ventana, si cambió la cantidad o si es un traspaso. Contra cualquier otra base: NO MEDIDO.
 *
 * Lo que NO ejerce: el camino HTTP (controlador → 409 → diálogo de la pantalla). Las 65 suites
 * HTTP no corren en el CI; ese tramo lo cubren las pruebas del componente y del servicio.
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
  mod = require(path.resolve(__dirname, '../../libs/commercial/src/lib/commercial-replenishment/lote-repetido.ts'));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar lote-repetido.ts con ts-node: ${e.message}`);
  process.exit(2);
}
const { buscarLoteRepetido, renglonesDeCompra, VENTANA_LOTE_REPETIDO_MIN } = mod;

/** El TESTIGO: el cruce por pares de la medición, escrito aparte del SQL del candado. */
async function testigo(db, desfaseDias) {
  const r = await db.raw(`
    WITH l AS (
      SELECT r.batch_id, r.created_by, r.created_at, r.estado, ln.product_id,
             COALESCE(ln.destination_warehouse_id, r.warehouse_id) AS dst, ln.final_qty
        FROM commercial.purchase_requisitions r
        JOIN commercial.purchase_requisition_lines ln ON ln.requisition_id = r.id AND ln.tenant_id = r.tenant_id
       WHERE r.tenant_id = ? AND r.batch_id IS NOT NULL AND r.source_type = 'supplier' AND ln.final_qty > 0
    ), b AS (SELECT DISTINCT batch_id, created_by, min(created_at) OVER (PARTITION BY batch_id) AS t0 FROM l)
    SELECT DISTINCT b.batch_id
      FROM b
      JOIN l nb ON nb.batch_id = b.batch_id
      JOIN l a  ON a.created_by = b.created_by AND a.product_id = nb.product_id AND a.dst = nb.dst
               AND a.final_qty = nb.final_qty AND a.estado <> 'cancelled'
               AND a.created_at <  b.t0 + make_interval(days => ?)
               AND a.created_at >= b.t0 + make_interval(days => ?) - make_interval(mins => ?)`,
  [T, desfaseDias, desfaseDias, VENTANA_LOTE_REPETIDO_MIN]);
  return new Set(r.rows.map((x) => x.batch_id));
}

/** Los lotes reales, con sus documentos de compra tal como los manda la pantalla. */
async function lotes(db) {
  const r = await db.raw(`
    SELECT r.batch_id, r.created_by, min(r.created_at) OVER (PARTITION BY r.batch_id) AS t0,
           r.id, r.warehouse_id, ln.product_id, ln.destination_warehouse_id, ln.final_qty
      FROM commercial.purchase_requisitions r
      JOIN commercial.purchase_requisition_lines ln ON ln.requisition_id = r.id AND ln.tenant_id = r.tenant_id
     WHERE r.tenant_id = ? AND r.batch_id IS NOT NULL AND r.source_type = 'supplier' AND r.created_by IS NOT NULL`, [T]);
  const m = new Map();
  for (const x of r.rows) {
    let b = m.get(x.batch_id);
    if (!b) { b = { batch_id: x.batch_id, user: x.created_by, t0: new Date(x.t0), docs: new Map() }; m.set(x.batch_id, b); }
    let d = b.docs.get(x.id);
    if (!d) { d = { warehouse_id: x.warehouse_id, source_type: 'supplier', lines: [] }; b.docs.set(x.id, d); }
    d.lines.push({ product_id: x.product_id, source_type: 'supplier', destination_warehouse_id: x.destination_warehouse_id, final_qty: Number(x.final_qty) });
  }
  return [...m.values()].map((b) => ({ ...b, docs: [...b.docs.values()] }));
}

(async () => {
  const knexes = [];
  console.log('\n[RA-UX.1b] Lote repetido — el SQL real del candado contra la base\n');

  // ── 0. Lo puro, sin base: qué cuenta como renglón de compra ──────────────────────────────
  console.log('0) Forma del payload');
  const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  const r0 = renglonesDeCompra([
    { warehouse_id: U(1), source_type: 'supplier', lines: [
      { product_id: U(10), final_qty: 3 },                                   // destino = encabezado
      { product_id: U(11), destination_warehouse_id: U(2), final_qty: 4 },   // destino = renglón
      { product_id: U(12), final_qty: 0 },                                   // sin cantidad: fuera
    ] },
    { warehouse_id: U(1), source_type: 'branch', lines: [{ product_id: U(13), final_qty: 9 }] },   // traspaso: fuera
  ]);
  ok(r0.length === 2 && r0[0].destino === U(1) && r0[1].destino === U(2),
    'sólo compra con cantidad > 0, destino del renglón o del encabezado (el mismo COALESCE del SQL)');

  // ── 1. La historia, en sólo lectura ───────────────────────────────────────────────────────
  console.log('\n1) Reproducción de los lotes reales (sólo lectura)');
  const ro = require('knex')(require('../knexfile-newdb.js').development);
  knexes.push(ro);
  try {
    await ro.transaction(async (trx) => {
      await trx.raw('SET TRANSACTION READ ONLY');
      const ls = await lotes(trx);
      console.log(`   ${ls.length} lote(s) de compra con autor`);
      if (ls.length < 2) { noMedido('sin historia de lotes en esta base: no hay qué reproducir'); return; }
      for (const [nombre, dias] of [['al momento de crearse', 0], ['PLACEBO, 7 días después', 7]]) {
        const marcados = new Set();
        for (const b of ls) {
          const ahora = new Date(b.t0.getTime() + dias * 86400000);
          const r = await buscarLoteRepetido(trx, { tenantId: T, userId: b.user, docs: b.docs, ahora });
          if (r) marcados.add(b.batch_id);
        }
        const w = await testigo(trx, dias);
        const faltan = [...w].filter((x) => !marcados.has(x)).length;
        const sobran = [...marcados].filter((x) => !w.has(x)).length;
        console.log(`   ${nombre}: candado ${marcados.size} · testigo ${w.size} · faltan ${faltan} · sobran ${sobran}`);
        ok(faltan === 0 && sobran === 0, `${nombre}: el candado señala EXACTAMENTE los lotes del testigo`);
        ok(marcados.size < ls.length, `${nombre}: no señala todo (${marcados.size} de ${ls.length}) — un candado que siempre dice «repetido» no distingue nada`);
        if (dias === 0 && !w.size) noMedido('la historia no tiene ningún repetido: la detección positiva no se ejerció con datos reales');
      }
      throw new Error('__ROLLBACK__');
    });
  } catch (e) {
    if (!/__ROLLBACK__/.test(e.message)) { fail++; console.log('  ✗ la reproducción falló:', e.message); }
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
      // RLS: sin el tenant puesto, la base devuelve 0 filas y el caso saldría NO MEDIDO por plomería.
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      // Medido en prod el 2026-10-21: el producto apunta a `catalog.products` (NO existe
      // `commercial.products`) y `created_by` no tiene FK, así que las dos personas son ids sintéticos.
      const wh = (await trx.raw(`SELECT id FROM commercial.warehouses WHERE tenant_id = ? ORDER BY id LIMIT 1`, [T])).rows;
      const pr = (await trx.raw(`SELECT id FROM catalog.products WHERE tenant_id = ? ORDER BY id LIMIT 1`, [T])).rows;
      if (!wh.length || !pr.length) { noMedido('la base sembrada no trae un almacén y un producto del tenant'); throw new Error('__ROLLBACK__'); }
      const [W, P, A, B] = [wh[0].id, pr[0].id, U(901), U(902)];
      const ahora = new Date();
      const previo = async (o) => {
        const [req] = await trx('commercial.purchase_requisitions').insert({
          tenant_id: T, warehouse_id: W, source_type: 'supplier', folio: `RQ-TEST-${Math.random().toString(36).slice(2, 8)}`,
          estado: o.estado || 'pending_approval', target_basis: 'max', total_lines: 1, total_units: o.qty, total_cost: 0,
          created_by: o.user || A, created_at: new Date(ahora.getTime() - (o.min ?? 5) * 60000),
        }).returning(['id']);
        await trx('commercial.purchase_requisition_lines').insert({
          tenant_id: T, requisition_id: req.id, product_id: P, source_type: 'supplier', final_qty: o.qty, suggested_qty: o.qty, unit_cost: 1, line_cost: o.qty,
        });
      };
      const pide = (qty, src = 'supplier') => [{ warehouse_id: W, source_type: src, lines: [{ product_id: P, source_type: src, final_qty: qty }] }];
      const busca = (docs, user = A) => buscarLoteRepetido(trx, { tenantId: T, userId: user, docs, ahora });

      await previo({ qty: 7 });
      const si = await busca(pide(7));
      ok(!!si && si.renglones === 1 && si.de === 1, 'el mismo renglón, de la misma persona, a 5 min: REPETIDO');
      ok(!(await busca(pide(8))), 'NEGATIVA: otra cantidad no es el mismo pedido');
      ok(!(await busca(pide(7), B)), 'NEGATIVA: otra persona no es un doble clic');
      ok(!(await busca(pide(7, 'branch'))), 'NEGATIVA: un traspaso no entra al candado');
      await previo({ qty: 11, estado: 'cancelled' });
      ok(!(await busca(pide(11))), 'NEGATIVA: lo cancelado no cuenta — volver a pedirlo es justo lo esperado');
      await previo({ qty: 13, min: VENTANA_LOTE_REPETIDO_MIN + 1 });
      ok(!(await busca(pide(13))), `NEGATIVA: fuera de la ventana (${VENTANA_LOTE_REPETIDO_MIN + 1} min) ya no es repetido`);
      throw new Error('__ROLLBACK__');
    });
  } catch (e) {
    if (!/__ROLLBACK__/.test(e.message)) { fail++; console.log('  ✗ los casos sintéticos fallaron:', e.message); }
  }
  return fin(knexes);
})().catch(async (e) => { console.error('  ✗', e.message); process.exit(1); });
