import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { VisitMonitorService } from './visit-monitor.service';

/**
 * `[MCP.3.7]` El servicio del monitoreo con dobles (sin base): alcance (sólo tu equipo), fecha, y
 * que el día se arme con los hechos correctos — la falta sólo cuando la ruta se cerró, y lo no
 * medido declarado. Las reglas finas están en visit-protocol.engine.spec.ts.
 */
const YO = '11111111-1111-1111-1111-111111111111';
const VEND = '22222222-2222-2222-2222-222222222222';
const AJENO = '33333333-3333-3333-3333-333333333333';
const HOY = '2026-10-21';

interface Mundo {
  role?: string;
  team?: string[];
  picks?: unknown[];
  agenda?: unknown[];
  customers?: unknown[];
  visits?: unknown[];
  orders?: unknown[];
  days?: unknown[];
  gps?: unknown[];
  nearest?: unknown[];
  /** `department_code` del PUESTO de quien consulta. */
  department?: string | null;
  /** Rutas con `route_kind = 'vecinal'` (por valor). */
  vecinales?: string[];
}

function armar(m: Mundo) {
  const raws: { sql: string; b: unknown[] }[] = [];
  const tabla = (nombre: string) => {
    const q: any = {};
    let ids: string[] | null = null;
    q.whereIn = (_c: string, v: string[]) => { if (nombre.startsWith('identity.users')) ids = v; return q; };
    for (const k of ['join', 'leftJoin', 'where', 'whereNull', 'whereNot', 'whereRaw', 'orderBy', 'select', 'distinct']) q[k] = () => q;
    const data = (): unknown[] => {
      if (nombre.startsWith('public.users')) return (m.team ?? []).map((id) => ({ id }));
      if (nombre.startsWith('identity.users')) return [...new Set([YO, VEND, ...(m.team ?? [])])].filter((id) => !ids || ids.includes(id)).map((id) => ({ id, name: id === YO ? 'Supervisor' : `Vend ${id.slice(0, 2)}` }));
      if (nombre.startsWith('commercial.vendor_route_day_picks')) return m.picks ?? [];
      if (nombre.startsWith('public.daily_assignments')) return m.agenda ?? [];
      if (nombre.startsWith('commercial.customers')) return m.customers ?? [];
      if (nombre.startsWith('commercial.vendor_visits')) return m.visits ?? [];
      if (nombre.startsWith('commercial.orders')) return m.orders ?? [];
      if (nombre.startsWith('commercial.seller_route_days')) return m.days ?? [];
      return [];
    };
    q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(data()).then(ok, ko);
    return q;
  };
  const trx: any = Object.assign(tabla, {
    raw: vi.fn(async (sql: string, b: unknown[] = []) => {
      raws.push({ sql, b });
      if (sql.includes('AS today')) {
        return { rows: [{ today: HOY, day_start: '2026-10-21T06:00:00Z', day_end: '2026-10-22T06:00:00Z', my_department: m.department ?? null }] };
      }
      if (sql.includes('FROM trade.catalogs')) return { rows: (m.vecinales ?? []).map((value) => ({ value, route_kind: 'vecinal' })) };
      if (sql.includes('count(*)::int AS n')) return { rows: m.gps ?? [] };
      if (sql.includes('jsonb_to_recordset')) return { rows: m.nearest ?? [] };
      if (sql.includes('UNION')) return { rows: [{ user_id: YO }, { user_id: VEND }] };
      return { rows: [] };
    }),
  });
  const tk = { run: vi.fn(async (fn: (t: unknown) => unknown) => fn(trx)) };
  const tenantCtx = { get: () => ({ tenantId: 't', userId: YO, roleName: m.role ?? 'supervisor_ventas' }) };
  return { svc: new VisitMonitorService(tk as any, tenantCtx as any), raws };
}

const RUTA = { user_id: VEND, route: 'RUTA 27' };
const cli = (id: string, o: Record<string, unknown> = {}) => ({
  id, code: id.toUpperCase(), name: `Cliente ${id}`, sales_route: 'RUTA 27', latitude: '19.4', longitude: '-99.1', visit_sequence: 1, ...o,
});

describe('VisitMonitorService.monitor', () => {
  it('fecha mal formada o futura = 400; persona fuera del equipo = 403', async () => {
    const { svc } = armar({ team: [VEND] });
    await expect(svc.monitor('21/10/2026')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.monitor('2026-10-22')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.monitor(HOY, AJENO)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('sin equipo, el supervisor sólo se ve a sí mismo (alcance = equipo)', async () => {
    const { svc } = armar({ team: [] });
    const r = await svc.monitor(HOY);
    expect(r.scope).toBe('equipo');
    expect(r.vendor_options.map((o) => o.user_id)).toEqual([YO]);
  });

  it('ruta abierta hoy: lo no visitado es pendiente, no falta', async () => {
    const { svc } = armar({
      team: [VEND], agenda: [RUTA], customers: [cli('a'), cli('b')],
      days: [{ user_id: VEND, started_at: '2026-10-21T14:00:00Z', finished_at: null }],
      gps: [{ user_id: VEND, n: 50, first_at: 'x', last_at: 'y' }],
      nearest: [{ user_id: VEND, customer_id: 'a', d: 10 }],
    });
    const r = await svc.monitor(HOY, VEND);
    const v = r.vendors[0];
    expect(v.day_state).toBe('en_ruta');
    expect(v.closed).toBe(false);
    expect(v.counts.pendientes).toBe(2);
    expect(v.counts.faltas).toBe(0);
  });

  it('ruta finalizada: se juzga — pedido, se fue sin abrir, no pasó, sin ubicación, y fuera de ruta', async () => {
    const { svc } = armar({
      team: [VEND], agenda: [RUTA],
      customers: [cli('a'), cli('b'), cli('c'), cli('d', { latitude: null, longitude: null }), cli('z', { sales_route: 'RUTA 99' })],
      visits: [{ user_id: VEND, customer_id: 'z', visited_at: '2026-10-21T16:00:00Z', ended_at: '2026-10-21T16:10:00Z', had_order: false, had_ticket: false, no_sale_reason: 'cerrado', notes: null, latitude: '19.4', longitude: '-99.1' }],
      orders: [{ user_id: VEND, customer_id: 'a' }],
      days: [{ user_id: VEND, started_at: '2026-10-21T14:00:00Z', finished_at: '2026-10-21T22:00:00Z' }],
      gps: [{ user_id: VEND, n: 300, first_at: 'x', last_at: 'y' }],
      nearest: [{ user_id: VEND, customer_id: 'b', d: 30 }, { user_id: VEND, customer_id: 'c', d: 400 }],
    });
    const r = await svc.monitor(HOY, VEND);
    const by = Object.fromEntries(r.vendors[0].rows.map((x) => [x.customer_id, x]));
    expect(by['a'].status).toBe('con_pedido');
    expect(by['b'].status).toBe('se_fue_sin_abrir');
    expect(by['c'].status).toBe('no_paso');
    expect(by['d'].status).toBe('sin_ubicacion');
    // Visitado aunque no sea de su ruta: no se pierde la visita.
    expect(by['z'].on_route).toBe(false);
    expect(by['z'].status).toBe('sin_pedido');
    expect(r.totals.faltas).toBe(2);
  });

  it('día finalizado SIN GPS: nada es falta, todo lo no visitado con ubicación es sin GPS', async () => {
    const { svc, raws } = armar({
      team: [VEND], agenda: [RUTA], customers: [cli('a'), cli('b')],
      days: [{ user_id: VEND, started_at: 'x', finished_at: 'y' }],
      gps: [],
    });
    const r = await svc.monitor(HOY, VEND);
    expect(r.vendors[0].counts.sin_gps).toBe(2);
    expect(r.vendors[0].counts.faltas).toBe(0);
    // Sin GPS no se busca la cercanía (no hay a qué compararla).
    expect(raws.some((x) => x.sql.includes('jsonb_to_recordset'))).toBe(false);
  });

  it('una fecha pasada se juzga aunque nadie haya finalizado la ruta', async () => {
    const { svc } = armar({ team: [VEND], agenda: [RUTA], customers: [cli('a')], gps: [{ user_id: VEND, n: 9, first_at: 'x', last_at: 'y' }] });
    const r = await svc.monitor('2026-10-20', VEND);
    expect(r.vendors[0].closed).toBe(true);
    expect(r.vendors[0].day_state).toBe('sin_iniciar');
    expect(r.vendors[0].rows[0].status).toBe('no_paso');
  });

  it('la ruta escogida ese día manda sobre la agenda', async () => {
    const { svc } = armar({
      team: [VEND], picks: [{ user_id: VEND, route: 'RUTA 5' }], agenda: [RUTA],
      customers: [cli('a', { sales_route: 'RUTA 5' })],
    });
    const r = await svc.monitor(HOY, VEND);
    expect(r.vendors[0].route_source).toBe('eleccion');
    expect(r.vendors[0].routes).toEqual(['RUTA 5']);
  });

  describe('alcance de Ruta Vecinal (puesto con department_code = ruta_vecinal)', () => {
    const VEC = '44444444-4444-4444-4444-444444444444';
    const R_VEC = '1V003 PAULINA MICHELLE PLACENCIA BRAVO';
    const visita = (customer_id: string) => ({
      user_id: VEC, customer_id, visited_at: '2026-10-21T16:00:00Z', ended_at: '2026-10-21T16:10:00Z',
      had_order: false, had_ticket: false, no_sale_reason: 'cerrado', notes: null, latitude: '19.4', longitude: '-99.1',
    });
    const mundoRv = (o: Partial<Mundo> = {}): Mundo => ({
      department: 'ruta_vecinal', vecinales: [R_VEC], team: [VEND, VEC],
      agenda: [RUTA, { user_id: VEC, route: R_VEC }],
      customers: [cli('a'), cli('v', { sales_route: R_VEC })],
      gps: [{ user_id: VEND, n: 9, first_at: 'x', last_at: 'y' }, { user_id: VEC, n: 9, first_at: 'x', last_at: 'y' }],
      ...o,
    });

    it('⛔ un supervisor RV con un vendedor en ruta camión NO lo ve: ni en la lista, ni en el filtro, ni en los totales', async () => {
      const { svc, raws } = armar(mundoRv());
      const r = await svc.monitor(HOY);
      expect(r.alcance).toEqual({ tipo_ruta: 'vecinal', etiqueta: 'Rutas vecinales' });
      expect(r.vendors.map((v) => v.user_id)).toEqual([VEC]);
      expect(r.vendor_options.map((o) => o.user_id)).toEqual([VEC]);
      expect(r.vendors[0].rows.map((x) => x.customer_id)).toEqual(['v']);
      expect(r.totals.clientes).toBe(1);
      // Ni siquiera se le pide el GPS al de camión.
      const gpsSql = raws.find((x) => x.sql.includes('count(*)::int AS n'))!;
      expect(gpsSql.b[0]).toEqual([VEC]);
    });

    it('⛔ pedir explícitamente al de camión no da 403 nuevo: sale vacío', async () => {
      const { svc } = armar(mundoRv());
      const r = await svc.monitor(HOY, VEND);
      expect(r.vendors).toEqual([]);
      expect(r.vendor_options.map((o) => o.user_id)).toEqual([VEC]);
    });

    it('⛔ un vendedor con ruta vecinal Y de camión: sólo se queda lo vecinal; una visita fuera de ruta a un cliente de camión no se lista', async () => {
      const { svc } = armar(mundoRv({
        team: [VEC],
        agenda: [{ user_id: VEC, route: 'RUTA 27' }, { user_id: VEC, route: R_VEC }],
        customers: [cli('a'), cli('v', { sales_route: R_VEC }), cli('w', { sales_route: '1V004 OTRA' }), cli('z', { sales_route: 'RUTA 99' })],
        vecinales: [R_VEC, '1V004 OTRA'],
        visits: [visita('w'), visita('z')],
      }));
      const r = await svc.monitor(HOY, VEC);
      const v = r.vendors[0];
      expect(v.routes).toEqual([R_VEC]);
      const ids = v.rows.map((x) => x.customer_id).sort();
      expect(ids).toEqual(['v', 'w']);
      expect(v.rows.find((x) => x.customer_id === 'w')!.on_route).toBe(false);
    });

    it('si no hay NINGUNA ruta vecinal declarada, el supervisor RV no ve nada (cierra, no abre)', async () => {
      const { svc } = armar(mundoRv({ vecinales: [] }));
      const r = await svc.monitor(HOY);
      expect(r.vendors).toEqual([]);
      expect(r.vendor_options).toEqual([]);
    });

    // ⚠️ En el MONITOREO, sí: su contrato sólo sabe declarar el recorte vecinal (el de Ruta Directa
    // vive en el tablero `[MCP.3.9]` y en Cartera — supervisor-board.service.spec.ts).
    it('Ruta Directa (y cualquier otro puesto) queda SIN recorte: ve camión y vecinal', async () => {
      const { svc, raws } = armar(mundoRv({ department: 'ruta_directa' }));
      const r = await svc.monitor(HOY);
      expect(r.alcance).toEqual({ tipo_ruta: null, etiqueta: null });
      expect(r.vendors.map((v) => v.user_id).sort()).toEqual([VEND, VEC].sort());
      expect(raws.some((x) => x.sql.includes('FROM trade.catalogs'))).toBe(false);
    });

    it('god-mode con puesto vecinal tampoco se recorta', async () => {
      const { svc } = armar(mundoRv({ role: 'superadmin' }));
      const r = await svc.monitor(HOY);
      expect(r.alcance.tipo_ruta).toBeNull();
      expect(r.scope).toBe('todos');
    });
  });

  it('god-mode ve a todos los que tienen ruta o visitas ese día', async () => {
    const { svc } = armar({ role: 'superadmin' });
    const r = await svc.monitor(HOY);
    expect(r.scope).toBe('todos');
    expect(r.vendor_options.length).toBe(2);
  });
});
