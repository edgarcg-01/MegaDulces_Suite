import { cuerpoTicketVenta, TicketVenta, TicketVentaLinea, TicketVentaCascada } from './ticket-venta';

/**
 * `[TK.d2]` El descuento de cabecera en el papel de 80 mm: mismo nombre que los otros dos, y
 * con el porcentaje que este papel era el único en callarse.
 *
 * Decía **«Desc. documento  -$1.80»** a secas. La carta y la pantalla ya mostraban el
 * porcentaje que declara Kepler (`kdm1.c19`, el campo que su propia pantalla rotula «Descuento
 * Cliente»); el ticket del mostrador no. Tres papeles del mismo documento no pueden nombrar el
 * mismo renglón de tres maneras.
 *
 * ⚠️ Acá el ancho manda: el papel son **45 caracteres** y `fila()` recorta por la izquierda si
 * no entra. El rótulo más largo posible —«Descuento de cliente (12.5%)», 28— más un importe de
 * 10 deja 7 de holgura. Se prueba explícitamente que el renglón NO sale mutilado.
 */

const ANCHO = 45;

const L = (p: Partial<TicketVentaLinea> = {}): TicketVentaLinea => ({
  linea: 1, sku: '900', descripcion: 'PALETA PAYASO CHICO 20G', unidad: 'PZA',
  cantidad: 12, precio_lista: 6, lista_conocida: true, precio_pagado: 5,
  descuento_unitario: 1, descuento_linea: 12, importe: 60, equivalencia: null,
  iva: 8.28, ieps: 0, impuesto_tipo: 'iva', iva_tasa: 0.16, ieps_tasa: 0,
  precio_neto: 5.17, precio_neto_desc: 4.31, ...p,
});

const CASCADA: TicketVentaCascada = {
  importe_lista: 72, descuento_precio: 12, subtotal: 60,
  descuento_documento: 1.8, descuento_documento_pct_erp: 3,
  iva: 8.28, ieps: 0, total: 58.2, descuento_total: 13.8, descuento_total_pct: 19.17,
  lineas_con_lista: 1, lineas_sin_lista: 0,
  impuesto_desglosado: true, iva_lineas: 8.28, ieps_lineas: 0, importe_neto: 50.17,
};

const ticket = (cascada: Partial<TicketVentaCascada> = {}): string => cuerpoTicketVenta({
  id: '05UF1001-0000912', origen: 'telemarketing', origen_label: 'Factura Telemarketing',
  doc_label: null, sucursal: '05', sucursal_nombre: 'Zamora Centro',
  caja: null, folio: '0000912', fecha: '2026-09-18', hora: null, hora_motivo: null,
  cliente_nombre: 'ABARROTES LA ESPERANZA', cliente_rfc: null, atendio: null, atendio_rol: null,
  impuestos_incluidos: true,
  lineas: [L()],
  cascada: { ...CASCADA, ...cascada },
  cuadra: true, aviso: null,
} as TicketVenta);

/** El renglón del ticket que contiene un texto, ya sin las etiquetas del HTML. */
const renglon = (t: string, txt: string): string =>
  (t.replace(/<[^>]*>/g, '\n').split('\n').find((l) => l.includes(txt)) ?? '');

describe('[TK.d2] el descuento de cabecera, en el papel de 80 mm', () => {
  it('se llama «Descuento de cliente» y ahora sí lleva el porcentaje', () => {
    const t = ticket();
    expect(t).toContain('Descuento de cliente (3%)');
    expect(t).toContain('-$1.80');
  });

  /** La prueba negativa: el rótulo viejo no puede volver en silencio. */
  it('ya no dice «Desc. documento»', () => {
    expect(ticket()).not.toContain('Desc. documento');
  });

  /**
   * ⛔ El riesgo propio de este papel. Un rótulo largo y `fila()` recortaría el importe o el
   * texto, y el cliente leería «Descuento de client -$1.8».
   */
  it('con el porcentaje más largo el renglón entra completo en los 45 caracteres', () => {
    const t = ticket({ descuento_documento_pct_erp: 12.5, descuento_documento: 1234.56 });
    const r = renglon(t, 'Descuento de cliente');
    expect(r.length).toBeLessThanOrEqual(ANCHO);
    expect(r).toContain('Descuento de cliente (12.5%)');
    expect(r).toContain('-$1,234.56');
  });

  /** Sin porcentaje declarado no se inventa un «(0%)». */
  it('sin porcentaje declarado el renglón va sin paréntesis', () => {
    const t = ticket({ descuento_documento_pct_erp: null });
    expect(t).toContain('Descuento de cliente');
    expect(t).not.toContain('(0%)');
  });

  /** El redondeo a favor del cliente conserva su propio nombre. */
  it('el ajuste no se disfraza de descuento de cliente', () => {
    const t = ticket({ descuento_documento: -1.2, descuento_documento_pct_erp: null });
    expect(t).toContain('Ajuste');
    expect(t).not.toContain('Descuento de cliente');
  });
});
