import { condicionDePlazo, plazoDeKepler } from './kepler-requisition-sink.adapter';

/**
 * `[PQ.146]` El plazo de la OC sale de la ficha del proveedor en Kepler (`kdxd.c16`), no de la
 * plantilla. Los casos son los valores reales medidos en `kepler_ods.kdxd` y `kdm1.c30` (2026-11-23).
 */
describe('[PQ.146] plazo de la OC = el de la ficha del proveedor en Kepler', () => {
  it('el texto de condiciones sigue la regla de Kepler', () => {
    expect(condicionDePlazo(0)).toBe('Pago de contado');
    expect(condicionDePlazo(21)).toBe('21 días fecha factura');
    expect(condicionDePlazo(8)).toBe('8 días fecha factura');
    expect(condicionDePlazo(90)).toBe('90 días fecha factura');
  });

  it('toma los días de la ficha tal como los da Postgres (numeric en texto)', () => {
    expect(plazoDeKepler('30')).toEqual({ ok: true, valor: { dias: '30', condicion: '30 días fecha factura' } });
    expect(plazoDeKepler('21.00')).toEqual({ ok: true, valor: { dias: '21', condicion: '21 días fecha factura' } });
    expect(plazoDeKepler('0')).toEqual({ ok: true, valor: { dias: '0', condicion: 'Pago de contado' } });
    expect(plazoDeKepler(15)).toEqual({ ok: true, valor: { dias: '15', condicion: '15 días fecha factura' } });
  });

  it('NEGATIVA: un plazo inválido se rechaza, nunca cae al de la plantilla', () => {
    for (const malo of ['-1', '', null, undefined, '7.5', 'abc']) {
      const r = plazoDeKepler(malo);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.motivo).toMatch(/no un número de días válido/);
    }
  });
});
