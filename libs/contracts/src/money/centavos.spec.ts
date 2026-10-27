import {
  DineroInvalido, centavos, convertirMoneda, formatearDinero, pesosACentavos, sumarCentavos, valorDePiezaEnCentavos, valorDePiezas,
} from './centavos';

/** `[LE.2.1]` Dinero exacto (B6): cada caso es uno que `float` resuelve mal o que alguien teclea mal. */
describe('[LE.2.1] centavos enteros', () => {
  it('pesos en texto → centavos exactos', () => {
    expect(pesosACentavos('1234.5')).toBe(123450n);
    expect(pesosACentavos('0.1')).toBe(10n);
    expect(pesosACentavos('-0.05')).toBe(-5n);
    expect(pesosACentavos('1702.9')).toBe(170290n);
    expect(pesosACentavos('9999999999999.99')).toBe(999999999999999n);
  });

  it('lo que float suma mal, en centavos suma bien', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumarCentavos([pesosACentavos('0.1'), pesosACentavos('0.2')])).toBe(pesosACentavos('0.3'));
    expect(sumarCentavos(Array.from({ length: 1000 }, () => pesosACentavos('0.01')))).toBe(1000n);
  });

  it.each(['12.345', '1e3', '1,000', '$100', '', ' ', 'abc', '.50', '12.'])('NEGATIVA: «%s» no es un monto en pesos', (t) => {
    expect(() => pesosACentavos(t)).toThrow(DineroInvalido);
  });

  it('centavos de la base (texto) y de código (entero seguro); nada con decimales', () => {
    expect(centavos('123450')).toBe(123450n);
    expect(centavos(-5)).toBe(-5n);
    expect(() => centavos(12.5)).toThrow(DineroInvalido);
    expect(() => centavos('12.50')).toThrow(DineroInvalido);
    expect(() => centavos(Number.MAX_SAFE_INTEGER + 2)).toThrow(DineroInvalido);
  });

  it('formatea sin pasar por number', () => {
    expect(formatearDinero(170323000n)).toBe('$1,703,230.00');
    expect(formatearDinero(-2988n)).toBe('-$29.88');
    expect(formatearDinero(10000n, 'USD')).toBe('US$100.00');
    expect(formatearDinero(999999999999999n)).toBe('$9,999,999,999,999.99');
  });

  it('UN solo redondeo, mitad lejos del cero', () => {
    expect(convertirMoneda(10000n, '18.25')).toBe(182500n);       // US$100 a 18.25
    expect(convertirMoneda(1n, '18.255')).toBe(18n);              // 18.255 → 18
    expect(convertirMoneda(2n, '0.25')).toBe(1n);                 // 0.5 → 1
    expect(convertirMoneda(-2n, '0.25')).toBe(-1n);               // −0.5 → −1 (no hacia +∞)
    expect(convertirMoneda(3n, '0.5')).toBe(2n);                  // 1.5 → 2
    expect(() => convertirMoneda(1n, '18')).toThrow(DineroInvalido);
    expect(() => convertirMoneda(1n, '-18.2')).toThrow(DineroInvalido);
  });

  it('piezas: el valor sale del catálogo; una llave desconocida revienta', () => {
    expect(valorDePiezaEnCentavos('0.5')).toBe(50n);
    expect(valorDePiezaEnCentavos('20m')).toBe(2000n);
    expect(valorDePiezaEnCentavos('100', 'USD')).toBe(10000n);
    expect(valorDePiezas({ 500: 50, 100: -5, '0.5': 3 })).toBe(2500000n - 50000n + 150n);
    expect(() => valorDePiezas({ 300: 1 })).toThrow(DineroInvalido);
    expect(() => valorDePiezas({ '20m': 1 }, 'USD')).toThrow(DineroInvalido);
    expect(() => valorDePiezas({ 500: 1.5 })).toThrow(DineroInvalido);
    expect(() => valorDePiezas({ 500: 0 })).toThrow(DineroInvalido);
  });
});
