// Sin `import ... from 'vitest'`: la config usa `globals: true` (ver requisicion-oc.spec.ts).
import { CommercialReplenishmentService } from './commercial-replenishment.service';

/**
 * `[CANON.5.25]` La pantalla de proveedores guarda un parámetro de pedido a la vez, y esa escritura
 * marca el campo como `manual` en `order_params_source` (y firma `updated_by`). Sin la marca, el
 * importer `import-supplier-params` lo tomaría por derivado y lo pisaría en la noche.
 */
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SUP = '11111111-2222-4333-8444-555555555555';
const USER = '99999999-8888-4777-8666-555555555555';

const armar = (opts: { columna?: boolean; userId?: string } = {}) => {
  const updates: Array<Record<string, unknown>> = [];
  const raws: Array<{ sql: string; b?: unknown[] }> = [];
  const trx: any = (tabla: string) => ({
    where: () => ({
      update: async (u: Record<string, unknown>) => { updates.push({ tabla, ...u }); return 1; },
    }),
  });
  trx.fn = { now: () => 'NOW()' };
  // Como knex: `raw` devuelve el builder en el acto (va dentro del UPDATE) y se resuelve con `await`.
  trx.raw = (sql: string, b?: unknown[]) => {
    raws.push({ sql, b });
    const rows = sql.includes("column_name='order_params_source'") ? [{ c: opts.columna ?? true }]
      : sql.includes('fill_rate_override') ? [{ t: true, c: true }] : [];
    return { sql, b, then: (ok: (v: unknown) => unknown) => ok({ rows }) };
  };
  const tk = { run: async (fn: (t: unknown) => unknown) => fn(trx) };
  const tenantCtx = { requireTenantId: () => TENANT, get: () => ({ tenantId: TENANT, userId: opts.userId ?? USER }) };
  const svc = new CommercialReplenishmentService(tk as never, tenantCtx as never, {} as never, {} as never);
  return { svc, updates, raws };
};

describe('[CANON.5.25] la captura manual de parámetros de pedido se marca en la misma escritura', () => {
  it('con el payload de /compras/proveedores (un campo) marca SÓLO ese campo como manual y firma', async () => {
    const { svc, updates } = armar();
    await svc.setSupplierOrderParams(SUP, { cadence_days_override: 9 });
    expect(updates).toHaveLength(1);
    const u = updates[0];
    expect(u['cadence_days_override']).toBe(9);
    expect(u['updated_by']).toBe(USER);
    const marca = u['order_params_source'] as { sql: string; b: unknown[] };
    expect(marca.sql).toContain("coalesce(order_params_source, '{}'::jsonb) || ?::jsonb");
    expect(JSON.parse(marca.b[0] as string)).toEqual({ cadence_days_override: 'manual' });
  });

  it('borrar el valor (null) también es una decisión de una persona: queda manual', async () => {
    const { svc, updates } = armar();
    await svc.setSupplierOrderParams(SUP, { min_order_amount: null });
    const marca = updates[0]['order_params_source'] as { b: unknown[] };
    expect(JSON.parse(marca.b[0] as string)).toEqual({ min_order_amount: 'manual' });
  });

  it('el endpoint viejo de mínimo en cajas también marca', async () => {
    const { svc, updates } = armar();
    await svc.setSupplierMinBoxes(SUP, 40);
    const marca = updates[0]['order_params_source'] as { b: unknown[] };
    expect(updates[0]['min_order_boxes']).toBe(40);
    expect(JSON.parse(marca.b[0] as string)).toEqual({ min_order_boxes: 'manual' });
  });

  it('un parámetro que el importer no deriva (fill rate) no toca la procedencia', async () => {
    const { svc, updates } = armar();
    await svc.setSupplierOrderParams(SUP, { fill_rate_override: 90 });
    expect(updates[0]).not.toHaveProperty('order_params_source');
    expect(updates[0]).not.toHaveProperty('updated_by');
  });

  it('si la migración no ha llegado, guarda igual y sin la columna (no da 500)', async () => {
    const { svc, updates } = armar({ columna: false });
    await svc.setSupplierOrderParams(SUP, { colchon_days: 4 });
    expect(updates[0]['colchon_days']).toBe(4);
    expect(updates[0]).not.toHaveProperty('order_params_source');
  });

  it('un usuario que no es UUID no se escribe en updated_by (columna uuid)', async () => {
    const { svc, updates } = armar({ userId: 'system' });
    await svc.setSupplierOrderParams(SUP, { colchon_days: 4 });
    expect(updates[0]['updated_by']).toBeNull();
  });

  it('la respuesta no filtra los detalles internos de la escritura', async () => {
    const { svc } = armar();
    const r = await svc.setSupplierOrderParams(SUP, { colchon_days: 4 });
    expect(r).not.toHaveProperty('order_params_source', expect.anything());
    expect((r as Record<string, unknown>)['updated_by']).toBeUndefined();
  });
});
