import { describe, it, expect } from 'vitest';
import {
  generateQuoteFilename,
  LEYENDA_MARCA_AGUA,
  EMPRESA_NOMBRE,
  QuoteDeliverableData,
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
    subtotal: 969.84,
    total: 969.84,
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
