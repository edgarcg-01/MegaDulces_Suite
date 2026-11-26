// Sin `import ... from 'vitest'`: la config de este proyecto usa `globals: true`,
// y el import explícito hace que el archivo ni siquiera cargue.
import {
  ESPERA_TIENDA_MS,
  TOPE_POR_PASADA,
  TiendaSyncPorEventoService,
  type EmpujeTienda,
} from './tienda-sync-por-evento.service';

/**
 * `[COT.7.50]` — lo que este oyente tiene que garantizar.
 *
 * ⚠️ **NO MEDIDO acá:** que el empuje real llegue a Wix. Eso necesita el secreto en k3s y una
 * corrida contra la tienda viva. Esto prueba la DECISIÓN: qué se toma, qué se empuja, y qué pasa
 * cuando el empuje falla.
 */

function armar(opciones: { cola?: string[]; falla?: string; resultado?: { renglones: number; noPublicados: number } } = {}) {
  const llamadas: string[][] = [];
  const knex = {
    raw: async () => ({ rows: (opciones.cola ?? []).map((sku) => ({ sku })) }),
  };
  const listen = { escuchar: () => () => undefined, alConectar: () => () => undefined };
  const empuje: EmpujeTienda = {
    empujar: async (skus: string[]) => {
      llamadas.push([...skus]);
      if (opciones.falla) throw new Error(opciones.falla);
      return opciones.resultado ?? { renglones: skus.length, noPublicados: 0 };
    },
  };
  const svc = new TiendaSyncPorEventoService(knex as never, listen as never, empuje);
  return { svc, llamadas };
}

describe('[COT.7.50] la tienda se empuja cuando algo cambia, no cada tanto', () => {
  it('no estrena ni canal ni reloj: espera menos que el drenado de existencia', () => {
    // el drenado de [CANON.6.21] junta 2 min; este empuje no depende de ese recálculo
    expect(ESPERA_TIENDA_MS).toBeLessThan(120_000);
    expect(ESPERA_TIENDA_MS).toBeGreaterThanOrEqual(30_000);
  });

  it('toma los SKU de la cola y los acumula sin repetir', async () => {
    const { svc } = armar({ cola: ['95612', '17064', '95612'] });
    expect(await svc.tomarDeLaCola()).toBe(3);
    expect(svc.pendientes()).toBe(2);
    await svc.tomarDeLaCola();
    expect(svc.pendientes()).toBe(2);
  });

  it('empuja lo acumulado y lo suelta', async () => {
    const { svc, llamadas } = armar({ cola: ['95612', '17064'] });
    await svc.tomarDeLaCola();
    const r = await svc.pasada();
    expect(r).toEqual({ empujados: 2, renglones: 2 });
    expect(llamadas).toEqual([['95612', '17064']]);
    expect(svc.pendientes()).toBe(0);
  });

  it('sin nada acumulado NO llama al empuje', async () => {
    const { svc, llamadas } = armar({ cola: [] });
    expect(await svc.pasada()).toBeNull();
    expect(llamadas).toHaveLength(0);
  });

  describe('⛔ FAIL-OPEN: un empuje caído no puede tumbar al worker ni perder trabajo', () => {
    it('si el empuje falla, NO lanza', async () => {
      const { svc } = armar({ cola: ['95612'], falla: 'wix no contesta' });
      await svc.tomarDeLaCola();
      await expect(svc.pasada()).resolves.toBeNull();
    });

    it('⭐ y los SKU siguen PENDIENTES: no se sueltan si no se empujaron', async () => {
      const { svc } = armar({ cola: ['95612', '17064'], falla: 'wix no contesta' });
      await svc.tomarDeLaCola();
      expect(svc.pendientes()).toBe(2);
      await svc.pasada();
      expect(svc.pendientes()).toBe(2);
    });

    it('una cola ilegible no rompe nada: devuelve 0 y sigue', async () => {
      const { svc } = armar();
      const roto = new TiendaSyncPorEventoService(
        { raw: async () => { throw Object.assign(new Error('no existe'), { code: '42P01' }); } } as never,
        { escuchar: () => () => undefined, alConectar: () => () => undefined } as never,
        { empujar: async () => ({ renglones: 0, noPublicados: 0 }) },
      );
      expect(await roto.tomarDeLaCola()).toBe(0);
      expect(roto.pendientes()).toBe(0);
      expect(svc.pendientes()).toBe(0);
    });
  });

  describe('una ráfaga de ventas no se vuelve una tormenta', () => {
    it('empuja como mucho el tope por pasada, y lo que sobra queda pendiente', async () => {
      const muchos = Array.from({ length: TOPE_POR_PASADA + 25 }, (_, i) => `sku-${i}`);
      const { svc, llamadas } = armar({ cola: muchos });
      await svc.tomarDeLaCola();
      expect(svc.pendientes()).toBe(TOPE_POR_PASADA + 25);
      await svc.pasada();
      expect(llamadas[0]).toHaveLength(TOPE_POR_PASADA);
      expect(svc.pendientes()).toBe(25);
    });
  });

  describe('sólo escucha donde corresponde', () => {
    const conEntorno = async (env: Record<string, string | undefined>, f: () => void) => {
      const antes = { WORKER: process.env.WORKER, DISABLE_TIENDA_SYNC: process.env.DISABLE_TIENDA_SYNC };
      Object.assign(process.env, env);
      try { f(); } finally { Object.assign(process.env, antes); }
    };

    it('no escucha si el proceso no es el worker', async () => {
      await conEntorno({ WORKER: undefined, DISABLE_TIENDA_SYNC: undefined }, () => {
        const { svc } = armar();
        let escucho = false;
        (svc as unknown as { listen: unknown }).listen = { escuchar: () => { escucho = true; return () => undefined; }, alConectar: () => () => undefined };
        svc.onModuleInit();
        expect(escucho).toBe(false);
      });
    });

    it('no escucha con DISABLE_TIENDA_SYNC', async () => {
      await conEntorno({ WORKER: 'true', DISABLE_TIENDA_SYNC: 'true' }, () => {
        const { svc } = armar();
        let escucho = false;
        (svc as unknown as { listen: unknown }).listen = { escuchar: () => { escucho = true; return () => undefined; }, alConectar: () => () => undefined };
        svc.onModuleInit();
        expect(escucho).toBe(false);
      });
    });

    it('en el worker SÍ escucha, y el canal es el que ya existe', async () => {
      await conEntorno({ WORKER: 'true', DISABLE_TIENDA_SYNC: undefined }, () => {
        const { svc } = armar();
        const canales: string[] = [];
        (svc as unknown as { listen: unknown }).listen = {
          escuchar: (c: string) => { canales.push(c); return () => undefined; },
          alConectar: () => () => undefined,
        };
        svc.onModuleInit();
        expect(canales).toEqual(['existencia_sucia']);
        svc.onModuleDestroy();
      });
    });
  });
});
