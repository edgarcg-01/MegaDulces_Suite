#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[PROC.3]` — **Dos decisiones no pueden tener el mismo número.**
 *
 * ── El defecto, medido el 2026-10-07 ────────────────────────────────────────────────────────
 *
 * `02_DECISIONES_ARQUITECTURA.md` tiene 83 ADR y DOS números ocupados dos veces:
 *
 *   · ADR-031 → «Cadena de compra real (RA.15)»  y  «Wincaja: landing schema separado»
 *   · ADR-053 → «Un feed sin latido propio (OBS)» y  «Reclamo de recepción (WMS-REC.8)»
 *
 * Un ADR se cita desde el código y desde los planes — hay 40+ archivos citando esos dos números.
 * Cuando el número está ocupado dos veces, la cita **no identifica nada**: quien lee
 * `(ADR-031)` en un comentario no sabe cuál de las dos decisiones lo respalda.
 *
 * ⭐ La causa es la misma que la de las marcas de tiempo de las migraciones: cada sesión elige
 * el siguiente número **a mano**, mirando el archivo en el momento en que empieza. Con ~16
 * sesiones en un día, dos miran el mismo estado y eligen el mismo número. `CLAUDE.md` ya
 * documentaba el caso de ADR-052 y nadie lo arregló, porque nada lo vuelve a mirar.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *
 * Falla si aparece un número de ADR repetido que NO esté en `HEREDADOS`. Es un trinquete: los
 * dos de hoy quedan declarados con su motivo, y uno nuevo pone el CI en rojo.
 *
 * ⚠️ Los heredados NO se renumeran acá y es a propósito: son 40+ archivos de varias fases, y
 *    reescribirlos en caliente —con otras sesiones editando los mismos archivos— cuesta más de
 *    lo que arregla. Renumerarlos es una decisión de quien es dueño de esas fases, no de una
 *    compuerta. Lo que esta compuerta garantiza es que la lista no crezca.
 *
 *     node scripts/check-adr-duplicados.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DOC = path.join(__dirname, '..', 'docs', 'IMPLEMENTACION', '02_DECISIONES_ARQUITECTURA.md');

/** Los duplicados que ya existían al poner la compuerta. No crecen; se encogen cuando se renumeren. */
const HEREDADOS = new Map([
  ['031', 'RA.15 «Cadena de compra real» vs. Wincaja «landing schema separado» — medido 2026-10-07'],
  ['053', 'OBS «Un feed sin latido propio» vs. WMS-REC.8 «Reclamo de recepción» — medido 2026-10-07'],
]);

function main() {
  if (!fs.existsSync(DOC)) {
    console.error(`⛔ no está ${path.relative(process.cwd(), DOC)} — la compuerta no puede medir. FRENA.`);
    process.exit(1);
  }
  const txt = fs.readFileSync(DOC, 'utf8');

  const cuenta = new Map();
  for (const l of txt.split('\n')) {
    const m = /^##\s+ADR-(\d{3})\b/.exec(l);
    if (m) cuenta.set(m[1], (cuenta.get(m[1]) || 0) + 1);
  }
  if (cuenta.size === 0) {
    console.error('⛔ cero encabezados `## ADR-NNN`: o cambió el formato del documento o se leyó mal. FRENA.');
    process.exit(1);
  }

  const dup = [...cuenta.entries()].filter(([, n]) => n > 1).map(([k]) => k).sort();
  const nuevos = dup.filter((k) => !HEREDADOS.has(k));
  const curados = [...HEREDADOS.keys()].filter((k) => !dup.includes(k)).sort();

  const max = [...cuenta.keys()].sort().pop();
  console.log(`  ${cuenta.size} ADR · el más alto es ADR-${max} · el siguiente libre es ADR-${String(Number(max) + 1).padStart(3, '0')}`);

  if (curados.length) {
    console.log(`\n  ⭐ ya no están duplicados (sacalos de HEREDADOS en este archivo): ${curados.map((k) => `ADR-${k}`).join(', ')}`);
  }

  if (nuevos.length) {
    console.error('\n⛔ NÚMERO DE ADR DUPLICADO — dos decisiones distintas con el mismo número:');
    for (const k of nuevos) {
      console.error(`\n   ADR-${k} aparece ${cuenta.get(k)} veces:`);
      for (const l of txt.split('\n')) {
        if (new RegExp(`^##\\s+ADR-${k}\\b`).test(l)) console.error(`     ${l.slice(0, 110)}`);
      }
    }
    console.error(`\n   Una cita «(ADR-${nuevos[0]})» desde el código deja de identificar una decisión.`);
    console.error(`   Usá el siguiente libre: ADR-${String(Number(max) + 1).padStart(3, '0')}.`);
    process.exit(1);
  }

  if (dup.length) {
    console.log(`\n  ${dup.length} duplicado(s) HEREDADO(S), declarados — no crecen:`);
    for (const k of dup) console.log(`     ADR-${k}: ${HEREDADOS.get(k)}`);
  }
  console.log('\n✓ ningún número de ADR duplicado NUEVO.');
}

main();
