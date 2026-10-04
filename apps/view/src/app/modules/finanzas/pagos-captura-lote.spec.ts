import { CandidatoLote, clasificar, diasEntre, llavePago, pagosRepetidos, textoMotivo } from './pagos-captura-lote';

/**
 * `[PC.3]` — La regla que decide si un comprobante del lote viene pre-marcado («listo»),
 * pide un clic («revisar»), pide elegir, o no tiene pago.
 */
const pago = (p: Partial<CandidatoLote> = {}): CandidatoLote => ({
  sucursal: '00', doc_prefix: 'XD2601', folio: '100', pago_date: '2026-09-10', deposits: 0, ...p,
});
const OCR = { monto: 1500, fecha: '2026-09-10' };

describe('[PC.3] clasificar', () => {
  it('un pago libre + factura que coincide → listo', () => {
    const c = pago({ concepto_match: true, pago_date: '2026-08-01' });
    expect(clasificar(OCR, [c])).toEqual({ confianza: 'listo', propuesto: c, motivo: 'factura_coincide' });
  });

  it('un pago libre + fecha a ±3 días → listo', () => {
    const c = pago({ pago_date: '2026-09-13' });
    expect(clasificar(OCR, [c]).confianza).toBe('listo');
    expect(clasificar(OCR, [c]).motivo).toBe('fecha_cercana');
  });

  it('un pago libre a 4 días y sin factura → revisar (sólo el monto lo sostiene)', () => {
    const c = pago({ pago_date: '2026-09-14' });
    expect(clasificar(OCR, [c])).toEqual({ confianza: 'revisar', propuesto: c, motivo: 'solo_monto' });
  });

  it('sin fecha leída y sin factura → revisar, no listo', () => {
    expect(clasificar({ monto: 1500, fecha: null }, [pago()]).confianza).toBe('revisar');
  });

  /** ⛔ El caso que justifica el clic: dos pagos del mismo monto. */
  it('⛔ dos pagos libres del mismo monto → elegir, aunque uno tenga la fecha exacta', () => {
    const r = clasificar(OCR, [pago({ folio: '1' }), pago({ folio: '2', pago_date: '2026-09-12' })]);
    expect(r).toEqual({ confianza: 'elegir', propuesto: null, motivo: 'varios_pagos' });
  });

  it('varios libres pero la factura señala uno → revisar con ese propuesto, nunca listo', () => {
    const b = pago({ folio: '2', concepto_match: true });
    const r = clasificar(OCR, [pago({ folio: '1' }), b]);
    expect(r).toEqual({ confianza: 'revisar', propuesto: b, motivo: 'factura_coincide' });
  });

  it('los pagos que ya tienen comprobante no compiten con el libre', () => {
    const libre = pago({ folio: '2' });
    const r = clasificar(OCR, [pago({ folio: '1', deposits: 1 }), libre]);
    expect(r.propuesto).toBe(libre);
    expect(r.confianza).toBe('listo');
  });

  /** ⛔ Un pago con comprobante nunca sale pre-marcado: puede ser el mismo papel dos veces. */
  it('⛔ el único candidato ya tiene comprobante → revisar, aunque la factura coincida', () => {
    const c = pago({ deposits: 1, concepto_match: true });
    expect(clasificar(OCR, [c])).toEqual({ confianza: 'revisar', propuesto: c, motivo: 'ya_tiene_comprobante' });
  });

  it('todos con comprobante y varios → elegir', () => {
    expect(clasificar(OCR, [pago({ folio: '1', deposits: 1 }), pago({ folio: '2', deposits: 2 })]).confianza).toBe('elegir');
  });

  it('sin candidatos → sin_pago', () => {
    expect(clasificar(OCR, [])).toEqual({ confianza: 'sin_pago', propuesto: null, motivo: 'sin_candidatos' });
  });

  it.each([null, undefined, 0, -5, Number.NaN])('monto %p → sin_pago por sin_monto, sin mirar candidatos', (monto) => {
    expect(clasificar({ monto: monto as number | null, fecha: OCR.fecha }, [pago({ concepto_match: true })]))
      .toEqual({ confianza: 'sin_pago', propuesto: null, motivo: 'sin_monto' });
  });
});

describe('[PC.3] diasEntre', () => {
  it('ignora la hora y el orden', () => {
    expect(diasEntre('2026-09-10T23:00:00.000Z', '2026-09-13')).toBe(3);
    expect(diasEntre('2026-09-13', '2026-09-10')).toBe(3);
  });
  it('cruza fin de mes', () => { expect(diasEntre('2026-08-30', '2026-09-02')).toBe(3); });
  it('null si alguna no es fecha', () => {
    expect(diasEntre(null, '2026-09-10')).toBeNull();
    expect(diasEntre('10/09/2026', '2026-09-10')).toBeNull();
  });
});

describe('[PC.3] llavePago / pagosRepetidos', () => {
  it('el folio solo no basta: transferencia y cheque con el mismo folio son pagos distintos', () => {
    expect(llavePago(pago({ doc_prefix: 'XD2601' }))).not.toBe(llavePago(pago({ doc_prefix: 'XD2501' })));
  });
  it('detecta dos filas del lote apuntando al mismo pago e ignora las que no apuntan a nada', () => {
    expect([...pagosRepetidos(['a', 'b', 'a', null, null, 'c'])]).toEqual(['a']);
  });
});

describe('[PC.3] textoMotivo', () => {
  it('cada motivo tiene texto', () => {
    for (const m of ['factura_coincide', 'fecha_cercana', 'solo_monto', 'ya_tiene_comprobante', 'varios_pagos', 'sin_monto', 'sin_candidatos'] as const) {
      expect(textoMotivo(m).length).toBeGreaterThan(5);
    }
  });
});
