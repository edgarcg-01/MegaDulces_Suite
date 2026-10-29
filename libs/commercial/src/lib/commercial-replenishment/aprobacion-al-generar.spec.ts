import { CommercialReplenishmentService } from './commercial-replenishment.service';

/**
 * `[PQ.27]` D1 (Edgar, 2026-10-29): quien tiene permiso de autorizar no pasa por una segunda
 * pantalla para aprobar lo que acaba de generar. Medido en 30 d: 61 % de las aprobaciones las hacía
 * quien creó la requisición y 93 % en lote.
 */
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function armar() {
  const svc = Object.create(CommercialReplenishmentService.prototype) as any;
  svc.logger = { log: vi.fn(), warn: vi.fn() };
  svc.tenantCtx = { requireTenantId: () => 't', get: () => ({ userId: null }) };
  // 1ª llamada: `loteColsListas`; 2ª: la transacción del lote, que ya devuelve lo creado.
  svc.tk = {
    run: vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce({ batch_id: 'b', batch_folio: 'RQ-LOTE-2026-00001', total: 2, compras: 2, traspasos: 0, folios: ['RQ-1', 'RQ-2'], ids: [A, B] })
      // 3ª: `[PQ.31]` cuántos traspasos aprobados no salen (escritura apagada en su origen).
      .mockResolvedValueOnce(1),
  };
  svc.bulkEstado = vi.fn(async (ids: string[]) => ({ pedidas: ids.length, hechas: 1, ok: [A], fallas: [{ id: B, motivo: 'costo movido 8 %' }] }));
  return svc;
}
const dto = { requisitions: [{ source_type: 'supplier', warehouse_id: 'w', lines: [{ product_id: 'p', final_qty: 2 }] }] };

describe('[PQ.27] D1 — aprobar al generar', () => {
  it('con el permiso, aprueba el lote recién creado y dice cuáles no pasaron, por FOLIO', async () => {
    const svc = armar();
    const r = await svc.createRequisitionBatch(dto, { autoAprobar: true });
    expect(svc.bulkEstado).toHaveBeenCalledWith([A, B], 'approve');
    expect(r.aprobacion).toEqual({ automatica: true, aprobadas: 1, traspasos_sin_escritura: 1, fallas: [{ folio: 'RQ-2', motivo: 'costo movido 8 %' }] });
    expect(r).not.toHaveProperty('ids');
  });

  it('NEGATIVA: sin el permiso, todo queda en la cola y no se aprueba nada', async () => {
    const svc = armar();
    const r = await svc.createRequisitionBatch(dto, {});
    expect(svc.bulkEstado).not.toHaveBeenCalled();
    expect(r.aprobacion).toEqual({ automatica: false, aprobadas: 0, fallas: [] });
  });

  it('NEGATIVA: el controlador decide por la CLAVE exacta, no por el god-mode', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const ctl = readFileSync(join(__dirname, 'commercial-replenishment.controller.ts'), 'utf8');
    expect(ctl).toMatch(/permissions\?\.\[Permission\.COMPRAS_REQUISICIONES_AUTORIZAR\] === true/);
  });
});
