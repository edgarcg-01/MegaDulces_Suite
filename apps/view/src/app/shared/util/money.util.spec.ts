import { money, moneyOSinMedir } from './money.util';

/**
 * `[CGP-V.7]` Lo que no se midió se DICE. `money(null)` dibuja `$0.00`, que sobre un dato ausente
 * afirma un cero que nadie contó. La variante es aditiva: `money` no cambia.
 */
describe('[CGP-V.7] moneyOSinMedir', () => {
  it('⛔ sin dato dice «sin medir», no $0.00', () => {
    expect(moneyOSinMedir(null)).toBe('sin medir');
    expect(moneyOSinMedir(undefined)).toBe('sin medir');
    expect(moneyOSinMedir('')).toBe('sin medir');
    expect(moneyOSinMedir('no es un número')).toBe('sin medir');
  });

  it('un cero MEDIDO sigue siendo cero', () => {
    expect(moneyOSinMedir(0)).toBe(money(0));
  });

  it('el numeric de Postgres llega como texto y se formatea igual', () => {
    expect(moneyOSinMedir('1500.5')).toBe(money(1500.5));
  });

  it('la etiqueta del vacío se puede nombrar', () => {
    expect(moneyOSinMedir(null, 'sin dato')).toBe('sin dato');
  });

  it('money no cambia: sigue aceptando null como cero (la usan Finanzas y Compras)', () => {
    expect(money(null)).toBe(money(0));
  });
});
