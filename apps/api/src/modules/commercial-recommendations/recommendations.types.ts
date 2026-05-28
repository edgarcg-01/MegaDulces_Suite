/**
 * Tipos para canasta estratégica (D.4).
 *
 * Las 4 categorías reflejan el ciclo comercial estándar de portafolio:
 *   - base        → ventas recurrentes que sostienen revenue.
 *   - focus       → productos donde HAY palanca: vende mucho a otros, este customer no.
 *   - exploración → cross-sell dentro de marcas ya validadas por el customer.
 *   - innovación  → empuje de nuevos SKUs sin historial todavía.
 */

export type RecommendationCategory = 'base' | 'focus' | 'exploration' | 'innovation';

export interface RecommendationItem {
  product_id: string;
  product_name: string;
  brand_name: string | null;
  category: RecommendationCategory;
  score: number;          // 0..1 — mayor = más fuerte la recomendación
  reason: string;         // texto humano-legible explicando por qué
  sample_price: number;   // precio que vería el cliente (BASE-MXN o lista del customer)
  units_in_last_period?: number; // métrica de soporte para debugging
}

export interface RecommendedBasket {
  customer_id: string;
  computed_at: string;
  total_recommendations: number;
  category_counts: Record<RecommendationCategory, number>;
  items: RecommendationItem[];
}

/** Configuración de la heurística — futuro: por-tenant. */
export const RECOMMENDATION_LIMITS = {
  BASE: 5,           // top 5 productos suyos
  FOCUS: 5,          // top 5 del tenant que no compra
  EXPLORATION: 5,    // hasta 5 productos de sus brands sin probar
  INNOVATION: 3,     // hasta 3 productos nuevos del mes
  CUSTOMER_HISTORY_DAYS: 90,  // ventana para calcular "base"
  TENANT_TOP_DAYS: 30,        // ventana para "focus"
  INNOVATION_DAYS: 30,        // productos creados en últimos N días
} as const;
