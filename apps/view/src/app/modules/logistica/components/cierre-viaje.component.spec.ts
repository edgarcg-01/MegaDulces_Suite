import type { PagoViaje } from '@megadulces/contracts';
import { agruparPorPersona } from './cierre-viaje.component';

/**
 * EMB.26 — «Lo que se libera por persona» en la pestaña Cierre y pago. Una fila por persona y
 * papel; si cualquier renglón está retenido la fila dice Retenido (con su motivo): un liberado
 * no puede tapar un retenido.
 */
const p = (o: Partial<PagoViaje>): PagoViaje => ({
  source: 'guia', source_id: 'g1', shipment_id: 's1', shipment_folio: 'EMB-1', kepler_sucursal: '01', kepler_guia: '0001',
  shipment_date: '2026-10-06', guide_number: 'GUIA-1', driver_id: 'd1', persona: 'CHOFER PRUEBA', rol: 'chofer',
  concept: 'comision', amount: 129, estado_viaje: 'cerrado', liberado: true, motivo: 'Viaje cerrado', en_vale: false,
  expense_proof_id: null, vale_status: null, vale_folio: null, ...o,
});

describe('agruparPorPersona', () => {
  it('suma comisión y viático de la misma persona en una fila', () => {
    const f = agruparPorPersona([p({ concept: 'comision', amount: 129 }), p({ concept: 'viatico', amount: 200 })]);
    expect(f).toHaveLength(1);
    expect(f[0].montos).toEqual({ comision: 129, viatico: 200, maniobra_carga: 0 });
    expect(f[0].total).toBe(329);
    expect(f[0].estado).toBe('liberado');
  });

  it('un renglón retenido manda sobre los liberados y trae su motivo', () => {
    const f = agruparPorPersona([
      p({ concept: 'comision' }),
      p({ concept: 'viatico', amount: 200, liberado: false, estado_viaje: 'abierto', motivo: 'Faltan paradas por cerrar' }),
    ]);
    expect(f[0].estado).toBe('retenido');
    expect(f[0].motivo).toBe('Faltan paradas por cerrar');
  });

  it('ordena chofer, ayudante, cargador y omite lo cancelado', () => {
    const f = agruparPorPersona([
      p({ driver_id: 'c', persona: 'CARGADOR PRUEBA', rol: 'cargador', concept: 'maniobra_carga', amount: 30, source: 'carga', estado_viaje: 'cargado' }),
      p({ driver_id: 'a', persona: 'AYUDANTE PRUEBA', rol: 'ayudante', amount: 91.2 }),
      p({ driver_id: 'd' }),
      p({ driver_id: 'x', persona: 'CANCELADO', estado_viaje: 'cancelado' }),
    ]);
    expect(f.map((x) => x.rol)).toEqual(['chofer', 'ayudante', 'cargador']);
  });

  it('lo que ya está en un vale se marca En vale', () => {
    expect(agruparPorPersona([p({ en_vale: true, expense_proof_id: 'v1' })])[0].estado).toBe('en_vale');
  });
});
