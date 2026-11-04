import { fechaDeCalendario } from './fecha-de-calendario';

describe('fechaDeCalendario', () => {
  it('⭐ el caso real: «2024-04-31» no existe → null (antes tumbaba el INSERT de la factura)', () => {
    expect(fechaDeCalendario('2024-04-31')).toBeNull();
  });

  it('una fecha real pasa tal cual, y se queda sólo con el día si trae hora', () => {
    expect(fechaDeCalendario('2024-04-30')).toBe('2024-04-30');
    expect(fechaDeCalendario('2026-10-31T00:00:00')).toBe('2026-10-31');
    expect(fechaDeCalendario(' 2026-01-05 ')).toBe('2026-01-05');
  });

  it('bisiesto: 29 de febrero sólo en año bisiesto', () => {
    expect(fechaDeCalendario('2024-02-29')).toBe('2024-02-29');
    expect(fechaDeCalendario('2026-02-29')).toBeNull();
    expect(fechaDeCalendario('2026-02-30')).toBeNull();
  });

  it('lo que no es fecha AAAA-MM-DD → null, no se adivina', () => {
    for (const v of ['2026-13-01', '2026-00-10', '2026-10-00', '31/10/2026', '', 'sin fecha', null, undefined, 20261031]) {
      expect(fechaDeCalendario(v)).toBeNull();
    }
  });
});
