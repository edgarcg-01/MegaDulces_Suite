// Sin `import ... from 'vitest'`: la config de este proyecto usa `globals: true`,
// y el import explícito hace que el archivo ni siquiera cargue.
import {
  CLIENTE_TIENDA,
  MARCA_CANAL,
  NoSeConvierte,
  SUCURSAL_TIENDA,
  notaDelPedido,
  pedidoTiendaACotizacion,
  unidadDePresentacion,
  type FichaTienda,
  type PedidoTienda,
} from './pedido-tienda-a-cotizacion';

/**
 * Los SKU, cantidades y presentaciones son de pedidos REALES de la tienda (medidos el 2026-11-25).
 * ⛔ Los nombres de comprador NO: el repo es público y el comprador es una persona. Van inventados.
 */
const FICHAS: Record<string, FichaTienda> = {
  // CHURROLOKO 400 GR. PATYLETA — tres presentaciones
  '95612': { unidades: [{ unidad: 'PZA', factor: 1 }, { unidad: 'PAQ', factor: 10 }, { unidad: 'CJA', factor: 180 }] },
  // ALTOS ROLLO ALTA 20X30 1KG — una sola unidad, y la tienda le puso de rótulo el nombre
  '17064': { unidades: [{ unidad: 'KG', factor: 1 }] },
  // LA ROSA CERETZZA — la tienda guardó el CÓDIGO de unidad como rótulo
  '70500': { unidades: [{ unidad: '500', factor: 1 }, { unidad: 'PAQ', factor: 2 }, { unidad: 'CJA', factor: 20 }] },
};
const fichaDe = (sku: string): FichaTienda | null => FICHAS[sku] ?? null;
const LARGO = 120;

const pedido = (p: Partial<PedidoTienda> = {}): PedidoTienda => ({
  numero: '11222',
  pago: 'PAID',
  estado: 'APPROVED',
  comprador: 'Comprador De Prueba',
  renglones: [{ sku: '95612', cantidad: 18, presentacion: 'Paquete', precio_tienda: 40.3, nombre: 'CHURROLOKO' }],
  ...p,
});

describe('[COT.7.50] el pedido de la tienda, armado como cotización', () => {
  it('arma la cotización contra el cliente y la sucursal declarados', () => {
    const c = pedidoTiendaACotizacion(pedido(), fichaDe, LARGO);
    expect(c.cliente).toBe(CLIENTE_TIENDA);
    expect(c.cliente).toBe('ONLINE');
    expect(c.sucursal).toBe(SUCURSAL_TIENDA);
    expect(c.sucursal).toBe('01');
    expect(c.renglones).toEqual([
      { sku: '95612', quantity: 18, qty_unit: 'PAQ', unidad_via: 'nombre', precio_tienda: 40.3 },
    ]);
  });

  it('NO copia el precio de la tienda al renglón: sólo lo acompaña para poder declararlo', () => {
    const c = pedidoTiendaACotizacion(pedido(), fichaDe, LARGO);
    const r = c.renglones[0] as Record<string, unknown>;
    expect(r['unit_price']).toBeUndefined();
    expect(r['list_price']).toBeUndefined();
    expect(r['line_total']).toBeUndefined();
    expect(c.renglones[0].precio_tienda).toBe(40.3);
  });

  describe('la unidad, en sus tres reglas', () => {
    it('1 — el rótulo conocido', () => {
      expect(unidadDePresentacion('Caja', FICHAS['95612'])).toMatchObject({ unidad: 'CJA', via: 'nombre' });
      expect(unidadDePresentacion('Pieza', FICHAS['95612'])).toMatchObject({ unidad: 'PZA', via: 'nombre' });
    });

    it('2 — el código de unidad que la tienda guardó como rótulo', () => {
      expect(unidadDePresentacion('500', FICHAS['70500'])).toMatchObject({ unidad: '500', via: 'codigo de unidad' });
      expect(unidadDePresentacion('cub', { unidades: [{ unidad: 'CUB', factor: 1 }, { unidad: 'PZA', factor: 9 }] }))
        .toMatchObject({ unidad: 'CUB', via: 'codigo de unidad' });
    });

    it('3 — un SKU de unidad única resuelve aunque el rótulo sea el nombre del producto', () => {
      expect(unidadDePresentacion('BOLSA ROLLO ALTA OXXO 20 X 30 ALTOS', FICHAS['17064']))
        .toMatchObject({ unidad: 'KG', via: 'unidad unica' });
    });

    it('⛔ con varias unidades y un rótulo que no es ninguna, NO adivina', () => {
      expect(unidadDePresentacion('PASTA DONITA GUSTINOS 1 KG', FICHAS['95612'])).toBeNull();
      expect(unidadDePresentacion(null, FICHAS['95612'])).toBeNull();
    });

    it('el rótulo conocido gana sobre la unidad única', () => {
      expect(unidadDePresentacion('Caja', FICHAS['70500'])).toMatchObject({ unidad: 'CJA', via: 'nombre' });
    });
  });

  describe('⛔ falla cerrada: nada se arma a medias', () => {
    const rechaza = (p: Partial<PedidoTienda>, texto: RegExp) => {
      expect(() => pedidoTiendaACotizacion(pedido(p), fichaDe, LARGO)).toThrow(NoSeConvierte);
      expect(() => pedidoTiendaACotizacion(pedido(p), fichaDe, LARGO)).toThrow(texto);
    };

    it('sin pagar — D2: sería mercancía que nadie pagó', () => rechaza({ pago: 'NOT_PAID' }, /no está pagado/));
    it('cancelado', () => rechaza({ estado: 'CANCELED' }, /cancelado/));
    it('sin renglones', () => rechaza({ renglones: [] }, /no tiene renglones/));
    it('un renglón sin SKU', () =>
      rechaza({ renglones: [{ sku: null, cantidad: 1, presentacion: 'Paquete', precio_tienda: 1, nombre: null }] }, /no trae SKU/));
    it('un SKU que no está en nuestro catálogo, y lo dice', () =>
      rechaza({ renglones: [{ sku: '99999', cantidad: 1, presentacion: 'Paquete', precio_tienda: 1, nombre: null }] }, /99999/));
    it('cantidad no positiva', () =>
      rechaza({ renglones: [{ sku: '95612', cantidad: 0, presentacion: 'Paquete', precio_tienda: 1, nombre: null }] }, /positiva/));
    it('una presentación que no se puede resolver nombra el SKU y el rótulo', () =>
      rechaza({ renglones: [{ sku: '95612', cantidad: 1, presentacion: 'Cubeta', precio_tienda: 1, nombre: null }] }, /Cubeta.*95612|95612/));

    it('UN renglón malo tira el pedido ENTERO, no sólo ese renglón', () => {
      expect(() =>
        pedidoTiendaACotizacion(
          pedido({
            renglones: [
              { sku: '95612', cantidad: 2, presentacion: 'Paquete', precio_tienda: 40.3, nombre: null },
              { sku: '99999', cantidad: 1, presentacion: 'Paquete', precio_tienda: 1, nombre: null },
            ],
          }),
          fichaDe,
          LARGO,
        ),
      ).toThrow(/99999/);
    });
  });

  describe('la nota del pedido', () => {
    it('lleva quién compró, el canal y el número', () => {
      const n = notaDelPedido(pedido(), LARGO);
      expect(n).toBe(`Comprador De Prueba ${MARCA_CANAL} #11222`);
    });

    it('nunca pasa del largo del comentario de Kepler', () => {
      const largo = notaDelPedido(pedido({ comprador: 'A'.repeat(300) }), 60);
      expect(largo.length).toBeLessThanOrEqual(60);
    });

    it('al recortar se pierde el nombre, nunca el canal ni el número', () => {
      const n = notaDelPedido(pedido({ comprador: 'B'.repeat(300) }), 60);
      expect(n).toContain(MARCA_CANAL);
      expect(n).toContain('#11222');
    });

    it('sin comprador sigue diciendo de dónde vino', () => {
      expect(notaDelPedido(pedido({ comprador: null }), LARGO)).toBe(`${MARCA_CANAL} #11222`);
    });
  });

  it('un pedido real de varios renglones se arma entero', () => {
    const c = pedidoTiendaACotizacion(
      pedido({
        renglones: [
          { sku: '95612', cantidad: 18, presentacion: 'Paquete', precio_tienda: 40.3, nombre: null },
          { sku: '17064', cantidad: 3, presentacion: 'BOLSA ROLLO ALTA OXXO 20 X 30 ALTOS', precio_tienda: 63.86, nombre: null },
          { sku: '70500', cantidad: 1, presentacion: '500', precio_tienda: 84.48, nombre: null },
        ],
      }),
      fichaDe,
      LARGO,
    );
    expect(c.renglones.map((r) => r.qty_unit)).toEqual(['PAQ', 'KG', '500']);
    expect(c.renglones.map((r) => r.unidad_via)).toEqual(['nombre', 'unidad unica', 'codigo de unidad']);
  });
});
