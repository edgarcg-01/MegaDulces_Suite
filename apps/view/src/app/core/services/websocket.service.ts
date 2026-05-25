import { Injectable, signal, DestroyRef, inject } from '@angular/core';
import { Subject, Observable, merge } from 'rxjs';
import { debounceTime, buffer, filter, map } from 'rxjs/operators';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../environments/environment';
import { AuthService } from './auth.service';

export interface CaptureEvent {
  type: 'capture:created' | 'capture:synced' | 'capture:deleted';
  captureId: string;
  userId: string;
  capturedByUsername?: string;
  zonaCaptura?: string;
  fecha?: string;
  stats?: any;
  scoreFinalPct?: number;
}

export interface BatchCaptureEvent {
  type: 'capture:created' | 'capture:synced' | 'capture:deleted';
  batch: true;
  count: number;
  events: CaptureEvent[];
}

export interface MetricsUpdateEvent {
  type: 'metrics:updated';
  scope: 'own' | 'team' | 'global';
  summary?: any;
  dailyScores?: any;
}

export interface DebouncedCaptureEvent {
  events: CaptureEvent[];
  count: number;
  types: Set<string>;
}

@Injectable({ providedIn: 'root' })
export class WebSocketService {
  private socket: Socket | null = null;
  private destroyRef = inject(DestroyRef);
  private auth = inject(AuthService);

  private captureCreated$ = new Subject<CaptureEvent>();
  private captureSynced$ = new Subject<CaptureEvent>();
  private captureDeleted$ = new Subject<CaptureEvent>();
  private metricsUpdated$ = new Subject<MetricsUpdateEvent>();

  private rawCaptureEvent$ = new Subject<CaptureEvent>();

  connected = signal(false);
  lastEvent = signal<string | null>(null);
  lastEventTime = signal<Date | null>(null);

  private DEBOUNCE_MS = 3000;

  constructor() {
    this.setupAutoReconnect();
    this.setupBfcacheHandlers();
  }

  /**
   * Permite que Chrome guarde la página en bfcache (back/forward cache).
   *
   * Una conexión WebSocket abierta es uno de los killers más comunes de
   * bfcache: el browser asume que la página tiene estado vivo y no puede
   * congelarla. Lighthouse penaliza esto en "Page prevented back/forward
   * cache restoration".
   *
   * Estrategia: en `pagehide` cerramos el socket (libera el lock de bfcache);
   * en `pageshow` con `event.persisted === true` (la página viene del
   * bfcache) reconectamos. Si el usuario llega por navegación normal,
   * `pageshow` también dispara pero `persisted` es false — no reconectamos
   * porque la conexión inicial la maneja otro flujo (auth login).
   */
  private setupBfcacheHandlers(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('pagehide', () => {
      if (this.socket?.connected) {
        this.socket.disconnect();
      }
    });
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) {
        const token = this.auth.token();
        if (token) this.connect(token);
      }
    });
  }

  private setupAutoReconnect(): void {
    const token = this.auth.token();
    if (!token) return;

    const payload = this.decodeJwtPayload(token);
    if (!payload) return;

    const expiresAt = (payload.exp || 0) * 1000;
    const refreshBefore = 5 * 60 * 1000;
    const msUntilRefresh = expiresAt - Date.now() - refreshBefore;

    if (msUntilRefresh > 0) {
      setTimeout(() => {
        this.tryReconnect();
      }, msUntilRefresh);
    }
  }

  private tryReconnect(): void {
    const token = this.auth.token();
    if (!token) {
      console.warn('[WS] No token available for reconnection');
      this.disconnect();
      return;
    }

    if (this.socket?.connected) {
      this.socket.auth = { token };
      this.socket.disconnect().connect();
      console.log('[WS] Reconnected with refreshed token');
    }

    this.setupAutoReconnect();
  }

  private decodeJwtPayload(token: string): any | null {
    try {
      const base64Url = token.split('.')[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(base64));
    } catch {
      return null;
    }
  }

  private handleIncomingEvent(eventType: string, data: CaptureEvent | BatchCaptureEvent): void {
    this.lastEvent.set(eventType);
    this.lastEventTime.set(new Date());

    if ('batch' in data && data.batch) {
      console.log(`[WS] ${eventType} batch received: ${data.count} events`);
      for (const event of data.events) {
        this.emitSingleEvent(eventType, event);
      }
    } else {
      this.emitSingleEvent(eventType, data as CaptureEvent);
    }
  }

  private emitSingleEvent(eventType: string, data: CaptureEvent): void {
    switch (eventType) {
      case 'capture:created':
        this.captureCreated$.next(data);
        break;
      case 'capture:synced':
        this.captureSynced$.next(data);
        break;
      case 'capture:deleted':
        this.captureDeleted$.next(data);
        break;
    }
    this.rawCaptureEvent$.next(data);
  }

  connect(token: string): void {
    if (this.socket?.connected) {
      console.log('[WS] Already connected');
      return;
    }

    const wsUrl = environment.apiUrl.replace('/api', '');
    console.log('[WS] Connecting to:', wsUrl);

    this.socket = io(wsUrl, {
      path: '/reports/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
    });

    this.socket.on('connect', () => {
      console.log('[WS] Connected to /reports namespace');
      this.connected.set(true);
    });

    this.socket.on('disconnect', (reason) => {
      console.log('[WS] Disconnected:', reason);
      this.connected.set(false);
    });

    this.socket.on('connect_error', (error) => {
      console.warn('[WS] Connection error:', error.message);
      this.connected.set(false);
    });

    this.socket.on('capture:created', (data: CaptureEvent | BatchCaptureEvent) => {
      this.handleIncomingEvent('capture:created', data);
    });

    this.socket.on('capture:synced', (data: CaptureEvent | BatchCaptureEvent) => {
      this.handleIncomingEvent('capture:synced', data);
    });

    this.socket.on('capture:deleted', (data: CaptureEvent | BatchCaptureEvent) => {
      this.handleIncomingEvent('capture:deleted', data);
    });

    this.socket.on('metrics:updated', (data: MetricsUpdateEvent) => {
      console.log('[WS] metrics:updated received');
      this.lastEvent.set('metrics:updated');
      this.lastEventTime.set(new Date());
      this.metricsUpdated$.next(data);
    });

    this.setupAutoReconnect();
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.connected.set(false);
      console.log('[WS] Disconnected manually');
    }
  }

  get captureCreated(): Observable<CaptureEvent> {
    return this.captureCreated$.asObservable();
  }

  get captureSynced(): Observable<CaptureEvent> {
    return this.captureSynced$.asObservable();
  }

  get captureDeleted(): Observable<CaptureEvent> {
    return this.captureDeleted$.asObservable();
  }

  get metricsUpdated(): Observable<MetricsUpdateEvent> {
    return this.metricsUpdated$.asObservable();
  }

  get anyCaptureEvent(): Observable<CaptureEvent> {
    return merge(
      this.captureCreated$,
      this.captureSynced$,
      this.captureDeleted$
    );
  }

  get debouncedCaptureEvent(): Observable<DebouncedCaptureEvent> {
    return this.rawCaptureEvent$.pipe(
      buffer(this.rawCaptureEvent$.pipe(debounceTime(this.DEBOUNCE_MS))),
      filter(events => events.length > 0),
      map((events) => ({
        events,
        count: events.length,
        types: new Set(events.map(e => e.type)),
      }))
    );
  }
}