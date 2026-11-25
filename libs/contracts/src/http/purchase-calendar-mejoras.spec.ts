// Sin `import ... from 'vitest'`: la config usa `globals: true` (con el import el spec no carga: compuerta spec-vivo).
import {
  estadoDeRegla, fechasDeLaRegla, lugaresDeLaCaptura, patronDelDiaFijo, proximasRevisiones, puedeSerResponsable, reglasDeLaCaptura,
  SEMANA_DEL_MES_ULTIMA, validarCaptura, validarRegla, type GuardarReglaDto, type PatronDeRegla, type ReglaRevision,
} from './purchase-calendar.contract';

/**
 * Las mejoras que pidieron los usuarios al día siguiente de salir a prod (anexo C §10.12, DC28–DC30):
 * - `[PQ.3.15]` la cadencia de «días de la semana»: cada 2, 3 o 6 semanas a partir de una fecha, o una vez al mes;
 * - `[PQ.3.21]` varias zonas o sucursales en una captura: una regla por lugar;
 * - `[PQ.3.22]` el responsable: sólo quien escribe en todas las sucursales de la regla.
 *
 * Calendario real: el 1-nov-2026 es domingo; el 24-nov, martes; diciembre trae CINCO martes (1, 8, 15, 22, 29) y
 * febrero de 2027 cuatro (2, 9, 16, 23). El 1-ene-2027 es viernes.
 */

type Regla = PatronDeRegla & Pick<ReglaRevision, 'out_of_cycle_until'>;
const base: Regla = {
  pattern: 'weekdays', weekdays: null, month_days: null, month_last_day: false, every_n_days: null, weekend_shift: 'friday',
  week_interval: null, week_anchor: null, month_week: null, out_of_cycle_until: null,
};
const dias = (weekdays: number[], extra: Partial<Regla> = {}): Regla => ({ ...base, weekdays, ...extra });
const cadaSemanas = (weekdays: number[], k: number, ancla: string): Regla => dias(weekdays, { week_interval: k, week_anchor: ancla });
const alMes = (weekdays: number[], cual: number): Regla => dias(weekdays, { month_week: cual });
const fechas = (r: Regla, desde: string, n: number) => proximasRevisiones(r, desde, n).map((x) => x.fecha);

describe('`[PQ.3.15]` la cadencia de «días de la semana» (DC29)', () => {
  it('cada 2 semanas en martes, a partir del 24 de noviembre: una sí y otra no, cruzando el año', () => {
    expect(fechas(cadaSemanas([2], 2, '2026-11-24'), '2026-11-24', 4)).toEqual(['2026-11-24', '2026-12-08', '2026-12-22', '2027-01-05']);
  });

  it('cada 3 semanas en lunes y jueves: los dos días de la semana que toca', () => {
    expect(fechas(cadaSemanas([1, 4], 3, '2026-11-23'), '2026-11-23', 6))
      .toEqual(['2026-11-23', '2026-11-26', '2026-12-14', '2026-12-17', '2027-01-04', '2027-01-07']);
  });

  it('cada 6 semanas en viernes', () => {
    expect(fechas(cadaSemanas([5], 6, '2026-11-27'), '2026-11-20', 3)).toEqual(['2026-11-27', '2027-01-08', '2027-02-19']);
  });

  it('antes de «a partir del» no hay revisiones, ni siquiera en la misma semana', () => {
    // Ancla el miércoles 2-dic: el lunes 30-nov es de esa semana pero ANTES de la ancla.
    expect(fechas(cadaSemanas([1, 3], 2, '2026-12-02'), '2026-11-23', 3)).toEqual(['2026-12-02', '2026-12-14', '2026-12-16']);
  });

  it('la semana va de lunes a domingo: una ancla en domingo cuenta desde SU semana, no la siguiente', () => {
    // Domingo 29-nov es de la semana del lunes 23: el martes 1-dic es de la semana siguiente (no toca), el 8-dic sí.
    expect(fechas(cadaSemanas([2], 2, '2026-11-29'), '2026-11-29', 2)).toEqual(['2026-12-08', '2026-12-22']);
  });

  it('una vez al mes: el primer martes', () => {
    expect(fechas(alMes([2], 1), '2026-11-24', 4)).toEqual(['2026-12-01', '2027-01-05', '2027-02-02', '2027-03-02']);
  });

  it('una vez al mes: el último viernes (le faltan menos de 7 días al fin de mes)', () => {
    expect(fechas(alMes([5], SEMANA_DEL_MES_ULTIMA), '2026-11-24', 4)).toEqual(['2026-11-27', '2026-12-25', '2027-01-29', '2027-02-26']);
  });

  it('el cuarto no es el último cuando el mes trae cinco (diciembre), y sí cuando trae cuatro (febrero)', () => {
    const dic = (r: Regla) => fechasDeLaRegla(r, '2026-12-01', '2026-12-31').map((x) => x.fecha);
    expect(dic(alMes([2], 4))).toEqual(['2026-12-22']);
    expect(dic(alMes([2], SEMANA_DEL_MES_ULTIMA))).toEqual(['2026-12-29']);
    const feb = (r: Regla) => fechasDeLaRegla(r, '2027-02-01', '2027-02-28').map((x) => x.fecha);
    expect(feb(alMes([2], 4))).toEqual(feb(alMes([2], SEMANA_DEL_MES_ULTIMA)));
    expect(feb(alMes([2], 4))).toEqual(['2027-02-23']);
  });

  it('⛔ NEGATIVA: una regla de cada semana no cambia ni una fecha (con la cadencia vacía o en 1)', () => {
    const antes = fechas(dias([2, 4]), '2026-11-24', 8);
    expect(antes).toEqual(['2026-11-24', '2026-11-26', '2026-12-01', '2026-12-03', '2026-12-08', '2026-12-10', '2026-12-15', '2026-12-17']);
    expect(fechas(dias([2, 4], { week_interval: 1, week_anchor: '2026-11-01' }), '2026-11-24', 8)).toEqual(antes);
  });

  it('⭐ el criterio de PQ.3.15: las 3 quincenales de día fijo de la hoja de Compras (21-nov → 28-dic) dan 7 de 7 (con «cada 14 días» daban 0)', () => {
    // Dos proveedores en lunes y uno en miércoles; fechas de la hoja «CALENDARIO COMPRAS» (anexo C §10.9).
    const casos: [Regla, string[]][] = [
      [cadaSemanas([1], 2, '2026-11-23'), ['2026-11-23', '2026-12-07', '2026-12-21']],
      [cadaSemanas([1], 2, '2026-11-23'), ['2026-11-23', '2026-12-07']],
      [cadaSemanas([3], 2, '2026-12-02'), ['2026-12-02', '2026-12-16']],
    ];
    let iguales = 0;
    let total = 0;
    for (const [r, hoja] of casos) {
      const suite = fechasDeLaRegla(r, '2026-11-21', '2026-12-28').map((x) => x.fecha);
      iguales += hoja.filter((f) => suite.includes(f)).length;
      total += hoja.length;
    }
    expect(`${iguales} de ${total}`).toBe('7 de 7');
  });

  it('cada N semanas sin «a partir del» no da fechas: no se inventa la ancla', () => {
    expect(fechas(dias([2], { week_interval: 2 }), '2026-11-24', 3)).toEqual([]);
  });

  it('el estado de hoy respeta la cadencia: la semana que no toca no se rezaga', () => {
    // Cada 2 semanas en martes desde el 10-nov: tocan el 10 y el 24 (el 17 no). Atendido el 10; hoy, martes 24.
    const r = cadaSemanas([2], 2, '2026-11-10');
    const e = estadoDeRegla(r, '2026-11-24', { actividad: ['2026-11-10'], vigente_desde: '2026-11-10' });
    expect(e.estado).toBe('toca_hoy');
    expect(e.proxima?.fecha).toBe('2026-12-08');
    // El miércoles 18 (semana que no toca) sigue al día: el 17 no era fecha.
    expect(estadoDeRegla(r, '2026-11-18', { actividad: ['2026-11-10'], vigente_desde: '2026-11-10' }).estado).toBe('al_dia');
  });
});

describe('`[PQ.3.15]` lo que la base rechazaría, dicho antes (el mismo CHECK de la migración 20261124133043)', () => {
  const Z = ['LP', 'ZAM', 'MOR'];
  const S = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];
  const d = (extra: Partial<GuardarReglaDto>): GuardarReglaDto => ({ supplier_code: 'CD015', scope: 'corporate', pattern: 'weekdays', weekdays: [2], ...extra });

  it('las cadencias válidas pasan', () => {
    expect(validarRegla(d({}), Z, S)).toBeNull();
    for (const k of [2, 3, 6]) expect(validarRegla(d({ week_interval: k, week_anchor: '2026-11-24' }), Z, S)).toBeNull();
    for (const m of [1, 2, 3, 4, SEMANA_DEL_MES_ULTIMA]) expect(validarRegla(d({ month_week: m }), Z, S)).toBeNull();
  });

  it('lo que no, en llano', () => {
    expect(validarRegla(d({ week_interval: 4, week_anchor: '2026-11-24' }), Z, S)).toBe('La cadencia es cada semana, cada 2, 3 o 6 semanas, o una vez al mes.');
    expect(validarRegla(d({ week_interval: 2 }), Z, S)).toBe('Di a partir de qué fecha cuenta «cada N semanas».');
    expect(validarRegla(d({ week_anchor: '2026-11-24' }), Z, S)).toBe('«A partir del» sólo va con «cada N semanas».');
    expect(validarRegla(d({ week_interval: 2, week_anchor: '2026-11-24', month_week: 1 }), Z, S)).toBe('Elige «cada N semanas» o «una vez al mes», no las dos.');
    expect(validarRegla(d({ week_interval: 2, week_anchor: '2026-02-30' }), Z, S)).toBe('La fecha «a partir del» no es válida.');
    expect(validarRegla(d({ month_week: 6 }), Z, S)).toBe('«Una vez al mes» va el primero, segundo, tercero, cuarto o último.');
    expect(validarRegla(d({ pattern: 'month_days', weekdays: null, month_days: [15], month_week: 1 }), Z, S)).toBe('Sólo una regla por días de la semana lleva cadencia.');
  });
});

describe('`[PQ.3.21]` varias zonas o sucursales en una captura: una regla por lugar (DC28)', () => {
  const Z = ['LP', 'ZAM', 'MOR'];
  const S = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];
  const d = (extra: Partial<GuardarReglaDto>): GuardarReglaDto => ({ supplier_code: 'CD015', scope: 'zone', pattern: 'weekdays', weekdays: [2], ...extra });

  it('La Piedad y Zamora, martes: dos reglas, cada una con su zona sola (el caso de CD015 en prod)', () => {
    const rs = reglasDeLaCaptura(d({ zone_codes: ['LP', 'ZAM'] }));
    expect(rs.map((r) => [r.zone_code, r.branch_code, r.zone_codes, r.branch_codes])).toEqual([['LP', null, undefined, undefined], ['ZAM', null, undefined, undefined]]);
    expect(rs.every((r) => r.pattern === 'weekdays' && r.weekdays?.[0] === 2)).toBe(true);
    expect(validarCaptura(d({ zone_codes: ['LP', 'ZAM'] }), Z, S)).toBeNull();
  });

  it('una zona repetida es una sola regla; la captura de antes (una zona) sigue valiendo', () => {
    expect(lugaresDeLaCaptura(d({ zone_codes: ['LP', 'LP'] }))).toEqual(['LP']);
    expect(lugaresDeLaCaptura(d({ zone_code: 'MOR' }))).toEqual(['MOR']);
    expect(reglasDeLaCaptura({ ...d({}), scope: 'branch', branch_codes: ['04', '05'] }).map((r) => r.branch_code)).toEqual(['04', '05']);
    expect(reglasDeLaCaptura({ ...d({}), scope: 'corporate' }).map((r) => [r.zone_code, r.branch_code])).toEqual([[null, null]]);
  });

  it('sin lugares, con lugares del otro alcance, o con uno que no existe, se dice cuál', () => {
    expect(validarCaptura(d({ zone_codes: [] }), Z, S)).toBe('Elige al menos una zona.');
    expect(validarCaptura({ ...d({}), scope: 'branch', branch_codes: [] }, Z, S)).toBe('Elige al menos una sucursal.');
    expect(validarCaptura({ ...d({}), scope: 'branch', zone_codes: ['LP'], branch_codes: ['04'] }, Z, S)).toBe('Sólo una regla por zona lleva zonas.');
    expect(validarCaptura(d({ zone_codes: ['LP', 'XX'] }), Z, S)).toBe('Elige una zona de compra.');
    expect(validarCaptura(d({ zone_codes: 'LP' as unknown as string[] }), Z, S)).toBe('Las zonas y sucursales van en una lista.');
  });
});

describe('`[PQ.3.22]` quién puede ser responsable (DC30): escribe en TODAS las sucursales de la regla', () => {
  it('quien escribe en todas puede serlo de cualquier regla', () => {
    expect(puedeSerResponsable(null, ['04'])).toBe(true);
  });
  it('el encargado de Yurécuaro, de la regla de Yurécuaro sí; de la zona La Piedad (cuatro sucursales), no', () => {
    expect(puedeSerResponsable(['04'], ['04'])).toBe(true);
    expect(puedeSerResponsable(['04'], ['01', '02', '03', '04'])).toBe(false);
  });
  it('sin sucursales de la regla no se ofrece a nadie con alcance recortado', () => {
    expect(puedeSerResponsable(['04'], [])).toBe(false);
  });
});

describe('`[PQ.3.15]` el día fijo de Kepler se guarda con la cadencia, anclado en la última actividad de esa sucursal', () => {
  it('cada semana → días de la semana; cada 2 o 3 semanas → con cadencia; otro periodo → cada N días', () => {
    expect(patronDelDiaFijo({ weekday: 5, every_days: 7, ultima: '2026-11-20' })).toMatchObject({ pattern: 'weekdays', weekdays: [5], week_interval: null });
    expect(patronDelDiaFijo({ weekday: 5, every_days: 14, ultima: '2026-11-20' }))
      .toMatchObject({ pattern: 'weekdays', weekdays: [5], week_interval: 2, week_anchor: '2026-11-20', every_n_days: null });
    expect(patronDelDiaFijo({ weekday: 1, every_days: 21, ultima: '2026-11-16' })).toMatchObject({ week_interval: 3, week_anchor: '2026-11-16' });
    expect(patronDelDiaFijo({ weekday: 1, every_days: 28, ultima: '2026-11-16' })).toMatchObject({ pattern: 'every_n_days', every_n_days: 28, week_interval: null });
  });
});
