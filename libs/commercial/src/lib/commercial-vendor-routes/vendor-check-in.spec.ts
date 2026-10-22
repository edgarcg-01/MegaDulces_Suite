import { CommercialVendorRoutesService } from './commercial-vendor-routes.service';

/**
 * `[MCP.3.7]` Abrir al cliente registra la llegada (`checkIn`). Lo que importa: abrirlo otra vez con
 * la visita de hoy abierta NO crea otra; la distancia al cliente sale del servidor; y un cliente sin
 * ubicación se la toma de esta llegada (flujo de siempre: `locate`).
 */
const CID = '44444444-4444-4444-4444-444444444444';

function armar(m: { open?: Record<string, unknown> | null; customer?: Record<string, unknown> }) {
  const inserts: unknown[] = [];
  const updates: unknown[] = [];
  const tabla = (nombre: string) => {
    const q: any = {};
    for (const k of ['where', 'whereNull', 'whereRaw', 'orderBy']) q[k] = () => q;
    q.first = async () => {
      if (nombre === 'commercial.customers') return m.customer ?? { id: CID, latitude: '19.4', longitude: '-99.1' };
      if (nombre === 'commercial.vendor_visits') return m.open ?? undefined;
      return undefined;
    };
    q.insert = (o: unknown) => { inserts.push(o); return { returning: async () => [{ id: 'nueva', ...(o as object) }] }; };
    q.update = (o: unknown) => { updates.push(o); return { returning: async () => [{ ...(m.open ?? {}), ...(o as object) }] }; };
    return q;
  };
  const trx: any = Object.assign(tabla, { raw: (s: string) => s, fn: { now: () => 'now()' } });
  const tk = { run: vi.fn(async (fn: (t: unknown) => unknown) => fn(trx)) };
  const ctx = { get: () => ({ tenantId: 't', userId: '11111111-1111-1111-1111-111111111111' }) };
  const svc = new CommercialVendorRoutesService(tk as any, ctx as any);
  const locate = vi.fn(async () => ({ location_set: true }));
  (svc as any).locate = locate;
  return { svc, inserts, updates, locate };
}

describe('checkIn — abrir al cliente registra la llegada', () => {
  it('⭐ sin visita abierta hoy: crea una, con la distancia al cliente calculada en el servidor', async () => {
    const { svc, inserts } = armar({});
    const r: any = await svc.checkIn({ customer_id: CID, latitude: 19.4001, longitude: -99.1 });
    expect(inserts).toHaveLength(1);
    expect(r.reused).toBe(false);
    expect(r.distance_m).toBe(11);
  });

  it('⭐ con la visita de hoy abierta: NO crea otra (es la misma llegada)', async () => {
    const { svc, inserts } = armar({ open: { id: 'v1', latitude: '19.4', longitude: '-99.1', ended_at: null } });
    const r: any = await svc.checkIn({ customer_id: CID, latitude: 19.4001, longitude: -99.1 });
    expect(inserts).toHaveLength(0);
    expect(r.id).toBe('v1');
    expect(r.reused).toBe(true);
  });

  it('la llegada abierta sin GPS se completa con el GPS nuevo; una con GPS no se pisa', async () => {
    const a = armar({ open: { id: 'v1', latitude: null, longitude: null } });
    await a.svc.checkIn({ customer_id: CID, latitude: 19.4001, longitude: -99.1 });
    expect(a.updates).toEqual([{ latitude: 19.4001, longitude: -99.1 }]);
    const b = armar({ open: { id: 'v1', latitude: '19.5', longitude: '-99.2' } });
    await b.svc.checkIn({ customer_id: CID, latitude: 19.4001, longitude: -99.1 });
    expect(b.updates).toEqual([]);
  });

  it('cliente sin ubicación: se le toma de esta llegada; la distancia queda sin medir (null, no 0)', async () => {
    const { svc, locate } = armar({ customer: { id: CID, latitude: null, longitude: null } });
    const r: any = await svc.checkIn({ customer_id: CID, latitude: 19.4001, longitude: -99.1 });
    expect(locate).toHaveBeenCalledTimes(1);
    expect(r.distance_m).toBeNull();
  });
});
