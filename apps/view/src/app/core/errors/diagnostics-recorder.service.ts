import { Injectable, inject } from '@angular/core';
import { Router, NavigationCancel, NavigationEnd, NavigationError, NavigationStart } from '@angular/router';

/**
 * Grabadora de lo que pasa MIENTRAS la app se usa.
 *
 * El primer intento de diagnóstico medía al abrir la pantalla de diagnóstico, y eso no
 * sirve: `performance.getEntriesByType('resource')` solo ve el documento actual, así que
 * al navegar a /diagnostico se perdía justo la evidencia de la pantalla que se colgó. El
 * usuario terminaba mandando la foto de una carga sana.
 *
 * Esto graba en vivo y guarda en `localStorage`, así que sobrevive a la navegación, a la
 * recarga, y a abrir el diagnóstico en otra pestaña. Lo que importa capturar es:
 *
 *  - **Navegaciones sin final.** Una entrada con `ms: null` es literalmente el cuelgue:
 *    el router arrancó y nunca llegó. Es el dato que ninguna medición del servidor da.
 *  - **Peticiones sin respuesta.** Igual: `ms: null` = quedó colgada.
 *  - **Bloqueo del hilo principal**, que congela la interfaz sin que falle nada.
 *
 * Se escribe con throttle y tope de tamaño: una grabadora que perjudica lo que mide no
 * sirve de nada.
 */

export interface DiagEvent {
  /** Qué fue: navegación de ruta o petición HTTP. */
  t: 'nav' | 'req';
  url: string;
  /** Hora de inicio (ISO). */
  at: string;
  /** Duración en ms, o null si NUNCA terminó — eso es lo que buscamos. */
  ms: number | null;
  /** Estado HTTP, o el desenlace de la navegación (end/cancel/error). */
  out?: string;
}

export interface DiagSnapshot {
  events: DiagEvent[];
  longTaskMs: number;
  longTaskN: number;
  /** Tarea larga más grande vista (ms): un solo bloqueo enorme cuenta distinto que muchos chicos. */
  longTaskMax: number;
  since: string;
}

const KEY = 'app_diag';
const MAX_EVENTS = 60;
const FLUSH_MS = 1000;

@Injectable({ providedIn: 'root' })
export class DiagnosticsRecorderService {
  private readonly router = inject(Router);

  private events: DiagEvent[] = [];
  private longTaskMs = 0;
  private longTaskN = 0;
  private longTaskMax = 0;
  private since = new Date().toISOString();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  /** Arranca la grabación. Idempotente: la llama AppComponent al iniciar. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.restore();
    this.watchRouter();
    this.watchLongTasks();
    // Un cuelgue suele terminar en recarga o en cerrar la pestaña: hay que dejar
    // el registro escrito ANTES de eso, no después.
    addEventListener('pagehide', () => this.flush(true));
    addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.flush(true); });
  }

  /** Marca el inicio de algo y devuelve la función que lo cierra. */
  begin(t: DiagEvent['t'], url: string): (out?: string) => void {
    const ev: DiagEvent = { t, url, at: new Date().toISOString(), ms: null };
    const t0 = performance.now();
    this.push(ev);
    let closed = false;
    return (out?: string) => {
      if (closed) return;
      closed = true;
      ev.ms = Math.round(performance.now() - t0);
      ev.out = out;
      this.schedule();
    };
  }

  snapshot(): DiagSnapshot {
    const stored = this.read();
    // Lo grabado en esta sesión manda sobre lo persistido (puede ser más reciente).
    const seen = new Set(this.events.map((e) => e.t + e.at + e.url));
    const merged = [...stored.events.filter((e) => !seen.has(e.t + e.at + e.url)), ...this.events];
    return {
      events: merged.slice(-MAX_EVENTS),
      longTaskMs: Math.max(this.longTaskMs, stored.longTaskMs),
      longTaskN: Math.max(this.longTaskN, stored.longTaskN),
      longTaskMax: Math.max(this.longTaskMax, stored.longTaskMax),
      since: stored.since < this.since ? stored.since : this.since,
    };
  }

  clear(): void {
    this.events = [];
    this.longTaskMs = this.longTaskN = this.longTaskMax = 0;
    this.since = new Date().toISOString();
    try { localStorage.removeItem(KEY); } catch { /* sin storage: se sigue grabando en memoria */ }
  }

  // ── interno ───────────────────────────────────────────────────────────

  private watchRouter(): void {
    let close: ((out?: string) => void) | null = null;
    this.router.events.subscribe((e) => {
      if (e instanceof NavigationStart) {
        // Si la anterior seguía abierta, queda con ms=null a propósito: eso ES el hallazgo.
        close = this.begin('nav', e.url);
      } else if (e instanceof NavigationEnd) { close?.('end'); close = null; }
      else if (e instanceof NavigationCancel) { close?.('cancel'); close = null; }
      else if (e instanceof NavigationError) { close?.('error'); close = null; }
    });
  }

  private watchLongTasks(): void {
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          const d = Math.round(e.duration);
          this.longTaskMs += d; this.longTaskN++;
          if (d > this.longTaskMax) this.longTaskMax = d;
        }
        this.schedule();
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* Safari no lo soporta */ }
  }

  private push(ev: DiagEvent): void {
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.schedule();
  }

  private schedule(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, FLUSH_MS);
  }

  private flush(now = false): void {
    if (now && this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    try { localStorage.setItem(KEY, JSON.stringify(this.snapshot())); }
    catch { /* storage lleno: la grabación en memoria sigue viva */ }
  }

  private read(): DiagSnapshot {
    try {
      const raw = localStorage.getItem(KEY);
      const s = raw ? JSON.parse(raw) : null;
      if (s && Array.isArray(s.events)) return s as DiagSnapshot;
    } catch { /* json corrupto: se arranca de cero */ }
    return { events: [], longTaskMs: 0, longTaskN: 0, longTaskMax: 0, since: this.since };
  }

  private restore(): void {
    const s = this.read();
    this.since = s.since || this.since;
  }
}
