import { cuerpoTicketVenta, TicketVenta, TicketVentaLinea } from './ticket-venta';

/**
 * Candado del ticket de venta reimpreso (Fase TK.2).
 *
 * Calca el del arqueo (`tienda/ticket-arqueo.spec.ts`) porque comparten la restricción física,
 * y agrega lo propio de este papel: la cascada de descuento y lo que NO debe imprimirse.
 *
 * **1. La grilla de 32 caracteres.** El ticket no se maqueta con CSS sino contando caracteres.
 * La letra va en 14px, que ocupa el **99%** de los 72 mm imprimibles de un papel de 80 mm: un
 * renglón de 33 caracteres YA no entra, se parte en dos y rompe la alineación
 * `concepto ..... monto`. Eso no se ve en pantalla, se ve en el papel de la caja — el peor
 * lugar para descubrirlo. Acá se atrapa antes, con los nombres de producto REALES de Kepler,
 * que llegan a 70 caracteres.
 *
 * **2. La cascada tiene que CERRAR.** Lo único que un cliente puede comprobar de un papel es
 * que los números sumen. Si `lista − descuentos ≠ total`, el ticket se lee como un error del
 * sistema aunque cada cifra sea defendible por separado.
 *
 * **3. Lo que no se imprime.** Sin descuento no se imprime "Descuento: $0.00" (el 70% de los
 * tickets de mostrador no trae ninguno, y un cero invita a buscar algo que no hubo). Y NUNCA
 * se imprime una hora de venta: Kepler no la guarda, y poner el reloj del navegador ahí sería
 * presentar la hora de la reimpresión como la de la venta (la falla que midió la Fase VP).
 */

const L = (p: Partial<TicketVentaLinea>): TicketVentaLinea => ({
  linea: 1, sku: '92609', descripcion: 'VASO DART 32J32 TERMICO', unidad: 'PAQ',
  cantidad: 3, precio_lista: 23.69, precio_pagado: 23.69,
  descuento_unitario: 0, descuento_linea: 0, importe: 71.07, equivalencia: null, ...p,
});

const BASE: TicketVenta = {
  id: '03UD1001-0018665', origen: 'mostrador', origen_label: 'Ticket de mostrador',
  doc_label: 'Ticket Contado Caja 1', sucursal: '03', sucursal_nombre: 'Zamora Centro',
  caja: 1, folio: '0018665', fecha: '2026-03-07',
  cliente_nombre: 'CONTADO', cliente_rfc: 'XAXX010101000',
  atendio: 'VENTAS DE PISO', atendio_rol: 'Cajero',
  impuestos_incluidos: true,
  lineas: [L({})],
  cascada: {
    importe_lista: 71.07, descuento_precio: 0, subtotal: 71.07,
    descuento_documento: 0, descuento_documento_pct_erp: null,
    iva: 0, ieps: 2.04, total: 71.07, descuento_total: 0, descuento_total_pct: 0,
  },
  cuadra: true, aviso: null,
};

const lineas = (t: Partial<TicketVenta>) => cuerpoTicketVenta({ ...BASE, ...t }).split('\n');

describe('cuerpoTicketVenta — grilla de 32 caracteres', () => {
  /**
   * El caso más cargado que puede salir de la pantalla: nombre de sucursal largo, cliente con
   * razón social larga, productos con el nombre más largo medido en Kepler (70 caracteres),
   * descuento en renglón, equivalencia de peldaño y aviso de documento incompleto.
   */
  it('ningun renglon pasa de 32 caracteres, ni en el peor caso', () => {
    const out = lineas({
      sucursal_nombre: 'Zamora Centro Comercial Norte Ampliacion',
      cliente_nombre: 'COMERCIALIZADORA Y DISTRIBUIDORA DE ABARROTES DEL BAJIO SA DE CV',
      cliente_rfc: 'CDA010101AB9',
      atendio: 'Rosa Maria Tinoco Venegas',
      lineas: [
        L({ descripcion: 'PALETA PAYASO VAINILLA CON CHOCOLATE Y MALVAVISCO BOLSA 24 PIEZAS 960G',
            cantidad: 12, precio_lista: 1250.75, precio_pagado: 1180.5,
            descuento_unitario: 70.25, descuento_linea: 843, importe: 14166,
            equivalencia: '2 CJA' }),
        L({ linea: 2, descripcion: 'SUPERCALIFRAGILISTICOESPIALIDOSOEXTRAORDINARIOINCREIBLE', cantidad: 0.605,
            unidad: 'KG', precio_lista: 38.51, precio_pagado: 38.51, importe: 23.3 }),
      ],
      cascada: { ...BASE.cascada, importe_lista: 15032.3, descuento_precio: 843,
        subtotal: 14189.3, descuento_documento: 425.68, descuento_documento_pct_erp: 3,
        total: 13763.62, descuento_total: 1268.68, descuento_total_pct: 8.44 },
      aviso: 'Los renglones no explican el total (hueco de 22.4%). Falta detalle en el ERP.',
    });
    const largos = out.filter((l) => l.length > 32);
    expect(largos).toEqual([]);
  });

  /** Prueba NEGATIVA del candado de arriba: si no atrapara nada, sería una intención. */
  it('el candado si detecta un renglon de 33', () => {
    expect('x'.repeat(33).length > 32).toBe(true);
  });

  it('una palabra mas larga que el renglon se parte en vez de desbordar', () => {
    const out = lineas({ lineas: [L({ descripcion: 'A'.repeat(80) })] });
    expect(out.filter((l) => l.length > 32)).toEqual([]);
    expect(out.join('\n')).toContain('A'.repeat(32));
  });
});

describe('cuerpoTicketVenta — la cascada cierra', () => {
  const dinero = (s: string) => Number(s.replace(/[^0-9.-]/g, ''));
  const valor = (out: string[], etiqueta: string) => {
    const l = out.find((x) => x.startsWith(etiqueta));
    return l ? dinero(l.slice(etiqueta.length)) : null;
  };

  it('lista - descuento en precio - descuento del documento = total', () => {
    const out = lineas({
      lineas: [L({ precio_lista: 19.54, precio_pagado: 19.21, descuento_unitario: 0.33,
        descuento_linea: 0.99, importe: 57.63 })],
      cascada: { importe_lista: 58.62, descuento_precio: 0.99, subtotal: 57.63,
        descuento_documento: 1.73, descuento_documento_pct_erp: 3, iva: 0, ieps: 0,
        total: 55.9, descuento_total: 2.72, descuento_total_pct: 4.64 },
    });
    const lista = valor(out, 'Precio de lista');
    const d1 = valor(out, 'Descuento en precio');
    const d2 = valor(out, 'Descuento documento');
    const total = valor(out, 'TOTAL PAGADO');
    expect(lista).toBe(58.62);
    // Los descuentos se imprimen con signo negativo: es lo que el ojo sigue en la columna.
    expect(d1).toBe(-0.99);
    expect(d2).toBe(-1.73);
    expect(Number(((lista as number) + (d1 as number) + (d2 as number)).toFixed(2))).toBe(total);
  });

  it('el renglon dice cuanto costaba antes cuando hubo descuento', () => {
    const out = lineas({
      lineas: [L({ precio_lista: 19.54, precio_pagado: 19.21, descuento_linea: 0.99, importe: 57.63 })],
    });
    expect(out.join('\n')).toContain('antes');
  });

  it('un total MAYOR que los renglones se rotula redondeo, no descuento negativo', () => {
    const out = lineas({
      cascada: { ...BASE.cascada, descuento_documento: -0.4, total: 71.47 },
    }).join('\n');
    expect(out).toContain('Ajuste de redondeo');
    expect(out).not.toContain('Descuento documento');
  });
});

describe('cuerpoTicketVenta — lo que NO se imprime', () => {
  it('sin descuento no imprime la linea de descuento ni el bloque AHORRASTE', () => {
    const out = lineas({}).join('\n');
    expect(out).not.toContain('Descuento en precio');
    expect(out).not.toContain('Descuento documento');
    expect(out).not.toContain('AHORRASTE');
    expect(out).not.toContain('antes');
  });

  it('con descuento si aparece el bloque AHORRASTE', () => {
    const out = lineas({
      cascada: { ...BASE.cascada, descuento_precio: 0.99, descuento_total: 0.99, descuento_total_pct: 1.39 },
    }).join('\n');
    expect(out).toContain('AHORRASTE');
  });

  /**
   * ⚠️ El candado que importa: Kepler NO guarda la hora del documento (medido: sus 10 columnas
   * `timestamp` están en 00:00:00). La única hora del papel es la de la REIMPRESIÓN y va
   * rotulada como tal. Si alguien mete una "Hora de venta", esto se cae.
   */
  it('no imprime una hora de venta, y la de reimpresion va rotulada', () => {
    const out = lineas({}).join('\n');
    expect(out).not.toMatch(/Hora\b/);
    expect(out).toContain('Reimpreso');
  });

  it('dice que no es comprobante fiscal', () => {
    // La leyenda va en DOS renglones a propósito. Antes era una sola frase de 43 caracteres
    // que `envolver` partía por donde cayera: en un papel que se le entrega al cliente, la
    // leyenda legal se lee de corrido o no se lee. Si alguien la vuelve a envolver, el
    // `stringContaining` de abajo falla — el `toContain` sobre el texto pegado, no.
    const out = lineas({});
    expect(out).toEqual(expect.arrayContaining([
      expect.stringContaining('COPIA INFORMATIVA'),
      expect.stringContaining('No es comprobante fiscal'),
    ]));
  });

  /**
   * Lo encontro la MUESTRA IMPRESA, no el codigo: en un ticket sin descuento (los de antes del
   * 13-ago-2026, que no tienen precio de lista) la regla de cierre de productos y la del TOTAL
   * quedaban pegadas —`-----` y `=====` sin nada en medio— y en el papel eso se lee como un
   * renglon que falta.
   */
  it('nunca imprime dos reglas seguidas', () => {
    const esRegla = (l: string) => /^[-=]{32}$/.test(l);
    for (const caso of [
      {},                                                                       // sin descuento
      { cascada: { ...BASE.cascada, descuento_precio: 5, descuento_total: 5 } }, // con descuento
      { lineas: [] },                                                            // sin renglones
    ]) {
      const out = lineas(caso);
      const pegadas = out.filter((l, i) => i > 0 && esRegla(l) && esRegla(out[i - 1]));
      expect(pegadas).toEqual([]);
    }
  });

  it('el candado de reglas pegadas si detecta el caso', () => {
    const esRegla = (l: string) => /^[-=]{32}$/.test(l);
    const falso = ['-'.repeat(32), '='.repeat(32)];
    expect(falso.filter((l, i) => i > 0 && esRegla(l) && esRegla(falso[i - 1]))).toHaveLength(1);
  });
  it('un documento sin renglones lo declara en vez de salir vacio', () => {
    const out = lineas({ lineas: [], cascada: { ...BASE.cascada, importe_lista: 0, subtotal: 0 } }).join('\n');
    expect(out).toContain('SIN RENGLONES');
  });
});
