import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SchedulerOwnershipService } from './scheduler-ownership.service';

/**
 * `[DEPLOY.1]` — el apagado NO puede copiar el guard del arranque.
 *
 * Los dos hooks de este servicio hacen lo MISMO (detener crons e intervals) por razones
 * OPUESTAS, y esa asimetría es justo lo que un lector apurado "arregla":
 *
 *  - `onApplicationBootstrap` sale temprano si este proceso ES el dueño de los crons.
 *    Apagarlos ahí dejaría los 65 `@Cron` sin correr en ningún lado.
 *  - `onApplicationShutdown` NO sale nunca, y eso es el punto: el worker es precisamente
 *    quien los corre, y al recibir SIGTERM tiene que dejar de arrancar trabajo nuevo
 *    mientras drena el que ya está en vuelo.
 *
 * Si alguien le copia `if (shouldRunInProcessCron()) return;` al apagado, el arreglo se
 * vuelve no-op EN SILENCIO: el worker seguiría disparando crons durante los 600 s de gracia
 * y volveríamos a matar transacciones, pero ahora con más ventana para que pase. El primer
 * bloque de abajo se pone rojo si eso ocurre.
 */

type Detenible = { stop: () => void };

function registroFalso(opciones: { crons: string[]; intervals: string[]; rompe?: string }) {
  const detenidos: string[] = [];
  const borrados: string[] = [];

  const crons = new Map<string, Detenible>();
  for (const nombre of opciones.crons) {
    crons.set(nombre, {
      stop: () => {
        if (nombre === opciones.rompe) throw new Error(`stop() falló para ${nombre}`);
        detenidos.push(nombre);
      },
    });
  }

  const registry = {
    getCronJobs: () => crons,
    getIntervals: () => [...opciones.intervals],
    deleteInterval: (n: string) => {
      borrados.push(n);
    },
  };

  // El servicio sólo usa estos tres miembros del SchedulerRegistry real.
  return { detenidos, borrados, registry: registry as never };
}

describe('[DEPLOY.1] SchedulerOwnershipService — drenado del worker al apagarse', () => {
  const previo = { ENABLE_WORKER_QUEUE: process.env.ENABLE_WORKER_QUEUE, WORKER: process.env.WORKER };

  beforeEach(() => {
    // Worker-tier encendido Y este proceso ES el worker → shouldRunInProcessCron() === true.
    process.env.ENABLE_WORKER_QUEUE = 'true';
    process.env.WORKER = 'true';
  });

  afterEach(() => {
    if (previo.ENABLE_WORKER_QUEUE === undefined) delete process.env.ENABLE_WORKER_QUEUE;
    else process.env.ENABLE_WORKER_QUEUE = previo.ENABLE_WORKER_QUEUE;
    if (previo.WORKER === undefined) delete process.env.WORKER;
    else process.env.WORKER = previo.WORKER;
  });

  it('en el WORKER: el arranque NO toca nada y el apagado detiene TODO', () => {
    const { detenidos, borrados, registry } = registroFalso({
      crons: ['refrescoMV', 'escanerNocturno', 'feedIntradia'],
      intervals: ['latido'],
    });
    const svc = new SchedulerOwnershipService(registry);

    // Arranque: este proceso ES el dueño, así que los crons quedan vivos.
    svc.onApplicationBootstrap();
    expect(detenidos).toEqual([]);
    expect(borrados).toEqual([]);

    // Apagado: deja de arrancar trabajo nuevo. ⛔ Acá NO hay guard, a propósito.
    svc.onApplicationShutdown('SIGTERM');
    expect(detenidos).toEqual(['refrescoMV', 'escanerNocturno', 'feedIntradia']);
    expect(borrados).toEqual(['latido']);
  });

  it('en el API (no worker): el arranque ya los apagaba — no se rompe esa conducta', () => {
    process.env.WORKER = 'false'; // worker-tier ON y este NO es el worker
    const { detenidos, borrados, registry } = registroFalso({
      crons: ['refrescoMV', 'escanerNocturno'],
      intervals: ['latido'],
    });
    const svc = new SchedulerOwnershipService(registry);

    svc.onApplicationBootstrap();
    expect(detenidos).toEqual(['refrescoMV', 'escanerNocturno']);
    expect(borrados).toEqual(['latido']);
  });

  it('un cron que revienta al detenerse no impide detener a los demás', () => {
    const { detenidos, registry } = registroFalso({
      crons: ['sano1', 'roto', 'sano2'],
      intervals: [],
      rompe: 'roto',
    });
    const svc = new SchedulerOwnershipService(registry);

    expect(() => svc.onApplicationShutdown('SIGTERM')).not.toThrow();
    // El roto no entra, los sanos sí: una falla aislada no deja crons vivos durante el drenado.
    expect(detenidos).toEqual(['sano1', 'sano2']);
  });

  it('sin señal (apagado programático) también detiene todo', () => {
    const { detenidos, registry } = registroFalso({ crons: ['a', 'b'], intervals: [] });
    const svc = new SchedulerOwnershipService(registry);

    svc.onApplicationShutdown();
    expect(detenidos).toEqual(['a', 'b']);
  });
});
