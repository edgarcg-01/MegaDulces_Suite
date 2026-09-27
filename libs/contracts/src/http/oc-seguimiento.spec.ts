import {
  OC_NOTA_MAX, OC_SEGUIMIENTO_ESTATUS, OC_SEGUIMIENTO_LABEL, esEstatusSeguimiento, notaObligatoria, validarSeguimiento,
} from './oc-seguimiento.contract';

describe('[RA-PRO.62] seguimiento de orden de compra', () => {
  it('los cinco estatus pedidos por Compras, cada uno con su etiqueta', () => {
    expect([...OC_SEGUIMIENTO_ESTATUS]).toEqual(['vigente', 'detenida_pago', 'detenida_logistica', 'backorder', 'no_surtida_cancelada']);
    for (const e of OC_SEGUIMIENTO_ESTATUS) expect(OC_SEGUIMIENTO_LABEL[e]).toBeTruthy();
  });

  it('reconoce sólo los estatus de la lista', () => {
    expect(esEstatusSeguimiento('backorder')).toBe(true);
    expect(esEstatusSeguimiento('cancelada')).toBe(false);
    expect(esEstatusSeguimiento(null)).toBe(false);
  });

  it('la nota es obligatoria en todo lo que no sea Vigente', () => {
    expect(notaObligatoria('vigente')).toBe(false);
    for (const e of OC_SEGUIMIENTO_ESTATUS.filter((x) => x !== 'vigente')) expect(notaObligatoria(e)).toBe(true);
  });

  it('Vigente sin nota se acepta y la nota vacía queda en null', () => {
    expect(validarSeguimiento('vigente', '   ')).toEqual({ ok: true, estatus: 'vigente', nota: null });
  });

  it('⭐ NEGATIVA: detenida sin motivo se rechaza (también con espacios o una nota de 2 letras)', () => {
    expect(validarSeguimiento('detenida_pago', '').ok).toBe(false);
    expect(validarSeguimiento('detenida_pago', '    ').ok).toBe(false);
    expect(validarSeguimiento('backorder', 'ok').ok).toBe(false);
  });

  it('con motivo se acepta y la nota se recorta', () => {
    expect(validarSeguimiento('detenida_logistica', '  sin transporte hasta el lunes  '))
      .toEqual({ ok: true, estatus: 'detenida_logistica', nota: 'sin transporte hasta el lunes' });
  });

  it('rechaza estatus inválido y nota demasiado larga', () => {
    expect(validarSeguimiento('cancelada', 'x')).toEqual({ ok: false, error: 'Estatus de seguimiento no válido.' });
    expect(validarSeguimiento('no_surtida_cancelada', 'x'.repeat(OC_NOTA_MAX + 1)).ok).toBe(false);
  });
});
