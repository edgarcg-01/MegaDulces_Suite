#!/usr/bin/env node
/**
 * Compuerta de registro: la interfaz le habla de TÚ, no de VOS.
 *
 * Qué mira: SOLO texto que ve el usuario — literales de cadena en `.ts` y el
 * cuerpo de los `.html`. Los comentarios de código quedan fuera a propósito:
 * la memoria interna del repo está escrita en voseo y reescribirla sería un
 * diff de miles de líneas que no cambia una sola pantalla.
 *
 * Por qué un tokenizador y no un `grep`: `grep` no distingue
 * "// esto elegía el almacén" (comentario, no se toca) de
 * "Elegí una sucursal" (botón, sí se toca), y `\b` de grep ni siquiera respeta
 * los acentos — `abrí` casaba dentro de `abría`.
 *
 * Uso:
 *   node scripts/check-voseo.js                 → reporta y sale 1 si hay voseo
 *   node scripts/check-voseo.js --aplicar       → reescribe los casos seguros
 *   node scripts/check-voseo.js --ambiguos      → lista los -ir (elegí/abrí/…)
 *   node scripts/check-voseo.js --self          → prueba negativa de la compuerta
 */

const fs = require('fs');
const path = require('path');
const MAPA = require('./voseo-map.js');

const RAIZ = path.resolve(__dirname, '..');

/** Dónde vive el texto que ve un usuario de producción. */
const AMBITOS = [
  'apps/view/src',
  'apps/portal/src',
  'apps/vendor/src',
  'apps/api/src',
  'libs',
];

const EXCLUIR_DIR = new Set(['node_modules', 'dist', '.angular', 'coverage', '.nx']);
const EXT = new Set(['.ts', '.html']);

function listarArchivos(dir, acc) {
  let entradas;
  try {
    entradas = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entradas) {
    if (e.isDirectory()) {
      if (EXCLUIR_DIR.has(e.name)) continue;
      listarArchivos(path.join(dir, e.name), acc);
    } else if (EXT.has(path.extname(e.name))) {
      acc.push(path.join(dir, e.name));
    }
  }
  return acc;
}

/**
 * Devuelve los tramos de `src` que son texto para el usuario.
 * En `.ts`: el interior de cada literal de cadena (', ", `), sin comentarios y
 * sin las expresiones `${...}` incrustadas, que vuelven a ser código.
 */
function tramosTexto(src, esHtml) {
  const tramos = [];
  if (esHtml) {
    let i = 0;
    let ini = 0;
    while (i < src.length) {
      if (src.startsWith('<!--', i)) {
        if (i > ini) tramos.push([ini, i]);
        const fin = src.indexOf('-->', i + 4);
        i = fin === -1 ? src.length : fin + 3;
        ini = i;
      } else {
        i++;
      }
    }
    if (ini < src.length) tramos.push([ini, src.length]);
    return tramos;
  }

  let i = 0;
  // pila de contextos de template literal: cada `${` abre código anidado
  const pilaTpl = [];
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];

    if (c === '/' && d === '/') {
      const fin = src.indexOf('\n', i);
      i = fin === -1 ? src.length : fin + 1;
      continue;
    }
    if (c === '/' && d === '*') {
      const fin = src.indexOf('*/', i + 2);
      i = fin === -1 ? src.length : fin + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const comilla = c;
      const ini = i + 1;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === comilla) break;
        if (src[i] === '\n') break; // cadena sin cerrar: no arrastres el archivo
        i++;
      }
      if (i > ini) tramos.push([ini, i]);
      i++;
      continue;
    }
    if (c === '`') {
      let ini = i + 1;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '`') break;
        // Un template literal NO es sólo texto para el usuario: adentro viven
        // el SQL de knex.raw(), el CSS de `styles:` y el HTML de `template:`,
        // cada uno con SUS comentarios. Ahí el repo escribe en voseo a
        // propósito (es memoria interna) y además hay 1ª persona legítima
        // ("la escribí y caí en ella dos veces").
        if (src[i] === '/' && src[i + 1] === '*') {
          if (i > ini) tramos.push([ini, i]);
          const fin = src.indexOf('*/', i + 2);
          i = fin === -1 ? src.length : fin + 2;
          ini = i;
          continue;
        }
        if (src.startsWith('<!--', i)) {
          if (i > ini) tramos.push([ini, i]);
          const fin = src.indexOf('-->', i + 4);
          i = fin === -1 ? src.length : fin + 3;
          ini = i;
          continue;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          if (i > ini) tramos.push([ini, i]);
          // saltar la expresión, contando llaves
          let prof = 1;
          i += 2;
          while (i < src.length && prof > 0) {
            if (src[i] === '{') prof++;
            else if (src[i] === '}') prof--;
            i++;
          }
          ini = i;
          continue;
        }
        i++;
      }
      if (i > ini) tramos.push([ini, i]);
      i++;
      continue;
    }
    i++;
  }
  return tramos;
}

const LETRA = 'A-Za-zÁÉÍÓÚÜÑáéíóúüñ';
const RE_PALABRA = new RegExp(`[${LETRA}]+`, 'g');

function conMayuscula(original, reemplazo) {
  if (original[0] === original[0].toUpperCase() && original[0] !== original[0].toLowerCase()) {
    return reemplazo[0].toUpperCase() + reemplazo.slice(1);
  }
  return reemplazo;
}

function lineaDe(src, pos) {
  let n = 1;
  for (let i = 0; i < pos; i++) if (src[i] === '\n') n++;
  return n;
}

function contexto(src, pos, largo) {
  const ini = Math.max(0, pos - 45);
  const fin = Math.min(src.length, pos + largo + 45);
  return src.slice(ini, fin).replace(/\s+/g, ' ').trim();
}

/** ¿La frase exenta cubre a la palabra hallada, o apenas pasa cerca? */
function cubre(re, texto, rel, largo) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = g.exec(texto)) !== null) {
    if (m.index <= rel && m.index + m[0].length >= rel + largo) return true;
    if (m.index === g.lastIndex) g.lastIndex++;
  }
  return false;
}

/** Escanea un archivo y devuelve los hallazgos (sin tocar disco). */
function escanear(abs, src) {
  const esHtml = path.extname(abs) === '.html';
  const hallazgos = [];
  for (const [ini, fin] of tramosTexto(src, esHtml)) {
    const tramo = src.slice(ini, fin);
    let m;
    RE_PALABRA.lastIndex = 0;
    while ((m = RE_PALABRA.exec(tramo)) !== null) {
      const palabra = m[0];
      const clave = palabra.toLowerCase();
      // hasOwnProperty, no indexación directa: "constructor" o "toString" en
      // una cadena resolvían contra Object.prototype y daban un falso positivo
      // que reventaba el reemplazo.
      const seguro = Object.prototype.hasOwnProperty.call(MAPA.SEGURO, clave)
        ? MAPA.SEGURO[clave]
        : undefined;
      const ambiguo = Object.prototype.hasOwnProperty.call(MAPA.AMBIGUO, clave)
        ? MAPA.AMBIGUO[clave]
        : undefined;
      if (!seguro && !ambiguo) continue;
      // "SOS" (la señal del rastreo GPS) y "VOS" (nombre de campo) en
      // mayúsculas no son el pronombre: convertirlos en "Eres"/"Tú" rompería
      // un botón de auxilio. Sólo vale para el pronombre, que tiene 3 letras;
      // un "TENÉS" en mayúsculas sigue siendo voseo.
      const enMayusculas = palabra === palabra.toUpperCase() && palabra !== palabra.toLowerCase();
      if (enMayusculas && Object.prototype.hasOwnProperty.call(MAPA.PRONOMBRE, clave)) continue;
      const pos = ini + m.index;
      // La excepción sólo vale si la palabra está DENTRO de la frase exenta:
      // si no, «¿qué pedí…? usá el historial» perdonaba también el "usá".
      const desde = Math.max(0, pos - 30);
      const alrededor = src.slice(desde, pos + palabra.length + 30);
      const rel = pos - desde;
      if (MAPA.EXCEPCIONES.some((re) => cubre(re, alrededor, rel, palabra.length))) continue;
      hallazgos.push({
        archivo: abs,
        pos,
        linea: lineaDe(src, pos),
        palabra,
        sugerencia: conMayuscula(palabra, seguro || ambiguo),
        clase: seguro ? 'seguro' : 'ambiguo',
        contexto: contexto(src, pos, palabra.length),
      });
    }

    for (const { re, por } of MAPA.FRASES) {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      let f;
      while ((f = g.exec(tramo)) !== null) {
        const pos = ini + f.index;
        hallazgos.push({
          archivo: abs,
          pos,
          linea: lineaDe(src, pos),
          palabra: f[0],
          sugerencia: f[0].replace(new RegExp(re.source, re.flags.replace('g', '')), por),
          clase: 'frase',
          contexto: contexto(src, pos, f[0].length),
        });
      }
    }
  }
  // Un hallazgo de frase y uno de palabra pueden pisarse ("con vos" contra
  // "vos"): gana la frase, que es la que sabe de la preposición.
  const frases = hallazgos.filter((h) => h.clase === 'frase');
  return hallazgos.filter(
    (h) =>
      h.clase === 'frase' ||
      !frases.some((f) => f.pos <= h.pos && f.pos + f.palabra.length >= h.pos + h.palabra.length),
  );
}

function aplicar(src, hallazgos) {
  let salida = src;
  // de atrás hacia adelante: así los offsets anteriores siguen siendo válidos
  for (const h of [...hallazgos].sort((a, b) => b.pos - a.pos)) {
    salida =
      salida.slice(0, h.pos) + h.sugerencia + salida.slice(h.pos + h.palabra.length);
  }
  return salida;
}

function main() {
  const args = process.argv.slice(2);
  const modoAplicar = args.includes('--aplicar');
  const soloAmbiguos = args.includes('--ambiguos');
  const verSelf = args.includes('--self');

  if (verSelf) return self();

  const archivos = [];
  for (const ambito of AMBITOS) listarArchivos(path.join(RAIZ, ambito), archivos);

  const todos = [];
  for (const abs of archivos) {
    const src = fs.readFileSync(abs, 'utf8');
    const h = escanear(abs, src);
    if (h.length) todos.push({ abs, src, hallazgos: h });
  }

  const filtrados = soloAmbiguos
    ? todos
        .map((f) => ({ ...f, hallazgos: f.hallazgos.filter((h) => h.clase === 'ambiguo') }))
        .filter((f) => f.hallazgos.length)
    : todos;

  let total = 0;
  for (const f of filtrados) {
    const rel = path.relative(RAIZ, f.abs).replace(/\\/g, '/');
    for (const h of f.hallazgos) {
      total++;
      console.log(`${rel}:${h.linea}  ${h.palabra} → ${h.sugerencia}`);
      console.log(`    ${h.contexto}`);
    }
  }

  if (modoAplicar && !soloAmbiguos) {
    let archivosTocados = 0;
    for (const f of filtrados) {
      fs.writeFileSync(f.abs, aplicar(f.src, f.hallazgos), 'utf8');
      archivosTocados++;
    }
    console.log(`\nAplicado: ${total} reemplazos en ${archivosTocados} archivos.`);
    return;
  }

  if (soloAmbiguos) {
    console.log(`\n${total} casos de la clase -ir (misma forma que "yo elegí").`);
    return;
  }

  if (total === 0) {
    console.log('check:voseo — sin voseo en texto de interfaz.');
    process.exit(0);
  }
  console.log(`\n✗ check:voseo — ${total} usos de voseo en texto de interfaz.`);
  console.log('  La interfaz le habla de TÚ (es-MX). Corré: node scripts/check-voseo.js --aplicar');
  console.log('  Si la forma es 1ª persona legítima ("recibí tu archivo"), agregala a');
  console.log('  EXCEPCIONES en scripts/voseo-map.js, con el motivo escrito.');
  process.exit(1);
}

/**
 * Prueba negativa: una compuerta sin rojo demostrado es una intención.
 * Arma en memoria un archivo con voseo en una cadena y voseo en un comentario,
 * y exige que vea el primero y NO el segundo.
 */
function self() {
  const casos = [
    {
      nombre: 'cadena con voseo → lo ve',
      archivo: 'x.ts',
      src: `const msg = 'Revisá el corte y confirmá el total';`,
      esperado: ['revisá', 'confirmá'],
    },
    {
      nombre: 'comentario con voseo → NO lo ve',
      archivo: 'x.ts',
      src: `// Revisá el corte antes de confirmá\nconst a = 1;`,
      esperado: [],
    },
    {
      nombre: 'bloque de comentario → NO lo ve',
      archivo: 'x.ts',
      src: `/** Acá elegía el almacén; tenés que mirarlo */\nconst a = 1;`,
      esperado: [],
    },
    {
      nombre: 'template con ${expr} → ve el texto, no la expresión',
      archivo: 'x.ts',
      src: 'const t = `No tenés ${podesCount} pedidos`;',
      esperado: ['tenés'],
    },
    {
      nombre: 'html con voseo → lo ve',
      archivo: 'x.html',
      src: `<p>No tenés entregas pendientes.</p>`,
      esperado: ['tenés'],
    },
    {
      nombre: 'palabra legítima (después/además/estás) → no es voseo',
      archivo: 'x.ts',
      src: `const m = 'Después de además, estás listo; el inglés y el interés';`,
      esperado: [],
    },
    {
      nombre: 'futuro (revisará/enviará) → no es voseo',
      archivo: 'x.ts',
      src: `const m = 'El sistema revisará y enviará el reporte';`,
      esperado: [],
    },
    {
      nombre: 'comentario SQL DENTRO de un template → NO lo ve',
      archivo: 'x.ts',
      src: 'const sql = `SELECT 1 /* la escribí y caí dos veces; revisá esto */ FROM t`;',
      esperado: [],
    },
    {
      nombre: 'comentario HTML dentro de un template → NO lo ve',
      archivo: 'x.ts',
      src: 'const t = `<!-- ¿qué pedí? la vista por lote --><p>Elegí una ruta</p>`;',
      esperado: ['elegí'],
    },
    {
      nombre: '«recibí» en 1ª persona → correcto, no se toca',
      archivo: 'x.ts',
      src: `const m = 'Recibí tu comprobante. No recibí ninguna pregunta.';`,
      esperado: [],
    },
    {
      nombre: 'excepción «qué pedí» → correcto, no se toca',
      archivo: 'x.ts',
      src: `const m = 'Para «¿qué pedí la última vez?» usá el historial';`,
      esperado: ['usá'],
    },
    {
      nombre: 'preposición + vos → "ti", no "tú"',
      archivo: 'x.ts',
      src: `const m = 'Reservado por vos · lo mandamos a vos';`,
      esperado: ['por vos', 'a vos'],
    },
    {
      nombre: 'enclítico (cancelalo/sacale) → lo ve',
      archivo: 'x.ts',
      src: `const m = 'Abre ese vale y cancelalo; sacale foto';`,
      esperado: ['cancelalo', 'sacale'],
    },
    {
      nombre: 'sustantivos homógrafos (bebé, café, pagaré) → no son voseo',
      archivo: 'x.ts',
      src: `const m = 'Puestos: bebé, café, pagaré, mamá, papá';`,
      esperado: [],
    },
    {
      nombre: 'SOS / VOS en mayúsculas → no se tocan',
      archivo: 'x.ts',
      src: `const m = 'Señal SOS del rastreo; campo VOS del archivo';`,
      esperado: [],
    },
    {
      nombre: 'clases CSS (animate-spin, translate-x) → NO las toca',
      archivo: 'x.html',
      src: `<div class="animate-pulse translate-x-2 rotate-45 separate"></div>`,
      esperado: [],
    },
    {
      nombre: 'imperativo -ir (elegí/abrí) → sí lo ve',
      archivo: 'x.ts',
      src: `const m = 'Elegí una sucursal o abrí un conteo';`,
      esperado: ['elegí', 'abrí'],
    },
  ];

  let fallos = 0;
  for (const c of casos) {
    const h = escanear(c.archivo, c.src).map((x) => x.palabra.toLowerCase());
    const ok =
      h.length === c.esperado.length && c.esperado.every((e) => h.includes(e));
    console.log(`${ok ? '✓' : '✗'} ${c.nombre}${ok ? '' : ` — vio [${h}] esperaba [${c.esperado}]`}`);
    if (!ok) fallos++;
  }
  // El rojo también se prueba: un archivo con voseo tiene que producir hallazgos.
  const rojo = escanear('x.ts', `const m = 'Tenés que elegir';`).length > 0;
  console.log(`${rojo ? '✓' : '✗'} la compuerta se pone roja cuando hay voseo`);
  if (!rojo) fallos++;

  if (fallos) {
    console.log(`\n✗ check:voseo --self: ${fallos} fallos.`);
    process.exit(1);
  }
  console.log('\n✓ check:voseo --self: la compuerta ve el texto y NO los comentarios.');
}

module.exports = { escanear, tramosTexto, aplicar };

if (require.main === module) main();
