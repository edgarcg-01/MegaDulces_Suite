// Sin `import ... from 'vitest'`: la config de este proyecto usa `globals: true`,
// y el import explícito hace que el archivo ni siquiera cargue.
import { compradorDe, pedidoWixAPedidoTienda, presentacionDeRenglon } from './pedido-wix';
import { pedidoTiendaACotizacion } from './pedido-tienda-a-cotizacion';

/**
 * `[COT.7.50]` — el mapeo contra la forma REAL de un pedido de Wix.
 *
 * El pedido de abajo es el **11229 de la tienda viva**, leído el 2026-11-26 y recortado a los
 * campos que el mapeo mira (sin un solo dato del comprador real). No es un ejemplo inventado: si
 * Wix cambia la forma, esta prueba es la que se tiene que caer.
 */
const PEDIDO_REAL = {
  number: '11229',
  status: 'APPROVED',
  paymentStatus: 'PAID',
  lineItems: [
    {
      quantity: 10,
      productName: { original: 'FEASTABLES MR. BEAST CHOCOLATE MILK CRUNCH 10PZ' },
      physicalProperties: { sku: '97245' },
      price: { amount: '165.00', formattedAmount: '165,00$' },
      catalogReference: {
        catalogItemId: 'c51fa1c9-0ae4-7ff3-21c0-0f238aa1781b',
        options: { options: { 'Presentación': 'Paquete' }, variantId: '7a451e24-b8a5-4069-abbc-a87ad089460e' },
      },
      descriptionLines: [
        { name: { original: 'Presentación' }, plainText: { original: 'Paquete' }, lineType: 'PLAIN_TEXT' },
      ],
    },
  ],
  recipientInfo: { contactDetails: { firstName: 'NOMBRE', lastName: 'APELLIDO' } },
};

describe('[COT.7.50] el pedido de Wix se traduce desde su forma MEDIDA, no desde el manual', () => {
  it('toma número, estado, pago, SKU, cantidad, presentación, precio y nombre del lugar correcto', () => {
    const p = pedidoWixAPedidoTienda(PEDIDO_REAL);
    expect(p).toMatchObject({ numero: '11229', estado: 'APPROVED', pago: 'PAID', comprador: 'NOMBRE APELLIDO' });
    expect(p.renglones).toEqual([
      {
        sku: '97245',
        cantidad: 10,
        presentacion: 'Paquete',
        precio_tienda: 165,
        nombre: 'FEASTABLES MR. BEAST CHOCOLATE MILK CRUNCH 10PZ',
      },
    ]);
  });

  it('y ese pedido real atraviesa entero hasta la cotización', () => {
    const armada = pedidoTiendaACotizacion(
      pedidoWixAPedidoTienda(PEDIDO_REAL),
      () => ({ unidades: [{ unidad: 'PZA', factor: 1 }, { unidad: 'PAQ', factor: 10 }] }),
      120,
    );
    expect(armada.renglones).toEqual([
      { sku: '97245', quantity: 10, qty_unit: 'PAQ', unidad_via: 'nombre', precio_tienda: 165 },
    ]);
    expect(armada.notas).toContain('PEDIDO PAGINA WEB #11229');
  });
});

describe('[COT.7.50] la presentación sale de un campo que se LLAMA Presentación, y de ningún otro', () => {
  it('la lee de la opción de la variante', () => {
    expect(presentacionDeRenglon({ catalogReference: { options: { options: { 'Presentación': 'Caja' } } } })).toBe('Caja');
  });

  it('sin acento y en minúsculas es la misma opción', () => {
    expect(presentacionDeRenglon({ catalogReference: { options: { options: { presentacion: 'Pieza' } } } })).toBe('Pieza');
  });

  it('si no está en la opción, la busca en descriptionLines', () => {
    expect(
      presentacionDeRenglon({
        descriptionLines: [{ name: { original: 'Presentación' }, plainText: { original: 'Bulto' } }],
      }),
    ).toBe('Bulto');
  });

  describe('⛔⛔ la regla que la medición MATÓ: «si hay una sola opción, esa es la presentación»', () => {
    it('una única opción que es un SABOR NO se toma como presentación', () => {
      // Medido el 2026-11-26: 209 de 308 opciones únicas eran sabores (CHAMOY, MANGO, FRESA…).
      expect(presentacionDeRenglon({ catalogReference: { options: { options: { Sabor: 'CHAMOY' } } } })).toBeNull();
    });

    it('ni siquiera cuando viene sola en descriptionLines', () => {
      expect(
        presentacionDeRenglon({ descriptionLines: [{ name: { original: 'Sabor' }, plainText: { original: 'MANGO' } }] }),
      ).toBeNull();
    });

    it('y un sabor NO puede convertirse en unidad por la puerta de atrás', () => {
      // Con un SKU de unidad única, un rótulo inventado resolvería «bien» por el motivo equivocado.
      const p = pedidoWixAPedidoTienda({
        number: '1', status: 'APPROVED', paymentStatus: 'PAID',
        lineItems: [{ quantity: 1, physicalProperties: { sku: '9' }, catalogReference: { options: { options: { Sabor: 'FRESA' } } } }],
      });
      expect(p.renglones[0].presentacion).toBeNull();
    });
  });

  it('sin opciones ni descriptionLines: null, no se adivina', () => {
    expect(presentacionDeRenglon({})).toBeNull();
    expect(presentacionDeRenglon({ catalogReference: { options: { options: {} } } })).toBeNull();
  });
});

describe('[COT.7.50] lo que falta se declara, nunca se rellena a favor', () => {
  it('⭐ sin paymentStatus el pedido NO queda como pagado', () => {
    const p = pedidoWixAPedidoTienda({ number: '7', status: 'APPROVED', lineItems: [] });
    expect(p.pago).toBe('DESCONOCIDO');
    expect(p.pago).not.toBe('PAID');
  });

  it('y por eso pedidoTiendaACotizacion lo rechaza', () => {
    expect(() =>
      pedidoTiendaACotizacion(pedidoWixAPedidoTienda({ number: '7', status: 'APPROVED', lineItems: [] }), () => null, 120),
    ).toThrow(/no está pagado/);
  });

  it('un pedido sin renglones da una lista vacía, no un renglón fantasma', () => {
    expect(pedidoWixAPedidoTienda({ number: '7' }).renglones).toEqual([]);
    expect(pedidoWixAPedidoTienda({ number: '7', lineItems: null }).renglones).toEqual([]);
  });

  it('un renglón sin SKU llega como null y lo rechaza la regla de negocio', () => {
    const p = pedidoWixAPedidoTienda({ number: '7', status: 'APPROVED', paymentStatus: 'PAID', lineItems: [{ quantity: 2 }] });
    expect(p.renglones[0].sku).toBeNull();
    expect(() => pedidoTiendaACotizacion(p, () => null, 120)).toThrow(/no trae SKU/);
  });

  it('precio ausente es null, no cero', () => {
    const p = pedidoWixAPedidoTienda({ number: '7', lineItems: [{ quantity: 1, physicalProperties: { sku: '5' } }] });
    expect(p.renglones[0].precio_tienda).toBeNull();
  });
});

describe('[COT.7.50] el comprador, para que telemarketing sepa a quién llamar', () => {
  it('nombre y apellido del destinatario', () => {
    expect(compradorDe({ recipientInfo: { contactDetails: { firstName: 'ANA', lastName: 'PEREZ' } } })).toBe('ANA PEREZ');
  });

  it('si el destinatario no trae nombre, el de facturación', () => {
    expect(
      compradorDe({ recipientInfo: { contactDetails: {} }, billingInfo: { contactDetails: { firstName: 'LUIS' } } }),
    ).toBe('LUIS');
  });

  it('sin ninguno: null (la nota igual conserva la marca y el número)', () => {
    expect(compradorDe({})).toBeNull();
  });
});
