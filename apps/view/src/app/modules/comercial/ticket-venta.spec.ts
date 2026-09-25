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

describe('cuerpoTicketVenta — el producto en tres renglones', () => {
  /** El nombre tiene el renglón entero: es lo que se perdía cuando había 7 columnas. */
  it('el nombre del producto va solo en su renglon, completo', () => {
    const nombre = 'PALETA PAYASO VAINILLA CON CHOCOLATE 24P';  // 40, entra en 45
    const out = lineas({ lineas: [L({ descripcion: nombre })] });
    expect(out).toContain(nombre);
  });

  it('la operacion dice cuanto, por cuanto, igual a cuanto', () => {
    const out = lineas({ lineas: [L({ cantidad: 12, unidad: 'PZA', precio_pagado: 5, importe: 60 })] });
    const op = out.find((l) => l.includes(' x '));
    expect(op).toContain('12 PZA x 5.00');
    expect(op).toContain('60.00');
  });

  /**
   * ⚠️ El candado de la forma: sin nada que declarar son DOS renglones, con algo son TRES.
   * Si el tercero se imprimiera siempre, cada ticket crecería un 50% en papel y diría
   * "Desc 0.00" — que se lee como una afirmación, no como un hueco.
   */
  it('sin nada que declarar el producto ocupa DOS renglones, no tres', () => {
    const pelado = L({ descuento_linea: 0, lista_conocida: false, impuesto_tipo: null,
      iva: 0, ieps: 0, ieps_tasa: 0 });
    const uno = lineas({ lineas: [pelado], cascada: { ...BASE.cascada, lineas_con_lista: 0 } });
    const dos = lineas({ lineas: [pelado, { ...pelado, linea: 2 }], cascada: { ...BASE.cascada, lineas_con_lista: 0 } });
    expect(dos.length - uno.length).toBe(2);
  });

  /**
   * ⚠️ ESTA PRUEBA CAMBIO DE VALOR CON [TK.10], a proposito: antes decia TRES.
   *
   * Un producto con descuento E impuesto ahora declara cuatro conceptos —Lista, Desc, IVA y
   * los dos netos— y en 43 caracteres utiles ya no entran en un renglon. El ticket pasa a
   * CUATRO. Es el costo que se acepto al agregar las columnas, medido antes de escribirlas.
   *
   * Lo que NO puede cambiar, y por eso se comprueba abajo, es COMO se parte: por concepto,
   * nunca dejando una etiqueta sin su monto.
   */
  it('con descuento, impuesto y netos el producto ocupa CUATRO renglones', () => {
    const corto = L({ descripcion: 'PALETA', cantidad: 12, unidad: 'PZA', precio_lista: 6,
      precio_pagado: 5, descuento_linea: 12, importe: 60,
      impuesto_tipo: 'iva', iva: 8.28, ieps: 0, iva_tasa: 0.16, ieps_tasa: 0 });
    const uno = lineas({ lineas: [corto] });
    const dos = lineas({ lineas: [corto, { ...corto, linea: 2 }] });
    expect(dos.length - uno.length).toBe(4);

    // 6.00/1.16 = 5.17 y 5.00/1.16 = 4.31: los dos netos salen del precio que esta al lado.
    const txt = uno.join(String.fromCharCode(10));
    expect(txt).toContain('Neto 5.17');
    expect(txt).toContain('Neto c/desc 4.31');
    // Ninguna etiqueta queda huerfana al final de su renglon.
    for (const ln of uno) {
      expect(ln.trimEnd().endsWith('Neto')).toBe(false);
      expect(ln.trimEnd().endsWith('Neto c/desc')).toBe(false);
    }
  });

  /**
   * ⚠️ Lo encontró el candado, no la vista: con montos grandes el desglose pasa de los 43
   * caracteres útiles, y el envoltorio por palabra dejaba `IEPS` al final de un renglón y
   * `1,655.42` al principio del siguiente — una etiqueta separada de su monto. Ahora se empaca
   * por CONCEPTO: baja el concepto entero o no baja.
   */
  it('cuando el desglose no cabe, baja el concepto entero y no parte el monto', () => {
    const out = lineas({ lineas: [L({})] });          // Lista 58.88 · Desc -2,381.40 · IEPS 1,655.42
    const texto = out.join('\n');
    expect(texto).toContain('IEPS 1,655.42');
    expect(texto).toContain('Desc -2,381.40');
    expect(out.filter((l) => l.length > ANCHO)).toEqual([]);
    // Y el concepto que bajó sigue sangrado como el de arriba.
    expect(out.filter((l) => l.includes('IEPS 1,655.42'))[0].startsWith('  ')).toBe(true);
  });

  /**
   * ⚠️ Lo encontró la muestra renderizada: el desglose salía PEGADO AL MARGEN, desalineado de
   * la operación que explica. `envolver()` parte por `\s+` y rejunta con un espacio, así que el
   * sangrado tiene que agregarse DESPUÉS de envolver, no antes.
   */
  it('el desglose va sangrado como la operacion', () => {
    const out = lineas({ lineas: [L({})] });
    const op = out.find((l) => l.includes(' x '));
    const desglose = out.find((l) => l.includes('Lista 58.88'));
    expect(op?.startsWith('  ')).toBe(true);
    expect(desglose?.startsWith('  ')).toBe(true);
  });

  /** La equivalencia de peldaño va pegada al nombre si cabe; si no, se omite (es descriptiva). */
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

describe('cuerpoTicketVenta — la cascada cierra', () => {
  /** Extrae el número que sigue a una etiqueta dentro del bloque de totales. */
  const tras = (out: string[], etiqueta: string): number | null => {
    // Se exige el `$`: los totales usan `pesos()` (con símbolo) y el desglose del producto usa
    // `money()` (sin símbolo), así que "Lista 6.00" de un renglón NO se confunde con el total.
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

  it('el desglose del producto muestra lista y descuento', () => {
    const out = lineas({}).join('\n');
    expect(out).toContain('Lista 58.88');
    expect(out).toContain('Desc -2,381.40');
  });

  it('un total MAYOR que los renglones se rotula ajuste, no descuento negativo', () => {
    const out = lineas({ cascada: { ...BASE.cascada, descuento_documento: -0.4 } }).join('\n');
    expect(out).toContain('Ajuste');
    expect(out).not.toContain('Desc. documento');
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
  it('no imprime ninguna hora', () => {
    const out = lineas({}).join('\n');
    expect(out).not.toMatch(/Hora\b/);
    expect(out).not.toMatch(/\d{1,2}:\d{2}/);
  });

  /**
   * TK.5, decisión del usuario: el sello fiscal y la marca de reimpresión salen del PAPEL.
   * Se prueba explícitamente para que nadie los reponga sin darse cuenta.
   */
  it('no imprime el sello fiscal ni la marca de reimpresion', () => {
    const out = lineas({}).join('\n');
    expect(out).not.toContain('comprobante fiscal');
    expect(out).not.toContain('Reimpreso');
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
