// [E.23] Clasifica la salida de replay.js: renglón por renglón (precio) y pedido por pedido
// (importe, IVA, IEPS). Arranca con un control del clasificador: si no acierta, no reporta nada.
// Uso: node scripts/kepler/replay-cotizacion/analiza.js <salida.json>
const fs = require('fs');
const path = require('path');
const { renglones, dias } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

// [E.25] La cuenta REAL de la cotización (libs/contracts quote-totals.ts), empaquetada: el pedido se
// cuadra con la misma función que usan el servidor, la pantalla y el papel, no con una copia.
const RAIZ = path.resolve(__dirname, '..', '..', '..');
const cache = path.join(RAIZ, 'node_modules', '.cache', 'replay-cotizacion');
fs.mkdirSync(cache, { recursive: true });
require(path.join(RAIZ, 'node_modules', 'esbuild')).buildSync({
  entryPoints: [path.join(RAIZ, 'libs/contracts/src/money/quote-totals.ts')],
  bundle: true, platform: 'node', format: 'cjs', outfile: path.join(cache, 'quote-totals.cjs'), logLevel: 'warning',
});
const { totalesCotizacion } = require(path.join(cache, 'quote-totals.cjs'));
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const norm = (v) => {
  const l = String(v || '').trim().toUpperCase();
  return ({ CAJA: 'CJA', BULTO: 'BTO', CUBETA: 'CUB', PAQUETE: 'PAQ' })[l] || l;
};
const pesos = (n) => '$' + n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── CONTROL del clasificador: un renglón idéntico tiene que caer en "exacto" ──
const clasifica = (l) => {
  const m = l.motor;
  if (m.error) return 'error_motor';
  if (m.unit_price === null) return 'sin_precio';
  if (norm(m.unit_label) !== norm(l.un)) return 'unidad_distinta';
  const ePu = r2(m.unit_price);
  const kPu = r2(Number(l.pu));
  if (Math.abs(ePu - kPu) <= 0.005) return 'exacto';
  const kLista = l.lista === null ? null : r2(Number(l.lista));
  if (kLista === null) return 'kepler_sin_lista';
  if (Math.abs(m.list_price - kLista) > 0.01) return 'lista_distinta';
  if (Math.abs(kPu - kLista) <= 0.01) return 'kepler_cobro_lista_motor_bajo';
  if (kPu < ePu) return 'kepler_mas_barato';
  return 'kepler_mas_caro';
};
const ctl = { motor: { unit_price: 51.76, list_price: 55.93, unit_label: 'PAQ' }, pu: 51.76, lista: 55.93, un: 'PAQ' };
if (clasifica(ctl) !== 'exacto') throw new Error('CONTROL del clasificador falló');
if (clasifica({ ...ctl, pu: 55.93 }) !== 'kepler_cobro_lista_motor_bajo') throw new Error('CONTROL 2 del clasificador falló');

// ── Renglones ──
const clases = new Map();
for (const l of renglones) {
  l.clase = clasifica(l);
  const c = clases.get(l.clase) || { n: 0, kepler: 0, motor: 0, dif: 0, ej: [] };
  c.n++;
  c.kepler += Number(l.imp);
  const eTot = l.motor.line_total ?? 0;
  c.motor += eTot;
  c.dif += eTot - Number(l.imp);
  if (c.ej.length < 6) c.ej.push(l);
  clases.set(l.clase, c);
}
const N = renglones.length;
const K = renglones.reduce((a, l) => a + Number(l.imp), 0);
const docs = new Set(renglones.map((l) => l.suc + '|' + l.folio + '|' + l.serie)).size;
console.log(`# Replay — pedidos de telemarketing U-D-40 de los últimos ${dias} día(s)`);
console.log(`Universo: ${docs} pedidos · ${N} renglones · ${pesos(K)} cobrados por Kepler\n`);
console.log('## Renglón: ¿el motor da el mismo precio que Kepler?');
console.log('| clase | renglones | % | importe Kepler | importe motor | motor − Kepler |');
console.log('|---|---:|---:|---:|---:|---:|');
for (const [k, c] of [...clases].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`| ${k} | ${c.n} | ${(100 * c.n / N).toFixed(1)} | ${pesos(c.kepler)} | ${pesos(c.motor)} | ${pesos(c.dif)} |`);
}
for (const [k, c] of clases) {
  if (k === 'exacto') continue;
  console.log(`\n### ejemplos: ${k}`);
  for (const l of c.ej) {
    const m = l.motor;
    console.log(`- ${l.suc} ${l.folio} · ${l.sku} · ${l.qty} ${l.un} · Kepler pu ${l.pu} lista ${l.lista} | motor ${m.unit_label ?? '-'} pu ${m.unit_price} lista ${m.list_price} · aplicó [${(m.applied || []).map((a) => a.step).join(',')}]${m.volume_tier ? ' tramo ' + JSON.stringify(m.volume_tier) : ''}${m.unpriced_reason ? ' · ' + m.unpriced_reason : ''}${m.error ? ' · ERROR ' + m.error : ''}`);
  }
}

// ── Pedido: importe e impuestos ──
const porDoc = new Map();
for (const l of renglones) {
  const k = l.suc + '|' + l.folio + '|' + l.serie;
  const d = porDoc.get(k) || { h: l, ls: [] };
  d.ls.push(l);
  porDoc.set(k, d);
}
const tasa = (v) => Math.abs(Number(v || 0)) / 100;
let dTot = 0, dIncons = 0, dExactos = 0, dTotalOk = 0, ivaA = 0, iepsA = 0, ivaB = 0, iepsB = 0, ambasB = 0, pctDocs = 0;
let ivaC = 0, iepsC = 0, ambasC = 0, asumidosC = 0;
const pad = { igual: 0, distinto: 0, fuera: 0, noMedido: 0 };
const ejB = [];
const ejC = [];
for (const [, d] of porDoc) {
  dTot++;
  const h = d.h;
  const pct = Number(h.pct) / 100;
  if (Number(h.pct) !== 0) pctDocs++;
  // El padrón: «la vista no lo tiene» es distinto de «lo tiene sin %» (= sin descuento).
  if (h.padron_codigo === undefined) pad.noMedido++; // universo anterior a E.25: no traía la columna
  else if (!h.padron_codigo) pad.fuera++;
  else if (Math.abs(Number(h.pct_padron || 0) - Number(h.pct)) < 0.001) pad.igual++;
  else pad.distinto++;
  // La cabecera de un pedido vivo sigue a lo surtido: sólo se compara contra una que cuadra con sus renglones.
  const kSuma = d.ls.reduce((a, l) => a + Number(l.imp), 0);
  if (Math.abs(r2(kSuma * (1 - pct)) - Number(h.importe)) > 0.05) { dIncons++; continue; }
  if (!d.ls.every((l) => l.clase === 'exacto')) continue;
  dExactos++;
  const suma = d.ls.reduce((a, l) => a + l.motor.line_total, 0);
  const total = r2(suma * (1 - pct));
  if (Math.abs(total - Number(h.importe)) <= 0.05) dTotalOk++;
  // A · el modelo de hoy (recalcTotals): todo es IVA 16 %
  const taxA = r2(total - r2(total / 1.16));
  if (Math.abs(taxA - Number(h.iva)) <= 0.05) ivaA++;
  if (Math.abs(0 - Number(h.ieps)) <= 0.05) iepsA++;
  // B · la tasa de CADA producto (kdii c18 IVA / c19 IEPS), sobre el importe ya con el % del cliente
  let iva = 0, ieps = 0;
  for (const l of d.ls) {
    const neto = l.motor.line_total * (1 - pct);
    const ti = tasa(l.kdii_iva), te = tasa(l.kdii_ieps);
    const base = neto / (1 + ti + te);
    iva += base * ti;
    ieps += base * te;
  }
  const okI = Math.abs(r2(iva) - Number(h.iva)) <= 0.05, okE = Math.abs(r2(ieps) - Number(h.ieps)) <= 0.05;
  if (okI) ivaB++;
  if (okE) iepsB++;
  if (okI && okE) ambasB++;
  else if (ejB.length < 5) ejB.push(`${h.suc} ${h.folio}: Kepler IVA ${h.iva} IEPS ${h.ieps} · modelo B IVA ${r2(iva)} IEPS ${r2(ieps)}`);
  // C · la cotización tal cual: tasas que devolvió el MOTOR + totalesCotizacion, al centavo
  const t = totalesCotizacion(d.ls.map((l) => l.motor.line_total), Number(h.pct) || null,
    d.ls.map((l) => ({ iva: l.motor.iva_rate ?? null, ieps: l.motor.ieps_rate ?? null })));
  asumidosC += t.impuesto_asumido;
  const cI = Math.abs(t.iva - Number(h.iva)) <= 0.005, cE = Math.abs(t.ieps - Number(h.ieps)) <= 0.005;
  if (cI) ivaC++;
  if (cE) iepsC++;
  if (cI && cE && Math.abs(t.total - Number(h.importe)) <= 0.005) ambasC++;
  else if (ejC.length < 5) ejC.push(`${h.suc} ${h.folio}: Kepler total ${h.importe} IVA ${h.iva} IEPS ${h.ieps} · cotización ${t.total} / ${t.iva} / ${t.ieps}`);
}
console.log('\n## Pedido: importe e impuestos (cabecera consistente y TODOS sus renglones exactos)');
console.log(`Pedidos: ${dTot} · cabecera que no cuadra con sus propios renglones (pedido vivo, se excluye): ${dIncons} · con cabecera consistente y TODOS los renglones exactos: ${dExactos}`);
console.log(`- importe (Σ renglones × (1 − %cliente del pedido)) = c16: **${dTotalOk} de ${dExactos}**`);
console.log(`- A · modelo actual (IVA 16 % fijo): IVA cuadra en ${ivaA} de ${dExactos}; IEPS (=0) en ${iepsA} de ${dExactos}`);
console.log(`- B · tasa por producto (kdii c18/c19): IVA cuadra en ${ivaB}, IEPS en ${iepsB}, **ambos en ${ambasB} de ${dExactos}**`);
for (const e of ejB) console.log('  - ' + e);
console.log(`- C · LA COTIZACIÓN (tasas del motor + totalesCotizacion, al centavo): total, IVA e IEPS en **${ambasC} de ${dExactos}** (IVA ${ivaC}, IEPS ${iepsC}; renglones con impuesto asumido: ${asumidosC})`);
for (const e of ejC) console.log('  - ' + e);
console.log(`\n## % del cliente: padrón (v_erp_wholesale_customers) contra el % del pedido (kdm1.c19)`);
console.log(pad.noMedido === dTot
  ? `- NO MEDIDO: este universo es anterior a E.25 y no trae si la vista tiene al cliente (corré replay.js de nuevo)`
  : `- en el padrón y mismo % (sin % = 0): ${pad.igual} · en el padrón con % distinto: ${pad.distinto} · **la vista NO lo tiene: ${pad.fuera}** · de ${dTot} pedidos (con % ≠ 0: ${pctDocs})`);

// ── Tasa del maestro contra la tasa del renglón ──
let tOk = 0, tSin = 0;
const tMal = new Map();
for (const l of renglones) {
  if (l.kdii_iva === null && l.kdii_ieps === null) { tSin++; continue; }
  const ok = tasa(l.kdii_iva) === tasa(l.t_iva) && tasa(l.kdii_ieps) === tasa(l.t_ieps);
  if (ok) tOk++;
  else { const k = `kdii ${l.kdii_iva}/${l.kdii_ieps} vs renglón ${l.t_iva}/${l.t_ieps}`; tMal.set(k, (tMal.get(k) || 0) + 1); }
}
console.log(`\n## Tasa de impuesto: maestro kdii (c18/c19) contra el renglón del pedido (kdm2 c17/c18)`);
console.log(`- iguales ${tOk} de ${N} · sin fila en kdii ${tSin} · distintas ${N - tOk - tSin}`);
for (const [k, v] of tMal) console.log(`  - ${k}: ${v}`);
