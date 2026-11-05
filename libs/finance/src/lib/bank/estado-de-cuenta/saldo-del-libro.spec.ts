import { describe, expect, it } from 'vitest';
import { cierreDelDia } from './saldo-del-libro';

// La forma del 30-oct de una cuenta Banorte en prod, con importes cambiados (el repo es público):
// cuatro renglones capturados en desorden; el cierre es el que no es «saldo anterior» de nadie.
const DIA = [
  { amount_in: 75.5, amount_out: 0, running_balance: 2640.83 },
  { amount_in: 21.77, amount_out: 0, running_balance: 2662.6 },
  { amount_in: 1769, amount_out: 0, running_balance: 2565.33 },
  { amount_in: 0, amount_out: 2500, running_balance: 162.6 },
];

describe('[CB.59] cierreDelDia', () => {
  it('reconstruye la cadena y devuelve el cierre, no el último capturado', () => {
    expect(cierreDelDia(DIA)).toBe(162.6);
  });

  it('con un solo renglón, su saldo es el cierre', () => {
    expect(cierreDelDia([{ amount_in: '10.00', amount_out: '0', running_balance: '110.00' }])).toBe(110);
  });

  it('[negativa] dos cadenas sueltas (falta un renglón): no hay un cierre que afirmar', () => {
    expect(cierreDelDia([DIA[0], DIA[3]])).toBeNull();
  });

  it('[negativa] sin saldos, no hay testigo', () => {
    expect(cierreDelDia([{ amount_in: 1, amount_out: 0, running_balance: null }])).toBeNull();
    expect(cierreDelDia([])).toBeNull();
  });
});
