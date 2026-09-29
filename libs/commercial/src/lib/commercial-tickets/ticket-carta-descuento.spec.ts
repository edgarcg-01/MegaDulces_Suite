import { TicketCartaService } from './ticket-carta.service';
import { TicketDetalle, TicketLinea, TicketCascada } from './commercial-tickets.service';

/**
 * `[TK.d2]` El renglón del descuento de cabecera se llama por su nombre.
 *
 * Decía **«Descuento del documento (3% del ERP)»**: nombra al papel y al sistema, no a lo que
 * pasó. El cliente que lo lee no sabe qué es «el documento» ni qué es «el ERP».
 *
 * Kepler rotula ese campo (`kdm1.c19`) **«Descuento Cliente»** en su propia pantalla —anclado a
 * una captura y comprobado campo por campo en `ERP_KEPLER` §4— y §3.1 lo define como el
 * descuento comercial sobre el total. Se usa ese nombre y el porcentaje va pelado.
 *
 * ⚠️ Lo que este renglón NO afirma: que el porcentaje venga del maestro de clientes. Es el que
 * el documento declara en su cabecera. Contrastarlo contra `kdud` está sin medir y declarado
 * como tal en el plan de fase — no se dibuja como si estuviera comprobado.
 */

const L: TicketLinea = {
  linea: 1, sku: '900', descripcion: 'PALETA PAYASO CHICO 20G', unidad: 'PZA',
  cantidad: 12, precio_lista: 6, lista_conocida: true, precio_pagado: 5,
  descuento_unitario: 1, descuento_linea: 12, importe: 60, equivalencia: null,
  iva: 8.28, ieps: 0, impuesto_tipo: 'iva', iva_tasa: 0.16, ieps_tasa: 0,
  precio_neto: 5.17, precio_neto_desc: 4.31,
};

const CASCADA: TicketCascada = {
  importe_lista: 72, descuento_precio: 12, subtotal: 60,
  descuento_documento: 1.8, descuento_documento_pct_erp: 3,
  iva: 8.28, ieps: 0, total: 58.2, descuento_total: 13.8, descuento_total_pct: 19.17,
  lineas_con_lista: 1, lineas_sin_lista: 0,
  impuesto_desglosado: true, iva_lineas: 8.28, ieps_lineas: 0, importe_neto: 50.17,
};

const svc = new TicketCartaService({ logo: () => '' } as never);

const html = (cascada: Partial<TicketCascada> = {}): string => {
  const doc: TicketDetalle = {
    id: '05UF1001-0000912', origen: 'telemarketing', origen_label: 'Factura Telemarketing',
    doc_label: null, sucursal: '05', sucursal_nombre: 'Zamora Centro', caja: null,
    folio: '0000912', fecha: '2026-09-18', hora: null, hora_motivo: null,
    cliente_nombre: 'ABARROTES LA ESPERANZA', cliente_rfc: null, atendio: null, atendio_rol: null,
    impuestos_incluidos: true, lineas: [L], cascada: { ...CASCADA, ...cascada },
    cuadra: true, aviso: null,
  };
  return (svc as unknown as { html(d: TicketDetalle, e: unknown): string })
    .html(doc, { rfc: 'XAXX010101000', nombre: 'MEGA DULCES', cp: '59600' });
};

describe('[TK.d2] el descuento de cabecera, en la carta', () => {
  it('se llama «Descuento de cliente» y lleva el porcentaje', () => {
    const h = html();
    expect(h).toContain('Descuento de cliente');
    expect(h).toContain('(3%)');
    expect(h).toContain('-$1.80');
  });

  /** La prueba negativa: los dos rótulos viejos no pueden volver sin ponerse en rojo. */
  it('ya no dice «del documento» ni «del ERP»', () => {
    const h = html();
    expect(h).not.toContain('Descuento del documento');
    expect(h).not.toContain('del ERP');
  });

  /**
   * ⚠️ Sin porcentaje declarado no se inventa un «(0%)»: el renglón sale con el importe solo.
   * Un 0% diría que hubo un descuento de cero, que no es lo mismo que «no se declaró».
   */
  it('sin porcentaje declarado, el renglón va sin paréntesis', () => {
    const h = html({ descuento_documento_pct_erp: null });
    expect(h).toContain('Descuento de cliente');
    expect(h).not.toContain('(0%)');
    expect(h).toMatch(/Descuento de cliente<\/td>/);
  });

  /** El redondeo a favor del cliente sigue siendo otra cosa, y conserva su nombre. */
  it('el ajuste de redondeo no se disfraza de descuento de cliente', () => {
    const h = html({ descuento_documento: -1.2, descuento_documento_pct_erp: null });
    expect(h).toContain('Ajuste de redondeo');
    expect(h).not.toContain('Descuento de cliente');
  });
});
