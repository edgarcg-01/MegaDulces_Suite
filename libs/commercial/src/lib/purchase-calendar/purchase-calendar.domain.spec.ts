// Sin `import ... from 'vitest'`: la config usa `globals: true` (con el import el spec no carga: compuerta spec-vivo).
import {
  actividadDeLaRegla, alcanceDeQuienVe, almacenesDelAlcance, armarCalendario, desdeEntradas, nombreDelAlcance, plazasDelAlcance, reglaEnAlcance,
  revisaPorAlcance, zonasDeCompra,
  type FilaActividad, type ReglaLeida, type SucursalZona,
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
