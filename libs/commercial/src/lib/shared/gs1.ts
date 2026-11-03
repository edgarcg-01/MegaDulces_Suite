/**
 * `[NP.7.1.3]` Dígito verificador GS1 (EAN-8, UPC-A, EAN-13, DUN-14). En el repo no había ninguno:
 * el `digitoVerificador` de `cashbook/codigo-formato.ts` es otro algoritmo (códigos de orden LE.2.8).
 *
 * Sólo aplica a lo que tiene forma GS1 (8, 12, 13 o 14 dígitos). Una clave interna de Kepler (`C`+clave,
 * `CB23…`) o la propia clave del SKU (5 dígitos) no es GS1: ni válida ni inválida, simplemente otra cosa.
 */

export function esFormaGs1(codigo: string): boolean {
  return /^(\d{8}|\d{12,14})$/.test(String(codigo ?? '').trim());
}

/** El dígito que corresponde a los dígitos dados (sin el verificador). */
export function digitoGs1(sinVerificador: string): number {
  let suma = 0;
  // De derecha a izquierda: el dígito pegado al verificador pesa 3, el siguiente 1, y así.
  for (let i = sinVerificador.length - 1, peso = 3; i >= 0; i--, peso = peso === 3 ? 1 : 3) {
    suma += Number(sinVerificador[i]) * peso;
  }
  return (10 - (suma % 10)) % 10;
}

/** true si tiene forma GS1 y su último dígito es el verificador correcto. */
export function gs1Valido(codigo: string): boolean {
  const c = String(codigo ?? '').trim();
  if (!esFormaGs1(c)) return false;
  return digitoGs1(c.slice(0, -1)) === Number(c[c.length - 1]);
}
