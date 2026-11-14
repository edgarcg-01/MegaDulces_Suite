// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import {
  avanceDe, diaSemanaIso, estadoPunto, motivoNoEntregable, tieneEvidencia, tocaEnFecha, validarHora, validarPuntos,
  type PuntoChecklist,
} from './checklist.contract';

const P = (id: string, evidence: PuntoChecklist['evidence']): PuntoChecklist => ({
  id, label: 'Punto ' + id, block: null, evidence,
  accepts_documents: false, requires_amount: false, requires_folio: false, requires_comment: false,
});

describe('[MDT.1.4] tieneEvidencia — hecho = con evidencia (regla de MDTask, Fase 2.1)', () => {
  it('un punto de fotos sin foto subida NO está hecho, aunque esté marcado', () => {
    expect(tieneEvidencia(P('p0', 'photos'), { checked: true }, 0)).toBe(false);
  });
  it('un punto de fotos con una foto subida está hecho', () => {
    expect(tieneEvidencia(P('p0', 'photos'), null, 1)).toBe(true);
  });
  it('texto: sólo espacios no es evidencia', () => {
    expect(tieneEvidencia(P('p0', 'text'), { text: '   ' }, 0)).toBe(false);
    expect(tieneEvidencia(P('p0', 'text'), { text: 'Cubrió Ana' }, 0)).toBe(true);
  });
  it('listado: necesita al menos un renglón con algo', () => {
    expect(tieneEvidencia(P('p0', 'list'), { list: ['', '  '] }, 0)).toBe(false);
    expect(tieneEvidencia(P('p0', 'list'), { list: ['', 'Pendiente de surtir'] }, 0)).toBe(true);
  });
  it('una foto NO vuelve hecho un punto de texto (no se piden dos pruebas ni se cambia una por otra)', () => {
    expect(tieneEvidencia(P('p0', 'text'), {}, 3)).toBe(false);
  });
  it('none: se cierra con la marca', () => {
    expect(tieneEvidencia(P('p0', 'none'), { checked: true }, 0)).toBe(true);
    expect(tieneEvidencia(P('p0', 'none'), { checked: false }, 0)).toBe(false);
  });
  it('prueba negativa: una evidencia desconocida NO cae a hecho', () => {
    expect(tieneEvidencia({ evidence: 'firma' as never }, { checked: true, text: 'x' }, 5)).toBe(false);
  });
});

describe('[MDT.1.4] estadoPunto — justificado no es hecho', () => {
  it('sin evidencia y sin nota → no_ejecutado', () => {
    expect(estadoPunto(P('p0', 'photos'), null, 0, {})).toBe('no_ejecutado');
  });
  it('sin evidencia y con nota → justificado (no hecho)', () => {
    expect(estadoPunto(P('p0', 'photos'), null, 0, { employee_note: 'No había luz' })).toBe('justificado');
  });
  it('entrega tarde cuenta como justificación, como en MDTask', () => {
    expect(estadoPunto(P('p0', 'photos'), null, 0, { submitted_late: true })).toBe('justificado');
  });
  it('con evidencia es hecho aunque haya nota', () => {
    expect(estadoPunto(P('p0', 'photos'), null, 1, { employee_note: 'x' })).toBe('hecho');
  });
});

describe('[MDT.1.4] motivoNoEntregable / avanceDe', () => {
  const puntos = [P('p0', 'photos'), P('p1', 'text')];
  it('todo con evidencia → se entrega', () => {
    expect(motivoNoEntregable(puntos, { p1: { text: 'ok' } }, { p0: 2 }, null)).toBeNull();
  });
  it('falta evidencia y no hay nota → se dice cuántos faltan', () => {
    expect(motivoNoEntregable(puntos, {}, { p0: 1 }, '')).toMatch(/Faltan 1 de 2/);
  });
  it('falta evidencia pero hay nota → se entrega, y lo que falta queda justificado', () => {
    expect(motivoNoEntregable(puntos, {}, {}, 'Se cayó el sistema')).toBeNull();
    expect(avanceDe(puntos, {}, {}, { employee_note: 'Se cayó el sistema' }))
      .toEqual({ total: 2, hechos: 0, justificados: 2, sin_ejecutar: 0 });
  });
  it('avance sin nota: lo que falta es sin ejecutar', () => {
    expect(avanceDe(puntos, { p1: { text: 'ok' } }, {}, {})).toEqual({ total: 2, hechos: 1, justificados: 0, sin_ejecutar: 1 });
  });
});

describe('[MDT.1.3] tocaEnFecha — la tarea del día se deriva de la norma', () => {
  it('diaSemanaIso: 2026-11-13 es viernes (5) y 2026-11-15 domingo (7)', () => {
    expect(diaSemanaIso('2026-11-13')).toBe(5);
    expect(diaSemanaIso('2026-11-15')).toBe(7);
  });
  it('diaria toca siempre', () => {
    expect(tocaEnFecha({ frequency: 'daily', weekday: null, month_day: null }, '2026-11-15')).toBe(true);
  });
  it('semanal sólo en su día', () => {
    const viernes = { frequency: 'weekly' as const, weekday: 5, month_day: null };
    expect(tocaEnFecha(viernes, '2026-11-13')).toBe(true);
    expect(tocaEnFecha(viernes, '2026-11-12')).toBe(false);
  });
  it('mensual en su día; un 31 en un mes de 30 cae en el último día', () => {
    expect(tocaEnFecha({ frequency: 'monthly', weekday: null, month_day: 28 }, '2026-11-28')).toBe(true);
    expect(tocaEnFecha({ frequency: 'monthly', weekday: null, month_day: 28 }, '2026-11-27')).toBe(false);
    expect(tocaEnFecha({ frequency: 'monthly', weekday: null, month_day: 31 }, '2026-11-30')).toBe(true);
    expect(tocaEnFecha({ frequency: 'monthly', weekday: null, month_day: 31 }, '2026-02-28')).toBe(true);
  });
  it('por evento nunca se deriva', () => {
    expect(tocaEnFecha({ frequency: 'event', weekday: null, month_day: null }, '2026-11-13')).toBe(false);
  });
  it('prueba negativa: una fecha mal formada no toca', () => {
    expect(tocaEnFecha({ frequency: 'daily', weekday: null, month_day: null }, '13/11/2026')).toBe(false);
  });
});

describe('[MDT.2.2] validarPuntos', () => {
  it('acepta puntos bien formados', () => {
    expect(validarPuntos([P('p0', 'photos'), P('p1', 'list')])).toBeNull();
  });
  it('rechaza vacío, ids repetidos y evidencia desconocida', () => {
    expect(validarPuntos([])).toMatch(/al menos un punto/);
    expect(validarPuntos([P('p0', 'photos'), P('p0', 'text')])).toMatch(/repetido/);
    expect(validarPuntos([{ ...P('p0', 'photos'), evidence: 'firma' }])).toMatch(/evidencia/);
  });
});

describe('[MDT.3.2b] validarHora — la hora límite de la norma', () => {
  it('acepta HH:MM de 24 horas', () => {
    expect(validarHora('10:00')).toBeNull();
    expect(validarHora('23:59')).toBeNull();
    expect(validarHora('00:01')).toBeNull();
  });
  it('rechaza medianoche, horas fuera de rango y formatos sueltos (negativas)', () => {
    for (const mala of ['00:00', '24:00', '9:00', '10:60', '10.00', '', ' 10:00', null, 1000]) {
      expect(validarHora(mala)).toMatch(/HH:MM/);
    }
  });
});
