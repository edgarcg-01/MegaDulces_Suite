// [SV.2] El tablero del supervisor de ventas: cómo van SUS rutas.
//
// ── POR QUÉ ESTA FORMA ───────────────────────────────────────────────────────────────────
// Medido contra prod el 2026-10-06, antes de escribir una línea:
//
//  · El supervisor de ventas (5 cuentas / 4 personas) tiene 33 permisos y NINGUNO de analítica
//    de venta: hoy no existe ninguna pantalla que pueda abrir para ver esto.
//  · `commercial.sales_targets` tiene CERO filas. Por eso `meta` nace en `null` y su estado es
//    `sin_meta` — nunca `ok`. Es el `cfg ? classify : 'ok'` que la Fase VP encontró dando verde
//    incondicional, y acá no se repite.
//  · El COSTO por ruta existe en **1 de 430 filas** (`costo_status='sin_dato_en_la_fuente'` en
//    las 4 rutas vecinales). Por eso NO hay campo de margen: publicarlo sería dibujar un cero.
//    Se declara en `margen_motivo` y punto.
//
// El vocabulario del semáforo NO se declara acá: se reusa `KpiEstado`/`clasificarKpi` de
// `kpi-threshold.contract.ts` (CDRP.2). Un sexto vocabulario de estados es justo lo que ADR-056
// existe para impedir.

import { z } from 'zod';
import { Coverage, Freshness } from './provenance.contract';
import type { KpiEstado } from './kpi-threshold.contract';

/**
 * Por qué un supervisor no tiene rutas. **`[]` no alcanza**: "no le toca ninguna" y "nadie le
 * declaró el equipo" se arreglan en lugares distintos y los arregla gente distinta.
 *
 *  · `sin_equipo`       — nadie le reporta. Lo arregla quien administra personas.
 *  · `equipo_sin_ruta`  — tiene gente, y a esa gente no le asignaron ruta. Medido: le pasa a
 *                         `jose_herrera`, que tiene 10 reportes y sólo 3 con ruta.
 */
export const AlcanceMotivo = z.enum(['sin_equipo', 'equipo_sin_ruta']);
export type AlcanceMotivo = z.infer<typeof AlcanceMotivo>;

/** Qué rutas le tocan a quien pregunta, y por qué son ésas. */
export const SupervisorAlcance = z.object({
  /** Cuántas personas le reportan (vivas). */
  reportes: z.number(),
  /** Cuántas de esas personas tienen ruta asignada. */
  reportes_con_ruta: z.number(),
  /**
   * Las rutas, ya como CONJUNTO de códigos. Dos cuentas en la misma ruta son UNA ruta: medido,
   * 3 de las 4 vecinales tienen dos cuentas de vendedor, y sumar por vendedor las duplicaría.
   */
  rutas: z.array(z.string()),
  motivo: AlcanceMotivo.nullable(),
});
export type SupervisorAlcance = z.infer<typeof SupervisorAlcance>;

/** Cómo va UNA ruta en el periodo pedido. */
export interface SupervisorRuta {
  /** El código que habla el ODS ('23', '1V001', '502'). */
  route_code: string;
  /** Cómo se llama en el catálogo de la app; suele traer el nombre del vendedor. */
  etiqueta: string | null;
  /** Días con venta en el periodo. NO es "días hábiles": es lo que de verdad operó. */
  dias_operados: number;
  venta: number;
  tickets: number;
  lineas: number;
  /** `venta / tickets`. `null` con 0 tickets — nunca 0, que se leería como "vende barato". */
  ticket_promedio: number | null;
  /** Meta del MES en curso, de `commercial.sales_targets` (scope route). `null` = sin capturar. */
  meta_mes: number | null;
  /** Venta del mes a la fecha, que es contra lo que la meta mensual se puede comparar. */
  venta_mes: number;
  /** Los 5 estados de CDRP.2. Con `meta_mes` en null es SIEMPRE `sin_meta`. */
  estado: KpiEstado;
  /** Qué falta, en palabras accionables. Nunca "sin datos". */
  estado_motivo: string | null;
  /** `venta_mes / meta_mes`. `null` sin meta o con meta 0. */
  avance: number | null;
  /**
   * ⛔ Siempre `null` hoy. El costo por ruta está en 1 de 430 filas del ODS. Se deja el campo
   * para que el día que exista no haya que cambiar la forma del wire — pero se DECLARA.
   */
  margen_pct: number | null;
  margen_motivo: string | null;
  /** Último día con venta. Si está viejo, la ruta dejó de operar y eso se ve. */
  ultimo_dia: string | null;
}

/** Un punto de la serie día a día. El filtro por semana se arma sobre esto en el cliente. */
export interface SupervisorDia {
  route_code: string;
  business_date: string;
  venta: number;
  tickets: number;
}

/** La respuesta completa del tablero. */
export interface SupervisorTablero {
  periodo: { desde: string; hasta: string; dias: number };
  alcance: SupervisorAlcance;
  rutas: SupervisorRuta[];
  serie: SupervisorDia[];
  freshness: Freshness;
  cobertura: Coverage;
}

export const SupervisorAlcanceSchema = SupervisorAlcance;
export const CoverageSchema = Coverage;
export const FreshnessSchema = Freshness;

/**
 * Ventana máxima que la matview `analytics.mv_rd_route_daily_200d` cubre.
 *
 * ⚠️ Pedir más atrás NO devuelve menos en silencio: el servicio lo recorta y lo dice en
 * `cobertura.note`. Un rango que se achica sin avisar es cómo se publica una caída de venta
 * que en realidad es una caída de cobertura.
 */
export const SUPERVISOR_VENTANA_DIAS = 200;
