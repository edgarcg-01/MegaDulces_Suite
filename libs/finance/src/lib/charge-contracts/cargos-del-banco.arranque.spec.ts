import 'reflect-metadata';
import { PgListenService } from '@megadulces/platform-core';
import { FinancePaymentCalendarModule } from '../payment-calendar/finance-payment-calendar.module';
import { CANAL_BANCOS } from '../bank/aviso-bancos';
import { CargosDelBancoService } from './cargos-del-banco.service';
import { ChargeContractsService } from './charge-contracts.service';

/**
 * `[PGP.213]` El oyente de los cargos del banco suma cuatro dependencias al módulo del Calendario, y **que compile no es que
 * arranque** (`[CB.53.1]`; #414 tiró la API en prod con el CI en verde). Vitest no emite `design:paramtypes`: el grafo se
 * lee de los decoradores del módulo, como en `finance-payment-calendar.module.arranque.spec`.
 *
 * ⚠️ NO MEDIDO aquí: la pasada contra la base (eso es `test-newdb-pgp213-charge-contracts.js`) ni que el worker de prod
 * reciba el aviso (se ve en su log: «cargos del banco …»).
 */
const meta = <T>(clave: string, objetivo: unknown): T[] => (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];
function alcanceDe(modulo: unknown): Set<unknown> {
  const out = new Set<unknown>(meta<unknown>('providers', modulo));
  for (const imp of meta<unknown>('imports', modulo)) for (const exp of meta<unknown>('exports', imp)) out.add(exp);
  return out;
}

describe('[PGP.213] el grafo del módulo cierra con el oyente de los cargos del banco', () => {
  it('el constructor toma sus cuatro dependencias (si cambian, revisar el arranque)', () => {
    expect(CargosDelBancoService.length).toBe(4);
  });

  it('el oyente y el servicio de contratos están entre los providers; PgListenService al alcance (no provisto aquí)', () => {
    const providers = meta<unknown>('providers', FinancePaymentCalendarModule);
    expect(providers).toContain(CargosDelBancoService);
    expect(providers).toContain(ChargeContractsService);
    expect(alcanceDe(FinancePaymentCalendarModule).has(PgListenService)).toBe(true);
    expect(providers).not.toContain(PgListenService);
  });

  it('sin reloj (Edgar: «ningún cron» en el Calendario)', () => {
    const relojes = Object.getOwnPropertyNames(CargosDelBancoService.prototype).flatMap((k) => {
      const v = (CargosDelBancoService.prototype as unknown as Record<string, unknown>)[k];
      return typeof v === 'function' ? Reflect.getMetadataKeys(v).map(String).filter((x) => /SCHEDULE/.test(x)) : [];
    });
    expect(relojes).toEqual([]);
  });
});

describe('[PGP.213] sólo el worker escucha, una vez, y se puede apagar', () => {
  const con = (env: Record<string, string | undefined>, fn: (escuchar: ReturnType<typeof vi.fn>, correr: ReturnType<typeof vi.fn>) => void) => {
    const antes = { WORKER: process.env.WORKER, DISABLE_CARGOS_DEL_BANCO: process.env.DISABLE_CARGOS_DEL_BANCO };
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try {
      const escuchar = vi.fn().mockReturnValue(() => undefined);
      const svc = new CargosDelBancoService({} as never, {} as never, {} as never, { escuchar } as never);
      const correr = vi.fn().mockResolvedValue(undefined);
      svc.correr = correr;
      svc.onModuleInit();
      fn(escuchar, correr);
      svc.onModuleDestroy();
    } finally {
      for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };

  it('fuera del worker no se suscribe', () => {
    con({ WORKER: 'false', DISABLE_CARGOS_DEL_BANCO: undefined }, (escuchar) => expect(escuchar).not.toHaveBeenCalled());
  });

  it('en el worker se suscribe UNA vez, al canal del banco', () => {
    con({ WORKER: 'true', DISABLE_CARGOS_DEL_BANCO: undefined }, (escuchar) => {
      expect(escuchar.mock.calls.map((c) => c[0])).toEqual([CANAL_BANCOS]);
    });
  });

  it('con DISABLE_CARGOS_DEL_BANCO=true no se suscribe ni en el worker', () => {
    con({ WORKER: 'true', DISABLE_CARGOS_DEL_BANCO: 'true' }, (escuchar) => expect(escuchar).not.toHaveBeenCalled());
  });
});

describe('[PGP.213] la pasada recorre los tenants activos y un tenant que falla no detiene a los demás', () => {
  it('corre la pasada de cada tenant en su contexto, y sigue tras un fallo', async () => {
    const vistos: string[] = [];
    const knex = Object.assign(() => ({ where: () => ({ pluck: async () => ['t-1', 't-2'] }) }), {});
    const tenantCtx = { run: (ctx: { tenantId: string }, fn: () => Promise<unknown>) => { vistos.push(ctx.tenantId); return fn(); } };
    let n = 0;
    const contratos = { pasada: vi.fn().mockImplementation(async () => {
      if (n++ === 0) throw new Error('falla del primero');
      return { hoy: '2026-11-26', propuesta: null, recalculados: 0, cargos: null, cerrados: 0, esperando: 0, fallas: [] };
    }) };
    const svc = new CargosDelBancoService(knex as never, tenantCtx as never, contratos as never, {} as never);
    await svc.correr();
    expect(vistos).toEqual(['t-1', 't-2']);
    expect(contratos.pasada).toHaveBeenCalledTimes(2);
  });
});
