import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import type { Knex } from 'knex';
import type { DayPickCleared, DayPickChoice, DayPickOption, DayPickState } from '@megadulces/contracts';
import { TenantKnexService } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';
import { isPlatformAdminRole } from '@megadulces/platform-core';
import { vendorTodayRouteExistsSql, vendorTodayRouteIdsSql } from '../shared/vendor-cartera.sql';
import { syncErpCarteraForToday, isErpGovernedRoute } from '../shared/vendor-cartera-erp';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC_REGEX = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;
const E164_REGEX = /^\+\d{8,15}$/;

/** Normaliza a E.164 (MX: 10 dígitos → +52...). Null si vacío; lanza si no forma un E.164 válido. */
function normalizeWhatsapp(raw?: string | null): string | null {
  if (raw == null) return null;
  const hadPlus = String(raw).trim().startsWith('+');
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  let e164: string;
  if (hadPlus) e164 = '+' + digits;
  else if (digits.length === 10) e164 = '+52' + digits;
  else if (digits.length === 12 && digits.startsWith('52')) e164 = '+' + digits;
  else if (digits.length === 13 && digits.startsWith('521')) e164 = '+52' + digits.slice(3);
  else e164 = '+' + digits;
  if (!E164_REGEX.test(e164)) {
    throw new BadRequestException('whatsapp inválido: usar 10 dígitos (MX) o formato E.164 (+52...)');
  }
  return e164;
}

/**
 * Normaliza visitDays a un arreglo de enteros válidos (ISO weekday 1-7).
 * Acepta Set<number>, number[] u otros iterables; filtra valores inválidos
 * para evitar mandar algo distinto de un array a Postgres (p.ej. "[object Set]").
 */
function toVisitDaysArray(visitDays: unknown): number[] {
  const arr = Array.isArray(visitDays)
    ? visitDays
    : visitDays instanceof Set
      ? Array.from(visitDays)
      : visitDays
        ? Array.from(visitDays as Iterable<unknown>)
        : [];
  return arr
    .map((d) => Number(d))
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
}

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

/** [VR.SUP.1] Acumulador por ruta al armar las opciones del día (interno al servicio). */
interface DayPickAccumulator {
  route_id: string;
  route: string;
  zone: string | null;
  today: boolean;
  days: Set<number>;
  vendors: Map<string, { username: string; today: boolean }>;
}

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

/** Alta rápida de cliente desde la app del vendedor (campo). */
export interface CreateVendorCustomerDto {
  name: string;
  phone?: string;
  whatsapp?: string;
  rfc?: string;
  legal_name?: string;
  sales_route?: string;
  /** Dirección / referencia libre — se guarda en notes. */
  notes?: string;
  /** Geo capturada al momento del alta (opcional). */
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

  /**
   * Fuentes de existencia del vendedor logueado, para el toggle "ver sucursal / ver
   * camioneta" del take-order:
   *   - `sucursal`: el almacén central que lo surte (por `users.warehouse_code` →
   *     `warehouses.kepler_code`). Si no tiene sucursal asignada, cae al almacén
   *     default del tenant (para que el catálogo nunca quede sin stock).
   *   - `camioneta`: el almacén `kind='truck'` cuyo `owner_user_id` es el vendedor
   *     (null si no tiene camión asignado → el app no muestra ese toggle).
   * El app pasa el `id` elegido como `warehouse_id` al catálogo → stock_available de
   * ESA fuente. Todo lectura, scope de tenant (RLS via tk.run).
   */
  async myStockSources() {
    const me = this.tenantCtx.get()?.userId || null;
    return this.tk.run(async (trx) => {
      // route_id vive en identity.users (la vista public.users no lo expone).
      const user = me
        ? await trx('identity.users').where({ id: me }).select('route_id', 'warehouse_code').first()
        : null;

      type Wh = { id: string; code: string; name: string };
      let sucursal: Wh | undefined;
      // De DÓNDE salió la sucursal: una asignación REAL (route/warehouse_code) o el
      // DEFAULT del tenant (fallback). Normalización del error "veo la sucursal
      // equivocada": el default no se dibuja como si fuera la sucursal del vendedor;
      // el app lo muestra como "sin asignar" para que se corrija, no que engañe.
      let sucursalSource: 'route' | 'warehouse_code' | 'default' | null = null;

      // La ruta operativa del vendedor sale de `daily_assignments` — lo que ESCRIBE el
      // panel de supervisor y LEE la cartera ("Mi ruta") + createCustomer. Se prefiere
      // la ruta de HOY (ISODOW MX); si no hay, cualquiera asignada. Fallback: el legacy
      // `users.route_id`. Así una asignación desde el panel maneja también el stock, sin
      // tener que setear route_id aparte (era la causa de "veo otra sucursal").
      let routeId: string | null = user?.route_id || null;
      // [VR.SUP.1] La ruta que el supervisor escogió para hoy manda: surte de la
      // sucursal de ESA ruta.
      let picked = false;
      // Sin try/catch a propósito: dentro de la trx un error la aborta (25P02) y el
      // catch no salvaría las queries siguientes. La migración va antes que el código.
      if (me) {
        const pick = await trx('commercial.vendor_route_day_picks')
          .where({ user_id: me })
          .whereNull('deleted_at')
          .whereRaw(`work_date = (now() AT TIME ZONE 'America/Mexico_City')::date`)
          .first('route_id');
        if (pick?.route_id) {
          routeId = pick.route_id;
          picked = true;
        }
      }
      if (me && !picked) {
        try {
          const da = await trx('public.daily_assignments')
            .where({ user_id: me })
            .whereNull('deleted_at')
            .select('route_id')
            .orderByRaw(
              `(day_of_week = EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::int) DESC`,
            )
            .first();
          if (da?.route_id) routeId = da.route_id;
        } catch {
          /* sin daily_assignments → usamos users.route_id */
        }
      }

      // 1. La verdad operativa: usuario → su ruta → sucursal de la ruta.
      //    En try/catch: la tabla route_warehouses es nueva; si el código despliega
      //    antes que su migración, NO rompemos la resolución (cae a warehouse_code /
      //    default). Lección del incidente client_uuid: código y migración pueden
      //    llegar desfasados.
      if (routeId) {
        try {
          sucursal = await trx('commercial.route_warehouses as rw')
            .join('commercial.warehouses as w', function () {
              this.on('w.id', '=', 'rw.warehouse_id').andOn('w.tenant_id', '=', 'rw.tenant_id');
            })
            .where('rw.route_id', routeId)
            .where('w.active', true)
            .whereNull('w.deleted_at')
            .select('w.id', 'w.code', 'w.name')
            .first<Wh>();
          if (sucursal) sucursalSource = 'route';
        } catch {
          /* route_warehouses aún no migrada → seguimos con los fallbacks */
        }
      }
      // 2. Fallback: warehouse_code directo del usuario (scoping Tienda).
      if (!sucursal && user?.warehouse_code) {
        sucursal = await trx('commercial.warehouses')
          .where({ kepler_code: user.warehouse_code, kind: 'central', active: true })
          .whereNull('deleted_at')
          .select('id', 'code', 'name')
          .first<Wh>();
        if (sucursal) sucursalSource = 'warehouse_code';
      }
      // 3. Fallback: el almacén default del tenant (para no quedar sin stock). NO es
      //    una asignación real → se marca 'default' para que el app lo declare.
      if (!sucursal) {
        sucursal = await trx('commercial.warehouses')
          .where({ is_default: true, active: true })
          .whereNull('deleted_at')
          .select('id', 'code', 'name')
          .first<Wh>();
        if (sucursal) sucursalSource = 'default';
      }

      const camioneta: Wh | undefined = me
        ? await trx('commercial.warehouses')
            .where({ kind: 'truck', owner_user_id: me, active: true })
            .whereNull('deleted_at')
            .select('id', 'code', 'name')
            .first<Wh>()
        : undefined;

      return {
        sucursal: sucursal
          ? {
              id: sucursal.id,
              code: sucursal.code,
              name: sucursal.name,
              // assigned=false → es el default del tenant, NO la sucursal del vendedor:
              // el app lo declara "sin asignar" en vez de mostrarlo como su surtido real.
              assigned: sucursalSource === 'route' || sucursalSource === 'warehouse_code',
              source: sucursalSource,
            }
          : null,
        camioneta: camioneta
          ? { id: camioneta.id, code: camioneta.code, name: camioneta.name }
          : null,
      };
    });
  }

  /**
   * Admin: las rutas del catálogo (`trade.catalogs` cat 'rutas') con su zona, la sucursal
   * de surtido ya asignada (si hay) y una SUGERENCIA por zona/nombre para pre-llenar la UI
   * (el admin confirma/corrige — no se inventa el vínculo, se propone). Devuelve además los
   * almacenes central asignables.
   */
  async listRoutesWithWarehouse() {
    return this.tk.run(async (trx) => {
      const whs = await trx('commercial.warehouses')
        .where({ kind: 'central', active: true })
        .whereNull('deleted_at')
        .select('id', 'code', 'name', 'kepler_code')
        .orderBy('code');
      const byKepler = new Map(whs.filter((w: any) => w.kepler_code).map((w: any) => [w.kepler_code, w]));
      const byCode = new Map(whs.map((w: any) => [w.code, w]));

      const routes = await trx('trade.catalogs as r')
        .leftJoin('public.zones as z', 'z.id', 'r.parent_id')
        .leftJoin('commercial.route_warehouses as rw', function () {
          this.on('rw.route_id', '=', 'r.id').andOn('rw.tenant_id', '=', 'r.tenant_id');
        })
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.id', '=', 'rw.warehouse_id').andOn('w.tenant_id', '=', 'rw.tenant_id');
        })
        .where('r.catalog_id', 'rutas')
        .whereNull('r.deleted_at')
        .select(
          'r.id as route_id',
          'r.value as route',
          'z.name as zone',
          'rw.warehouse_id as assigned_id',
          'w.name as assigned_name',
        )
        .orderBy(['z.name', 'r.value']);

      // Sugerencia por zona/nombre (heurística; el admin la confirma). RVLPA = La Piedad
      // Abastos (02); el resto de La Piedad = Padre Hidalgo (01); Zamora=05; Canindo=06;
      // Morelia Madero = MD-32.
      const suggest = (zone: string | null, route: string | null) => {
        const zn = (zone || '').toUpperCase();
        const rv = (route || '').toUpperCase();
        if (rv.startsWith('RVLPA')) return byKepler.get('02');
        if (zn.includes('LA PIEDAD')) return byKepler.get('01');
        if (zn.includes('ZAMORA')) return byKepler.get('05');
        if (zn.includes('CANINDO')) return byKepler.get('06');
        if (zn.includes('MORELIA')) return byCode.get('MD-32') || byCode.get('MD-30');
        return undefined;
      };

      return {
        warehouses: whs.map((w: any) => ({ id: w.id, code: w.code, name: w.name })),
        routes: routes.map((r: any) => {
          const s = r.assigned_id ? null : suggest(r.zone, r.route);
          return {
            route_id: r.route_id,
            route: r.route,
            zone: r.zone,
            warehouse_id: r.assigned_id || null,
            warehouse_name: r.assigned_name || null,
            suggested_id: s?.id || null,
            suggested_name: s?.name || null,
          };
        }),
      };
    });
  }

  /** Admin: asigna (o cambia) la sucursal de surtido de una ruta. Idempotente (UPSERT). */
  async setRouteWarehouse(routeId: string, warehouseId: string) {
    if (!UUID_REGEX.test(routeId)) throw new BadRequestException('route_id inválido');
    if (!UUID_REGEX.test(warehouseId)) throw new BadRequestException('warehouse_id inválido');
    const me = this.tenantCtx.get()?.userId || null;
    return this.tk.run(async (trx) => {
      const route = await trx('trade.catalogs')
        .where({ id: routeId, catalog_id: 'rutas' })
        .whereNull('deleted_at')
        .select('id', 'tenant_id')
        .first();
      if (!route) throw new NotFoundException('Ruta no encontrada');
      const wh = await trx('commercial.warehouses')
        .where({ id: warehouseId, kind: 'central' })
        .whereNull('deleted_at')
        .first();
      if (!wh) throw new BadRequestException('Almacén inválido (debe ser una sucursal central)');
      await trx('commercial.route_warehouses')
        .insert({
          tenant_id: route.tenant_id,
          route_id: routeId,
          warehouse_id: warehouseId,
          created_by: me,
          updated_by: me,
        })
        .onConflict(['tenant_id', 'route_id'])
        .merge({ warehouse_id: warehouseId, updated_by: me, updated_at: trx.fn.now() });
      return { route_id: routeId, warehouse_id: warehouseId };
    });
  }

  /** Vendedores asignables (usuarios de campo activos). Los roles reales de campo son
   *  `vendedor_ruta`/`promotor_ruta` (no `vendedor` a secas, que no existe) — el filtro
   *  viejo devolvía [] y dejaba vacíos los dropdowns de asignación.
   *
   *  Alcance: un supervisor solo ve SU equipo (`supervisor_id = él`), no todo el tenant
   *  — antes veía a todos. El god-mode (platform admin) sí ve todos. Sin identidad →
   *  nada (fail-closed). Todo vendedor de campo activo tiene supervisor_id poblado. */
  async listVendors() {
    const ctx = this.tenantCtx.get();
    const me = ctx?.userId || null;
    const seeAll = isPlatformAdminRole(ctx?.roleName);
    return this.tk.run(async (trx) => {
      let q = trx('public.users')
        .whereIn('role_name', [
          'vendedor_ruta',
          'promotor_ruta',
          'vendedor',
          'colaborador',
          'ejecutivo',
        ])
        .where('activo', true);
      if (!seeAll) {
        if (!me) return [];
        q = q.where('supervisor_id', me);
      }
      return q.select('id', 'username', 'role_name').orderBy('username');
    });
  }

  /** Catálogo de rutas (trade.catalogs 'rutas') con su zona — para el picker del panel
   *  de supervisores que asigna rutas a vendedores. */
  async listRouteCatalog() {
    return this.tk.run(async (trx) =>
      trx('trade.catalogs as r')
        .leftJoin('public.zones as z', 'z.id', 'r.parent_id')
        .where('r.catalog_id', 'rutas')
        .whereNull('r.deleted_at')
        .select('r.id as route_id', 'r.value as route', 'z.name as zone')
        .orderBy(['z.name', 'r.value']),
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

  /**
   * Rutas de venta del vendedor para HOY: la escogida por el supervisor [VR.SUP.1] o,
   * si no escogió, su agenda de trade (daily_assignments).
   */
  async myRoutes(): Promise<string[]> {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) return [];
    return this.tk.run(async (trx) => {
      const rows = await trx('public.catalogs as cat')
        .where('cat.catalog_id', 'rutas')
        .whereNull('cat.deleted_at')
        .whereRaw(`cat.id IN (${vendorTodayRouteIdsSql()})`, [userId])
        .distinct('cat.value as sales_route')
        .orderBy('sales_route');
      return rows.map((r: any) => r.sales_route);
    });
  }

  // ─── [VR.SUP.1] Ruta del día escogida por el supervisor de ventas ───

  /**
   * Estado de "¿qué ruta vas a trabajar hoy?" para el usuario logueado.
   *  - `can_pick`: tiene equipo a su cargo (`users.supervisor_id = él`) o es god-mode.
   *    El supervisor se reconoce por tener gente a cargo — el mismo criterio con el que
   *    `listVendors` ya acota su panel —, no por nombre de rol.
   *  - `current`: la ruta que escogió HOY (null = trabaja su agenda normal).
   *  - `agenda_today`: lo que su agenda semanal le pone hoy (lo que ve si no escoge).
   *  - `options`: rutas de su equipo + las suyas, con quién la trabaja, qué días,
   *    si toca hoy y cuántos clientes tiene. Ordenadas: primero las que tocan hoy.
   */
  async dayPickState(): Promise<DayPickState> {
    const ctx = this.tenantCtx.get();
    const me = ctx?.userId || null;
    const empty: DayPickState = { can_pick: false, current: null, agenda_today: [], options: [] };
    if (!me) return empty;
    const seeAll = isPlatformAdminRole(ctx?.roleName);

    return this.tk.run(async (trx) => {
      const team = await trx('public.users')
        .where({ supervisor_id: me, activo: true })
        .select('id');
      const canPick = seeAll || team.length > 0;

      const [current, agenda] = await Promise.all([
        trx('commercial.vendor_route_day_picks as p')
          .join('public.catalogs as cat', 'cat.id', 'p.route_id')
          .where('p.user_id', me)
          .whereNull('p.deleted_at')
          .whereRaw(`p.work_date = (now() AT TIME ZONE 'America/Mexico_City')::date`)
          .first('p.route_id', 'cat.value as route', 'p.updated_at'),
        trx('public.daily_assignments as da')
          .join('public.catalogs as cat', function () {
            this.on('cat.id', '=', 'da.route_id')
              .andOnVal('cat.catalog_id', '=', 'rutas')
              .andOnNull('cat.deleted_at');
          })
          .where('da.user_id', me)
          .whereRaw(`da.day_of_week = EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::int`)
          .distinct('cat.value as route')
          .orderBy('route'),
      ]);

      const options = canPick
        ? await this.dayPickOptions(trx, me, team.map((t: { id: string }) => t.id), seeAll)
        : [];

      return {
        can_pick: canPick,
        current: current ? { route_id: current.route_id, route: current.route } : null,
        agenda_today: agenda.map((a: { route: string }) => a.route),
        options,
      };
    });
  }

  /** Rutas elegibles: las de la agenda del equipo + las del propio supervisor (god-mode: todas las agendadas). */
  private async dayPickOptions(trx: Knex.Transaction, me: string, teamIds: string[], seeAll: boolean): Promise<DayPickOption[]> {
    const userIds = [me, ...teamIds];
    const rows = await trx('public.daily_assignments as da')
      .join('public.catalogs as cat', function (this: Knex.JoinClause) {
        this.on('cat.id', '=', 'da.route_id')
          .andOnVal('cat.catalog_id', '=', 'rutas')
          .andOnNull('cat.deleted_at');
      })
      .join('public.users as u', 'u.id', 'da.user_id')
      .leftJoin('public.zones as z', 'z.id', 'cat.parent_id')
      .modify((q: Knex.QueryBuilder) => {
        if (!seeAll) q.whereIn('da.user_id', userIds);
      })
      .select(
        'cat.id as route_id',
        'cat.value as route',
        'z.name as zone',
        'u.id as user_id',
        'u.username',
        'da.day_of_week',
        trx.raw(
          `(da.day_of_week = EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::int) AS is_today`,
        ),
      );
    if (!rows.length) return [];

    const byRoute = new Map<string, DayPickAccumulator>();
    for (const r of rows) {
      let o = byRoute.get(r.route_id);
      if (!o) {
        o = { route_id: r.route_id, route: r.route, zone: r.zone, today: false, days: new Set<number>(), vendors: new Map<string, { username: string; today: boolean }>() };
        byRoute.set(r.route_id, o);
      }
      o.days.add(Number(r.day_of_week));
      if (r.is_today) o.today = true;
      const v = o.vendors.get(r.user_id) || { username: r.username, today: false };
      if (r.is_today) v.today = true;
      o.vendors.set(r.user_id, v);
    }

    const counts = await trx('commercial.customers')
      .whereNull('deleted_at')
      .whereIn('sales_route', [...byRoute.values()].map((o) => o.route))
      .groupBy('sales_route')
      .select('sales_route', trx.raw('count(*)::int AS n'));
    const countBy = new Map<string, number>(
      counts.map((c: { sales_route: string; n: number }) => [c.sales_route, Number(c.n)]),
    );

    return [...byRoute.values()]
      .map((o) => ({
        route_id: o.route_id,
        route: o.route,
        zone: o.zone,
        scheduled_today: o.today,
        days: [...o.days].sort((a: number, b: number) => a - b),
        // Quién la trabaja (y si le toca hoy). "Tú" = el propio supervisor.
        vendors: [...o.vendors.entries()].map(([id, v]) => ({ username: v.username, today: v.today, is_me: id === me })),
        customers: countBy.get(o.route) ?? 0,
      }))
      .sort((a, b) => Number(b.scheduled_today) - Number(a.scheduled_today) || a.route.localeCompare(b.route, 'es', { numeric: true }));
  }

  /** Escoge la ruta a trabajar HOY. Solo rutas de su equipo (o suyas). Cambiar = re-escoger. */
  async setDayPick(routeId: string): Promise<DayPickChoice> {
    if (!routeId || !UUID_REGEX.test(routeId)) throw new BadRequestException('route_id inválido');
    const ctx = this.tenantCtx.get();
    const me = ctx?.userId || null;
    if (!me) throw new BadRequestException('Sin usuario en sesión');
    const seeAll = isPlatformAdminRole(ctx?.roleName);

    return this.tk.run(async (trx) => {
      const team = await trx('public.users').where({ supervisor_id: me, activo: true }).select('id');
      if (!seeAll && !team.length) {
        throw new BadRequestException('Solo un supervisor con equipo a cargo puede escoger ruta');
      }
      const options = await this.dayPickOptions(trx, me, team.map((t: { id: string }) => t.id), seeAll);
      const chosen = options.find((o) => o.route_id === routeId);
      if (!chosen) throw new BadRequestException('Esa ruta no es de tu equipo');

      const existing = await trx('commercial.vendor_route_day_picks')
        .where({ user_id: me })
        .whereNull('deleted_at')
        .whereRaw(`work_date = (now() AT TIME ZONE 'America/Mexico_City')::date`)
        .forUpdate()
        .first('id');
      if (existing) {
        await trx('commercial.vendor_route_day_picks')
          .where({ id: existing.id })
          .update({ route_id: routeId, updated_at: trx.fn.now(), updated_by: me });
      } else {
        await trx('commercial.vendor_route_day_picks').insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          user_id: me,
          route_id: routeId,
          work_date: trx.raw(`(now() AT TIME ZONE 'America/Mexico_City')::date`),
          created_by: me,
          updated_by: me,
        });
      }
      return { route_id: chosen.route_id, route: chosen.route };
    });
  }

  /** Vuelve a su agenda normal de hoy (borra la elección del día). */
  async clearDayPick(): Promise<DayPickCleared> {
    const me = this.tenantCtx.get()?.userId || null;
    if (!me) throw new BadRequestException('Sin usuario en sesión');
    return this.tk.run(async (trx) => {
      const n = await trx('commercial.vendor_route_day_picks')
        .where({ user_id: me })
        .whereNull('deleted_at')
        .whereRaw(`work_date = (now() AT TIME ZONE 'America/Mexico_City')::date`)
        .update({ deleted_at: trx.fn.now(), deleted_by: me, updated_at: trx.fn.now(), updated_by: me });
      return { cleared: n > 0 };
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
    return this.tk.run(async (trx) => {
      // [VK.4] Rutas gobernadas por Kepler: su cartera se sincroniza desde la ficha antes de leer.
      await syncErpCarteraForToday(trx, me);
      return trx('commercial.customers as c')
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
        .orderByRaw('c.visit_sequence asc nulls last, c.name asc');
    });
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
      // [VK.4] Rutas gobernadas por Kepler: su cartera se sincroniza desde la ficha antes de leer.
      await syncErpCarteraForToday(trx, me);
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
          // [VK.4] De dónde sale el cliente: 'kepler' = su ficha la gobierna el ERP.
          trx.raw(`CASE WHEN c.erp_customer_code IS NOT NULL THEN 'kepler' ELSE 'manual' END AS source`),
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
                 AND o.status <> 'draft'
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

  /**
   * Alta rápida de cliente desde la app del vendedor. Genera el `code` (el
   * vendedor no inventa códigos), asigna la price list default del tenant para
   * que el cliente sea pedible de inmediato y guarda geo si viene. Solo CREA
   * (nunca edita/borra) — gateado por COMMERCIAL_ORDERS_CREAR en el controller.
   */
  async createCustomer(dto: CreateVendorCustomerDto) {
    const name = (dto.name || '').trim();
    if (!name) throw new BadRequestException('name requerido');
    if (dto.rfc && !RFC_REGEX.test(dto.rfc.toUpperCase())) {
      throw new BadRequestException(
        'rfc inválido (formato MX: 3-4 letras + 6 dígitos + 3 alfanuméricos)',
      );
    }
    const whatsapp = normalizeWhatsapp(dto.whatsapp);
    const lat = dto.latitude != null ? Number(dto.latitude) : null;
    const lng = dto.longitude != null ? Number(dto.longitude) : null;
    if ((lat != null && !Number.isFinite(lat)) || (lng != null && !Number.isFinite(lng))) {
      throw new BadRequestException('lat/lng inválidos');
    }

    return this.tk.run(async (trx) => {
      const me = this.tenantCtx.get()?.userId || null;

      // Auto-asignar a la cartera del vendedor para que el cliente aparezca en
      // "Mi ruta": sin sales_route + visit_days que matcheen, vendor-cartera.sql
      // lo deja fuera. Tomamos la ruta de HOY (o la primera de su cartera) y los
      // días en que el vendedor recorre esa ruta (daily_assignments de trade).
      let salesRoute = dto.sales_route?.trim().toUpperCase() || null;
      let visitDays: number[] = [];
      // [VR.SUP.1] Si el supervisor escogió ruta hoy, el cliente nuevo es de ESA ruta,
      // con los días en que la recorre su vendedor dueño (cualquiera en la agenda).
      if (!salesRoute && me) {
        const pick = await trx('commercial.vendor_route_day_picks as p')
          .join('public.catalogs as cat', 'cat.id', 'p.route_id')
          .where('p.user_id', me)
          .whereNull('p.deleted_at')
          .whereRaw(`p.work_date = (now() AT TIME ZONE 'America/Mexico_City')::date`)
          .first('p.route_id', 'cat.value as ruta');
        if (pick) {
          salesRoute = pick.ruta;
          const days = await trx('public.daily_assignments')
            .where({ route_id: pick.route_id })
            .distinct('day_of_week');
          visitDays = days.map((d: { day_of_week: number }) => Number(d.day_of_week)).sort((x: number, y: number) => x - y);
        }
      }
      if (!salesRoute && me) {
        const asg = await trx('public.daily_assignments as da')
          .join('public.catalogs as cat', function () {
            this.on('cat.id', '=', 'da.route_id')
              .andOnVal('cat.catalog_id', '=', 'rutas')
              .andOnNull('cat.deleted_at');
          })
          .where('da.user_id', me)
          .select(
            'cat.value as ruta',
            'da.day_of_week',
            trx.raw(
              `(da.day_of_week = EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::int) as is_today`,
            ),
          );
        if (asg.length) {
          const byRoute = new Map<string, Set<number>>();
          for (const a of asg) {
            if (!byRoute.has(a.ruta)) byRoute.set(a.ruta, new Set());
            byRoute.get(a.ruta)!.add(Number(a.day_of_week));
          }
          const chosen = asg.find((a: any) => a.is_today)?.ruta || asg[0].ruta;
          salesRoute = chosen;
          visitDays = [...(byRoute.get(chosen) || [])].sort((x, y) => x - y);
        }
      }

      // [VK.4] En una ruta gobernada por Kepler los clientes VIENEN de Kepler: un alta
      // manual acá sería un cliente que Kepler no conoce (y que la próxima sincronización
      // no podría gobernar). Se da de alta en Kepler y aparece solo al abrir la ruta.
      if (salesRoute && (await isErpGovernedRoute(trx, salesRoute))) {
        throw new BadRequestException(
          'Los clientes de esta ruta vienen de Kepler: dalo de alta en Kepler y aparecerá solo en tu ruta.',
        );
      }

      // Price list default del tenant → el cliente queda pedible al instante.
      const defaultPl = await trx('commercial.price_lists')
        .where({ is_default: true, active: true })
        .whereNull('deleted_at')
        .first();

      // Code auto-generado (prefijo V- = alta de vendedor). El random hace
      // despreciable la colisión: así no necesitamos retry dentro de la trx
      // (un 23505 la abortaría → 25P02).
      const code = 'V-' + randomBytes(5).toString('hex').toUpperCase();

      // Blindaje: visitDays puede venir como Set (o cualquier otra cosa) desde
      // ramas previas; normalizamos siempre a number[] antes de tocar la DB
      // para no repetir el bug de "[object Set]" en smallint[].
      const visitDaysArray = toVisitDaysArray(visitDays);

      try {
        const [row] = await trx('commercial.customers')
          .insert({
            tenant_id: trx.raw('public.current_tenant_id()'),
            code,
            name,
            legal_name: dto.legal_name?.trim() || null,
            rfc: dto.rfc?.toUpperCase() || null,
            phone: dto.phone?.trim() || null,
            whatsapp,
            sales_route: salesRoute,
            visit_days: visitDaysArray.length
              ? trx.raw('?::smallint[]', ['{' + visitDaysArray.join(',') + '}'])
              : null,
            default_price_list_id: defaultPl?.id || null,
            credit_limit: 0,
            payment_terms_days: 0, // cash-only beta
            active: true,
            notes: dto.notes?.trim() || null,
            latitude: lat,
            longitude: lng,
          })
          .returning('*');
        return row;
      } catch (e: any) {
        if (e?.code === '23505') {
          const c = String(e.constraint || '');
          if (c.includes('whatsapp')) {
            throw new ConflictException(
              'Ese número de WhatsApp ya está registrado en otro cliente.',
            );
          }
          throw new ConflictException(
            'No se pudo crear el cliente (dato duplicado). Reintentá.',
          );
        }
        throw e;
      }
    });
  }
}
