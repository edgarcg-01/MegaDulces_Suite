import { cuerpoTicketVenta, TicketVenta, TicketVentaLinea, TicketVentaCascada } from './ticket-venta';

/**
 * `[TK.10]` Los dos NETOS en el ticket de 80 mm.
 *
 * «Neto» = precio SIN IMPUESTOS. Son dos porque son dos momentos: antes y después del descuento.
 * Lo que se prueba acá no es la división —ésa la hace el backend— sino **cuándo el papel se
 * calla**, que es donde un desglose miente sin fallar:
 *
 *   · sin cuadre del impuesto → ninguno de los dos. Un neto que no reconstruye el total es peor
 *     que no tenerlo (ADR-056), y es el mismo candado que ya gobierna las columnas de impuesto.
 *   · sin precio de lista → no hay «antes de descuento» que publicar. `null` ≠ 0.
 *   · sin impuesto en el renglón → el neto ES el precio: repetirlo con otra etiqueta en 45
 *     caracteres se lee como una corrección, no como un dato.
 *   · sin descuento → los dos netos son el mismo número: va uno solo, sin sufijo.
 */

const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Los netos se DERIVAN de las tasas del propio fixture: una variante sin impuesto no puede
 * heredar un neto distinto del precio, o la prueba comprobaría una incoherencia.
 */
const L = (p: Partial<TicketVentaLinea> = {}): TicketVentaLinea => {
  const b: TicketVentaLinea = {
    linea: 1, sku: '900', descripcion: 'PALETA PAYASO CHICO 20G', unidad: 'PZA',
    cantidad: 12, precio_lista: 6, lista_conocida: true, precio_pagado: 5,
    descuento_unitario: 1, descuento_linea: 12, importe: 60, equivalencia: null,
    iva: 8.28, ieps: 0, impuesto_tipo: 'iva', iva_tasa: 0.16, ieps_tasa: 0,
    precio_neto: null, precio_neto_desc: null, ...p,
  };
  const div = (1 + b.ieps_tasa) * (1 + b.iva_tasa);
  return {
    ...b,
    precio_neto: p.precio_neto !== undefined ? p.precio_neto
      : (b.lista_conocida ? r2(b.precio_lista / div) : null),
    precio_neto_desc: p.precio_neto_desc !== undefined ? p.precio_neto_desc
      : r2(b.precio_pagado / div),
  };
};

const CASCADA: TicketVentaCascada = {
  importe_lista: 72, descuento_precio: 12, subtotal: 60,
  descuento_documento: 0, descuento_documento_pct_erp: null,
  iva: 8.28, ieps: 0, total: 60, descuento_total: 12, descuento_total_pct: 16.67,
  lineas_con_lista: 1, lineas_sin_lista: 0,
  impuesto_desglosado: true, iva_lineas: 8.28, ieps_lineas: 0, importe_neto: 51.72,
};

const ticket = (
  lineas: TicketVentaLinea[] = [L()],
  cascada: Partial<TicketVentaCascada> = {},
): string => cuerpoTicketVenta({
  id: '05UD1005-0006440', origen: 'mostrador', origen_label: 'Ticket de mostrador',
  doc_label: null, sucursal: '05', sucursal_nombre: 'Zamora Centro',
  caja: 5, folio: '0006440', fecha: '2026-09-18', hora: null, hora_motivo: null,
  cliente_nombre: null, cliente_rfc: null, atendio: null, atendio_rol: null,
  impuestos_incluidos: true,
  lineas,
  cascada: { ...CASCADA, ...cascada },
  cuadra: true, aviso: null,
});

describe('TK.10 · los netos en el ticket de 80 mm', () => {
  it('imprime los dos, derivados del precio que está al lado', () => {
    const t = ticket();
    // 6.00/1.16 = 5.17 (lista sin IVA) · 5.00/1.16 = 4.31 (pagado sin IVA)
    expect(t).toContain('Neto 5.17');
    expect(t).toContain('Neto c/desc 4.31');
  });

  it('el importe neto cierra contra el total: neto + IVA = total', () => {
    expect(ticket()).toContain('Importe neto');
    expect(r2((CASCADA.importe_neto as number) + (CASCADA.iva as number))).toBe(CASCADA.total);
  });

  /** ⛔ El candado principal, y el más barato de romper por accidente. */
  it('sin cuadre del impuesto NO imprime ningún neto', () => {
    const t = ticket([L()], { impuesto_desglosado: false });
    expect(t).not.toContain('Neto');
  });

  it('con el importe neto en null no imprime el total neto (null no es cero)', () => {
    expect(ticket([L()], { importe_neto: null })).not.toContain('Importe neto');
  });

  it('sin precio de lista no hay neto ANTES de descuento, y no se rellena con el pagado', () => {
    const t = ticket([L({ lista_conocida: false, descuento_linea: 0, descuento_unitario: 0 })]);
    expect(t).toContain('Neto 4.31');      // el del pagado sí: ése se sabe
    expect(t).not.toContain('Neto 5.17');  // el de lista no existe
    expect(t).not.toContain('Neto c/desc');
  });

  /** Un renglón exento: el neto ES el precio, y repetirlo gasta un renglón en nada. */
  it('sin impuesto en el renglón NO imprime neto: sería el mismo número', () => {
    const t = ticket(
      [L({ iva: 0, iva_tasa: 0, ieps: 0, ieps_tasa: 0, impuesto_tipo: null })],
      { iva: 0, iva_lineas: 0, importe_neto: 60 },
    );
    expect(t).not.toContain('Neto 5.00');
    expect(t).not.toContain('Neto c/desc');
  });

  it('sin descuento los dos netos son el mismo: se imprime UNO, sin sufijo', () => {
    const t = ticket([L({ precio_lista: 5, descuento_linea: 0, descuento_unitario: 0 })]);
    expect(t).toContain('Neto 4.31');
    expect(t).not.toContain('Neto c/desc');
  });

  /**
   * ⚠️ El ancho es el enemigo de este papel: 45 caracteres, 43 útiles con el sangrado. Un
   * concepto no puede quedar separado de su monto ni desbordar la hoja.
   */
  it('ningún renglón se pasa de 45 caracteres ni corta una etiqueta de su monto', () => {
    for (const ln of ticket().split(String.fromCharCode(10))) {
      expect(ln.length).toBeLessThanOrEqual(45);
      expect(ln.trimEnd().endsWith('Neto')).toBe(false);
      expect(ln.trimEnd().endsWith('Neto c/desc')).toBe(false);
    }
  });
});
