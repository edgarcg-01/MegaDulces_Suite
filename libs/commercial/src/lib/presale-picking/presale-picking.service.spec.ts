import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PresalePickingService } from './presale-picking.service';

/**
 * `[MCP.3]` + `[MCP.8]` Las decisiones del servicio, con dobles (sin base de datos): quién puede
 * empezar y cerrar un surtido, cuándo se toca el pedido y a quién se avisa. Las reglas puras
 * (pestañas, plan de cierre, detección del cobro) están en presale-picking.engine.spec.ts; lo que
 * hace cumplir la tabla (un surtido por pedido, cierre coherente) lo prueba la migración con su
 * prueba negativa.
 */
const T = '00000000-0000-0000-0000-00000000d01c';
const YO = '11111111-1111-1111-1111-111111111111';
const OTRO = '22222222-2222-2222-2222-222222222222';
const PEDIDO = '33333333-3333-3333-3333-333333333333';

interface Mundo {
  pick?: Record<string, unknown> | null;
  lineas?: Array<Record<string, unknown>>;
  enOla?: boolean;
  almacenes?: string[] | null;
  /** [MCP.3.13] Columnas del grupo que trae `leer` (pedido agrupado). */
  grupo?: Record<string, unknown>;
}

function armar(m: Mundo) {
  const updates: Record<string, Record<string, unknown>[]> = {};
  const raws: string[] = [];
  const tabla = (nombre: string) => {
    const resultado = () => {
      if (nombre.startsWith('commercial.presale_picks')) return { first: m.pick ?? undefined, rows: m.pick ? [m.pick] : [] };
      if (nombre.startsWith('commercial.order_lines')) return { first: undefined, rows: m.lineas ?? [] };
      if (nombre.startsWith('identity.users')) return { first: { nombre: 'Juan Pérez', username: 'jperez' }, rows: [] };
      return { first: undefined, rows: [] };
    };
    const q: any = {};
    for (const k of ['where', 'whereNull', 'whereNotNull', 'leftJoin', 'orderBy', 'forUpdate', 'whereIn', 'whereExists', 'andWhere', 'select']) {
      q[k] = () => q;
    }
    q.first = async () => resultado().first;
    q.update = async (o: Record<string, unknown>) => { (updates[nombre] ??= []).push(o); return 1; };
    q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(resultado().rows).then(ok, ko);
    return q;
  };
  const trx: any = Object.assign(tabla, {
    raw: vi.fn(async (sql: string) => { raws.push(sql); return { rows: [] }; }),
    fn: { now: () => 'now()' },
  });
  const tk = { run: vi.fn(async (fn: (t: unknown) => unknown) => fn(trx)) };
  const tenantCtx = { get: () => ({ tenantId: T, userId: YO }), requireTenantId: () => T };
  const scope = { warehouseIds: vi.fn(async () => (m.almacenes === undefined ? ['wh-02'] : m.almacenes)) };
  const orders = { recortarTrasSurtido: vi.fn(async () => ({ total_before: 1584.84, total_after: 1219.26 })) };
  const presale = { pedidosParaGuias: vi.fn(async () => []), candidatosParaCampo: vi.fn() };
  const alerts = { emitTo: vi.fn() };
  const push = { sendToUser: vi.fn(async () => ({ sent: 0, pruned: 0 })) };
  const svc = new PresalePickingService(tk as any, tenantCtx as any, scope as any, orders as any, presale as any, alerts as any, push as any);
  const fila = {
    id: PEDIDO, code: 'PD-2026-00072', total: 1584.84, warehouse_id: 'wh-02', user_id: 'vend-1',
    seller_username: '42pmpb', customer_name: 'ABARROTES ROSY', requested_delivery_date: '2026-10-14',
    confirmed_at: '2026-10-14T15:42:00Z', lines: 2, en_ola: !!m.enOla,
    started_at: m.pick?.['started_at'] ?? null, started_by: m.pick?.['started_by'] ?? null, started_by_name: m.pick?.['started_by_name'] ?? null,
    ...m.grupo,
  };
  (svc as any).leer = vi.fn(async () => [fila]);
  return { svc, orders, alerts, push, updates, raws };
}

const LINEAS = [
  { id: 'l1', quantity: 5, qty_unit: 'PAQ', qty_factor: 1, line_total: 161.4, product_name: 'BOMBON GRANDE' },
  { id: 'l2', quantity: 1, qty_unit: 'CJA', qty_factor: 1, line_total: 314.04, product_name: 'SALSA MAGA 1 1/2' },
];
const ABIERTO_POR = (quien: string) => ({ id: 'pk-1', order_id: PEDIDO, started_by: quien, started_by_name: quien === YO ? 'Juan Pérez' : 'Ana López', started_at: '2026-10-14T15:43:00Z', finished_at: null });

describe('PresalePickingService · empezar a surtir', () => {
  it('registra a quien empieza y avisa a la vendedora', async () => {
    const { svc, raws, alerts, updates } = armar({ pick: ABIERTO_POR(YO) });
    await svc.start(PEDIDO);
    expect(raws.some((s) => /INSERT INTO commercial\.presale_picks/.test(s))).toBe(true);
    // Empezar a surtir es el acuse del aviso de la sucursal.
    expect(updates['commercial.order_notifications']?.[0]).toMatchObject({ seen_by: YO });
    expect(alerts.emitTo).toHaveBeenCalledWith(T, '42pmpb', expect.objectContaining({ type: 'presale_pick' }));
  });

  it('si ya lo está surtiendo otra persona, lo dice con su nombre', async () => {
    const { svc } = armar({ pick: ABIERTO_POR(OTRO) });
    await expect(svc.start(PEDIDO)).rejects.toThrow(/Ya lo está surtiendo Ana López/);
  });

  it('no se empieza si ya va en un recorrido de la consola', async () => {
    const { svc } = armar({ pick: null, enOla: true });
    await expect(svc.start(PEDIDO)).rejects.toBeInstanceOf(ConflictException);
  });

  it('sin sucursal en el alcance no se surte nada', async () => {
    const { svc } = armar({ almacenes: [] });
    await expect(svc.start(PEDIDO)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rechaza un id mal formado', async () => {
    const { svc } = armar({});
    await expect(svc.start('no-es-uuid')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PresalePickingService · terminar', () => {
  it('si hubo todo, no toca el pedido y avisa que se surtió completo', async () => {
    const { svc, orders, alerts, updates } = armar({ pick: ABIERTO_POR(YO), lineas: LINEAS });
    const r = await svc.finish(PEDIDO, { lines: [{ line_id: 'l1', picked: 5 }, { line_id: 'l2', picked: 1 }] });
    expect(r.outcome).toBe('completo');
    expect(r.report).toBeNull();
    expect(orders.recortarTrasSurtido).not.toHaveBeenCalled();
    expect(updates['commercial.presale_picks']?.[0]).toMatchObject({ outcome: 'completo', finished_by: YO, finished_by_name: 'Juan Pérez' });
    expect(alerts.emitTo).toHaveBeenCalledWith(T, '42pmpb', expect.objectContaining({ title: 'Tu pedido se surtió completo' }));
  });

  it('con faltantes quita lo que no hubo, guarda el reporte y se lo manda a la vendedora', async () => {
    const { svc, orders, alerts, updates, push } = armar({ pick: ABIERTO_POR(YO), lineas: LINEAS });
    const r = await svc.finish(PEDIDO, { lines: [{ line_id: 'l1', picked: 3 }, { line_id: 'l2', picked: 0 }] });
    expect(r.outcome).toBe('con_faltantes');
    expect(orders.recortarTrasSurtido).toHaveBeenCalledWith(
      expect.anything(), PEDIDO,
      expect.objectContaining({ quitar: ['l2'], recortar: [{ line_id: 'l1', quantity: 3 }] }),
      expect.stringContaining('Juan Pérez'),
    );
    expect(r.report).toMatchObject({ total_before: 1584.84, total_after: 1219.26 });
    expect(JSON.parse(updates['commercial.presale_picks'][0]['report'] as string).removed[0].product_name).toBe('SALSA MAGA 1 1/2');
    expect(alerts.emitTo).toHaveBeenCalledWith(T, '42pmpb', expect.objectContaining({ title: 'Reporte de surtido: faltó 2 productos' }));
    await Promise.resolve();
    expect(push.sendToUser).toHaveBeenCalledWith('vend-1', expect.objectContaining({ url: '/vendor/mis-pedidos' }));
  });

  it('sólo quien empezó lo puede cerrar', async () => {
    const { svc } = armar({ pick: ABIERTO_POR(OTRO), lineas: LINEAS });
    await expect(svc.finish(PEDIDO, { lines: [{ line_id: 'l1', picked: 5 }, { line_id: 'l2', picked: 1 }] }))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('sin «Empezar a surtir» no se cierra', async () => {
    const { svc } = armar({ pick: null, lineas: LINEAS });
    await expect(svc.finish(PEDIDO, { lines: [] })).rejects.toThrow(/Empezar a surtir/);
  });

  it('un cierre ya hecho no se repite', async () => {
    const { svc } = armar({ pick: { ...ABIERTO_POR(YO), finished_at: '2026-10-14T15:47:00Z' }, lineas: LINEAS });
    await expect(svc.finish(PEDIDO, { lines: [] })).rejects.toThrow(/ya se terminó/);
  });

  it('un marcado inválido es un 400, no un pedido a medias', async () => {
    const { svc, orders } = armar({ pick: ABIERTO_POR(YO), lineas: LINEAS });
    await expect(svc.finish(PEDIDO, { lines: [{ line_id: 'l1', picked: 5 }] })).rejects.toBeInstanceOf(BadRequestException);
    expect(orders.recortarTrasSurtido).not.toHaveBeenCalled();
  });
});

/** [MCP.3.13] Una parte de LPA del pedido P-10482, cuya otra parte se surte en PH. */
const PARTE_LPA = {
  warehouse_name: 'La Piedad Abastos', group_id: 'g-1', group_code: 'P-10482', group_parts: 2, group_other_warehouses: ['PH'],
};

describe('[MCP.3.13] pedido agrupado · bandeja y avisos', () => {
  it('el renglón de una parte trae el folio del principal, las partes y las OTRAS sucursales', async () => {
    const { svc } = armar({ grupo: PARTE_LPA });
    const r = await svc.inbox();
    expect(r.data[0]).toMatchObject({ group_code: 'P-10482', group_parts: 2, group_other_warehouses: ['PH'] });
  });

  it('un pedido suelto trae null / null / [] (no se inventa grupo)', async () => {
    const { svc } = armar({});
    const r = await svc.inbox();
    expect(r.data[0]).toMatchObject({ group_code: null, group_parts: null, group_other_warehouses: [] });
  });

  it('el aviso de una parte surtida nombra la sucursal', async () => {
    const { svc, alerts } = armar({ pick: ABIERTO_POR(YO), lineas: LINEAS, grupo: PARTE_LPA });
    await svc.finish(PEDIDO, { lines: [{ line_id: 'l1', picked: 5 }, { line_id: 'l2', picked: 1 }] });
    expect(alerts.emitTo).toHaveBeenCalledWith(T, '42pmpb', expect.objectContaining({
      title: 'Tu pedido P-10482 · parte de La Piedad Abastos: surtido completo',
    }));
  });

  it('con faltantes, también nombra la sucursal', async () => {
    const { svc, alerts } = armar({ pick: ABIERTO_POR(YO), lineas: LINEAS, grupo: PARTE_LPA });
    await svc.finish(PEDIDO, { lines: [{ line_id: 'l1', picked: 3 }, { line_id: 'l2', picked: 0 }] });
    expect(alerts.emitTo).toHaveBeenCalledWith(T, '42pmpb', expect.objectContaining({
      title: 'Tu pedido P-10482 · parte de La Piedad Abastos: faltó 2 productos',
    }));
  });

  it('al empezar, el aviso de la parte nombra la sucursal', async () => {
    const { svc, alerts } = armar({ pick: ABIERTO_POR(YO), grupo: PARTE_LPA });
    await svc.start(PEDIDO);
    expect(alerts.emitTo).toHaveBeenCalledWith(T, '42pmpb', expect.objectContaining({
      title: 'Tu pedido P-10482 · parte de La Piedad Abastos: ya lo están surtiendo',
    }));
  });

  it('un grupo cuyas partes son todas de la misma sucursal avisa como siempre', async () => {
    const { svc, alerts } = armar({ pick: ABIERTO_POR(YO), lineas: LINEAS, grupo: { ...PARTE_LPA, group_other_warehouses: [] } });
    await svc.finish(PEDIDO, { lines: [{ line_id: 'l1', picked: 5 }, { line_id: 'l2', picked: 1 }] });
    expect(alerts.emitTo).toHaveBeenCalledWith(T, '42pmpb', expect.objectContaining({ title: 'Tu pedido se surtió completo' }));
  });
});
