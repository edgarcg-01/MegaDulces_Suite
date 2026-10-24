import { sumarYaPedido, factorBaseDe, VENTANA_YA_PEDIDO_DIAS, VENTANA_EN_CAMINO_DIAS } from './ya-pedido-sucursal';
import type { EscaleraUnidades } from '@megadulces/contracts';

/**
 * `[AB.34]` CANDADO de la cuenta compartida «lo que la sucursal ya pidió». La usan «Mi pedido», la mesa
 * y `/compras/pedido`: si cambia, cambia lo que se le resta al sugerido en las tres.
 *
 * Prueba negativa hecha al escribirla (2026-10-24): sumando el embarque sin convertir a base
 * (`qty` en vez de `qty * k`) se pone en rojo «2 cajas embarcadas son 32 paquetes».
 */
const ESC: EscaleraUnidades = { unit_base: 'PAQ', u2_label: 'PAQ', u3_label: 'CJA', f2: 1, f3: 16, is_weight: false };
const escaleras = new Map([['70056', ESC]]);

describe('[AB.34] sumarYaPedido', () => {
  it('CONTROL: un pedido abierto y un embarque, en base', () => {
    const { viene, sinUnidad } = sumarYaPedido(
      [{ sku: '70056', unidad: 'PAQ', ya_pedido: '12', atorado: 0, negado: 0 }],
      [{ sku: '70056', unidad: 'PAQ', en_camino: 8 }],
      escaleras,
    );
    expect(viene.get('70056')).toEqual({ ya: 12, atorado: 0, negado: 0, camino: 8 });
    expect(sinUnidad).toBe(0);
  });

  it('2 cajas embarcadas son 32 paquetes, no 2 (AB.23)', () => {
    const { viene } = sumarYaPedido([], [{ sku: '70056', unidad: 'CJA', en_camino: 2 }], escaleras);
    expect(viene.get('70056')?.camino).toBe(32);
  });

  it('⛔ una unidad que la escalera no conoce no se suma: se cuenta', () => {
    const { viene, sinUnidad } = sumarYaPedido([{ sku: '70056', unidad: 'BULTO', ya_pedido: 3, atorado: 0, negado: 0 }], [], escaleras);
    expect(viene.has('70056')).toBe(false);
    expect(sinUnidad).toBe(1);
  });

  it('lo atorado y lo negado se guardan aparte (quien consume decide no restarlos)', () => {
    const { viene } = sumarYaPedido([{ sku: '70056', unidad: 'PAQ', ya_pedido: 0, atorado: 5, negado: 2 }], [], escaleras);
    expect(viene.get('70056')).toEqual({ ya: 0, atorado: 5, negado: 2, camino: 0 });
  });

  it('con `enMesa`, lo que no está en la pantalla ni se suma ni se cuenta', () => {
    const { viene, sinUnidad } = sumarYaPedido(
      [{ sku: '99999', unidad: 'BULTO', ya_pedido: 4, atorado: 0, negado: 0 }], [], escaleras, new Set(['70056']));
    expect(viene.size).toBe(0);
    expect(sinUnidad).toBe(0);
  });

  it('las ventanas siguen siendo las decididas: 7 días para ya pedido y para en camino', () => {
    expect(VENTANA_YA_PEDIDO_DIAS).toBe(7);
    expect(VENTANA_EN_CAMINO_DIAS).toBe(7);
  });

  it('factorBaseDe se re-exporta sin cambio', () => {
    expect(factorBaseDe('CJA', ESC)).toBe(16);
  });
});
