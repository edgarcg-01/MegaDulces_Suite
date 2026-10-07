import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthService } from './auth.service';
import { WebSocketService } from './websocket.service';
import { MapMarker } from '../../shared/components/map/map.component';
import { Freshness, freshnessColor, freshnessOf, relativeAge } from '../../shared/util/relative-age';

export interface LivePosition {
  user_id: string;
  username: string;
  lat: number;
  lng: number;
  captured_at: string;
  speed_mps: number | null;
  accuracy_m: number | null;
  route_id: string | null;
  source: string | null;
}

/**
 * Capa de posiciones EN VIVO reutilizable (MapKit). Generaliza el antiguo
 * LiveTrackingService: arranca con el seed HTTP /reports/live-positions y
 * mantiene un signal Map<userId,pos> alimentado por el evento WS `route_ping`.
 * La frescura se deriva de `captured_at` contra un reloj local que tickea cada
 * 15s. Reusable por live-map y por cualquier vista que quiera una capa de
 * personal en vivo (commercial-map, routes-analysis, flota).
 */
@Injectable()
export class MapLiveLayerService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private ws = inject(WebSocketService);

  private readonly _positions = signal<Map<string, LivePosition>>(new Map());
  private readonly _now = signal(Date.now());
  private clockTimer: any = null;
  private wsSub: { unsubscribe(): void } | null = null;

  readonly positions = computed(() => Array.from(this._positions().values()));
  readonly now = this._now.asReadonly();

  readonly counts = computed(() => {
    const now = this._now();
    let online = 0, idle = 0, stale = 0;
    for (const p of this._positions().values()) {
      const f = freshnessOf(new Date(p.captured_at).getTime(), now);
      if (f === 'online') online++;
      else if (f === 'idle') idle++;
      else stale++;
    }
    return { online, idle, stale, total: this._positions().size };
  });

  freshness(p: LivePosition): Freshness {
    return freshnessOf(new Date(p.captured_at).getTime(), this._now());
  }

  ageLabel(p: LivePosition): string {
    return relativeAge(new Date(p.captured_at).getTime(), this._now());
  }

  /** Posiciones como marcadores del átomo (kind 'user', color/ring por frescura). */
  markers(): MapMarker[] {
    return this.positions().map((p) => {
      const f = this.freshness(p);
      const spd = p.speed_mps != null ? ` · ${Math.round(p.speed_mps * 3.6)} km/h` : '';
      return {
        id: p.user_id,
        lat: p.lat,
        lng: p.lng,
        kind: 'user' as const,
        color: freshnessColor(f),
        ring: f === 'online',
        title: `<b>${p.username}</b><br>${this.ageLabel(p)}${spd}`,
      };
    });
  }

  async start(sinceMin = 30): Promise<void> {
    const token = this.auth.token();
    if (token) this.ws.connect(token);

    try {
      const params = new HttpParams().set('since_min', String(sinceMin));
      const res = await firstValueFrom(
        this.http.get<{ positions: LivePosition[] }>(
          `${environment.apiUrl}/reports/live-positions`,
          { params },
        ),
      );
      const m = new Map<string, LivePosition>();
      for (const p of res?.positions || []) m.set(p.user_id, p);
      this._positions.set(m);
    } catch {
      /* sin seed: se llena con los pings que lleguen */
    }

    this.wsSub = this.ws.routePing.subscribe((ping) => {
      if (!Number.isFinite(ping?.lat) || !Number.isFinite(ping?.lng)) return;
      const m = new Map(this._positions());
      m.set(ping.userId, {
        user_id: ping.userId,
        username: ping.username || m.get(ping.userId)?.username || '—',
        lat: ping.lat,
        lng: ping.lng,
        captured_at: ping.capturedAt,
        speed_mps: ping.speedMps ?? null,
        accuracy_m: ping.accuracyM ?? null,
        route_id: ping.routeId ?? null,
        source: ping.source ?? null,
      });
      this._positions.set(m);
    });

    if (!this.clockTimer) {
      this.clockTimer = setInterval(() => this._now.set(Date.now()), 15_000);
    }
  }

  /** Sube la cadencia on-demand de los usuarios observados (lista vacía = ninguno). */
  watch(userIds: string[]): void {
    this.ws.watchUsers(userIds);
  }

  stop(): void {
    this.wsSub?.unsubscribe();
    this.wsSub = null;
    if (this.clockTimer) { clearInterval(this.clockTimer); this.clockTimer = null; }
  }
}
