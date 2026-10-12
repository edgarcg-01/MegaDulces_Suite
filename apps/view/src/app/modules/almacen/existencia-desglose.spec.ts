import { desglosar, desgloseTexto, rotuloUnidad } from './existencia-desglose';

const txt = (...a: Parameters<typeof desglosar>) => desgloseTexto(desglosar(...a));

describe('[EX.U2] desglose de existencia en cj / paq / pz', () => {
  it('caja + paquete + pieza (SKU 70031: 320 pz por caja, 16 pz por paquete)', () => {
    // 333.7 cajas de antes = 106,784 pz → 333 cj, 224 pz sueltas = 14 paq exactos.
    expect(txt(106784, 320, 16, 'PZA', 'PAQ')).toBe('333 cj 14 paq');
    expect(txt(106789, 320, 16, 'PZA', 'PAQ')).toBe('333 cj 14 paq 5 pz');
  });

  it('sin paquete: cajas + unidad base (SKU 97244: 6,471 pz a 180 por caja = 35.95 cj)', () => {
    expect(txt(6471, 180, null, 'PZA')).toBe('35 cj 171 pz');
  });

  it('base PAQUETE (la forma más común en Kepler): cajas + paquetes', () => {
    expect(txt(1459, 58, null, 'PAQ')).toBe('25 cj 9 paq');
  });

  it('menos de una caja no inventa un "0 cj"', () => {
    expect(txt(100, 180, null, 'PZA')).toBe('100 pz');
  });

  it('cajas exactas no arrastran un "0 pz"', () => {
    expect(txt(360, 180, null, 'PZA')).toBe('2 cj');
  });

  it('sin factor de caja (divisor 1) no se fingen cajas: va la unidad base', () => {
    expect(txt(333, 1, null, 'PAQ')).toBe('333 paq');
    expect(txt(333, null, null, 'PZA')).toBe('333 pz');
  });

  it('un paquete que no es intermedio (≥ la caja) se ignora', () => {
    expect(txt(500, 100, 100, 'PZA', 'PAQ')).toBe('5 cj');
    expect(txt(500, 100, 1, 'PZA', 'PAQ')).toBe('5 cj');
  });

  it('el peso conserva decimales en su última parte; lo contado no', () => {
    expect(txt(52.5, 20, null, 'KG')).toBe('2 cj 12.5 kg');
    expect(txt(41.6, 20, null, 'PZA')).toBe('2 cj 2 pz');
  });

  it('ruido de float no produce una caja de menos', () => {
    expect(txt(0.1 * 3 * 600, 180, null, 'PZA')).toBe('1 cj');   // 180.00000000000003
    expect(txt(359.99999999, 180, null, 'PZA')).toBe('2 cj');
  });

  it('cero y negativo/ausente se dicen como cero, en su unidad', () => {
    expect(txt(0, 180, null, 'PZA')).toBe('0 pz');
    expect(txt(null, 180, null, 'PAQ')).toBe('0 paq');
  });

  it('rótulos del ERP: gramaje numérico no es unidad', () => {
    expect(rotuloUnidad('500')).toBe('u');
    expect(rotuloUnidad(' pza ')).toBe('pz');
    expect(rotuloUnidad('BTO')).toBe('bto');
    expect(rotuloUnidad(null)).toBe('u');
  });
});
