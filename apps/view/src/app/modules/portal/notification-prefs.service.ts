import { Injectable, computed, signal } from '@angular/core';

export type NotifKey = 'orders' | 'promotions' | 'recommendations' | 'lowStock';

export interface NotifPrefs {
  orders: boolean;
  promotions: boolean;
  recommendations: boolean;
  lowStock: boolean;
}

const STORAGE_KEY = 'portal:notif-prefs';

const DEFAULT_PREFS: NotifPrefs = {
  orders: true,
  promotions: true,
  recommendations: true,
  lowStock: true,
};

@Injectable({ providedIn: 'root' })
export class NotificationPrefsService {
  private readonly _prefs = signal<NotifPrefs>(this.load());
  readonly prefs = this._prefs.asReadonly();

  readonly enabledCount = computed(
    () => Object.values(this._prefs()).filter((v) => v).length,
  );

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

  reset(): void {
    this._prefs.set({ ...DEFAULT_PREFS });
    this.persist({ ...DEFAULT_PREFS });
  }

  private load(): NotifPrefs {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_PREFS };
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_PREFS, ...parsed };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  private persist(prefs: NotifPrefs): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  }
}
