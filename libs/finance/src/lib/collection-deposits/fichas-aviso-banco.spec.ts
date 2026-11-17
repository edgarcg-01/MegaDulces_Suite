import 'reflect-metadata';
import { PgListenService } from '@megadulces/platform-core';
import { FinanceCollectionDepositsModule } from './finance-collection-deposits.module';
import { FICHAS_AVISO_MARGEN_MS, FICHAS_AVISO_RAFAGA_MS, FichasAvisoBancoService } from './fichas-aviso-banco.service';
import { CobranzaGateway } from './cobranza.gateway';
import { CANAL_BANCOS } from '../bank/aviso-bancos';

/**
 * `[CC.21]` La bandeja de fichas se refresca cuando Bancos avisa (`bancos_movimientos`). Que compile no es que arranque
 * (#414): el cableado se lee de los decoradores; el comportamiento, con relojes falsos.
 */
const meta = <T>(clave: string, objetivo: unknown): T[] => (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];

describe('[CC.21] el cableado de FichasAvisoBancoService', () => {
  it('el constructor toma 2 dependencias (si cambia, revisar el arranque)', () => {
    expect(FichasAvisoBancoService.length).toBe(2);
  });
  it('el oyente, PgListenService y el gateway están entre los providers del módulo', () => {
    const p = meta<unknown>('providers', FinanceCollectionDepositsModule);
    expect(p).toContain(FichasAvisoBancoService);
    expect(p).toContain(PgListenService);
    expect(p).toContain(CobranzaGateway);
  });
  it('no hay reloj: ningún método lleva metadata de @nestjs/schedule', () => {
    const relojes = Object.getOwnPropertyNames(FichasAvisoBancoService.prototype).flatMap((k) => {
      const v = (FichasAvisoBancoService.prototype as unknown as Record<string, unknown>)[k];
      return typeof v === 'function' ? Reflect.getMetadataKeys(v).map(String).filter((x) => /SCHEDULE/.test(x)) : [];
    });
    expect(relojes).toEqual([]);
  });
});

const conEnv = (vars: Record<string, string | undefined>, fn: () => void): void => {
  const antes: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { antes[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { fn(); } finally { for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const armar = () => {
  const oyentes: Record<string, () => void> = {};
  const listen = { escuchar: vi.fn((canal: string, f: () => void) => { oyentes[canal] = f; return vi.fn(); }) };
  const gateway = { avisarATodosLocal: vi.fn(() => 3) };
  const svc = new FichasAvisoBancoService(listen as unknown as PgListenService, gateway as unknown as CobranzaGateway);
  return { svc, listen, gateway, avisa: () => oyentes[CANAL_BANCOS]?.() };
};

describe('[CC.21] cuándo avisa a la bandeja', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('en el worker NO escucha (las bandejas están conectadas al API)', () => {
    conEnv({ WORKER: 'true', DISABLE_FICHAS_AVISO_BANCO: undefined }, () => {
      const { svc, listen } = armar(); svc.onModuleInit();
      expect(listen.escuchar).not.toHaveBeenCalled();
    });
  });

  it('apagado por variable: no escucha', () => {
    conEnv({ WORKER: undefined, DISABLE_FICHAS_AVISO_BANCO: 'true' }, () => {
      const { svc, listen } = armar(); svc.onModuleInit();
      expect(listen.escuchar).not.toHaveBeenCalled();
    });
  });

  it('una ráfaga de avisos = UNA recarga al llegar + UNA cuando la conciliación ya corrió', () => {
    conEnv({ WORKER: undefined, DISABLE_FICHAS_AVISO_BANCO: undefined, BANK_RECON_AVISO_QUIET_S: undefined }, () => {
      const { svc, listen, gateway, avisa } = armar(); svc.onModuleInit();
      expect(listen.escuchar).toHaveBeenCalledWith(CANAL_BANCOS, expect.any(Function));
      avisa(); avisa(); avisa();
      vi.advanceTimersByTime(FICHAS_AVISO_RAFAGA_MS);
      expect(gateway.avisarATodosLocal).toHaveBeenCalledTimes(1);
      expect(gateway.avisarATodosLocal).toHaveBeenLastCalledWith('bank_loaded', 'llegó el estado de cuenta');
      vi.advanceTimersByTime(60_000 + FICHAS_AVISO_MARGEN_MS - FICHAS_AVISO_RAFAGA_MS - 1);
      expect(gateway.avisarATodosLocal).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(gateway.avisarATodosLocal).toHaveBeenCalledTimes(2);
      expect(gateway.avisarATodosLocal).toHaveBeenLastCalledWith('bank_loaded', 'la conciliación ya corrió');
      vi.advanceTimersByTime(10 * 60_000);
      expect(svc.avisosEnviados).toBe(2); // y nada más: no hay reloj que siga sonando
    });
  });

  it('la segunda mirada sigue la espera configurada de la conciliación', () => {
    conEnv({ BANK_RECON_AVISO_QUIET_S: '120' }, () => {
      expect(armar().svc.segundaMiradaMs).toBe(120_000 + FICHAS_AVISO_MARGEN_MS);
    });
  });

  it('al apagarse no queda ningún temporizador vivo', () => {
    conEnv({ WORKER: undefined, DISABLE_FICHAS_AVISO_BANCO: undefined }, () => {
      const { svc, gateway, avisa } = armar(); svc.onModuleInit();
      avisa(); svc.onModuleDestroy();
      vi.advanceTimersByTime(10 * 60_000);
      expect(gateway.avisarATodosLocal).not.toHaveBeenCalled();
    });
  });
});
