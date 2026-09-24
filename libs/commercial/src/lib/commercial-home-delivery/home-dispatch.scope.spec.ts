import { ForbiddenException } from '@nestjs/common';
import { HomeDispatchService } from './home-dispatch.service';

/**
 * `[ZN.3]` — Reparto: el alcance también aplica cuando NO se pide sucursal.
 *
 * ── El defecto ───────────────────────────────────────────────────────────────────────────────
 * `listRiders` y `listDispatched` filtraban por sucursal **sólo si venía el parámetro**. Sin
 * parámetro no filtraban nada, así que la encargada de La Piedad Abastos veía los repartidores y
 * los despachos de las nueve sucursales. `REPARTO_DESPACHAR` lo tienen **9 personas con alcance
 * acotado** — 6 encargadas de tienda y 3 auxiliares, todas `own` con su sucursal en la ficha.
 *
 * ── Las dos preguntas no se responden igual ──────────────────────────────────────────────────
 *   · pidió una sucursal concreta y no le toca  → **403** (`assertCanRead`): contestarle con otra
 *     sería responder algo que no preguntó;
 *   · no pidió ninguna                          → **lo suyo**, no la red entera (`intersect`).
 *
 * Se prueba con dobles porque el sujeto es la DECISIÓN, que es TypeScript y ocurre antes de la
 * consulta. Lo que se afirma es el `whereIn` que termina en la query — la consulta en sí se sigue
 * probando por HTTP (ADR-044).
 */

/** Doble de knex encadenable que ANOTA por qué columnas y valores se filtró. */
const knexDoble = (registro: Array<{ col: string; vals: string[] }>) => {
  const q: Record<string, unknown> = {};
  for (const m of ['where', 'andWhere', 'whereNull', 'whereRaw', 'leftJoin', 'orderBy', 'select']) {
    q[m] = () => q;
  }
  q['whereIn'] = (col: string, vals: string[]) => {
    registro.push({ col, vals });
    return q;
  };
  // Thenable: `await` sobre la consulta devuelve filas (vacías: no es lo que se mide acá).
  q['then'] = (res: (v: unknown) => unknown) => Promise.resolve([]).then(res);
  return () => q;
};

const armar = (modo: 'all' | 'none' | 'listed' | 'own', values: string[] = []) => {
  const registro: Array<{ col: string; vals: string[] }> = [];
  const scope = {
    assertCanRead: async (_dim: string, valor: string) => {
      const ok = modo === 'all' ? true : modo === 'none' ? false : values.includes(String(valor));
      if (!ok) throw new ForbiddenException(`fuera de alcance: ${valor}`);
    },
    current: async () => ({ dims: { warehouse: { mode: modo, values } } }),
    // Mismo contrato que `ScopeService.intersect`: `null` = no filtrar.
    intersect: (sc: any, dim: string, pedido: string[] | null) => {
      const d = sc.dims[dim];
      const limpio = (pedido ?? []).filter(Boolean);
      if (d.mode === 'all') return limpio.length ? limpio : null;
      if (d.mode === 'none') return [];
      return limpio.length ? limpio.filter((v: string) => d.values.includes(v)) : d.values;
    },
  };
  const svc = new HomeDispatchService(
    { run: async (cb: (trx: unknown) => unknown) => cb(knexDoble(registro)) } as never,
    { requireTenantId: () => 't1' } as never,
    {} as never, // AlertsService: no participa de estos listados
    scope as never,
  );
  return { svc, registro };
};

describe('[ZN.3] HomeDispatchService · el alcance filtra aunque no se pida sucursal', () => {
  it('⭐ SIN parámetro, la encargada de la 02 ve SÓLO la 02 (antes veía las nueve)', async () => {
    const { svc, registro } = armar('listed', ['02']);
    await svc.listRiders({});
    expect(registro).toEqual([{ col: 'warehouse_code', vals: ['02'] }]);
  });

  it('SIN parámetro y con alcance global no se filtra nada — a quien ya veía todo no se le recorta', async () => {
    const { svc, registro } = armar('all');
    await svc.listRiders({});
    expect(registro).toEqual([]);
  });

  it('pedir la sucursal PROPIA pasa y filtra por ella', async () => {
    const { svc, registro } = armar('listed', ['02']);
    await svc.listDispatched({ warehouse_code: '02' });
    expect(registro).toEqual([{ col: 'd.kepler_warehouse_code', vals: ['02'] }]);
  });

  it('⭐ NEGATIVA: pedir una sucursal AJENA da 403 y no llega a filtrar nada', async () => {
    const { svc, registro } = armar('listed', ['02']);
    await expect(svc.listDispatched({ warehouse_code: '05' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(registro).toEqual([]);
  });

  it('alcance `none` filtra a CERO filas, que no es lo mismo que no filtrar', async () => {
    // El caso que un `if (lista.length)` mal escrito convierte en fail-open: `[]` es una
    // respuesta legítima («no te toca ninguna») y tiene que llegar al WHERE.
    const { svc, registro } = armar('none');
    await svc.listRiders({});
    expect(registro).toEqual([{ col: 'warehouse_code', vals: [] }]);
  });
});
