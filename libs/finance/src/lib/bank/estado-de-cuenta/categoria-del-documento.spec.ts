import { planCategoriaDelDocumento, type FilaParaCategorizar } from './categoria-del-documento';

const CAT = new Map([['compra_mercancia', 'c-compra'], ['nomina', 'c-nomina'], ['traspaso_entre_cuentas', 'c-traspaso']]);
const fila = (id: string, o: Partial<FilaParaCategorizar> = {}): FilaParaCategorizar =>
  ({ id, category_id: null, classified_by: 'banco', doc_tipo: null, entidad: null, beneficiario: null, ...o });

describe('[BFU.2.10] planCategoriaDelDocumento: al casar, la categoría sale del documento de Kepler', () => {
  it('el renglón sin categoría toma la de su documento: proveedor, nómina, traspaso', () => {
    const plan = planCategoriaDelDocumento([
      fila('p', { doc_tipo: 'X-D-26', entidad: 'CD001' }),
      fila('n', { doc_tipo: 'X-D-25', entidad: 'GN001', beneficiario: 'NOMINA' }),
      fila('t', { doc_tipo: 'N-A-26' }),
    ], CAT);
    expect(plan).toEqual([
      { id: 'p', category_id: 'c-compra', classified_by: 'documento' },
      { id: 'n', category_id: 'c-nomina', classified_by: 'documento' },
      { id: 't', category_id: 'c-traspaso', classified_by: 'documento' },
    ]);
  });

  it('⛔ no se adivina: sin pareo, acreedor de gasto, o GN001 que ya es Walmart → nada', () => {
    expect(planCategoriaDelDocumento([
      fila('sin-pareo'),
      fila('gasto', { doc_tipo: 'X-D-26', entidad: 'GQ001', beneficiario: 'QUALITAS' }),
      fila('walmart', { doc_tipo: 'X-D-26', entidad: 'GN001', beneficiario: 'Nueva Wal Mart de México' }),
    ], CAT)).toEqual([]);
  });

  it('⛔ lo que ya tiene categoría de otra fuente (texto del banco, regla, a mano) no se toca', () => {
    expect(planCategoriaDelDocumento([
      fila('banco', { category_id: 'c-comision', doc_tipo: 'X-D-26', entidad: 'CD001' }),
      fila('regla', { classified_by: 'rule', doc_tipo: 'X-D-26', entidad: 'CD001' }),
      fila('mano', { classified_by: 'manual', category_id: 'c-otra', doc_tipo: 'N-A-26' }),
    ], CAT)).toEqual([]);
  });

  it('la categoría que vino del documento sigue al pareo: si cambia, cambia; si se va, vuelve a «sin categoría»', () => {
    expect(planCategoriaDelDocumento([
      fila('cambia', { classified_by: 'documento', category_id: 'c-compra', doc_tipo: 'N-A-26' }),
      fila('se-va', { classified_by: 'documento', category_id: 'c-compra' }),
      fila('igual', { classified_by: 'documento', category_id: 'c-compra', doc_tipo: 'X-D-26', entidad: 'CA009' }),
    ], CAT)).toEqual([
      { id: 'cambia', category_id: 'c-traspaso', classified_by: 'documento' },
      { id: 'se-va', category_id: null, classified_by: 'banco' },
    ]);
  });

  it('[negativa] un código que no existe en el catálogo no se escribe (ni como null)', () => {
    expect(planCategoriaDelDocumento([fila('p', { doc_tipo: 'X-D-26', entidad: 'CD001' })], new Map())).toEqual([]);
  });
});
