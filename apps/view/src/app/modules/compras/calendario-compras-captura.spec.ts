import {
  anclaPorOmision, avisoDeGuardado, cadenciaDeLaRegla, camposDeCadencia, plazasDeLosLugares, puestoLegible,
} from './calendario-compras-captura';
import { corrimientoEnPalabras, patronEnPalabras } from './calendario-compras-reglas';
import type { PatronDeRegla } from '@megadulces/contracts';

/** Las mejoras de los usuarios (anexo C §10.12): cadencia (PQ.3.15), varias zonas (PQ.3.21) y responsable (PQ.3.22). */
const semana = (weekdays: number[], extra: Partial<PatronDeRegla> = {}): PatronDeRegla => ({
  pattern: 'weekdays', weekdays, month_days: null, month_last_day: false, every_n_days: null, weekend_shift: 'friday', ...extra,
});

describe('[PQ.3.15] la cadencia, en palabras', () => {
  it('cada N semanas dice cuántas y qué días, y debajo desde cuándo', () => {
    const r = semana([2], { week_interval: 2, week_anchor: '2026-11-24' });
    expect(patronEnPalabras(r)).toBe('Cada 2 semanas, en martes');
    expect(corrimientoEnPalabras(r)).toBe('A partir del mar 24 nov');
    expect(patronEnPalabras(semana([1, 4], { week_interval: 3, week_anchor: '2026-11-23' }))).toBe('Cada 3 semanas, en lunes y jueves');
    expect(patronEnPalabras(semana([1, 2, 3, 4, 5], { week_interval: 6, week_anchor: '2026-11-23' }))).toBe('Cada 6 semanas, de lunes a viernes');
  });
  it('una vez al mes: el primero… el último', () => {
    expect(patronEnPalabras(semana([2], { month_week: 1 }))).toBe('El primer martes de cada mes');
    expect(patronEnPalabras(semana([5], { month_week: 5 }))).toBe('El último viernes de cada mes');
    expect(patronEnPalabras(semana([1, 3], { month_week: 3 }))).toBe('El tercer lunes y miércoles de cada mes');
  });
  it('NEGATIVA: sin cadencia, como antes (y sin línea de abajo)', () => {
    expect(patronEnPalabras(semana([3]))).toBe('Cada miércoles');
    expect(patronEnPalabras(semana([1, 2, 3, 4, 5]))).toBe('De lunes a viernes');
    expect(corrimientoEnPalabras(semana([3]))).toBeNull();
  });
});

describe('[PQ.3.15] la cadencia, de ida y vuelta entre la regla y el formulario', () => {
  it('lo que guarda cada opción, y de regreso', () => {
    expect(camposDeCadencia('semana', '2026-11-24', 1)).toEqual({ week_interval: null, week_anchor: null, month_week: null });
    expect(camposDeCadencia('2', '2026-11-24', 1)).toEqual({ week_interval: 2, week_anchor: '2026-11-24', month_week: null });
    expect(camposDeCadencia('mes', '2026-11-24', 5)).toEqual({ week_interval: null, week_anchor: null, month_week: 5 });
    expect(cadenciaDeLaRegla({ week_interval: 6, week_anchor: '2026-11-27', month_week: null })).toEqual({ cadencia: '6', ancla: '2026-11-27', mesSemana: 1 });
    expect(cadenciaDeLaRegla({ week_interval: null, week_anchor: null, month_week: 4 })).toEqual({ cadencia: 'mes', ancla: null, mesSemana: 4 });
    expect(cadenciaDeLaRegla({})).toEqual({ cadencia: 'semana', ancla: null, mesSemana: 1 });
  });
  it('«a partir del» por omisión: el primer día elegido desde hoy (incluido); sin días, hoy', () => {
    expect(anclaPorOmision('2026-11-21', [2])).toBe('2026-11-24');   // sábado → martes
    expect(anclaPorOmision('2026-11-24', [2, 5])).toBe('2026-11-24'); // hoy es martes
    expect(anclaPorOmision('2026-11-21', [])).toBe('2026-11-21');
  });
});

describe('[PQ.3.21] y [PQ.3.22] lugares, sucursales y responsable', () => {
  const Z = [{ code: 'LP', nombre: 'La Piedad', sucursales: ['01', '02', '03', '04'] }, { code: 'MOR', nombre: 'Morelia', sucursales: ['07', '08'] }];
  const TODAS = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];
  it('las sucursales que cubre lo capturado', () => {
    expect(plazasDeLosLugares('corporate', [], Z, TODAS)).toEqual(TODAS);
    expect(plazasDeLosLugares('zone', ['LP', 'MOR'], Z, TODAS)).toEqual(['01', '02', '03', '04', '07', '08']);
    expect(plazasDeLosLugares('branch', ['04', '04', '05'], Z, TODAS)).toEqual(['04', '05']);
  });
  it('el puesto se lee, sin inventar nombres', () => {
    expect(puestoLegible('gerente_compras')).toBe('Gerente compras');
    expect(puestoLegible('almacenista')).toBe('Almacenista');
    expect(puestoLegible(null)).toBe('Sin puesto');
  });
  it('el aviso de un lugar es el de siempre; el de varios dice cuántas y qué pasó con cada una', () => {
    const nombre = (l: string | null) => (l === 'LP' ? 'zona La Piedad' : l === 'ZAM' ? 'zona Zamora' : 'todas las sucursales');
    expect(avisoDeGuardado({ reglas: [{ lugar: null, id: 'A', accion: 'actualizada' }] }, 'CONFITERÍA', 'El 15 y el último de cada mes', nombre))
      .toBe('Regla actualizada: CONFITERÍA en todas las sucursales, el 15 y el último de cada mes.');
    expect(avisoDeGuardado({ reglas: [{ lugar: 'LP', id: 'A', accion: 'creada' }, { lugar: 'ZAM', id: 'B', accion: 'creada' }] }, 'BOTANAS', 'Cada martes', nombre))
      .toBe('2 reglas de BOTANAS, cada martes: zona La Piedad (nueva) y zona Zamora (nueva).');
  });
});
