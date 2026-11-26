// Sin `import ... from 'vitest'`: la config usa `globals: true` (con el import el spec no carga: compuerta spec-vivo).
import { diasEntre } from '../finance/pago-vencido.contract';
import { sumarDias } from './existencia-historico.contract';
import {
  diaIso, estadoDeRegla, fechasDeLaRegla, historialDeLaRegla, OCASIONALES_MAX, proximasRevisiones, ultimoCambioSinHistorial, validarOcasionales,
  type CambioDeRegla, type EstadoDeLaRegla, type PatronDeRegla, type ReglaRevision,
} from './purchase-calendar.contract';

/**
 * `[PQ.3.3]` Las fechas de una regla de revisión y su estado de hoy (anexo C §10.3, DC14, DC19).
 * Calendario real: el 20-nov-2026 es viernes, el 15-nov domingo, el 30-nov lunes, el 31-dic jueves,
 * el 31-ene-2027 domingo y el 28-feb-2027 domingo.
 */

type Regla = PatronDeRegla & Pick<ReglaRevision, 'out_of_cycle_until'>;
const base: Regla = { pattern: 'weekdays', weekdays: null, month_days: null, month_last_day: false, every_n_days: null, weekend_shift: 'friday', out_of_cycle_until: null };
const semana = (...weekdays: number[]): Regla => ({ ...base, pattern: 'weekdays', weekdays });
const mes = (month_days: number[], ultimo = false, weekend_shift: 'friday' | 'monday' = 'friday'): Regla =>
  ({ ...base, pattern: 'month_days', month_days, month_last_day: ultimo, weekend_shift });
const cada = (n: number): Regla => ({ ...base, pattern: 'every_n_days', every_n_days: n });
const fechas = (xs: { fecha: string }[]) => xs.map((x) => x.fecha);

describe('aritmética de fechas (sin reloj ni zona horaria)', () => {
  it('día ISO, sumar y restar días, cruzando mes y año', () => {
    expect(diaIso('2026-11-20')).toBe(5);
    expect(diaIso('2026-11-15')).toBe(7);
    expect(sumarDias('2026-12-30', 3)).toBe('2027-01-02');
    expect(sumarDias('2027-03-01', -1)).toBe('2027-02-28');
    expect(diasEntre('2026-11-18', '2026-11-20')).toBe(2);
  });
});

describe('fechasDeLaRegla / proximasRevisiones', () => {
  it('días de la semana: cada miércoles (el ejemplo de Yurécuaro)', () => {
    expect(fechas(proximasRevisiones(semana(3), '2026-11-20', 3))).toEqual(['2026-11-25', '2026-12-02', '2026-12-09']);
  });

  it('dos días de la semana, contando hoy si coincide', () => {
    expect(fechas(proximasRevisiones(semana(2, 5), '2026-11-20', 3))).toEqual(['2026-11-20', '2026-11-24', '2026-11-27']);
  });

  it('el 15 y el último, corporativo: el fin de semana se ADELANTA al viernes (DC19) y lo dice', () => {
    const r = proximasRevisiones(mes([15], true), '2026-11-01', 6);
    expect(r).toEqual([
      { fecha: '2026-11-13', corrida_de: '2026-11-15' },
      { fecha: '2026-11-30', corrida_de: null },
      { fecha: '2026-12-15', corrida_de: null },
      { fecha: '2026-12-31', corrida_de: null },
      { fecha: '2027-01-15', corrida_de: null },
      { fecha: '2027-01-29', corrida_de: '2027-01-31' },
    ]);
  });

  it('corrido al LUNES, «el último» de enero se va a febrero (por eso el default es viernes)', () => {
    expect(proximasRevisiones(mes([15], true, 'monday'), '2027-01-16', 4)).toEqual([
      { fecha: '2027-02-01', corrida_de: '2027-01-31' },
      { fecha: '2027-02-15', corrida_de: null },
      { fecha: '2027-03-01', corrida_de: '2027-02-28' },
      { fecha: '2027-03-15', corrida_de: null },
    ]);
  });

  it('el 1 y el último corridos al lunes caen en el MISMO día: una sola revisión', () => {
    // 31-ene-2027 domingo → lunes 1-feb, que además es el día 1.
    expect(fechas(fechasDeLaRegla(mes([1], true, 'monday'), '2027-01-25', '2027-02-05'))).toEqual(['2027-02-01']);
  });

  it('un día que el mes no tiene se SALTA (para fin de mes está «el último»)', () => {
    expect(fechas(proximasRevisiones(mes([31]), '2026-11-01', 1))).toEqual(['2026-12-31']);
    expect(fechas(proximasRevisiones(mes([30]), '2027-02-01', 1))).toEqual(['2027-03-30']);
  });

  it('cada N días: desde el ancla; sin ancla no se inventa fecha', () => {
    expect(fechasDeLaRegla(cada(6), '2026-11-15', '2026-12-31')).toEqual([]);
    expect(fechas(proximasRevisiones(cada(6), '2026-11-15', 2, '2026-11-14'))).toEqual(['2026-11-20', '2026-11-26']);
  });

  it('una regla sin días no da fechas (no revienta)', () => {
    expect(proximasRevisiones(semana(), '2026-11-20', 3)).toEqual([]);
    expect(proximasRevisiones(mes([]), '2026-11-20', 3)).toEqual([]);
  });
});

describe('estadoDeRegla — el estado de HOY (DC14: lo no atendido amanece rezagado)', () => {
  const hoy = '2026-11-20'; // viernes

  it('miércoles atendido el miércoles → al día, la próxima es el siguiente miércoles', () => {
    const e = estadoDeRegla(semana(3), hoy, { actividad: ['2026-11-18'] });
    expect(e.estado).toBe('al_dia');
    expect(e.proxima?.fecha).toBe('2026-11-25');
  });

  it('el viernes de Yurécuaro sin documento hoy → toca hoy', () => {
    const e = estadoDeRegla(semana(5), hoy, { actividad: ['2026-11-13'] });
    expect(e).toMatchObject({ estado: 'toca_hoy', pendiente_desde: '2026-11-20', dias_atraso: 0 });
  });

  it('dos miércoles sin atender → rezagada desde el PRIMERO de la racha', () => {
    const e = estadoDeRegla(semana(3), hoy, { actividad: ['2026-11-04'] });
    expect(e).toMatchObject({ estado: 'rezagada', pendiente_desde: '2026-11-11', dias_atraso: 9 });
  });

  it('una regla nueva no debe fechas de antes de existir (vigente_desde)', () => {
    const e = estadoDeRegla(semana(3), hoy, { vigente_desde: '2026-11-16' });
    expect(e).toMatchObject({ estado: 'rezagada', pendiente_desde: '2026-11-18', dias_atraso: 2 });
    // Control: sin vigente_desde la misma regla «debería» desde hace dos meses — por eso existe el parámetro.
    expect(estadoDeRegla(semana(3), hoy).dias_atraso).toBeGreaterThan(50);
  });

  it('un fallo VIEJO ya cubierto por la fecha siguiente no es rezago de hoy', () => {
    expect(estadoDeRegla(semana(3), hoy, { actividad: ['2026-11-04', '2026-11-18'] }).estado).toBe('al_dia');
  });

  it('pedido tarde: el jueves cubre el miércoles que se pasó', () => {
    expect(estadoDeRegla(semana(3), hoy, { actividad: ['2026-11-11', '2026-11-19'] }).estado).toBe('al_dia');
  });

  it('pedido adelantado: el lunes atiende el miércoles (≤ 3 días), y un pedido de 4 días antes no', () => {
    expect(estadoDeRegla(semana(3), '2026-11-25', { actividad: ['2026-11-18', '2026-11-23'] }).estado).toBe('al_dia');
    // Negativa: el sábado 21 está a 4 días del miércoles 25 → ese miércoles sigue tocando.
    expect(estadoDeRegla(semana(3), '2026-11-25', { actividad: ['2026-11-18', '2026-11-21'] }).estado).toBe('toca_hoy');
  });

  it('dos sucursales, dos días, el MISMO proveedor: cada regla con su propia actividad', () => {
    const yur = estadoDeRegla(semana(3), hoy, { actividad: ['2026-11-18'] });
    const can = estadoDeRegla(semana(2), hoy, { actividad: ['2026-11-10'] });
    expect(yur.estado).toBe('al_dia');
    expect(can).toMatchObject({ estado: 'rezagada', pendiente_desde: '2026-11-17', dias_atraso: 3 });
  });

  it('«hoy no se pide» atiende su fecha; con nueva fecha, esa es la próxima y se vence', () => {
    const marcas = [{ review_date: '2026-11-18', outcome: 'skipped' as const, postponed_to: '2026-11-21' }];
    expect(estadoDeRegla(semana(3), hoy, { marcas })).toMatchObject({ estado: 'al_dia', proxima: { fecha: '2026-11-21', corrida_de: null } });
    expect(estadoDeRegla(semana(3), '2026-11-22', { marcas })).toMatchObject({ estado: 'rezagada', pendiente_desde: '2026-11-21', dias_atraso: 1 });
    // Sin nueva fecha, la marca sola deja la regla al día.
    expect(estadoDeRegla(semana(3), hoy, { marcas: [{ review_date: '2026-11-18', outcome: 'skipped', postponed_to: null }] }).estado).toBe('al_dia');
  });

  it('el 15 corrido al viernes 13: ese día toca; la próxima es el lunes 30', () => {
    const e = estadoDeRegla(mes([15], true), '2026-11-13', { actividad: ['2026-10-30'] });
    expect(e).toMatchObject({ estado: 'toca_hoy', pendiente_desde: '2026-11-13' });
    expect(e.proxima?.fecha).toBe('2026-11-30');
  });

  it('cada 6 días: toca, se rezaga, se atiende; sin ancla se declara', () => {
    expect(estadoDeRegla(cada(6), hoy, { ancla: '2026-11-14' }).estado).toBe('toca_hoy');
    expect(estadoDeRegla(cada(6), '2026-11-23', { ancla: '2026-11-14' })).toMatchObject({ estado: 'rezagada', dias_atraso: 3 });
    expect(estadoDeRegla(cada(6), '2026-11-23', { ancla: '2026-11-14', actividad: ['2026-11-21'] }))
      .toMatchObject({ estado: 'al_dia', proxima: { fecha: '2026-11-27', corrida_de: null } });
    expect(estadoDeRegla(cada(6), hoy).estado).toBe('sin_ancla');
  });

  it('cada 6 días pospuesta: manda la nueva fecha', () => {
    const marcas = [{ review_date: '2026-11-20', outcome: 'skipped' as const, postponed_to: '2026-11-24' }];
    expect(estadoDeRegla(cada(6), '2026-11-22', { ancla: '2026-11-14', marcas }))
      .toMatchObject({ estado: 'al_dia', proxima: { fecha: '2026-11-24', corrida_de: null } });
  });

  it('fuera de ciclo hasta el 15-dic: no se rezaga, y la próxima es la primera después', () => {
    const e = estadoDeRegla({ ...semana(3), out_of_cycle_until: '2026-12-15' }, hoy, { actividad: ['2026-10-01'] });
    expect(e).toMatchObject({ estado: 'fuera_de_ciclo', dias_atraso: 0, proxima: { fecha: '2026-12-16', corrida_de: null } });
  });
});

describe('`[PQ.3.18]` (c) los ocasionales en bloque: lo que se rechaza antes de llegar a la base', () => {
  it('sin proveedores, con una clave vacía o que no es texto, se dice en llano', () => {
    expect(validarOcasionales({ supplier_codes: [] })).toBe('Faltan los proveedores.');
    expect(validarOcasionales({ supplier_codes: ['CA022', ' '] })).toBe('Cada proveedor va por su clave de Kepler.');
    expect(validarOcasionales({ supplier_codes: [7 as unknown as string] })).toBe('Cada proveedor va por su clave de Kepler.');
    expect(validarOcasionales(null as unknown as { supplier_codes: string[] })).toBe('Faltan los proveedores.');
  });
  it(`más de ${OCASIONALES_MAX} no son «los ocasionales»; hasta ahí, válido`, () => {
    expect(validarOcasionales({ supplier_codes: Array.from({ length: OCASIONALES_MAX + 1 }, (_, i) => 'C' + i) })).toMatch(/más de 500/);
    expect(validarOcasionales({ supplier_codes: Array.from({ length: OCASIONALES_MAX }, (_, i) => 'C' + i) })).toBeNull();
    expect(validarOcasionales({ supplier_codes: ['CA022'] })).toBeNull();
  });
});

describe('`[PQ.3.17]` el historial de una regla: de qué a qué, reconstruido desde la regla de hoy', () => {
  const hoy: EstadoDeLaRegla = {
    pattern: 'weekdays', weekdays: [1, 3], month_days: null, month_last_day: false, every_n_days: null, weekend_shift: 'friday',
    week_interval: 2, week_anchor: '2026-11-23', month_week: null, reviewer_user_id: 'U-B', out_of_cycle_until: null,
    out_of_cycle_reason: null, note: 'pasa con el camión de Zamora',
  };
  const cambio = (el: string, campos: CambioDeRegla['campos'], por: string | null = 'Bea'): CambioDeRegla =>
    ({ el, dia: el.slice(0, 10), por, campos, nombres: {} });
  // El más nuevo primero, como los da la API.
  const cambios = [
    cambio('2026-11-26T15:00:00Z', { out_of_cycle_until: { antes: '2026-12-15', despues: null }, out_of_cycle_reason: { antes: 'inventario', despues: null } }),
    cambio('2026-11-25T15:00:00Z', {
      pattern: { antes: 'every_n_days', despues: 'weekdays' }, every_n_days: { antes: 14, despues: null },
      weekdays: { antes: null, despues: [1, 3] }, week_interval: { antes: null, despues: 2 }, week_anchor: { antes: null, despues: '2026-11-23' },
      reviewer_user_id: { antes: null, despues: 'U-B' },
    }, 'Ana'),
  ];

  it('el cambio más nuevo termina en la regla de hoy; su «antes» es el «después» del anterior', () => {
    const [p1, p2] = historialDeLaRegla(hoy, cambios);
    expect(p1.despues).toEqual(hoy);
    expect(p1.antes.out_of_cycle_until).toBe('2026-12-15');
    expect(p1.antes.out_of_cycle_reason).toBe('inventario');
    expect(p1.antes.weekdays).toEqual([1, 3]); // lo que no se movió se queda
    expect(p2.despues).toEqual(p1.antes);
  });

  it('reconstruye el patrón ENTERO de antes, no sólo las columnas que se movieron', () => {
    const p2 = historialDeLaRegla(hoy, cambios)[1];
    expect(p2.antes).toMatchObject({ pattern: 'every_n_days', every_n_days: 14, weekdays: null, week_interval: null, week_anchor: null, reviewer_user_id: null });
    expect(p2.antes.note).toBe('pasa con el camión de Zamora');
    expect(p2.antes.out_of_cycle_until).toBe('2026-12-15'); // estaba fuera de ciclo cuando cambió el patrón
  });

  it('las listas del JSON vuelven como números, y un campo que no venía queda en null', () => {
    const p = historialDeLaRegla({ ...hoy, weekdays: [1] }, [cambio('2026-11-25T15:00:00Z', { weekdays: { antes: ['2', '4'], despues: [1] } })])[0];
    expect(p.antes.weekdays).toEqual([2, 4]);
    const q = historialDeLaRegla(hoy, [cambio('2026-11-25T15:00:00Z', { note: { despues: 'x' } as never })])[0];
    expect(q.antes.note).toBeNull();
  });

  it('lo que el cambio trae manda sobre lo reconstruido: un hueco no le atribuye un valor que no escribió', () => {
    // Hoy la nota es «z» (una escritura que no pasó por el disparador); el cambio guardado decía «x».
    const p = historialDeLaRegla({ ...hoy, note: 'z' }, [cambio('2026-11-25T15:00:00Z', { note: { antes: null, despues: 'x' } })])[0];
    expect(p.despues.note).toBe('x');
    expect(p.antes.note).toBeNull();
  });

  it('sin cambios no hay pasos; el objeto de hoy no se modifica', () => {
    const copia = JSON.parse(JSON.stringify(hoy));
    expect(historialDeLaRegla(hoy, [])).toEqual([]);
    historialDeLaRegla(hoy, cambios);
    expect(hoy).toEqual(copia);
  });

  it('el último cambio que el historial no tiene es de antes de que se guardara; con su fila (±2 s), no', () => {
    const u = { por: 'Ana', el: '2026-11-25T15:00:01Z', dia: '2026-11-25' };
    expect(ultimoCambioSinHistorial({ ultimo_cambio: u, cambios })).toBe(false);
    expect(ultimoCambioSinHistorial({ ultimo_cambio: u, cambios: [] })).toBe(true);
    expect(ultimoCambioSinHistorial({ ultimo_cambio: { ...u, el: '2026-11-24T10:00:00Z' }, cambios })).toBe(true);
    // NEGATIVA: una regla que nadie tocó no dice que le falte historial.
    expect(ultimoCambioSinHistorial({ ultimo_cambio: null, cambios: [] })).toBe(false);
  });
});
