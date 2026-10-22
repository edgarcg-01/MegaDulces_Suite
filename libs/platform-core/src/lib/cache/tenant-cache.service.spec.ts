import { TenantCacheService } from './tenant-cache.service';

/**
 * `[RA-UX.11c]` — el caché por tenant nunca deja colgado un request.
 *
 * Nace de un caso medido el 2026-10-22: una API levantada sin Redis dejó `/compras/pedido`
 * cargando para siempre, con una transacción abierta en la base mientras tanto. El cliente de
 * Redis no FALLABA: esperaba la conexión sin resolver nunca, y el `try/catch` de antes sólo
 * cubría el fallo.
 */

/** Un caché de mentira: cada operación hace lo que la prueba le diga. */
function cache(o: { get?: () => Promise<unknown>; set?: () => Promise<unknown>; del?: () => Promise<unknown> } = {}) {
  const nunca = () => new Promise<never>(() => undefined);
  return {
    get: vi.fn(o.get ?? (async () => undefined)),
    set: vi.fn(o.set ?? (async () => undefined)),
    del: vi.fn(o.del ?? nunca),
  };
}
const nunca = () => new Promise<never>(() => undefined);
const servicio = (c: ReturnType<typeof cache>) => new TenantCacheService(c as never, undefined);

describe('[RA-UX.11c] TenantCacheService.getOrSet', () => {
  it('⛔ Redis TRABADO en el get (nunca contesta): calcula igual, dentro del tope', async () => {
    const s = servicio(cache({ get: nunca }));
    const t0 = Date.now();
    const v = await s.getOrSet('k', 60_000, async () => 'fresco');
    const ms = Date.now() - t0;
    expect(v).toBe('fresco');
    expect(ms).toBeGreaterThanOrEqual(TenantCacheService.TOPE_MS - 20);
    expect(ms).toBeLessThan(TenantCacheService.TOPE_MS * 3);
  });

  it('⛔ Redis TRABADO en el set: devuelve el valor sin esperar a guardarlo', async () => {
    const s = servicio(cache({ set: nunca }));
    const t0 = Date.now();
    expect(await s.getOrSet('k', 60_000, async () => 42)).toBe(42);
    expect(Date.now() - t0).toBeLessThan(TenantCacheService.TOPE_MS * 3);
  });

  it('Redis que FALLA (rechaza): calcula igual, como antes', async () => {
    const s = servicio(cache({ get: async () => { throw new Error('ECONNREFUSED'); }, set: async () => { throw new Error('ECONNREFUSED'); } }));
    expect(await s.getOrSet('k', 60_000, async () => 'fresco')).toBe('fresco');
  });

  it('un acierto devuelve lo guardado y NO calcula', async () => {
    const c = cache({ get: async () => 'guardado' });
    const prod = vi.fn(async () => 'fresco');
    expect(await servicio(c).getOrSet('k', 60_000, prod)).toBe('guardado');
    expect(prod).not.toHaveBeenCalled();
  });

  it('un fallo de caché guarda lo calculado, con su TTL y la llave prefijada', async () => {
    const c = cache();
    await servicio(c).getOrSet('k', 60_000, async () => 'fresco');
    expect(c.set).toHaveBeenCalledWith('t:no-tenant:k', 'fresco', 60_000);
  });

  it('⭐ un rechazo que llega DESPUÉS del tope no queda como rechazo sin manejar', async () => {
    const sueltos: unknown[] = [];
    const h = (e: unknown) => sueltos.push(e);
    process.on('unhandledRejection', h);
    const s = servicio(cache({ get: () => new Promise((_r, rej) => setTimeout(() => rej(new Error('tarde')), TenantCacheService.TOPE_MS + 50)) }));
    expect(await s.getOrSet('k', 60_000, async () => 'fresco')).toBe('fresco');
    await new Promise((r) => setTimeout(r, 150));
    process.off('unhandledRejection', h);
    expect(sueltos).toHaveLength(0);
  });

  it('invalidate tampoco espera a un Redis trabado', async () => {
    const s = servicio(cache({ del: nunca }));
    const t0 = Date.now();
    await s.invalidate('k');
    expect(Date.now() - t0).toBeLessThan(TenantCacheService.TOPE_MS * 3);
  });
});
