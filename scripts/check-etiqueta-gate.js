#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * ⭐⭐ `[ETQ-FIT.4]` LA COMPUERTA DE LA ETIQUETA SIGUE SIENDO UNA COMPUERTA.
 *
 * La etiqueta de anaquel es **papel**: sale de la impresora, se pega en el mostrador y el cliente
 * le cree. Un renglón cortado ahí no es un defecto visual, es un precio a medio imprimir. Lo
 * único que puede juzgarla es `scripts/etiqueta-geometria.js`, que la renderiza de verdad sobre
 * un corpus congelado de 220 etiquetas reales de prod.
 *
 * Este archivo no mide etiquetas: vigila que **el que mide siga puesto y siga siendo estricto**.
 * Comprueba tres cosas, y las tres se pueden aflojar sin que nada más se entere:
 *
 *   1. El arnés no tiene excepciones declaradas (`CONOCIDOS` vacío).
 *   2. Las DOS corridas —con y sin tipografías— son compuertas de `npm run check`.
 *   3. El modo `--sin-fuentes` existe y no anula el aborto de la corrida normal.
 *
 * ── Por qué acá y no en un `.spec.ts` ────────────────────────────────────────────────────────
 * Estaba escrito como caso de `etiqueta-hoja.spec.ts` y **se medía verde con la comprobación
 * rota**: el spec vive en `apps/view`, lo corre Nx con caché, y un cambio en `scripts/` no
 * invalida esa caché. Verificado: metiendo una excepción a mano, `nx test view` seguía en verde
 * y sólo se ponía rojo con `--skip-nx-cache`. Declarar los archivos en `sharedGlobals` de
 * `nx.json` tampoco alcanzó (probado, y revertido para no dejar una configuración que no hace lo
 * que su comentario dice).
 *
 * Un guardián que puede quedar cacheado sobre una versión vieja del archivo que vigila no
 * guarda nada. Acá es node plano: corre siempre, lee el archivo del disco, no hay caché.
 */
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const ARNES = path.join(RAIZ, 'scripts', 'etiqueta-geometria.js');
const CHECK = path.join(RAIZ, 'scripts', 'check-all.js');

const fallas = [];
const exigir = (cond, msg) => { if (!cond) fallas.push(msg); };

const arnes = fs.readFileSync(ARNES, 'utf8');
const check = fs.readFileSync(CHECK, 'utf8');

/**
 * ⛔ Una entrada en `CONOCIDOS` es decir *"esta etiqueta se imprime mal y lo aceptamos"*, y el
 * efecto es que el arnés sale VERDE con ella rota. Tenía cinco —cuatro nombres de promoción de
 * 60-83 caracteres y un monto de 6 cifras— y las cinco tenían arreglo: el encabezado de dos
 * renglones y el techo del monto calculado desde la caja.
 *
 * Si alguna vez hace falta volver a declarar una, este mensaje es el trámite: hay que poder
 * explicar por qué no tiene arreglo, y editar esta compuerta a propósito.
 */
/**
 * ⚠️ Se pregunta PRIMERO por la forma vacía. Con la alternancia al revés —el cuerpo primero— el
 * `[\s\S]*?` salta el `};` de la misma línea y sigue hasta el siguiente que encuentre en el
 * archivo: la compuerta salía roja con la lista vacía, acusando de "excepción" al código que
 * venía después. Un guardián que no sabe leer lo que vigila es ruido, y al ruido se lo ignora.
 */
const VACIO = /const CONOCIDOS = \{\s*\};/;
if (!VACIO.test(arnes)) {
  const conocidos = /const CONOCIDOS = \{([\s\S]*?)\n\};/.exec(arnes);
  exigir(!!conocidos, 'no se encontró `const CONOCIDOS` en el arnés: cambió de forma y esta compuerta quedó ciega');
  if (conocidos) {
    const cuerpo = conocidos[1].replace(/\/\/[^\n]*/g, '').trim();
    exigir(cuerpo === '', `el arnés declara excepciones y no debería: ${cuerpo.slice(0, 160)}`);
  }
}

// Las DOS corridas. Con una sola, la mitad del riesgo queda sin vigilar: el reporte que abrió
// todo esto ("salen mal en otros equipos") es justamente el escenario sin tipografías.
exigir(/nombre: 'etiqueta'/.test(check), "`npm run check` no corre el arnés de la etiqueta");
exigir(/nombre: 'etiqueta-sin-fuentes'/.test(check), "`npm run check` no corre el arnés SIN tipografías");
exigir(/etiqueta-geometria\.js [^']*--sin-fuentes/.test(check), 'la compuerta sin tipografías no pasa `--sin-fuentes`');

// El modo de peor caso existe, y NO desactiva el aborto de la corrida normal: publicar
// milímetros medidos con la tipografía de respaldo ya fue un defecto real.
exigir(/const SIN_FUENTES = argv\.includes\('--sin-fuentes'\)/.test(arnes), 'el arnés no tiene el modo `--sin-fuentes`');
exigir(/if \(faltan\.length && !SIN_FUENTES\)/.test(arnes),
  'el arnés dejó de abortar cuando faltan tipografías en la corrida normal');

if (fallas.length) {
  console.error('⛔ compuerta de la etiqueta:');
  for (const f of fallas) console.error('   · ' + f);
  process.exit(1);
}
console.log(`✅ compuerta de la etiqueta: sin excepciones declaradas, y las 2 corridas (con y sin tipografías) están en \`npm run check\`.`);
