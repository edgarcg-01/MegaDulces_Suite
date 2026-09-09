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
  cajero?: string;   // SM.10 — cajero del ticket (kdm1.c67) para ligar actividad a la cajera
  caja?: string;     // SM.10 — caja física del ticket (kdm1.c5 / maestro.caja) → atribución por caja
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

/**
 * `[TDA.1]` — El aviso de cambio de precio de etiqueta vive en el vocabulario común
 * (`@megadulces/contracts`), no acá: lo entienden el backend que lo emite y el frontend que lo
 * consume, así que un cambio de forma tiene que ser error de compilación en los dos lados.
 *
 * Se re-exporta para que el módulo lo siga importando de `./store.types` como el resto.
 *
 * ⚠️ Deuda con nombre: `LiveTicket` y `StoreAlert` (arriba) siguen escritos DOS veces a mano —una
 * acá y otra en `apps/view/.../tienda/store-socket.service.ts`. Retrofitearlos es otro pase; no se
 * mezcla con esta feature para que el diff siga siendo legible.
 */
export type { LabelPricesChanged } from '@megadulces/contracts';
