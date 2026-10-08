// Sin `import ... from 'vitest'`: la config usa `globals: true` (ver la nota de `allocation.spec.ts`).
import { resolverCodigo, unidadDelCodigo, unidadMayor, type KdiiFila } from './checado-codigo';

/**
 * `[GP.4]` El lector de códigos del checado, con las filas REALES de `kdii` (sucursal 01) de las
 * capturas que anclaron el decode (`ERP_KEPLER.md` §3.y.4). Un error acá cuenta un paquete como
 * pieza o una caja como paquete: el checado diría que cuadra lo que no cuadra.
 */
const SNICKERS: KdiiFila = {
  sku: '06001', nombre: 'CHOC SNICKERS /6',
  u1: 'PZA', u2: 'PAQ', f2: 6, u3: 'CJA', f3: 192,
  base: ['006001', null, null], dos: ['06001', null, '7502271917412'], tres: ['C06001'],
};
const LECHITA: KdiiFila = {
  sku: '78158', nombre: 'LECHITA SANTA CLARA SURTIDA 180 ML / 1',
  u1: 'PZA', u2: 'PZA', f2: 1, u3: 'CJA', f3: 27,
  base: ['78158', null, '7501055377213'], dos: ['7501055377183', null, null], tres: ['C78158'],
};

describe('unidadDelCodigo · tres casillas por unidad', () => {
  it('⭐ 006001 es la PIEZA y 06001 el PAQUETE: no se confunden por los ceros', () => {
    expect(unidadDelCodigo(SNICKERS, '006001')).toMatchObject({ unidad: 'PZA', factor: 1 });
    expect(unidadDelCodigo(SNICKERS, '06001')).toMatchObject({ unidad: 'PAQ', factor: 6 });
  });

  it('la caja por su etiqueta C+clave', () => {
    expect(unidadDelCodigo(SNICKERS, 'C06001')).toMatchObject({ unidad: 'CJA', factor: 192 });
    expect(unidadDelCodigo(SNICKERS, 'c06001')).toMatchObject({ unidad: 'CJA' });
  });

  it('la tercera casilla de la base (c102) y de la unidad dos (c96) también cuentan', () => {
    expect(unidadDelCodigo(LECHITA, '7501055377213')).toMatchObject({ unidad: 'PZA', factor: 1 });
    expect(unidadDelCodigo(SNICKERS, '7502271917412')).toMatchObject({ unidad: 'PAQ', factor: 6 });
  });

  it('prueba negativa: un código ajeno no es del producto', () => {
    expect(unidadDelCodigo(SNICKERS, '7501055377213')).toBeNull();
    expect(unidadDelCodigo(SNICKERS, '')).toBeNull();
  });
});

describe('resolverCodigo · entre varios productos', () => {
  it('un solo dueño del código', () => {
    expect(resolverCodigo('C78158', [SNICKERS, LECHITA], new Set())).toEqual({
      tipo: 'ok', resuelto: { sku: '78158', nombre: LECHITA.nombre, unidad: 'CJA', factor: 27 },
    });
  });

  it('⭐ código compartido: gana el que va en el pedido', () => {
    const OTRO: KdiiFila = { ...LECHITA, sku: '99999', nombre: 'OTRO', base: ['06001', null, null] };
    const r = resolverCodigo('06001', [SNICKERS, OTRO], new Set(['06001']));
    expect(r).toMatchObject({ tipo: 'ok', resuelto: { sku: '06001', unidad: 'PAQ' } });
  });

  it('prueba negativa: compartido y ninguno (o ambos) en el pedido → ambiguo, no se adivina', () => {
    const OTRO: KdiiFila = { ...LECHITA, sku: '99999', nombre: 'OTRO', base: ['06001', null, null] };
    expect(resolverCodigo('06001', [SNICKERS, OTRO], new Set()).tipo).toBe('ambiguo');
  });

  it('nadie lo tiene → desconocido', () => {
    expect(resolverCodigo('123', [SNICKERS], new Set()).tipo).toBe('desconocido');
  });
});

describe('unidadMayor', () => {
  it('la de mayor factor: la caja', () => {
    expect(unidadMayor(SNICKERS)).toEqual({ unidad: 'CJA', factor: 192 });
  });

  it('sin unidades mayores a 1 → null (se vende suelto)', () => {
    expect(unidadMayor({ ...LECHITA, f2: 1, f3: null })).toBeNull();
  });
});
