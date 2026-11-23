import type { CierreKeplerPago } from '@megadulces/contracts';
import { SQL_SALIDA_QUE_LO_PAGO, motivoAunqueSalioValido, motivoParaNoCambiar } from './salio-antes-de-cambiar';

/**
 * `[PGP.199]` Un pago cuyo dinero ya salió no se cancela, ni se marca fallido, ni se reprograma. El caso: CD031 (CEDIS),
 * pago del 9-nov cancelado con el dinero ya fuera; su factura volvió a «por pagar» y se pagó otra vez el 13-nov.
 */
const SALIDA = { fuente: 'el libro del banco', fecha: '2026-11-09', cuenta: 'STDR 2169', importe: 36331.77 };
const cierre = (o: Partial<CierreKeplerPago> = {}): CierreKeplerPago => ({
  estado: 'pagado', desfase_dias: 0, pagado: 36331.77,
  facturas: { pagada: 1, saldada_sin_dinero: 0, en_parte: 0, sin_pagar: 0, sin_medir: 0 },
  pagos: [{ sucursal: '00', doc_prefix: 'XD2601', folio: '0024281', tipo: 'transferencia', fecha: '2026-11-09', aplicado: 36331.77,
    cuenta: '2169', cuenta_nombre: 'SANTANDER 2169', comprobante_id: null, comprobante_estado: null }],
  ...o,
} as CierreKeplerPago);

describe('[PGP.199] ¿ya salió el dinero?', () => {
  it('el banco lo prueba: se niega y dice cuándo, de qué cuenta y cuánto', () => {
    const m = motivoParaNoCambiar('cancelar', SALIDA, null);
    expect(m).toMatch(/^No se puede cancelar: este pago ya salió del banco el 2026-11-09 \(STDR 2169, \$36,331\.77/);
    expect(motivoParaNoCambiar('reprogramar', SALIDA, null)).toMatch(/^No se puede reprogramar/);
    expect(motivoParaNoCambiar('marcar como fallido', SALIDA, null)).toMatch(/^No se puede marcar como fallido/);
  });

  it('Kepler lo prueba (todas sus facturas pagadas con dinero): se niega y nombra el documento', () => {
    expect(motivoParaNoCambiar('cancelar', null, cierre())).toBe('No se puede cancelar: Tesorería ya pagó todas sus facturas en Kepler (XD2601-0024281 del 2026-11-09). El pago se liga solo a ese documento.');
  });

  it('control: sin salida y con Kepler a medias, sin pagar, saldado sólo con notas o sin medir, se deja hacer', () => {
    expect(motivoParaNoCambiar('cancelar', null, null)).toBeNull();
    expect(motivoParaNoCambiar('cancelar', null, cierre({ estado: 'en_parte', facturas: { pagada: 1, saldada_sin_dinero: 0, en_parte: 0, sin_pagar: 1, sin_medir: 0 } }))).toBeNull();
    expect(motivoParaNoCambiar('cancelar', null, cierre({ estado: 'sin_pagar', pagos: [], pagado: 0, facturas: { pagada: 0, saldada_sin_dinero: 0, en_parte: 0, sin_pagar: 1, sin_medir: 0 } }))).toBeNull();
    expect(motivoParaNoCambiar('cancelar', null, cierre({ estado: 'saldado_sin_dinero', pagado: 0, facturas: { pagada: 0, saldada_sin_dinero: 1, en_parte: 0, sin_pagar: 0, sin_medir: 0 } }))).toBeNull();
    expect(motivoParaNoCambiar('cancelar', null, cierre({ facturas: { pagada: 1, saldada_sin_dinero: 0, en_parte: 0, sin_pagar: 0, sin_medir: 1 } }))).toBeNull();
  });

  it('seguir aunque salió exige decir por qué (10 letras o más)', () => {
    expect(motivoAunqueSalioValido(undefined)).toBe(false);
    expect(motivoAunqueSalioValido('   es otro ')).toBe(false);
    expect(motivoAunqueSalioValido('la salida del 9 es del pago de CD031 de otra factura')).toBe(true);
  });

  it('la consulta descarta lo devuelto y lo que ya prueba otro pago, y reconoce el pago partido', () => {
    expect(SQL_SALIDA_QUE_LO_PAGO).toMatch(/FROM finance\.bank_movements dv/);
    expect(SQL_SALIDA_QUE_LO_PAGO).toMatch(/FROM finance\.bank_statement_lines dv/);
    expect(SQL_SALIDA_QUE_LO_PAGO).toMatch(/o\.id <> p\.pago AND o\.status <> 'cancelled' AND o\.paid_bank_movement_id = b\.id/);
    expect(SQL_SALIDA_QUE_LO_PAGO).toMatch(/z\.n >= 2/);
    expect((SQL_SALIDA_QUE_LO_PAGO.match(/\?/g) ?? []).length).toBe(5);
  });
});
