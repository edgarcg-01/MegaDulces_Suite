import type { FichaUnidad, RubroCodigo } from '@megadulces/contracts';
import { anualAlPeriodo, armarUnidad, diasPorAnio, mesesDelPeriodo, periodoDe, repartoDeNomina, type DatosUnidad } from './costo-unidad.logic';

/**
 * `[FCU.1]` El costo de una unidad: presupuesto prorrateado, real por rubro con su procedencia, y lo
 * que falta dicho (nunca $0). Casos de la hoja (International 1) y de Kepler (seguro de $36,611.49).
 */
const ficha = (o: Partial<FichaUnidad> = {}): FichaUnidad => ({
  vehicle_id: 'u1', economic_number: 'UNIDAD 1', display_name: 'INTERNATIONAL 1', plate: '55AB1M', plate_kepler: '55AB1M',
  kepler_code: '00001', vin: null, year: 2016, brand: null, model: null, fleet_area: 'transportes', ownership: null,
  purchase_value: null, purchase_date: null, useful_life_years: null, residual_value: null, insurance_carrier: null,
  insurance_policy: null, insurance_premium: null, insurance_expires_on: '2027-05-15', driver_monthly_salary: 7566,
  salario_visible: true, budget_km_year: 80000, kepler_aliases: ['INTERNATIONAL 1'], tiene_gps: true, notes: null, ...o,
});
const pres = (o: Partial<Record<RubroCodigo, number>>) => new Map(Object.entries(o).map(([k, v]) => [k as RubroCodigo, new Map([[2026, v as number]])]));
const datos = (o: Partial<DatosUnidad> = {}): DatosUnidad => ({
  ficha: ficha(), lineas: [], presupuesto: pres({ seguro: 42845, salarios: 90792 }), km: { km: 3000, fuente: 'gps', dias_gps: 31 },
  comisiones: [], nomina: null, ...o,
});
const OCT = periodoDe('2026-10-01', '2026-10-31', '2026-10-26');

describe('[FCU.1] el periodo', () => {
  it('sin fechas: del 1 del mes a hoy', () => {
    expect(periodoDe(undefined, undefined, '2026-10-26')).toEqual({ desde: '2026-10-01', hasta: '2026-10-26', dias: 26 });
  });
  it('PRUEBA NEGATIVA: fechas al revés, mal escritas o de más de un año se rechazan', () => {
    expect(() => periodoDe('2026-10-31', '2026-10-01', '2026-10-26')).toThrow(/después/);
    expect(() => periodoDe('31/10/2026', undefined, '2026-10-26')).toThrow(/AAAA-MM-DD/);
    expect(() => periodoDe('2025-01-01', '2026-10-26', '2026-10-26')).toThrow(/un año/);
  });
  it('días por año y meses tocados', () => {
    expect(diasPorAnio(periodoDe('2025-12-20', '2026-01-10', '2026-10-26'))).toEqual([{ anio: 2025, dias: 12 }, { anio: 2026, dias: 10 }]);
    expect(mesesDelPeriodo(periodoDe('2026-09-20', '2026-10-05', '2026-10-26')))
      .toEqual([{ ym: '2026-09', dias: 11, diasMes: 30 }, { ym: '2026-10', dias: 5, diasMes: 31 }]);
  });
  it('el presupuesto anual se prorratea por días (seguro $42,845 × 31 ÷ 365 = $3,638.89)', () => {
    expect(anualAlPeriodo(new Map([[2026, 42845]]), OCT)).toBe(3638.89);
    expect(anualAlPeriodo(new Map(), OCT)).toBeNull();
  });
});

describe('[FCU.1] armarUnidad', () => {
  it('Kepler: el seguro pagado es el real, con sus renglones; lo sugerido se distingue', () => {
    const u = armarUnidad(datos({ lineas: [{ rubro: 'seguro', importe: 36611.49, estado: 'sugerido' }] }), OCT, '2026-10-26', true);
    const s = u.rubros.find((r) => r.rubro === 'seguro')!;
    expect(s).toMatchObject({ real: 36611.49, procedencia: 'kepler', sugerido: 36611.49, renglones: 1, presupuesto_anual: 42845, presupuesto: 3638.89 });
    expect(u.sugerido).toBe(36611.49);
    expect(u.avisos.map((a) => a.tipo)).toContain('por_confirmar');
  });

  it('salario: capturado en la ficha × días; sin capturar se DICE', () => {
    expect(armarUnidad(datos(), OCT, '2026-10-26', true).rubros.find((r) => r.rubro === 'salarios'))
      .toMatchObject({ real: 7711.1, procedencia: 'captura' }); // 7,566 × 12 × 31 ÷ 365
    expect(armarUnidad(datos({ ficha: ficha({ driver_monthly_salary: null }) }), OCT, '2026-10-26', true).rubros.find((r) => r.rubro === 'salarios'))
      .toMatchObject({ real: null, procedencia: 'sin_dato' });
  });

  it('PRUEBA NEGATIVA: sin permiso, el salario y la nómina administrativa no viajan ni suman', () => {
    const u = armarUnidad(datos({ nomina: { sueldos_admin: 5000, gastos_directos: 100, razon: 'x' } }), OCT, '2026-10-26', false);
    const sal = u.rubros.find((r) => r.rubro === 'salarios')!;
    const adm = u.rubros.find((r) => r.rubro === 'sueldos_admin')!;
    expect([sal.real, sal.presupuesto, adm.real]).toEqual([null, null, null]);
    // Se rotula «Restringido» (no «Capturado» ni «Falta capturar») y no cuenta como rubro sin dato.
    expect([sal.procedencia, adm.procedencia]).toEqual(['restringido', 'restringido']);
    expect(u.rubros.filter((r) => r.procedencia === 'sin_dato' || r.procedencia === 'sin_medir').length).toBe(u.rubros_sin_dato);
    expect(armarUnidad(datos({ nomina: { sueldos_admin: 5000, gastos_directos: 100, razon: 'x' } }), OCT, '2026-10-26', true).rubros_sin_dato)
      .toBe(u.rubros_sin_dato);
    expect(u.rubros.find((r) => r.rubro === 'gastos_directos')!.real).toBe(100);
    expect(u.real).toBe(100);
  });

  it('comisiones: guías × tarifa del chofer; la ruta sin tarifa no suma y se cuenta', () => {
    const c = armarUnidad(datos({ comisiones: [180, 180, null, 61.92] }), OCT, '2026-10-26', true).rubros.find((r) => r.rubro === 'comisiones')!;
    expect(c).toMatchObject({ real: 421.92, procedencia: 'calculado', renglones: 4 });
    expect(c.calculo).toMatch(/1 con ruta sin tarifa/);
  });

  it('arrendamiento/depreciación: propia con datos → depreciación; sin decir si es propia → falta', () => {
    const propia = ficha({ ownership: 'propia', purchase_value: 1500000, residual_value: 150000, useful_life_years: 10 });
    expect(armarUnidad(datos({ ficha: propia }), OCT, '2026-10-26', true).rubros.find((r) => r.rubro === 'arrendamiento_depreciacion'))
      .toMatchObject({ real: 11465.75, procedencia: 'calculado' });
    expect(armarUnidad(datos(), OCT, '2026-10-26', true).rubros.find((r) => r.rubro === 'arrendamiento_depreciacion'))
      .toMatchObject({ real: null, procedencia: 'sin_dato' });
    // Arrendada sin pagos de renta que la nombren: «Sin medir», nunca $0 ni «Kepler» vacío.
    expect(armarUnidad(datos({ ficha: ficha({ ownership: 'arrendada' }) }), OCT, '2026-10-26', true).rubros.find((r) => r.rubro === 'arrendamiento_depreciacion'))
      .toMatchObject({ real: null, procedencia: 'sin_medir' });
  });

  it('PRUEBA NEGATIVA: lo sin dato NO suma al total, y se cuenta', () => {
    const u = armarUnidad(datos({ ficha: ficha({ driver_monthly_salary: null }) }), OCT, '2026-10-26', true);
    expect(u.rubros_sin_dato).toBe(4); // salario, arrendamiento, nómina (sueldos y gastos directos)
    expect(u.real).toBe(0);
  });

  it('$/km real con km del GPS; sin km no hay $/km; el de la hoja = su total anual ÷ sus km', () => {
    const u = armarUnidad(datos({ lineas: [{ rubro: 'combustible', importe: 6000, estado: 'confirmado' }] }), OCT, '2026-10-26', true);
    expect(u.por_km_real).toBe(4.57); // (6,000 + 7,711.10) ÷ 3,000 km
    expect(u.por_km_presupuesto).toBe(1.67); // (42,845 + 90,792) ÷ 80,000 km
    expect(armarUnidad(datos({ km: { km: null, fuente: null, dias_gps: 0 } }), OCT, '2026-10-26', true).por_km_real).toBeNull();
  });
});

describe('[FCU.1] reparto de la nómina administrativa', () => {
  const meses = mesesDelPeriodo(OCT);
  it('se reparte por los km de cada unidad en el mes', () => {
    const r = repartoDeNomina(meses, new Map([['2026-10', { sueldos_admin: 30000, gastos_directos: 0, metodo: 'km' }]]),
      new Map([['2026-10', new Map([['a', 2000], ['b', 1000]])]]), ['a', 'b']);
    expect(r.porUnidad.get('a')?.sueldos_admin).toBe(20000);
    expect(r.porUnidad.get('b')?.sueldos_admin).toBe(10000);
    expect(r.mesesSinNomina).toEqual([]);
  });
  it('PRUEBA NEGATIVA: un mes sin capturar se dice; la unidad sin km queda fuera (null)', () => {
    const r = repartoDeNomina(mesesDelPeriodo(periodoDe('2026-09-01', '2026-10-31', '2026-10-31')),
      new Map([['2026-10', { sueldos_admin: 30000, gastos_directos: 0, metodo: 'km' }]]), new Map([['2026-10', new Map([['a', 2000]])]]), ['a', 'b']);
    expect(r.mesesSinNomina).toEqual(['2026-09']);
    expect(r.porUnidad.get('a')?.sueldos_admin).toBe(30000);
    expect(r.porUnidad.get('b')?.sueldos_admin).toBeNull();
  });
  it('sin ningún mes capturado no hay reparto', () => {
    expect(repartoDeNomina(meses, new Map(), new Map(), ['a']).porUnidad.size).toBe(0);
  });
});
