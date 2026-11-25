import { motivoPiezaSoloEnPiso, piezaSoloEnPiso } from './quote-units.contract';

describe('[COT.58] piezaSoloEnPiso', () => {
  it('pieza · paquete · caja: la pieza no se cotiza (06001 CHOC SNICKERS /6)', () => {
    expect(piezaSoloEnPiso('PZA', 'PAQ', 'CJA')).toBe(true);
    expect(piezaSoloEnPiso(' pza ', 'paq', 'cja')).toBe(true);
  });

  it('sólo pieza y caja (sin paquete): la pieza se queda', () => expect(piezaSoloEnPiso('PZA', null, 'CJA')).toBe(false));

  it('pieza y paquete sin caja: la pieza se queda', () => expect(piezaSoloEnPiso('PZA', 'PAQ', null)).toBe(false));

  it('granel por peso (17252 POLIPRO: 250 · KG · CJA): la unidad menor se queda', () =>
    expect(piezaSoloEnPiso('250', 'KG', 'CJA')).toBe(false));

  it('bulto en lugar de caja (01054 AGUINALDO CHICO: PZA · PAQ · BTO): la pieza se queda', () =>
    expect(piezaSoloEnPiso('PZA', 'PAQ', 'BTO')).toBe(false));

  it('ficha rara con dos paquetes (20323 PICOSOS PIÑA: PAQ · PAQ · CJA): no aplica', () =>
    expect(piezaSoloEnPiso('PAQ', 'PAQ', 'CJA')).toBe(false));

  it('el rechazo nombra el producto y cuántas piezas trae cada unidad que sí se cotiza', () =>
    expect(motivoPiezaSoloEnPiso('06001', 'CHOC SNICKERS /6 ', 6, 192)).toBe(
      'La pieza de 06001 CHOC SNICKERS /6 se vende sólo en piso de ventas: en cotización va por paquete (6 PZA) o por caja (192 PZA).',
    ));
});
