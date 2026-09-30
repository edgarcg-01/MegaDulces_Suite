import { cuerpoTicketVenta, TicketVenta, TicketVentaLinea } from './ticket-venta';

/**
 * Candado del ticket de venta reimpreso, **rollo de 80 mm** (Fase TK.5).
 *
 * **1. La grilla de 45 caracteres.** El ticket no se maqueta con CSS sino CONTANDO CARACTERES.
 * A 80 mm de ancho (72 útiles) y 10px de Courier New entran exactamente 45, medido en el
 * navegador que imprime. Uno más y el renglón se parte en dos, y lo que se parte es el montón
 * de la derecha: el importe. Eso no se ve en pantalla, se ve en el papel — el peor lugar para
 * descubrirlo. Se prueba con los nombres de producto REALES de Kepler, que llegan a 70.
 *
 * **2. La forma del producto.** A 45 caracteres no hay columnas: cada producto son hasta TRES
 * renglones (nombre / operación / desglose). El tercero **no se imprime** cuando no hay nada
 * que declarar — un `Desc 0.00` se leería como "te descontamos cero".
 *
 * **3. La cascada tiene que CERRAR.** Lo único que un cliente puede comprobar de un papel es
 * que los números sumen.
 *
 * **4. Lo que NO se imprime.** Esta fase quitó del papel el sello fiscal, la marca de
 * reimpresión y el aviso de procedencia (decisión del usuario; el aviso sigue en pantalla).
 * Y NUNCA se imprime una hora de venta: Kepler no la guarda, y poner el reloj del navegador
 * sería presentar la hora de la reimpresión como la de la venta (la falla que midió la Fase VP).
 */

/** Ancho del rollo de 80 mm a 10px. Medido, no elegido: ver la cabecera de ticket-venta.ts. */
const ANCHO = 45;

const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * ⚠️ Los dos netos se DERIVAN de las tasas del propio fixture, no se fijan a mano.
 *
 * La primera version los dejaba clavados en el default (54.52 / 49.27) y cualquier variante que
 * pusiera `ieps_tasa: 0` quedaba mintiendo: un renglon SIN impuesto tiene neto == precio, y el
 * fixture decia lo contrario. Esa incoherencia hizo fallar una prueba que estaba bien escrita
 * —la del producto sin nada que declarar— y por un rato parecio culpa del codigo.
 */
const L = (p: Partial<TicketVentaLinea>): TicketVentaLinea => {
  const b: TicketVentaLinea = {
    linea: 1, sku: '70043', descripcion: 'GOMA A GRANEL LA ROSA 12KG', unidad: 'KG',
    cantidad: 420, precio_lista: 58.88, lista_conocida: true, precio_pagado: 53.21,
    descuento_unitario: 5.67, descuento_linea: 2381.40, importe: 22348.20, equivalencia: null,
    iva: 0, ieps: 1655.42, impuesto_tipo: 'ieps', iva_tasa: 0, ieps_tasa: 0.08,
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
    impuesto_desglosado: true, iva_lineas: 0, ieps_lineas: 1655.42, importe_neto: 20692.78,
  },
  cuadra: true, aviso: null,
};

/** Un ticket SIN descuento y sin precio de lista: los anteriores al 2026-08-13. */
const SIN_LISTA: Partial<TicketVenta> = {
  lineas: [L({ lista_conocida: false, precio_lista: 53.21, descuento_unitario: 0,
    descuento_linea: 0, impuesto_tipo: null, iva: 0, ieps: 0, ieps_tasa: 0 })],
  cascada: {
    ...BASE.cascada, importe_lista: 22348.20, descuento_precio: 0, descuento_total: 0,
    descuento_total_pct: 0, lineas_con_lista: 0, lineas_sin_lista: 1,
  },
};

const lineas = (t: Partial<TicketVenta>) => cuerpoTicketVenta({ ...BASE, ...t }).split('\n');

describe('cuerpoTicketVenta — grilla de 45 caracteres', () => {
  /**
   * El caso más cargado que puede salir de la pantalla: sucursal larga, cliente con razón
   * social larga, cajero con nombre completo, el producto más largo medido en Kepler (70
   * caracteres), equivalencia de peldaño y aviso de documento incompleto.
   */
  it('ningun renglon pasa de 45 caracteres, ni en el peor caso', () => {
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
  it('el candado si detecta un renglon de 46', () => {
    expect('x'.repeat(ANCHO + 1).length > ANCHO).toBe(true);
  });

  /**
   * ⚠️ El nombre del cliente y el del cajero ya no comparten renglón con nada, pero a 45
   * caracteres se pasan igual: tienen que envolverse, no desbordar ni recortarse en silencio.
   */
  it('el cliente y el cajero largos se envuelven, no desbordan', () => {
    const out = lineas({
      cliente_nombre: 'COMERCIALIZADORA Y DISTRIBUIDORA DE ABARROTES DEL BAJIO SA DE CV',
      atendio: 'SUCURSAL ZAMORA CENTRO COMERCIAL NORTE PISO DE VENTAS',
    });
    expect(out.filter((l) => l.length > ANCHO)).toEqual([]);
    // Envuelto, no truncado: la última palabra del nombre tiene que seguir estando.
    expect(out.join('\n')).toContain('CV');
    expect(out.join('\n')).toContain('VENTAS');
  });
});

describe('cuerpoTicketVenta — [TK.13] la partida escrita como cuenta', () => {
  /** Una paleta: lista 6.00, pagada 5.00, 12 piezas, IVA 16%. */
  const PALETA = L({ descripcion: 'PALETA PAYASO', sku: '900', cantidad: 12, unidad: 'PZA',
    precio_lista: 6, precio_pagado: 5, descuento_unitario: 1, descuento_linea: 12, importe: 60,
    impuesto_tipo: 'iva', iva: 8.28, ieps: 0, iva_tasa: 0.16, ieps_tasa: 0 });
  const conPaleta = (extra: Partial<TicketVenta> = {}) => lineas({
    lineas: [PALETA],
    cascada: { ...BASE.cascada, importe_lista: 72, descuento_precio: 12, total: 60,
      iva: 8.28, ieps: 0, descuento_total: 12, iva_lineas: 8.28, ieps_lineas: 0 },
    ...extra,
  });

  it('el nombre y el código van en el primer renglón', () => {
    const out = conPaleta();
    const r = out.find((l) => l.startsWith('PALETA PAYASO'));
    expect(r).toBeDefined();
    expect(r?.trimEnd().endsWith('900')).toBe(true);
  });

  it('renglón 2 y 3: el valor POR PIEZA y sus impuestos, a la izquierda', () => {
    const out = conPaleta();
    expect(out).toContain('  c/u 6.00 -1.00 = 5.00');
    expect(out).toContain('  s/imp 4.31 + IVA 16% 0.69');
  });

  /**
   * Pedido del usuario sobre la maqueta «C»: la partida va TODA alineada a la derecha (su
   * importe cae en la columna derecha) y sus impuestos también a la derecha pero 12 mm antes
   * del borde = 8 caracteres. Y ya no hay renglón «Neto partida».
   */
  it('renglón 4: la partida entera pegada al borde derecho', () => {
    const out = conPaleta();
    const p = out.find((l) => l.includes('x12 PZA'));
    expect(p?.trim()).toBe('x12 PZA 72.00 -12.00 = 60.00');
    expect(p?.length).toBe(ANCHO);
  });

  it('renglón 5: los impuestos de la partida a la derecha, dejando 12 mm (8 caracteres)', () => {
    const out = conPaleta();
    const i = out.find((l) => l.includes('s/imp 51.72 + IVA 8.28'));
    expect(i?.length).toBe(ANCHO);
    expect(i?.endsWith(' '.repeat(8))).toBe(true);
    expect(i?.endsWith(' '.repeat(9))).toBe(false);
    expect(out.join('\n')).not.toContain('Neto partida');
  });

  it('con UNA pieza no repite: un solo juego de valores', () => {
    const una = L({ descripcion: 'CHICLE', sku: '901', cantidad: 1, unidad: 'PZA',
      precio_lista: 10, precio_pagado: 10, descuento_unitario: 0, descuento_linea: 0, importe: 10,
      impuesto_tipo: 'ieps', iva: 0, ieps: 0.74, iva_tasa: 0, ieps_tasa: 0.08 });
    const out = lineas({ lineas: [una], cascada: { ...BASE.cascada, total: 10, ieps_lineas: 0.74 } });
    // Con una pieza la partida ES el unitario: un solo renglón, a la derecha, con su importe.
    const r = out.find((l) => l.trim().startsWith('1 PZA'));
    expect(r?.trim()).toBe('1 PZA 10.00');
    expect(r?.length).toBe(ANCHO);
    expect(out.some((l) => l.includes('c/u') || /\sx\d/.test(l))).toBe(false);
    // Sin descuento no hay "-0.00": se leería «te descontamos cero».
    expect(out.join('\n')).not.toContain('-0.00');
    const imp = out.find((l) => l.includes('s/imp 9.26 + IEPS 8% 0.74'));
    expect(imp?.endsWith(' '.repeat(8))).toBe(true);
  });

  it('un producto sin impuesto no imprime el renglón s/imp (sería el mismo número)', () => {
    const pelado = L({ descuento_linea: 0, descuento_unitario: 0, lista_conocida: false,
      impuesto_tipo: null, iva: 0, ieps: 0, ieps_tasa: 0 });
    const out = lineas({ lineas: [pelado], cascada: { ...BASE.cascada, lineas_con_lista: 0, ieps_lineas: 0 } });
    expect(out.join('\n')).not.toContain('s/imp');
  });

  it('el descuento de CLIENTE que manda el backend se imprime dentro de la partida', () => {
    const d = { lista: 60, descuento: 6, con_descuento: 54, sin_impuestos: 46.55, iva: 7.45, ieps: 0, neto: 54 };
    const u = { lista: 5, descuento: 0.5, con_descuento: 4.5, sin_impuestos: 3.88, iva: 0.62, ieps: 0, neto: 4.5 };
    const conCliente = { ...PALETA, precio_lista: 5, lista_conocida: false, descuento_linea: 0,
      desglose: { unitario: u, partida: d, descuento_cliente: 6 } };
    const out = lineas({
      lineas: [conCliente],
      cascada: { ...BASE.cascada, descuento_precio: 0, descuento_documento: 6, descuento_documento_pct_erp: 10,
        total: 54, desglose_total: d },
    });
    expect(out).toContain('  c/u 5.00 -0.50 = 4.50');
    expect(out.find((l) => l.includes('x12'))?.trim()).toBe('x12 PZA 60.00 -6.00 = 54.00');
    expect(out.some((l) => l.startsWith('Descuento de cliente (10%)'))).toBe(true);
  });

  it('la equivalencia se pega al nombre cuando cabe, y se omite cuando no', () => {
    const corto = lineas({ lineas: [L({ descripcion: 'GOMA A GRANEL', equivalencia: '35 CJA' })] });
    expect(corto.join('\n')).toContain('GOMA A GRANEL (35 CJA)');
    const largo = lineas({
      lineas: [L({ descripcion: 'PALETA PAYASO VAINILLA CON CHOCOLATE Y MALVAVISCO 24P', equivalencia: '2 CJA' })],
    });
    expect(largo.filter((l) => l.length > ANCHO)).toEqual([]);
    expect(largo.join('\n')).not.toContain('(2 CJA)');
  });
});

describe('cuerpoTicketVenta — los totales cierran', () => {
  /** Extrae el número que sigue a una etiqueta dentro del bloque de totales (con `$`). */
  const tras = (out: string[], etiqueta: string): number | null => {
    const re = new RegExp('^' + etiqueta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+-?\\$([\\d,]+\\.\\d{2})');
    for (const l of out) {
      const m = re.exec(l);
      if (m) return Number(m[1].replace(/,/g, ''));
    }
    return null;
  };

  it('lista − descuento en precio = total, y sin impuestos + IEPS = total', () => {
    const out = lineas({});
    const lista = tras(out, 'Precio de lista');
    const d1 = tras(out, 'Descuento en precio');
    const sin = tras(out, 'Sin impuestos');
    const ieps = tras(out, 'IEPS');
    const total = tras(out, 'TOTAL');
    expect(lista).toBe(24729.60);
    expect(d1).toBe(2381.40);
    expect(Number(((lista as number) - (d1 as number)).toFixed(2))).toBe(total);
    expect(Number(((sin as number) + (ieps as number)).toFixed(2))).toBe(total);
  });

  it('un total MAYOR que los renglones se rotula ajuste, no descuento negativo', () => {
    const out = lineas({ cascada: { ...BASE.cascada, descuento_documento: -0.4 } }).join('\n');
    expect(out).toContain('Ajuste');
    expect(out).not.toContain('Descuento de cliente');
  });
});

describe('cuerpoTicketVenta — desglose de impuesto', () => {
  /**
   * ⭐ En 45 caracteres el renglón del desglose es libre, así que el impuesto se escribe con su
   * NOMBRE y ya no hace falta la letra clave ni la leyenda `V=IVA I=IEPS` que pedía el formato
   * de columnas. Sigue valiendo el hecho que lo permite: nunca coinciden (0 de 123,203).
   */
  it('escribe IVA e IEPS con su nombre, sin letra clave', () => {
    const conIeps = lineas({ lineas: [L({ impuesto_tipo: 'ieps', ieps: 1655.42, iva: 0 })] }).join('\n');
    expect(conIeps).toContain('IEPS 1,655.42');
    expect(conIeps).not.toContain('V=IVA');
    const conIva = lineas({
      lineas: [L({ impuesto_tipo: 'iva', iva: 203.94, ieps: 0, ieps_tasa: 0, iva_tasa: 0.16 })],
    }).join('\n');
    expect(conIva).toContain('IVA 203.94');
  });

  /** Un producto que no causa impuesto no lo menciona: no imprime $0.00 (ADR-056). */
  it('sin impuesto no menciona el impuesto, no imprime cero', () => {
    const out = lineas({
      lineas: [L({ impuesto_tipo: null, iva: 0, ieps: 0, ieps_tasa: 0 })],
    }).join('\n');
    expect(out).not.toContain('IEPS 0.00');
    expect(out).not.toContain('IVA 0.00');
  });

  /**
   * ⚠️ El candado que importa: si la suma de los renglones NO reproduce lo que declara el
   * documento, el papel no imprime el desglose. Unos importes que el cliente suma y no le dan
   * son peores que no tenerlos.
   */
  it('si el impuesto no cuadra contra el documento, no se imprime el desglose', () => {
    const out = lineas({ cascada: { ...BASE.cascada, impuesto_desglosado: false } }).join('\n');
    expect(out).not.toContain('IEPS');
    expect(out).not.toMatch(/\bIVA\b/);
  });
});

describe('cuerpoTicketVenta — lo que NO se imprime', () => {
  it('sin descuento no imprime la cascada ni el bloque AHORRASTE', () => {
    const out = lineas(SIN_LISTA).join('\n');
    expect(out).not.toContain('Descuento');
    expect(out).not.toContain('AHORRASTE');
  });

  it('sin precio de lista no inventa un renglon de lista', () => {
    const out = lineas(SIN_LISTA).join('\n');
    expect(out).not.toContain('Lista');
  });

  it('con descuento si aparece el bloque AHORRASTE', () => {
    expect(lineas({}).join('\n')).toContain('AHORRASTE');
  });

  /**
   * ⚠️ Kepler NO guarda la hora del documento (medido: sus 10 columnas `timestamp` están en
   * 00:00:00). Si alguien mete una "Hora de venta", esto se cae.
   */
  /**
   * `[TK.13]` La ÚNICA hora del papel es la de la REIMPRESIÓN, rotulada como tal (pedido del
   * usuario). La de la venta sigue sin imprimirse: Kepler no la guarda, y la fecha de la venta
   * va rotulada «Venta» para que no se confunda con la de la reimpresión.
   */
  it('la única hora es la de la reimpresión, en hora de México, y rotulada', () => {
    // 16:15 UTC = 10:15 en México (UTC-6).
    const out = cuerpoTicketVenta(BASE, new Date('2026-09-30T16:15:00Z')).split('\n');
    const horas = out.filter((l) => /\d{1,2}:\d{2}/.test(l));
    expect(horas.length).toBe(1);
    expect(horas[0].trim()).toBe('REIMPRESIÓN 30/09/26 10:15');
    expect(out.some((l) => l.includes('Venta 26/08/26'))).toBe(true);
    expect(out.join('\n')).not.toMatch(/Hora\b/);
  });

  it('encabezado: marca, razón social del emisor, sucursal y reimpresión, en ese orden', () => {
    const out = cuerpoTicketVenta({ ...BASE, emisor_nombre: 'LUIS FRANCISCO LOPEZ GUTIERREZ' })
      .split('\n').map((l) => l.trim());
    expect(out[0]).toBe('MEGA DULCES');
    expect(out[1]).toBe('LUIS FRANCISCO LOPEZ GUTIERREZ');
    expect(out[2]).toBe('Zamora Centro');
    expect(out[3].startsWith('REIMPRESIÓN ')).toBe(true);
  });

  it('sin identidad fiscal configurada omite la razón social, no la inventa', () => {
    const out = cuerpoTicketVenta({ ...BASE, emisor_nombre: null }).split('\n').map((l) => l.trim());
    expect(out[1]).toBe('Zamora Centro');
  });

  /**
   * TK.5, decisión del usuario: el sello fiscal sale del PAPEL. (La marca de reimpresión, que
   * TK.5 también había quitado, VOLVIÓ en TK.13 a pedido del usuario: ver la prueba de la hora.)
   */
  it('no imprime el sello fiscal', () => {
    const out = lineas({}).join('\n');
    expect(out).not.toContain('comprobante fiscal');
  });

  /**
   * ⚠️ El aviso de procedencia tampoco va al papel — pero NO desapareció: lo sigue mostrando
   * `/comercial/tickets`. Este candado cuida el papel; el de la pantalla es que el componente
   * siga leyendo `d.aviso`.
   */
  it('el aviso del backend no sale en el papel', () => {
    const out = lineas({ aviso: 'Kepler no guarda el precio de lista de este documento.' }).join('\n');
    expect(out).not.toContain('precio de lista de este documento');
  });

  /** Con caja, `doc_label` repetiría lo que ya dice el renglón de arriba. */
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
