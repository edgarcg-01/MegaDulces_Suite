import { fechasCortas } from './fecha-corta';

describe('[RE.75] el inspector usa el formato de fecha de las listas', () => {
  it('una fecha ISO sola', () => {
    expect(fechasCortas('2026-03-31')).toBe('31/03/26');
  });
  it('dentro de un subtítulo, sin tocar el resto', () => {
    expect(fechasCortas('8 Esquinas · 2026-03-31')).toBe('8 Esquinas · 31/03/26');
  });
  it('con hora ISO', () => {
    expect(fechasCortas('2026-10-31T06:00:00.000Z')).toBe('31/10/26');
  });
  it('control: un texto sin fecha no cambia', () => {
    expect(fechasCortas('XD40 · 0000421')).toBe('XD40 · 0000421');
  });
});
