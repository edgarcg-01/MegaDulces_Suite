/**
 * `[LE.2.8]` El FORMATO del código de orden, sin dependencias: lo carga también la prueba de paridad
 * contra `cashbook._codigo(seq)` (`database/tests/test-newdb-cashbook-ordenes.js`). Si cambia acá,
 * cambia allá: la prueba lo exige.
 */

export const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LARGO = 4;

/**
 * Suma ponderada por posición con pesos primos con 10. Con 32 símbolos y un solo dígito no se puede
 * cazar TODO error de dedo; la prueba mide cuánto caza (≈90 % de las letras cambiadas, ≈80 % de las
 * volteadas) y lo que no caza lo frena que el código no exista como orden vigente.
 */
const PESOS = [3, 7, 9, 1];
export function digitoVerificador(cuerpo: string): number {
  let s = 0;
  for (let i = 0; i < cuerpo.length; i++) {
    const v = ALFABETO.indexOf(cuerpo[i]);
    if (v < 0) throw new Error(`carácter fuera del alfabeto del código: ${cuerpo[i]}`);
    s += (v + 1) * PESOS[i % PESOS.length];
  }
  return s % 10;
}

/**
 * El código número `n` (un consecutivo de la base). Se mezcla con un multiplicador impar módulo
 * 32^4 —una biyección— para que dos órdenes seguidas no se parezcan; dos `n` distintos nunca dan el
 * mismo cuerpo dentro de un ciclo de 1,048,576.
 */
export function armarCodigo(n: number): string {
  const M = ALFABETO.length ** LARGO;
  if (!Number.isInteger(n) || n < 0) throw new Error(`consecutivo inválido para el código: ${n}`);
  let x = (n * 747_353 + 12_345) % M;
  let cuerpo = '';
  for (let i = 0; i < LARGO; i++) { cuerpo = ALFABETO[x % ALFABETO.length] + cuerpo; x = Math.floor(x / ALFABETO.length); }
  return `${cuerpo}-${digitoVerificador(cuerpo)}`;
}

export type LecturaDeCodigo =
  | { ok: true; codigo: string }
  | { ok: false; motivo: 'sin_codigo' }
  | { ok: false; motivo: 'verificador'; leido: string };

const AL_INICIO = /^\s*([a-z2-9]{4})\s*-\s*(\d)(?=\s|$)/i;

/** Lee el código al inicio de la referencia de CAOS. El resto del texto es libre. */
export function leerCodigo(ref: string | null | undefined): LecturaDeCodigo {
  const m = AL_INICIO.exec(ref ?? '');
  if (!m) return { ok: false, motivo: 'sin_codigo' };
  const cuerpo = m[1].toUpperCase();
  if ([...cuerpo].some((c) => !ALFABETO.includes(c))) return { ok: false, motivo: 'sin_codigo' };
  const leido = `${cuerpo}-${m[2]}`;
  if (digitoVerificador(cuerpo) !== Number(m[2])) return { ok: false, motivo: 'verificador', leido };
  return { ok: true, codigo: leido };
}
