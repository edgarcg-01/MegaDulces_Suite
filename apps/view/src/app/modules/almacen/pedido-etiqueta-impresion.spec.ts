import { folioDeLectura } from '@megadulces/contracts';
import { anchoBarrasMm } from '@megadulces/ui-web';
import {
  CSS_TICKET_PEDIDO,
  PAGINA_TICKET_80,
  diaDeEntrega,
  dibujarCodigos,
  esFolioDeSuite,
  ticketPedidoHtml,
  type DatosEtiquetaPedido,
} from './pedido-etiqueta-impresion';

/** `[MCP.32]` La etiqueta del pedido: el ticket de 80 mm que imprimen el surtidor y la cajera. */
const D: DatosEtiquetaPedido = {
  folio: 'PD-2026-00138', cliente: 'ABARROTES CARMELITA', vendedor: 'Vendedor PH', entrega: '2026-11-21', productos: 3,
};
const C = { qr: '<svg class="q"></svg>', barras: '<svg class="b"></svg>' };

describe('[MCP.32] etiqueta del pedido', () => {
  it('lleva folio, cliente, vendedor, día de entrega, productos, QR, barras y los 12 dígitos', () => {
    const h = ticketPedidoHtml(D, C);
    for (const t of ['PD-2026-00138', 'ABARROTES CARMELITA', 'Vendedor: Vendedor PH', 'Entrega: sáb 21 nov', '3 productos', 'class="q"', 'class="b"', '992026000138']) {
      expect(h).toContain(t);
    }
  });

  it('es la hoja de la impresora de tickets (80 mm, área útil 72 mm), no la de la TSC', () => {
    expect(PAGINA_TICKET_80).toContain('80mm');
    expect(CSS_TICKET_PEDIDO).toContain('width:72mm');
    expect(CSS_TICKET_PEDIDO).not.toContain('32mm');
  });

  it('NEGATIVO: el texto del cliente se escapa (no se cuela HTML en la impresión)', () => {
    const h = ticketPedidoHtml({ ...D, cliente: '<img src=x onerror=alert(1)> & "CO"' }, C);
    expect(h).not.toContain('<img');
    expect(h).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;CO&quot;');
  });

  it('sin barras o sin fecha: no se inventa nada, sale lo que hay', () => {
    const h = ticketPedidoHtml({ ...D, entrega: null, cliente: null, productos: null }, { qr: C.qr, barras: null });
    expect(h).not.toContain('Entrega');
    expect(h).not.toContain('class="b"');
    expect(h).not.toContain('productos');
    expect(h).toContain('Cliente sin nombre');
    expect(diaDeEntrega('2026-02-30')).toBe('');
    expect(diaDeEntrega('mañana')).toBe('');
  });

  it('sólo los pedidos de la Suite llevan esta etiqueta', () => {
    expect(esFolioDeSuite('PD-2026-00138')).toBe(true);
    expect(esFolioDeSuite('03UD1001-0018665')).toBe(false);
    expect(esFolioDeSuite(null)).toBe(false);
  });

  it('las barras dibujadas son las del folio y caben en el ticket', async () => {
    const c = await dibujarCodigos('PD-2026-00138');
    expect(c.barras).toContain('pt-bar');
    // A 1.5× su ancho mínimo siguen cabiendo en los 66 mm útiles del ticket.
    expect((anchoBarrasMm('992026000138') ?? 99) * 1.5).toBeLessThanOrEqual(66);
    // Ida y vuelta: lo que va impreso se lee como el mismo pedido.
    expect(folioDeLectura('992026000138')).toBe('PD-2026-00138');
  });

  it('un folio que no es de la Suite sale sin barras', async () => {
    const c = await dibujarCodigos('03UD1001-0018665');
    expect(c.barras).toBeNull();
  });
});
