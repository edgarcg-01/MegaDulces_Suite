/**
 * `[RH.17.2]` «Horario distinto» con el horario COMPLETO de ese día (entrada, salida y comida opcionales).
 *
 * Antes sólo movía la entrada: un día de 8:00 a 14:00 se medía contra la salida de su horario permanente (18:00) y
 * salía con 4 h de «salida anticipada». Con la salida capturada, ESE día se mide de la entrada a la salida capturadas;
 * los demás días y el horario permanente no cambian.
 */
import { calcularAsistencia, type EntradaAsistencia, type FilaDia, type HorarioAsignado, type IncidenciaVigente } from './asistencia-persona';
import { CONFIG_DEFAULT } from './config-reglas';
import { rangoFechas } from './fechas';
import { validarCaptura } from './incidencias';

/** Ana, lunes a sábado 08:00–18:00 con una hora de comida. `cambia` reemplaza las checadas de un día. */
function escenario(cambia: (f: string) => string[] | undefined, over: Partial<EntradaAsistencia> = {}): EntradaAsistencia {
  const filas: FilaDia[] = [];
  for (const f of rangoFechas('2026-07-02', '2026-07-22')) {
    if (new Date(`${f}T12:00:00Z`).getUTCDay() === 0) continue;
    filas.push({ codigo: '15', nombreReloj: 'Ana R', fecha: f, horas: cambia(f) ?? ['08:00', '13:00', '14:00', '18:00'] });
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
const turno = { entrada: '08:00', salida: '18:00', comidaMin: 60 };
const ASIGNADO: HorarioAsignado = { ...turno, horarios: [turno], sabado: true, sabadoEntrada: null, sabadoSalida: null, asignadoPor: null, actualizadoEn: null };
const conAsignado = { asignados: new Map([['15', ASIGNADO]]) };

const MARTES = '2026-07-21';
/** Un Horario distinto del martes: entrada (y, si se da, salida y comida) en minutos del día. */
const hd = (entrada: number, salida?: number | null, comida?: number | null, fecha = MARTES): IncidenciaVigente => ({
  id: `hd-${fecha}`, personCode: '15', tipo: 'horario_distinto', desde: fecha, hasta: fecha, nota: 'prueba',
  minutos: entrada, salidaMin: salida ?? null, comidaMin: comida ?? null,
});
const otra = (tipo: string, minutos: number, fecha = MARTES): IncidenciaVigente =>
  ({ id: `${tipo}-${fecha}`, personCode: '15', tipo, desde: fecha, hasta: fecha, nota: 'prueba', minutos });

const dia = (e: EntradaAsistencia, f = MARTES) =>
  calcularAsistencia(e).personas.find((p) => p.codigo === '15')?.semanas.flatMap((s) => s.dias).find((d) => d.fecha === f);

const H = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

describe('[RH.17.2] Horario distinto con la salida de ese día (horario asignado 08:00–18:00)', () => {
  const salioALas = (hora: string) => escenario((f) => (f === MARTES ? ['08:00', hora] : undefined), conAsignado);

  it('control (hoy): SIN salida capturada, irse a las 14:00 son 4 h de salida anticipada', () => {
    const e = salioALas('14:00');
    e.incidencias = [hd(H('08:00'))];
    expect(dia(e)).toMatchObject({ salidaAntesMin: 240, extraMin: 0 });
  });

  it('⭐ CON salida 14:00 y comida 0: irse a las 14:00 es cumplir — sin salida anticipada, se esperaban 6 h', () => {
    const e = salioALas('14:00');
    e.incidencias = [hd(H('08:00'), H('14:00'), 0)];
    expect(dia(e)).toMatchObject({ salidaAntesMin: 0, esperadoMin: 360, atrasoMin: 0, extraMin: 0, salidaEsperada: '14:00' });
  });

  it('quedarse menos de 30 min no gana; quedarse una hora gana 1 h (la regla de siempre, contra la salida de ese día)', () => {
    const e1 = salioALas('14:20');
    e1.incidencias = [hd(H('08:00'), H('14:00'), 0)];
    expect(dia(e1)).toMatchObject({ extraMin: 0, salidaAntesMin: 0 });
    const e2 = salioALas('15:00');
    e2.incidencias = [hd(H('08:00'), H('14:00'), 0)];
    expect(dia(e2)).toMatchObject({ extraMin: 60 });
    // Contra su salida permanente (18:00) esa misma hora no habría contado.
    const sinSalida = salioALas('15:00');
    sinSalida.incidencias = [hd(H('08:00'))];
    expect(dia(sinSalida)).toMatchObject({ extraMin: 0, salidaAntesMin: 180 });
  });

  it('el retardo de ese día se mide contra la entrada capturada', () => {
    const e = escenario((f) => (f === MARTES ? ['10:00', '16:00'] : undefined), conAsignado);
    e.incidencias = [hd(H('10:00'), H('16:00'), 0)];
    expect(dia(e)).toMatchObject({ atrasoMin: 0, salidaAntesMin: 0, esperadoMin: 360 });
  });

  it('los demás días y su horario permanente no cambian', () => {
    const e = salioALas('14:00');
    e.incidencias = [hd(H('08:00'), H('14:00'), 0)];
    expect(dia(e, '2026-07-20')).toMatchObject({ esperadoMin: 540, salidaAntesMin: 0, extraMin: 0 });
    expect(dia(e, '2026-07-22')).toMatchObject({ esperadoMin: 540, salidaAntesMin: 0 });
  });

  it('comida: la del Horario distinto se mide; si además hay «Comida distinta» ese día, manda ésa', () => {
    const conComida = () => escenario((f) => (f === MARTES ? ['08:00', '11:00', '11:45', '14:00'] : undefined), conAsignado);
    const e = conComida();
    e.incidencias = [hd(H('08:00'), H('14:00'), 30)];
    expect(dia(e)).toMatchObject({ comidaExcesoMin: 15, esperadoMin: 330 });
    const e2 = conComida();
    e2.incidencias = [hd(H('08:00'), H('14:00'), 30), otra('comida_distinta', 60)];
    expect(dia(e2)).toMatchObject({ comidaExcesoMin: 0, esperadoMin: 300 });
  });

  it('sin comida capturada, ese día se descuenta la comida de su horario (60 min)', () => {
    const e = salioALas('14:00');
    e.incidencias = [hd(H('08:00'), H('14:00'))];
    expect(dia(e)).toMatchObject({ esperadoMin: 300 });
  });
});

describe('[RH.17.2] Horario distinto con salida, sin horario asignado (deducido)', () => {
  it('la salida que se esperaba ese día es la capturada, y contra ella se ganan horas extra', () => {
    const e = escenario((f) => (f === MARTES ? ['08:00', '15:00'] : undefined));
    e.incidencias = [hd(H('08:00'), H('14:00'), 0)];
    expect(dia(e)).toMatchObject({ salidaEsperada: '14:00', extraMin: 60 });
  });
});

describe('[RH.17.2] captura de Horario distinto con salida y comida', () => {
  const base = {
    site_code: 'cedis', person_code: '15', incident_type: 'horario_distinto', date_from: MARTES,
    minutes: H('08:00'), reason: 'Junta en corporativo', authorized_by_name: 'Gerente',
  };
  const valor = (b: Record<string, unknown>) => {
    const r = validarCaptura({ ...base, ...b });
    return r.ok ? r.valor : r.error;
  };

  it('sin salida ni comida: igual que hoy (las dos en null)', () => {
    expect(valor({})).toMatchObject({ end_minutes: null, break_minutes: null, minutes: 480 });
    expect(valor({ end_minutes: '', break_minutes: '' })).toMatchObject({ end_minutes: null, break_minutes: null });
  });
  it('con salida y comida: las guarda', () => {
    expect(valor({ end_minutes: H('14:00'), break_minutes: 0 })).toMatchObject({ end_minutes: 840, break_minutes: 0 });
  });
  it('rechaza una salida antes (o igual) que la entrada, fuera del día, o una comida imposible', () => {
    expect(valor({ end_minutes: H('08:00') })).toBe('La salida de ese día tiene que ser después de la entrada.');
    expect(valor({ end_minutes: H('07:00') })).toBe('La salida de ese día tiene que ser después de la entrada.');
    expect(valor({ end_minutes: 1440 })).toBe('La hora de salida de ese día no es válida.');
    expect(valor({ break_minutes: 241 })).toBe('La comida de ese día va de 0 a 240 minutos.');
    expect(valor({ end_minutes: H('09:00'), break_minutes: 60 })).toBe('La comida no puede durar lo mismo o más que el día.');
  });
  it('sigue pidiendo el porqué y quién autorizó', () => {
    expect(valor({ reason: '', end_minutes: H('14:00') })).toBe('Escribe por qué ese día entró en otro horario.');
    expect(valor({ authorized_by_name: '', end_minutes: H('14:00') })).toBe('Escribe quién autorizó el cambio de horario.');
  });
  it('en otros tipos no se guarda salida ni comida aunque lleguen', () => {
    expect(valor({ incident_type: 'vacaciones', minutes: null, end_minutes: 840, break_minutes: 30 }))
      .toMatchObject({ end_minutes: null, break_minutes: null });
  });
});
