import { presentacionesConCodigo, ubicacionDe, type AsignacionDeSurtido } from './apoyo-surtido';

/** `[GP.RF.33][GP.RF.34]` Qué ubicación y qué códigos viajan con cada renglón de preventa. */
describe('[GP.RF.34] ubicacionDe', () => {
  const A = (x: Partial<AsignacionDeSurtido>): AsignacionDeSurtido => ({
    product_id: 'p1', presentacion_rotulo: 'PAQ', papel: 'surtido_fijo', code: 'BA053', pick_sequence: 12, ...x,
  });

  it('⭐ el lugar fijo antes que la tienda o la reserva', () => {
    const r = ubicacionDe([A({ papel: 'reserva_preferida', code: 'BC011' }), A({ papel: 'exhibicion_tienda', code: 'TA011' }), A({})], 'p1', 'PAQ');
    expect(r).toEqual({ code: 'BA053', orden: 12 });
  });

  it('en el mismo papel, la de la presentación pedida', () => {
    const r = ubicacionDe([A({ presentacion_rotulo: 'CJA', code: 'BB021' }), A({ presentacion_rotulo: 'PAQ', code: 'BA053' })], 'p1', 'paq');
    expect(r?.code).toBe('BA053');
  });

  it('sin lugar fijo, la exhibición de tienda', () => {
    expect(ubicacionDe([A({ papel: 'exhibicion_tienda', code: 'TA011', pick_sequence: null })], 'p1', 'PAQ')).toEqual({ code: 'TA011', orden: null });
  });

  it('NEGATIVA: sin asignación del producto no inventa una (null), y no toma la de otro producto', () => {
    expect(ubicacionDe([A({ product_id: 'p2' })], 'p1', 'PAQ')).toBeNull();
    expect(ubicacionDe([A({ papel: 'papel_raro' })], 'p1', 'PAQ')).toBeNull();
  });
});

describe('[GP.RF.33] presentacionesConCodigo', () => {
  it('⭐ cada presentación con su rótulo en mayúsculas y sus códigos', () => {
    expect(presentacionesConCodigo([{ rotulo: 'pza', codigos: ['7501'] }, { rotulo: 'CJA', codigos: ['C123', '1750'] }]))
      .toEqual([{ unit: 'PZA', codigos: ['7501'] }, { unit: 'CJA', codigos: ['C123', '1750'] }]);
  });

  it('NEGATIVA: sin rótulo o sin códigos no sirve para reconocer un escaneo', () => {
    expect(presentacionesConCodigo([{ rotulo: null, codigos: ['7501'] }, { rotulo: 'PAQ', codigos: [] }])).toEqual([]);
    expect(presentacionesConCodigo(undefined)).toEqual([]);
  });
});
