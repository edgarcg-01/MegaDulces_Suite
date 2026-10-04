import {
  CandidatoLote, LecturaOcr, chequeoBanco, chequeoFecha, chequeoMonto, chequeoProveedor, clasificar,
  coincidencias, diasEntre, llavePago, normalizarProveedor, pagosRepetidos, textoMotivo,
} from './pagos-captura-lote';

/**
 * `[PC.3]`/`[PC.5]` — La regla que decide si un comprobante del lote viene pre-marcado («listo»):
 * sólo si coinciden EXACTAMENTE banco, fecha, monto y proveedor (pedido del usuario, 2026-10-03).
 */
const pago = (p: Partial<CandidatoLote> = {}): CandidatoLote => ({
  sucursal: '00', doc_prefix: 'XD2601', folio: '100', monto: 150621.5, pago_date: '2026-09-29T06:00:00.000Z',
  pago_dia: '2026-09-29', proveedor_nombre: 'CONVERMEX SA DE CV', deposits: 0, clave_banco: '1463', account_label: '1463', ...p,
});
const OCR: LecturaOcr = { monto: 150621.5, fecha: '2026-09-29', cuenta_origen: '002496700783014636', beneficiario: 'CONVERMEX S.A. DE C.V.' };

describe('[PC.5] las cuatro comparaciones', () => {
  it('monto: al centavo, sin pelear con el punto flotante', () => {
    expect(chequeoMonto(0.1 + 0.2, 0.3)).toBe('ok');
    expect(chequeoMonto(150621.5, 150621.49)).toBe('difiere');
    expect(chequeoMonto(null, 10)).toBe('sin_dato');
  });

  it('fecha: el mismo día; un día de diferencia ya difiere', () => {
    expect(chequeoFecha('2026-09-29', '2026-09-29T06:00:00.000Z')).toBe('ok');
    expect(chequeoFecha('2026-09-30', '2026-09-29')).toBe('difiere');
    expect(chequeoFecha(null, '2026-09-29')).toBe('sin_dato');
  });

  /** ⚠️ La CLABE termina en dígito verificador: `…01463` + `6`. */
  it('banco: reconoce la cuenta dentro de la CLABE pese al dígito verificador', () => {
    expect(chequeoBanco('002496700783014636', { clave_banco: '1463', account_label: '1463' })).toBe('ok');
  });
  it('banco: número de cuenta o enmascarado', () => {
    expect(chequeoBanco('****1463', { clave_banco: '1463' })).toBe('ok');
    expect(chequeoBanco('0123451463', { account_label: '1463' })).toBe('ok');
  });
  it('banco: otra cuenta propia → difiere', () => {
    expect(chequeoBanco('****4885', { clave_banco: '1463', account_label: '1463' })).toBe('difiere');
  });
  it('⛔ banco: sin cuenta leída, o sin banco en Kepler → sin_dato (nunca ok)', () => {
    expect(chequeoBanco(null, { clave_banco: '1463' })).toBe('sin_dato');
    expect(chequeoBanco('****1463', { clave_banco: null, account_label: null })).toBe('sin_dato');
  });

  it('proveedor: ignora puntuación, acentos y sufijo societario', () => {
    expect(normalizarProveedor('Convermex, S.A. de C.V.')).toBe('CONVERMEX');
    expect(chequeoProveedor('CONVERMEX S.A. DE C.V.', 'CONVERMEX SA DE CV')).toBe('ok');
    expect(chequeoProveedor('DULCERÍA ÁLAMO', 'DULCERIA ALAMO SA DE CV')).toBe('ok');
  });
  it('proveedor: el SPEI trunca el nombre → el truncado cuenta', () => {
    expect(chequeoProveedor('DISTRIBUIDORA DE DULCES Y CHOCOLA', 'DISTRIBUIDORA DE DULCES Y CHOCOLATES DEL BAJIO SA DE CV')).toBe('ok');
  });
  it('⛔ proveedor: nada de parecidos difusos, y un prefijo muy corto no basta', () => {
    expect(chequeoProveedor('DULCES LA ROSITA', 'DULCES DE LA ROSA SA')).toBe('difiere');
    expect(chequeoProveedor('ABC', 'ABC COMERCIAL')).toBe('difiere');
    expect(chequeoProveedor('', 'ABC')).toBe('sin_dato');
  });
});

describe('[PC.5] clasificar', () => {
  it('un pago libre con las cuatro exactas → listo', () => {
    const c = pago();
    expect(clasificar(OCR, [c])).toEqual({ confianza: 'listo', propuesto: c, motivo: 'cuatro_coinciden' });
    expect(coincidencias(OCR, c)).toEqual({ banco: 'ok', fecha: 'ok', monto: 'ok', proveedor: 'ok' });
  });

  it.each([
    ['banco', { cuenta_origen: '****4885' }],
    ['fecha', { fecha: '2026-09-30' }],
    ['proveedor', { beneficiario: 'OTRA EMPRESA SA' }],
  ])('⛔ falla sólo %s → revisar, nunca listo', (_, cambio) => {
    expect(clasificar({ ...OCR, ...cambio }, [pago()]).confianza).toBe('revisar');
  });

  it('⛔ monto con un centavo de diferencia → revisar (el servidor lo trae por su ±$1)', () => {
    expect(clasificar(OCR, [pago({ monto: 150621.49 })]).confianza).toBe('revisar');
  });

  it('⛔ lo que no se leyó no cuenta: sin cuenta de origen → revisar', () => {
    expect(clasificar({ ...OCR, cuenta_origen: null }, [pago()]).confianza).toBe('revisar');
  });

  /** El caso que antes era «elegir»: dos pagos del mismo monto, pero sólo uno salió de ese banco. */
  it('dos pagos del mismo monto y sólo uno con las cuatro → listo ese', () => {
    const otro = pago({ folio: '200', clave_banco: '4885', account_label: '4885' });
    const bueno = pago({ folio: '100' });
    expect(clasificar(OCR, [otro, bueno])).toEqual({ confianza: 'listo', propuesto: bueno, motivo: 'cuatro_coinciden' });
  });

  it('dos con las cuatro (gemelos) → elegir', () => {
    expect(clasificar(OCR, [pago({ folio: '1' }), pago({ folio: '2' })]).confianza).toBe('elegir');
  });

  it('ninguno perfecto pero uno coincide en más cosas → revisar con ése propuesto', () => {
    const tres = pago({ folio: '1', pago_dia: '2026-09-30' });
    const dos = pago({ folio: '2', pago_dia: '2026-09-30', clave_banco: '4885', account_label: '4885' });
    expect(clasificar(OCR, [dos, tres])).toEqual({ confianza: 'revisar', propuesto: tres, motivo: 'no_coincide_todo' });
  });

  it('ninguno perfecto y empatados → elegir', () => {
    expect(clasificar(OCR, [pago({ folio: '1', pago_dia: '2026-09-30' }), pago({ folio: '2', pago_dia: '2026-09-28' })]).confianza).toBe('elegir');
  });

  it('los pagos que ya tienen comprobante no compiten', () => {
    const libre = pago({ folio: '2' });
    const r = clasificar(OCR, [pago({ folio: '1', deposits: 1 }), libre]);
    expect(r.propuesto).toBe(libre);
    expect(r.confianza).toBe('listo');
  });

  /** ⛔ Un pago con comprobante nunca sale pre-marcado: puede ser el mismo papel dos veces. */
  it('⛔ el único candidato ya tiene comprobante → revisar, aunque coincidan las cuatro', () => {
    const c = pago({ deposits: 1 });
    expect(clasificar(OCR, [c])).toEqual({ confianza: 'revisar', propuesto: c, motivo: 'ya_tiene_comprobante' });
  });

  it('sin candidatos → sin_pago', () => {
    expect(clasificar(OCR, [])).toEqual({ confianza: 'sin_pago', propuesto: null, motivo: 'sin_candidatos' });
  });

  it.each([null, undefined, 0, -5, Number.NaN])('monto %p → sin_pago por sin_monto', (monto) => {
    expect(clasificar({ ...OCR, monto: monto as number | null }, [pago()]))
      .toEqual({ confianza: 'sin_pago', propuesto: null, motivo: 'sin_monto' });
  });

  it('usa pago_dia (texto) antes que pago_date (Date serializado en UTC)', () => {
    // pago_date de pg puede llegar corrido; pago_dia manda.
    expect(chequeoFecha(OCR.fecha, pago({ pago_dia: '2026-09-29', pago_date: '2026-09-28T06:00:00.000Z' }).pago_dia)).toBe('ok');
    expect(clasificar(OCR, [pago({ pago_dia: '2026-09-29', pago_date: '2026-09-28T06:00:00.000Z' })]).confianza).toBe('listo');
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
    for (const m of ['cuatro_coinciden', 'no_coincide_todo', 'ya_tiene_comprobante', 'varios_pagos', 'sin_monto', 'sin_candidatos'] as const) {
      expect(textoMotivo(m).length).toBeGreaterThan(5);
    }
  });
});
