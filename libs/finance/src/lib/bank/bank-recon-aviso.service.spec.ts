import { BankReconPorAvisoService } from './bank-recon-aviso.service';
import { CANAL_BANCOS } from './aviso-bancos';
import { CANAL_FUENTE_KEPLER } from '../goods-receipt-proofs/entradas-por-aviso';

/**
 * `[CB.60b]` El aviso agenda UNA mirada a 60 s del primero; los de en medio se absorben. Que el worker se suscriba
 * a los dos canales, y sólo el worker, lo cuida `finance-bank.module.arranque.spec.ts`.
 */
describe('[CB.60b] el oyente de la conciliación: cuándo mira', () => {
  const WORKER = process.env.WORKER;
  const montar = () => {
    const oyentes = new Map<string, () => void>();
    const listen = { escuchar: (canal: string, fn: () => void) => { oyentes.set(canal, fn); return () => { oyentes.delete(canal); }; } };
    const svc = new BankReconPorAvisoService({} as never, {} as never, listen as never, {} as never);
    const correr = vi.spyOn(svc, 'correr').mockResolvedValue();
    return { svc, oyentes, correr };
  };
  afterEach(() => {
    if (WORKER === undefined) delete process.env.WORKER; else process.env.WORKER = WORKER;
    vi.useRealTimers();
  });

  it('al arrancar mira una vez: lo avisado mientras el worker estaba abajo se perdió', async () => {
    vi.useFakeTimers();
    process.env.WORKER = 'true';
    const { svc, correr } = montar();
    svc.onModuleInit();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(correr).toHaveBeenCalledTimes(1);
    svc.onModuleDestroy();
  });

  it('una ráfaga de avisos de Bancos es UNA mirada', async () => {
    vi.useFakeTimers();
    process.env.WORKER = 'true';
    const { svc, oyentes, correr } = montar();
    svc.onModuleInit();
    await vi.advanceTimersByTimeAsync(60_000); // la mirada del arranque
    correr.mockClear();
    oyentes.get(CANAL_BANCOS)!();
    oyentes.get(CANAL_BANCOS)!();
    oyentes.get(CANAL_BANCOS)!();
    expect(correr).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(correr).toHaveBeenCalledTimes(1);
    svc.onModuleDestroy();
    expect(oyentes.size).toBe(0);
  });

  it('[negativa] avisos de Kepler cada 10 s durante 5 minutos SÍ producen miradas (una espera de silencio daría cero)', async () => {
    vi.useFakeTimers();
    process.env.WORKER = 'true';
    const { svc, oyentes, correr } = montar();
    svc.onModuleInit();
    for (let s = 10; s <= 300; s += 10) {
      await vi.advanceTimersByTimeAsync(10_000);
      oyentes.get(CANAL_FUENTE_KEPLER)!();
    }
    expect(correr.mock.calls.length).toBeGreaterThanOrEqual(4);
    svc.onModuleDestroy();
  });
});

/**
 * `[CB.79]` Un aviso de Bancos dice QUÉ periodos cambiaron. Antes el oyente lo descartaba y sólo miraba la ventana
 * (mes en curso y, hasta el día 20, el anterior): un periodo viejo con datos nuevos dependía del botón «Conciliar».
 */
describe('[CB.79] el oyente mira también los periodos que nombra el aviso de Bancos', () => {
  const WORKER = process.env.WORKER;
  afterEach(() => { if (WORKER === undefined) delete process.env.WORKER; else process.env.WORKER = WORKER; });
  const montar = () => {
    const oyentes = new Map<string, (payload: string) => void>();
    const listen = { escuchar: (canal: string, fn: (p: string) => void) => { oyentes.set(canal, fn); return () => { oyentes.delete(canal); }; } };
    const svc = new BankReconPorAvisoService({} as never, {} as never, listen as never, {} as never);
    // El arranque agenda una mirada con un temporizador real: se cancela para que no corra durante la prueba.
    vi.spyOn(svc as never as { programar: () => void }, 'programar').mockImplementation(() => undefined);
    const vistos: string[] = [];
    vi.spyOn(svc as never as { correrPeriodo: (p: string) => Promise<string> }, 'correrPeriodo')
      .mockImplementation(async (p: string) => { vistos.push(p); return 'corrio'; });
    return { svc, oyentes, vistos };
  };

  it('un libro de agosto vuelto a subir en noviembre: agosto se concilia junto con la ventana, una sola vez', async () => {
    process.env.WORKER = 'true';
    const { svc, oyentes, vistos } = montar();
    svc.onModuleInit();
    oyentes.get(CANAL_BANCOS)!(JSON.stringify({ origen: 'libro', periodos: ['2026-08'] }));
    await svc.correr('2026-11-17');
    expect(vistos).toEqual(['2026-11', '2026-10', '2026-08']);
    vistos.length = 0;
    await svc.correr('2026-11-17');
    expect(vistos).toEqual(['2026-11', '2026-10']);
    svc.onModuleDestroy();
  });

  it('[negativa] un aviso de Kepler o uno sin periodos no agrega nada a la ventana', async () => {
    process.env.WORKER = 'true';
    const { svc, oyentes, vistos } = montar();
    svc.onModuleInit();
    oyentes.get(CANAL_FUENTE_KEPLER)!(JSON.stringify({ periodos: ['2026-08'] }));
    oyentes.get(CANAL_BANCOS)!('no es json');
    await svc.correr('2026-11-25');
    expect(vistos).toEqual(['2026-11']);
    svc.onModuleDestroy();
  });
});
