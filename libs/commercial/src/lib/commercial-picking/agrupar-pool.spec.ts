// Sin `import ... from 'vitest'`: la config usa `globals: true` y los demás specs de esta
// librería tampoco lo importan (ver la nota de `allocation.spec.ts`).
import { agruparPool } from './picking.service';

/**
 * `[VEC.8]` Pruebas del agrupado del pool por (sucursal, ruta).
 *
 * ── Por qué merece prueba propia ────────────────────────────────────────────────────────
 * Existe para que **no se mezcle mercancía al surtir**. Si agrupa mal, el error no revienta
 * nada: alguien camina el almacén con una lista que junta dos rutas, y se descubre cuando un
 * cliente recibe lo de otro. Es el mismo perfil de daño silencioso que `allocation.spec.ts`.
 *
 * ⭐ El caso que de verdad importa —y el motivo de que la clave sea (sucursal, ruta) y no sólo
 * la ruta— está medido en prod: **`RUTA 23` existe en Padre Hidalgo y en La Piedad Abastos**,
 * y `RUTA 28` también. Agrupar sólo por ruta las fundiría en un grupo, y armar esa ola sería
 * un recorrido imposible (dos bodegas).
 */

const fila = (
  warehouse_id: string,
  warehouse_name: string,
  sales_route: string | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  warehouse_id,
  warehouse_name,
  sales_route,
  route_kind: sales_route ? 'camion' : null,
  route_kind_motivo: sales_route ? null : 'cliente_sin_ruta',
  lines: 1,
  units: 1,
  total: 10,
  ...extra,
});

describe('agruparPool · que no se mezcle mercancía', () => {
  it('la MISMA ruta en dos sucursales da DOS grupos, no uno', () => {
    const g = agruparPool([
      fila('wh-ph', 'Padre Hidalgo', 'RUTA 23'),
      fila('wh-lp', 'La Piedad Abastos', 'RUTA 23'),
    ]);
    expect(g).toHaveLength(2);
    expect(new Set(g.map((x) => x.warehouse_id))).toEqual(new Set(['wh-ph', 'wh-lp']));
  });

  it('dos rutas distintas en la MISMA sucursal también se separan', () => {
    const g = agruparPool([
      fila('wh-ph', 'Padre Hidalgo', 'RUTA 23'),
      fila('wh-ph', 'Padre Hidalgo', 'RUTA 28'),
    ]);
    expect(g).toHaveLength(2);
  });

  it('acumula pedidos, renglones, unidades e importe del grupo', () => {
    const g = agruparPool([
      fila('wh-ph', 'Padre Hidalgo', 'RUTA 23', { lines: 3, units: 10, total: 100 }),
      fila('wh-ph', 'Padre Hidalgo', 'RUTA 23', { lines: 2, units: 5, total: 50 }),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].pedidos).toBe(2);
    expect(g[0].renglones).toBe(5);
    expect(g[0].unidades).toBe('15');
    expect(g[0].total).toBe('150');
  });

  /**
   * ⚠️ El pedido de un cliente sin ruta NO puede desaparecer del agrupado. Si se cayera, el
   * encabezado diría 25 pedidos y la tabla mostraría 27 — y lo que falta es justo lo que
   * nadie sabe dónde poner. Va a su propio grupo, con el motivo a la vista.
   */
  it('el pedido sin ruta cae en su propio grupo, con el motivo, y no se pierde', () => {
    const g = agruparPool([
      fila('wh-lp', 'La Piedad Abastos', 'RUTA 23'),
      fila('wh-lp', 'La Piedad Abastos', null),
    ]);
    expect(g).toHaveLength(2);
    const huerfano = g.find((x) => x.sales_route === null);
    expect(huerfano?.route_kind_motivo).toBe('cliente_sin_ruta');
    expect(g.reduce((a, x) => a + x.pedidos, 0)).toBe(2);
  });

  it('ordena por tamaño: donde consolidar rinde va primero', () => {
    const g = agruparPool([
      fila('wh-ph', 'Padre Hidalgo', 'RUTA 23'),
      fila('wh-lp', 'La Piedad Abastos', 'RUTA 28'),
      fila('wh-lp', 'La Piedad Abastos', 'RUTA 28'),
    ]);
    expect(g[0].sales_route).toBe('RUTA 28');
    expect(g[0].pedidos).toBe(2);
  });

  /**
   * El orden tiene que ser ESTABLE entre llamadas con los mismos datos: una lista que se
   * reordena sola entre recargas se lee como si hubieran cambiado los datos.
   */
  it('a igual tamaño el orden es estable (por nombre de ruta)', () => {
    const filas = [
      fila('wh-ph', 'Padre Hidalgo', 'RUTA 28'),
      fila('wh-ph', 'Padre Hidalgo', 'RUTA 21'),
      fila('wh-ph', 'Padre Hidalgo', 'RUTA 23'),
    ];
    const a = agruparPool(filas).map((x) => x.sales_route);
    const b = agruparPool([...filas].reverse()).map((x) => x.sales_route);
    expect(a).toEqual(['RUTA 21', 'RUTA 23', 'RUTA 28']);
    expect(b).toEqual(a);
  });

  /**
   * CONTROL POSITIVO. Sin él, un agrupador que devolviera siempre `[]` pasaría varias de las
   * pruebas de arriba (las que sólo comprueban que NO se fusionen cosas).
   */
  it('control positivo: con filas devuelve grupos; con cero filas, cero grupos', () => {
    expect(agruparPool([])).toHaveLength(0);
    expect(agruparPool([fila('wh-ph', 'Padre Hidalgo', 'RUTA 23')])).toHaveLength(1);
  });

  /**
   * El total de pedidos de los grupos TIENE que coincidir con las filas de entrada. Es el
   * invariante que hace imposible el defecto más caro: que el encabezado y la tabla digan
   * números distintos.
   */
  it('invariante: la suma de los grupos es el total de filas', () => {
    const filas = [
      fila('wh-ph', 'Padre Hidalgo', 'RUTA 23'),
      fila('wh-ph', 'Padre Hidalgo', 'RUTA 28'),
      fila('wh-lp', 'La Piedad Abastos', 'RUTA 23'),
      fila('wh-lp', 'La Piedad Abastos', null),
      fila('wh-lp', 'La Piedad Abastos', null),
    ];
    expect(agruparPool(filas).reduce((a, x) => a + x.pedidos, 0)).toBe(filas.length);
  });
});
