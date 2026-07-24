import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * F.3 — Bandeja de pedidos WhatsApp (persona de tienda / operador de reparto).
 * Habla con `/whatsapp/orders/*`. Confirmar crea el pedido a domicilio real y lo
 * manda a `/reparto/asignar`; rechazar cierra el hilo y avisa al cliente.
 */

export interface WhatsAppOrderItem {
  name: string | null;
  qty: number; // piezas
  unit_price: number | null;
  pieces_per_package?: number;
  presentation?: string; // "2 paq × 40 (80 pzas)" o "5 pzas"
}

export interface WhatsAppPendingOrder {
  thread_id: string;
  phone: string;
  customer_name: string | null;
  items: WhatsAppOrderItem[];
  total: number;
  delivery_address: { street?: string; references?: string; recipient_name?: string; phone?: string } | null;
  last_message_at: string | null;
}

@Injectable({ providedIn: 'root' })
export class WhatsAppOrdersService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.apiUrl;

  listPending(): Observable<WhatsAppPendingOrder[]> {
    return this.http.get<WhatsAppPendingOrder[]>(`${this.api}/whatsapp/orders`);
  }

  confirm(threadId: string): Observable<{ order_id: string; code: string; total: number }> {
    return this.http.post<{ order_id: string; code: string; total: number }>(
      `${this.api}/whatsapp/orders/${threadId}/confirm`, {});
  }

  reject(threadId: string, reason?: string): Observable<{ status: string }> {
    return this.http.post<{ status: string }>(`${this.api}/whatsapp/orders/${threadId}/reject`, { reason });
  }
}
