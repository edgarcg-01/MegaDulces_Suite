import 'reflect-metadata';
import { PgListenService } from '@megadulces/platform-core';
import { FinanceExpenseProofsModule } from '../finance-expense-proofs.module';
import { CANAL_SOLICITUD, ESPERA_SOLICITUD_MS, SolicitudPorEventoService } from './solicitud-por-evento.service';
import { SolicitudGastoService } from './solicitud-gasto.service';
// El nombre del canal lo comparten la migración (el disparador avisa) y el servicio (escucha): si difieren, nadie oye.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const migracion = require('../../../../../../database/migrations-newdb/20261118085331_pgp122_solicitud_por_evento.js') as { CANAL: string };

/**
 * `[PGP.122]` R1 por evento — el que escucha `solicitud_gasto_kepler`. **Que compile no es que arranque** (`[CB.53.1]`,
 * `#414`): el grafo del módulo se lee de sus decoradores. El disparador se prueba contra Postgres real en
 * `database/tests/test-newdb-solicitud-por-evento.js`; aquí, el cableado: quién escucha, cuándo mira y qué corre.
 */
const meta = <T>(clave: string, objetivo: unknown): T[] =>
  (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];
function alcanceDe(modulo: unknown): Set<unknown> {
  const out = new Set<unknown>(meta<unknown>('providers', modulo));
  for (const imp of meta<unknown>('imports', modulo)) for (const exp of meta<unknown>('exports', imp)) out.add(exp);
  return out;
}

describe('[PGP.122] el grafo de FinanceExpenseProofsModule cierra con el que escucha la solicitud', () => {
  it('el constructor toma 2 dependencias (si cambia, revisar el arranque)', () => {
    expect(SolicitudPorEventoService.length).toBe(2);
  });
  it('el que escucha y el servicio que corre el lazo están entre los providers', () => {
    const p = meta<unknown>('providers', FinanceExpenseProofsModule);
    expect(p).toContain(SolicitudPorEventoService);
    expect(p).toContain(SolicitudGastoService);
  });
  it('⛔ PgListenService está al alcance del módulo (no es global)', () => {
    expect(alcanceDe(FinanceExpenseProofsModule).has(PgListenService)).toBe(true);
  });
  it('PRUEBA NEGATIVA: sin proveerlo, PgListenService queda fuera', () => {
    class SinListen {}
    Reflect.defineMetadata('providers', [SolicitudPorEventoService], SinListen);
    Reflect.defineMetadata('imports', [], SinListen);
    expect(alcanceDe(SinListen).has(PgListenService)).toBe(false);
  });
  it('no hay reloj: ningún método lleva metadata de @nestjs/schedule', () => {
    const relojes = Object.getOwnPropertyNames(SolicitudPorEventoService.prototype).flatMap((k) => {
      const v = (SolicitudPorEventoService.prototype as unknown as Record<string, unknown>)[k];
      return typeof v === 'function' ? Reflect.getMetadataKeys(v).map(String).filter((x) => /SCHEDULE/.test(x)) : [];
    });
    expect(relojes).toEqual([]);
  });
  it('el canal que escucha es el que avisa la migración', () => {
    expect(migracion.CANAL).toBe(CANAL_SOLICITUD);
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
const vacio = { vistos_en_ods: 0, sin_ver_30min: 0, canceladas_en_kepler: 0, canceladas_firmadas: 0, huerfanas: [] };
const nuevasSolicitudes = () => ({ lazo: vi.fn(async () => ({ ...vacio })) });

describe('[PGP.122] quién escucha y cuándo corre el lazo', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('en un pod de api (no worker) no escucha ni corre el lazo', async () => {
    await conEnv({ WORKER: 'false', DISABLE_SOLICITUD_POR_EVENTO: undefined }, async () => {
      const l = nuevoListen(); const s = nuevasSolicitudes();
      new SolicitudPorEventoService(s as never, l as never).onModuleInit();
      await vi.advanceTimersByTimeAsync(ESPERA_SOLICITUD_MS * 2);
      expect(l.escuchar).not.toHaveBeenCalled();
      expect(s.lazo).not.toHaveBeenCalled();
    });
  });

  it('apagado por variable de entorno, ni en el worker escucha', async () => {
    await conEnv({ WORKER: 'true', DISABLE_SOLICITUD_POR_EVENTO: 'true' }, async () => {
      const l = nuevoListen(); const s = nuevasSolicitudes();
      new SolicitudPorEventoService(s as never, l as never).onModuleInit();
      await vi.advanceTimersByTimeAsync(ESPERA_SOLICITUD_MS * 2);
      expect(l.escuchar).not.toHaveBeenCalled();
      expect(s.lazo).not.toHaveBeenCalled();
    });
  });

  it('en el worker escucha el canal, mira al arrancar, tras un aviso y cuando el LISTEN vuelve', async () => {
    await conEnv({ WORKER: 'true', DISABLE_SOLICITUD_POR_EVENTO: undefined }, async () => {
      const l = nuevoListen(); const s = nuevasSolicitudes();
      const svc = new SolicitudPorEventoService(s as never, l as never);
      svc.onModuleInit();
      expect(l.escuchar).toHaveBeenCalledWith(CANAL_SOLICITUD, expect.any(Function));
      await vi.advanceTimersByTimeAsync(ESPERA_SOLICITUD_MS + 10);
      expect(s.lazo).toHaveBeenCalledTimes(1);
      // Varios avisos dentro de la espera son UNA pasada.
      l.avisa(CANAL_SOLICITUD); l.avisa(CANAL_SOLICITUD); l.avisa(CANAL_SOLICITUD);
      await vi.advanceTimersByTimeAsync(ESPERA_SOLICITUD_MS + 10);
      expect(s.lazo).toHaveBeenCalledTimes(2);
      l.vuelve();
      await vi.advanceTimersByTimeAsync(ESPERA_SOLICITUD_MS + 10);
      expect(s.lazo).toHaveBeenCalledTimes(3);
      svc.onModuleDestroy();
      l.avisa(CANAL_SOLICITUD);
      await vi.advanceTimersByTimeAsync(ESPERA_SOLICITUD_MS + 10);
      expect(s.lazo).toHaveBeenCalledTimes(3);
    });
  });

  it('si el lazo falla, no revienta el proceso y el siguiente aviso vuelve a mirar', async () => {
    await conEnv({ WORKER: 'true', DISABLE_SOLICITUD_POR_EVENTO: undefined }, async () => {
      const l = nuevoListen();
      const s = { lazo: vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ ...vacio }) };
      const svc = new SolicitudPorEventoService(s as never, l as never);
      svc.onModuleInit();
      await vi.advanceTimersByTimeAsync(ESPERA_SOLICITUD_MS + 10);
      expect(s.lazo).toHaveBeenCalledTimes(1);
      l.avisa(CANAL_SOLICITUD);
      await vi.advanceTimersByTimeAsync(ESPERA_SOLICITUD_MS + 10);
      expect(s.lazo).toHaveBeenCalledTimes(2);
      svc.onModuleDestroy();
    });
  });
});
