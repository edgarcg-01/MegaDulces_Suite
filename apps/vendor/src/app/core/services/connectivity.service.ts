import { Injectable, computed, signal } from '@angular/core';

/**
 * Estado de conexión reactivo para la UI (signals). Fuente única que consumen
 * las pantallas para decidir si operan online o en modo offline. El disparo del
 * sync al reconectar lo maneja OfflineSyncService por su cuenta — esto es solo
 * el flag que el front lee.
 */
@Injectable({ providedIn: 'root' })
export class ConnectivityService {
  private readonly _online = signal<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  readonly online = this._online.asReadonly();
  readonly offline = computed(() => !this._online());

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this._online.set(true));
      window.addEventListener('offline', () => this._online.set(false));
    }
  }

  /** Snapshot puntual (para lógica fuera de un contexto reactivo). */
  isOnline(): boolean {
    return typeof navigator !== 'undefined' ? navigator.onLine : this._online();
  }
}
