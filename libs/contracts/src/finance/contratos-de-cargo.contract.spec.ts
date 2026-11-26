import {
  SUBTIPOS_COMPROMISO, agruparPropuestas, autorizadoPorContrato, clasificarSerie, diaValido, fechaEsperadaDelPeriodo, numeroDeCredito,
  periodosDelHorizonte, problemasParaConfirmar, subtipoDelCargo, transicionPermitida,
  type ContratoParaRevisar, type SerieParaProponer,
} from './contratos-de-cargo.contract';

/** Las 26 cabezas (con su categoría de Bancos) de las 47 series vigentes, medidas en prod el 2026-11-25. */
const MEDIDAS: [string, string | null, string, string][] = [
  ['DOMICILIACION PAGO SERVICIO', 'servicios', 'por_clasificar', 'otro'],
  ['PAGO DE CAPITAL', 'pago_credito', 'credito', 'capital'],
  ['STM FINANCIAL S', 'servicios', 'por_clasificar', 'otro'],
  ['PAGO DE INTERESES', 'pago_credito', 'credito', 'interes'],
  ['INTERESES NO REALES', 'pago_credito', 'credito', 'interes'],
  ['PAGO DE IVA', 'iva_acreditable', 'credito', 'iva'],
  ['PAGO FAMILIASEGURA P', null, 'por_clasificar', 'otro'],
  ['PAGO TARJETA DE', 'servicios', 'por_clasificar', 'otro'],
  ['PAGO VIDASEGURA PREF', null, 'por_clasificar', 'otro'],
  ['ADMINISTRACION RENTA', null, 'cuota_comision', 'comision'],
  ['CUOTA AFILIACION TPV', null, 'cuota_comision', 'comision'],
  ['COM SERV BBVA', 'comision_bancaria', 'cuota_comision', 'comision'],
  ['RENTA TERMINAL PUNTO', 'comision_bancaria', 'cuota_comision', 'comision'],
  ['SERV BANCA INTERNET', 'comision_bancaria', 'cuota_comision', 'comision'],
  ['I V A', 'iva_acreditable', 'cuota_comision', 'iva'],
  ['COBRO IVA', 'iva_acreditable', 'cuota_comision', 'iva'],
  ['COMISION PENALIZACION POR', 'comision_bancaria', 'cuota_comision', 'comision'],
  ['COMISION POR PENALIZACION', 'comision_bancaria', 'cuota_comision', 'comision'],
  ['COMISION ADMINISTRACION RENTA', 'comision_bancaria', 'cuota_comision', 'comision'],
  ['IVA COM SERVICIOS', 'iva_acreditable', 'cuota_comision', 'iva'],
  ['COMISION POR ADMINISTRACION', 'comision_bancaria', 'cuota_comision', 'comision'],
  ['FACTURACION PENALIZACION POR', 'comision_bancaria', 'cuota_comision', 'comision'],
  ['IVA COMISION PENALIZACION', 'iva_acreditable', 'cuota_comision', 'iva'],
  ['IVA COMISION ADMINISTRACION', 'iva_acreditable', 'cuota_comision', 'iva'],
  ['IVA COMISION POR', 'iva_acreditable', 'cuota_comision', 'iva'],
  ['IVA', 'iva_acreditable', 'cuota_comision', 'iva'],
];

const serie = (over: Partial<SerieParaProponer>): SerieParaProponer => ({
  series_key: 'k', rule: 'fixed_amount', bank_account_id: 'cta', concept_head: 'DOMICILIACION PAGO SERVICIO', latest_concept: 'DOMICILIACION PAGO SERVICIO',
  category_code: 'servicios', months: 5, charges: 5, charges_per_month: 1, fixed_amount: 100, last_amount: 100, min_amount: 100, max_amount: 100,
  first_charge_date: '2026-07-24', last_charge_date: '2026-11-24', min_day: 23, max_day: 27, movement_dates: ['2026-11-24'], ...over,
});

describe('[PGP.210] el contrato que sustenta un cargo del banco', () => {
  it.each(MEDIDAS)('«%s» (%s) se clasifica como %s / %s', (cabeza, cat, tipo, concepto) => {
    expect(clasificarSerie(cabeza, cat)).toMatchObject({ tipo, concepto });
  });

  it('lo que no casa con ninguna regla se dice por clasificar, con su porqué (no se adivina)', () => {
    const c = clasificarSerie('ALGO NUEVO DEL BANCO', null);
    expect(c.tipo).toBe('por_clasificar');
    expect(c.porque).toContain('Tesorería');
  });

  it('el número del crédito es la primera corrida de 6 dígitos o más', () => {
    expect(numeroDeCredito('PAGO DE CAPITAL 012345678')).toBe('012345678');
    expect(numeroDeCredito('COM SERV 12345')).toBeNull();
    expect(numeroDeCredito(null)).toBeNull();
  });

  it('capital, interés e IVA del MISMO crédito en la misma cuenta son UN contrato con tres renglones', () => {
    const p = agruparPropuestas([
      serie({ series_key: 'i', rule: 'variable_amount', concept_head: 'PAGO DE INTERESES', latest_concept: 'PAGO DE INTERESES 012345678', category_code: 'pago_credito', fixed_amount: null, last_amount: 10529.5, min_day: 5, max_day: 7 }),
      serie({ series_key: 'c', concept_head: 'PAGO DE CAPITAL', latest_concept: 'PAGO DE CAPITAL 012345678', category_code: 'pago_credito', fixed_amount: 83333.33, min_day: 5, max_day: 6, first_charge_date: '2026-01-05' }),
      serie({ series_key: 'v', rule: 'variable_amount', concept_head: 'PAGO DE IVA', latest_concept: 'PAGO DE IVA 012345678', category_code: 'iva_acreditable', fixed_amount: null, last_amount: 1685 }),
      serie({ series_key: 'otro', concept_head: 'PAGO DE CAPITAL', latest_concept: 'PAGO DE CAPITAL 099999999', category_code: 'pago_credito', fixed_amount: 110611.11 }),
    ]);
    expect(p).toHaveLength(2);
    const credito = p.find((x) => x.acreedor === 'Crédito 012345678');
    expect(credito?.tipo).toBe('credito');
    expect(credito?.renglones.map((r) => [r.concepto, r.regla_importe, r.importe_fijo])).toEqual([['capital', 'fijo', 83333.33], ['interes', 'estimado', null], ['iva', 'estimado', null]]);
    expect(credito).toMatchObject({ dia_desde: 5, dia_hasta: 27, inicio: '2026-01-05' });
    expect(credito?.evidencia).toHaveLength(3);
  });

  it('NEGATIVA: el mismo número en OTRA cuenta no se junta; lo que no es crédito no se agrupa por número', () => {
    const p = agruparPropuestas([
      serie({ series_key: 'a', concept_head: 'PAGO DE CAPITAL', latest_concept: 'PAGO DE CAPITAL 012345678', category_code: 'pago_credito', bank_account_id: 'x' }),
      serie({ series_key: 'b', concept_head: 'PAGO DE CAPITAL', latest_concept: 'PAGO DE CAPITAL 012345678', category_code: 'pago_credito', bank_account_id: 'y' }),
      serie({ series_key: 'd1', latest_concept: "DOMICILIACION PAGO SERVICIO '0000176 RFC AAA010101AAA" }),
      serie({ series_key: 'd2', latest_concept: "DOMICILIACION PAGO SERVICIO '0000176 RFC AAA010101AAA" }),
    ]);
    expect(p).toHaveLength(4);
  });

  it('dos contratos del mismo importe el mismo mes: un renglón fijo con 2 cargos por periodo', () => {
    const [p] = agruparPropuestas([serie({ series_key: 'dos', fixed_amount: 21291, charges_per_month: 2 })]);
    expect(p.renglones[0]).toMatchObject({ regla_importe: 'fijo', importe_fijo: 21291, cargos_por_periodo: 2 });
    expect(p.tipo).toBe('por_clasificar');
  });

  describe('[PGP.211] el cargo de cada mes', () => {
    it('el subtipo: capital = amortización; interés e IVA del crédito = interés; los demás, su tipo', () => {
      expect(subtipoDelCargo('credito', 'capital')).toBe('amortizacion');
      expect(subtipoDelCargo('credito', 'interes')).toBe('interes');
      expect(subtipoDelCargo('credito', 'iva')).toBe('interes');
      expect(subtipoDelCargo('credito', 'comision')).toBe('otro');
      expect(subtipoDelCargo('arrendamiento', 'renta')).toBe('arrendamiento');
      expect(subtipoDelCargo('cuota_comision', 'iva')).toBe('cuota_comision');
      expect(subtipoDelCargo('por_clasificar', 'otro')).toBe('otro');
      for (const t of ['arrendamiento', 'credito', 'seguro', 'fonacot', 'cuota_comision', 'servicio', 'nomina', 'por_clasificar'] as const) {
        expect(SUBTIPOS_COMPROMISO).toContain(subtipoDelCargo(t, 'capital'));
      }
    });
    it('los periodos del horizonte cruzan el año', () => {
      expect(periodosDelHorizonte('2026-11-26', 2)).toEqual(['2026-11', '2026-12']);
      expect(periodosDelHorizonte('2026-12-31', 3)).toEqual(['2026-12', '2027-01', '2027-02']);
      expect(periodosDelHorizonte('2026-12-31', 0)).toEqual([]);
    });
    it('la fecha esperada no se pasa del último día del mes', () => {
      expect(fechaEsperadaDelPeriodo('2026-12', 12)).toBe('2026-12-12');
      expect(fechaEsperadaDelPeriodo('2026-11', 31)).toBe('2026-11-30');
      expect(fechaEsperadaDelPeriodo('2027-02', 30)).toBe('2027-02-28');
      expect(fechaEsperadaDelPeriodo('2028-02', 30)).toBe('2028-02-29');
      expect(fechaEsperadaDelPeriodo('2026-12', 0)).toBe('2026-12-01');
    });
    it('la firma del cargo es la del contrato (DCR5)', () => {
      expect(autorizadoPorContrato('abc')).toBe('contrato:abc');
    });
  });

  it('el ciclo: propuesto → confirmado o cancelado; confirmado → terminado; lo demás no', () => {
    expect(transicionPermitida('propuesto', 'confirmado')).toBe(true);
    expect(transicionPermitida('propuesto', 'cancelado')).toBe(true);
    expect(transicionPermitida('confirmado', 'terminado')).toBe(true);
    expect(transicionPermitida('confirmado', 'cancelado')).toBe(false);
    expect(transicionPermitida('cancelado', 'confirmado')).toBe(false);
    expect(transicionPermitida('terminado', 'confirmado')).toBe(false);
    expect(transicionPermitida('propuesto', 'terminado')).toBe(false);
  });

  it('los días: 1–31 al mes, 1–7 a la semana', () => {
    expect(diaValido('mensual', 31)).toBe(true);
    expect(diaValido('mensual', 0)).toBe(false);
    expect(diaValido('semanal', 5)).toBe(true);
    expect(diaValido('semanal', 8)).toBe(false);
    expect(diaValido('mensual', 2.5)).toBe(false);
  });

  describe('lo que le falta para confirmarse', () => {
    const bien: ContratoParaRevisar = { tipo: 'arrendamiento', acreedor: 'Arrendadora', cadencia: 'mensual', dia_desde: 23, dia_hasta: 27, inicio: '2026-06-01', fin: null, tiene_documento: true };
    const fijo = { descripcion: 'Renta', regla_importe: 'fijo' as const, importe_fijo: 21291, filas_de_tabla: 0 };
    it('NEGATIVA: un contrato completo no tiene problemas', () => {
      expect(problemasParaConfirmar(bien, [fijo])).toEqual([]);
    });
    it('por clasificar, sin acreedor, días fuera, fin antes del inicio, sin renglones', () => {
      const p = problemasParaConfirmar({ ...bien, tipo: 'por_clasificar', acreedor: ' ', dia_desde: 0, fin: '2026-05-01' }, []);
      expect(p).toHaveLength(5);
    });
    it('el fijo sin importe y la tabla vacía', () => {
      const p = problemasParaConfirmar(bien, [{ ...fijo, importe_fijo: null }, { descripcion: 'Capital', regla_importe: 'tabla', importe_fijo: null, filas_de_tabla: 0 }]);
      expect(p).toEqual(['«Renta» es de importe fijo y no tiene importe.', '«Capital» se cobra por tabla y su tabla está vacía.']);
    });
    it('la tabla con filas y el estimado pasan', () => {
      expect(problemasParaConfirmar(bien, [{ descripcion: 'Capital', regla_importe: 'tabla', importe_fijo: null, filas_de_tabla: 24 }, { descripcion: 'Interés', regla_importe: 'estimado', importe_fijo: null, filas_de_tabla: 0 }])).toEqual([]);
    });
    it('DCR11: arrendamiento, crédito, seguro y FONACOT no se confirman sin el PDF; cuota, servicio y nómina sí', () => {
      for (const tipo of ['arrendamiento', 'credito', 'seguro', 'fonacot'] as const) {
        expect(problemasParaConfirmar({ ...bien, tipo, tiene_documento: false }, [fijo])).toEqual(['Falta el PDF del contrato: arrendamiento, crédito, seguro y FONACOT lo llevan para confirmarse.']);
      }
      for (const tipo of ['cuota_comision', 'servicio', 'nomina'] as const) {
        expect(problemasParaConfirmar({ ...bien, tipo, tiene_documento: false }, [fijo])).toEqual([]);
      }
    });
    it('semanal: el día va de lunes (1) a domingo (7)', () => {
      expect(problemasParaConfirmar({ ...bien, cadencia: 'semanal', dia_desde: 5, dia_hasta: 5 }, [fijo])).toEqual([]);
      expect(problemasParaConfirmar({ ...bien, cadencia: 'semanal', dia_desde: 23, dia_hasta: 27 }, [fijo])[0]).toContain('lunes');
    });
  });
});
