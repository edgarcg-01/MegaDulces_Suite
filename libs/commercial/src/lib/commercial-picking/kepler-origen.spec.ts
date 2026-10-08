// Sin `import ... from 'vitest'`: la config usa `globals: true` (ver la nota de `allocation.spec.ts`).
import {
  documentoKepler,
  keplerOrderId,
  normalizarLlave,
  planearOlas,
  UMBRAL_TANDA,
  unidadesMezcladas,
  type RenglonConUnidad,
} from './kepler-origen';

/**
 * `[GP.2]` Pruebas del pedido de Kepler como origen del surtido.
 *
 * Lo que más importa es `keplerOrderId`: tiene que dar EXACTAMENTE el mismo UUID que la
 * expresión del CHECK de la base (migración `20261007260100`). Si difieren, ningún pedido de
 * Kepler puede entrar a una ola (el INSERT revienta). Por eso los valores esperados NO salen de
 * este código: se le pidieron a Postgres (prod, solo lectura, 2026-10-07) con
 * `md5('kepler/UD40/' || '01' || '/' || 1::smallint || '/' || '0002781')::uuid`.
 */
describe('keplerOrderId · el UUID determinista del pedido', () => {
  it('⭐ coincide con el md5()::uuid que calcula Postgres (dos folios reales)', () => {
    expect(keplerOrderId({ sucursal: '01', serie: 1, folio: '0002781' })).toBe(
      '17d7c171-0bab-badf-5160-e64f5c9116ea',
    );
    expect(keplerOrderId({ sucursal: '06', serie: 12, folio: '0000367' })).toBe(
      '21a4dcc8-fa6e-ef52-4ad2-3d0df806ca17',
    );
  });

  it('cambia si cambia CUALQUIER parte de la llave (prueba negativa)', () => {
    const base = keplerOrderId({ sucursal: '01', serie: 1, folio: '0002781' });
    expect(keplerOrderId({ sucursal: '02', serie: 1, folio: '0002781' })).not.toBe(base);
    expect(keplerOrderId({ sucursal: '01', serie: 2, folio: '0002781' })).not.toBe(base);
    expect(keplerOrderId({ sucursal: '01', serie: 1, folio: '0002782' })).not.toBe(base);
  });
});

describe('normalizarLlave', () => {
  it('rellena el folio a 7 dígitos, como lo guarda Kepler', () => {
    expect(normalizarLlave({ sucursal: '01', serie: 1, folio: '2781' })).toEqual({
      sucursal: '01',
      serie: 1,
      folio: '0002781',
    });
  });

  it('el mismo pedido escrito de dos formas da el mismo id (no entra dos veces a la ola)', () => {
    const a = normalizarLlave({ sucursal: '01', serie: '1', folio: '2781' })!;
    const b = normalizarLlave({ sucursal: ' 01 ', serie: 1, folio: '0002781' })!;
    expect(keplerOrderId(a)).toBe(keplerOrderId(b));
  });

  it.each([
    [null],
    [{}],
    [{ sucursal: '1', serie: 1, folio: '1' }],
    [{ sucursal: 'PH', serie: 1, folio: '1' }],
    [{ sucursal: '01', serie: 1.5, folio: '1' }],
    [{ sucursal: '01', serie: -1, folio: '1' }],
    [{ sucursal: '01', serie: 100, folio: '1' }],
    [{ sucursal: '01', serie: 1, folio: 'A123' }],
    [{ sucursal: '01', serie: 1, folio: '' }],
  ])('rechaza la llave inválida %j', (x) => {
    expect(normalizarLlave(x)).toBeNull();
  });
});

describe('documentoKepler', () => {
  it('arma el folio legible del tablero de GP.1', () => {
    expect(documentoKepler({ serie: 1, folio: '0002781' })).toBe('UD4001-0002781');
    expect(documentoKepler({ serie: 12, folio: '0000367' })).toBe('UD4012-0000367');
  });
});

describe('planearOlas · la regla de Francisco (FASE_GP §5.1)', () => {
  it('el umbral es 5 renglones', () => {
    expect(UMBRAL_TANDA).toBe(5);
  });

  it('⭐ de 1 a 5 renglones van juntos en la tanda; de 6 en adelante, uno por ola', () => {
    const plan = planearOlas([
      { id: 'a', renglones: 1 },
      { id: 'b', renglones: 5 },
      { id: 'c', renglones: 6 },
      { id: 'd', renglones: 85 },
      { id: 'e', renglones: 3 },
    ]);
    expect(plan.tanda).toEqual(['a', 'b', 'e']);
    expect(plan.individuales).toEqual(['c', 'd']);
    expect(plan.vacios).toEqual([]);
  });

  it('el borde: 5 es tanda y 6 es individual (prueba negativa del umbral)', () => {
    expect(planearOlas([{ id: 'x', renglones: 5 }]).tanda).toEqual(['x']);
    expect(planearOlas([{ id: 'x', renglones: 6 }]).tanda).toEqual([]);
  });

  it('un pedido sin renglones NO entra a la tanda: se separa para que se vea', () => {
    const plan = planearOlas([
      { id: 'vacio', renglones: 0 },
      { id: 'roto', renglones: Number.NaN },
      { id: 'ok', renglones: 2 },
    ]);
    expect(plan.vacios).toEqual(['vacio', 'roto']);
    expect(plan.tanda).toEqual(['ok']);
  });

  it('sin pedidos no inventa olas', () => {
    expect(planearOlas([])).toEqual({ tanda: [], individuales: [], vacios: [] });
  });
});

describe('unidadesMezcladas · el mismo producto en dos unidades frena la ola', () => {
  const r = (
    source: 'suite' | 'kepler',
    product_id: string | null,
    qty_unit: string | null,
    sku = product_id,
  ): RenglonConUnidad => ({ source, product_id, sku, qty_unit });

  it('⭐ dos pedidos de Kepler piden la misma clave en PAQ y en PZA (caso medido en prod: 02135)', () => {
    const out = unidadesMezcladas([r('kepler', '02135', 'PAQ'), r('kepler', '02135', 'PZA')]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('02135');
    expect(out[0]).toContain('PAQ');
    expect(out[0]).toContain('PZA');
  });

  it('la misma clave en la MISMA unidad no frena (prueba negativa)', () => {
    expect(unidadesMezcladas([r('kepler', 'x', 'KG'), r('kepler', 'x', 'KG')])).toEqual([]);
  });

  it('dos claves distintas en unidades distintas no frenan', () => {
    expect(unidadesMezcladas([r('kepler', 'a', 'PAQ'), r('kepler', 'b', 'PZA')])).toEqual([]);
  });

  it('una unidad ausente también cuenta como distinta (no se asume que es la misma)', () => {
    expect(unidadesMezcladas([r('kepler', 'x', 'PAQ'), r('kepler', 'x', null)])).toHaveLength(1);
  });

  it('sólo pedidos de la Suite: no frena (ahí la cantidad ya viene en la unidad base)', () => {
    expect(unidadesMezcladas([r('suite', 'x', 'PAQ'), r('suite', 'x', 'PZA')])).toEqual([]);
  });

  it('un renglón sin producto se ignora acá (lo frena la regla del catálogo)', () => {
    expect(unidadesMezcladas([r('kepler', null, 'PAQ', '999'), r('kepler', null, 'PZA', '999')])).toEqual([]);
  });
});
