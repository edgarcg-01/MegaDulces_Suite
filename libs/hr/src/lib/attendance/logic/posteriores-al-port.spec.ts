/**
 * `[RH.6.1]`–`[RH.6.3]` Lo que Mega Talento cambió en asistencia después del port de `[RH.1.10]`
 * (1a28f6e): la marca sin pareja (8396d3c), la incidencia Descanso (8dd5521) y varios horarios por
 * persona (8396d3c). Cada caso fija una frase de la regla tal como la dejó Mega Talento, con su
 * negativa: sin el cambio, el número sale como antes.
 */
import { calcularAsistencia, type EntradaAsistencia, type FilaDia, type HorarioAsignado, type IncidenciaVigente } from './asistencia-persona';
import { CONFIG_DEFAULT } from './config-reglas';
import { detalleDia } from './detalle-dia';
import { rangoFechas } from './fechas';
import { aMinutos, marcaSinPareja } from './horario-deducido';
import { errorDeHorario } from '../attendance-schedules.service';
import { horariosDeFila } from '../attendance-reader';

const m = (hs: string[]): number[] => hs.map((h) => aMinutos(h) as number);

describe('[RH.6.1] la marca de en medio sin pareja', () => {
  it('par: ninguna queda sola', () => {
    expect(marcaSinPareja(m(['10:00', '10:15']))).toBeNull();
  });

  it('falta la salida al desayuno (10:28 · 14:33 · 15:02): la suelta es la PRIMERA, no la última', () => {
    expect(marcaSinPareja(m(['10:28', '14:33', '15:02']))).toBe(0);
  });

  it('checó dos veces el regreso (14:05 · 14:56 · 15:02): no acepta la «pausa» de 6 min', () => {
    expect(marcaSinPareja(m(['14:05', '14:56', '15:02']))).toBe(2);
  });

  it('empate: la última, como antes', () => {
    expect(marcaSinPareja(m(['11:00', '11:30', '12:00']))).toBe(2);
  });

  it('el día ya no descuenta 4 horas de «comida»: 10:28 queda suelta y la comida es 14:33–15:02', () => {
    const d = detalleDia(['08:00', '10:28', '14:33', '15:02', '18:00']);
    expect(d.comida).toBe('10:28 · 14:33 – 15:02');
    expect(d.comidaMin).toBe(29);
    expect(d.netasMin).toBe(600 - 29);
  });
});

/**
 * Ana: lunes a sábado 08:00–13:00 · 14:00–18:00 del jueves 02-jul al miércoles 22-jul; descansa el
 * domingo. `cambia(f)` devuelve las marcas de ese día (null = no vino).
 */
function escenario(cambia: (f: string) => string[] | null | undefined = () => undefined, over: Partial<EntradaAsistencia> = {}): EntradaAsistencia {
  const filas: FilaDia[] = [];
  for (const f of rangoFechas('2026-07-02', '2026-07-22')) {
    if (new Date(`${f}T12:00:00Z`).getUTCDay() === 0) continue;
    const c = cambia(f);
    if (c === null) continue;
    filas.push({ codigo: '15', nombreReloj: 'Ana R', fecha: f, horas: c ?? ['08:00', '13:00', '14:00', '18:00'] });
  }
  return {
    siteCode: 'cedis', desde: '2026-07-16', hasta: '2026-07-22', soloPromotoras: false,
    cfg: CONFIG_DEFAULT, filas,
    silencio: new Map([['15', 0]]), unaMarca: new Map([['15', { dias: filas.length, conUna: 0 }]]),
    padron: new Map([['15', {
      userId: 'u-15', registrado: true, nombre: 'Ana', nombreCompleto: 'PRUEBA UNO', departamento: 'ALMACEN',
      puesto: 'Auxiliar', fotoUrl: null, activo: true,
    }]]),
    turnosConfirmados: new Map(), asignados: new Map(), revisiones: new Map(), incidencias: [],
    ...over,
  };
}
const ana = (e: EntradaAsistencia) => calcularAsistencia(e).personas.find((p) => p.codigo === '15');
const dia = (e: EntradaAsistencia, f: string) => ana(e)?.semanas.flatMap((s) => s.dias).find((d) => d.fecha === f);
const inc = (tipo: string, desde: string, hasta = desde): IncidenciaVigente =>
  ({ id: `i-${tipo}-${desde}`, personCode: '15', tipo, desde, hasta, nota: 'prueba', minutos: null });

describe('[RH.6.2] incidencia Descanso', () => {
  it('no vino el martes 21 con Descanso: es descanso, no falta, y su domingo no se mueve', () => {
    const e = escenario((f) => (f === '2026-07-21' ? null : undefined), { incidencias: [inc('descanso', '2026-07-21')] });
    expect(dia(e, '2026-07-21')).toMatchObject({ estado: 'descanso', descansoCambio: 'descansa' });
    expect(dia(e, '2026-07-19')?.estado).toBe('descanso');
    expect(ana(e)?.faltas).toBe(0);
  });

  it('manda sobre el cambio de descanso del mismo día', () => {
    const e = escenario((f) => (f === '2026-07-21' ? null : undefined),
      { incidencias: [inc('cambio_descanso', '2026-07-22'), inc('descanso', '2026-07-21')] });
    expect(dia(e, '2026-07-21')?.estado).toBe('descanso');
  });

  it('⛔ NEGATIVA — sin la incidencia, faltar el martes es falta', () => {
    const e = escenario((f) => (f === '2026-07-21' ? null : undefined));
    expect(dia(e, '2026-07-21')?.estado).toBe('falta');
  });
});

describe('[RH.6.3] varios horarios por persona', () => {
  const turno = (entrada: string, salida: string, comidaMin = 60) => ({ entrada, salida, comidaMin });
  const asignado = (horarios: Array<ReturnType<typeof turno>>): HorarioAsignado => ({
    ...horarios[0], horarios, sabado: true, sabadoEntrada: null, sabadoSalida: null, asignadoPor: null, actualizadoEn: null,
  });
  const tarde = (f: string) => (f === '2026-07-20' ? ['12:00', '15:00', '16:00', '21:00'] : undefined);

  it('el lunes trabajó la tarde: se mide contra 12:00–21:00 y la ficha dice qué turno', () => {
    const e = escenario(tarde, { asignados: new Map([['15', asignado([turno('08:00', '18:00'), turno('12:00', '21:00')])]]) });
    expect(dia(e, '2026-07-20')).toMatchObject({ turno: '12:00', esperadoMin: 480, extraMin: 0, atrasoMin: 0 });
    expect(dia(e, '2026-07-17')).toMatchObject({ turno: '08:00', esperadoMin: 540 });
    expect(ana(e)?.turnos).toEqual(['08:00', '12:00']);
  });

  it('llegó 12:20 al turno de la tarde: 20 min de retardo contra 12:00 (no un día atípico contra las 08:00)', () => {
    const e = escenario((f) => (f === '2026-07-20' ? ['12:20', '15:00', '16:00', '21:00'] : undefined),
      { asignados: new Map([['15', asignado([turno('08:00', '18:00'), turno('12:00', '21:00')])]]) });
    expect(dia(e, '2026-07-20')).toMatchObject({ turno: '12:00', atrasoMin: 20 });
  });

  it('llegar 70 min tarde a la mañana sigue siendo la mañana (margen de 120, no de 60)', () => {
    const e = escenario((f) => (f === '2026-07-20' ? ['09:10', '13:00', '14:00', '18:00'] : undefined),
      { asignados: new Map([['15', asignado([turno('08:00', '18:00'), turno('12:00', '21:00')])]]) });
    expect(dia(e, '2026-07-20')).toMatchObject({ turno: '08:00', atrasoMin: 70 });
  });

  it('⛔ NEGATIVA — con un solo horario, la tarde se mide contra 08:00–18:00', () => {
    const e = escenario(tarde, { asignados: new Map([['15', asignado([turno('08:00', '18:00')])]]) });
    const d = dia(e, '2026-07-20');
    expect(d?.esperadoMin).toBe(540);
    expect(d?.turno).toBeUndefined();
  });

  it('valida como Mega Talento: hasta 4, sin dos con la misma entrada, y dice cuál está mal', () => {
    const h = (starts_at: string, ends_at: string) => ({ starts_at, ends_at, lunch_minutes: 60 });
    expect(errorDeHorario({ shifts: [h('08:00', '17:00'), h('13:00', '21:00')] })).toBeNull();
    expect(errorDeHorario({ shifts: [h('08:00', '17:00'), h('08:00', '18:00')] })).toMatch(/misma hora/);
    expect(errorDeHorario({ shifts: [h('06:00', '12:00'), h('08:00', '17:00'), h('10:00', '18:00'), h('12:00', '20:00'), h('14:00', '22:00')] }))
      .toMatch(/hasta 4/);
    expect(errorDeHorario({ shifts: [h('08:00', '17:00'), h('21:00', '13:00')] })).toMatch(/\(horario 2\)/);
    // Uno suelto, como antes.
    expect(errorDeHorario({ starts_at: '08:00', ends_at: '17:00', lunch_minutes: 60 })).toBeNull();
  });

  it('la fila: `shifts` sólo vale si cuadra con sus entradas; si no, manda lo de las columnas', () => {
    const shifts = [turno('08:00', '17:00'), turno('13:00', '21:00')];
    expect(horariosDeFila(shifts, ['08:00', '13:00'])).toEqual(shifts);
    expect(horariosDeFila(shifts, ['08:00'])).toBeNull();
    expect(horariosDeFila(null, ['08:00', '13:00'])).toBeNull();
    expect(horariosDeFila([turno('08:00', '17:00'), { entrada: '13:00' }], ['08:00', '13:00'])).toBeNull();
  });
});
