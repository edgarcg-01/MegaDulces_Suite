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
