/**
 * `[PU.13]` **El estimado de ingresos por día** — `GET finance/budget/income-forecast`.
 *
 * Una fila por día del periodo de la versión vigente, con dos canales (bancos y caja general) y, en
 * cada uno, el ESTIMADO (dato propio, `budget.income_forecast_days`) al lado de lo REAL (leído en el
 * momento de `finance.bank_movements`, categoría `cobranza`; nunca copiado).
 *
 * ⚠️ Las dos ausencias son distintas (ADR-056):
 *  · `estimado: null` → ese día no se estimó (ya tenía dato real cuando se hizo la versión).
 *  · `real: null`     → el estado de cuenta de ese canal todavía no está cargado hasta ese día.
 *    Un `0` en `real` significa «cargado, y no entró nada».
 */

export type IncomeChannel = 'bancos' | 'caja_general';

export interface IncomeForecastCell {
  /** `null` = ese día no se estimó en esta versión. */
  estimado: number | null;
  /** `null` = sin cargar todavía (el canal sólo está cargado hasta `real_hasta`). NUNCA 0 por ausencia. */
  real: number | null;
}

export interface IncomeForecastDay {
  /** `YYYY-MM-DD`. */
  fecha: string;
  /** 1 = lunes … 7 = domingo (ISO). */
  dia_semana: number;
  /** Semana ISO (la de la hoja de Finanzas: «semana 42»). */
  semana: number;
  /** Año ISO de esa semana (la 53 de 2026 termina el 3-ene-2027). */
  semana_anio: number;
  inhabil: boolean;
  bancos: IncomeForecastCell;
  caja_general: IncomeForecastCell;
}

export interface IncomeForecastVersion {
  id: string;
  nombre: string;
  desde: string;
  hasta: string;
  metodo: string;
  parametros: Record<string, unknown>;
  created_at: string;
  created_by: string | null;
}

export interface IncomeForecastResponse {
  /** `null` = no hay ninguna versión vigente; `vacia_porque` dice por qué. */
  version: IncomeForecastVersion | null;
  vacia_porque: string | null;
  /** Último día con movimientos cargados por canal. `null` = el canal no tiene nada cargado. */
  real_hasta: Record<IncomeChannel, string | null>;
  /** Desde el día 1 del mes de `desde` hasta `hasta`: así el mes en curso se ve completo. */
  dias: IncomeForecastDay[];
  /** Qué cuenta como ingreso, dicho una vez para que la pantalla no lo reconstruya. */
  definicion_real: string;
}
