/**
 * Tipos del feature store por customer (Fase M, Sprint M.0).
 *
 * Customer 360 = "telemetría" del cliente derivada de commercial.orders.
 * Determinista, sin ML, sin tocar dinero. Lee de aquí el Motor de Decisión.
 */

export type LifecycleStage =
  | 'new'
  | 'active'
  | 'at_risk'
  | 'lost'
  | 'reactivated';

export interface Customer360 {
  customer_id: string;
  orders_count: number;
  first_order_at: string | null;
  last_order_at: string | null;
  recency_days: number | null;
  frequency_90d: number;
  monetary_90d: number;
  aov: number;
  /** Mediana de días entre pedidos. null si <3 pedidos (no hay suficientes gaps). */
  cadence_days: number | null;
  /** last_order_at + cadence_days. null si no hay cadencia. */
  next_order_estimate: string | null;
  lifecycle_stage: LifecycleStage;
  computed_at: string;
}

export type NbaAction = 'due_for_reorder' | 'none';

export interface NextBestAction {
  customer_id: string;
  action: NbaAction;
  reason: string;
  urgency: 'low' | 'medium' | 'high' | null;
  days_overdue: number | null;
  next_order_estimate: string | null;
  lifecycle_stage: LifecycleStage | null;
}

export interface NbaListItem {
  customer_id: string;
  code: string | null;
  name: string | null;
  last_order_at: string | null;
  next_order_estimate: string | null;
  cadence_days: number | null;
  lifecycle_stage: LifecycleStage;
  days_overdue: number;
  urgency: 'low' | 'medium' | 'high';
}

export interface ReorderMessageItem {
  product_id: string;
  product_name: string;
  sample_price: number;
}

export interface ReorderMessage {
  customer_id: string;
  action: NbaAction;
  urgency: 'low' | 'medium' | 'high' | null;
  channel_hint: 'whatsapp' | 'push' | null;
  /** null cuando action !== 'due_for_reorder'. */
  message: string | null;
  generated_by: 'llm' | 'template' | 'none';
  basket: ReorderMessageItem[];
  reason: string;
}
