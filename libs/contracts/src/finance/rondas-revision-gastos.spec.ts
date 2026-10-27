import { horaAmPm, rondaDeRevision } from './rondas-revision-gastos.contract';

/** Un instante en hora de México (UTC−6, sin horario de verano desde 2022). 2026-10-19 = lunes. */
const MX = (fecha: string, hhmm: string) => new Date(`${fecha}T${hhmm}:00-06:00`);
const LUN = '2026-10-19';
const JUE = '2026-10-22';
const VIE = '2026-10-23';
const SAB = '2026-10-24';
const DOM = '2026-10-25';

describe('[GX.86] rondaDeRevision — los bordes de cada ronda', () => {
  it.each([
    ['08:29', false], ['08:30', true], ['09:59', true], ['10:00', false],
    ['16:59', false], ['17:00', true], ['17:59', true], ['18:00', false],
    ['00:00', false], ['12:00', false], ['23:59', false],
  ])('lunes %s → en ronda = %s', (h, esperado) => {
    expect(rondaDeRevision(MX(LUN, h)).en_ronda).toBe(esperado);
  });

  it('sábado y domingo no hay ronda, aun a la hora de una', () => {
    for (const d of [SAB, DOM]) for (const h of ['08:30', '09:00', '17:30']) {
      expect(rondaDeRevision(MX(d, h)).en_ronda).toBe(false);
    }
  });
});

describe('[GX.86] rondaDeRevision — lo que se le dice a la persona', () => {
  it('en ronda: «ahorita estamos revisando» y a qué hora termina', () => {
    const r = rondaDeRevision(MX(LUN, '09:15'));
    expect(r.linea).toBe('Ahorita estamos revisando: el tuyo entra en esta ronda, que termina a las 10:00 am.');
    expect(r.acuse).toBe('Lo revisamos en esta ronda, que termina a las 10:00 am.');
  });

  it('antes de la primera: la ronda de hoy a las 8:30 am', () => {
    expect(rondaDeRevision(MX(LUN, '07:00')).linea).toBe('Lo que subas ahora se revisa en la ronda de hoy a las 8:30 am.');
  });

  it('entre rondas: la de hoy a las 5:00 pm', () => {
    const r = rondaDeRevision(MX(LUN, '12:40'));
    expect(r.proxima).toEqual({ dia: 'hoy', hora: '17:00' });
    expect(r.linea).toBe('Lo que subas ahora se revisa en la ronda de hoy a las 5:00 pm.');
    expect(r.acuse).toBe('Lo revisamos en la ronda de hoy a las 5:00 pm.');
  });

  it('jueves después de las 6: la de mañana a las 8:30 am', () => {
    expect(rondaDeRevision(MX(JUE, '19:00')).linea).toBe('Lo que subas ahora se revisa en la ronda de mañana a las 8:30 am.');
  });

  it('viernes en la tarde: brinca el fin de semana al lunes', () => {
    expect(rondaDeRevision(MX(VIE, '19:20')).linea).toBe('Lo que subas ahora se revisa en la ronda del lunes a las 8:30 am.');
  });

  it('domingo: la de mañana (lunes)', () => {
    expect(rondaDeRevision(MX(DOM, '20:00')).proxima).toEqual({ dia: 'mañana', hora: '08:30' });
  });

  it('ninguna línea dice que no se puede subir: es un aviso, no un bloqueo', () => {
    for (const [d, h] of [[LUN, '09:00'], [LUN, '12:00'], [VIE, '22:00'], [SAB, '10:00']]) {
      expect(rondaDeRevision(MX(d, h)).linea).not.toMatch(/cerrad|no se puede|solo se|sólo se/i);
    }
  });

  it('la hora sale de México, no de la del proceso (02:00 UTC del martes = lunes 20:00 en MX)', () => {
    expect(rondaDeRevision(new Date('2026-10-20T02:00:00Z')).proxima).toEqual({ dia: 'mañana', hora: '08:30' });
    expect(rondaDeRevision(new Date('2026-10-19T15:00:00Z')).en_ronda).toBe(true); // 9:00 en MX
  });
});

describe('[GX.86] horaAmPm', () => {
  it.each([['08:30', '8:30 am'], ['10:00', '10:00 am'], ['12:00', '12:00 pm'], ['17:00', '5:00 pm'], ['00:15', '12:15 am']])(
    '%s → %s', (a, b) => expect(horaAmPm(a)).toBe(b));
});
