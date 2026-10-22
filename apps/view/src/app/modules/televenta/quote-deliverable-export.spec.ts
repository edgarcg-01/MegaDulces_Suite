import { describe, it, expect } from 'vitest';
import {
  generateQuoteFilename,
  LEYENDA_MARCA_AGUA,
  EMPRESA_NOMBRE,
  QuoteDeliverableData,
  modeloEntregable,
  condiciones,
  fechaVigencia,
  lineaControl,
  paraExcel,
} from './quote-deliverable-export';

describe('QuoteDeliverableExport — Estándares Comerciales y Entregables', () => {
  const dummyQuote: QuoteDeliverableData = {
    customerCode: 'CLI-0042',
    customerName: 'Abarrotes La Guadalupana',
    branchCode: '02',
    branchName: 'La Piedad Abastos',
    salespersonCode: 'V04',
    salespersonName: 'Juan Pérez',
    quoteDate: new Date(2026, 8, 26, 17, 30), // Sep 26, 2026, 17:30
    validUntil: '2026-10-03',
    discountPct: null,
    items: [
      {
        sku: '70068',
        name: 'PAL JUMBO CEREZA',
        unit_label: 'CJA',
        rung: 'box',
        factor: 12,
        quantity: 1,
        unit_price: 969.84,
        line_total: 969.84,
        price_source: 'volume_qty',
      },
    ],
  };

  it('formatea el nombre de archivo exacto solicitado: (NUMERO CLIENTE)(NOMBRE CLIENTE)(AAAA,MM,DD,HH,MM).ext', () => {
    const filenamePdf = generateQuoteFilename(dummyQuote, 'pdf');
    expect(filenamePdf).toBe('(CLI-0042)(ABARROTES_LA_GUADALUPANA)(2026,09,26,17,30).pdf');

    const filenameXlsx = generateQuoteFilename(dummyQuote, 'xlsx');
    expect(filenameXlsx).toBe('(CLI-0042)(ABARROTES_LA_GUADALUPANA)(2026,09,26,17,30).xlsx');
  });

  it('cumple con la leyenda oficial de marca de agua', () => {
    expect(LEYENDA_MARCA_AGUA).toBe(
      'ESTO ES UNA COTIZACION, NO UNA VENTA, EFECTOS INFORMATIVOS PARA EL CLIENTE QUE SOLICITO LA INFORMACION'
    );
  });

  it('contiene la razón social oficial de Mega Dulces', () => {
    expect(EMPRESA_NOMBRE).toBe('MEGA DULCES DE LOS ALTOS S.A. DE C.V.');
  });

  it('soporta prospectos sin código de cliente asignado', () => {
    const prospect: QuoteDeliverableData = {
      ...dummyQuote,
      customerCode: null,
      customerName: 'Cliente Nuevo Mostrador',
    };
    const filename = generateQuoteFilename(prospect, 'pdf');
    expect(filename).toMatch(/^\(PROSPECTO\)\(CLIENTE_NUEVO_MOSTRADOR\)\(\d{4},\d{2},\d{2},\d{2},\d{2}\)\.pdf$/);
  });
});

/**
 * `[E.19]` La cuenta del papel. Antes de esto el entregable del DETALLE:
 *   · restaba el descuento del cliente a un subtotal que ya lo traía y no traía IVA (C1);
 *   · aplicaba otra vez, como «descuento del renglón», el de volumen/promo que YA está en el
 *     precio unitario (C2) — medido en prod: 123 renglones, $8,539.97 por debajo.
 * Estas pruebas fijan lo que el papel tiene que decir, y no cómo se dibuja.
 */
describe('modeloEntregable — la cuenta que se le promete al cliente', () => {
  const base: QuoteDeliverableData = {
    customerCode: 'C1086', customerName: 'Cliente', branchCode: '01', branchName: 'La Piedad',
    validUntil: '2026-11-04', quoteDate: new Date(2026, 9, 20), discountPct: 3,
    items: [
      // lista $100, cotizado a $90 por VOLUMEN: el $90 ya es el precio
      { sku: 'A', name: 'Con volumen', unit_label: 'CJA', quantity: 10, unit_price: 90, line_total: 900, price_source: 'Volumen' },
      { sku: 'B', name: 'De lista', unit_label: 'CJA', quantity: 1, unit_price: 100, line_total: 100, price_source: 'Lista' },
    ],
  };

  it('el descuento del renglón es SÓLO el del cliente: el volumen no se aplica dos veces (C2)', () => {
    const m = modeloEntregable(base);
    // $90 con 3 % del cliente = $87.30; el defecto imprimía $90 × (1 − 10 %) = $81
    expect(m.filas[0].unitario).toBeCloseTo(87.3, 2);
    expect(m.filas[0].importe).toBe(873);
  });

  it('importe − descuento = total, y la columna de netos suma ese total al centavo (C1)', () => {
    const m = modeloEntregable(base);
    expect(m.totales.importe).toBe(1000);
    expect(m.totales.descuento).toBe(30);
    expect(m.totales.total).toBe(970);
    const suma = m.filas.reduce((a, f) => a + (f.importe ?? 0), 0);
    expect(Math.round(suma * 100)).toBe(97000);
    // el IVA es la parte del total, no se suma encima: 970 / 1.16 = 836.21 → IVA 133.79
    expect(m.totales.iva).toBe(133.79);
  });

  /**
   * `[E.25]` El pedido REAL de Kepler 01-0003309 (cliente con 2 %): 5 renglones IEPS 8 % y 3 de IVA
   * 16 %. Kepler guardó total 5,016.07 · IVA 180.03 · IEPS 274.88.
   */
  const pedido3309 = (conTasas: boolean): QuoteDeliverableData => ({
    ...base,
    discountPct: 2,
    items: [706.2, 789.5, 893.76, 697.5, 699.6, 641.8, 523.28, 166.8].map((imp, i) => ({
      sku: String(i), name: 'X', unit_label: 'PAQ', quantity: 1, unit_price: imp, line_total: imp,
      ...(conTasas ? (i < 5 ? { iva_rate: 0, ieps_rate: 0.08 } : { iva_rate: 0.16, ieps_rate: 0 }) : {}),
    })),
  });

  it('[E.25] con la tasa de cada producto el papel desglosa IVA e IEPS como Kepler, sin avisos', () => {
    const d = pedido3309(true);
    const m = modeloEntregable(d);
    expect(m.totales.total).toBe(5016.07);
    expect(m.totales.iva).toBe(180.03);
    expect(m.totales.ieps).toBe(274.88);
    expect(m.totales.subtotal).toBe(4561.16);
    expect(condiciones(d, m).some((c) => c.startsWith('Impuesto estimado'))).toBe(false);
  });

  it('[E.25] sin tasas (cotización vieja) el impuesto se ASUME y el papel lo dice', () => {
    const d = pedido3309(false);
    const m = modeloEntregable(d);
    expect(m.totales.impuesto_asumido).toBe(8);
    expect(condiciones(d, m)).toContain('Impuesto estimado en 8 artículo(s): IVA 16 % asumido, sin la tasa del producto.');
  });

  it('no genera el papel si su total no es el que guardó el servidor', () => {
    expect(() => modeloEntregable({ ...base, totalGuardado: 970 })).not.toThrow();
    expect(() => modeloEntregable({ ...base, totalGuardado: 950 })).toThrow(/no coincide con el total guardado/);
  });

  it('sin precio y regalo se declaran: nunca $0.00, y no entran al total', () => {
    const m = modeloEntregable({
      ...base,
      items: [
        ...base.items,
        { sku: 'X', name: 'No manejado', unit_label: 'PZA', quantity: 3, unit_price: null, line_total: 0 },
        { sku: 'G', name: 'Regalo ERP', unit_label: 'PZA', quantity: 1, unit_price: 0, line_total: 0, regalo: true },
      ],
    });
    expect(m.filas[2]).toMatchObject({ tipo: 'sin_precio', importe: null, unitario: null });
    expect(m.filas[3]).toMatchObject({ tipo: 'regalo', importe: null });
    expect(m.totales.total).toBe(970);
    expect(m.totales.sin_precio).toBe(1);
  });

  it('la emisión es la fecha de la cotización y el título avisa si ya venció o se canceló (M1)', () => {
    expect(modeloEntregable(base).emision.getDate()).toBe(20);
    expect(modeloEntregable({ ...base, estado: 'vencida' })).toMatchObject({ titulo: 'COTIZACIÓN VENCIDA', alerta: true });
    expect(modeloEntregable({ ...base, estado: 'cancelada' })).toMatchObject({ titulo: 'COTIZACIÓN CANCELADA', alerta: true });
    expect(modeloEntregable(base)).toMatchObject({ titulo: 'COTIZACIÓN FORMAL', alerta: false });
  });

  it('sin descuento del cliente, el papel imprime el precio cotizado tal cual', () => {
    const m = modeloEntregable({ ...base, discountPct: null });
    expect(m.conDescuento).toBe(false);
    expect(m.filas[0]).toMatchObject({ unitario: 90, importe: 900 });
    expect(m.totales.total).toBe(1000);
  });
});

/**
 * [E.29] La hoja de la cotización (VEN-001): lo que el papel promete y cómo lo escribe. Fechas en
 * un solo formato, la sucursal por nombre, las condiciones de pago del ERP y nada cortado en silencio.
 */
describe('hoja de la cotización — condiciones y fechas', () => {
  const base: QuoteDeliverableData = {
    customerCode: 'C1086', customerName: 'Cliente', branchCode: '01', branchName: 'Padre Hidalgo',
    validUntil: '2026-11-06', quoteDate: new Date(2026, 9, 22), discountPct: null,
    items: [{ sku: 'A', name: 'Uno', unit_label: 'PAQ', quantity: 1, unit_price: 10, line_total: 10 }],
  };

  it('la vigencia sale dd/mm/aaaa y en hora LOCAL (con new Date(iso) sería el día anterior en México)', () => {
    const v = fechaVigencia('2026-11-06');
    expect(v.texto).toBe('06/11/2026');
    expect(v.fecha?.getDate()).toBe(6);
    expect(fechaVigencia('')).toEqual({ texto: 'término indicado', fecha: null });
    expect(fechaVigencia('15 días')).toEqual({ texto: '15 días', fecha: null });
  });

  it('la sucursal va por NOMBRE: el código no aparece en las condiciones', () => {
    const c = condiciones(base, modeloEntregable(base));
    expect(c).toContain('Válida hasta el 06/11/2026 en Padre Hidalgo.');
    expect(c.join(' ')).not.toMatch(/sucursal 01|\(01\)/i);
  });

  it('el plazo de pago del ERP se imprime; sin dato NO se inventa ninguno', () => {
    const linea = (d: QuoteDeliverableData) => condiciones(d, modeloEntregable(d)).find((t) => t.startsWith('Plazo de pago'));
    expect(linea({ ...base, paymentDays: 30 })).toBe('Plazo de pago: 30 días de crédito.');
    expect(linea({ ...base, paymentDays: 0 })).toBe('Plazo de pago: de contado (sin días de crédito).');
    expect(linea({ ...base, paymentDays: null })).toBeUndefined();
    expect(linea(base)).toBeUndefined();
  });

  it('la nota al cliente va completa (antes se cortaba a 90 caracteres sin avisar)', () => {
    const nota = 'Entrega el jueves en la bodega de la calle Hidalgo; avisar a recepción antes de llegar con el pedido completo.';
    const d = { ...base, notes: nota };
    expect(nota.length).toBeGreaterThan(90);
    expect(condiciones(d, modeloEntregable(d))).toContain('Nota: ' + nota);
  });
});

/** [E.29] Control del documento: con qué versión, quién y a qué pedido corresponde un papel. */
describe('hoja de la cotización — control', () => {
  const base: QuoteDeliverableData = {
    quoteCode: 'COT-2026-00026', customerCode: 'C1086', customerName: 'Cliente', branchCode: '01',
    branchName: 'Padre Hidalgo', validUntil: '2026-11-06', discountPct: null,
    items: [{ sku: 'A', name: 'Uno', unit_label: 'PAQ', quantity: 1, unit_price: 10, line_total: 10 }],
  };

  it('la línea de control lleva folio, versión, quién la elaboró y el pedido', () => {
    const l = lineaControl({ ...base, actualizada: new Date(2026, 9, 22, 14, 5), elaboro: 'Cinthia Yaret', orderCode: 'PED-2026-00101' });
    expect(l).toBe('Folio COT-2026-00026 · Versión del 22/10/2026 14:05 · Elaboró Cinthia Yaret · Pedido PED-2026-00101');
  });

  it('lo que falta no se imprime vacío; sin folio se DECLARA', () => {
    expect(lineaControl(base)).toBe('Folio COT-2026-00026');
    expect(lineaControl({ ...base, quoteCode: null, actualizada: 'no-es-fecha' })).toBe('Folio SIN ASIGNAR');
  });

  it('la emisión AAAA-MM-DD del servidor es ESE día, no el anterior (new Date(iso) es medianoche UTC)', () => {
    const m = modeloEntregable({ ...base, quoteDate: '2026-10-22' });
    expect([m.emision.getFullYear(), m.emision.getMonth(), m.emision.getDate()]).toEqual([2026, 9, 22]);
  });

  it('paraExcel conserva la hora de PARED (ExcelJS escribe en UTC)', () => {
    const x = paraExcel(new Date(2026, 9, 22, 14, 5));
    expect([x.getUTCDate(), x.getUTCHours(), x.getUTCMinutes()]).toEqual([22, 14, 5]);
  });
});
