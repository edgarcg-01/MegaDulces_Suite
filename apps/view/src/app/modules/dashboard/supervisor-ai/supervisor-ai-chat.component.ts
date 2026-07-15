import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { trigger, transition, style, animate } from '@angular/animations';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ButtonModule } from 'primeng/button';
import { SupervisorAiService, HorusChatTurn, HorusToolTrace } from './supervisor-ai.service';
import { ThotAiInputComponent, ThotAsk } from '../../comercial/components/thot-ai-input.component';

/** Mensaje en la UI: turno + (para assistant) bloques de datos de las tools. */
interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  blocks?: DataBlock[];
  pending?: boolean;
  error?: boolean;
  logId?: string | null;
  vote?: 1 | -1;
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
  barKey: string | null;
  barMax: number;
  kpis: KpiStat[] | null;
}

const SUGGESTIONS = [
  '¿Cómo viene el equipo esta semana?',
  '¿Qué tiendas llevan más días sin visita?',
  '¿Quién tiene la salud de ejecución más baja y por qué?',
  '¿Hay algo raro de integridad en las visitas?',
  '¿Qué dice la auditoría visual de las fotos?',
  '¿Qué coaching de Horus funcionó?',
];

/**
 * HIQ.0 — "Pregúntale a Horus": chat del supervisor sobre ejecución de Trade
 * (réplica por dominio del patrón TC.3/ADR-026 de Thot). El backend orquesta
 * tools deterministas y narra; acá mostramos la respuesta + los datos que las
 * tools devolvieron (transparencia) + feedback 👍/👎.
 */
@Component({
  selector: 'app-supervisor-ai-chat',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, RouterLink, ThotAiInputComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [
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
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Pregúntale a Horus</h1>
          <p class="surf-page-sub">Preguntá en lenguaje natural sobre la ejecución del equipo: capturas, tiendas, integridad, coaching. Los números salen del motor.</p>
        </div>
        <div class="tc-head-actions">
          <a pButton icon="pi pi-arrow-left" label="Tablero" [text]="true" severity="secondary" size="small" routerLink="/dashboard/supervisor-ai"></a>
          @if (messages().length > 0) {
            <button pButton icon="pi pi-eraser" label="Nueva consulta" [text]="true" severity="secondary" size="small" (click)="reset()"></button>
          }
        </div>
      </header>

      <div class="tc-thread" #thread [@.disabled]="reduce">
        @if (messages().length === 0) {
          <div class="tc-empty">
            <div class="tc-empty-icon"><i class="pi pi-eye" aria-hidden="true"></i></div>
            <h3>¿Qué querés saber de tu equipo?</h3>
            <p>Probá con una de estas:</p>
            <div class="tc-suggest">
              @for (s of suggestions; track s; let si = $index) {
                <button class="tc-chip" (click)="send(s)" [style.animation-delay.ms]="220 + si * 45">
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
              <i [class]="m.role === 'user' ? 'pi pi-user' : 'pi pi-eye'" aria-hidden="true"></i>
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
                      <span class="tc-block-src"><i class="pi pi-verified" aria-hidden="true"></i> motor determinista</span>
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
                    @if (m.logId) {
                      <button type="button" class="tc-act" [class.tc-voted]="m.vote === 1" (click)="vote(mi, 1)" title="Respuesta útil">
                        <i class="pi pi-thumbs-up" aria-hidden="true"></i>
                      </button>
                      <button type="button" class="tc-act" [class.tc-voted]="m.vote === -1" (click)="vote(mi, -1)" title="Respuesta mala">
                        <i class="pi pi-thumbs-down" aria-hidden="true"></i>
                      </button>
                    }
                  </div>
                }
              }
            </div>
          </div>
        }
      </div>

      <app-thot-ai-input class="tc-composer" (ask)="onAsk($event)"></app-thot-ai-input>
    </div>
  `,
  styles: [`
    .tc-page { display: flex; flex-direction: column; height: calc(100dvh - 7rem); }
    @media (max-width: 1023.98px) {
      .tc-page {
        height: calc(100dvh - 3.5rem - 2.2rem - 3.6rem - env(safe-area-inset-top) - env(safe-area-inset-bottom));
      }
    }
    @media (max-width: 640px) {
      .tc-thread { gap: var(--sp-3); padding: var(--sp-2) 0 var(--sp-3); }
      .tc-msg { gap: var(--sp-2); max-width: 100%; }
      .tc-avatar { width: 28px; height: 28px; }
      .tc-bubble { padding: var(--sp-2) var(--sp-3); }
      .tc-md { font-size: .9rem; line-height: 1.65; }
      .tc-suggest { gap: var(--sp-2); }
    }
    .tc-head-actions { display: flex; align-items: center; gap: var(--sp-1); }
    .tc-thread { flex: 1; overflow-y: auto; padding: var(--sp-3) var(--sp-1) var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-4); }

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
    .tc-bubble {
      border-radius: var(--r-lg); padding: var(--sp-3) var(--sp-4);
      font-size: var(--fs-body); line-height: 1.6; color: var(--text-main);
      min-width: 0;
    }
    .tc-user .tc-bubble { background: var(--surface-hover-bg); border: 1px solid transparent; }
    .tc-bot .tc-bubble { background: transparent; padding: var(--sp-1) 0 0; flex: 1; }
    .tc-bot .tc-bubble.tc-err {
      background: var(--bad-soft-bg); border: 1px solid var(--bad-border, var(--bad-fg));
      border-radius: var(--r-lg); padding: var(--sp-3) var(--sp-4); color: var(--bad-soft-fg);
    }
    .tc-text { white-space: pre-wrap; }
    .tc-block { margin-top: var(--sp-3); }
    .tc-block-title { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); margin-bottom: var(--sp-1); font-weight: var(--fw-bold, 700); }
    .tc-table-wrap { overflow-x: auto; border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .tc-table { border-collapse: collapse; width: 100%; font-size: var(--fs-sm); }
    .tc-table th, .tc-table td { padding: var(--sp-2) var(--sp-3); text-align: left; white-space: nowrap; border-bottom: 1px solid var(--border-color); }
    .tc-table th { font-weight: var(--fw-bold, 600); color: var(--text-muted); background: var(--surface-hover-bg); }
    .tc-table tbody tr:last-child td { border-bottom: none; }
    .tc-more { font-size: var(--fs-micro); color: var(--text-muted); margin-top: var(--sp-1); }

    .tc-block-head { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-2); }
    .tc-block-ic { width: 22px; height: 22px; flex-shrink: 0; display: grid; place-items: center; border-radius: var(--r-sm); background: var(--ember-soft); color: var(--action); font-size: .72rem; }
    .tc-block-badge { font-size: var(--fs-micro); color: var(--text-muted); background: var(--surface-hover-bg); padding: .05rem .45rem; border-radius: var(--r-pill); }
    .tc-block-src { margin-left: auto; display: inline-flex; align-items: center; gap: .25rem; font-size: var(--fs-micro); color: var(--text-faint); white-space: nowrap; }
    .tc-block-src i { font-size: .72rem; color: var(--ok-fg); }

    .tc-kpis { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
    .tc-kpi { flex: 1; min-width: 120px; display: flex; flex-direction: column; gap: .1rem; padding: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--surface-ground, var(--card-bg)); }
    .tc-kpi-val { font-size: 1.35rem; font-weight: var(--fw-bold, 800); color: var(--text-main); font-variant-numeric: tabular-nums; letter-spacing: -.01em; line-height: 1.15; }
    .tc-kpi-lbl { font-size: var(--fs-micro); color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; }

    .tc-table th.tc-r, .tc-table td.tc-r { text-align: right; font-variant-numeric: tabular-nums; }
    .tc-table td.tc-strong { font-weight: var(--fw-bold, 600); color: var(--text-main); }
    .tc-table tbody tr { transition: background-color .12s var(--ease-standard); }
    .tc-table tbody tr:hover { background: var(--surface-hover-bg); }

    .tc-bar-cell { position: relative; display: inline-block; min-width: 72px; padding-bottom: 5px; }
    .tc-bar { position: absolute; right: 0; bottom: 0; height: 3px; background: var(--action); opacity: .4; border-radius: 2px; }
    .tc-bar-num { position: relative; }

    @keyframes tc-enter { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
    @keyframes tc-pop { from { opacity: 0; transform: translateY(8px) scale(.82); } to { opacity: 1; transform: none; } }
    .tc-page > .surf-page-head { animation: tc-enter .45s var(--ease-out, cubic-bezier(.23,1,.32,1)) both; }
    .tc-page > .tc-composer { animation: tc-enter .5s var(--ease-out, cubic-bezier(.23,1,.32,1)) both; animation-delay: .08s; }
    .tc-empty-icon { animation: tc-pop .55s cubic-bezier(.34,1.4,.5,1) both; animation-delay: .06s; }
    .tc-empty h3 { animation: tc-enter .5s var(--ease-out, cubic-bezier(.23,1,.32,1)) both; animation-delay: .13s; }
    .tc-empty p  { animation: tc-enter .5s var(--ease-out, cubic-bezier(.23,1,.32,1)) both; animation-delay: .18s; }
    @keyframes tc-enter-chip { from { opacity: 0; translate: 0 10px; } to { opacity: 1; translate: 0 0; } }
    .tc-chip { animation: tc-enter-chip .5s var(--ease-out, cubic-bezier(.23,1,.32,1)) both; }
    @media (prefers-reduced-motion: reduce) {
      .tc-page > .surf-page-head, .tc-page > .tc-composer,
      .tc-empty-icon, .tc-empty h3, .tc-empty p, .tc-chip { animation: none; }
    }

    .tc-typing { display: inline-flex; gap: 4px; padding: var(--sp-1) 0; }
    .tc-typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); animation: tc-blink 1.2s infinite both; }
    .tc-typing i:nth-child(2) { animation-delay: .2s; } .tc-typing i:nth-child(3) { animation-delay: .4s; }
    @keyframes tc-blink { 0%,80%,100% { opacity: .2; } 40% { opacity: 1; } }

    .tc-reveal { animation: tc-reveal 500ms cubic-bezier(0.22, 1, 0.36, 1) both; }
    @keyframes tc-reveal {
      from { opacity: 0; filter: blur(8px); transform: translateY(6px); }
      to   { opacity: 1; filter: blur(0);   transform: translateY(0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .tc-reveal, .tc-avatar.is-thinking { animation: none; }
    }

    .tc-composer { display: block; margin-top: var(--sp-3); position: relative; z-index: 2; }

    .tc-md {
      font-size: .95rem;
      line-height: 1.72;
      color: var(--text-main);
      letter-spacing: .002em;
    }
    .tc-md > p, .tc-md > ul, .tc-md > ol, .tc-md > blockquote, .tc-md > .tc-md-h { max-width: 70ch; }
    .tc-md > :first-child { margin-top: 0; }
    .tc-md > :last-child { margin-bottom: 0; }
    .tc-md p { margin: 0 0 .75em; }
    .tc-md .tc-table-wrap { margin: .65em 0 .9em; }
    .tc-md strong { font-weight: var(--fw-bold, 700); color: var(--text-main); }
    .tc-md em { font-style: italic; }
    .tc-md ul, .tc-md ol { margin: .5em 0 .85em; padding-left: 1.3em; }
    .tc-md li { margin: .25em 0; padding-left: .15em; }
    .tc-md li::marker { color: var(--action); }
    .tc-md code {
      font-family: var(--font-mono); font-size: .85em;
      background: var(--surface-hover-bg); color: var(--text-main);
      padding: .12em .4em; border-radius: var(--r-sm);
    }
    .tc-md a { color: var(--action); text-decoration: underline; text-underline-offset: 2px; }
    .tc-md a:hover { color: var(--action-hover, var(--action)); }
    .tc-md .tc-md-h { font-weight: var(--fw-bold, 700); color: var(--text-main); line-height: 1.3; margin: 1.1em 0 .45em; }
    .tc-md .tc-md-h1 { font-size: 1.2rem; letter-spacing: -.01em; }
    .tc-md .tc-md-h2 { font-size: 1.08rem; }
    .tc-md .tc-md-h3 { font-size: .98rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; }
    .tc-md blockquote {
      margin: .6em 0; padding: .3em 0 .3em 1em;
      border-left: 3px solid var(--action); color: var(--text-muted);
    }
    .tc-md blockquote p { margin: .2em 0; }
    .tc-md-hr { border: none; border-top: 1px solid var(--border-color); margin: 1em 0; }

    .tc-actions { display: flex; gap: var(--sp-1); margin-top: var(--sp-2); }
    .tc-act {
      width: 28px; height: 28px; display: grid; place-items: center;
      border: none; background: transparent; color: var(--text-faint);
      border-radius: var(--r-sm); cursor: pointer;
      transition: background-color .15s var(--ease-standard), color .15s var(--ease-standard);
    }
    .tc-act:hover:not(:disabled) { background: var(--surface-hover-bg); color: var(--text-main); }
    .tc-act:disabled { opacity: .4; cursor: default; }
    .tc-act.tc-voted { color: var(--action); background: var(--ember-soft); }
  `],
})
export class SupervisorAiChatComponent implements OnInit {
  readonly suggestions = SUGGESTIONS;
  private readonly svc = inject(SupervisorAiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly thread = viewChild<ElementRef<HTMLElement>>('thread');

  readonly copiedIdx = signal<number | null>(null);
  private readonly mdCache = new Map<string, SafeHtml>();

  ngOnInit(): void {
    // Deep-link (?q=…) desde el tablero: auto-envía.
    const q = this.route.snapshot.queryParamMap.get('q');
    if (q && q.trim()) this.send(q);
  }

  messages = signal<ChatMsg[]>([]);
  loading = signal(false);
  draft = '';

  readonly reduce = typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  private history = computed<HorusChatTurn[]>(() =>
    this.messages().filter((m) => !m.pending && !m.error).map((m) => ({ role: m.role, content: m.content })),
  );

  private lastOpts: { think: boolean; deepSearch: boolean } = { think: false, deepSearch: false };

  send(text: string, think = false, deepSearch = false) {
    const q = (text || '').trim();
    if (!q || this.loading()) return;
    const histForApi = this.history();
    this.messages.update((ms) => [...ms, { role: 'user', content: q }]);
    this.draft = '';
    this.dispatch(histForApi, q, { think, deepSearch });
  }

  onAsk(e: ThotAsk) {
    this.send(e.text, e.think, e.deepSearch);
  }

  regenerate() {
    if (this.loading()) return;
    const ms = this.messages();
    let lastUser = '';
    for (let i = ms.length - 1; i >= 0; i--) {
      if (ms[i].role === 'user') { lastUser = ms[i].content; break; }
    }
    if (!lastUser) return;
    this.messages.update((arr) => {
      const c = [...arr];
      while (c.length && c[c.length - 1].role === 'assistant') c.pop();
      return c;
    });
    const h = this.history();
    this.dispatch(h.slice(0, -1), lastUser, this.lastOpts);
  }

  private dispatch(histForApi: HorusChatTurn[], q: string, opts: { think: boolean; deepSearch: boolean }) {
    this.lastOpts = opts;
    this.messages.update((ms) => [...ms, { role: 'assistant', content: '', pending: true }]);
    this.loading.set(true);
    this.scroll();

    this.svc.askChat(histForApi, q, opts)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const blocks = (res.tools_used || []).map((t) => this.toBlock(t)).filter((b): b is DataBlock => !!b);
          this.replacePending({ role: 'assistant', content: res.answer, blocks, error: res.source === 'error', logId: res.log_id });
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

  copy(idx: number, content: string) {
    navigator.clipboard?.writeText(content).then(() => {
      this.copiedIdx.set(idx);
      setTimeout(() => { if (this.copiedIdx() === idx) this.copiedIdx.set(null); }, 1500);
    }).catch(() => {});
  }

  /** 👍/👎 — alimenta la curaduría (patrón TC.5a). Optimista + idempotente en UI. */
  vote(idx: number, v: 1 | -1) {
    const m = this.messages()[idx];
    if (!m?.logId || m.vote === v) return;
    this.messages.update((ms) => ms.map((x, i) => (i === idx ? { ...x, vote: v } : x)));
    this.svc.chatFeedback(m.logId, v).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ error: () => {} });
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

  private toBlock(t: HorusToolTrace): DataBlock | null {
    const rows = this.extractRows(t.result);
    if (!rows.length) return null;
    const keys = Object.keys(rows[0]).filter((k) => k !== '_truncated' && !/_id$/.test(k) && k !== 'subject_id').slice(0, 7);
    if (!keys.length) return null;
    const shown = rows.slice(0, 10);
    const cols: ColMeta[] = keys.map((k) => ({ key: k, label: this.humanize(k), type: this.colType(k, rows) }));

    let kpis: KpiStat[] | null = null;
    if (rows.length === 1) {
      const num = cols.filter((c) => c.type !== 'text');
      if (num.length) kpis = num.map((c) => ({ label: c.label, value: this.fmtCell(rows[0][c.key], c.type) }));
    }

    let barKey: string | null = null;
    let barMax = 0;
    if (!kpis) {
      const dom = cols.find((c) => c.type === 'num') || cols.find((c) => c.type === 'percent');
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
    label: 'Sujeto', subject_type: 'Tipo', window_days: 'Ventana (d)', visits: 'Visitas',
    avg_score: 'Score prom.', score_trend: 'Tendencia', own_share_pct: 'Share propio',
    photo_coverage_pct: 'Foto %', days_since_visit: 'Días sin visita', exec_score: 'Salud',
    exec_level_score: 'Nivel', avg_visit_min: 'Min/visita', avg_skus: 'SKUs prom.',
    idle_min_avg: 'Muerto (min)', finding_type: 'Hallazgo', severity: 'Severidad',
    status: 'Estado', source: 'Fuente', score: 'Magnitud', created_at: 'Fecha',
    day: 'Día', captures: 'Capturas', stores: 'Tiendas', colaborador: 'Colaborador',
    exhibiciones: 'Exhibiciones', nombre: 'Nombre', username: 'Usuario', name: 'Nombre',
    store_name: 'Tienda', captured_by: 'Colaborador', shelf_quality: 'Calidad anaquel',
    out_of_stock: 'Agotado', mismatch: 'Inconsistencia', photo_quality: 'Calidad foto',
    metric: 'Métrica', mean: 'Promedio', stddev: 'Desviación', n_obs: 'Observaciones',
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
    return 'num';
  }

  fmtCell(v: any, type: ColType): string {
    if (v == null || v === '') return '—';
    if (typeof v === 'boolean') return v ? 'Sí' : 'No';
    const n = Number(v);
    if (type === 'percent' && !isNaN(n)) { const p = Math.abs(n) <= 1 ? n * 100 : n; return p.toLocaleString('es-MX', { maximumFractionDigits: 1 }) + '%'; }
    if (type === 'num' && !isNaN(n)) return Number.isInteger(n) ? n.toLocaleString('es-MX') : n.toLocaleString('es-MX', { maximumFractionDigits: 2 });
    if (typeof v === 'object') return JSON.stringify(v).slice(0, 60);
    return String(v);
  }

  barPct(b: DataBlock, r: Record<string, any>): number {
    if (!b.barKey || !b.barMax) return 0;
    return Math.max(0, Math.min(100, (Math.abs(Number(r[b.barKey]) || 0) / b.barMax) * 100));
  }

  private toolIcon(name: string): string {
    const n = name.toLowerCase();
    if (/finding/.test(n)) return 'pi pi-exclamation-triangle';
    if (/vision/.test(n)) return 'pi pi-camera';
    if (/timeline|tienda/.test(n)) return 'pi pi-calendar';
    if (/baseline|learning/.test(n)) return 'pi pi-chart-line';
    if (/action|task|coaching/.test(n)) return 'pi pi-check-square';
    if (/resolve/.test(n)) return 'pi pi-search';
    if (/sales/.test(n)) return 'pi pi-dollar';
    return 'pi pi-table';
  }

  private extractRows(result: any): Record<string, any>[] {
    if (Array.isArray(result)) return result.filter((r) => r && typeof r === 'object');
    if (result && typeof result === 'object') {
      for (const k of ['rows', 'items', 'verdicts', 'colaboradores', 'tiendas', 'data']) {
        const v = result[k];
        if (Array.isArray(v)) return v.filter((r: any) => r && typeof r === 'object');
        if (v && typeof v === 'object' && Array.isArray(v.rows)) return v.rows.filter((r: any) => r && typeof r === 'object');
      }
    }
    return [];
  }

  private toolLabel(name: string): string {
    return name.replace(/^horus_/, '').replace(/_/g, ' ');
  }

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

  private splitRow(s: string): string[] {
    let r = s.trim();
    if (r.startsWith('|')) r = r.slice(1);
    if (r.endsWith('|')) r = r.slice(0, -1);
    return r.split('|').map((c) => c.trim());
  }

  private isTableSep(s: string): boolean {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(s);
  }

  private mdTable(header: string[], body: string[][]): string {
    const cols = header.length;
    const isNum = (v: string) => /^[$+\-]?\s?[\d][\d.,\s]*%?$/.test((v || '').trim());
    const numCol: boolean[] = [];
    for (let c = 0; c < cols; c++) {
      const vals = body.map((r) => r[c] ?? '').filter((v) => v !== '');
      numCol[c] = vals.length > 0 && vals.filter(isNum).length >= Math.ceil(vals.length / 2);
    }
    const th = header.map((h, c) => `<th class="${numCol[c] ? 'tc-r' : ''}">${this.inlineMd(h)}</th>`).join('');
    const rows = body.map((r) => '<tr>' + header.map((_, c) => {
      const cls = `${numCol[c] ? 'tc-r ' : ''}${c === 0 ? 'tc-strong' : ''}`.trim();
      return `<td class="${cls}">${this.inlineMd(r[c] ?? '')}</td>`;
    }).join('') + '</tr>').join('');
    return `<div class="tc-table-wrap"><table class="tc-table"><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  private mdToHtml(raw: string): string {
    const lines = this.esc(raw).split(/\r?\n/);
    const out: string[] = [];
    let list: 'ul' | 'ol' | null = null;
    let quote = false;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    const closeQuote = () => { if (quote) { out.push('</blockquote>'); quote = false; } };
    const close = () => { closeList(); closeQuote(); };

    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) { close(); continue; }

      if (t.includes('|') && i + 1 < lines.length && this.isTableSep(lines[i + 1])) {
        close();
        const header = this.splitRow(t);
        const body: string[][] = [];
        let j = i + 2;
        while (j < lines.length && lines[j].trim().includes('|') && !this.isTableSep(lines[j])) {
          body.push(this.splitRow(lines[j].trim()));
          j++;
        }
        out.push(this.mdTable(header, body));
        i = j - 1;
        continue;
      }

      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { close(); out.push('<hr class="tc-md-hr">'); continue; }

      const h = t.match(/^(#{1,3})\s+(.*)$/);
      if (h) { close(); out.push(`<p class="tc-md-h tc-md-h${h[1].length}">${this.inlineMd(h[2])}</p>`); continue; }

      const bq = t.match(/^>\s?(.*)$/);
      if (bq) { closeList(); if (!quote) { out.push('<blockquote>'); quote = true; } out.push(`<p>${this.inlineMd(bq[1])}</p>`); continue; }

      const ul = t.match(/^[-*]\s+(.*)$/);
      if (ul) { closeQuote(); if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${this.inlineMd(ul[1])}</li>`); continue; }

      const ol = t.match(/^\d+\.\s+(.*)$/);
      if (ol) { closeQuote(); if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${this.inlineMd(ol[1])}</li>`); continue; }

      close();
      out.push(`<p>${this.inlineMd(t)}</p>`);
    }
    close();
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
