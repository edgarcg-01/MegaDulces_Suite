import {
  digitoVerificadorCurp, digitoVerificadorRfc, normalizarClaveFiscal, rfcYCurpCoinciden, validarCurp, validarRfc,
} from './identidad-fiscal';

/**
 * `[ALC.1.2]` Anclas PÚBLICAS (ninguna es de un cliente): `EKU9003173C9` y `CACX7605101P8` son RFC
 * de pruebas del SAT; `HEGG560427MVZRRL04` es la CURP de ejemplo del instructivo de RENAPO. Las
 * constancias reales con que se verificó el algoritmo no se versionan (datos personales).
 */
describe('validarRfc', () => {
  it('acepta los RFC de prueba del SAT, de persona moral y física', () => {
    expect(validarRfc('EKU9003173C9')).toEqual({ ok: true, rfc: 'EKU9003173C9', tipo: 'moral', generico: false });
    expect(validarRfc('CACX7605101P8')).toEqual({ ok: true, rfc: 'CACX7605101P8', tipo: 'fisica', generico: false });
  });

  it('normaliza minúsculas, espacios y guiones antes de validar', () => {
    expect(normalizarClaveFiscal(' eku-900317 3c9 ')).toBe('EKU9003173C9');
    expect(validarRfc('eku 900317-3c9').ok).toBe(true);
  });

  it('el genérico es válido y se marca como genérico', () => {
    expect(validarRfc('XAXX010101000')).toEqual({ ok: true, rfc: 'XAXX010101000', tipo: 'fisica', generico: true });
    expect(validarRfc('XEXX010101000').ok).toBe(true);
  });

  it('caza un carácter cambiado con el dígito verificador y dice cuál esperaba', () => {
    const r = validarRfc('EKU9003173C8');
    expect(r).toMatchObject({ ok: false, motivo: 'verificador', verificador_esperado: '9' });
    expect(digitoVerificadorRfc('EKU9003173C')).toBe('9');
    expect(digitoVerificadorRfc('CACX7605101P')).toBe('8');
  });

  it('caza casi todos los cambios de UN carácter de la homoclave', () => {
    const base = 'EKU9003173C9';
    let cambios = 0, cazados = 0;
    for (const i of [9, 10]) {
      for (const ch of '0123456789ABCDEFGHIJKLMNPQRSTUVWXYZ') {
        if (ch === base[i]) continue;
        cambios++;
        if (!validarRfc(base.slice(0, i) + ch + base.slice(i + 1)).ok) cazados++;
      }
    }
    expect(cazados / cambios).toBeGreaterThan(0.85);
  });

  it('rechaza una fecha imposible, el largo equivocado y el vacío', () => {
    expect(validarRfc('EKU9013173C9')).toMatchObject({ ok: false, motivo: 'fecha' }); // mes 13
    expect(validarRfc('EKU900230')).toMatchObject({ ok: false, motivo: 'formato' });
    expect(validarRfc('EKU9002303C9X')).toMatchObject({ ok: false, motivo: 'formato' }); // moral con 13
    expect(validarRfc('')).toMatchObject({ ok: false, motivo: 'vacio' });
    expect(validarRfc(null)).toMatchObject({ ok: false, motivo: 'vacio' });
  });

  it('el 29 de febrero sólo existe en año bisiesto (se acepta si lo es en 19xx o 20xx)', () => {
    expect(validarRfc(`EKU000229${'3C'}${digitoVerificadorRfc('EKU0002293C')}`).ok).toBe(true); // 2000
    expect(validarRfc(`EKU010229${'3C'}${digitoVerificadorRfc('EKU0102293C')}`)).toMatchObject({ ok: false, motivo: 'fecha' });
  });
});

describe('validarCurp', () => {
  it('acepta la CURP de ejemplo de RENAPO', () => {
    expect(validarCurp('HEGG560427MVZRRL04')).toEqual({ ok: true, curp: 'HEGG560427MVZRRL04' });
    expect(digitoVerificadorCurp('HEGG560427MVZRRL0')).toBe('4');
  });

  it('caza el verificador, la entidad y la fecha', () => {
    expect(validarCurp('HEGG560427MVZRRL05')).toMatchObject({ ok: false, motivo: 'verificador' });
    expect(validarCurp('HEGG560427MXXRRL04')).toMatchObject({ ok: false, motivo: 'entidad' });
    expect(validarCurp('HEGG561327MVZRRL04')).toMatchObject({ ok: false, motivo: 'fecha' });
    expect(validarCurp('HEGG560427MVZRRL0')).toMatchObject({ ok: false, motivo: 'formato' });
  });
});

describe('rfcYCurpCoinciden', () => {
  it('compara los 10 primeros caracteres de persona física', () => {
    expect(rfcYCurpCoinciden('HEGG560427AB1', 'HEGG560427MVZRRL04')).toBe(true);
    expect(rfcYCurpCoinciden('HEGG560428AB1', 'HEGG560427MVZRRL04')).toBe(false);
    expect(rfcYCurpCoinciden('EKU9003173C9', 'HEGG560427MVZRRL04')).toBe(false); // moral: nunca
  });
});
