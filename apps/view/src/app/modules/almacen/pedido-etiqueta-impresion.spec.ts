import { folioDeLectura } from '@megadulces/contracts';
import { anchoBarrasMm } from '@megadulces/ui-web';
import {
  celdaEtiquetaPedido,
  diaDeEntrega,
  dibujarCodigos,
  esFolioDeSuite,
  etiquetasPedidoTscHtml,
  ticketPedidoHtml,
  type DatosEtiquetaPedido,
} from './pedido-etiqueta-impresion';

/** `[MCP.32]` La etiqueta del pedido: TSC (surtidor) y ticket de 80 mm (cajera). */
const D: DatosEtiquetaPedido = {
  folio: 'PD-2026-00138', cliente: 'ABARROTES CARMELITA', vendedor: 'Vendedor PH', entrega: '2026-11-21', productos: 3,
};
const C = { qr: '<svg class="q"></svg>', barras: '<svg class="b"></svg>' };

describe('[MCP.32] etiqueta del pedido', () => {
  it('lleva folio, cliente, vendedor, día de entrega, QR, barras y los 12 dígitos', () => {
    const h = celdaEtiquetaPedido(D, C);
    for (const t of ['PD-2026-00138', 'ABARROTES CARMELITA', 'Vendedor PH', 'Entrega sáb 21 nov', 'class="q"', 'class="b"', '992026000138']) {
      expect(h).toContain(t);
    }
  });

  it('TSC: la misma etiqueta 3 veces en UNA fila (no se tira papel)', () => {
    const h = etiquetasPedidoTscHtml(D, C);
    expect(h.match(/class="et-fila"/g)).toHaveLength(1);
    expect(h.match(/class="pe"/g)).toHaveLength(3);
  });

  it('el ticket lleva lo mismo y cuántos productos', () => {
    const h = ticketPedidoHtml(D, C);
    for (const t of ['PD-2026-00138', 'ABARROTES CARMELITA', 'Vendedor: Vendedor PH', 'Entrega: sáb 21 nov', '3 productos', '992026000138']) {
      expect(h).toContain(t);
    }
  });

  it('NEGATIVO: el texto del cliente se escapa (no se cuela HTML en la impresión)', () => {
    const h = celdaEtiquetaPedido({ ...D, cliente: '<img src=x onerror=alert(1)> & "CO"' }, C);
    expect(h).not.toContain('<img');
    expect(h).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;CO&quot;');
  });

  it('sin barras o sin fecha: no se inventa nada, sale lo que hay', () => {
    const h = celdaEtiquetaPedido({ ...D, entrega: null, cliente: null }, { qr: C.qr, barras: null });
    expect(h).not.toContain('Entrega');
    expect(h).not.toContain('class="b"');
    expect(h).toContain('Cliente sin nombre');
    expect(diaDeEntrega('2026-02-30')).toBe('');
    expect(diaDeEntrega('mañana')).toBe('');
  });

  it('sólo los pedidos de la Suite llevan esta etiqueta', () => {
    expect(esFolioDeSuite('PD-2026-00138')).toBe(true);
    expect(esFolioDeSuite('03UD1001-0018665')).toBe(false);
    expect(esFolioDeSuite(null)).toBe(false);
  });

  it('las barras dibujadas son las del folio y caben en la etiqueta de 32 mm', async () => {
    const c = await dibujarCodigos('PD-2026-00138', 'tsc');
    expect(c.barras).toContain('pe-bar');
    expect(anchoBarrasMm('992026000138')).toBeLessThanOrEqual(26);
    // Ida y vuelta: lo que va impreso se lee como el mismo pedido.
    expect(folioDeLectura('992026000138')).toBe('PD-2026-00138');
  });

  it('un folio que no es de la Suite sale sin barras', async () => {
    const c = await dibujarCodigos('03UD1001-0018665', 'ticket');
    expect(c.barras).toBeNull();
  });
});
