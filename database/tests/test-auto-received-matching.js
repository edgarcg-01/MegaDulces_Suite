/* eslint-disable no-console */
/**
 * RA.15.1 — Smoke UNITARIO de matchEntradasToOrders (auto-received). Sin DB: valida la
 * lógica de conciliación X-A-40 Kepler ↔ OC abiertas (presencia sku+almacén+fecha, dedup
 * por folio, OC más vieja primero, cap al pendiente, entrada posterior a la OC).
 */
const { matchEntradasToOrders } = require('../importers/kepler/import-auto-received.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// OC A (vieja) y B (nueva), ambas piden sku S1; A además S2.
const orders = [
  { id: 'A', created_date: '2026-07-01', lines: [{ po_line_id: 'A1', product_id: 'pS1', sku: 'S1', pending: 40 }, { po_line_id: 'A2', product_id: 'pS2', sku: 'S2', pending: 20 }] },
  { id: 'B', created_date: '2026-07-05', lines: [{ po_line_id: 'B1', product_id: 'pS1', sku: 'S1', pending: 10 }] },
];

// Test 1 — un X-A-40 con S1 se asigna a la OC MÁS VIEJA (A), cierra su línea S1 en full.
{
  const taken = new Set();
  const r = matchEntradasToOrders(JSON.parse(JSON.stringify(orders)), [{ folio: 'F1', doc_date: '2026-07-03', sku: 'S1' }], taken);
  ok(r.length === 1 && r[0].purchase_order_id === 'A', 'entrada S1 → OC más vieja (A)');
  ok(r[0].lines.length === 1 && r[0].lines[0].po_line_id === 'A1' && r[0].lines[0].received_qty === 40, 'cierra línea A/S1 en full (40)');
  ok(taken.has('F1'), 'folio F1 marcado consumido');
}

// Test 2 — dedup: el mismo folio ya tomado NO se vuelve a asignar.
{
  const taken = new Set(['F1']);
  const r = matchEntradasToOrders(JSON.parse(JSON.stringify(orders)), [{ folio: 'F1', doc_date: '2026-07-03', sku: 'S1' }], taken);
  ok(r.length === 0, 'folio ya consumido → no re-concilia (idempotente)');
}

// Test 3 — entrada ANTERIOR a ambas OC → no matchea (la recepción debe ser posterior).
{
  const taken = new Set();
  const r = matchEntradasToOrders(JSON.parse(JSON.stringify(orders)), [{ folio: 'F0', doc_date: '2026-06-30', sku: 'S1' }], taken);
  ok(r.length === 0, 'entrada previa a la OC → no matchea');
}

// Test 4 — dos folios S1: cierran A y B (uno c/u, más vieja primero); S2 de A queda pendiente.
{
  const taken = new Set();
  const ents = [{ folio: 'F1', doc_date: '2026-07-06', sku: 'S1' }, { folio: 'F2', doc_date: '2026-07-07', sku: 'S1' }];
  const r = matchEntradasToOrders(JSON.parse(JSON.stringify(orders)), ents, taken);
  ok(r.length === 2, 'dos entradas → dos OE');
  ok(r[0].purchase_order_id === 'A' && r[1].purchase_order_id === 'B', 'asigna A (vieja) luego B');
  const aRec = r.find((x) => x.purchase_order_id === 'A');
  ok(aRec.lines.length === 1 && aRec.lines[0].po_line_id === 'A1', 'folio S1 cierra solo la línea S1 de A (S2 sigue pendiente → OC partial)');
}

// Test 5 — folio con S2 cierra la línea S2 de A.
{
  const taken = new Set();
  const r = matchEntradasToOrders(JSON.parse(JSON.stringify(orders)), [{ folio: 'F3', doc_date: '2026-07-08', sku: 'S2' }], taken);
  ok(r.length === 1 && r[0].lines[0].po_line_id === 'A2' && r[0].lines[0].received_qty === 20, 'entrada S2 → cierra línea A/S2 (20)');
}

console.log(`\nRA.15.1 auto-received matching: ${pass} OK, ${fail} fallidos`);
process.exit(fail ? 1 : 0);
