import { describe, expect, it } from 'vitest';
import { anterioresPorEntregar, estadoDelCliente, montoPreventa, ventaDeHoyPorCliente } from './ruta-estado';

const base = { ordered_today: false, visited_today: false, no_sale_reason_today: null };

describe('[MCP.21] cómo va cada cliente de Mi ruta', () => {
  it('sin visita: lo dice en palabras y no pinta icono (va su orden de visita, si tiene)', () => {
    expect(estadoDelCliente(base, null)).toEqual({ clave: 'sin_visita', texto: 'Sin visita', icono: null });
  });

  it('abrirlo registra la llegada, pero eso no es «hecho»: dice «Visitado, sin cerrar»', () => {
    const e = estadoDelCliente({ ...base, visited_today: true }, null);
    expect(e.clave).toBe('visitado');
    expect(e.texto).toBe('Visitado, sin cerrar');
  });

  it('«no pidió» lleva el motivo con la misma etiqueta que ve el supervisor', () => {
    const e = estadoDelCliente({ ...base, visited_today: true, no_sale_reason_today: 'con_inventario' }, null);
    expect(e).toEqual({ clave: 'no_pidio', texto: 'No pidió · Todavía tiene producto', icono: 'pi-ban' });
  });

  it('⭐ si pidió, manda aunque antes se haya marcado «no pidió»; con su monto si el pedido es suyo', () => {
    const c = { ordered_today: true, visited_today: true, no_sale_reason_today: 'cerrado' };
    expect(estadoDelCliente(c, '$274.81')).toEqual({ clave: 'pedido', texto: 'Pedido hoy $274.81', icono: 'pi-check' });
    // Un pedido de hoy que no es suyo (portal, otro vendedor): no inventa un monto.
    expect(estadoDelCliente(c, null).texto).toBe('Pedido hoy');
  });

  it('lo levantado hoy por cliente: sin borradores ni cancelados, y el total que llega como texto se suma', () => {
    const m = ventaDeHoyPorCliente([
      { customer_id: 'a', status: 'confirmed', total: '100.50' },
      { customer_id: 'a', status: 'pending_approval', total: 50 },
      { customer_id: 'a', status: 'draft', total: 999 },
      { customer_id: 'b', status: 'cancelled', total: 80 },
      { customer_id: 'c', status: 'fulfilled', total: 'x' },
    ]);
    expect(m.get('a')).toBe(150.5);
    expect(m.has('b')).toBe(false);
    expect(m.has('c')).toBe(false);
  });

  it('⭐ «por entregar» cuenta sólo lo de días anteriores, sin preventas y un agrupado una vez', () => {
    const hoy = '2026-11-11';
    const n = anterioresPorEntregar([
      // Hoy a las 20:30 en México = 02:30 UTC del día siguiente: sigue siendo de hoy.
      { id: 'h', total: 10, created_at: '2026-11-12T02:30:00.000Z', is_preventa: false, group_id: null },
      { id: 'p1', total: 10, created_at: '2026-11-09T18:00:00.000Z', is_preventa: false, group_id: 'g' },
      { id: 'p2', total: 10, created_at: '2026-11-09T18:00:00.000Z', is_preventa: false, group_id: 'g' },
      { id: 'v', total: 10, created_at: '2026-11-08T18:00:00.000Z', is_preventa: true, group_id: null },
      { id: 'x', total: 10, created_at: '2026-11-05T18:00:00.000Z', is_preventa: false },
    ], hoy);
    expect(n).toBe(2);
  });

  it('el monto de preventa es sólo de las preventas (antes sumaba también los pedidos del vendedor)', () => {
    expect(montoPreventa([
      { id: 'v', total: '300', created_at: '2026-11-10T18:00:00.000Z', is_preventa: true },
      { id: 'p', total: 999, created_at: '2026-11-10T18:00:00.000Z', is_preventa: false },
    ])).toBe(300);
  });
});
