import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SupervisorBoardService } from './supervisor-board.service';
import { VisitMonitorService } from './visit-monitor.service';
import { SIN_MEDIR } from './supervisor-board.engine';

/**
 * `[MCP.3.9]` El tablero del supervisor con dobles (sin base): el día armado (visitados primero),
 * la venta Kepler del día y de la catorcena atribuida a la ruta, la meta y el avance; lo no medible
 * declarado (null + motivo, nunca $0); el alcance RV/RD; y la captura de metas con sus 403/400.
 */
const YO = '11111111-1111-1111-1111-111111111111';
const VEC = '44444444-4444-4444-4444-444444444444';
const VEC2 = '55555555-5555-5555-5555-555555555555';
const CAM = '22222222-2222-2222-2222-222222222222';
const AJENO = '33333333-3333-3333-3333-333333333333';
const HOY = '2026-10-21'; // miércoles; la catorcena abrió el sábado 17
const R_VEC = '1V003 PAULINA MICHELLE PLACENCIA BRAVO';
const R_CAM = 'RUTA 27';

interface Mundo {
  role?: string;
  department?: string | null;
  team?: string[];
  catalog?: { value: string; route_kind: string | null; erp_vendor_code?: string | null }[];
  picks?: { user_id: string; work_date: string; route: string }[];
  agenda?: { user_id: string; day_of_week: number; route: string }[];
  customers?: unknown[];
  visits?: unknown[];
  orders?: unknown[];
  days?: unknown[];
  /** Venta Kepler por código y día. */
  sales?: { code: string; day: string; amount: string; tickets: number }[];
  targets?: { user_id: string; amount: string }[];
}

const todaSemana = (user_id: string, route: string) => [1, 2, 3, 4, 5, 6, 7].map((day_of_week) => ({ user_id, day_of_week, route }));

function armar(m: Mundo) {
  const raws: { sql: string; b: unknown[] }[] = [];
  const updates: { tabla: string; where: unknown[]; set: unknown }[] = [];
  const tabla = (nombre: string) => {
    const q: any = {};
    const wheres: unknown[] = [];
    let ids: string[] | null = null;
    q.whereIn = (_c: string, v: string[]) => { if (nombre.startsWith('identity.users')) ids = v; return q; };
    q.where = (...a: unknown[]) => { wheres.push(a.length === 1 ? a[0] : a); return q; };
    for (const k of ['join', 'leftJoin', 'whereNull', 'whereNot', 'whereRaw', 'orderBy', 'select', 'distinct']) q[k] = () => q;
    const data = (): unknown[] => {
      if (nombre.startsWith('public.users')) {
        // `where({ id, activo })` + (si no es god-mode) `where('supervisor_id', yo)`.
        const id = (wheres.find((w: any) => w && typeof w === 'object' && !Array.isArray(w) && 'id' in w) as any)?.id;
        const porSupervisor = wheres.some((w: any) => Array.isArray(w) && w[0] === 'supervisor_id');
        const team = m.team ?? [];
        if (id) return (porSupervisor ? team.includes(id) : [YO, VEC, VEC2, CAM, AJENO].includes(id)) ? [{ id }] : [];
        return team.map((x) => ({ id: x }));
      }
      if (nombre.startsWith('identity.users')) {
        return [YO, VEC, VEC2, CAM].filter((id) => !ids || ids.includes(id))
          .map((id) => ({ id, name: { [YO]: 'Supervisor', [VEC]: 'Vecinal Uno', [VEC2]: 'Vecinal Dos', [CAM]: 'Camión' }[id] }));
      }
      if (nombre.startsWith('commercial.vendor_route_day_picks')) return m.picks ?? [];
      if (nombre.startsWith('public.daily_assignments')) return m.agenda ?? [];
      if (nombre.startsWith('commercial.customers')) return m.customers ?? [];
      if (nombre.startsWith('commercial.vendor_visits')) return m.visits ?? [];
      if (nombre.startsWith('commercial.orders')) return m.orders ?? [];
      if (nombre.startsWith('commercial.seller_route_days')) return m.days ?? [];
      if (nombre.startsWith('commercial.vendor_targets')) return m.targets ?? [];
      return [];
    };
    q.first = async () => data()[0];
    q.update = async (set: unknown) => { updates.push({ tabla: nombre, where: wheres, set }); return 1; };
    q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(data()).then(ok, ko);
    return q;
  };
  const trx: any = Object.assign(tabla, {
    fn: { now: () => 'now()' },
    raw: vi.fn(async (sql: string, b: unknown[] = []) => {
      raws.push({ sql, b });
      if (sql.includes('AS today')) {
        return { rows: [{ today: HOY, day_start: '2026-10-21T06:00:00Z', day_end: '2026-10-22T06:00:00Z', my_department: m.department ?? null }] };
      }
      if (sql.includes('FROM trade.catalogs')) return { rows: m.catalog ?? CATALOGO };
      if (sql.includes('identity.positions')) return { rows: [{ department_code: m.department ?? null }] };
      if (sql.includes('v_kepler_vecinal_sales_docs')) {
        const [codes, from, to] = b as [string[], string, string];
        return { rows: (m.sales ?? []).filter((s) => codes.includes(s.code) && s.day >= from && s.day <= to) };
      }
      if (sql.includes('UNION')) return { rows: (m.team ?? []).map((user_id) => ({ user_id })) };
      return { rows: [] };
    }),
  });
  const tk = { run: vi.fn(async (fn: (t: unknown) => unknown) => fn(trx)) };
  const tenantCtx = { get: () => ({ tenantId: 't', userId: YO, roleName: m.role ?? 'supervisor_ventas' }) };
  const monitor = new VisitMonitorService(tk as any, tenantCtx as any);
  return { svc: new SupervisorBoardService(tk as any, tenantCtx as any, monitor), raws, updates };
}

const CATALOGO = [
  { value: R_VEC, route_kind: 'vecinal', erp_vendor_code: '1V003' },
  { value: R_CAM, route_kind: 'camion', erp_vendor_code: null },
];
const cli = (id: string, route: string, seq: number) => ({
  id, code: id.toUpperCase(), name: `Cliente ${id}`, sales_route: route, latitude: '19.4', longitude: '-99.1', visit_sequence: seq,
});
const visita = (user_id: string, customer_id: string, at: string, o: Record<string, unknown> = {}) => ({
  user_id, customer_id, visited_at: at, ended_at: at.replace(':00Z', ':09Z'), had_order: false, had_ticket: false,
  no_sale_reason: 'cerrado', notes: null, latitude: '19.4', longitude: '-99.1', ...o,
});

/** Un equipo con una vendedora vecinal y un vendedor de camión. */
const mundo = (o: Partial<Mundo> = {}): Mundo => ({
  team: [VEC, CAM],
  agenda: [...todaSemana(VEC, R_VEC), ...todaSemana(CAM, R_CAM)],
  customers: [cli('v1', R_VEC, 1), cli('v2', R_VEC, 2), cli('v3', R_VEC, 3), cli('c1', R_CAM, 1)],
  visits: [
    visita(VEC, 'v3', '2026-10-21T15:00:00Z', { had_order: true, no_sale_reason: null }),
    visita(VEC, 'v2', '2026-10-21T17:00:00Z'),
  ],
  days: [{ user_id: VEC, started_at: '2026-10-21T14:00:00Z', finished_at: null }],
  sales: [
    { code: '1V003', day: '2026-10-16', amount: '999999', tickets: 99 }, // catorcena anterior: no cuenta
    { code: '1V003', day: '2026-10-18', amount: '2000.00', tickets: 4 },
    { code: '1V003', day: '2026-10-21', amount: '1000.50', tickets: 3 },
  ],
  targets: [{ user_id: VEC, amount: '10000.00' }],
  ...o,
});

describe('SupervisorBoardService.board', () => {
  it('fecha mal formada o futura = 400', async () => {
    const { svc } = armar(mundo());
    await expect(svc.board('21/10/2026')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.board('2026-10-22')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('⭐ RV: visitados primero (por hora) y luego los no visitados en orden de ruta; venta del día y de la catorcena; meta y avance', async () => {
    const { svc, raws } = armar(mundo({ department: 'ruta_vecinal' }));
    const r = await svc.board(HOY, true);
    expect(r.period).toEqual({ start: '2026-10-17', end: '2026-10-30', day: 5 });
    expect(r.scope).toBe('vecinal');
    expect(r.scope_label).toBe('Rutas vecinales');
    expect(r.can_set_targets).toBe(true);
    expect(r.vendors.map((v) => v.user_id)).toEqual([VEC]);
    const v = r.vendors[0];
    expect(v.routes).toEqual(['1V003']);
    expect(v.day_state).toBe('en_ruta');
    expect(v.started_at).toBe('2026-10-21T14:00:00Z');
    expect(v.customers.map((c) => c.customer_id)).toEqual(['v3', 'v2', 'v1']);
    expect(v.customers.map((c) => c.result)).toEqual(['con_pedido', 'sin_pedido', null]);
    expect(v.customers[1].reason).toBe('cerrado');
    expect(v.customers[2].visited_at).toBeNull();
    expect(v.customers_total).toBe(3);
    expect(v.customers_visited).toBe(2);
    expect(v.sales_day).toEqual({ amount: 1000.5, tickets: 3, unmeasured_reason: null });
    expect(v.sales_period).toEqual({ amount: 3000.5, tickets: 7, unmeasured_reason: null });
    expect(v.target).toBe(10000);
    expect(v.progress_pct).toBe(30);
    expect(r.totals).toEqual({ vendors: 1, customers_total: 3, customers_visited: 2, sales_day: 1000.5, sales_period: 3000.5, target: 10000 });
    // La venta se pide sólo por el código de la ruta del alcance, del sábado de arranque a hoy.
    const q = raws.find((x) => x.sql.includes('v_kepler_vecinal_sales_docs'))!;
    expect(q.b).toEqual([['1V003'], '2026-10-17', HOY]);
  });

  it('⛔ RD: no ve lo vecinal; la venta de camión NO es $0: es null con su motivo, y no se consulta Kepler', async () => {
    const { svc, raws } = armar(mundo({ department: 'ruta_directa' }));
    const r = await svc.board(HOY);
    expect(r.scope).toBe('directa');
    expect(r.scope_label).toBe('Ruta directa');
    expect(r.vendors.map((v) => v.user_id)).toEqual([CAM]);
    const v = r.vendors[0];
    expect(v.customers.map((c) => c.customer_id)).toEqual(['c1']);
    expect(v.sales_day).toEqual({ amount: null, tickets: null, unmeasured_reason: SIN_MEDIR.directa });
    expect(v.sales_period.amount).toBeNull();
    expect(v.progress_pct).toBeNull();
    expect(r.totals.sales_day).toBeNull();
    expect(r.totals.sales_period).toBeNull();
    expect(raws.some((x) => x.sql.includes('v_kepler_vecinal_sales_docs'))).toBe(false);
  });

  it('RD ve las rutas SIN tipo declarado (cuentan como directa)', async () => {
    const { svc } = armar(mundo({
      department: 'ruta_directa',
      catalog: [{ value: R_VEC, route_kind: 'vecinal', erp_vendor_code: '1V003' }, { value: R_CAM, route_kind: null }],
    }));
    const r = await svc.board(HOY);
    expect(r.vendors.map((v) => v.user_id)).toEqual([CAM]);
  });

  it('god-mode ve a los dos; el total no se afirma si alguien no se pudo medir', async () => {
    const { svc } = armar(mundo({ role: 'superadmin', department: 'ruta_vecinal' }));
    const r = await svc.board(HOY);
    expect(r.scope).toBeNull();
    expect(r.vendors.map((v) => v.user_id).sort()).toEqual([CAM, VEC].sort());
    expect(r.vendors.find((v) => v.user_id === VEC)!.sales_day.amount).toBe(1000.5);
    expect(r.totals.sales_day).toBeNull();
  });

  it('la venta se atribuye a la RUTA: quien cubrió la ruta ajena un día se lleva esa venta; la misma ruta-día suma UNA vez en el total', async () => {
    const { svc } = armar(mundo({
      team: [VEC, VEC2],
      // VEC2 no tiene agenda: el sábado 18 cubrió la ruta de VEC (elección del día) y hoy también.
      agenda: todaSemana(VEC, R_VEC),
      picks: [{ user_id: VEC2, work_date: '2026-10-18', route: R_VEC }, { user_id: VEC2, work_date: HOY, route: R_VEC }],
    }));
    const r = await svc.board(HOY);
    const dos = r.vendors.find((v) => v.user_id === VEC2)!;
    expect(dos.sales_period).toEqual({ amount: 3000.5, tickets: 7, unmeasured_reason: null });
    expect(dos.sales_day.amount).toBe(1000.5);
    expect(r.totals.sales_day).toBe(1000.5);
    expect(r.totals.sales_period).toBe(3000.5);
  });

  it('quien hoy no tiene ruta pero sí la tuvo en la catorcena sigue en el tablero: hoy null (sin ruta), catorcena medida', async () => {
    const { svc } = armar(mundo({
      team: [VEC2],
      agenda: [],
      picks: [{ user_id: VEC2, work_date: '2026-10-18', route: R_VEC }],
      targets: [],
    }));
    const r = await svc.board(HOY);
    const v = r.vendors[0];
    expect(v.user_id).toBe(VEC2);
    expect(v.routes).toEqual([]);
    expect(v.sales_day).toEqual({ amount: null, tickets: null, unmeasured_reason: SIN_MEDIR.sinRuta });
    expect(v.sales_period.amount).toBe(2000);
    expect(v.target).toBeNull();
    expect(v.progress_pct).toBeNull();
    expect(r.totals.sales_day).toBeNull(); // nada que medir hoy
    expect(r.totals.sales_period).toBe(2000);
    expect(r.totals.target).toBeNull();
  });

  it('una ruta vecinal sin venta ese día es $0 MEDIDO (no null)', async () => {
    const { svc } = armar(mundo({ department: 'ruta_vecinal', sales: [] }));
    const r = await svc.board(HOY);
    expect(r.vendors[0].sales_day).toEqual({ amount: 0, tickets: 0, unmeasured_reason: null });
    expect(r.vendors[0].progress_pct).toBe(0);
  });
});

describe('SupervisorBoardService.setTarget', () => {
  const ok = { user_id: VEC, period_start: '2026-10-17', amount: 15000.456 };

  it('⭐ captura: upsert con auditoría, redondeado a centavos', async () => {
    const { svc, raws } = armar(mundo({ department: 'ruta_vecinal' }));
    const r = await svc.setTarget(ok);
    expect(r).toEqual({ user_id: VEC, period_start: '2026-10-17', amount: 15000.46 });
    const ins = raws.find((x) => x.sql.includes('INSERT INTO commercial.vendor_targets'))!;
    expect(ins.sql).toContain('ON CONFLICT (tenant_id, user_id, period_start) WHERE deleted_at IS NULL');
    expect(ins.b).toEqual([VEC, '2026-10-17', 15000.46, YO, YO]);
  });

  it('amount null = borrar (soft delete con quién)', async () => {
    const { svc, updates, raws } = armar(mundo());
    const r = await svc.setTarget({ ...ok, amount: null });
    expect(r.amount).toBeNull();
    expect(updates).toHaveLength(1);
    expect(updates[0].tabla).toBe('commercial.vendor_targets');
    expect(updates[0].set).toMatchObject({ deleted_by: YO, updated_by: YO });
    expect(raws.some((x) => x.sql.includes('INSERT INTO'))).toBe(false);
  });

  it('⛔ vendedor ajeno (no es de su equipo) = 403', async () => {
    const { svc } = armar(mundo());
    await expect(svc.setTarget({ ...ok, user_id: AJENO })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('⛔ su propia meta = 403', async () => {
    const { svc } = armar(mundo({ team: [YO, VEC] }));
    await expect(svc.setTarget({ ...ok, user_id: YO })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('⛔ de su equipo pero fuera de su alcance (RV y el vendedor sólo tiene camión) = 403', async () => {
    const { svc, raws } = armar(mundo({ department: 'ruta_vecinal' }));
    await expect(svc.setTarget({ ...ok, user_id: CAM })).rejects.toBeInstanceOf(ForbiddenException);
    expect(raws.some((x) => x.sql.includes('INSERT INTO'))).toBe(false);
  });

  it('⛔ RD tampoco captura a la vecinal', async () => {
    const { svc } = armar(mundo({ department: 'ruta_directa' }));
    await expect(svc.setTarget(ok)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.setTarget({ ...ok, user_id: CAM })).resolves.toMatchObject({ user_id: CAM });
  });

  it('⛔ period_start que no abre catorcena = 400 (domingo, sábado a media catorcena, basura)', async () => {
    const { svc } = armar(mundo());
    for (const p of ['2026-10-18', '2026-10-24', '17/10/2026', '']) {
      await expect(svc.setTarget({ ...ok, period_start: p })).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('⛔ amount negativo, no numérico o fuera de rango = 400', async () => {
    const { svc } = armar(mundo());
    for (const a of [-1, -0.01, Number.NaN, Infinity, '100' as unknown as number, 1e15]) {
      await expect(svc.setTarget({ ...ok, amount: a })).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(svc.setTarget({ ...ok, amount: 0 })).resolves.toMatchObject({ amount: 0 });
  });

  it('user_id mal formado = 400', async () => {
    const { svc } = armar(mundo());
    await expect(svc.setTarget({ ...ok, user_id: 'x' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
