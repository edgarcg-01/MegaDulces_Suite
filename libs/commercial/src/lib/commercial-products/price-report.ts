import { BadRequestException } from '@nestjs/common';

/**
 * `[CAT.7]` Las dos decisiones del **reporte de precios por proveedor** que no son SQL.
 *
 * Viven acá, fuera del servicio, por una razón medida en este repo: lo que se puede probar sin
 * Postgres se prueba sin Postgres, y lo que toca Postgres se prueba con una consulta real
 * (ADR-044). Adentro del servicio estas dos decisiones sólo se podían ejercitar con una base
 * levantada, así que en la práctica no se ejercitaban.
 *
 * Las dos deciden algo que la hoja impresa después AFIRMA:
 *  1. `resolvePriceReportParams` — de qué fuente sale el precio (una plaza, o la forma
 *     consolidada), que es lo que hace que un número sea o no el que cobra ese mostrador.
 *  2. `buildPriceReportMeta` — los huecos: cuántos renglones se quedaron sin precio, si la lista
 *     se cortó, y de cuándo son los precios. Un recorte mudo se lee como «el proveedor no tiene
 *     más», y una fecha ausente se lee como «hoy».
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Plaza Kepler: dos dígitos (`00` CEDIS … `06`). Cualquier otra cosa NO es una plaza. */
const SUCURSAL_REGEX = /^[0-9]{2}$/;

/** Tope duro de renglones. 8,700 SKUs × 7 plazas es una hoja que nadie imprime. */
export const PRICE_REPORT_LIMIT_DEFAULT = 3000;
export const PRICE_REPORT_LIMIT_MAX = 5000;

/** La fila de precio POR PLAZA. Se lee filtrada por `sucursal`. */
export const FUENTE_POR_SUCURSAL = 'commercial.product_label_prices';
/**
 * La forma CONSOLIDADA (1 fila por producto). ⚠️ No es un promedio: es la fila de la plaza que
 * representa a la red (`[NORM.3]`). Por eso el reporte lo declara en vez de callarlo.
 */
export const FUENTE_CONSOLIDADA = 'commercial.v_product_label_prices';

/**
 * Las columnas que el reporte lee de la fuente de precio, en UN solo lugar.
 *
 * ⚠️ Existe como constante —y no escrita a mano dentro del `select()`— porque una columna que no
 * existe en la vista **compila perfecto y revienta en runtime**: es un modo de falla ya vivido en
 * este repo (`erp_sales_invoices.warehouse_name`). El smoke las contrasta contra
 * `information_schema` en las DOS fuentes, así que agregar una que no esté se pone rojo antes de
 * llegar a la pantalla.
 */
export const PRICE_REPORT_LABEL_COLUMNS = [
  'sucursal',
  'unit_base',
  'content',
  'barcode',
  'sold_by_kg',
  'piece_price',
  'wholesale_piece_min_qty',
  'wholesale_piece_price',
  'pack_size',
  'pack_price',
  'wholesale_pack_min_qty',
  'wholesale_pack_price',
  'box_size',
  'box_price',
  'computed_at',
] as const;

/** `[CAT.7]` Filtros del reporte de precios imprimible. */
export interface PriceReportQuery {
  /** Proveedores a incluir. Vacío = todo el catálogo (con el tope de `limit`). */
  supplier_ids?: string[];
  /** Plaza Kepler de 2 dígitos. Sin ella, la forma consolidada. */
  sucursal?: string;
  search?: string;
  /** Por default sólo activos: un reporte que lista bajas manda a pedir lo que ya no se vende. */
  only_active?: boolean;
  only_with_price?: boolean;
  limit?: number;
}

export interface PriceReportParams {
  supplierIds: string[];
  sucursal: string | null;
  /** Tabla o vista de la que sale el precio. Se deriva de `sucursal`, nunca se recibe de afuera. */
  fuente: string;
  search: string;
  onlyActive: boolean;
  onlyWithPrice: boolean;
  limit: number;
}

/** Una fila del reporte, en lo que a `meta` le importa. */
export interface PriceReportRowLike {
  piece_price?: string | number | null;
  computed_at?: string | Date | null;
}

export interface PriceReportMeta {
  total: number;
  mostrados: number;
  truncado: boolean;
  limite: number;
  sucursal: string | null;
  sucursal_nombre: string | null;
  consolidado: boolean;
  sin_precio: number;
  precios_al: string | null;
}

/**
 * Normaliza los filtros que llegan por query string y elige la fuente del precio.
 *
 * ⚠️ Un `supplier_ids` que viene con algo y NO deja ningún UUID válido es un **error**, no «todos
 * los proveedores»: el pedido era acotado y devolver el catálogo entero sería contestar otra
 * pregunta. Es el mismo criterio que `list()` ya aplica con `brand_ids` inválidos.
 */
export function resolvePriceReportParams(query: PriceReportQuery = {}): PriceReportParams {
  const pedidos = query.supplier_ids || [];
  const supplierIds = pedidos.filter((id) => UUID_REGEX.test(String(id || '').trim()));
  if (pedidos.length && !supplierIds.length) {
    throw new BadRequestException('supplier_ids inválido');
  }

  const suc = String(query.sucursal ?? '').trim();
  const sucursal = SUCURSAL_REGEX.test(suc) ? suc : null;

  const pedido = Number(query.limit);
  const limit = Number.isFinite(pedido) && pedido > 0
    ? Math.min(Math.trunc(pedido), PRICE_REPORT_LIMIT_MAX)
    : PRICE_REPORT_LIMIT_DEFAULT;

  return {
    supplierIds,
    sucursal,
    fuente: sucursal ? FUENTE_POR_SUCURSAL : FUENTE_CONSOLIDADA,
    search: (query.search || '').trim(),
    // `false` explícito incluye las bajas; cualquier otra cosa (incluido no mandar nada) = sólo activos.
    onlyActive: query.only_active !== false,
    onlyWithPrice: query.only_with_price === true,
    limit,
  };
}

/**
 * Los huecos de la hoja, declarados.
 *
 * `precios_al` es `null` cuando NINGUNA fila trae `computed_at` — y `null` significa «no se pudo
 * medir», no «recién actualizado». La pantalla lo dice con esas palabras.
 */
export function buildPriceReportMeta(
  rows: PriceReportRowLike[],
  total: number,
  params: Pick<PriceReportParams, 'limit' | 'sucursal'>,
  sucursalNombre: string | null,
): PriceReportMeta {
  const totalNum = Number(total) || 0;
  let preciosAl: string | null = null;
  let sinPrecio = 0;

  for (const r of rows) {
    if (r.piece_price === null || r.piece_price === undefined) sinPrecio++;
    const iso = r.computed_at instanceof Date ? r.computed_at.toISOString() : r.computed_at;
    if (iso && (!preciosAl || iso > preciosAl)) preciosAl = iso;
  }

  return {
    total: totalNum,
    mostrados: rows.length,
    truncado: totalNum > rows.length,
    limite: params.limit,
    sucursal: params.sucursal,
    sucursal_nombre: sucursalNombre,
    consolidado: !params.sucursal,
    sin_precio: sinPrecio,
    precios_al: preciosAl,
  };
}
