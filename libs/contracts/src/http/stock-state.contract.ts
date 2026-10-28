/**
 * `[MCP.3.16]` El ESTADO de la existencia de un producto en una sucursal, para la toma de pedido del
 * vendedor. Regla decidida por David con su PM (2026-10-27):
 *
 *   · sin medición (la lectura de esa sucursal está vieja o falló)  → `sin_dato`       (gris, NO bloquea)
 *   · medida y sin registro de existencia en esa sucursal           → `no_se_maneja`   (0 gris, va al final)
 *   · medida, con registro y cantidad <= 0                          → `agotado`        (rojo, bloquea)
 *   · medida, con registro y cantidad > 0                           → `con_existencia`
 *
 * El orden de las preguntas importa: «no lo maneja» y «agotado» son afirmaciones, y sólo se pueden
 * hacer con una lectura al día (ADR-056: lo que no se midió se declara, nunca se dibuja como 0).
 *
 * La fuente es `analytics.v_erp_stock_on_hand` (ADR-055) y la frescura es el carril `ods_live_hot`
 * de `analytics.ods_branch_checks`; el resolvedor vive en
 * `libs/commercial/src/lib/commercial-inventory/stock-state.ts`. Esto es sólo la regla pura y la
 * forma de lo que viaja, compartida por el servidor y la app.
 */

export type StockState = 'con_existencia' | 'agotado' | 'no_se_maneja' | 'sin_dato';

/**
 * Horas que puede tener la última revisión del carril `ods_live_hot` de una sucursal para tomar su
 * existencia como al día. La MISMA tolerancia con la que `store.service.ts` y
 * `route-promo.service.ts` juzgan este carril (envía cada minuto: 6 h queda lejos de un hipo y cerca
 * de «algo se rompió anoche»).
 */
export const ODS_HOT_TOLERANCIA_H = 6;

/** Pura. Sin medición -> sin_dato; sin registro -> no_se_maneja; <= 0 -> agotado; si no, con_existencia. */
export function estadoDeExistencia(i: { medido: boolean; conRegistro: boolean; qty: number | null }): StockState {
  if (!i.medido) return 'sin_dato';
  if (!i.conRegistro) return 'no_se_maneja';
  const q = i.qty == null ? NaN : Number(i.qty);
  // Un registro sin cantidad legible no autoriza ni «agotado» ni «hay»: se declara.
  if (!Number.isFinite(q)) return 'sin_dato';
  return q <= 0 ? 'agotado' : 'con_existencia';
}

/** agotado y no_se_maneja bloquean agregar; sin_dato y con_existencia no. */
export function bloqueaAgregar(s: StockState | null | undefined): boolean {
  return s === 'agotado' || s === 'no_se_maneja';
}

/**
 * `[MCP.3.16]` EL texto del bloqueo al agregar, el MISMO en el servidor (409) y en la pantalla.
 * Antes había dos funciones que no coincidían y la del servidor decía «no hay en tu zona» sin
 * haber medido la zona entera (ADR-056):
 *  · con alternativas: «No se puede agregar: no hay existencias en PH · LPA tiene 14»;
 *  · si TODA la zona se midió al día y nadie tiene: «No se puede agregar un producto que no hay en tu zona»;
 *  · si no se puede afirmar lo de la zona (no se resolvió, o alguna sucursal está sin dato), sólo lo
 *    que sí se sabe y qué sucursales quedaron sin dato: «… no hay existencias en PH · sin dato de YU».
 * `texto` de cada alternativa lo pone quien llama: la pantalla en la unidad que se pide («14 CJA»);
 * el servidor sólo conoce la unidad BASE y la escribe sin rótulo.
 */
export function mensajeSinExistencia(o: {
  surtido: string;
  alternativas: ReadonlyArray<{ short: string; texto: string }>;
  zonaCompleta: boolean;
  sinDato: readonly string[];
}): string {
  if (o.alternativas.length) {
    return `No se puede agregar: no hay existencias en ${o.surtido} · ${o.alternativas.map((a) => `${a.short} tiene ${a.texto}`).join(' · ')}`;
  }
  if (o.zonaCompleta) return 'No se puede agregar un producto que no hay en tu zona';
  return `No se puede agregar: no hay existencias en ${o.surtido}${o.sinDato.length ? ' · sin dato de ' + o.sinDato.join(', ') : ''}`;
}

/** Cuerpo del 409 que devuelve el servidor al bloquear. */
export interface StockBlockError {
  code: 'SIN_EXISTENCIA';
  /**
   * El texto que se le muestra al vendedor (`mensajeSinExistencia`; nunca el uuid). El nombre del
   * producto viaja aparte en `product_name`. Las cantidades van en unidad BASE: la pantalla, que sabe
   * la unidad que se pide, lo vuelve a armar desde `alternatives`.
   */
  message: string;
  product_id: string;
  product_name: string;
  warehouse_id: string;
  /** PH, LPA… (`short_label`; si no hay, `name`). */
  warehouse_short: string;
  state: 'agotado' | 'no_se_maneja';
  /** Otras sucursales de la zona con existencia > 0 (lectura al día), mayor primero, máx 3. Unidad BASE. */
  alternatives: Array<{ warehouse_id: string; short: string; qty: number }>;
}

/**
 * Lo que el catálogo (`GET commercial/price-lists/:id/prices?warehouse_id=X&stock_state=1`) agrega a
 * cada renglón. Sin `stock_state=1` el catálogo no cambia (lo leen también el portal y `view`).
 *
 * Con `stock_state=1`, `stock_available` sale de la vista canónica (con el gemelo del legado) en
 * unidad BASE; es `null` cuando no hay registro o cuando la lectura de la sucursal no está al día
 * (`sin_dato`): un número viejo no se pinta como si fuera de hoy.
 */
export interface CatalogStockStateFields {
  stock_state: StockState | null;
  /** ISO de `analytics.ods_branch_checks.last_check_at` de esa sucursal; `null` = nunca se revisó. */
  stock_checked_at: string | null;
  /** El producto vivo cuya existencia se usó, cuando el renglón es un DUPLICADO legado (`sku` NULL). */
  stock_twin_product_id: string | null;
}
