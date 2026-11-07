import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { antiguedad, EstadoCuentaClienteDocument, type DetalleEC } from './estado-cuenta-cliente.document';
import { FinanceCustomerLedgerModule } from './finance-customer-ledger.module';
import { CustomerLedgerController } from './customer-ledger.controller';
import { CustomerLedgerService } from './customer-ledger.service';

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

  it('sólo facturas abiertas, de la más vieja a la más nueva', () => {
    expect(t).not.toContain('0001111');
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
    expect(EstadoCuentaClienteDocument.length).toBe(3);
  });
});
