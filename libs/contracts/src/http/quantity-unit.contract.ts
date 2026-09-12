/**
 * [VU.0] LA UNIDAD VIAJA CON LA CANTIDAD — la forma, una sola vez (ADR-056 · ADR-057).
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 *
 * Edgar, 2026-09-12: *"¿ya tenemos una verdad absoluta en todo lugar donde se muevan unidades,
 * existencias y ventas?"*. La respuesta medida fue **no**, y el hueco no estaba donde se venía
 * trabajando: los resolvedores (`v_unit_truth`, `v_warehouse_box_factor`, `v_product_box_factor`,
 * `mv_kepler_unit_ladder`) resuelven la unidad **al LEER**. Al **ESCRIBIR** no hay nada.
 *
 * Censo en prod (2026-09-12): **22 tablas con una columna de cantidad y ninguna de unidad al
 * lado**, contra 9 que la declaran. Y la única que la declara de verdad —`analytics.sales_daily`
 * con `rung_factor`/`unit_kind`— es un hecho DERIVADO, no un lugar donde un humano captura.
 *
 * El resultado es que un vendedor, un almacenista o un comprador escriben un número y ese número
 * se guarda **sin decir en qué unidad está**. Después alguien lo lee y le presta una unidad. Eso
 * es exactamente el error que ADR-055 cobró en `replenishment_plan.stock_pz` —donde el NOMBRE de
 * la columna afirma "piezas" y el contenido no está normalizado— por **$866,805 de sobre-pedido**
 * y **$2.68M de inventario invisible**.
 *
 * ── La regla ────────────────────────────────────────────────────────────────────────────────
 *
 * ⭐ **Una cantidad que no dice su unidad no es un dato, es un número.** Toda tabla donde se
 * ESCRIBE una cantidad lleva estos tres campos al lado, y los tres admiten `null` — porque
 * *"no sé en qué unidad estaba"* es una respuesta legítima y **"pieza" no es su sinónimo**.
 *
 * ⛔ **Nunca rellenar con un default.** Una fila histórica sin unidad se queda sin unidad. El día
 * que alguien escriba `'pieza'` sobre las filas viejas "para completar", habrá convertido una
 * ignorancia medible en una afirmación falsa — que es el pecado de ADR-056.
 *
 * ── El vocabulario NO se inventa ─────────────────────────────────────────────────────────────
 *
 * `qty_unit` reusa los rótulos que el ERP ya usa y que `analytics.v_unit_truth.base_label`
 * publica (`PZA`, `PAQ`, `CJA`, `KG`…), no una enumeración paralela. `qty_factor_source` reusa los
 * veredictos de `analytics.v_product_box_factor.source`. Un vocabulario paralelo es un segundo
 * resolvedor disfrazado, y esa es la falla que esta fase persigue.
 */

/**
 * Rótulo de la unidad EN LA QUE SE CAPTURÓ la cantidad, tal como lo nombra el ERP.
 *
 * ⚠️ Es texto libre a propósito, no un enum cerrado: medido en prod, `v_unit_truth.base_label`
 * trae **12 rótulos distintos** y entre ellos hay GRAMAJES (`500`, `250`, `400`) que Kepler guarda
 * donde debería ir una unidad. Un enum obligaría a mapearlos a algo, y mapear un gramaje a una
 * unidad es inventarla. Se guarda lo que dice la fuente y el consumidor decide si lo entiende.
 */
export type QtyUnitLabel = string;

/** De dónde salió el factor con que se convirtió. Mismos valores que `v_product_box_factor.source`. */
export type QtyFactorSource =
  /** El humano capturó directo en la unidad almacenada: no hubo conversión (factor 1 afirmado). */
  | 'captura_directa'
  /** `commercial.product_unit_overrides` — edición manual. ⚠️ Es la fuente que el ERP contradice
   *  146× más seguido que la etiquetera (2.92% contra 0.02%, ADR-057/KX.4). */
  | 'override'
  /** Un override de `1` que NO tapó al ERP porque el ERP declara más (guard de KX.4). */
  | 'override_no_dato'
  /** `kdii.c84` vía `analytics.product_box_factor`. */
  | 'kepler_c84'
  /** `commercial.product_label_prices.box_size` (la etiquetera). */
  | 'etiquetera'
  /** `catalog.products.factor_sale`. */
  | 'factor_sale'
  /** La guarda anti-pallet: `c84` era ≥ 3× el empaque interno y se usó el interno. */
  | 'inner_box_guard'
  /** ⛔ NO hay factor: el `1` es un respaldo, no una afirmación. Se distingue de `captura_directa`. */
  | 'default';

/**
 * Los tres campos que acompañan a toda cantidad ESCRITA.
 *
 * Se cumple la identidad `quantity = qty_captured × qty_factor` cuando los tres están presentes;
 * cuando `qty_factor` es `null` la cantidad está en `qty_unit` sin conversión, y cuando `qty_unit`
 * es `null` **no se sabe** y ningún consumidor puede suponerlo.
 */
export interface QuantityUnitStamp {
  /** En qué unidad lo escribió quien lo escribió. `null` = no se registró (histórico o fuente muda). */
  qty_unit: QtyUnitLabel | null;
  /** El factor aplicado para llegar a `quantity`. `null` = no hubo conversión, o no se sabe cuál. */
  qty_factor: number | null;
  /** Con qué autoridad se aplicó ese factor. `null` = no se registró. */
  qty_factor_source: QtyFactorSource | null;
}

/** Las tres columnas, con el nombre exacto que llevan en la base. Un solo lugar donde cambiarlas. */
export const QTY_UNIT_COLUMNS = ['qty_unit', 'qty_factor', 'qty_factor_source'] as const;

/**
 * ⭐ La pregunta que un consumidor debe poder hacer antes de sumar o comparar.
 *
 * Devuelve `false` cuando la unidad no está registrada — y entonces la cifra **se declara**, no se
 * suma con las demás. Es el mismo criterio que el sell-out aplica por celda: el 70% del dinero
 * vive en renglones que mezclan dos unidades, y ahí el total no existe.
 */
export function tieneUnidadDeclarada(q: Partial<QuantityUnitStamp> | null | undefined): boolean {
  return !!q && typeof q.qty_unit === 'string' && q.qty_unit.trim().length > 0;
}
