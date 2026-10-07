#!/usr/bin/env node
/**
 * `[KBD.1]` COMPUERTA — una tabla que se puede SELECCIONAR se puede RECORRER con el teclado.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * QUÉ MIRA, Y POR QUÉ ESE CRITERIO
 *
 * `pSelectableRow` de PrimeNG es lo que da `↑↓`, `Home`/`End`, `Enter`/`Space` y el roving
 * tabindex (la tabla entera = UN stop de tabulador, DESIGN D.4a). Una `<p-table>` con
 * `selectionMode` **sin** `pSelectableRow` tiene filas que se eligen con el mouse y **no existen
 * para el teclado**: ni se llega a ellas tabulando, ni se recorren con flechas.
 *
 * El criterio es `selectionMode` y no "toda tabla", a propósito: una tabla de sólo lectura no
 * tiene nada que seleccionar, y exigirle navegación sería ruido. Medido al escribir esto:
 * **153 archivos con `<p-table>`, 13 con `pSelectableRow`.**
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * ⛔ LO QUE ESTA COMPUERTA **NO** PUEDE VER, Y SE DECLARA
 *
 * Mira por ARCHIVO, no por tabla — igual que `check:tables`, y por la misma razón: amarrar cada
 * `selectionMode` con el `<p-table>` que lo lleva exige parsear el template, y hay pantallas
 * donde el modo ni siquiera está en el template (`[selectionMode]="modo()"`). Un archivo con dos
 * tablas donde se arregló UNA pasa entero. Se dice acá en vez de fingir precisión.
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const APPS = ['apps/view/src', 'apps/vendor/src', 'apps/portal/src'];

/**
 * DEUDA DECLARADA — las que ya estaban cuando se escribió la compuerta (2026-10-01).
 *
 * No se silencian: se CUENTAN y se imprimen en cada corrida. La identidad importa, no el conteo:
 * un archivo NUEVO que no esté acá rompe la compuerta aunque ese mismo día se haya arreglado
 * otro. Podar la lista AVISA pero no rompe — son muchas, repartidas entre ~10 sesiones, y hacer
 * fallar el build del que arregló una pantalla ajena es como se terminan apagando las compuertas.
 */
const DEUDA = new Set(JSON.parse(
  fs.existsSync(path.join(__dirname, 'check-keyboard-nav.deuda.json'))
    ? fs.readFileSync(path.join(__dirname, 'check-keyboard-nav.deuda.json'), 'utf8')
    : '[]',
));

/**
 * ⛔ DOS AGUJAS, y las dos se acotaron MIDIENDO en vez de suponiendo.
 *
 * **Primer intento:** `/\bselectionMode\b/` sobre el fuente entero. Dio 8 pantallas y al abrirlas
 * **7 eran falsos positivos** — `selectionMode="range"` es también un input de `p-datepicker`, y
 * casi toda pantalla con filtro de fechas lo tiene. Una compuerta que marca siete de ocho mal
 * enseña a ignorarla en la primera corrida. Por eso el atributo se busca DENTRO de la etiqueta
 * `<p-table …>` (`[^>]*` cruza los saltos de línea, que es como está escrito todo el repo).
 *
 * **Segundo hallazgo:** acotada así, la aguja de selección encuentra **CERO** — toda tabla
 * `selectionMode="single"` del repo ya trae `pSelectableRow`. Queda igual, porque protege lo que
 * ya está bien, pero no era ahí donde estaba el problema.
 *
 * **Donde sí estaba:** la fila con `(click)` que el teclado no alcanza — **29 archivos medidos**.
 * Se abre con el mouse y con el teclado no se llega ni tabulando. Ésa es, textual, la falta de
 * "desplazamiento por flechas".
 *
 * ⚠️ Las tres tablas de multi-selección con checkbox NO entran: ahí `pSelectableRow` secuestra
 * el clic de la fila —que en esas pantallas abre el detalle— y el checkbox ya es el camino de
 * teclado para seleccionar. Exigírselo habría metido una regresión disfrazada de arreglo.
 */
const RE_TABLA_SINGLE = /<p-table\b[^>]*selectionMode="single"[^>]*>/;
const RE_FILA_CLICABLE = /<tr\b[^>]*\(click\)/;
const RE_FILA_ENFOCABLE = /<tr\b[^>]*tabindex/;

function analizar(src) {
  const tieneSelectable = /\bpSelectableRow\b/.test(src);
  if (RE_TABLA_SINGLE.test(src) && !tieneSelectable) {
    return {
      motivo:
        'la tabla selecciona con el clic y no se puede RECORRER: sus filas no existen para el ' +
        'teclado. Falta [pSelectableRow]="fila" en el <tr> del cuerpo.',
    };
  }
  if (RE_FILA_CLICABLE.test(src) && !tieneSelectable && !RE_FILA_ENFOCABLE.test(src)) {
    return {
      motivo:
        'hay una fila con (click) a la que el teclado NO llega: ni tabulando ni con flechas. ' +
        'Lo que se hace con el mouse tiene que poder hacerse con el teclado.',
    };
  }
  return null;
}

// ── Prueba negativa ────────────────────────────────────────────────────────────────────────
if (process.argv.includes('--self-test')) {
  const casos = [
    // ── Aguja 1 · selección por clic de fila ───────────────────────────────────────────────
    ['selección single sin navegación', '<p-table selectionMode="single"><tr>x</tr>', true],
    ['selección single CON navegación', '<p-table selectionMode="single"><tr [pSelectableRow]="f">x</tr>', false],
    ['tabla de sólo lectura: no aplica', '<p-table [value]="filas()"><tr>x</tr>', false],
    ['etiqueta multilínea', '<p-table [value]="f()"\n   dataKey="id"\n   selectionMode="single">\n<tr>x</tr>', true],
    // ⛔⛔ EL FALSO POSITIVO QUE DE VERDAD PASÓ: 7 de 8 hallazgos de la primera corrida eran
    // esto — el filtro de fechas de la pantalla, que NO es una tabla.
    ['p-datepicker selectionMode=range + tabla de sólo lectura',
      '<p-datepicker selectionMode="range" /> <p-table [value]="f()"><tr>x</tr>', false],
    ['datepicker range Y ADEMÁS una tabla single sin teclado',
      '<p-datepicker selectionMode="range" /> <p-table selectionMode="single"><tr>x</tr>', true],
    ['selectionMode suelto en TypeScript, sin tabla', 'interface X { selectionMode: string }', false],
    // ⛔ Multi-selección con checkbox: NO se exige. pSelectableRow secuestraría el clic de la
    // fila, que en esas pantallas abre el detalle, y el checkbox ya es el camino de teclado.
    ['multi con checkbox: no se exige',
      '<p-table selectionMode="multiple"><tr><td><p-tablecheckbox [value]="r" /></td></tr>', false],

    // ── Aguja 2 · la fila clicable que el teclado no alcanza (29 archivos medidos) ─────────
    ['fila con (click) sin teclado', '<tr (click)="abrir(d)"><td>x</td></tr>', true],
    ['fila con (click) + pSelectableRow', '<tr [pSelectableRow]="d" (click)="abrir(d)"><td>x</td></tr>', false],
    ['fila con (click) + tabindex (la salida que ya usa el repo)',
      '<tr (click)="abrir(d)" tabindex="0" role="button"><td>x</td></tr>', false],
    // ⛔ El (click) en un BOTÓN de la fila no cuenta: ése ya es enfocable por sí mismo.
    ['botón con (click) dentro de la fila', '<tr><td><button (click)="abrir(d)">ver</button></td></tr>', false],
  ];
  let fallos = 0;
  for (const [nombre, src, debeFallar] of casos) {
    const fallo = analizar(src) !== null;
    if (fallo !== debeFallar) {
      console.error(`  ❌ self-test "${nombre}": esperaba ${debeFallar ? 'ROJO' : 'verde'} y dio ${fallo ? 'ROJO' : 'verde'}`);
      fallos++;
    } else {
      console.log(`  ✅ self-test "${nombre}": ${debeFallar ? 'rojo' : 'verde'}, como debe`);
    }
  }
  if (fallos) {
    console.error(`\n❌ La compuerta no detecta ${fallos} caso(s) que debería.\n`);
    process.exit(1);
  }
  console.log(`\n✅ ${casos.length} casos: la compuerta se pone roja exactamente donde debe.\n`);
  process.exit(0);
}

// ── La guarda tiene que estar INSTALADA, o el primitivo es decorativo ──────────────────────
const sinGuarda = ['view', 'vendor', 'portal'].filter((app) => {
  const p = path.join(RAIZ, 'apps', app, 'src', 'main.ts');
  return !fs.existsSync(p) || !fs.readFileSync(p, 'utf8').includes('installRowNavGuard(');
});

function recorrer(dir, salida) {
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return salida; }
  for (const e of entradas) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') recorrer(p, salida); }
    else if (e.name.endsWith('.component.ts')) salida.push(p);
  }
  return salida;
}

const archivos = [];
for (const a of APPS) recorrer(path.join(RAIZ, a), archivos);

const malos = [];
const cohorte = [];
for (const f of archivos) {
  const src = fs.readFileSync(f, 'utf8');
  const r = analizar(src);
  if (!r) continue;
  const rel = path.relative(RAIZ, f).replace(/\\/g, '/');
  if (DEUDA.has(rel)) cohorte.push({ rel, ...r });
  else malos.push({ rel, ...r });
}

if (sinGuarda.length) {
  console.error(`\n❌ La guarda de teclado NO está instalada en: ${sinGuarda.join(', ')}`);
  console.error('   `installRowNavGuard(document)` va en el main.ts de cada app, junto a la guarda');
  console.error('   de la rueda. Sin ella, encender la navegación le ROBA las teclas (Space, Enter,');
  console.error('   Home/End, flechas) a cualquier campo que viva dentro de una fila.\n');
  process.exit(1);
}

if (malos.length) {
  console.error('');
  for (const m of malos) {
    console.error(`❌ ${m.rel}`);
    console.error(`   ${m.motivo}`);
  }
  console.error(`\n${malos.length} tabla(s) NUEVAS seleccionables sin teclado.`);
  console.error('   Cómo se arregla: [pSelectableRow]="fila" en el <tr>, y dataKey en la <p-table>.');
  console.error('   ⛔ No hace falta escribir una directiva: PrimeNG ya mueve, y la guarda global');
  console.error('      de @megadulces/ui-web ya evita que le robe las teclas a los campos.\n');
  process.exit(1);
}

const podables = [...DEUDA].filter((d) => !cohorte.some((c) => c.rel === d));
if (podables.length) {
  console.log(`\n✅ ${podables.length} pantalla(s) de la deuda ya NO la necesitan:`);
  for (const s of podables.slice(0, 10)) console.log(`   · ${s}`);
  if (podables.length > 10) console.log(`   · …y ${podables.length - 10} más`);
  console.log('   Sacalas de scripts/check-keyboard-nav.deuda.json.\n');
}

const deudaTxt = cohorte.length
  ? `\n⚠️  ${cohorte.length} pantalla(s) en DEUDA: seleccionables con el mouse, invisibles para el teclado.\n` +
    `   No son un aprobado: es el trabajo que falta. Tracker: [KBD.1].`
  : '';

console.log(
  `✅ ${archivos.length} componente(s) · guarda instalada en las 3 apps · ` +
  `ninguna tabla NUEVA seleccionable sin teclado.${deudaTxt}`,
);
