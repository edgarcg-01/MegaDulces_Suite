import { describe, expect, it } from 'vitest';
import { armarEncabezado } from './encabezado-del-banco';
import { aperturaDelDia } from './saldo-del-libro';

// Un día de banco con importes inventados (el repo es público): abre en 1,000, entra 100, sale 2 → cierra en 1,098.
const DIA1 = [
  { amount_in: 100, amount_out: 0, running_balance: 1100 },
  { amount_in: 0, amount_out: 2, running_balance: 1098 },
];
// El día 12 de doce iguales (+100 −2 cada día desde 1,000), capturado en desorden: abre en 2,078 y cierra en 2,176.
const DIA12 = [
  { amount_in: 0, amount_out: 2, running_balance: 2176 },
  { amount_in: 100, amount_out: 0, running_balance: 2178 },
];

describe('[CB.75] aperturaDelDia', () => {
  it('es el saldo anterior que ningún renglón del día produjo (aunque vengan en desorden)', () => {
    expect(aperturaDelDia(DIA1)).toBe(1000);
    expect(aperturaDelDia(DIA12)).toBe(2078);
    expect(aperturaDelDia([...DIA12].reverse())).toBe(2078);
  });
  it('[negativa] dos cadenas sueltas o sin saldos: no hay apertura que afirmar', () => {
    expect(aperturaDelDia([DIA1[0], DIA12[0]])).toBeNull();
    expect(aperturaDelDia([{ amount_in: 1, amount_out: 0, running_balance: null }])).toBeNull();
    expect(aperturaDelDia([])).toBeNull();
  });
});

describe('[CB.75] armarEncabezado: el encabezado de una cuenta que usa el banco', () => {
  it('abre con la apertura del primer día, cierra con el cierre del último y suma los totales', () => {
    const e = armarEncabezado({ periodo: '2026-10', primerDia: DIA1, ultimoDia: DIA12, totalIn: '1200.00', totalOut: '24.00' });
    expect(e).toEqual({ periodo: '2026-10', opening_balance: 1000, closing_balance: 2176, total_in: 1200, total_out: 24, medido: true });
  });

  it('inicial + abonos − cargos = final cuando el banco cuadra; si falta un renglón, NO cuadra (el final lo pone el banco)', () => {
    const e = armarEncabezado({ periodo: '2026-10', primerDia: DIA1, ultimoDia: DIA12, totalIn: 1200, totalOut: 24 });
    expect(Math.round((e.opening_balance + e.total_in - e.total_out) * 100) / 100).toBe(e.closing_balance);
    const sinUno = armarEncabezado({ periodo: '2026-10', primerDia: DIA1, ultimoDia: DIA12, totalIn: 1100, totalOut: 24 });
    expect(Math.round((sinUno.opening_balance + sinUno.total_in - sinUno.total_out) * 100) / 100).not.toBe(sinUno.closing_balance);
  });

  it('⛔ si la cadena no se puede afirmar, queda «sin saldo» (cero y cero, medido=false), nunca un saldo inventado', () => {
    const e = armarEncabezado({ periodo: '2026-10', primerDia: [DIA1[0], DIA12[0]], ultimoDia: DIA12, totalIn: 10, totalOut: 2 });
    expect(e.medido).toBe(false);
    expect([e.opening_balance, e.closing_balance]).toEqual([0, 0]);
    expect([e.total_in, e.total_out]).toEqual([10, 2]);
  });

  it('⛔ un periodo sin movimientos no se cuenta como cuadrado', () => {
    const e = armarEncabezado({ periodo: '2026-12', primerDia: [], ultimoDia: [], totalIn: 0, totalOut: 0 });
    expect(e.medido).toBe(false);
  });
});
