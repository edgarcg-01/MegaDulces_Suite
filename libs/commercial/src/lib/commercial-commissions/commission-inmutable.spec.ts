import { CommercialCommissionsService } from './commercial-commissions.service';

/**
 * `[RD.22]` — **Una corrida de comisiones es un valor congelado.**
 *
 * Se escribe una vez, con el periodo ya cerrado, y no se vuelve a tocar. Esto fija las tres
 * reglas que lo sostienen, y las tres **tienen que poder romperse**:
 *
 *  1. **Lo pagado no se edita jamas.** Ni con `replace`. Es el registro de un deposito que ya
 *     ocurrio: si la escala cambia con efecto retroactivo, la diferencia va como ajuste en la
 *     quincena siguiente. Reescribirlo dejaria el historial sin coincidir con lo depositado.
 *  2. **Lo aprobado tampoco, en silencio.** Lleva una firma: se anula a mano primero, y ese
 *     acto queda registrado.
 *  3. **Una quincena abierta no se guarda.** Guardarla obligaba a reescribirla cada 30 min, que
 *     es una cifra de nomina moviendose sola. La vista previa SI puede mirarla: no deja fila.
 *
 * ⚠️ Esto NO ejecuta SQL: los dobles de knex no validan una consulta (lo pago este repo con 13
 * tests verdes y el login de prod en 500). Lo que se comprueba aca es el **flujo de control** --
 * a quien se le niega escribir y a quien no -- que es exactamente donde vive la regla. La parte
 * que si toca la base la cubre `database/tests/test-newdb-rd-commission-base.js`.
 */

/** Un `trx` falso que devuelve la corrida viva que le pidan y anota lo que se intento borrar. */
function trxCon(viva: Record<string, unknown> | undefined) {
  const borrados: string[] = [];
  const insertados: string[] = [];
  const qb = (tabla: string): Record<string, (...a: unknown[]) => unknown> => {
    const self: Record<string, (...a: unknown[]) => unknown> = {
      where: () => self, whereNull: () => self, whereNot: () => self,
      first: async () => (tabla === 'commercial.commission_runs' ? viva : undefined),
      del: async () => { borrados.push(tabla); return 1; },
      insert: (...a: unknown[]) => { insertados.push(tabla); return { returning: async () => [{ id: 'nueva' }] , then: (f: (v: unknown) => unknown) => f(undefined) } as never; },
      returning: async () => [{ id: 'nueva' }],
    };
    return self;
  };
  const trx = ((tabla: string) => qb(tabla)) as unknown as Record<string, unknown>;
  (trx as { fn?: unknown }).fn = { now: () => 'now()' };
  return { trx, borrados, insertados };
}

const PERIODO = { id: 'p1', anio: 2026, period_no: 20 };
const ESCALA = { id: 's1' };

function servicio() {
  const tenantCtx = { get: () => ({ userId: 'u1' }), requireTenantId: () => 't1' } as never;
  const tk = { run: async (cb: (t: unknown) => unknown) => cb(null) } as never;
  return new CommercialCommissionsService(tk, tenantCtx);
}

/** `persist` es privado a proposito: la regla no se expone, se aplica. Se llama por el borde. */
function persist(svc: CommercialCommissionsService, trx: unknown, ctx: Record<string, unknown>) {
  return (svc as unknown as {
    persist: (
      t: unknown, ten: string, p: unknown, s: unknown,
      tot: Record<string, number>, lines: unknown[], c: Record<string, unknown>,
    ) => Promise<string>;
  }).persist(trx, 't1', PERIODO, ESCALA, {}, [], ctx);
}

describe('[RD.22] la corrida es un valor congelado', () => {
  // Candado del propio doble: si `trxCon` devolviera siempre `undefined`, los tres casos de
  // abajo pasarian por vacuidad -- nunca habria corrida viva que proteger y el archivo se
  // pondria verde sin mirar nada.
  it('el doble devuelve la corrida viva que se le pide', async () => {
    const { trx } = trxCon({ id: 'r1', status: 'pagado' });
    const fila = await (trx as unknown as (t: string) => { first: () => Promise<unknown> })
      ('commercial.commission_runs').first();
    expect(fila).toEqual({ id: 'r1', status: 'pagado' });
  });

  /**
   * ⚠️ **Una aclaracion que salio de mutar este archivo, no de leerlo.** Al apagar el freno de
   * `pagado` el test siguio VERDE: la red de abajo (`!['borrador','bloqueada'].includes(...)`)
   * tambien rechaza, y su mensaje dice *"No se reemplaza una corrida pagado"* -- o sea que mi
   * `toThrow(/pagad/i)` casaba con el mensaje equivocado y pasaba por la razon equivocada.
   *
   * Lo que el freno explicito SI agrega es el mensaje correcto: sin el, pedir esto con
   * `replace: false` responde *"Usa replace=true"*, que para una corrida pagada es una
   * instruccion **activamente equivocada**. Por eso se afirma la frase que solo produce este
   * freno, y no una palabra que las dos ramas comparten.
   */
  it('NO reescribe una corrida pagada, y lo dice bien: no manda a reintentar con replace', async () => {
    const { trx, borrados } = trxCon({ id: 'r1', status: 'pagado' });
    await expect(persist(servicio(), trx, { replace: true, status: 'borrador', gates: [], dataAsOf: null }))
      .rejects.toThrow(/ajuste en la quincena siguiente/i);
    // Y lo que de verdad importa: no alcanzo a borrar nada.
    expect(borrados).toEqual([]);
  });

  it('NO reescribe una corrida aprobada: hay que anularla a mano, y explica por que', async () => {
    const { trx, borrados } = trxCon({ id: 'r1', status: 'aprobado' });
    await expect(persist(servicio(), trx, { replace: true, status: 'borrador', gates: [], dataAsOf: null }))
      .rejects.toThrow(/sin dejar rastro/i);
    expect(borrados).toEqual([]);
  });

  /**
   * ⭐ **El cambio de comportamiento real de RD.22.** `en_curso` estaba en la lista de
   * reemplazables, porque el cron de cada 30 min pisaba su propia corrida de la quincena
   * abierta. Sin cron no se produce mas, pero la tabla admite el valor y una fila vieja podria
   * traerlo: si siguiera siendo reemplazable, el unico estado que nadie firmo seria tambien el
   * unico que se puede sobrescribir sin que quede registro.
   */
  it('una corrida en_curso YA NO se reemplaza: ese estado dejo de producirse', async () => {
    const { trx, borrados } = trxCon({ id: 'r1', status: 'en_curso' });
    await expect(persist(servicio(), trx, { replace: true, status: 'borrador', gates: [], dataAsOf: null }))
      .rejects.toThrow(/No se reemplaza/i);
    expect(borrados).toEqual([]);
  });

  // ⭐ La prueba NEGATIVA. Sin esto, un `persist` que rechazara TODO pasaria los dos casos de
  // arriba y romperia el unico camino que de verdad hace falta: recalcular un borrador.
  it('SI reemplaza un borrador cuando se lo piden (si no, no se podria recalcular nada)', async () => {
    const { trx, borrados } = trxCon({ id: 'r1', status: 'borrador' });
    await expect(persist(servicio(), trx, { replace: true, status: 'borrador', gates: [], dataAsOf: null }))
      .resolves.toBeDefined();
    expect(borrados).toContain('commercial.commission_runs');
  });

  it('una bloqueada tambien se reemplaza: es el caso de "se arreglo el dato y se vuelve a correr"', async () => {
    const { trx, borrados } = trxCon({ id: 'r1', status: 'bloqueada' });
    await expect(persist(servicio(), trx, { replace: true, status: 'borrador', gates: [], dataAsOf: null }))
      .resolves.toBeDefined();
    expect(borrados).toContain('commercial.commission_runs');
  });

  it('sin replace no pisa nada, aunque sea un borrador', async () => {
    const { trx, borrados } = trxCon({ id: 'r1', status: 'borrador' });
    await expect(persist(servicio(), trx, { status: 'borrador', gates: [], dataAsOf: null }))
      .rejects.toThrow(/replace/i);
    expect(borrados).toEqual([]);
  });
});

/**
 * El periodo abierto. Se ejerce `computeRun` de verdad: con un `trx` que devuelve una quincena
 * que todavia corre, tiene que rechazar **sin hacer una sola consulta mas** -- el freno va antes
 * del calculo, que cuesta 8.5 s.
 */
describe('[RD.22] una quincena que todavia corre no se guarda', () => {
  function svcConPeriodo(date_to: string, hoy: string) {
    let consultas = 0;
    const trx = Object.assign(
      (_t: string) => ({ where: () => ({ whereNull: () => ({ first: async () => undefined }) }) }),
      {
        raw: async (sql: string) => {
          consultas += 1;
          if (/commission_periods/.test(sql)) {
            return { rows: [{ id: 'p1', anio: 2026, period_no: 20, date_from: '2026-10-01', date_to, pay_date: null, hoy }] };
          }
          return { rows: [] };
        },
      },
    );
    const tenantCtx = { get: () => ({ userId: 'u1' }), requireTenantId: () => 't1' } as never;
    const tk = { run: async (cb: (t: unknown) => unknown) => cb(trx) } as never;
    return { svc: new CommercialCommissionsService(tk, tenantCtx), contar: () => consultas };
  }

  it('rechaza el periodo abierto ANTES de calcular (una sola consulta: la del periodo)', async () => {
    const { svc, contar } = svcConPeriodo('2026-10-15', '2026-10-07');
    await expect(svc.computeRun('p1')).rejects.toThrow(/todavia corre|cierra el/i);
    expect(contar()).toBe(1);
  });

  /**
   * ⭐ La prueba negativa del freno: el "hoy" sale de la DB (`current_date`), no de
   * `new Date()`. Con el reloj del proceso en UTC, entre las 18:00 y la medianoche de Mexico
   * el dia se adelanta y una quincena que cierra HOY se daria por cerrada seis horas antes.
   * Aca el ultimo dia del periodo ES hoy, asi que **no** debe frenar por periodo abierto.
   */
  it('el ultimo dia de la quincena ya cuenta como cerrada: no frena por "todavia corre"', async () => {
    const { svc } = svcConPeriodo('2026-10-07', '2026-10-07');
    await expect(svc.computeRun('p1')).rejects.not.toThrow(/todavia corre/i);
  });

  it('la vista previa SI puede mirar el periodo abierto: no deja fila', async () => {
    const { svc } = svcConPeriodo('2026-10-15', '2026-10-07');
    // Avanza mas alla del freno (muere despues, en la escala, que este doble no provee).
    await expect(svc.computeRun('p1', { dryRun: true })).rejects.not.toThrow(/todavia corre/i);
  });
});
