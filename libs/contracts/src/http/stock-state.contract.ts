/**
 * `[MCP.3.16]` El ESTADO de la existencia de un producto en una sucursal, para la toma de pedido del
 * vendedor. Regla decidida por David con su PM (2026-10-27):
 *
 *   · sin medición (la lectura de esa sucursal está vieja o falló)  → `sin_dato`       (gris)
 *   · medida y sin registro de existencia en esa sucursal           → `no_se_maneja`   (0 gris, va al final)
 *   · medida, con registro y cantidad <= 0                          → `agotado`        (rojo)
 *   · medida, con registro y cantidad > 0                           → `con_existencia`
 *
 * ⚠️ Desde ADR-115 (anexo A de la fase DN, 2026-11-07) NINGÚN estado bloquea agregar: el vendedor
 * captura lo que el cliente pide y lo que no hay se registra para Compras (`order_stock_notices`).
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

/**
 * `[DN.7]` La lectura al día AFIRMA que en esa sucursal no hay: `agotado` o `no_se_maneja`.
 * `sin_dato` y `con_existencia` no.
 *
 * Hasta ADR-115 esto se llamaba `bloqueaAgregar` y frenaba el renglón en el teléfono. Ya no bloquea
 * nada: el vendedor captura lo que el cliente pide y el servidor lo registra para Compras. Lo siguen
 * usando el pedido SUGERIDO (lo predijo el sistema, no lo pidió el cliente: no propone lo que no hay,
 * DA4) y la pintura de la fila.
 */
export function sinExistenciaAfirmada(s: StockState | null | undefined): boolean {
  return s === 'agotado' || s === 'no_se_maneja';
}

/**
 * `[DN.7]` EL texto del estado de un renglón sin existencia, el MISMO en el servidor y en la pantalla.
 *
 * ⚠️ Ya no dice «No se puede agregar» (ADR-115): el renglón SE GUARDA, y decir lo contrario sería
 * afirmar lo que no es. Tampoco dice «no hay» a secas: el «agotado» de Kepler no es testigo fiable
 * (medido 2026-11-07: el 29.4 % de los saldos ≤ 0 son negativos y del 5.9 al 7.6 % de lo que estaba en
 * 0 al cierre se vendió al día siguiente). Por eso «puede estar agotado».
 *  · con alternativas: «Puede estar agotado en PH · LPA tiene 14»;
 *  · si TODA la zona se midió al día y nadie tiene: «Puede estar agotado en PH · tampoco hay en tu zona»;
 *  · si no se puede afirmar lo de la zona (no se resolvió, o alguna sucursal está sin dato), sólo lo
 *    que sí se sabe y qué sucursales quedaron sin dato: «Puede estar agotado en PH · sin dato de YU».
 *  · `no_se_maneja` empieza con «PH no lo maneja».
 * `texto` de cada alternativa lo pone quien llama: la pantalla en la unidad que se pide («14 CJA»);
 * el servidor sólo conoce la unidad BASE y la escribe sin rótulo.
 */
export function mensajeExistencia(o: {
  state: 'agotado' | 'no_se_maneja';
  surtido: string;
  alternativas: ReadonlyArray<{ short: string; texto: string }>;
  zonaCompleta: boolean;
  sinDato: readonly string[];
}): string {
  const base = o.state === 'no_se_maneja' ? `${o.surtido} no lo maneja` : `Puede estar agotado en ${o.surtido}`;
  if (o.alternativas.length) return `${base} · ${o.alternativas.map((a) => `${a.short} tiene ${a.texto}`).join(' · ')}`;
  if (o.zonaCompleta) return `${base} · tampoco hay en tu zona`;
  return `${base}${o.sinDato.length ? ' · sin dato de ' + o.sinDato.join(', ') : ''}`;
}

/**
 * `[DN.7]` (ADR-115) Lo que el servidor sabe de la existencia de un renglón al GUARDARLO. Ya no hay
 * 409: el renglón se guarda siempre y esto viaja en la respuesta de `POST commercial/orders/:id/lines`
 * y `PATCH …/lines/:line_id` como `stock_review` (y `stock_state`). Sólo se calcula para la app del
 * vendedor (la clave `VENDOR_APP_ACCESS`) cuando AGREGA en una sucursal; si no, viajan en `null`.
 */
export interface LineStockReview {
  state: StockState;
  /** Existencia en unidad BASE en la sucursal de surtido; `null` = sin registro o sin dato. */
  qty: number | null;
  /** Hay existencia, pero menos que la cantidad del renglón (las dos en unidad BASE). */
  insuficiente: boolean;
  product_id: string;
  product_name: string;
  warehouse_id: string;
  /** PH, LPA… (`short_label`; si no hay, `name`). */
  warehouse_short: string;
  /** ISO de la lectura de esa sucursal (`ods_branch_checks.last_check_at`); `null` = nunca se revisó. */
  checked_at: string | null;
  /** Otras sucursales de la zona con existencia > 0 (lectura al día), mayor primero, máx 3. Unidad BASE. Sólo si no hay. */
  alternatives: Array<{ warehouse_id: string; short: string; qty: number }>;
  /** El texto para el vendedor (`mensajeExistencia`, o por qué no hay dato); `null` con existencia. */
  message: string | null;
}

/** `[DN.6]` Estado de una fila de `commercial.order_stock_notices`: `pendiente` = marca de `place()` sin completar. */
export type StockNoticeState = StockState | 'pendiente';

/**
 * `[DN.6]` Qué se decidió sobre un renglón sin existencia. `sin_aviso` = lo registró el servidor sin que
 * nadie viera un aviso (frente 1 del anexo A); las demás llegan con la hoja del vendedor y el surtidor.
 */
export type StockNoticeDecision =
  | 'dejar'
  | 'condicional'
  | 'cambiar_ya'
  | 'otra_sucursal'
  | 'quitar'
  | 'sin_aviso'
  | 'condicional_no_aplicable';

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
