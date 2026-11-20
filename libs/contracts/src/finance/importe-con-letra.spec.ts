/**
 * `[PGP.165]` El importe con letra del cheque. Vectores SINTÉTICOS (el repo es público) con la FORMA de los errores
 * medidos el 2026-11-19 en la copia del anexo de venta: «… y uno mil», «veintiuno mil», «ciento uno mil», «un millón
 * pesos», «veintidos».
 */
import { IMPORTE_CON_LETRA_MAXIMO_CENTAVOS, centavosExactos, enteroConLetra, importeConLetra } from './importe-con-letra';

describe('[PGP.165] importeConLetra', () => {
  it('«uno» se apocopa delante de mil, millón y peso', () => {
    expect(importeConLetra(6_147_199)).toBe('sesenta y un mil cuatrocientos setenta y un pesos 99/100 M.N.');
    expect(importeConLetra(2_100_000)).toBe('veintiún mil pesos 00/100 M.N.');
    expect(importeConLetra(3_100_000)).toBe('treinta y un mil pesos 00/100 M.N.');
    expect(importeConLetra(10_100_000)).toBe('ciento un mil pesos 00/100 M.N.');
    expect(importeConLetra(2_100)).toBe('veintiún pesos 00/100 M.N.');
    expect(importeConLetra(100)).toBe('un peso 00/100 M.N.');
    expect(importeConLetra(2_100_000_000)).toBe('veintiún millones de pesos 00/100 M.N.');
  });

  it('mil, cien y ciento', () => {
    expect(importeConLetra(100_000)).toBe('mil pesos 00/100 M.N.');
    expect(importeConLetra(100_100)).toBe('mil un pesos 00/100 M.N.');
    expect(importeConLetra(10_000)).toBe('cien pesos 00/100 M.N.');
    expect(importeConLetra(10_100)).toBe('ciento un pesos 00/100 M.N.');
    expect(importeConLetra(10_000_000)).toBe('cien mil pesos 00/100 M.N.');
    expect(importeConLetra(110_000)).toBe('mil cien pesos 00/100 M.N.');
    expect(importeConLetra(50_150_000)).toBe('quinientos un mil quinientos pesos 00/100 M.N.');
  });

  it('«de pesos» sólo en millones exactos; «un millón» sin «uno»', () => {
    expect(importeConLetra(100_000_000)).toBe('un millón de pesos 00/100 M.N.');
    expect(importeConLetra(200_000_000)).toBe('dos millones de pesos 00/100 M.N.');
    expect(importeConLetra(200_000_100)).toBe('dos millones un pesos 00/100 M.N.');
    expect(importeConLetra(150_000_000)).toBe('un millón quinientos mil pesos 00/100 M.N.');
    expect(importeConLetra(100_000_000_000)).toBe('mil millones de pesos 00/100 M.N.');
  });

  it('acentos de veintidós, veintitrés, veintiséis y dieciséis', () => {
    expect(importeConLetra(2_200)).toBe('veintidós pesos 00/100 M.N.');
    expect(importeConLetra(2_300)).toBe('veintitrés pesos 00/100 M.N.');
    expect(importeConLetra(2_600)).toBe('veintiséis pesos 00/100 M.N.');
    expect(importeConLetra(1_600)).toBe('dieciséis pesos 00/100 M.N.');
  });

  it('un importe con centavos, en la forma de un cheque de noviembre', () => {
    expect(importeConLetra(10_744_693)).toBe('ciento siete mil cuatrocientos cuarenta y seis pesos 93/100 M.N.');
    expect(importeConLetra(42_855_461)).toBe('cuatrocientos veintiocho mil quinientos cincuenta y cuatro pesos 61/100 M.N.');
    expect(importeConLetra(5)).toBe('cero pesos 05/100 M.N.');
    expect(importeConLetra(0)).toBe('cero pesos 00/100 M.N.');
  });

  it('en ningún importe de 0 a 2,000,000 de pesos queda «uno» delante de un sustantivo ni «veintiuno»', () => {
    // barrido de la parte entera: cada miles y cada unidad hasta 2,000 y saltos hasta 2,000,000
    const malos: string[] = [];
    const revisar = (entero: number) => {
      const t = importeConLetra(entero * 100);
      if (/\buno (mil|millón|millones|pesos?)\b|veintiuno\b|^un mil\b|millón pesos|millones pesos/.test(t)) malos.push(`${entero}: ${t}`);
    };
    for (let n = 0; n <= 2_000; n++) revisar(n);
    for (let n = 2_000; n <= 2_000_000; n += 997) revisar(n);
    expect(malos).toEqual([]);
  });

  it('⛔ no escribe un importe dudoso: no entero, negativo o fuera de rango', () => {
    expect(() => importeConLetra(10.5)).toThrow(RangeError);
    expect(() => importeConLetra(-1)).toThrow(RangeError);
    expect(() => importeConLetra(Number.NaN)).toThrow(RangeError);
    expect(() => importeConLetra(IMPORTE_CON_LETRA_MAXIMO_CENTAVOS + 1)).toThrow(RangeError);
    expect(() => enteroConLetra(1.5)).toThrow(RangeError);
  });
});

describe('[PGP.165] centavosExactos', () => {
  it('lee el texto de un numeric y un número de dos decimales sin pasar por flotantes', () => {
    expect(centavosExactos('107446.93')).toBe(10_744_693);
    expect(centavosExactos('5.5')).toBe(550);
    expect(centavosExactos('12')).toBe(1_200);
    expect(centavosExactos('61471.990000')).toBe(6_147_199);
    expect(centavosExactos(242869.77)).toBe(24_286_977);
    expect(centavosExactos(0.07)).toBe(7);
  });

  it('⛔ se niega a redondear un tercer decimal: ése es el centavo de la calculadora', () => {
    expect(() => centavosExactos('61471.785')).toThrow(/más de dos decimales/);
    expect(() => centavosExactos(1.005)).toThrow(/más de dos decimales/);
  });

  it('⛔ texto ilegible o negativo no es un importe', () => {
    expect(() => centavosExactos('')).toThrow(RangeError);
    expect(() => centavosExactos('1,234.00')).toThrow(RangeError);
    expect(() => centavosExactos('-5.00')).toThrow(RangeError);
  });
});
