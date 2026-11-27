#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[PQ.167]` COMPUERTA — **toda cantidad de mercancía que se publica dice en qué unidad va.**
 *
 * ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────
 * 2026-11-27: el Excel de una requisición rotulaba «Piezas» una cantidad que eran CAJAS
 * (`final_qty`: el costo del renglón es el de caja en 97 %+ de los renglones de 60 días y el de
 * pieza en 0), y la ficha de la requisición decía «Pedir» a secas. En `/compras/hallazgos` la
 * MISMA palabra («Existencia», «Sugerido») va en piezas; en la requisición, en cajas. El análisis
 * de los 509 arreglos de 30 días encontró 10 de cifra falsa por cajas/piezas, y el barrido de las
 * plantillas, 137 encabezados de cantidad sin unidad (55–75 reales tras revisar 30 a mano).
 * Ver GOTCHAS §96 (la hermana: «todo monto dice si lleva impuestos», `check-monto-con-base.js`).
 *
 * ── LO QUE MIDE ──────────────────────────────────────────────────────────────────────────
 * `<th>` y KPIs `format: 'number'` cuyo texto es una CANTIDAD de mercancía (Cantidad, Existencia,
 * Sugerido, Pedir, Recibido, Surtido, Faltante, Tránsito, Reorden, Mín/Máx…) y no dicen la unidad
 * (caja/cj, pieza/pz, paquete, kg, unid.) ni en el texto ni en `title`/`pTooltip`/`aria-label`.
 * Se exime el encabezado con interpolación (la unidad suele venir de `{{ }}`) y el que tiene al lado
 * una columna «Unidad/Presentación». ⚠️ Heurística de TEXTO: no sabe si la unidad dicha es la
 * verdadera; eso se MIDE contra el dato antes de rotular.
 *
 * ── DEUDA ────────────────────────────────────────────────────────────────────────────────
 * Nace sellada (`check-cantidad-con-unidad.deuda.json`, conteo por archivo): frena lo NUEVO.
 *
 * Uso:
 *   node scripts/check-cantidad-con-unidad.js                 # compara contra la deuda
 *   node scripts/check-cantidad-con-unidad.js --todo          # lista cada hallazgo
 *   node scripts/check-cantidad-con-unidad.js --sellar-deuda  # re-sella la línea base
 *   node scripts/check-cantidad-con-unidad.js --self-test     # prueba negativa
 */
'use strict';
const fs = require('fs');
const path = require('path');

const RAIZ_REPO = path.resolve(__dirname, '..');
const RAIZ = path.join(RAIZ_REPO, 'apps', 'view', 'src', 'app');
const DEUDA_FILE = path.join(__dirname, 'check-cantidad-con-unidad.deuda.json');

const CANTIDAD = /\b(cantidad|cant\.?|existencias?|exist\.?|sugeridos?|pedir|recibid[oa]s?|surtid[oa]s?|faltantes?|inventario|stock|tr[aá]nsito|disponibles?|apartad[oa]s?|enviad[oa]s?|contad[oa]s?|te[oó]ric[oa]|f[ií]sic[oa]|reorden|pedid[oa])\b/i;
const UNIDAD = /\b(cajas?|cjas?|cj\.?|cjs|pz\.?|pzas?|pzs|piezas?|paquetes?|paq\.?|kg|kilos?|unidad|unidades|unid\.?|uds?|lts?|litros?|presentaci[oó]n|bultos?|displays?|tarimas?)\b/i;
/** No es cantidad de mercancía: dinero, fechas, conteos de documentos, porcentajes. */
const NO_CANTIDAD = /(\$|importe|monto|valor|costo|precio|%|folio|fecha|d[ií]as|clientes|renglones|l[ií]neas|skus?|productos|art[ií]culos|documentos|[oó]rdenes|tickets|efectivo|cr[eé]dito|prom\.|cadencia|impuesto|iva)/i;

function archivos(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) archivos(p, acc);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) acc.push(p);
  }
  return acc;
}

function revisar(src) {
  const out = [];
  const lineas = src.split(/\r?\n/);
  lineas.forEach((ln, i) => {
    const TH = /<th\b([^>]*)>(.*?)<\/th>/gi;
    for (let m; (m = TH.exec(ln));) {
      const attrs = m[1]; const raw = m[2];
      if (/\{\{/.test(raw)) continue;
      const texto = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!texto || !CANTIDAD.test(texto) || NO_CANTIDAD.test(texto)) continue;
      const tip = [...attrs.matchAll(/(?:title|pTooltip|aria-label)="([^"]*)"/g)].map((x) => x[1]).join(' ');
      if (UNIDAD.test(texto) || UNIDAD.test(tip)) continue;
      const ventana = lineas.slice(Math.max(0, i - 3), i + 4).join(' ');
      if (/<th\b[^>]*>\s*(Unidad|U\.?M\.?|Present\.?|Presentaci[oó]n|Unid\.?)\s*<\/th>/i.test(ventana)) continue;
      out.push({ linea: i + 1, que: `cantidad «${texto.slice(0, 40)}» sin unidad` });
    }
    if (/format:\s*'number'/.test(ln)) {
      const label = (ln.match(/label:\s*['`"]([^'`"]*)['`"]/) || [])[1] || '';
      if (!label || !CANTIDAD.test(label) || NO_CANTIDAD.test(label) || UNIDAD.test(ln)) return;
      out.push({ linea: i + 1, que: `KPI «${label}» de cantidad sin unidad` });
    }
  });
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
    ['<th class="x">Existencia</th>', 1],
    ['<th class="x">Existencia (cj)</th>', 0],
    ['<th class="x" title="En cajas.">Pedir</th>', 0],
    ['<th>Sugerido (unid.)</th>', 0],
    ['<th>Costo sugerido</th>', 0],
    ['<th>Días de existencia</th>', 0],
    ['<th>Recibido {{ et.mayor }}</th>', 0],
    ["{ label: 'Pedido', value: n, format: 'number' }", 1],
    ["{ label: 'Pedido', value: n, format: 'number', sub: 'en cajas' }", 0],
  ];
  let mal = 0;
  for (const [src, esperado] of casos) {
    const n = revisar(src).length;
    if (n !== esperado) { mal++; console.error(`✗ esperaba ${esperado}, dio ${n}: ${src}`); }
  }
  if (mal) { console.error(`[cantidad-con-unidad:self] ❌ ${mal} caso(s) mal.`); process.exit(1); }
  console.log(`[cantidad-con-unidad:self] ✅ ${casos.length} casos (2 en rojo a propósito).`);
  process.exit(0);
}

const por = medir();
const conteo = Object.fromEntries(Object.entries(por).map(([f, h]) => [f, h.length]));

if (process.argv.includes('--sellar-deuda')) {
  fs.writeFileSync(DEUDA_FILE, JSON.stringify(Object.fromEntries(Object.entries(conteo).sort()), null, 2) + '\n');
  const tot = Object.values(conteo).reduce((s, n) => s + n, 0);
  console.log(`[cantidad-con-unidad] deuda sellada: ${tot} hallazgo(s) en ${Object.keys(conteo).length} archivo(s).`);
  process.exit(0);
}
if (process.argv.includes('--todo')) {
  for (const [f, hs] of Object.entries(por)) for (const h of hs) console.log(`${f}:${h.linea}  ${h.que}`);
}
const deuda = fs.existsSync(DEUDA_FILE) ? JSON.parse(fs.readFileSync(DEUDA_FILE, 'utf8')) : {};
const nuevos = Object.entries(por).filter(([f, hs]) => hs.length > (deuda[f] || 0));
if (nuevos.length) {
  for (const [f, hs] of nuevos) {
    console.error(`${f}  ${hs.length} hallazgo(s) contra ${deuda[f] || 0} en deuda:`);
    for (const h of hs) console.error(`  ${f}:${h.linea}  ${h.que}`);
  }
  console.error('\n[cantidad-con-unidad] ❌ Hay cantidades NUEVAS que no dicen su unidad (cajas, piezas, paquetes, kg).');
  console.error('Mide la unidad contra el dato y escríbela en el encabezado o su title (GOTCHAS §96).');
  process.exit(1);
}
const tot = Object.values(conteo).reduce((s, n) => s + n, 0);
console.log(`[cantidad-con-unidad] ✅ sin cantidades nuevas sin unidad (${tot} en deuda declarada).`);
