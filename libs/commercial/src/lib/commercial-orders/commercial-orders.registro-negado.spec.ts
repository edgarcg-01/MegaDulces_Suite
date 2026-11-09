import { CommercialOrdersService } from './commercial-orders.service';
import { completarRegistro, marcarAlAgendar } from './order-stock-notices';

/**
 * `[DN.8]` (ADR-115) Lo que `place()` hace con el registro de lo negado: a QUIÉN registra (sólo la
 * preventa por ruta de la app del vendedor, con el filtro evaluado DESPUÉS de que `place` aplica la
 * fecha que trae la sincronización) y que el registro NUNCA tumba el agendado.
 *
 * Los dos pasos del registro (`marcarAlAgendar`, `completarRegistro`) se sustituyen por espías: su SQL
 * se prueba contra base real en `database/tests/test-newdb-dn-registro-negado.js` (un knex falso no
 * valida SQL). Aquí se prueba el cableado: cuándo se llaman, con qué, y qué pasa si fallan.
 */
vi.mock('./order-stock-notices', async (importOriginal) => {
  const real = await importOriginal<typeof import('./order-stock-notices')>();
  return { ...real, marcarAlAgendar: vi.fn(), completarRegistro: vi.fn() };
});

const ORDER = '44444444-4444-4444-8444-444444444444';
const PARTE = '77777777-7777-4777-8777-777777777777';
const BUILD = 'vendor@2026-11-07.dn11a';

interface Mundo {
  rol?: string;
  conClave?: string[];
  pedido?: Record<string, unknown>;
  partes?: string[];
}

function montar(m: Mundo = {}) {
  const pedido: Record<string, unknown> = {
    id: ORDER, code: 'PD-2026-00001', status: 'draft', warehouse_id: 'wh-1', customer_id: 'cli-1', user_id: 'u',
    delivery_type: 'route', requested_delivery_date: null, group_id: null, ...m.pedido,
  };
  const corridasDespues: string[] = [];
  const raw = async (sql: string, b: unknown[] = []) => {
    if (sql.includes('identity.role_permissions')) return { rows: (m.conClave ?? ['vendedor_ruta']).includes(String(b[0])) ? [{ '?column?': 1 }] : [] };
    return { rows: [] };
  };
  const tabla = () => {
    const q: Record<string, unknown> = {};
    for (const k of ['where', 'forUpdate', 'returning', 'whereNull']) q[k] = () => q;
    q['first'] = async () => ({ ...pedido });
    q['update'] = async () => 1;
    return q;
  };
  // Tipo explícito (no `any`): la transacción se refiere a sí misma y TS no infiere eso solo.
  interface TrxFalso {
    (nombre?: string): Record<string, unknown>;
    raw: typeof raw;
    transaction: (cb: (sp: unknown) => unknown) => Promise<unknown>;
  }
  const trx: TrxFalso = Object.assign(tabla, { raw, transaction: async (cb: (sp: unknown) => unknown) => cb(trx) });
  const tk = {
    run: (a: unknown, b?: unknown) => {
      if (typeof a === 'string') corridasDespues.push(a);
      return (typeof a === 'function' ? a : b as (t: unknown) => unknown)(trx);
    },
  };
  const tenantCtx = { get: () => ({ tenantId: 't', userId: 'u', roleName: m.rol ?? 'vendedor_ruta' }), requireTenantId: () => 't' };
  const svc = new CommercialOrdersService(tk as never, tenantCtx as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  const s = svc as unknown as Record<string, (...a: unknown[]) => unknown>;
  vi.spyOn(s, 'enforceOrderOwnership' as never).mockResolvedValue(undefined as never);
  // Como el real: si hay partes, el pedido que se separa pasa a ser su propia raíz (`group_id = id`).
  vi.spyOn(s, 'separarPorSucursal' as never).mockImplementation((async (_t: unknown, o: Record<string, unknown>) => {
    const partes = (m.partes ?? []).map((id) => ({ ...pedido, id, group_id: o['id'] }));
    if (partes.length) o['group_id'] = o['id'];
    return partes;
  }) as never);
  vi.spyOn(s, 'tomarEnCampo' as never).mockImplementation((async (_t: unknown, o: Record<string, unknown>) => ({ ...o, status: 'confirmed', total: 0 })) as never);
  return { svc, corridasDespues, trx };
}

/** Deja correr lo que `place()` dejó pendiente «después del commit». */
const drenar = () => new Promise((r) => setTimeout(r, 0));

const marcar = vi.mocked(marcarAlAgendar);
const completar = vi.mocked(completarRegistro);

beforeEach(() => {
  marcar.mockReset().mockResolvedValue({ root: ORDER, marcadas: 3 });
  completar.mockReset().mockResolvedValue({ completadas: 3, negadas: 1, sinDato: 0 });
});

describe('[DN.8] place() registra la preventa por ruta del vendedor', () => {
  it('⭐ el payload de la sincronización: la fecha llega en place (el borrador no la tenía) → se marca y se completa después', async () => {
    const { svc, corridasDespues, trx } = montar();
    const r = await svc.place(ORDER, { requested_delivery_date: '2030-01-02', client_build: BUILD });
    expect(r).toMatchObject({ status: 'confirmed' });
    expect(marcar).toHaveBeenCalledTimes(1);
    expect(marcar).toHaveBeenCalledWith(trx, [ORDER], { userId: 'u', clientBuild: BUILD, raizRespaldo: ORDER });
    await drenar();
    expect(corridasDespues).toEqual(['t']);
    expect(completar).toHaveBeenCalledWith(trx, ORDER);
  });

  it('pedido agrupado: se marcan el principal y sus partes, ya separadas', async () => {
    const { svc } = montar({ partes: [PARTE], pedido: { requested_delivery_date: '2030-01-02' } });
    await svc.place(ORDER, {});
    expect(marcar.mock.calls[0][1]).toEqual([ORDER, PARTE]);
  });

  it('⭐ una PARTE reabierta se reagenda con la raíz de su grupo ORIGINAL, aunque separar le cambie el grupo', async () => {
    const GRUPO = '99999999-9999-4999-8999-999999999999';
    const { svc } = montar({ partes: [PARTE], pedido: { requested_delivery_date: '2030-01-02', group_id: GRUPO } });
    await svc.place(ORDER, {});
    expect(marcar.mock.calls[0][2]).toMatchObject({ raizRespaldo: GRUPO });
    // Control: sin grupo, la raíz es el propio pedido.
    marcar.mockClear();
    const { svc: svc2 } = montar({ pedido: { requested_delivery_date: '2030-01-02' } });
    await svc2.place(ORDER, {});
    expect(marcar.mock.calls[0][2]).toMatchObject({ raizRespaldo: ORDER });
  });

  it('la versión de la app se sanea: basura → null (es un dato de medición, no texto libre)', async () => {
    const { svc } = montar({ pedido: { requested_delivery_date: '2030-01-02' } });
    await svc.place(ORDER, { client_build: 'vendor; DROP TABLE x' });
    expect(marcar.mock.calls[0][2]).toEqual({ userId: 'u', clientBuild: null, raizRespaldo: ORDER });
  });

  it.each([
    ['sin fecha de entrega (el asistente)', { pedido: {} }, {}],
    ['entrega a domicilio', { pedido: { delivery_type: 'home_delivery', requested_delivery_date: '2030-01-02' } }, {}],
    ['viaje largo', { pedido: { requested_delivery_date: '2030-01-02' } }, { delivery_type: 'long_trip' }],
    ['un rol sin la clave del vendedor', { rol: 'telemarketing', pedido: { requested_delivery_date: '2030-01-02' } }, {}],
    ['el portal (customer_b2b)', { rol: 'customer_b2b', conClave: ['customer_b2b'], pedido: { requested_delivery_date: '2030-01-02' } }, {}],
    // Con la clave en su rol: lo que lo deja fuera es isPlatformAdminRole, no que le falte la clave.
    ['un admin de plataforma (aunque su rol tuviera la clave)', { rol: 'superadmin', conClave: ['superadmin'], pedido: { requested_delivery_date: '2030-01-02' } }, {}],
    ['un admin (aunque su rol tuviera la clave)', { rol: 'admin', conClave: ['admin'], pedido: { requested_delivery_date: '2030-01-02' } }, {}],
  ] as Array<[string, Mundo, Record<string, unknown>]>)('negativa: %s → no se registra', async (_n, m, dto) => {
    const { svc, corridasDespues } = montar(m);
    const r = await svc.place(ORDER, dto as never);
    await drenar();
    expect(r).toMatchObject({ status: 'confirmed' });
    expect(marcar).not.toHaveBeenCalled();
    expect(corridasDespues).toEqual([]);
  });

  it('control: con fecha, por ruta y con la clave SÍ se registra (la negativa de arriba no es por otra cosa)', async () => {
    const { svc } = montar({ pedido: { requested_delivery_date: '2030-01-02' } });
    await svc.place(ORDER, {});
    expect(marcar).toHaveBeenCalledTimes(1);
  });

  it('un reintento sobre un pedido ya confirmado no vuelve a marcar ni a completar', async () => {
    const { svc, corridasDespues } = montar({ pedido: { status: 'confirmed', requested_delivery_date: '2030-01-02' } });
    await svc.place(ORDER, {});
    await drenar();
    expect(marcar).not.toHaveBeenCalled();
    expect(corridasDespues).toEqual([]);
  });

  it('sin renglones que marcar (sólo promociones) no se abre el paso 2', async () => {
    marcar.mockResolvedValue({ root: null, marcadas: 0 });
    const { svc, corridasDespues } = montar({ pedido: { requested_delivery_date: '2030-01-02' } });
    await svc.place(ORDER, {});
    await drenar();
    expect(corridasDespues).toEqual([]);
  });
});

describe('[DN.8] ⛔ el registro NUNCA tumba el agendado', () => {
  it('⭐ si el paso 1 falla, place() responde el pedido confirmado y no abre el paso 2', async () => {
    marcar.mockRejectedValue(new Error('relation "commercial.order_stock_notices" does not exist'));
    const { svc, corridasDespues } = montar({ pedido: { requested_delivery_date: '2030-01-02' } });
    const r = await svc.place(ORDER, {});
    await drenar();
    expect(r).toMatchObject({ status: 'confirmed' });
    expect(corridasDespues).toEqual([]);
  });

  it('⭐ si el paso 2 falla, place() ya respondió y el error no se escapa (queda para el barrido)', async () => {
    completar.mockRejectedValue(new Error('la existencia no se pudo leer'));
    const { svc } = montar({ pedido: { requested_delivery_date: '2030-01-02' } });
    const r = await svc.place(ORDER, {});
    await drenar();
    expect(r).toMatchObject({ status: 'confirmed' });
    expect(completar).toHaveBeenCalledTimes(1);
  });

  it('si el paso 2 truena de forma síncrona, tampoco se escapa', async () => {
    completar.mockImplementation(() => { throw new Error('síncrono'); });
    const { svc } = montar({ pedido: { requested_delivery_date: '2030-01-02' } });
    await expect(svc.place(ORDER, {})).resolves.toMatchObject({ status: 'confirmed' });
    await drenar();
  });
});
