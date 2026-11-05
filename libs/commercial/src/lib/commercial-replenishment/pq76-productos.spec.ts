// Sin `import ... from 'vitest'`: la config usa `globals: true` (ver requisicion-oc.spec.ts).
import { aProductos, filasDeProductos, productIdsDe } from './commercial-replenishment.service';

/**
 * `[PQ.76]` Pedido pedía las tres listas (compra, traspaso, sobrestock) con `pageSize=1000`; el
 * servidor las topaba en 500 y la pantalla sumaba esos 500 como el total. Medido el 2026-11-05 contra
 * prod: traspasos 500 de 4,511 y sobrestock 500 de 4,605. Ahora la pantalla pide sólo los productos
 * de su página, y los totales siguen siendo los de toda la red.
 *
 * Probado contra prod en sólo lectura con el servicio empaquetado:
 * - sin `product_ids`, las tres respuestas son idénticas a la versión anterior;
 * - con `product_ids`, sólo vienen esos productos, con los mismos totales y las mismas filas que la
 *   lista completa (incluidos 5 productos que estaban fuera del tope);
 * - con un id inexistente vienen 0 filas y los totales de la red, no 0.
 */
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

describe('[PQ.76] productIdsDe', () => {
  it('sólo UUIDs, sin repetidos', () => {
    expect(productIdsDe(`${A}, ${B},${A},x;drop table,`)).toEqual([A, B]);
    expect(productIdsDe(undefined)).toEqual([]);
  });
});

describe('[PQ.76] aProductos', () => {
  it('sin productos el SQL es el de siempre: ORDER BY y LIMIT de la consulta', () => {
    const binds: Record<string, unknown> = {};
    const sql = aProductos('SELECT x.product_id, COUNT(*) OVER() AS _total FROM x', 'x.v DESC', 'LIMIT 50 OFFSET 0', [], binds);
    expect(sql.replace(/\s+/g, ' ')).toBe('SELECT x.product_id, COUNT(*) OVER() AS _total FROM x ORDER BY x.v DESC LIMIT 50 OFFSET 0');
    expect(binds).toEqual({});
  });

  it('⛔ con productos, el filtro va AFUERA: las ventanas (los totales) se calculan sobre todo el filtro', () => {
    const binds: Record<string, unknown> = {};
    const sql = aProductos('SELECT x.product_id, COUNT(*) OVER() AS _total FROM x', 'x.v DESC', 'LIMIT 50 OFFSET 0', [A, B], binds);
    const interior = sql.indexOf('COUNT(*) OVER()');
    const filtro = sql.indexOf('IN (:pq76_0,:pq76_1)');
    expect(interior).toBeGreaterThan(-1);
    expect(filtro).toBeGreaterThan(-1);
    // El IN vive en la capa de afuera, no dentro de la consulta que calcula los totales.
    expect(sql.slice(0, sql.indexOf('FROM (SELECT x.product_id'))).toContain('IN (:pq76_0,:pq76_1)');
    expect(sql).toContain('_pq76_rn = 1');
    expect(binds).toEqual({ pq76_0: A, pq76_1: B });
  });
});

describe('[PQ.76] filasDeProductos', () => {
  it('quita el renglón testigo y sus marcas', () => {
    const r = filasDeProductos([
      { product_id: A, _total: 9, _pq76_en: true, _pq76_rn: 3 },
      { product_id: 'otro', _total: 9, _pq76_en: false, _pq76_rn: 1 },
    ]);
    expect(r).toEqual([{ product_id: A, _total: 9 }]);
  });

  it('⛔ si ningún producto pedido tiene renglón, la respuesta queda vacía (los totales ya se leyeron del testigo)', () => {
    expect(filasDeProductos([{ product_id: 'otro', _total: 9, _pq76_en: false, _pq76_rn: 1 }])).toEqual([]);
  });

  it('sin filtro no toca nada', () => {
    const rows = [{ product_id: A, _total: 9 }];
    expect(filasDeProductos(rows)).toBe(rows);
  });
});
