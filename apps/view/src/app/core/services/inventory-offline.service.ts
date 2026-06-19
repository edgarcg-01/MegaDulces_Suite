import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { OfflineDatabaseService, InventoryScanPending, InventoryCatalogEntry } from './offline-database.service';

/**
 * Fase OFF — conteo de inventario offline-first (cliente).
 *
 * - **Outbox** de escaneos (Dexie `inventoryScans`): el escaneo se persiste local
 *   primero (cero pérdida), con `scan_uuid` (idempotency key; el backend dedup
 *   con inventory_count_scan_log) y `capture_pass`.
 * - **Catálogo offline** (Dexie `inventoryCatalog`): resolve barcode→producto sin
 *   red. Se cachea el folio al iniciar la jornada + lazy en cada resolve online.
 * - **Sync** en reconexión (listener `online`) + manual. 409 (folio cerrado) →
 *   el escaneo se marca `descartado` (auditable), no se pierde silenciosamente.
 *
 * Auto-contenido (no toca offline-sync.service): su propio listener + flush.
 */
@Injectable({ providedIn: 'root' })
export class InventoryOfflineService {
  private readonly db = inject(OfflineDatabaseService);
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  /** Pendientes sin sincronizar (para el banner del contador). */
  readonly pending = signal(0);
  readonly online = signal(typeof navigator !== 'undefined' ? navigator.onLine : true);
  readonly syncing = signal(false);
  readonly hasPending = computed(() => this.pending() > 0);

  private flushing = false;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => { this.online.set(true); this.flush(); });
      window.addEventListener('offline', () => this.online.set(false));
    }
    this.refreshPending();
  }

  newScanUuid(): string {
    return typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  // ───── Catálogo offline (resolve sin red) ─────

  /** Cachea el catálogo del folio (bulk, al iniciar la jornada con red). */
  async cacheFolioCatalog(countId: string, rows: Array<Omit<InventoryCatalogEntry, 'id' | 'count_id'>>): Promise<void> {
    const entries: InventoryCatalogEntry[] = rows
      .filter((r) => !!r.barcode)
      .map((r) => ({ id: `${countId}:${r.barcode}`, count_id: countId, ...r }));
    if (entries.length) await this.db.inventoryCatalog.bulkPut(entries);
  }

  /** Lazy-cache: guarda un producto resuelto online para futuros escaneos offline. */
  async cacheProduct(countId: string, e: Omit<InventoryCatalogEntry, 'id' | 'count_id'>): Promise<void> {
    if (!e.barcode) return;
    await this.db.inventoryCatalog.put({ id: `${countId}:${e.barcode}`, count_id: countId, ...e });
  }

  /** Resuelve barcode→producto desde el cache local (offline). */
  async resolveLocal(countId: string, barcode: string): Promise<InventoryCatalogEntry | null> {
    return (await this.db.inventoryCatalog.get(`${countId}:${barcode}`)) ?? null;
  }

  // ───── Outbox de escaneos ─────

  /** Encola un escaneo (se persiste antes que la red → cero pérdida). */
  async queueScan(scan: {
    scan_uuid: string;
    count_id: string;
    product_id?: string | null;
    barcode?: string | null;
    quantity: number;
    capture_pass: number;
  }): Promise<void> {
    await this.db.inventoryScans.put({
      scan_uuid: scan.scan_uuid,
      count_id: scan.count_id,
      product_id: scan.product_id ?? null,
      barcode: scan.barcode ?? null,
      quantity: scan.quantity,
      capture_pass: scan.capture_pass,
      client_ts: new Date().toISOString(),
      sincronizado: false,
      intentos_fallidos: 0,
      ultimo_intento: '',
      estado: 'pendiente',
    });
    this.refreshPending();
  }

  async pendingFor(countId: string): Promise<InventoryScanPending[]> {
    return (await this.db.inventoryScans.where('count_id').equals(countId).toArray())
      .filter((s) => !s.sincronizado && s.estado !== 'descartado');
  }

  async discardedFor(countId: string): Promise<InventoryScanPending[]> {
    return (await this.db.inventoryScans.where('count_id').equals(countId).toArray())
      .filter((s) => s.estado === 'descartado');
  }

  private async refreshPending(): Promise<void> {
    const all = await this.db.inventoryScans.toArray();
    this.pending.set(all.filter((s) => !s.sincronizado && s.estado !== 'descartado').length);
  }

  // ───── Sync ─────

  /** Drena la cola: POST de cada escaneo pendiente. Idempotente server-side. */
  async flush(): Promise<{ synced: number; failed: number; discarded: number }> {
    const out = { synced: 0, failed: 0, discarded: 0 };
    if (this.flushing || (typeof navigator !== 'undefined' && !navigator.onLine)) return out;
    this.flushing = true;
    this.syncing.set(true);
    try {
      const all = await this.db.inventoryScans.toArray();
      const pend = all.filter((s) => !s.sincronizado && s.estado !== 'descartado');
      for (const s of pend) {
        try {
          await firstValueFrom(
            this.http.post(`${this.apiUrl}/commercial/inventory/counts/${s.count_id}/count`, {
              scan_uuid: s.scan_uuid,
              capture_pass: s.capture_pass,
              quantity: s.quantity,
              ...(s.product_id ? { product_id: s.product_id } : { barcode: s.barcode }),
            }),
          );
          await this.db.inventoryScans.update(s.scan_uuid, { sincronizado: true });
          out.synced++;
        } catch (e: any) {
          const status = e?.status;
          if (status === 409) {
            // Folio cerrado/no admite conteos → descartar (auditable), no reintentar.
            await this.db.inventoryScans.update(s.scan_uuid, {
              estado: 'descartado',
              motivo_descarte: e?.error?.message || 'El folio ya no admite conteos',
            });
            out.discarded++;
          } else {
            // Transitorio (0/timeout/5xx) o 4xx → reintentar luego.
            await this.db.inventoryScans.update(s.scan_uuid, {
              intentos_fallidos: (s.intentos_fallidos || 0) + 1,
              ultimo_intento: new Date().toISOString(),
            });
            out.failed++;
          }
        }
      }
    } finally {
      this.flushing = false;
      this.syncing.set(false);
      await this.refreshPending();
    }
    return out;
  }
}
