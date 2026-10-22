import { ConflictException } from '@nestjs/common';
import { buscarLoteRepetido, mensajeLoteRepetido, renglonesDeCompra, VENTANA_LOTE_REPETIDO_MIN } from './lote-repetido';
import { CommercialReplenishmentService } from './commercial-replenishment.service';

/**
 * `[RA-UX.1b]` — el candado del lote repetido, en las dos mitades que NO son SQL.
 *
 * ⚠️ **Qué NO afirma este archivo:** que el SQL encuentre lo que debe. Un doble de Knex no ejecuta
 * SQL; eso lo prueba `database/tests/test-newdb-lote-repetido.js`, que corre ESTE MISMO módulo
 * contra la historia real (7 de 106 lotes, idénticos a un testigo independiente; placebo 0).
 * Acá se prueba la forma del payload, el mensaje y que el servicio FRENE, CONFIRME y FALLE
 * ABIERTO como dice.
 */

const U = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const compra = (qty: number, extra: Record<string, unknown> = {}) => ({
  warehouse_id: U(1), source_type: 'supplier',
  lines: [{ product_id: U(10), source_type: 'supplier', final_qty: qty, ...extra }],
});

describe('[RA-UX.1b] renglonesDeCompra — qué se compara', () => {
  it('el destino es el del renglón; si falta, el del encabezado (el mismo COALESCE del SQL)', () => {
    expect(renglonesDeCompra([compra(3)])).toEqual([{ product_id: U(10), destino: U(1), qty: 3 }]);
    expect(renglonesDeCompra([compra(3, { destination_warehouse_id: U(2) })])[0].destino).toBe(U(2));
  });
  it('NEGATIVA: traspasos, cantidades en cero e ids que no son UUID quedan fuera', () => {
    expect(renglonesDeCompra([{ ...compra(3), source_type: 'branch' }])).toEqual([]);
    expect(renglonesDeCompra([compra(0)])).toEqual([]);
    expect(renglonesDeCompra([compra(3, { product_id: 'no-uuid' })])).toEqual([]);
  });
});

describe('[RA-UX.1b] buscarLoteRepetido — cómo le habla a la base', () => {
  it('sin renglones de compra no consulta nada', async () => {
    const raw = vi.fn();
    expect(await buscarLoteRepetido({ raw }, { tenantId: U(9), userId: U(8), docs: [{ ...compra(3), source_type: 'branch' }] })).toBeNull();
    expect(raw).not.toHaveBeenCalled();
  });
  it('manda los bindings en el orden del SQL, con la ventana y el MISMO instante dos veces', async () => {
    const raw = vi.fn().mockResolvedValue({ rows: [{ renglones: 0 }] });
    const ahora = new Date('2026-10-21T20:33:00Z');
    await buscarLoteRepetido({ raw }, { tenantId: U(9), userId: U(8), docs: [compra(3)], ahora });
    const b = raw.mock.calls[0][1];
    expect(JSON.parse(b[0])).toEqual([{ product_id: U(10), destino: U(1), qty: 3 }]);
    expect(b.slice(1)).toEqual([U(9), U(8), ahora.toISOString(), VENTANA_LOTE_REPETIDO_MIN, ahora.toISOString()]);
  });
  it('arma el hallazgo: cuántos de cuántos, qué lotes y hace cuánto', async () => {
    const ahora = new Date('2026-10-21T20:33:00Z');
    const raw = vi.fn().mockResolvedValue({ rows: [{ renglones: 1, lotes: ['RQ-LOTE-2026-00103'], ultimo: '2026-10-21T20:32:00Z' }] });
    const r = await buscarLoteRepetido({ raw }, { tenantId: U(9), userId: U(8), docs: [compra(3)], ahora });
    expect(r).toEqual({ renglones: 1, de: 1, lotes: ['RQ-LOTE-2026-00103'], minutos: 1 });
    expect(mensajeLoteRepetido(r!)).toMatch(/hace 1 minuto.*RQ-LOTE-2026-00103.*No se creó nada/);
  });
});

/** El servicio sin su constructor: sólo lo que `createRequisitionBatch` toca. */
function servicio(raw: (...a: unknown[]) => unknown, userId: string | null = U(8)) {
  const s = Object.create(CommercialReplenishmentService.prototype) as CommercialReplenishmentService & Record<string, unknown>;
  const insert = vi.fn().mockResolvedValue({ id: U(77), folio: 'RQ-2026-99999' });
  const sp = { raw: vi.fn(raw) };
  const trx = { raw: vi.fn(), transaction: (cb: (x: unknown) => unknown) => Promise.resolve().then(() => cb(sp)) };
  Object.assign(s, {
    tenantCtx: { requireTenantId: () => U(9), get: () => ({ userId }) },
    tk: { run: (fn: (t: unknown) => unknown) => Promise.resolve().then(() => fn(trx)) },
    logger: { warn: vi.fn(), log: vi.fn() },
    loteColsListas: async () => false,
    insertRequisition: insert,
  });
  return { s, insert, sp };
}

describe('[RA-UX.1b] createRequisitionBatch — frena, confirma y falla abierto', () => {
  const repetido = () => ({ rows: [{ renglones: 1, lotes: ['RQ-LOTE-2026-00103'], ultimo: new Date().toISOString() }] });

  it('⛔ un lote repetido se FRENA con 409 LOTE_REPETIDO y no se inserta NADA', async () => {
    const { s, insert } = servicio(repetido);
    const e = await s.createRequisitionBatch({ requisitions: [compra(3)] as never }).catch((x) => x);
    expect(e).toBeInstanceOf(ConflictException);
    expect((e as ConflictException).getResponse()).toMatchObject({ code: 'LOTE_REPETIDO', repetido: { renglones: 1 } });
    expect(insert).not.toHaveBeenCalled();
  });

  it('con allow_duplicate la persona lo confirmó: ni se consulta, y se crea', async () => {
    const { s, insert, sp } = servicio(repetido);
    const r = await s.createRequisitionBatch({ requisitions: [compra(3)] as never, allow_duplicate: true });
    expect(sp.raw).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledTimes(1);
    expect(r.total).toBe(1);
  });

  it('un lote que no repite nada se crea como siempre', async () => {
    const { s, insert } = servicio(() => ({ rows: [{ renglones: 0 }] }));
    await s.createRequisitionBatch({ requisitions: [compra(3)] as never });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('⭐ si la consulta del candado FALLA, el lote se crea igual (falla abierto, y lo deja en el log)', async () => {
    const { s, insert } = servicio(() => { throw new Error('column "destination_warehouse_id" does not exist'); });
    await s.createRequisitionBatch({ requisitions: [compra(3)] as never });
    expect(insert).toHaveBeenCalledTimes(1);
    expect((s as unknown as { logger: { warn: ReturnType<typeof vi.fn> } }).logger.warn).toHaveBeenCalled();
  });

  it('sin autor (llamada de sistema) no hay «la misma persona»: no se consulta', async () => {
    const { s, sp, insert } = servicio(repetido, null);
    await s.createRequisitionBatch({ requisitions: [compra(3)] as never });
    expect(sp.raw).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
