import 'reflect-metadata';
import { PgListenService } from '@megadulces/platform-core';
import { FinanceCustomerLedgerModule } from './finance-customer-ledger.module';
import { CANAL_CARTERA, ESPERA_CARTERA_MS, CarteraPorEventoService } from './cartera-por-evento.service';

/**
 * `[CXC.21]` — El que drena la cartera escucha `cartera_sucia`. **Que compile no es que arranque** (`[CB.53.1]`,
 * `#414`): el grafo del módulo se lee de sus decoradores (vitest no emite `design:paramtypes`). El SQL de
 * `analytics.drain_customer_receivables()` se prueba contra base real en
 * `database/tests/test-newdb-cartera-por-evento.js`; aquí, sólo el cableado.
 */
const meta = <T>(clave: string, objetivo: unknown): T[] =>
  (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];
function alcanceDe(modulo: unknown): Set<unknown> {
  const out = new Set<unknown>(meta<unknown>('providers', modulo));
  for (const imp of meta<unknown>('imports', modulo)) for (const exp of meta<unknown>('exports', imp)) out.add(exp);
  return out;
}

describe('[CXC.21] el grafo de FinanceCustomerLedgerModule cierra con el que drena', () => {
  it('el constructor toma 2 dependencias (si cambia, revisar el arranque)', () => {
    expect(CarteraPorEventoService.length).toBe(2);
  });
  it('el que drena está entre los providers (si no, nadie escucha)', () => {
    expect(meta<unknown>('providers', FinanceCustomerLedgerModule)).toContain(CarteraPorEventoService);
  });
  it('⛔ PgListenService está al alcance del módulo', () => {
    expect(alcanceDe(FinanceCustomerLedgerModule).has(PgListenService)).toBe(true);
  });
  it('PRUEBA NEGATIVA: sin proveerlo, PgListenService queda fuera', () => {
    class SinListen {}
    Reflect.defineMetadata('providers', [CarteraPorEventoService], SinListen);
    Reflect.defineMetadata('imports', [], SinListen);
    expect(alcanceDe(SinListen).has(PgListenService)).toBe(false);
  });
  it('no hay reloj: ningún método lleva metadata de @nestjs/schedule', () => {
    const relojes = Object.getOwnPropertyNames(CarteraPorEventoService.prototype).flatMap((k) => {
      const v = (CarteraPorEventoService.prototype as unknown as Record<string, unknown>)[k];
      return typeof v === 'function' ? Reflect.getMetadataKeys(v).map(String).filter((x) => /SCHEDULE/.test(x)) : [];
    });
    expect(relojes).toEqual([]);
  });
});

const conEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void> | void) => {
  const antes: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { antes[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { await fn(); } finally { for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const nuevoListen = () => {
  const oyentes: Record<string, () => void> = {};
  let alVolver: (() => void) | null = null;
  return {
    escuchar: vi.fn((canal: string, f: () => void) => { oyentes[canal] = f; return vi.fn(); }),
    alConectar: vi.fn((f: () => void) => { alVolver = f; return vi.fn(); }),
    avisa: (canal: string) => oyentes[canal]?.(),
    vuelve: () => alVolver?.(),
  };
};
const corrida = (o: Partial<Record<string, unknown>>) => ({ mode: 'llave', reason: 'cola', marks: 2, accounts: 1, inserted: 0, updated: 58, deleted: 0, ms: 30, ...o });
const nuevoKnex = (...respuestas: Array<Array<Record<string, unknown>>>) => {
  const raw = vi.fn(async (sql: string) => { void sql; return { rows: respuestas.length > 1 ? respuestas.shift() : respuestas[0] }; });
  return { raw };
};

describe('[CXC.21] quién escucha y cuándo drena', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('en un pod de api (no worker) no escucha ni drena', async () => {
    await conEnv({ WORKER: 'false', DISABLE_CARTERA_POR_EVENTO: undefined }, async () => {
      const l = nuevoListen(); const k = nuevoKnex([corrida({ mode: 'vacio' })]);
      const s = new CarteraPorEventoService(k as never, l as never);
      s.onModuleInit();
      await vi.advanceTimersByTimeAsync(ESPERA_CARTERA_MS * 2);
      expect(l.escuchar).not.toHaveBeenCalled();
      expect(k.raw).not.toHaveBeenCalled();
    });
  });

  it('apagado por variable de entorno, ni en el worker escucha', async () => {
    await conEnv({ WORKER: 'true', DISABLE_CARTERA_POR_EVENTO: 'true' }, async () => {
      const l = nuevoListen(); const k = nuevoKnex([corrida({ mode: 'vacio' })]);
      new CarteraPorEventoService(k as never, l as never).onModuleInit();
      await vi.advanceTimersByTimeAsync(ESPERA_CARTERA_MS * 2);
      expect(l.escuchar).not.toHaveBeenCalled();
      expect(k.raw).not.toHaveBeenCalled();
    });
  });

  it('en el worker escucha cartera_sucia, drena al arrancar y otra vez tras un aviso', async () => {
    await conEnv({ WORKER: 'true', DISABLE_CARTERA_POR_EVENTO: undefined }, async () => {
      const l = nuevoListen(); const k = nuevoKnex([corrida({ mode: 'completo', reason: 'primero_del_dia' })], [corrida({})]);
      const s = new CarteraPorEventoService(k as never, l as never);
      s.onModuleInit();
      expect(l.escuchar).toHaveBeenCalledWith(CANAL_CARTERA, expect.any(Function));
      await vi.advanceTimersByTimeAsync(ESPERA_CARTERA_MS + 10);
      expect(k.raw).toHaveBeenCalledTimes(1);
      expect(String(k.raw.mock.calls[0][0])).toContain('analytics.drain_customer_receivables()');
      l.avisa(CANAL_CARTERA);
      await vi.advanceTimersByTimeAsync(ESPERA_CARTERA_MS + 10);
      expect(k.raw).toHaveBeenCalledTimes(2);
      s.onModuleDestroy();
    });
  });

  it('sin la migración (42883) dice «no instalado» y no revienta', async () => {
    const k = { raw: vi.fn(async () => { throw Object.assign(new Error('function does not exist'), { code: '42883' }); }) };
    const s = new CarteraPorEventoService(k as never, nuevoListen() as never);
    await expect(s.drenar()).resolves.toMatchObject({ mode: 'no_instalado' });
  });

  it('otro error de la base SÍ se propaga (no se confunde con «no instalado»)', async () => {
    const k = { raw: vi.fn(async () => { throw Object.assign(new Error('boom'), { code: '57014' }); }) };
    const s = new CarteraPorEventoService(k as never, nuevoListen() as never);
    await expect(s.drenar()).rejects.toThrow('boom');
  });
});
