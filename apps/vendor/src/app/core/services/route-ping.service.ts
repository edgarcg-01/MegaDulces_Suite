import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Capacitor } from '@capacitor/core';
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

  // Cadencia adaptativa: rápido en movimiento, lento detenido. El recurso caro
  // es el GPS+batería, así que solo se acelera cuando hay algo que reportar.
  private static readonly MOVING_MS = 25 * 1000; // se mueve → cada 25s
  private static readonly STATIONARY_MS = 60 * 1000; // detenido → cada 60s (heartbeat "en vivo")
  private static readonly HIGH_FREQ_MS = 12 * 1000; // observado por un supervisor → 12s
  private static readonly MOVE_THRESHOLD_M = 30; // delta para considerar "en movimiento"
  private static readonly MAX_ACCURACY_M = 2000; // descarta fixes basura (ubicación por red)
  private static readonly DRAIN_MS = 60 * 1000; // reintento de cola offline
  private static readonly BATCH = 200;

  private pingTimer: any = null;
  private syncTimer: any = null;
  private activeRouteId: string | null = null;
  private wakeLock: any = null;
  /** Última posición usada para detectar movimiento (lat/lng). */
  private lastFix: { lat: number; lng: number } | null = null;
  /** Timestamp del último fix encolado — evita duplicar fixes GPS cacheados. */
  private lastEnqueuedTs = 0;
  private moving = false;
  private running = false;
  /** Alta frecuencia on-demand: el server la activa cuando un supervisor observa. */
  private highFreqUntil = 0;
  /** id del watcher nativo de background-geolocation (null = no nativo / inactivo). */
  private bgWatcherId: string | null = null;
  /** Jornada del vendedor abierta (independiente del flujo de captura). */
  private readonly _shiftActive = signal(false);

  /** Plataforma nativa (Capacitor) — el tracking en background solo existe ahí. */
  private readonly native = Capacitor.isNativePlatform();
  /** Watcher nativo registrado OK. */
  readonly bgActive = signal(false);
  /** El watcher devolvió permiso insuficiente (NOT_AUTHORIZED). */
  readonly bgPermissionDenied = signal(false);
  /** Último error del watcher nativo (visible en el diálogo de ayuda + logcat). */
  readonly bgError = signal<string | null>(null);
  /** Timestamp del último fix de background recibido (diagnóstico). */
  private lastBgFixTs = 0;

  /**
   * Salud del tracking en segundo plano (para avisar al vendedor):
   *  - 'web'        → PWA, no hay background (solo foreground por diseño).
   *  - 'permission' → falta permiso "todo el tiempo" → abrir ajustes.
   *  - 'inactive'   → nativo pero el watcher no quedó activo.
   *  - 'ok'         → registrando (o sin jornada, no aplica).
   */
  readonly trackingHealth = computed<'ok' | 'web' | 'permission' | 'inactive'>(() => {
    const expected = this._shiftActive() || !!this.captureSvc.activeRoute()?.id;
    if (!expected) return 'ok';
    if (!this.native) return 'web';
    if (this.bgPermissionDenied()) return 'permission';
    if (!this.bgActive()) return 'inactive';
    return 'ok';
  });

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
    if (this.running) return; // ya corriendo
    this.running = true;
    // Drain siempre (foreground + background comparten la cola).
    this.syncTimer = setInterval(() => void this.drain(), RoutePingService.DRAIN_MS);
    // Heartbeat foreground (app visible): garantiza reporte aunque esté DETENIDO.
    // El watcher de background es por distancia, así que un vendedor quieto no
    // emitía nada → en el mapa salía "sin señal". El tick cubre ese caso.
    void this.acquireWakeLock();
    void this.tick();
    // Nativo: además, watcher de background para continuidad con pantalla apagada
    // / movimiento. En web es no-op (cae por isNativePlatform()).
    void this.startBackgroundWatcher();
  }

  private stop(): void {
    this.running = false;
    this.activeRouteId = null;
    if (this.pingTimer) { clearTimeout(this.pingTimer); this.pingTimer = null; }
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; }
    this.lastFix = null;
    this.moving = false;
    this.releaseWakeLock();
    void this.stopBackgroundWatcher();
    this.bgActive.set(false);
    // Intento final de drenar lo que quede encolado.
    void this.drain();
  }

  /** Abre los ajustes de la app (permisos / batería) para arreglar el tracking. */
  async openSettings(): Promise<void> {
    try {
      const { registerPlugin } = await import('@capacitor/core');
      const BG = registerPlugin<any>('BackgroundGeolocation');
      await BG.openSettings();
    } catch {
      /* plugin no disponible (web) — no-op */
    }
  }

  /** Sube a alta frecuencia por `ttlSec` (lo activa el server vía WS al observar). */
  setHighFrequency(ttlSec: number): void {
    const wasActive = Date.now() < this.highFreqUntil;
    this.highFreqUntil = Date.now() + Math.max(0, ttlSec) * 1000;
    // Adelanta el próximo tick SOLO en la transición a "observado" (una vez).
    // Re-tickear en CADA drain creaba un loop: drain→setHighFrequency→tick→
    // capturePing→drain→… a la velocidad del POST (ráfaga de pings idénticos).
    if (!wasActive && this.running && this.pingTimer) {
      clearTimeout(this.pingTimer);
      this.pingTimer = setTimeout(() => void this.tick(), 0);
    }
  }

  /** Delay hasta el próximo fix según movimiento / observación on-demand. */
  private nextDelay(): number {
    if (Date.now() < this.highFreqUntil) return RoutePingService.HIGH_FREQ_MS;
    return this.moving ? RoutePingService.MOVING_MS : RoutePingService.STATIONARY_MS;
  }

  /** Un ciclo: captura, drena (send-through), reprograma con cadencia adaptativa. */
  private async tick(): Promise<void> {
    await this.capturePing();
    if (!this.running) return;
    this.pingTimer = setTimeout(() => void this.tick(), this.nextDelay());
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

  /**
   * Watcher de background en nativo: foreground service con notificación
   * persistente que sigue emitiendo fixes con la pantalla apagada / app en
   * background. `distanceFilter` controla la eficiencia a nivel OS (solo
   * dispara al moverse). Devuelve true si quedó activo (= no usar el loop web).
   */
  private async startBackgroundWatcher(): Promise<boolean> {
    if (this.bgWatcherId) return true;
    if (!this.native) return false;
    const { registerPlugin } = await import('@capacitor/core');
    const BG = registerPlugin<any>('BackgroundGeolocation');
    const onFix = (location: any, error: any) => {
      if (error) {
        // Permiso insuficiente ("mientras se usa" / denegado) → bandera para que
        // el vendedor lo arregle. Otros errores (sin fix) solo se loguean.
        if (error.code === 'NOT_AUTHORIZED' || /not.?authorized|denied|permission/i.test(error.message || '')) {
          this.bgPermissionDenied.set(true);
        }
        console.warn(`[tracking] watcher error: ${error.code || ''} ${error.message || ''}`);
        return;
      }
      if (!location) return;
      this.bgPermissionDenied.set(false);
      this.bgError.set(null);
      this.lastBgFixTs = location.time || Date.now();
      void this.enqueueFix({
        lat: location.latitude,
        lng: location.longitude,
        accuracyM: location.accuracy ?? undefined,
        speedMps: location.speed ?? undefined,
        ts: location.time || Date.now(),
        source: 'background',
      });
    };
    // El BackgroundGeolocationService del plugin se bindea async al cargar; si el
    // watcher arranca antes de que termine, rechaza "Service not running" →
    // reintentar. Cualquier otro error se SUPERFICIE (signal + logcat) en vez de
    // tragarse, porque el "no notificación / no GPS bloqueado" suele venir de un
    // fallo nativo de startForeground que el plugin solo loguea.
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        this.bgWatcherId = await BG.addWatcher(
          {
            backgroundTitle: 'Mega Dulces — ruta activa',
            backgroundMessage: 'Registrando tu recorrido',
            requestPermissions: true,
            stale: false,
            distanceFilter: RoutePingService.MOVE_THRESHOLD_M,
          },
          onFix,
        );
        this.bgActive.set(true);
        this.bgError.set(null);
        console.log(`[tracking] watcher nativo activo (intento ${attempt})`);
        return true;
      } catch (e: any) {
        const msg = e?.message || String(e);
        this.bgError.set(msg);
        console.error(`[tracking] addWatcher falló (intento ${attempt}): ${msg}`);
        if (!/service not running/i.test(msg) || attempt === 4) break;
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    this.bgWatcherId = null;
    this.bgActive.set(false);
    return false;
  }

  private async stopBackgroundWatcher(): Promise<void> {
    if (!this.bgWatcherId) return;
    const id = this.bgWatcherId;
    this.bgWatcherId = null;
    try {
      const { registerPlugin } = await import('@capacitor/core');
      const BG = registerPlugin<any>('BackgroundGeolocation');
      await BG.removeWatcher({ id });
    } catch {
      /* noop */
    }
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
          maximumAge: 8000,
        });
      });
    } catch {
      return; // sin fix esta vez; el siguiente intervalo reintenta
    }

    await this.enqueueFix({
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracyM: pos.coords.accuracy ?? undefined,
      speedMps: pos.coords.speed != null ? pos.coords.speed : undefined,
      ts: pos.timestamp || Date.now(),
      source: 'foreground',
    });
  }

  /** Encola un fix (de foreground o background), detecta movimiento y drena. */
  private async enqueueFix(fix: {
    lat: number;
    lng: number;
    accuracyM?: number;
    speedMps?: number;
    ts: number;
    source: 'foreground' | 'background';
  }): Promise<void> {
    const userId = this.auth.user()?.sub || (this.auth.user() as any)?.id;
    if (!userId) return;
    if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return;
    // Descarta fixes de precisión basura (ubicación por red, acc ~50km) que
    // teletransportarían el marcador a otra ciudad.
    if (fix.accuracyM != null && fix.accuracyM > RoutePingService.MAX_ACCURACY_M) return;
    // Mismo fix GPS que el anterior (getCurrentPosition devolvió caché): no duplicar.
    if (fix.ts === this.lastEnqueuedTs) return;
    this.lastEnqueuedTs = fix.ts;

    if (this.lastFix) {
      const moved = RoutePingService.haversineM(this.lastFix.lat, this.lastFix.lng, fix.lat, fix.lng);
      const bySpeed = fix.speedMps != null && fix.speedMps > 0.7; // ~2.5 km/h
      this.moving = moved >= RoutePingService.MOVE_THRESHOLD_M || bySpeed;
    }
    this.lastFix = { lat: fix.lat, lng: fix.lng };

    const ping: RoutePing = {
      id: this.uuid(),
      userId: String(userId),
      routeId: this.activeRouteId,
      capturedAt: new Date(fix.ts).toISOString(),
      lat: fix.lat,
      lng: fix.lng,
      accuracyM: fix.accuracyM,
      speedMps: fix.speedMps,
      source: fix.source,
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
        platform: Capacitor.getPlatform(),
      })),
    };
    try {
      const res = await firstValueFrom(
        this.http.post<{ inserted: number; high_freq_sec?: number }>(
          `${environment.apiUrl}/reports/route-pings`,
          body,
        ),
      );
      // Confirmados: los borramos de la cola (ya viven en server, idempotente).
      await this.db.routePings.bulkDelete(pending.map((p) => p.id));
      // El server nos dice si un supervisor nos está observando → subir cadencia.
      if (res?.high_freq_sec && res.high_freq_sec > 0) {
        this.setHighFrequency(res.high_freq_sec);
      }
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

  /** Distancia en metros entre dos coordenadas (haversine). */
  private static haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
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
