/**
 * WMS-BI.1 — Análisis BI de Almacén: tipos compartidos service↔controller.
 *
 * Ver el cabezal de `commercial-bi-almacen.service.ts` para las decisiones de fondo
 * (por qué el costo se declara en vez de aproximarse, por qué el alcance viene de
 * `ScopeService` y no de un mecanismo nuevo, qué columnas del pedido original NO
 * existen todavía en el dato real).
 */

export interface BiWarehouseOpt {
  id: string;
  code: string;
  name: string;
  zone_id: string | null;
  zone_name: string | null;
  /** Sólo las sucursales Kepler (01-06) alimentan el Diario de Movimientos hoy. */
  has_movements_feed: boolean;
}

export interface BiZoneGroup {
  zone_id: string | null;
  zone_name: string; // '(sin zona)' cuando zone_id es null
  warehouses: BiWarehouseOpt[];
}

export interface BiDocType {
  doc_code: string;
  movement_label: string;
  movement_kind: 'entrada' | 'salida' | 'info';
}

export interface BiFiltersResponse {
  zones: BiZoneGroup[];
  doc_types: BiDocType[];
  /** Alcance de sucursales del usuario en sesión (ADR-050). */
  scope: { mode: string; resolvable: boolean; warehouse_count: number | null };
  /** Frescura REAL del feed de movimientos (Kepler). null = nunca importado en este entorno. */
  movements_as_of: { max_doc_date: string | null; max_imported_at: string | null; total_rows: number };
  /** La existencia/costo son vistas EN VIVO sobre el ODS: no tienen "última corrida", se sirven al momento. */
  inventory_as_of: string;
}

export interface BiProductOpt {
  id: string;
  sku: string | null;
  name: string;
  brand_name: string | null;
}

export interface BiInventoryValuation {
  as_of: string;
  /** false = `analytics.v_erp_unit_cost` no existe en este entorno: no se aproxima con cost_base solo. */
  erp_cost_available: boolean;
  unavailable_reason: string | null;
  sku_en_scope: number | null;
  valor_catalogo: number | null;
  valor_erp_verificado: number | null;
  /** Mismo subconjunto (con testigo) que valor_erp_verificado, a costo de catálogo — para que la diferencia compare lo mismo. */
  valor_catalogo_mismo_subset: number | null;
  diferencia: number | null;
  cobertura_testigo_pct: number | null;
}

export interface BiMovementCounts {
  /** Cubre SÓLO sucursales Kepler (01-06): Morelia/CEDIS no tienen este feed todavía. */
  covers_all_scope: boolean;
  entradas_lineas: number;
  salidas_lineas: number;
  productos_con_movimiento: number;
  daily_series: Array<{ date: string; entradas: number; salidas: number }>;
  top_salida_valor: Array<{ sku: string | null; product_name: string; valor: number }>;
}

export interface BiCostDeviationRow {
  warehouse_code: string;
  sku: string | null;
  product_name: string;
  costo_catalogo: number | null;
  costo_erp: number | null;
  diferencia: number | null;
  diferencia_pct: number | null;
}

export interface BiCostDeviation {
  available: boolean;
  unavailable_reason: string | null;
  rows: BiCostDeviationRow[];
}

export interface BiSummaryResponse {
  from: string;
  to: string;
  inventory: BiInventoryValuation;
  movements: BiMovementCounts;
  cost_deviation: BiCostDeviation;
}

export interface BiMovementRow {
  doc_date: string;
  /** `null` cuando el enriquecimiento contra kepler_ods se saltó por timeout — ver `hora_no_disponible`. */
  hora: string | null;
  zone_name: string | null;
  /** Antes "Almacén" — es la SUCURSAL (una fila de commercial.warehouses = una sucursal). */
  warehouse_code: string;
  warehouse_name: string;
  /**
   * Sub-almacén dentro de la sucursal (disponible/dañado/caduco). Decisión del negocio
   * (2026-09-15): el feed de ajustes hoy es genérico (InvIn1/InvOut1, sin motivo capturado en
   * Kepler) — se declara SIEMPRE 'Disponible' hasta que el ERP capture el motivo real. No es
   * una clasificación inventada por línea; es el único valor que el dato de hoy sostiene.
   */
  almacen: 'Disponible';
  movement_kind: 'entrada' | 'salida' | 'info';
  /** Antes "Motivo" — nombre de negocio del documento (Venta/Compra/Traspaso/Devolución/Ajuste…). */
  movement_label: string;
  doc_code: string;
  folio: string;
  sku: string | null;
  product_name: string;
  /** kdii.c3 → kdig (verificado 87.6% de match). Nombre real: fabricante/distribuidor. */
  linea_producto: string | null;
  /** kdii.c4 → kdie (verificado 100% de match). El "canasto": DULCES/BOTANAS/ABARROTES/… */
  tipo_producto: string | null;
  /** kdii.c5 → kdif (verificado 99.5% de match). Sub-categoría dentro del tipo. */
  grupo_producto: string | null;
  qty: number;
  signed_qty: number;
  /** kdm2.c11 — unidad en la que se capturó ESTA línea (PZA/PAQ/CJA/KG/…). */
  unidad_operacion: string | null;
  /** analytics.v_unit_truth.base_label — la unidad base del producto en ESE almacén. */
  unidad_base: string | null;
  /**
   * Cantidad convertida a unidad base. `null` cuando la conversión no se pudo verificar
   * (no se dibuja una cantidad inventada) — ver `unidad_base_medible`.
   */
  cantidad_base: number | null;
  unidad_base_medible: boolean;
  unit_cost: number | null;
  amount: number | null;
  /** Importe a COSTO de esta línea (compras/ajustes/traspasos). `null` en líneas de venta. */
  importe_costo: number | null;
  /** Importe de VENTA de esta línea (ventas/remisiones). `null` en líneas de costo. */
  importe_venta: number | null;
  /** Derivado de catalog.products.iva_rate × importe_venta. `null` sin tasa o sin venta. */
  iva_valor: number | null;
  /** Derivado de catalog.products.ieps_rate × importe_venta. `null` sin tasa o sin venta. */
  ieps_valor: number | null;
  /** importe_venta − iva_valor − ieps_valor, asumiendo importe_venta CON impuesto incluido.
   * ⚠️ Supuesto NO verificado contra un ticket real — declarado, no confirmado. */
  venta_neta: number | null;
  cost_base_hoy: number | null;
  source_system: 'kepler';
}

export interface BiPage<T> {
  page: number;
  pageSize: number;
  total: number;
  rows: T[];
}

export interface BiField {
  key: string;
  label: string;
  group: string;
  available: boolean;
  /** Por qué está deshabilitado: falta de dato en el feed, o falta de permiso. */
  reason?: string;
}

export interface BiMovementDetail {
  header: Record<string, unknown> | null;
  lines: Array<Record<string, unknown>>;
  totals: { qty: number; amount: number; lineas: number };
  counterpart: Record<string, unknown> | null;
  /** true = el destino era un cliente/tienda y se ocultó por falta de permiso. */
  dest_redacted: boolean;
}
