#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[SUC.1]` COMPUERTA — un código de sucursal no se publica crudo, y el pipe que lo rotula
 * no se usa sin declararlo.
 *
 * ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────
 * Pedido de negocio: *"sale como sucursal como número y es universal que debe salir como
 * nombre"*. Se barrieron 82 sitios en 50 componentes. Sin compuerta, el 83 entra mañana: el
 * patrón `{{ r.warehouse_code }}` es lo que uno escribe sin pensar, y **no falla** — la
 * pantalla muestra «07» y nadie se entera hasta que alguien vuelve a reclamar.
 *
 * ── LAS DOS COSAS QUE MIDE ───────────────────────────────────────────────────────────────
 *  1. **Sitios crudos nuevos.** Interpolaciones que publican un código de sucursal sin el
 *     pipe. Se comparan contra una línea base: lo que hoy queda crudo está acá con su motivo,
 *     y lo que aparezca de más rompe. ⚠️ La base no es "lo que no alcancé a hacer": son los
 *     casos donde el código CRUDO es lo correcto (ver abajo).
 *  2. **Pipe usado sin declarar.** Angular standalone exige el pipe en `imports: [...]`; si
 *     falta, el template **no compila**, pero el error aparece recién en el build del CI y no
 *     dice qué archivo del barrido quedó a medias. Acá sale con nombre y en 300 ms.
 *
 * ── LO QUE NO SE TOCA, Y POR QUÉ ─────────────────────────────────────────────────────────
 * ⛔ **El código pegado a un folio** (`{{ t.sucursal }}/{{ t.folio }}` → «07/0123») NO es un
 * rótulo: es la LLAVE del documento, la que se dicta por teléfono y se teclea en Kepler.
 * Rotularla la vuelve inservible. Medido en el barrido: **28 de 119** ocurrencias eran de este
 * tipo; un barrido ciego las habría roto todas.
 * ⛔ **El código que ya viene con su nombre al lado** (`{{ c.warehouse_code }}
 * {{ c.warehouse_name }}`) — 19 casos — sólo se duplicaría.
 * ⛔ **El mensaje que habla del código como código** (`'La sucursal ' + c.ref.sucursal + ' no
 * está en el catálogo'`): ahí el crudo ES la información.
 *
 * Uso:  node scripts/check-sucursal-pipe.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', 'apps', 'view', 'src', 'app');
const PIPE = 'SucursalPipe';

/** Interpolación cuyo valor ES un código de sucursal (propiedad simple, con `?.` y `|| '…'`). */
const CRUDO = /\{\{\s*[A-Za-z_$][A-Za-z0-9_$.?()]*\.(?:warehouse_code|sucursal)\s*(?:\|\|\s*'[^']*')?\s*\}\}/g;
/**
 * La misma, ya rotulada.
 * ⚠️ El `[^|]` antes del `|` NO es cosmético: sin él, `{{ a.warehouse_code || a.sucursal }}`
 * —un `||` seguido de la palabra `sucursal`— se lee como si ya tuviera el pipe. Pasó en
 * `anden-vales.component.ts` y el candado lo reportó como "usa el pipe sin declararlo", un
 * archivo que no usa ningún pipe. Un detector que confunde su propio patrón con otra cosa no
 * detecta: inventa.
 */
const CON_PIPE = /\{\{[^}]*[^|\s]\s*\|\s*sucursal\b/;
/** Formas donde el crudo es CORRECTO (ver cabecera). */
const EXENTO = /folio|doc_prefix|_nombre|_name|nombreDe|nameOf|\}\}\s*\/\s*\{\{|\}\}\//;

function archivos(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) archivos(p, acc);
    // El propio pipe queda fuera: su docstring trae el ejemplo de uso (`{{ x | sucursal }}`) y
    // se denunciaría solo por "usar el pipe sin declararlo". Un candado que se marca a sí mismo
    // enseña a ignorar su salida, que es exactamente como muere una compuerta.
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') && e.name !== 'sucursal.pipe.ts') acc.push(p);
  }
  return acc;
}

const rel = (p) => path.relative(path.resolve(__dirname, '..'), p).replace(/\\/g, '/');

let crudos = 0; let sinDeclarar = 0; let usos = 0; let conPipe = 0;
const detalleCrudo = []; const detalleDecl = [];

for (const f of archivos(RAIZ)) {
  const src = fs.readFileSync(f, 'utf8');
  const lineas = src.split(/\r?\n/);

  // 1 · sitios crudos
  lineas.forEach((l, i) => {
    if (EXENTO.test(l)) return;
    const m = l.match(CRUDO);
    if (m && !CON_PIPE.test(l)) { crudos += m.length; detalleCrudo.push(`${rel(f)}:${i + 1}  ${l.trim().slice(0, 100)}`); }
  });

  // 2 · pipe usado sin declarar. Se cuenta sobre el TEMPLATE, no sobre el archivo entero,
  // para no confundir un `SucursalPipe` de un comentario con la declaración real.
  // Se reusa `CON_PIPE` en vez de repetir la expresión: eran dos copias del mismo patrón, y la
  // de acá no llevaba el `[^|]` — o sea que el conteo y la detección podían discrepar.
  const usadoAqui = (src.match(new RegExp(CON_PIPE.source, 'g')) || []).length;
  if (!usadoAqui) continue;
  usos += usadoAqui; conPipe++;
  const importado = new RegExp(`import\\s*\\{[^}]*\\b${PIPE}\\b[^}]*\\}\\s*from`).test(src);
  // En el arreglo `imports: [...]` del decorador (puede ser multilínea).
  const bloque = (src.match(/imports\s*:\s*\[[\s\S]*?\]/) || [''])[0];
  const declarado = new RegExp(`\\b${PIPE}\\b`).test(bloque);
  if (!importado || !declarado) {
    sinDeclarar++;
    detalleDecl.push(`${rel(f)}  ${importado ? '' : '· falta el import'}${!importado && !declarado ? ' y' : ''}${declarado ? '' : ' · falta en imports: [...]'}`);
  }
}

console.log(`\n[SUC.1] ${usos} usos del pipe en ${conPipe} componentes\n`);

if (detalleDecl.length) {
  console.log(`✖ ${sinDeclarar} componente(s) usan el pipe SIN declararlo — el template no compila:`);
  detalleDecl.forEach((d) => console.log(`    ${d}`));
} else {
  console.log(`✔ los ${conPipe} componentes que usan el pipe lo declaran`);
}

if (detalleCrudo.length) {
  console.log(`\n✖ ${crudos} sitio(s) publican un código de sucursal CRUDO:`);
  detalleCrudo.slice(0, 40).forEach((d) => console.log(`    ${d}`));
  if (detalleCrudo.length > 40) console.log(`    … y ${detalleCrudo.length - 40} más`);
  console.log(`\n  Rotularlo:  {{ x.warehouse_code | sucursal }}   (import SucursalPipe + imports: [...])`);
  console.log(`  Si el crudo es CORRECTO acá (folio, ya trae nombre, o el mensaje habla del código),`);
  console.log(`  la línea queda exenta sola — revisá la cabecera de este archivo.`);
} else {
  console.log(`✔ ningún código de sucursal se publica crudo`);
}

const fallas = sinDeclarar + crudos;
console.log(`\n=== ${fallas === 0 ? 'OK' : `${fallas} falla(s)`} ===\n`);
process.exit(fallas ? 1 : 0);
