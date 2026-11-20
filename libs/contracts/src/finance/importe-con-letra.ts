/**
 * `[PGP.165]` **El importe con letra, una sola vez y bien escrito.** Lo usan el cheque y su póliza (anexo CH) y el
 * anexo de venta, que antes tenía su propia copia privada (ADR-056: un primitivo vive en `libs/`, no en cada módulo).
 *
 * ── Por qué ────────────────────────────────────────────────────────────────────────────────
 * Un cheque cuya cantidad con letra no coincide con la del número **lo rechaza el banco**. La copia del anexo de
 * venta escribía «sesenta y uno mil cuatrocientos setenta y uno pesos» por $61,471 (es «sesenta y **un** mil …
 * setenta y **un** pesos»), «veintiuno mil», «ciento uno mil», «un millón pesos» (falta «de») y «veintidos» sin
 * acento. $61,471.99 fue el importe de un cheque real de mayo de 2026.
 *
 * ── Las reglas ─────────────────────────────────────────────────────────────────────────────
 *  · Entra en **centavos enteros**: nunca un número con decimales binarios. `centavosExactos` convierte el importe
 *    de un cheque y **se niega** a redondear uno con más de dos decimales (el redondeo silencioso es justo el defecto
 *    que devolvía cheques).
 *  · «uno» se apocopa delante de un sustantivo: «un peso», «veintiún pesos», «treinta y un mil», «un millón».
 *  · 1,000 es «mil», no «un mil»; 100 es «cien», 101 «ciento un».
 *  · «de pesos» sólo en millones exactos: «dos millones de pesos», «dos millones un pesos».
 *  · «peso» en singular sólo para 1.
 * Sale en minúsculas con «M.N.»: quien la imprime decide mayúsculas.
 */

const UNIDADES = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
const DE_10_A_29 = [
  'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve',
  'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete',
  'veintiocho', 'veintinueve',
];
const DECENAS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const CENTENAS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos',
  'ochocientos', 'novecientos'];

/** El tope: un billón menos un centavo. Ningún cheque se le acerca; más allá, es un error de captura. */
export const IMPORTE_CON_LETRA_MAXIMO_CENTAVOS = 100_000_000_000_000 - 1;

/** 0..999 con las formas plenas («uno», «veintiuno»): la apócope la hace quien sabe qué sigue. */
function hasta999(n: number): string {
  if (n === 0) return '';
  if (n === 100) return 'cien';
  const c = Math.floor(n / 100);
  const r = n % 100;
  const partes: string[] = [];
  if (c) partes.push(CENTENAS[c]);
  if (r) {
    if (r < 10) partes.push(UNIDADES[r]);
    else if (r < 30) partes.push(DE_10_A_29[r - 10]);
    else partes.push(r % 10 ? `${DECENAS[Math.floor(r / 10)]} y ${UNIDADES[r % 10]}` : DECENAS[Math.floor(r / 10)]);
  }
  return partes.join(' ');
}

/** «uno» al final, delante de un sustantivo (mil, millón, peso): «un»; «veintiuno» → «veintiún». */
function apocopar(s: string): string {
  return s.replace(/veintiuno$/, 'veintiún').replace(/(^|\s)uno$/, '$1un');
}

/** 0..999,999 delante de un sustantivo: «mil», «veintiún mil», «ciento un mil quinientos un». */
function hastaMillon(n: number): string {
  const miles = Math.floor(n / 1000);
  const resto = n % 1000;
  const partes: string[] = [];
  if (miles) partes.push(miles === 1 ? 'mil' : `${apocopar(hasta999(miles))} mil`);
  if (resto) partes.push(hasta999(resto));
  return apocopar(partes.join(' '));
}

/** La parte entera en palabras, lista para ir delante de «peso(s)». */
export function enteroConLetra(entero: number): string {
  if (!Number.isSafeInteger(entero) || entero < 0) throw new RangeError(`entero inválido para la letra: ${entero}`);
  if (entero === 0) return 'cero';
  const millones = Math.floor(entero / 1_000_000);
  const resto = entero % 1_000_000;
  const partes: string[] = [];
  if (millones) partes.push(millones === 1 ? 'un millón' : `${hastaMillon(millones)} millones`);
  if (resto) partes.push(hastaMillon(resto));
  return partes.join(' ');
}

/**
 * `ciento siete mil cuatrocientos cuarenta y seis pesos 93/100 M.N.` a partir de **centavos enteros**.
 * ⛔ Lanza con un número que no es entero, negativo o por encima del tope: un cheque no se escribe con un importe dudoso.
 */
export function importeConLetra(centavos: number): string {
  if (!Number.isSafeInteger(centavos) || centavos < 0 || centavos > IMPORTE_CON_LETRA_MAXIMO_CENTAVOS) {
    throw new RangeError(`importe inválido para la letra (se esperan centavos enteros): ${centavos}`);
  }
  const entero = Math.floor(centavos / 100);
  const cent = centavos % 100;
  const millonesExactos = entero >= 1_000_000 && entero % 1_000_000 === 0;
  const moneda = entero === 1 ? 'peso' : 'pesos';
  return `${enteroConLetra(entero)} ${millonesExactos ? 'de ' : ''}${moneda} ${String(cent).padStart(2, '0')}/100 M.N.`;
}

/**
 * El importe de un cheque en centavos, **sin redondear nunca**. Acepta el texto de un `numeric` de Postgres
 * (`'107446.93'`, `'5.5'`, `'12'`) o un número cuyo valor ya es de dos decimales. ⛔ Lanza con un tercer decimal
 * distinto de cero (`'61471.785'`): ése es el centavo que se perdía en la calculadora y devolvía el cheque.
 */
export function centavosExactos(valor: string | number): number {
  const texto = typeof valor === 'number' ? String(valor) : String(valor ?? '').trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(texto);
  if (!m) throw new RangeError(`importe ilegible para un cheque: «${valor}»`);
  const dec = m[2] ?? '';
  if (/[1-9]/.test(dec.slice(2))) throw new RangeError(`el importe ${texto} tiene más de dos decimales: un cheque no se redondea en silencio`);
  const cent = Number(m[1]) * 100 + Number((dec + '00').slice(0, 2));
  if (!Number.isSafeInteger(cent)) throw new RangeError(`importe fuera de rango para un cheque: «${valor}»`);
  return cent;
}
