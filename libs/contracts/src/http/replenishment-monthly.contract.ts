/**
 * `[RA-PRO.65]` La película de venta por mes de un SKU: lo que abre el globo de "V30d / Máx" en el
 * desglose de `/compras/pedido`.
 *
 * **La venta en DINERO siempre se mide; las CAJAS no siempre.** El dinero es el árbitro
 * (ADR-059) y es la misma base con que el motor calcula su estacionalidad; las cajas salen de
 * `units × rung_factor / (suf × bf)` y sólo donde el peldaño está medido y sin mezcla (ADR-057).
 * Lo que no se puede medir se DECLARA (`cajas: null`, `cajas_parcial`), nunca se dibuja como 0.
 *
 * ⚠️ **El divisor es `suf × bf`, el mismo de la columna "V30d"** — no sólo `bf`. `suf`
 * (RA-PRO.28) son las sub-unidades de demanda por unidad de stock: 1 en el catálogo normal, >1 en
 * granel. Medido en prod el 2026-10-02: con `suf` el globo y la columna coinciden (razón mediana
 * 0.99 sobre 18,895 celdas); sin él, los 15 SKUs de granel salían 14.02× más grandes.
 */

/** Por qué no se pudo medir la ventana del año anterior. `null` = sí se midió. */
export type MonthlyLyMotivo = 'sin_venta_ano_anterior' | 'peldano_no_medido';

/** Un mes de la película. `cajas: null` = ese mes no tiene ningún renglón con peldaño medido. */
export interface MonthlySalesMonth {
  mes: string;
  venta: number;
  cajas: number | null;
  cajas_parcial: boolean;
}

/** Las dos ventanas que alimentan el prorrateo de referencia del comprador. */
export interface MonthlySalesWindow {
  v30_cajas: number;
  v30_parcial: boolean;
  /** Próximos 30 días del año anterior. `null` = no medible (ver `ly_motivo`). */
  ly_next30_cajas: number | null;
  ly_motivo: MonthlyLyMotivo | null;
  /** 0.6 × V30 + 0.4 × LY próximos 30 — la regla del sistema anterior. REFERENCIA, no pedido. */
  prorrateo_60_40: number | null;
}

export interface MonthlySalesResponse {
  product: { sku: string; nombre: string } | null;
  /** `null` = toda la red. */
  warehouse: string | null;
  /** El divisor que se usó para pasar de piezas base a cajas (`suf × bf`). */
  bf: number | null;
  months: MonthlySalesMonth[];
  window: MonthlySalesWindow | null;
}
