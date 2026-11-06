import { describe, expect, it } from 'vitest';
import { moverEnOrden } from './calendario-pagos-grupos';

/**
 * `[PGP.76]` Reordenar era de a un lugar por clic (tres escrituras y una recarga cada uno). Ahora
 * un arrastre o una tecla produce la lista completa en su nuevo orden, y se guarda de una vez.
 */
const dia = ['bimbo', 'hershey', 'lala', 'sigma', 'barcel'];

describe('[PGP.76] moverEnOrden', () => {
  it('llevar el último al primer turno es UN movimiento, y los demás se recorren uno', () => {
    expect(moverEnOrden(dia, 4, 0)).toEqual(['barcel', 'bimbo', 'hershey', 'lala', 'sigma']);
  });
  it('bajar el primero al tercer lugar', () => {
    expect(moverEnOrden(dia, 0, 2)).toEqual(['hershey', 'lala', 'bimbo', 'sigma', 'barcel']);
  });
  it('un paso (lo que hace la flecha del teclado) intercambia con el vecino', () => {
    expect(moverEnOrden(dia, 2, 1)).toEqual(['bimbo', 'lala', 'hershey', 'sigma', 'barcel']);
  });
  it('fuera de rango se acota y nunca pierde ni duplica un pago', () => {
    expect(moverEnOrden(dia, 1, 99)).toEqual(['bimbo', 'lala', 'sigma', 'barcel', 'hershey']);
    expect(moverEnOrden(dia, 3, -5)).toEqual(['sigma', 'bimbo', 'hershey', 'lala', 'barcel']);
    expect(moverEnOrden(dia, 9, 0)).toEqual(dia);
    expect(moverEnOrden(dia, 2, 2)).toEqual(dia);
    expect(new Set(moverEnOrden(dia, 0, 4)).size).toBe(dia.length);
  });
  it('no muta la lista que recibe', () => {
    const copia = [...dia];
    moverEnOrden(dia, 0, 4);
    expect(dia).toEqual(copia);
  });
});
