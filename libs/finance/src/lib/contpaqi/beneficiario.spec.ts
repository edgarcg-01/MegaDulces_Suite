import { describe, expect, it } from 'vitest';
import { classifyWith, compileRules } from '../bank/finance-bank.service';
import { patronDe, reglaBeneficiario, textoBeneficiario, type ReglaBeneficiario } from './beneficiario';

/**
 * `[CP.8.80]` La regla por beneficiario se prueba con el MOTOR REAL de bancos (`classifyWith`), no con una regex
 * suelta: lo que importa es qué hará el motor al importar el próximo estado de cuenta.
 */
const OSCAR = { raw_type: 'G', raw_code: '613', concept: 'Oscar Hernandez R' };

function regla(m: typeof OSCAR, texto: string): ReglaBeneficiario {
  const r = reglaBeneficiario(m, texto);
  if ('error' in r) throw new Error(r.error);
  return r;
}

/** El motor con la regla sola: `nomina` si la toma, `sin_clasificar` si no. */
function motor(r: ReglaBeneficiario) {
  const c = compileRules([{ priority: 1000, ...r, category_code: 'nomina' }]);
  return (M: string | null, C: string | null, x: string | null): string => classifyWith(c, M, C, x);
}

describe('[CP.8.80] la regla que recuerda a un beneficiario', () => {
  it('«OSCAR HERNANDEZ» toma las tres formas medidas en prod y deja el error de dedo', () => {
    const m = motor(regla(OSCAR, 'Oscar Hernandez'));
    expect(m('G', '613', 'Oscar Hernandez')).toBe('nomina');
    expect(m('G', '613', 'Oscar Hernandez R')).toBe('nomina');
    expect(m('G', '613', 'Oscar Hernandez Rodriguez')).toBe('nomina');
    expect(m('G', '613', 'Oscar Hernnandez Rodriguez')).toBe('sin_clasificar');
  });

  it('⛔ palabra completa: «OSCAR HERNANDEZ R» no captura «OSCAR HERNANDEZ RODRIGUEZ» ni «OSCAR HERNANDEZROMO»', () => {
    const m = motor(regla(OSCAR, 'Oscar Hernandez R'));
    expect(m('G', '613', 'Oscar Hernandez R')).toBe('nomina');
    expect(m('G', '613', 'Oscar Hernandez Rodriguez')).toBe('sin_clasificar');
    expect(motor(regla(OSCAR, 'Oscar Hernandez'))('G', '613', 'Oscar HernandezRomo')).toBe('sin_clasificar');
  });

  it('⛔ empieza con: el nombre a media frase no cuenta («PAGO A OSCAR HERNANDEZ»)', () => {
    expect(motor(regla(OSCAR, 'Oscar Hernandez'))('G', '613', 'PAGO A OSCAR HERNANDEZ')).toBe('sin_clasificar');
  });

  it('acentos y eñes: lo escrito sin acento toma lo que el banco trae con acento, y al revés', () => {
    const m = motor(regla({ raw_type: 'G', raw_code: '613', concept: 'José Peña Núñez' }, 'jose pena nunez'));
    expect(m('G', '613', 'JOSÉ PEÑA NÚÑEZ')).toBe('nomina');
    expect(m('G', '613', 'Jose Pena Nunez')).toBe('nomina');
    expect(textoBeneficiario('  José   Peña ')).toBe('JOSE PENA');
  });

  it('⛔ la regla se ata al TIPO del movimiento: el depósito con el mismo nombre no cae', () => {
    const m = motor(regla(OSCAR, 'Oscar Hernandez'));
    expect(m('I', '102', 'Oscar Hernandez')).toBe('sin_clasificar');
    expect(m('G', '612', 'Oscar Hernandez')).toBe('nomina');   // el código no la ata: 612 y 613 son el mismo beneficiario
  });

  it('el texto en la columna de código (BANORTE, concepto vacío): la regla mira el código', () => {
    const r = regla({ raw_type: 'G', raw_code: 'Valentin Oyanguren', concept: null }, 'Valentin Oyanguren');
    expect(r.match_concept).toBeNull();
    expect(motor(r)('G', 'VALENTIN OYANGUREN', null)).toBe('nomina');
  });

  it('⛔ se niega: muy corto, sólo números, o un texto que el propio movimiento no tiene', () => {
    expect(reglaBeneficiario(OSCAR, 'OSC')).toHaveProperty('error');
    expect(reglaBeneficiario(OSCAR, '613 2026')).toHaveProperty('error');
    expect(reglaBeneficiario(OSCAR, '')).toHaveProperty('error');
    expect(reglaBeneficiario(OSCAR, 'Valentin Oyanguren')).toHaveProperty('error');
  });

  it('⛔ un punto o un asterisco del banco son literales, no comodines', () => {
    expect(patronDe('S.A. DE C.V')).toContain('S\\.[AÁ]\\.');
    const m = motor(regla({ raw_type: 'G', raw_code: '612', concept: 'COMER*CIAL X' }, 'COMER*CIAL X'));
    expect(m('G', '612', 'COMER*CIAL X')).toBe('nomina');
    expect(m('G', '612', 'COMERRRCIAL X')).toBe('sin_clasificar');
  });

  it('sin tipo en el banco, la regla no exige tipo', () => {
    expect(regla({ raw_type: null, raw_code: '613', concept: 'Oscar Hernandez' }, 'Oscar Hernandez').match_type).toBeNull();
  });
});
