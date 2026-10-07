// Sin `import ... from 'vitest'`: la config usa `globals: true` y los otros 4 specs de esta
// librería tampoco lo importan. Importarlo acá rompía la suite entera con un
// "Cannot read properties of undefined (reading 'config')" antes de correr un solo caso.
import {
  PedidoDeProducto,
  repartirOla,
  repartirProducto,
  resumenPorPedido,
} from './allocation';

/**
 * Pruebas del reparto de lo surtido (SU.6/SU.8, ADR-067).
 *
 * Es la lógica que decide **a qué cliente se le queda corto el pedido** cuando el anaquel no
 * alcanzó. Por eso se prueba por unidad y no sólo por HTTP: un error acá no rompe nada —
 * simplemente alguien recibe de menos y nadie se entera hasta que reclama.
 *
 * Cada bloque trae su prueba negativa o su invariante, según lo que cuide.
 */

const p = (
  code: string,
  qty: number,
  extra: Partial<PedidoDeProducto> = {},
): PedidoDeProducto => ({
  order_id: `id-${code}`,
  order_code: code,
  qty_requested: qty,
  delivery_date: null,
  confirmed_at: null,
  ...extra,
});

describe('repartirProducto · el reparto de lo que hubo', () => {
  describe('cuando alcanza', () => {
    it('sirve a todos completo y no inventa una decisión', () => {
      const r = repartirProducto([p('A', 5), p('B', 8)], 13);
      expect(r.map((x) => x.qty_allocated)).toEqual([5, 8]);
      expect(r.every((x) => x.regla === 'completo')).toBe(true);
    });

    it('⭐ el sobrante NO se le encaja a nadie', () => {
      // Se levantaron 20 y sólo se pedían 13: nadie recibe de más.
      const r = repartirProducto([p('A', 5), p('B', 8)], 20);
      expect(r.map((x) => x.qty_allocated)).toEqual([5, 8]);
      expect(r.reduce((s, x) => s + x.qty_allocated, 0)).toBe(13);
    });
  });

  describe('cuando NO alcanza', () => {
    it('⭐ sirve completo y en orden, no a prorrata', () => {
      // 3 pedidos de 10 y sólo 10 levantados. A prorrata serían 3.33 cada uno: TRES pedidos
      // inservibles en vez de uno servido.
      const r = repartirProducto([p('A', 10), p('B', 10), p('C', 10)], 10);
      expect(r.map((x) => x.qty_allocated)).toEqual([10, 0, 0]);
      expect(r.every((x) => x.regla === 'prioridad_entrega')).toBe(true);
    });

    it('el que sobra parcial recibe el resto exacto', () => {
      const r = repartirProducto([p('A', 10), p('B', 10)], 13);
      expect(r.map((x) => x.qty_allocated)).toEqual([10, 3]);
    });

    it('⭐ INVARIANTE: nunca reparte más de lo levantado, ni más de lo pedido', () => {
      const pedidos = [p('A', 7), p('B', 4), p('C', 12)];
      for (let hubo = 0; hubo <= 30; hubo++) {
        const r = repartirProducto(pedidos, hubo);
        const dado = r.reduce((s, x) => s + x.qty_allocated, 0);
        expect(dado).toBeLessThanOrEqual(hubo);
        expect(dado).toBeLessThanOrEqual(7 + 4 + 12);
        for (const x of r) expect(x.qty_allocated).toBeLessThanOrEqual(x.qty_requested);
      }
    });
  });

  describe('el orden de atención es explicable y estable', () => {
    it('⭐ el que se entrega ANTES va primero (no el que pidió más)', () => {
      const r = repartirProducto(
        [p('GRANDE', 100, { delivery_date: '2026-09-20' }), p('CHICO', 5, { delivery_date: '2026-09-18' })],
        5,
      );
      // Se sirve al de entrega más cercana, aunque su pedido sea el chico.
      expect(r[0].order_code).toBe('CHICO');
      expect(r[0].qty_allocated).toBe(5);
      expect(r.find((x) => x.order_code === 'GRANDE')!.qty_allocated).toBe(0);
    });

    it('a igual fecha, gana el que se confirmó primero', () => {
      const r = repartirProducto(
        [
          p('TARDE', 10, { delivery_date: '2026-09-20', confirmed_at: '2026-09-17T18:00:00Z' }),
          p('TEMPRANO', 10, { delivery_date: '2026-09-20', confirmed_at: '2026-09-17T08:00:00Z' }),
        ],
        10,
      );
      expect(r[0].order_code).toBe('TEMPRANO');
      expect(r[0].qty_allocated).toBe(10);
    });

    it('⭐ es DETERMINISTA: el mismo insumo da el mismo reparto, venga en el orden que venga', () => {
      const a = p('A', 6, { delivery_date: '2026-09-19' });
      const b = p('B', 6, { delivery_date: '2026-09-19' });
      const c = p('C', 6, { delivery_date: '2026-09-18' });
      const r1 = repartirProducto([a, b, c], 8);
      const r2 = repartirProducto([c, b, a], 8);
      const r3 = repartirProducto([b, a, c], 8);
      const clave = (r: ReturnType<typeof repartirProducto>) =>
        r.map((x) => `${x.order_code}:${x.qty_allocated}`).join('|');
      expect(clave(r1)).toBe(clave(r2));
      expect(clave(r2)).toBe(clave(r3));
      // Y el de entrega más cercana se sirvió completo.
      expect(r1[0].order_code).toBe('C');
      expect(r1[0].qty_allocated).toBe(6);
    });

    it('un pedido SIN fecha de entrega no se cuela adelante', () => {
      const r = repartirProducto(
        [p('SIN_FECHA', 10), p('CON_FECHA', 10, { delivery_date: '2026-12-31' })],
        10,
      );
      expect(r[0].order_code).toBe('CON_FECHA');
    });
  });

  describe('cuando no hubo nada', () => {
    it('⭐ nadie recibe, y la regla lo DICE (no se disfraza de reparto)', () => {
      const r = repartirProducto([p('A', 5), p('B', 8)], 0);
      expect(r.every((x) => x.qty_allocated === 0)).toBe(true);
      expect(r.every((x) => x.regla === 'sin_mercancia')).toBe(true);
      // Prueba negativa: con 1 sola unidad la regla YA es otra — el caso no es degenerado.
      expect(repartirProducto([p('A', 5), p('B', 8)], 1)[0].regla).toBe('prioridad_entrega');
    });
  });

  describe('entradas sucias no producen cantidades imposibles', () => {
    it('cantidades negativas, cero, NaN o fraccionarias se saneán a entero >= 0', () => {
      const r = repartirProducto(
        [p('A', -5), p('B', 0), p('C', 7.9), p('D', Number.NaN as unknown as number)],
        100,
      );
      for (const x of r) {
        expect(Number.isInteger(x.qty_allocated)).toBe(true);
        expect(x.qty_allocated).toBeGreaterThanOrEqual(0);
      }
      expect(r.find((x) => x.order_code === 'C')!.qty_allocated).toBe(7);
    });

    it('un levantado negativo o NaN se trata como cero, no como "infinito"', () => {
      expect(repartirProducto([p('A', 5)], -3)[0].qty_allocated).toBe(0);
      expect(repartirProducto([p('A', 5)], Number.NaN as unknown as number)[0].qty_allocated).toBe(0);
    });

    it('sin pedidos devuelve lista vacía y no revienta', () => {
      expect(repartirProducto([], 10)).toEqual([]);
    });
  });
});

describe('repartirOla · la ola entera', () => {
  it('reparte cada producto por separado', () => {
    const ola = repartirOla([
      { product_id: 'SKU1', qty_picked: 13, pedidos: [p('A', 5), p('B', 8)] },
      { product_id: 'SKU2', qty_picked: 2, pedidos: [p('A', 4)] },
    ]);
    expect(ola).toHaveLength(2);
    expect(ola[0].reparto.map((x) => x.qty_allocated)).toEqual([5, 8]);
    expect(ola[1].reparto[0].qty_allocated).toBe(2);
  });

  it('⭐ un renglón sin tocar (null) se trata como cero, no como "todo"', () => {
    const ola = repartirOla([{ product_id: 'SKU1', qty_picked: null, pedidos: [p('A', 5)] }]);
    expect(ola[0].reparto[0].qty_allocated).toBe(0);
    expect(ola[0].reparto[0].regla).toBe('sin_mercancia');
  });
});

describe('resumenPorPedido · a quién le falta algo', () => {
  it('marca completos e incompletos, y cuenta los renglones cortos', () => {
    const ola = repartirOla([
      { product_id: 'SKU1', qty_picked: 5, pedidos: [p('A', 5), p('B', 8)] }, // B se queda corto
      { product_id: 'SKU2', qty_picked: 10, pedidos: [p('A', 4), p('B', 6)] }, // los dos completos
    ]);
    const res = resumenPorPedido(ola).sort((x, y) => x.order_code.localeCompare(y.order_code));
    expect(res).toHaveLength(2);
    expect(res[0]).toMatchObject({ order_code: 'A', completo: true, renglones_cortos: 0 });
    expect(res[1]).toMatchObject({ order_code: 'B', completo: false, renglones_cortos: 1 });
  });

  it('con todo completo, nadie aparece incompleto (prueba negativa del anterior)', () => {
    const ola = repartirOla([{ product_id: 'SKU1', qty_picked: 13, pedidos: [p('A', 5), p('B', 8)] }]);
    expect(resumenPorPedido(ola).every((r) => r.completo)).toBe(true);
  });
});
