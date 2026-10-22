#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[THR.1]` Compuerta: el nombre de tier de cada `@Throttle` / `@SkipThrottle` EXISTE en el servidor.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 * `ThrottlerModule.forRoot` (apps/api/src/app.module.ts) declara tres tiers con NOMBRE:
 * `short`, `medium` y `long`. El guard (`@nestjs/throttler` 6.5, `throttler.guard.js`) recorre
 * los tiers configurados y, para cada uno, lee la metadata `THROTTLER:LIMIT<nombre>` /
 * `THROTTLER:SKIP<nombre>` del handler. Un decorador que usa OTRO nombre guarda metadata que
 * ningún tier lee: **no da error, no da aviso, no deja log, y el tope no existe**.
 *
 * Lo que ya costó, medido el 2026-10-16:
 *   · `@Throttle({ default: { limit: 15|20, ttl: 60_000 } })` en 4 endpoints de
 *     `commercial-analytics` (el chat «Pregúntale al Sell-Out» y el incentivo de ruta, que llaman a un
 *     LLM de pago por uso): creían tener tope y no lo tenían. Se descubrió al revisar un PR AJENO a
 *     ellos, no por una falla.
 *   · `@SkipThrottle()` SIN argumentos equivale a `{ default: true }`: tampoco salta nada. Está en los
 *     dos controladores de ingesta de checadas (`libs/hr`): creen estar exentos del límite global y no
 *     lo están (ver EXCEPCIONES).
 *
 * ── Qué mide ────────────────────────────────────────────────────────────────
 *  1. Lee los tiers configurados de `app.module.ts` (si no puede leer NINGUNO, FALLA: una compuerta
 *     que no sabe contra qué juzgar no puede reportar verde).
 *  2. Busca todo `@Throttle(` y `@SkipThrottle(` en `apps/` y `libs/` (sin comentarios) y extrae las
 *     CLAVES de primer nivel del objeto. `@SkipThrottle()` sin argumentos cuenta como la clave
 *     implícita `default`.
 *  3. Frena si alguna clave no es un tier configurado.
 *
 * ── Deuda declarada, con ratchet ────────────────────────────────────────────
 * EXCEPCIONES lista lo que hoy incumple y NO se arregló por decisión pendiente. Es un ratchet exacto:
 * si aparece una violación nueva en un archivo no listado, o una listada **sube**, frena; y si una
 * listada **baja o desaparece**, también frena (hay que quitar la excepción: una deuda que ya se pagó
 * no se queda escrita).
 *
 * Uso:
 *   node scripts/check-throttle-names.js
 *   node scripts/check-throttle-names.js --self-test     # prueba negativa
 */
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');
const APP_MODULE = 'apps/api/src/app.module.ts';
const RAICES = ['apps', 'libs'];
const IGNORAR = /(node_modules|dist|\.angular|\.nx|coverage)/;

/**
 * Deuda conocida: archivo → { violaciones permitidas, motivo }.
 * ⛔ No se agrega una entrada para «hacer pasar» la compuerta: se agrega SÓLO con una decisión
 * pendiente escrita, y se quita cuando se resuelve.
 */
const EXCEPCIONES = {
  'libs/hr/src/lib/attendance/attendance-ingest.controller.ts': {
    n: 2,
    motivo:
      '`@SkipThrottle()` a nivel de clase (2 controladores de ingesta de checadas) equivale a `{ default: true }` y no salta nada: ' +
      'el lector sí está bajo los topes globales (10/s, 60/10 s, 200/min por IP). Arreglarlo con `{ short: true, medium: true, long: true }` ' +
      'QUITA esa protección en un endpoint `@Public()` cuyo guard valida un token: decide quien lleva RH/seguridad si ese token resiste fuerza bruta sin tope.',
  },
};

/** Los nombres de tier que `ThrottlerModule.forRoot(...)` configura. */
function tiersConfigurados(texto) {
  const i = texto.indexOf('ThrottlerModule.forRoot(');
  if (i < 0) return [];
  const j = texto.indexOf('(', i);
  const bloque = extraerBalanceado(texto, j, '(', ')');
  if (bloque === null) return [];
  return [...bloque.matchAll(/\bname:\s*['"](\w+)['"]/g)].map((m) => m[1]);
}

/** El texto entre el delimitador de apertura en `desde` y su cierre balanceado (sin incluirlos); `null` si no cierra. */
function extraerBalanceado(texto, desde, abre, cierra) {
  let prof = 0;
  for (let k = desde; k < texto.length; k++) {
    const c = texto[k];
    if (c === abre) prof++;
    else if (c === cierra) {
      prof--;
      if (prof === 0) return texto.slice(desde + 1, k);
    }
  }
  return null;
}

/** Las claves de primer nivel de un literal de objeto (`a: …, b: { c: … }` → `a`, `b`). */
function clavesDePrimerNivel(cuerpo) {
  const claves = [];
  let prof = 0;
  let inicio = true; // estamos justo después de `{` o de una coma de primer nivel
  for (let k = 0; k < cuerpo.length; k++) {
    const c = cuerpo[k];
    if (c === '{' || c === '(' || c === '[') prof++;
    else if (c === '}' || c === ')' || c === ']') prof--;
    else if (prof === 0 && c === ',') inicio = true;
    else if (prof === 0 && inicio && /[A-Za-z_$]/.test(c)) {
      const m = cuerpo.slice(k).match(/^([A-Za-z_$][\w$]*)\s*:/);
      if (m) claves.push(m[1]);
      inicio = false;
    } else if (prof === 0 && inicio && /['"]/.test(c)) {
      const m = cuerpo.slice(k).match(/^['"]([\w$]+)['"]\s*:/);
      if (m) claves.push(m[1]);
      inicio = false;
    } else if (!/\s/.test(c)) inicio = false;
  }
  return claves;
}

const esComentario = (linea) => /^\s*(\/\/|\*|\/\*)/.test(linea);

/** Todo `@Throttle(` / `@SkipThrottle(` de un texto: `{ linea, decorador, clave }` por cada clave usada. */
function hallazgosDeTexto(texto) {
  const out = [];
  const lineas = texto.split('\n');
  const offsets = [];
  let acc = 0;
  for (const l of lineas) {
    offsets.push(acc);
    acc += l.length + 1;
  }
  for (const m of texto.matchAll(/@(Throttle|SkipThrottle)\(/g)) {
    const idx = m.index;
    let linea = offsets.findIndex((o, k) => o <= idx && (k === offsets.length - 1 || offsets[k + 1] > idx));
    if (linea < 0) linea = 0;
    if (esComentario(lineas[linea])) continue;
    const abre = idx + m[0].length - 1;
    const args = extraerBalanceado(texto, abre, '(', ')');
    const dec = m[1];
    if (args === null) {
      out.push({ linea: linea + 1, decorador: dec, clave: '(sin cierre)' });
      continue;
    }
    const a = args.trim();
    if (a === '') {
      // `@SkipThrottle()` = `{ default: true }`; `@Throttle()` ni compila, pero tampoco limita.
      out.push({ linea: linea + 1, decorador: dec, clave: 'default (implícita)' });
    } else if (a.startsWith('{')) {
      const cuerpo = extraerBalanceado(a, 0, '{', '}');
      const claves = cuerpo === null ? [] : clavesDePrimerNivel(cuerpo);
      if (claves.length === 0) out.push({ linea: linea + 1, decorador: dec, clave: '(objeto sin claves legibles)' });
      for (const c of claves) out.push({ linea: linea + 1, decorador: dec, clave: c });
    } else {
      out.push({ linea: linea + 1, decorador: dec, clave: `(forma no reconocida: ${a.slice(0, 30)})` });
    }
  }
  return out;
}

/** Las violaciones de un texto frente a los tiers dados. */
function violacionesDeTexto(texto, tiers) {
  return hallazgosDeTexto(texto).filter((h) => !tiers.includes(h.clave));
}

function archivos(dir, acc = []) {
  const abs = path.join(RAIZ, dir);
  if (!fs.existsSync(abs)) return acc;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (IGNORAR.test(rel)) continue;
    if (e.isDirectory()) archivos(rel, acc);
    else if (/\.ts$/.test(e.name) && !/\.(spec|d)\.ts$/.test(e.name)) acc.push(rel);
  }
  return acc;
}

/** Aplica el ratchet de EXCEPCIONES. Devuelve los textos de error. */
function juzgar(violacionesPorArchivo, excepciones) {
  const errores = [];
  for (const [archivo, lista] of Object.entries(violacionesPorArchivo)) {
    const ex = excepciones[archivo];
    if (!ex) {
      for (const v of lista) errores.push(`${archivo}:${v.linea}  @${v.decorador} usa «${v.clave}», que NO es un tier configurado: no limita nada (falla muda)`);
    } else if (lista.length > ex.n) {
      errores.push(`${archivo}  tenía ${ex.n} violaciones permitidas y ahora hay ${lista.length}: la deuda SUBIÓ`);
    } else if (lista.length < ex.n) {
      errores.push(`${archivo}  la excepción permite ${ex.n} y quedan ${lista.length}: quita o baja la entrada de EXCEPCIONES (una deuda pagada no se queda escrita)`);
    }
  }
  for (const archivo of Object.keys(excepciones)) {
    if (!violacionesPorArchivo[archivo]) errores.push(`${archivo}  figura en EXCEPCIONES pero ya no tiene violaciones: quita la entrada`);
  }
  return errores;
}

// ── Prueba negativa ───────────────────────────────────────────────────────────
function selfTest() {
  let fallas = 0;
  const ok = (cond, msg) => {
    if (!cond) {
      console.error('  ✖ ' + msg);
      fallas++;
    } else console.log('  ✓ ' + msg);
  };
  const tiers = ['short', 'medium', 'long'];

  ok(JSON.stringify(tiersConfigurados("ThrottlerModule.forRoot({ throttlers: [ { name: 'short', ttl: 1, limit: 2 }, { name: 'long', ttl: 3, limit: 4 } ] })")) === '["short","long"]', 'lee los tiers del forRoot');
  ok(tiersConfigurados('nada que ver').length === 0, 'sin forRoot no inventa tiers');

  const malo = violacionesDeTexto("@Throttle({ default: { limit: 20, ttl: 60_000 } })\nmetodo() {}", tiers);
  ok(malo.length === 1 && malo[0].clave === 'default' && malo[0].linea === 1, '⛔ `@Throttle({ default })` SE MARCA (la forma que no limitaba nada)');
  ok(violacionesDeTexto("@Throttle({ long: { limit: 20, ttl: 60_000 } })", tiers).length === 0, 'un tier real pasa');
  ok(violacionesDeTexto("@Throttle({ medium: { limit: 3, ttl: 10_000 }, long: { limit: 10, ttl: 600_000 } })", tiers).length === 0, 'dos tiers en el mismo decorador pasan');
  ok(violacionesDeTexto("@Throttle({\n  long: {\n    limit: 5,\n    ttl: 1000,\n  },\n})", tiers).length === 0, 'el literal multilínea pasa');
  const mezcla = violacionesDeTexto("@Throttle({ long: { limit: 1, ttl: 2 }, default: { limit: 3, ttl: 4 } })", tiers);
  ok(mezcla.length === 1 && mezcla[0].clave === 'default', 'una clave mala entre buenas se marca, y `limit`/`ttl` (segundo nivel) NO cuentan como claves');
  const bare = violacionesDeTexto('@SkipThrottle()\nclass A {}', tiers);
  ok(bare.length === 1 && bare[0].clave.startsWith('default'), '⛔ `@SkipThrottle()` sin argumentos SE MARCA (equivale a `{ default: true }`)');
  ok(violacionesDeTexto('@SkipThrottle({ short: true, medium: true, long: true })', tiers).length === 0, '`@SkipThrottle` con los tiers reales pasa');
  ok(violacionesDeTexto("// @Throttle({ default: { limit: 1, ttl: 2 } })\n * @SkipThrottle()", tiers).length === 0, 'lo que está en un comentario se ignora');
  ok(violacionesDeTexto("@Throttle({ 'long': { limit: 1, ttl: 2 } })", tiers).length === 0, 'una clave entre comillas se lee igual');
  ok(violacionesDeTexto('@Throttle(opciones)', tiers).length === 1, 'una forma que no se puede leer se marca, no se asume buena');

  const v = (n) => Array.from({ length: n }, (_, i) => ({ linea: i + 1, decorador: 'Throttle', clave: 'default' }));
  ok(juzgar({ 'a.ts': v(1) }, {}).length === 1, 'RATCHET: una violación en un archivo sin excepción frena');
  ok(juzgar({ 'a.ts': v(2) }, { 'a.ts': { n: 2, motivo: 'x' } }).length === 0, 'RATCHET: la deuda declarada, igual a lo permitido, no frena');
  ok(juzgar({ 'a.ts': v(3) }, { 'a.ts': { n: 2, motivo: 'x' } }).length === 1, 'RATCHET: si la deuda SUBE, frena');
  ok(juzgar({ 'a.ts': v(1) }, { 'a.ts': { n: 2, motivo: 'x' } }).length === 1, 'RATCHET: si la deuda BAJA, frena (hay que quitar la excepción)');
  ok(juzgar({}, { 'a.ts': { n: 2, motivo: 'x' } }).length === 1, 'RATCHET: una excepción sin violaciones frena (deuda ya pagada)');

  if (fallas) {
    console.error(`\n✖ self-test: ${fallas} caso(s) fallaron — la compuerta no sirve.`);
    process.exit(1);
  }
  console.log('\n✓ self-test: la compuerta marca lo que debe y deja pasar lo que debe.');
}

// ── Corrida real ──────────────────────────────────────────────────────────────
function main() {
  const modulo = path.join(RAIZ, APP_MODULE);
  if (!fs.existsSync(modulo)) {
    console.error(`✖ throttle-names: no existe ${APP_MODULE}; no hay contra qué juzgar.`);
    process.exit(1);
  }
  const tiers = tiersConfigurados(fs.readFileSync(modulo, 'utf8'));
  if (tiers.length === 0) {
    console.error(`✖ throttle-names: no se pudo leer NINGÚN tier de ThrottlerModule.forRoot en ${APP_MODULE}. Una compuerta que no sabe contra qué juzgar no reporta verde.`);
    process.exit(1);
  }

  const porArchivo = {};
  let decoradores = 0;
  for (const rel of RAICES.flatMap((r) => archivos(r))) {
    const texto = fs.readFileSync(path.join(RAIZ, rel), 'utf8');
    if (!texto.includes('Throttle(')) continue;
    decoradores += hallazgosDeTexto(texto).length;
    const vio = violacionesDeTexto(texto, tiers);
    if (vio.length) porArchivo[rel] = vio;
  }
  // Una compuerta vacua es una intención: si no encontró NI UN decorador, algo cambió (la ruta, el patrón).
  if (decoradores === 0) {
    console.error('✖ throttle-names: no encontró ningún @Throttle/@SkipThrottle en apps/ ni libs/. O cambió la forma de buscarlos o esto es vacuo.');
    process.exit(1);
  }

  const errores = juzgar(porArchivo, EXCEPCIONES);
  if (errores.length) {
    console.error(`✖ throttle-names — ${errores.length} problema(s). Tiers configurados: ${tiers.join(', ')}.\n`);
    for (const e of errores) console.error('  ' + e);
    console.error('\n  Un @Throttle/@SkipThrottle con otro nombre NO da error: simplemente no existe el tope. Usa un tier configurado.');
    process.exit(1);
  }
  const deuda = Object.values(EXCEPCIONES).reduce((s, e) => s + e.n, 0);
  console.log(`✓ throttle-names: ${decoradores} uso(s) de @Throttle/@SkipThrottle, todos con un tier configurado (${tiers.join('/')})` + (deuda ? `; ${deuda} violación(es) conocida(s) declarada(s) en EXCEPCIONES.` : '.'));
}

if (require.main === module) {
  if (process.argv.includes('--self-test')) selfTest();
  else main();
}

module.exports = { tiersConfigurados, hallazgosDeTexto, violacionesDeTexto, juzgar, EXCEPCIONES };
