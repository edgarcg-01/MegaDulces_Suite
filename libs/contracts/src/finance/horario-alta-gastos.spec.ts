import { exentoDeHorarioAlta, horarioAltaGastos } from './horario-alta-gastos.contract';

/** Un instante en hora de México (UTC−6, sin horario de verano desde 2022). 2026-10-19 = lunes. */
const MX = (fecha: string, hhmm: string) => new Date(`${fecha}T${hhmm}:00-06:00`);
const LUN = '2026-10-19';
const VIE = '2026-10-23';
const SAB = '2026-10-24';
const DOM = '2026-10-25';

describe('[GX.86] horarioAltaGastos — los bordes de cada ventana', () => {
  it.each([
    ['08:29', false], ['08:30', true], ['09:59', true], ['10:00', false],
    ['16:59', false], ['17:00', true], ['17:59', true], ['18:00', false],
    ['00:00', false], ['12:00', false], ['23:59', false],
  ])('lunes %s → abierto = %s', (h, esperado) => {
    expect(horarioAltaGastos(MX(LUN, h)).abierto).toBe(esperado);
  });

  it('sábado y domingo cerrado todo el día, aun en la hora de una ventana', () => {
    for (const d of [SAB, DOM]) for (const h of ['08:30', '09:00', '17:30']) {
      expect(horarioAltaGastos(MX(d, h)).abierto).toBe(false);
    }
  });
});

describe('[GX.86] horarioAltaGastos — qué le dice a la persona', () => {
  it('abierto: dice a qué hora cierra la ventana en curso', () => {
    const e = horarioAltaGastos(MX(LUN, '09:15'));
    expect(e.cierra).toBe('10:00');
    expect(e.mensaje).toContain('10:00');
  });

  it('antes de abrir: abre hoy a las 8:30', () => {
    expect(horarioAltaGastos(MX(LUN, '07:00')).abre).toEqual({ dia: 'hoy', hora: '08:30' });
  });

  it('entre ventanas: abre hoy a las 17:00', () => {
    expect(horarioAltaGastos(MX(LUN, '10:00')).abre).toEqual({ dia: 'hoy', hora: '17:00' });
  });

  it('después de las 18:00 entre semana: abre mañana a las 8:30', () => {
    expect(horarioAltaGastos(MX(LUN, '18:00')).abre).toEqual({ dia: 'mañana', hora: '08:30' });
  });

  it('viernes en la tarde: brinca el fin de semana al lunes', () => {
    const e = horarioAltaGastos(MX(VIE, '19:00'));
    expect(e.abre).toEqual({ dia: 'el lunes', hora: '08:30' });
    expect(e.mensaje).toContain('lunes a las 8:30');
  });

  it('domingo: abre mañana (lunes)', () => {
    expect(horarioAltaGastos(MX(DOM, '20:00')).abre).toEqual({ dia: 'mañana', hora: '08:30' });
  });

  it('la hora sale de México, no de la del proceso (02:00 UTC del martes = lunes 20:00 en MX)', () => {
    expect(horarioAltaGastos(new Date('2026-10-20T02:00:00Z')).abre).toEqual({ dia: 'mañana', hora: '08:30' });
    // 15:00 UTC = 9:00 en México → abierto
    expect(horarioAltaGastos(new Date('2026-10-19T15:00:00Z')).abierto).toBe(true);
  });
});

describe('[GX.86] exentoDeHorarioAlta', () => {
  it('el aprobador (COMPROBAR) no tiene horario', () => {
    expect(exentoDeHorarioAlta({ FINANCE_EXPENSES_COMPROBAR: true }, false)).toBe(true);
  });
  it('el rol de plataforma no tiene horario', () => {
    expect(exentoDeHorarioAlta({}, true)).toBe(true);
  });
  it('quien sólo da de alta SÍ tiene horario (aunque vea gastos)', () => {
    expect(exentoDeHorarioAlta({ FINANCE_EXPENSES_CAPTURAR: true, FINANCE_EXPENSES_VER: true }, false)).toBe(false);
  });
  it('COMPROBAR en false, o sin permisos (link de captura), tiene horario', () => {
    expect(exentoDeHorarioAlta({ FINANCE_EXPENSES_COMPROBAR: false }, false)).toBe(false);
    expect(exentoDeHorarioAlta(null, false)).toBe(false);
  });
});
