import 'reflect-metadata';
import { Cron } from '@nestjs/schedule';
import { CANAL_FUENTE_KEPLER, PgListenService } from '@megadulces/platform-core';
import { FinancePaymentCalendarModule } from './finance-payment-calendar.module';
import { PagosVencidosService } from './pagos-vencidos.service';
import { PaymentCalendarService } from './payment-calendar.service';

/**
 * `[PGP.117]` La liberación de pagos vencidos agrega un oyente con cuatro dependencias al módulo del
 * Calendario, y **que compile no es que arranque** (`[CB.53.1]`: un oyente tiró el arranque de Nest con
 * el typecheck en verde; #414 tiró la API en prod con el CI en verde). Vitest no emite
 * `design:paramtypes`, así que el grafo se lee de los decoradores del módulo, como en
 * `finance-bank.module.arranque.spec`.
 *
 * ⚠️ Lo que este candado NO prueba: que el worker reciba avisos ni que la pasada escriba bien contra
 * una base real (eso queda NO MEDIDO hasta el primer día en prod: `finance.payment_allocation_history`).
 */
const meta = <T>(clave: string, objetivo: unknown): T[] =>
  (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];

function alcanceDe(modulo: unknown): Set<unknown> {
  const out = new Set<unknown>(meta<unknown>('providers', modulo));
  for (const imp of meta<unknown>('imports', modulo)) for (const exp of meta<unknown>('exports', imp)) out.add(exp);
  return out;
}

describe('[PGP.117] el grafo de FinancePaymentCalendarModule cierra con el oyente de pagos vencidos', () => {
  it('el constructor del oyente toma sus cuatro dependencias (si cambian, revisar el arranque)', () => {
    expect(PagosVencidosService.length).toBe(4);
  });

  it('el oyente está entre los providers y tiene al alcance el Calendario y PgListenService', () => {
    const alcance = alcanceDe(FinancePaymentCalendarModule);
    expect(meta<unknown>('providers', FinancePaymentCalendarModule)).toContain(PagosVencidosService);
    expect(alcance.has(PaymentCalendarService)).toBe(true);
    expect(alcance.has(PgListenService)).toBe(true);
  });

  it('NO provee PgListenService por su cuenta: abriría una segunda conexión LISTEN contra prod', () => {
    expect(meta<unknown>('providers', FinancePaymentCalendarModule)).not.toContain(PgListenService);
  });

  it('PRUEBA NEGATIVA: sin el import que lo exporta, la comprobación se pone roja', () => {
    class ModuloSinElImport {}
    Reflect.defineMetadata('providers', [PagosVencidosService, PaymentCalendarService], ModuloSinElImport);
    Reflect.defineMetadata('imports', [], ModuloSinElImport);
    expect(alcanceDe(ModuloSinElImport).has(PgListenService)).toBe(false);
  });

  // `@Cron` guarda su metadata en la FUNCIÓN, no en (prototipo, clave).
  const relojesDe = (C: { prototype: object }): string[] =>
    Object.getOwnPropertyNames(C.prototype).flatMap((k) => {
      const v = (C.prototype as Record<string, unknown>)[k];
      return typeof v === 'function' ? Reflect.getMetadataKeys(v).map(String).filter((x) => /SCHEDULE/.test(x)) : [];
    });

  it('sin reloj: ningún método del oyente lleva metadata de @nestjs/schedule (Edgar: «ningún cron»)', () => {
    expect(relojesDe(PagosVencidosService)).toEqual([]);
  });

  it('PRUEBA NEGATIVA: con un @Cron real, la guarda lo ve', () => {
    class ConReloj { scan(): void { /* */ } }
    const d = Object.getOwnPropertyDescriptor(ConReloj.prototype, 'scan') as PropertyDescriptor;
    Cron('0 0 7 * * *')(ConReloj.prototype, 'scan', d);
    expect(relojesDe(ConReloj).length).toBeGreaterThan(0);
  });
});

describe('[PGP.117] sólo el worker escucha, y se puede apagar', () => {
  const con = (env: Record<string, string | undefined>, fn: (escuchar: ReturnType<typeof vi.fn>) => void) => {
    const antes = { WORKER: process.env.WORKER, DISABLE_PAGOS_VENCIDOS: process.env.DISABLE_PAGOS_VENCIDOS };
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try {
      const escuchar = vi.fn().mockReturnValue(() => undefined);
      const svc = new PagosVencidosService({} as never, {} as never, {} as never, { escuchar } as never);
      // La mirada de arranque no debe tocar nada real: se reemplaza la pasada.
      svc.liberarHoy = vi.fn().mockResolvedValue(0);
      svc.onModuleInit();
      fn(escuchar);
      svc.onModuleDestroy();
    } finally {
      for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };

  it('fuera del worker no se suscribe', () => {
    con({ WORKER: 'false', DISABLE_PAGOS_VENCIDOS: undefined }, (escuchar) => expect(escuchar).not.toHaveBeenCalled());
  });

  it('en el worker se suscribe UNA vez, a los documentos de Kepler', () => {
    con({ WORKER: 'true', DISABLE_PAGOS_VENCIDOS: undefined }, (escuchar) => {
      expect(escuchar.mock.calls.map((c) => c[0])).toEqual([CANAL_FUENTE_KEPLER]);
    });
  });

  it('con DISABLE_PAGOS_VENCIDOS=true no se suscribe ni en el worker', () => {
    con({ WORKER: 'true', DISABLE_PAGOS_VENCIDOS: 'true' }, (escuchar) => expect(escuchar).not.toHaveBeenCalled());
  });
});
