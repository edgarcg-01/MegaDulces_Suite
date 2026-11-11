import type { PresalePickReport } from '@megadulces/contracts';
import { armarReporte, planearCierre, type RenglonParaCerrar } from './presale-picking.engine';
import { armarRenglonesRevision } from './presale-review.engine';
import {
  ordenarSugerencias,
  palabrasClave,
  puntuarSustituto,
  topeEnUnidad,
  unidadesDeEscalera,
  unidadesMasChicas,
  unidadSugerida,
} from './presale-substitute.engine';

describe('[MCP.17] unidadesMasChicas · en qué más se puede surtir el mismo producto', () => {
  const U = [
    { unit: 'PZA', factor: 1, price: 2 },
    { unit: 'PAQ', factor: 12, price: 22 },
    { unit: 'CJA', factor: 24, price: 40 },
  ];
  it('de una CJA de 24: paquete y pieza, nunca la caja', () => {
    expect(unidadesMasChicas(U, 24, 'CJA').map((u) => u.unit)).toEqual(['PZA', 'PAQ']);
  });
  it('de un PAQ: sólo pieza (no se sube a caja)', () => {
    expect(unidadesMasChicas(U, 12, 'paq ').map((u) => u.unit)).toEqual(['PZA']);
  });
  it('un renglón en piezas no tiene nada más chico', () => {
    expect(unidadesMasChicas(U, 1, 'PZA')).toEqual([]);
  });
  it('prueba negativa: sin precio no se ofrece, y la unidad propia tampoco aunque la escalera le dé otro factor', () => {
    const raro = [{ unit: 'PZA', factor: 1, price: null }, { unit: 'CJA', factor: 12, price: 40 }];
    expect(unidadesMasChicas(raro, 28, 'CJA')).toEqual([]);
  });
});

describe('[MCP.17] topeEnUnidad · no más de lo que faltó', () => {
  it('de 24 piezas que faltaron caben 2 PAQ de 12, no 2.5', () => {
    expect(topeEnUnidad(24, { unit: 'PAQ', factor: 12, price: 1 })).toBe(2);
    expect(topeEnUnidad(30, { unit: 'PAQ', factor: 12, price: 1 })).toBe(2);
  });
  it('en peso no se redondea a entero', () => {
    expect(topeEnUnidad(2.5, { unit: 'KG', factor: 1, price: 1 })).toBe(2.5);
  });
  it('nada faltó: tope cero', () => {
    expect(topeEnUnidad(0, { unit: 'PZA', factor: 1, price: 1 })).toBe(0);
  });
});

/**
 * `[MCP.13]` El cambio de producto al surtir, sin base: qué se sugiere, en qué unidad, qué acepta el
 * cierre y cómo lo ve la caja. Lo que se prueba es lo que se rompe sin que la pantalla cambie.
 */
describe('palabrasClave · qué dice el nombre que es el producto', () => {
  it('quita tamaño, empaque, medidas y números', () => {
    expect(palabrasClave('VIT BANDERILLA GRANDE CHILE PI')).toEqual(['BANDERILLA', 'CHILE']);
    expect(palabrasClave('MI PEPINO / 12 AP')).toEqual(['PEPINO']);
    expect(palabrasClave('3 BLS PELONETA 21 GR')).toEqual(['PELONETA']);
  });
  it('compara sin acentos y sin repetir', () => {
    expect(palabrasClave('Crayón crayon CRAYÓN')).toEqual(['CRAYON']);
  });
  it('un nombre vacío no tiene palabras', () => {
    expect(palabrasClave(null)).toEqual([]);
    expect(palabrasClave('  ')).toEqual([]);
  });
});

describe('puntuarSustituto · por qué se sugiere', () => {
  const ORIG = { product_id: 'o', nombre: 'VIT BANDERILLA GRANDE CHILE PI', supplier_id: 'prov-1' };
  it('nombre y proveedor suman más que sólo el nombre', () => {
    const ambos = puntuarSustituto(ORIG, { product_id: 'a', nombre: 'BANDERILLA CHICA', supplier_id: 'prov-1' });
    const nombre = puntuarSustituto(ORIG, { product_id: 'b', nombre: 'BANDERILLA CHICA', supplier_id: 'prov-2' });
    expect(ambos).toEqual({ score: 14, match: 'nombre_y_proveedor' });
    expect(nombre).toEqual({ score: 10, match: 'nombre' });
  });
  it('del mismo proveedor sin palabras en común: se sugiere, abajo', () => {
    expect(puntuarSustituto(ORIG, { product_id: 'c', nombre: 'TAMARINDO ENCHILADO', supplier_id: 'prov-1' })).toEqual({ score: 4, match: 'proveedor' });
  });
  it('sin nada en común no se sugiere; compartir sólo «GRANDE» no cuenta', () => {
    expect(puntuarSustituto(ORIG, { product_id: 'd', nombre: 'PALETA GRANDE', supplier_id: 'prov-9' })).toBeNull();
  });
  it('el mismo producto nunca se sugiere a sí mismo', () => {
    expect(puntuarSustituto(ORIG, { product_id: 'o', nombre: ORIG.nombre, supplier_id: 'prov-1' })).toBeNull();
  });
  it('sin proveedor en el original, el de otro producto sin proveedor no cuenta como «mismo»', () => {
    const o = { ...ORIG, supplier_id: null };
    expect(puntuarSustituto(o, { product_id: 'e', nombre: 'TAMARINDO', supplier_id: null })).toBeNull();
  });
});

describe('unidadesDeEscalera · en qué se puede poner', () => {
  it('la base siempre; paquete y caja sólo con factor mayor a 1', () => {
    const u = unidadesDeEscalera({
      unit_base: 'PZA',
      rungs: { base: { label: 'PZA', price: 9.8, size: 1 }, pack: { label: 'PAQ', price: 52, size: 6 }, box: { label: 'CJA', price: 228, size: 24 } },
    });
    expect(u).toEqual([
      { unit: 'PZA', factor: 1, price: 9.8 },
      { unit: 'PAQ', factor: 6, price: 52 },
      { unit: 'CJA', factor: 24, price: 228 },
    ]);
  });
  it('un rótulo mayor con factor 1 ES la base: no se repite', () => {
    const u = unidadesDeEscalera({ unit_base: 'BTO', rungs: { base: { label: 'BTO', price: 100, size: 1 }, box: { label: 'BTO', price: 100, size: 1 } } });
    expect(u).toEqual([{ unit: 'BTO', factor: 1, price: 100 }]);
  });
  it('sin escalera (sin precio en la sucursal) no hay unidades', () => {
    expect(unidadesDeEscalera(null)).toEqual([]);
  });
  it('sugiere la unidad del original si el sustituto la tiene; si no, su base', () => {
    const u = [{ unit: 'PZA', factor: 1, price: 1 }, { unit: 'CJA', factor: 12, price: 10 }];
    expect(unidadSugerida(u, 'cja')).toEqual(u[1]);
    expect(unidadSugerida(u, 'PAQ')).toEqual(u[0]);
    expect(unidadSugerida([], 'PZA')).toBeNull();
  });
});

describe('ordenarSugerencias', () => {
  it('primero el más parecido; empatados, el de más existencia; sin dato al final', () => {
    const xs = [
      { id: 'a', score: 10, stock_qty: 5 },
      { id: 'b', score: 14, stock_qty: 1 },
      { id: 'c', score: 10, stock_qty: null },
      { id: 'd', score: 10, stock_qty: 40 },
    ];
    expect(ordenarSugerencias(xs).map((x) => x.id)).toEqual(['b', 'd', 'a', 'c']);
  });
});

describe('planearCierre · con cambio de producto', () => {
  const R: RenglonParaCerrar[] = [
    { line_id: 'a', product_id: 'p-a', product_name: 'ROLLY POP', quantity: 3, qty_unit: 'PZA', qty_factor: 1, line_total: 55.5 },
    { line_id: 'b', product_id: 'p-b', product_name: 'BANDERILLA', quantity: 2, qty_unit: 'PZA', qty_factor: 1, line_total: 44.8 },
  ];
  const cambio = { product_id: 'p-x', quantity: 1, unit: 'PZA' };

  it('⭐ lo que faltó se cambia por la cantidad elegida; el original queda con lo que hubo', () => {
    const p = planearCierre(R, [{ line_id: 'a', picked: 3 }, { line_id: 'b', picked: 1, substitute: cambio }]);
    expect(p.outcome).toBe('con_faltantes');
    expect(p.recortar).toEqual([{ line_id: 'b', quantity: 1 }]);
    expect(p.sustituir).toEqual([{ for_line_id: 'b', for_product_name: 'BANDERILLA', product_id: 'p-x', quantity: 1, unit: 'PZA' }]);
  });

  it('si no hubo nada de ningún renglón pero se cambió, sí se surte (no se pide cancelar)', () => {
    const p = planearCierre(R, [
      { line_id: 'a', picked: 0, substitute: { product_id: 'p-y', quantity: 3, unit: 'pza' } },
      { line_id: 'b', picked: 0 },
    ]);
    expect(p.quitar).toEqual(['a', 'b']);
    expect(p.sustituir[0]).toMatchObject({ product_id: 'p-y', quantity: 3, unit: 'PZA' });
  });

  it('no se cambia lo que sí hubo completo', () => {
    expect(() => planearCierre(R, [{ line_id: 'a', picked: 3, substitute: cambio }, { line_id: 'b', picked: 2 }])).toThrow(/hubo todo/);
  });

  it('[MCP.17] el mismo producto en la MISMA unidad no es un cambio (va en lo surtido)', () => {
    expect(() => planearCierre(R, [{ line_id: 'a', picked: 3 }, { line_id: 'b', picked: 1, substitute: { ...cambio, product_id: 'p-b' } }])).toThrow(/otra unidad/);
    // Prueba negativa: la unidad escrita distinto («pza ») sigue siendo la misma.
    expect(() => planearCierre(R, [{ line_id: 'a', picked: 3 }, { line_id: 'b', picked: 1, substitute: { product_id: 'p-b', quantity: 1, unit: 'pza ' } }])).toThrow(/otra unidad/);
  });

  it('⭐ [MCP.17] pidieron 1 CJA y no hubo caja completa: el mismo producto va en PAQ y la caja se quita', () => {
    const conCaja: typeof R = [...R, { line_id: 'c', product_id: 'p-c', product_name: 'BOMBON', quantity: 24, qty_unit: 'CJA', qty_factor: 24, line_total: 480 }];
    const p = planearCierre(conCaja, [
      { line_id: 'a', picked: 3 },
      { line_id: 'b', picked: 2 },
      { line_id: 'c', picked: 0, substitute: { product_id: 'p-c', quantity: 8, unit: 'paq' } },
    ]);
    expect(p.quitar).toEqual(['c']);
    expect(p.sustituir).toEqual([{ for_line_id: 'c', for_product_name: 'BOMBON', product_id: 'p-c', quantity: 8, unit: 'PAQ' }]);
  });

  it('cantidad cero, negativa o con decimales en piezas se rechaza', () => {
    const con = (q: number) => () => planearCierre(R, [{ line_id: 'a', picked: 3 }, { line_id: 'b', picked: 1, substitute: { ...cambio, quantity: q } }]);
    expect(con(0)).toThrow(/mayor a cero/);
    expect(con(-2)).toThrow(/mayor a cero/);
    expect(con(1.5)).toThrow(/entera/);
  });

  it('sin unidad o sin producto se rechaza', () => {
    expect(() => planearCierre(R, [{ line_id: 'a', picked: 3 }, { line_id: 'b', picked: 1, substitute: { ...cambio, unit: ' ' } }])).toThrow(/unidad/);
    expect(() => planearCierre(R, [{ line_id: 'a', picked: 3 }, { line_id: 'b', picked: 1, substitute: { ...cambio, product_id: '' } }])).toThrow(/qué producto/);
  });

  it('el reporte lleva los cambios sólo si hubo; sin cambios queda igual que antes', () => {
    const p = planearCierre(R, [{ line_id: 'a', picked: 3 }, { line_id: 'b', picked: 1 }]);
    expect(armarReporte(p, 100, 77.6)).not.toHaveProperty('substituted');
    const s = [{ line_id: 'n', for_line_id: 'b', for_product_name: 'BANDERILLA', for_sku: '05189', product_id: 'p-x', product_name: 'X', sku: '1', quantity: 1, unit: 'PZA', line_total: 20 }];
    expect(armarReporte(p, 100, 97.6, s)?.substituted).toEqual(s);
  });
});

describe('armarRenglonesRevision · la caja con un cambio de producto', () => {
  const sustitucion = (forLine: string, newLine: string) => ({
    line_id: newLine, for_line_id: forLine, for_product_name: 'BANDERILLA', for_sku: '05189',
    product_id: 'p-x', product_name: 'TAMARINDO', sku: '777', quantity: 1, unit: 'PZA', line_total: 20,
  });

  it('⭐ el original recortado y cubierto no se le pide completar; el sustituto dice en lugar de qué va', () => {
    const reporte: PresalePickReport = {
      removed: [],
      adjusted: [{ product_name: 'BANDERILLA', unit: 'PZA', ordered: 2, picked: 1, line_id: 'b' }],
      substituted: [sustitucion('b', 'n')],
      total_before: 100, total_after: 97.6,
    };
    const r = armarRenglonesRevision([
      { line_id: 'b', product_id: 'p-b', product_name: 'BANDERILLA', quantity: 1, qty_unit: 'PZA', qty_factor: 1 },
      { line_id: 'n', product_id: 'p-x', product_name: 'TAMARINDO', quantity: 1, qty_unit: 'PZA', qty_factor: 1 },
    ], reporte);
    expect(r.find((x) => x.key === 'b')).toMatchObject({ ordered: 1, picked: 1 });
    expect(r.find((x) => x.key === 'b')).not.toHaveProperty('substitutes_for');
    expect(r.find((x) => x.key === 'n')).toMatchObject({ ordered: 1, picked: 1, substitutes_for: 'BANDERILLA' });
  });

  it('el original borrado y cubierto no aparece como faltante; uno borrado SIN cambio sí', () => {
    const restore = { product_id: 'p-b', quantity: 2, qty_unit: 'PZA', qty_factor: 1, qty_factor_source: null, discount_percent: 0, unit_price: 20, tax_rate: 0, source_warehouse_id: null, line_number: 2, notes: null };
    const reporte: PresalePickReport = {
      removed: [
        { product_name: 'BANDERILLA', unit: 'PZA', ordered: 2, picked: 0, line_id: 'b', restore },
        { product_name: 'COCADA', unit: 'PZA', ordered: 1, picked: 0, line_id: 'c', restore: { ...restore, product_id: 'p-c' } },
      ],
      adjusted: [],
      substituted: [sustitucion('b', 'n')],
      total_before: 100, total_after: 80,
    };
    const r = armarRenglonesRevision([{ line_id: 'n', product_id: 'p-x', product_name: 'TAMARINDO', quantity: 2, qty_unit: 'PZA', qty_factor: 1 }], reporte);
    expect(r.map((x) => x.product_name)).toEqual(['TAMARINDO', 'COCADA']);
    // La llave del borrado conserva su posición en el reporte: la caja y el servidor la leen igual.
    expect(r[1].key).toBe('borrado:1');
  });

  it('[MCP.17] el mismo producto en otra unidad: la caja ve qué unidad no hubo completa, y no pide reponer la caja', () => {
    const restore = { product_id: 'p-b', quantity: 24, qty_unit: 'CJA', qty_factor: 24, qty_factor_source: null, discount_percent: 0, unit_price: 400, tax_rate: 0, source_warehouse_id: null, line_number: 1, notes: null };
    const reporte: PresalePickReport = {
      removed: [{ product_name: 'BANDERILLA', unit: 'CJA', ordered: 1, picked: 0, line_id: 'b', restore }],
      adjusted: [],
      substituted: [{ ...sustitucion('b', 'n'), product_id: 'p-b', product_name: 'BANDERILLA', quantity: 8, unit: 'PAQ', same_product: true }],
      total_before: 400, total_after: 160,
    };
    const r = armarRenglonesRevision([{ line_id: 'n', product_id: 'p-b', product_name: 'BANDERILLA', quantity: 96, qty_unit: 'PAQ', qty_factor: 12 }], reporte);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ ordered: 8, unit: 'PAQ', substitutes_for: 'BANDERILLA en CJA' });
    // Prueba negativa: un cambio por OTRO producto sigue diciendo sólo el nombre.
    const otro = armarRenglonesRevision([{ line_id: 'n', product_id: 'p-x', product_name: 'TAMARINDO', quantity: 2, qty_unit: 'PZA', qty_factor: 1 }],
      { ...reporte, substituted: [sustitucion('b', 'n')] });
    expect(otro[0].substitutes_for).toBe('BANDERILLA');
  });
});
