import type { PresalePickReport, PresalePickRestore } from '@megadulces/contracts';
import {
  RevisionInvalida,
  armarRenglonesRevision,
  planearRevision,
  resolucion,
  type RenglonVivo,
} from './presale-review.engine';

/**
 * `[MCP.10]` La revisión en caja, sin base. Lo que se prueba es lo que cambia el dinero del pedido:
 * de dónde sale «lo pedido», qué se repone, qué se quita y qué NO se deja cobrar.
 */

// El caso de Padre Hidalgo: el mazapán se pidió 3 y el surtidor dejó 2; la salsa no hubo nada.
const VIVOS: RenglonVivo[] = [
  { line_id: 'a', product_id: 'p-a', product_name: 'PALETA PAYASO', quantity: 24, qty_unit: 'CJA', qty_factor: 24 },
  { line_id: 'b', product_id: 'p-b', product_name: 'MAZAPAN GIGANTE', quantity: 40, qty_unit: 'PAQ', qty_factor: 20 },
];
const RESTORE: PresalePickRestore = {
  product_id: 'p-c', quantity: 12, qty_unit: 'CJA', qty_factor: 12, qty_factor_source: 'kepler',
  discount_percent: 0, unit_price: 18.5, tax_rate: 0, source_warehouse_id: null, line_number: 3, notes: null,
};
const REPORTE: PresalePickReport = {
  adjusted: [{ product_name: 'MAZAPAN GIGANTE', unit: 'PAQ', ordered: 3, picked: 2, line_id: 'b' }],
  removed: [{ product_name: 'SALSA MAGA', unit: 'CJA', ordered: 1, picked: 0, line_id: 'c', restore: RESTORE }],
  total_before: 500,
  total_after: 380,
};

describe('armarRenglonesRevision', () => {
  it('lo pedido sale del reporte del surtido y lo surtido de lo que hoy dice el pedido', () => {
    const r = armarRenglonesRevision(VIVOS, REPORTE);
    expect(r.map((x) => [x.key, x.ordered, x.picked, x.unit])).toEqual([
      ['a', 1, 1, 'CJA'],
      ['b', 3, 2, 'PAQ'],
      ['borrado:0', 1, 0, 'CJA'],
    ]);
  });

  it('el renglón borrado vuelve con su copia y su factor; sin copia no se puede reponer', () => {
    const [, , conCopia] = armarRenglonesRevision(VIVOS, REPORTE);
    expect(conCopia).toMatchObject({ line_id: null, product_id: 'p-c', factor: 12, restorable: true });
    const viejo: PresalePickReport = { ...REPORTE, removed: [{ product_name: 'SALSA MAGA', unit: 'CJA', ordered: 1, picked: 0 }] };
    const [, , sinCopia] = armarRenglonesRevision(VIVOS, viejo);
    expect(sinCopia).toMatchObject({ product_id: null, restorable: false });
  });

  it('sin reporte (surtido completo) nada aparece como faltante', () => {
    const r = armarRenglonesRevision(VIVOS, null);
    expect(r.every((x) => x.ordered === x.picked)).toBe(true);
    expect(r).toHaveLength(2);
  });

  it('un reporte viejo sin line_id empata por nombre y unidad sólo si es único', () => {
    const viejo: PresalePickReport = { ...REPORTE, adjusted: [{ product_name: 'MAZAPAN GIGANTE', unit: 'PAQ', ordered: 3, picked: 2 }], removed: [] };
    expect(armarRenglonesRevision(VIVOS, viejo)[1].ordered).toBe(3);
    const ambiguo: PresalePickReport = { ...viejo, adjusted: [...viejo.adjusted, ...viejo.adjusted] };
    // CONTROL: con dos candidatos no se adivina; se queda con lo que dice el pedido.
    expect(armarRenglonesRevision(VIVOS, ambiguo)[1].ordered).toBe(2);
  });
});

describe('planearRevision', () => {
  const R = armarRenglonesRevision(VIVOS, REPORTE);
  const todoBien = () => R.map((x) => ({ key: x.key, final: x.picked }));

  it('si todo está bien, el pedido no se toca', () => {
    const p = planearRevision(R, todoBien());
    expect(p.cambia).toBe(false);
    expect(p.poner).toEqual([]);
    expect(p.quitar).toEqual([]);
    expect(p.reponer).toEqual([]);
    expect(p.lines.map((l) => l.resolution)).toEqual(['bien', 'no_hubo', 'no_hubo']);
  });

  it('«Ya se completó» sube el renglón a lo pedido, en unidad BASE', () => {
    const m = todoBien();
    m[1].final = 3;
    const p = planearRevision(R, m);
    expect(p.poner).toEqual([{ line_id: 'b', quantity: 60 }]);
    expect(p.lines[1].resolution).toBe('completo');
  });

  it('el renglón borrado que se completa se REPONE con su copia', () => {
    const m = todoBien();
    m[2].final = 1;
    const p = planearRevision(R, m);
    expect(p.reponer).toEqual([{ restore: RESTORE, quantity: 12 }]);
    expect(p.lines[2].resolution).toBe('completo');
  });

  it('«No hay» sobre algo que el surtidor dio completo lo recorta o lo quita', () => {
    const m = todoBien();
    m[0].final = 0;
    expect(planearRevision(R, m).quitar).toEqual(['a']);
    const m2 = todoBien();
    m2[1].final = 1;
    expect(planearRevision(R, m2).poner).toEqual([{ line_id: 'b', quantity: 20 }]);
  });

  it('lo que vino de más se devuelve y no se cobra', () => {
    const m = todoBien().map((x) => ({ ...x, returned: x.key === 'a' ? 2 : 0 }));
    const p = planearRevision(R, m);
    expect(p.cambia).toBe(false);
    expect(p.lines[0]).toMatchObject({ final: 1, returned: 2, resolution: 'devuelto' });
  });

  it('NEGATIVO: no deja cobrar más de lo pedido', () => {
    const m = todoBien();
    m[0].final = 2;
    expect(() => planearRevision(R, m)).toThrow(/no se cobra más de lo pedido/);
  });

  it('NEGATIVO: un borrado sin copia no se puede reponer', () => {
    const viejo = armarRenglonesRevision(VIVOS, { ...REPORTE, removed: [{ product_name: 'SALSA MAGA', unit: 'CJA', ordered: 1, picked: 0 }] });
    const m = viejo.map((x) => ({ key: x.key, final: x.picked }));
    m[2].final = 1;
    expect(() => planearRevision(viejo, m)).toThrow(/avísale a la vendedora/);
  });

  it('NEGATIVO: falta un renglón, viene repetido, es ajeno o la cantidad es rara', () => {
    expect(() => planearRevision(R, todoBien().slice(1))).toThrow(RevisionInvalida);
    expect(() => planearRevision(R, [...todoBien(), todoBien()[0]])).toThrow(/repetido/);
    expect(() => planearRevision(R, [...todoBien(), { key: 'zzz', final: 1 }])).toThrow(/no es de este pedido/);
    const fraccion = todoBien();
    fraccion[1].final = 2.5;
    expect(() => planearRevision(R, fraccion)).toThrow(/va entera/);
    const negativo = todoBien();
    negativo[1].final = -1;
    expect(() => planearRevision(R, negativo)).toThrow(/inválida/);
  });

  it('NEGATIVO: el pedido no puede quedar vacío', () => {
    expect(() => planearRevision(R, R.map((x) => ({ key: x.key, final: 0 })))).toThrow(/quedaría vacío/);
  });
});

describe('resolucion', () => {
  it('distingue bien, completo, no hubo y devuelto', () => {
    expect(resolucion(3, 3, 3, 0)).toBe('bien');
    expect(resolucion(3, 2, 3, 0)).toBe('completo');
    expect(resolucion(3, 2, 2, 0)).toBe('no_hubo');
    expect(resolucion(3, 3, 3, 1)).toBe('devuelto');
  });
});
