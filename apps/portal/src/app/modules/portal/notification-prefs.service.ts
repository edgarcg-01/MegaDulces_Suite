import { Injectable, signal } from '@angular/core';

export type NotifKey = 'orders';

export interface NotifPrefs {
  /** Toast + refresh ante alertas WS de tus pedidos (confirmed/fulfilled). */
  orders: boolean;
}

const STORAGE_KEY = 'portal:notif-prefs';

const DEFAULT_PREFS: NotifPrefs = {
  orders: true,
};

/**
 * Preferencias de notificaciones del portal B2B.
 *
 * Hoy solo `orders` tiene plumbing real contra el WS /alerts del backend
 * (order_confirmed / order_fulfilled scoped al customer del JWT). Los toggles
 * que existían antes (promotions/recommendations/lowStock) eran zombi — sin
 * consumer y sin evento WS asociado — así que se eliminaron. Se reintroducen
 * cuando haya pipeline backend que los respalde.
 */
@Injectable({ providedIn: 'root' })
export class NotificationPrefsService {
  private readonly _prefs = signal<NotifPrefs>(this.load());
  readonly prefs = this._prefs.asReadonly();

  toggle(key: NotifKey): void {
    const next = { ...this._prefs(), [key]: !this._prefs()[key] };
    this._prefs.set(next);
    this.persist(next);
  }

  set(key: NotifKey, value: boolean): void {
    const next = { ...this._prefs(), [key]: value };
    this._prefs.set(next);
    this.persist(next);
  }

  private load(): NotifPrefs {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_PREFS };
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_PREFS, orders: parsed?.orders ?? DEFAULT_PREFS.orders };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  private persist(prefs: NotifPrefs): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  }
}
