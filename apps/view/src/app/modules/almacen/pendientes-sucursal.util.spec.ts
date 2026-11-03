import { describe, expect, it } from 'vitest';
import type { ColaSucursal } from '@megadulces/contracts';
import { porGrupo, repartir, veredicto } from './pendientes-sucursal.util';

const cola = (p: Partial<ColaSucursal>): ColaSucursal => ({
  id: 'x', grupo: 'recibir', de: 'sucursal', label: 'X', accion: '', ruta: '/x', query: null, ventana: null,
  estado: 'ok', total: 0, mas_viejo_dias: null, filas: [], ...p,
});

describe('[AB.45] Pendientes de la sucursal — reparto de colas', () => {
  const colas = [
    cola({ id: 'a', total: 3, mas_viejo_dias: 2 }),
    cola({ id: 'b', total: 1, mas_viejo_dias: 9, grupo: 'caja' }),
    cola({ id: 'c', total: 0 }),
    cola({ id: 'd', estado: 'no_medido', grupo: 'caja' }),
    cola({ id: 'e', de: 'otra_area', total: 300, grupo: 'inventario' }),
    cola({ id: 'f', de: 'otra_area', total: 0 }),
  ];

  it('con trabajo, lo que más espera primero', () => {
    expect(repartir(colas).conTrabajo.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('en cero va a «al día»; la que no se leyó, aparte', () => {
    const r = repartir(colas);
    expect(r.alDia.map((c) => c.id)).toEqual(['c']);
    expect(r.sinLeer.map((c) => c.id)).toEqual(['d']);
  });

  it('lo de otra área se ve pero NO suma al total de la sucursal', () => {
    const v = veredicto(colas);
    expect(v.total).toBe(4);
    expect(v.colas).toBe(2);
    expect(v.masViejo).toBe(9);
    expect(repartir(colas).otraArea.map((c) => c.id)).toEqual(['e']);
  });

  it('una cola que no se pudo leer se cuenta como sin leer, no como cero', () => {
    expect(veredicto(colas).sinLeer).toBe(1);
    expect(porGrupo(colas).find((g) => g.grupo === 'caja')).toEqual({ grupo: 'caja', total: 1, sinLeer: true });
  });

  it('prueba negativa: sin colas sin leer, sinLeer es 0', () => {
    expect(veredicto([cola({ total: 1 })]).sinLeer).toBe(0);
  });
});
