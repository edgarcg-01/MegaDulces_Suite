import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { AuthService } from '../../../core/services/auth.service';
import { WebSocketService } from '../../../core/services/websocket.service';

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
 * Estado del mapa en vivo: arranca con el seed HTTP (última posición por usuario)
 * y luego mantiene un signal Map<userId, posición> que se actualiza con cada
 * `route_ping` que llega por WebSocket. La frescura (online/idle/stale) se deriva
 * de `captured_at` contra `now`.
 */
@Injectable()
export class LiveTrackingService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private ws = inject(WebSocketService);

  private readonly _positions = signal<Map<string, LivePosition>>(new Map());
  /** tick de reloj para recomputar frescura sin esperar un ping nuevo. */
  private readonly _now = signal(Date.now());
  private clockTimer: any = null;
  private wsSub: { unsubscribe(): void } | null = null;

  /** Umbrales de frescura (ms). */
  static readonly ONLINE_MS = 90_000; // < 1.5 min → en línea (verde)
  static readonly IDLE_MS = 6 * 60_000; // < 6 min → inactivo (ámbar); más → stale (gris)

  readonly positions = computed(() => Array.from(this._positions().values()));
  readonly now = this._now.asReadonly();

  readonly counts = computed(() => {
    const now = this._now();
    let online = 0, idle = 0, stale = 0;
    for (const p of this._positions().values()) {
      const age = now - new Date(p.captured_at).getTime();
      if (age < LiveTrackingService.ONLINE_MS) online++;
      else if (age < LiveTrackingService.IDLE_MS) idle++;
      else stale++;
    }
    return { online, idle, stale, total: this._positions().size };
  });

  freshness(p: LivePosition): 'online' | 'idle' | 'stale' {
    const age = this._now() - new Date(p.captured_at).getTime();
    if (age < LiveTrackingService.ONLINE_MS) return 'online';
    if (age < LiveTrackingService.IDLE_MS) return 'idle';
    return 'stale';
  }

  async start(sinceMin = 30): Promise<void> {
    const token = this.auth.token();
    if (token) this.ws.connect(token);

    // Seed: última posición conocida por usuario.
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
      /* sin seed: el mapa se llena con los pings que vayan llegando */
    }

    // Stream en vivo.
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

  stop(): void {
    this.wsSub?.unsubscribe();
    this.wsSub = null;
    if (this.clockTimer) { clearInterval(this.clockTimer); this.clockTimer = null; }
  }
}
