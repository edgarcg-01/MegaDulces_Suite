import knexFactory from 'knex';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PresaleRouteService } from './presale-route.service';
import { PresalePickingService } from './presale-picking.service';
import type { RenglonDeRuta } from './presale-route.engine';

/**
 * `[MCP.3.6]` Las decisiones del servicio de la ruta, con dobles (sin base de datos): quién puede
 * finalizar la ruta y cerrar su surtido, qué pedidos se cierran y a quién se avisa. El reparto está
 * en presale-route.engine.spec.ts; el cierre de cada pedido es `PresalePickingService.cerrarPedido`,
 * el mismo del surtido por pedido.
 */
const T = '00000000-0000-0000-0000-00000000d01c';
const YO = '11111111-1111-1111-1111-111111111111';
const OTRO = '22222222-2222-2222-2222-222222222222';
const RUTA = '44444444-4444-4444-4444-444444444444';

interface Mundo {
  /** La fila de `seller_route_days` que encuentra la consulta. */
  ruta?: Record<string, unknown> | null;
  renglones?: Array<RenglonDeRuta & { warehouse_id: string }>;
  almacenes?: string[] | null;
  /** Lo que contesta el conteo de clientes visitados (`vendor_visits`). */
  visitados?: number;
}

function armar(m: Mundo) {
  const updates: Record<string, Record<string, unknown>[]> = {};
  const raws: string[] = [];
  const wheres: Record<string, unknown[][]> = {};
  const tabla = (nombre: string) => {
    const q: any = {};
    q.where = (...a: unknown[]) => { (wheres[nombre] ??= []).push(a); return q; };
    for (const k of ['whereNull', 'whereNotNull', 'whereIn', 'whereNot', 'select', 'joinRaw', 'join', 'leftJoin', 'distinct']) q[k] = () => q;
    // Sólo la lectura con candado encuentra el surtido del pedido: la de «¿lo tiene otra persona?» no.
    q.forUpdate = () => { q.bloqueado = true; return q; };
    q.first = async () => {
      if (nombre.startsWith('commercial.seller_route_days')) return m.ruta ?? undefined;
      if (nombre.startsWith('commercial.presale_picks')) return q.bloqueado ? { id: 'pk-1', finished_at: null } : undefined;
      if (nombre.startsWith('commercial.vendor_visits')) return { visited: m.visitados ?? 0 };
      if (nombre.startsWith('identity.users')) return { nombre: 'Juan Pérez', username: 'jperez' };
      return undefined;
    };
    // Con `returning` knex devuelve las filas; sin él, el conteo.
    q.update = async (o: Record<string, unknown>, ret?: string[]) => {
      (updates[nombre] ??= []).push(o);
      return ret ? [{ finished_at: '2026-10-21T22:37:43Z' }] : 1;
    };
    q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve([]).then(ok, ko);
    return q;
  };
  const trx: any = Object.assign(tabla, {
    raw: vi.fn(async (sql: string) => { raws.push(sql); return { rows: [] }; }),
    fn: { now: () => 'now()' },
  });
  const tk = { run: vi.fn(async (fn: (t: unknown) => unknown) => fn(trx)) };
  const tenantCtx = { get: () => ({ tenantId: T, userId: YO }) };
  const scope = { warehouseIds: vi.fn(async () => (m.almacenes === undefined ? ['wh-02'] : m.almacenes)) };
  const picking = {
    quien: vi.fn(async () => ({ userId: YO, nombre: 'Juan Pérez' })),
    leer: vi.fn(async (_t: unknown, f: { orderId: string }) => [{ id: f.orderId, code: `PD-${f.orderId}`, total: 100, warehouse_id: 'wh-02', customer_name: `Cliente ${f.orderId}` }]),
    cerrarPedido: vi.fn(async (_t: unknown, _f: unknown, _p: unknown, marcados: Array<{ picked: number }>) => ({
      outcome: marcados.every((x) => x.picked >= 30) ? 'completo' : 'con_faltantes',
      report: marcados.every((x) => x.picked >= 30) ? null : { removed: [], adjusted: [], total_before: 100, total_after: 66.67 },
    })),
  };
  const alerts = { emitTo: vi.fn() };
  const push = { sendToUser: vi.fn(async () => ({ sent: 0, pruned: 0 })) };
  const svc = new PresaleRouteService(tk as any, tenantCtx as any, scope as any, picking as any, alerts as any, push as any);
  const fila = {
    id: RUTA, user_id: 'vend-1', seller_username: '42pmpb', seller_name: 'Rosa', work_date: '2026-10-21',
    started_at: '2026-10-21T14:00:00Z', finished_at: '2026-10-21T20:00:00Z', orders: 3, products: 1,
    pick_started_by: YO, pick_started_by_name: 'Juan Pérez', pick_started_at: '2026-10-21T20:10:00Z',
    pick_finished_by: null, pick_finished_by_name: null, pick_finished_at: null,
  };
  (svc as any).leerRutas = vi.fn(async () => [fila]);
  (svc as any).renglonesDeRuta = vi.fn(async () => m.renglones ?? []);
  return { svc, picking, alerts, push, updates, raws, wheres };
}

let n = 0;
const renglon = (order_id: string, confirmed_at: string): RenglonDeRuta & { warehouse_id: string } => ({
  order_id, code: `PD-${order_id}`, customer_name: `Cliente ${order_id}`, confirmed_at, delivery_date: '2026-10-22',
  line_id: `l${++n}`, product_id: 'paleta', sku: null, barcode: null, product_name: 'PALETA PAYASO', brand: 'RICOLINO',
  quantity: 30, qty_unit: null, qty_factor: null, warehouse_id: 'wh-02',
});
const TRES = () => [
  renglon('A', '2026-10-21T15:00:00Z'),
  renglon('B', '2026-10-21T15:10:00Z'),
  renglon('C', '2026-10-21T15:20:00Z'),
];
const RUTA_SURTIENDO = (quien: string) => ({
  id: RUTA, user_id: 'vend-1', work_date: '2026-10-21', started_at: '2026-10-21T14:00:00Z', finished_at: '2026-10-21T20:00:00Z',
  pick_started_by: quien, pick_started_by_name: quien === YO ? 'Juan Pérez' : 'Ana López', pick_started_at: '2026-10-21T20:10:00Z',
  pick_finished_at: null,
});

describe('PresaleRouteService · el vendedor', () => {
  it('finalizar sin ruta en curso es un Conflict', async () => {
    const { svc } = armar({ ruta: null });
    await expect(svc.finishDay()).rejects.toBeInstanceOf(ConflictException);
  });

  it('finalizar una ruta ya finalizada es un Conflict', async () => {
    const { svc } = armar({ ruta: { id: RUTA, started_at: '2026-10-21T14:00:00Z', finished_at: '2026-10-21T20:00:00Z' } });
    await expect(svc.finishDay()).rejects.toThrow(/No tienes una ruta en curso/);
  });

  it('finalizar la ruta en curso la marca como del vendedor', async () => {
    const { svc, updates } = armar({ ruta: { id: RUTA, started_at: '2026-10-21T14:00:00Z', finished_at: null } });
    await svc.finishDay();
    expect(updates['commercial.seller_route_days']?.[0]).toMatchObject({ finished_how: 'vendedor', updated_by: YO });
  });

  it('[MCP.3.6] al finalizar se abre la tanda «fuera de la ruta» desde la hora de cierre', async () => {
    const { svc, raws } = armar({ ruta: { id: RUTA, started_at: '2026-10-21T14:00:00Z', finished_at: null } });
    await svc.finishDay();
    const ins = raws.find((s) => /'fuera_de_ruta'/.test(s));
    expect(ins).toMatch(/INSERT INTO commercial\.seller_route_days/);
    expect(ins).toMatch(/kind = 'fuera_de_ruta' AND finished_at IS NULL/);
  });

  it('[MCP.3.6] la ruta dice cuántos clientes DISTINTOS visitó la persona dentro de su ventana', async () => {
    const { svc, wheres } = armar({ ruta: { id: RUTA, started_at: '2026-10-21T14:00:00Z', finished_at: '2026-10-21T20:00:00Z' }, visitados: 9 });
    const d = await svc.myDay();
    expect(d.visited).toBe(9);
    const w = wheres['commercial.vendor_visits'] ?? [];
    expect(w).toContainEqual(['user_id', YO]);
    expect(w).toContainEqual(['visited_at', '>=', '2026-10-21T14:00:00Z']);
    expect(w).toContainEqual(['visited_at', '<=', '2026-10-21T20:00:00Z']);
  });

  it('[MCP.3.6] en ruta (sin finalizar) cuenta las visitas hasta AHORA', async () => {
    const { svc, wheres } = armar({ ruta: { id: RUTA, started_at: '2026-10-21T14:00:00Z', finished_at: null }, visitados: 4 });
    const d = await svc.myDay();
    expect(d.visited).toBe(4);
    expect(wheres['commercial.vendor_visits']).toContainEqual(['visited_at', '<=', 'now()']);
  });

  it('[MCP.3.6] sin ruta iniciada: 0 visitados y ni se consulta', async () => {
    const { svc, wheres } = armar({ ruta: null, visitados: 7 });
    const d = await svc.myDay();
    expect(d).toMatchObject({ state: 'sin_iniciar', visited: 0 });
    expect(wheres['commercial.vendor_visits']).toBeUndefined();
  });

  it('[MCP.3.6] al finalizar, la respuesta trae los clientes visitados', async () => {
    const { svc } = armar({ ruta: { id: RUTA, started_at: '2026-10-21T14:00:00Z', finished_at: null }, visitados: 3 });
    const d = await svc.finishDay();
    expect(d.visited).toBe(3);
  });

  it('iniciar una ruta ya finalizada no la reabre', async () => {
    const { svc, raws } = armar({ ruta: { id: RUTA, started_at: '2026-10-21T14:00:00Z', finished_at: '2026-10-21T20:00:00Z' } });
    await expect(svc.startDay()).rejects.toThrow(/ya se finalizó/);
    expect(raws.some((s) => /INSERT INTO commercial\.seller_route_days/.test(s))).toBe(false);
  });

  it('iniciar sin ruta la crea, idempotente por el índice del día', async () => {
    const { svc, raws } = armar({ ruta: null });
    await svc.startDay();
    expect(raws.find((s) => /INSERT INTO commercial\.seller_route_days/.test(s))).toMatch(/ON CONFLICT \(tenant_id, user_id, work_date\) WHERE deleted_at IS NULL AND kind = 'ruta' DO NOTHING/);
  });
});

describe('PresaleRouteService · el surtidor', () => {
  it('sólo quien empezó la ruta la puede cerrar', async () => {
    const { svc, picking } = armar({ ruta: RUTA_SURTIENDO(OTRO), renglones: TRES() });
    await expect(svc.routeFinish(RUTA, { products: [{ product_id: 'paleta', picked: 90 }] })).rejects.toBeInstanceOf(ForbiddenException);
    expect(picking.cerrarPedido).not.toHaveBeenCalled();
  });

  it('sin «Empezar a surtir» no se cierra', async () => {
    const { svc } = armar({ ruta: { ...RUTA_SURTIENDO(YO), pick_started_by: null }, renglones: TRES() });
    await expect(svc.routeFinish(RUTA, { products: [] })).rejects.toThrow(/Empezar a surtir/);
  });

  it('no se empieza a surtir una ruta que el vendedor no ha finalizado', async () => {
    const { svc } = armar({ ruta: { ...RUTA_SURTIENDO(YO), finished_at: null, pick_started_by: null }, renglones: TRES() });
    await expect(svc.routeStart(RUTA)).rejects.toThrow(/sigue abierta/);
  });

  it('si otra persona ya la está surtiendo, lo dice con su nombre', async () => {
    const { svc } = armar({ ruta: RUTA_SURTIENDO(OTRO), renglones: TRES() });
    await expect(svc.routeStart(RUTA)).rejects.toThrow(/Ya la está surtiendo Ana López/);
  });

  it('[MCP.3.6] la tanda «fuera de la ruta» se recolecta sin que el vendedor la finalice, y empezar la CIERRA y abre la siguiente', async () => {
    const { svc, raws, updates } = armar({
      ruta: { ...RUTA_SURTIENDO(YO), kind: 'fuera_de_ruta', finished_at: null, pick_started_by: null },
      renglones: TRES(),
    });
    await svc.routeStart(RUTA);
    expect(updates['commercial.seller_route_days']?.[0]).toHaveProperty('finished_at');
    expect(raws.find((s) => /'fuera_de_ruta'/.test(s))).toMatch(/SELECT tenant_id, user_id, work_date, 'fuera_de_ruta'/);
    expect(raws.filter((s) => /INSERT INTO commercial\.presale_picks/.test(s))).toHaveLength(3);
  });

  it('empezar abre el surtido de cada pedido de la ruta', async () => {
    const { svc, raws } = armar({ ruta: { ...RUTA_SURTIENDO(YO), pick_started_by: null }, renglones: TRES() });
    await svc.routeStart(RUTA);
    expect(raws.filter((s) => /INSERT INTO commercial\.presale_picks/.test(s))).toHaveLength(3);
  });

  it('80 de 90: cierra cada pedido con su parte y avisa a la vendedora UNA vez', async () => {
    const { svc, picking, alerts, updates } = armar({ ruta: RUTA_SURTIENDO(YO), renglones: TRES() });
    const r = await svc.routeFinish(RUTA, { products: [{ product_id: 'paleta', picked: 80 }] });
    expect(picking.cerrarPedido).toHaveBeenCalledTimes(3);
    expect(r.bags.map((b) => [b.code, b.outcome, b.lines[0].picked])).toEqual([
      ['PD-A', 'completo', 30], ['PD-B', 'completo', 30], ['PD-C', 'con_faltantes', 20],
    ]);
    expect(updates['commercial.seller_route_days']?.[0]).toMatchObject({ pick_finished_by: YO, pick_finished_by_name: 'Juan Pérez' });
    expect(alerts.emitTo).toHaveBeenCalledTimes(1);
    expect(alerts.emitTo).toHaveBeenCalledWith(T, '42pmpb', expect.objectContaining({ title: 'Reporte de surtido de tu ruta: 1 de 3 pedidos con faltantes' }));
  });

  it('un pedido al que no le tocó nada NO se cierra: se reporta sin_mercancia', async () => {
    const { svc, picking } = armar({ ruta: RUTA_SURTIENDO(YO), renglones: TRES() });
    const r = await svc.routeFinish(RUTA, { products: [{ product_id: 'paleta', picked: 60 }] });
    expect(picking.cerrarPedido).toHaveBeenCalledTimes(2);
    expect(r.bags.find((b) => b.code === 'PD-C')).toMatchObject({ outcome: 'sin_mercancia', total_before: 100, total_after: 100 });
  });

  it('un marcado inválido es un 400 y no se cierra ningún pedido', async () => {
    const { svc, picking } = armar({ ruta: RUTA_SURTIENDO(YO), renglones: TRES() });
    await expect(svc.routeFinish(RUTA, { products: [{ product_id: 'paleta', picked: 91 }] })).rejects.toBeInstanceOf(BadRequestException);
    expect(picking.cerrarPedido).not.toHaveBeenCalled();
  });

  it('sin sucursal en el alcance no se surte nada', async () => {
    const { svc } = armar({ almacenes: [], ruta: RUTA_SURTIENDO(YO) });
    await expect(svc.routeStart(RUTA)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('PresalePickingService.leer · la bandeja de siempre', () => {
  // Knex de verdad, sin conexión: sólo para ver el SQL que arma.
  const k = knexFactory({ client: 'pg' });
  const sqlDe = (f: Record<string, unknown>): string => {
    let qb: any;
    const trx: any = Object.assign((t: string) => {
      qb = k(t);
      qb.then = (ok: (v: unknown) => unknown) => Promise.resolve([]).then(ok);
      return qb;
    }, { raw: k.raw.bind(k) });
    const svc = new PresalePickingService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    void svc.leer(trx, { almacenes: null, ...f });
    return qb.toString();
  };

  it('lo que es de una ruta no sale suelto (NOT EXISTS sobre seller_route_days)', () => {
    const sql = sqlDe({ desde: '2026-09-21' });
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM commercial\.seller_route_days rd WHERE rd\.tenant_id = o\.tenant_id/);
    expect(sql).toMatch(/o\.confirmed_at >= rd\.started_at/);
  });

  it('la ruta sí lee sus propios pedidos', () => {
    expect(sqlDe({ orderId: 'x', incluirRutas: true })).not.toMatch(/seller_route_days/);
  });
});
