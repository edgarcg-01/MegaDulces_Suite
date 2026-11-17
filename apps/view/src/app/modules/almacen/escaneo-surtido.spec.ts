import type { PickerWaveLine } from '@megadulces/contracts';
import { leerEscaneo, ordenarPorRecorrido, unidadDelRenglon } from './escaneo-surtido';

const L = (x: Partial<PickerWaveLine>): PickerWaveLine => ({
  id: 'l1', product_id: 'p1', product_name: 'AVILA MAZAPAN 40', sku: '15114', barcode: null,
  qty_requested: 2, qty_unit: 'PAQ', unidad_mixta: false, qty_presentacion: null, unidad_presentacion: null,
  qty_picked: null, status: 'pendiente', bin_code: null, note: null, existencia: null, existencia_unidad: null, aviso_caja: null,
  presentaciones: [{ unit: 'PAQ', codigos: ['7502212930012'] }, { unit: 'CJA', codigos: ['C07302'] }],
  ...x,
} as PickerWaveLine);

/** `[GP.RF.33]` Escanear marca Completo sólo cuando se sabe que es la presentación pedida (códigos reales de CEDIS). */
describe('[GP.RF.33] leerEscaneo', () => {
  it('⭐ el código del paquete en un renglón pedido en paquetes: Completo', () => {
    const r = leerEscaneo(' 7502212930012 ', [L({})]);
    expect(r).toMatchObject({ tipo: 'completo', linea: { id: 'l1' } });
  });

  it('NEGATIVA: la caja en un renglón pedido en paquetes NO se marca: avisa', () => {
    expect(leerEscaneo('C07302', [L({})])).toMatchObject({ tipo: 'otra_presentacion', escaneada: 'CJA', pedida: 'PAQ' });
  });

  it('NEGATIVA: sin los códigos por presentación (Telemarketing, servidor anterior) no marca nada solo', () => {
    expect(leerEscaneo('7502212930012', [L({ presentaciones: undefined, barcode: '7502212930012' })])).toBeNull();
  });

  it('ya marcado lo dice; dos renglones pendientes del mismo producto no se adivinan', () => {
    expect(leerEscaneo('7502212930012', [L({ status: 'surtido' })])).toMatchObject({ tipo: 'ya_marcado' });
    expect(leerEscaneo('7502212930012', [L({}), L({ id: 'l2' })])).toEqual({ tipo: 'varios' });
  });

  it('la unidad del renglón es la de la hoja si la hay', () => {
    expect(unidadDelRenglon({ qty_presentacion: 3, unidad_presentacion: 'bto', qty_unit: 'KG' })).toBe('BTO');
    expect(unidadDelRenglon({ qty_presentacion: null, unidad_presentacion: null, qty_unit: 'paq' })).toBe('PAQ');
  });
});

describe('[GP.RF.34] ordenarPorRecorrido', () => {
  it('⭐ primero lo que tiene ubicación, por su orden; lo demás al final como venía', () => {
    const r = ordenarPorRecorrido([
      L({ id: 'sin1' }), L({ id: 'c', bin_code: 'BC011', orden_recorrido: 30 }), L({ id: 'sin2' }),
      L({ id: 'a', bin_code: 'BA053', orden_recorrido: 5 }), L({ id: 'x', bin_code: 'BZ991', orden_recorrido: null }),
    ]);
    expect(r.map((l) => l.id)).toEqual(['a', 'c', 'x', 'sin1', 'sin2']);
  });
});
