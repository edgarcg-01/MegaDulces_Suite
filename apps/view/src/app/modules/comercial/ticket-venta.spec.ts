import { cuerpoTicketVenta, TicketVenta, TicketVentaLinea } from './ticket-venta';

/**
 * Candado del ticket de venta reimpreso, formato **departamental** (Fase TK.2).
 *
 * **1. La grilla de 82 caracteres.** El ticket no se maqueta con CSS sino CONTANDO CARACTERES.
 * A 139.7 mm de ancho y 10px de Courier New entran exactamente 82 (medido en el navegador que
 * imprime); uno más y el renglón se parte en dos, rompiendo la alineación de las cinco
 * columnas. Eso no se ve en pantalla: se ve en el papel, que es el peor lugar para descubrirlo.
 * Se prueba con los nombres de producto REALES de Kepler, que llegan a 70 caracteres.
 *
 * **2. El ticket cabe en la medida pedida.** 139.7 × 50.8 mm son ~12 renglones a 10px. Un
 * ticket de 5 productos tiene que caber; si la maqueta engorda, este candado se cae.
 *
 * **3. La cascada tiene que CERRAR.** Lo único que un cliente puede comprobar de un papel es
 * que los números sumen.
 *
 * **4. Lo que no se imprime.** Sin descuento no se imprime "Descuento $0.00" (el 70% de los
 * tickets de mostrador no trae ninguno). Y NUNCA se imprime una hora de venta: Kepler no la
 * guarda, y poner el reloj del navegador ahí sería presentar la hora de la reimpresión como la
 * de la venta (la falla que midió la Fase VP).
 */

/** Ancho del formato departamental (139.7 mm / 10px). Medido, no elegido: ver ticket-venta.ts. */
const ANCHO = 82;
/** Renglones que caben en los 50.8 mm de alto del diseño, a 3.64 mm por renglón. */
const RENGLONES_EN_LA_MEDIDA = 12;

const L = (p: Partial<TicketVentaLinea>): TicketVentaLinea => ({
  linea: 1, sku: '70043', descripcion: 'GOMA A GRANEL LA ROSA 12KG', unidad: 'KG',
  cantidad: 420, precio_lista: 58.88, lista_conocida: true, precio_pagado: 53.21,
  descuento_unitario: 5.67, descuento_linea: 2381.40, importe: 22348.20, equivalencia: null,
  iva: 0, ieps: 1655.42, impuesto_tipo: 'ieps', iva_tasa: 0, ieps_tasa: 0.08, ...p,
});

const BASE: TicketVenta = {
  id: '05UD1005-0006440', origen: 'mostrador', origen_label: 'Ticket de mostrador',
  doc_label: 'Ticket Contado Caja 5', sucursal: '05', sucursal_nombre: 'Zamora Centro',
  caja: 5, folio: '0006440', fecha: '2026-08-26', hora: null, hora_motivo: null,
  cliente_nombre: 'CONTADO', cliente_rfc: 'XAXX010101000',
  atendio: 'SUCURSAL ZAMORA CENTRO PISO', atendio_rol: 'Cajero',
  impuestos_incluidos: true,
  lineas: [L({})],
  cascada: {
    importe_lista: 24729.60, descuento_precio: 2381.40, subtotal: 22348.20,
    descuento_documento: 0, descuento_documento_pct_erp: null,
    iva: 0, ieps: 0, total: 22348.20, descuento_total: 2381.40, descuento_total_pct: 9.63,
    lineas_con_lista: 1, lineas_sin_lista: 0,
    impuesto_desglosado: true, iva_lineas: 0, ieps_lineas: 1655.42,
  },
  cuadra: true, aviso: null,
};

/** Un ticket SIN descuento y sin precio de lista: los anteriores al 2026-08-13. */
const SIN_LISTA: Partial<TicketVenta> = {
  lineas: [L({ lista_conocida: false, precio_lista: 53.21, descuento_unitario: 0, descuento_linea: 0 })],
  cascada: {
    ...BASE.cascada, importe_lista: 22348.20, descuento_precio: 0, descuento_total: 0,
    descuento_total_pct: 0, lineas_con_lista: 0, lineas_sin_lista: 1,
  },
};

const lineas = (t: Partial<TicketVenta>) => cuerpoTicketVenta({ ...BASE, ...t }).split('\n');

describe('cuerpoTicketVenta — grilla de 82 caracteres', () => {
  /**
   * El caso más cargado que puede salir de la pantalla: sucursal larga, cliente con razón
   * social larga, cajero con nombre completo, el producto más largo medido en Kepler (70
   * caracteres), equivalencia de peldaño y aviso de documento incompleto.
   */
  it('ningun renglon pasa de 82 caracteres, ni en el peor caso', () => {
    const out = lineas({
      sucursal_nombre: 'Zamora Centro Comercial Norte Ampliacion',
      cliente_nombre: 'COMERCIALIZADORA Y DISTRIBUIDORA DE ABARROTES DEL BAJIO SA DE CV',
      cliente_rfc: 'CDA010101AB9',
      atendio: 'Rosa Maria Tinoco Venegas',
      lineas: [
        L({ descripcion: 'PALETA PAYASO VAINILLA CON CHOCOLATE Y MALVAVISCO BOLSA 24 PIEZAS 960G',
            cantidad: 12, precio_lista: 1250.75, precio_pagado: 1180.5, importe: 14166,
            equivalencia: '2 CJA' }),
        L({ linea: 2, descripcion: 'SUPERCALIFRAGILISTICOESPIALIDOSOEXTRAORDINARIOINCREIBLE',
            cantidad: 0.605, unidad: 'KG', importe: 123456.78 }),
      ],
      cascada: { ...BASE.cascada, importe_lista: 150032.30, descuento_precio: 8430,
        descuento_documento: 425.68, descuento_documento_pct_erp: 3,
        total: 137636.20, descuento_total: 8855.68, descuento_total_pct: 5.9 },
      aviso: 'Los renglones no explican el total (hueco de 22.4%). Falta detalle en el ERP.',
    });
    expect(out.filter((l) => l.length > ANCHO)).toEqual([]);
  });

  /** Prueba NEGATIVA: si el candado no atrapara nada, sería una intención. */
  it('el candado si detecta un renglon de 83', () => {
    expect('x'.repeat(ANCHO + 1).length > ANCHO).toBe(true);
  });

  /**
   * ⚠️ `fila()` devolvía renglones de 92 caracteres en cuanto el cliente y el cajero tenían
   * nombre largo — el caso NORMAL, no el raro. Un helper de maquetación que puede exceder el
   * papel es el bug esperando; ahora recorta y termina con un `slice` duro.
   */
  it('el encabezado con cliente y cajero largos se recorta en vez de desbordar', () => {
    const out = lineas({
      cliente_nombre: 'COMERCIALIZADORA Y DISTRIBUIDORA DE ABARROTES DEL BAJIO SA DE CV',
      atendio: 'SUCURSAL ZAMORA CENTRO COMERCIAL NORTE PISO DE VENTAS',
    });
    expect(out.filter((l) => l.length > ANCHO)).toEqual([]);
  });
});

describe('cuerpoTicketVenta — cabe en 139.7 x 50.8 mm', () => {
  /** La medida que dio diseño. Si la maqueta engorda, esto se cae antes que el papel. */
  it('un ticket de 5 productos entra en los 12 renglones de la medida', () => {
    const cinco = [1, 2, 3, 4, 5].map((i) => L({ linea: i, equivalencia: null }));
    const out = lineas({ lineas: cinco, cascada: { ...BASE.cascada, lineas_con_lista: 5 } });
    expect(out.length).toBeLessThanOrEqual(RENGLONES_EN_LA_MEDIDA);
  });

  it('cada producto ocupa UN renglon, equivalencia incluida', () => {
    const uno = lineas({ lineas: [L({ equivalencia: null })] }).length;
    const dos = lineas({ lineas: [L({ equivalencia: null }), L({ linea: 2, equivalencia: null })] }).length;
    expect(dos - uno).toBe(1);
    // La equivalencia va PEGADA al nombre: no gasta un renglon propio. A 50.8 mm de alto eso
    // es la diferencia entre que un ticket de 5 productos quepa o no.
    const conEq = lineas({ lineas: [L({ descripcion: 'GOMA A GRANEL', equivalencia: '35 CJA' })] });
    expect(conEq.length).toBe(uno);
    expect(conEq.join('\n')).toContain('GOMA A GRANEL (35 CJA)');
  });

  /** Si la equivalencia no cabe en la columna se omite: esta en la carta y en la pantalla. */
  it('con nombre largo la equivalencia se omite en vez de desbordar', () => {
    const out = lineas({
      lineas: [L({ descripcion: 'PALETA PAYASO VAINILLA CON CHOCOLATE Y MALVAVISCO 24P', equivalencia: '2 CJA' })],
    });
    expect(out.filter((l) => l.length > ANCHO)).toEqual([]);
    expect(out.join('\n')).not.toContain('(2 CJA)');
  });

  /** Los 5 productos del diseño, CON equivalencia: sigue cabiendo en la medida. */
  it('5 productos con equivalencia siguen entrando en los 12 renglones', () => {
    const cinco = [1, 2, 3, 4, 5].map((i) => L({ linea: i, descripcion: 'ALTOS BAJA CORT', equivalencia: '3 CJA' }));
    const out = lineas({ lineas: cinco, cascada: { ...BASE.cascada, lineas_con_lista: 5 } });
    expect(out.length).toBeLessThanOrEqual(RENGLONES_EN_LA_MEDIDA);
  });
});

describe('cuerpoTicketVenta — la cascada cierra', () => {
  /** Extrae el número que sigue a una etiqueta dentro del renglón de totales. */
  const tras = (out: string[], etiqueta: string): number | null => {
    // Se escapa la etiqueta COMPLETA. Con `replace('.', …)` sólo cambiaba el primer punto, así
    // que el llamador terminaba pre-escapando a mano y el patrón quedaba con doble barra.
    const re = new RegExp(etiqueta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+-?\\$([\\d,]+\\.\\d{2})');
    for (const l of out) {
      const m = re.exec(l);
      if (m) return Number(m[1].replace(/,/g, ''));
    }
    return null;
  };

  it('lista - descuento en precio - descuento del documento = total', () => {
    const out = lineas({
      cascada: { ...BASE.cascada, importe_lista: 24729.60, descuento_precio: 2381.40,
        descuento_documento: 100, total: 22248.20, descuento_total: 2481.40 },
    });
    const lista = tras(out, 'Lista');
    const d1 = tras(out, 'Descuento');
    const d2 = tras(out, 'Desc. documento');
    const total = tras(out, 'TOTAL');
    expect(lista).toBe(24729.60);
    expect(d1).toBe(2381.40);
    expect(d2).toBe(100);
    expect(Number(((lista as number) - (d1 as number) - (d2 as number)).toFixed(2))).toBe(total);
  });

  it('el renglon del producto muestra lista y pagado lado a lado', () => {
    const l = lineas({}).find((x) => x.includes('GOMA A GRANEL'));
    expect(l).toContain('58.88');   // lista
    expect(l).toContain('53.21');   // pagado
  });

  it('un total MAYOR que los renglones se rotula ajuste, no descuento negativo', () => {
    const out = lineas({ cascada: { ...BASE.cascada, descuento_documento: -0.4 } }).join('\n');
    expect(out).toContain('Ajuste');
    expect(out).not.toContain('Desc. documento');
  });
});

describe('cuerpoTicketVenta — desglose de impuesto (TK.4)', () => {
  /**
   * ⭐ La columna es UNA y no dos porque IVA e IEPS **nunca coinciden** en el mismo renglón
   * (0 de 123,203 medidos en prod). Con dos columnas, una siempre iría vacía y el nombre del
   * producto bajaría de 26 a 19 caracteres.
   */
  it('imprime el impuesto con la letra que dice cual es', () => {
    const conIeps = lineas({ lineas: [L({ impuesto_tipo: 'ieps', ieps: 1655.42, iva: 0 })] }).join('\n');
    expect(conIeps).toMatch(/1,655\.42 I/);
    const conIva = lineas({ lineas: [L({ impuesto_tipo: 'iva', iva: 203.94, ieps: 0, ieps_tasa: 0, iva_tasa: 0.16 })] }).join('\n');
    expect(conIva).toMatch(/203\.94 V/);
  });

  /** La leyenda va en el encabezado de columna: un renglón propio saca el ticket de la medida. */
  it('la leyenda vive en el encabezado y no gasta un renglon', () => {
    const con = lineas({});
    const sin = lineas({ cascada: { ...BASE.cascada, impuesto_desglosado: false } });
    expect(con.join('\n')).toContain('V=IVA I=IEPS');
    expect(con.length).toBe(sin.length);
  });

  /** Un producto que no causa impuesto lleva GUION, no $0.00: son cosas distintas (ADR-056). */
  it('sin impuesto imprime guion, no cero', () => {
    const out = lineas({ lineas: [L({ impuesto_tipo: null, iva: 0, ieps: 0, ieps_tasa: 0 })] });
    const fila = out.find((l) => l.includes('GOMA A GRANEL'));
    expect(fila).not.toContain('0.00 I');
    expect(fila).not.toContain('0.00 V');
  });

  /**
   * ⚠️ El candado que importa: si la suma de los renglones NO reproduce lo que declara el
   * documento, el papel no imprime el desglose. Unas columnas que el cliente suma y no le dan
   * son peores que no tenerlas.
   */
  it('si el impuesto no cuadra contra el documento, no se imprime el desglose', () => {
    const out = lineas({ cascada: { ...BASE.cascada, impuesto_desglosado: false } }).join('\n');
    expect(out).not.toContain('IMPUESTO');
    expect(out).not.toContain('V=IVA');
  });

  /** Con el desglose puesto, el ticket de 5 productos SIGUE cabiendo en la medida. */
  it('5 productos con desglose de impuesto siguen entrando en los 12 renglones', () => {
    const cinco = [1, 2, 3, 4, 5].map((i) => L({ linea: i, equivalencia: null }));
    const out = lineas({ lineas: cinco, cascada: { ...BASE.cascada, lineas_con_lista: 5 } });
    expect(out.length).toBeLessThanOrEqual(RENGLONES_EN_LA_MEDIDA);
    expect(out.filter((l) => l.length > ANCHO)).toEqual([]);
  });
});

describe('cuerpoTicketVenta — lo que NO se imprime', () => {
  it('sin descuento no imprime la cascada ni el bloque AHORRASTE', () => {
    const out = lineas(SIN_LISTA).join('\n');
    expect(out).not.toContain('Descuento');
    expect(out).not.toContain('AHORRASTE');
  });

  it('sin precio de lista la columna LISTA desaparece entera', () => {
    const out = lineas(SIN_LISTA).join('\n');
    expect(out).not.toContain('LISTA');
    expect(out).toContain('PRECIO');
  });

  it('con descuento si aparece el bloque AHORRASTE', () => {
    expect(lineas({}).join('\n')).toContain('AHORRASTE');
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
    expect(lineas({}).join('\n')).toContain('No es comprobante fiscal');
  });

  /** Con caja, `doc_label` repetiría palabra por palabra lo que ya dice el renglón de arriba. */
  it('con caja no repite el tipo de documento; sin caja si lo dice', () => {
    expect(lineas({}).join('\n')).not.toContain('Ticket Contado Caja 5');
    const factura = lineas({ caja: null, doc_label: 'Factura Telemarketing' }).join('\n');
    expect(factura).toContain('Factura Telemarketing');
  });

  it('un documento sin renglones lo declara en vez de salir vacio', () => {
    const out = lineas({ lineas: [], cascada: { ...BASE.cascada, lineas_con_lista: 0 } }).join('\n');
    expect(out).toContain('SIN RENGLONES');
  });

  /** Lo encontró la muestra impresa: dos reglas seguidas se leen como un renglón que falta. */
  it('nunca imprime dos reglas seguidas', () => {
    const esRegla = (l: string) => new RegExp('^[-=]{' + ANCHO + '}$').test(l);
    for (const caso of [{}, SIN_LISTA, { lineas: [] }]) {
      const out = lineas(caso);
      expect(out.filter((l, i) => i > 0 && esRegla(l) && esRegla(out[i - 1]))).toEqual([]);
    }
  });
});
