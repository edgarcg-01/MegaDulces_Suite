/**
 * El reloj hábil de la Mesa de Servicio, con fechas REALES de octubre de 2026 (México no tiene horario
 * de verano: UTC-6 todo el mes). Jueves 1 · viernes 2 · sábado 3 · domingo 4 · lunes 5.
 *
 * Calendario por defecto del tenant: lunes a sábado, 08:00–19:00. Un «día hábil» se siembra como 480 min
 * (8 h de trabajo), no como la ventana entera de 11 h.
 *
 * La prueba NEGATIVA importa más que la positiva: un `getDay()` del servidor da otro día según el huso
 * del proceso. Por eso se fija el instante en UTC y se verifica contra la hora LOCAL de México.
 */
import {
  addBusinessMinutes,
  addClockMinutes,
  businessMinutesBetween,
  clockMinutesBetween,
  esHorarioHabil,
  instantFromLocal,
  localParts,
  parseHHMM,
  validarCalendario,
  type BusinessCalendar,
} from './business-clock';

const MX: BusinessCalendar = { tz: 'America/Mexico_City', days: [1, 2, 3, 4, 5, 6], startMin: 480, endMin: 1140 };
/** Instante a partir de hora LOCAL de México (UTC-6). */
const mx = (iso: string): Date => new Date(`${iso}-06:00`);
const local = (d: Date): string => {
  const p = localParts(d, MX.tz);
  const hh = String(Math.floor(p.minOfDay / 60)).padStart(2, '0');
  const mm = String(p.minOfDay % 60).padStart(2, '0');
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')} ${hh}:${mm}`;
};

describe('parseHHMM', () => {
  it('lee el formato de una columna time de Postgres', () => {
    expect(parseHHMM('08:00')).toBe(480);
    expect(parseHHMM('19:00:00')).toBe(1140);
    expect(parseHHMM('0:30')).toBe(30);
  });
  it('NEGATIVA: rechaza lo que no es una hora', () => {
    expect(() => parseHHMM('25:00')).toThrow();
    expect(() => parseHHMM('8am')).toThrow();
    expect(() => parseHHMM('08:60')).toThrow();
  });
});

describe('zona horaria: se lee la hora de MÉXICO, no la del proceso', () => {
  it('15:00 UTC del lunes es 09:00 en México', () => {
    expect(local(new Date('2026-10-05T15:00:00Z'))).toBe('2026-10-05 09:00');
  });
  it('NEGATIVA: 03:00 UTC del lunes todavía es DOMINGO en México (el día cambia por el huso)', () => {
    const p = localParts(new Date('2026-10-05T03:00:00Z'), MX.tz);
    expect(p.dow).toBe(0);
    expect(p.d).toBe(4);
    // Un getUTCDay() diría lunes (1): justo el error que este módulo existe para no cometer.
    expect(new Date('2026-10-05T03:00:00Z').getUTCDay()).toBe(1);
  });
  it('instantFromLocal es la inversa de localParts', () => {
    const d = instantFromLocal(2026, 10, 5, 9 * 60, MX.tz);
    expect(d.toISOString()).toBe('2026-10-05T15:00:00.000Z');
    expect(local(d)).toBe('2026-10-05 09:00');
  });
  it('funciona con otra zona (UTC) — no está clavado a México', () => {
    const utc: BusinessCalendar = { tz: 'UTC', days: [1, 2, 3, 4, 5], startMin: 540, endMin: 1020 };
    expect(addBusinessMinutes(new Date('2026-10-05T10:00:00Z'), 60, utc).toISOString()).toBe('2026-10-05T11:00:00.000Z');
  });
});

describe('addBusinessMinutes', () => {
  it('dentro del horario: suma directo', () => {
    expect(local(addBusinessMinutes(mx('2026-10-05T09:00:00'), 120, MX))).toBe('2026-10-05 11:00');
  });
  it('el borde exacto del cierre NO salta de día (19:00 se alcanza, no se pasa)', () => {
    expect(local(addBusinessMinutes(mx('2026-10-05T08:00:00'), 660, MX))).toBe('2026-10-05 19:00');
  });
  it('un minuto más sí pasa al día siguiente a las 08:01', () => {
    expect(local(addBusinessMinutes(mx('2026-10-05T08:00:00'), 661, MX))).toBe('2026-10-06 08:01');
  });
  it('viernes 18:00 + 2 h: 1 h el viernes y 1 h el SÁBADO (el sábado es hábil)', () => {
    expect(local(addBusinessMinutes(mx('2026-10-02T18:00:00'), 120, MX))).toBe('2026-10-03 09:00');
  });
  it('⭐ sábado 18:30 + 1 h: 30 min el sábado y 30 min el LUNES (el domingo no cuenta)', () => {
    expect(local(addBusinessMinutes(mx('2026-10-03T18:30:00'), 60, MX))).toBe('2026-10-05 08:30');
  });
  it('un ticket que nace el domingo empieza a correr el lunes a las 08:00', () => {
    expect(local(addBusinessMinutes(mx('2026-10-04T10:00:00'), 30, MX))).toBe('2026-10-05 08:30');
  });
  it('antes de abrir: el reloj arranca a la apertura', () => {
    expect(local(addBusinessMinutes(mx('2026-10-05T06:00:00'), 60, MX))).toBe('2026-10-05 09:00');
  });
  it('después de cerrar: arranca el día hábil siguiente', () => {
    expect(local(addBusinessMinutes(mx('2026-10-05T20:00:00'), 30, MX))).toBe('2026-10-06 08:30');
  });
  it('tres «días hábiles» (1440 min) desde el lunes 08:00 caen el miércoles a las 10:00', () => {
    // lunes 660 + martes 660 = 1320; faltan 120 → miércoles 08:00 + 2 h.
    expect(local(addBusinessMinutes(mx('2026-10-05T08:00:00'), 1440, MX))).toBe('2026-10-07 10:00');
  });
  it('siete «días hábiles» (3360 min) desde el lunes se agotan el sábado a las 09:00', () => {
    // lunes a viernes = 5 × 660 = 3300; faltan 60 → sábado 08:00 + 1 h. No cruza ningún domingo.
    expect(local(addBusinessMinutes(mx('2026-10-05T08:00:00'), 3360, MX))).toBe('2026-10-10 09:00');
  });
  it('⭐ y desde el miércoles SÍ cruzan el domingo sin contarlo: caen el martes siguiente', () => {
    // miércoles a sábado = 4 × 660 = 2640; el domingo no cuenta; lunes = 660 → 3300; faltan 60 → martes 09:00.
    expect(local(addBusinessMinutes(mx('2026-10-07T08:00:00'), 3360, MX))).toBe('2026-10-13 09:00');
  });
  it('cero minutos devuelve el primer instante hábil a partir de `from`', () => {
    expect(local(addBusinessMinutes(mx('2026-10-04T10:00:00'), 0, MX))).toBe('2026-10-05 08:00');
    expect(local(addBusinessMinutes(mx('2026-10-05T10:00:00'), 0, MX))).toBe('2026-10-05 10:00');
  });
  it('NEGATIVA: minutos negativos o no numéricos se rechazan', () => {
    expect(() => addBusinessMinutes(mx('2026-10-05T09:00:00'), -1, MX)).toThrow();
    expect(() => addBusinessMinutes(mx('2026-10-05T09:00:00'), Number.NaN, MX)).toThrow();
  });
});

describe('businessMinutesBetween', () => {
  it('lunes 10:00 → martes 10:00 = lo que queda del lunes + lo que lleva el martes', () => {
    expect(businessMinutesBetween(mx('2026-10-05T10:00:00'), mx('2026-10-06T10:00:00'), MX)).toBe(540 + 120);
  });
  it('sábado 18:00 → lunes 09:00 no cuenta el domingo', () => {
    expect(businessMinutesBetween(mx('2026-10-03T18:00:00'), mx('2026-10-05T09:00:00'), MX)).toBe(60 + 60);
  });
  it('fuera de horario no suma nada', () => {
    expect(businessMinutesBetween(mx('2026-10-05T20:00:00'), mx('2026-10-06T07:00:00'), MX)).toBe(0);
    expect(businessMinutesBetween(mx('2026-10-04T08:00:00'), mx('2026-10-04T18:00:00'), MX)).toBe(0);
  });
  it('b <= a devuelve 0, no un negativo', () => {
    expect(businessMinutesBetween(mx('2026-10-05T10:00:00'), mx('2026-10-05T09:00:00'), MX)).toBe(0);
  });
  it('⭐ es la inversa de addBusinessMinutes (ida y vuelta, 40 casos)', () => {
    for (let i = 0; i < 40; i++) {
      const from = new Date(mx('2026-10-01T06:00:00').getTime() + i * 197 * 60_000);
      const mins = (i * 53) % 1700;
      const to = addBusinessMinutes(from, mins, MX);
      expect(businessMinutesBetween(from, to, MX)).toBe(mins);
    }
  });
});

describe('esHorarioHabil', () => {
  it('lunes 09:00 sí; lunes 19:00 no (el cierre es exclusivo); domingo no', () => {
    expect(esHorarioHabil(mx('2026-10-05T09:00:00'), MX)).toBe(true);
    expect(esHorarioHabil(mx('2026-10-05T19:00:00'), MX)).toBe(false);
    expect(esHorarioHabil(mx('2026-10-04T12:00:00'), MX)).toBe(false);
    expect(esHorarioHabil(mx('2026-10-03T12:00:00'), MX)).toBe(true);
  });
});

describe('reloj de la política: hábil o corrido', () => {
  it('Urgente (corrido) corre de noche y en domingo: domingo 23:00 + 4 h = lunes 03:00', () => {
    expect(local(addClockMinutes(mx('2026-10-04T23:00:00'), 240, 'calendar', MX))).toBe('2026-10-05 03:00');
  });
  it('el MISMO plazo en reloj hábil NO corre de noche: domingo 23:00 + 4 h = lunes 12:00', () => {
    expect(local(addClockMinutes(mx('2026-10-04T23:00:00'), 240, 'business', MX))).toBe('2026-10-05 12:00');
  });
  it('clockMinutesBetween respeta el reloj elegido', () => {
    const a = mx('2026-10-04T23:00:00');
    const b = mx('2026-10-05T12:00:00');
    expect(clockMinutesBetween(a, b, 'calendar', MX)).toBe(13 * 60);
    expect(clockMinutesBetween(a, b, 'business', MX)).toBe(240);
  });
});

describe('validarCalendario', () => {
  it('NEGATIVA: sin días, días fuera de rango, o cierre antes que apertura', () => {
    expect(() => validarCalendario({ ...MX, days: [] })).toThrow();
    expect(() => validarCalendario({ ...MX, days: [7] })).toThrow();
    expect(() => validarCalendario({ ...MX, startMin: 1140, endMin: 480 })).toThrow();
  });
  it('CONTROL: el calendario por defecto es válido', () => {
    expect(() => validarCalendario(MX)).not.toThrow();
  });
});
