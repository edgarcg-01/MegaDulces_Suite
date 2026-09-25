import { TicketCartaService } from './ticket-carta.service';
import { TicketDetalle, TicketLinea, TicketCascada } from './commercial-tickets.service';

/**
 * `[TK.10]` Las dos columnas de NETO en la hoja carta.
 *
 * La carta tiene espacio y por eso muestra columnas donde el ticket de 80 mm apenas declara
 * conceptos. Lo que se fija acá es lo mismo que en el otro papel, con la forma de esta hoja:
 *
 *   · las dos columnas viajan JUNTAS y cuelgan del cuadre del impuesto;
 *   · un renglón sin precio de lista dice «sin dato», no un número;
 *   · el resumen gana un renglón de importe neto que CIERRA contra el total.
 *
 * Se prueba el HTML porque es el entregable: la carta se imprime y se le da a un cliente. El
 * PDF lo hace Chromium a partir de este mismo string.
 */

const r2 = (v: number): number => Math.round(v * 100) / 100;

const L = (p: Partial<TicketLinea> = {}): TicketLinea => {
  const b: TicketLinea = {
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

const CASCADA: TicketCascada = {
  importe_lista: 72, descuento_precio: 12, subtotal: 60,
  descuento_documento: 0, descuento_documento_pct_erp: null,
  iva: 8.28, ieps: 0, total: 60, descuento_total: 12, descuento_total_pct: 16.67,
  lineas_con_lista: 1, lineas_sin_lista: 0,
  impuesto_desglosado: true, iva_lineas: 8.28, ieps_lineas: 0, importe_neto: 51.72,
};

/** El servicio sólo necesita el anexo para el logo; acá va uno que devuelve vacío. */
const svc = new TicketCartaService({ logo: () => '' } as never);

const html = (lineas: TicketLinea[] = [L()], cascada: Partial<TicketCascada> = {}): string => {
  const doc: TicketDetalle = {
    id: '05UD1005-0006440', origen: 'mostrador', origen_label: 'Ticket de mostrador',
    doc_label: null, sucursal: '05', sucursal_nombre: 'Zamora Centro', caja: 5,
    folio: '0006440', fecha: '2026-09-18', hora: null, hora_motivo: null,
    cliente_nombre: null, cliente_rfc: null, atendio: null, atendio_rol: null,
    impuestos_incluidos: true, lineas, cascada: { ...CASCADA, ...cascada },
    cuadra: true, aviso: null,
  };
  return (svc as unknown as { html(d: TicketDetalle, e: unknown): string })
    .html(doc, { rfc: 'XAXX010101000', nombre: 'MEGA DULCES', cp: '59600' });
};

describe('TK.10 · las columnas de neto en la hoja carta', () => {
  it('imprime los dos encabezados y los dos valores', () => {
    const h = html();
    expect(h).toContain('>Neto<');
    expect(h).toContain('>Neto c/desc<');
    expect(h).toContain('5.17');
    expect(h).toContain('4.31');
  });

  it('el resumen gana el importe neto y CIERRA contra el total', () => {
    const h = html();
    expect(h).toContain('Importe neto');
    expect(h).toContain('51.72');
    expect(r2((CASCADA.importe_neto as number) + (CASCADA.iva as number))).toBe(CASCADA.total);
  });

  /** ⛔ Sin cuadre desaparecen las DOS columnas y el renglón del resumen. */
  it('sin cuadre del impuesto no imprime ninguna de las dos columnas', () => {
    const h = html([L()], { impuesto_desglosado: false });
    expect(h).not.toContain('>Neto<');
    expect(h).not.toContain('>Neto c/desc<');
    expect(h).not.toContain('Importe neto');
  });

  it('con importe_neto en null tampoco las imprime (null no es cero)', () => {
    const h = html([L()], { importe_neto: null });
    expect(h).not.toContain('>Neto c/desc<');
  });

  it('un renglón sin precio de lista dice «sin dato», no un número', () => {
    const h = html([L({ lista_conocida: false, descuento_linea: 0, descuento_unitario: 0 })],
      { lineas_con_lista: 0, lineas_sin_lista: 1, descuento_precio: 0 });
    expect(h).toContain('sin dato');
  });

  /**
   * ⚠️ Con los netos son DIEZ columnas: la tabla tiene que declararlo para que el CSS reparta
   * los anchos. Sin la clase, las columnas nuevas se comen el nombre del producto sin avisar.
   */
  it('la tabla se marca con-neto para que el CSS reparta los anchos', () => {
    // ⚠️ Se mira la ETIQUETA de la tabla, no el documento: el nombre de la clase tambien vive
    // en el bloque de CSS, asi que buscarlo suelto da verdadero siempre. La primera version de
    // esta prueba fallaba por eso — y habria pasado igual con la clase sin poner.
    const tag = (h: string): string => (h.match(/<table class="det[^"]*"/) ?? [''])[0];
    expect(tag(html())).toContain('con-neto');
    expect(tag(html([L()], { impuesto_desglosado: false }))).not.toContain('con-neto');
  });
});
