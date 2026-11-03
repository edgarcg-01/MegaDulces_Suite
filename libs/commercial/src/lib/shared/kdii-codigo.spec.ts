// Sin `import ... from 'vitest'`: la config usa `globals: true` (ver la nota de `allocation.spec.ts`).
import { esCerrada, resolverCodigo, resolverEscaneo, unidadDelCodigo, unidadMayor, type KdiiFila } from './kdii-codigo';

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

describe('unidad cerrada (CJA, BTO, CUB): la que lleva etiqueta n/N', () => {
  it('la caja del producto', () => {
    expect(unidadMayor(SNICKERS)).toEqual({ unidad: 'CJA', factor: 192 });
  });

  it('⭐ un producto que sólo tiene PAQUETE no tiene unidad cerrada (su paquete va a la caja P)', () => {
    expect(unidadMayor({ ...SNICKERS, u3: null, f3: null })).toBeNull();
  });

  it('⭐ un producto que se vende por caja (base = CJA, factor 1) sí la tiene', () => {
    expect(unidadMayor({ ...SNICKERS, u1: 'CJA', u2: null, f2: null, u3: null, f3: null })).toEqual({ unidad: 'CJA', factor: 1 });
  });

  it('bulto y cubeta también son cerradas; paquete, pieza y kilo no', () => {
    expect(['CJA', 'BTO', 'CUB', 'cja'].map(esCerrada)).toEqual([true, true, true, true]);
    expect(['PAQ', 'PZA', 'KG', '500', null].map(esCerrada)).toEqual([false, false, false, false, false]);
  });
});

/**
 * `[NP.7.L.9a]` El escaneo del levantamiento, con fichas REALES de `kdii` (sucursal 01, 2026-11-02),
 * las mismas tres que Francisco abrió en Kepler (00052, 02020) más el 95805 del plan. Las casillas 2 y
 * 3 de la Unidad Tres (`c97`/`c98`) traen claves internas `CB23`/`CB33` + SKU.
 */
const TICTAC: KdiiFila = {
  sku: '00052', nombre: 'TIC TAC CANELA  /12',
  u1: 'PZA', u2: 'PAQ', f2: 12, u3: 'CJA', f3: 144,
  base: ['CB1100052', '000052', 'C3100052'], dos: ['840004096513', '00052', 'CB3200052'], tres: ['C00052', 'CB2300052', 'CB3300052'],
};
const TRIDENT: KdiiFila = {
  sku: '02020', nombre: 'TRIDENT XTRA CARE MENTA /12 MONDELEZ',
  u1: 'PZA', u2: 'PAQ', f2: 12, u3: 'CJA', f3: 384,
  base: ['7622210571403', 'CB1202020', 'C3102020'], dos: ['7501056960216', '02020', 'CB3202020'], tres: ['C02020', 'CB2302020', 'CB3302020'],
};
const BONOBON: KdiiFila = {
  sku: '95805', nombre: 'ARCOR BON O BON FRESA SN VAL /18 ARCOR',
  u1: 'PAQ', u2: 'PAQ', f2: 1, u3: 'CJA', f3: 12,
  base: ['95805', '7500443007398', null], dos: [null, null, null], tres: ['C95805', null, null],
};

describe('resolverEscaneo · el peldaño que la persona tiene en la mano', () => {
  it('⭐ el EAN de la pieza es la Base; el del paquete es la Dos', () => {
    expect(resolverEscaneo('7622210571403', [TRIDENT])).toEqual({
      tipo: 'ok', resuelto: { sku: '02020', nombre: TRIDENT.nombre, peldano: 'base', unidad: 'PZA', factor: 1 },
    });
    expect(resolverEscaneo('7501056960216', [TRIDENT])).toMatchObject({ tipo: 'ok', resuelto: { peldano: 'dos', factor: 12 } });
  });

  it('el EAN guardado en la segunda casilla de la Base (c93) también es Base', () => {
    expect(resolverEscaneo('7500443007398', [BONOBON])).toMatchObject({ tipo: 'ok', resuelto: { sku: '95805', peldano: 'base' } });
  });

  it('las casillas 2 y 3 de la Unidad Tres (c97/c98) cuentan, y C+clave es la Tres', () => {
    expect(resolverEscaneo('CB2300052', [TICTAC])).toMatchObject({ tipo: 'ok', resuelto: { peldano: 'tres', factor: 144 } });
    expect(resolverEscaneo('c00052', [TICTAC])).toMatchObject({ tipo: 'ok', resuelto: { peldano: 'tres' } });
  });

  it('⭐ un código de la Dos SIN factor capturado sigue siendo de ese producto (no «no existe»)', () => {
    const sinFactor: KdiiFila = { ...TRIDENT, f2: 0 };
    expect(resolverEscaneo('7501056960216', [sinFactor])).toMatchObject({ tipo: 'ok', resuelto: { peldano: 'dos', factor: null } });
    // control: el checado, que sí exige factor, NO lo resuelve — por eso el levantamiento usa su propia función
    expect(unidadDelCodigo(sinFactor, '7501056960216')).toBeNull();
  });

  it('prueba negativa: sin ceros a la izquierda no hay coincidencia (000052 ≠ 00052)', () => {
    expect(resolverEscaneo('000052', [TICTAC])).toMatchObject({ resuelto: { peldano: 'base' } });
    expect(resolverEscaneo('00052', [TICTAC])).toMatchObject({ resuelto: { peldano: 'dos' } });
    expect(resolverEscaneo('52', [TICTAC]).tipo).toBe('desconocido');
  });

  it('⭐ código compartido entre dos productos → ambiguo, sin desempate (no se captura)', () => {
    const otro: KdiiFila = { ...TICTAC, sku: '99999', base: ['7622210571403', null, null] };
    expect(resolverEscaneo('7622210571403', [TRIDENT, otro])).toEqual({ tipo: 'ambiguo', candidatos: ['02020', '99999'] });
  });

  it('código que nadie tiene → desconocido; vacío → desconocido', () => {
    expect(resolverEscaneo('7500000000000', [TRIDENT, TICTAC]).tipo).toBe('desconocido');
    expect(resolverEscaneo('  ', [TRIDENT]).tipo).toBe('desconocido');
  });
});
