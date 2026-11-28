import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { OfflineDatabaseService, InventoryScanPending, InventoryCatalogEntry } from './offline-database.service';
import { normalizarCodigoDeBarras } from './codigo-de-barras-normalizado';

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

  /**
   * Cachea el catálogo del folio (bulk, al iniciar la jornada con red).
   *
   * `[ICR.M10]` Siembra **además** la llave normalizada cuando difiere de la exacta: el lector
   * en modo EAN-13 le pone un cero adelante al UPC-A y, sin esto, el mismo escaneo que online
   * resuelve bien no reconoce nada sin red. La exacta se escribe siempre y **gana**, porque la
   * normalizada es un segundo intento, nunca un reemplazo.
   */
  async cacheFolioCatalog(countId: string, rows: Array<Omit<InventoryCatalogEntry, 'id' | 'count_id'>>): Promise<void> {
    const entries: InventoryCatalogEntry[] = [];
    for (const r of rows) {
      if (!r.barcode) continue;
      entries.push({ id: `${countId}:${r.barcode}`, count_id: countId, ...r });
      const norm = normalizarCodigoDeBarras(r.barcode);
      if (norm && norm !== r.barcode) {
        entries.push({ id: `${countId}:${norm}`, count_id: countId, ...r });
      }
    }
    if (entries.length) await this.db.inventoryCatalog.bulkPut(entries);
  }

  /** Lazy-cache: guarda un producto resuelto online para futuros escaneos offline. */
  async cacheProduct(countId: string, e: Omit<InventoryCatalogEntry, 'id' | 'count_id'>): Promise<void> {
    if (!e.barcode) return;
    await this.db.inventoryCatalog.put({ id: `${countId}:${e.barcode}`, count_id: countId, ...e });
  }

  /**
   * Resuelve barcode→producto desde el cache local (offline).
   *
   * `[ICR.M10]` Dos intentos, en el mismo orden que el servidor: **exacto primero** —si el
   * código tal cual está, ése gana y la normalización nunca desvía un escaneo que hoy
   * funciona— y después el normalizado, que es el que cubre el cero que agrega el lector.
   */
  async resolveLocal(countId: string, barcode: string): Promise<InventoryCatalogEntry | null> {
    const exacto = await this.db.inventoryCatalog.get(`${countId}:${barcode}`);
    if (exacto) return exacto;
    const norm = normalizarCodigoDeBarras(barcode);
    if (!norm || norm === barcode) return null;
    return (await this.db.inventoryCatalog.get(`${countId}:${norm}`)) ?? null;
  }

  /**
   * `[ICR.M5]` **Cuántos productos de este folio tiene descargados ESTE dispositivo.**
   *
   * `cacheFolioCatalog` sólo corre con red (`prefetchCatalog` se rinde sin conexión), así que
   * un teléfono que llega a la sucursal ya sin señal se queda en **cero** y no puede reconocer
   * ni un código. La pantalla no puede arreglarlo —descargar sin red no existe— pero sí tiene
   * que **decirlo** antes de que alguien empiece a contar a ciegas de verdad.
   *
   * ⚠️ Cuenta sólo lo que tiene código de barras: `cacheFolioCatalog` filtra por `barcode`
   * porque la llave del cache es el código. Un cero no distingue «nunca se descargó» de «este
   * folio no tiene ni un producto con código», pero lo segundo no existe en prod.
   */
  async catalogCountFor(countId: string): Promise<number> {
    return this.db.inventoryCatalog.where('count_id').equals(countId).count();
  }

  // ───── Outbox de escaneos ─────

  /** Encola un escaneo (se persiste antes que la red → cero pérdida). */
  async queueScan(scan: {
    scan_uuid: string;
    count_id: string;
    product_id?: string | null;
    barcode?: string | null;
    quantity: number;
    /** `[IC.F24]` En qué unidad dijo haber contado. `null` = la del código del SKU. */
    unit?: string | null;
    /** `[ICR.M3]` El rack en el que está parada la persona. `null` = el montón «sin rack». */
    aisle_id?: string | null;
    capture_pass: number;
  }): Promise<void> {
    await this.db.inventoryScans.put({
      scan_uuid: scan.scan_uuid,
      count_id: scan.count_id,
      product_id: scan.product_id ?? null,
      barcode: scan.barcode ?? null,
      quantity: scan.quantity,
      unit: scan.unit ?? null,
      aisle_id: scan.aisle_id ?? null,
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

  /** `[ICR.M10]` Los escaneos detenidos esperando que una persona diga qué producto contó. */
  async ambiguousFor(countId: string): Promise<InventoryScanPending[]> {
    return (await this.db.inventoryScans.where('count_id').equals(countId).toArray())
      .filter((s) => s.estado === 'ambiguo' && !s.sincronizado);
  }

  /**
   * `[ICR.M10]` La persona eligió cuál de los candidatos contó: la captura vuelve a la cola
   * atada a ese `product_id`, y el código de barras se suelta para que no la vuelva a partir.
   * Conserva su `scan_uuid`, así que si por lo que sea ya se había aplicado, no duplica.
   */
  async resolveAmbiguous(scanUuid: string, productId: string): Promise<void> {
    await this.db.inventoryScans.update(scanUuid, {
      product_id: productId,
      barcode: null,
      estado: 'pendiente',
      motivo_descarte: undefined,
      candidatos: undefined,
      intentos_fallidos: 0,
    });
    await this.refreshPending();
  }

  /**
   * ⛔ Un escaneo `ambiguo` **cuenta como pendiente**: no llegó al folio y alguien tiene que
   * actuar. Dejarlo fuera del número lo volvería invisible, que es el defecto de E4 con otra
   * causa.
   */
  private async refreshPending(): Promise<void> {
    const all = await this.db.inventoryScans.toArray();
    this.pending.set(all.filter((s) => !s.sincronizado && s.estado !== 'descartado').length);
  }

  // ───── Sync ─────

  /** Drena la cola: POST de cada escaneo pendiente. Idempotente server-side. */
  async flush(): Promise<{ synced: number; failed: number; discarded: number; ambiguous: number }> {
    const out = { synced: 0, failed: 0, discarded: 0, ambiguous: 0 };
    if (this.flushing || (typeof navigator !== 'undefined' && !navigator.onLine)) return out;
    this.flushing = true;
    this.syncing.set(true);
    try {
      const all = await this.db.inventoryScans.toArray();
      // ⛔ `[ICR.M10]` Los `ambiguo` NO se reintentan solos: volverían a chocar con el mismo
      // 409 para siempre. Salen de la cola cuando una persona elige el producto.
      const pend = all.filter((s) => !s.sincronizado && s.estado !== 'descartado' && s.estado !== 'ambiguo');
      for (const s of pend) {
        try {
          await firstValueFrom(
            this.http.post(`${this.apiUrl}/commercial/inventory/counts/${s.count_id}/count`, {
              scan_uuid: s.scan_uuid,
              capture_pass: s.capture_pass,
              quantity: s.quantity,
              unit: s.unit ?? undefined,
              // `[ICR.M3]` El rack donde estaba parada la persona. Se omite cuando no hay —el
              // servidor lo toma como «sin rack»—, y nunca se manda vacío.
              ...(s.aisle_id ? { aisle_id: s.aisle_id } : {}),
              ...(s.product_id ? { product_id: s.product_id } : { barcode: s.barcode }),
            }),
          );
          await this.db.inventoryScans.update(s.scan_uuid, { sincronizado: true });
          out.synced++;
        } catch (e: any) {
          const status = e?.status;
          if (status === 409 && e?.error?.code === 'CODIGO_AMBIGUO') {
            /*
              ⛔⛔ `[ICR.M10]` **Esto NO es un descarte.** El código casa con más de un
              producto —en el folio de Yurécuaro una CUCHARA y un TENEDOR de Reyher comparten
              código, y dos sabores de gomitas Canel's también— y la captura sigue siendo
              buena: lo único que falta es que alguien diga cuál de los dos contó.

              Antes de esta rama caía en el `if (status === 409)` de abajo y se marcaba
              `descartado`: la mercancía contada moría en silencio por un defecto del
              catálogo, no del folio.
            */
            await this.db.inventoryScans.update(s.scan_uuid, {
              estado: 'ambiguo',
              motivo_descarte: e?.error?.message || 'El código coincide con más de un producto',
              candidatos: Array.isArray(e?.error?.candidates) ? e.error.candidates : [],
            });
            out.ambiguous++;
          } else if (status === 409) {
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
