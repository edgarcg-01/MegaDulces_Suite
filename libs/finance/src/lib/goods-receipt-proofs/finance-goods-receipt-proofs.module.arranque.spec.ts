import 'reflect-metadata';
import { Cron } from '@nestjs/schedule';
import { PgListenService } from '@megadulces/platform-core';
import { FinanceGoodsReceiptProofsModule } from './finance-goods-receipt-proofs.module';
import { GoodsReceiptTwinsService } from './goods-receipt-twins.service';
import { GoodsReceiptsWatcherService } from './goods-receipts-watcher.service';
import { CANAL_FUENTE_KEPLER, MiradaAlAviso } from './entradas-por-aviso';

/**
 * `[RE.69]` — El apareo de gemelas y el aviso de entradas nuevas dejaron el `@Cron` y escuchan `caja_fuente`.
 * Eso agrega `PgListenService` a dos constructores, y **que compile no es que arranque** (`[CB.53.1]`: el
 * 2026-10-21 un oyente igual tiró el arranque de Nest con el typecheck en verde). Mismo candado: el grafo del
 * módulo leído de sus decoradores (vitest no emite `design:paramtypes`, ver `finance-bank.module.arranque.spec`).
 */
const meta = <T>(clave: string, objetivo: unknown): T[] =>
  (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];

function alcanceDe(modulo: unknown): Set<unknown> {
  const out = new Set<unknown>(meta<unknown>('providers', modulo));
  for (const imp of meta<unknown>('imports', modulo)) for (const exp of meta<unknown>('exports', imp)) out.add(exp);
  return out;
}

describe('[RE.69] el grafo de FinanceGoodsReceiptProofsModule cierra con los oyentes', () => {
  it('los constructores toman sus dependencias (si cambian, revisar el arranque)', () => {
    expect(GoodsReceiptTwinsService.length).toBe(3);
    expect(GoodsReceiptsWatcherService.length).toBe(4);
  });
  it('⛔ PgListenService está al alcance: lo exporta un import (CajaRealtimeModule)', () => {
    expect(alcanceDe(FinanceGoodsReceiptProofsModule).has(PgListenService)).toBe(true);
  });
  it('NO lo provee por su cuenta: eso abriría una segunda conexión LISTEN contra prod', () => {
    expect(meta<unknown>('providers', FinanceGoodsReceiptProofsModule)).not.toContain(PgListenService);
  });
  it('los dos oyentes están entre los providers (si no, nadie escucha)', () => {
    const p = meta<unknown>('providers', FinanceGoodsReceiptProofsModule);
    expect(p).toContain(GoodsReceiptTwinsService);
    expect(p).toContain(GoodsReceiptsWatcherService);
  });
  it('PRUEBA NEGATIVA: sin el import que lo exporta, la comprobación se pone roja', () => {
    class SinElImport {}
    Reflect.defineMetadata('providers', [GoodsReceiptTwinsService], SinElImport);
    Reflect.defineMetadata('imports', [], SinElImport);
    expect(alcanceDe(SinElImport).has(PgListenService)).toBe(false);
  });
  // `@Cron` guarda su metadata EN LA FUNCIÓN (SetMetadata sobre `descriptor.value`), no en (prototipo, clave):
  // medido al escribir esto — mirar el prototipo daba [] aun con el `@Cron` puesto, y la guarda pasaba siempre.
  const relojesDe = (C: { prototype: object }): string[] =>
    Object.getOwnPropertyNames(C.prototype).flatMap((k) => {
      const v = (C.prototype as Record<string, unknown>)[k];
      return typeof v === 'function' ? Reflect.getMetadataKeys(v).map(String).filter((x) => /SCHEDULE/.test(x)) : [];
    });
  it('ya no hay reloj: ningún método lleva metadata de @nestjs/schedule', () => {
    expect(relojesDe(GoodsReceiptTwinsService)).toEqual([]);
    expect(relojesDe(GoodsReceiptsWatcherService)).toEqual([]);
  });
  it('PRUEBA NEGATIVA: con un @Cron real, la guarda lo ve', () => {
    class ConReloj { scan(): void { /* */ } }
    const d = Object.getOwnPropertyDescriptor(ConReloj.prototype, 'scan') as PropertyDescriptor;
    Cron('0 */5 * * * *')(ConReloj.prototype, 'scan', d);
    expect(relojesDe(ConReloj)).toContain('SCHEDULE_CRON_OPTIONS');
  });
});

describe('[RE.69] quién escucha en cada proceso', () => {
  const conEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
    const antes: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) { antes[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fn(); } finally { for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  };
  const nuevoListen = () => ({ escuchar: vi.fn().mockReturnValue(() => undefined) });

  it('el apareo escucha SÓLO en el worker, al canal de Kepler', () => {
    conEnv({ WORKER: 'true', DISABLE_RECEIPT_TWINS: undefined }, () => {
      const l = nuevoListen();
      const t = new GoodsReceiptTwinsService({} as never, {} as never, l as never);
      t.onModuleInit();
      expect(l.escuchar).toHaveBeenCalledTimes(1);
      expect(l.escuchar.mock.calls[0][0]).toBe(CANAL_FUENTE_KEPLER);
      t.onModuleDestroy();
    });
    conEnv({ WORKER: 'false', DISABLE_RECEIPT_TWINS: undefined }, () => {
      const l = nuevoListen();
      const t = new GoodsReceiptTwinsService({} as never, {} as never, l as never);
      t.onModuleInit();
      expect(l.escuchar).not.toHaveBeenCalled();
    });
  });
  it('el aviso a pantalla escucha en los pods de api y NO en el worker', () => {
    conEnv({ WORKER: 'false', DISABLE_RECEIPT_WATCH: undefined }, () => {
      const l = nuevoListen();
      const w = new GoodsReceiptsWatcherService({} as never, {} as never, { ventanaDias: 45 } as never, l as never);
      w.onModuleInit();
      expect(l.escuchar).toHaveBeenCalledTimes(1);
      expect(l.escuchar.mock.calls[0][0]).toBe(CANAL_FUENTE_KEPLER);
      w.onModuleDestroy();
    });
    conEnv({ WORKER: 'true', DISABLE_RECEIPT_WATCH: undefined }, () => {
      const l = nuevoListen();
      const w = new GoodsReceiptsWatcherService({} as never, {} as never, { ventanaDias: 45 } as never, l as never);
      w.onModuleInit();
      expect(l.escuchar).not.toHaveBeenCalled();
    });
  });
  it('los interruptores de siempre los apagan', () => {
    conEnv({ WORKER: 'true', DISABLE_RECEIPT_TWINS: 'true' }, () => {
      const l = nuevoListen();
      new GoodsReceiptTwinsService({} as never, {} as never, l as never).onModuleInit();
      expect(l.escuchar).not.toHaveBeenCalled();
    });
  });
});

describe('[RE.69] la mirada al aviso', () => {
  it('la primera mirada corre (no hay firma previa); la siguiente con la misma firma, no', async () => {
    const trabajo = vi.fn().mockResolvedValue(undefined);
    const m = new MiradaAlAviso(10, async () => 'a', trabajo, () => undefined);
    await m.mirar();
    await m.mirar();
    expect(trabajo.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });
  it('si la firma cambia, corre', async () => {
    const firmas = ['a', 'a', 'b'];
    const trabajo = vi.fn().mockResolvedValue(undefined);
    const m = new MiradaAlAviso(10, async () => firmas.shift() as string, trabajo, () => undefined);
    await m.mirar(); await m.mirar(); await m.mirar();
    expect(trabajo.mock.calls.map((c) => c[0])).toEqual([true, false, true]);
  });
  it('NEGATIVA: si el trabajo falla, la firma NO se guarda y la siguiente mirada reintenta', async () => {
    const trabajo = vi.fn().mockRejectedValueOnce(new Error('caído')).mockResolvedValue(undefined);
    const m = new MiradaAlAviso(10, async () => 'a', trabajo, () => undefined);
    await expect(m.mirar()).rejects.toThrow('caído');
    await m.mirar();
    expect(trabajo.mock.calls.map((c) => c[0])).toEqual([true, true]);
  });
  it('una ráfaga de avisos agenda UNA sola mirada', async () => {
    vi.useFakeTimers();
    try {
      const trabajo = vi.fn().mockResolvedValue(undefined);
      const m = new MiradaAlAviso(1000, async () => 'a', trabajo, () => undefined);
      for (let i = 0; i < 15; i++) m.avisar();
      await vi.advanceTimersByTimeAsync(1100);
      expect(trabajo).toHaveBeenCalledTimes(1);
      m.avisar();
      await vi.advanceTimersByTimeAsync(1100);
      expect(trabajo).toHaveBeenCalledTimes(2);
      m.detener();
    } finally { vi.useRealTimers(); }
  });
});
