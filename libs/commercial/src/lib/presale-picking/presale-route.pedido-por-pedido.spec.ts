import knexFactory from 'knex';
import { ConflictException } from '@nestjs/common';
import { PresaleRouteService } from './presale-route.service';
import { PresalePickingService } from './presale-picking.service';
import { SURTIDO_DE_RUTA } from './presale-route.engine';

/**
 * `[MCP.3.15]` La preventa llega al surtidor PEDIDO POR PEDIDO, en cuanto el vendedor la manda
 * (David, 2026-10-26). Con el surtido de ruta apagado: la bandeja suelta trae lo de una ruta abierta,
 * no se listan rutas para surtir (duplicarían los pedidos), no se empieza una ruta y «Finalizar ruta»
 * no avisa al surtidor. El modo ruta sigue probado en presale-route.service.spec.ts.
 */
const T = '00000000-0000-0000-0000-00000000d01c';
const YO = '11111111-1111-1111-1111-111111111111';
const RUTA = '44444444-4444-4444-4444-444444444444';

/** Lo mínimo para el servicio de la ruta, sin base. `ruta` = la fila de `seller_route_days` que encuentra. */
function armar(ruta: Record<string, unknown> | null) {
  const updates: Array<Record<string, unknown>> = [];
  const tabla = (): Record<string, unknown> => {
    const q: Record<string, unknown> = {};
    for (const k of ['where', 'whereNull', 'whereNotNull', 'whereIn', 'select', 'joinRaw', 'join', 'leftJoin', 'forUpdate', 'orderBy', 'orderByRaw']) q[k] = () => q;
    q['first'] = async () => ruta ?? undefined;
    q['update'] = async (o: Record<string, unknown>, ret?: string[]) => { updates.push(o); return ret ? [{ finished_at: '2026-10-26T22:00:00Z' }] : 1; };
    q['then'] = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve([{ visited: 0 }]).then(ok, ko);
    return q;
  };
  const trx = Object.assign(tabla, { raw: vi.fn(async () => ({ rows: [] })), fn: { now: () => 'now()' } });
  const tk = { run: vi.fn(async (fn: (t: unknown) => unknown) => fn(trx)) };
  const tenantCtx = { get: () => ({ tenantId: T, userId: YO }) };
  const scope = { warehouseIds: vi.fn(async () => ['wh-02']) };
  const alerts = { emitTo: vi.fn() };
  const push = { sendToUser: vi.fn(async () => ({ sent: 0, pruned: 0 })) };
  const picking = { quien: vi.fn(async () => ({ userId: YO, nombre: 'Juan Pérez' })) };
  const svc = new PresaleRouteService(tk as never, tenantCtx as never, scope as never, picking as never, alerts as never, push as never);
  // Si el modo ruta estuviera prendido, esto sería lo que listaría: una ruta con 3 pedidos.
  const leerRutas = vi.fn(async () => [{ id: RUTA, orders: 3 }]);
  Object.assign(svc, { leerRutas });
  return { svc, alerts, updates, leerRutas };
}

describe('[MCP.3.15] La preventa llega pedido por pedido', () => {
  it('la decisión vigente: el surtido de ruta está apagado', () => {
    expect(SURTIDO_DE_RUTA).toBe(false);
  });

  it('no se listan rutas para surtir (sus pedidos ya están en la bandeja suelta)', async () => {
    const { svc, leerRutas } = armar(null);
    const r = await svc.routes();
    expect(r.data).toEqual([]);
    expect(r.scope).toBe('propios');
    expect(leerRutas).not.toHaveBeenCalled();
  });

  it('empezar a surtir una ruta se rechaza y dice dónde están sus pedidos', async () => {
    const { svc } = armar({ id: RUTA, kind: 'ruta', finished_at: '2026-10-26T20:00:00Z' });
    const p = svc.routeStart(RUTA);
    await expect(p).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.routeStart(RUTA)).rejects.toThrow(/pedido por pedido/);
  });

  it('«Finalizar ruta» cierra la ruta del vendedor y NO avisa al surtidor', async () => {
    const { svc, alerts, updates } = armar({ id: RUTA, started_at: '2026-10-26T14:00:00Z', finished_at: null });
    await svc.finishDay();
    expect(updates[0]).toMatchObject({ finished_how: 'vendedor', updated_by: YO });
    expect(alerts.emitTo).not.toHaveBeenCalled();
  });
});

describe('[MCP.3.15] La bandeja suelta del surtidor', () => {
  // Knex de verdad, sin conexión: sólo para ver el SQL que arma.
  const k = knexFactory({ client: 'pg' });
  const sqlDe = (f: Record<string, unknown>): string => {
    let qb: ReturnType<typeof k> | null = null;
    const trx = Object.assign((t: string) => {
      const q = k(t);
      Object.assign(q, { then: (ok: (v: unknown) => unknown) => Promise.resolve([]).then(ok) });
      qb = q;
      return q;
    }, { raw: k.raw.bind(k) });
    const svc = new PresalePickingService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    void svc.leer(trx as never, { almacenes: null, ...f });
    return String(qb);
  };

  it('lo levantado en una ruta abierta también llega suelto (sin el NOT EXISTS de la ruta)', () => {
    const sql = sqlDe({ desde: '2026-10-20' });
    expect(sql).not.toMatch(/seller_route_days/);
    expect(sql).toMatch(/"o"\."status" = 'confirmed'/);
  });

  it('trae las indicaciones del vendedor (orders.notes)', () => {
    expect(sqlDe({ desde: '2026-10-20' })).toMatch(/"o"\."notes"/);
  });

  it('el renglón lleva las indicaciones limpias; sin texto = null', () => {
    const svc = new PresalePickingService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    const aRenglon = (notes: unknown) =>
      (svc as unknown as { aRenglon: (f: Record<string, unknown>, h: string) => { instructions?: string | null } })
        .aRenglon({ id: 'o1', code: 'P-1', requested_delivery_date: '2026-10-26', notes }, '2026-10-26');
    expect(aRenglon('  Las Sabritas con caducidad de diciembre.  ').instructions).toBe('Las Sabritas con caducidad de diciembre.');
    expect(aRenglon('   ').instructions).toBeNull();
    expect(aRenglon(null).instructions).toBeNull();
  });
});
