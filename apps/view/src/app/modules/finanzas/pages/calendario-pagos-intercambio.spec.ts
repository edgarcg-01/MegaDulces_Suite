import { describe, expect, it } from 'vitest';
import { pasosIntercambio } from './calendario-pagos-grupos';

/**
 * `[PGP.60]` Reordenar fallaba 68 de 178 veces (4xx, 14 días al 2026-11-04): dos `POST` en paralelo
 * que chocaban con la regla del backend. El simulador reproduce ESA regla (`setPriorityRank`: un
 * orden que otro pago pendiente del día ya tiene → 400) para probar los pasos sin base.
 */
type Pago = { id: string; priority_rank: number | null };

/** La regla del backend, paso por paso, sobre un estado que va cambiando. Lanza en el primer choque. */
function aplicar(lista: Pago[], pasos: Array<[string, number]>): Map<string, number | null> {
  const estado = new Map(lista.map((p) => [p.id, p.priority_rank]));
  for (const [id, rank] of pasos) {
    if (!(Number.isInteger(rank) && rank > 0)) throw new Error('priority_rank debe ser un entero > 0');
    for (const [otro, r] of estado) if (otro !== id && r === rank) throw new Error(`El orden ${rank} ya lo tiene otro pago de este día`);
    estado.set(id, rank);
  }
  return estado;
}

/** Lo de antes: los dos `POST` salían a la vez, cada uno contra el estado ORIGINAL. */
function enParalelo(lista: Pago[], i: number, j: number): void {
  const a = lista[i], b = lista[j];
  const mio = a.priority_rank ?? i + 1, suyo = b.priority_rank ?? j + 1;
  aplicar(lista, [[a.id, suyo]]);
  aplicar(lista, [[b.id, mio]]);
}

describe('[PGP.60] pasosIntercambio — reordenar dos pagos sin chocar con el backend', () => {
  const dia: Pago[] = [
    { id: 'hershey', priority_rank: 1 }, { id: 'gonac', priority_rank: 2 },
    { id: 'rico', priority_rank: 3 }, { id: 'bimbo', priority_rank: 4 },
  ];

  it('CONTROL: lo de antes (en paralelo) choca — es el 38 % de fallas medido', () => {
    expect(() => enParalelo(dia, 1, 2)).toThrow(/ya lo tiene otro pago/);
  });

  it('subir: los tres pasos no chocan y los dos números quedan intercambiados', () => {
    const fin = aplicar(dia, pasosIntercambio(dia, 2, 1));
    expect(fin.get('rico')).toBe(2);
    expect(fin.get('gonac')).toBe(3);
    expect(fin.get('hershey')).toBe(1);
    expect(fin.get('bimbo')).toBe(4);
  });

  it('bajar el último hacia arriba y el primero hacia abajo, en los bordes', () => {
    expect(aplicar(dia, pasosIntercambio(dia, 0, 1)).get('hershey')).toBe(2);
    expect(aplicar(dia, pasosIntercambio(dia, 3, 2)).get('bimbo')).toBe(3);
  });

  it('el número temporal es libre aunque los órdenes tengan huecos', () => {
    const conHuecos: Pago[] = [{ id: 'a', priority_rank: 2 }, { id: 'b', priority_rank: 7 }];
    const pasos = pasosIntercambio(conHuecos, 0, 1);
    expect(pasos[0][1]).toBe(8);
    const fin = aplicar(conHuecos, pasos);
    expect([fin.get('a'), fin.get('b')]).toEqual([7, 2]);
  });

  it('índices fuera de rango o iguales: ningún paso', () => {
    expect(pasosIntercambio(dia, -1, 0)).toEqual([]);
    expect(pasosIntercambio(dia, 3, 4)).toEqual([]);
    expect(pasosIntercambio(dia, 1, 1)).toEqual([]);
  });
});
