import { cajasDeRenglon, nombreArchivoOc, referenciaUtil, textoCajasRenglon } from './oc-kepler';

describe('[RA-PRO.61] cajasDeRenglon — sólo cuando el costo confirma la unidad', () => {
  it('el caso real: 900 PAQ, 20 por caja, costo 56 y caja 1,120 → 45 cajas', () => {
    expect(cajasDeRenglon({ cantidad: 900, unidades_por_caja: 20, costo_unitario: 56, costo_caja: 1120 })).toBe(45);
  });

  it('tolera redondeo de centavos (±1%)', () => {
    expect(cajasDeRenglon({ cantidad: 24, unidades_por_caja: 12, costo_unitario: 8.3333, costo_caja: 100 })).toBe(2);
  });

  it('⭐ NEGATIVA: si el costo no cuadra (factor en otra unidad) NO se inventan cajas', () => {
    // Costo simbólico: 0.0008 × 12 ≠ 0.01 → el factor no significa "piezas de este renglón".
    expect(cajasDeRenglon({ cantidad: 12, unidades_por_caja: 12, costo_unitario: 0.0008, costo_caja: 0.01 })).toBeNull();
    // Servicio: caja ≠ unitario × 1.
    expect(cajasDeRenglon({ cantidad: 1, unidades_por_caja: 1, costo_unitario: 69312.31, costo_caja: 128434.25 })).toBeNull();
  });

  it('cantidad negativa (ajuste capturado como OC) → null, no "-2 cj"', () => {
    expect(cajasDeRenglon({ cantidad: -40, unidades_por_caja: 20, costo_unitario: 5, costo_caja: 100 })).toBeNull();
  });

  it('faltan datos → null', () => {
    expect(cajasDeRenglon({ cantidad: 10, unidades_por_caja: null, costo_unitario: 5, costo_caja: 50 })).toBeNull();
    expect(cajasDeRenglon({ cantidad: 10, unidades_por_caja: 10, costo_unitario: 0, costo_caja: 50 })).toBeNull();
    expect(cajasDeRenglon({ cantidad: 10, unidades_por_caja: 10, costo_unitario: 5, costo_caja: null })).toBeNull();
  });
});

describe('[RA-PRO.61] referencia y nombre de archivo', () => {
  it('la referencia "0" de Kepler no se imprime', () => {
    expect(referenciaUtil('0')).toBeNull();
    expect(referenciaUtil('  ')).toBeNull();
    expect(referenciaUtil('FAC-123')).toBe('FAC-123');
  });

  it('OC_<SUC>-<FOLIO>_<PROVEEDOR>_<PROVEEDOR|INTERNO>_AAAA-MM-DD-HH-MM.pdf', () => {
    expect(nombreArchivoOc('00', '0004409', 'Puro Relajo', new Date(2026, 8, 26, 14, 5), false))
      .toBe('OC_00-0004409_PURO-RELAJO_PROVEEDOR_2026-09-26-14-05.pdf');
    expect(nombreArchivoOc('01', '12', null, new Date(2026, 0, 2, 3, 4), true)).toBe('OC_01-12_SIN-PROVEEDOR_INTERNO_2026-01-02-03-04.pdf');
  });

  it('⭐ NEGATIVA: la versión interna y la del proveedor NUNCA se llaman igual', () => {
    const d = new Date(2026, 8, 26, 14, 5);
    expect(nombreArchivoOc('00', '1', 'X', d, true)).not.toBe(nombreArchivoOc('00', '1', 'X', d, false));
  });
});

describe('[RA-PRO.61] textoCajasRenglon — el resto va en la unidad del renglón', () => {
  const R = (cantidad: number, upc: number, unidad = 'PAQ') => ({ cantidad, unidades_por_caja: upc, costo_unitario: 10, costo_caja: 10 * upc, unidad });
  it('cajas exactas, con resto y menos de una caja', () => {
    expect(textoCajasRenglon(R(900, 20))).toBe('45 cj');
    expect(textoCajasRenglon(R(890, 20))).toBe('44 cj + 10 paq');
    expect(textoCajasRenglon(R(12.5, 25, 'KG'))).toBe('12.5 kg');
  });
  it('sin verificar → null', () => {
    expect(textoCajasRenglon({ cantidad: 12, unidades_por_caja: 12, costo_unitario: 0.0008, costo_caja: 0.01, unidad: 'PAQ' })).toBeNull();
  });
});
