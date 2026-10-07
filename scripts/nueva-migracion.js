#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[PROC.2]` — **La marca de tiempo de una migración se GENERA, no se elige.**
 *
 * ── El defecto que esto cierra, medido el 2026-10-07 ────────────────────────────────────────
 *
 *   187 de 1,084 migraciones (17 %) comparten marca de tiempo con otra.
 *   1,058 de 1,084 terminan en segundos `00`.
 *
 * El segundo número explica el primero: nadie usa un generador, se escribe a mano un número
 * redondo (`...120000`, `...140000`). Con ~16 sesiones trabajando el mismo día, dos eligen el
 * mismo y las dos pasan su compuerta local — `check-migration-collisions.js` sólo compara contra
 * lo que hay EN TU disco, así que dos ramas en paralelo nunca se ven. Colisionan al aterrizar.
 *
 * No rompe hoy porque knex guarda cada migración por su NOMBRE COMPLETO, así que las dos corren.
 * Lo que se pierde es el ORDEN: entre dos del mismo instante lo decide una letra del nombre de
 * archivo, no el reloj. El día que una dependa de la otra, falla sin que el mensaje lo explique.
 *
 * ⚠️ `npm run migrate:new` NO crea una migración: corre `migrate:latest`, o sea que APLICA todas
 *    las pendientes. Quien lo tipee esperando un generador, despliega. Por eso este script existe
 *    aparte y con otro nombre.
 *
 * ── Uso ─────────────────────────────────────────────────────────────────────────────────────
 *
 *     node scripts/nueva-migracion.js <nombre_en_snake_case>
 *     node scripts/nueva-migracion.js gp_tablero_pedidos_acceso
 *
 * Imprime la ruta del archivo creado. No toca la base.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'database', 'migrations-newdb');

/** `YYYYMMDDHHMMSS` en hora local, con los SEGUNDOS reales — que es lo que evita la colisión. */
function marca(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Las marcas ya tomadas. Mira el disco Y `origin/main`: una rama paralela puede haber aterrizado
 * una migración que tu copia local todavía no tiene, y ésa es justamente la colisión que no se ve.
 */
function tomadas() {
  const set = new Set();
  for (const f of fs.readdirSync(DIR)) if (f.endsWith('.js')) set.add(f.slice(0, 14));
  try {
    const salida = execFileSync('git', ['ls-tree', 'origin/main', '--name-only', 'database/migrations-newdb/'],
      { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const l of salida.split('\n')) {
      const b = l.trim().split('/').pop();
      if (b && b.endsWith('.js')) set.add(b.slice(0, 14));
    }
  } catch {
    console.warn('  ⚠️ no se pudo leer `origin/main` (¿sin red?): la marca se comprueba SÓLO contra el disco.');
  }
  return set;
}

const PLANTILLA = (nombre) => `'use strict';
/**
 * \`[XX.N]\` — <qué hace y POR QUÉ, con lo que mediste antes de escribirla>.
 *
 * ── Lo medido antes (sólo lectura) ──────────────────────────────────────────────────────────
 *  · <la cifra que justifica este cambio>
 *
 * ⚠️ Si sólo hace GRANT/UPDATE/INSERT y no crea ningún objeto de esquema, la compuerta del
 *    despliegue la clasifica NO_MEDIDO y FRENA a todo el equipo hasta que alguien la aplique a
 *    mano. Aplicala ANTES de mergear.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(\`SET LOCAL lock_timeout = '5s'\`);
  // TODO
};

/** Deshace EXACTAMENTE lo que hizo el \`up\`, ni una fila más. */
exports.down = async function down(knex) {
  void knex;
  // TODO
};
`;

function main() {
  const nombre = process.argv[2];
  if (!nombre) {
    console.error('Uso: node scripts/nueva-migracion.js <nombre_en_snake_case>');
    process.exit(2);
  }
  if (!/^[a-z][a-z0-9_]*$/.test(nombre)) {
    console.error(`⛔ "${nombre}" no es snake_case en minúsculas. Es la convención del repo (CLAUDE.md).`);
    process.exit(2);
  }

  const ya = tomadas();
  // Si el segundo exacto ya está tomado, se avanza de a un segundo. Nunca se reusa una marca:
  // es más barato correr el reloj que explicarle a alguien por qué su migración corrió primero.
  const d = new Date();
  let t = marca(d);
  let saltos = 0;
  while (ya.has(t)) { d.setSeconds(d.getSeconds() + 1); t = marca(d); saltos++; }

  const destino = path.join(DIR, `${t}_${nombre}.js`);
  fs.writeFileSync(destino, PLANTILLA(nombre), 'utf8');

  console.log(`✓ ${path.relative(path.join(__dirname, '..'), destino)}`);
  console.log(`  marca ${t} · ${ya.size} ya tomadas${saltos ? ` · ${saltos} segundo(s) de salto para no pisar una` : ''}`);
}

main();
