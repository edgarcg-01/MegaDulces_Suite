import { periodoDelArchivo } from './bancos-shared';

/**
 * `[PGP.97.1]` El periodo de un workbook por el nombre de su archivo. El caso real del 5-nov:
 * «11 NOVIEMBRE.xlsx» subido con octubre seleccionado se fue a octubre y la siguiente subida de
 * octubre lo borró.
 */
describe('[PGP.97.1] periodoDelArchivo', () => {
  const nov7 = new Date(2026, 10, 7);

  it('⛔ mes sin año NO cae al periodo seleccionado: es del año en curso', () => {
    expect(periodoDelArchivo('11 NOVIEMBRE.xlsx', '2026-10', nov7)).toBe('2026-11');
  });
  it('mes con año: ese periodo, aunque haya otro seleccionado', () => {
    expect(periodoDelArchivo('10 OCTUBRE 2026 (27).xlsx', '2026-11', nov7)).toBe('2026-10');
    expect(periodoDelArchivo('estado_septiembre_2026.xlsx', null, nov7)).toBe('2026-09');
  });
  it('un mes que todavía no llega es del año pasado (diciembre subido en enero)', () => {
    expect(periodoDelArchivo('12 DICIEMBRE.xlsx', null, new Date(2027, 0, 5))).toBe('2026-12');
    expect(periodoDelArchivo('01 ENERO.xlsx', null, new Date(2027, 0, 5))).toBe('2027-01');
  });
  it('acentos y minúsculas no estorban', () => {
    expect(periodoDelArchivo('movimientos de octubre.xlsx', null, nov7)).toBe('2026-10');
  });
  it('sin mes en el nombre: el periodo seleccionado, como antes; sin nada, null', () => {
    expect(periodoDelArchivo('bancos (3).xlsx', '2026-10', nov7)).toBe('2026-10');
    expect(periodoDelArchivo('bancos.xlsx', null, nov7)).toBeNull();
  });
  it('cuatro dígitos que no son un año (la cuenta) no se leen como año', () => {
    expect(periodoDelArchivo('OCTUBRE_1463.xlsx', '2026-09', nov7)).toBe('2026-10');
  });
  it('una palabra que CONTIENE un mes no es el mes («MAYOREO» no es mayo)', () => {
    expect(periodoDelArchivo('MAYOREO.xlsx', '2026-10', nov7)).toBe('2026-10');
  });
});
