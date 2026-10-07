import { VgMetric, VgDimension } from '../ventas-generales.service';

/** Filtros de alcance (WHERE) que recortan el universo antes de agrupar por la dimensión. */
export interface VgFilters {
  channel?: string | null;
  warehouse_id?: string | null;
  brand_id?: string | null;
  category_id?: string | null;
  /** Alcance por TEXTO que emite Thot (VG.2): SKU exacto, o nombre de marca/categoría. */
  sku?: string | null;
  brand?: string | null;
  category?: string | null;
}

/**
 * Fase VG — contrato `spec` del tablero generativo. Es el ÚNICO artefacto que el agente
 * (Thot, VG.2) va a emitir: describe QUÉ bloques y a qué (métrica × dimensión × rango) se
 * bindea cada uno. Los datos los pone el renderer llamando a endpoints deterministas — el
 * spec NO lleva cifras. Hoy (VG.0/1) lo produce el constructor y los presets; mañana, Thot.
 */
export type SalesBlockType = 'kpi' | 'breakdown' | 'series';
export type BreakdownViz = 'bars-table' | 'bars' | 'table';

export interface SalesBlock {
  type: SalesBlockType;
  title?: string;
  /** breakdown/series */
  metric?: VgMetric;
  /** breakdown */
  dimension?: VgDimension;
  limit?: number;
  viz?: BreakdownViz;
  /** series */
  range?: '30d' | '90d' | '12m';
  /** rango explícito (VG.1) — si viene, manda sobre `range` y usa el endpoint semántico. */
  from?: string;
  to?: string;
  /** filtros de alcance (VG.1) — si hay alguno, el bloque usa el endpoint semántico. */
  filters?: VgFilters;
  /** ancho en la grilla de 12 columnas (default 12). */
  span?: number;
}

export interface DashboardSpec {
  title?: string;
  /** Explicación en llano del tablero (VG.2 — la escribe Thot al componer). */
  narrative?: string;
  blocks: SalesBlock[];
}
