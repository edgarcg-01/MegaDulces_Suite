// [MCP.3.14] El vendedor ve UN pedido; el estado por sucursal sólo aparece si surten 2+.
import { describe, expect, it } from 'vitest';
import type { OrderGroupPart } from '../../portal/portal.service';
import { estadoDeParte, sucursalesDelPedido, textoSucursales } from '../pedido-grupo';

const parte = (over: Partial<OrderGroupPart>): OrderGroupPart => ({
  id: 'p1', code: 'P-1', status: 'confirmed', total: 100, warehouse_id: 'w1',
  warehouse_short: 'LPA', warehouse_name: 'La Piedad', is_main: true, pick: 'por_surtir', ...over,
});

describe('sucursalesDelPedido', () => {
  it('sin grupo no dice nada (el pedido muestra su estado normal)', () => {
    expect(sucursalesDelPedido({ group_parts: null })).toEqual([]);
    expect(sucursalesDelPedido({})).toEqual([]);
  });

  it('con UNA sola sucursal tampoco (la regla de David: sólo si surten 2+)', () => {
    expect(sucursalesDelPedido({ group_parts: [parte({ pick: 'completo' })] })).toEqual([]);
  });

  it('con dos sucursales dice en qué va cada una, la principal primero', () => {
    const ss = sucursalesDelPedido({
      group_parts: [
        parte({ pick: 'completo' }),
        parte({ id: 'p2', code: 'P-2', warehouse_short: 'PH', is_main: false, pick: 'por_surtir' }),
      ],
    });
    expect(ss).toEqual([
      { short: 'LPA', etiqueta: 'Surtido', tono: 'ok' },
      { short: 'PH', etiqueta: 'Por surtir', tono: 'muted' },
    ]);
    expect(textoSucursales(ss)).toBe('LPA Surtido · PH Por surtir');
  });

  it('sin nombre corto usa el nombre, y sin nombre el folio', () => {
    const ss = sucursalesDelPedido({
      group_parts: [
        parte({ warehouse_short: null }),
        parte({ id: 'p2', code: 'P-2', warehouse_short: null, warehouse_name: null, is_main: false }),
      ],
    });
    expect(ss.map((s) => s.short)).toEqual(['La Piedad', 'P-2']);
  });
});

describe('estadoDeParte', () => {
  it('lo que pasó con el pedido manda sobre el surtido', () => {
    expect(estadoDeParte({ status: 'cancelled', pick: 'completo' }).etiqueta).toBe('Cancelado');
    expect(estadoDeParte({ status: 'fulfilled', pick: 'completo' }).etiqueta).toBe('Entregado');
  });

  it('cada estado del surtido tiene su texto', () => {
    expect(estadoDeParte({ status: 'confirmed', pick: 'surtiendo' }).etiqueta).toBe('Surtiendo');
    expect(estadoDeParte({ status: 'confirmed', pick: 'con_faltantes' })).toEqual({ etiqueta: 'Surtido con faltantes', tono: 'warn' });
  });

  it('sin dato del surtido lo DECLARA, no lo pinta como «por surtir»', () => {
    expect(estadoDeParte({ status: 'confirmed', pick: null }).etiqueta).toBe('Sin dato de surtido');
  });
});
