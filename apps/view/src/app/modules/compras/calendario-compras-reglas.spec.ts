import type { ReglaCalendario } from '@megadulces/contracts';
import {
  atencionEnPalabras, corrimientoEnPalabras, diaCorto, diaFijoEnPalabras, diaFijoEvidencia, diaFijoReciente, estadoEnPalabras, fechasEnRango, patronEnPalabras, propuestaEnPalabras, relativo, alcanceEnPalabras, paraQuienVe,
  avanceEscalonEnPalabras, avanceTotalEnPalabras, NOMBRE_ESCALON, pesoEnPalabras, porcentaje,
} from './calendario-compras-reglas';

/** `[PQ.3.5]` Lo que la pantalla del calendario dice en palabras, y las fechas de «Semana» y «Mes». */

const HOY = '2026-11-20'; // viernes

const regla = (o: Partial<ReglaCalendario>): ReglaCalendario => ({
  id: 'r', supplier_code: 'P1', scope: 'corporate', zone_code: null, branch_code: null, pattern: 'weekdays', weekdays: [3],
  month_days: null, month_last_day: false, every_n_days: null, weekend_shift: 'friday', reviewer_user_id: null,
  out_of_cycle_until: null, out_of_cycle_reason: null, supplier_name: 'Proveedor', alcance_nombre: 'Todas las sucursales',
  revisa: 'Gerencia de compras', estado: { estado: 'al_dia', pendiente_desde: null, dias_atraso: 0, proxima: { fecha: '2026-11-25', corrida_de: null } },
  ultima_actividad: null, ultima_marca: null, definida_por: null, definida_el: '2026-11-01', note: null,
  pedido_supplier_id: null, pedido_warehouse_ids: [], ...o,
});

describe('las fechas en palabras', () => {
  it('día corto con el día de la semana, sin correrse por zona horaria', () => {
    expect(diaCorto('2026-11-20')).toBe('vie 20 nov');
    expect(diaCorto('2027-01-31')).toBe('dom 31 ene');
    expect(diaCorto(null)).toBe('—');
  });
  it('relativo a hoy', () => {
    expect(relativo('2026-11-20', HOY)).toBe('hoy');
    expect(relativo('2026-11-21', HOY)).toBe('mañana');
    expect(relativo('2026-11-17', HOY)).toBe('hace 3 días');
  });
});

describe('el patrón en palabras (los ejemplos de Francisco)', () => {
  it('días de la semana', () => {
    expect(patronEnPalabras(regla({ weekdays: [3] }))).toBe('Cada miércoles');
    expect(patronEnPalabras(regla({ weekdays: [4, 2] }))).toBe('Cada martes y jueves');
    expect(patronEnPalabras(regla({ weekdays: [1, 2, 3, 4, 5] }))).toBe('De lunes a viernes');
  });
  it('días del mes, con el último y el corrimiento', () => {
    const q = regla({ pattern: 'month_days', weekdays: null, month_days: [15], month_last_day: true });
    expect(patronEnPalabras(q)).toBe('El 15 y el último de cada mes');
    expect(corrimientoEnPalabras(q)).toBe('Si cae en fin de semana, se adelanta al viernes');
    expect(patronEnPalabras(regla({ pattern: 'month_days', weekdays: null, month_days: [1, 10, 20], month_last_day: true })))
      .toBe('Los días 1, 10, 20 y el último de cada mes');
    expect(patronEnPalabras(regla({ pattern: 'month_days', weekdays: null, month_days: [], month_last_day: true }))).toBe('El último de cada mes');
    expect(corrimientoEnPalabras(regla({ weekdays: [3] }))).toBeNull();
  });
  it('cada N días', () => {
    expect(patronEnPalabras(regla({ pattern: 'every_n_days', weekdays: null, every_n_days: 14 }))).toBe('Cada 14 días');
  });
});

describe('el estado lleva palabra y el dato que lo explica', () => {
  it('rezagada dice cuántos días y desde cuándo', () => {
    const e = estadoEnPalabras({ estado: 'rezagada', pendiente_desde: '2026-11-18', dias_atraso: 2, proxima: null }, regla({}), HOY);
    expect(e).toEqual({ etiqueta: 'Rezagada · 2 días', severidad: 'danger', detalle: 'Se debe desde el mié 18 nov' });
  });
  it('fuera de ciclo dice hasta cuándo y por qué', () => {
    const e = estadoEnPalabras({ estado: 'fuera_de_ciclo', pendiente_desde: null, dias_atraso: 0, proxima: null },
      regla({ out_of_cycle_until: '2027-01-15', out_of_cycle_reason: 'de temporada' }), HOY);
    expect(e.detalle).toBe('Hasta el vie 15 ene · de temporada');
  });
});

describe('la última atención dice el documento o la marca', () => {
  it('OC cancelada se nombra como tal (la revisión se hizo)', () => {
    expect(atencionEnPalabras({ fecha: '2026-11-18', fuente: 'oc_cancelada' }, null)).toEqual({ que: 'Orden de compra cancelada', cuando: 'mié 18 nov' });
  });
  it('una marca «hoy no se pide» lleva su motivo', () => {
    const m = { review_date: '2026-11-19', outcome: 'skipped' as const, postponed_to: null, skip_reason: 'in_quotation' as const, note: null, marcada_por: 'Ana', marcada_el: '2026-11-19T15:00:00Z' };
    expect(atencionEnPalabras({ fecha: '2026-11-19', fuente: 'marca' }, m).que).toBe('No se pidió (en cotización)');
  });
  it('sin actividad no se dibuja una fecha', () => {
    expect(atencionEnPalabras(null, null)).toEqual({ que: 'Sin OC ni entrada en el último año', cuando: '' });
  });
});

describe('fechasEnRango — Semana y Mes con el MISMO cálculo que la API', () => {
  it('dos reglas del mismo proveedor en dos sucursales y dos días distintos', () => {
    const f = fechasEnRango([
      regla({ id: 'yur', weekdays: [3], alcance_nombre: 'Yurécuaro' }),
      regla({ id: 'can', weekdays: [2], alcance_nombre: 'Canindo' }),
    ], HOY, '2026-11-26');
    expect(f.map((x) => `${x.fecha} ${x.regla.id}`)).toEqual(['2026-11-24 can', '2026-11-25 yur']);
  });
  it('el último de enero de 2027 cae en domingo: se ve el viernes 29, con la fecha original', () => {
    const f = fechasEnRango([regla({ pattern: 'month_days', weekdays: null, month_days: [], month_last_day: true })], '2027-01-25', '2027-01-31');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ fecha: '2027-01-29', corrida_de: '2027-01-31', pospuesta: false });
  });
  it('cada N días cuenta desde su siguiente fecha; sin ancla no inventa ninguna', () => {
    const n = regla({ id: 'n', pattern: 'every_n_days', weekdays: null, every_n_days: 7, estado: { estado: 'al_dia', pendiente_desde: null, dias_atraso: 0, proxima: { fecha: '2026-11-23', corrida_de: null } } });
    const sin = regla({ id: 's', pattern: 'every_n_days', weekdays: null, every_n_days: 7, estado: { estado: 'sin_ancla', pendiente_desde: null, dias_atraso: 0, proxima: null } });
    expect(fechasEnRango([n, sin], HOY, '2026-12-01').map((x) => `${x.fecha} ${x.regla.id}`)).toEqual(['2026-11-23 n', '2026-11-30 n']);
  });
  it('negativa: fuera de ciclo no tiene fechas hasta después de su «hasta»; una nueva fecha pospuesta sí sale', () => {
    const fuera = regla({ id: 'f', weekdays: [1], out_of_cycle_until: '2026-11-30' });
    const pos = regla({ id: 'p', weekdays: [1], ultima_marca: { review_date: '2026-11-23', outcome: 'skipped', postponed_to: '2026-11-26', skip_reason: 'blocked', note: null, marcada_por: null, marcada_el: '2026-11-20T00:00:00Z' } });
    const f = fechasEnRango([fuera, pos], HOY, '2026-12-07');
    expect(f.filter((x) => x.regla.id === 'f').map((x) => x.fecha)).toEqual(['2026-12-07']);
    expect(f.filter((x) => x.regla.id === 'p').map((x) => [x.fecha, x.pospuesta])).toEqual([
      ['2026-11-23', false], ['2026-11-26', true], ['2026-11-30', false], ['2026-12-07', false],
    ]);
  });
});

describe('lo que propone Kepler', () => {
  it('ciclo propuesto vs. pocas rondas (se define a mano)', () => {
    expect(propuestaEnPalabras({ proposal_status: 'propuesto', cycle_days_proposed: 8 })).toBe('Cada 8 días');
    expect(propuestaEnPalabras({ proposal_status: 'pocas_compras', cycle_days_proposed: null })).toBe('Pocas rondas: define el ciclo a mano');
  });
});

describe('`[PQ.3.6]` la lista recortada se dice', () => {
  const nombre = (c: string) => ({ '04': 'Yurécuaro', '05': 'Zamora Centro', '06': 'Canindo' } as Record<string, string>)[c] ?? c;
  it('ve todas: no dice nada', () => {
    expect(alcanceEnPalabras({ todas: true, sucursales: ['04', '05'] }, nombre)).toBeNull();
    expect(paraQuienVe({ todas: true, sucursales: ['04'] }, nombre)).toBe('');
  });
  it('su sucursal, o su zona con «y»', () => {
    expect(alcanceEnPalabras({ todas: false, sucursales: ['04'] }, nombre)).toBe('Ves sólo las reglas de Yurécuaro: las de todas las sucursales las revisa la gerencia de compras.');
    expect(alcanceEnPalabras({ todas: false, sucursales: ['05', '06'] }, nombre)).toMatch(/^Ves sólo las reglas de Zamora Centro y Canindo:/);
    expect(paraQuienVe({ todas: false, sucursales: ['05', '06'] }, nombre)).toBe(' para Zamora Centro y Canindo');
  });
  it('negativa: sin sucursal en la ficha NO se lee como «no hay reglas»', () => {
    expect(alcanceEnPalabras({ todas: false, sucursales: [] }, nombre)).toMatch(/no tiene sucursal/);
    expect(paraQuienVe({ todas: false, sucursales: [] }, nombre)).toBe('');
  });
});

describe('`[PQ.3.14]` el día fijo por sucursal, en palabras', () => {
  it('cada semana, uno sí y otro no, cada N semanas', () => {
    expect(diaFijoEnPalabras({ weekday: 4, every_days: 7 })).toBe('cada jueves');
    expect(diaFijoEnPalabras({ weekday: 5, every_days: 14 })).toBe('un viernes sí y otro no');
    expect(diaFijoEnPalabras({ weekday: 4, every_days: 21 })).toBe('cada 3 semanas, en jueves');
    expect(diaFijoEnPalabras({ weekday: 1, every_days: 28 })).toBe('cada 4 semanas, en lunes');
  });
  it('lo reciente: «n de m»; si vino más de lo que pide el periodo, cuántas veces (nunca «9 de 6»); plural del sábado', () => {
    expect(diaFijoReciente({ weekday: 5, recientes: { en_el_dia: 5, esperadas: 6 } })).toBe('5 de 6 viernes en las últimas 13 semanas');
    expect(diaFijoReciente({ weekday: 1, recientes: { en_el_dia: 9, esperadas: 6 } })).toBe('9 lunes en las últimas 13 semanas');
    expect(diaFijoReciente({ weekday: 6, recientes: { en_el_dia: 9, esperadas: 13 } })).toBe('9 de 13 sábados en las últimas 13 semanas');
  });
  it('la evidencia completa del formulario, con la sucursal', () => {
    expect(diaFijoEvidencia({ branch_code: '04', weekday: 5, every_days: 14, dias: 13, en_el_dia: 13, recientes: { en_el_dia: 5, esperadas: 6 }, ultima: '2026-11-13' }, 'Yurécuaro'))
      .toBe('Kepler: en Yurécuaro, 13 de los 13 días con orden o entrada de los últimos 12 meses cayeron en viernes; 5 de 6 viernes en las últimas 13 semanas.');
  });
});

describe('`[PQ.3.18]` el embudo de llenado en palabras', () => {
  const total = { escalon: null, proveedores: 340, con_regla: 0, compra_pct: 100, compra_con_regla_pct: 0, ocs_pct: 100, ocs_con_regla_pct: 0 };
  it('el avance total, también en cero: dice 0\u00a0%, no vacío', () => {
    expect(avanceTotalEnPalabras(total)).toBe('Con regla: 0 de 340 proveedores · 0\u00a0% de la compra · 0\u00a0% de las OC');
    expect(avanceTotalEnPalabras({ ...total, con_regla: 5, compra_con_regla_pct: 12.25, ocs_con_regla_pct: 8 }))
      .toBe('Con regla: 5 de 340 proveedores · 12.3\u00a0% de la compra · 8\u00a0% de las OC');
  });
  it('sin la compra medida, el total lo DICE en vez de pintar un 0', () => {
    expect(avanceTotalEnPalabras({ ...total, compra_pct: null, compra_con_regla_pct: null, ocs_pct: null, ocs_con_regla_pct: null }))
      .toBe('Con regla: 0 de 340 proveedores (lo que pesan en la compra no se midió)');
  });
  it('el avance de un escalón: lo hecho DE lo que pesa', () => {
    expect(avanceEscalonEnPalabras({ escalon: 1, proveedores: 62, con_regla: 0, compra_pct: 82.8, compra_con_regla_pct: 0, ocs_pct: 65.8, ocs_con_regla_pct: 0 }))
      .toBe('0 de 62 proveedores · 0\u00a0% de 82.8\u00a0% de la compra · 0\u00a0% de 65.8\u00a0% de las OC');
  });
  it('el nombre de cada escalón dice qué junta', () => {
    expect(NOMBRE_ESCALON[1]).toBe('Escalón 1 · el 80\u00a0% de la compra o el 50\u00a0% de las OC');
    expect(NOMBRE_ESCALON[3]).toBe('Escalón 3 · ocasionales');
  });
  it('el peso del proveedor en su renglón, y sin medir lo dice', () => {
    expect(pesoEnPalabras({ escalon: 1, compra_pct: 10.9, ocs_12m: 490 }, 49)).toEqual({ principal: '10.9\u00a0% de la compra', detalle: '490 OC · 49 rondas en 12 meses · escalón 1' });
    expect(pesoEnPalabras(null, 1)).toEqual({ principal: 'Peso no medido', detalle: '1 ronda en 12 meses' });
    expect(porcentaje(0)).toBe('0\u00a0%');
  });
  it('NEGATIVA: el % nunca se separa de su número (espacio que no se parte), y un escalón vacío se dice en llano', () => {
    expect(porcentaje(68.1)).not.toContain(' %');
    expect(avanceEscalonEnPalabras({ escalon: 3, proveedores: 0, con_regla: 0, compra_pct: 0, compra_con_regla_pct: 0, ocs_pct: 0, ocs_con_regla_pct: 0 })).toBe('Ningún proveedor en este escalón');
  });
});
