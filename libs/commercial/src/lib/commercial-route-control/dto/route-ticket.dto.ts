export type RouteTicketType = 'venta' | 'carga' | 'combustible';

export const ROUTE_TICKET_TYPES: RouteTicketType[] = ['venta', 'carga', 'combustible'];

/** Línea de producto detectada en un ticket de CARGA (preview para revisión). */
export interface RouteTicketLinePreview {
  raw: string;
  normalized: string;
  quantity: number;
  product_id: string | null;
  product_name: string | null;
  confidence: string; // high | medium | low | no_match
}

/** Resultado de OCR sin persistir (preview para revisión en UI). */
export interface ProcesarRouteTicketResult {
  ticket_type: RouteTicketType;
  cloudinary_public_id: string;
  photo_url: string;
  photo_preview_url: string;
  fields: {
    route_code: string | null;
    ticket_date: string | null;
    total: number | null;
    corte_number: string | null;
    reference: string | null;
    liters: number | null;
  };
  /**
   * Resolución de la ruta detectada contra el catálogo de rutas de la zona del
   * vendedor. El usuario NO edita la ruta: si `route_matched` es false, el
   * ticket no se puede guardar (la regla se reaplica en guardar()).
   */
  route_matched: boolean;
  route_value: string | null; // nombre canónico, ej. "RUTA 321"
  /** Solo en carga: productos detectados para descargar al camión. */
  lines?: RouteTicketLinePreview[];
}

/** Payload de guardado (tras revisión del vendedor). */
export interface GuardarRouteTicketDto {
  ticket_type: RouteTicketType;
  route_code: string;
  ticket_date: string; // ISO YYYY-MM-DD
  total?: number | null;
  corte_number?: string | null;
  reference?: string | null;
  liters?: number | null;
  cloudinary_public_id?: string | null;
  photo_url?: string | null;
  photo_preview_url?: string | null;
  ocr_text?: string | null;
  ocr_json?: unknown;
  /** Solo carga: líneas confirmadas a descargar al camión del vendedor. */
  lines?: { product_id: string; quantity: number }[];
}

export interface UpdateRouteTicketDto {
  route_code?: string;
  ticket_date?: string;
  total?: number | null;
  corte_number?: string | null;
  reference?: string | null;
  liters?: number | null;
}

export interface ListRouteTicketsQuery {
  ticket_type?: RouteTicketType;
  route_code?: string;
  date_from?: string;
  date_to?: string;
  page?: number;
  pageSize?: number;
}

export interface RouteReportQuery {
  date_from?: string;
  date_to?: string;
}
