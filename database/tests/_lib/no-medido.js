/* eslint-disable no-console */
/**
 * [VP.5.1] El tercer estado de una suite: **NO MEDIDO**.
 *
 * ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────
 * `run-all-tests.js` tenía dos resultados —✅ y ❌— y el resumen decía "N/M suites verde". Con eso,
 * una suite que **no pudo ni conectarse** se reporta idéntica a una que encontró una regresión real.
 * Son problemas opuestos: una pide arreglar el entorno, la otra arreglar el código. Colapsarlos tiene
 * dos costos, los dos ya vividos en este repo:
 *
 *   · el rojo permanente que nadie va a atender **enseña a ignorar el tablero** (OBS.8: por eso se
 *     borraron los latidos muertos del CDC en vez de dejarlos en crítico);
 *   · y al revés, un test que se rinde en silencio pasa **verde sin medir nada** (el patrón
 *     "skip-graceful" de las suites de banco/ContPAQi, que pasan justo en el entorno sin datos donde
 *     alguien las correría).
 *
 * Es la misma regla que ADR-056 aplica al dato y a la cobertura, aplicada al harness: **lo que no se
 * pudo medir se declara**. No se cuenta como éxito, no tumba la corrida, y aparece con su motivo.
 *
 * ── CONTRATO ─────────────────────────────────────────────────────────────────────────────
 *   exit 0 → pasó · exit 1 → FALLÓ (regresión) · exit 2 → NO MEDIDO (no había con qué comprobar)
 *
 * `exit 2` es opt-in: las ~150 suites que ya existen conservan la semántica 0/1 sin tocarlas.
 */

/** Códigos de error de `pg` que significan "no pude llegar a los datos", no "los datos están mal". */
const SIN_ACCESO = new Set([
  '28P01', // contraseña inválida
  '28000', // autorización inválida
  '3D000', // la base no existe
  '57P03', // la base está arrancando
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
]);

/** ¿este error es de acceso al entorno (NO MEDIDO) y no un defecto del código bajo prueba? */
function esFaltaDeAcceso(e) {
  if (!e) return false;
  return SIN_ACCESO.has(e.code) || /password|autentif|authentication|ECONNREFUSED|getaddrinfo/i.test(e.message || '');
}

/**
 * Termina el proceso declarando NO MEDIDO. Usar cuando falte el entorno, NUNCA para tapar una
 * aserción que no cuadró: eso es una falla y va con exit 1.
 */
function noMedido(motivo) {
  console.log(`\n  ⓘ NO MEDIDO — ${motivo}`);
  console.log('  (no es "pasó": es que en este destino no había con qué comprobarlo)\n');
  process.exit(2);
}

/**
 * Envuelve el arranque de una suite: si el fallo es de ACCESO se declara NO MEDIDO (exit 2); si es
 * cualquier otra cosa, se re-lanza para que siga siendo una falla de verdad (exit 1).
 */
async function correr(fn) {
  try {
    await fn();
  } catch (e) {
    if (esFaltaDeAcceso(e)) noMedido(`no se pudo llegar a la base — ${e.message}`);
    throw e;
  }
}

module.exports = { noMedido, esFaltaDeAcceso, correr, SIN_ACCESO };
