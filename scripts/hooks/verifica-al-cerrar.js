#!/usr/bin/env node
/**
 * Hook Stop — corre las compuertas rapidas sobre lo que la sesion TOCO, al cerrar el turno.
 *
 * ⭐ POR QUE EXISTE (auditoria 2026-10-14). El reclamo medido fue "no es autocritico y no
 * evalua su propio trabajo". La causa no era de estilo: **no habia un solo hook configurado**
 * en ningun settings.json, asi que nada corria despues de una edicion. Toda la verificacion
 * era voluntaria y en prosa. Y las compuertas que si existen (31 en el registro) corren en
 * el `pre-push` -- o sea, al EMPUJAR, que es tarde y pasa una vez cada muchos turnos.
 *
 * Esto cierra ese hueco: al terminar el turno mide los archivos del arbol de trabajo y
 * devuelve el rojo a la sesion, que es el unico momento en que todavia puede arreglarlo.
 *
 * ⛔ DOS FRENOS, A PROPOSITO:
 *
 *  1. **Anti-bucle.** Bloquear en `Stop` reinvoca al modelo. Si una compuerta esta roja por
 *     deuda ajena, la sesion no puede arreglarla y quedaria girando para siempre. Por eso
 *     bloquea UNA sola vez por conjunto de archivos: la segunda pasada con el mismo estado
 *     solo informa. El estado vive en `.git/` (local, no versionado, se va con el clon).
 *
 *  2. **Nunca falla por su propia infraestructura.** Mismo criterio que `.githooks/pre-push`:
 *     si node no puede correr una compuerta, o git no responde, deja pasar. Una compuerta que
 *     rompe el flujo por su propio andamio se desactiva a la semana, y entonces no protege
 *     de nada.
 *
 * ⚠️ Solo corre compuertas ESTATICAS y rapidas (sin red, sin base). Las que necesitan la LAN
 *    -- `destino-prod` y `migrations` -- van aparte en `DE_RED`, porque en una maquina sin
 *    acceso a `192.168.0.222` tardarian hasta el timeout en cada turno.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RAIZ = path.resolve(__dirname, '..', '..');
const TOPE_MS = 25000;

/** Compuertas estaticas que valen la pena en cada turno (ms medidos 2026-10-14). */
const RAPIDAS = [
  { nombre: 'ts7-paths', script: 'scripts/check-ts7-paths.js', ms: 105 },
  { nombre: 'docker-ctx', script: 'scripts/check-docker-context.js', ms: 235 },
  { nombre: 'sucursales', script: 'scripts/check-branch-catalog.js', ms: 668 },
];

/**
 * Compuertas que necesitan la LAN. Solo corren si hay una var de prod definida,
 * y su falla NUNCA bloquea: sin red darian un rojo que no es del trabajo de la sesion.
 */
const DE_RED = [
  { nombre: 'migrations', script: 'database/scripts/check-applied-migrations.js', ms: 300 },
  // ⭐ `destino-prod` vive SOLO aca. `ci.yml` lo excluye con razon declarada ("sin
  // `PROD_DB_URL` se niega a decir verde, y hace bien"), y el runner de GitHub no
  // alcanza `192.168.0.222`. Esta maquina si. Es el candado del incidente del
  // 2026-09-24: una auditoria entera medida contra la Railway muerta, una migracion
  // aplicada al cluster equivocado y un "incidente de ingesta" reportado que no existia.
  // *Un destino equivocado no falla: triunfa en el lugar equivocado.*
  { nombre: 'destino-prod', script: 'scripts/check-prod-target.js', ms: 520 },
];

function main() {
  const tocados = archivosTocados();
  if (!tocados.length) return salir();

  const fallas = [];
  for (const g of RAPIDAS) {
    const r = corre(g.script);
    if (r.rojo) fallas.push({ ...g, salida: r.salida, bloquea: true });
  }
  for (const g of DE_RED) {
    if (!process.env.DATABASE_URL_NEW_PROD && !process.env.PROD_DB_URL) continue;
    const r = corre(g.script);
    if (r.rojo) fallas.push({ ...g, salida: r.salida, bloquea: false });
  }

  if (!fallas.length) return salir();

  const bloqueantes = fallas.filter((f) => f.bloquea);
  const yaAvisado = mismaHuella(tocados);
  marcarHuella(tocados);

  const detalle = fallas
    .map((f) => `  · ${f.nombre}${f.bloquea ? '' : ' (informativo, necesita LAN)'}\n${sangra(f.salida)}`)
    .join('\n');

  // Segunda pasada con el mismo estado, o nada bloqueante: solo informar.
  if (!bloqueantes.length || yaAvisado) {
    return salir({
      systemMessage: `Compuertas en rojo (ya avisado, no bloqueo):\n${detalle}`,
    });
  }

  salir({
    decision: 'block',
    reason:
      `Antes de cerrar: ${bloqueantes.length} compuerta(s) del repo estan en ROJO ` +
      `sobre el arbol que dejaste.\n\n${detalle}\n\n` +
      'Arreglalo, o si el rojo es deuda ajena a tu cambio, decilo explicitamente en tu ' +
      'respuesta (no lo dejes pasar en silencio). Este aviso NO se repite: la proxima vez ' +
      'con el mismo arbol solo informa.',
  });
}

/** Archivos modificados en el arbol (lo que la sesion dejo sin commitear). */
function archivosTocados() {
  try {
    const s = execFileSync('git', ['status', '--porcelain'], {
      cwd: RAIZ,
      encoding: 'utf8',
      timeout: 5000,
    });
    return s.split('\n').filter(Boolean);
  } catch {
    return []; // sin git no estorbo
  }
}

function corre(script) {
  const abs = path.join(RAIZ, script);
  if (!fs.existsSync(abs)) return { rojo: false, salida: '' };
  try {
    execFileSync(process.execPath, [abs], {
      cwd: RAIZ,
      encoding: 'utf8',
      timeout: TOPE_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { rojo: false, salida: '' };
  } catch (e) {
    // Un fallo del andamio (timeout, node ausente) no es un rojo de compuerta.
    if (e.killed || e.code === 'ETIMEDOUT' || typeof e.status !== 'number') {
      return { rojo: false, salida: '' };
    }
    const txt = `${e.stdout || ''}${e.stderr || ''}`.trim();
    return { rojo: true, salida: txt.split('\n').slice(0, 12).join('\n') };
  }
}

const SELLO = path.join(RAIZ, '.git', 'ultimo-aviso-compuertas');

function huella(tocados) {
  return crypto.createHash('md5').update(tocados.join('\n')).digest('hex');
}
function mismaHuella(tocados) {
  try {
    return fs.readFileSync(SELLO, 'utf8').trim() === huella(tocados);
  } catch {
    return false;
  }
}
function marcarHuella(tocados) {
  try {
    fs.writeFileSync(SELLO, huella(tocados));
  } catch {
    /* si no puedo escribir el sello, solo pierdo el anti-bucle */
  }
}

function sangra(s) {
  return s
    .split('\n')
    .map((l) => `      ${l}`)
    .join('\n');
}

function salir(obj) {
  if (obj) process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // jamas romper el turno por culpa de este hook
}
