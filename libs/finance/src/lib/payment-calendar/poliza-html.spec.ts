import { camposDelCheque, polizaDelCheque } from '@megadulces/contracts';
import { POLIZA_ALTO_MM, POLIZA_ANCHO_MM, opcionesPdfPoliza, polizaHtml } from './poliza-html';
import { diaDeColumna, documentosDePoliza } from './payment-calendar-document.service';
import type { ItemDePoliza } from './payment-calendar.service';

const item = (o: Partial<ItemDePoliza> = {}): ItemDePoliza => ({
  applied_amount: 100_000, beneficiary: 'Dulces del Bajío', obligation_source: 'kepler_payable', concept: '41230',
  branch_code: '05', doc_ref: ' FAC-A9000 ', vence: '2026-11-15', payee_code: 'C0123', discount_amount: 0,
  discount_lines: [], cfdi: null, ...o,
});

const poliza = (beneficiario = 'Dulces del Bajío SA de CV') => polizaDelCheque({
  folio: '5407',
  campos: camposDelCheque({ fecha: '2026-11-20', beneficiario, centavos: 10_744_693 }),
  centavos: 10_744_693,
  banco: 'BanBajío · Conecta · BB 4166',
  cuentaBanco: { cuenta: '1120000001', nombre: 'BANCO DEL BAJIO 4166' },
  clasificacion: 'Proveedor de mercancía',
  dia: '2026-11-20',
  acreedor: 'C0123',
  documentos: documentosDePoliza({ items: [item(), item({ concept: '41231', doc_ref: null, applied_amount: 7_446.93 })] }),
  hechoPor: 'Quien imprime',
});

describe('[PGP.168.1] la póliza en papel', () => {
  const html = polizaHtml(poliza(), '25-nov-2026 18:40');

  it('media carta vertical, sin márgenes: el tamaño del talonario de hoy', () => {
    expect(html).toContain(`@page{size:${POLIZA_ANCHO_MM}mm ${POLIZA_ALTO_MM}mm;margin:0}`);
    expect(opcionesPdfPoliza()).toMatchObject({ width: '139.7mm', height: '215.9mm', preferCSSPageSize: true });
  });

  it('dos hojas: ORIGINAL y COPIA, cada una en su página', () => {
    expect(html.match(/<section class="copia">/g)).toHaveLength(2);
    expect(html.indexOf('>ORIGINAL<')).toBeGreaterThan(0);
    expect(html.indexOf('>COPIA<')).toBeGreaterThan(html.indexOf('>ORIGINAL<'));
    expect(html).toContain('.copia+.copia{break-before:page}');
  });

  it('repite el cheque y lleva las sumas iguales', () => {
    for (const t of ['Cheque No. <b>5407</b>', '20 DE NOVIEMBRE DE 2026', '**107,446.93**', 'SUMAS IGUALES', 'Recibí el cheque No. 5407 por $107,446.93.']) {
      expect(html).toContain(t);
    }
  });

  it('cada documento es un parcial que ocupa también las columnas de cuenta (no lleva cuenta propia)', () => {
    expect(html).toContain('<tr class="doc"><td colspan="3" class="parcial-nombre">Suc 05 · folio 41230 · Ref. FAC-A9000');
    expect(html.match(/<tr class="doc">/g)).toHaveLength(4); // 2 documentos × 2 copias
  });

  it('lo que va a mano tiene su línea: número de póliza, firma, nombre, fecha, revisado, sello', () => {
    for (const t of ['Póliza No.', 'Firma de quien recibe', 'Nombre de quien recibe', '>Fecha<', 'Revisado por', 'Sello de captura']) expect(html).toContain(t);
    expect(html).toContain('La cuenta del beneficiario la escribe Contabilidad.');
    expect(html).toContain('<b>Quien imprime</b>Hecho por');
  });

  it('el nombre se escapa: un «&» o un «<» en la razón social no rompen el documento', () => {
    const h = polizaHtml(poliza('A&B <Dulces> SA'), 'x');
    expect(h).toContain('A&amp;B &lt;DULCES&gt; SA');
    expect(h).not.toContain('<DULCES>');
  });
});

describe('[PGP.168.1] los documentos de la póliza salen del pago armado', () => {
  it('una factura de Kepler: folio, sucursal, referencia (recortada) y vencimiento', () => {
    expect(documentosDePoliza({ items: [item()] })[0]).toMatchObject({ folio: '41230', sucursal: '05', referencia: 'FAC-A9000', vence: '2026-11-15', concepto: null, uuid: null });
  });

  it('el UUID sólo si se ligó UN CFDI; con varios candidatos no se escoge uno', () => {
    const uno = item({ cfdi: { estado: 'unico', cfdi: { uuid: 'AAA' } } });
    const varios = item({ cfdi: { estado: 'varios', cfdi: null } });
    expect(documentosDePoliza({ items: [uno, varios] }).map((d) => d.uuid)).toEqual(['AAA', null]);
  });

  it('un gasto o un compromiso no es factura de Kepler: va por su concepto, sin folio ni sucursal', () => {
    const d = documentosDePoliza({ items: [item({ obligation_source: 'budget_expense', concept: 'Renta de bodega', branch_code: '05', doc_ref: 'X' })] })[0];
    expect(d).toMatchObject({ folio: null, sucursal: null, referencia: null, concepto: 'Renta de bodega' });
  });

  it('el descuento al pagar lleva su rótulo; sin descuento, ninguno', () => {
    const con = item({ applied_amount: 97_000, discount_amount: 3_000, discount_lines: [{ reason: 'pronto_pago', amount: 3000, rate: 0.03, note: null }] });
    const [a, b] = documentosDePoliza({ items: [con, item()] });
    expect(a.descuento).toBe(3_000);
    expect(a.descuentoRotulo).toBeTruthy();
    expect(b.descuentoRotulo).toBeNull();
  });

  it('un `date` de Postgres llega como Date a medianoche local: se lee su día, no el de UTC', () => {
    expect(diaDeColumna(new Date(2026, 10, 15))).toBe('2026-11-15');
    expect(diaDeColumna('2026-11-15')).toBe('2026-11-15');
    expect(diaDeColumna(null)).toBeNull();
    expect(diaDeColumna(new Date('x'))).toBeNull();
  });
});
