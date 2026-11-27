// Sin `import ... from 'vitest'`: la config usa `globals: true` (con el import el spec no carga: compuerta spec-vivo).
import {
  actividadDeLaRegla, actividadDeRequisiciones, alcanceDeQuienVe, almacenesDelAlcance, armarCalendario, armarEmbudo, avisoConRegla, avisoSinRegla, canalCubierto, desdeEntradas, diaFijoDeActividad, diasFijosPorProveedor, nombreDelAlcance,
  plazasDelAlcance, reglaEnAlcance, repartirPropuestas, revisaPorAlcance, zonasDeCompra,
  type CanalCiclo, type CompraDoceMeses, type FilaActividad, type FilaRequisicion, type FilaEmbudo, type ReglaLeida, type SucursalZona,
} from './purchase-calendar.domain';

/** `[PQ.3.3]` La actividad de Kepler por alcance y el armado del calendario. El SQL se prueba contra base real. */

// Las zonas MEDIDAS en prod el 2026-11-20 (`analytics.v_branch_zone`).
const SUC: SucursalZona[] = [
  ['00', 'CEDIS', null, null], ['01', 'Padre Hidalgo', 'LP', 'La Piedad'], ['02', 'La Piedad Abastos', 'LP', 'La Piedad'],
  ['03', '8 Esquinas', 'LP', 'La Piedad'], ['04', 'Yurécuaro', 'LP', 'La Piedad'], ['05', 'Zamora Centro', 'ZAM', 'Zamora'],
  ['06', 'Canindo', 'ZAM', 'Zamora'], ['07', 'Morelia Madero', 'MOR', 'Morelia'], ['08', 'Morelia Abastos', 'MOR', 'Morelia'],
].map(([branch_code, branch_name, zona_code, zona_nombre]) => ({ branch_code: branch_code as string, branch_name, branch_short: null, zona_code, zona_nombre }));

const fila = (supplier_code: string, plaza: string, fechas: string[], fuente: FilaActividad['ultima_fuente'] = 'oc'): FilaActividad =>
  ({ supplier_code, plaza, fechas, ultima: fechas[fechas.length - 1], ultima_fuente: fuente });

const regla = (o: Partial<ReglaLeida>): ReglaLeida => ({
  id: 'r', supplier_code: 'P1', scope: 'corporate', zone_code: null, branch_code: null, pattern: 'weekdays', weekdays: [3],
  month_days: null, month_last_day: false, every_n_days: null, weekend_shift: 'friday', reviewer_user_id: null,
  out_of_cycle_until: null, out_of_cycle_reason: null, supplier_name: 'Proveedor uno', reviewer_name: null,
  definida_por: 'Gerencia', definida_el: '2026-10-01', vigente_desde: '2026-10-01', note: null, pedido_supplier_id: null, ...o,
});

describe('plazas y nombre del alcance', () => {
  it('corporativo = todas; zona = sus sucursales medidas; sucursal = la suya', () => {
    expect(plazasDelAlcance({ scope: 'corporate', zone_code: null, branch_code: null }, SUC)).toBeNull();
    expect([...(plazasDelAlcance({ scope: 'zone', zone_code: 'ZAM', branch_code: null }, SUC) ?? [])].sort()).toEqual(['05', '06']);
    expect([...(plazasDelAlcance({ scope: 'branch', zone_code: null, branch_code: '04' }, SUC) ?? [])]).toEqual(['04']);
  });

  it('el nombre se dice con palabras, y quién revisa sale del alcance si la regla no nombra a nadie', () => {
    expect(nombreDelAlcance({ scope: 'zone', zone_code: 'ZAM', branch_code: null }, SUC)).toBe('Zona Zamora');
    expect(nombreDelAlcance({ scope: 'branch', zone_code: null, branch_code: '04' }, SUC)).toBe('Yurécuaro');
    expect(revisaPorAlcance({ scope: 'corporate', zone_code: null, branch_code: null }, SUC)).toBe('Gerencia de compras');
    expect(revisaPorAlcance({ scope: 'branch', zone_code: null, branch_code: '06' }, SUC)).toBe('Encargado de Canindo');
  });
});

describe('actividadDeLaRegla — cada regla ve SÓLO su proveedor en SUS plazas', () => {
  const filas = [
    fila('P1', '04', ['2026-11-18']), fila('P1', '06', ['2026-11-17'], 'entrada'),
    fila('P1', '00', ['2026-11-12', '2026-11-19'], 'oc_cancelada'), fila('P2', '04', ['2026-11-20']),
  ];
  it('sucursal: la actividad de OTRA sucursal del mismo proveedor no la atiende', () => {
    expect(actividadDeLaRegla({ supplier_code: 'P1', scope: 'branch', zone_code: null, branch_code: '04' }, filas, SUC).fechas).toEqual(['2026-11-18']);
  });
  it('zona Zamora: sólo 05 y 06', () => {
    const a = actividadDeLaRegla({ supplier_code: 'P1', scope: 'zone', zone_code: 'ZAM', branch_code: null }, filas, SUC);
    expect(a).toEqual({ fechas: ['2026-11-17'], ultima: { fecha: '2026-11-17', fuente: 'entrada' } });
  });
  it('corporativo: todas las plazas del proveedor, y la última dice su fuente (OC cancelada)', () => {
    const a = actividadDeLaRegla({ supplier_code: 'P1', scope: 'corporate', zone_code: null, branch_code: null }, filas, SUC);
    expect(a.fechas).toEqual(['2026-11-12', '2026-11-17', '2026-11-18', '2026-11-19']);
    expect(a.ultima).toEqual({ fecha: '2026-11-19', fuente: 'oc_cancelada' });
  });
});

describe('desdeEntradas — la parte cara de la consulta, sólo lo necesario', () => {
  it('la ventana de rezago, o N + 7 si una regla «cada N» es más larga', () => {
    expect(desdeEntradas('2026-11-20', [{ pattern: 'weekdays', every_n_days: null }])).toBe('2026-09-19');
    expect(desdeEntradas('2026-11-20', [{ pattern: 'every_n_days', every_n_days: 90 }])).toBe('2026-08-15');
  });
});

describe('armarCalendario', () => {
  const hoy = '2026-11-20';
  it('ordena: rezagada (la más vieja primero) → toca hoy → al día; y cuenta el resumen', () => {
    const cal = armarCalendario(hoy, [
      regla({ id: 'a', supplier_code: 'A', supplier_name: 'Al día', weekdays: [3] }),
      regla({ id: 'b', supplier_code: 'B', supplier_name: 'Toca hoy', weekdays: [5] }),
      regla({ id: 'c', supplier_code: 'C', supplier_name: 'Rezagada', weekdays: [3] }),
    ], [fila('A', '00', ['2026-11-18']), fila('B', '00', ['2026-11-13']), fila('C', '00', ['2026-11-04'])], [], SUC);
    expect(cal.reglas.map((r) => [r.supplier_name, r.estado.estado])).toEqual([
      ['Rezagada', 'rezagada'], ['Toca hoy', 'toca_hoy'], ['Al día', 'al_dia'],
    ]);
    expect(cal.resumen).toEqual({ rezagada: 1, toca_hoy: 1, sin_ancla: 0, al_dia: 1, fuera_de_ciclo: 0 });
    expect(cal.fuente).toMatch(/canceladas/);
  });

  it('una marca «se pidió fuera de Kepler» atiende la fecha y es la última actividad', () => {
    const cal = armarCalendario(hoy, [regla({ id: 'x', weekdays: [3] })], [fila('P1', '00', ['2026-11-11'])], [
      { rule_id: 'x', review_date: '2026-11-18', outcome: 'ordered_outside_kepler', postponed_to: null, skip_reason: null, note: null, marcada_por: 'Ana', marcada_el: '2026-11-18T18:00:00Z' },
    ], SUC);
    expect(cal.reglas[0].estado.estado).toBe('al_dia');
    expect(cal.reglas[0].ultima_actividad).toEqual({ fecha: '2026-11-18', fuente: 'marca' });
    expect(cal.reglas[0].ultima_marca).toMatchObject({ outcome: 'ordered_outside_kepler', marcada_por: 'Ana' });
  });

  it('`[PQ.3.5]` trae las zonas con sus sucursales y, por regla, los almacenes de Pedido de SU alcance', () => {
    const alm = [{ id: 'w04', code: '04' }, { id: 'w05', code: '05' }, { id: 'w06', code: '06' }];
    const cal = armarCalendario(hoy, [
      regla({ id: 'corp' }),
      regla({ id: 'zam', scope: 'zone', zone_code: 'ZAM', pedido_supplier_id: 'sup-1', note: 'pasa en ruta' }),
      regla({ id: 'yur', scope: 'branch', branch_code: '04' }),
    ], [], [], SUC, alm);
    const por = Object.fromEntries(cal.reglas.map((r) => [r.id, r]));
    expect(por['corp'].pedido_warehouse_ids).toEqual([]); // corporativo = todas, sin filtro
    expect(por['zam'].pedido_warehouse_ids).toEqual(['w05', 'w06']);
    expect(por['yur'].pedido_warehouse_ids).toEqual(['w04']);
    expect(por['zam']).toMatchObject({ pedido_supplier_id: 'sup-1', note: 'pasa en ruta' });
    expect(cal.zonas).toEqual(zonasDeCompra(SUC));
    expect(cal.zonas.map((z) => [z.code, z.nombre, z.sucursales.join(',')])).toEqual([
      ['LP', 'La Piedad', '01,02,03,04'], ['ZAM', 'Zamora', '05,06'], ['MOR', 'Morelia', '07,08'],
    ]);
    expect(cal.sucursales).toEqual(['00', '01', '02', '03', '04', '05', '06', '07', '08']);
  });

  it('negativa: una sucursal sin almacén de Pedido no inventa uno (y el CEDIS no está en ninguna zona)', () => {
    expect(almacenesDelAlcance({ scope: 'branch', zone_code: null, branch_code: '07' }, SUC, [{ id: 'w05', code: '05' }])).toEqual([]);
    expect(zonasDeCompra(SUC).some((z) => z.sucursales.includes('00'))).toBe(false);
  });

  it('negativa: la marca de OTRA regla no atiende a ésta', () => {
    const cal = armarCalendario(hoy, [regla({ id: 'x', weekdays: [3] })], [fila('P1', '00', ['2026-11-11'])], [
      { rule_id: 'otra', review_date: '2026-11-18', outcome: 'ordered_outside_kepler', postponed_to: null, skip_reason: null, note: null, marcada_por: null, marcada_el: '2026-11-18T18:00:00Z' },
    ], SUC);
    expect(cal.reglas[0].estado.estado).toBe('rezagada');
  });
});

describe('`[PQ.3.6]` reglaEnAlcance — cada quien ve las reglas que caben COMPLETAS en sus sucursales (§10.1)', () => {
  const corp = { scope: 'corporate', zone_code: null, branch_code: null } as const;
  const zam = { scope: 'zone', zone_code: 'ZAM', branch_code: null } as const;
  const zamora = { scope: 'branch', zone_code: null, branch_code: '05' } as const;
  const yur = { scope: 'branch', zone_code: null, branch_code: '04' } as const;

  it('alcance `all` (null): ve todas, también la corporativa', () => {
    for (const r of [corp, zam, zamora, yur]) expect(reglaEnAlcance(r, SUC, null)).toBe(true);
  });

  it('el encargado de Zamora Centro (05) ve SÓLO la regla de su sucursal: ni la de su zona ni la corporativa', () => {
    expect([corp, zam, zamora, yur].map((r) => reglaEnAlcance(r, SUC, ['05']))).toEqual([false, false, true, false]);
  });

  it('la gerencia de la zona Zamora (05, 06) ve la de su zona y la de su sucursal, no la corporativa ni la de otra zona', () => {
    expect([corp, zam, zamora, yur].map((r) => reglaEnAlcance(r, SUC, ['05', '06']))).toEqual([false, true, true, false]);
  });

  it('negativa: la corporativa no cabe ni con las 8 sucursales sin el CEDIS (son TODAS las plazas)', () => {
    expect(reglaEnAlcance(corp, SUC, ['01', '02', '03', '04', '05', '06', '07', '08'])).toBe(false);
    expect(reglaEnAlcance(corp, SUC, SUC.map((x) => x.branch_code))).toBe(true);
  });

  it('negativa: sin sucursales ([]) no ve nada, y una zona sin sucursales no cabe en nadie recortado', () => {
    for (const r of [corp, zam, zamora]) expect(reglaEnAlcance(r, SUC, [])).toBe(false);
    expect(reglaEnAlcance({ scope: 'zone', zone_code: 'NADA', branch_code: null }, SUC, ['05'])).toBe(false);
  });

  it('armarCalendario recorta las reglas Y el resumen a lo que la persona ve, y lo DICE', () => {
    const reglas = [regla({ id: 'corp' }), regla({ id: 'zam', scope: 'zone', zone_code: 'ZAM' }), regla({ id: 'z05', scope: 'branch', branch_code: '05' })];
    const todo = armarCalendario('2026-11-20', reglas, [], [], SUC, [], null);
    const suyo = armarCalendario('2026-11-20', reglas, [], [], SUC, [], ['05']);
    expect(todo.reglas.map((r) => r.id).sort()).toEqual(['corp', 'z05', 'zam']);
    expect(todo.tu_alcance).toEqual({ todas: true, sucursales: SUC.map((x) => x.branch_code) });
    expect(suyo.reglas.map((r) => r.id)).toEqual(['z05']);
    expect(Object.values(suyo.resumen).reduce((a, b) => a + b, 0)).toBe(1);
    expect(suyo.tu_alcance).toEqual({ todas: false, sucursales: ['05'] });
  });

  it('alcanceDeQuienVe: sólo sucursales que existen, en el orden de la red; vacío = su ficha no tiene sucursal', () => {
    expect(alcanceDeQuienVe(SUC, ['06', '05', 'MD-30'])).toEqual({ todas: false, sucursales: ['05', '06'] });
    expect(alcanceDeQuienVe(SUC, [])).toEqual({ todas: false, sucursales: [] });
  });
});

/**
 * `[PQ.3.14]` El día fijo por sucursal. Los controles son pares MEDIDOS en prod (2026-11-21): un proveedor de
 * tostadas que en Yurécuaro entrega un viernes sí y otro no (13 de 13 días en viernes, cada 14), uno de bebidas
 * que en 8 Esquinas cae en jueves 34 de 42 días, y el mismo proveedor de tostadas en La Piedad Abastos: 8 de 8 en
 * miércoles, pero cada 49 días (no es un día fijo).
 */
describe('día fijo por sucursal (PQ.3.14)', () => {
  const HOY = '2026-11-21';
  /** n fechas desde `ultima` hacia atrás, cada `paso` días. */
  const serie = (ultima: string, n: number, paso: number): string[] => {
    const out: string[] = [];
    const [y, m, d] = ultima.split('-').map(Number);
    for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.UTC(y, m - 1, d - i * paso)).toISOString().slice(0, 10));
    return out;
  };

  it('control: 13 viernes, uno sí y otro no → viernes, cada 14 días, con su evidencia', () => {
    expect(diaFijoDeActividad(serie('2026-11-13', 13, 14), HOY)).toEqual({
      motivo: null, weekday: 5, every_days: 14, dias: 13, en_el_dia: 13, recientes: { en_el_dia: 6, esperadas: 6 }, ultima: '2026-11-13' });
  });

  it('control: cada jueves con días sueltos de otro día (34 de 42, 81 %) → jueves, cada semana', () => {
    const jueves = serie('2026-11-12', 34, 7);
    const sueltos = serie('2026-11-10', 8, 21); // martes
    const m = diaFijoDeActividad([...sueltos, ...jueves], HOY);
    expect(m).toMatchObject({ motivo: null, weekday: 4, every_days: 7, dias: 42, en_el_dia: 34, ultima: '2026-11-12' });
  });

  it('control: 8 de 8 en miércoles pero cada 49 días no es un día fijo (periodo irregular)', () => {
    expect(diaFijoDeActividad(serie('2026-11-18', 8, 49), HOY)).toEqual({ motivo: 'periodo_irregular' });
  });

  it('el umbral: 7 de 10 en el mismo día (70 %) sí; 6 de 9 (67 %) no', () => {
    const lunes = serie('2026-11-16', 7, 7);
    expect(diaFijoDeActividad([...lunes, '2026-11-04', '2026-10-22', '2026-10-09'], HOY)).toMatchObject({ motivo: null, weekday: 1, dias: 10, en_el_dia: 7 });
    expect(diaFijoDeActividad([...serie('2026-11-16', 6, 7), '2026-11-04', '2026-10-22', '2026-10-09'], HOY)).toEqual({ motivo: 'sin_dia_fijo' });
  });

  it('con menos de 8 días no se propone, aunque todos caigan el mismo día', () => {
    expect(diaFijoDeActividad(serie('2026-11-20', 7, 7), HOY)).toEqual({ motivo: 'pocos_dias' });
  });

  it('el mismo día repetido (OC y entrada el mismo día) cuenta una vez', () => {
    const v = serie('2026-11-20', 7, 7);
    expect(diaFijoDeActividad([...v, ...v], HOY)).toEqual({ motivo: 'pocos_dias' });
  });

  it('sin el ritmo reciente no se propone: la racha de abril con una OC suelta hoy (el caso medido: 97 % rezagada)', () => {
    expect(diaFijoDeActividad([...serie('2026-04-28', 14, 7), '2026-11-21'], HOY)).toEqual({ motivo: 'sin_ritmo_reciente' });
  });

  it('el ritmo reciente, en su borde: 7 de 13 jueves en las últimas 13 semanas sí; 6 de 13 no', () => {
    const viejos = serie('2026-06-04', 10, 7);
    expect(diaFijoDeActividad([...viejos, ...serie('2026-11-19', 7, 7)], HOY)).toMatchObject({ motivo: null, weekday: 4, recientes: { en_el_dia: 7, esperadas: 13 } });
    expect(diaFijoDeActividad([...viejos, ...serie('2026-11-19', 6, 7)], HOY)).toEqual({ motivo: 'sin_ritmo_reciente' });
  });

  it('por proveedor: sólo sucursales con zona (el CEDIS no: R7), ordenadas, y la plaza desconocida fuera', () => {
    const v = serie('2026-11-20', 12, 7);
    const m = diasFijosPorProveedor([
      { supplier_code: 'P1', plaza: '06', fechas: v },
      { supplier_code: 'P1', plaza: '04', fechas: serie('2026-11-13', 13, 14) },
      { supplier_code: 'P1', plaza: '00', fechas: v },
      { supplier_code: 'P1', plaza: 'MD-30', fechas: v },
      { supplier_code: 'P2', plaza: '05', fechas: v.slice(0, 5) },
    ], SUC, HOY);
    expect([...m.keys()]).toEqual(['P1']);
    expect(m.get('P1')?.map((p) => [p.branch_code, p.weekday, p.every_days])).toEqual([['04', 5, 14], ['06', 5, 7]]);
  });
});

describe('`[PQ.3.14]` el día fijo no se pierde al definir otra regla', () => {
  const d = (branch_code: string) => ({ branch_code, weekday: 4, every_days: 7 as const, dias: 30, en_el_dia: 28, recientes: { en_el_dia: 12, esperadas: 13 }, ultima: '2026-11-19' });
  const dias = new Map([['A', [d('07'), d('08')]], ['B', [d('07'), d('08')]], ['C', [d('04')]], ['D', [d('04')]]]);
  const r = repartirPropuestas([
    { supplier_code: 'A', reglas_vivas: 0, con_regla_de_sucursal: [] },          // sin regla: sus dos sucursales
    { supplier_code: 'B', reglas_vivas: 2, con_regla_de_sucursal: ['07'] },      // corporativa + la de 07: falta 08
    { supplier_code: 'C', reglas_vivas: 1, con_regla_de_sucursal: [] },          // sólo corporativa (o de zona): falta 04
    { supplier_code: 'D', reglas_vivas: 1, con_regla_de_sucursal: ['04'] },      // ya tiene la de 04: nada pendiente
    { supplier_code: 'E', reglas_vivas: 0, con_regla_de_sucursal: [] },          // sin regla y sin día fijo
  ], dias);

  it('sin regla: los que no tienen ninguna, con todo su día fijo (también el que no tiene)', () => {
    expect(r.sin_regla.map((p) => [p.supplier_code, p.dias_fijos.map((x) => x.branch_code)])).toEqual([['A', ['07', '08']], ['E', []]]);
  });
  it('pendiente: la regla corporativa o de zona NO borra la propuesta de sucursal; la de esa sucursal sí', () => {
    expect(r.dia_fijo_pendiente.map((p) => [p.supplier_code, p.dias_fijos.map((x) => x.branch_code)])).toEqual([['B', ['08']], ['C', ['04']]]);
  });
});

describe('`[PQ.3.18]` el embudo de llenado', () => {
  // Diez proveedores con números redondos (monto, OC): el total es 1,000 de compra y 100 OC.
  //   A 500/5 · B 200/5 · C 100/5 · D 50/40 (poco dinero, muchas OC) · E 50/15 · F 40/10 · G 30/10 · H 20/5 · I 10/4 (ocasional) · J 0/1 (ocasional con día fijo)
  const filas: FilaEmbudo[] = [
    ['A', 'propuesto', 1], ['B', 'propuesto', 0], ['C', 'propuesto', 0], ['D', 'compra_continua', 0], ['E', 'propuesto', 0],
    ['F', 'propuesto', 0], ['G', 'propuesto', 0], ['H', 'propuesto', 0], ['I', 'pocas_compras', 0], ['J', 'una_compra', 0],
  ].map(([supplier_code, proposal_status, reglas_vivas]) => ({
    supplier_code: supplier_code as string, proposal_status: proposal_status as string, reglas_vivas: reglas_vivas as number, con_dia_fijo: supplier_code === 'J',
  }));
  const compra = new Map<string, CompraDoceMeses>([
    ['A', { monto: 500, ocs: 5 }], ['B', { monto: 200, ocs: 5 }], ['C', { monto: 100, ocs: 5 }], ['D', { monto: 50, ocs: 40 }],
    ['E', { monto: 50, ocs: 15 }], ['F', { monto: 40, ocs: 10 }], ['G', { monto: 30, ocs: 10 }], ['H', { monto: 20, ocs: 5 }],
    ['I', { monto: 10, ocs: 4 }], ['J', { monto: 0, ocs: 1 }],
  ]);
  const { peso, embudo } = armarEmbudo(filas, compra);
  const escalon = (c: string) => peso.get(c)?.escalon;

  it('escalón 1 = los que juntan el 80 % de la compra (C empieza en 70 %) O el 50 % de las OC (E empieza en 40 % y termina en 55 %: entra el que empieza ANTES del umbral)', () => {
    // Por compra: A (0 % antes) · B (50 %) · C (70 %) entran; D empieza en 80 % → no. Por OC: D (0 %) · E (40 %) entran; F empieza en 55 % → no.
    expect(['A', 'B', 'C', 'D', 'E'].map(escalon)).toEqual([1, 1, 1, 1, 1]);
    expect(['F', 'G', 'H'].map(escalon)).toEqual([2, 2, 2]);
  });
  it('escalón 3 = ocasional SIN día fijo; con día fijo es escalón 2 (su regla ya viene armada)', () => {
    expect([escalon('I'), escalon('J')]).toEqual([3, 2]);
  });
  it('el peso de cada uno, en % de la compra y OC de 12 meses', () => {
    expect(peso.get('A')).toEqual({ escalon: 1, compra_pct: 50, ocs_12m: 5 });
    expect(peso.get('D')).toEqual({ escalon: 1, compra_pct: 5, ocs_12m: 40 });
  });
  it('el avance: con regla sólo A → 1 de 10 proveedores, 50 % de la compra y 5 % de las OC; los escalones suman el total', () => {
    expect(embudo.measured).toBe(true);
    expect(embudo.total).toEqual({ escalon: null, proveedores: 10, con_regla: 1, compra_pct: 100, compra_con_regla_pct: 50, ocs_pct: 100, ocs_con_regla_pct: 5 });
    expect(embudo.escalones.map((e) => [e.escalon, e.proveedores, e.con_regla, e.compra_pct, e.ocs_pct])).toEqual([
      [1, 5, 1, 90, 70], [2, 4, 0, 9, 26], [3, 1, 0, 1, 4],
    ]);
  });
  it('PRUEBA NEGATIVA: el escalón no depende de tener regla (A sin regla sigue en 1) y una regla dada de baja (0 vivas) sale del avance', () => {
    const sinReglas = armarEmbudo(filas.map((f) => ({ ...f, reglas_vivas: 0 })), compra);
    expect(sinReglas.peso.get('A')?.escalon).toBe(1);
    expect(sinReglas.embudo.total.con_regla).toBe(0);
    expect(sinReglas.embudo.total.compra_con_regla_pct).toBe(0);
  });
  it('con cero reglas y cero compra dice 0 %, no vacío ni NaN', () => {
    const vacio = armarEmbudo(filas.map((f) => ({ ...f, reglas_vivas: 0 })), new Map());
    expect(vacio.embudo.total).toEqual({ escalon: null, proveedores: 10, con_regla: 0, compra_pct: 0, compra_con_regla_pct: 0, ocs_pct: 0, ocs_con_regla_pct: 0 });
  });
  it('sin la compra de 12 meses (no medido): se cuentan proveedores y reglas, los % son null, sin escalones ni peso, y lo dice', () => {
    const nm = armarEmbudo(filas, null);
    expect(nm.embudo.measured).toBe(false);
    expect(nm.embudo.note).toMatch(/no se midió/);
    expect(nm.embudo.total).toEqual({ escalon: null, proveedores: 10, con_regla: 1, compra_pct: null, compra_con_regla_pct: null, ocs_pct: null, ocs_con_regla_pct: null });
    expect(nm.embudo.escalones).toEqual([]);
    expect(nm.peso.size).toBe(0);
  });
});

describe('`[PQ.3.17]` el calendario dice quién cambió cada regla y trae su historial', () => {
  const hoy = '2026-11-20';
  const cambio = { el: '2026-11-19T16:00:00Z', dia: '2026-11-19', por: 'Bea', campos: { note: { antes: null, despues: 'x' } }, nombres: {} };
  const tocada = regla({ id: 't', fue_cambiada: true, cambiada_por: 'Bea', cambiada_el: '2026-11-19T16:00:00Z', vigente_desde: '2026-11-19' });
  const intacta = regla({ id: 'i', supplier_code: 'P2', fue_cambiada: false, cambiada_por: 'Gerencia', cambiada_el: '2026-10-01T16:00:00Z' });

  it('el último cambio sale de la regla (quién, el instante y el día de México); la que nadie tocó, null', () => {
    const cal = armarCalendario(hoy, [tocada, intacta], [], [], SUC);
    const por = Object.fromEntries(cal.reglas.map((r) => [r.id, r.ultimo_cambio]));
    expect(por['t']).toEqual({ por: 'Bea', el: '2026-11-19T16:00:00Z', dia: '2026-11-19' });
    expect(por['i']).toBeNull();
  });

  it('con historial medido, cada regla trae sus cambios y cuántos tiene (la que no tiene ninguno, lista vacía)', () => {
    const cal = armarCalendario(hoy, [tocada, intacta], [], [], SUC, [], null,
      { measured: true, note: null, por: new Map([['t', { cambios: [cambio], total: 3 }]]) });
    const t = cal.reglas.find((r) => r.id === 't')!;
    const i = cal.reglas.find((r) => r.id === 'i')!;
    expect([t.cambios, t.cambios_total]).toEqual([[cambio], 3]);
    expect([i.cambios, i.cambios_total]).toEqual([[], 0]);
    expect(cal.historial).toEqual({ measured: true, note: null });
  });

  it('NEGATIVA: sin historial medido, ninguna regla trae `cambios` (no «sin cambios») y el calendario lo dice', () => {
    const cal = armarCalendario(hoy, [tocada], [], [], SUC, [], null, { measured: false, note: 'no se leyó', por: new Map() });
    expect('cambios' in cal.reglas[0]).toBe(false);
    expect(cal.historial).toEqual({ measured: false, note: 'no se leyó' });
    expect('historial' in armarCalendario(hoy, [tocada], [], [], SUC)).toBe(false);
  });
});

describe('[PQ.3.24] el aviso «Hoy te toca» de Pedido (DC35: manda el Calendario)', () => {
  const HOY = '2026-11-25';
  type E = 'rezagada' | 'toca_hoy' | 'al_dia' | 'fuera_de_ciclo' | 'sin_ancla';
  const conEstado = (supplier_code: string, estado: E) =>
    ({ supplier_code, estado: { estado, pendiente_desde: null, dias_atraso: 0, proxima: null } });
  const canal = (supplier_id: string, supplier_code: string | null, plaza: string | null, proxima: string): CanalCiclo =>
    ({ supplier_id, supplier_code, plaza, proxima });

  it('con regla: un proveedor cuenta UNA vez, rezagado si alguna regla lo está; al día, sin ancla y fuera de ciclo no son «te toca»', () => {
    const r = avisoConRegla([
      conEstado('A', 'rezagada'), conEstado('A', 'toca_hoy'), // A: rezagado (no también «hoy»)
      conEstado('B', 'toca_hoy'), conEstado('B', 'al_dia'),
      conEstado('C', 'al_dia'), conEstado('D', 'sin_ancla'), conEstado('E', 'fuera_de_ciclo'),
    ]);
    expect(r).toEqual({ rezagados: 1, hoy: 1, proveedores: 5 });
    expect(avisoConRegla([])).toEqual({ rezagados: 0, hoy: 0, proveedores: 0 });
  });

  it('NEGATIVA del criterio: un proveedor con regla al día NO sale vencido aunque su canal lo esté', () => {
    const reglas = [regla({ supplier_code: 'P1', scope: 'corporate' })];
    const canales = [canal('id-p1', 'P1', '04', '2026-11-01'), canal('id-p1', 'P1', '06', '2026-11-25')];
    expect(avisoSinRegla(canales, reglas, SUC, HOY)).toEqual({ vencidos: 0, hoy: 0 });
    // Control: sin la regla, el mismo canal sí es «te toca» (sin confirmar).
    expect(avisoSinRegla(canales, [], SUC, HOY)).toEqual({ vencidos: 1, hoy: 0 });
  });

  it('la regla de zona cubre SUS sucursales; el canal del mismo proveedor en otra zona sigue sin regla', () => {
    const reglas = [regla({ supplier_code: 'P1', scope: 'zone', zone_code: 'ZAM' })];
    expect(canalCubierto(canal('id-p1', 'P1', '05', HOY), reglas, SUC)).toBe(true);
    expect(canalCubierto(canal('id-p1', 'P1', '04', HOY), reglas, SUC)).toBe(false);
    expect(avisoSinRegla([canal('id-p1', 'P1', '05', '2026-11-01'), canal('id-p1', 'P1', '04', HOY)], reglas, SUC, HOY))
      .toEqual({ vencidos: 0, hoy: 1 });
  });

  it('la regla de sucursal no cubre otra sucursal; un almacén que no es sucursal sólo lo cubre la corporativa', () => {
    const suc = [regla({ supplier_code: 'P1', scope: 'branch', branch_code: '06' })];
    expect(canalCubierto(canal('id-p1', 'P1', '06', HOY), suc, SUC)).toBe(true);
    expect(canalCubierto(canal('id-p1', 'P1', '05', HOY), suc, SUC)).toBe(false);
    expect(canalCubierto(canal('id-p1', 'P1', null, HOY), suc, SUC)).toBe(false);
    expect(canalCubierto(canal('id-p1', 'P1', null, HOY), [regla({ supplier_code: 'P1' })], SUC)).toBe(true);
  });

  it('R5: la regla cubre también por la ficha de Pedido que resolvió, aunque la clave de la ficha sea otra o no exista', () => {
    const reglas = [regla({ supplier_code: 'P9', pedido_supplier_id: 'id-ficha' })];
    expect(canalCubierto(canal('id-ficha', 'OTRA', '04', HOY), reglas, SUC)).toBe(true);
    expect(canalCubierto(canal('id-ficha', null, '04', HOY), reglas, SUC)).toBe(true);
    expect(canalCubierto(canal('id-otra', null, '04', HOY), reglas, SUC)).toBe(false);
  });

  it('fuera de ciclo también cubre: la gerencia ya decidió sobre ese proveedor', () => {
    const reglas = [regla({ supplier_code: 'P1', out_of_cycle_until: '2027-05-01', out_of_cycle_reason: 'Ocasional' })];
    expect(avisoSinRegla([canal('id-p1', 'P1', '04', '2026-10-01')], reglas, SUC, HOY)).toEqual({ vencidos: 0, hoy: 0 });
  });

  it('sin regla: cada proveedor una vez, por su canal más atrasado; lo de mañana no cuenta', () => {
    const canales = [
      canal('id-a', 'A', '04', HOY), canal('id-a', 'A', '05', '2026-11-20'), // A: vencido (no también hoy)
      canal('id-b', 'B', '04', HOY), canal('id-b', 'B', '06', HOY),          // B: hoy, una vez
      canal('id-c', 'C', '04', '2026-11-26'),                               // C: mañana, no cuenta
    ];
    expect(avisoSinRegla(canales, [], SUC, HOY)).toEqual({ vencidos: 1, hoy: 1 });
    expect(avisoSinRegla([], [], SUC, HOY)).toEqual({ vencidos: 0, hoy: 0 });
  });
});

describe('[PQ.3.29] la requisición de compra de la Suite atiende la revisión en la sucursal DESTINO (DC40)', () => {
  // Miércoles 25-nov-2026: el caso medido en prod. Las requisiciones salen de la 08 y van a 05 y 06; a 02 no va nada.
  const HOY = '2026-11-25';
  // Cada sucursal tuvo su OC el miércoles pasado: hoy sólo toca la fecha de hoy (sin eso, la regla nace rezagada).
  const semanaPasada = ['05', '06', '02'].map((b) => fila('CV003', b, ['2026-11-18']));
  const req = (supplier_id: string, supplier_code: string | null, plaza: string, fechas: string[]): FilaRequisicion =>
    ({ supplier_id, supplier_code, plaza, fechas, ultima: [...fechas].sort().pop() as string });

  it('cada fila es actividad con fuente «requisicion»; misma clave y sucursal se juntan', () => {
    const a = actividadDeRequisiciones([req('f1', 'CV003', '05', ['2026-11-24']), req('f1', 'CV003', '05', ['2026-11-25'])], []);
    expect(a).toEqual([{ supplier_code: 'CV003', plaza: '05', fechas: ['2026-11-24', '2026-11-25'], ultima: '2026-11-25', ultima_fuente: 'requisicion' }]);
  });

  it('R5: cuenta también para la clave de la regla que resolvió esa ficha de Pedido (y sin clave en la ficha, sólo para ésa)', () => {
    const reglas = [{ supplier_code: 'K1', pedido_supplier_id: 'f1' }];
    expect(actividadDeRequisiciones([req('f1', 'F1', '05', [HOY])], reglas).map((x) => x.supplier_code).sort()).toEqual(['F1', 'K1']);
    expect(actividadDeRequisiciones([req('f1', null, '05', [HOY])], reglas).map((x) => x.supplier_code)).toEqual(['K1']);
    expect(actividadDeRequisiciones([req('f9', null, '05', [HOY])], reglas)).toEqual([]);
  });

  it('el caso de CV003: 05 y 06 quedan al día por su requisición; 02 sigue «toca hoy» (no hubo requisición para ella)', () => {
    const reglas = ['05', '06', '02'].map((b) => regla({ id: b, supplier_code: 'CV003', scope: 'branch', branch_code: b, weekdays: [3] }));
    // Control: sin las requisiciones (como antes), las tres «tocan hoy» aunque la OC de Kepler salió de la 08.
    const antes = armarCalendario(HOY, reglas, [...semanaPasada, fila('CV003', '08', [HOY])], [], SUC);
    expect(antes.reglas.map((r) => [r.branch_code, r.estado.estado]).sort()).toEqual([['02', 'toca_hoy'], ['05', 'toca_hoy'], ['06', 'toca_hoy']]);
    const act = [...semanaPasada, fila('CV003', '08', [HOY]), ...actividadDeRequisiciones([req('f', 'CV003', '05', [HOY]), req('f', 'CV003', '06', [HOY])], reglas)];
    const cal = armarCalendario(HOY, reglas, act, [], SUC);
    const por = Object.fromEntries(cal.reglas.map((r) => [r.branch_code, r]));
    expect(por['05'].estado.estado).toBe('al_dia');
    expect(por['06'].estado.estado).toBe('al_dia');
    expect(por['05'].ultima_actividad).toEqual({ fecha: HOY, fuente: 'requisicion' });
    expect(por['02'].estado.estado).toBe('toca_hoy');
  });

  it('NEGATIVA: la requisición que va a la 08 no atiende la regla de la 05', () => {
    const reglas = [regla({ id: 'r05', supplier_code: 'CV003', scope: 'branch', branch_code: '05', weekdays: [3] })];
    const cal = armarCalendario(HOY, reglas, [...semanaPasada, ...actividadDeRequisiciones([req('f', 'CV003', '08', [HOY])], reglas)], [], SUC);
    expect(cal.reglas[0].estado.estado).toBe('toca_hoy');
  });

  it('el mismo día, la OC de Kepler gana como «última atención» (va primero)', () => {
    const reglas = [regla({ id: 'r05', supplier_code: 'CV003', scope: 'branch', branch_code: '05', weekdays: [3] })];
    const act = [fila('CV003', '05', [HOY]), ...actividadDeRequisiciones([req('f', 'CV003', '05', [HOY])], reglas)];
    expect(armarCalendario(HOY, reglas, act, [], SUC).reglas[0].ultima_actividad).toEqual({ fecha: HOY, fuente: 'oc' });
  });
});
