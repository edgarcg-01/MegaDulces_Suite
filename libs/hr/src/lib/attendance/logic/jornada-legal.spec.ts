import { limitesLegales, semanaContraLey } from './jornada-legal';

/** `[RH.15.10]` La tabla del decreto (DOF 1-may-2026), año por año, y la semana medida contra ella. */
describe('[RH.15.10] jornada y horas extra según la reforma', () => {
  it.each([
    ['2025-12-31', 48, 9], ['2026-11-17', 48, 9], ['2027-01-01', 46, 9], ['2028-06-01', 44, 10],
    ['2029-03-15', 42, 11], ['2030-01-01', 40, 12], ['2035-08-08', 40, 12],
  ])('%s: jornada %i h, extra %i h', (fecha, jornada, extra) => {
    const l = limitesLegales(fecha);
    expect([l.jornadaMaxMin / 60, l.extraMaxMin / 60]).toEqual([jornada, extra]);
  });

  it('dentro de la jornada legal no hay excedente', () => {
    expect(semanaContraLey('2026-11-12', 48 * 60)).toMatchObject({ excedenteMin: 0, triplesMin: 0 });
  });
  it('2026: 55 h → 7 h de más, ninguna al triple (tope 9)', () => {
    expect(semanaContraLey('2026-11-12', 55 * 60)).toMatchObject({ excedenteMin: 420, triplesMin: 0 });
  });
  it('2026: 60 h → 12 h de más, 3 al triple', () => {
    expect(semanaContraLey('2026-11-12', 60 * 60)).toMatchObject({ excedenteMin: 720, triplesMin: 180 });
  });
  it('2027: la misma semana de 50 h ya rebasa la jornada (46 h)', () => {
    expect(semanaContraLey('2027-02-04', 50 * 60)).toMatchObject({ jornadaMaxMin: 46 * 60, excedenteMin: 240, triplesMin: 0 });
  });
  it('la semana que cruza el 1 de enero se mide con el año en que EMPIEZA', () => {
    expect(semanaContraLey('2026-12-31', 47 * 60).jornadaMaxMin).toBe(48 * 60);
  });
});
