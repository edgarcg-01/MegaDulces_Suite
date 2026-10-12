import type { PagoViaje } from '@megadulces/contracts';
import { conceptoDelVale, corteAPagar, corteDe, esFecha, htmlHojaDeViajes, resumenPorPersona } from './trip-pay.logic';

/**
 * `[EMB.29]` El corte catorcenal y el resumen por persona (ADR-091). Las fechas de pago se
 * contrastaron con lo que Kepler ejerció de verdad: gastos 075/128 por persona en viernes
 * 17-jul, 31-jul, 14-ago, 28-ago, 11-sep y 25-sep de 2026.
 */

const item = (o: Partial<PagoViaje>): PagoViaje => ({
  source: 'guia', source_id: 'g1', shipment_id: 's1', shipment_folio: 'EMB-2026-00001', kepler_sucursal: '01',
  kepler_guia: '0001644', shipment_date: '2026-10-06', guide_number: 'GUIA-2026-00001', driver_id: 'd1',
  persona: 'PERSONA PRUEBA UNO', rol: 'chofer', concept: 'comision', amount: 129, estado_viaje: 'cerrado',
  liberado: true, motivo: 'Viaje cerrado', en_vale: false, expense_proof_id: null, vale_status: null, vale_folio: null,
  ...o,
});

describe('corteDe — catorcena de jueves a miércoles, pago en viernes', () => {
  it('reproduce los días de pago que Kepler ejerció', () => {
    for (const [dentro, pago] of [
      ['2026-07-02', '2026-07-17'], ['2026-07-29', '2026-07-31'], ['2026-08-12', '2026-08-14'],
      ['2026-08-26', '2026-08-28'], ['2026-09-09', '2026-09-11'], ['2026-09-23', '2026-09-25'],
    ]) expect(corteDe(dentro).pago).toBe(pago);
  });

  it('el corte va de jueves a miércoles y contiene la fecha', () => {
    const c = corteDe('2026-10-06');
    expect(c).toEqual({ desde: '2026-09-24', hasta: '2026-10-07', pago: '2026-10-09' });
    expect(new Date(c.desde + 'T00:00:00Z').getUTCDay()).toBe(4);
    expect(new Date(c.hasta + 'T00:00:00Z').getUTCDay()).toBe(3);
    expect(new Date(c.pago + 'T00:00:00Z').getUTCDay()).toBe(5);
  });

  it('los bordes caen en su corte, no en el vecino', () => {
    expect(corteDe('2026-09-24').desde).toBe('2026-09-24');
    expect(corteDe('2026-10-07').hasta).toBe('2026-10-07');
    expect(corteDe('2026-10-08').desde).toBe('2026-10-08');
  });

  it('el corte a pagar es el último que ya cerró', () => {
    expect(corteAPagar('2026-10-12')).toEqual({ desde: '2026-09-24', hasta: '2026-10-07', pago: '2026-10-09' });
    expect(corteAPagar('2026-10-08').desde).toBe('2026-09-24');
  });

  it('una fecha inválida no se convierte en un corte', () => {
    expect(() => corteDe('ayer')).toThrow();
    expect(esFecha('2026-13-40')).toBe(false);
    expect(esFecha('2026-10-07')).toBe(true);
  });
});

describe('resumenPorPersona', () => {
  it('separa lo que se puede pagar, lo retenido y lo que ya está en vale', () => {
    const r = resumenPorPersona([
      item({ concept: 'comision', amount: 129 }),
      item({ concept: 'viatico', amount: 200 }),
      item({ source_id: 'g2', concept: 'comision', amount: 103.2, liberado: false, estado_viaje: 'abierto' }),
      item({ source_id: 'g3', concept: 'comision', amount: 61.92, en_vale: true, expense_proof_id: 'v1' }),
      item({ source_id: 'g4', concept: 'comision', amount: 500, estado_viaje: 'cancelado', liberado: false }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].liberado).toEqual({ comision: 129, viatico: 200, maniobra_carga: 0 });
    expect(r[0].liberado_total).toBe(329);
    expect(r[0].viajes).toBe(1);
    expect(r[0].retenido_total).toBe(103.2);
    expect(r[0].retenidos).toBe(1);
    expect(r[0].en_vale_total).toBe(61.92);
    expect(r[0].vales).toEqual(['v1']);
  });

  it('un cargador cuenta cargas, no viajes', () => {
    const r = resumenPorPersona([
      item({ driver_id: 'c1', persona: 'CARGADOR PRUEBA', rol: 'cargador', source: 'carga', source_id: 'l1', concept: 'maniobra_carga', amount: 30, estado_viaje: 'cargado' }),
      item({ driver_id: 'c1', persona: 'CARGADOR PRUEBA', rol: 'cargador', source: 'carga', source_id: 'l2', concept: 'maniobra_carga', amount: 30, estado_viaje: 'cargado' }),
    ]);
    expect(r[0].cargas).toBe(2);
    expect(r[0].viajes).toBe(0);
    expect(r[0].liberado_total).toBe(60);
  });
});

describe('conceptoDelVale y la hoja', () => {
  const items = [item({ concept: 'comision', amount: 129 }), item({ concept: 'viatico', amount: 200 })];

  it('el concepto dice persona, corte, viajes y los conceptos de Kepler', () => {
    const c = conceptoDelVale('PERSONA PRUEBA UNO', { desde: '2026-09-24', hasta: '2026-10-07' }, items);
    expect(c).toContain('PERSONA PRUEBA UNO');
    expect(c).toContain('2026-09-24 a 2026-10-07');
    expect(c).toContain('1 viaje cerrado');
    expect(c).toContain('075');
    expect(c).toContain('128');
    expect(c).not.toContain('186');
  });

  it('la hoja escapa el HTML y suma el total', () => {
    const h = htmlHojaDeViajes('<script>', corteDe('2026-10-06'), items, 'Quien <prepara>', 'hoy');
    expect(h).not.toContain('<script>');
    expect(h).toContain('&lt;script&gt;');
    expect(h).toContain('$329.00');
  });
});
