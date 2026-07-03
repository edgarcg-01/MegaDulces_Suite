import { Injectable, Logger } from '@nestjs/common';
import { AlertsGateway } from './alerts.gateway';
import { Alert, AlertType, AlertSeverity, ALERT_THRESHOLDS } from './alerts.types';

/**
 * Helper para emitir alertas WS con builder methods por tipo.
 *
 * Pattern: services downstream (OrdersService, scanner) llaman a métodos
 * tipados (`emitLargeOrder`, `emitLowStock`) en vez de construir el payload
 * manualmente. Esto centraliza el formato y facilita cambios de schema.
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(private readonly gateway: AlertsGateway) {}

  /** Emisión genérica. */
  emit(tenantId: string, alert: Omit<Alert, 'emitted_at'>): void {
    const full: Alert = { ...alert, emitted_at: new Date().toISOString() };
    this.gateway.emitToTenant(tenantId, full);
  }

  // ─────────── builders por tipo ───────────

  emitLargeOrder(tenantId: string, params: {
    order_id: string;
    code: string;
    customer_id: string;
    customer_name: string;
    total: number;
  }): void {
    if (params.total < ALERT_THRESHOLDS.LARGE_ORDER_MXN) return; // bajo umbral, skip
    this.emit(tenantId, {
      type: 'large_order',
      severity: params.total >= ALERT_THRESHOLDS.LARGE_ORDER_MXN * 3 ? 'critical' : 'warn',
      title: `Pedido grande confirmado: ${params.code}`,
      message: `${params.customer_name} — $${params.total.toFixed(2)} MXN`,
      data: params,
    });
  }

  emitOrderFulfilled(tenantId: string, params: {
    order_id: string;
    code: string;
    customer_id: string;
    customer_name: string;
    total: number;
  }): void {
    this.emit(tenantId, {
      type: 'order_fulfilled',
      severity: 'info',
      title: `Pedido entregado: ${params.code}`,
      message: `${params.customer_name} — $${params.total.toFixed(2)}`,
      data: params,
    });
  }

  emitOrderConfirmed(tenantId: string, params: {
    order_id: string;
    code: string;
    customer_id: string;
    customer_name: string;
    total: number;
  }): void {
    this.emit(tenantId, {
      type: 'order_confirmed',
      severity: 'info',
      title: `Pedido confirmado: ${params.code}`,
      message: `${params.customer_name} — $${params.total.toFixed(2)}`,
      data: params,
    });
  }

  emitLowStock(tenantId: string, params: {
    product_id: string;
    product_name: string;
    brand_name: string | null;
    warehouse_code: string;
    available_quantity: number;
  }): void {
    const severity: AlertSeverity =
      params.available_quantity === 0 ? 'critical' :
      params.available_quantity < 20 ? 'critical' : 'warn';
    this.emit(tenantId, {
      type: 'low_stock_critical',
      severity,
      title: `Stock crítico: ${params.product_name}`,
      message: `${params.available_quantity} unidades en ${params.warehouse_code}`,
      data: params,
    });
  }

  emitExpiringLots(tenantId: string, params: {
    product_id: string;
    product_name: string;
    brand_name: string | null;
    warehouse_code: string;
    lot_code: string;
    expiry_date: string;
    quantity: number;
    days_to_expiry: number;
  }): void {
    const expired = params.days_to_expiry < 0;
    const severity: AlertSeverity =
      expired || params.days_to_expiry <= ALERT_THRESHOLDS.EXPIRING_LOTS_CRITICAL_DAYS ? 'critical' : 'warn';
    this.emit(tenantId, {
      type: 'expiring_lots',
      severity,
      title: expired
        ? `Lote VENCIDO: ${params.product_name}`
        : `Lote por vencer: ${params.product_name}`,
      message: expired
        ? `${params.quantity} u · lote ${params.lot_code} · venció hace ${Math.abs(params.days_to_expiry)} días (${params.warehouse_code})`
        : `${params.quantity} u · lote ${params.lot_code} · vence en ${params.days_to_expiry} días (${params.warehouse_code})`,
      data: params,
    });
  }

  emitVipInactive(tenantId: string, params: {
    customer_id: string;
    customer_code: string;
    customer_name: string;
    credit_limit: number;
    days_inactive: number | null;
  }): void {
    this.emit(tenantId, {
      type: 'vip_inactive',
      severity: 'warn',
      title: `VIP inactivo: ${params.customer_name}`,
      message: params.days_inactive
        ? `Sin pedido hace ${params.days_inactive} días (crédito $${params.credit_limit.toFixed(0)})`
        : `Nunca compró (crédito $${params.credit_limit.toFixed(0)})`,
      data: params,
    });
  }

  emitSoldExpired(tenantId: string, params: {
    order_id: string;
    order_code: string;
    customer_name: string;
    items: Array<{ product_id: string; quantity_from_expired: number }>;
  }): void {
    const totalUnits = params.items.reduce((s, i) => s + i.quantity_from_expired, 0);
    this.emit(tenantId, {
      type: 'sold_expired',
      severity: 'warn',
      title: `Pedido ${params.order_code} despachó producto vencido`,
      message: `${totalUnits} u de ${params.items.length} producto(s) salieron de lote vencido — ${params.customer_name}`,
      data: params,
    });
  }

  /**
   * Reparto — entrega asignada a un repartidor. El payload lleva `rider_user_id`
   * para que la app del repartidor filtre las suyas (sala por tenant, filtro por
   * usuario en cliente). Seam WhatsApp (Fase F): cuando haya BSP, este mismo
   * builder dispara además el mensaje al repartidor/cliente.
   */
  emitDeliveryAssigned(tenantId: string, params: {
    delivery_id: string;
    folio: string;
    rider_user_id: string;
    customer_name: string;
    address: string | null;
    units: number;
    collect_on_delivery: boolean;
    amount_to_collect: number | null;
  }): void {
    this.emit(tenantId, {
      type: 'delivery_assigned',
      severity: 'info',
      title: `Nueva entrega asignada: ${params.folio}`,
      message: params.collect_on_delivery
        ? `${params.customer_name} — cobrar $${Number(params.amount_to_collect || 0).toFixed(2)}`
        : `${params.customer_name} — ya pagado`,
      data: params,
    });
    // TODO Fase F (ADR-006): notificar al repartidor por WhatsApp con domicilio + qué cargar.
  }

  /**
   * Reparto — entrega completada. Para el seguimiento del encargado en tienda y
   * (Fase F) el aviso "entregado" al cliente por WhatsApp.
   */
  emitDeliveryDelivered(tenantId: string, params: {
    delivery_id: string;
    folio: string;
    rider_user_id: string | null;
    customer_name: string;
    delivered_at: string;
    collected_amount: number | null;
  }): void {
    this.emit(tenantId, {
      type: 'delivery_delivered',
      severity: 'info',
      title: `Entrega completada: ${params.folio}`,
      message: params.collected_amount
        ? `${params.customer_name} — cobrado $${Number(params.collected_amount).toFixed(2)}`
        : `${params.customer_name} — entregado`,
      data: params,
    });
    // TODO Fase F (ADR-006): notificar al cliente por WhatsApp ("tu pedido fue entregado").
  }

  /** Test manual para smoke. */
  emitTest(tenantId: string, message?: string): void {
    this.emit(tenantId, {
      type: 'test',
      severity: 'info',
      title: 'Test alert',
      message: message || 'Smoke test desde POST /commercial/alerts/test',
      data: { triggered_at: new Date().toISOString() },
    });
  }
}
