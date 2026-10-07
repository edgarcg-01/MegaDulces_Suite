import { CommercialTicketsService, TicketDetalle, rotuloSinFiscal } from './commercial-tickets.service';
import { TicketCartaService } from './ticket-carta.service';

/**
 * `[TK.14]` Pedido del usuario (2026-09-30): donde un papel diga «fiscal» o «no fiscal», se quita.
 *
 * Se prueba el TEXTO VISIBLE: los comentarios HTML de la plantilla explican la historia de la
 * leyenda y no se imprimen, así que se retiran antes de buscar.
 */

describe('[TK.14] el tipo de documento sale sin «Fiscal» ni «No Fiscal»', () => {
  it.each([
    ['Factura Cont No Fiscal', 'Factura de contado'],
    ['Factura Cont (No Fiscal)', 'Factura de contado'],
    ['Factura (fiscal)', 'Factura'],
    ['Factura Telemarketing', 'Factura Telemarketing'],
    ['Ticket Contado Caja 3', 'Ticket Contado Caja 3'],
  ])('%s → %s', (entrada, esperado) => {
    expect(rotuloSinFiscal(entrada)).toBe(esperado);
  });

  it('null sigue siendo null, y un rótulo que sólo decía «Fiscal» no queda como cadena vacía', () => {
    expect(rotuloSinFiscal(null)).toBeNull();
    expect(rotuloSinFiscal('No Fiscal')).toBeNull();
  });
});

describe('[TK.14] la carta PDF no menciona lo fiscal', () => {
  const tickets = new CommercialTicketsService({} as never, {} as never);
  const carta = new TicketCartaService({ logo: () => '' } as never, {} as never);
  const visible = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '').toLowerCase();

  const doc = (): TicketDetalle =>
    (tickets as unknown as { armar(h: unknown, raw: unknown[]): TicketDetalle }).armar({
      id: '01UD1201-0900100', origen: 'credito', doc_label: rotuloSinFiscal('Factura Cont No Fiscal'),
      sucursal: '01', sucursal_nombre: 'Padre Hidalgo', caja: null, folio: '0900100', fecha: '2026-09-30',
      cliente_nombre: 'CLIENTE', cliente_rfc: null, atendio: null, atendio_rol: null,
      descuento_pct_erp: null, impuestos_incluidos: true, total: 10, iva: null, ieps: 0.74,
    }, [{ linea: 1, sku: '901', descripcion: 'CHICLE', unidad: 'PZA', cantidad: 1,
      precio_unitario: 10, precio_lista: 10, importe: 10, iva_tasa: 0, ieps_tasa: 0.08 }]);

  it('ni en el cuerpo ni en el pie de página', () => {
    const d = doc();
    const html = (carta as unknown as { html(d: TicketDetalle, e: unknown): string })
      .html(d, { rfc: 'XAXX010101000', nombre: 'MEGA DULCES', cp: '59600' });
    const pie = (carta as unknown as { pie(d: TicketDetalle): string }).pie(d);
    expect(visible(html)).not.toContain('fiscal');
    expect(visible(pie)).not.toContain('fiscal');
    expect(visible(pie)).toContain('documento informativo');
    expect(html).toContain('Factura de contado');
  });
});
