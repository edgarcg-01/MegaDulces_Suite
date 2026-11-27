import { conImpuestos, tasaImpuestos } from './impuestos-compra.contract';

describe('[PQ.162] la compra con impuestos, con la fórmula de Kepler', () => {
  it('la tasa sale de las dos columnas de la ficha, que Kepler guarda en negativo', () => {
    expect(tasaImpuestos('-16.0000', '0.0000')).toBe(16);
    expect(tasaImpuestos('0.0000', '-8.0000')).toBe(8);
    expect(tasaImpuestos(-16, -8)).toBe(24);
    // sin ficha: NO es tasa 0, es que no se sabe
    expect(tasaImpuestos(null, null)).toBeNull();
  });

  it('suma IVA e IEPS sobre el importe (Kepler no cobra IVA sobre el IEPS) y redondea a centavos', () => {
    expect(conImpuestos(1000, 8)).toBe(1080);
    expect(conImpuestos(1000, 24)).toBe(1240);
    expect(conImpuestos(33.335, 16)).toBe(38.67);
    // control: un renglón real de la OC 00-0007505 de DART (c13 sin IVA, c17 = 16, c18 = 0)
    expect(conImpuestos(174566.29, 16)).toBe(202496.9);
  });

  it('sin tasa el importe sale tal cual: quien lo muestra lo declara', () => {
    expect(conImpuestos(500, null)).toBe(500);
    expect(conImpuestos(500, undefined)).toBe(500);
    // una tasa en negativo (como viene de Kepler) no RESTA impuesto
    expect(conImpuestos(500, -16)).toBe(580);
  });
});
