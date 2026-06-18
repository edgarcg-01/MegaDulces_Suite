/**
 * Tipos compartidos para alertas WS commercial.
 *
 * Cada alert es self-contained: el frontend lo recibe y muestra sin necesidad
 * de hacer GET adicionales. Por eso el `data` lleva snapshot de lo relevante
 * (customer name, product name, etc.).
 */

export type AlertType =
  | 'low_stock_critical' // available_quantity < threshold
  | 'expiring_lots'      // lote con caducidad próxima o vencida (FEFO)
  | 'large_order'        // order.total > threshold al confirmar
  | 'vip_inactive'       // customer con credit_limit alto sin compra en N días
  | 'order_confirmed'    // every order confirm (informativo)
  | 'order_fulfilled'    // every order fulfill (informativo)
  | 'test';              // manual trigger para smoke testing

export type AlertSeverity = 'info' | 'warn' | 'critical';

export interface Alert<T = Record<string, any>> {
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  data: T;
  emitted_at: string; // ISO 8601
}

/** Umbrales por default (futuro: por-tenant configurable). */
export const ALERT_THRESHOLDS = {
  LARGE_ORDER_MXN: 3000,           // pedido confirmado > $3k = grande
  LOW_STOCK_AVAILABLE: 50,         // available < 50 unidades = crítico
  VIP_CREDIT_LIMIT_MXN: 15000,     // customer con credit_limit >= $15k = VIP
  VIP_INACTIVE_DAYS: 14,           // VIP sin compra en 14 días = alert
  EXPIRING_LOTS_DAYS: 30,          // lote que vence en <= 30 días = alert (incluye ya vencidos)
  EXPIRING_LOTS_CRITICAL_DAYS: 7,  // <= 7 días o vencido = critical
} as const;
