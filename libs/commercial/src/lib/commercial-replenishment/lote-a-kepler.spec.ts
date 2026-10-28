import { CommercialReplenishmentService } from './commercial-replenishment.service';

/**
 * `[PQ.20]` Aprobar en lote sí sale a Kepler: después de contestar, una por una.
 * Medido el 2026-10-28: 222 aprobadas en 7 días sin un solo intento, porque KR.5 sacó el empuje
 * del lote y no dejó nada en su lugar.
 */
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function armar(conSink = true) {
  const svc = Object.create(CommercialReplenishmentService.prototype) as any;
  Object.defineProperty(svc, 'enLote', { value: new Set<string>() });
  svc.logger = { log: vi.fn(), warn: vi.fn() };
  svc.keplerSink = conSink ? {} : undefined;
  svc.approve = vi.fn(async (id: string) => ({ id, estado: 'approved' }));
  svc.reject = vi.fn(async (id: string) => ({ id, estado: 'cancelled' }));
  const orden: string[] = [];
  svc.pushKeplerTrasAprobar = vi.fn(async (id: string) => { orden.push(id); return { estado: 'entregada', folio: '1' }; });
  return { svc, orden };
}
const esperar = () => new Promise((r) => setTimeout(r, 0));

describe('[PQ.20] bulkEstado → Kepler', () => {
  it('aprueba sin empujar dentro de la petición y después empuja cada una, en orden', async () => {
    const { svc, orden } = armar();
    const r = await svc.bulkEstado([A, B], 'approve');
    expect(r.hechas).toBe(2);
    expect(svc.approve).toHaveBeenCalledWith(A, false);
    await esperar(); await esperar(); await esperar();
    expect(orden).toEqual([A, B]);
  });

  it('una que no salió no frena a las demás', async () => {
    const { svc, orden } = armar();
    svc.pushKeplerTrasAprobar = vi.fn(async (id: string) => { orden.push(id); return id === A ? { estado: 'no_salio', motivo: 'x' } : { estado: 'entregada' }; });
    await svc.bulkEstado([A, B], 'approve');
    await esperar(); await esperar(); await esperar();
    expect(orden).toEqual([A, B]);
  });

  it('NEGATIVA: rechazar en lote no empuja nada', async () => {
    const { svc, orden } = armar();
    await svc.bulkEstado([A, B], 'reject', 'no');
    await esperar();
    expect(orden).toEqual([]);
  });

  it('NEGATIVA: la que falló al aprobar no se empuja', async () => {
    const { svc, orden } = armar();
    svc.approve = vi.fn(async (id: string) => { if (id === A) throw new Error('costo movido'); return { id }; });
    await svc.bulkEstado([A, B], 'approve');
    await esperar(); await esperar();
    expect(orden).toEqual([B]);
  });

  it('NEGATIVA: sin sink ligado no intenta', async () => {
    const { svc, orden } = armar(false);
    await svc.bulkEstado([A], 'approve');
    await esperar();
    expect(orden).toEqual([]);
  });
});
