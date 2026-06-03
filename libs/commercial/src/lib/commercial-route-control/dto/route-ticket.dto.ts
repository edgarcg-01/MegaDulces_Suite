export type RouteTicketType = 'venta' | 'carga' | 'combustible';

export const ROUTE_TICKET_TYPES: RouteTicketType[] = ['venta', 'carga', 'combustible'];

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
