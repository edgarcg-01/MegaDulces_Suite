#!/usr/bin/env node
/**
 * Compuerta: un `computed()` que lee un CAMPO PLANO queda CONGELADO para siempre.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * Un `computed()` de Angular sólo se invalida cuando se lo avisa un productor reactivo. Si su
 * cuerpo no lee ninguna señal, se evalúa UNA vez, cachea, y no vuelve a recalcular nunca —
 * aunque el campo que lee cambie mil veces. Bajo `provideZonelessChangeDetection()` el síntoma
 * es MUDO: no hay error, no hay warning, el build pasa, el typecheck pasa. El valor no cambia.
 *
 * ── Por qué no alcanzaba con la lección escrita ─────────────────────────────────────────────
 * Ya había pasado y ya estaba documentado:
 *
 *   · 2026-09-14 · `almacen-analisis-bi.component.ts` — dos computed congelados; se dejó
 *     `almacen-analisis-bi.reactividad.spec.ts`, que prueba LA REGLA en aislamiento.
 *   · 2026-09-22 · `finanzas-caja-general.component.ts` — `bloqueos = computed(() =>
 *     motivosDeBloqueo(this.f))` con `f` plano. El botón **Guardar** de la captura de caja
 *     quedaba inhabilitado de por vida: la persona llenaba todo bien y la lista de motivos
 *     seguía mostrando los del formulario vacío.
 *
 * Ocho días entre una y otra, con el spec ya en el repo. Un spec que prueba el principio no
 * revisa el código que se escribe después: eso lo hace un barrido. Ésa es la diferencia entre
 * una lección y una compuerta.
 *
 * ── Qué marca ───────────────────────────────────────────────────────────────────────────────
 * Un `this.campo` leído dentro de un `computed(...)` cuando ese campo, en el mismo archivo:
 *   (1) se declara SIN un productor reactivo (`signal`, `input`, `computed`, `toSignal`, …), y
 *   (2) se REASIGNA o se muta en algún lado.
 *
 * La condición (2) es la que lo vuelve preciso: una constante de sólo lectura (`readonly money =
 * money`) leída en un computed es inofensiva, porque no cambia nunca. Lo que rompe es un campo
 * que cambia y no avisa.
 *
 * ── Lo que NO cubre, dicho ──────────────────────────────────────────────────────────────────
 * Es un barrido de texto, no un análisis de tipos. Se le escapan:
 *   · campos declarados en la MISMA línea que la clase (`class X { f = ''; }`) — el patrón busca
 *     la declaración al principio de una línea, que es como está escrito todo el repo;
 *   · campos que viven en otro archivo (una clase base heredada);
 *   · un `untracked(() => this.senal())`, que es una señal leída sin registrar dependencia y
 *     produce exactamente el mismo congelamiento, a propósito.
 * Una compuerta que no dice dónde termina se lee como cobertura total, y no lo es.
 */
const fs = require('node:fs');
const path = require('node:path');

const RAICES = ['apps', 'libs'];
const IGNORAR = /(node_modules|dist|\.angular|\.nx|coverage)/;
const BARRA = String.fromCharCode(92); // backslash, sin escribirlo literal

/** Productores reactivos: leerlos dentro de un computed SÍ crea dependencia. */
const REACTIVO = /^(signal|computed|input|inject|toSignal|model|linkedSignal|viewChild|viewChildren|contentChild|contentChildren|output|toObservable)\b|^signal</;

/** Reemplaza comentarios y literales por espacios, CONSERVANDO offsets y saltos de línea. */
function blanquear(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const borrar = (desde, hasta) => {
    for (let k = desde; k < hasta && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      borrar(i, j); i = j; continue;
    }
    if (c === '/' && d === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      borrar(i, Math.min(j + 2, n)); i = j + 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === BARRA) { j += 2; continue; }
        if (src[j] === c) break;
        if (c !== '`' && src[j] === '\n') break;
        j++;
      }
      borrar(i + 1, j); i = j + 1; continue;
    }
    i++;
  }
  return out.join('');
}

/** Declaraciones de campo de clase: nombre -> { reactivo } */
function camposDeClase(code) {
  const campos = new Map();
  const conInit = /^[ \t]*(?:(?:readonly|private|protected|public|static|declare|override)[ \t]+)*([A-Za-z_$][\w$]*)[ \t]*[!?]?[ \t]*(?::[^=\n]+)?=[ \t]*([^\n]*)$/gm;
  let m;
  while ((m = conInit.exec(code))) {
    const init = (m[2] || '').trim();
    campos.set(m[1], { reactivo: REACTIVO.test(init) });
  }
  const sinInit = /^[ \t]*(?:(?:readonly|private|protected|public|static|declare|override)[ \t]+)*([A-Za-z_$][\w$]*)[ \t]*[!?]?[ \t]*:[^=\n]+;[ \t]*$/gm;
  while ((m = sinInit.exec(code))) {
    if (!campos.has(m[1])) campos.set(m[1], { reactivo: false });
  }
  return campos;
}

/** Devuelve [inicio, fin) de cada cuerpo de `computed(`, con paréntesis balanceados. */
function regionesComputed(code) {
  const regiones = [];
  const re = /\bcomputed\s*(?:<[^>]*>)?\s*\(/g;
  while (re.exec(code)) {
    let prof = 1;
    let j = re.lastIndex;
    while (j < code.length && prof > 0) {
      if (code[j] === '(') prof++;
      else if (code[j] === ')') prof--;
      j++;
    }
    regiones.push([re.lastIndex, j]);
  }
  return regiones;
}

const MUTADORES = '(push|pop|splice|shift|unshift|sort|reverse|fill|copyWithin)';
const PUNTO = BARRA + '.';

/**
 * Lo que ya estaba cuando se puso la compuerta (2026-09-22), ENUMERADO uno por uno.
 *
 * ⚠️ La lista es EXACTA (archivo + campo): un campo nuevo en un archivo ya listado también falla.
 * Una compuerta que se salta un archivo entero deja de vigilarlo, y así es como mueren.
 *
 * Cada entrada dice si es deuda o si es correcto a propósito. Lo correcto a propósito no se
 * "arregla"; lo que es deuda tiene dueño en el tracker, no se queda acá para siempre.
 */
const PERMITIDOS = new Map([
  // CORRECTO A PROPÓSITO — no tocar. `counts` es un objeto que se muta, y el computed lee
  // `countsVersion()`, una señal que se incrementa EXACTAMENTE donde `counts` cambia (:311, :327).
  // Es el patrón deliberado de "señal de versión"; el barrido no puede distinguir intención.
  ['apps/view/src/app/modules/reparto/pages/rider-liquidation.component.ts::counts', 'senal de version deliberada (countsVersion)'],

  // DEUDA · CONGELADOS DE VERDAD (cero señales en el cuerpo) — el indicador de "hay filtros
  // puestos" nunca se enciende, así que el botón de limpiar filtros no aparece nunca.
  ['apps/view/src/app/modules/compras/pages/compras-reclamos.component.ts::fResp', 'deuda CG.22'],
  ['apps/view/src/app/modules/compras/pages/compras-reclamos.component.ts::fKind', 'deuda CG.22'],
  ['apps/view/src/app/modules/compras/pages/compras-reclamos.component.ts::fWh', 'deuda CG.22'],
  ['apps/view/src/app/modules/compras/pages/compras-reclamos.component.ts::fSearch', 'deuda CG.22'],
  ['apps/view/src/app/modules/compras/pages/compras-reclamos.component.ts::fSupplier', 'deuda CG.22'],
  ['apps/view/src/app/modules/compras/pages/compras-reclamos.component.ts::fStatus', 'deuda CG.22'],
  ['apps/view/src/app/modules/tienda/pages/tienda-caducidades-expediente.component.ts::warehouseId', 'deuda CG.22'],
  ['apps/view/src/app/modules/tienda/pages/tienda-caducidades-expediente.component.ts::plazoFiltro', 'deuda CG.22'],
  ['apps/view/src/app/modules/tienda/pages/tienda-caducidades-expediente.component.ts::search', 'deuda CG.22'],
  ['apps/view/src/app/modules/tienda/pages/tienda-caducidades-expediente.component.ts::desde', 'deuda CG.22'],
  ['apps/view/src/app/modules/tienda/pages/tienda-caducidades-expediente.component.ts::hasta', 'deuda CG.22'],
  ['apps/view/src/app/modules/comercial/pages/comercial-sell-out.component.ts::curTo', 'deuda CG.22'],
  ['apps/view/src/app/modules/comercial/pages/comercial-sell-out.component.ts::curFrom', 'deuda CG.22'],

  // DEUDA · PARCIALES — el computed SÍ se recalcula, pero por OTRA señal del cuerpo. El campo
  // plano no lo despierta, así que el bug se esconde detrás de la dependencia de al lado.
  ['apps/view/src/app/modules/compras/pages/compras-pedido-real.component.ts::fSupplier', 'deuda CG.22 (parcial)'],
  ['apps/view/src/app/modules/compras/pages/compras-pedido-real.component.ts::fBrand', 'deuda CG.22 (parcial)'],
  ['apps/view/src/app/modules/compras/pages/compras-pedido-real.component.ts::fCategory', 'deuda CG.22 (parcial)'],
  ['apps/view/src/app/modules/compras/pages/compras-pedido-real.component.ts::wbWarehouses', 'deuda CG.22 (parcial)'],
  ['apps/view/src/app/modules/compras/pages/compras-pedido-real.component.ts::search', 'deuda CG.22 (parcial)'],
  ['apps/view/src/app/modules/compras/pages/compras-pedido-real.component.ts::coverage', 'deuda CG.22 (parcial)'],
  ['apps/view/src/app/modules/comercial/pages/comercial-orders.component.ts::fromDate', 'deuda CG.22 (parcial)'],
  ['apps/view/src/app/modules/comercial/pages/comercial-orders.component.ts::toDate', 'deuda CG.22 (parcial)'],
  ['apps/view/src/app/modules/finanzas/pages/finanzas-capturas-sin-folio.component.ts::solSel', 'deuda CG.22 (parcial)'],
]);

function revisar(archivo) {
  const src = fs.readFileSync(archivo, 'utf8');
  if (!src.includes('computed(')) return [];
  const code = blanquear(src);
  const campos = camposDeClase(code);
  const hallazgos = [];

  for (const [ini, fin] of regionesComputed(code)) {
    const cuerpo = code.slice(ini, fin);
    // `this.x` que NO es una llamada (`this.x(`).
    const lect = /this\.([A-Za-z_$][\w$]*)\s*(?!\()/g;
    let r;
    const vistos = new Set();
    while ((r = lect.exec(cuerpo))) {
      const nombre = r[1];
      if (vistos.has(nombre)) continue;
      vistos.add(nombre);
      const campo = campos.get(nombre);
      if (!campo || campo.reactivo) continue;
      const reasigna = new RegExp('this' + PUNTO + nombre + BARRA + 's*=[^=]').test(code);
      const muta = new RegExp(
        'this' + PUNTO + nombre + '(?:' + PUNTO + '[A-Za-z_$][' + BARRA + 'w$]*)*' + PUNTO + MUTADORES + BARRA + 's*' + BARRA + '(',
      ).test(code);
      if (!reasigna && !muta) continue; // constante: no puede quedar stale
      const linea = code.slice(0, ini + r.index).split('\n').length;
      hallazgos.push({ archivo, linea, nombre });
    }
  }
  return hallazgos;
}

function* archivos(dir) {
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entradas) {
    const p = path.join(dir, e.name);
    if (IGNORAR.test(p)) continue;
    if (e.isDirectory()) yield* archivos(p);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') && !e.name.endsWith('.d.ts')) yield p;
  }
}

const crudos = [];
for (const raiz of RAICES) for (const f of archivos(raiz)) crudos.push(...revisar(f));

const clave = (h) => `${h.archivo.replace(/[\\]/g, '/')}::${h.nombre}`;
const todos = crudos.filter((h) => !PERMITIDOS.has(clave(h)));
const heredados = crudos.length - todos.length;

// Una entrada de la lista que ya no aparece es una entrada que sobra: se avisa para que la
// lista no se vuelva un cementerio que nadie limpia.
const vistos = new Set(crudos.map(clave));
const sobrantes = [...PERMITIDOS.keys()].filter((k) => !vistos.has(k));

if (todos.length) {
  console.error('\n[X] computed() sobre campo PLANO: queda congelado y no vuelve a recalcular.\n');
  for (const h of todos) {
    console.error(`   ${h.archivo.replace(/[\\]/g, '/')}:${h.linea}  ->  this.${h.nombre} no es una senal, y cambia`);
  }
  console.error('\n   Se evalua UNA vez y cachea: el valor no cambia nunca mas, sin un solo error.');
  console.error('   Fix: el campo pasa a signal(...) y el computed lo lee como this.<campo>().');
  console.error('   Y leelo PRIMERO e incondicional: un && que corte antes lo deja sin dependencias.\n');
  process.exit(1);
}
if (sobrantes.length) {
  console.log('   nota: ' + sobrantes.length + ' entrada(s) de la lista base ya no aparecen; se pueden borrar:');
  for (const k of sobrantes) console.log('         ' + k);
}
console.log(
  'OK reactividad: ningun computed() NUEVO depende de un campo plano mutable' +
  (heredados ? ` (${heredados} heredados, enumerados en la lista base).` : '.'),
);
