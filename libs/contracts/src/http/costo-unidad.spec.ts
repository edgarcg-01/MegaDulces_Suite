import {
  anualEnCorte, avisosDeUnidad, CONCEPTOS_DE_FLOTA, depreciacionAnual, porKm, rangoEnCorte, repartir,
  RUBROS_COSTO_UNIDAD, rubroDeLinea, simularReposicion,
} from './costo-unidad.contract';

/**
 * `[FCU]` Las reglas de Costo por unidad. Los casos salen de la hoja «TRANSPORTES 2026 - COSTOS DE
 * TRANSPORTE»: si una regla deja de reproducir la hoja (corregida), esta prueba se pone roja.
 */
describe('costo-unidad · rubros', () => {
  it('los 14 renglones de la hoja + los 3 que la hoja no trae, en su orden', () => {
    expect(RUBROS_COSTO_UNIDAD.map((r) => r.codigo)).toEqual([
      'placas_refrendo_verificacion', 'arrendamiento_depreciacion', 'pension', 'gps_magnitracking', 'gps_salvador',
      'seguro', 'comisiones', 'salarios', 'mtto_preventivo', 'reparaciones', 'neumaticos', 'lubricantes',
      'gastos_directos', 'sueldos_admin', 'combustible', 'casetas', 'multas',
    ]);
  });

  it('cada renglón de Kepler va a su rubro; el GPS de Salvador se separa del de Magnitracking', () => {
    expect(rubroDeLinea('111')).toBe('seguro');
    expect(rubroDeLinea(' 255 ')).toBe('reparaciones');
    expect(rubroDeLinea('038')).toBe('combustible');
    expect(rubroDeLinea('209', 'SERV DE INSTALACION DE GPS HINO 500')).toBe('gps_magnitracking');
    expect(rubroDeLinea('209', 'GPS', 'SALVADOR RAMIREZ')).toBe('gps_salvador');
  });

  it('PRUEBA NEGATIVA: un concepto que no es de flota no tiene rubro', () => {
    expect(rubroDeLinea('054')).toBeNull();
    expect(rubroDeLinea('')).toBeNull();
  });

  it('ningún concepto está en dos rubros (salvo el 209, que se parte por el texto)', () => {
    const vistos = RUBROS_COSTO_UNIDAD.flatMap((r) => [...r.conceptos]).filter((c) => c !== '209');
    expect(new Set(vistos).size).toBe(vistos.length);
    expect(CONCEPTOS_DE_FLOTA).toContain('209');
  });
});

describe('costo-unidad · cortes de la hoja', () => {
  it('reproduce las columnas de la hoja (International 1, placas $3,600 al año)', () => {
    expect(anualEnCorte(3600, 'anual')).toBe(3600);
    expect(anualEnCorte(3600, 'seis_meses')).toBe(1800);
    expect(anualEnCorte(3600, 'cuatro_meses')).toBe(1200);
    expect(anualEnCorte(3600, 'mes')).toBe(300);
    expect(anualEnCorte(3600, 'periodo_28')).toBe(276.92);
    expect(anualEnCorte(3600, 'dia')).toBe(9.86);
  });

  it('un real de 40 días se lleva a «por mes» para compararlo', () => {
    expect(rangoEnCorte(4000, 40, 'mes')).toBe(3041.67);
  });

  it('PRUEBA NEGATIVA: sin días o sin km no hay corte ni $/km (no se divide entre cero ni entre un supuesto)', () => {
    expect(rangoEnCorte(100, 0, 'mes')).toBeNull();
    expect(porKm(100, null)).toBeNull();
    expect(porKm(100, 0)).toBeNull();
    expect(porKm(null, 10)).toBeNull();
    expect(porKm(611292.81, 80000)).toBe(7.64);
  });
});

describe('costo-unidad · reposición (tabla lateral de la hoja)', () => {
  it('reproduce sus cifras: $1,650,000, 5 % y 10 %, 80,000 km', () => {
    const t = simularReposicion({ valor: 1650000, incremento: 0.05, depreciacion: 0.1, km_anio: 80000, anios: 3 });
    expect(t[0]).toEqual({ anio: 1, valor_reposicion: 1650000, valor_residual: 1485000, perdida_acumulada: 165000, perdida_del_anio: 165000, por_km: 2.06 });
    expect(t[1]).toMatchObject({ valor_reposicion: 1732500, valor_residual: 1336500, perdida_acumulada: 396000, perdida_del_anio: 231000, por_km: 2.89 });
    expect(t[2]).toMatchObject({ valor_reposicion: 1819125, valor_residual: 1202850, perdida_acumulada: 616275, perdida_del_anio: 220275, por_km: 2.75 });
  });

  it('PRUEBA NEGATIVA: sin valor no hay tabla', () => {
    expect(simularReposicion({ valor: 0, incremento: 0.05, depreciacion: 0.1, km_anio: 80000, anios: 10 })).toEqual([]);
  });

  it('depreciación en línea recta; sin vida útil, no se inventa', () => {
    expect(depreciacionAnual({ purchase_value: 1500000, residual_value: 150000, useful_life_years: 10 })).toBe(135000);
    expect(depreciacionAnual({ purchase_value: 1500000, residual_value: null, useful_life_years: null })).toBeNull();
  });
});

describe('costo-unidad · reparto de la nómina administrativa', () => {
  const u = [{ vehicle_id: 'a', km: 3000 }, { vehicle_id: 'b', km: 1000 }, { vehicle_id: 'c', km: null }];

  it('por km: en proporción a sus km, y la suma cuadra al centavo', () => {
    const p = repartir(10000, u, 'km');
    expect(p.find((x) => x.vehicle_id === 'a')?.monto).toBe(7500);
    expect(p.find((x) => x.vehicle_id === 'b')?.monto).toBe(2500);
    expect(p.reduce((a, x) => a + (x.monto ?? 0), 0)).toBe(10000);
  });

  it('PRUEBA NEGATIVA: la unidad sin km queda fuera y lo dice (null, no $0)', () => {
    const c = repartir(10000, u, 'km').find((x) => x.vehicle_id === 'c');
    expect(c?.monto).toBeNull();
    expect(c?.razon).toMatch(/Sin km/);
  });

  it('PRUEBA NEGATIVA: si nadie tiene km, nadie recibe y todas lo dicen', () => {
    const p = repartir(10000, [{ vehicle_id: 'x', km: null }, { vehicle_id: 'y', km: 0 }], 'km');
    expect(p.every((x) => x.monto === null)).toBe(true);
  });

  it('en partes iguales: 3 unidades, $100 → 33.34 + 33.33 + 33.33', () => {
    const p = repartir(100, u, 'partes_iguales');
    expect(p.map((x) => x.monto)).toEqual([33.34, 33.33, 33.33]);
  });
});

describe('costo-unidad · avisos', () => {
  const base = { ficha: { insurance_expires_on: '2027-01-01' }, km: { km: 1000, fuente: 'gps' as const, dias_gps: 31 }, guias: 10, dias: 31, tienePresupuesto: true, sugerido: 0 };

  it('sin nada que decir, no avisa', () => {
    expect(avisosDeUnidad(base, '2026-10-26')).toEqual([]);
  });

  it('seguro vencido (la hoja trae 2024), por vencer en 30 días, o sin fecha', () => {
    expect(avisosDeUnidad({ ...base, ficha: { insurance_expires_on: '2024-05-15' } }, '2026-10-26').map((a) => a.tipo)).toEqual(['seguro_vencido']);
    expect(avisosDeUnidad({ ...base, ficha: { insurance_expires_on: '2026-11-05' } }, '2026-10-26')[0].texto).toBe('El seguro vence en 10 días (2026-11-05)');
    expect(avisosDeUnidad({ ...base, ficha: { insurance_expires_on: null } }, '2026-10-26').map((a) => a.tipo)).toEqual(['sin_fecha_seguro']);
  });

  it('sin km, GPS parcial, sin guías, sin presupuesto y lo sugerido sin confirmar', () => {
    expect(avisosDeUnidad({ ...base, km: { km: null, fuente: null, dias_gps: 0 } }, '2026-10-26').map((a) => a.tipo)).toEqual(['sin_km']);
    expect(avisosDeUnidad({ ...base, km: { km: 500, fuente: 'gps', dias_gps: 10 } }, '2026-10-26').map((a) => a.tipo)).toEqual(['gps_parcial']);
    expect(avisosDeUnidad({ ...base, guias: 0, tienePresupuesto: false, sugerido: 1234.5 }, '2026-10-26').map((a) => a.tipo))
      .toEqual(['sin_guias', 'sin_presupuesto', 'por_confirmar']);
  });
});
