import {
  costoConImpuesto, costoDeLinea, elegirAnterior, tipoCambio,
  type CostoPresentacion, type FichaCompras,
} from './price-change-compras.contract';

/** `[ETQ-CAMBIOS.11]` Las reglas del «costo anterior» y del tipo de cambio del PDF de Compras. */
const costo = (unidad: string, actual: number, anterior: number | null = null): CostoPresentacion => ({
  unidad, costo_actual: actual, costo_anterior: anterior, anterior_desde: anterior == null ? null : '2026-10-10',
});
const ficha = (costos: CostoPresentacion[]): FichaCompras => ({
  sku: '1', proveedor: 'P', uxc: 12, mayoreo_caja: 100, impuesto_pct: 16, costos,
});

describe('elegirAnterior', () => {
  it('sin historia no hay anterior (nunca un cero)', () => {
    expect(elegirAnterior([], 10)).toEqual({ costo_anterior: null, anterior_desde: null });
  });
  it('⭐ una sola foto igual al costo de hoy es la SIEMBRA, no un cambio: no hay anterior', () => {
    expect(elegirAnterior([{ costo: 10, desde: '2026-10-15' }], 10)).toEqual({ costo_anterior: null, anterior_desde: null });
  });
  it('si la última foto ya es el costo de hoy, el anterior es la foto de antes', () => {
    const h = [{ costo: 12, desde: '2026-10-14' }, { costo: 10, desde: '2026-10-01' }];
    expect(elegirAnterior(h, 12)).toEqual({ costo_anterior: 10, anterior_desde: '2026-10-01' });
  });
  it('si el costo de hoy todavía no se fotografió, el anterior es la última foto', () => {
    const h = [{ costo: 10, desde: '2026-10-01' }];
    expect(elegirAnterior(h, 12)).toEqual({ costo_anterior: 10, anterior_desde: '2026-10-01' });
  });
  it('NEGATIVA: dos fotos y el costo de hoy distinto de ambas toma la más reciente, no la más vieja', () => {
    const h = [{ costo: 11, desde: '2026-10-10' }, { costo: 9, desde: '2026-10-01' }];
    expect(elegirAnterior(h, 12).costo_anterior).toBe(11);
  });
});

describe('costoDeLinea', () => {
  it('casa por rótulo sin importar mayúsculas ni espacios', () => {
    const f = ficha([costo('PZA', 5), costo('CJA', 60)]);
    expect(costoDeLinea(f, ' cja ')?.costo_actual).toBe(60);
  });
  it('⭐ un rótulo que no está NO cae al primero: devuelve null (sin dato)', () => {
    expect(costoDeLinea(ficha([costo('PZA', 5)]), 'CJA')).toBeNull();
  });
  it('un rótulo repetido es ambiguo: no se adivina', () => {
    expect(costoDeLinea(ficha([costo('500', 5), costo('500', 7)]), '500')).toBeNull();
  });
  it('sin ficha o sin unidad, null', () => {
    expect(costoDeLinea(null, 'CJA')).toBeNull();
    expect(costoDeLinea(ficha([costo('CJA', 1)]), null)).toBeNull();
  });
});

describe('costoConImpuesto', () => {
  it('aplica la tasa y redondea a centavos', () => {
    expect(costoConImpuesto(100, 16)).toBe(116);
    expect(costoConImpuesto(10.5, 8)).toBe(11.34);
  });
  it('⭐ sin tasa conocida NO es «sin impuesto»: es null', () => {
    expect(costoConImpuesto(100, null)).toBeNull();
    expect(costoConImpuesto(null, 16)).toBeNull();
  });
  it('tasa 0 es una tasa real (producto exento)', () => {
    expect(costoConImpuesto(100, 0)).toBe(100);
  });
});

describe('tipoCambio', () => {
  it('N cuando no hay costo anterior', () => {
    expect(tipoCambio(costo('CJA', 60, null))).toBe('N');
  });
  it('S cuando el costo cambió', () => {
    expect(tipoCambio(costo('CJA', 60, 55))).toBe('S');
  });
  it('null cuando el costo no se movió o no se conoce', () => {
    expect(tipoCambio(costo('CJA', 60, 60))).toBeNull();
    expect(tipoCambio(null)).toBeNull();
  });
});
