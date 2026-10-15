import { diaCorto } from './dia-corto.contract';

describe('[CGP-L.4] diaCorto — una jornada nombrada igual en la campana y en la pantalla', () => {
  it('YYYY-MM-DD se lee como día-mes', () => {
    expect(diaCorto('2026-10-13')).toBe('13-oct');
    expect(diaCorto('2026-01-05')).toBe('5-ene');
  });

  it('acepta un timestamp ISO y toma sólo el día de calendario', () => {
    expect(diaCorto('2026-10-13T23:30:00.000Z')).toBe('13-oct');
  });

  it('⛔ no pasa por Date: medianoche no se corre al día anterior en México', () => {
    // Con `new Date('2026-10-13')` en TZ America/Mexico_City saldría el 12.
    expect(diaCorto('2026-10-13')).not.toBe('12-oct');
  });

  it('lo que no es fecha se devuelve tal cual: no se inventa un día', () => {
    expect(diaCorto('ayer')).toBe('ayer');
    expect(diaCorto('2026-13-01')).toBe('2026-13-01');
  });
});
