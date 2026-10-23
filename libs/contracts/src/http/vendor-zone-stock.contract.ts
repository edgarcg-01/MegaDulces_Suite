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
  /** ISO 8601: la existencia más reciente que se cargó de esta sucursal; `null` = nunca. */
  as_of: string | null;
}

export interface VendorZoneStockResponse {
  /** Nombre de la zona («La Piedad»); `null` si no se pudo resolver. */
  zone: string | null;
  /** Sucursales de la zona: primero la del vendedor, luego en el orden del catálogo. */
  warehouses: ZoneWarehouse[];
  /**
   * `product_id` → existencia disponible (cantidad − apartado, en unidad BASE) por sucursal, en el
   * mismo orden que `warehouses`. `null` = esa sucursal no tiene renglón de ese producto (sin dato).
   * Sólo vienen productos con existencia en al menos una sucursal de la zona: un producto que no
   * viene es «sin existencias en la zona».
   */
  stock: Record<string, (number | null)[]>;
  /** Por qué no hay datos (`null` si se midió). */
  unmeasured_reason: string | null;
}
