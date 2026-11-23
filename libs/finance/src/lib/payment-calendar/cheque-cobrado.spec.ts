import {
  decidirChequesCobrados, decidirPagosPorElBanco, numeroDeChequeCobrado, numeroDeChequeEmitido, type PagoPendiente, type SalidaBanco,
} from './pago-por-el-banco';

/**
 * `[PGP.166]` El cheque se da por cobrado cuando el banco trae su número. Formas de prod (2026-11-23): el cheque 5384
 * del Calendario por $211,742.35 se cobró el 18-nov en BanBajío 4166 por $211,742.34 (el centavo de `[PGP.165]`).
 */
const HOY = '2026-11-23';
const CH: PagoPendiente = { id: 'ch5384', dia: '2026-11-17', importe: 211742.35, metodo: 'cheque', referencia: '5384', cuenta_planeada: 'bajio4166' };
const cobro = (o: Partial<SalidaBanco> = {}): SalidaBanco => ({
  id: 'm5384', cuenta_id: 'bajio4166', fecha: '2026-11-18', importe: 211742.34,
  concepto: 'Doc. Pagado por Camara de Compensacion por (211,742.34) mxn numero de cheque | 5384 | Reci | 9488031735', ...o,
});

describe('[PGP.166] los números del cheque', () => {
  it('el emitido sale de la referencia del pago; el cobrado, del concepto del banco', () => {
    expect(numeroDeChequeEmitido('5384')).toBe('5384');
    expect(numeroDeChequeEmitido('Cheque 05384')).toBe('5384');
    expect(numeroDeChequeEmitido('12')).toBeNull();
    expect(numeroDeChequeEmitido(null)).toBeNull();
    expect(numeroDeChequeCobrado(cobro().concepto)).toBe('5384');
    expect(numeroDeChequeCobrado('Doc. Pagado por Camara de Compensacion por (7,120.32) mxn numero de cheque | 05395 | Recibo')).toBe('5395');
    expect(numeroDeChequeCobrado('PAGO CHEQUE EFECTIVO')).toBeNull();
    expect(numeroDeChequeCobrado('SPEI ENVIADO CITI MEXICO/0036039880 124 018112610087')).toBeNull();
  });
});

describe('[PGP.166] el cheque cobrado', () => {
  it('casa por número en su cuenta: pagado con el importe que cobró el banco (aunque difiera un centavo)', () => {
    const d = decidirPagosPorElBanco([CH], [cobro()], HOY).get('ch5384');
    expect(d).toEqual({ estado: 'probado', movimiento_id: 'm5384', cuenta_id: 'bajio4166', fecha: '2026-11-18', importe: 211742.34, cheque: '5384' });
  });

  it('control: con el número +1000, en otra cuenta o sin cobro, no se da por cobrado', () => {
    expect(decidirPagosPorElBanco([{ ...CH, referencia: '6384' }], [cobro()], HOY).get('ch5384')?.estado).toBe('sin_salida');
    expect(decidirPagosPorElBanco([{ ...CH, cuenta_planeada: 'santander2169' }], [cobro()], HOY).get('ch5384')?.estado).toBe('sin_salida');
    expect(decidirPagosPorElBanco([CH], [], HOY).get('ch5384')).toEqual({ estado: 'sin_salida', motivo: 'El cheque 5384 todavía no aparece cobrado en el banco' });
  });

  it('cobrado por otro importe (más de $1): no se decide y se dicen los dos importes', () => {
    const d = decidirPagosPorElBanco([CH], [cobro({ importe: 200000 })], HOY).get('ch5384');
    expect(d).toEqual({ estado: 'disputada', motivo: 'El cheque 5384 se cobró por $200000.00 y el pago es por $211742.35: no se da por pagado' });
  });

  it('dos pagos vivos con el mismo número de cheque: no se adivina', () => {
    const d = decidirChequesCobrados([CH, { ...CH, id: 'copia' }], [cobro()]);
    expect(d.get('ch5384')?.estado).toBe('disputada');
    expect(d.get('copia')?.estado).toBe('disputada');
  });

  it('el cobro que tomó el cheque ya no lo toma una transferencia del mismo importe', () => {
    const tr: PagoPendiente = { id: 'tr', dia: '2026-11-18', importe: 211742.34, metodo: null };
    const d = decidirPagosPorElBanco([CH, tr], [cobro()], HOY);
    expect(d.get('ch5384')?.estado).toBe('probado');
    expect(d.get('tr')?.estado).toBe('sin_salida');
  });

  it('un cheque sin número sigue fuera, como antes', () => {
    expect(decidirPagosPorElBanco([{ ...CH, referencia: null }], [cobro()], HOY).get('ch5384')?.estado).toBe('excluido');
  });
});
