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
 * ── POR QUÉ RATCHET Y NO "TODO O NADA" ───────────────────────────────────────────────────
 * Prender la regla en rojo sobre las 13 deudas existentes la haría inservible el primer día: nadie
 * puede arreglar 13 superficies para mergear un fix de otra cosa, así que la compuerta se desactiva
 * "temporalmente" y no vuelve. Mismo criterio que el ratchet de lint de TS.0: **la deuda existente
 * se declara y el número SÓLO PUEDE BAJAR**. Un endpoint nuevo sin procedencia sube el conteo y pone
 * el CI en rojo; arreglar uno viejo lo baja y el script te dice que muevas la línea.
 *
 * ── UN GATE SIN PRUEBA NEGATIVA ES UNA INTENCIÓN ─────────────────────────────────────────
 * (regla 6 de ADR-056). Se verificó rompiéndolo a propósito: agregar una interfaz con `generated_at`
 * y sin `freshness` sube el conteo a 14 y el script sale 1.
 */
const fs = require('fs');
const path = require('path');

/**
 * Deuda medida el 2026-09-07. **Sólo puede bajar.** Al arreglar una superficie, bajá este número en
 * el mismo commit — si no, la compuerta deja de proteger lo que acabás de ganar.
 */
const BASELINE = 13;

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

const bloque = /export interface\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
const conformes = [];
const deudas = [];

for (const raiz of RAICES) {
  for (const p of archivos(path.isAbsolute(raiz) ? raiz : path.join(RAIZ, raiz))) {
    let src;
    try { src = fs.readFileSync(p, 'utf8'); } catch { continue; }
    if (!AFIRMA_TIEMPO.test(src)) continue;           // atajo barato: el 99% de los archivos no aplica
    for (const m of src.matchAll(bloque)) {
      const [, nombre, cuerpo] = m;
      if (!AFIRMA_TIEMPO.test(cuerpo)) continue;
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
