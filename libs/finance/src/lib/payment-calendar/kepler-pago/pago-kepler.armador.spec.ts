import {
  armarPagoKepler, armarPagosKepler, conceptoDeFactura, escrituraDePagoEncendida, ivaProporcional, motivosParaNoEscribir,
  type FacturaAPagar, type PagoKeplerEntrada, type PagoSuite,
} from './pago-kepler.armador';

/**
 * `[PGP.71]` El armador del `X-D-26`. Los casos que importan son los negativos: cada uno es una
 * forma de escribir en el ERP un pago que se ve bien y significa otra cosa.
 */
const factura = (o: Partial<FacturaAPagar> = {}): FacturaAPagar => ({
  almacen: '00', tipo: 20, subtipo: 1, folio: '0009469', concepto: 'C-001',
  saldo: 1160, aplicado: 1160, iva: 160, ieps: 0, total: 1160, ...o,
});
const entrada = (o: Partial<PagoKeplerEntrada> = {}): PagoKeplerEntrada => ({
  sucursal: '00', fecha: '2026-11-05', hora: '10:30', referencia: 'PG-0001', importe: 1160,
  cuentaTesoreria: '4176', destino: 'BBVA · CLABE 012180001234567899',
  proveedor: { codigo: 'CA041', rfc: 'DAY060209FI2', nombre: 'DISTRIBUCIONES AYARI', domicilio: ['CAMINO 1', 'MEXICO', ''], dias: 30 },
  facturas: [factura()], ...o,
});

describe('[PGP.71] armarPagoKepler', () => {
  it('un pago de una factura: cabecera, CxP, aplicación y saldo', () => {
    const r = armarPagoKepler(entrada());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.kdm1).toMatchObject({ c10: 'CA041', c11: 'PG-0001', c12: 'C-001', c48: 'CEDIS', c16: 1160, c42: 1160, c45: '4176', c17: 30, c67: 'SUITE', c85: '012', c86: '' });
    expect(r.plan.kdxe).toMatchObject({ c11: 1160, c17: 1160, c20: 0, c22: '4176', c16: 'PG-0001', c18: 'C-001' });
    expect(r.plan.kdxf).toEqual([{ c1: '00', c2: 'CA041', c3: '2026-11-05', c4: 26, c5: 1, c7: 20, c8: 1, c9: '0009469', c10: 1160, c11: 1160 }]);
    expect(r.plan.saldos).toEqual([{ almacen: '00', acreedor: 'CA041', tipo: 20, subtipo: 1, folio: '0009469', menos: 1160 }]);
  });

  it('dos facturas: una aplicación por factura y el IVA proporcional a lo aplicado', () => {
    const r = armarPagoKepler(entrada({
      importe: 1580,
      facturas: [factura(), factura({ folio: '0009470', saldo: 1000, aplicado: 420, iva: 0, ieps: 80, total: 1080 })],
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.kdxf.map((f) => f['c10'])).toEqual([1160, 420]);
    // 1160 × 160/1160 = 160 de IVA; 420 × 80/1080 = 31.111… de IEPS
    expect(r.plan.kdm1).toMatchObject({ c81: 160, c84: 31.11 });
  });

  it('sin CLABE válida, el código de banco queda vacío: no se adivina', () => {
    const r = armarPagoKepler(entrada({ destino: 'BBVA cuenta 1234' }));
    expect(r.ok && r.plan.kdm1['c85']).toBe('');
  });

  it('sin días de crédito conocidos, c17 se queda como lo trae la plantilla', () => {
    const r = armarPagoKepler(entrada({ proveedor: { ...entrada().proveedor, dias: null } }));
    expect(r.ok && 'c17' in r.plan.kdm1).toBe(false);
  });

  // ── Lo que NO se escribe ─────────────────────────────────────────────────────────────────
  const rechaza = (e: PagoKeplerEntrada, texto: RegExp) => {
    const r = armarPagoKepler(e);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivos.join(' | ')).toMatch(texto);
  };

  it('rechaza aplicar más de lo que Kepler dice que se debe', () => {
    rechaza(entrada({ facturas: [factura({ saldo: 1000 })] }), /debe 1000\.00 en Kepler/);
  });
  it('rechaza un importe que no es la suma de lo aplicado', () => {
    rechaza(entrada({ importe: 1200 }), /no es la suma/);
  });
  it('rechaza facturas con conceptos distintos (Kepler pide uno)', () => {
    rechaza(entrada({ importe: 2320, facturas: [factura(), factura({ folio: '2', concepto: 'C-010' })] }), /conceptos distintos/);
  });
  it('rechaza el efectivo de Caja General (D1)', () => {
    rechaza(entrada({ cuentaTesoreria: '0011' }), /Caja General/);
  });
  it('rechaza un acreedor que no es proveedor de compra', () => {
    rechaza(entrada({ proveedor: { ...entrada().proveedor, codigo: 'GB001' } }), /no es un proveedor de compra/);
  });
  it('rechaza una factura de otro almacén que el servidor', () => {
    rechaza(entrada({ facturas: [factura({ almacen: '01' })] }), /almacén 01/);
  });
  it('rechaza un pago sin facturas o sin cuenta de tesorería', () => {
    rechaza(entrada({ facturas: [], importe: 0 }), /ninguna factura/);
    rechaza(entrada({ cuentaTesoreria: ' ' }), /cuenta de tesorería/);
  });
});

describe('[PGP.71] ivaProporcional', () => {
  it('una factura sin total no aporta (no divide entre cero)', () => {
    expect(ivaProporcional([{ aplicado: 100, iva: 16, ieps: 0, total: 0 }])).toEqual({ c81: 0, c82: 0, c84: 0 });
  });
  it('c82 va sin redondear y c81 a centavos', () => {
    const r = ivaProporcional([{ aplicado: 100, iva: 1, ieps: 0, total: 3 }]);
    expect(r.c81).toBe(33.33);
    expect(r.c82).toBeCloseTo(33.3333333, 6);
  });
});

describe('[PGP.71] E3.3 motivosParaNoEscribir', () => {
  const pago = (o: Partial<PagoSuite> = {}): PagoSuite => ({
    status: 'executed', payment_method: 'transferencia', origen_kind: 'bank', kepler_payment_folio: null,
    lot_status: 'released', items: [{ obligation_source: 'kepler_payable', branch_code: '00' }], validacion_estado: 'validado', ...o,
  });
  it('autorizado, pagado, por transferencia y sin ligar: se puede', () => {
    expect(motivosParaNoEscribir(pago())).toEqual([]);
  });
  it('⛔ un pago sin marcar pagado NO se escribe', () => {
    expect(motivosParaNoEscribir(pago({ status: 'pending' }))).toContain('El pago no está marcado como pagado');
  });
  // `[PGP.104]` F2: marcado pagado no basta; lo prueban el banco Y el comprobante.
  it('⛔ [PGP.104] sin validar con banco y comprobante NO se escribe, aunque esté marcado pagado', () => {
    for (const e of ['falta_comprobante', 'esperando_banco', 'discrepa', 'sin_cuenta', null]) {
      expect(motivosParaNoEscribir(pago({ validacion_estado: e }))).toContain('El pago no está validado con el estado de cuenta y su comprobante');
    }
  });
  it('⛔ un día sin autorizar NO se escribe', () => {
    expect(motivosParaNoEscribir(pago({ lot_status: 'in_prep' }))).toContain('El día no está autorizado');
  });
  it('⛔ uno ya ligado a un X-D-26 no se vuelve a escribir (sería un pago doble)', () => {
    expect(motivosParaNoEscribir(pago({ kepler_payment_folio: '0023969' })).join(' ')).toMatch(/duplicaría/);
  });
  it('⛔ efectivo, factoraje, renglones que no son de Kepler, dos sucursales o factura saldada: no', () => {
    expect(motivosParaNoEscribir(pago({ payment_method: 'efectivo' })).length).toBeGreaterThan(0);
    expect(motivosParaNoEscribir(pago({ origen_kind: 'factoraje' })).length).toBeGreaterThan(0);
    expect(motivosParaNoEscribir(pago({ items: [{ obligation_source: 'budget_expense', branch_code: null }] })).length).toBeGreaterThan(0);
    expect(motivosParaNoEscribir(pago({ items: [{ obligation_source: 'kepler_payable', branch_code: '00' }, { obligation_source: 'kepler_payable', branch_code: '01' }] })).length).toBeGreaterThan(0);
    expect(motivosParaNoEscribir(pago({ items: [{ obligation_source: 'kepler_payable', branch_code: '00', kepler_saldada: true }] })).length).toBeGreaterThan(0);
  });
});

describe('[PGP.71] E3.5 el interruptor', () => {
  it('apagado por default, con la variable vacía o mal escrita', () => {
    expect(escrituraDePagoEncendida({})).toBe(false);
    expect(escrituraDePagoEncendida({ KEPLER_PAGO_ESCRITURA: '' })).toBe(false);
    expect(escrituraDePagoEncendida({ KEPLER_PAGO_ESCRITURA: 'true' })).toBe(false);
    expect(escrituraDePagoEncendida({ KEPLER_PAGO_ESCRITURA: 'encendido' })).toBe(false);
  });
  it('encendido sólo con la palabra exacta', () => {
    expect(escrituraDePagoEncendida({ KEPLER_PAGO_ESCRITURA: 'encendida' })).toBe(true);
  });
});

describe('[PGP.111] P7 y P8: un X-D-26 por concepto, y el gasto con 007', () => {
  it('⭐ P7: facturas de dos sucursales salen como DOS X-D-26, cada uno con el importe de las suyas', () => {
    const r = armarPagosKepler(entrada({ importe: 2320, facturas: [factura(), factura({ folio: '2', concepto: 'C-010' })] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.planes.map((p) => [p.concepto, p.importe, p.facturas.length])).toEqual([['C-001', 1160, 1], ['C-010', 1160, 1]]);
    expect(r.planes[1].plan.kdm1['c12']).toBe('C-010');
    expect(r.planes[1].plan.kdm1['c48']).toBe('MORELIA ABASTOS');
    expect(r.planes.every((p) => p.plan.kdm1['c11'] === entrada().referencia)).toBe(true);
  });
  it('con un solo concepto es exactamente armarPagoKepler', () => {
    const r = armarPagosKepler(entrada());
    const uno = armarPagoKepler(entrada());
    expect(r.ok && uno.ok && r.planes.length === 1 && JSON.stringify(r.planes[0].plan) === JSON.stringify(uno.plan)).toBe(true);
  });
  it('⛔ si una parte no se puede armar, no se arma ninguna (no se escribe medio pago)', () => {
    const r = armarPagosKepler(entrada({ importe: 2320, facturas: [factura(), factura({ folio: '2', concepto: 'C-010', saldo: 100 })] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivos.join(' ')).toMatch(/C-010: La factura 20-1-2 debe 100.00/);
  });
  it('⛔ el importe del pago tiene que ser la suma de lo aplicado, también partido', () => {
    expect(armarPagosKepler(entrada({ importe: 2000, facturas: [factura(), factura({ folio: '2', concepto: 'C-010' })] })).ok).toBe(false);
  });
  it('⭐ P8: la factura de gasto (10-1) sin concepto se paga con 007; una de compra sin concepto se sigue rechazando', () => {
    expect(conceptoDeFactura({ tipo: 10, concepto: '' })).toBe('007');
    expect(conceptoDeFactura({ tipo: 10, concepto: ' C-002 ' })).toBe('C-002');
    expect(conceptoDeFactura({ tipo: 20, concepto: '' })).toBe('');
    const r = armarPagoKepler(entrada({ facturas: [factura({ tipo: 10, concepto: '' })] }));
    expect(r.ok && r.plan.kdm1['c12']).toBe('007');
    const sin = armarPagoKepler(entrada({ facturas: [factura({ concepto: '' })] }));
    expect(sin.ok).toBe(false);
    if (!sin.ok) expect(sin.motivos.join(' ')).toMatch(/no trae concepto/);
  });
});
