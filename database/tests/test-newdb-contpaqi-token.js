/**
 * `[CP.8.6]` — Candado del token de correlación. Carga el `.ts` REAL vía ts-node.
 *
 * El token es la llave del puente: cuando el carril de vuelta trae una póliza de ContPAQi, esto
 * es lo que dice cuál de nuestros eventos la originó. Lo que este candado defiende:
 *
 *  1. **Determinista**: el mismo evento da el mismo token, siempre. Con uno aleatorio, re-emitir
 *     dejaría huérfana la entrega anterior — parecería perdida estando asentada.
 *  2. **Sin colisiones medibles** sobre el universo REAL (55,369 movimientos bancarios), y la
 *     prueba corre el cálculo de verdad en vez de citar un número.
 *  3. **No se recorta**: un token a medias no casa con nada y deja el evento entregado y para
 *     siempre sin verificar — que se ve igual que uno que todavía no llega.
 *
 * Sin base de datos: lógica pura.
 */
'use strict';

const path = require('path');

require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: {
    module: 'commonjs', target: 'es2020', esModuleInterop: true,
    moduleResolution: 'node', ignoreDeprecations: '6.0',
  },
});

const SRC = path.resolve(__dirname, '..', '..', 'libs', 'finance', 'src', 'lib', 'contpaqi');
const { tokenDe, extraerToken, conceptoConToken, PREFIJO, LARGO_HEX, LARGO_TOKEN } =
  require(path.join(SRC, 'token.ts'));

let ok = 0;
let fail = 0;
const check = (cond, label) => {
  if (cond) { ok++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
};
const lanza = (fn, label) => {
  try { fn(); fail++; console.log(`  ✗ ${label} — NO lanzó`); }
  catch { ok++; console.log(`  ✓ ${label}`); }
};

(async () => {
  console.log('\n[1] Forma');
  const t = tokenDe('bank_movement', 'cb-2026-03-01-0042');
  check(t.startsWith(PREFIJO), `arranca con "${PREFIJO}"`);
  check(t.length === LARGO_TOKEN, `mide ${LARGO_TOKEN} (${PREFIJO.length} + ${LARGO_HEX} hex)`);
  check(/^MD:[0-9A-F]+$/.test(t), 'sólo hex en mayúsculas — sin ambigüedad de caja');
  check(LARGO_TOKEN + 1 < 100, 'entra en los 100 chars del concepto y deja sitio a la descripción');

  console.log('\n[2] ⭐ Determinista — la razón de que no sea aleatorio');
  check(tokenDe('bank_movement', 'cb-1') === tokenDe('bank_movement', 'cb-1'),
    'el mismo evento da el mismo token');
  check(tokenDe('bank_movement', 'cb-1') !== tokenDe('bank_movement', 'cb-2'),
    'eventos distintos dan tokens distintos');
  check(tokenDe('bank_movement', 'cb-1') !== tokenDe('supplier_payment', 'cb-1'),
    'el TIPO también cuenta: el mismo id en otro flujo es otro evento');
  // El separador existe por esto: sin él, ('a','bc') y ('ab','c') colisionarían por construcción.
  check(tokenDe('a', 'bc') !== tokenDe('ab', 'c'),
    '⭐ el separador evita que concatenar vuelva iguales a dos eventos distintos');

  console.log('\n[3] ⭐ Colisiones — medidas, no citadas');
  // El universo REAL: finance.bank_movements tiene 55,369 filas (medido 2026-10-09).
  const UNIVERSO = 55369;
  const vistos = new Set();
  let choques = 0;
  for (let i = 0; i < UNIVERSO; i++) {
    const tk = tokenDe('bank_movement', `evt-${i}`);
    if (vistos.has(tk)) choques++;
    vistos.add(tk);
  }
  check(choques === 0, `0 colisiones generando el universo real completo (${UNIVERSO.toLocaleString('en-US')} tokens) — hubo ${choques}`);
  // ⛔ La prueba NEGATIVA va por la MATEMÁTICA, no por una muestra — y eso lo enseñó una
  // mutación. La versión anterior contaba colisiones de 8 hex sobre este universo y exigía > 0.
  // Pasaba porque este hash dio exactamente 1, pero el valor ESPERADO es 0.357: con otras
  // entradas da 0 y la prueba se pone roja sin que nada esté mal. Una aserción que depende de
  // la suerte del hash no guarda nada.
  //
  // La cota del cumpleaños sí es determinista: colisiones esperadas ≈ n²/2N.
  const esperadas = (hex) => (UNIVERSO * UNIVERSO) / (2 * Math.pow(16, hex));
  const e8 = esperadas(8);
  const e12 = esperadas(LARGO_HEX);
  console.log(`      colisiones esperadas sobre ${UNIVERSO.toLocaleString('en-US')}: 8 hex = ${e8.toFixed(3)} · ${LARGO_HEX} hex = ${e12.toFixed(6)}`);
  check(e8 > 0.3, `⛔ con 8 hex (el valor mal razonado) se esperan ${e8.toFixed(3)} colisiones — inaceptable`);
  check(e12 < 0.001, `con ${LARGO_HEX} hex se esperan ${e12.toFixed(6)} — despreciable`);
  check(e8 / e12 > 100, `⭐ los 4 hex de más dividen el riesgo por ${Math.round(e8 / e12).toLocaleString('en-US')}`);
  // Y el universo ×10, que es donde 10 hex tampoco alcanzaba.
  const e12x10 = (UNIVERSO * 10) ** 2 / (2 * Math.pow(16, LARGO_HEX));
  check(e12x10 < 0.01, `aguanta el universo ×10: ${e12x10.toFixed(4)} colisiones esperadas`);

  console.log('\n[4] Extraer el token de lo que volvió de ContPAQi');
  check(extraerToken(`${t} PAGO TRASLADO DE EFECTIVO`) === t, 'lo encuentra adelante (como lo escribimos)');
  check(extraerToken(`PAGO TRASLADO ${t}`) === t, 'lo encuentra atrás (si alguien editó el concepto)');
  check(extraerToken('PAGO TRASLADO DE EFECTIVO') === null, '⭐ sin token devuelve null, NO cadena vacía');
  check(extraerToken(null) === null && extraerToken('') === null, 'tolera null y vacío');
  check(extraerToken(`${t.slice(0, -3)} PAGO`) === null,
    '⭐ un token A MEDIAS no se acepta — casaría con otro evento o con ninguno');
  check(extraerToken(t.toLowerCase()) === t, 'no se pierde si ContPAQi cambia la caja');

  console.log('\n[5] Armar el concepto');
  const c = conceptoConToken(t, 'PAGO TRASLADO DE EFECTIVO');
  check(c.startsWith(t) && c.includes('PAGO TRASLADO'), 'token adelante, descripción después');
  check(c.length <= 100, 'entra en el ancho del campo');
  check(extraerToken(c) === t, 'round-trip: lo que se arma se puede volver a extraer');
  const largo = conceptoConToken(t, 'X'.repeat(300));
  check(largo.length === 100, 'una descripción enorme se recorta al ancho');
  check(extraerToken(largo) === t, '⭐ y se recorta la DESCRIPCIÓN, nunca el token');
  check(conceptoConToken(t, '') === t, 'sin descripción queda sólo el token, sin espacio colgando');
  lanza(() => conceptoConToken(t, 'x', 5), 'si el token no entra en el ancho, FALLA en vez de recortarlo');

  console.log('\n[6] Pruebas negativas de identidad');
  lanza(() => tokenDe('', 'id'), 'sin tipo de evento no hay token');
  lanza(() => tokenDe('tipo', ''), 'sin id de evento no hay token');
  lanza(() => tokenDe('tipo', '   '), 'un id en blanco no es un id');

  console.log(`\n${fail === 0 ? '✅' : '❌'} CP.8.6 token de correlación: ${ok} ✓ / ${fail} ✗\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  fail++;
  console.log(`  ✗ excepción no esperada: ${e && e.message}`);
  console.log(`\n❌ CP.8.6 token de correlación: ${ok} ✓ / ${fail} ✗\n`);
  process.exit(1);
});
