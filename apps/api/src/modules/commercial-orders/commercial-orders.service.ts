import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { TenantKnexService } from '../../shared/database/tenant-knex.service';
import { TenantContextService } from '../../shared/tenant/tenant-context.service';
import { CommercialPricingService } from '../commercial-pricing/commercial-pricing.service';
import { CommercialInventoryService } from '../commercial-inventory/commercial-inventory.service';
import { AlertsService } from '../commercial-alerts/alerts.service';

// ─────────── tipos ───────────

export type OrderStatus = 'draft' | 'confirmed' | 'fulfilled' | 'cancelled';

export type DeliveryType = 'route' | 'long_trip';

export interface CreateDraftDto {
  customer_id: string;
  warehouse_id: string;
  notes?: string;
  /**
   * J.6.6: tipo de entrega. `route` (default) = entrega por ruta regular;
   * `long_trip` = viaje largo dedicado. Define cómo logística arma el shipment.
   */
  delivery_type?: DeliveryType;
}

export interface UpdateOrderDraftDto {
  notes?: string;
  delivery_type?: DeliveryType;
}

export interface AddLineDto {
  product_id: string;
  quantity: number;
  /** Override del descuento por línea (0..1). Si no viene, 0. */
  discount_percent?: number;
  notes?: string;
}

export interface UpdateLineDto {
  quantity?: number;
  discount_percent?: number;
  notes?: string;
}

export interface ListOrdersQuery {
  status?: OrderStatus;
  customer_id?: string;
  user_id?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class CommercialOrdersService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly pricing: CommercialPricingService,
    private readonly inventory: CommercialInventoryService,
    private readonly alerts: AlertsService,
  ) {}

  // ─────────────────────────────────────────────────────────────────
  // Crear draft
  // ─────────────────────────────────────────────────────────────────

  async createDraft(dto: CreateDraftDto) {
    if (!UUID_REGEX.test(dto.customer_id))
      throw new BadRequestException('customer_id inválido');
    if (!UUID_REGEX.test(dto.warehouse_id))
      throw new BadRequestException('warehouse_id inválido');

    return this.tk.run(async (trx) => {
      const userId = this.requireUserId();

      // Validar customer + warehouse activos
      const customer = await trx('commercial.customers')
        .where({ id: dto.customer_id })
        .whereNull('deleted_at')
        .first();
      if (!customer)
        throw new NotFoundException(`Customer ${dto.customer_id} no encontrado`);
      if (!customer.active)
        throw new ConflictException('Customer inactivo no puede tener pedidos');

      const warehouse = await trx('commercial.warehouses')
        .where({ id: dto.warehouse_id })
        .whereNull('deleted_at')
        .first();
      if (!warehouse)
        throw new NotFoundException(`Warehouse ${dto.warehouse_id} no encontrado`);
      if (!warehouse.active)
        throw new ConflictException('Warehouse inactivo');

      // Generar code secuencial
      const code = await this.nextCode(trx);

      // Snapshot del price_list que aplica al cliente
      const priceListId = customer.default_price_list_id || (await this.findDefaultPriceListId(trx));

      const deliveryType = dto.delivery_type ?? 'route';
      if (!['route', 'long_trip'].includes(deliveryType)) {
        throw new BadRequestException(
          `delivery_type inválido: ${deliveryType}. Debe ser 'route' o 'long_trip'.`,
        );
      }

      const [order] = await trx('commercial.orders')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          code,
          customer_id: dto.customer_id,
          user_id: userId,
          warehouse_id: dto.warehouse_id,
          price_list_id: priceListId,
          status: 'draft',
          payment_method: 'cash',
          delivery_type: deliveryType,
          subtotal: 0,
          tax_total: 0,
          total: 0,
          paid_amount: 0,
          balance_due: 0,
          currency: 'MXN',
          notes: dto.notes || null,
          created_by: userId,
        })
        .returning('*');

      // Audit trail: creación
      await this.recordHistory(trx, order.id, null, 'draft', null);

      return order;
    });
  }

  /**
   * J.6.6 — Actualiza campos del header del order (solo en draft).
   * Por ahora limitado a `notes` + `delivery_type`. Otros campos requieren
   * lógica adicional (price_list_id cambia totales, etc.).
   */
  async updateDraft(orderId: string, dto: UpdateOrderDraftDto) {
    if (!UUID_REGEX.test(orderId))
      throw new BadRequestException('orderId inválido');

    return this.tk.run(async (trx) => {
      const order = await trx('commercial.orders').where({ id: orderId }).first();
      if (!order) throw new NotFoundException(`Order ${orderId} no encontrada`);
      if (order.status !== 'draft') {
        throw new ConflictException(
          `Solo se pueden editar pedidos en draft. Estado actual: '${order.status}'.`,
        );
      }

      const patch: Record<string, any> = { updated_at: trx.fn.now() };
      if (dto.notes !== undefined) patch.notes = dto.notes || null;
      if (dto.delivery_type !== undefined) {
        if (!['route', 'long_trip'].includes(dto.delivery_type)) {
          throw new BadRequestException(`delivery_type inválido: ${dto.delivery_type}`);
        }
        patch.delivery_type = dto.delivery_type;
      }

      if (Object.keys(patch).length === 1) {
        // Solo updated_at → no-op real, devolver tal cual
        return order;
      }

      const [updated] = await trx('commercial.orders')
        .where({ id: orderId })
        .update(patch)
        .returning('*');
      return updated;
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Líneas (solo en draft)
  // ─────────────────────────────────────────────────────────────────

  async addLine(orderId: string, dto: AddLineDto) {
    if (!UUID_REGEX.test(orderId))
      throw new BadRequestException('orderId inválido');
    if (!UUID_REGEX.test(dto.product_id))
      throw new BadRequestException('product_id inválido');
    if (typeof dto.quantity !== 'number' || dto.quantity <= 0)
      throw new BadRequestException('quantity debe ser > 0');
    if (
      dto.discount_percent !== undefined &&
      (dto.discount_percent < 0 || dto.discount_percent > 1)
    )
      throw new BadRequestException('discount_percent debe estar en [0..1]');

    return this.tk.run(async (trx) => {
      const order = await this.requireDraft(trx, orderId);

      // Resolver precio para este customer
      const priceInfo = await this.pricing.resolvePriceForCustomer(
        dto.product_id,
        order.customer_id,
      );
      if (priceInfo.price === null) {
        throw new ConflictException(
          `Producto ${dto.product_id} sin precio configurado para el cliente`,
        );
      }
      if (dto.quantity < (priceInfo.min_qty || 1)) {
        throw new ConflictException(
          `Cantidad mínima ${priceInfo.min_qty} para este producto`,
        );
      }

      const discount = dto.discount_percent ?? 0;
      const unitPrice = Number(priceInfo.price);
      const taxRate = Number(priceInfo.tax_rate);
      const lineSubtotal = +(dto.quantity * unitPrice * (1 - discount)).toFixed(2);
      const lineTax = +(lineSubtotal * taxRate).toFixed(2);
      const lineTotal = +(lineSubtotal + lineTax).toFixed(2);

      // Determinar line_number consecutivo
      const [{ next_line }] = await trx('commercial.order_lines')
        .where({ order_id: orderId })
        .max({ next_line: 'line_number' });
      const lineNumber = (Number(next_line) || 0) + 1;

      const [line] = await trx('commercial.order_lines')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          order_id: orderId,
          product_id: dto.product_id,
          line_number: lineNumber,
          quantity: dto.quantity,
          unit_price: unitPrice,
          tax_rate: taxRate,
          discount_percent: discount,
          line_subtotal: lineSubtotal,
          line_tax: lineTax,
          line_total: lineTotal,
          notes: dto.notes || null,
        })
        .returning('*');

      await this.recalcOrderTotals(trx, orderId);
      return line;
    });
  }

  async updateLine(orderId: string, lineId: string, dto: UpdateLineDto) {
    if (!UUID_REGEX.test(orderId) || !UUID_REGEX.test(lineId))
      throw new BadRequestException('id inválido');

    return this.tk.run(async (trx) => {
      await this.requireDraft(trx, orderId);

      const line = await trx('commercial.order_lines')
        .where({ id: lineId, order_id: orderId })
        .first();
      if (!line) throw new NotFoundException(`Line ${lineId} no encontrada`);

      const quantity =
        dto.quantity !== undefined ? Number(dto.quantity) : Number(line.quantity);
      const discount =
        dto.discount_percent !== undefined
          ? dto.discount_percent
          : Number(line.discount_percent);

      if (quantity <= 0) throw new BadRequestException('quantity debe ser > 0');
      if (discount < 0 || discount > 1)
        throw new BadRequestException('discount_percent en [0..1]');

      const unitPrice = Number(line.unit_price);
      const taxRate = Number(line.tax_rate);
      const lineSubtotal = +(quantity * unitPrice * (1 - discount)).toFixed(2);
      const lineTax = +(lineSubtotal * taxRate).toFixed(2);
      const lineTotal = +(lineSubtotal + lineTax).toFixed(2);

      const [updated] = await trx('commercial.order_lines')
        .where({ id: lineId })
        .update({
          quantity,
          discount_percent: discount,
          line_subtotal: lineSubtotal,
          line_tax: lineTax,
          line_total: lineTotal,
          notes: dto.notes !== undefined ? dto.notes : line.notes,
        })
        .returning('*');

      await this.recalcOrderTotals(trx, orderId);
      return updated;
    });
  }

  async removeLine(orderId: string, lineId: string) {
    if (!UUID_REGEX.test(orderId) || !UUID_REGEX.test(lineId))
      throw new BadRequestException('id inválido');

    return this.tk.run(async (trx) => {
      await this.requireDraft(trx, orderId);
      const [deleted] = await trx('commercial.order_lines')
        .where({ id: lineId, order_id: orderId })
        .delete()
        .returning('id');
      if (!deleted) throw new NotFoundException(`Line ${lineId} no encontrada`);

      await this.recalcOrderTotals(trx, orderId);
      return { deleted: true, id: lineId };
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // State machine
  // ─────────────────────────────────────────────────────────────────

  /**
   * draft → confirmed
   * Valida líneas, reserva stock, lockea líneas.
   */
  async confirm(orderId: string) {
    if (!UUID_REGEX.test(orderId))
      throw new BadRequestException('orderId inválido');

    return this.tk.run(async (trx) => {
      const order = await this.requireDraft(trx, orderId);

      const lines = await trx('commercial.order_lines')
        .where({ order_id: orderId })
        .orderBy('line_number');
      if (lines.length === 0)
        throw new ConflictException('Pedido sin líneas no puede confirmarse');

      // Reservar stock por línea. CommercialInventoryService corre dentro de SU
      // PROPIA transaction (tk.run abre una nueva). Para mantener atomicidad
      // del confirm completo, hacemos las reservas inline con la misma trx.
      for (const line of lines) {
        await this.reserveStockInline(trx, order.warehouse_id, line.product_id, Number(line.quantity), orderId);
      }

      const [updated] = await trx('commercial.orders')
        .where({ id: orderId })
        .update({
          status: 'confirmed',
          confirmed_at: trx.fn.now(),
          updated_at: trx.fn.now(),
          updated_by: this.tenantCtx.get()?.userId || null,
        })
        .returning('*');

      // Audit trail
      await this.recordHistory(trx, orderId, 'draft', 'confirmed', null);

      // Emitir alerts post-commit (los Knex transactions hacen commit cuando el
      // callback resuelve sin throw. Acá aún estamos dentro pero ya tenemos los
      // datos finales. Si el commit falla después, el cliente recibirá una alert
      // de un pedido que no se persistió — trade-off aceptable para beta).
      const tenantId = this.tenantCtx.requireTenantId();
      const customer = await trx('commercial.customers')
        .where({ id: order.customer_id })
        .select('name')
        .first();
      const customerName = customer?.name || order.customer_id;
      const total = Number(updated.total);

      this.alerts.emitOrderConfirmed(tenantId, {
        order_id: orderId,
        code: updated.code,
        customer_name: customerName,
        total,
      });
      this.alerts.emitLargeOrder(tenantId, {
        order_id: orderId,
        code: updated.code,
        customer_id: order.customer_id,
        customer_name: customerName,
        total,
      });

      return updated;
    });
  }

  /**
   * confirmed → fulfilled
   * Consume reservas como `sale`. Wrapper que abre su propio trx.
   *
   * A diferencia de `fulfillInTransaction()` (idempotente para hooks), este
   * endpoint REST valida estrictamente que el order esté en `confirmed` y
   * lanza 409 si no — para no enmascarar bugs de UI/cliente que disparen
   * fulfill en estados ilegales.
   */
  async fulfill(orderId: string) {
    if (!UUID_REGEX.test(orderId))
      throw new BadRequestException('orderId inválido');
    return this.tk.run(async (trx) => {
      const o = await trx('commercial.orders').where({ id: orderId }).first();
      if (!o) throw new NotFoundException(`Order ${orderId} no encontrada`);
      if (o.status !== 'confirmed') {
        throw new ConflictException(
          `Solo se puede fulfillar desde 'confirmed'. Estado actual: '${o.status}'`,
        );
      }
      return this.fulfillInTransaction(trx, orderId);
    });
  }

  /**
   * Fulfill ejecutado dentro de un trx EXISTENTE. Mismo efecto que `fulfill()`
   * pero reusa el trx del caller. Único uso conocido: hook
   * `LogisticsShipmentsService.close()` que dispara fulfill cuando se cierra
   * la última shipment del order (fix J.6.1 — antes hacía UPDATE pelado que
   * NO consumía stock ni registraba history ni emitía alerts).
   *
   * Validaciones: idempotente — si el order NO está `confirmed` (ej: ya estaba
   * fulfilled por otra shipment, o fue cancelado), retorna el order sin tocar.
   * Esto permite que el hook se ejecute sin romper transacciones por carrera.
   */
  async fulfillInTransaction(trx: any, orderId: string) {
    if (!UUID_REGEX.test(orderId))
      throw new BadRequestException('orderId inválido');

    const order = await trx('commercial.orders').where({ id: orderId }).first();
    if (!order) throw new NotFoundException(`Order ${orderId} no encontrada`);

    // Idempotencia para uso desde hooks: si no está confirmed, no-op.
    // (Llamadas directas via REST `POST /:id/fulfill` ya validaron status.)
    if (order.status !== 'confirmed') return order;

    const lines = await trx('commercial.order_lines').where({ order_id: orderId });

    for (const line of lines) {
      await this.consumeStockInline(
        trx,
        order.warehouse_id,
        line.product_id,
        Number(line.quantity),
        orderId,
      );
    }

    const [updated] = await trx('commercial.orders')
      .where({ id: orderId })
      .update({
        status: 'fulfilled',
        fulfilled_at: trx.fn.now(),
        updated_at: trx.fn.now(),
        updated_by: this.tenantCtx.get()?.userId || null,
      })
      .returning('*');

    await this.recordHistory(trx, orderId, 'confirmed', 'fulfilled', null);

    const tenantId = this.tenantCtx.requireTenantId();
    const customer = await trx('commercial.customers')
      .where({ id: order.customer_id })
      .select('name')
      .first();
    this.alerts.emitOrderFulfilled(tenantId, {
      order_id: orderId,
      code: updated.code,
      customer_name: customer?.name || order.customer_id,
      total: Number(updated.total),
    });

    return updated;
  }

  /**
   * draft/confirmed → cancelled
   * Si está confirmed, libera reservas.
   */
  async cancel(orderId: string, reason?: string) {
    if (!UUID_REGEX.test(orderId))
      throw new BadRequestException('orderId inválido');

    return this.tk.run(async (trx) => {
      const order = await trx('commercial.orders').where({ id: orderId }).first();
      if (!order) throw new NotFoundException(`Order ${orderId} no encontrada`);
      if (order.status === 'cancelled')
        throw new ConflictException('Pedido ya estaba cancelado');
      if (order.status === 'fulfilled')
        throw new ConflictException(
          'No se puede cancelar un pedido ya entregado. Generar devolución.',
        );

      if (order.status === 'confirmed') {
        const lines = await trx('commercial.order_lines')
          .where({ order_id: orderId });
        for (const line of lines) {
          await this.releaseStockInline(
            trx,
            order.warehouse_id,
            line.product_id,
            Number(line.quantity),
            orderId,
          );
        }
      }

      const [updated] = await trx('commercial.orders')
        .where({ id: orderId })
        .update({
          status: 'cancelled',
          cancelled_at: trx.fn.now(),
          cancellation_reason: reason || null,
          updated_at: trx.fn.now(),
          updated_by: this.tenantCtx.get()?.userId || null,
        })
        .returning('*');

      await this.recordHistory(trx, orderId, order.status, 'cancelled', reason || null);

      return updated;
    });
  }

  /** Devuelve historial de cambios de status para un pedido. */
  async getHistory(orderId: string) {
    if (!UUID_REGEX.test(orderId))
      throw new BadRequestException('orderId inválido');

    return this.tk.run(async (trx) => {
      const order = await trx('commercial.orders').where({ id: orderId }).first();
      if (!order) throw new NotFoundException(`Order ${orderId} no encontrada`);

      return trx('commercial.order_status_history')
        .where({ order_id: orderId })
        .orderBy('changed_at', 'asc')
        .select(
          'id',
          'from_status',
          'to_status',
          'changed_by',
          'changed_by_username',
          'reason',
          'snapshot',
          'changed_at',
        );
    });
  }

  /** Lista pedidos del customer del JWT actual (Portal B2B). */
  async listMyOrders(query: ListOrdersQuery & { customer_id?: string }) {
    const customerId = await this.resolveCustomerIdFromCtx();
    if (!customerId) {
      throw new BadRequestException(
        'Usuario sin customer_id linkeado — no es customer_b2b o está mal configurado',
      );
    }
    return this.list({ ...query, customer_id: customerId });
  }

  private async resolveCustomerIdFromCtx(): Promise<string | null> {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) return null;
    return this.tk.run(async (trx) => {
      const row = await trx('public.users')
        .where({ id: userId })
        .select('customer_id')
        .first();
      return row?.customer_id || null;
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Reads
  // ─────────────────────────────────────────────────────────────────

  async findById(orderId: string) {
    if (!UUID_REGEX.test(orderId))
      throw new BadRequestException('orderId inválido');

    return this.tk.run(async (trx) => {
      const order = await trx('commercial.orders').where({ id: orderId }).first();
      if (!order) throw new NotFoundException(`Order ${orderId} no encontrada`);
      const lines = await trx('commercial.order_lines')
        .where({ order_id: orderId })
        .orderBy('line_number');
      return { ...order, lines };
    });
  }

  async list(query: ListOrdersQuery) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 50));
    const offset = (page - 1) * pageSize;

    return this.tk.run(async (trx) => {
      let q = trx('commercial.orders as o')
        .leftJoin('commercial.customers as c', 'c.id', 'o.customer_id')
        .leftJoin('commercial.warehouses as w', 'w.id', 'o.warehouse_id')
        .whereNull('o.deleted_at');

      if (query.status) q = q.where('o.status', query.status);
      if (query.customer_id) q = q.where('o.customer_id', query.customer_id);
      if (query.user_id) q = q.where('o.user_id', query.user_id);
      if (query.from) q = q.where('o.created_at', '>=', query.from);
      if (query.to) q = q.where('o.created_at', '<=', query.to);

      const [{ count }] = await q.clone().count<{ count: string }[]>('* as count');

      const data = await q
        .select(
          'o.id',
          'o.code',
          'o.status',
          'o.customer_id',
          'c.name as customer_name',
          'o.warehouse_id',
          'w.code as warehouse_code',
          'o.subtotal',
          'o.tax_total',
          'o.total',
          'o.balance_due',
          'o.created_at',
          'o.confirmed_at',
          'o.fulfilled_at',
          'o.cancelled_at',
        )
        .orderBy('o.created_at', 'desc')
        .limit(pageSize)
        .offset(offset);

      return { data, page, pageSize, total: Number(count) };
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Helpers privados
  // ─────────────────────────────────────────────────────────────────

  private async requireDraft(trx: any, orderId: string) {
    const order = await trx('commercial.orders').where({ id: orderId }).first();
    if (!order) throw new NotFoundException(`Order ${orderId} no encontrada`);
    if (order.status !== 'draft')
      throw new ConflictException(
        `Pedido en estado '${order.status}' no admite modificación de líneas`,
      );
    return order;
  }

  /**
   * Inserta una fila en commercial.order_status_history. Llamado en cada
   * transición (incluyendo creación, donde from_status es null).
   */
  private async recordHistory(
    trx: any,
    orderId: string,
    fromStatus: string | null,
    toStatus: string,
    reason: string | null,
  ): Promise<void> {
    const ctx = this.tenantCtx.get();
    // Snapshot ligero de totals para debugging futuro
    const order = await trx('commercial.orders')
      .where({ id: orderId })
      .select('subtotal', 'tax_total', 'total', 'balance_due')
      .first();

    await trx('commercial.order_status_history').insert({
      tenant_id: trx.raw('public.current_tenant_id()'),
      order_id: orderId,
      from_status: fromStatus,
      to_status: toStatus,
      changed_by: ctx?.userId || null,
      changed_by_username: ctx?.username || null,
      reason,
      snapshot: order ? JSON.stringify(order) : null,
    });
  }

  private async recalcOrderTotals(trx: any, orderId: string): Promise<void> {
    const sums = await trx('commercial.order_lines')
      .where({ order_id: orderId })
      .sum({
        subtotal: 'line_subtotal',
        tax: 'line_tax',
        total: 'line_total',
      });
    const { subtotal, tax, total } = sums[0] as {
      subtotal: string | null;
      tax: string | null;
      total: string | null;
    };

    await trx('commercial.orders')
      .where({ id: orderId })
      .update({
        subtotal: Number(subtotal) || 0,
        tax_total: Number(tax) || 0,
        total: Number(total) || 0,
        balance_due: Number(total) || 0, // sin payments todavía
        updated_at: trx.fn.now(),
      });
  }

  private async nextCode(trx: any): Promise<string> {
    const tenantId = this.tenantCtx.requireTenantId();
    const year = new Date().getFullYear();

    // Atomic upsert + increment
    const [{ current_value }] = await trx.raw(
      `
      INSERT INTO commercial.order_sequences (tenant_id, year, current_value)
      VALUES (?, ?, 1)
      ON CONFLICT (tenant_id, year) DO UPDATE
        SET current_value = commercial.order_sequences.current_value + 1,
            updated_at = now()
      RETURNING current_value
      `,
      [tenantId, year],
    ).then((r: any) => r.rows);

    const padded = String(current_value).padStart(5, '0');
    return `PD-${year}-${padded}`;
  }

  private async findDefaultPriceListId(trx: any): Promise<string | null> {
    const pl = await trx('commercial.price_lists')
      .where({ is_default: true, active: true })
      .whereNull('deleted_at')
      .first();
    return pl?.id || null;
  }

  private requireUserId(): string {
    const ctx = this.tenantCtx.get();
    if (!ctx?.userId) {
      throw new BadRequestException(
        'Usuario no identificado — orders requiere request autenticado',
      );
    }
    return ctx.userId;
  }

  // ─── Stock helpers inline (operan en la trx del orders flow) ───

  private async reserveStockInline(
    trx: any,
    warehouseId: string,
    productId: string,
    quantity: number,
    orderId: string,
  ): Promise<void> {
    const stockRow = await trx('commercial.stock')
      .where({ warehouse_id: warehouseId, product_id: productId })
      .forUpdate()
      .first();

    const qBefore = stockRow ? Number(stockRow.quantity) : 0;
    const rBefore = stockRow ? Number(stockRow.reserved_quantity) : 0;

    if (qBefore - rBefore < quantity) {
      throw new ConflictException(
        `Stock disponible insuficiente para producto ${productId}: ${qBefore - rBefore} < ${quantity}`,
      );
    }

    if (stockRow) {
      await trx('commercial.stock')
        .where({ id: stockRow.id })
        .update({
          reserved_quantity: rBefore + quantity,
          updated_at: trx.fn.now(),
          updated_by: this.tenantCtx.get()?.userId || null,
        });
    } else {
      // No row → no stock → ya rechazó arriba. Defensa por si llegamos acá.
      throw new ConflictException(
        `No existe registro de stock para producto ${productId} en almacén`,
      );
    }

    await trx('commercial.stock_movements').insert({
      tenant_id: trx.raw('public.current_tenant_id()'),
      warehouse_id: warehouseId,
      product_id: productId,
      movement_type: 'reserve',
      quantity,
      quantity_before: qBefore,
      quantity_after: qBefore,
      reference_type: 'order',
      reference_id: orderId,
      created_by: this.tenantCtx.get()?.userId || null,
    });
  }

  private async consumeStockInline(
    trx: any,
    warehouseId: string,
    productId: string,
    quantity: number,
    orderId: string,
  ): Promise<void> {
    const stockRow = await trx('commercial.stock')
      .where({ warehouse_id: warehouseId, product_id: productId })
      .forUpdate()
      .first();
    if (!stockRow) {
      throw new ConflictException(`Sin stock para producto ${productId}`);
    }
    const qBefore = Number(stockRow.quantity);
    const rBefore = Number(stockRow.reserved_quantity);
    if (rBefore < quantity) {
      throw new ConflictException(
        `Sale > reserved para producto ${productId}: ${rBefore} < ${quantity}`,
      );
    }

    await trx('commercial.stock')
      .where({ id: stockRow.id })
      .update({
        quantity: qBefore - quantity,
        reserved_quantity: rBefore - quantity,
        updated_at: trx.fn.now(),
        updated_by: this.tenantCtx.get()?.userId || null,
      });

    await trx('commercial.stock_movements').insert({
      tenant_id: trx.raw('public.current_tenant_id()'),
      warehouse_id: warehouseId,
      product_id: productId,
      movement_type: 'sale',
      quantity,
      quantity_before: qBefore,
      quantity_after: qBefore - quantity,
      reference_type: 'order',
      reference_id: orderId,
      created_by: this.tenantCtx.get()?.userId || null,
    });
  }

  private async releaseStockInline(
    trx: any,
    warehouseId: string,
    productId: string,
    quantity: number,
    orderId: string,
  ): Promise<void> {
    const stockRow = await trx('commercial.stock')
      .where({ warehouse_id: warehouseId, product_id: productId })
      .forUpdate()
      .first();
    if (!stockRow) return; // nada que liberar (defensivo)
    const rBefore = Number(stockRow.reserved_quantity);
    const releaseQty = Math.min(rBefore, quantity);

    await trx('commercial.stock')
      .where({ id: stockRow.id })
      .update({
        reserved_quantity: rBefore - releaseQty,
        updated_at: trx.fn.now(),
        updated_by: this.tenantCtx.get()?.userId || null,
      });

    await trx('commercial.stock_movements').insert({
      tenant_id: trx.raw('public.current_tenant_id()'),
      warehouse_id: warehouseId,
      product_id: productId,
      movement_type: 'release',
      quantity: releaseQty,
      quantity_before: Number(stockRow.quantity),
      quantity_after: Number(stockRow.quantity),
      reference_type: 'order',
      reference_id: orderId,
      created_by: this.tenantCtx.get()?.userId || null,
    });
  }
}
