import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subject, firstValueFrom } from 'rxjs';
import { TelemetryService } from '../telemetry/telemetry.service';

/**
 * Outbox offline-first (Fase 2).
 *
 * Cuando el rep está sin señal, las mutaciones del carrito (add/update/remove
 * línea) se ENCOLAN en IndexedDB en vez de fallar, y se REPRODUCEN en orden
 * (FIFO) al reconectar o al reabrir la app. La cola sobrevive a recargas y al
 * cierre de la pestaña (IndexedDB es persistente).
 *
 * Límites a propósito (ver Fase 2 del plan):
 *   - Solo se encola cuando `navigator.onLine === false` (offline claro), así
 *     la request nunca salió → cero riesgo de duplicado al reproducir. Los
 *     fallos de red "online pero flaky" los maneja el retry del interceptor (E3).
 *   - El replay corre con la app abierta (al volver online o al arrancar). NO
 *     reproduce con la app cerrada: eso requiere Background Sync en un SW custom,
 *     incompatible con el ngsw de Angular. (Follow-up Fase 2.5.)
 *   - Conflictos: si una op falla con 4xx al reproducir (ej. sin stock), se
 *     descarta y se reporta — gana la verdad del servidor.
 */

const DB_NAME = 'portal-outbox';
const STORE = 'ops';
const DB_VERSION = 1;

export interface OutboxOp {
  id?: number;
  method: 'POST' | 'PATCH' | 'DELETE';
  url: string;
  body?: unknown;
  label?: string;
  createdAt: number;
}

export interface ReplayResult {
  synced: number;
  failed: number;
}

@Injectable({ providedIn: 'root' })
export class OutboxService {
  private readonly http = inject(HttpClient);
  private readonly telemetry = inject(TelemetryService);

  /** Nº de operaciones pendientes de sincronizar (driver de la UI). */
  readonly pending = signal(0);
  /** True mientras se reproduce la cola. */
  readonly syncing = signal(false);
  /** Emite tras cada replay para que quien dependa reconcilie (ej. refreshCart). */
  readonly replayed$ = new Subject<ReplayResult>();

  private db: IDBDatabase | null = null;
  private started = false;

  async init(): Promise<void> {
    if (this.started || typeof indexedDB === 'undefined') return;
    this.started = true;
    try {
      this.db = await this.openDb();
    } catch {
      this.db = null;
      return; // sin IndexedDB el outbox queda inactivo (degradación silenciosa)
    }
    await this.refreshCount();

    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => void this.replay());
    }
    if (this.isOnline() && this.pending() > 0) void this.replay();
  }

  isOnline(): boolean {
    return typeof navigator === 'undefined' ? true : navigator.onLine;
  }

  /** Encola una operación (cuando estamos offline). */
  async enqueue(op: Omit<OutboxOp, 'id' | 'createdAt'>): Promise<void> {
    if (!this.db) return;
    const full: OutboxOp = { ...op, createdAt: Date.now() };
    await this.tx('readwrite', (store) => store.add(full));
    await this.refreshCount();
    this.telemetry.track('outbox_enqueued', { method: op.method, label: op.label });
  }

  /** Reproduce la cola en orden. Idempotente: si ya está corriendo, no reentra. */
  async replay(): Promise<ReplayResult> {
    const result: ReplayResult = { synced: 0, failed: 0 };
    if (!this.db || this.syncing() || !this.isOnline()) return result;

    const ops = await this.allOps();
    if (ops.length === 0) return result;

    this.syncing.set(true);
    try {
      for (const op of ops) {
        try {
          await firstValueFrom(this.http.request(op.method, op.url, { body: op.body }));
          await this.delete(op.id!);
          result.synced++;
        } catch (err) {
          const status = (err as { status?: number })?.status ?? 0;
          if (status >= 400 && status < 500) {
            // Cliente/conflicto (ej. sin stock): no va a tener éxito al reintentar.
            // Lo descartamos y lo contamos como fallo (gana el servidor).
            await this.delete(op.id!);
            result.failed++;
          } else {
            // Red caída de nuevo o 5xx transitorio: paramos y reintentamos luego.
            break;
          }
        }
      }
    } finally {
      this.syncing.set(false);
      await this.refreshCount();
      this.telemetry.track('outbox_replayed', { synced: result.synced, failed: result.failed });
      this.replayed$.next(result);
    }
    return result;
  }

  // ── IndexedDB helpers ───────────────────────────────────────────────────────

  private openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error('no db'));
      const t = this.db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private allOps(): Promise<OutboxOp[]> {
    return this.tx<OutboxOp[]>('readonly', (s) => s.getAll() as IDBRequest<OutboxOp[]>).then((ops) =>
      (ops || []).sort((a, b) => (a.id ?? 0) - (b.id ?? 0)),
    );
  }

  private delete(id: number): Promise<void> {
    return this.tx('readwrite', (s) => s.delete(id)).then(() => void 0);
  }

  private async refreshCount(): Promise<void> {
    try {
      const n = await this.tx<number>('readonly', (s) => s.count());
      this.pending.set(n || 0);
    } catch {
      /* noop */
    }
  }
}
