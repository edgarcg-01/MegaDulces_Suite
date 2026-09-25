import {
  computePeriodComparativo, computePeriodCoverage, deltaPct, mesesParciales, ultimoDiaMes,
  ETIQUETA_PLAZA, type PeriodSlice,
} from './period-coverage';

/**
 * [GX.19] La medición que justifica la fase vive ACÁ y no en un comentario.
 *
 * Un comentario con una cifra no avisa cuando deja de ser cierto; un test sí. Es la lección que
 * `[CDRP.2.1]` pagó — una medición persistida en un `COMMENT ON TABLE` de prod envejeció en tres
 * días. Los números de abajo son los de prod del 2026-09-25 y si el motor deja de reproducirlos,
 * esto se pone rojo.
 */
describe('cobertura de egresos', () => {
  describe('computePeriodComparativo', () => {
    it('separa el Δ de universo del Δ de gasto — el caso medido en prod (2026-09-25)', () => {
      // Rango por defecto (90 d) contra los 90 previos. Las sucursales 06/07/08 ENTRARON al
      // universo en el período actual (cutover de ERP + alta de contabilidad); 00-05 están en los
      // dos. Cifras exactas de `analytics.expense_entries`.
      const actual: PeriodSlice[] = [
        { mes: '2026-08', grupo: '00', total: 155_487_953.74 }, // las 6 de siempre, agregadas
        { mes: '2026-09', grupo: '06', total: 2_948_916.67 },
        { mes: '2026-09', grupo: '07', total: 20_000_000.0 },
        { mes: '2026-09', grupo: '08', total: 16_795_754.31 },
      ];
      const previo: PeriodSlice[] = [
        { mes: '2026-05', grupo: '00', total: 153_731_451.29 },
      ];

      const c = computePeriodComparativo(actual, previo);

      expect(c.total).toBe(195_232_624.72);
      expect(c.total_prev).toBe(153_731_451.29);
      // Lo que la pantalla publicaba sola: se lee como "el gasto subió 27 %".
      expect(c.delta_pct).toBe(27.0);
      // Lo que de verdad pasó con el gasto comparable.
      expect(c.delta_pct_comparable).toBe(1.1);
      expect(c.solo_actual).toEqual(['06', '07', '08']);
      expect(c.solo_previo).toEqual([]);
      expect(c.universo_cambio).toBe(true);
    });

    it('no inventa un cambio de universo cuando no lo hay', () => {
      const filas: PeriodSlice[] = [{ mes: '2026-08', grupo: '00', total: 100 }];
      const c = computePeriodComparativo(filas, [{ mes: '2026-05', grupo: '00', total: 80 }]);
      expect(c.universo_cambio).toBe(false);
      expect(c.delta_pct).toBe(25);
      expect(c.delta_pct_comparable).toBe(25);
    });

    it('declara el Δ como NO MEDIDO cuando la base es cero (nunca 0 % ni Infinity)', () => {
      expect(deltaPct(1_000, 0)).toBeNull();
      const c = computePeriodComparativo([{ mes: '2026-08', grupo: '06', total: 500 }], []);
      expect(c.delta_pct).toBeNull();
      expect(c.delta_pct_comparable).toBeNull();
      // Una sucursal que sólo existe ahora NO es un aumento de gasto: es universo.
      expect(c.solo_actual).toEqual(['06']);
    });
  });

  describe('computePeriodCoverage', () => {
    it('marca la sucursal que entra a mitad del rango y cuánto pesa', () => {
      const filas: PeriodSlice[] = [
        { mes: '2026-07', grupo: '00', total: 600 },
        { mes: '2026-08', grupo: '00', total: 400 },
        { mes: '2026-08', grupo: '06', total: 250 },
      ];
      const c = computePeriodCoverage(filas, '2026-07-01', '2026-08-31');

      expect(c.measured).toBe(true);
      expect(c.grupos_todos).toEqual(['00']);
      expect(c.grupos_parciales).toEqual([{ grupo: '06', desde: '2026-08', total: 250 }]);
      expect(c.pct).toBe(80); // 1000 de 1250
      expect(c.meses_parciales).toEqual([]);
      expect(c.note).toContain('06 (desde 2026-08)');
    });

    it('declara «sin medir» en vez de afirmar cobertura total cuando no hay filas', () => {
      const c = computePeriodCoverage([], '2026-07-01', '2026-08-31');
      expect(c.measured).toBe(false);
      expect(c.pct).toBeNull();
      expect(c.grupos).toEqual([]);
    });

    it('dice explícitamente que la tendencia es comparable cuando lo es', () => {
      const filas: PeriodSlice[] = [
        { mes: '2026-07', grupo: '00', total: 10 },
        { mes: '2026-08', grupo: '00', total: 12 },
      ];
      const c = computePeriodCoverage(filas, '2026-07-01', '2026-08-31');
      expect(c.pct).toBe(100);
      expect(c.note).toContain('comparable');
    });
  });

  describe('mesesParciales', () => {
    it('detecta las dos puntas del rango por defecto (90 días)', () => {
      // El default de la pantalla: hoy − 90 d … hoy. Junio arranca el 27 y septiembre corta el 25.
      expect(mesesParciales(['2026-06', '2026-07', '2026-08', '2026-09'], '2026-06-27', '2026-09-25'))
        .toEqual(['2026-06', '2026-09']);
    });

    it('un mes entero no es parcial', () => {
      expect(mesesParciales(['2026-08'], '2026-08-01', '2026-08-31')).toEqual([]);
    });

    it('calcula el último día sin correrse por zona horaria, incluido febrero bisiesto', () => {
      expect(ultimoDiaMes('2026-02')).toBe('2026-02-28');
      expect(ultimoDiaMes('2024-02')).toBe('2024-02-29');
      expect(ultimoDiaMes('2026-12')).toBe('2026-12-31');
      // Enero completo NO debe salir parcial: es el borde donde un `new Date()` en UTC-6 fallaba.
      expect(mesesParciales(['2026-01'], '2026-01-01', '2026-01-31')).toEqual([]);
    });
  });
});

/**
 * `[IG.1]` El mismo mecanismo, del lado del INGRESO. No se duplica el módulo: se le dice cómo se
 * llama su grupo. Estas cifras son las medidas en prod el 2026-09-25 para el rango por defecto.
 */
describe('cobertura del lado ingreso (mismo motor, otra etiqueta)', () => {
  it('habla de PLAZAS, no de sucursales', () => {
    const filas: PeriodSlice[] = [
      { mes: '2026-08', grupo: 'MORELIA ABASTOS', total: 30_208_668.0 },
      { mes: '2026-09', grupo: 'MORELIA ABASTOS', total: 10_000_000.0 },
      { mes: '2026-09', grupo: 'MORELIA MADERO', total: 6_155_966.01 },
    ];
    const c = computePeriodCoverage(filas, '2026-08-01', '2026-09-25', ETIQUETA_PLAZA);

    expect(c.note).toContain('plaza');
    expect(c.note).not.toContain('sucursal');
    expect(c.grupos_todos).toEqual(['MORELIA ABASTOS']);
    expect(c.grupos_parciales[0].grupo).toBe('MORELIA MADERO');
    // Septiembre está cortado (el rango termina el 25) — la barra baja NO es caída de venta.
    expect(c.meses_parciales).toEqual(['2026-09']);
  });

  it('una plaza que abre a mitad del rango no es crecimiento de venta', () => {
    const c = computePeriodComparativo(
      [{ mes: '2026-09', grupo: 'MORELIA MADERO', total: 6_155_966.01 },
       { mes: '2026-09', grupo: 'CANINDO', total: 15_061_684.54 }],
      [{ mes: '2026-06', grupo: 'CANINDO', total: 14_000_000.0 }],
    );
    expect(c.solo_actual).toEqual(['MORELIA MADERO']);
    expect(c.universo_cambio).toBe(true);
    // El Δ de todas exagera; el comparable es el que responde "¿vendimos más?".
    expect(c.delta_pct).toBe(51.6);
    expect(c.delta_pct_comparable).toBe(7.6);
  });
});
