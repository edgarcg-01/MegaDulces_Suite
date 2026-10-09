import { asistencia, dia, persona } from '../../../testing/rh.fixture';
import {
  SIN_DEPARTAMENTO, celdaDe, columnasDelRango, diasPorFecha, etiquetaParcial, faltasDelPeriodo, firmaHoras, horarioDe, horasTexto,
  irregularidadesDe, pausasDelDia, porDepartamento, rebasados, tramosDe,
} from './reporte-formato';

/**
 * `[RH.1.7c]` Cómo se dice cada día en el reporte «calcado» de Mega Talento. Lo que se defiende: el papel se lee
 * igual que allá (0 - 0 es falta, VAC es vacaciones, DESC. es el descanso que se movió), y el DÍA EN CURSO no se
 * acusa (a las 7 de la mañana nadie ha faltado todavía).
 */
const HOY = '2026-10-08';
const o = { hoy: HOY, mideRetardo: true };
const una = (d = dia()) => { const p = persona({ semanas: [{ ...persona().semanas[0], dias: [d] }] }); return { p, m: diasPorFecha(p) }; };

describe('[RH.1.7c] celdaDe — un día en el papel', () => {
  it('un día normal: jornada, pausas y D/C', () => {
    const { p, m } = una(dia({ fecha: '2026-10-05', entrada: '07:56', salida: '17:04', comida: '11:02 – 11:24 · 14:01 – 15:00', desayunoMin: 22, comidaMin: 59 }));
    const c = celdaDe(p, m, '2026-10-05', o);
    expect([c.tipo, c.jornada, c.tramos, c.desMin, c.comMin]).toEqual(['dia', '07:56 - 17:04', ['11:02–11:24', '14:01–15:00'], 22, 59]);
    expect(c.tarde).toBe(false);
  });

  it('tarde en rojo sólo donde la plaza mide retardo', () => {
    const { p, m } = una(dia({ fecha: '2026-10-05', entrada: '08:47', atrasoMin: 17 }));
    expect(celdaDe(p, m, '2026-10-05', o).tarde).toBe(true);
    expect(celdaDe(p, m, '2026-10-05', { ...o, mideRetardo: false }).tarde).toBe(false);
  });

  it('excesos en ámbar y salida antes de hora', () => {
    const { p, m } = una(dia({ fecha: '2026-10-05', desayunoMin: 41, desayunoExcesoMin: 11, comidaMin: 72, comidaExcesoMin: 12, salidaAntesMin: 40 }));
    const c = celdaDe(p, m, '2026-10-05', o);
    expect([c.desExcedido, c.comExcedida, c.salioAntes]).toEqual([true, true, true]);
    expect(c.titulo).toContain('salió 40 min antes');
  });

  it('falta = «0 - 0»; con incidencia que no la justifica, su código', () => {
    const { p, m } = una(dia({ fecha: '2026-10-06', estado: 'falta', entrada: null, salida: null }));
    expect(celdaDe(p, m, '2026-10-06', o)).toMatchObject({ tipo: 'falta', jornada: '0 - 0' });
    const fi = una(dia({ fecha: '2026-10-06', estado: 'falta', incidencias: [{ id: 'x', tipo: 'falta_injustificada', codigo: 'FI', etiqueta: 'Falta injustificada', nota: '' }] }));
    expect(celdaDe(fi.p, fi.m, '2026-10-06', o)).toMatchObject({ tipo: 'falta', jornada: 'FI' });
  });

  it('⛔ HOY no es falta todavía: «·», sin rojo', () => {
    const { p, m } = una(dia({ fecha: HOY, estado: 'falta', entrada: null, salida: null }));
    expect(celdaDe(p, m, HOY, o)).toMatchObject({ tipo: 'sin_checar_hoy', jornada: '·' });
  });

  it('⛔ HOY con checadas: sigue en su jornada (la última marca no es su salida)', () => {
    const { p, m } = una(dia({ fecha: HOY, entrada: '07:58', salida: '11:25' }));
    expect(celdaDe(p, m, HOY, o)).toMatchObject({ tipo: 'curso', jornada: '07:58 - …' });
  });

  it('una sola marca: «08:02 - 0», en rojo', () => {
    const { p, m } = una(dia({ fecha: '2026-10-06', estado: 'marca_faltante', hora: '08:02', entrada: null, salida: null }));
    expect(celdaDe(p, m, '2026-10-06', o)).toMatchObject({ tipo: 'marca', jornada: '08:02 - 0' });
  });

  it('descanso «—», descanso movido «DESC.», justificado «JUST.»', () => {
    const d1 = una(dia({ fecha: '2026-10-04', estado: 'descanso' }));
    expect(celdaDe(d1.p, d1.m, '2026-10-04', o).jornada).toBe('—');
    const d2 = una(dia({ fecha: '2026-10-05', estado: 'descanso', descansoPorAusencia: true }));
    expect(celdaDe(d2.p, d2.m, '2026-10-05', o).jornada).toBe('DESC.');
    const d3 = una(dia({ fecha: '2026-10-05', estado: 'justificado' }));
    expect(celdaDe(d3.p, d3.m, '2026-10-05', o).jornada).toBe('JUST.');
  });

  it('vacaciones de la semana entera: el código sale aunque no haya días que pintar', () => {
    const p = persona({ semanas: [], incidencias: [{ id: 'v', tipo: 'vacaciones', codigo: 'VAC', etiqueta: 'Vacaciones', nota: '', desde: '2026-10-05', hasta: '2026-10-06' }] });
    expect(celdaDe(p, diasPorFecha(p), '2026-10-05', o)).toMatchObject({ tipo: 'inc', jornada: 'VAC' });
    expect(celdaDe(p, diasPorFecha(p), '2026-10-07', o).tipo).toBe('vacio');
  });
});

describe('[RH.1.7c] pausas, horas y horario', () => {
  it('tramos del texto del servidor, con una salida sin regreso sola', () => {
    expect(tramosDe('10:58 – 11:14 · 14:02 – 14:58')).toEqual(['10:58–11:14', '14:02–14:58']);
    expect(tramosDe('14:02 – 14:58 · 17:30')).toEqual(['14:02–14:58', '17:30']);
    expect(tramosDe('—')).toEqual([]);
  });

  it('el desayuno es la pausa que dura lo que dice el servidor; la comida, el resto', () => {
    expect(pausasDelDia(dia({ comida: '11:02 – 11:24 · 14:01 – 15:00', desayunoMin: 22 }))).toEqual({ desayuno: '11:02–11:24', comida: '14:01–15:00' });
    expect(pausasDelDia(dia({ comida: '11:22 – 12:21', desayunoMin: null }))).toEqual({ desayuno: null, comida: '11:22–12:21' });
  });

  it('horas y diferencia contra el horario como en Mega Talento', () => {
    expect(horasTexto(2750)).toBe('45h 50m');
    expect(horasTexto(0)).toBe('—');
    expect(firmaHoras(70)).toBe('+1h 10m');
    expect(firmaHoras(-40)).toBe('−0h 40m');
    expect(firmaHoras(null)).toBe('');
  });

  it('la columna Horario: asignado, rotativo o deducido', () => {
    expect(horarioDe(persona({ horarioAsignado: { entrada: '08:00', salida: '17:00', comidaMin: 60, sabado: false, sabadoEntrada: null, sabadoSalida: null, asignadoPor: null, actualizadoEn: null } })))
      .toEqual({ texto: '08:00–17:00', asignado: true });
    expect(horarioDe(persona({ turnos: ['09:00', '13:00'] })).texto).toBe('Rota · 09:00 / 13:00');
    expect(horarioDe(persona({ horario: '08:30', turnos: ['08:30'] })).texto).toBe('Deducido · 8:30 am');
  });

  it('una columna por día, con hoy marcado', () => {
    const c = columnasDelRango('2026-10-08', '2026-10-14', HOY);
    expect(c.map((x) => `${x.dow} ${x.dia}`)).toEqual(['Jue 8', 'Vie 9', 'Sáb 10', 'Dom 11', 'Lun 12', 'Mar 13', 'Mié 14']);
    expect(c[0].hoy).toBe(true);
  });
});

describe('[RH.1.7c] irregularidades (la fila en rojo)', () => {
  const conDias = (...dias: ReturnType<typeof dia>[]) => persona({ semanas: [{ ...persona().semanas[0], dias }] });
  const irr = (p: ReturnType<typeof persona>) => irregularidadesDe(p, { hoy: HOY, desayunoAlertaMin: 10 });

  it('falta y retardo son altas; dentro de la tolerancia se lista pero no pinta', () => {
    const r = irr(conDias(
      dia({ fecha: '2026-10-05', estado: 'falta' }),
      dia({ fecha: '2026-10-06', estado: 'retardo', atrasoMin: 20, retardoRealMin: 5 }),
      dia({ fecha: '2026-10-07', estado: 'absorbido', atrasoMin: 6 }),
    ));
    expect(r.map((i) => `${i.tipo}:${i.nivel}`)).toEqual(['falta:alta', 'retardo:alta', 'tolerancia:alta']);
    expect(r[1].texto).toBe('Llegó 20 min tarde (5 fuera de tolerancia)');
  });

  it('⛔ hoy no cuenta, y un día justificado por incidencia tampoco', () => {
    const r = irr(conDias(
      dia({ fecha: HOY, estado: 'falta' }),
      dia({ fecha: '2026-10-05', estado: 'falta', incidencias: [{ id: 'p', tipo: 'permiso_con_goce', codigo: 'PCG', etiqueta: 'Permiso', nota: '' }] }),
    ));
    expect(r).toEqual([]);
  });

  it('⛔ con el número bloqueado el retardo no acusa', () => {
    const p = persona({ usable: false, semanas: [{ ...persona().semanas[0], dias: [dia({ fecha: '2026-10-05', atrasoMin: 30, retardoRealMin: 15 })] }] });
    expect(irr(p)).toEqual([]);
  });

  it('desayuno excedido (alta) y una sola marca (baja)', () => {
    const r = irr(conDias(dia({ fecha: '2026-10-05', desayunoExcesoMin: 11 }), dia({ fecha: '2026-10-06', estado: 'marca_faltante' })));
    expect(r.map((i) => `${i.tipo}:${i.nivel}`)).toEqual(['desayuno:alta', 'una_marca:baja']);
  });
});

describe('[RH.1.7c] lo que cuentan las pestañas y el agrupado', () => {
  it('Tolerancia: los usables primero, el resto «por confirmar»', () => {
    const r = rebasados(asistencia([
      persona({ codigo: '1', retardoRealMin: 8 }), persona({ codigo: '2', retardoRealMin: 28 }),
      persona({ codigo: '3', retardoRealMin: 5, usable: false }), persona({ codigo: '4', retardoRealMin: 0 }),
    ]));
    expect(r.usables.map((p) => p.codigo)).toEqual(['2', '1']);
    expect(r.porConfirmar.map((p) => p.codigo)).toEqual(['3']);
  });

  it('⛔ Faltas no cuenta la de hoy', () => {
    const d = asistencia([persona({ semanas: [{ ...persona().semanas[0], dias: [dia({ fecha: '2026-10-07', estado: 'falta' }), dia({ fecha: HOY, estado: 'falta' })] }] })]);
    expect(faltasDelPeriodo(d, HOY).map((f) => f.fecha)).toEqual(['2026-10-07']);
  });

  it('por departamento, en orden, con «sin departamento» al final y el total del departamento completo', () => {
    const a = persona({ codigo: '1', nombreCompleto: 'Zeta', departamento: 'Sistemas · sistemas' });
    const b = persona({ codigo: '2', nombreCompleto: 'Alfa', departamento: 'Sistemas · sistemas' });
    const c = persona({ codigo: '3', departamento: null });
    const d = persona({ codigo: '4', departamento: 'Compras · compras' });
    const g = porDepartamento([a, b, c, d], [a, c, d]);
    expect(g.map((x) => `${x.departamento}:${x.personas.length}/${x.total}`)).toEqual(['COMPRAS:1/1', 'SISTEMAS:1/2', `${SIN_DEPARTAMENTO}:1/1`]);
    expect(porDepartamento([a, b], [a, b])[0].personas.map((p) => p.nombreCompleto)).toEqual(['Alfa', 'Zeta']);
  });

  it('los reportes parciales dicen que lo son', () => {
    expect(etiquetaParcial({ unica: null, departamentos: ['SISTEMAS'], buscar: '', soloIrregulares: false })).toBe('solo SISTEMAS');
    expect(etiquetaParcial({ unica: null, departamentos: [], buscar: ' ana ', soloIrregulares: true })).toBe('quien coincide con «ana» · sólo con irregularidades');
    expect(etiquetaParcial({ unica: null, departamentos: [], buscar: '', soloIrregulares: false })).toBe('');
  });
});
