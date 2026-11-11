import { BankReconPorAvisoService } from './bank-recon-aviso.service';
import { CANAL_BANCOS } from './aviso-bancos';

/**
 * `[CB.60b]` Un aviso de Bancos (la descarga que entró a los movimientos, o la carga del libro) agenda la MISMA
 * corrida que un aviso de Kepler: tras el silencio, una por ráfaga. Que el worker se suscriba a los dos canales,
 * y sólo el worker, lo cuida `finance-bank.module.arranque.spec.ts`.
 */
describe('[CB.60b] el aviso de Bancos agenda la conciliación', () => {
  const WORKER = process.env.WORKER;
  afterEach(() => {
    if (WORKER === undefined) delete process.env.WORKER; else process.env.WORKER = WORKER;
    vi.useRealTimers();
  });

  it('una ráfaga de avisos de Bancos es UNA corrida, después del silencio', async () => {
    vi.useFakeTimers();
    process.env.WORKER = 'true';
    const oyentes = new Map<string, () => void>();
    const listen = { escuchar: (canal: string, fn: () => void) => { oyentes.set(canal, fn); return () => { oyentes.delete(canal); }; } };
    const svc = new BankReconPorAvisoService({} as never, {} as never, listen as never, {} as never);
    const correr = vi.spyOn(svc, 'correr').mockResolvedValue();
    svc.onModuleInit();
    oyentes.get(CANAL_BANCOS)!();
    oyentes.get(CANAL_BANCOS)!();
    expect(correr).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(correr).toHaveBeenCalledTimes(1);
    svc.onModuleDestroy();
    expect(oyentes.size).toBe(0);
  });
});
