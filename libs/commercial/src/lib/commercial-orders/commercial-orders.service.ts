import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';
import { vendorTodayRouteExistsSql } from '../shared/vendor-cartera.sql';
import { CommercialPricingService } from '../commercial-pricing/commercial-pricing.service';
import { CommercialInventoryService } from '../commercial-inventory/commercial-inventory.service';
import { AlertsService } from '../commercial-alerts/alerts.service';
import { CommercialPushService } from '../commercial-push/commercial-push.service';
import { OrderStockService } from './order-stock.service';

// ─────────── tipos ───────────

export type OrderStatus = 'draft' | 'pending_approval' | 'confirmed' | 'fulfilled' | 'cancelled';

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
  /** V.5: fecha de entrega agendada (YYYY-MM-DD) para "pedido futuro". NULL = inmediato. */
  requested_delivery_date?: string;
}

export interface UpdateOrderDraftDto {
  notes?: string;
  delivery_type?: DeliveryType;
  requested_delivery_date?: string | null;
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

export interface ReplaceLinesDto {
  lines: AddLineDto[];
}

export interface FrequentProductRow {
  product_id: string;
  product_name: string | null;
  sku: string | null;
  brand_name: string | null;
  order_count: number;
  total_qty: number;
  avg_qty: number;
  last_ordered_at: string;
}

export interface ListOrdersQuery {
  status?: OrderStatus;
  /** Multi-status CSV, ej "pending_approval,confirmed". Se suma a `status`. */
  statuses?: string;
  customer_id?: string;
  user_id?: string;
  /** Restringe a pedidos de clientes en la cartera del vendedor del JWT (vendor_sales_routes). */
  mine?: boolean;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class CommercialOrdersService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly pricing: CommercialPricingService,
    private readonly inventory: CommercialInventoryService,
    private readonly alerts: AlertsService,
    private readonly push: CommercialPushService,
    private readonly stock: OrderStockService,
  ) {}

  /**
   * Push fire-and-forget al cliente del pedido (Fase 3). Nunca lanza ni bloquea
   * la operación de la orden — la notificación es best-effort.
   */
  private notifyCustomer(customerId: string, orderId: string, title: string, body: string): void {
    void this.push
      .sendToCustomer(customerId, { title, body, url: `/portal/orders/${orderId}`, tag: `order-${orderId}` })
      .catch(() => void 0);
  }

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

      const requestedDeliveryDate = dto.requested_delivery_date || null;
      if (requestedDeliveryDate && !DATE_REGEX.test(requestedDeliveryDate)) {
        throw new BadRequestException('requested_delivery_date debe ser YYYY-MM-DD');
      }

      const [order] = await trx('commercial.orders')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          code,
          customer_id: dto.customer_id,
          user_id: userId,
          warehouse_id: dto.warehouse_id,
          price_list_id: priceListId,
          // Snapshot de la ruta del cliente al draft. Si el cliente luego cambia
          // de ruta, esta orden mantiene la asignada al momento del pedido.
          route_id: customer.route_id || null,
          status: 'draft',
          payment_method: 'cash',
          delivery_type: deliveryType,
          requested_delivery_date: requestedDeliveryDate,
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
      await this.enforceOrderOwnership(trx, order);
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
      if (dto.requested_delivery_date !== undefined) {
        const d = dto.requested_delivery_date || null;
        if (d && !DATE_REGEX.test(d)) {
          throw new BadRequestException('requested_delivery_date debe ser YYYY-MM-DD');
        }
        patch.requested_delivery_date = d;
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
      // Lock pesimista sobre la row del order. Serializa addLine concurrentes
      // sobre el mismo order y evita race en el MAX(line_number)+1 que
      // explotaba el UNIQUE (tenant_id, order_id, line_number). El lock dura
      // hasta el commit de esta trx.
      await trx.raw('SELECT id FROM commercial.orders WHERE id = ? FOR UPDATE', [orderId]);

      const order = await this.requireDraft(trx, orderId);
      await this.enforceOrderOwnership(trx, order);

      // Merge por producto: si el SKU ya tiene línea en el carrito, se INCREMENTA
      // (igual que updateLine: conserva el snapshot de precio y recalcula) en vez
      // de crear una línea duplicada. Antes addLine SIEMPRE insertaba → el mismo
      // producto aparecía como líneas separadas al re-agregarlo desde rails/sheet.
      const existing = await trx('commercial.order_lines')
        .where({ order_id: orderId, product_id: dto.product_id })
        .first();
      if (existing) {
        const newQty = Number(existing.quantity) + dto.quantity;
        const exUnit = Number(existing.unit_price);
        const exTax = Number(existing.tax_rate);
        const exDiscount = Number(existing.discount_percent) || 0;
        const exSubtotal = +(newQty * exUnit * (1 - exDiscount)).toFixed(2);
        const exLineTax = +(exSubtotal * exTax).toFixed(2);
        const exTotal = +(exSubtotal + exLineTax).toFixed(2);
        const [merged] = await trx('commercial.order_lines')
          .where({ id: existing.id })
          .update({
            quantity: newQty,
            // draft-only (requireDraft arriba): la cantidad pedida sigue al carrito.
            requested_quantity: newQty,
            line_subtotal: exSubtotal,
            line_tax: exLineTax,
            line_total: exTotal,
          })
          .returning('*');
        await this.recalcOrderTotals(trx, orderId);
        return merged;
      }

      // Línea nueva: resolver precio del customer + validar MOQ + insertar.
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

      // line_number consecutivo (safe ahora gracias al FOR UPDATE arriba).
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
          requested_quantity: dto.quantity,
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

  /**
   * VQ: reemplaza TODAS las líneas del draft con el set provisto, en una sola
   * transacción (un solo lock). Pensado para el "order pad" del vendedor: la UI
   * mantiene el estado completo del pedido (producto→cantidad) y al confirmar
   * manda el set entero. Dedupe por product_id (suma cantidades), clampea a
   * min_qty, y omite (sin abortar) los productos sin precio para el cliente.
   */
  async replaceLines(orderId: string, dto: ReplaceLinesDto) {
    if (!UUID_REGEX.test(orderId))
      throw new BadRequestException('orderId inválido');

    const merged = new Map<string, { quantity: number; discount_percent?: number; notes?: string }>();
    for (const l of dto?.lines || []) {
      if (!l || !UUID_REGEX.test(l.product_id)) continue;
      const qty = Number(l.quantity);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const prev = merged.get(l.product_id);
      if (prev) prev.quantity += qty;
      else merged.set(l.product_id, { quantity: qty, discount_percent: l.discount_percent, notes: l.notes });
    }

    return this.tk.run(async (trx) => {
      await trx.raw('SELECT id FROM commercial.orders WHERE id = ? FOR UPDATE', [orderId]);
      const order = await this.requireDraft(trx, orderId);
      await this.enforceOrderOwnership(trx, order);

      await trx('commercial.order_lines').where({ order_id: orderId }).del();

      const skipped: { product_id: string; reason: string }[] = [];
      let lineNumber = 0;
      for (const [productId, info] of merged) {
        const priceInfo = await this.pricing.resolvePriceForCustomer(productId, order.customer_id);
        if (priceInfo.price === null) {
          skipped.push({ product_id: productId, reason: 'sin precio' });
          continue;
        }
        const discount = info.discount_percent ?? 0;
        if (discount < 0 || discount > 1) {
          skipped.push({ product_id: productId, reason: 'descuento inválido' });
          continue;
        }
        const minQty = priceInfo.min_qty || 1;
        const qty = info.quantity < minQty ? minQty : info.quantity;
        const unitPrice = Number(priceInfo.price);
        const taxRate = Number(priceInfo.tax_rate);
        const lineSubtotal = +(qty * unitPrice * (1 - discount)).toFixed(2);
        const lineTax = +(lineSubtotal * taxRate).toFixed(2);
        const lineTotal = +(lineSubtotal + lineTax).toFixed(2);
        lineNumber += 1;
        await trx('commercial.order_lines').insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          order_id: orderId,
          product_id: productId,
          line_number: lineNumber,
          quantity: qty,
          requested_quantity: qty,
          unit_price: unitPrice,
          tax_rate: taxRate,
          discount_percent: discount,
          line_subtotal: lineSubtotal,
          line_tax: lineTax,
          line_total: lineTotal,
          notes: info.notes || null,
        });
      }

      await this.recalcOrderTotals(trx, orderId);
      return { order_id: orderId, added: lineNumber, skipped };
    });
  }

  /**
   * VQ: productos que el cliente compra habitualmente (agregado de order_lines
   * de pedidos confirmed/fulfilled en la ventana). Alimenta el order pad —
   * sección "Habituales" con cantidad sugerida = promedio histórico.
   */
  async frequentProducts(
    customerId: string,
    opts: { days?: number; limit?: number } = {},
  ): Promise<FrequentProductRow[]> {
    if (!UUID_REGEX.test(customerId))
      throw new BadRequestException('customer_id inválido');
    const days = Math.min(Math.max(opts.days ?? 120, 1), 365);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

    return this.tk.run(async (trx) => {
      return trx('commercial.order_lines as ol')
        .join('commercial.orders as o', 'o.id', 'ol.order_id')
        .leftJoin('public.products as p', 'p.id', 'ol.product_id')
        .leftJoin('public.brands as b', 'b.id', 'p.brand_id')
        .where('o.customer_id', customerId)
        .whereIn('o.status', ['confirmed', 'fulfilled'])
        .whereRaw(`o.created_at >= now() - (? || ' days')::interval`, [days])
        .groupBy('ol.product_id', 'p.nombre', 'p.sku', 'b.nombre')
        .select(
          'ol.product_id',
          trx.raw('p.nombre as product_name'),
          trx.raw('p.sku as sku'),
          trx.raw('b.nombre as brand_name'),
          trx.raw('count(distinct o.id)::int as order_count'),
          trx.raw('sum(ol.quantity)::numeric as total_qty'),
          trx.raw('greatest(round(avg(ol.quantity)), 1)::int as avg_qty'),
          trx.raw('max(o.created_at) as last_ordered_at'),
        )
        .orderByRaw('count(distinct o.id) desc, sum(ol.quantity) desc')
        .limit(limit) as unknown as FrequentProductRow[];
    });
  }

  async updateLine(orderId: string, lineId: string, dto: UpdateLineDto) {
    if (!UUID_REGEX.test(orderId) || !UUID_REGEX.test(lineId))
      throw new BadRequestException('id inválido');

    return this.tk.run(async (trx) => {
      const order = await this.requireEditableForLines(trx, orderId);
      await this.enforceOrderOwnership(trx, order);

      const line = await trx('commercial.order_lines')
        .where({ id: lineId, order_id: orderId })
        .first();
      if (!line) throw new NotFoundException(`Line ${lineId} no encontrada`);

      const prevQty = Number(line.quantity);
      const requested = Number(line.requested_quantity ?? line.quantity);
      const quantity =
        dto.quantity !== undefined ? Number(dto.quantity) : prevQty;
      const discount =
        dto.discount_percent !== undefined
          ? dto.discount_percent
          : Number(line.discount_percent);

      if (quantity <= 0) throw new BadRequestException('quantity debe ser > 0');
      if (discount < 0 || discount > 1)
        throw new BadRequestException('discount_percent en [0..1]');

      // En pending_approval el vendedor solo puede RECORTAR la cantidad: nunca
      // entregar más de lo que el cliente pidió. La cantidad pedida queda
      // congelada en `requested_quantity` al entrar a pending_approval.
      if (order.status === 'pending_approval' && quantity > requested) {
        throw new BadRequestException(
          `La cantidad aprobada (${quantity}) no puede superar la pedida por el cliente (${requested}).`,
        );
      }

      // Si el pedido ya está pending_approval, el stock está reservado.
      // Ajustar la reserva por delta: liberar exceso o reservar lo nuevo.
      if (order.status === 'pending_approval' && quantity !== prevQty) {
        const delta = quantity - prevQty;
        if (delta > 0) {
          await this.stock.reserve(trx, order.warehouse_id, line.product_id, delta, orderId);
        } else {
          await this.stock.release(trx, order.warehouse_id, line.product_id, -delta, orderId);
        }
      }

      const unitPrice = Number(line.unit_price);
      const taxRate = Number(line.tax_rate);
      const lineSubtotal = +(quantity * unitPrice * (1 - discount)).toFixed(2);
      const lineTax = +(lineSubtotal * taxRate).toFixed(2);
      const lineTotal = +(lineSubtotal + lineTax).toFixed(2);

      // En draft el cliente sigue armando — `requested_quantity` se sincroniza
      // con `quantity` porque NO existe todavía una "cantidad pedida congelada".
      // En pending_approval queda intocable.
      const updatePatch: Record<string, any> = {
        quantity,
        discount_percent: discount,
        line_subtotal: lineSubtotal,
        line_tax: lineTax,
        line_total: lineTotal,
        notes: dto.notes !== undefined ? dto.notes : line.notes,
      };
      if (order.status === 'draft') {
        updatePatch.requested_quantity = quantity;
      }

      const [updated] = await trx('commercial.order_lines')
        .where({ id: lineId })
        .update(updatePatch)
        .returning('*');

      await this.recalcOrderTotals(trx, orderId);
      return updated;
    });
  }

  async removeLine(orderId: string, lineId: string) {
    if (!UUID_REGEX.test(orderId) || !UUID_REGEX.test(lineId))
      throw new BadRequestException('id inválido');

    return this.tk.run(async (trx) => {
      const order = await this.requireEditableForLines(trx, orderId);
      await this.enforceOrderOwnership(trx, order);

      const line = await trx('commercial.order_lines')
        .where({ id: lineId, order_id: orderId })
        .first();
      if (!line) throw new NotFoundException(`Line ${lineId} no encontrada`);

      // Si el pedido está pending_approval, liberar la reserva antes de borrar.
      if (order.status === 'pending_approval') {
        await this.stock.release(
          trx,
          order.warehouse_id,
          line.product_id,
          Number(line.quantity),
          orderId,
        );
      }

      await trx('commercial.order_lines').where({ id: lineId }).delete();
      await this.recalcOrderTotals(trx, orderId);
      return { deleted: true, id: lineId };
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // State machine
  // ─────────────────────────────────────────────────────────────────

  /**
   * draft → pending_approval
   * El CLIENTE confirma su pedido. Stock se reserva inmediatamente para
   * proteger inventario; el vendedor luego revisa y llama a `approve()`
   * para mover a `confirmed`.
   */
  async confirm(orderId: string) {
    if (!UUID_REGEX.test(orderId))
      throw new BadRequestException('orderId inválido');

    return this.tk.run(async (trx) => {
      const order = await this.requireDraft(trx, orderId);
      await this.enforceOrderOwnership(trx, order);

      const lines = await trx('commercial.order_lines')
        .where({ order_id: orderId })
        .orderBy('line_number');
      if (lines.length === 0)
        throw new ConflictException('Pedido sin líneas no puede confirmarse');

      // Preventa (pedido con fecha de entrega agendada): NO reservar stock — se
      // entrega después y el inventario se consume en el reparto (fulfill). Un
      // pedido sin fecha (portal/inmediato) sí reserva al confirmar.
      const isPreventa = !!order.requested_delivery_date;
      if (!isPreventa) {
        for (const line of lines) {
          await this.stock.reserve(trx, order.warehouse_id, line.product_id, Number(line.quantity), orderId);
        }
      }

      // Congelar la cantidad pedida por el cliente. A partir de acá el vendedor
      // solo puede recortar (quantity <= requested_quantity).
      await trx('commercial.order_lines')
        .where({ order_id: orderId })
        .whereNull('requested_quantity')
        .update({ requested_quantity: trx.raw('quantity') });

      const [updated] = await trx('commercial.orders')
        .where({ id: orderId })
        .update({
          status: 'pending_approval',
          pending_approval_at: trx.fn.now(),
          updated_at: trx.fn.now(),
          updated_by: this.tenantCtx.get()?.userId || null,
        })
        .returning('*');

      await this.recordHistory(trx, orderId, 'draft', 'pending_approval', null);

      // La alert "order_confirmed" la disparamos cuando el vendedor apruebe.
      // Aquí solo emitimos large_order (señal interna de monitoreo de tamaños).
      const tenantId = this.tenantCtx.requireTenantId();
      const customer = await trx('commercial.customers')
        .where({ id: order.customer_id })
        .select('name')
        .first();
      const customerName = customer?.name || order.customer_id;
      const total = Number(updated.total);

      this.alerts.emitLargeOrder(tenantId, {
        order_id: orderId,
        code: updated.code,
        customer_id: order.customer_id,
        customer_name: customerName,
        total,
      });

      this.notifyCustomer(
        order.customer_id,
        orderId,
        'Pedido recibido',
        `Recibimos tu pedido ${updated.code}. Te avisamos cuando se confirme.`,
      );

      return updated;
    });
  }

  /**
   * pending_approval → confirmed
   * El VENDEDOR aprueba el pedido del cliente. Sin cambio de inventario
   * (stock ya estaba reservado desde el confirm del cliente).
   */
  async approve(orderId: string) {
    if (!UUID_REGEX.test(orderId))
      throw new BadRequestException('orderId inválido');

    return this.tk.run(async (trx) => {
      const order = await trx('commercial.orders').where({ id: orderId }).first();
      if (!order) throw new NotFoundException(`Order ${orderId} no encontrada`);
      if (order.status !== 'pending_approval') {
        throw new ConflictException(
          `Solo se puede aprobar desde 'pending_approval'. Estado actual: '${order.status}'`,
        );
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

      await this.recordHistory(trx, orderId, 'pending_approval', 'confirmed', null);

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
        customer_id: order.customer_id,
        customer_name: customerName,
        total,
      });

      this.notifyCustomer(
        order.customer_id,
        orderId,
        'Pedido confirmado ✓',
        `Tu pedido ${updated.code} fue confirmado y está en proceso.`,
      );

      return updated;
    });
  }

  /**
   * "Tomar pedido en campo" (preventa): el vendedor arma el pedido y lo deja
   * `confirmed` en UNA transacción atómica e idempotente. Equivale a
   * updateDraft(fecha) + confirm + approve, pero sin los 3 round-trips ni el
   * riesgo de quedar a medias (un fallo de red dejaba el pedido en
   * `pending_approval` y el reintento moría en "solo desde draft").
   *
   * Avanza lo que falte e ignora lo ya hecho:
   *   - draft            → confirmed (camino normal)
   *   - pending_approval → confirmed (reintento tras un place a medias)
   *   - confirmed        → no-op (reintento por red; la trx previa ya aplicó)
   *   - fulfilled/cancelled → 409
   *
   * Stock: la preventa (con fecha de entrega) NO reserva — se consume en el
   * reparto (fulfill), igual que confirm(). Sin fecha sí reserva al confirmar.
   */
  async place(orderId: string, dto: UpdateOrderDraftDto = {}) {
    if (!UUID_REGEX.test(orderId))
      throw new BadRequestException('orderId inválido');

    return this.tk.run(async (trx) => {
      const order = await trx('commercial.orders').where({ id: orderId }).first();
      if (!order) throw new NotFoundException(`Order ${orderId} no encontrada`);
      await this.enforceOrderOwnership(trx, order);

      if (order.status === 'confirmed') return order; // idempotente: ya tomado
      if (order.status === 'fulfilled')
        throw new ConflictException('Pedido ya entregado');
      if (order.status === 'cancelled')
        throw new ConflictException('Pedido cancelado no se puede tomar');

      const userId = this.tenantCtx.get()?.userId || null;

      // Header (fecha de entrega / notes / delivery_type): solo editable en draft.
      if (order.status === 'draft') {
        const patch: Record<string, any> = {};
        if (dto.notes !== undefined) patch.notes = dto.notes || null;
        if (dto.delivery_type !== undefined) {
          if (!['route', 'long_trip'].includes(dto.delivery_type))
            throw new BadRequestException(`delivery_type inválido: ${dto.delivery_type}`);
          patch.delivery_type = dto.delivery_type;
        }
        if (dto.requested_delivery_date !== undefined) {
          const d = dto.requested_delivery_date || null;
          if (d && !DATE_REGEX.test(d))
            throw new BadRequestException('requested_delivery_date debe ser YYYY-MM-DD');
          patch.requested_delivery_date = d;
        }
        if (Object.keys(patch).length) {
          await trx('commercial.orders').where({ id: orderId }).update(patch);
          Object.assign(order, patch);
        }
      }

      const lines = await trx('commercial.order_lines')
        .where({ order_id: orderId })
        .orderBy('line_number');
      if (lines.length === 0)
        throw new ConflictException('Pedido sin líneas no puede confirmarse');

      const isPreventa = !!order.requested_delivery_date;

      // Paso draft → pending_approval (reserva si no es preventa, congela qty).
      // Si ya entró en pending_approval, este paso ya se hizo en el confirm previo.
      if (order.status === 'draft') {
        if (!isPreventa) {
          for (const line of lines) {
            await this.stock.reserve(trx, order.warehouse_id, line.product_id, Number(line.quantity), orderId);
          }
        }
        await trx('commercial.order_lines')
          .where({ order_id: orderId })
          .whereNull('requested_quantity')
          .update({ requested_quantity: trx.raw('quantity') });
        await this.recordHistory(trx, orderId, 'draft', 'pending_approval', null);
      }

      const [updated] = await trx('commercial.orders')
        .where({ id: orderId })
        .update({
          status: 'confirmed',
          pending_approval_at: order.pending_approval_at || trx.fn.now(),
          confirmed_at: trx.fn.now(),
          updated_at: trx.fn.now(),
          updated_by: userId,
        })
        .returning('*');

      await this.recordHistory(trx, orderId, 'pending_approval', 'confirmed', 'preventa: tomada en campo');

      // Mismas señales que confirm() + approve() juntas.
      const tenantId = this.tenantCtx.requireTenantId();
      const customer = await trx('commercial.customers')
        .where({ id: order.customer_id })
        .select('name')
        .first();
      const customerName = customer?.name || order.customer_id;
      const total = Number(updated.total);

      this.alerts.emitLargeOrder(tenantId, {
        order_id: orderId, code: updated.code, customer_id: order.customer_id, customer_name: customerName, total,
      });
      this.alerts.emitOrderConfirmed(tenantId, {
        order_id: orderId, code: updated.code, customer_id: order.customer_id, customer_name: customerName, total,
      });
      this.notifyCustomer(
        order.customer_id,
        orderId,
        'Pedido confirmado ✓',
        `Tu pedido ${updated.code} fue confirmado y está en proceso.`,
      );

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
   * V.5 — Autoventa "pedido al instante": fast-forward a `fulfilled` en UNA sola
   * transacción. El vendedor arma el pedido y lo entrega en el acto (vende de la
   * mercancía del camión), sin pasar por la aprobación en 2 tiempos.
   *
   * Acepta cualquier estado previo a la entrega y avanza lo que falte:
   *   - draft           → reserva stock + congela requested_quantity + confirmed → fulfilled
   *   - pending_approval → confirmed → fulfilled (stock ya reservado en el confirm)
   *   - confirmed        → fulfilled
   * Idempotente-ish: 409 si ya está fulfilled/cancelled.
   *
   * El consumo de inventario sale del almacén central (beta); la conciliación
   * real del camión vive en los tickets de carga/venta del cierre de ruta.
   */
  async deliverNow(orderId: string) {
    if (!UUID_REGEX.test(orderId))
      throw new BadRequestException('orderId inválido');

    return this.tk.run(async (trx) => {
      const order = await trx('commercial.orders').where({ id: orderId }).first();
      if (!order) throw new NotFoundException(`Order ${orderId} no encontrada`);
      await this.enforceOrderOwnership(trx, order);
      if (order.status === 'fulfilled')
        throw new ConflictException('Pedido ya entregado');
      if (order.status === 'cancelled')
        throw new ConflictException('Pedido cancelado no se puede entregar');

      const userId = this.tenantCtx.get()?.userId || null;

      if (order.status === 'draft') {
        const lines = await trx('commercial.order_lines')
          .where({ order_id: orderId })
          .orderBy('line_number');
        if (lines.length === 0)
          throw new ConflictException('Pedido sin líneas no puede entregarse');

        for (const line of lines) {
          await this.stock.reserve(trx, order.warehouse_id, line.product_id, Number(line.quantity), orderId);
        }
        await trx('commercial.order_lines')
          .where({ order_id: orderId })
          .whereNull('requested_quantity')
          .update({ requested_quantity: trx.raw('quantity') });

        await trx('commercial.orders')
          .where({ id: orderId })
          .update({
            status: 'confirmed',
            pending_approval_at: trx.fn.now(),
            confirmed_at: trx.fn.now(),
            updated_at: trx.fn.now(),
            updated_by: userId,
          });
        await this.recordHistory(trx, orderId, 'draft', 'confirmed', 'autoventa: entrega inmediata');
      } else if (order.status === 'pending_approval') {
        await trx('commercial.orders')
          .where({ id: orderId })
          .update({
            status: 'confirmed',
            confirmed_at: trx.fn.now(),
            updated_at: trx.fn.now(),
            updated_by: userId,
          });
        await this.recordHistory(trx, orderId, 'pending_approval', 'confirmed', 'autoventa: entrega inmediata');
      }

      // Estado garantizado 'confirmed' → fulfillInTransaction consume y entrega.
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

    const expiredHits: Array<{ product_id: string; quantity_from_expired: number }> = [];
    for (const line of lines) {
      const { expiredConsumed } = await this.stock.consume(
        trx,
        order.warehouse_id,
        line.product_id,
        Number(line.quantity),
        orderId,
      );
      if (expiredConsumed > 0)
        expiredHits.push({ product_id: line.product_id, quantity_from_expired: expiredConsumed });
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
      customer_id: order.customer_id,
      customer_name: customer?.name || order.customer_id,
      total: Number(updated.total),
    });

    if (expiredHits.length) {
      this.alerts.emitSoldExpired(tenantId, {
        order_id: orderId,
        order_code: updated.code,
        customer_name: customer?.name || order.customer_id,
        items: expiredHits,
      });
    }

    return updated;
  }

  /**
   * draft/pending_approval/confirmed → cancelled
   * Si está pending_approval o confirmed, libera reservas (stock se reserva en
   * el confirm del cliente, sigue reservado hasta cancel o fulfill).
   */
  async cancel(orderId: string, reason?: string) {
    if (!UUID_REGEX.test(orderId))
      throw new BadRequestException('orderId inválido');

    return this.tk.run(async (trx) => {
      const order = await trx('commercial.orders').where({ id: orderId }).first();
      if (!order) throw new NotFoundException(`Order ${orderId} no encontrada`);
      await this.enforceOrderOwnership(trx, order);
      if (order.status === 'cancelled')
        throw new ConflictException('Pedido ya estaba cancelado');
      if (order.status === 'fulfilled')
        throw new ConflictException(
          'No se puede cancelar un pedido ya entregado. Generar devolución.',
        );

      if (order.status === 'confirmed' || order.status === 'pending_approval') {
        const lines = await trx('commercial.order_lines')
          .where({ order_id: orderId });
        for (const line of lines) {
          await this.stock.release(
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
      await this.enforceOrderOwnership(trx, order);

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

  /**
   * J.10 — Tracking de embarques desde el módulo comercial.
   *
   * Devuelve los shipments asociados a un order (filtrados por tenant via RLS),
   * incluyendo timestamps de cada transición. Pensado para que el Portal B2B
   * y el módulo vendedor muestren el estado real de entrega sin requerir el
   * permiso `LOGISTICS_SHIPMENTS_VER` (este endpoint vive en commercial y
   * reusa `COMMERCIAL_ORDERS_VER`).
   *
   * customer_b2b solo puede leer shipments de SUS órdenes (ownership check).
   */
  async getShipments(orderId: string) {
    if (!UUID_REGEX.test(orderId))
      throw new BadRequestException('orderId inválido');

    return this.tk.run(async (trx) => {
      const order = await trx('commercial.orders')
        .where({ id: orderId })
        .select('id', 'customer_id')
        .first();
      if (!order) throw new NotFoundException(`Order ${orderId} no encontrada`);
      await this.enforceOrderOwnership(trx, order);

      return trx('logistics.shipments as s')
        .leftJoin('logistics.vehicles as v', 'v.id', 's.vehicle_id')
        .leftJoin('logistics.routes as r', 'r.id', 's.route_id')
        .where('s.order_id', orderId)
        .whereNull('s.deleted_at')
        .orderBy('s.created_at', 'asc')
        .select(
          's.id',
          's.folio',
          's.status',
          's.type',
          's.origin',
          's.destination',
          's.shipment_date',
          's.departure_at',
          's.arrival_at',
          's.closed_at',
          's.created_at',
          'v.plate as vehicle_plate',
          'r.name as route_name',
        );
    });
  }

  /** Lista pedidos del customer del JWT actual (Portal B2B). */
  async listMyOrders(query: ListOrdersQuery & { customer_id?: string }) {
    const customerId = await this.resolveCustomerIdFromCtx();
    if (!customerId) {
      // Sin customer_id linkeado (= no es customer_b2b o user mal configurado)
      // → respuesta vacía 200 en vez de 400. El portal frontend leakea
      // refreshCart() a navegaciones admin (bug) y el 400 ensucia la consola
      // a admins legítimos. Si el user es realmente un customer_b2b sin link,
      // verá un carrito vacío que es el comportamiento esperado.
      const page = Math.max(1, Number(query.page) || 1);
      const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 50));
      return {
        data: [],
        page,
        pageSize,
        total: 0,
        pagination: { page, pageSize, total: 0, pageCount: 0 },
      };
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

  /**
   * Variante de `resolveCustomerIdFromCtx` que usa una trx existente —
   * evita abrir un sub-trx anidado cuando ya estamos dentro de `tk.run`.
   */
  private async resolveCustomerIdFromUser(trx: any): Promise<string | null> {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) return null;
    const row = await trx('public.users')
      .where({ id: userId })
      .select('customer_id')
      .first();
    return row?.customer_id || null;
  }

  /**
   * Defense in depth: para usuarios con rol `customer_b2b`, valida que el
   * pedido pertenezca al customer linkeado al user. Sin esta validación, un
   * customer_b2b autenticado podría leer / modificar pedidos de cualquier
   * otro customer del mismo tenant (RLS no protege porque comparten tenant).
   * Admin / vendedor / supervisor pasan sin validación (su permiso ya implica
   * scope global tenant).
   */
  private async enforceOrderOwnership(trx: any, order: { customer_id: string }): Promise<void> {
    const ctx = this.tenantCtx.get();
    if (ctx?.roleName !== 'customer_b2b') return;
    const myCustomerId = await this.resolveCustomerIdFromUser(trx);
    if (!myCustomerId) {
      throw new ForbiddenException('Usuario customer_b2b sin customer_id linkeado');
    }
    if (order.customer_id !== myCustomerId) {
      throw new ForbiddenException('No tenés acceso a este pedido');
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Reads
  // ─────────────────────────────────────────────────────────────────

  async findById(orderId: string) {
    if (!UUID_REGEX.test(orderId))
      throw new BadRequestException('orderId inválido');

    return this.tk.run(async (trx) => {
      // Ownership pre-check con query liviano antes del join completo.
      const headOnly = await trx('commercial.orders')
        .where({ id: orderId })
        .select('id', 'customer_id')
        .first();
      if (!headOnly) throw new NotFoundException(`Order ${orderId} no encontrada`);
      await this.enforceOrderOwnership(trx, headOnly);

      const order = await trx('commercial.orders as o')
        .leftJoin('commercial.customers as c', 'c.id', 'o.customer_id')
        .leftJoin('commercial.warehouses as w', 'w.id', 'o.warehouse_id')
        .leftJoin('public.users as u', 'u.id', 'o.user_id')
        .leftJoin('logistics.routes as r', 'r.id', 'o.route_id')
        .where('o.id', orderId)
        .first(
          'o.*',
          'o.code as folio',
          'c.name as customer_name',
          'w.code as warehouse_code',
          'w.name as warehouse_name',
          'u.username as user_username',
          'r.name as route_name',
        );
      if (!order) throw new NotFoundException(`Order ${orderId} no encontrada`);
      const lines = await trx('commercial.order_lines as ol')
        .leftJoin('public.products as p', 'p.id', 'ol.product_id')
        .leftJoin('public.brands as b', 'b.id', 'p.brand_id')
        .leftJoin('commercial.stock as s', function () {
          this.on('s.product_id', '=', 'ol.product_id').andOn(
            's.warehouse_id',
            '=',
            trx.raw('?', [order.warehouse_id]),
          );
        })
        .where('ol.order_id', orderId)
        .orderBy('ol.line_number')
        .select(
          'ol.*',
          'p.nombre as product_name',
          'b.nombre as brand_name',
          trx.raw('COALESCE(s.quantity, 0) as stock_quantity'),
          trx.raw('COALESCE(s.reserved_quantity, 0) as stock_reserved'),
          // Stock disponible para ESTA línea: si el pedido está pending_approval/confirmed,
          // la qty de la línea ya está incluida en reserved → se suma de vuelta para
          // mostrar el tope al que se puede subir la línea. En draft no se reserva,
          // así que (quantity - reserved) ya es el disponible real.
          trx.raw(
            `GREATEST(
               COALESCE(s.quantity, 0) - COALESCE(s.reserved_quantity, 0)
               + CASE WHEN ? IN ('pending_approval','confirmed') THEN ol.quantity ELSE 0 END,
               0
             ) as stock_available`,
            [order.status],
          ),
        );
      return { ...order, lines };
    });
  }

  async list(query: ListOrdersQuery) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 50));
    const offset = (page - 1) * pageSize;

    return this.tk.run(async (trx) => {
      // Defense in depth: si el rol es customer_b2b, sobrescribir cualquier
      // customer_id que venga en la query con el customer del JWT. Sin esto,
      // un customer_b2b podría listar pedidos de otros customers del tenant
      // pasando `?customer_id=<otro>` (RLS no diferencia entre customers).
      const ctx = this.tenantCtx.get();
      if (ctx?.roleName === 'customer_b2b') {
        const myCustomerId = await this.resolveCustomerIdFromUser(trx);
        if (!myCustomerId) {
          throw new ForbiddenException('Usuario customer_b2b sin customer_id linkeado');
        }
        query = { ...query, customer_id: myCustomerId };
      }

      let q = trx('commercial.orders as o')
        .leftJoin('commercial.customers as c', 'c.id', 'o.customer_id')
        .leftJoin('commercial.warehouses as w', 'w.id', 'o.warehouse_id')
        .leftJoin('public.users as u', 'u.id', 'o.user_id')
        .leftJoin('logistics.routes as r', 'r.id', 'o.route_id')
        .whereNull('o.deleted_at');

      if (query.status) q = q.where('o.status', query.status);
      if (query.statuses) {
        const list = query.statuses
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (list.length) q = q.whereIn('o.status', list);
      }
      if (query.customer_id) q = q.where('o.customer_id', query.customer_id);
      if (query.user_id) q = q.where('o.user_id', query.user_id);
      if (query.mine) {
        // Cartera del vendedor: pedidos de clientes en la ruta que trade le
        // asignó para HOY (daily_assignments). Incluye preventa (customer_b2b) y
        // de campo por igual. Ver vendorTodayRouteExistsSql.
        const meId = this.tenantCtx.get()?.userId || null;
        q = q.whereRaw(vendorTodayRouteExistsSql('c'), [meId]);
      }
      if (query.from) q = q.where('o.created_at', '>=', query.from);
      if (query.to) q = q.where('o.created_at', '<=', query.to);

      const [agg] = await q
        .clone()
        .select(
          trx.raw('count(o.id)::int as count'),
          trx.raw('coalesce(sum(o.total), 0)::numeric as total_amount'),
        );
      const total = Number(agg?.count) || 0;
      const totalAmount = Number(agg?.total_amount) || 0;

      const data = await q
        .select(
          'o.id',
          'o.code as folio',
          'o.code',
          'o.status',
          'o.delivery_type',
          'o.requested_delivery_date',
          'o.customer_id',
          'c.name as customer_name',
          'o.warehouse_id',
          'w.code as warehouse_code',
          'w.name as warehouse_name',
          'o.subtotal',
          'o.tax_total',
          'o.total',
          'o.balance_due',
          'o.basket_promo_code',
          'o.basket_discount_amount',
          'o.notes',
          'o.user_id',
          'u.username as user_username',
          // Preventa = pedido originado por el propio cliente vía Portal B2B
          // (su user es customer_b2b). Campo = lo tomó un vendedor en sitio.
          trx.raw("(u.role_name = 'customer_b2b') as is_preventa"),
          'o.route_id',
          'r.name as route_name',
          'o.created_at',
          'o.pending_approval_at',
          'o.confirmed_at',
          'o.fulfilled_at',
          'o.cancelled_at',
        )
        .orderBy('o.created_at', 'desc')
        .limit(pageSize)
        .offset(offset);

      return {
        data,
        page,
        pageSize,
        total,
        total_amount: totalAmount,
        pagination: {
          page,
          pageSize,
          total,
          pageCount: Math.ceil(total / pageSize) || 0,
        },
      };
    });
  }

  /**
   * Conteo de pedidos agrupado por status en UNA query (GROUP BY). Reemplaza el
   * N+1 del front (un listOrders por chip). Respeta los mismos filtros base que
   * list() + el scope customer_b2b. NO filtra por status: devuelve el conteo de
   * todos para que el front pinte los chips que necesite.
   */
  async countsByStatus(query: ListOrdersQuery) {
    return this.tk.run(async (trx) => {
      let q2 = query;
      const ctx = this.tenantCtx.get();
      if (ctx?.roleName === 'customer_b2b') {
        const myCustomerId = await this.resolveCustomerIdFromUser(trx);
        if (!myCustomerId) {
          throw new ForbiddenException('Usuario customer_b2b sin customer_id linkeado');
        }
        q2 = { ...query, customer_id: myCustomerId };
      }

      let q = trx('commercial.orders as o')
        .leftJoin('commercial.customers as c', 'c.id', 'o.customer_id')
        .whereNull('o.deleted_at');

      if (q2.customer_id) q = q.where('o.customer_id', q2.customer_id);
      if (q2.user_id) q = q.where('o.user_id', q2.user_id);
      if (q2.mine) {
        const meId = this.tenantCtx.get()?.userId || null;
        q = q.whereRaw(vendorTodayRouteExistsSql('c'), [meId]);
      }
      if (q2.from) q = q.where('o.created_at', '>=', q2.from);
      if (q2.to) q = q.where('o.created_at', '<=', q2.to);

      const rows = await q.select('o.status').count('o.id as count').groupBy('o.status');

      const counts: Record<string, number> = {};
      let total = 0;
      for (const r of rows as any[]) {
        const n = Number(r.count) || 0;
        counts[r.status] = n;
        total += n;
      }
      return { counts, total };
    });
  }

  /**
   * J16 — serie diaria de monto + conteo de pedidos para el sparkline del KPI hero.
   * Mismo scope/filtros que countsByStatus (incl. customer_b2b). Si no se da rango,
   * usa los últimos 30 días (la sparkline necesita una ventana acotada). Alinea a
   * todos los días del rango (0 en días sin pedidos). 1 query, sin N+1.
   */
  async dailySeries(query: ListOrdersQuery) {
    return this.tk.run(async (trx) => {
      let q2 = query;
      const ctx = this.tenantCtx.get();
      if (ctx?.roleName === 'customer_b2b') {
        const myCustomerId = await this.resolveCustomerIdFromUser(trx);
        if (!myCustomerId) {
          throw new ForbiddenException('Usuario customer_b2b sin customer_id linkeado');
        }
        q2 = { ...query, customer_id: myCustomerId };
      }

      const to = q2.to || new Date().toISOString().slice(0, 10);
      const from = q2.from || (() => { const d = new Date(to); d.setDate(d.getDate() - 29); return d.toISOString().slice(0, 10); })();
      const toTs = /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to} 23:59:59` : to;

      let q = trx('commercial.orders as o')
        .leftJoin('commercial.customers as c', 'c.id', 'o.customer_id')
        .whereNull('o.deleted_at')
        .where('o.created_at', '>=', from)
        .where('o.created_at', '<=', toTs);

      if (q2.customer_id) q = q.where('o.customer_id', q2.customer_id);
      if (q2.user_id) q = q.where('o.user_id', q2.user_id);
      if (q2.mine) {
        const meId = this.tenantCtx.get()?.userId || null;
        q = q.whereRaw(vendorTodayRouteExistsSql('c'), [meId]);
      }

      const rows = await q
        .groupByRaw('o.created_at::date')
        .select([
          trx.raw('o.created_at::date as d'),
          trx.raw('coalesce(sum(o.total), 0)::numeric as amount'),
          trx.raw('count(o.id)::int as count'),
        ]);

      const key = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
      const map = new Map<string, { amount: number; count: number }>();
      for (const r of rows as any[]) map.set(key(r.d), { amount: Number(r.amount), count: Number(r.count) });

      const dates: string[] = [];
      const cur = new Date(from);
      const end = new Date(to);
      let guard = 0;
      while (cur <= end && guard++ < 400) {
        dates.push(cur.toISOString().slice(0, 10));
        cur.setDate(cur.getDate() + 1);
      }

      return {
        range: { from, to },
        dates,
        amount: dates.map((d) => map.get(d)?.amount ?? 0),
        count: dates.map((d) => map.get(d)?.count ?? 0),
      };
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
   * Permite editar/borrar líneas mientras el pedido sea editable por alguien:
   *   - `draft`: el cliente sigue armando, stock NO reservado todavía.
   *   - `pending_approval`: el vendedor ajusta cantidades antes de aprobar;
   *     stock SÍ reservado → cualquier delta debe re-reservar/liberar.
   */
  private async requireEditableForLines(trx: any, orderId: string) {
    const order = await trx('commercial.orders').where({ id: orderId }).first();
    if (!order) throw new NotFoundException(`Order ${orderId} no encontrada`);
    if (order.status !== 'draft' && order.status !== 'pending_approval')
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

  /**
   * Recalcula totals del order. Aplica promos active del tenant ANTES de sumar
   * (nxm, percent_off_product, volume_discount, bundle_fixed_price, cross_sell).
   * El basket-level (percent_off_basket) se aplica al final sobre subtotal+tax.
   *
   * Cada call es idempotente: parte siempre de `quantity * unit_price * (1 - manual_discount)`
   * (no del line_subtotal stored), y reescribe los 3 totals de la línea. Permite
   * re-correr el recalc al editar líneas sin acumular discounts.
   */
  private async recalcOrderTotals(trx: any, orderId: string): Promise<void> {
    const lines = await trx('commercial.order_lines')
      .where({ order_id: orderId })
      .orderBy('line_number');

    const promos = await this.loadActivePromotions(trx);

    // Index de qty por product_id en este order (para bundle / cross_sell).
    const qtyByProduct = new Map<string, number>();
    for (const l of lines) {
      qtyByProduct.set(l.product_id, (qtyByProduct.get(l.product_id) || 0) + Number(l.quantity));
    }

    // Pre-compute: qué lines tienen bundle aplicable (todos los items del bundle
    // cumplen qty). Marcamos line.product_id → bundle.id que la cubre.
    const bundleByLine = new Map<string, any>();
    const bundles = promos.filter((p) => p.promotion_type === 'bundle_fixed_price');
    for (const promo of bundles) {
      const items: Array<{ product_id: string; quantity: number }> = Array.isArray(promo.rules?.items)
        ? promo.rules.items
        : [];
      if (!items.length) continue;
      const fulfilled = items.every((it) => (qtyByProduct.get(it.product_id) || 0) >= Number(it.quantity || 1));
      if (!fulfilled) continue;
      for (const it of items) {
        // Solo aplicamos bundle si esta línea no fue tomada ya por otra bundle de mayor priority.
        if (!bundleByLine.has(it.product_id)) bundleByLine.set(it.product_id, promo);
      }
    }

    for (const line of lines) {
      const qty = Number(line.quantity);
      const unitPrice = Number(line.unit_price);
      const manualDiscount = Number(line.discount_percent) || 0;
      const taxRate = Number(line.tax_rate);

      const baseSubtotal = qty * unitPrice * (1 - manualDiscount);
      let lineSubtotal = baseSubtotal;
      let appliedPromoCode: string | null = null;
      let appliedPromoType: string | null = null;

      const bundle = bundleByLine.get(line.product_id);
      if (bundle) {
        const items: Array<{ product_id: string; quantity: number }> = bundle.rules.items;
        const bundlePrice = Number(bundle.rules.price);
        const bundleBaseTotal = items.reduce((acc, it) => {
          const ln = lines.find((l) => l.product_id === it.product_id);
          if (!ln) return acc;
          return acc + Number(it.quantity) * Number(ln.unit_price);
        }, 0);
        if (bundleBaseTotal > 0) {
          const lineWeight = (qty * unitPrice) / bundleBaseTotal;
          lineSubtotal = +(bundlePrice * lineWeight).toFixed(2);
          appliedPromoCode = bundle.code;
          appliedPromoType = 'bundle_fixed_price';
        }
      } else {
        for (const p of promos) {
          if (p.promotion_type === 'bundle_fixed_price' || p.promotion_type === 'percent_off_basket') continue;
          const r = p.rules || {};
          let discountAmount = 0;

          if (p.promotion_type === 'nxm' && r.product_id === line.product_id) {
            const nBuy = Math.max(1, Number(r.n_buy) || 1);
            const mPay = Math.max(1, Number(r.m_pay) || nBuy);
            if (mPay < nBuy && qty >= nBuy) {
              const groups = Math.floor(qty / nBuy);
              const freeUnits = groups * (nBuy - mPay);
              discountAmount = freeUnits * unitPrice;
            }
          } else if (p.promotion_type === 'percent_off_product' && r.product_id === line.product_id) {
            const pct = Math.min(1, Math.max(0, Number(r.percent) || 0));
            discountAmount = qty * unitPrice * pct;
          } else if (p.promotion_type === 'volume_discount' && r.product_id === line.product_id) {
            const tiers: Array<{ min_qty: number; percent: number }> = Array.isArray(r.tiers) ? r.tiers : [];
            const sorted = [...tiers].sort((a, b) => Number(b.min_qty) - Number(a.min_qty));
            const tier = sorted.find((t) => qty >= Number(t.min_qty));
            if (tier) {
              const pct = Math.min(1, Math.max(0, Number(tier.percent) || 0));
              discountAmount = qty * unitPrice * pct;
            }
          } else if (p.promotion_type === 'cross_sell_discount') {
            const trigger = qtyByProduct.get(r.trigger_product_id) || 0;
            if (trigger > 0 && r.target_product_id === line.product_id) {
              const pct = Math.min(1, Math.max(0, Number(r.percent) || 0));
              discountAmount = qty * unitPrice * pct;
            }
          }

          if (discountAmount > 0) {
            lineSubtotal = +(baseSubtotal - discountAmount).toFixed(2);
            appliedPromoCode = p.code;
            appliedPromoType = p.promotion_type;
            break;
          }
        }
      }

      lineSubtotal = Math.max(0, +lineSubtotal.toFixed(2));
      const lineTax = +(lineSubtotal * taxRate).toFixed(2);
      const lineTotal = +(lineSubtotal + lineTax).toFixed(2);
      const discountAmount = +Math.max(0, baseSubtotal - lineSubtotal).toFixed(2);

      const cleanedNotes = typeof line.notes === 'string' && line.notes.startsWith('Promo aplicada:')
        ? null
        : line.notes;

      await trx('commercial.order_lines')
        .where({ id: line.id })
        .update({
          line_subtotal: lineSubtotal,
          line_tax: lineTax,
          line_total: lineTotal,
          applied_promo_code: appliedPromoCode,
          applied_promo_type: appliedPromoType,
          discount_amount: discountAmount,
          notes: cleanedNotes,
        });
    }

    // Sum lines.
    const sums = await trx('commercial.order_lines')
      .where({ order_id: orderId })
      .sum({ subtotal: 'line_subtotal', tax: 'line_tax', total: 'line_total' });
    let { subtotal, tax, total } = sums[0] as {
      subtotal: string | null;
      tax: string | null;
      total: string | null;
    };
    let s = Number(subtotal) || 0;
    let t = Number(tax) || 0;
    let g = Number(total) || 0;

    let basketPromoCode: string | null = null;
    let basketDiscountAmount = 0;
    const basketPromo = promos.find((p) => p.promotion_type === 'percent_off_basket');
    if (basketPromo) {
      const pct = Math.min(1, Math.max(0, Number(basketPromo.rules?.percent) || 0));
      const minOrder = Number(basketPromo.min_order_amount) || 0;
      if (pct > 0 && g >= minOrder) {
        const totalBefore = g;
        s = +(s * (1 - pct)).toFixed(2);
        t = +(t * (1 - pct)).toFixed(2);
        g = +(s + t).toFixed(2);
        basketPromoCode = basketPromo.code;
        basketDiscountAmount = +(totalBefore - g).toFixed(2);
      }
    }

    await trx('commercial.orders')
      .where({ id: orderId })
      .update({
        subtotal: s,
        tax_total: t,
        total: g,
        balance_due: g,
        basket_promo_code: basketPromoCode,
        basket_discount_amount: basketDiscountAmount,
        updated_at: trx.fn.now(),
      });
  }

  /**
   * Lee promociones activas del tenant ordenadas por priority (menor = más fuerte).
   * Filtra por vigencia (starts_at/ends_at) y por flag `active`.
   * Ignora `applies_to_customer_ids` por ahora (todas se asumen all_customers
   * en beta).
   */
  private async loadActivePromotions(trx: any): Promise<any[]> {
    const now = new Date();
    return trx('commercial.promotions')
      .where({ active: true })
      .whereNull('deleted_at')
      .andWhere((q: any) => {
        q.whereNull('starts_at').orWhere('starts_at', '<=', now);
      })
      .andWhere((q: any) => {
        q.whereNull('ends_at').orWhere('ends_at', '>=', now);
      })
      .orderBy('priority', 'asc')
      .orderBy('code', 'asc');
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
}
