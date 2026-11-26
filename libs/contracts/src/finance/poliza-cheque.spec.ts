import { camposDelCheque } from './cheque-impreso';
import { fechaCortaDePoliza, polizaDelCheque, type DatosDePoliza, type DocumentoParaPoliza } from './poliza-cheque';

const doc = (o: Partial<DocumentoParaPoliza> = {}): DocumentoParaPoliza => ({
  folio: '12345', sucursal: '05', referencia: 'A-1234', uuid: null, vence: '2026-11-15',
  aplicado: 100_000, descuento: 0, descuentoRotulo: null, concepto: '12345', ...o,
});
const datos = (o: Partial<DatosDePoliza> = {}): DatosDePoliza => ({
  folio: '5407',
  campos: camposDelCheque({ fecha: '2026-11-20', beneficiario: 'Dulces del Bajío SA de CV', centavos: 10_744_693 }),
  centavos: 10_744_693,
  banco: 'BanBajío · Conecta · BB 4166',
  cuentaBanco: { cuenta: '1120000001', nombre: 'BANCO DEL BAJIO 4166' },
  clasificacion: 'Proveedor de mercancía',
  dia: '2026-11-20',
  acreedor: 'C0123',
  documentos: [doc(), doc({ folio: '12346', referencia: null, aplicado: '7446.93', uuid: '1A2B3C4D-0000-0000-0000-000000000000' })],
  hechoPor: 'Tesorería',
  ...o,
});

describe('[PGP.168.1] la póliza del cheque', () => {
  it('control: repite el cheque con las mismas cadenas que el cheque impreso', () => {
    const p = polizaDelCheque(datos());
    expect(p.cheque).toEqual({
      folio: '5407', fecha: '20 DE NOVIEMBRE DE 2026', beneficiario: 'DULCES DEL BAJÍO SA DE CV', importe: '**107,446.93**',
      letra: '(CIENTO SIETE MIL CUATROCIENTOS CUARENTA Y SEIS PESOS 93/100 M.N.)', banco: 'BanBajío · Conecta · BB 4166',
    });
    expect(p.recibi).toBe('Recibí el cheque No. 5407 por $107,446.93.');
  });

  it('cargo al beneficiario, cada documento como parcial, abono al banco con su cuenta de ContPAQi; sumas iguales', () => {
    const p = polizaDelCheque(datos());
    expect(p.renglones.map((r) => [r.cuenta, r.nombre, r.parcial, r.cargo, r.abono])).toEqual([
      ['', 'DULCES DEL BAJÍO SA DE CV (acreedor C0123)', '', '107,446.93', ''],
      ['', 'Suc 05 · folio 12345 · Ref. A-1234', '100,000.00', '', ''],
      ['', 'Suc 05 · folio 12346', '7,446.93', '', ''],
      ['1120000001', 'BANCO DEL BAJIO 4166', '', '', '107,446.93'],
    ]);
    expect(p.sumas).toEqual({ cargo: '107,446.93', abono: '107,446.93' });
  });

  it('la cuenta del beneficiario queda en blanco: la Suite no la tiene y no se adivina', () => {
    expect(polizaDelCheque(datos()).renglones[0].cuenta).toBe('');
  });

  it('cada documento dice su CFDI (o que no está ligado) y su vencimiento', () => {
    const [, a, b] = polizaDelCheque(datos()).renglones;
    expect(a.detalle).toBe('CFDI sin ligar · vence 15-nov-2026');
    expect(b.detalle).toBe('CFDI 1A2B3C4D-0000-0000-0000-000000000000 · vence 15-nov-2026');
  });

  it('el descuento al pagar se ve: la factura, el descuento con su motivo, y el parcial es lo que sale del banco', () => {
    const p = polizaDelCheque(datos({
      centavos: 9_700_000,
      campos: camposDelCheque({ fecha: '2026-11-20', beneficiario: 'X SA', centavos: 9_700_000 }),
      documentos: [doc({ aplicado: '97000.00', descuento: '3000.00', descuentoRotulo: 'Pronto pago 3 %' })],
    }));
    expect(p.renglones[1].parcial).toBe('97,000.00');
    expect(p.renglones[1].detalle).toContain('factura 100,000.00 − Pronto pago 3 % 3,000.00');
  });

  it('un gasto (sin factura de Kepler) se nombra por su concepto y no dice «CFDI sin ligar»', () => {
    const p = polizaDelCheque(datos({
      centavos: 248_240,
      campos: camposDelCheque({ fecha: '2026-11-26', beneficiario: 'Proveedor SA', centavos: 248_240 }),
      documentos: [doc({ folio: null, sucursal: null, referencia: null, vence: null, concepto: 'Mantenimiento de montacargas', aplicado: '2482.40' })],
      acreedor: null,
      cuentaBanco: null,
      banco: 'Santander · PYME · STDR 2169',
    }));
    expect(p.renglones[1]).toMatchObject({ nombre: 'Mantenimiento de montacargas', detalle: null, parcial: '2,482.40' });
    expect(p.renglones[0].nombre).toBe('PROVEEDOR SA');
    // Sin cuenta contable del banco, el renglón del abono se nombra con el banco y la cuenta queda en blanco.
    expect(p.renglones[2]).toMatchObject({ cuenta: '', nombre: 'Santander · PYME · STDR 2169', abono: '2,482.40' });
  });

  it('el concepto dice qué se paga, cuántos documentos y de qué día del Calendario', () => {
    expect(polizaDelCheque(datos()).concepto).toBe('Proveedor de mercancía · 2 documentos · Calendario de pagos del 20-nov-2026');
  });

  it('prueba negativa: si los documentos no suman el cheque al centavo, no hay póliza', () => {
    expect(() => polizaDelCheque(datos({ documentos: [doc(), doc({ aplicado: '7446.94' })] }))).toThrow(/no cuadra con el cheque/);
    expect(() => polizaDelCheque(datos({ documentos: [] }))).toThrow(/sin documentos/);
    expect(() => polizaDelCheque(datos({ documentos: [doc({ aplicado: '107446.925' })] }))).toThrow(/más de dos decimales/);
  });

  it('la fecha corta se lee del texto, sin pasar por un Date', () => {
    expect(fechaCortaDePoliza('2026-01-01')).toBe('1-ene-2026');
    expect(fechaCortaDePoliza('2026-13-01')).toBeNull();
    expect(fechaCortaDePoliza(null)).toBeNull();
  });
});
