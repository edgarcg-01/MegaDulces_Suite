import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { CommercialVendorRoutesService } from './commercial-vendor-routes.service';

/**
 * `[MCP.3.9]` Alcance RV/RD en las pestañas de asignación de «Cartera de ventas»: las LECTURAS se
 * recortan (RV → sólo vecinales; RD → sólo las que no lo son, con las no declaradas; god-mode →
 * todas) y las ESCRITURAS fuera del alcance dan 403 sin tocar nada.
 */
const YO = '11111111-1111-1111-1111-111111111111';
const VEND = '22222222-2222-2222-2222-222222222222';
const R_VEC = '1V003 PAULINA MICHELLE PLACENCIA BRAVO';
const ASIG_VEC = '66666666-6666-6666-6666-666666666666';
const ASIG_CAM = '77777777-7777-7777-7777-777777777777';
const ROUTE_ID_CAM = '88888888-8888-8888-8888-888888888888';
const WH = '99999999-9999-9999-9999-999999999999';
const NUEVO = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function armar(m: { role?: string; department?: string | null }) {
  const writes: string[] = [];
  const tabla = (nombre: string) => {
    const q: any = {};
    const wheres: any[] = [];
    q.where = (...a: unknown[]) => { wheres.push(a[0]); return q; };
    for (const k of ['whereNull', 'whereNotNull', 'whereIn', 'groupBy', 'select', 'orderBy', 'orderByRaw', 'leftJoin', 'join']) q[k] = () => q;
    const data = (): any[] => {
      if (nombre === 'commercial.customers') {
        return [
          { sales_route: R_VEC, customer_count: 10 },
          { sales_route: 'RUTA 27', customer_count: 20 },
          { sales_route: 'RUTA SIN DECLARAR', customer_count: 5 },
        ];
      }
      if (nombre.startsWith('commercial.vendor_sales_routes')) {
        const all = [
          { id: ASIG_VEC, sales_route: R_VEC, user_id: VEND, username: 'vend' },
          { id: ASIG_CAM, sales_route: 'RUTA 27', user_id: VEND, username: 'vend' },
        ];
        const id = wheres.find((w) => w && typeof w === 'object' && 'id' in w)?.id;
        return id ? all.filter((a) => a.id === id) : all;
      }
      if (nombre === 'trade.catalogs') return [{ id: ROUTE_ID_CAM, tenant_id: 't', value: 'RUTA 27' }];
      if (nombre === 'commercial.warehouses') return [{ id: WH }];
      if (nombre === 'public.users') return [{ id: VEND, username: 'vend' }, { id: NUEVO, username: 'nuevo' }];
      return [];
    };
    q.first = async () => data()[0];
    q.insert = () => { writes.push(`insert ${nombre}`); return { onConflict: () => ({ ignore: () => ({ returning: async () => [{ id: 'nueva' }] }), merge: async () => 1 }) }; };
    q.update = async () => { writes.push(`update ${nombre}`); return 1; };
    q.del = async () => { writes.push(`delete ${nombre}`); return 1; };
    q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(data()).then(ok, ko);
    return q;
  };
  const trx: any = Object.assign(tabla, {
    fn: { now: () => 'now()' },
    raw: vi.fn(async (sql: string) => {
      // Rutas de cada vendedor (agenda + cartera): VEND sólo tiene camión; NUEVO, ninguna.
      if (sql.includes('vendor_sales_routes')) return { rows: [{ user_id: VEND, route: 'RUTA 27' }] };
      if (sql.includes('identity.positions')) return { rows: [{ department_code: m.department ?? null }] };
      if (sql.includes('FROM trade.catalogs')) {
        return { rows: [{ value: R_VEC, route_kind: 'vecinal' }, { value: 'RUTA 27', route_kind: 'camion' }] };
      }
      return { rows: [] };
    }),
  });
  const tk = { run: vi.fn(async (fn: (t: unknown) => unknown) => fn(trx)) };
  const ctx = { get: () => ({ tenantId: 't', userId: YO, roleName: m.role ?? 'supervisor_ventas' }) };
  return { svc: new CommercialVendorRoutesService(tk as any, ctx as any), writes };
}

describe('Cartera de ventas — alcance RV/RD', () => {
  it('⛔ RV: sales-routes sólo trae las vecinales', async () => {
    const { svc } = armar({ department: 'ruta_vecinal' });
    const r = await svc.listSalesRoutes();
    expect(r.map((x) => x.sales_route)).toEqual([R_VEC]);
  });

  it('⛔ RD: sales-routes trae camión y las no declaradas, nunca la vecinal', async () => {
    const { svc } = armar({ department: 'ruta_directa' });
    const r = await svc.listSalesRoutes();
    expect(r.map((x) => x.sales_route)).toEqual(['RUTA 27', 'RUTA SIN DECLARAR']);
  });

  it('god-mode (aunque su puesto sea RV) y los demás puestos: todas', async () => {
    for (const m of [{ role: 'superadmin', department: 'ruta_vecinal' }, { department: 'ventas' }, { department: null }]) {
      const { svc } = armar(m);
      expect((await svc.listSalesRoutes()).length).toBe(3);
    }
  });

  it('vendors: RV no ve al de sólo camión, pero sí al que no tiene ruta (hay que poder asignarle la primera)', async () => {
    const { svc } = armar({ department: 'ruta_vecinal' });
    expect((await svc.listVendors()).map((v) => v.id)).toEqual([NUEVO]);
    const rd = armar({ department: 'ruta_directa' });
    expect((await rd.svc.listVendors()).map((v) => v.id)).toEqual([VEND, NUEVO]);
  });

  it('las asignaciones y los clientes de una ruta ajena se leen recortados', async () => {
    const { svc } = armar({ department: 'ruta_vecinal' });
    const a: any[] = await svc.listAssignments();
    expect(a.map((x) => x.sales_route)).toEqual([R_VEC]);
    expect(await svc.customersByRoute('RUTA 27')).toEqual([]);
  });

  it('⛔ RV no asigna, no ordena, no quita ni cambia la sucursal de una ruta de camión (403, sin escribir)', async () => {
    const { svc, writes } = armar({ department: 'ruta_vecinal' });
    await expect(svc.assign({ user_id: VEND, sales_route: 'RUTA 27' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.setRouteOrder({ sales_route: 'RUTA 27', customer_ids: [] })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.unassign(ASIG_CAM)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.setRouteWarehouse(ROUTE_ID_CAM, WH)).rejects.toBeInstanceOf(ForbiddenException);
    expect(writes).toEqual([]);
  });

  it('⛔ RD no asigna ni quita una ruta vecinal; sí la suya', async () => {
    const { svc, writes } = armar({ department: 'ruta_directa' });
    await expect(svc.assign({ user_id: VEND, sales_route: R_VEC })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.unassign(ASIG_VEC)).rejects.toBeInstanceOf(ForbiddenException);
    expect(writes).toEqual([]);
    await svc.assign({ user_id: VEND, sales_route: 'RUTA 27' });
    expect(writes).toEqual(['insert commercial.vendor_sales_routes']);
  });
});
