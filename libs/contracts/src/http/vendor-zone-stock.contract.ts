/**
 * `[MCP.3.12]` Existencias de las sucursales de la ZONA del vendedor, para la toma de pedido.
 *
 * Pedido de David (2026-10-23): «nos dieron permiso de vender de otras sucursales». En cada
 * producto el vendedor ve, en chico, cuánto hay en cada sucursal de su zona. Esta parte SÓLO
 * muestra; elegir de qué sucursal se surte un renglón es la parte 2.
 *
 * La zona es `commercial.warehouses.purchase_zone` (La Piedad = PH, LPA, 8ES, YU · Zamora = DAMASO,
 * CAN · Morelia = MM, MA). El CEDIS queda fuera: su zona es «Corporativo» y David pidió no
 * contarlo. Si un día la zona de VENTA dejara de coincidir con la de compras, esto pide su propio
 * dato — hoy es la misma agrupación (verificado en prod el 2026-10-23).
 *
 * Lo que no se pudo medir se DECLARA: sin sucursal asignada, sin zona o con la consulta caída,
 * `warehouses` viene vacío con su `unmeasured_reason`, nunca como existencias en cero.
 */

export interface ZoneWarehouse {
  id: string;
  /** Clave Kepler de la sucursal (`02`). */
  code: string;
  /** Nombre corto para la tira del producto (`LPA`). */
  short: string;
  name: string;
  /** ¿Es la sucursal de surtido del vendedor? */
  mine: boolean;
  /**
   * ISO 8601: de cuándo es la lectura de esta sucursal. `[MCP.3.16]` Es el mismo valor que
   * `checked_at` (se conserva por compatibilidad); `null` = nunca se revisó.
   */
  as_of: string | null;
  /**
   * `[MCP.3.16]` La lectura de esta sucursal está vieja (más de `ODS_HOT_TOLERANCIA_H` horas) o
   * falló: sus celdas de `stock` vienen en `null` y se leen «sin dato», nunca 0.
   */
  stale: boolean;
  /** `[MCP.3.16]` ISO de la última revisión del carril `ods_live_hot` de esta sucursal; `null` = nunca. */
  checked_at: string | null;
}

export interface VendorZoneStockResponse {
  /** Nombre de la zona («La Piedad»); `null` si no se pudo resolver. */
  zone: string | null;
  /** Sucursales de la zona: primero la del vendedor, luego en el orden del catálogo. */
  warehouses: ZoneWarehouse[];
  /**
   * `product_id` → existencia (unidad BASE) por sucursal, en el mismo orden que `warehouses`.
   *
   * `[MCP.3.16]` Sale de la vista canónica `analytics.v_erp_stock_on_hand` (ADR-055), ya no de la
   * copia `commercial.stock`, y NO descuenta apartados (la vista no los tiene; medido en prod: 1
   * fila de 53,223 con apartado). Un DUPLICADO legado (`sku` NULL) trae la existencia de su gemelo
   * vivo (`sku = btrim(articulo)`), bajo su propio `product_id`.
   *
   * Regla de lectura de una celda:
   *  · sucursal `stale`                          → sin dato (la celda viene `null`);
   *  · sucursal al día y número                  → ese número (0 = agotado);
   *  · sucursal al día y `null`                  → esa sucursal no tiene registro: 0 («no se maneja»);
   *  · producto AUSENTE de la matriz             → 0 en toda sucursal al día, sin dato en las stale.
   * Sólo vienen productos con existencia > 0 en al menos una sucursal al día de la zona.
   */
  stock: Record<string, (number | null)[]>;
  /** Por qué no hay datos (`null` si se midió). */
  unmeasured_reason: string | null;
}
