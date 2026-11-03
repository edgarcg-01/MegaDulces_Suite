import { describe, it, expect } from 'vitest';
import { PaymentCalendarDocumentService } from './payment-calendar-document.service';
import type { ExpedienteLinea } from './payment-calendar.service';

/**
 * `[PGP.47]` **El desglose por factura del Preliminar.**
 *
 * Lo que se prueba acá no es «que pinte una tabla»: es que el papel **no afirme lo que no es**.
 * Cada caso nace de algo medido contra prod el 2026-11-03 y que, mal escrito, habría mentido:
 *
 *  - `ref_evidencia` son DOS cosas con la misma forma (142 ids internos de comprobante contra 36
 *    UUID fiscales del SAT). Publicar el primero como identificador fiscal mentiría en 142 de 178.
 *  - El folio externo sale del CFDI (36 de 36, timbrado) o del OCR (132 de 142, una lectura de
 *    una foto). Sin declarar la fuente, una lectura automática se lee como un dato fiscal.
 *  - 33 de 226 líneas vivas son documentos que el ERP **ya tiene saldados**: si eso no grita en
 *    el renglón, se firma un pago que no se puede ejecutar.
 *  - Una obligación propia no tiene factura del ERP detrás. Contarla como «sin papel» inflaría
 *    lo que hay que ir a buscar al archivo (ADR-056).
 *
 * ⛔ Los dos métodos son privados a propósito (nadie fuera del documento los necesita); se
 * alcanzan por `as any`, que es acceso de prueba, no un agujero en la API.
 */

const svc = new PaymentCalendarDocumentService(null as never);
const tabla = (alloc: unknown[], det: ExpedienteLinea[]): string =>
  (svc as unknown as { tablaExpediente(a: unknown[], d: ExpedienteLinea[]): string }).tablaExpediente(alloc, det);
const control = (det: ExpedienteLinea[]): string =>
  (svc as unknown as { controlExpediente(d: ExpedienteLinea[]): string }).controlExpediente(det);

function linea(over: Partial<ExpedienteLinea> = {}): ExpedienteLinea {
  return {
    allocation_id: 'A1', obligation_source: 'kepler_payable', obligation_id: 'O1',
    se_paga: 1000, sucursal: '00', folio_interno: '0009780', folio_externo: 'FDA 56778',
    folio_externo_fuente: 'ocr', orden_compra: '0007005', fecha_recepcion: '2026-09-24',
    fecha: '2026-09-24', vencimiento: '2026-10-24', importe: 1000, pendiente: 1000,
    referencia: '0-F6778', rfc: 'CSA0806034GA', rfc_fuente: 'nombre', rfc_discrepa: null,
    papel: 'pdf', uuid_fiscal: null, saldada: false, ...over,
  };
}
const pago = (over: Record<string, unknown> = {}) => ({
  id: 'A1', priority_rank: 1, amount_assigned: 1000, classification: 'proveedor_mercancia',
  payment_method: 'transferencia', bank_account_label: 'Banorte 3041',
  destination_account_text: 'CLABE 072180001234567890', items: [{ beneficiary: 'SARAMEL' }], ...over,
});

describe('[PGP.47] el desglose por factura', () => {
  it('imprime UN renglón por factura, no los beneficiarios concatenados', () => {
    const html = tabla([pago({ amount_assigned: 3000 })], [
      linea({ folio_interno: '0009780' }), linea({ folio_interno: '0009781' }), linea({ folio_interno: '0009782' }),
    ]);
    expect(html).toContain('0009780');
    expect(html).toContain('0009781');
    expect(html).toContain('0009782');
    expect((html.match(/class="doc-row"/g) ?? []).length).toBe(3);
  });

  it('⛔ publica la sucursal por NOMBRE, y el código NO aparece como celda', () => {
    const html = tabla([pago()], [linea({ sucursal: '00' })]);
    expect(html).toContain('CEDIS');
    // El control que importa: que no quede una celda cuyo contenido ÚNICO sea el código.
    expect(html).not.toMatch(/<td>\s*00\s*<\/td>/);
  });

  it('⛔ el UUID fiscal sólo se publica cuando la evidencia ES el UUID', () => {
    const conPdf = tabla([pago()], [linea({ papel: 'pdf', uuid_fiscal: null })]);
    expect(conPdf).not.toContain('F873518E');
    const conUuid = tabla([pago()], [linea({ papel: 'uuid', uuid_fiscal: 'F873518E-4EDE-459B-A3C6-499A59CD68DC' })]);
    expect(conUuid).toContain('UUID');
  });

  it('⛔ el folio externo viaja con su FUENTE: timbrado y leído no valen lo mismo', () => {
    const porOcr = tabla([pago()], [linea({ folio_externo: 'FDA 56778', folio_externo_fuente: 'ocr' })]);
    expect(porOcr).toContain('FDA 56778');
    expect(porOcr).toContain('OCR');
    const porCfdi = tabla([pago()], [linea({ folio_externo: 'F961549', folio_externo_fuente: 'cfdi' })]);
    expect(porCfdi).toContain('CFDI');
    expect(porCfdi).not.toContain('>OCR<');
  });

  it('sin folio externo no inventa fuente: la columna queda declarada en blanco', () => {
    const html = tabla([pago()], [linea({ folio_externo: null, folio_externo_fuente: 'ninguna' })]);
    expect(html).not.toContain('OCR');
    expect(html).not.toContain('CFDI');
  });

  it('⛔ una factura que el ERP ya no debe lo GRITA en su renglón', () => {
    const html = tabla([pago()], [linea({ saldada: true })]);
    expect(html).toContain('YA SALDADA EN EL ERP');
  });

  it('un pago sin documentos ligados lo dice, en vez de dejar el hueco mudo', () => {
    const html = tabla([pago()], []);
    expect(html).toContain('Sin desglose');
  });

  it('las fechas se cortan del texto ISO — nunca por Date, que corre el día en México', () => {
    const html = tabla([pago()], [linea({ fecha: '2026-10-25', vencimiento: '2026-01-01' })]);
    expect(html).toContain('25-oct');
    expect(html).toContain('1-ene');
    expect(html).not.toContain('24-oct');
    expect(html).not.toContain('31-dic');
  });
});

describe('[PGP.47] el control del expediente', () => {
  const muestra: ExpedienteLinea[] = [
    linea({ papel: 'pdf' }),
    linea({ papel: 'uuid', uuid_fiscal: 'AA', folio_externo: 'F1', folio_externo_fuente: 'cfdi' }),
    linea({ papel: 'ninguna', folio_externo: null, folio_externo_fuente: 'ninguna' }),
    linea({ obligation_source: 'supplier_payable', papel: 'no_aplica', folio_externo: null, folio_externo_fuente: null }),
  ];

  it('⛔ una obligación propia NO cuenta como «sin papel»: no tiene factura del ERP detrás', () => {
    const html = control(muestra);
    // 4 documentos en total, pero sólo 3 con factura del ERP detrás, y UNO solo sin papel.
    expect(html).toMatch(/Documentos del día<\/td><td class="r"><b>4<\/b>/);
    expect(html).toContain('3 con factura del ERP detrás');
    expect(html).toMatch(/SIN ningún papel<\/td><td class="r"><b>1<\/b>/);
  });

  it('separa lo que se puede imprimir del sistema de lo que hay que pedirle al proveedor', () => {
    const html = control(muestra);
    expect(html).toMatch(/digitalizada \(PDF\)<\/td><td class="r"><b>1<\/b>/);
    expect(html).toMatch(/sin archivo<\/td><td class="r"><b>1<\/b>/);
  });

  it('avisa cuántos folios externos los leyó un OCR y no están verificados', () => {
    const html = control(muestra);
    // Uno solo: de los 3 con factura del ERP detrás, el del CFDI es timbrado y el tercero no
    // tiene folio externo. Contar 2 sería contar el timbrado como lectura.
    expect(html).toMatch(/leído por OCR<\/td><td class="r"><b>1<\/b>/);
    expect(html).toContain('cotejar contra el papel');
  });

  it('cuenta el pago parcial, que es el que necesita soporte anexo', () => {
    const html = control([linea({ se_paga: 400, pendiente: 1000 }), linea({ se_paga: 1000, pendiente: 1000 })]);
    expect(html).toMatch(/menos de lo que se debe<\/td><td class="r"><b>1<\/b>/);
  });

  it('⛔ la alerta de documento saldado NO se imprime cuando no hay ninguno', () => {
    expect(control([linea({ saldada: false })])).not.toContain('ATENCIÓN');
    expect(control([linea({ saldada: true })])).toContain('ATENCIÓN');
  });
});
