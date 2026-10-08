import type { HrRelojEstadoDto } from '@megadulces/contracts';
import { chipEnVivo, desdeCuando, desfaseTexto, faltantesTexto, motivoReloj, peorSemaforo, resumenRelojes } from './relojes-formato';

/**
 * `[RH.1.7b]` El formato de la franja de relojes, el mismo que RH ya leía en Mega Talento. Lo que se defiende: la
 * pantalla no parece al día cuando no lo está, y un reloj sin dato se dice como falta de DATO, no de la persona.
 */
const r = (o: Partial<HrRelojEstadoDto>): HrRelojEstadoDto => ({
  serie: 'S1', sucursalId: 'ph', alias: 'Entrada', modo: 'agente', ip: '', nota: '', ultimaSenal: null, ultimaChecada: null, ultimoBackfill: null,
  segundosSinSenal: 30, logsEnReloj: null, logsEnBase: null, desfaseRelojSeg: null, ultimoError: '', agenteVersion: '', agenteHost: '',
  semaforo: 'ok', ...o,
});

describe('[RH.1.7b] desdeCuando', () => {
  it('segundos, minutos y horas como en Mega Talento', () => {
    expect(desdeCuando(r({ segundosSinSenal: 40 }))).toBe('hace 40 s');
    expect(desdeCuando(r({ segundosSinSenal: 600 }))).toBe('hace 10 min');
    expect(desdeCuando(r({ segundosSinSenal: 3600 + 12 * 60 }))).toBe('hace 1 h 12 m');
    expect(desdeCuando(r({ segundosSinSenal: 7200 }))).toBe('hace 2 h');
  });
  it('más de un día: la fecha de la última señal, en hora de México', () => {
    expect(desdeCuando(r({ segundosSinSenal: 3 * 86400, ultimaSenal: '2026-07-17T20:00:00Z', semaforo: 'mudo' }))).toBe('sin señal desde el 17 jul');
    // 05:30 UTC del 18-jul es 23:30 del 17-jul en México.
    expect(desdeCuando(r({ segundosSinSenal: 3 * 86400, ultimaSenal: '2026-07-18T05:30:00Z', semaforo: 'mudo' }))).toBe('sin señal desde el 17 jul');
    expect(desdeCuando(r({ segundosSinSenal: 3 * 86400, ultimaSenal: null, semaforo: 'mudo' }))).toBe('hace 3 días');
  });
  it('⛔ NEGATIVA — un reloj que nunca habló no dice «hace 0 s»', () => {
    expect(desdeCuando(r({ segundosSinSenal: null, semaforo: 'mudo' }))).toBe('nunca ha reportado');
  });
  it('en pausa no se mide el tiempo: se dice que está en pausa', () => {
    expect(desdeCuando(r({ semaforo: 'pendiente', segundosSinSenal: 99999 }))).toBe('en pausa');
  });
});

describe('[RH.1.7b] hora corrida y faltantes', () => {
  it('la hora corrida se marca pasando 2 minutos, con su signo', () => {
    expect(desfaseTexto(r({ desfaseRelojSeg: 420 }))).toBe('hora corrida +7 min');
    expect(desfaseTexto(r({ desfaseRelojSeg: -300 }))).toBe('hora corrida −5 min');
  });
  it('⛔ NEGATIVA — hasta 2 minutos no es hora corrida, y sin medir no se dice nada', () => {
    expect(desfaseTexto(r({ desfaseRelojSeg: 120 }))).toBe('');
    expect(desfaseTexto(r({ desfaseRelojSeg: -35 }))).toBe('');
    expect(desfaseTexto(r({ desfaseRelojSeg: null }))).toBe('');
  });
  it('lo que falta en la base contra lo que el reloj dice tener', () => {
    expect(faltantesTexto(r({ logsEnReloj: 5000, logsEnBase: 3988 }))).toBe('faltan 1,012');
    expect(faltantesTexto(r({ logsEnReloj: 5000, logsEnBase: 5000 }))).toBe('completo');
    expect(faltantesTexto(r({ logsEnReloj: 5000, logsEnBase: null }))).toBe('');
  });
});

describe('[RH.1.7b] motivo, resumen y peor estado', () => {
  it('el motivo dice qué hacer; el error del lector manda sobre el genérico', () => {
    expect(motivoReloj(r({ semaforo: 'mudo', ultimoError: 'No responde el puerto 4370' }))).toBe('No responde el puerto 4370');
    expect(motivoReloj(r({ semaforo: 'mudo' }))).toContain('lector apagado');
    expect(motivoReloj(r({ semaforo: 'atrasado' }))).toContain('más lento');
    expect(motivoReloj(r({ semaforo: 'pendiente', nota: 'cambio de equipo' }))).toBe('en pausa — cambio de equipo. Sus checadas se guardan y se aplican al quitar la pausa');
  });
  it('⛔ NEGATIVA — un reloj al día no lleva motivo', () => {
    expect(motivoReloj(r({ semaforo: 'ok' }))).toBe('');
  });
  it('el resumen dice sólo lo que hay, con plurales', () => {
    expect(resumenRelojes([r({}), r({}), r({ semaforo: 'atrasado' }), r({ semaforo: 'mudo' }), r({ semaforo: 'pendiente' })]))
      .toBe('2 al día · 1 atrasado · 1 sin señal · 1 en pausa');
    expect(resumenRelojes([r({ semaforo: 'atrasado' }), r({ semaforo: 'atrasado' })])).toBe('2 atrasados');
    expect(resumenRelojes([])).toBe('sin relojes registrados');
  });
  it('el peor estado colorea: mudo > atrasado > en pausa > al día', () => {
    expect(peorSemaforo([r({}), r({ semaforo: 'pendiente' }), r({ semaforo: 'mudo' })])).toBe('mudo');
    expect(peorSemaforo([r({}), r({ semaforo: 'pendiente' }), r({ semaforo: 'atrasado' })])).toBe('atrasado');
    expect(peorSemaforo([r({}), r({ semaforo: 'pendiente' })])).toBe('pendiente');
    expect(peorSemaforo([])).toBe('vacio');
  });
  it('el chip de Asistencia: «En vivo» sólo si nada está sin señal ni atrasado', () => {
    expect(chipEnVivo('ok').texto).toBe('En vivo');
    expect(chipEnVivo('atrasado').texto).toBe('Con retraso');
    expect(chipEnVivo('mudo').texto).toBe('Sin señal');
    expect(chipEnVivo('vacio').texto).toBe('Sin reloj');
  });
});
