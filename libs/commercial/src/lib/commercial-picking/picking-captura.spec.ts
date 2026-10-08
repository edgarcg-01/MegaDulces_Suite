// Sin `import ... from 'vitest'`: la config usa `globals: true` (ver la nota de `allocation.spec.ts`).
import {
  estadoCaptura,
  evaluarPedido,
  renglonCaptura,
  type FilaCaptura,
  type KeplerProducto,
} from './picking-captura.service';

/**
 * `[GP.3d]` Lo que Facturación ve para corregir en Kepler. Un error acá no truena: le dice que deje
 * en Kepler una cantidad equivocada, o da por capturado algo que no cuadra.
 */
const f = (o: Partial<FilaCaptura> = {}): FilaCaptura => ({
  sku: '70034',
  producto: 'CHOC RANITA CROA',
  qty_requested: 75, // 3 BTO de 25 KG
  qty_unit: 'KG',
  qty_presentacion: 3,
  unidad_presentacion: 'BTO',
  qty_allocated: 75,
  ...o,
});
const k = (o: Partial<KeplerProducto> = {}): KeplerProducto => ({ n: 1, base: 75, pres: 3, unidades: ['BTO'], descripcion: 'CHOC RANITA CROA', ...o });
const kmap = (...xs: Array<[string, KeplerProducto]>): Map<string, KeplerProducto> => new Map(xs);

describe('renglonCaptura · un renglón contra Kepler', () => {
  it('⭐ faltó 1 BTO: Kepler sigue con 3 y debe quedar en 2 (en la presentación de Kepler)', () => {
    const r = renglonCaptura(f({ qty_allocated: 50 }), k(), true);
    expect(r).toMatchObject({ unidad: 'BTO', pedido: 3, surtido: 2, falta: 1, kepler: 3, cuadra: false });
  });

  it('completo y Kepler con lo mismo: cuadra', () => {
    expect(renglonCaptura(f(), k(), true).cuadra).toBe(true);
  });

  it('Facturación ya lo dejó en 2 BTO: cuadra', () => {
    expect(renglonCaptura(f({ qty_allocated: 50 }), k({ pres: 2, base: 50 }), true).cuadra).toBe(true);
  });

  it('⭐ peso: Kepler recalculó la base con su factor (50.3 en vez de 50.5) y lo surtido no da BTO entero → cuadra con holgura', () => {
    const r = renglonCaptura(f({ qty_allocated: 50.5 }), k({ pres: 2, base: 50.3, unidades: ['BTO'] }), true);
    expect(r.unidad).toBe('KG');
    expect(r.cuadra).toBe(true);
  });

  it('prueba negativa del peso: 10% de diferencia NO cuadra', () => {
    expect(renglonCaptura(f({ qty_allocated: 50.5 }), k({ base: 45 }), true).cuadra).toBe(false);
  });

  it('lo surtido no da presentación entera: todo el renglón va en la base (no "2.4 BTO", que no se teclea)', () => {
    const r = renglonCaptura(f({ qty_allocated: 60 }), k(), true);
    expect(r).toMatchObject({ unidad: 'KG', pedido: 75, surtido: 60, kepler: 75 });
  });

  it('Kepler ya no trae la clave: kepler 0, y si se surtió algo no cuadra', () => {
    expect(renglonCaptura(f(), undefined, true)).toMatchObject({ kepler: 0, cuadra: false });
  });

  it('sin lectura de Kepler no compara (null), no inventa', () => {
    expect(renglonCaptura(f({ qty_allocated: 50 }), undefined, false)).toMatchObject({ kepler: null, cuadra: null });
  });

  it('la clave en dos renglones de Kepler se suma y se avisa cuántos son', () => {
    const r = renglonCaptura(f(), k({ n: 2 }), true);
    expect(r.renglones_kepler).toBe(2);
  });
});

describe('evaluarPedido · dónde va el pedido', () => {
  it('⭐ AUTORIZADO, completo y Kepler igual → sólo pasar a SURTIDO', () => {
    const e = evaluarPedido([f()], kmap(['70034', k()]), 'AUTORIZADO');
    expect(e).toEqual({ estado: 'por_avanzar', pendientes: [] });
  });

  it('⭐ AUTORIZADO pero el cliente SUBIÓ la cantidad en Kepler durante el surtido → corregir, no "sólo avanzar"', () => {
    const e = evaluarPedido([f()], kmap(['70034', k({ pres: 5, base: 125 })]), 'AUTORIZADO');
    expect(e.estado).toBe('por_capturar');
    expect(e.pendientes[0]).toMatchObject({ surtido: 3, kepler: 5 });
  });

  it('⭐ AUTORIZADO y Kepler trae un renglón que la Suite no surtió → corregir (quitarlo)', () => {
    const e = evaluarPedido([f()], kmap(['70034', k()], ['06001', k({ descripcion: 'MAZAPAN', pres: 2, base: 2, unidades: ['CJA'] })]), 'AUTORIZADO');
    expect(e.estado).toBe('por_capturar');
    expect(e.pendientes).toEqual([expect.objectContaining({ sku: '06001', producto: 'MAZAPAN', extra: true, kepler: 2, unidad: 'CJA' })]);
  });

  it('SURTIDO y cuadra → capturado', () => {
    expect(evaluarPedido([f({ qty_allocated: 50 })], kmap(['70034', k({ pres: 2, base: 50 })]), 'SURTIDO').estado).toBe('capturado');
  });

  it('⭐ SURTIDO pero Kepler dejó lo pedido → con diferencias (no se da por capturado)', () => {
    expect(evaluarPedido([f({ qty_allocated: 50 })], kmap(['70034', k()]), 'SURTIDO').estado).toBe('con_diferencias');
  });

  it('Kepler no trae el pedido (sin cabecera) → otro estatus, sin comparar', () => {
    const e = evaluarPedido([f({ qty_allocated: 50 })], null, null);
    expect(e.estado).toBe('kepler_otro');
    expect(e.pendientes[0]).toMatchObject({ cuadra: null, falta: 1 });
  });
});

describe('estadoCaptura', () => {
  it.each(['SURTIDO', 'CHECADO', 'EMBARCADO'])('Kepler en %s y cuadra → capturado', (e) => {
    expect(estadoCaptura(e, false)).toBe('capturado');
  });

  it.each([null, 'CREADO', 'CANCELADO'])('Kepler en %s → otro estatus (no se inventa un estado)', (e) => {
    expect(estadoCaptura(e, false)).toBe('kepler_otro');
  });
});
