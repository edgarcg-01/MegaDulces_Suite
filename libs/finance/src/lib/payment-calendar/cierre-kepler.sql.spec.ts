import { SQL_CIERRE_KEPLER, armarCierres, idsParaCierre, type FilaCierreKepler } from './cierre-kepler.sql';

const fila = (o: Partial<FilaCierreKepler> = {}): FilaCierreKepler => ({
  obligation_id: 'f1', importe: 1000, psuc: '00', p_tipo: 26, p_sub: 1, p_folio: '0017253', aplicado: 1000,
  fecha: '2026-11-03', cuenta: '2169', cuenta_nombre: 'SANTANDER 2169', comprobante_id: null, comprobante_estado: null, ...o,
});

describe('[PGP.94] la consulta del cierre', () => {
  it('descarta los pagos CANCELADOS con el cruce de [PGP.67] (proveedor + folio sin btrim)', () => {
    // Si alguien lo quita, un pago cancelado volvería a contarse como «pagado en Kepler».
    expect(SQL_CIERRE_KEPLER).toMatch(/NOT EXISTS[\s\S]*kepler_ods\.kdm1[\s\S]*m\.c43 = 'C'/);
    expect(SQL_CIERRE_KEPLER).toMatch(/m\.c10 = x\.c2/);
    expect(SQL_CIERRE_KEPLER).toMatch(/m\.c6 = x\.c6/);
  });
  it('usa la llave canónica de la factura, no una copia', () => {
    expect(SQL_CIERRE_KEPLER).toContain("md5('kepler_payable|'");
  });
  it('no ofrece un comprobante rechazado', () => {
    expect(SQL_CIERRE_KEPLER).toMatch(/s\.status <> 'rechazado'/);
  });
});

describe('[PGP.94] armado del cierre', () => {
  const pago = { id: 'p1', lotDate: '2026-11-03', alta: '2026-11-01' };

  it('sólo pregunta por facturas de Kepler, sin repetir', () => {
    expect(idsParaCierre([
      { allocation_id: 'p1', obligation_source: 'kepler_payable', obligation_id: 'f1' },
      { allocation_id: 'p2', obligation_source: 'kepler_payable', obligation_id: 'f1' },
      { allocation_id: 'p1', obligation_source: 'supplier_payable', obligation_id: 'x' },
    ])).toEqual(['f1']);
  });

  it('lo pendiente es importe − aplicado vigente (la misma cuenta que la vista)', () => {
    const m = armarCierres([pago], [{ allocation_id: 'p1', obligation_source: 'kepler_payable', obligation_id: 'f1' }],
      [fila({ aplicado: 600 }), fila({ p_folio: '0017300', aplicado: 400, fecha: '2026-11-04' })]);
    const c = m.get('p1')!;
    expect(c.estado).toBe('pagado');
    expect(c.pagos).toHaveLength(2);
    expect(c.desfase_dias).toBe(1);
  });

  it('una factura sin aplicaciones viene con columnas null y queda sin pagar', () => {
    const m = armarCierres([pago], [{ allocation_id: 'p1', obligation_source: 'kepler_payable', obligation_id: 'f1' }],
      [fila({ psuc: null, p_tipo: null, p_sub: null, p_folio: null, aplicado: null, fecha: null })]);
    expect(m.get('p1')!.estado).toBe('sin_pagar');
  });

  it('una factura que no vino de Kepler, o que la consulta no encontró, es sin_medir', () => {
    const m = armarCierres([pago], [
      { allocation_id: 'p1', obligation_source: 'supplier_payable', obligation_id: 'x' },
      { allocation_id: 'p1', obligation_source: 'kepler_payable', obligation_id: 'no-esta' },
    ], []);
    expect(m.get('p1')!.estado).toBe('sin_medir');
    expect(m.get('p1')!.facturas.sin_medir).toBe(2);
  });

  it('un pago sin facturas no inventa estado: sin_medir', () => {
    expect(armarCierres([pago], [], []).get('p1')!.estado).toBe('sin_medir');
  });
});
