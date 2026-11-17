import 'reflect-metadata';
import { PgListenService } from '@megadulces/platform-core';
import { CommercialAnalyticsModule } from './commercial-analytics.module';
import { CANAL_EXISTENCIA, ESPERA_EXISTENCIA_MS, ExistenciaPorEventoService } from './existencia-por-evento.service';

/**
 * `[CANON.6.21]` — El que drena la existencia escucha `existencia_sucia`. **Que compile no es que arranque**
 * (`[CB.53.1]`, `#414`): el grafo del módulo se lee de sus decoradores (vitest no emite `design:paramtypes`). El SQL
 * de `analytics.drenar_existencia()` se prueba contra base real en `database/tests/test-newdb-existencia-por-evento.js`
 * (un doble de Knex no ejecuta SQL); aquí, sólo el cableado: quién escucha, cuándo drena y qué hace con la respuesta.
 */
const meta = <T>(clave: string, objetivo: unknown): T[] =>
  (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];
function alcanceDe(modulo: unknown): Set<unknown> {
  const out = new Set<unknown>(meta<unknown>('providers', modulo));
  for (const imp of meta<unknown>('imports', modulo)) for (const exp of meta<unknown>('exports', imp)) out.add(exp);
  return out;
}

describe('[CANON.6.21] el grafo de CommercialAnalyticsModule cierra con el que drena', () => {
  it('el constructor toma 2 dependencias (si cambia, revisar el arranque)', () => {
    expect(ExistenciaPorEventoService.length).toBe(2);
  });
  it('el que drena está entre los providers (si no, nadie escucha)', () => {
    expect(meta<unknown>('providers', CommercialAnalyticsModule)).toContain(ExistenciaPorEventoService);
  });
  it('⛔ PgListenService está al alcance del módulo', () => {
    expect(alcanceDe(CommercialAnalyticsModule).has(PgListenService)).toBe(true);
  });
  it('PRUEBA NEGATIVA: sin proveerlo, PgListenService queda fuera', () => {
    class SinListen {}
    Reflect.defineMetadata('providers', [ExistenciaPorEventoService], SinListen);
    Reflect.defineMetadata('imports', [], SinListen);
    expect(alcanceDe(SinListen).has(PgListenService)).toBe(false);
  });
  it('no hay reloj: ningún método lleva metadata de @nestjs/schedule', () => {
    const relojes = Object.getOwnPropertyNames(ExistenciaPorEventoService.prototype).flatMap((k) => {
      const v = (ExistenciaPorEventoService.prototype as unknown as Record<string, unknown>)[k];
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
const renglon = (o: Partial<Record<string, unknown>>) => ({ modo: 'llave', motivo: 'cola', marcas: 3, llaves: 2, objeto: 'price_truth', insertadas: 0, actualizadas: 1, borradas: 0, ...o });
/** Un knex de mentira que contesta, en orden, lo que se le dé (y registra las llamadas). */
const nuevoKnex = (...respuestas: Array<Array<Record<string, unknown>>>) => {
  const raw = vi.fn(async (sql: string) => { void sql; return { rows: respuestas.length > 1 ? respuestas.shift() : respuestas[0] }; });
  return { raw };
};

describe('[CANON.6.21] quién escucha y cuándo drena', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('en un pod de api (no worker) no escucha ni drena', async () => {
    await conEnv({ WORKER: 'false', DISABLE_EXISTENCIA_POR_EVENTO: undefined }, async () => {
      const l = nuevoListen(); const k = nuevoKnex([renglon({ modo: 'vacio' })]);
      const s = new ExistenciaPorEventoService(k as never, l as never);
      s.onModuleInit();
      await vi.advanceTimersByTimeAsync(ESPERA_EXISTENCIA_MS * 2);
      expect(l.escuchar).not.toHaveBeenCalled();
      expect(k.raw).not.toHaveBeenCalled();
    });
  });

  it('apagado con DISABLE_EXISTENCIA_POR_EVENTO: ni en el worker', async () => {
    await conEnv({ WORKER: 'true', DISABLE_EXISTENCIA_POR_EVENTO: 'true' }, async () => {
      const l = nuevoListen(); const k = nuevoKnex([renglon({ modo: 'vacio' })]);
      new ExistenciaPorEventoService(k as never, l as never).onModuleInit();
      await vi.advanceTimersByTimeAsync(ESPERA_EXISTENCIA_MS * 2);
      expect(l.escuchar).not.toHaveBeenCalled();
      expect(k.raw).not.toHaveBeenCalled();
    });
  });

  it('en el worker escucha existencia_sucia y drena UNA vez al arrancar (lo que quedó con el proceso abajo)', async () => {
    await conEnv({ WORKER: 'true', DISABLE_EXISTENCIA_POR_EVENTO: undefined }, async () => {
      const l = nuevoListen(); const k = nuevoKnex([renglon({ modo: 'completo', motivo: 'primero_del_dia' })]);
      const s = new ExistenciaPorEventoService(k as never, l as never);
      s.onModuleInit();
      expect(l.escuchar).toHaveBeenCalledTimes(1);
      expect(l.escuchar.mock.calls[0][0]).toBe(CANAL_EXISTENCIA);
      expect(l.alConectar).toHaveBeenCalledTimes(1);
      expect(k.raw).not.toHaveBeenCalled();            // espera antes de la primera mirada
      await vi.advanceTimersByTimeAsync(ESPERA_EXISTENCIA_MS);
      expect(k.raw).toHaveBeenCalledTimes(1);
      expect(String(k.raw.mock.calls[0][0])).toMatch(/analytics\.drenar_existencia\(\)/);
      s.onModuleDestroy();
    });
  });

  it('una ráfaga de avisos es UNA pasada; un aviso después de ella, otra', async () => {
    await conEnv({ WORKER: 'true', DISABLE_EXISTENCIA_POR_EVENTO: undefined }, async () => {
      const l = nuevoListen(); const k = nuevoKnex([renglon({})]);
      const s = new ExistenciaPorEventoService(k as never, l as never);
      s.onModuleInit();
      await vi.advanceTimersByTimeAsync(ESPERA_EXISTENCIA_MS);  // la del arranque
      for (let i = 0; i < 10; i++) l.avisa(CANAL_EXISTENCIA);
      await vi.advanceTimersByTimeAsync(ESPERA_EXISTENCIA_MS);
      expect(k.raw).toHaveBeenCalledTimes(2);
      l.avisa(CANAL_EXISTENCIA);
      await vi.advanceTimersByTimeAsync(ESPERA_EXISTENCIA_MS);
      expect(k.raw).toHaveBeenCalledTimes(3);
      s.onModuleDestroy();
    });
  });

  it('al volver el LISTEN (se pudieron perder avisos) vuelve a mirar, aunque no haya aviso nuevo', async () => {
    await conEnv({ WORKER: 'true', DISABLE_EXISTENCIA_POR_EVENTO: undefined }, async () => {
      const l = nuevoListen(); const k = nuevoKnex([renglon({ modo: 'vacio' })]);
      const s = new ExistenciaPorEventoService(k as never, l as never);
      s.onModuleInit();
      await vi.advanceTimersByTimeAsync(ESPERA_EXISTENCIA_MS);
      l.vuelve();
      await vi.advanceTimersByTimeAsync(ESPERA_EXISTENCIA_MS);
      expect(k.raw).toHaveBeenCalledTimes(2);
      s.onModuleDestroy();
    });
  });

  it('«ocupado» (otro recalcula): agenda otra mirada sola, sin esperar un aviso', async () => {
    await conEnv({ WORKER: 'true', DISABLE_EXISTENCIA_POR_EVENTO: undefined }, async () => {
      const l = nuevoListen(); const k = nuevoKnex([renglon({ modo: 'ocupado', motivo: null, objeto: null })], [renglon({})]);
      const s = new ExistenciaPorEventoService(k as never, l as never);
      s.onModuleInit();
      await vi.advanceTimersByTimeAsync(ESPERA_EXISTENCIA_MS);
      expect(k.raw).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(ESPERA_EXISTENCIA_MS);
      expect(k.raw).toHaveBeenCalledTimes(2);
      s.onModuleDestroy();
    });
  });

  it('PRUEBA NEGATIVA: con «vacio» NO vuelve a mirar solo (no hay un reloj escondido)', async () => {
    await conEnv({ WORKER: 'true', DISABLE_EXISTENCIA_POR_EVENTO: undefined }, async () => {
      const l = nuevoListen(); const k = nuevoKnex([renglon({ modo: 'vacio' })]);
      const s = new ExistenciaPorEventoService(k as never, l as never);
      s.onModuleInit();
      await vi.advanceTimersByTimeAsync(ESPERA_EXISTENCIA_MS * 10);
      expect(k.raw).toHaveBeenCalledTimes(1);
      s.onModuleDestroy();
    });
  });

  it('«error»: lo dice en el log como error (la cola quedó intacta en la base)', async () => {
    await conEnv({ WORKER: 'true', DISABLE_EXISTENCIA_POR_EVENTO: undefined }, async () => {
      const l = nuevoListen(); const k = nuevoKnex([renglon({ modo: 'error', motivo: 'cola', objeto: null })]);
      const s = new ExistenciaPorEventoService(k as never, l as never);
      const err = vi.spyOn((s as unknown as { logger: { error: (m: string) => void } }).logger, 'error').mockImplementation(() => undefined);
      const r = await s.drenar();
      expect(r.modo).toBe('error');
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0][0])).toMatch(/FALLÓ.*cola quedó intacta/);
    });
  });

  it('sin la migración todavía (42883): lo dice como aviso, no como falla, y no reintenta solo', async () => {
    await conEnv({ WORKER: 'true', DISABLE_EXISTENCIA_POR_EVENTO: undefined }, async () => {
      const l = nuevoListen();
      const raw = vi.fn().mockRejectedValue(Object.assign(new Error('function analytics.drenar_existencia() does not exist'), { code: '42883' }));
      const s = new ExistenciaPorEventoService({ raw } as never, l as never);
      const lg = (s as unknown as { logger: { warn: (m: string) => void; error: (m: string) => void } }).logger;
      const warn = vi.spyOn(lg, 'warn').mockImplementation(() => undefined);
      const err = vi.spyOn(lg, 'error').mockImplementation(() => undefined);
      s.onModuleInit();
      await vi.advanceTimersByTimeAsync(ESPERA_EXISTENCIA_MS * 5);
      expect(raw).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.some((c) => /falta la migración 20261117094325/.test(String(c[0])))).toBe(true);
      expect(err).not.toHaveBeenCalled();
      s.onModuleDestroy();
    });
  });

  it('PRUEBA NEGATIVA: otra falla de la base SÍ es error (no se confunde con «no instalado»)', async () => {
    await conEnv({ WORKER: 'true', DISABLE_EXISTENCIA_POR_EVENTO: undefined }, async () => {
      const raw = vi.fn().mockRejectedValue(Object.assign(new Error('permission denied'), { code: '42501' }));
      const s = new ExistenciaPorEventoService({ raw } as never, nuevoListen() as never);
      await expect(s.drenar()).rejects.toThrow('permission denied');
    });
  });

  it('una pasada que revienta (sin base) se dice y no tumba al proceso; el siguiente aviso reintenta', async () => {
    await conEnv({ WORKER: 'true', DISABLE_EXISTENCIA_POR_EVENTO: undefined }, async () => {
      const l = nuevoListen();
      const raw = vi.fn().mockRejectedValueOnce(new Error('sin conexión')).mockResolvedValue({ rows: [renglon({})] });
      const s = new ExistenciaPorEventoService({ raw } as never, l as never);
      const err = vi.spyOn((s as unknown as { logger: { error: (m: string) => void } }).logger, 'error').mockImplementation(() => undefined);
      s.onModuleInit();
      await vi.advanceTimersByTimeAsync(ESPERA_EXISTENCIA_MS);
      expect(err.mock.calls.some((c) => /la pasada falló: sin conexión/.test(String(c[0])))).toBe(true);
      l.avisa(CANAL_EXISTENCIA);
      await vi.advanceTimersByTimeAsync(ESPERA_EXISTENCIA_MS);
      expect(raw).toHaveBeenCalledTimes(2);
      s.onModuleDestroy();
    });
  });

  it('al apagarse deja de escuchar y suelta la reconexión', async () => {
    await conEnv({ WORKER: 'true', DISABLE_EXISTENCIA_POR_EVENTO: undefined }, async () => {
      const l = nuevoListen(); const k = nuevoKnex([renglon({})]);
      const s = new ExistenciaPorEventoService(k as never, l as never);
      s.onModuleInit();
      const dejar = l.escuchar.mock.results[0].value as ReturnType<typeof vi.fn>;
      const soltar = l.alConectar.mock.results[0].value as ReturnType<typeof vi.fn>;
      s.onModuleDestroy();
      expect(dejar).toHaveBeenCalledTimes(1);
      expect(soltar).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(ESPERA_EXISTENCIA_MS * 2);
      expect(k.raw).not.toHaveBeenCalled();            // la mirada del arranque se canceló
    });
  });
});
