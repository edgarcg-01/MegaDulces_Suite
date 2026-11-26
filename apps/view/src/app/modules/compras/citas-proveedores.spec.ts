import { describe, it, expect } from 'vitest';
import { ETIQUETA_SITUACION_REUNION, SITUACIONES_REUNION, type AgendaCitas, type AgendarReunionDto, type ReunionVista } from '@megadulces/contracts';
import {
  aniosDelPlan, choqueEnPalabras, diaCorto, diaLargo, dtoDeReunion, faltaParaGuardar, fechaDeIso, fechaIso, finSugerido, HORAS, lugarEnPalabras,
  primeraDelDia, proveedorEnPalabras, quienVa, rangoSemana, relativo, respuesta, SEVERIDAD_SITUACION, sumarDiasIso, tipoEnPalabras,
} from './citas-proveedores';

/** `[PQ.3.8]` Citas · C3: lo que la pantalla dice, sin Angular. */

const reunion = (o: Partial<ReunionVista> = {}): ReunionVista => ({
  id: 'r1', supplier_code: 'PRV01', supplier_name: 'Dulcería Alfa', kind: 'executive', status: 'scheduled', situacion: 'agendada',
  acciones: ['editar', 'cancelar'], date: '2026-12-02', start_time: '10:00', end_time: '11:00', starts_at: '2026-12-02T16:00:00Z',
  ends_at: '2026-12-02T17:00:00Z', mode: 'in_person', location: 'Sala de juntas', topics: ['Precios'], work_plan_year: null,
  organizer: { user_id: 'u1', nombre: 'Ana López' },
  participants: [
    { id: 'p1', side: 'internal', user_id: 'u1', nombre: 'Ana López', area: 'compras', job_title: null },
    { id: 'p2', side: 'internal', user_id: 'u2', nombre: 'Luis Pérez', area: 'marketing', job_title: null },
    { id: 'p3', side: 'supplier', user_id: null, nombre: 'Ejecutivo', area: null, job_title: 'Gerente' },
  ],
  minutes: null, minutes_by: null, minutes_at: null, cancelled_reason: null, cancelled_by: null, cancelled_at: null, choques: [], ...o,
});

const agenda = (o: Partial<AgendaCitas> = {}): AgendaCitas => ({
  hoy: '2026-11-26', semana: { desde: '2026-11-23', hasta: '2026-11-29' }, reuniones: [],
  sin_minuta: { total: 0, tope: 50, reuniones: [] }, por_confirmar: 0, ...o,
});

describe('[PQ.3.8] fechas en palabras', () => {
  it('día largo y corto, con el día de la semana correcto', () => {
    expect(diaLargo('2026-12-02')).toBe('miércoles 2 de diciembre');
    expect(diaCorto('2026-11-29')).toBe('dom 29 nov');
  });

  it('el rango de la semana: mismo mes, cruzando mes y cruzando año', () => {
    expect(rangoSemana({ desde: '2026-11-23', hasta: '2026-11-29' })).toBe('23 al 29 de noviembre de 2026');
    expect(rangoSemana({ desde: '2026-11-30', hasta: '2026-12-06' })).toBe('30 de noviembre al 6 de diciembre de 2026');
    expect(rangoSemana({ desde: '2026-12-28', hasta: '2027-01-03' })).toBe('28 de diciembre de 2026 al 3 de enero de 2027');
  });

  it('relativo a hoy y sumar días sin brincar por el horario', () => {
    expect(relativo('2026-11-26', '2026-11-26')).toBe('hoy');
    expect(relativo('2026-11-25', '2026-11-26')).toBe('ayer');
    expect(relativo('2026-11-27', '2026-11-26')).toBe('mañana');
    expect(relativo('2026-11-20', '2026-11-26')).toBe('hace 6 días');
    expect(relativo('2026-12-03', '2026-11-26')).toBe('en 7 días');
    expect(sumarDiasIso('2026-11-30', 7)).toBe('2026-12-07');
    expect(sumarDiasIso('2027-01-01', -7)).toBe('2026-12-25');
  });

  it('el selector de fecha y la API hablan del mismo día (sin pasar por UTC)', () => {
    const d = fechaDeIso('2026-12-02');
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 11, 2]);
    expect(fechaIso(new Date(2026, 11, 2, 23, 30))).toBe('2026-12-02'); // de noche sigue siendo el 2
  });
});

describe('[PQ.3.8] la reunión en palabras', () => {
  it('quién va: los de la casa por nombre y cuántos del proveedor', () => {
    expect(quienVa(reunion())).toBe('Ana López, Luis Pérez · 1 del proveedor');
    expect(quienVa(reunion({ participants: [] }))).toBe('Nadie de Mega Dulces');
  });

  it('sin ficha, la clave (no se inventa un nombre)', () => {
    expect(proveedorEnPalabras(reunion())).toBe('Dulcería Alfa');
    expect(proveedorEnPalabras(reunion({ supplier_name: null }))).toBe('Clave PRV01');
  });

  it('el tipo con su año en el plan de trabajo; lugar con modalidad', () => {
    expect(tipoEnPalabras(reunion({ kind: 'work_plan', work_plan_year: 2027 }))).toBe('Plan de trabajo 2027');
    expect(tipoEnPalabras(reunion())).toBe('Cita con ejecutivo');
    expect(lugarEnPalabras(reunion())).toBe('En persona · Sala de juntas');
    expect(lugarEnPalabras(reunion({ mode: 'video', location: null }))).toBe('Videollamada');
  });

  it('cada situación tiene etiqueta y color', () => {
    for (const s of SITUACIONES_REUNION) { expect(ETIQUETA_SITUACION_REUNION[s]).toBeTruthy(); expect(SEVERIDAD_SITUACION[s]).toBeTruthy(); }
  });

  it('el choque dice con quién y a qué hora', () => {
    expect(choqueEnPalabras({ user_id: 'u1', nombre: 'Ana López', meeting_id: 'r2', supplier_code: 'X1', supplier_name: null, start_time: '10:30', end_time: '12:00' }))
      .toBe('Ana López también tiene reunión con la clave X1 de 10:30 a 12:00.');
  });
});

describe('[PQ.3.8] la respuesta de arriba (Q.1)', () => {
  it('semana vacía y nada pendiente', () => {
    expect(respuesta(agenda())).toBe('Esta semana: sin reuniones.');
  });

  it('cuenta las vivas (no las canceladas) y dice lo pendiente de antes', () => {
    const a = agenda({
      reuniones: [reunion(), reunion({ id: 'r2', situacion: 'cancelada' }), reunion({ id: 'r3' })],
      sin_minuta: { total: 1, tope: 50, reuniones: [] }, por_confirmar: 2,
    });
    expect(respuesta(a)).toBe('Esta semana: 2 reuniones. 1 reunión ya pasó sin minuta. 2 siguen por confirmar.');
  });

  it('otra semana se nombra por su rango', () => {
    expect(respuesta(agenda({ semana: { desde: '2026-11-30', hasta: '2026-12-06' }, reuniones: [reunion()] })))
      .toBe('Del 30 de noviembre al 6 de diciembre de 2026: 1 reunión.');
  });

  it('la fecha se pinta en el primer renglón de cada día', () => {
    const l = [reunion(), reunion({ id: 'b' }), reunion({ id: 'c', date: '2026-12-03' })];
    expect(l.map((_, i) => primeraDelDia(l, i))).toEqual([true, false, true]);
  });
});

describe('[PQ.3.8] el formulario', () => {
  it('horas cada 15 minutos de 06:00 a 22:00, y el fin una hora después', () => {
    expect(HORAS[0]).toBe('06:00');
    expect(HORAS[HORAS.length - 1]).toBe('22:00');
    expect(HORAS).toHaveLength(65);
    expect(finSugerido('10:15')).toBe('11:15');
    expect(finSugerido('21:30')).toBe('22:00');
    expect(aniosDelPlan('2026-11-26')).toEqual([2026, 2027]);
  });

  it('editar lleva los id de la gente que ya estaba (para que la API sepa a quién conserva)', () => {
    const dto = dtoDeReunion(reunion());
    expect(dto.participants).toEqual([
      { id: 'p1', side: 'internal', user_id: 'u1', area: 'compras' },
      { id: 'p2', side: 'internal', user_id: 'u2', area: 'marketing' },
      { id: 'p3', side: 'supplier', name: 'Ejecutivo', job_title: 'Gerente' },
    ]);
    expect(dto.date).toBe('2026-12-02');
    expect(dto).not.toHaveProperty('status');
  });

  it('lo que falta para guardar, en una frase', () => {
    const base: AgendarReunionDto = dtoDeReunion(reunion());
    expect(faltaParaGuardar(base)).toBeNull();
    expect(faltaParaGuardar({ ...base, supplier_code: '' })).toBe('Elige el proveedor.');
    expect(faltaParaGuardar({ ...base, end_time: '10:00' })).toBe('La hora de fin va después de la de inicio.');
    expect(faltaParaGuardar({ ...base, kind: 'work_plan', work_plan_year: null })).toBe('Elige el año del plan de trabajo.');
    expect(faltaParaGuardar({ ...base, participants: [{ side: 'supplier', name: 'Ejecutivo' }] })).toBe('Agrega al menos a una persona de Mega Dulces.');
    expect(faltaParaGuardar({ ...base, participants: [...base.participants, { side: 'internal', user_id: null, area: 'compras' }] })).toMatch(/Completa la persona/);
    expect(faltaParaGuardar({ ...base, participants: [...base.participants, { side: 'supplier', name: '  ' }] })).toMatch(/nombre de cada quien va por el proveedor/);
  });
});
