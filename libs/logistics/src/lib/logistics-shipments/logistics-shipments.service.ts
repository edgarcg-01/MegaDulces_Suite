import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Inject,
} from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';
import { ORDER_FULFILLMENT_PORT, OrderFulfillmentPort } from '@megadulces/contracts';
import { haversineKm } from '../logistics-routing/route-solver';

export type ShipmentStatus =
  | 'programado'
  | 'checklist_salida'
  | 'en_ruta'
  | 'entregado'
  | 'checklist_llegada'
  | 'costos_pendientes'
  | 'cerrado'
  | 'cancelado';
export type ShipmentType = 'entrega' | 'traspaso' | 'recoleccion';

export interface CreateShipmentDto {
  shipment_date: string; // ISO date
  vehicle_id?: string;
  route_id?: string;
  order_id?: string; // hook opcional a commercial.orders
  origin?: string;
  destination?: string;
  type?: ShipmentType;
  cargo_value?: number;
  boxes_count?: number;
  total_weight_kg?: number;
  notes?: string;
}

export interface UpdateShipmentDto extends Partial<CreateShipmentDto> {
  actual_km?: number;
  freight_revenue?: number;
}

export interface ListShipmentsQuery {
  status?: ShipmentStatus;
  vehicle_id?: string;
  driver_id?: string; // filtra via guides
  order_id?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Transiciones válidas del state machine (Fase J.8 — extendida desde repo origen).
 *
 * Dos flujos soportados:
 *  - Simple (J.0-J.7):  programado → en_ruta → entregado → cerrado
 *  - Formal (repo):     programado → checklist_salida → en_ruta → entregado →
 *                       checklist_llegada → costos_pendientes → cerrado
 *
 * Los estados nuevos (checklist_salida, checklist_llegada, costos_pendientes)
 * son OPCIONALES: el operador puede saltarlos si no necesita el control formal.
 * Cancelado se permite desde cualquier estado activo (no desde cerrado).
 */
const VALID_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  programado: ['checklist_salida', 'en_ruta', 'cancelado'],
  checklist_salida: ['en_ruta', 'cancelado'],
  en_ruta: ['entregado', 'cancelado'],
  entregado: ['checklist_llegada', 'cerrado', 'cancelado'],
  checklist_llegada: ['costos_pendientes', 'cerrado', 'cancelado'],
  costos_pendientes: ['cerrado', 'cancelado'],
  cerrado: [],
  cancelado: [],
};

@Injectable()
export class LogisticsShipmentsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    @Inject(ORDER_FULFILLMENT_PORT)
    private readonly orderFulfillment: OrderFulfillmentPort,
  ) {}

  // ── Create ───────────────────────────────────────────────────────────────

  async create(dto: CreateShipmentDto) {
    this.validateCreate(dto);

    return this.tk.run(async (trx) => {
      // Validar referencias si vienen
      if (dto.vehicle_id) await this.assertVehicleAvailable(trx, dto.vehicle_id);
      if (dto.route_id) await this.assertRouteExists(trx, dto.route_id);
      if (dto.order_id) await this.assertOrderExists(trx, dto.order_id);

      const folio = await this.nextFolio(trx, 'EMB');

      const [row] = await trx('logistics.shipments')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          folio,
          shipment_date: dto.shipment_date,
          vehicle_id: dto.vehicle_id || null,
          route_id: dto.route_id || null,
          order_id: dto.order_id || null,
          origin: dto.origin || null,
          destination: dto.destination || null,
          type: dto.type || 'entrega',
          cargo_value: dto.cargo_value || 0,
          boxes_count: dto.boxes_count || 0,
          total_weight_kg: dto.total_weight_kg || 0,
          status: 'programado',
          notes: dto.notes || null,
        })
        .returning('*');
      return row;
    });
  }

  // ── List + Find ──────────────────────────────────────────────────────────

  async list(query: ListShipmentsQuery) {
    const page = Math.max(1, query.page || 1);
    const pageSize = Math.min(200, Math.max(1, query.pageSize || 50));
    const offset = (page - 1) * pageSize;

    return this.tk.run(async (trx) => {
      let q = trx('logistics.shipments as s').whereNull('s.deleted_at');
      if (query.status) q = q.where('s.status', query.status);
      if (query.vehicle_id) q = q.where('s.vehicle_id', query.vehicle_id);
      if (query.order_id) q = q.where('s.order_id', query.order_id);
      if (query.from) q = q.where('s.shipment_date', '>=', query.from);
      if (query.to) q = q.where('s.shipment_date', '<=', query.to);
      if (query.driver_id) {
        // Filtra via subquery a guides
        q = q.whereIn('s.id', function (this: any) {
          this.select('shipment_id')
            .from('logistics.delivery_guides')
            .where(function (this: any) {
              this.where('driver_id', query.driver_id)
                .orWhere('helper1_id', query.driver_id)
                .orWhere('helper2_id', query.driver_id);
            });
        });
      }

      const [{ total }] = await q.clone().count<{ total: string }[]>('s.id as total');
      const rows = await q
        .clone()
        .orderBy('s.shipment_date', 'desc')
        .orderBy('s.folio', 'desc')
        .limit(pageSize)
        .offset(offset);

      return {
        items: rows,
        page,
        pageSize,
        total: Number(total),
        totalPages: Math.ceil(Number(total) / pageSize),
      };
    });
  }

  async findById(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const row = await trx('logistics.shipments')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!row) throw new NotFoundException(`Shipment ${id} no encontrado`);
      return row;
    });
  }

  /**
   * J.9.7 — Shipments del chofer logueado.
   *
   * Resuelve `logistics.drivers.user_id = JWT user_id` para obtener el driver_id,
   * luego lista shipments donde el driver aparece (como driver, helper1 o helper2)
   * en alguna de las delivery_guides asociadas.
   *
   * Filtros opcionales: `status` (default: shipments activos, no cerrado/cancelado),
   * `from` / `to` para rango de fechas.
   */
  async myDriverShipments(opts: { status?: ShipmentStatus; from?: string; to?: string } = {}) {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) throw new BadRequestException('Sin user_id en contexto');

    return this.tk.run(async (trx) => {
      const driver = await trx('logistics.drivers')
        .where({ user_id: userId })
        .whereNull('deleted_at')
        .first();
      if (!driver) {
        // El user no tiene driver asociado → lista vacía (no es un error)
        return [];
      }

      let q = trx('logistics.shipments as s')
        .leftJoin('logistics.vehicles as v', 'v.id', 's.vehicle_id')
        .leftJoin('logistics.routes as r', 'r.id', 's.route_id')
        .leftJoin('commercial.orders as o', 'o.id', 's.order_id')
        .leftJoin('commercial.customers as c', 'c.id', 'o.customer_id')
        .whereNull('s.deleted_at')
        .whereIn('s.id', function (this: any) {
          this.select('shipment_id')
            .from('logistics.delivery_guides')
            .where(function (this: any) {
              this.where('driver_id', driver.id)
                .orWhere('helper1_id', driver.id)
                .orWhere('helper2_id', driver.id);
            })
            .whereNull('deleted_at');
        });

      if (opts.status) q = q.where('s.status', opts.status);
      else q = q.whereNotIn('s.status', ['cerrado', 'cancelado']);
      if (opts.from) q = q.where('s.shipment_date', '>=', opts.from);
      if (opts.to) q = q.where('s.shipment_date', '<=', opts.to);

      return q
        .select(
          's.*',
          'v.plate as vehicle_plate',
          'v.model as vehicle_model',
          'r.name as route_name',
          'o.code as order_code',
          'c.name as customer_name',
        )
        .orderBy('s.shipment_date', 'desc');
    });
  }

  /**
   * J12.1 — Posiciones en vivo de la flota: embarques `en_ruta` con la última
   * posición GPS de su chofer (reusa route_location_pings que ya alimenta el
   * RoutePingService web). Sin hardware: el puente de rastreo en vivo.
   */
  async livePositions() {
    return this.tk.run(async (trx) => {
      const ships = await trx('logistics.shipments as s')
        .join('logistics.delivery_guides as g', function (this: any) {
          this.on('g.shipment_id', 's.id').andOnNull('g.deleted_at');
        })
        .join('logistics.drivers as d', 'd.id', 'g.driver_id')
        .leftJoin('logistics.vehicles as v', 'v.id', 's.vehicle_id')
        .where('s.status', 'en_ruta')
        .whereNull('s.deleted_at')
        .whereNotNull('d.user_id')
        .select(
          's.id as shipment_id',
          's.folio',
          's.destination',
          'd.full_name as driver_name',
          'd.user_id',
          'v.plate as vehicle_plate',
        );

      // Dedup por embarque (un shipment puede tener varias guías/choferes).
      const byShipment = new Map<string, any>();
      for (const r of ships) if (!byShipment.has(r.shipment_id)) byShipment.set(r.shipment_id, r);
      const rows = [...byShipment.values()];
      const userIds = [...new Set(rows.map((r) => r.user_id))];
      if (!userIds.length) return [];

      // route_location_pings es public (sin RLS) → filtrar tenant explícito.
      const pings = await trx('public.route_location_pings')
        .whereRaw('tenant_id = public.current_tenant_id()')
        .whereIn('user_id', userIds)
        .whereRaw("captured_at > now() - interval '12 hours'")
        .distinctOn('user_id')
        .orderBy([{ column: 'user_id' }, { column: 'captured_at', order: 'desc' }])
        .select('user_id', 'lat', 'lng', 'captured_at', 'accuracy_m');
      const pingByUser = new Map(pings.map((p: any) => [p.user_id, p]));

      return rows
        .map((r) => {
          const p = pingByUser.get(r.user_id);
          if (!p) return null;
          return {
            shipment_id: r.shipment_id,
            folio: r.folio,
            destination: r.destination,
            driver_name: r.driver_name,
            vehicle_plate: r.vehicle_plate,
            lat: Number(p.lat),
            lng: Number(p.lng),
            accuracy_m: p.accuracy_m != null ? Number(p.accuracy_m) : null,
            captured_at: p.captured_at,
          };
        })
        .filter(Boolean);
    });
  }

  /**
   * J12.4 — ETA heurístico por parada. Desde la posición actual del chofer
   * (último ping) recorre los destinatarios pendientes en `sequence_order`,
   * acumulando distancia / velocidad promedio + minutos por parada. Sin ML.
   *
   * Config opcional en config_finance (category 'otro'):
   *   velocidad_promedio_kmh (default 30) · minutos_por_parada (default 12)
   */
  async etaForShipment(shipmentId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(shipmentId)) throw new BadRequestException('shipmentId inválido');
    return this.tk.run(async (trx) => {
      const shipment = await trx('logistics.shipments').where({ id: shipmentId }).whereNull('deleted_at').first();
      if (!shipment) throw new NotFoundException(`Embarque ${shipmentId} no encontrado`);

      const cfg = await trx('logistics.config_finance')
        .whereIn('key', ['velocidad_promedio_kmh', 'minutos_por_parada'])
        .where({ active: true })
        .select('key', 'value');
      const cfgMap = new Map(cfg.map((c: any) => [c.key, Number(c.value)]));
      const speed = cfgMap.get('velocidad_promedio_kmh') || 30; // km/h
      const serviceMin = cfgMap.get('minutos_por_parada') ?? 12;

      const guideIds = (
        await trx('logistics.delivery_guides').where({ shipment_id: shipmentId }).whereNull('deleted_at').select('id')
      ).map((g: any) => g.id);
      if (!guideIds.length) return { stops: [], total_km: 0, total_minutes: 0 };

      const recipients = await trx('logistics.guide_recipients as r')
        .leftJoin('commercial.customers as c', 'c.id', 'r.customer_id')
        .whereIn('r.guide_id', guideIds)
        .where('r.status', 'pendiente')
        .whereNotNull('r.sequence_order')
        .orderBy('r.sequence_order', 'asc')
        .select('r.id', 'r.customer_name', 'r.sequence_order', 'c.latitude', 'c.longitude');

      const stops = recipients.filter((r: any) => r.latitude != null && r.longitude != null);
      if (!stops.length) return { stops: [], total_km: 0, total_minutes: 0 };

      // Punto de partida: último ping del chofer; si no hay, el primer destino.
      const driver = await trx('logistics.delivery_guides as g')
        .join('logistics.drivers as d', 'd.id', 'g.driver_id')
        .where('g.shipment_id', shipmentId).whereNotNull('d.user_id')
        .select('d.user_id').first();
      let from: { lat: number; lng: number } | null = null;
      if (driver?.user_id) {
        const ping = await trx('public.route_location_pings')
          .whereRaw('tenant_id = public.current_tenant_id()')
          .where({ user_id: driver.user_id })
          .orderBy('captured_at', 'desc').first();
        if (ping) from = { lat: Number(ping.lat), lng: Number(ping.lng) };
      }
      if (!from) from = { lat: Number(stops[0].latitude), lng: Number(stops[0].longitude) };

      const now = Date.now();
      let cumKm = 0;
      let cumMin = 0;
      let prev = from;
      const out = stops.map((r: any) => {
        const pt = { lat: Number(r.latitude), lng: Number(r.longitude) };
        const legKm = haversineKm(prev, pt);
        cumKm += legKm;
        cumMin += (legKm / speed) * 60 + serviceMin;
        prev = pt;
        return {
          recipient_id: r.id,
          customer_name: r.customer_name,
          sequence_order: r.sequence_order,
          leg_km: Math.round(legKm * 100) / 100,
          cumulative_km: Math.round(cumKm * 100) / 100,
          eta: new Date(now + cumMin * 60000).toISOString(),
        };
      });

      return {
        from_source: driver?.user_id ? 'driver_ping' : 'first_stop',
        speed_kmh: speed,
        service_minutes: serviceMin,
        stops: out,
        total_km: Math.round(cumKm * 100) / 100,
        total_minutes: Math.round(cumMin),
      };
    });
  }

  /**
   * J.7.1 — Lista de pedidos `confirmed` que NO tienen shipment activo asociado.
   *
   * Logística usa esto como su "bandeja de entrada": pedidos esperando ser
   * programados. Ordenados por fecha de creación ASC (FIFO).
   *
   * Considera "shipment activo" cualquier shipment del order que NO esté en
   * `cancelado` (cualquier otro estado cuenta como "ya programado").
   */
  async pendingOrders() {
    return this.tk.run(async (trx) => {
      return trx('commercial.orders as o')
        .leftJoin('commercial.customers as c', 'c.id', 'o.customer_id')
        .leftJoin('commercial.warehouses as w', 'w.id', 'o.warehouse_id')
        .where('o.status', 'confirmed')
        .whereNull('o.deleted_at')
        .whereNotExists(function (this: any) {
          this.select(trx.raw('1'))
            .from('logistics.shipments')
            .whereRaw('logistics.shipments.order_id = o.id')
            .whereNull('logistics.shipments.deleted_at')
            .whereNot('logistics.shipments.status', 'cancelado');
        })
        .select(
          'o.id',
          'o.code',
          'o.created_at',
          'o.confirmed_at',
          'o.total',
          'o.delivery_type',
          'o.customer_id',
          'c.name as customer_name',
          'c.code as customer_code',
          'o.warehouse_id',
          'w.name as warehouse_name',
        )
        .orderBy('o.confirmed_at', 'asc');
    });
  }

  // ── Update (solo campos editables, depende del status) ───────────────────

  async update(id: string, dto: UpdateShipmentDto) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');

    return this.tk.run(async (trx) => {
      const existing = await trx('logistics.shipments')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!existing) throw new NotFoundException(`Shipment ${id} no encontrado`);

      if (['cerrado', 'cancelado'].includes(existing.status)) {
        throw new ConflictException(`Shipment ${existing.folio} ya está ${existing.status}, no editable.`);
      }

      // Validar refs nuevas
      if (dto.vehicle_id && dto.vehicle_id !== existing.vehicle_id) {
        await this.assertVehicleAvailable(trx, dto.vehicle_id);
      }
      if (dto.route_id && dto.route_id !== existing.route_id) {
        await this.assertRouteExists(trx, dto.route_id);
      }
      if (dto.order_id && dto.order_id !== existing.order_id) {
        await this.assertOrderExists(trx, dto.order_id);
      }

      const patch: Record<string, any> = { updated_at: trx.fn.now() };
      for (const k of [
        'shipment_date', 'vehicle_id', 'route_id', 'order_id',
        'origin', 'destination', 'type', 'cargo_value', 'boxes_count',
        'total_weight_kg', 'actual_km', 'freight_revenue', 'notes',
      ] as const) {
        if (dto[k] !== undefined) patch[k] = dto[k];
      }

      const [row] = await trx('logistics.shipments')
        .where({ id })
        .update(patch)
        .returning('*');
      return row;
    });
  }

  // ── State machine transitions ────────────────────────────────────────────

  /**
   * J.8.3 — programado → checklist_salida.
   *
   * Marca el inicio del flujo formal: el chofer debe completar el checklist
   * de inspección pre-departure antes de salir. NO marca departure_at (eso
   * sucede en depart()). NO toca el vehicle todavía.
   *
   * Si el operador prefiere el flujo simple, puede llamar directamente
   * depart() y saltarse este estado.
   */
  async startSalidaChecklist(id: string) {
    return this.transition(id, 'checklist_salida', async () => ({}));
  }

  /** programado → en_ruta. Marca vehicle.status = en_ruta y guarda departure_at. */
  async depart(id: string) {
    return this.transition(id, 'en_ruta', async (trx, shipment) => {
      if (shipment.vehicle_id) {
        await trx('logistics.vehicles')
          .where({ id: shipment.vehicle_id })
          .update({ status: 'en_ruta', updated_at: trx.fn.now() });
      }
      return { departure_at: trx.fn.now() };
    });
  }

  /** en_ruta → entregado. Marca arrival_at. NO libera vehicle todavía (puede haber retorno). */
  async deliver(id: string) {
    return this.transition(id, 'entregado', async (trx) => ({
      arrival_at: trx.fn.now(),
    }));
  }

  /**
   * J.8.3 — entregado → checklist_llegada.
   *
   * Marca inicio del flujo formal post-llegada: el chofer/operador debe
   * completar el checklist de inspección post-arrival (estado del vehicle,
   * entrega correcta, devoluciones, etc.) antes de pasar a cálculo de costos.
   */
  async startLlegadaChecklist(id: string) {
    return this.transition(id, 'checklist_llegada', async () => ({}));
  }

  /**
   * J.8.3 — checklist_llegada → costos_pendientes.
   *
   * Marca que el checklist está OK y ahora falta capturar/validar los costos
   * del viaje (combustible, casetas, viáticos, etc.) antes de cerrar.
   * Después de capturar costos en shipment_expenses, se llama close().
   */
  async markCostsPending(id: string) {
    return this.transition(id, 'costos_pendientes', async () => ({}));
  }

  /**
   * (entregado | checklist_llegada | costos_pendientes) → cerrado. Libera vehicle.
   *
   * Hook commercial: si el shipment tiene `order_id` y es la última shipment
   * abierta del order, dispara `OrdersService.fulfillInTransaction(trx, orderId)`
   * dentro del MISMO trx. Esto:
   *   - consume el stock reservado (movements type='sale')
   *   - actualiza orders.status='fulfilled'
   *   - registra en order_status_history
   *   - emite alert WS emitOrderFulfilled
   *
   * Fix J.6.1 — antes hacíamos UPDATE pelado del status que NO consumía stock
   * (inventario quedaba con reservas eternas + history roto + sin alert).
   */
  async close(id: string) {
    return this.transition(id, 'cerrado', async (trx, shipment) => {
      if (shipment.vehicle_id) {
        await trx('logistics.vehicles')
          .where({ id: shipment.vehicle_id })
          .update({ status: 'disponible', updated_at: trx.fn.now() });
      }
      if (shipment.order_id) {
        const open = await trx('logistics.shipments')
          .where({ order_id: shipment.order_id })
          .whereNotIn('status', ['cerrado', 'cancelado'])
          .whereNot({ id: shipment.id })
          .first();
        if (!open) {
          // Idempotente: si el order ya está fulfilled/cancelled,
          // fulfillInTransaction retorna el order sin tocar.
          await this.orderFulfillment.fulfillInTransaction(trx, shipment.order_id);
        }
      }
      return { closed_at: trx.fn.now() };
    });
  }

  /**
   * programado|en_ruta → cancelado. Libera vehicle si estaba reservado.
   *
   * IMPORTANTE (J.10): cancelar una shipment NO revierte el stock reservado
   * del order asociado. La shipment falló logísticamente, pero el compromiso
   * comercial sigue vigente — el operador puede crear una nueva shipment para
   * el mismo `order_id`. Para liberar stock realmente hay que cancelar el
   * order vía `POST /commercial/orders/:id/cancel`.
   */
  async cancel(id: string, reason?: string) {
    return this.transition(id, 'cancelado', async (trx, shipment) => {
      if (shipment.vehicle_id) {
        await trx('logistics.vehicles')
          .where({ id: shipment.vehicle_id })
          .update({ status: 'disponible', updated_at: trx.fn.now() });
      }
      return {
        closed_at: trx.fn.now(),
        notes: reason
          ? `${shipment.notes ? shipment.notes + '\n' : ''}[CANCELADO] ${reason}`
          : shipment.notes,
      };
    });
  }

  // ── Soft delete (solo si está cancelado o cerrado sin guías) ─────────────

  async softDelete(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const s = await trx('logistics.shipments')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!s) throw new NotFoundException(`Shipment ${id} no encontrado`);
      if (!['cancelado', 'cerrado'].includes(s.status)) {
        throw new ConflictException(
          `Solo se pueden borrar shipments cancelados o cerrados (actual: ${s.status})`,
        );
      }
      await trx('logistics.shipments')
        .where({ id })
        .update({ deleted_at: trx.fn.now() });
      return { deleted: true, id };
    });
  }

  // ── Helpers internos ─────────────────────────────────────────────────────

  /**
   * Ejecuta una transición de status validando con VALID_TRANSITIONS.
   * `applyExtras` puede retornar un patch parcial extra a aplicar (timestamps, notes).
   */
  private async transition(
    id: string,
    nextStatus: ShipmentStatus,
    applyExtras: (trx: any, shipment: any) => Promise<Record<string, any>>,
  ) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');

    return this.tk.run(async (trx) => {
      const shipment = await trx('logistics.shipments')
        .where({ id })
        .whereNull('deleted_at')
        .forUpdate()
        .first();
      if (!shipment) throw new NotFoundException(`Shipment ${id} no encontrado`);

      const allowed = VALID_TRANSITIONS[shipment.status as ShipmentStatus] || [];
      if (!allowed.includes(nextStatus)) {
        throw new ConflictException(
          `Transición inválida: ${shipment.status} → ${nextStatus}. Permitidas: [${allowed.join(', ')}] o ninguna.`,
        );
      }

      const extras = await applyExtras(trx, shipment);

      const [updated] = await trx('logistics.shipments')
        .where({ id })
        .update({
          status: nextStatus,
          updated_at: trx.fn.now(),
          ...extras,
        })
        .returning('*');
      return updated;
    });
  }

  private async assertVehicleAvailable(trx: any, vehicleId: string): Promise<void> {
    if (!UUID_REGEX.test(vehicleId)) throw new BadRequestException('vehicle_id inválido');
    const v = await trx('logistics.vehicles')
      .where({ id: vehicleId })
      .whereNull('deleted_at')
      .first();
    if (!v) throw new NotFoundException(`Vehicle ${vehicleId} no encontrado`);
    if (!v.active) throw new ConflictException(`Vehicle ${v.plate} está inactivo`);
    if (v.status === 'baja') throw new ConflictException(`Vehicle ${v.plate} está dado de baja`);
    // Permitimos asignar uno en mantenimiento (operador puede saber lo que hace)
  }

  private async assertRouteExists(trx: any, routeId: string): Promise<void> {
    if (!UUID_REGEX.test(routeId)) throw new BadRequestException('route_id inválido');
    const r = await trx('logistics.routes')
      .where({ id: routeId })
      .whereNull('deleted_at')
      .first();
    if (!r) throw new NotFoundException(`Route ${routeId} no encontrada`);
  }

  private async assertOrderExists(trx: any, orderId: string): Promise<void> {
    if (!UUID_REGEX.test(orderId)) throw new BadRequestException('order_id inválido');
    const o = await trx('commercial.orders')
      .where({ id: orderId })
      .whereNull('deleted_at')
      .first();
    if (!o) throw new NotFoundException(`Order ${orderId} no encontrada`);
    if (['cancelled'].includes(o.status)) {
      throw new ConflictException(`Order ${o.code} está cancelada`);
    }
  }

  /**
   * Genera folio atómico por (tenant, prefix, year) usando UPSERT.
   * Mismo patrón que commercial.order_sequences.
   */
  private async nextFolio(trx: any, prefix: 'EMB' | 'GUIA'): Promise<string> {
    const tenantId = this.tenantCtx.requireTenantId();
    const year = new Date().getFullYear();

    const [{ current_value }] = await trx.raw(
      `
      INSERT INTO logistics.sequences (tenant_id, prefix, year, current_value)
      VALUES (?, ?, ?, 1)
      ON CONFLICT (tenant_id, prefix, year) DO UPDATE
        SET current_value = logistics.sequences.current_value + 1,
            updated_at = now()
      RETURNING current_value
      `,
      [tenantId, prefix, year],
    ).then((r: any) => r.rows);

    const padded = String(current_value).padStart(5, '0');
    return `${prefix}-${year}-${padded}`;
  }

  // Expone nextFolio para que GuidesService genere GUIA-YYYY-NNNNN.
  // Acceso vía LogisticsShipmentsService.
  async generateGuideFolio(trx: any): Promise<string> {
    return this.nextFolio(trx, 'GUIA');
  }

  private validateCreate(dto: CreateShipmentDto): void {
    if (!dto.shipment_date) throw new BadRequestException('shipment_date requerido');
    if (dto.type && !['entrega', 'traspaso', 'recoleccion'].includes(dto.type)) {
      throw new BadRequestException(`type inválido: ${dto.type}`);
    }
    if (dto.vehicle_id !== undefined && dto.vehicle_id && !UUID_REGEX.test(dto.vehicle_id)) {
      throw new BadRequestException('vehicle_id inválido');
    }
    if (dto.route_id !== undefined && dto.route_id && !UUID_REGEX.test(dto.route_id)) {
      throw new BadRequestException('route_id inválido');
    }
    if (dto.order_id !== undefined && dto.order_id && !UUID_REGEX.test(dto.order_id)) {
      throw new BadRequestException('order_id inválido');
    }
  }
}
