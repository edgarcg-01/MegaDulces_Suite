/**
 * `[RH.1.15]` Los cambios de lógica de asistencia que Mega Talento hizo DESPUÉS del último port
 * (`[RH.1.10]` @ 1a28f6e):
 *
 *   · 8dd5521 (13/10/2026) — incidencia «Descanso»: esos días son descanso sin mover otro, y mandan
 *     sobre unas vacaciones que los cruzan.
 *   · 8396d3c (15/10/2026) — (a) la marca de en medio sin pareja ya no es siempre la última
 *     (`marcaSinPareja`, una sola regla para la pantalla y la alerta de desayuno); (b) hasta 4
 *     horarios por persona, cada día contra el más cercano a su entrada.
 *
 * Mega Talento no trae pruebas de esto: cada caso reproduce el ejemplo del mensaje de su commit, con
 * personas y códigos inventados.
 */
import { calcularAsistencia, horariosDeFila, type EntradaAsistencia, type FilaDia, type HorarioAsignado, type IncidenciaVigente } from './asistencia-persona';
import { CONFIG_DEFAULT } from './config-reglas';
import { detalleDia } from './detalle-dia';
import { rangoFechas } from './fechas';
import { marcaSinPareja, PAUSA_MIN_CREIBLE, aMinutos } from './horario-deducido';
import { analizarDia } from './reglas';
import type { ChecadaMin, EntradaDia } from './tipos';
import { errorDeHorario, horariosDelCuerpo } from '../attendance-schedules.service';

const m = (...h: string[]) => h.map((x) => aMinutos(x) as number);

describe('[RH.1.15] marcaSinPareja — cuál marca de en medio se queda sola', () => {
  it('pares: ninguna', () => {
    expect(marcaSinPareja(m('13:00', '14:00'))).toBeNull();
    expect(marcaSinPareja([])).toBeNull();
  });

  it('regreso del desayuno sin su salida (10:28) + comida 14:33–15:02: la suelta es la PRIMERA, no la última', () => {
    // Antes se emparejaba 10:28→14:33 (4 h 05 min de «comida»).
    expect(marcaSinPareja(m('10:28', '14:33', '15:02'))).toBe(0);
  });

  it('⛔ una «pausa» de menos de 10 min no es descanso: 14:05, 14:56, 15:02 deja suelta la 15:02', () => {
    // Sumando a secas ganaría 14:56–15:02 (6 min) y la comida real de 51 min quedaría suelta.
    expect(PAUSA_MIN_CREIBLE).toBe(10);
    expect(marcaSinPareja(m('14:05', '14:56', '15:02'))).toBe(2);
  });

  it('empate: se deja la última, como antes', () => {
    expect(marcaSinPareja(m('10:00', '10:30', '11:00'))).toBe(2);
  });

  it('sólo puede quedar sola una de índice par (las de antes y después se emparejan de corrido)', () => {
    const r = marcaSinPareja(m('09:00', '10:40', '10:55', '14:00', '15:00'));
    expect(r).toBe(0);
    expect((r as number) % 2).toBe(0);
  });
});

describe('[RH.1.15] detalleDia — la pantalla usa la misma marca suelta', () => {
  it('07:00 · 10:28 · 14:33 · 15:02 · 18:00: comida de 29 min, no de 4 h 05', () => {
    const d = detalleDia(['07:00', '10:28', '14:33', '15:02', '18:00']);
    expect(d.comida).toBe('10:28 · 14:33 – 15:02');
    expect(d.comidaMin).toBe(29);
    expect(d.netasMin).toBe(11 * 60 - 29);
  });

  it('⛔ NEGATIVA — con número par de marcas nada cambia', () => {
    const d = detalleDia(['07:00', '10:00', '10:20', '14:00', '15:00', '18:00']);
    expect(d.comida).toBe('10:00 – 10:20 · 14:00 – 15:00');
    expect(d.netasMin).toBe(11 * 60 - 80);
  });
});

describe('[RH.1.15] alerta de desayuno — salta la misma marca suelta', () => {
  const marcas = (fecha: string, ...horas: string[]): ChecadaMin[] =>
    horas.map((h) => ({ fechaHora: `${fecha}T${h}:00`, hora: `${h}:00`, tipo: null }));
  const entrada = (checadas: ChecadaMin[]): EntradaDia => ({
    empleado: { sucursalId: 'prueba', codigo: '31', nombre: 'Prueba' },
    fecha: '2026-07-07', diaSemana: 2, cerrado: true,
    horario: { nombre: 'General', dias: [1, 2, 3, 4, 5], entrada: '07:00', salida: '18:00', toleranciaMin: 10 },
    config: CONFIG_DEFAULT, empleadoConActividadRango: true, checadas,
  });

  it('09:00 sin su salida, desayuno real 10:40–10:55, comida 14:00–15:00: NO es un desayuno de 100 min', () => {
    const r = analizarDia(entrada(marcas('2026-07-07', '07:00', '09:00', '10:40', '10:55', '14:00', '15:00', '18:00')));
    expect(r.map((x) => x.regla)).not.toContain('desayuno_excedido');
  });

  it('⛔ NEGATIVA — un desayuno de verdad largo (09:00–10:40, pares) sí alerta', () => {
    const r = analizarDia(entrada(marcas('2026-07-07', '07:00', '09:00', '10:40', '14:00', '15:00', '18:00')));
    expect(r.find((x) => x.regla === 'desayuno_excedido')?.evidencia['duracionMin']).toBe(100);
  });
});

// ── Persona con dos horarios: mañana 07:00–15:00 (comida 30) y tarde 13:00–20:00 (comida 60) ─────
const MANANA = ['07:00', '11:00', '11:30', '15:00'];
const TARDE = ['13:00', '16:00', '17:00', '20:00'];
/** Lunes a viernes; martes y jueves de tarde, el resto de mañana. `cambia(f)` mueve un día. */
function rota(cambia: (f: string) => string[] | null | undefined = () => undefined, over: Partial<EntradaAsistencia> = {}): EntradaAsistencia {
  const filas: FilaDia[] = [];
  for (const f of rangoFechas('2026-06-25', '2026-07-22')) {
    const dow = new Date(`${f}T12:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const c = cambia(f);
    if (c === null) continue;
    filas.push({ codigo: '21', nombreReloj: 'Rota P', fecha: f, horas: c ?? (dow === 2 || dow === 4 ? TARDE : MANANA) });
  }
  return {
    siteCode: 'tienda-prueba', desde: '2026-07-16', hasta: '2026-07-22', soloPromotoras: false,
    cfg: CONFIG_DEFAULT, filas,
    silencio: new Map([['21', 0]]), unaMarca: new Map([['21', { dias: filas.length, conUna: 0 }]]),
    padron: new Map([['21', {
      userId: 'u-21', registrado: true, nombre: 'Rota', nombreCompleto: 'PRUEBA ROTA', departamento: 'PISO',
      puesto: 'Vendedor', fotoUrl: null, activo: true,
    }]]),
    turnosConfirmados: new Map([['21', ['07:00', '13:00']]]),
    asignados: new Map([['21', dosHorarios()]]),
    revisiones: new Map(), incidencias: [],
    ...over,
  };
}
function dosHorarios(): HorarioAsignado {
  const h = [{ entrada: '07:00', salida: '15:00', comidaMin: 30 }, { entrada: '13:00', salida: '20:00', comidaMin: 60 }];
  return { ...h[0], horarios: h, sabado: false, sabadoEntrada: null, sabadoSalida: null, asignadoPor: 'RH prueba', actualizadoEn: null };
}
const persona = (e: EntradaAsistencia) => calcularAsistencia(e).personas.find((p) => p.codigo === '21');
const diaDe = (e: EntradaAsistencia, f: string) => persona(e)?.semanas.flatMap((s) => s.dias).find((d) => d.fecha === f);

describe('[RH.1.15] varios horarios por persona', () => {
  it('el martes de tarde (13:00) se mide contra el de la tarde: pedía 6 h y debía salir a las 20:00', () => {
    const e = rota();
    expect(diaDe(e, '2026-07-21')).toMatchObject({ turno: '13:00', referencia: '13:00', atrasoMin: 0, salidaEsperada: '20:00', esperadoMin: 360, comidaExcesoMin: 0 });
    expect(diaDe(e, '2026-07-20')).toMatchObject({ turno: '07:00', referencia: '07:00', atrasoMin: 0, salidaEsperada: '15:00' });
    expect(persona(e)?.turnos).toEqual(['07:00', '13:00']);
    expect(persona(e)?.marcas.find((x) => x.codigo === 'horario_confirmado')?.detalle).toContain('RH le asignó 2 horarios');
  });

  it('llegar 70 min tarde a la mañana (08:10) sigue siendo retardo del turno de la mañana (margen 120, no 60)', () => {
    const e = rota((f) => (f === '2026-07-20' ? ['08:10', '11:00', '11:30', '15:10'] : undefined));
    expect(diaDe(e, '2026-07-20')).toMatchObject({ turno: '07:00', atrasoMin: 70 });
  });

  it('llegar 13:40 al turno de la tarde son 40 min de retardo contra 13:00 (no 10 contra «otro turno» de 13:30)', () => {
    const e = rota((f) => (f === '2026-07-21' ? ['13:40', '16:00', '17:00', '20:00'] : undefined));
    expect(diaDe(e, '2026-07-21')).toMatchObject({ turno: '13:00', referencia: '13:00', atrasoMin: 40 });
  });

  it('⛔ NEGATIVA — con UN solo horario (el de la mañana) el martes de tarde pide 7 h 30 y debía salir a las 21:00', () => {
    const uno = dosHorarios();
    const solo = { ...uno, horarios: [uno.horarios[0]] };
    const e = rota(undefined, { asignados: new Map([['21', solo]]), turnosConfirmados: new Map([['21', ['07:00']]]) });
    // Comida de 60 contra 30 permitidos: 30 de exceso que con su horario de tarde no existe.
    expect(diaDe(e, '2026-07-21')).toMatchObject({ esperadoMin: 450, salidaEsperada: '21:00', comidaExcesoMin: 30 });
    expect(diaDe(e, '2026-07-21')).not.toHaveProperty('turno');
    expect(persona(e)?.marcas.find((x) => x.codigo === 'horario_confirmado')?.detalle).toContain('RH le asignó su horario: 07:00 a 15:00');
  });

  it('un día sin checadas toma el primer horario (y no dice turno)', () => {
    const e = rota((f) => (f === '2026-07-22' ? null : undefined));
    expect(diaDe(e, '2026-07-22')?.estado).toBe('falta');
    expect(diaDe(e, '2026-07-22')).not.toHaveProperty('turno');
  });
});

describe('[RH.1.15] horariosDeFila — qué de la fila se cree', () => {
  const dos = [{ entrada: '07:00', salida: '15:00', comidaMin: 30 }, { entrada: '13:00', salida: '21:00', comidaMin: '30' }];
  it('2 válidos que casan con sus entradas', () => {
    expect(horariosDeFila(dos, ['07:00', '13:00'])).toEqual([
      { entrada: '07:00', salida: '15:00', comidaMin: 30 }, { entrada: '13:00', salida: '21:00', comidaMin: 30 }]);
  });
  it('⛔ NEGATIVA — null (la fila se lee como antes): sin columna, con uno, sin casar con las entradas o con basura', () => {
    expect(horariosDeFila(null, ['07:00'])).toBeNull();
    expect(horariosDeFila([dos[0]], ['07:00'])).toBeNull();
    expect(horariosDeFila(dos, ['07:00'])).toBeNull();
    expect(horariosDeFila([dos[0], { entrada: 7 }], ['07:00', '13:00'])).toBeNull();
  });
});

describe('[RH.1.15] errorDeHorario — validación de varios horarios (texto de Mega Talento)', () => {
  const t = (starts_at: string, ends_at: string, lunch_minutes: number) => ({ starts_at, ends_at, lunch_minutes });
  it('dos horarios bien: sin error, y se guardan en la forma de Mega Talento', () => {
    const b = { shifts: [t('07:00', '15:00', 30), t('13:00', '21:00', 30)] };
    expect(errorDeHorario(b)).toBeNull();
    expect(horariosDelCuerpo(b)).toEqual([
      { entrada: '07:00', salida: '15:00', comidaMin: 30 }, { entrada: '13:00', salida: '21:00', comidaMin: 30 }]);
  });
  it('sin `shifts` es el horario de siempre', () => {
    expect(horariosDelCuerpo({ starts_at: '08:00', ends_at: '17:00', lunch_minutes: 60 })).toEqual([{ entrada: '08:00', salida: '17:00', comidaMin: 60 }]);
  });
  it('⛔ más de 4, dos con la misma entrada, o uno malo (dice cuál)', () => {
    expect(errorDeHorario({ shifts: [1, 2, 3, 4, 5].map((i) => t(`0${i}:00`, `0${i + 4}:00`, 0)) })).toBe('Se le pueden poner hasta 4 horarios.');
    expect(errorDeHorario({ shifts: [t('07:00', '15:00', 30), t('07:00', '16:00', 30)] })).toContain('Dos horarios no pueden empezar a la misma hora');
    expect(errorDeHorario({ shifts: [t('07:00', '15:00', 30), t('21:00', '13:00', 30)] })).toBe('La salida tiene que ser después de la entrada (horario 2).');
  });
});

// ── Incidencia «Descanso» (8dd5521) ─────────────────────────────────────────────────────────────
function lunesASabado(cambia: (f: string) => string[] | null | undefined, incidencias: IncidenciaVigente[]): EntradaAsistencia {
  const filas: FilaDia[] = [];
  for (const f of rangoFechas('2026-07-02', '2026-07-22')) {
    if (new Date(`${f}T12:00:00Z`).getUTCDay() === 0) continue;
    const c = cambia(f);
    if (c === null) continue;
    filas.push({ codigo: '15', nombreReloj: 'Ana R', fecha: f, horas: c ?? ['08:00', '13:00', '14:00', '18:00'] });
  }
  return {
    siteCode: 'cedis', desde: '2026-07-16', hasta: '2026-07-22', soloPromotoras: false, cfg: CONFIG_DEFAULT, filas,
    silencio: new Map([['15', 0]]), unaMarca: new Map([['15', { dias: filas.length, conUna: 0 }]]),
    padron: new Map([['15', { userId: 'u-15', registrado: true, nombre: 'Ana', nombreCompleto: 'PRUEBA UNO', departamento: 'ALMACEN', puesto: 'Auxiliar', fotoUrl: null, activo: true }]]),
    turnosConfirmados: new Map(), asignados: new Map(), revisiones: new Map(), incidencias,
  };
}
const inc = (tipo: string, desde: string, hasta = desde): IncidenciaVigente =>
  ({ id: `i-${tipo}-${desde}`, personCode: '15', tipo, desde, hasta, nota: 'prueba', minutos: null });
const ana = (e: EntradaAsistencia) => calcularAsistencia(e).personas.find((p) => p.codigo === '15');
const diaAna = (e: EntradaAsistencia, f: string) => ana(e)?.semanas.flatMap((s) => s.dias).find((d) => d.fecha === f);

describe('[RH.1.15] incidencia «Descanso»', () => {
  it('no vino el lunes 20 con «Descanso»: es su descanso, no falta, y su domingo sigue siendo descanso', () => {
    const e = lunesASabado((f) => (f === '2026-07-20' ? null : undefined), [inc('descanso', '2026-07-20')]);
    expect(diaAna(e, '2026-07-20')).toMatchObject({ estado: 'descanso', descansoCambio: 'descansa' });
    expect(diaAna(e, '2026-07-19')?.estado).toBe('descanso');
    expect(ana(e)?.faltas).toBe(0);
    expect(ana(e)?.faltasJustificadas).toBe(0);
  });

  it('vacaciones del 16 al 22 con «Descanso» el lunes 20: ese día es descanso, no vacaciones (no cuenta como justificado)', () => {
    const fuera = (f: string) => (f >= '2026-07-16' && f <= '2026-07-22' ? null : undefined);
    const con = lunesASabado(fuera, [inc('vacaciones', '2026-07-16', '2026-07-22'), inc('descanso', '2026-07-20')]);
    const sin = lunesASabado(fuera, [inc('vacaciones', '2026-07-16', '2026-07-22')]);
    expect(diaAna(con, '2026-07-20')?.estado).toBe('descanso');
    // ⛔ NEGATIVA — sin el «Descanso», el lunes 20 es un día de vacaciones más.
    expect(diaAna(sin, '2026-07-20')?.estado).toBe('justificado');
    expect((ana(sin)?.faltasJustificadas ?? 0) - (ana(con)?.faltasJustificadas ?? 0)).toBe(1);
  });
});
