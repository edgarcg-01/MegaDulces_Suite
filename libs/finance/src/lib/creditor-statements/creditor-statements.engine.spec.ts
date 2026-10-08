/**
 * `[ECA.1]` Pruebas del motor del Estado de cuenta de acreedores.
 *
 * El caso de armado es el REAL de Mondelez (CM009), contra el reporte "Estado de cuenta del
 * proveedor" de Kepler del 07/10/2026 (filtro 01/08/2026–31/10/2026), medido en prod:
 *  · 0007199 $129,191.53 ← transferencia 0016796 $129,191.53 → saldo 0.
 *  · 0007211 $251,924.43 ← transferencia 0016281 $233,924.43 + nota de crédito 0001153 $18,000 → saldo 0.
 *  · 0007213 $533,666.29 ← transferencia 0016183 $474,110.29 + notas 0001149 $56,542 y 0001150 $3,014 → saldo 0.
 *  · La transferencia 0016796 ($641,405.60) se repartió entre 0007199 y 0007210 → no le queda remanente.
 * Y las pruebas negativas: un banco con comisiones NO es deuda financiera, y un documento sin
 * vencimiento NO está vencido (ADR-056: lo que no se puede medir se declara, no se pinta).
 */
import {
  armarEstado, clasificarAcreedor, estadoDocumento, nombreGrupo, totalesEstado, type AplicacionCruda, type DocCrudo,
} from './creditor-statements.engine';

const A = (folio: string, importe: string, over: Partial<DocCrudo> = {}): DocCrudo => ({
  sucursal: '00', naturaleza: 'A', tipo_doc: '20', sub: '1', folio, documento: 'Aplica Orden Entrada',
  fecha: '2026-06-29', vence: '2026-07-27', referencia: '0-F-7455', importe, ...over,
});
const D = (tipo: string, folio: string, importe: string, fecha: string): DocCrudo => ({
  sucursal: '00', naturaleza: 'D', tipo_doc: tipo, sub: '1', folio,
  documento: tipo === '26' ? 'Transferencia a proveedor' : 'Nota crédito',
  fecha, vence: '1800-01-01', referencia: null, importe,
});
const ap = (doc: string, tipo: string, pago: string, importe: string, fecha: string): AplicacionCruda => ({
  sucursal: '00', doc_tipo: '20', doc_sub: '1', doc_folio: doc, pago_tipo: tipo, pago_sub: '1', pago_folio: pago,
  pago_documento: tipo === '26' ? 'Transferencia a proveedor' : 'Nota crédito', pago_fecha: fecha, pago_referencia: null, importe,
});

describe('[ECA.1] tipo de acreedor', () => {
  it('la clave de Kepler decide mercancía y servicios', () => {
    expect(clasificarAcreedor('CM009', '004')).toBe('mercancia');   // Mondelez
    expect(clasificarAcreedor('GAR001', null)).toBe('servicios');   // ARRENDAMEX
  });

  it('PRUEBA NEGATIVA: un banco con comisiones es Servicios, no deuda, aunque esté en el grupo 120', () => {
    expect(clasificarAcreedor('GB004', '120')).toBe('servicios');   // BBVA: "IVA SER BANCA" $48
    expect(clasificarAcreedor('GB001', null)).toBe('servicios');    // Banorte (comisiones)
  });

  it('la deuda financiera: préstamos A*, factoraje, tarjetas, y el grupo 140 aunque la clave sea G*', () => {
    expect(clasificarAcreedor('AR001', null)).toBe('financiero');   // préstamo de persona
    expect(clasificarAcreedor('B.B.FAC', null)).toBe('financiero'); // factoraje Financiera Bajío
    expect(clasificarAcreedor('TC1852', null)).toBe('financiero');  // tarjeta BBVA Oro
    expect(clasificarAcreedor('GS012', '140')).toBe('financiero');  // STM Financial
  });

  it('las sucursales dadas de alta como proveedor son internas, y lo desconocido no se adivina', () => {
    expect(clasificarAcreedor('TI004', null)).toBe('interno');
    expect(clasificarAcreedor('DD001', null)).toBe('sin_clasificar');
    expect(clasificarAcreedor('', null)).toBe('sin_clasificar');
  });
});

describe('[ECA.1] nombre del grupo de Kepler', () => {
  it('los 11 códigos tienen nombre; uno nuevo se muestra como código, no se inventa', () => {
    expect(nombreGrupo('001')).toBe('Proveedores AMDIVED');
    expect(nombreGrupo('140')).toBe('Financiamiento vehicular');
    expect(nombreGrupo('999')).toBe('Grupo 999');
    expect(nombreGrupo(null)).toBeNull();
  });
});

describe('[ECA.1] estado del documento', () => {
  it('pendiente / parcial / pagado / sobreaplicado, con tolerancia de centavo', () => {
    expect(estadoDocumento(100, 0)).toBe('pendiente');
    expect(estadoDocumento(100, 40)).toBe('parcial');
    expect(estadoDocumento(100, 99.995)).toBe('pagado');
    expect(estadoDocumento(100, 101)).toBe('sobreaplicado');
  });
});

describe('[ECA.1] armado: el caso real de Mondelez cuadra con el reporte de Kepler', () => {
  const docs: DocCrudo[] = [
    A('0007199', '129191.53'),
    A('0007210', '512214.07', { referencia: '0-F-7453' }),
    A('0007211', '251924.43', { referencia: '0-F-5909' }),
    A('0007213', '533666.29', { referencia: '0-F-5906' }),
    D('26', '0016796', '641405.60', '2026-08-11'),
  ];
  const apps: AplicacionCruda[] = [
    ap('0007199', '26', '0016796', '129191.53', '2026-08-11'),
    ap('0007210', '26', '0016796', '512214.07', '2026-08-11'),
    ap('0007211', '26', '0016281', '233924.43', '2026-08-04'),
    ap('0007211', '55', '0001153', '18000.00', '2026-08-04'),
    ap('0007213', '26', '0016183', '474110.29', '2026-08-03'),
    ap('0007213', '55', '0001149', '56542.00', '2026-08-03'),
    ap('0007213', '55', '0001150', '3014.00', '2026-08-03'),
  ];
  const r = armarEstado(docs, apps, '2026-10-07');

  it('cada documento sale con sus pagos casados y saldo cero', () => {
    const d7213 = r.documentos.find((d) => d.folio === '0007213')!;
    expect(d7213.aplicaciones.map((a) => `${a.tipo_doc}-${a.folio}:${a.importe}`)).toEqual([
      '26-0016183:474110.29', '55-0001149:56542', '55-0001150:3014',
    ]);
    expect(d7213.saldo).toBe(0);
    expect(d7213.estado).toBe('pagado');
    expect(r.documentos.every((d) => d.saldo === 0 && !d.vencido)).toBe(true);
  });

  it('una transferencia repartida entre dos facturas no deja remanente', () => {
    expect(r.pagos_sin_aplicar).toEqual([]);
  });

  it('los totales cuadran: lo aplicado es todo lo facturado', () => {
    const t = totalesEstado(r.documentos, r.pagos_sin_aplicar);
    expect(t.importe).toBe(1426996.32);
    expect(t.aplicado).toBe(1426996.32);
    expect(t.pendiente).toBe(0);
    expect(t.saldo).toBe(0);
  });
});

describe('[ECA.1] saldo, vencimiento y pagos sin aplicar', () => {
  it('una factura sin pago con vencimiento pasado está vencida; sin vencimiento NO (prueba negativa)', () => {
    const r = armarEstado([
      A('0000001', '1000', { vence: '2026-09-01' }),
      A('0000002', '500', { vence: '1800-01-01' }),
    ], [], '2026-10-07');
    const [d1, d2] = r.documentos;
    expect(d1.vencido).toBe(true);
    expect(d2.vence).toBeNull();
    expect(d2.vencido).toBe(false);
  });

  it('un pago sin aplicar es saldo a favor y resta del saldo; un sobreaplicado también', () => {
    const r = armarEstado([
      A('0000001', '1000', { vence: '2026-12-01' }),
      A('0000002', '200', { vence: '2026-12-01' }),
      D('26', '0000009', '300', '2026-10-01'),
      D('26', '0000010', '250', '2026-10-02'),
    ], [ap('0000002', '26', '0000010', '250', '2026-10-02')], '2026-10-07');
    expect(r.pagos_sin_aplicar.map((p) => [p.folio, p.remanente])).toEqual([['0000009', 300]]);
    expect(r.documentos.find((d) => d.folio === '0000002')!.estado).toBe('sobreaplicado');
    const t = totalesEstado(r.documentos, r.pagos_sin_aplicar);
    expect(t.pendiente).toBe(1000);       // el sobreaplicado no es "pendiente"…
    expect(t.saldo).toBe(1000 - 50 - 300); // …pero sus $50 de más sí restan del saldo
  });
});
