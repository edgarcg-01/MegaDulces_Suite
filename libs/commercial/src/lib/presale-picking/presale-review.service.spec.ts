import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { PresalePickReport } from '@megadulces/contracts';
import { PresaleReviewService } from './presale-review.service';
import { PresaleReviewController } from './presale-review.controller';
import { PresalePickingModule } from './presale-picking.module';

/**
 * `[MCP.10]` Las decisiones del servicio de revisión en caja, con dobles (sin base): cuándo se deja
 * revisar, cuándo se toca el pedido y a quién se avisa. Las reglas puras están en
 * presale-review.engine.spec.ts; la coherencia de la columna la prueba la migración con su negativa.
 */
const PEDIDO = '33333333-3333-3333-3333-333333333333';
const REPORTE: PresalePickReport = {
  adjusted: [{ product_name: 'MAZAPAN GIGANTE', unit: 'PAQ', ordered: 3, picked: 2, line_id: 'l-b' }],
  removed: [],
  total_before: 300,
  total_after: 200,
};
const VIVOS = [
  { line_id: 'l-a', product_id: 'p-a', product_name: 'PALETA PAYASO', quantity: 24, qty_unit: 'CJA', qty_factor: 24 },
  { line_id: 'l-b', product_id: 'p-b', product_name: 'MAZAPAN GIGANTE', quantity: 40, qty_unit: 'PAQ', qty_factor: 20 },
];

function armar(pick: Record<string, unknown> | null, almacenes: string[] | null = ['wh-01']) {
  const updates: Array<Record<string, unknown>> = [];
  const q: any = {};
  for (const k of ['where', 'forUpdate']) q[k] = () => q;
  q.first = async () => pick ?? undefined;
  q.update = async (o: Record<string, unknown>) => { updates.push(o); return 1; };
  const trx: any = Object.assign(() => q, { fn: { now: () => 'now()' } });
  const tk = { run: vi.fn(async (fn: (t: unknown) => unknown) => fn(trx)) };
  const scope = { warehouseIds: vi.fn(async () => almacenes) };
  const orders = { ajustarTrasRevision: vi.fn(async () => ({ total_before: 200, total_after: 300 })) };
  const picking = { quien: vi.fn(async () => ({ userId: 'caj-1', nombre: 'María Cajera' })), avisarVendedora: vi.fn() };
  const svc = new PresaleReviewService(tk as any, scope as any, orders as any, picking as any);
  const fila = { id: PEDIDO, code: 'PD-2026-00138', total: 200, warehouse_id: 'wh-01', user_id: 'v-1', seller_username: '10v01', customer_name: 'ABARROTES CARMELITA' };
  vi.spyOn(svc as any, 'leer').mockResolvedValue([fila]);
  vi.spyOn(svc as any, 'vivos').mockResolvedValue(VIVOS);
  return { svc, orders, picking, updates };
}

const surtido = { id: 'pk-1', finished_at: '2026-10-29T15:00:00Z', reviewed_at: null, report: REPORTE };

describe('PresaleReviewService.finish', () => {
  it('todo bien: guarda la revisión y NO toca el pedido ni avisa', async () => {
    const { svc, orders, picking, updates } = armar(surtido);
    const r = await svc.finish(PEDIDO, { lines: [{ key: 'l-a', final: 1 }, { key: 'l-b', final: 2 }] });
    expect(orders.ajustarTrasRevision).not.toHaveBeenCalled();
    expect(picking.avisarVendedora).not.toHaveBeenCalled();
    expect(r.review).toMatchObject({ total_before: 200, total_after: 200 });
    expect(updates[0]).toMatchObject({ reviewed_by: 'caj-1', reviewed_by_name: 'María Cajera' });
    expect(JSON.parse(updates[0]['review'] as string).lines.map((l: { resolution: string }) => l.resolution)).toEqual(['bien', 'no_hubo']);
  });

  it('«Ya se completó»: corrige el pedido en la misma transacción y avisa a la vendedora', async () => {
    const { svc, orders, picking } = armar(surtido);
    const r = await svc.finish(PEDIDO, { lines: [{ key: 'l-a', final: 1 }, { key: 'l-b', final: 3 }] });
    expect(orders.ajustarTrasRevision).toHaveBeenCalledWith(
      expect.anything(), PEDIDO, expect.objectContaining({ poner: [{ line_id: 'l-b', quantity: 60 }], quitar: [], reponer: [] }), 'revisión en caja: María Cajera',
    );
    expect(r.review.total_after).toBe(300);
    expect(picking.avisarVendedora).toHaveBeenCalledWith(expect.objectContaining({ id: PEDIDO }), 'La caja completó 1 producto', expect.stringContaining('300.00'));
  });

  it('NEGATIVO: no se revisa dos veces', async () => {
    const { svc, updates } = armar({ ...surtido, reviewed_at: '2026-10-29T16:00:00Z', reviewed_by_name: 'Otra Cajera' });
    await expect(svc.finish(PEDIDO, { lines: [] })).rejects.toThrow(ConflictException);
    expect(updates).toHaveLength(0);
  });

  it('NEGATIVO: no se revisa lo que el surtidor no ha terminado', async () => {
    const { svc } = armar({ ...surtido, finished_at: null });
    await expect(svc.finish(PEDIDO, { lines: [] })).rejects.toThrow(/todavía no termina/);
  });

  it('NEGATIVO: cobrar más de lo pedido es un 400 y no escribe nada', async () => {
    const { svc, orders, updates } = armar(surtido);
    await expect(svc.finish(PEDIDO, { lines: [{ key: 'l-a', final: 5 }, { key: 'l-b', final: 2 }] })).rejects.toThrow(BadRequestException);
    expect(orders.ajustarTrasRevision).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('NEGATIVO: sin sucursal asignada no se revisa nada', async () => {
    const { svc } = armar(surtido, []);
    await expect(svc.finish(PEDIDO, { lines: [] })).rejects.toThrow(ForbiddenException);
    await expect(svc.inbox()).resolves.toMatchObject({ scope: 'ninguno', data: [] });
  });

  it('la bandeja publica el pendiente CONTADO, y dice si la lista no lo alcanza', async () => {
    const { svc } = armar(surtido);
    vi.spyOn(svc as any, 'contarPendientes').mockResolvedValue(340);
    const r = await svc.inbox();
    expect(r.pending).toBe(340);
    expect(r.truncated).toBe(true);
    vi.spyOn(svc as any, 'contarPendientes').mockResolvedValue(1);
    expect((await svc.inbox()).truncated).toBe(false);
  });

  it('id inválido es un 400', async () => {
    const { svc } = armar(surtido);
    await expect(svc.finish('nada', { lines: [] })).rejects.toThrow(BadRequestException);
  });
});

describe('PresaleReviewService — arranque', () => {
  // Lección de #414. Como en pedido-negociacion.spec.ts: vitest transpila sin emitDecoratorMetadata,
  // así que se mide la aridad del constructor y el registro en el módulo, no design:paramtypes.
  it('el constructor toma sus cuatro dependencias', () => {
    expect(PresaleReviewService.length).toBe(4);
  });
  it('el módulo provee el servicio y expone el controlador', () => {
    const meta = (k: string) => (Reflect as unknown as { getMetadata(k: string, o: object): unknown[] }).getMetadata(k, PresalePickingModule) ?? [];
    expect(meta('providers')).toContain(PresaleReviewService);
    expect(meta('controllers')).toContain(PresaleReviewController);
  });
  it('[MCP.10.3] la ruta «search» se declara antes que «:id» (si no, Nest la toma como un id)', () => {
    const metodos = Object.getOwnPropertyNames(PresaleReviewController.prototype);
    expect(metodos.indexOf('search')).toBeGreaterThan(-1);
    expect(metodos.indexOf('search')).toBeLessThan(metodos.indexOf('detail'));
  });
});

describe('[MCP.10.3] PresaleReviewService.search — en qué pedido por revisar está el producto', () => {
  const FICHA = { sku: '44340', nombre: 'PALETA', u1: 'PZA', u2: null, f2: null, u3: 'CJA', f3: 24,
    b1: '7501000044340', b2: null, b3: null, d1: null, d2: null, d3: null, t1: null, t2: null, t3: null };

  function armarBusqueda(kdii: 'ok' | 'falla', almacenes: string[] | null = ['wh-07']) {
    const q: any = {};
    for (const k of ['leftJoin', 'whereIn']) q[k] = () => q;
    q.select = async () => [
      { order_id: 'o-1', product_name: 'PALETA PAYASO GRANDE', sku: '44340' },
      { order_id: 'o-2', product_name: 'MAZAPÁN GIGANTE 50 G', sku: '06001' },
    ];
    const sp = { raw: vi.fn(async () => ({ rows: [FICHA] })) };
    const trx: any = Object.assign(() => q, {
      transaction: vi.fn(async (fn: (t: unknown) => unknown) => { if (kdii === 'falla') throw new Error('kdii caído'); return fn(sp); }),
    });
    const tk = { run: vi.fn(async (fn: (t: unknown) => unknown) => fn(trx)) };
    const svc = new PresaleReviewService(tk as any, { warehouseIds: vi.fn(async () => almacenes) } as any, {} as any, {} as any);
    vi.spyOn(svc as any, 'leer').mockResolvedValue([
      { id: 'o-1', code: 'PD-1', warehouse_code: '07', customer_name: 'TIENDA UNO', seller_name: 'Vendedor A', reviewed_at: null },
      { id: 'o-2', code: 'PD-2', warehouse_code: '07', customer_name: 'TIENDA DOS', seller_name: 'Vendedor B', reviewed_at: null },
      { id: 'o-3', code: 'PD-3', warehouse_code: '07', customer_name: 'YA REVISADA', seller_name: 'Vendedor A', reviewed_at: '2026-11-09T16:00:00Z' },
    ]);
    const contar = vi.spyOn(svc as any, 'contarPendientes').mockResolvedValue(2);
    return { svc, sp, contar };
  }

  it('por el código de barras de Kepler encuentra el pedido, con su cliente y vendedor', async () => {
    const { svc } = armarBusqueda('ok');
    await expect(svc.search({ q: '7501000044340' })).resolves.toEqual({
      q: '7501000044340', truncated: false,
      data: [{ order_id: 'o-1', code: 'PD-1', customer_name: 'TIENDA UNO', seller_name: 'Vendedor A', product_name: 'PALETA PAYASO GRANDE', sku: '44340', match: 'codigo' }],
    });
  });

  it('por SKU (aun con ceros de menos) y por nombre sin acentos', async () => {
    const { svc } = armarBusqueda('ok');
    expect((await svc.search({ q: '6001' })).data.map((d) => [d.code, d.match])).toEqual([['PD-2', 'sku']]);
    expect((await svc.search({ q: 'mazapan gigante' })).data.map((d) => [d.code, d.match])).toEqual([['PD-2', 'nombre']]);
  });

  it('si los códigos de Kepler no se leen, busca igual por SKU y nombre (no truena)', async () => {
    const { svc } = armarBusqueda('falla');
    expect((await svc.search({ q: '44340' })).data.map((d) => d.code)).toEqual(['PD-1']);
    expect((await svc.search({ q: '7501000044340' })).data).toEqual([]);
  });

  it('NEGATIVO: sin texto o sin sucursal no busca; si hay más pedidos por revisar de los que vio, lo declara', async () => {
    const { svc, sp } = armarBusqueda('ok');
    expect(await svc.search({ q: '   ' })).toEqual({ q: '', data: [], truncated: false });
    expect(sp.raw).not.toHaveBeenCalled();
    const sinSucursal = armarBusqueda('ok', []);
    expect((await sinSucursal.svc.search({ q: 'paleta' })).data).toEqual([]);
    const tope = armarBusqueda('ok');
    tope.contar.mockResolvedValue(500);
    expect((await tope.svc.search({ q: 'paleta' })).truncated).toBe(true);
  });
});
