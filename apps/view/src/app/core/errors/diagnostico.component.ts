import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AppErrorService } from './app-error.service';
import { DiagnosticsRecorderService } from './diagnostics-recorder.service';
import { environment } from '../../../environments/environment';

/**
 * Diagnóstico de un cuelgue, en un clic.
 *
 * Existe porque perseguir este tipo de falla desde afuera no funciona. Los logs del
 * servidor decían que todo respondía en milisegundos mientras la pantalla se quedaba
 * pensando: el cuello estaba en el navegador —descargas compitiendo entre sí, un service
 * worker sirviendo una versión vieja, el hilo principal bloqueado— y nada de eso se ve
 * desde el backend. Cada vuelta costaba una hipótesis y un deploy.
 *
 * Esto lo da vuelta: mide DONDE pasa, arma un solo texto y lo deja en el portapapeles.
 * No hace falta DevTools ni saber qué mirar.
 */
@Component({
  selector: 'app-diagnostico',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    <div class="dg">
      <header class="dg-head">
        <h1>Diagnóstico</h1>
        <p class="dg-sub">
          Abrí esta pantalla <strong>después</strong> de que algo se quede colgado. La grabación
          corre desde que arranca la app y sobrevive a la recarga, así que lo importante
          —navegaciones y peticiones que nunca terminaron— queda registrado igual.
          Tocá <strong>Copiar diagnóstico</strong> y mandá el texto.
        </p>
      </header>

      <div class="dg-actions">
        <button type="button" class="dg-btn" (click)="run()" [disabled]="running()">
          {{ running() ? 'Midiendo…' : 'Medir de nuevo' }}
        </button>
        <button type="button" class="dg-btn dg-btn-primary" (click)="copy()" [disabled]="!report()">
          {{ copied() ? '✓ Copiado' : 'Copiar diagnóstico' }}
        </button>
      </div>

      @if (report(); as r) {
        <div class="dg-cards">
          @for (c of cards(); track c.k) {
            <div class="dg-card" [class.bad]="c.bad">
              <span class="dg-k">{{ c.k }}</span>
              <span class="dg-v">{{ c.v }}</span>
            </div>
          }
        </div>
        <pre class="dg-pre">{{ r }}</pre>
      } @else {
        <p class="dg-empty">Midiendo el estado de esta pestaña…</p>
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .dg { padding:1.5rem; max-width:70rem; margin:0 auto; display:flex; flex-direction:column; gap:1rem; }
    .dg-head h1 { margin:0; font-size:1.4rem; color:var(--text-main); }
    .dg-sub { margin:.3rem 0 0; font-size:.88rem; color:var(--text-muted); max-width:48rem; line-height:1.55; }
    .dg-actions { display:flex; gap:.6rem; flex-wrap:wrap; }
    .dg-btn { font:inherit; font-size:.86rem; padding:.45rem .9rem; cursor:pointer;
      border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); color:var(--text-main); }
    .dg-btn:hover:not(:disabled) { border-color:var(--action); color:var(--action); }
    .dg-btn:disabled { opacity:.55; cursor:default; }
    .dg-btn-primary { border-color:var(--action); color:var(--action); font-weight:600; }
    .dg-cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(13rem,1fr)); gap:.6rem; }
    .dg-card { border:1px solid var(--border-color); border-left:3px solid var(--border-color);
      border-radius:var(--r-md); padding:.55rem .7rem; display:flex; flex-direction:column; gap:.15rem; }
    .dg-card.bad { border-left-color:var(--bad-fg); }
    .dg-k { font-size:.66rem; text-transform:uppercase; letter-spacing:.04em; color:var(--text-faint); }
    .dg-v { font-size:.9rem; color:var(--text-main); font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
    .dg-pre { margin:0; padding:.9rem; border:1px solid var(--border-color); border-radius:var(--r-md);
      background:var(--surface-ground); font-family:var(--font-mono); font-size:.72rem; line-height:1.5;
      white-space:pre-wrap; overflow-wrap:anywhere; max-height:34rem; overflow:auto; }
    .dg-empty { color:var(--text-faint); font-size:.88rem; }
  `],
})
export class DiagnosticoComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly errors = inject(AppErrorService);
  private readonly rec = inject(DiagnosticsRecorderService);

  readonly report = signal<string | null>(null);
  readonly running = signal(false);
  readonly copied = signal(false);
  readonly cards = signal<{ k: string; v: string; bad?: boolean }[]>([]);

  ngOnInit(): void { void this.run(); }

  async run(): Promise<void> {
    this.running.set(true);
    try {
      const [sw, ping, server] = await Promise.all([this.swState(), this.pingApi(), this.serverInfo()]);
      const res = this.resources();
      const nav = this.navigation();
      // Lo grabado EN VIVO: es lo unico que sobrevive a la navegacion y a la recarga.
      // Una entrada sin duracion es, literalmente, lo que se quedo colgado.
      const snap = this.rec.snapshot();
      const stuckNav = snap.events.filter((e) => e.t === 'nav' && e.ms === null);
      const stuckReq = snap.events.filter((e) => e.t === 'req' && e.ms === null);
      const slowReq = snap.events.filter((e) => e.t === 'req' && (e.ms ?? 0) > 3000);

      // El desfase entre lo que sirve el servidor y lo que ejecuta esta pestaña es el
      // dato que más veces nos hizo perder tiempo: si no coinciden, se está probando
      // una versión que ya no existe.
      const bundle = this.bundleHash();
      const stale = !!server.bundle && !!bundle && server.bundle !== bundle;

      this.cards.set([
        { k: 'Versión que ejecuta', v: bundle || '—', bad: stale },
        { k: 'Versión que sirve', v: server.bundle || '—', bad: stale },
        { k: 'Commit del servidor', v: (server.commit || '—').slice(0, 8) },
        { k: 'Service worker', v: sw.summary, bad: sw.stale },
        { k: 'Peticiones de esta página', v: `${res.count} · ${res.mb} MB` },
        { k: 'Sin terminar', v: String(res.pending), bad: res.pending > 0 },
        { k: 'Recurso más lento', v: `${res.slowest.dur} · ${res.slowest.name}`, bad: res.slowest.ms > 5000 },
        { k: 'Bloqueo del hilo', v: `${snap.longTaskMs} ms en ${snap.longTaskN} (mayor ${snap.longTaskMax} ms)`, bad: snap.longTaskMax > 1000 },
        { k: 'Segundos con la UI trabada', v: String(snap.freezes.length), bad: snap.freezes.length > 0 },
        { k: 'Navegaciones sin terminar', v: String(stuckNav.length), bad: stuckNav.length > 0 },
        { k: 'Peticiones sin responder', v: String(stuckReq.length), bad: stuckReq.length > 0 },
        { k: 'Ping a la API (mediana)', v: ping.median, bad: ping.medianMs > 1500 },
        { k: 'Conexión', v: this.connection() },
      ]);

      this.report.set([
        `— DIAGNÓSTICO ${new Date().toISOString()} —`,
        `pantalla anterior : ${document.referrer || '(entrada directa)'}`,
        `url               : ${location.pathname}${location.search}`,
        `navegador         : ${navigator.userAgent}`,
        `conexión          : ${this.connection()}`,
        '',
        `VERSIÓN`,
        `  ejecuta : ${bundle || '—'}`,
        `  sirve   : ${server.bundle || '—'}${stale ? '   ⚠ DESFASADAS — esta pestaña corre código viejo' : ''}`,
        `  commit  : ${server.commit || '—'}`,
        '',
        `SERVICE WORKER`,
        `  ${sw.detail}`,
        '',
        `CARGA DE LA PÁGINA`,
        `  navegación      : ${nav}`,
        `  peticiones      : ${res.count} (${res.mb} MB transferidos)`,
        `  sin terminar    : ${res.pending}`,
        '',
        `LAS 12 MÁS LENTAS`,
        ...res.top.map((t) => `  ${t.dur.padStart(9)}  ${t.size.padStart(9)}  ${t.name}`),
        '',
        `GRABADO EN VIVO (desde ${snap.since})`,
        `  navegaciones SIN TERMINAR : ${stuckNav.length}`,
        ...stuckNav.map((e) => `    ⚠ ${e.at}  ${e.url}`),
        `  peticiones SIN RESPONDER  : ${stuckReq.length}`,
        ...stuckReq.map((e) => `    ⚠ ${e.at}  ${e.url}`),
        `  peticiones lentas (>3s)   : ${slowReq.length}`,
        ...slowReq.slice(-10).map((e) => `    ${String(e.ms).padStart(6)} ms  ${e.out ?? ''}  ${e.url}`),
        `  bloqueo del hilo          : ${snap.longTaskMs} ms en ${snap.longTaskN} tareas (la mayor ${snap.longTaskMax} ms)`,
        `  segundos con la UI trabada: ${snap.freezes.length}`,
        ...snap.freezes.slice(-12).map((f) => `    ${f.at.slice(11, 19)}  ${String(f.fps).padStart(2)} fps  salto ${String(f.gapMs).padStart(5)} ms  ${f.url}`),
        '',
        `ÚLTIMAS ${Math.min(20, snap.events.length)} OPERACIONES`,
        ...snap.events.slice(-20).map((e) =>
          `  ${e.at.slice(11, 23)}  ${e.t === 'nav' ? 'NAV ' : 'HTTP'}  ${(e.ms === null ? 'COLGADA' : e.ms + ' ms').padStart(9)}  ${e.out ?? ''}  ${e.url}`),
        '',
        `PING A LA API (5 intentos)`,
        `  ${ping.detail}`,
        '',
        `ÚLTIMOS ERRORES`,
        ...(this.errors.recent().length
          ? this.errors.recent().slice(0, 5).map((e) => `  ${e.id}  ${e.at ?? ''}  ${e.url ?? ''}  ${e.message}`)
          : ['  (ninguno registrado)']),
      ].join('\n'));
    } finally {
      this.running.set(false);
    }
  }

  copy(): void {
    const t = this.report();
    if (!t) return;
    const done = () => { this.copied.set(true); setTimeout(() => this.copied.set(false), 2500); };
    navigator.clipboard?.writeText(t).then(done).catch(() => { console.info(t); done(); });
  }

  // ── medidas ───────────────────────────────────────────────────────────

  /** Hash del bundle que esta pestaña está ejecutando (sale del <script> cargado). */
  private bundleHash(): string {
    const s = Array.from(document.querySelectorAll('script[src]'))
      .map((e) => (e as HTMLScriptElement).src)
      .find((u) => /\/main-[A-Za-z0-9_-]+\.js/.test(u));
    return s ? (s.match(/main-[A-Za-z0-9_-]+\.js/) || [''])[0] : '';
  }

  /** Qué versión sirve HOY el servidor, y con qué commit se construyó. */
  private async serverInfo(): Promise<{ bundle: string; commit: string }> {
    try {
      const [html, health] = await Promise.all([
        fetch('/index.html', { cache: 'no-store' }).then((r) => r.text()),
        firstValueFrom(this.http.get<{ commit?: string }>(`${environment.apiUrl}/health`)).catch(() => ({ commit: '' })),
      ]);
      return { bundle: (html.match(/main-[A-Za-z0-9_-]+\.js/) || [''])[0], commit: health?.commit || '' };
    } catch { return { bundle: '', commit: '' }; }
  }

  private async swState(): Promise<{ summary: string; detail: string; stale: boolean }> {
    if (!('serviceWorker' in navigator)) return { summary: 'no soportado', detail: 'no soportado', stale: false };
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      if (!regs.length) return { summary: 'sin registrar', detail: 'sin registrar', stale: false };
      const lines: string[] = [];
      let waiting = false;
      for (const r of regs) {
        if (r.waiting) waiting = true;
        lines.push(`scope=${r.scope} activo=${r.active?.state ?? '—'} esperando=${r.waiting ? 'SÍ (hay versión nueva sin aplicar)' : 'no'} instalando=${r.installing ? 'sí' : 'no'}`);
      }
      return {
        summary: waiting ? 'versión nueva SIN aplicar' : `${regs.length} registro(s), al día`,
        detail: lines.join('\n  '),
        stale: waiting,
      };
    } catch (e) { return { summary: 'error', detail: String(e), stale: false }; }
  }

  /** Mide la API DESDE ESTA PESTAÑA: es lo único comparable con lo que sufre el usuario. */
  private async pingApi(): Promise<{ median: string; medianMs: number; detail: string }> {
    const ms: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      try { await fetch(`${environment.apiUrl}/health`, { cache: 'no-store' }); } catch { /* se cuenta igual */ }
      ms.push(Math.round(performance.now() - t0));
    }
    const sorted = [...ms].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    return { median: `${med} ms`, medianMs: med, detail: `${ms.join(' / ')} ms` };
  }

  private navigation(): string {
    const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (!n) return '—';
    return `DOM listo ${Math.round(n.domContentLoadedEventEnd)} ms · load ${Math.round(n.loadEventEnd)} ms · tipo ${n.type}`;
  }

  private resources() {
    const es = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    let bytes = 0;
    for (const e of es) bytes += e.transferSize || 0;
    // responseEnd 0 con la entrada ya creada = la petición nunca cerró.
    const pending = es.filter((e) => e.responseEnd === 0).length;
    const sorted = [...es].sort((a, b) => b.duration - a.duration);
    const fmt = (e: PerformanceResourceTiming) => ({
      name: e.name.replace(location.origin, ''),
      dur: `${Math.round(e.duration)} ms`,
      ms: e.duration,
      size: e.transferSize ? `${Math.round(e.transferSize / 1024)} KB` : '—',
    });
    return {
      count: es.length,
      mb: (bytes / 1048576).toFixed(2),
      pending,
      top: sorted.slice(0, 12).map(fmt),
      slowest: sorted.length ? fmt(sorted[0]) : { name: '—', dur: '—', ms: 0, size: '—' },
    };
  }

  private connection(): string {
    const c = (navigator as unknown as { connection?: { effectiveType?: string; downlink?: number; rtt?: number } }).connection;
    return c ? `${c.effectiveType ?? '?'} · ${c.downlink ?? '?'} Mbps · rtt ${c.rtt ?? '?'} ms` : 'no informada';
  }

  // Las tareas largas las cuenta la grabadora, que arranca con la app. Medirlas acá
  // solo veía las de esta pantalla — que es justamente la que NO se cuelga.
}
