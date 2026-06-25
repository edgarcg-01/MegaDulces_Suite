import { Injectable, NgZone, inject } from '@angular/core';
import { onCLS, onINP, onLCP, onFCP, onTTFB, type Metric } from 'web-vitals';
import { environment } from '../../../environments/environment';
import { AuthService } from '../services/auth.service';

/**
 * Observabilidad del Portal B2B (área de mejora #1 del review CEO).
 *
 * Recolecta 3 familias de señal y las manda al backend en lotes vía
 * `navigator.sendBeacon` (no bloquea la navegación, sobrevive al cierre de tab):
 *
 *   1. RUM / Core Web Vitals — LCP, INP, CLS, FCP, TTFB (lib oficial web-vitals).
 *      Es el estándar que miden Uber/Rappi para performance percibida.
 *   2. Errores — uncaught + unhandledrejection (vía GlobalErrorHandler) + http.
 *   3. Funnel de negocio — eventos `track(name, props)` (ver catálogo → add → confirm).
 *
 * Sink: POST a `${apiUrl}/telemetry/portal`. ⚠️ Ese endpoint vive en el backend
 * (Trade_marketing) y aún no existe — mientras tanto el beacon falla en silencio
 * (es intencional: cero impacto en el usuario). En dev también loguea a consola.
 *
 *   ── HANDOFF BACKEND ──────────────────────────────────────────────────────
 *   Crear `POST /telemetry/portal` que reciba `{ events: TelemetryEvent[] }`,
 *   los persista (tabla append-only o time-series) y exponga dashboards de
 *   p75/p99 de cada vital + tasa de error + funnel. Sin auth estricta (el
 *   beacon puede salir post-logout); rate-limit por IP.
 */

export type TelemetryKind = 'web_vital' | 'error' | 'event';

export interface TelemetryEvent {
  kind: TelemetryKind;
  name: string;
  value?: number;
  rating?: string;
  props?: Record<string, unknown>;
  ts: number;
  url: string;
  session_id: string;
  env: string;
  release: string;
}

const ENDPOINT = `${environment.apiUrl}/telemetry/portal`;
const SAMPLE_RATE = (environment as any).telemetry?.sampleRate ?? 1;
const DEBUG = !environment.production;
const MAX_BATCH = 20;
const FLUSH_INTERVAL_MS = 15_000;

@Injectable({ providedIn: 'root' })
export class TelemetryService {
  private readonly zone = inject(NgZone);
  private readonly auth = inject(AuthService);

  /** Una sesión = una carga de página. Permite agrupar vitals+errores+eventos. */
  private readonly sessionId = this.makeId();
  /** Muestreo por sesión: si cae fuera, todo el tracking de esta sesión es no-op. */
  private readonly sampled = Math.random() < SAMPLE_RATE;
  private buffer: TelemetryEvent[] = [];
  private started = false;

  /** Llamar una vez al boot (APP_INITIALIZER). Idempotente. */
  init(): void {
    if (this.started || !this.sampled || typeof window === 'undefined') return;
    this.started = true;

    // Fuera de la zona de Angular: estos callbacks no deben disparar change
    // detection (no tocan UI). Evita re-renders fantasma por cada vital.
    this.zone.runOutsideAngular(() => {
      const report = (m: Metric) =>
        this.enqueue({
          kind: 'web_vital',
          name: m.name,
          value: Math.round(m.value * 1000) / 1000,
          rating: m.rating,
          props: { id: m.id, navigationType: m.navigationType },
          ...this.envelope(),
        });

      onLCP(report);
      onINP(report);
      onCLS(report);
      onFCP(report);
      onTTFB(report);

      // Flush en los momentos correctos: cuando la página se oculta/cierra
      // (web-vitals finaliza ahí) y periódicamente para eventos de funnel.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flush('hidden');
      });
      window.addEventListener('pagehide', () => this.flush('pagehide'));
      setInterval(() => this.flush('interval'), FLUSH_INTERVAL_MS);
    });
  }

  /** Evento de funnel de negocio. Ej: track('cart_line_added', { product_id }). */
  track(name: string, props?: Record<string, unknown>): void {
    if (!this.sampled) return;
    this.enqueue({ kind: 'event', name, props, ...this.envelope() });
  }

  /** Reporta un error (lo usa GlobalErrorHandler y el interceptor http). */
  trackError(name: string, props?: Record<string, unknown>): void {
    if (!this.sampled) return;
    this.enqueue({ kind: 'error', name, props, ...this.envelope() });
  }

  // ── internos ──────────────────────────────────────────────────────────────

  private envelope() {
    return {
      ts: Date.now(),
      url: location.pathname,
      session_id: this.sessionId,
      env: environment.envName,
      release: (environment as any).release ?? 'portal@1.0.0',
    };
  }

  private enqueue(ev: TelemetryEvent): void {
    if (DEBUG) console.debug('[telemetry]', ev.kind, ev.name, ev.value ?? ev.props ?? '');
    this.buffer.push(ev);
    if (this.buffer.length >= MAX_BATCH) this.flush('batch');
  }

  private flush(_reason: string): void {
    if (!this.buffer.length) return;
    const events = this.buffer;
    this.buffer = [];
    // Atribución: sendBeacon NO puede mandar header Authorization, así que
    // embebemos tenant_id/user_id del JWT en el payload (el backend los lee de
    // ahí). Si no hay sesión (login page), van null → telemetría anónima.
    const u = this.auth.user();
    const payload = JSON.stringify({
      events,
      tenant_id: (u as any)?.tenant_id ?? null,
      user_id: u?.sub ?? null,
    });

    try {
      // sendBeacon SIEMPRE manda con credentials mode 'include' (por spec). En
      // prod es mismo-origen (nginx proxya /api) → sin CORS, ideal por su
      // confiabilidad en unload. En dev es cross-origin (4200→3334) y el backend
      // responde ACAO '*', que el navegador rechaza si las credenciales son
      // 'include' → preflight bloqueado. Telemetría NO necesita credenciales
      // (tenant_id/user_id van en el payload), así que en dev usamos fetch con
      // credentials:'omit' para que el wildcard sea aceptado.
      const blob = new Blob([payload], { type: 'application/json' });
      if (environment.production && navigator.sendBeacon?.(ENDPOINT, blob)) return;
      fetch(ENDPOINT, {
        method: 'POST',
        body: payload,
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        credentials: 'omit',
      }).catch(() => void 0);
    } catch {
      // Telemetría nunca debe romper la app. Tragamos el error a propósito.
    }
  }

  private makeId(): string {
    try {
      return crypto.randomUUID();
    } catch {
      return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
  }
}
