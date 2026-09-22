#!/usr/bin/env node
/**
 * Compuerta: API de PrimeNG que la v22 RETIRÓ y que falla EN SILENCIO.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * Los tres modos de falla de esta familia comparten lo peor: **son atributos HTML válidos**. Sin
 * error en consola, sin warning, `nx build` verde, `nx typecheck` verde, `check:templates`
 * verde — y con razón, porque ese candado busca puntuación que rompe el literal, no nombres de
 * API que cambiaron. La única forma de verlos es abrir la pantalla.
 *
 * Lo que ya costó, medido:
 *   · 2026-09-19 · `finanzas-caja-general` — los 3 `p-dialog` con `pTemplate="footer"`. En v22 el
 *     pie se declara con `<ng-template #footer>`; con el nombre viejo NO SE PROYECTA NADA, así
 *     que "Registrar movimiento de caja" abría **sin Guardar ni Cancelar**. (GOTCHAS §59)
 *   · 2026-08-28 · `[styleClass]` enlazado en `p-table` explota; el estático pasa y no aplica.
 *   · 2026-09-02 · `<button pButton label="X">` quedó VACÍO: la directiva perdió `label`/`icon`
 *     (viven en el COMPONENTE `<p-button>`). Se arregló con un codemod en 111 archivos y
 *     **regresó solo**: el codemod arregla lo que existe, no lo que se escribe después.
 *
 * Verificado contra `node_modules/primeng/types/*.d.ts` de la versión instalada: `styleClass`
 * sobrevive SÓLO en `p-dialog`; en select/message/table/autocomplete/inputnumber no existe, y
 * como atributo estático Angular lo emite como atributo muerto.
 *
 * ── Prueba negativa ─────────────────────────────────────────────────────────────────────────
 * Rompela a propósito una vez (un `severity="warning"` en cualquier plantilla) y verificá el
 * rojo. Un gate sin prueba negativa es una intención.
 */
const fs = require('node:fs');
const path = require('node:path');

const RAICES = ['apps', 'libs'];
const IGNORAR = /(node_modules|dist|\.angular|\.nx|coverage)/;

/** Componentes a los que PrimeNG 22 les QUITÓ `styleClass`. */
const SIN_STYLECLASS = ['p-select', 'p-message', 'p-table', 'p-autocomplete', 'p-inputnumber', 'p-multiselect'];

/** Nombres de componente retirados en v22 -> su reemplazo. */
const RENOMBRADOS = [
  ['p-dropdown', 'p-select'],
  ['p-calendar', 'p-datepicker'],
  ['p-inputSwitch', 'p-toggleswitch'],
  ['p-tabView', 'p-tabs'],
  ['p-tabPanel', 'p-tabpanel (dentro de p-tabs)'],
  ['p-overlayPanel', 'p-popover'],
  ['p-sidebar', 'p-drawer'],
  ['p-messages', 'p-message'],
  ['p-accordionTab', 'p-accordion-panel'],
];

const hallazgos = [];

function linea(src, idx) {
  return src.slice(0, idx).split('\n').length;
}

function revisar(archivo, src) {
  const rel = archivo.replace(/[\\]/g, '/');
  const anotar = (idx, que, arreglo) =>
    hallazgos.push({ archivo: rel, linea: linea(src, idx), que, arreglo });

  // 1 · pTemplate dentro de un bloque <p-dialog> ... </p-dialog>
  const dlg = /<p-dialog[\s\S]*?<\/p-dialog>/g;
  let d;
  while ((d = dlg.exec(src))) {
    const bloque = d[0];
    const pt = /<ng-template[^>]*pTemplate=["'](footer|header)["']/g;
    let t;
    while ((t = pt.exec(bloque))) {
      anotar(d.index + t.index, `pTemplate="${t[1]}" dentro de un p-dialog`, `usar <ng-template #${t[1]}>`);
    }
  }

  // 2 · styleClass en componentes que ya no lo tienen
  for (const comp of SIN_STYLECLASS) {
    const re = new RegExp('<' + comp + '\\b[^>]*?\\bstyleClass=', 'gi');
    let m;
    while ((m = re.exec(src))) {
      anotar(m.index, `styleClass en <${comp}> (v22 lo retiró)`, 'clase en el host + regla propia, o inputStyleClass');
    }
  }

  // 3 · nombres retirados
  for (const [viejo, nuevo] of RENOMBRADOS) {
    const re = new RegExp('<' + viejo + '\\b', 'g');
    let m;
    while ((m = re.exec(src))) anotar(m.index, `<${viejo}> no existe en v22`, `usar <${nuevo}>`);
  }

  // 4 · severity que la librería no conoce (usa el primer string y se queda gris)
  const sev = /severity=["'](warning|help|error)["']/g;
  let s;
  while ((s = sev.exec(src))) {
    const mapa = { warning: 'warn', help: 'contrast', error: 'danger' };
    anotar(s.index, `severity="${s[1]}"`, `usar severity="${mapa[s[1]]}"`);
  }

  // 5 · la directiva pButton no tiene label/icon: el botón sale VACÍO
  const btn = /<(?:button|a)\b[^>]*\bpButton\b[^>]*>/g;
  let b;
  while ((b = btn.exec(src))) {
    const tag = b[0];
    if (/\bp-button\b/.test(tag)) continue; // <p-button pButton> es otro defecto, no éste
    // ⚠️ El espacio de adelante NO es adorno: sin él, `aria-label=` matchea y salen 40 falsos
    // positivos. `aria-label` es correcto y no se toca — la memoria del proyecto ya lo advierte.
    if (/\s\[?label\]?=/.test(tag)) {
      anotar(b.index, 'la DIRECTIVA pButton con label= (v22 no lo tiene: el botón sale vacío)',
        'usar el componente <p-button label icon>, o inyectar los <span> de PrimeNG a mano');
    }
  }
}

function* archivos(dir) {
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entradas) {
    const p = path.join(dir, e.name);
    if (IGNORAR.test(p)) continue;
    if (e.isDirectory()) yield* archivos(p);
    else if (/\.(ts|html)$/.test(e.name) && !e.name.endsWith('.d.ts')) yield p;
  }
}

for (const raiz of RAICES) {
  for (const f of archivos(raiz)) {
    const src = fs.readFileSync(f, 'utf8');
    if (!src.includes('p-') && !src.includes('pButton')) continue;
    revisar(f, src);
  }
}

/**
 * ── Techo por categoría, medido el 2026-09-22 ───────────────────────────────────────────────
 *
 * Son 602 apariciones en 183 archivos: una lista nominal de ese tamaño no se lee ni se mantiene.
 * En su lugar, un techo por categoría, y el gate falla si CRECE. Las dos que hoy están en CERO
 * quedan con tolerancia cero — son las que ya costaron caro:
 *
 *   · `pTemplate` en el pie de un `p-dialog`  -> el diálogo abre SIN BOTONES (GOTCHAS §59).
 *   · nombres retirados (`p-dropdown`, …)     -> el componente no existe, no renderiza.
 *
 * Las de `styleClass` son deuda REAL y medida, no cosmética: **283 `p-table` piden densidad
 * compacta con un atributo que v22 ignora, y NINGUNA de esas 283 pasa `size`**, así que están
 * renderizando en densidad default — lo contrario del "compact++" que fija DESIGN.md para
 * Operations. Se arreglan por pantalla cuando cada una se toque; bajar el número es el trabajo.
 */
const TECHO = {
  'pTemplate en p-dialog': 0,
  'nombre retirado': 0,
  'pButton con label': 3,
  'styleClass p-table': 283,
  'styleClass p-select': 255,
  'styleClass p-multiselect': 39,
  'styleClass p-inputnumber': 13,
  'styleClass p-autocomplete': 7,
  'styleClass p-message': 1,
  'severity retirado': 1,
};

function categoria(h) {
  if (h.que.startsWith('pTemplate')) return 'pTemplate en p-dialog';
  if (h.que.includes('no existe en v22')) return 'nombre retirado';
  if (h.que.includes('DIRECTIVA pButton')) return 'pButton con label';
  if (h.que.startsWith('severity')) return 'severity retirado';
  const m = h.que.match(/styleClass en <([a-z-]+)>/);
  if (m) return `styleClass ${m[1]}`;
  return h.que;
}

const porCat = new Map();
for (const h of hallazgos) {
  const c = categoria(h);
  if (!porCat.has(c)) porCat.set(c, []);
  porCat.get(c).push(h);
}

const excedidas = [];
for (const [cat, lista] of porCat) {
  const techo = TECHO[cat] ?? 0;
  if (lista.length > techo) excedidas.push({ cat, techo, lista });
}

if (excedidas.length) {
  console.error('\n[X] API de PrimeNG retirada en v22 (falla MUDA: sin error, sin warning, build verde):\n');
  for (const e of excedidas) {
    console.error(`   ${e.cat}: ${e.lista.length} (techo ${e.techo})`);
    // Con techo 0 se listan todas; si es una categoria con deuda, sólo lo que se pasó.
    for (const h of e.lista.slice(0, e.techo === 0 ? e.lista.length : 12)) {
      console.error(`      ${h.archivo}:${h.linea}  ${h.que}`);
      console.error(`         -> ${h.arreglo}`);
    }
  }
  console.error('\n   La unica forma de ver esto en runtime es abrir la pantalla. Por eso hay compuerta.');
  console.error('   Si bajaste el numero a proposito, bajá tambien el techo en TECHO{} de este archivo.\n');
  process.exit(1);
}

const bajaron = [];
for (const [cat, techo] of Object.entries(TECHO)) {
  const hoy = porCat.get(cat)?.length ?? 0;
  if (hoy < techo) bajaron.push(`${cat}: ${hoy} < ${techo}`);
}
if (bajaron.length) {
  console.log('   bajaron (actualizá el techo para que no vuelvan a subir):');
  for (const b of bajaron) console.log('      ' + b);
}
console.log(`OK primeng: sin API retirada NUEVA (${hallazgos.length} heredadas bajo techo; pTemplate-en-dialog y nombres retirados en CERO).`);
