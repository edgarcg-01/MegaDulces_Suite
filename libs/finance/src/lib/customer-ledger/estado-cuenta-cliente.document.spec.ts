import 'reflect-metadata';
import { antiguedad, EstadoCuentaClienteDocument, resolverDesde, type DetalleEC } from './estado-cuenta-cliente.document';
import { FinanceCustomerLedgerModule } from './finance-customer-ledger.module';
import { CustomerLedgerController } from './customer-ledger.controller';
import { CustomerLedgerService } from './customer-ledger.service';
import { CustomerDepositsService } from '../collection-deposits/customer-deposits.service';
import { qrSvg } from '../shared/qr-svg';

/**
 * `[CXC.40]` El estado de cuenta que se le entrega al cliente.
 *
 * Lo que se fija: la tabla cuadra AL CENTAVO con el saldo del cliente (lo que ninguna factura
 * explica va en su propio renglón, nunca escondido); las pagadas no salen; el RFC genérico del
 * SAT no se imprime como si fuera del cliente; nada interno (Kepler, kdue, kdm5) llega al
 * cliente; lo que viene de la base se escapa; y el proveedor está al alcance del módulo (que
 * compile no es que arranque — ver `finance-bank.module.arranque.spec.ts`).
 */

const P = (folio: string, over: Partial<DetalleEC['partidas'][number]> = {}) => ({
  doc_label: 'Venta crédito', folio_digital: folio, fecha: '2026-09-01', vencimiento: '2026-09-16',
  importe: 1000, saldo_documento: 1000, dias_vencido: 51, vencida: true, saldada: false, ...over,
});

const DET: DetalleEC = {
  hoy: '2026-11-06',
  cliente: { sucursal: '00', cliente_code: 'C1026', cliente_nombre: 'ANAHI ELIZABETH NAVEDA LOPEZ',
    rfc: 'XAXX010101000', vendedor: '01', vendedor_nombre: 'SERGIO FRANCISCO MENDOZA PEREZ',
    limite_credito: 80000, dias_credito: 15 },
  // 2,023.66 + 34,798.77 + 500 (por vencer) = 37,322.43 ; el cliente debe 37,422.43 → 100 sin factura
  saldo: 37422.43, vencido: 36822.43, saldo_a_favor: 0, sin_documento: 100,
  partidas: [
    P('00UD1301-0004714', { fecha: '2026-07-11', vencimiento: '2026-07-26', importe: 29686.44, saldo_documento: 2023.66, dias_vencido: 103 }),
    P('00UD1301-0005449', { fecha: '2026-07-21', importe: 34798.77, saldo_documento: 34798.77, dias_vencido: 93 }),
    P('00UD1301-0009999', { fecha: '2026-11-01', vencimiento: '2026-11-16', importe: 500, saldo_documento: 500, dias_vencido: null, vencida: false }),
    P('00UD1301-0001111', { importe: 7777.77, saldo_documento: 0, saldada: true, vencida: false }),
  ],
};
const EMISOR = { nombre: 'MEGA DULCES SA DE CV', rfc: 'MDU000000AAA' };
const doc = new EstadoCuentaClienteDocument(null as never, null as never, null as never);
const texto = (h: string) => h.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('[CXC.40] estado de cuenta del cliente', () => {
  const h = doc.html(DET, EMISOR);
  const t = texto(h);

  it('el total de la tabla es el saldo del cliente, y lo que no tiene factura va en su renglón', () => {
    expect(t).toContain('Saldo no asignado a una factura $100.00');
    expect(t).toMatch(/Total \$64,985\.21 \$27,662\.78 \$37,422\.43/);
    expect(t).toContain('Saldo total $37,422.43');
    // «Por vencer» = facturas al corriente (coincide con la antigüedad); el resto se declara.
    expect(t).toContain('Por vencer $500.00');
    expect(t).toContain('Incluye $100.00 no asignado a una factura');
  });

  it('cada peso, una explicación: vencido + por vencer + no asignado = saldo total', () => {
    const tarjeta = (l: string) => Number(t.match(new RegExp(`${l} \\$([\\d,]+\\.\\d\\d)`))![1].replace(/,/g, ''));
    expect(Math.round((tarjeta('Vencido') + tarjeta('Por vencer') + DET.sin_documento) * 100) / 100).toBe(DET.saldo);
  });

  it('NEGATIVA — el total no es un tfoot (Chromium lo repetiría al pie de cada página)', () => {
    expect(h).not.toContain('<tfoot');
    expect(t.match(/\bTotal\b/g)).toHaveLength(1);
  });

  it('la tabla de abiertas sólo trae abiertas, de la más vieja a la más nueva; la pagada va en su sección', () => {
    // `[CXC.47]` Antes la pagada no salía en el documento. Ahora sale, pero DESPUÉS de las abiertas, en «Facturas pagadas».
    const abiertasTxt = t.slice(t.indexOf('Detalle de facturas abiertas'), t.indexOf('Facturas pagadas'));
    expect(abiertasTxt).not.toContain('0001111');
    expect(t.slice(t.indexOf('Facturas pagadas'))).toContain('0001111');
    const i = (f: string) => t.indexOf(f);
    expect(i('0004714')).toBeLessThan(i('0005449'));
    expect(i('0005449')).toBeLessThan(i('0009999'));
    expect(t).toContain('Vencida · 103 días');
    expect(t).toContain('Al corriente');
  });

  it('NEGATIVA — el RFC genérico del SAT no se imprime como RFC del cliente', () => {
    expect(t).not.toContain('XAXX010101000');
    expect(texto(doc.html({ ...DET, cliente: { ...DET.cliente, rfc: 'NALA900101AB1' } }, EMISOR))).toContain('RFC NALA900101AB1');
  });

  it('NEGATIVA — nada interno llega al cliente', () => {
    for (const interno of ['Kepler', 'kdue', 'kdm5', 'ODS', 'compromiso']) expect(t).not.toMatch(new RegExp(interno, 'i'));
  });

  it('NEGATIVA — lo que viene de la base se escapa', () => {
    const malo = doc.html({ ...DET, cliente: { ...DET.cliente, cliente_nombre: '<script>x</script>' } }, EMISOR);
    expect(malo).not.toContain('<script>x</script>');
    expect(malo).toContain('&lt;script&gt;');
  });

  it('pagos sin factura (saldo menor que las facturas) se restan, con signo', () => {
    const t2 = texto(doc.html({ ...DET, saldo: 37222.43, sin_documento: -100 }, EMISOR));
    expect(t2).toContain('Pagos no asignados a una factura −$100.00');
  });

  it('sin facturas abiertas lo dice, no dibuja una tabla vacía', () => {
    const t3 = texto(doc.html({ ...DET, saldo: 0, vencido: 0, sin_documento: 0, partidas: [DET.partidas[3]] }, EMISOR));
    expect(t3).toContain('Sin facturas pendientes a la fecha de corte');
  });

  it('antigüedad por cortes de Cobranza, sin las pagadas', () => {
    expect(antiguedad(DET.partidas)).toEqual([
      { etiqueta: 'Por vencer', monto: 500 }, { etiqueta: '1 a 30 días', monto: 0 },
      { etiqueta: '31 a 60 días', monto: 0 }, { etiqueta: '61 a 90 días', monto: 0 },
      { etiqueta: 'Más de 90 días', monto: 36822.43 },
    ]);
  });

  it('arranque: el documento está al alcance del módulo y el controller lo pide', () => {
    const providers = Reflect.getMetadata('providers', FinanceCustomerLedgerModule) as unknown[];
    expect(providers).toContain(EstadoCuentaClienteDocument);
    expect(providers).toContain(CustomerLedgerService);
    // vitest transpila sin emitDecoratorMetadata: se fija la ARIDAD, no los tipos.
    expect(CustomerLedgerController.length).toBe(4);
    // `[CC.20]` La 4ª es el servicio del enlace de depósito (para el QR), @Optional: tiene que llegar por el import
    // del módulo de depósitos, o el PDF saldría siempre sin QR sin que nada lo diga.
    expect(EstadoCuentaClienteDocument.length).toBe(4);
    const imports = Reflect.getMetadata('imports', FinanceCustomerLedgerModule) as unknown[];
    const exportados = imports.flatMap((m) => (Reflect.getMetadata('exports', m as object) as unknown[]) || []);
    expect(exportados).toContain(CustomerDepositsService);
  });

  describe('[CXC.47] pagadas y no pagadas, a detalle, por periodo', () => {
    const APL = (folio: string, fecha: string, monto: number) => ({ label: 'Cobro CFDI', folio, fecha, monto });
    const D47: DetalleEC = {
      ...DET,
      partidas: [
        // abierta con un abono parcial: el abono sale debajo
        P('00UD1301-0004714', { fecha: '2026-07-11', importe: 29686.44, saldo_documento: 2023.66, dias_vencido: 103,
          aplicaciones: [APL('0000101', '2026-08-02', 27662.78)] }),
        P('00UD1301-0005449', { fecha: '2026-07-21', importe: 34798.77, saldo_documento: 34798.77, dias_vencido: 93 }),
        P('00UD1301-0009999', { fecha: '2026-11-01', vencimiento: '2026-11-16', importe: 500, saldo_documento: 500, dias_vencido: null, vencida: false }),
        // pagada DENTRO del periodo (facturada y pagada en él)
        P('00UD1301-0007001', { fecha: '2026-10-01', importe: 1200, saldo_documento: 0, saldada: true, vencida: false,
          pagada_el: '2026-10-10', aplicaciones: [APL('0000201', '2026-10-05', 700), APL('0000202', '2026-10-10', 500)] }),
        // facturada ANTES del periodo pero terminada de pagar dentro: entra
        P('00UD1301-0006001', { fecha: '2026-06-01', importe: 800, saldo_documento: 0, saldada: true, vencida: false,
          pagada_el: '2026-09-01', aplicaciones: [APL('0000150', '2026-09-01', 800)] }),
        // facturada y pagada ANTES del periodo: no entra
        P('00UD1301-0005001', { fecha: '2026-05-01', importe: 333.33, saldo_documento: 0, saldada: true, vencida: false,
          pagada_el: '2026-05-20', aplicaciones: [APL('0000099', '2026-05-20', 333.33)] }),
        // en cero (cancelada): nunca
        P('00UD1301-0005002', { fecha: '2026-10-02', importe: 0, saldo_documento: 0, saldada: true, vencida: false }),
      ],
    };
    const desde = resolverDesde(D47.hoy, undefined);
    const t47 = texto(doc.html(D47, EMISOR, '', null, desde));
    const pag = t47.slice(t47.indexOf('Facturas pagadas'));

    it('el periodo por defecto son 3 meses antes del corte, y se imprime', () => {
      expect(desde).toBe('2026-08-06');
      expect(t47).toContain('Periodo: del 06/08/2026 al 06/11/2026');
    });

    it('pagadas del periodo: las facturadas o terminadas de pagar en él; no las de antes ni las en cero', () => {
      expect(pag).toContain('0007001');
      expect(pag).toContain('0006001');
      expect(pag).not.toContain('0005001');
      expect(pag).not.toContain('0005002');
      expect(t47).toContain('Pagado en el periodo · 2 facturas $2,000.00');
      expect(t47).toContain('Pagadas en el periodo 2 por $2,000.00');
    });

    it('cada abono va debajo de su factura, con folio, fecha y monto (abiertas y pagadas)', () => {
      expect(pag).toMatch(/0007001 01\/10\/2026 10\/10\/2026 \$1,200\.00 ↳ Cobro CFDI 0000201 05\/10\/2026 −\$700\.00 ↳ Cobro CFDI 0000202 10\/10\/2026 −\$500\.00/);
      expect(t47).toMatch(/0004714[^↳]*↳ Cobro CFDI 0000101 02\/08\/2026 \$27,662\.78/);
    });

    it('«todo» trae toda la historia; las abiertas salen igual con cualquier periodo', () => {
      const tTodo = texto(doc.html(D47, EMISOR, '', null, resolverDesde(D47.hoy, 'todo')));
      expect(tTodo).toContain('0005001');
      expect(tTodo).toContain('toda la historia registrada');
      const tCorto = texto(doc.html(D47, EMISOR, '', null, '2026-11-01'));
      for (const f of ['0004714', '0005449', '0009999']) expect(tCorto).toContain(f);
      expect(tCorto).toContain('Sin facturas pagadas en este periodo');
    });

    it('NEGATIVA — un periodo mal escrito o posterior al corte se rechaza, no cae al default', () => {
      for (const malo of ['2026-13-01', '2026-02-30', 'ayer', '20/11/2026']) expect(() => resolverDesde('2026-11-20', malo)).toThrow(/date_from inválido/);
      expect(() => resolverDesde('2026-11-20', '2026-11-21')).toThrow(/posterior al corte/);
      expect(resolverDesde('2026-11-20', '2026-11-20')).toBe('2026-11-20');
    });

  });

  it('[CC.20] con enlace, el PDF imprime el QR para subir la ficha de depósito; sin enlace, no', () => {
    const con = doc.html(DET, EMISOR, '', qrSvg('https://suite.test/deposito/TOKEN', 118));
    expect(con).toContain('¿Ya depositó?');
    expect(con).toContain('<svg');
    const sin = doc.html(DET, EMISOR, '', null);
    expect(sin).not.toContain('¿Ya depositó?');
  });
});
