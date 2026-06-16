import { Injectable, effect, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthService } from './auth.service';
import { OfflineDatabaseService, RoutePing } from './offline-database.service';
import { DailyCaptureService } from '../../modules/dashboard/captures/daily-capture.service';

/**
 * Breadcrumbs GPS (Fase 2 tiempos muertos). Mientras hay una ruta activa y la
 * app está en foreground, toma la posición cada PING_INTERVAL_MS, la encola en
 * Dexie (offline-first) y drena la cola a POST /reports/route-pings cuando hay
 * red. Es la señal que separa "trasladándose" de "estacionado sin actividad".
 *
 * Autoarranque: observa `DailyCaptureService.activeRoute` — al elegir ruta
 * empieza, al limpiarla para. No requiere wiring manual en cada componente más
 * allá de inyectar el servicio para instanciarlo.
 */
@Injectable({ providedIn: 'root' })
export class RoutePingService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private db = inject(OfflineDatabaseService);
  private captureSvc = inject(DailyCaptureService);

  private static readonly PING_INTERVAL_MS = 3 * 60 * 1000; // 3 min
  private static readonly BATCH = 200;

  private pingTimer: any = null;
  private syncTimer: any = null;
  private activeRouteId: string | null = null;
  private wakeLock: any = null;
  /** Jornada del vendedor abierta (independiente del flujo de captura). */
  private readonly _shiftActive = signal(false);

  constructor() {
    // Trackea mientras haya ruta de captura activa O jornada de vendedor abierta.
    effect(() => {
      const route = this.captureSvc.activeRoute();
      const shift = this._shiftActive();
      if (route?.id || shift) this.start(route?.id ?? null);
      else this.stop();
    });
    // Drenar la cola cuando vuelve la red.
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => void this.drain());
    }
    // El wake lock se libera solo al ir a background; re-adquirir al volver.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.pingTimer) {
          void this.acquireWakeLock();
        }
      });
    }
  }

  /** Abre la jornada: arranca el tracking aunque no haya captura en curso. */
  startShift(): void {
    this._shiftActive.set(true);
  }

  /** Cierra la jornada: para el tracking si no hay captura activa. */
  endShift(): void {
    this._shiftActive.set(false);
  }

  private start(routeId: string | null): void {
    this.activeRouteId = routeId;
    if (this.pingTimer) return; // ya corriendo
    void this.acquireWakeLock();
    // Ping inmediato + cada intervalo.
    void this.capturePing();
    this.pingTimer = setInterval(() => void this.capturePing(), RoutePingService.PING_INTERVAL_MS);
    this.syncTimer = setInterval(() => void this.drain(), RoutePingService.PING_INTERVAL_MS);
  }

  private stop(): void {
    this.activeRouteId = null;
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; }
    this.releaseWakeLock();
    // Intento final de drenar lo que quede encolado.
    void this.drain();
  }

  /** Mantiene la pantalla encendida mientras se trackea (best effort, foreground). */
  private async acquireWakeLock(): Promise<void> {
    try {
      if (
        typeof navigator !== 'undefined' && 'wakeLock' in navigator &&
        typeof document !== 'undefined' && document.visibilityState === 'visible' &&
        !this.wakeLock
      ) {
        this.wakeLock = await (navigator as any).wakeLock.request('screen');
        this.wakeLock?.addEventListener?.('release', () => { this.wakeLock = null; });
      }
    } catch {
      // No soportado o sin permiso: el tracking sigue, solo no fuerza la pantalla.
    }
  }

  private releaseWakeLock(): void {
    try { void this.wakeLock?.release?.(); } catch { /* noop */ }
    this.wakeLock = null;
  }

  /** Toma una posición y la encola. Solo en foreground (no gastar GPS oculto). */
  private async capturePing(): Promise<void> {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (!navigator?.geolocation) return;
    const userId = this.auth.user()?.sub || (this.auth.user() as any)?.id;
    if (!userId) return;

    let pos: GeolocationPosition;
    try {
      pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 30000,
        });
      });
    } catch {
      return; // sin fix esta vez; el siguiente intervalo reintenta
    }

    const ping: RoutePing = {
      id: this.uuid(),
      userId: String(userId),
      routeId: this.activeRouteId,
      capturedAt: new Date(pos.timestamp || Date.now()).toISOString(),
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracyM: pos.coords.accuracy ?? undefined,
      speedMps: pos.coords.speed != null ? pos.coords.speed : undefined,
      source: 'foreground',
      sincronizado: false,
      intentos_fallidos: 0,
    };
    try {
      await this.db.routePings.put(ping);
    } catch {
      /* IndexedDB lleno o no disponible — best effort */
    }
    void this.drain();
  }

  /** Drena la cola de pings no sincronizados en lotes a la API. */
  private async drain(): Promise<void> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    let pending: RoutePing[];
    try {
      // La tabla SOLO contiene pendientes: los confirmados se borran tras el
      // POST (idempotente server-side), así que basta tomar un lote ordenado.
      pending = await this.db.routePings
        .orderBy('capturedAt')
        .limit(RoutePingService.BATCH)
        .toArray();
    } catch {
      return;
    }
    if (pending.length === 0) return;

    const body = {
      pings: pending.map((p) => ({
        client_uuid: p.id,
        route_id: p.routeId || undefined,
        captured_at: p.capturedAt,
        lat: p.lat,
        lng: p.lng,
        accuracy_m: p.accuracyM,
        speed_mps: p.speedMps,
        source: p.source,
      })),
    };
    try {
      await firstValueFrom(
        this.http.post(`${environment.apiUrl}/reports/route-pings`, body),
      );
      // Confirmados: los borramos de la cola (ya viven en server, idempotente).
      await this.db.routePings.bulkDelete(pending.map((p) => p.id));
    } catch {
      // Falló el envío: marcar reintento (no romper, el próximo drain reintenta).
      try {
        await this.db.routePings.bulkPut(
          pending.map((p) => ({ ...p, intentos_fallidos: (p.intentos_fallidos || 0) + 1 })),
        );
      } catch {
        /* noop */
      }
    }
  }

  private uuid(): string {
    if (typeof crypto !== 'undefined' && (crypto as any).randomUUID) {
      return (crypto as any).randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}
