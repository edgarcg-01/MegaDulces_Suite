#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[PQ.165]` COMPUERTA — **todo monto que se publica dice si lleva impuestos o no.**
 *
 * ── POR QUÉ (el incidente) ───────────────────────────────────────────────────────────────
 * 2026-11-26/27, `/compras/oc-abiertas` y `/compras/pedido`. Edgar vio una OC de $202,496.92 y
 * un «esperado $175,767» y preguntó *«¿no se está aplicando doble vez el IVA?»*. No: el total de
 * Kepler (`kdm1.c16`) lleva IVA e IEPS, los renglones (`kdm2.c13`) no, y el «esperado» era el
 * total CON IVA × la probabilidad de llegar, que se parecía al subtotal SIN IVA por casualidad.
 * Ninguna cifra decía su base, y el pedido —donde se decide cuánto comprar— valuaba todo SIN
 * impuestos mientras la OC y la deuda iban CON. *«Se paga con impuestos, lo correcto es siempre
 * agregar los impuestos desde que se genera la compra, para no sobrecomprar»* — Edgar.
 * La compra real sube ~8.6 % en promedio (71.5 % del valor lleva sólo IEPS 8 %), así que la
 * diferencia NO se ve a ojo: por eso tiene que estar ESCRITA (`[PQ.161]`–`[PQ.164]`, GOTCHAS §96).
 *
 * ── LO QUE MIDE ──────────────────────────────────────────────────────────────────────────
 *  1. **Encabezados de dinero** (`<th>` cuyo texto es Costo, Valor, Importe, Monto, Total,
 *     Precio, Subtotal, Sugerido, Comprado, Inmovilizado, Deuda, A pagar o `$`) que no dicen su
 *     base ni en el texto ni en su `title`.
 *  2. **KPIs de dinero** (`format: 'currency'`) cuya `label` + `sub` no dicen su base.
 *  «Dice su base» = menciona IVA, IEPS, impuesto(s), `c/imp`, «al costo», «a precio» o «sin IVA».
 *  ⚠️ Es una heurística de TEXTO: no sabe si la base dicha es la VERDADERA. Eso se mide contra el
 *  dato (ver GOTCHAS §96); la compuerta sólo impide que una cifra nueva salga sin decirla.
 *
 * ── DEUDA ────────────────────────────────────────────────────────────────────────────────
 * Nace sellada (`check-monto-con-base.deuda.json`, conteo por archivo): frena lo NUEVO. El flujo
 * de compras se barrió a cero el día que nació; lo demás queda declarado como deuda.
 *
 * Uso:
 *   node scripts/check-monto-con-base.js                 # compara contra la deuda
 *   node scripts/check-monto-con-base.js --todo          # lista cada hallazgo
 *   node scripts/check-monto-con-base.js --sellar-deuda  # re-sella la línea base
 *   node scripts/check-monto-con-base.js --self-test     # prueba negativa
 */
'use strict';
const fs = require('fs');
const path = require('path');

const RAIZ_REPO = path.resolve(__dirname, '..');
const RAIZ = path.join(RAIZ_REPO, 'apps', 'view', 'src', 'app');
const DEUDA_FILE = path.join(__dirname, 'check-monto-con-base.deuda.json');

/** Palabras que hacen de un encabezado una cifra de DINERO. */
const DINERO = /(^|[\s(¿>])(costo|valor|importe|monto|total|precio|subtotal|inmovilizado|deuda|a pagar)\b|\$/i;
/** …salvo que lo que cuenta sean cantidades, días o porcentajes. */
const NO_DINERO = /\b(cajas?|cj|piezas?|pz|unidades|unid|d[ií]as|renglones|l[ií]neas|docs?|documentos|productos|skus?|%|kg|cantidad|folios?|n[uú]mero)\b/i;
/** La base declarada. */
const BASE = /\biva\b|\bieps\b|impuesto|c\/imp|\bimp\.|al costo|a precio/i;

function archivos(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) archivos(p, acc);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) acc.push(p);
  }
  return acc;
}

/** Texto visible de un fragmento de plantilla: sin etiquetas ni interpolaciones. */
const visible = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ').replace(/@\w+[^{]*\{|\}/g, ' ').replace(/\s+/g, ' ').trim();

/** Hallazgos de un texto fuente: `{ linea, que }`. */
function revisar(src) {
  const out = [];
  const lineaDe = (i) => src.slice(0, i).split('\n').length;
  // 1. <th ...>…</th>
  const TH = /<th\b([^>]*)>([\s\S]*?)<\/th>/g;
  for (let m; (m = TH.exec(src));) {
    const attrs = m[1];
    const texto = visible(m[2]);
    if (!texto || !DINERO.test(texto) || NO_DINERO.test(texto)) continue;
    const title = (attrs.match(/\btitle="([^"]*)"/) || [])[1] || (attrs.match(/\[title\]="'([^']*)'/) || [])[1] || '';
    if (BASE.test(texto) || BASE.test(title)) continue;
    out.push({ linea: lineaDe(m.index), que: `encabezado «${texto.slice(0, 50)}» sin base (con/sin IVA)` });
  }
  // 2. KPI { label: '…', …, format: 'currency', … sub: '…' }. El objeto se delimita BALANCEANDO
  //    llaves desde el `format`: una regex `[^{}]*` no ve los `sub` con `${…}`, que son la mayoría
  //    (lo destapó el caso negativo del --self-test).
  const FMT = /format:\s*'currency'/g;
  for (let m; (m = FMT.exec(src));) {
    let a = m.index, prof = 0;
    for (; a > 0; a--) { const ch = src[a]; if (ch === '}') prof++; else if (ch === '{') { if (prof === 0) break; prof--; } }
    let b = m.index; prof = 0;
    for (; b < src.length; b++) { const ch = src[b]; if (ch === '{') prof++; else if (ch === '}') { if (prof === 0) break; prof--; } }
    const obj = src.slice(a, b + 1);
    const label = (obj.match(/label:\s*(['`])([^'`]*)\1/) || [])[2] || '';
    // La base puede estar en label, sub o title, y un sub trae comas: se busca en el objeto entero.
    if (BASE.test(obj)) continue;
    // Un sub calculado por un método (`sub: this.valorExisSub()`) se revisa donde se arma: no se adivina aquí.
    if (/sub:\s*this\.\w+\(/.test(obj)) continue;
    // Un sub que llega como VARIABLE (`{ label, value: v, format: 'currency', sub }`): la base la escribe quien llama.
    if (/[,{]\s*sub\s*[,}]/.test(obj)) continue;
    out.push({ linea: lineaDe(a), que: `KPI «${label || '?'}» de dinero sin base en label/sub` });
  }
  return out;
}

function medir() {
  const por = {};
  for (const f of archivos(RAIZ)) {
    const h = revisar(fs.readFileSync(f, 'utf8'));
    if (h.length) por[path.relative(RAIZ_REPO, f).split(path.sep).join('/')] = h;
  }
  return por;
}

if (process.argv.includes('--self-test')) {
  const casos = [
    ['<th class="x">Costo</th>', 1],
    ['<th class="x">Costo sin IVA</th>', 0],
    ['<th title="El total del documento en Kepler: con IVA e IEPS.">Total</th>', 0],
    ['<th>Valor<br/>con impuestos</th>', 0],
    ['<th>$ Pedido</th>', 1],
    ['<th>Total cajas</th>', 0],
    ['<th>Días</th>', 0],
    ["{ label: 'A comprar', value: t.pedido, format: 'currency', tone: 'brand', sub: 'venta × cobertura' }", 1],
    ["{ label: 'A comprar', value: t.pedido, format: 'currency', sub: 'con IVA e IEPS · venta × cobertura' }", 0],
    ["{ label: 'Valor venta', value: t.venta, format: 'currency', sub: 'últimos 30 días, a precio con IVA' }", 0],
    ["    return { label, value: v, format: 'currency', tone, sub };", 0],
    ["{ label: 'Deuda', value: d, format: 'currency', sub: `hasta ${x}` }", 1],
  ];
  let mal = 0;
  for (const [src, esperado] of casos) {
    const n = revisar(src).length;
    if (n !== esperado) { mal++; console.error(`✗ esperaba ${esperado}, dio ${n}: ${src}`); }
  }
  if (mal) { console.error(`[monto-con-base:self] ❌ ${mal} caso(s) mal.`); process.exit(1); }
  console.log(`[monto-con-base:self] ✅ ${casos.length} casos (4 en rojo a propósito).`);
  process.exit(0);
}

const por = medir();
const conteo = Object.fromEntries(Object.entries(por).map(([f, h]) => [f, h.length]));

if (process.argv.includes('--sellar-deuda')) {
  fs.writeFileSync(DEUDA_FILE, JSON.stringify(Object.fromEntries(Object.entries(conteo).sort()), null, 2) + '\n');
  const tot = Object.values(conteo).reduce((s, n) => s + n, 0);
  console.log(`[monto-con-base] deuda sellada: ${tot} hallazgo(s) en ${Object.keys(conteo).length} archivo(s).`);
  process.exit(0);
}

if (process.argv.includes('--todo')) {
  for (const [f, hs] of Object.entries(por)) for (const h of hs) console.log(`${f}:${h.linea}  ${h.que}`);
}

const deuda = fs.existsSync(DEUDA_FILE) ? JSON.parse(fs.readFileSync(DEUDA_FILE, 'utf8')) : {};
const nuevos = [];
for (const [f, hs] of Object.entries(por)) {
  const base = deuda[f] || 0;
  if (hs.length > base) nuevos.push({ f, hs, base });
}
if (nuevos.length) {
  for (const { f, hs, base } of nuevos) {
    console.error(`${f}  ${hs.length} hallazgo(s) contra ${base} en deuda:`);
    for (const h of hs) console.error(`  ${f}:${h.linea}  ${h.que}`);
  }
  console.error('\n[monto-con-base] ❌ Hay montos NUEVOS que no dicen si llevan impuestos.');
  console.error('Cada cifra de dinero dice su base: «con IVA», «sin IVA», «con impuestos», «a precio» (GOTCHAS §96).');
  process.exit(1);
}
const tot = Object.values(conteo).reduce((s, n) => s + n, 0);
console.log(`[monto-con-base] ✅ sin montos nuevos sin base (${tot} en deuda declarada).`);
