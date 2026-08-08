import { VgMetric, VgDimension } from '../ventas-generales.service';

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
  /** ancho en la grilla de 12 columnas (default 12). */
  span?: number;
}

export interface DashboardSpec {
  title?: string;
  /** Explicación en llano del tablero (VG.2 — la escribe Thot al componer). */
  narrative?: string;
  blocks: SalesBlock[];
}
