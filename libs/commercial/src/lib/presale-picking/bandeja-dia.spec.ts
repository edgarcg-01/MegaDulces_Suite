import { DiaInvalido, diaDeConsulta } from './bandeja-dia';

describe('[MCP.24] el día que pide una bandeja de preventa', () => {
  it('sin fecha es la bandeja viva', () => {
    expect(diaDeConsulta(undefined)).toBeNull();
    expect(diaDeConsulta(null)).toBeNull();
    expect(diaDeConsulta('')).toBeNull();
  });

  it('un día real pasa tal cual', () => {
    expect(diaDeConsulta('2026-11-11')).toBe('2026-11-11');
    expect(diaDeConsulta(' 2024-02-29 ')).toBe('2024-02-29');
  });

  it('⭐ prueba negativa: mal escrito o un día que no existe es error, no «hoy» en silencio', () => {
    for (const malo of ['2026-11-31', '2026-02-29', '11/11/2026', '2026-1-1', 'hoy', '2026-11-11T00:00:00Z']) {
      expect(() => diaDeConsulta(malo), malo).toThrow(DiaInvalido);
    }
  });
});
