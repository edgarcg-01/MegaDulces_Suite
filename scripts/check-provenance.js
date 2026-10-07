#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * [VP.2.3] CUARTA COMPUERTA — un reporte no declara cuándo respondió el servidor y se calla la edad
 * del dato (ADR-056).
 *
 * Correr:  npm run check:provenance
 *
 * ── LA REGLA, Y POR QUÉ ÉSTA ─────────────────────────────────────────────────────────────
 * **Toda interfaz de respuesta que declara `generated_at` tiene que declarar también procedencia**
 * (`freshness` o `data_as_of`).
 *
 * No es una regla arbitraria: es la tesis de la fase reducida a algo verificable. `generated_at` dice
 * *cuándo corrió la consulta*; un servidor que contesta en 200 ms sobre matvistas de hace seis días
 * lo reporta igual de fresco. Publicar el primero y callar el segundo es exactamente cómo la
 * plataforma estuvo seis días sirviendo precio, costo y margen muertos con total aplomo — y cómo la
 * etiquetera imprimió un precio 54% bajo costo.
 *
 * Un endpoint que ni siquiera pone `generated_at` no entra acá: no está afirmando nada sobre el
 * tiempo. El pecado es afirmar la mitad conveniente.
 *
 * ── EL RATCHET LLEGÓ A CERO (2026-09-08) ─────────────────────────────────────────────────
 * Nació como ratchet porque prender la regla en rojo sobre 13 deudas la haría inservible el primer
 * día: nadie arregla 13 superficies para mergear un fix de otra cosa, así que la compuerta se
 * desactiva "temporalmente" y no vuelve. Mismo criterio que el ratchet de lint de TS.0.
 *
 * La deuda se cerró en dos tandas (13 → 5 → 0), así que hoy es una **regla dura**: cualquier
 * respuesta nueva que declare `generated_at` sin procedencia pone el CI en rojo. Un ratchet que se
 * queda en su número inicial para siempre es una deuda con buena prensa; éste llegó a cero.
 *
 * ── UN GATE SIN PRUEBA NEGATIVA ES UNA INTENCIÓN ─────────────────────────────────────────
 * (regla 6 de ADR-056). Se verificó rompiéndolo a propósito: agregar una interfaz con `generated_at`
 * y sin `freshness` sube el conteo a 14 y el script sale 1.
 */
const fs = require('fs');
const path = require('path');

/**
 * Deuda: **0**. Medida en 13 el 2026-09-07 y cerrada el 2026-09-08 (13 → 5 → 0), con la regla
 * ampliada además a `type` y a las formas sin `export`.
 *
 * **Sólo puede bajar**, y a partir de acá eso significa que la compuerta pasó de ratchet a regla
 * dura: cualquier respuesta nueva que declare `generated_at` sin procedencia pone el CI en rojo.
 * Ése era el objetivo del ratchet — no vivir en 13 para siempre, sino llegar a 0 y quedarse.
 */
const BASELINE = 0;

const RAIZ = path.join(__dirname, '..');

/**
 * `--raiz=<dir>` escanea OTRO árbol en vez del repo. Existe sólo para que la compuerta pueda
 * probarse a sí misma (regla 6 de ADR-056) sin escribir archivos sonda dentro de `libs/` — donde un
 * temporal puede terminar barrido dentro de un commit ajeno. **No es un bypass**: no toca el
 * BASELINE ni el criterio, sólo cambia dónde mira, y CI nunca lo pasa.
 */
const raizArg = (process.argv.find((a) => a.startsWith('--raiz=')) || '').split('=')[1];
const RAICES = raizArg ? [raizArg] : ['libs', path.join('apps', 'view', 'src'), path.join('apps', 'portal', 'src'), path.join('apps', 'vendor', 'src')];

/** `generated_at` = "esto es la respuesta de un reporte y estoy hablando del tiempo". */
const AFIRMA_TIEMPO = /\bgenerated_at\s*[?:]/;
/** Procedencia aceptada: el envelope completo o, como mínimo, la fecha del dato. */
const DECLARA_PROCEDENCIA = /\bfreshness\s*[?:]|\bdata_as_of\s*[?:]/;

function archivos(dir, acc = []) {
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entradas) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
      archivos(p, acc);
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * Encabezado de una forma de respuesta: `interface X {` o `type X = {`, exportada **o no**.
 *
 * ── POR QUÉ TAMBIÉN `type`, Y POR QUÉ TAMBIÉN SIN `export` ───────────────────────────────
 * La versión anterior sólo miraba `export interface`, así que la regla se esquivaba escribiendo
 * `type` — sin mala intención: el briefing de Horus (`supervisor-agent.service.ts`) declara su
 * respuesta como `type Briefing = { … generated_at … }` y la compuerta **nunca lo vio**. Una regla
 * que depende de qué palabra clave eligió el autor no es una regla.
 *
 * Sin `export` tampoco: una forma local al archivo igual cruza el cable si es lo que devuelve el
 * endpoint. Medido antes de cambiarlo: en todo el repo había **1** caso (`Briefing`), o sea el
 * agujero era chico pero real, y cerrarlo cuesta un regex.
 *
 * `[^{]*` cubre además el `extends Foo` que el regex viejo (`(\w+)\s*\{`)
 * no contemplaba: con un `extends` en medio el encabezado **nunca calzaba**, así que la interfaz no
 * se examinaba por sí misma y su cuerpo sólo se veía si el match codicioso del vecino lo absorbía —
 * y entonces la deuda se le atribuía al vecino. Verificado: `export interface Base { … }` seguida de
 * `export interface Reporte extends Base { … generated_at … }` reportaba a **`Base`** como la
 * culpable, que no declara nada del tiempo.
 */
const ENCABEZADO = /(?:export\s+)?(?:interface\s+(\w+)[^{]*|type\s+(\w+)\s*=\s*)\{/g;

/**
 * Devuelve el cuerpo de la interfaz **balanceando llaves**, no buscando un `}` a principio de línea.
 *
 * ⚠️ El regex original (`\{([\s\S]*?)\n\}`) sólo cerraba con un `}` pegado a un salto de línea, así que
 * una interfaz de UNA SOLA LÍNEA (`export interface Punto { mes: string; }`) nunca cerraba ahí: su
 * "cuerpo" seguía tragando líneas hasta el próximo bloque multilínea. Eso hacía dos daños, y el
 * segundo es el que importa:
 *   1. culpaba al inocente — el `generated_at` del vecino se le atribuía a la interfaz de una línea;
 *   2. **escondía deudas reales** — `matchAll` reanuda DESPUÉS del match, así que todo lo tragado
 *      (en este repo: `SelloutSeriesReport`, `SelloutParetoReport`, `SelloutTargetsReport`) no se
 *      examinaba nunca. Una interfaz de una línea puesta arriba volvía invisible a la de abajo.
 * Una compuerta que puede ocultar justo lo que vigila es peor que no tenerla: da confianza sin
 * fundamento, que es la falla que esta fase entera existe para cerrar.
 */
function cuerpoDe(src, aperturaIdx) {
  let d = 1;
  let i = aperturaIdx + 1;
  while (i < src.length && d > 0) {
    const c = src[i];
    if (c === '{') d++;
    else if (c === '}') d--;
    i++;
  }
  return d === 0 ? src.slice(aperturaIdx + 1, i - 1) : null;
}

const conformes = [];
const deudas = [];

for (const raiz of RAICES) {
  for (const p of archivos(path.isAbsolute(raiz) ? raiz : path.join(RAIZ, raiz))) {
    let src;
    try { src = fs.readFileSync(p, 'utf8'); } catch { continue; }
    if (!AFIRMA_TIEMPO.test(src)) continue;           // atajo barato: el 99% de los archivos no aplica
    for (const m of src.matchAll(ENCABEZADO)) {
      const nombre = m[1] || m[2]; // grupo 1 = interface · grupo 2 = type
      const cuerpo = cuerpoDe(src, m.index + m[0].length - 1);
      if (cuerpo === null || !AFIRMA_TIEMPO.test(cuerpo)) continue;
      const rel = path.relative(RAIZ, p).replace(/\\/g, '/');
      (DECLARA_PROCEDENCIA.test(cuerpo) ? conformes : deudas).push({ nombre, rel });
    }
  }
}

const total = conformes.length + deudas.length;
console.log(`\n[VP.2.3] Procedencia en respuestas de reporte`);
console.log(`  interfaces que declaran generated_at : ${total}`);
console.log(`  ...con procedencia                   : ${conformes.length}`);
console.log(`  ...SIN procedencia (deuda)           : ${deudas.length}  (línea: ${BASELINE})\n`);

if (deudas.length) {
  console.log('  Deuda actual — cada una publica "cuándo respondí" y se calla "de cuándo es el dato":');
  for (const d of deudas.sort((a, b) => a.rel.localeCompare(b.rel) || a.nombre.localeCompare(b.nombre))) {
    console.log(`    ${d.nombre.padEnd(32)} ${d.rel}`);
  }
  console.log();
}

if (deudas.length > BASELINE) {
  console.error(`❌ La deuda SUBIÓ (${BASELINE} → ${deudas.length}).`);
  console.error('   Una respuesta de reporte que declara `generated_at` tiene que declarar también');
  console.error('   `freshness` (o al menos `data_as_of`): `generated_at` dice cuándo corrió la consulta,');
  console.error('   y un servidor que contesta en 200 ms sobre datos de hace seis días lo reporta igual');
  console.error('   de fresco. Reusá `composeFreshness()`/`laneAt()` de libs/commercial/.../shared/freshness.ts');
  console.error('   y el contrato de @megadulces/contracts (http/provenance.contract.ts).\n');
  process.exit(1);
}

if (deudas.length < BASELINE) {
  console.log(`✅ La deuda BAJÓ (${BASELINE} → ${deudas.length}).`);
  console.log(`   Bajá BASELINE a ${deudas.length} en scripts/check-provenance.js, en este mismo commit:`);
  console.log('   si no, la compuerta deja de proteger lo que acabás de ganar.\n');
  process.exit(0);
}

console.log('✅ Sin deuda nueva de procedencia.\n');
