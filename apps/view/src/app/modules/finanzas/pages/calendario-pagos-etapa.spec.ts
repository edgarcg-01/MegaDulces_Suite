import { describe, expect, it } from 'vitest';
import type { CierreKeplerPago } from '@megadulces/contracts';
import { diasDeAtraso, etapaDelPago, etapaInicial, type EtapaPago, type PagoParaEtapa } from './calendario-pagos-etapa';

const cierre = (estado: CierreKeplerPago['estado'], sin_medir = 0): CierreKeplerPago =>
  ({ estado, desfase_dias: null, pagado: 0, facturas: { total: 1, pagada: estado === 'pagado' ? 1 : 0, en_parte: 0, sin_pagar: 0, sin_medir, saldada_sin_dinero: 0 }, pagos: [] } as unknown as CierreKeplerPago);

const HOY = '2026-11-10';
const base: PagoParaEtapa = {
  lot_date: '2026-11-03', status: 'pending', payment_method: null, bank_account_id: null, destination_account_text: null,
  authorized_at: null, autorizado: false, kepler_cierre: cierre('sin_pagar'),
};
const listo: PagoParaEtapa = { ...base, payment_method: 'transferencia', bank_account_id: 'b1', destination_account_text: 'BBVA · CLABE 032180000118359719' };

describe('[PGP.114] la etapa de cada pago', () => {
  it('sin método, sin origen o sin destino: por preparar', () => {
    expect(etapaDelPago(base, HOY)).toBe('preparar');
    expect(etapaDelPago({ ...listo, bank_account_id: null }, HOY)).toBe('preparar');
    expect(etapaDelPago({ ...listo, destination_account_text: '  ' }, HOY)).toBe('preparar');
    // Efectivo no lleva origen ni destino.
    expect(etapaDelPago({ ...base, payment_method: 'efectivo' }, HOY)).toBe('autorizar');
  });

  it('preparado y sin autorizar: por autorizar; autorizado: por pagar', () => {
    expect(etapaDelPago(listo, HOY)).toBe('autorizar');
    expect(etapaDelPago({ ...listo, autorizado: true, authorized_at: '2026-11-10T10:00:00Z' }, HOY)).toBe('pagar');
    // Respuesta vieja sin `autorizado`: se lee de `authorized_at`.
    expect(etapaDelPago({ ...listo, autorizado: undefined, authorized_at: '2026-11-10T10:00:00Z' }, HOY)).toBe('pagar');
    // `autorizado` también viene true si el día se autorizó completo (regla vieja).
    expect(etapaDelPago({ ...listo, autorizado: true, authorized_at: null }, HOY)).toBe('pagar');
  });

  it('⛔ pendiente que Kepler ya saldó: pagado (no «por preparar»), aunque no tenga método', () => {
    expect(etapaDelPago({ ...base, kepler_cierre: cierre('pagado') }, HOY)).toBe('pagado');
    // Hoy también: Tesorería lo pagó y lo capturó en el día.
    expect(etapaDelPago({ ...base, lot_date: HOY, kepler_cierre: cierre('pagado') }, HOY)).toBe('pagado');
    // Control: en un día por venir es «quítalo del día», no pagado — sigue su camino (y el renglón lo dice).
    expect(etapaDelPago({ ...base, lot_date: '2026-11-12', kepler_cierre: cierre('pagado') }, HOY)).toBe('preparar');
    // Respuesta vieja sin `lot_date`: el día que se está viendo.
    expect(etapaDelPago({ ...base, lot_date: undefined, kepler_cierre: cierre('pagado') }, HOY, '2026-11-01')).toBe('pagado');
    // Control: pagado sólo EN PARTE sigue su camino normal.
    expect(etapaDelPago({ ...base, kepler_cierre: cierre('en_parte') }, HOY)).toBe('preparar');
    // Control: una factura sin medir no deja dar el cierre por completo.
    expect(etapaDelPago({ ...base, kepler_cierre: cierre('pagado', 1) }, HOY)).toBe('preparar');
  });

  it('marcado pagado: por registrar en Kepler hasta que Kepler lo salda', () => {
    expect(etapaDelPago({ ...listo, status: 'executed', kepler_cierre: cierre('sin_pagar') }, HOY)).toBe('kepler');
    expect(etapaDelPago({ ...listo, status: 'executed', kepler_cierre: null }, HOY)).toBe('kepler');
    expect(etapaDelPago({ ...listo, status: 'executed', kepler_cierre: cierre('pagado') }, HOY)).toBe('pagado');
  });

  it('rebotado: rebotó', () => {
    expect(etapaDelPago({ ...listo, status: 'failed' }, HOY)).toBe('rebote');
  });
});

describe('[PGP.114] con qué etapa abre', () => {
  const c = (p: Partial<Record<EtapaPago, number>>): Record<EtapaPago, number> =>
    ({ preparar: 0, autorizar: 0, pagar: 0, kepler: 0, pagado: 0, rebote: 0, ...p });
  it('la primera del circuito con trabajo', () => {
    expect(etapaInicial(c({ preparar: 3, pagar: 1 }), false)).toBe('preparar');
    expect(etapaInicial(c({ pagar: 1, kepler: 2 }), false)).toBe('pagar');
    expect(etapaInicial(c({ pagado: 5 }), false)).toBe('preparar');
  });
  it('quien autoriza abre en «por autorizar» si hay', () => {
    expect(etapaInicial(c({ preparar: 3, autorizar: 1 }), true)).toBe('autorizar');
    expect(etapaInicial(c({ preparar: 3 }), true)).toBe('preparar');
  });
});

describe('[PGP.114] días de atraso', () => {
  it('cuenta días civiles', () => {
    expect(diasDeAtraso('2026-10-19', '2026-11-10')).toBe(22);
    expect(diasDeAtraso('2026-11-10', '2026-11-10')).toBe(0);
    expect(diasDeAtraso('2026-11-12', '2026-11-10')).toBe(-2);
    expect(diasDeAtraso(null, '2026-11-10')).toBe(0);
  });
});
