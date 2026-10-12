/**
 * `[RH.1.10]` El banco de horas extra: saldo = ganadas − usadas + ajustes, desde que arrancó el banco.
 */
import type { HrPersonaAsistencia } from '@megadulces/contracts';
import { bancoHorasExtra, errorDeAjuste } from './banco-horas-extra';
import type { AsistenciaPersonas } from './asistencia-persona';

const persona = (o: Partial<HrPersonaAsistencia>): HrPersonaAsistencia => ({
  codigo: '15', nombreCompleto: 'PRUEBA UNO', departamento: 'ALMACEN', salida: '18:00', registrado: true,
  horasExtraSegun: 'deducido', incidencias: [],
  semanas: [{ dias: [
    { fecha: '2026-09-25', estado: 'a_tiempo', atrasoMin: 0, entrada: '08:00', salida: '19:00', salidaEsperada: '18:00', extraMin: 60 },
    { fecha: '2026-09-26', estado: 'a_tiempo', atrasoMin: 0, entrada: '08:00', salida: '18:40', salidaEsperada: '18:00', extraMin: 30 },
    { fecha: '2026-09-28', estado: 'a_tiempo', atrasoMin: 0, entrada: '08:00', salida: '18:00', salidaEsperada: '18:00', extraMin: 0 },
  ] }],
  ...o,
} as unknown as HrPersonaAsistencia);
const asistencia = (personas: HrPersonaAsistencia[]): AsistenciaPersonas => ({ personas } as unknown as AsistenciaPersonas);
const base = { siteCode: 'cedis', desde: '2026-09-24', hasta: '2026-10-12' };

describe('[RH.1.10] banco de horas extra', () => {
  it('saldo = ganadas − usadas + ajustes (el uso cuenta por día dentro del banco)', () => {
    const p = persona({
      incidencias: [{ id: 'i1', tipo: 'horas_extra', codigo: 'HE', etiqueta: 'Uso', nota: '', minutos: 30, desde: '2026-09-29', hasta: '2026-09-30' }],
    });
    const b = bancoHorasExtra({ ...base, asistencia: asistencia([p]), ajustes: [
      { id: 'a1', personCode: '15', fecha: '2026-09-24', minutos: 330, motivo: 'saldo que traía', creadoPor: 'rh', creadoEn: '' },
    ] });
    expect(b.personas[0]).toMatchObject({ ganadasMin: 90, usadasMin: 60, ajustesMin: 330, saldoMin: 360 });
    expect(b.personas[0].ganadas.map((g) => g.fecha)).toEqual(['2026-09-25', '2026-09-26']);
  });

  it('un uso que empezó antes del banco sólo cuenta sus días dentro', () => {
    const p = persona({
      incidencias: [{ id: 'i1', tipo: 'horas_extra', codigo: 'HE', etiqueta: 'Uso', nota: '', minutos: 60, desde: '2026-09-20', hasta: '2026-09-25' }],
    });
    expect(bancoHorasExtra({ ...base, asistencia: asistencia([p]), ajustes: [] }).personas[0].usadasMin).toBe(2 * 60);
  });

  it('un ajuste con fecha posterior a la pedida no cuenta', () => {
    const b = bancoHorasExtra({ ...base, hasta: '2026-09-30', asistencia: asistencia([persona({})]), ajustes: [
      { id: 'a1', personCode: '15', fecha: '2026-10-05', minutos: 600, motivo: 'después', creadoPor: 'rh', creadoEn: '' },
    ] });
    expect(b.personas[0].ajustesMin).toBe(0);
  });

  it('⛔ sin horario fijo y sin movimientos no sale, y se cuenta como «sin horario fijo»', () => {
    const p = persona({ horasExtraSegun: null, semanas: [{ dias: [] }] as unknown as HrPersonaAsistencia['semanas'] });
    const b = bancoHorasExtra({ ...base, asistencia: asistencia([p]), ajustes: [] });
    expect([b.personas.length, b.sinHorarioFijo]).toEqual([0, 1]);
  });

  it('pedir antes de que arranque el banco da vacío', () => {
    expect(bancoHorasExtra({ ...base, hasta: '2026-09-01', asistencia: null, ajustes: [] }).personas).toEqual([]);
  });

  it('valida el ajuste: distinto de cero, con motivo de 5 letras', () => {
    expect(errorDeAjuste({ site_code: 'c', person_code: '1', minutes: 0, reason: 'saldo inicial' })).toMatch(/distinto de cero/);
    expect(errorDeAjuste({ site_code: 'c', person_code: '1', minutes: 60, reason: 'ok' })).toMatch(/motivo/);
    expect(errorDeAjuste({ site_code: 'c', person_code: '1', minutes: -60, reason: 'corrección' })).toBeNull();
  });
});
