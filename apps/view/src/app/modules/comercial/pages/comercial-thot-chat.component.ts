import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { trigger, transition, style, animate } from '@angular/animations';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ButtonModule } from 'primeng/button';
import { ComercialService, ThotChatTurn, ThotToolTrace } from '../comercial.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { ANALYTICS_TABS } from '../analytics-tabs';

/** Mensaje en la UI: turno + (para assistant) bloques de datos de las tools. */
interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  blocks?: DataBlock[];
  pending?: boolean;
  error?: boolean;
}
type ColType = 'text' | 'num' | 'currency' | 'percent';
interface ColMeta { key: string; label: string; type: ColType; }
interface KpiStat { label: string; value: string; }
interface DataBlock {
  title: string;
  icon: string;
  cols: ColMeta[];
  rows: Record<string, any>[];
  extra: number;
  total: number;
  barKey: string | null;   // columna numérica dominante (mini-barras)
  barMax: number;
  kpis: KpiStat[] | null;   // si está → render como KPI strip (resultado de 1 fila)
}

const SUGGESTIONS = [
  '¿Cuánto se vendió en los últimos 30 días?',
  'Top 10 productos más vendidos este mes',
  '¿Qué productos están en rotura de stock?',
  'Margen por categoría del último trimestre',
  'Clientes inactivos hace más de 30 días',
  '¿Cómo va la marca Kinder en ventas?',
];

/**
 * TC.3 (ADR-026) — "Pregúntale a Thot": analítica conversacional sobre ventas.
 * El backend orquesta tools deterministas (RLS) y narra; acá mostramos la
 * respuesta + las tablas de datos que las tools devolvieron (transparencia).
 */
@Component({
  selector: 'app-comercial-thot-chat',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, PageTabsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [
    // Entrada/salida de mensajes — "materializan" con blur-rise + leve overshoot
    // (estilo Gemini/Claude/ChatGPT). El blur en la entrada da el efecto flotante.
    trigger('msg', [
      transition(':enter', [
        style({ opacity: 0, transform: 'translateY(14px) scale(0.985)', filter: 'blur(7px)' }),
        animate('440ms cubic-bezier(0.22, 1, 0.36, 1)',
          style({ opacity: 1, transform: 'none', filter: 'blur(0)' })),
      ]),
      transition(':leave', [
        animate('220ms ease',
          style({ opacity: 0, transform: 'translateY(-8px) scale(0.97)' })),
      ]),
    ]),
  ],
  template: `
    <div class="surf-page in tc-page">
      <app-page-tabs [tabs]="tabs" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Pregúntale a Thot</h1>
          <p class="surf-page-sub">Preguntá en lenguaje natural sobre ventas, inventario, clientes y márgenes. Los números salen de datos reales.</p>
        </div>
        @if (messages().length > 0) {
          <button pButton icon="pi pi-eraser" label="Nueva consulta" [text]="true" severity="secondary" size="small" (click)="reset()"></button>
        }
      </header>

      <div class="tc-thread" #thread [@.disabled]="reduce">
        @if (messages().length === 0) {
          <div class="tc-empty">
            <div class="tc-empty-icon"><i class="pi pi-comments" aria-hidden="true"></i></div>
            <h3>¿Qué querés saber?</h3>
            <p>Probá con una de estas:</p>
            <div class="tc-suggest">
              @for (s of suggestions; track s) {
                <button class="tc-chip" (click)="send(s)">
                  <i class="pi pi-sparkles" aria-hidden="true"></i>
                  <span>{{ s }}</span>
                </button>
              }
            </div>
          </div>
        }

        @for (m of messages(); track $index; let mi = $index) {
          <div class="tc-msg" @msg [class.tc-user]="m.role === 'user'" [class.tc-bot]="m.role === 'assistant'">
            <div class="tc-avatar" [class.is-thinking]="m.pending">
              <i [class]="m.role === 'user' ? 'pi pi-user' : 'pi pi-sparkles'" aria-hidden="true"></i>
            </div>
            <div class="tc-bubble" [class.tc-err]="m.error">
              @if (m.pending) {
                <span class="tc-typing"><i></i><i></i><i></i></span>
              } @else {
                @if (m.role === 'assistant') {
                  <div class="tc-text tc-reveal tc-md" [innerHTML]="renderMd(m.content)"></div>
                } @else {
                  <div class="tc-text tc-reveal">{{ m.content }}</div>
                }
                @for (b of m.blocks || []; track b.title) {
                  <div class="tc-block tc-reveal" [style.animation-delay.ms]="120 + $index * 90">
                    <div class="tc-block-head">
                      <span class="tc-block-ic"><i [class]="b.icon" aria-hidden="true"></i></span>
                      <span class="tc-block-title">{{ b.title }}</span>
                      <span class="tc-block-badge">{{ b.total }} {{ b.total === 1 ? 'fila' : 'filas' }}</span>
                      <span class="tc-block-src"><i class="pi pi-verified" aria-hidden="true"></i> datos reales · RLS</span>
                    </div>

                    @if (b.kpis) {
                      <div class="tc-kpis">
                        @for (k of b.kpis; track k.label) {
                          <div class="tc-kpi">
                            <span class="tc-kpi-val">{{ k.value }}</span>
                            <span class="tc-kpi-lbl">{{ k.label }}</span>
                          </div>
                        }
                      </div>
                    } @else {
                      <div class="tc-table-wrap">
                        <table class="tc-table">
                          <thead>
                            <tr>@for (c of b.cols; track c.key) { <th [class.tc-r]="c.type !== 'text'">{{ c.label }}</th> }</tr>
                          </thead>
                          <tbody>
                            @for (r of b.rows; track $index) {
                              <tr>
                                @for (c of b.cols; track c.key; let ci = $index) {
                                  <td [class.tc-r]="c.type !== 'text'" [class.tc-strong]="ci === 0">
                                    @if (c.key === b.barKey) {
                                      <span class="tc-bar-cell">
                                        <span class="tc-bar" [style.width.%]="barPct(b, r)"></span>
                                        <span class="tc-bar-num">{{ fmtCell(r[c.key], c.type) }}</span>
                                      </span>
                                    } @else {
                                      {{ fmtCell(r[c.key], c.type) }}
                                    }
                                  </td>
                                }
                              </tr>
                            }
                          </tbody>
                        </table>
                      </div>
                      @if (b.extra > 0) { <div class="tc-more">+{{ b.extra }} filas más</div> }
                    }
                  </div>
                }
                @if (m.role === 'assistant' && !m.error) {
                  <div class="tc-actions">
                    <button type="button" class="tc-act" (click)="copy(mi, m.content)"
                            [title]="copiedIdx() === mi ? 'Copiado' : 'Copiar'">
                      <i [class]="copiedIdx() === mi ? 'pi pi-check' : 'pi pi-copy'" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="tc-act" (click)="regenerate()" [disabled]="loading()" title="Regenerar">
                      <i class="pi pi-refresh" aria-hidden="true"></i>
                    </button>
                  </div>
                }
              }
            </div>
          </div>
        }
      </div>

      <form class="tc-input" (ngSubmit)="send(draft)">
        <i class="pi pi-comment tc-input-icon" aria-hidden="true"></i>
        <input type="text" [(ngModel)]="draft" name="draft" [disabled]="loading()"
               placeholder="Escribí tu pregunta…" autocomplete="off" />
        <button pButton type="submit" icon="pi pi-send" [rounded]="true" [loading]="loading()" [disabled]="!draft.trim()"></button>
      </form>
    </div>
  `,
  styles: [`
    .tc-page { display: flex; flex-direction: column; height: calc(100vh - 7rem); }
    .tc-thread { flex: 1; overflow-y: auto; padding: var(--sp-3) var(--sp-1) var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-4); }

    /* ── EMPTY STATE — ícono ember + sugerencias como tarjetas ── */
    .tc-empty { margin: auto; text-align: center; max-width: 560px; color: var(--text-muted); padding: var(--sp-6) var(--sp-3); }
    .tc-empty-icon {
      width: 64px; height: 64px; margin: 0 auto var(--sp-3);
      display: grid; place-items: center;
      border-radius: var(--r-lg);
      background: var(--ember-soft); color: var(--action);
      font-size: 1.6rem;
    }
    .tc-empty h3 { margin: 0 0 var(--sp-1); color: var(--text-main); font-size: var(--fs-h3, 1.1rem); font-weight: var(--fw-bold, 700); }
    .tc-empty p { margin: 0; font-size: var(--fs-sm); }
    .tc-suggest { display: flex; flex-wrap: wrap; gap: var(--sp-2); justify-content: center; margin-top: var(--sp-4); }
    .tc-chip {
      display: inline-flex; align-items: center; gap: var(--sp-2);
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: var(--r-pill);
      padding: var(--sp-2) var(--sp-4);
      font-size: var(--fs-sm); font-weight: var(--fw-medium, 500);
      color: var(--text-main);
      cursor: pointer;
      box-shadow: var(--shadow-light);
      transition: border-color .15s var(--ease-standard), transform .15s var(--ease-standard),
        box-shadow .2s var(--ease-standard), background-color .15s var(--ease-standard);
    }
    .tc-chip i { color: var(--action); font-size: .85rem; }
    .tc-chip:hover { border-color: var(--action); transform: translateY(-1px); box-shadow: var(--shadow-hover); }
    .tc-chip:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }

    /* ── MENSAJES ── */
    .tc-msg { display: flex; gap: var(--sp-3); max-width: 860px; }
    .tc-user { flex-direction: row-reverse; align-self: flex-end; }
    .tc-avatar {
      width: 32px; height: 32px; border-radius: var(--r-md); flex: 0 0 auto;
      display: flex; align-items: center; justify-content: center;
      background: var(--surface-hover-bg); color: var(--text-muted); font-size: .85rem;
    }
    .tc-bot .tc-avatar { background: var(--action); color: var(--action-ink, #fff); }
    .tc-avatar.is-thinking { animation: tc-think 1.6s ease-in-out infinite; }
    @keyframes tc-think {
      0%, 100% { box-shadow: 0 0 0 0 var(--action-ring, rgba(240,90,40,.35)); }
      50%      { box-shadow: 0 0 0 7px transparent; }
    }
    /* Burbujas con sombra suave → "flotan" sobre el fondo. */
    .tc-bubble {
      background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-lg); padding: var(--sp-3) var(--sp-4);
      font-size: var(--fs-body); line-height: 1.55; color: var(--text-main);
      box-shadow: var(--shadow-light);
    }
    .tc-user .tc-bubble { background: var(--surface-hover-bg); border-color: transparent; }
    .tc-err { border-color: var(--bad-fg); }
    .tc-text { white-space: pre-wrap; }
    .tc-block { margin-top: var(--sp-3); }
    .tc-block-title { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); margin-bottom: var(--sp-1); font-weight: var(--fw-bold, 700); }
    .tc-table-wrap { overflow-x: auto; border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .tc-table { border-collapse: collapse; width: 100%; font-size: var(--fs-sm); }
    .tc-table th, .tc-table td { padding: var(--sp-2) var(--sp-3); text-align: left; white-space: nowrap; border-bottom: 1px solid var(--border-color); }
    .tc-table th { font-weight: var(--fw-bold, 600); color: var(--text-muted); background: var(--surface-hover-bg); }
    .tc-table tbody tr:last-child td { border-bottom: none; }
    .tc-more { font-size: var(--fs-micro); color: var(--text-muted); margin-top: var(--sp-1); }

    /* ── Header del bloque: ícono + título + #filas + fuente ── */
    .tc-block-head { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-2); }
    .tc-block-ic { width: 22px; height: 22px; flex-shrink: 0; display: grid; place-items: center; border-radius: var(--r-sm); background: var(--ember-soft); color: var(--action); font-size: .72rem; }
    .tc-block-badge { font-size: var(--fs-micro); color: var(--text-muted); background: var(--surface-hover-bg); padding: .05rem .45rem; border-radius: var(--r-pill); }
    .tc-block-src { margin-left: auto; display: inline-flex; align-items: center; gap: .25rem; font-size: var(--fs-micro); color: var(--text-faint); white-space: nowrap; }
    .tc-block-src i { font-size: .72rem; color: var(--ok-fg); }

    /* ── KPI strip (resultado de 1 fila) ── */
    .tc-kpis { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
    .tc-kpi { flex: 1; min-width: 120px; display: flex; flex-direction: column; gap: .1rem; padding: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--surface-ground, var(--card-bg)); }
    .tc-kpi-val { font-size: 1.35rem; font-weight: var(--fw-bold, 800); color: var(--text-main); font-variant-numeric: tabular-nums; letter-spacing: -.01em; line-height: 1.15; }
    .tc-kpi-lbl { font-size: var(--fs-micro); color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; }

    /* ── Tabla inteligente: números a la derecha + tabular-nums + hover + 1ª col fuerte ── */
    .tc-table th.tc-r, .tc-table td.tc-r { text-align: right; font-variant-numeric: tabular-nums; }
    .tc-table td.tc-strong { font-weight: var(--fw-bold, 600); color: var(--text-main); }
    .tc-table tbody tr { transition: background-color .12s var(--ease-standard); }
    .tc-table tbody tr:hover { background: var(--surface-hover-bg); }

    /* ── Mini-barra de magnitud (columna dominante) ── */
    .tc-bar-cell { position: relative; display: inline-block; min-width: 72px; padding-bottom: 5px; }
    .tc-bar { position: absolute; right: 0; bottom: 0; height: 3px; background: var(--action); opacity: .4; border-radius: 2px; }
    .tc-bar-num { position: relative; }

    /* ── INDICADOR "escribiendo" ── */
    .tc-typing { display: inline-flex; gap: 4px; padding: var(--sp-1) 0; }
    .tc-typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); animation: tc-blink 1.2s infinite both; }
    .tc-typing i:nth-child(2) { animation-delay: .2s; } .tc-typing i:nth-child(3) { animation-delay: .4s; }
    @keyframes tc-blink { 0%,80%,100% { opacity: .2; } 40% { opacity: 1; } }

    /* Reveal del contenido — texto y tablas se materializan con blur-rise. */
    .tc-reveal { animation: tc-reveal 500ms cubic-bezier(0.22, 1, 0.36, 1) both; }
    @keyframes tc-reveal {
      from { opacity: 0; filter: blur(8px); transform: translateY(6px); }
      to   { opacity: 1; filter: blur(0);   transform: translateY(0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .tc-reveal, .tc-avatar.is-thinking { animation: none; }
    }

    /* ── COMPOSER — contenedor con anillo en foco (sin outline amarillo) ── */
    .tc-input {
      display: flex; align-items: center; gap: var(--sp-2);
      margin-top: var(--sp-3);
      padding: var(--sp-1) var(--sp-1) var(--sp-1) var(--sp-4);
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: var(--r-xl);
      box-shadow: var(--shadow-light);
      transition: border-color .18s var(--ease-standard), box-shadow .2s var(--ease-standard);
    }
    .tc-input:focus-within { border-color: var(--action); box-shadow: 0 0 0 3px var(--action-ring); }
    .tc-input-icon { color: var(--text-faint); font-size: 1rem; flex-shrink: 0; }
    .tc-input input {
      flex: 1; min-width: 0;
      border: none !important; outline: none !important; background: transparent;
      font-size: var(--fs-body); color: var(--text-main);
      padding: var(--sp-2) var(--sp-1);
    }
    @media (pointer: coarse) { .tc-input input { font-size: 16px; } }
    /* Composer flota sobre el hilo al scrollear. */
    .tc-input { position: relative; z-index: 2; }
    .tc-input:not(:focus-within) { box-shadow: 0 -4px 16px -10px rgba(0,0,0,.18), var(--shadow-light); }

    /* ── MARKDOWN en respuestas del asistente ── */
    .tc-md > :first-child { margin-top: 0; }
    .tc-md > :last-child { margin-bottom: 0; }
    .tc-md p { margin: 0 0 var(--sp-2); }
    .tc-md ul, .tc-md ol { margin: var(--sp-1) 0 var(--sp-2); padding-left: 1.25rem; }
    .tc-md li { margin: .15rem 0; }
    .tc-md code { font-family: var(--font-mono); font-size: .85em; background: var(--surface-hover-bg); padding: .1rem .35rem; border-radius: var(--r-sm); }
    .tc-md a { color: var(--action); text-decoration: underline; }
    .tc-md .tc-md-h { margin: var(--sp-2) 0 var(--sp-1); font-size: var(--fs-body); font-weight: var(--fw-bold, 700); }

    /* ── ACCIONES por mensaje (copiar / regenerar) ── */
    .tc-actions { display: flex; gap: var(--sp-1); margin-top: var(--sp-2); }
    .tc-act {
      width: 28px; height: 28px; display: grid; place-items: center;
      border: none; background: transparent; color: var(--text-faint);
      border-radius: var(--r-sm); cursor: pointer;
      transition: background-color .15s var(--ease-standard), color .15s var(--ease-standard);
    }
    .tc-act:hover:not(:disabled) { background: var(--surface-hover-bg); color: var(--text-main); }
    .tc-act:disabled { opacity: .4; cursor: default; }
  `],
})
export class ComercialThotChatComponent implements OnInit {
  readonly tabs = ANALYTICS_TABS;
  readonly suggestions = SUGGESTIONS;
  private readonly svc = inject(ComercialService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly thread = viewChild<ElementRef<HTMLElement>>('thread');

  /** Índice del mensaje recién copiado (feedback efímero del botón). */
  readonly copiedIdx = signal<number | null>(null);
  private readonly mdCache = new Map<string, SafeHtml>();

  ngOnInit(): void {
    // Deep-link desde la banda de IA de /comercial/empuje (?q=…): auto-envía.
    const q = this.route.snapshot.queryParamMap.get('q');
    if (q && q.trim()) this.send(q);
  }

  messages = signal<ChatMsg[]>([]);
  loading = signal(false);
  draft = '';

  /** Desactiva animaciones si el usuario pidió menos movimiento. */
  readonly reduce = typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  /** Historial (solo texto) para mandar al backend. */
  private history = computed<ThotChatTurn[]>(() =>
    this.messages().filter((m) => !m.pending && !m.error).map((m) => ({ role: m.role, content: m.content })),
  );

  send(text: string) {
    const q = (text || '').trim();
    if (!q || this.loading()) return;
    const histForApi = this.history();
    this.messages.update((ms) => [...ms, { role: 'user', content: q }]);
    this.draft = '';
    this.dispatch(histForApi, q);
  }

  /** Reintenta la última pregunta del usuario (regenera la respuesta). */
  regenerate() {
    if (this.loading()) return;
    const ms = this.messages();
    let lastUser = '';
    for (let i = ms.length - 1; i >= 0; i--) {
      if (ms[i].role === 'user') { lastUser = ms[i].content; break; }
    }
    if (!lastUser) return;
    // Quita la(s) respuesta(s) finales del asistente y vuelve a consultar.
    this.messages.update((arr) => {
      const c = [...arr];
      while (c.length && c[c.length - 1].role === 'assistant') c.pop();
      return c;
    });
    const h = this.history();          // ahora termina en el último user
    this.dispatch(h.slice(0, -1), lastUser);
  }

  /** Lanza la consulta al backend (agrega burbuja pending y resuelve). */
  private dispatch(histForApi: ThotChatTurn[], q: string) {
    this.messages.update((ms) => [...ms, { role: 'assistant', content: '', pending: true }]);
    this.loading.set(true);
    this.scroll();

    this.svc.thotChat(histForApi, q)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const blocks = (res.tools_used || []).map((t) => this.toBlock(t)).filter((b): b is DataBlock => !!b);
          this.replacePending({ role: 'assistant', content: res.answer, blocks, error: res.source === 'error' });
          this.loading.set(false);
          this.scroll();
        },
        error: () => {
          this.replacePending({ role: 'assistant', content: 'No pude responder en este momento. Probá de nuevo.', error: true });
          this.loading.set(false);
          this.scroll();
        },
      });
  }

  /** Copia el texto de un mensaje al portapapeles (feedback efímero). */
  copy(idx: number, content: string) {
    navigator.clipboard?.writeText(content).then(() => {
      this.copiedIdx.set(idx);
      setTimeout(() => { if (this.copiedIdx() === idx) this.copiedIdx.set(null); }, 1500);
    }).catch(() => {});
  }

  reset() {
    this.messages.set([]);
    this.draft = '';
  }

  private replacePending(msg: ChatMsg) {
    this.messages.update((ms) => {
      const copy = [...ms];
      const i = copy.findIndex((m) => m.pending);
      if (i >= 0) copy[i] = msg;
      else copy.push(msg);
      return copy;
    });
  }

  /** Extrae una tabla/KPI del resultado de una tool (transparencia + tipado). */
  private toBlock(t: ThotToolTrace): DataBlock | null {
    const rows = this.extractRows(t.result);
    if (!rows.length) return null;
    const keys = Object.keys(rows[0]).filter((k) => k !== '_truncated' && !/_id$/.test(k)).slice(0, 7);
    if (!keys.length) return null;
    const shown = rows.slice(0, 10);
    const cols: ColMeta[] = keys.map((k) => ({ key: k, label: this.humanize(k), type: this.colType(k, rows) }));

    // 1 fila con métricas → KPI strip (número grande en vez de tabla).
    let kpis: KpiStat[] | null = null;
    if (rows.length === 1) {
      const num = cols.filter((c) => c.type !== 'text');
      if (num.length) kpis = num.map((c) => ({ label: c.label, value: this.fmtCell(rows[0][c.key], c.type) }));
    }

    // Mini-barras: columna dominante (moneda > número) en tablas multi-fila.
    let barKey: string | null = null;
    let barMax = 0;
    if (!kpis) {
      const dom = cols.find((c) => c.type === 'currency') || cols.find((c) => c.type === 'num');
      if (dom) {
        barKey = dom.key;
        barMax = Math.max(0, ...shown.map((r) => Math.abs(Number(r[dom.key]) || 0)));
      }
    }

    return {
      title: this.humanize(this.toolLabel(t.name)),
      icon: this.toolIcon(t.name),
      cols, rows: shown,
      extra: Math.max(0, rows.length - shown.length),
      total: rows.length, barKey, barMax, kpis,
    };
  }

  private readonly LABELS: Record<string, string> = {
    product_name: 'Producto', product: 'Producto', brand_name: 'Marca', brand: 'Marca',
    customer_name: 'Cliente', customer: 'Cliente', name: 'Nombre', category: 'Categoría',
    units: 'Unidades', qty: 'Cantidad', quantity: 'Cantidad', revenue: 'Ventas', sales: 'Ventas',
    total: 'Total', orders: 'Pedidos', margin: 'Margen', margin_pct: 'Margen %',
    share: 'Participación', share_pct: 'Participación', avg_ticket: 'Ticket prom.', aov: 'Ticket prom.',
    stock: 'Stock', price: 'Precio', unit_price: 'Precio', last_order: 'Último pedido',
    days_inactive: 'Días inactivo', units_sold: 'Unidades',
  };

  private humanize(k: string): string {
    const key = k.toLowerCase().trim();
    return this.LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  private colType(key: string, rows: Record<string, any>[]): ColType {
    const k = key.toLowerCase();
    const numeric = rows.slice(0, 5).some((r) => r[key] != null && r[key] !== '' && !isNaN(Number(r[key])));
    if (!numeric) return 'text';
    if (/(share|pct|percent|porcentaje|tasa)/.test(k)) return 'percent';
    if (/(revenue|venta|sales|total|importe|monto|precio|price|ingreso|aov|ticket|amount|margen|margin)/.test(k)) return 'currency';
    return 'num';
  }

  fmtCell(v: any, type: ColType): string {
    if (v == null || v === '') return '—';
    const n = Number(v);
    if (type === 'currency' && !isNaN(n)) return n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 });
    if (type === 'percent' && !isNaN(n)) { const p = Math.abs(n) <= 1 ? n * 100 : n; return p.toLocaleString('es-MX', { maximumFractionDigits: 1 }) + '%'; }
    if (type === 'num' && !isNaN(n)) return Number.isInteger(n) ? n.toLocaleString('es-MX') : n.toLocaleString('es-MX', { maximumFractionDigits: 2 });
    return String(v);
  }

  barPct(b: DataBlock, r: Record<string, any>): number {
    if (!b.barKey || !b.barMax) return 0;
    return Math.max(0, Math.min(100, (Math.abs(Number(r[b.barKey]) || 0) / b.barMax) * 100));
  }

  private toolIcon(name: string): string {
    const n = name.toLowerCase();
    if (/product/.test(n)) return 'pi pi-box';
    if (/(customer|client)/.test(n)) return 'pi pi-users';
    if (/(stock|inventor)/.test(n)) return 'pi pi-database';
    if (/brand/.test(n)) return 'pi pi-tag';
    if (/(margin|margen)/.test(n)) return 'pi pi-percentage';
    if (/(sale|revenue|overview|venta|daily)/.test(n)) return 'pi pi-chart-line';
    return 'pi pi-table';
  }

  private extractRows(result: any): Record<string, any>[] {
    if (Array.isArray(result)) return result.filter((r) => r && typeof r === 'object');
    if (result && typeof result === 'object') {
      for (const k of ['rows', 'items', 'customers', 'products', 'data']) {
        if (Array.isArray(result[k])) return result[k].filter((r: any) => r && typeof r === 'object');
      }
    }
    return [];
  }

  private toolLabel(name: string): string {
    return name.replace(/^thot_/, '').replace(/_/g, ' ');
  }

  /**
   * Render Markdown ligero y SEGURO: escapa todo el HTML primero y recién
   * después aplica un subconjunto (negritas, itálicas, code, links http, listas,
   * encabezados, saltos). Sin dependencias. El escape-first evita XSS aunque la
   * respuesta venga del modelo. Cacheado por texto.
   */
  renderMd(src: string): SafeHtml {
    const cached = this.mdCache.get(src);
    if (cached) return cached;
    const safe = this.sanitizer.bypassSecurityTrustHtml(this.mdToHtml(src || ''));
    this.mdCache.set(src, safe);
    return safe;
  }

  private esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private inlineMd(s: string): string {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\b_([^_]+)_\b/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  private mdToHtml(raw: string): string {
    const lines = this.esc(raw).split(/\r?\n/);
    const out: string[] = [];
    let list: 'ul' | 'ol' | null = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

    for (const line of lines) {
      const t = line.trim();
      if (!t) { closeList(); continue; }

      const h = t.match(/^(#{1,3})\s+(.*)$/);
      if (h) { closeList(); out.push(`<h4 class="tc-md-h">${this.inlineMd(h[2])}</h4>`); continue; }

      const ul = t.match(/^[-*]\s+(.*)$/);
      if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${this.inlineMd(ul[1])}</li>`); continue; }

      const ol = t.match(/^\d+\.\s+(.*)$/);
      if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${this.inlineMd(ol[1])}</li>`); continue; }

      closeList();
      out.push(`<p>${this.inlineMd(t)}</p>`);
    }
    closeList();
    return out.join('');
  }

  private scroll() {
    setTimeout(() => {
      const el = this.thread()?.nativeElement;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior: this.reduce ? 'auto' : 'smooth' });
    }, 50);
  }
}
