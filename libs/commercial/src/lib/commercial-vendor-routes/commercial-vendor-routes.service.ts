import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';
import { vendorTodayRouteExistsSql } from '../shared/vendor-cartera.sql';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Radio default de "cliente cercano": más amplio que los 30 m de tiendas (clientes dispersos + drift GPS + estacionar). */
const DEFAULT_NEARBY_RADIUS_M = 80;
/** Separación mínima entre coords canónicas de 2 clientes distintos: por debajo, la detección sería ambigua → guard anti-traslape. */
const MIN_CUSTOMER_SEPARATION_M = 25;
/** Haversine en metros sobre c.latitude/c.longitude. Bindings: [lat, lat, lng]. */
const HAVERSINE_SQL = `6371000 * 2 * asin(sqrt(
  power(sin(radians((c.latitude - ?) / 2)), 2) +
  cos(radians(?)) * cos(radians(c.latitude)) *
  power(sin(radians((c.longitude - ?) / 2)), 2)
))`;

// (A) Una sola toma de GPS sincroniza el PdV completo: además del cliente,
// vincula/refresca la tienda de Trade. Radio para auto-vincular la tienda más
// cercana (más holgado que la detección de captura, por drift de GPS).
const STORE_LINK_RADIUS_M = 50;
/** Haversine en metros sobre trade.stores.latitud/longitud. Bindings: [lat, lat, lng]. */
const STORE_HAVERSINE_SQL = `6371000 * 2 * asin(sqrt(
  power(sin(radians((latitud - ?) / 2)), 2) +
  cos(radians(?)) * cos(radians(latitud)) *
  power(sin(radians((longitud - ?) / 2)), 2)
))`;

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

export interface SetLocationDto {
  latitude: number;
  longitude: number;
  /** Forzar el guardado pese al guard anti-traslape (el vendedor confirmó que es el cliente correcto). */
  force?: boolean;
}

/** Motivos válidos de no-venta (espejo del CHECK en la migración). */
export const NO_SALE_REASONS = [
  'cerrado',
  'no_atendio',
  'con_inventario',
  'sin_recursos',
  'no_interesado',
  'otro',
] as const;
export type NoSaleReason = (typeof NO_SALE_REASONS)[number];

export interface FinishVisitDto {
  customer_id: string;
  /** Se tomó un pedido (preventa) en la visita. */
  had_order?: boolean;
  /** Se capturó un ticket de venta directa. */
  had_ticket?: boolean;
  /** Motivo si no hubo venta (ignorado si had_order o had_ticket). */
  no_sale_reason?: NoSaleReason;
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

  /** Rutas de venta del vendedor para HOY (derivadas de trade — daily_assignments). */
  async myRoutes(): Promise<string[]> {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) return [];
    return this.tk.run(async (trx) => {
      const rows = await trx('public.daily_assignments as da')
        .join('public.catalogs as cat', function () {
          this.on('cat.id', '=', 'da.route_id')
            .andOnVal('cat.catalog_id', '=', 'rutas')
            .andOnNull('cat.deleted_at');
        })
        .where('da.user_id', userId)
        .whereRaw(
          `da.day_of_week = EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::int`,
        )
        .distinct('cat.value as sales_route')
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
        .whereRaw(vendorTodayRouteExistsSql('c'), [me])
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
        .whereRaw(vendorTodayRouteExistsSql('c'), [me])
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

  /**
   * V.6 — Clientes de la cartera cerca de la posición del vendedor, ordenados por
   * distancia (Haversine en SQL). Solo entran los geolocalizados (índice parcial).
   * Filtra por radio (default 80 m). Base de la autodetección de llegada en el home.
   */
  async nearbyCustomers(lat: number, lng: number, radius?: number) {
    const me = this.tenantCtx.get()?.userId;
    if (!me) return [];
    if (!Number.isFinite(lat) || !Number.isFinite(lng))
      throw new BadRequestException('lat/lng requeridos');
    const r =
      Number.isFinite(radius as number) && (radius as number) > 0
        ? Math.min(radius as number, 2000)
        : DEFAULT_NEARBY_RADIUS_M;
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.customers as c')
        .whereNull('c.deleted_at')
        .whereNotNull('c.latitude')
        .whereNotNull('c.longitude')
        .whereRaw(vendorTodayRouteExistsSql('c'), [me])
        .select(
          'c.id',
          'c.code',
          'c.name',
          'c.sales_route',
          'c.visit_sequence',
          'c.phone',
          'c.whatsapp',
          'c.latitude',
          'c.longitude',
          trx.raw(`${HAVERSINE_SQL} as distance_m`, [lat, lat, lng]),
        )
        .orderByRaw('distance_m asc')
        .limit(25);
      return rows
        .filter((x: any) => Number(x.distance_m) <= r)
        .map((x: any) => ({ ...x, distance_m: Math.round(Number(x.distance_m)) }));
    });
  }

  /**
   * Guard anti-traslape + set de coords canónicas de un cliente (dentro de una trx
   * dada). Si hay OTRO cliente con coords a menos de MIN_CUSTOMER_SEPARATION_M y no
   * se fuerza, NO guarda y devuelve el conflicto para que el vendedor desambigüe.
   */
  private async locate(
    trx: any,
    customerId: string,
    lat: number,
    lng: number,
    force: boolean,
    me: string | null,
  ) {
    const conflict = await trx('commercial.customers as c')
      .whereNull('c.deleted_at')
      .whereNot('c.id', customerId)
      .whereNotNull('c.latitude')
      .whereNotNull('c.longitude')
      .select('c.id', 'c.code', 'c.name', trx.raw(`${HAVERSINE_SQL} as distance_m`, [lat, lat, lng]))
      .orderByRaw('distance_m asc')
      .first();
    const dist = conflict ? Number(conflict.distance_m) : Infinity;
    if (!force && conflict && dist <= MIN_CUSTOMER_SEPARATION_M) {
      return {
        location_set: false,
        conflict: {
          customer_id: conflict.id,
          code: conflict.code,
          name: conflict.name,
          distance_m: Math.round(dist),
        },
        min_separation_m: MIN_CUSTOMER_SEPARATION_M,
      };
    }
    await trx('commercial.customers')
      .where({ id: customerId })
      .update({ latitude: lat, longitude: lng, updated_at: trx.fn.now(), updated_by: me || null });

    // (A) La misma toma sincroniza el PdV: vincula/refresca la tienda de Trade.
    const storeId = await this.syncStoreLocation(trx, customerId, lat, lng, me);

    return { location_set: true, customer_id: customerId, latitude: lat, longitude: lng, store_id: storeId };
  }

  /**
   * (A) Desde UNA toma de GPS del cliente, sincroniza su tienda de Trade:
   *  - si ya tiene store_id → propaga lat/lng al store (misma ubicación física);
   *  - si no → vincula la tienda activa más cercana (≤ STORE_LINK_RADIUS_M) que NO
   *    esté ya tomada por otro cliente (respeta el UNIQUE parcial) y le propaga la coord.
   *
   * Corre en un SAVEPOINT (trx anidada): si algo de la tienda falla, se revierte
   * solo esa parte SIN abortar la trx del cliente (evita 25P02 / perder el alta de
   * coords). Best-effort. Devuelve el store_id resultante o null.
   */
  private async syncStoreLocation(
    trx: any,
    customerId: string,
    lat: number,
    lng: number,
    me: string | null,
  ): Promise<string | null> {
    let storeId: string | null = null;
    try {
      await trx.transaction(async (sp: any) => {
        const cust = await sp('commercial.customers').where({ id: customerId }).first('store_id');
        storeId = cust?.store_id || null;

        if (!storeId) {
          const latDelta = STORE_LINK_RADIUS_M / 111_320;
          const lngDelta =
            STORE_LINK_RADIUS_M / (111_320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.0001));
          const nearest = await sp('trade.stores')
            .where({ activo: true })
            .whereNotNull('latitud')
            .whereNotNull('longitud')
            .whereBetween('latitud', [lat - latDelta, lat + latDelta])
            .whereBetween('longitud', [lng - lngDelta, lng + lngDelta])
            .select('id', sp.raw(`${STORE_HAVERSINE_SQL} as d`, [lat, lat, lng]))
            .orderByRaw('d asc')
            .first();
          if (nearest && Number(nearest.d) <= STORE_LINK_RADIUS_M) {
            const taken = await sp('commercial.customers')
              .where({ store_id: nearest.id })
              .whereNull('deleted_at')
              .first('id');
            if (!taken) {
              await sp('commercial.customers')
                .where({ id: customerId })
                .update({ store_id: nearest.id, updated_at: sp.fn.now(), updated_by: me || null });
              storeId = nearest.id;
            }
          }
        }

        if (storeId) {
          await sp('trade.stores')
            .where({ id: storeId })
            .update({ latitud: lat, longitud: lng, updated_at: sp.fn.now(), updated_by: me || null });
        }
      });
    } catch {
      storeId = null; // el savepoint hizo rollback; la trx del cliente sigue intacta
    }
    return storeId;
  }

  /** V.6 — Setea (o corrige) las coords canónicas de un cliente, con guard anti-traslape. */
  async setCustomerLocation(customerId: string, dto: SetLocationDto) {
    if (!UUID_REGEX.test(customerId)) throw new BadRequestException('customer_id inválido');
    const lat = Number(dto.latitude);
    const lng = Number(dto.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng))
      throw new BadRequestException('lat/lng requeridos');
    return this.tk.run(async (trx) => {
      const me = this.tenantCtx.get()?.userId || null;
      const customer = await trx('commercial.customers')
        .where({ id: customerId })
        .whereNull('deleted_at')
        .first('id');
      if (!customer) throw new NotFoundException(`Customer ${customerId} no encontrado`);
      return this.locate(trx, customerId, lat, lng, !!dto.force, me);
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

      // Capture-on-visit: si el cliente aún no tiene coords y el check-in trae GPS,
      // backfill con guard anti-traslape (no pisa si colisiona con otro cliente).
      let location: Awaited<ReturnType<typeof this.locate>> | null = null;
      if (dto.latitude != null && dto.longitude != null && customer.latitude == null) {
        location = await this.locate(
          trx,
          dto.customer_id,
          Number(dto.latitude),
          Number(dto.longitude),
          false,
          me,
        );
      }
      return { ...row, location };
    });
  }

  /**
   * V.7 — Cierra la visita con su resultado. Reusa la última visita ABIERTA de
   * hoy (mismo vendedor+cliente, ended_at NULL); si no hay, crea una (sirve de
   * check-in, con backfill de coords como en checkIn). Setea ended_at + flags +
   * motivo de no-venta. `had_order`/`had_ticket` los reporta el front (sabe qué
   * hizo en la visita); el motivo solo se guarda si NO hubo venta.
   */
  async finishVisit(dto: FinishVisitDto) {
    if (!UUID_REGEX.test(dto.customer_id)) throw new BadRequestException('customer_id inválido');
    const hadOrder = !!dto.had_order;
    const hadTicket = !!dto.had_ticket;
    const reason = !hadOrder && !hadTicket ? dto.no_sale_reason ?? null : null;
    if (reason && !NO_SALE_REASONS.includes(reason)) {
      throw new BadRequestException('no_sale_reason inválido');
    }
    return this.tk.run(async (trx) => {
      const me = this.tenantCtx.get()?.userId;
      if (!me) throw new BadRequestException('Usuario no identificado');
      const customer = await trx('commercial.customers')
        .where({ id: dto.customer_id })
        .whereNull('deleted_at')
        .first();
      if (!customer) throw new NotFoundException(`Customer ${dto.customer_id} no encontrado`);

      // Visita abierta de hoy (TZ MX) para reusar; si no hay, se crea.
      const open = await trx('commercial.vendor_visits')
        .where({ user_id: me, customer_id: dto.customer_id })
        .whereNull('ended_at')
        .whereRaw(`(visited_at AT TIME ZONE 'America/Mexico_City')::date = (now() AT TIME ZONE 'America/Mexico_City')::date`)
        .orderBy('visited_at', 'desc')
        .first();

      let location: Awaited<ReturnType<typeof this.locate>> | null = null;
      const patch = {
        ended_at: trx.fn.now(),
        had_order: hadOrder,
        had_ticket: hadTicket,
        no_sale_reason: reason,
        notes: dto.notes?.trim() || (open?.notes ?? null),
      };

      let row;
      if (open) {
        [row] = await trx('commercial.vendor_visits').where({ id: open.id }).update(patch).returning('*');
      } else {
        [row] = await trx('commercial.vendor_visits')
          .insert({
            tenant_id: trx.raw('public.current_tenant_id()'),
            user_id: me,
            customer_id: dto.customer_id,
            latitude: dto.latitude ?? null,
            longitude: dto.longitude ?? null,
            ...patch,
          })
          .returning('*');
      }

      // Backfill capture-on-visit si trae GPS y el cliente aún no tiene coords.
      if (dto.latitude != null && dto.longitude != null && customer.latitude == null) {
        location = await this.locate(trx, dto.customer_id, Number(dto.latitude), Number(dto.longitude), false, me);
      }
      return { ...row, location };
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
