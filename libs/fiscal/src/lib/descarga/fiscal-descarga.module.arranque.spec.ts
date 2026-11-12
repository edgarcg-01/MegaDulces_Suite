import 'reflect-metadata';
import { Cron } from '@nestjs/schedule';
import { PgListenService } from '@megadulces/platform-core';
import { FiscalDescargaModule } from './fiscal-descarga.module';
import { SatAlDiaService } from './sat-al-dia.service';
import { DescargaService } from './descarga.service';
import { JobQueueService } from '../jobs/job-queue.service';
import { JobRunnerService } from '../jobs/job-runner.service';

/**
 * `[PGP.110c]` La descarga automática agrega un servicio con seis dependencias, y **que compile no es que
 * arranque** (`[CB.53.1]`: el 2026-10-21 un oyente tiró el arranque de Nest con el typecheck en verde; #414
 * tiró la API en prod con el CI en verde). Vitest no emite `design:paramtypes`, así que el grafo se lee de
 * los decoradores del módulo, como `finance-goods-receipt-proofs.module.arranque.spec`.
 */
const meta = <T>(clave: string, objetivo: unknown): T[] =>
  (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];

function alcanceDe(modulo: unknown): Set<unknown> {
  const out = new Set<unknown>(meta<unknown>('providers', modulo));
  for (const imp of meta<unknown>('imports', modulo)) for (const exp of meta<unknown>('exports', imp)) out.add(exp);
  return out;
}

describe('[PGP.110c] el grafo de FiscalDescargaModule cierra con la descarga automática', () => {
  it('el constructor toma sus seis dependencias (si cambian, revisar el arranque)', () => {
    expect(SatAlDiaService.length).toBe(6);
  });

  it('todo lo que pide su constructor (salvo los globales de platform-core) está al alcance del módulo', () => {
    const alcance = alcanceDe(FiscalDescargaModule);
    for (const dep of [JobRunnerService, JobQueueService, DescargaService, PgListenService]) expect(alcance.has(dep)).toBe(true);
    expect(meta<unknown>('providers', FiscalDescargaModule)).toContain(SatAlDiaService);
  });

  it('PRUEBA NEGATIVA: sin el import de la cola, la comprobación se pone roja', () => {
    class SinLaCola {}
    Reflect.defineMetadata('providers', [SatAlDiaService, DescargaService, PgListenService], SinLaCola);
    Reflect.defineMetadata('imports', [], SinLaCola);
    expect(alcanceDe(SinLaCola).has(JobRunnerService)).toBe(false);
  });

  // `@Cron` guarda su metadata en la FUNCIÓN, no en (prototipo, clave): ver el spec de goods-receipt-proofs.
  const relojesDe = (C: { prototype: object }): string[] =>
    Object.getOwnPropertyNames(C.prototype).flatMap((k) => {
      const v = (C.prototype as Record<string, unknown>)[k];
      return typeof v === 'function' ? Reflect.getMetadataKeys(v).map(String).filter((x) => /SCHEDULE/.test(x)) : [];
    });

  it('sin reloj: ningún método lleva metadata de @nestjs/schedule (Edgar: «ningún cron»)', () => {
    expect(relojesDe(SatAlDiaService)).toEqual([]);
  });

  it('PRUEBA NEGATIVA: con un @Cron real, la guarda lo ve', () => {
    class ConReloj { scan(): void { /* */ } }
    const d = Object.getOwnPropertyDescriptor(ConReloj.prototype, 'scan') as PropertyDescriptor;
    Cron('0 0 7 * * *')(ConReloj.prototype, 'scan', d);
    expect(relojesDe(ConReloj).length).toBeGreaterThan(0);
  });
});
