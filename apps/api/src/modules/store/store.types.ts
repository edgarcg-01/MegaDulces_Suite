/** Proyecto Tienda (TDA) — tipos del monitor de tickets en vivo. */

export interface LiveTicketItem {
  sku: string;
  nombre: string;
  cant: number;
  importe: number;
}

export interface LiveTicket {
  warehouse_code: string;
  warehouse_name?: string;
  serie: string;
  folio: string;
  ticket_ts: string; // ISO
  total: number;
  forma_pago?: string;
  items: LiveTicketItem[];
}

export type StoreAlertType = 'large_ticket' | 'branch_idle' | 'test';

export interface StoreAlert {
  type: StoreAlertType;
  severity: 'info' | 'warn' | 'critical';
  title: string;
  message: string;
  data: Record<string, unknown>;
  emitted_at: string;
}
