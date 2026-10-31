import { ligarPorCaptura, llaveTurnoFechado, type ConteoFechado, type TurnoFechado } from './ligar-conteos';

/**
 * `[CSU.16]` El folio de la captura manda sólo si la captura cae DENTRO de su turno.
 *
 * Casos REALES (medidos en prod el 2026-10-30):
 *  · La Piedad Abastos, Caja 3, turno 407 (30-oct, 06:25 a 14:52): 4 retiros y el cierre, todos con
 *    su folio y dentro del turno → se ligan por folio.
 *  · Padre Hidalgo, Caja 2, 25-oct: 10C02 capturó 8 retiros ($95,000) con el folio 117, que es del
 *    24-oct (16:20 a 20:53). Lo retirado del turno 118 de ese día es $95,000. El folio miente.
 *  · Padre Hidalgo, Caja 1, 24-oct: retiros con el folio 111, que Kepler fecha el 17-oct.
 */
const turno = (folio: string, fecha: string, apertura: string, cierre: string | null, caja = '1', sucursal = '01', fecha_cierre: string | null = cierre ? fecha : null): TurnoFechado =>
  ({ sucursal, caja, folio, fecha, fecha_cierre, hora_apertura: apertura, hora_cierre: cierre });
const conteo = (id: string, tipo: string, folio: string | null, fecha_captura: string, hora: string, caja = '1', sucursal = '01'): ConteoFechado =>
  ({ id, tipo, caja, sucursal, cash_cut_folio: folio, fecha_captura, hora });

describe('[CSU.16] ligarPorCaptura', () => {
  it('⭐ caso real 3-407: retiros y cierre con su folio, dentro del turno → por folio', () => {
    const t = turno('407', '2026-10-30', '06:25:00', '14:52:49', '3', '02');
    const { porTurno, sinTurno } = ligarPorCaptura([t], [
      conteo('r1', 'retiro', '407', '2026-10-30', '10:04:22', '3', '02'),
      conteo('c1', 'cierre', '407', '2026-10-30', '14:56:04', '3', '02'),
    ]);
    expect(porTurno.get(llaveTurnoFechado(t))!.map((x) => [x.id, x.ligado])).toEqual([['r1', 'folio'], ['c1', 'folio']]);
    expect(sinTurno).toEqual([]);
  });

  it('⛔ NEGATIVA (caso real): el retiro del 25-oct con el folio del 24 NO va al turno 117 ni se reasigna', () => {
    const t117 = turno('117', '2026-10-24', '16:20:13', '20:53:25', '2');
    const t118 = turno('118', '2026-10-25', '07:28:29', '16:23:22', '2');
    const { porTurno, sinTurno } = ligarPorCaptura([t117, t118], [conteo('r1', 'retiro', '117', '2026-10-25', '09:50:00', '2')]);
    expect(porTurno.get(llaveTurnoFechado(t117))).toEqual([]);
    expect(porTurno.get(llaveTurnoFechado(t118))).toEqual([]);
    expect(sinTurno).toEqual([expect.objectContaining({ id: 'r1', motivo: 'folio_de_otro_turno' })]);
  });

  it('⛔ NEGATIVA: un folio de hace una semana tampoco, aunque el turno siga en la lista', () => {
    const t111 = turno('111', '2026-10-17', '07:38:40', '18:16:50');
    const { porTurno, sinTurno } = ligarPorCaptura([t111], [conteo('r1', 'retiro', '111', '2026-10-24', '09:12:00')]);
    expect(porTurno.get(llaveTurnoFechado(t111))).toEqual([]);
    expect(sinTurno.map((c) => c.motivo)).toEqual(['folio_de_otro_turno']);
  });

  it('el cierre contado pasada la medianoche sigue en su turno por folio (entra en la gracia)', () => {
    const t = turno('50', '2026-10-24', '16:00:00', '23:50:00');
    const { porTurno } = ligarPorCaptura([t], [conteo('c1', 'cierre', '50', '2026-10-25', '00:30:00')]);
    expect(porTurno.get(llaveTurnoFechado(t))).toEqual([expect.objectContaining({ ligado: 'folio' })]);
  });

  it('NEGATIVA: un cierre contado después de la gracia no se queda con el turno', () => {
    const t = turno('50', '2026-10-24', '16:00:00', '20:00:00');
    const { sinTurno } = ligarPorCaptura([t], [conteo('c1', 'cierre', '50', '2026-10-24', '23:30:00')]);
    expect(sinTurno).toHaveLength(1);
  });

  it('un turno que sigue abierto acepta su folio el mismo día', () => {
    const t = turno('119', '2026-10-24', '16:00:00', null);
    const { porTurno } = ligarPorCaptura([t], [conteo('r1', 'retiro', '119', '2026-10-24', '18:00:00')]);
    expect(porTurno.get(llaveTurnoFechado(t))).toEqual([expect.objectContaining({ ligado: 'folio' })]);
  });

  it('NEGATIVA: el mismo folio en otra caja u otra sucursal no liga', () => {
    const otraCaja = turno('118', '2026-10-24', '07:00:00', '15:00:00', '2');
    const otraSuc = turno('118', '2026-10-24', '07:00:00', '15:00:00', '1', '03');
    const { porTurno, sinTurno } = ligarPorCaptura([otraCaja, otraSuc], [conteo('r1', 'retiro', '118', '2026-10-24', '09:00:00')]);
    expect(porTurno.get(llaveTurnoFechado(otraCaja))).toEqual([]);
    expect(porTurno.get(llaveTurnoFechado(otraSuc))).toEqual([]);
    expect(sinTurno).toHaveLength(1);
  });

  it('sin folio se liga por caja + hora entre los turnos de su día', () => {
    const manana = turno('118', '2026-10-24', '07:20:49', '15:41:54');
    const tarde = turno('119', '2026-10-24', '16:00:00', null);
    const { porTurno } = ligarPorCaptura([manana, tarde], [conteo('r1', 'retiro', null, '2026-10-24', '17:30:00')]);
    expect(porTurno.get(llaveTurnoFechado(tarde))).toEqual([expect.objectContaining({ ligado: 'hora' })]);
    expect(porTurno.get(llaveTurnoFechado(manana))).toEqual([]);
  });

  it('sin folio y sin turno a esa hora vuelve sin ligar, con su motivo', () => {
    const { sinTurno } = ligarPorCaptura([turno('118', '2026-10-24', '07:20:49', '10:00:00')], [conteo('r1', 'retiro', null, '2026-10-24', '18:00:00')]);
    expect(sinTurno).toEqual([expect.objectContaining({ motivo: 'sin_turno' })]);
  });
});
