/** Una línea de venta detectada por OCR en el ticket del vendedor. */
export interface VendorSaleLineInput {
  sku: string; // identificador principal (inventory.products_active)
  product_name?: string | null;
  quantity: number;
  confidence?: string | null;
  product_id?: string | null; // opcional: catalog UUID si el sku ∈ catalog.products
}

/**
 * Payload de la captura del vendedor: registra las líneas de venta (productos
 * del ticket) ancladas a la tienda de trade. NO crea pedido ni route_ticket.
 * `capture_ref` agrupa las líneas de una captura (idempotencia en retry).
 */
export interface CrearVendorSaleDto {
  store_id: string;
  sale_date: string; // YYYY-MM-DD
  route_id?: string; // ruta asignada del vendedor (catalogs rutas)
  capture_ref?: string; // UUID generado en el cliente; reusar en retry = idempotente
  daily_capture_id?: string; // back-link suave a la visita sin ponderación
  ticket_photo_url?: string | null;
  ticket_cloudinary_public_id?: string | null;
  lines: VendorSaleLineInput[];
}

export interface ListVendorSalesQuery {
  date_from?: string;
  date_to?: string;
  store_id?: string;
  page?: number;
  pageSize?: number;
}

export interface VendorSalesReportQuery {
  date_from?: string;
  date_to?: string;
  store_id?: string;
}

export interface VendorSaleLinesQuery {
  capture_ref: string;
}
