import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AssignRouteDto {
  user_id: string;
  sales_route: string;
}

export interface SetRouteOrderDto {
  sales_route: string;
  customer_ids: string[]; // en el orden de visita deseado
}

export interface CheckInDto {
  customer_id: string;
  notes?: string;
  latitude?: number;
  longitude?: number;
}

/**
 * V.0 Modo Vendedor v2 — cartera del vendedor (qué rutas de venta cubre) y orden
 * de visita de los clientes. El supervisor_ventas asigna (permiso USUARIOS_ASIGNAR_RUTA);
 * el vendedor solo lee su cartera. La cartera = clientes cuya sales_route está en
 * las rutas asignadas al vendedor.
 */
@Injectable()
export class CommercialVendorRoutesService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Rutas de venta del tenant (distinct de customers.sales_route) con conteo de clientes y a quién están asignadas. */
  async listSalesRoutes() {
    return this.tk.run(async (trx) => {
      const routes = await trx('commercial.customers')
        .whereNull('deleted_at')
        .whereNotNull('sales_route')
        .groupBy('sales_route')
        .select('sales_route', trx.raw('count(*)::int as customer_count'))
        .orderBy('sales_route');

      const assigns = await trx('commercial.vendor_sales_routes as v')
        .leftJoin('public.users as u', function () {
          this.on('u.tenant_id', '=', 'v.tenant_id').andOn('u.id', '=', 'v.user_id');
        })
        .select('v.id', 'v.sales_route', 'v.user_id', 'u.username');
      const byRoute = new Map<string, { id: string; user_id: string; username: string }[]>();
      for (const a of assigns) {
        if (!byRoute.has(a.sales_route)) byRoute.set(a.sales_route, []);
        byRoute.get(a.sales_route)!.push({ id: a.id, user_id: a.user_id, username: a.username });
      }
      return routes.map((r: any) => ({
        sales_route: r.sales_route,
        customer_count: r.customer_count,
        assigned_to: byRoute.get(r.sales_route) || [],
      }));
    });
  }

  /** Vendedores asignables (usuarios de campo activos). */
  async listVendors() {
    return this.tk.run(async (trx) =>
      trx('public.users')
        .whereIn('role_name', ['vendedor', 'colaborador', 'ejecutivo'])
        .where('activo', true)
        .select('id', 'username', 'role_name')
        .orderBy('username'),
    );
  }

  /** Clientes de una ruta de venta, ordenados por visit_sequence (para reordenar). */
  async customersByRoute(salesRoute: string) {
    const route = (salesRoute || '').trim().toUpperCase();
    if (!route) throw new BadRequestException('sales_route requerido');
    return this.tk.run(async (trx) =>
      trx('commercial.customers')
        .where({ sales_route: route })
        .whereNull('deleted_at')
        .select('id', 'code', 'name', 'visit_sequence', 'phone', 'whatsapp')
        .orderByRaw('visit_sequence asc nulls last, name asc'),
    );
  }

  /** Asignaciones cartera (vendedor → rutas). Opcional filtrar por vendedor. */
  async listAssignments(userId?: string) {
    if (userId && !UUID_REGEX.test(userId)) throw new BadRequestException('user_id inválido');
    return this.tk.run(async (trx) => {
      let q = trx('commercial.vendor_sales_routes as v')
        .leftJoin('public.users as u', function () {
          this.on('u.tenant_id', '=', 'v.tenant_id').andOn('u.id', '=', 'v.user_id');
        })
        .select('v.id', 'v.user_id', 'u.username', 'v.sales_route', 'v.created_at');
      if (userId) q = q.where('v.user_id', userId);
      return q.orderBy(['u.username', 'v.sales_route']);
    });
  }

  /** Asigna una ruta de venta a un vendedor (idempotente). */
  async assign(dto: AssignRouteDto) {
    if (!UUID_REGEX.test(dto.user_id)) throw new BadRequestException('user_id inválido');
    const route = (dto.sales_route || '').trim().toUpperCase();
    if (!route) throw new BadRequestException('sales_route requerido');

    return this.tk.run(async (trx) => {
      const createdBy = this.tenantCtx.get()?.userId || null;
      const [row] = await trx('commercial.vendor_sales_routes')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          user_id: dto.user_id,
          sales_route: route,
          created_by: createdBy,
        })
        .onConflict(['tenant_id', 'user_id', 'sales_route'])
        .ignore()
        .returning('*');
      return row || { assigned: false, reason: 'ya estaba asignada' };
    });
  }

  async unassign(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const n = await trx('commercial.vendor_sales_routes').where({ id }).del();
      if (!n) throw new NotFoundException('Asignación no encontrada');
      return { unassigned: true, id };
    });
  }

  /** Rutas de venta del vendedor logueado (su cartera). */
  async myRoutes(): Promise<string[]> {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) return [];
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.vendor_sales_routes')
        .where({ user_id: userId })
        .select('sales_route')
        .orderBy('sales_route');
      return rows.map((r: any) => r.sales_route);
    });
  }

  /**
   * V.4 — Cobertura del día: la cartera del vendedor (clientes de sus rutas,
   * en orden de visita) anotada con si ya fue visitado HOY (TZ MX) y la fecha
   * de la última visita. Base del apartado "Por visitar".
   */
  async myCoverageToday() {
    const me = this.tenantCtx.get()?.userId;
    if (!me) return [];
    return this.tk.run(async (trx) =>
      trx('commercial.customers as c')
        .whereNull('c.deleted_at')
        .whereExists(function () {
          this.select(trx.raw('1'))
            .from('commercial.vendor_sales_routes as vsr')
            .whereRaw('vsr.sales_route = c.sales_route')
            .andWhere('vsr.user_id', me);
        })
        .select(
          'c.id',
          'c.code',
          'c.name',
          'c.visit_sequence',
          'c.sales_route',
          'c.phone',
          'c.whatsapp',
          trx.raw(
            `EXISTS (
               SELECT 1 FROM commercial.vendor_visits vv
               WHERE vv.customer_id = c.id AND vv.user_id = ?
                 AND (vv.visited_at AT TIME ZONE 'America/Mexico_City')::date
                     = (now() AT TIME ZONE 'America/Mexico_City')::date
             ) as visited_today`,
            [me],
          ),
          trx.raw(
            `(SELECT max(vv2.visited_at) FROM commercial.vendor_visits vv2
               WHERE vv2.customer_id = c.id AND vv2.user_id = ?) as last_visit_at`,
            [me],
          ),
        )
        .orderByRaw('c.visit_sequence asc nulls last, c.name asc'),
    );
  }

  /**
   * V.5 — Feed del home "Mi ruta": la cartera del vendedor (en orden de visita)
   * anotada con todo lo que necesita la pantalla principal de un solo fetch:
   *  - visited_today / last_visit_at (cobertura)
   *  - ordered_today (ya le tomó pedido hoy, TZ MX)
   *  - pending_orders[]: pedidos pendientes del cliente (pending_approval/confirmed),
   *    con total + is_preventa + fecha de entrega agendada; + has_preventa_pending.
   */
  async myHome() {
    const me = this.tenantCtx.get()?.userId;
    if (!me) return [];
    return this.tk.run(async (trx) => {
      const customers = await trx('commercial.customers as c')
        .whereNull('c.deleted_at')
        .whereExists(function () {
          this.select(trx.raw('1'))
            .from('commercial.vendor_sales_routes as vsr')
            .whereRaw('vsr.sales_route = c.sales_route')
            .andWhere('vsr.user_id', me);
        })
        .select(
          'c.id',
          'c.code',
          'c.name',
          'c.visit_sequence',
          'c.sales_route',
          'c.phone',
          'c.whatsapp',
          trx.raw(
            `EXISTS (
               SELECT 1 FROM commercial.vendor_visits vv
               WHERE vv.customer_id = c.id AND vv.user_id = ?
                 AND (vv.visited_at AT TIME ZONE 'America/Mexico_City')::date
                     = (now() AT TIME ZONE 'America/Mexico_City')::date
             ) as visited_today`,
            [me],
          ),
          trx.raw(
            `(SELECT max(vv2.visited_at) FROM commercial.vendor_visits vv2
               WHERE vv2.customer_id = c.id AND vv2.user_id = ?) as last_visit_at`,
            [me],
          ),
          trx.raw(
            `EXISTS (
               SELECT 1 FROM commercial.orders o
               WHERE o.customer_id = c.id AND o.deleted_at IS NULL
                 AND (o.created_at AT TIME ZONE 'America/Mexico_City')::date
                     = (now() AT TIME ZONE 'America/Mexico_City')::date
             ) as ordered_today`,
          ),
        )
        .orderByRaw('c.visit_sequence asc nulls last, c.name asc');

      const ids = customers.map((c: any) => c.id);
      if (!ids.length) return [];

      const pending = await trx('commercial.orders as o')
        .leftJoin('public.users as u', 'u.id', 'o.user_id')
        .whereIn('o.customer_id', ids)
        .whereIn('o.status', ['pending_approval', 'confirmed'])
        .whereNull('o.deleted_at')
        .orderBy('o.created_at', 'desc')
        .select(
          'o.customer_id',
          'o.id',
          'o.code',
          'o.status',
          'o.total',
          'o.requested_delivery_date',
          'o.created_at',
          trx.raw("(u.role_name = 'customer_b2b') as is_preventa"),
        );

      const byCustomer = new Map<string, any[]>();
      for (const o of pending) {
        if (!byCustomer.has(o.customer_id)) byCustomer.set(o.customer_id, []);
        byCustomer.get(o.customer_id)!.push(o);
      }

      return customers.map((c: any) => {
        const orders = byCustomer.get(c.id) || [];
        return {
          ...c,
          pending_count: orders.length,
          pending_total: orders.reduce((s, o) => s + Number(o.total), 0),
          has_preventa_pending: orders.some((o) => o.is_preventa),
          pending_orders: orders,
        };
      });
    });
  }

  /** V.4 — Registra un check-in de visita del vendedor logueado a un cliente. */
  async checkIn(dto: CheckInDto) {
    if (!UUID_REGEX.test(dto.customer_id)) throw new BadRequestException('customer_id inválido');
    return this.tk.run(async (trx) => {
      const me = this.tenantCtx.get()?.userId;
      if (!me) throw new BadRequestException('Usuario no identificado');
      const customer = await trx('commercial.customers')
        .where({ id: dto.customer_id })
        .whereNull('deleted_at')
        .first();
      if (!customer) throw new NotFoundException(`Customer ${dto.customer_id} no encontrado`);

      const [row] = await trx('commercial.vendor_visits')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          user_id: me,
          customer_id: dto.customer_id,
          notes: dto.notes?.trim() || null,
          latitude: dto.latitude ?? null,
          longitude: dto.longitude ?? null,
        })
        .returning('*');
      return row;
    });
  }

  /** Setea visit_sequence (1..N) a los clientes de una ruta, en el orden recibido. */
  async setRouteOrder(dto: SetRouteOrderDto) {
    const route = (dto.sales_route || '').trim().toUpperCase();
    if (!route) throw new BadRequestException('sales_route requerido');
    if (!Array.isArray(dto.customer_ids) || dto.customer_ids.some((id) => !UUID_REGEX.test(id)))
      throw new BadRequestException('customer_ids debe ser array de UUIDs');

    return this.tk.run(async (trx) => {
      let seq = 1;
      let updated = 0;
      for (const cid of dto.customer_ids) {
        updated += await trx('commercial.customers')
          .where({ id: cid, sales_route: route })
          .whereNull('deleted_at')
          .update({ visit_sequence: seq, updated_at: trx.fn.now() });
        seq++;
      }
      return { ordered: updated, sales_route: route };
    });
  }
}
