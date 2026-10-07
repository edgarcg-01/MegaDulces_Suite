// Contrato del wire REST del Command Center (ADR-052 / FASE_TS_CONTRATOS_TIPADOS).
//
// Fuente UNICA: el backend (BFF de commercial-analytics) devuelve este shape y el
// frontend (CommandCenterService) importa ESTE tipo. Un cambio de forma = error de
// compilacion en ambos lados. Semilla cosechada de las interfaces que ya vivian a
// mano en apps/view/.../command-center.service.ts (el "atajo de los 849", TS.2).
//
// Campos en English snake_case (convencion del proyecto). Zod v4.

import { z } from 'zod';

// Timestamp del wire. Knex/node-postgres entrega las columnas timestamp/date como
// objetos `Date` (pre-serializacion), pero el wire JSON siempre lleva un string ISO
// —es lo que `JSON.stringify(date)` producia historicamente—. Este schema acepta
// ambos y NORMALIZA a ISO, asi el `.parse()` del BFF no revienta con un Date y el
// tipo inferido sigue siendo `string` (el front no cambia). Usar SOLO en campos que
// pasan por un `.parse()` de verdad. No aplicar a fechas date-only (`day`), que ya
// vienen como string 'YYYY-MM-DD' via to_char y no deben ganar hora/UTC.
const wireTimestamp = z
  .union([z.string(), z.date()])
  .transform((v) => (v instanceof Date ? v.toISOString() : v));

// ── piezas ──

export const NetworkChannelRow = z.object({
  channel: z.string(),
  revenue: z.number(),
  cost: z.number().optional(),
  margin: z.number().optional(),
  margin_pct: z.number().optional(),
  units: z.number(),
  tickets: z.number(),
  share_pct: z.number(),
});
export type NetworkChannelRow = z.infer<typeof NetworkChannelRow>;

export const NetworkOverview = z.object({
  source: z.literal('network'),
  updated_at: wireTimestamp.nullable(),
  period: z.object({
    rolling_days: z.number(),
    last_sale_date: wireTimestamp.nullable().optional(),
  }),
  cost_coverage_pct: z.number().optional(),
  revenue: z.object({
    gross: z.number(),
    cost: z.number(),
    margin: z.number(),
    margin_pct: z.number(),
    currency: z.string(),
  }),
  units: z.number(),
  tickets: z.number(),
  avg_ticket: z.number(),
  unique_customers: z.number(),
  by_channel: z.array(NetworkChannelRow),
  pipeline: z.object({
    confirmed: z.number(),
    draft: z.number(),
    cancelled: z.number(),
  }),
});
export type NetworkOverview = z.infer<typeof NetworkOverview>;

export const NetworkTopProductRow = z.object({
  source: z.literal('network'),
  product_id: z.string(),
  product_name: z.string(),
  brand_name: z.string(),
  units_sold: z.number(),
  revenue: z.number(),
  cost: z.number().optional(),
  margin: z.number().optional(),
  margin_pct: z.number().optional(),
  abc_class: z.string().nullable(),
  // Participacion sobre la venta total de la red; null cuando el backend no tenia
  // el total fresco (evita 2a pasada por sales_daily). `?share=true` lo fuerza.
  share_pct: z.number().nullable(),
  rank_by_revenue: z.number(),
});
export type NetworkTopProductRow = z.infer<typeof NetworkTopProductRow>;

export const SalesByBrandRow = z.object({
  brand_id: z.string(),
  brand_name: z.string(),
  units: z.number(),
  revenue: z.number(),
  cost: z.number().optional(),
  margin: z.number().optional(),
  margin_pct: z.number().optional(),
  share_pct: z.number(),
});
export type SalesByBrandRow = z.infer<typeof SalesByBrandRow>;

// KV.3 — cliente real de la red (Kepler) con compra agregada.
export const ErpCustomerRow = z.object({
  erp_code: z.string(),
  name: z.string(),
  rfc: z.string().nullable(),
  city: z.string().nullable(),
  last_purchase: z.string().nullable(),
  rev_180d: z.number(),
  products: z.number(),
});
export type ErpCustomerRow = z.infer<typeof ErpCustomerRow>;

export const NetworkDailyRow = z.object({
  day: z.string(),
  revenue: z.number(),
  units: z.number(),
  tickets: z.number(),
});
export type NetworkDailyRow = z.infer<typeof NetworkDailyRow>;

export const LowStockItem = z.object({
  warehouse_code: z.string(),
  warehouse_name: z.string(),
  product_id: z.string(),
  product_name: z.string(),
  brand_name: z.string(),
  quantity: z.number(),
  reserved_quantity: z.number(),
  available_quantity: z.number(),
});
export type LowStockItem = z.infer<typeof LowStockItem>;

export const LowStockResponse = z.object({
  threshold: z.number(),
  warehouse_id: z.string().nullable(),
  total: z.number(),
  items: z.array(LowStockItem),
});
export type LowStockResponse = z.infer<typeof LowStockResponse>;

export const InactiveCustomerRow = z.object({
  customer_id: z.string(),
  code: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  credit_limit: z.number(),
  last_order_at: wireTimestamp.nullable(),
  days_since_last_order: z.number().nullable(),
});
export type InactiveCustomerRow = z.infer<typeof InactiveCustomerRow>;

export const InactiveCustomersResponse = z.object({
  threshold_days: z.number(),
  customers: z.array(InactiveCustomerRow),
});
export type InactiveCustomersResponse = z.infer<typeof InactiveCustomersResponse>;

// Productos en top-N del ERP con stock disponible 0 — venta perdida.
export const RankingOutOfStockRow = z.object({
  posicion: z.number(),
  articulo: z.string(),
  product_id: z.string().nullable(),
  nombre: z.string(),
  total_venta: z.number(),
  total_piezas_totales: z.number(),
  total_qty: z.number(),
  total_reserved: z.number(),
  available: z.number(),
});
export type RankingOutOfStockRow = z.infer<typeof RankingOutOfStockRow>;

// Motor de Inteligencia (Fase M) — conversion del feedback loop.
export const ConversionSummary = z.object({
  window_days: z.number(),
  offers: z.number(),
  converted: z.number(),
  conversion_pct: z.number(),
});
export type ConversionSummary = z.infer<typeof ConversionSummary>;

export const ConversionDailyRow = z.object({
  day: z.string(),
  offers: z.number(),
  converted: z.number(),
  conversion_pct: z.number(),
});
export type ConversionDailyRow = z.infer<typeof ConversionDailyRow>;

// ── el agregado (BFF): los 7 paneles COMMERCIAL_ANALYTICS_VER en 1 respuesta ──
//
// Solo van los paneles que comparten el gate `COMMERCIAL_ANALYTICS_VER`. Los otros
// 4 tienen OTRO permiso y siguen como llamadas aparte (no bypassear el gate por
// panel): net_customers=CUSTOMERS360_VER, conversion/conversion_series/due_count=
// modulo commercial-intelligence. Sus schemas quedan exportados arriba para TS.2.

export const CommandCenterDashboard = z.object({
  overview: NetworkOverview,
  top_products: z.array(NetworkTopProductRow),
  sales_by_brand: z.array(SalesByBrandRow),
  daily_series: z.array(NetworkDailyRow),
  low_stock: LowStockResponse,
  inactive_customers: InactiveCustomersResponse,
  ranking_out_of_stock: z.array(RankingOutOfStockRow),
});
export type CommandCenterDashboard = z.infer<typeof CommandCenterDashboard>;

// ── analytics MV-based (endpoints sueltos: overview / top-customers / top-products / daily-series) ──
// No son parte del agregado del Command Center (que usa las variantes `network/*`),
// pero comparten el boundary de commercial-analytics y su gate COMMERCIAL_ANALYTICS_VER.

// `overview()` (mv/live) conforma este shape: la rama live incluye `refreshed_at: null`
// y ambas ramas fijan `source as const` (fix TS.2 tras el drift que halló el typecheck).
export const OverviewResponse = z.object({
  source: z.enum(['mv', 'live']),
  refreshed_at: z.string().nullable(),
  period: z.unknown(),
  revenue: z.object({ gross: z.number(), net: z.number(), tax: z.number(), currency: z.string() }),
  orders: z.object({
    fulfilled: z.number(),
    confirmed: z.number(),
    draft: z.number(),
    cancelled: z.number(),
    avg_order_value: z.number(),
  }),
  units_sold: z.number().optional(),
  unique_customers: z.number(),
});
export type OverviewResponse = z.infer<typeof OverviewResponse>;

export const TopCustomerRow = z.object({
  source: z.enum(['mv', 'live']),
  customer_id: z.string(),
  code: z.string(),
  name: z.string(),
  orders_count: z.number(),
  revenue: z.number(),
  avg_order_value: z.number(),
  last_order_at: z.string(),
  rank: z.number().optional(),
});
export type TopCustomerRow = z.infer<typeof TopCustomerRow>;

export const TopProductRow = z.object({
  source: z.enum(['mv', 'live']),
  product_id: z.string(),
  product_name: z.string(),
  brand_name: z.string(),
  units_sold: z.number(),
  revenue: z.number(),
  orders_count: z.number(),
  rank_by_units: z.number().optional(),
  rank_by_revenue: z.number().optional(),
});
export type TopProductRow = z.infer<typeof TopProductRow>;

export const DailySeriesRow = z.object({
  day: z.string(),
  orders_count: z.number(),
  unique_customers: z.number(),
  revenue: z.number(),
  net_revenue: z.number(),
});
export type DailySeriesRow = z.infer<typeof DailySeriesRow>;
