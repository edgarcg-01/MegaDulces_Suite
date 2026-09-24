#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[VL.19]` COMPUERTA DE ARRANQUE — la app **levanta**, no sólo compila.
 *
 * ── El incidente que la obliga (2026-09-24) ─────────────────────────────────────────────────
 * `origin/main` llegó a producción sin arrancar. El commit `4cebb6aa` dejó
 * `FinanceExpedienteGastoModule` sin importar `CloudinaryModule`, que es quien exporta
 * `ObjectStorageService`, y Nest aborta el proceso entero:
 *
 *     UnknownDependenciesException: Nest can't resolve dependencies of the ExpedienteGastoService
 *     (TenantKnexService, TenantContextService, ?, ExpenseProofsService).
 *     ObjectStorageService at index [2] is not available in FinanceExpedienteGastoModule
 *
 * ⭐ **Ninguna compuerta existente lo veía, y no por descuido: `nx build api`, `typecheck`, `lint`
 * y las 6 suites de `libs/finance` (159 pruebas) pasaron todas en verde.** El tipo está bien
 * escrito; lo que está mal es el GRAFO de inyección, y eso Nest lo resuelve **en arranque**, no en
 * compilación. Un defecto así es invisible hasta que alguien levanta el proceso — y el primero que
 * lo levantó fue producción.
 *
 * Costó dos ventanas de caída y una reversión automática. La compuerta cuesta ~40 s.
 *
 * ── Qué mide, y qué NO ──────────────────────────────────────────────────────────────────────
 * Mide UNA cosa: que el proceso del API llegue a **escuchar**. Con eso quedan cubiertos el grafo
 * de inyección entero, los módulos que faltan, las variables de entorno obligatorias y cualquier
 * cosa que mate el arranque. NO mide que los endpoints respondan bien — eso son las suites.
 *
 * ⚠️ **Necesita la base de desarrollo alcanzable.** Si no lo está, el arranque puede colgarse por
 * una razón que no tiene nada que ver con el código, así que se reporta **NO MEDIDO** y se sale
 * con 0. Pintar eso de verde sería exactamente la mentira que la Fase VP vino a cerrar (ADR-056):
 * "no pude comprobarlo" no es "está bien". Y pintarlo de rojo enseñaría a ignorar la compuerta.
 *
 *   node scripts/check-boot.js
 *   node scripts/check-boot.js --probar-negativo   # rompe el grafo a propósito y exige el rojo
 */
'use strict';
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');
const SALIDA = path.join(RAIZ, 'dist', 'apps', 'api', 'main.js');
const ESPERA_MS = 120_000;

/**
 * El clasificador, aparte del arranque a propósito: así la prueba negativa puede ejercitarlo con
 * el texto REAL del incidente sin tener que reproducir la caída.
 *
 * `fatal` gana sobre `listo` aunque los dos aparezcan: Nest imprime muchísimo antes de morir, y
 * un arranque que alcanza a escuchar y después revienta no es un arranque bueno.
 */
function clasificar(texto) {
  const FATAL = [
    /UnknownDependenciesException/,
    /Nest can't resolve dependencies/i,
    /Nest cannot find module/i,
    /\[ExceptionHandler\]/,
    /process died during boot/i,
    /Cannot find module '/,
  ];
  for (const re of FATAL) {
    if (re.test(texto)) return { veredicto: 'fatal', patron: String(re) };
  }
  if (/Application running on/.test(texto) || /Nest application successfully started/.test(texto)) {
    return { veredicto: 'listo', patron: null };
  }
  return { veredicto: 'indeterminado', patron: null };
}

/** Las líneas que le sirven a una persona para arreglarlo, no el volcado entero. */
function lineasUtiles(texto, n = 8) {
  return texto
    .split(/\r?\n/)
    .filter((l) => /error|exception|cannot|resolve|available in|Potential solutions|died during boot/i.test(l))
    .slice(0, n)
    // Nest colorea con secuencias ANSI que en un log de CI son ruido ilegible.
    .map((l) => '      ' + l.replace(/\u001b\[[0-9;]*m/g, '').trim());
}

/** Un puerto alto y fijo por corrida: no se publica nada, sólo evita chocar con un dev server. */
function puertoLibre() {
  return 30000 + (process.pid % 20000);
}

/** ¿El binario compilado es más viejo que el código? Un `dist` rancio mide otra cosa y sale verde. */
function distEstaRancio() {
  if (!fs.existsSync(SALIDA)) return true;
  const tDist = fs.statSync(SALIDA).mtimeMs;
  let masNuevo = 0;
  const mirar = (dir) => {
    let entradas;
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) mirar(p);
      else if (e.name.endsWith('.ts')) {
        const m = fs.statSync(p).mtimeMs;
        if (m > masNuevo) masNuevo = m;
      }
    }
  };
  mirar(path.join(RAIZ, 'apps', 'api'));
  mirar(path.join(RAIZ, 'libs'));
  return masNuevo > tDist;
}

/**
 * Levanta un proceso, junta su salida y la clasifica. Devuelve en cuanto hay veredicto.
 * Mata al hijo SIEMPRE: una compuerta que deja un API huérfano escuchando es peor que no tenerla.
 */
function arrancar(cmd, args, env, esperaMs) {
  return new Promise((resolve) => {
    const hijo = spawn(cmd, args, { cwd: RAIZ, env, shell: false });
    let texto = '';
    let resuelto = false;
    const terminar = (r) => {
      if (resuelto) return;
      resuelto = true;
      clearTimeout(reloj);
      try { hijo.kill('SIGKILL'); } catch { /* ya murió */ }
      resolve({ ...r, texto });
    };
    const mirar = (b) => {
      texto += b.toString();
      const c = clasificar(texto);
      if (c.veredicto !== 'indeterminado') terminar(c);
    };
    hijo.stdout.on('data', mirar);
    hijo.stderr.on('data', mirar);
    hijo.on('error', (e) => terminar({ veredicto: 'fatal', patron: 'no se pudo lanzar: ' + e.message }));
    hijo.on('exit', (code) => {
      // Salir ANTES de escuchar es una falla aunque no haya impreso ningún patrón conocido.
      const c = clasificar(texto);
      terminar(c.veredicto === 'indeterminado'
        ? { veredicto: 'fatal', patron: 'el proceso terminó (codigo ' + code + ') sin llegar a escuchar' }
        : c);
    });
    const reloj = setTimeout(() => terminar({ veredicto: 'indeterminado', patron: 'agotó la espera' }), esperaMs);
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PRUEBA NEGATIVA — se rompe el grafo a propósito y se exige el rojo.
//
// No se toca el código real: se escribe un Nest mínimo que reproduce EXACTAMENTE el defecto del
// incidente (un servicio que inyecta un proveedor que su módulo no tiene). Así se ejercita la
// cadena completa —lanzar, leer, clasificar— en ~3 s y sin base de datos. Un gate cuyo rojo nunca
// se vio es una intención (ADR-056).
// ─────────────────────────────────────────────────────────────────────────────────────────────
async function probarNegativo() {
  let fallas = 0;
  const ok = (cond, msg) => { console.log((cond ? '  ✔ ' : '  ✘ ') + msg); if (!cond) fallas++; };

  // 1) El clasificador contra el texto REAL del incidente del 2026-09-24.
  const real = "ERROR [ExceptionHandler] UnknownDependenciesException [Error]: Nest can't resolve "
    + 'dependencies of the ExpedienteGastoService (TenantKnexService, TenantContextService, ?, '
    + 'ExpenseProofsService). Please make sure that the argument ObjectStorageService at index [2] '
    + 'is available in the FinanceExpedienteGastoModule module.';
  ok(clasificar(real).veredicto === 'fatal', 'el texto real del incidente se clasifica FATAL');
  ok(clasificar('Application running on 127.0.0.1:3333').veredicto === 'listo',
    'un arranque sano se clasifica LISTO');
  ok(clasificar('cargando modulos...').veredicto === 'indeterminado',
    'un log a medias NO se da por bueno (queda indeterminado)');
  // El orden importa: fatal manda aunque el proceso haya alcanzado a escuchar antes de morir.
  ok(clasificar('Application running on 127.0.0.1:3333\n[ExceptionHandler] boom').veredicto === 'fatal',
    'si hay fatal DESPUES de escuchar, manda el fatal');

  // 2) Extremo a extremo: un Nest de verdad con el mismo defecto tiene que salir FATAL.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chkboot-'));
  const archivo = path.join(dir, 'roto.js');
  const fuente = [
    "const { NestFactory } = require(" + JSON.stringify(require.resolve('@nestjs/core', { paths: [RAIZ] })) + ');',
    "const { Module, Injectable } = require(" + JSON.stringify(require.resolve('@nestjs/common', { paths: [RAIZ] })) + ');',
    '@Injectable() class Ausente {}',
    // Este servicio pide Ausente y su modulo NO lo provee: el mismo defecto del incidente.
    '@Injectable() class Servicio { constructor(a) { this.a = a; } }',
    'Servicio.prototype.constructor.length;',
    'Reflect.defineMetadata && null;',
    'const { Inject } = require(' + JSON.stringify(require.resolve('@nestjs/common', { paths: [RAIZ] })) + ');',
    'const Modulo = Module({ providers: [{ provide: Servicio, useFactory: (a) => new Servicio(a), inject: [Ausente] }] })(class {});',
    'NestFactory.create(Modulo, { logger: false })',
    '  .then(() => { console.log("Application running on 127.0.0.1:0"); process.exit(0); })',
    '  .catch((e) => { console.error("[ExceptionHandler] " + (e && e.message)); process.exit(1); });',
  ].join('\n');
  fs.writeFileSync(archivo, fuente);
  const r = await arrancar(process.execPath, [archivo], { ...process.env }, 30_000);
  ok(r.veredicto === 'fatal', 'un Nest REAL con el grafo roto sale FATAL (no verde, no colgado)');
  if (r.veredicto !== 'fatal') console.log(r.texto.split('\n').slice(-6).map((l) => '      ' + l).join('\n'));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* da igual */ }

  console.log(fallas === 0 ? '\nPRUEBA NEGATIVA: OK — la compuerta muerde.' : '\nPRUEBA NEGATIVA: ' + fallas + ' FALLA(S).');
  process.exit(fallas === 0 ? 0 : 1);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
async function principal() {
  if (process.argv.includes('--probar-negativo')) return probarNegativo();

  if (distEstaRancio()) {
    console.log('  el compilado esta mas viejo que el codigo — construyendo api primero…');
    const b = spawnSync('npx', ['nx', 'build', 'api'], { cwd: RAIZ, shell: true, encoding: 'utf8', maxBuffer: 1 << 26 });
    if (b.status !== 0) {
      console.log('✘ boot: NO MEDIDO — no se pudo construir api (eso lo reporta la compuerta `build`).');
      return process.exit(0);
    }
  }
  if (!fs.existsSync(SALIDA)) {
    console.log('✘ boot: NO MEDIDO — no existe ' + path.relative(RAIZ, SALIDA) + '.');
    return process.exit(0);
  }

  // ── Lo que esta compuerta mide es el CODIGO, no el `.env` de quien la corre ────────────────
  // Primera corrida real, 2026-09-24: salio roja por el freno `[AUTHZ-HARD]`, que aborta si
  // `JWT_SECRET` es el default publico del repo. El freno esta bien y tiene que seguir ahi — pero
  // esto lo dispara el archivo local de cada quien, no un defecto que se pueda arreglar en un
  // commit. **Una compuerta que se pone roja por algo que el codigo no controla ensena a
  // ignorarla**, y entonces el dia que el rojo es de verdad nadie lo mira.
  //
  // Asi que se le pasa un secreto de usar y tirar, distinto del default. No afloja nada: la
  // higiene del secreto de produccion vive en `ops/prod` y en el arranque real, que es donde
  // corresponde. Aca se mide una sola cosa: que el grafo levante.
  const env = {
    ...process.env,
    // Los 51 @Cron quedan inertes: la compuerta mide el ARRANQUE, no pone a trabajar la maquina.
    DISABLE_CRONS: 'true',
    PORT: String(puertoLibre()),
    NODE_ENV: process.env.NODE_ENV || 'production',
    JWT_SECRET: 'compuerta-de-arranque-secreto-descartable-' + process.pid,
  };
  const t0 = Date.now();
  const r = await arrancar(process.execPath, [SALIDA], env, ESPERA_MS);
  const seg = ((Date.now() - t0) / 1000).toFixed(1);

  if (r.veredicto === 'listo') {
    console.log('✔ boot: el API arranca y escucha (' + seg + ' s).');
    return process.exit(0);
  }
  if (r.veredicto === 'fatal') {
    console.log('✘ boot: EL API NO ARRANCA (' + seg + ' s) — ' + r.patron);
    console.log(lineasUtiles(r.texto).join('\n') || '      (sin lineas de error reconocibles)');
    console.log('\n  Esto tumba produccion apenas se despliegue. `nx build` NO lo ve: el grafo de');
    console.log('  inyeccion se resuelve al arrancar, no al compilar.');
    return process.exit(1);
  }
  // Indeterminado: casi siempre la base de desarrollo inalcanzable. Se DECLARA (ADR-056).
  console.log('~ boot: NO MEDIDO (' + seg + ' s) — ' + r.patron + '.');
  console.log('  Suele ser la base de desarrollo fuera de alcance, no el codigo. Ultimas lineas:');
  console.log(r.texto.split(/\r?\n/).filter(Boolean).slice(-5).map((l) => '      ' + l.replace(/\u001b\[[0-9;]*m/g, '')).join('\n'));
  return process.exit(0);
}

principal().catch((e) => { console.error('check-boot reventó:', e); process.exit(1); });
