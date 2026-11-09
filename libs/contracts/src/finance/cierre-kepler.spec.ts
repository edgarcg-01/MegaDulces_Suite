import {
  cierreCompleto, cierreDelPago, docPrefixKepler, estadoFacturaCierre, faltaParaCerrar, textoCierre, textoDesfase, tipoPagoKepler,
  type AplicacionKepler, type FacturaParaCierre,
} from './cierre-kepler.contract';

const app = (o: Partial<AplicacionKepler> = {}): AplicacionKepler => ({
  sucursal: '00', doc_tipo: 26, doc_sub: 1, folio: '0017253', fecha: '2026-11-03', aplicado: 1000,
  cuenta: '2169', cuenta_nombre: 'SANTANDER 2169', comprobante_id: null, comprobante_estado: null, ...o,
});

describe('[PGP.94] tipo y prefijo del documento de Kepler', () => {
  it('lee el catálogo kdmm medido', () => {
    expect(tipoPagoKepler(26, 1)).toBe('transferencia');
    expect(tipoPagoKepler('25', '1')).toBe('cheque');
    expect(tipoPagoKepler(20, 1)).toBe('efectivo');
    expect(tipoPagoKepler(20, 2)).toBe('banco');
    expect(tipoPagoKepler(55, 1)).toBe('nota_credito');
    expect(tipoPagoKepler(40, 1)).toBe('devolucion');
    expect(tipoPagoKepler(99, 1)).toBe('otro');
  });
  it('arma el prefijo como lo nombran el espejo y los comprobantes', () => {
    expect(docPrefixKepler(26, 1)).toBe('XD2601');
    expect(docPrefixKepler('5', '1')).toBe('XD0501');
  });
});

describe('[PGP.94] estado de una factura', () => {
  it('sin pendiente medido es sin_medir, nunca sin_pagar (ADR-056)', () => {
    expect(estadoFacturaCierre({ pendiente: null, aplicaciones: [] }, '2026-11-01')).toBe('sin_medir');
  });
  it('saldada con transferencia es pagada; con nota es saldada_sin_dinero', () => {
    expect(estadoFacturaCierre({ pendiente: 0, aplicaciones: [app()] }, '2026-11-01')).toBe('pagada');
    expect(estadoFacturaCierre({ pendiente: 0, aplicaciones: [app({ doc_tipo: 55 })] }, '2026-11-01')).toBe('saldada_sin_dinero');
  });
  it('saldo cero sin ninguna aplicación no se inventa: sin_medir', () => {
    expect(estadoFacturaCierre({ pendiente: 0, aplicaciones: [] }, '2026-11-01')).toBe('sin_medir');
  });
  it('viva con un abono de cuando ya estaba programada es en_parte; con uno viejo, sin_pagar', () => {
    expect(estadoFacturaCierre({ pendiente: 500, aplicaciones: [app({ fecha: '2026-11-02' })] }, '2026-11-01')).toBe('en_parte');
    expect(estadoFacturaCierre({ pendiente: 500, aplicaciones: [app({ fecha: '2026-08-02' })] }, '2026-11-01')).toBe('sin_pagar');
  });
  it('la holgura es de 3 días antes de programarla, no 4', () => {
    expect(estadoFacturaCierre({ pendiente: 500, aplicaciones: [app({ fecha: '2026-10-29' })] }, '2026-11-01')).toBe('en_parte');
    expect(estadoFacturaCierre({ pendiente: 500, aplicaciones: [app({ fecha: '2026-10-28' })] }, '2026-11-01')).toBe('sin_pagar');
  });
});

describe('[PGP.94] cierre de un pago', () => {
  const base = { lotDate: '2026-11-03', programadoDesde: '2026-11-01' };

  it('todas saldadas con dinero el mismo día: pagado, desfase 0, el documento con su banco', () => {
    const c = cierreDelPago({ ...base, facturas: [
      { pendiente: 0, aplicaciones: [app({ aplicado: 600 })] },
      { pendiente: 0, aplicaciones: [app({ aplicado: 400 })] },
    ] });
    expect(c.estado).toBe('pagado');
    expect(c.desfase_dias).toBe(0);
    expect(c.pagado).toBe(1000);
    // Las dos facturas las saldó UN documento: se suma, no se repite.
    expect(c.pagos).toHaveLength(1);
    expect(c.pagos[0]).toMatchObject({ doc_prefix: 'XD2601', folio: '0017253', aplicado: 1000, cuenta_nombre: 'SANTANDER 2169' });
    expect(cierreCompleto(c)).toBe(true);
    expect(textoCierre(c)).toBe('Pagado en Kepler el mismo día');
  });

  it('pagado un día después lo dice', () => {
    const c = cierreDelPago({ ...base, facturas: [{ pendiente: 0, aplicaciones: [app({ fecha: '2026-11-04' })] }] });
    expect(c.desfase_dias).toBe(1);
    expect(textoCierre(c)).toBe('Pagado en Kepler 1 día después');
  });

  it('ya estaba pagada antes de programarla: se explica con el documento que la cerró', () => {
    const c = cierreDelPago({ ...base, facturas: [{ pendiente: 0, aplicaciones: [app({ fecha: '2026-10-20', folio: '0016000' })] }] });
    expect(c.estado).toBe('pagado');
    expect(c.desfase_dias).toBe(-14);
    expect(c.pagos[0].folio).toBe('0016000');
  });

  it('una saldada y otra sin abono: en_parte, y no es completo', () => {
    const c = cierreDelPago({ ...base, facturas: [
      { pendiente: 0, aplicaciones: [app()] },
      { pendiente: 900, aplicaciones: [] },
    ] });
    expect(c.estado).toBe('en_parte');
    expect(cierreCompleto(c)).toBe(false);
    expect(textoCierre(c)).toBe('Pagado en parte: 1 saldada, 1 con saldo');
  });

  it('nada en Kepler desde que se programó: sin_pagar', () => {
    const c = cierreDelPago({ ...base, facturas: [{ pendiente: 900, aplicaciones: [app({ fecha: '2026-06-01' })] }] });
    expect(c.estado).toBe('sin_pagar');
    expect(c.pagos).toEqual([]);
    expect(c.desfase_dias).toBeNull();
  });

  it('sólo notas de crédito: saldado_sin_dinero y pagado 0', () => {
    const c = cierreDelPago({ ...base, facturas: [{ pendiente: 0, aplicaciones: [app({ doc_tipo: 55, aplicado: 300 })] }] });
    expect(c.estado).toBe('saldado_sin_dinero');
    expect(c.pagado).toBe(0);
    expect(c.desfase_dias).toBeNull();
  });

  it('una factura que no es de Kepler no lo vuelve completo y se declara', () => {
    const c = cierreDelPago({ ...base, facturas: [
      { pendiente: 0, aplicaciones: [app()] },
      { pendiente: null, aplicaciones: [] },
    ] });
    expect(c.estado).toBe('pagado');
    expect(c.facturas.sin_medir).toBe(1);
    expect(cierreCompleto(c)).toBe(false);
    expect(textoCierre(c)).toBe('Pagado en Kepler el mismo día (1 sin medir)');
  });

  it('ninguna medida: sin_medir', () => {
    expect(cierreDelPago({ ...base, facturas: [{ pendiente: null, aplicaciones: [] }] }).estado).toBe('sin_medir');
  });
});

describe('[PGP.94] desfase', () => {
  it('dice antes, después y el mismo día', () => {
    expect(textoDesfase(null)).toBeNull();
    expect(textoDesfase(0)).toBe('el mismo día');
    expect(textoDesfase(2)).toBe('2 días después');
    expect(textoDesfase(-1)).toBe('1 día antes');
  });
});

describe('[PGP.100] qué le falta a un pago para cerrarse', () => {
  const cierre = (facturas: FacturaParaCierre[]) => cierreDelPago({ lotDate: '2026-11-03', programadoDesde: '2026-11-01', facturas });
  it('Kepler no registra nada: falta aplicarlo en Kepler', () => {
    const f = faltaParaCerrar(cierre([{ pendiente: 1000, aplicaciones: [] }]))!;
    expect(f).toMatchObject({ kepler: true, comprobante: 0, texto: 'Falta aplicar el pago en Kepler' });
  });
  it('pagado en Kepler desde Matriz sin PDF: falta el comprobante', () => {
    const f = faltaParaCerrar(cierre([{ pendiente: 0, aplicaciones: [app()] }]))!;
    expect(f).toMatchObject({ kepler: false, comprobante: 1, texto: 'Falta el comprobante' });
  });
  it('pagado con PDF: cerrado (null)', () => {
    expect(faltaParaCerrar(cierre([{ pendiente: 0, aplicaciones: [app({ comprobante_id: 'x' })] }]))).toBeNull();
  });
  it('pago de sucursal sin PDF no es «falta comprobante»: hoy no se puede subir', () => {
    expect(faltaParaCerrar(cierre([{ pendiente: 0, aplicaciones: [app({ sucursal: '07' })] }]))).toBeNull();
  });
  it('saldada con nota de crédito no pide comprobante', () => {
    expect(faltaParaCerrar(cierre([{ pendiente: 0, aplicaciones: [app({ doc_tipo: 55 })] }]))).toBeNull();
  });
  it('en parte y sin PDF: dice las dos cosas', () => {
    const f = faltaParaCerrar(cierre([
      { pendiente: 0, aplicaciones: [app()] },
      { pendiente: 500, aplicaciones: [] },
    ]))!;
    expect(f.texto).toBe('Falta aplicar en Kepler el resto y el comprobante');
  });
  it('sin medir se declara, no se dibuja como cerrado (ADR-056)', () => {
    expect(faltaParaCerrar(null)!.sin_medir).toBe(true);
    expect(faltaParaCerrar(cierre([{ pendiente: null, aplicaciones: [] }]))!.sin_medir).toBe(true);
  });
});
