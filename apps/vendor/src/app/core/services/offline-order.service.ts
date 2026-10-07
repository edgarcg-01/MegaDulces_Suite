import { Injectable, inject } from '@angular/core';
import {
  OfflineDatabaseService,
  PedidoPendiente,
  OfflinePedidoLine,
} from './offline-database.service';
import { OfflineSyncService } from './offline-sync.service';
import { AuthService } from './auth.service';
import { OrderLine, PriceRow } from '../../modules/portal/portal.service';

/**
 * Take-order SIN red: arma/edita/confirma el pedido contra un draft local (Dexie
 * `pedidosPendientes`), sin tocar el backend. El replay (createDraft → replaceLines
 * → place) lo hace OfflineSyncService al reconectar. Los totales locales NO
 * incluyen promos del backend (se recalculan al sincronizar) — el front avisa.
 */
@Injectable({ providedIn: 'root' })
export class OfflineOrderService {
  private readonly db = inject(OfflineDatabaseService);
  private readonly sync = inject(OfflineSyncService);
  private readonly auth = inject(AuthService);

  private get userId(): string {
    return this.auth.user()?.sub || '';
  }

  // ─── Caché de contexto (abrir/armar sin red) ───

  /** Cachea catálogo+cliente+habituales al cargar online (para abrir offline luego). */
  cacheContext(
    customerId: string,
    ctx: { customer: any; priceListId: string; warehouseId: string; prices: PriceRow[]; frequent: any[] },
  ): Promise<void> {
    return this.db.cacheVendorContext(customerId, ctx);
  }

  /** Contexto cacheado para abrir el take-order sin red (null si nunca se cargó online). */
  getContext(customerId: string): Promise<{
    customer: any;
    warehouseId: string;
    prices: PriceRow[];
    frequent: any[];
  } | null> {
    return this.db.getVendorContext(customerId);
  }

  /** Abre el draft local "building" de este cliente, o crea uno nuevo. */
  async ensureDraft(customer: { id: string; name: string }, warehouseId: string): Promise<PedidoPendiente> {
    const existing = await this.db.getOpenPedido(this.userId, customer.id);
    if (existing) return existing;
    const now = new Date().toISOString();
    const p: PedidoPendiente = {
      id: crypto.randomUUID(),
      userId: this.userId,
      customerId: customer.id,
      customerName: customer.name,
      warehouseId,
      requestedDeliveryDate: '',
      lines: [],
      status: 'building',
      sincronizado: false,
      intentos_fallidos: 0,
      ultimo_intento: now,
      createdAt: now,
    };
    await this.db.savePedido(p);
    return p;
  }

  getById(id: string): Promise<PedidoPendiente | undefined> {
    return this.db.getPedidoById(id);
  }

  /** Reemplaza las líneas del draft local. */
  setLines(id: string, lines: OfflinePedidoLine[]): Promise<void> {
    return this.db.updatePedidoLines(id, lines);
  }

  /** Confirma el pedido offline → cola de sync. Intenta sincronizar si hay red. */
  async confirm(id: string, requestedDeliveryDate: string): Promise<void> {
    await this.db.setPedidoReady(id, requestedDeliveryDate);
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      setTimeout(() => void this.sync.sincronizarTodo().catch(() => {}), 500);
    }
  }

  cancel(id: string): Promise<void> {
    return this.db.deletePedido(id);
  }

  // ─── Cola de pedidos offline (visibilidad + reintento de "muertos") ───

  /** Alineado con OfflineSyncService.MAX_RETRY_ATTEMPTS: a partir de acá un pedido
   *  no se reintenta solo y queda "muerto" para acción manual. */
  private readonly MAX_RETRY = 5;

  /** Resumen de los pedidos confirmados offline sin sincronizar (cola + muertos). */
  async pendingSummaries(): Promise<PendingOrderSummary[]> {
    const pedidos = await this.db.getPedidosListos();
    return pedidos
      .map((p) => {
        let total = 0;
        let units = 0;
        for (const l of p.lines || []) {
          const sub = l.quantity * l.unit_price;
          total += sub + sub * l.tax_rate;
          units += l.quantity;
        }
        return {
          id: p.id,
          customerName: p.customerName,
          total,
          units,
          intentos: p.intentos_fallidos || 0,
          dead: (p.intentos_fallidos || 0) >= this.MAX_RETRY,
          createdAt: p.createdAt,
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Cuántos pedidos del vendedor esperan sincronizar (para el badge). */
  count(): Promise<number> {
    return this.db.contarPedidosPendientes(this.userId);
  }

  /** Reintenta un pedido "muerto": resetea sus intentos y dispara sync si hay red. */
  async retry(id: string): Promise<void> {
    await this.db.reintentarPedidoMuerto(id);
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      setTimeout(() => void this.sync.sincronizarTodo().catch(() => {}), 300);
    }
  }

  /** Línea local (snapshot de precio) desde un PriceRow + cantidad. */
  buildLine(p: PriceRow, quantity: number): OfflinePedidoLine {
    return {
      product_id: p.product_id,
      product_name: p.product_name,
      quantity,
      unit_price: Number(p.price) || 0,
      tax_rate: Number(p.tax_rate) || 0,
      min_qty: p.min_qty || 1,
    };
  }

  /** Draft local → OrderLine[] (totales client-side, SIN promos del backend). */
  toOrderLines(p: PedidoPendiente): OrderLine[] {
    return p.lines.map((l, i) => {
      const subtotal = l.quantity * l.unit_price;
      const tax = subtotal * l.tax_rate;
      return {
        id: l.product_id, // merge por producto → id estable = product_id
        order_id: p.id,
        product_id: l.product_id,
        product_name: l.product_name,
        line_number: i + 1,
        quantity: l.quantity,
        unit_price: l.unit_price,
        tax_rate: l.tax_rate,
        discount_percent: 0,
        line_subtotal: subtotal,
        line_tax: tax,
        line_total: subtotal + tax,
      };
    });
  }
}

/** Resumen de un pedido confirmado offline en espera de sincronización. */
export interface PendingOrderSummary {
  id: string;
  customerName: string;
  total: number;
  units: number;
  intentos: number;
  /** Llegó al cap de reintentos: no se reintenta solo, necesita acción manual. */
  dead: boolean;
  createdAt: string;
}
