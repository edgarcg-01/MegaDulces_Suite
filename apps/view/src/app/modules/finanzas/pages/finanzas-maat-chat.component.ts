import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { trigger, transition, style, animate } from '@angular/animations';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ButtonModule } from 'primeng/button';
import { ChartModule } from 'primeng/chart';
import { MaatService, MaatChatTurn, MaatToolTrace, MaatBriefing, MaatChatResult } from '../maat.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { FINANZAS_TABS } from '../finanzas-tabs';
import { ThotAiInputComponent, ThotAsk, ThotImage } from '../../comercial/components/thot-ai-input.component';

/** Mensaje en la UI: turno + (para assistant) bloques de datos de las tools. */
interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  blocks?: DataBlock[];
  pending?: boolean;
  /** Reveal progresivo en curso (texto apareciendo palabra por palabra). */
  streaming?: boolean;
  error?: boolean;
  /** Id del mensaje en finance.chat_messages (para el 👍/👎). */
  messageId?: string | null;
  vote?: 1 | -1 | null;
  /** Repreguntas sugeridas (chips clicables). */
  suggestions?: string[];
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
  /** Columna con deep-link a la póliza (si la hay) → botón "Ver →" por fila. */
  urlKey: string | null;
  /** Si es serie temporal → datos para la gráfica de tendencia. */
  chart: { data: any; labelKey: string } | null;
}

const SUGGESTIONS = [
  '¿Cuánto gastamos en los últimos 90 días y en qué?',
  'Top 10 proveedores por compra',
  '¿A quién le debemos más ahorita?',
  '¿Cómo va el gasto de nómina mes a mes?',
  'Resumen de los hallazgos contables',
  '¿Qué le compramos a DE LA ROSA?',
];


/**
 * MAAT.3 (ADR-028) — "Pregúntale a Maat": chat financiero conversacional.
 * Réplica fiel del diseño de /thot-chat (misma anatomía tc-*): el backend
 * orquesta tools deterministas sobre egresos/proveedores/hallazgos/conocimiento
 * y narra; acá mostramos la respuesta + las tablas que las tools devolvieron
 * (transparencia) + 👍/👎 por respuesta (colector del aprendizaje L2).
 */
@Component({
  selector: 'app-finanzas-maat-chat',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, ChartModule, PageTabsComponent, ThotAiInputComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [
    trigger('msg', [
      transition(':enter', [
        style({ opacity: 0, transform: 'translateY(10px)', filter: 'blur(4px)' }),
        animate('400ms cubic-bezier(0.22, 1, 0.36, 1)',
          style({ opacity: 1, transform: 'none', filter: 'blur(0)' })),
      ]),
      transition(':leave', [
        animate('220ms ease',
          style({ opacity: 0, transform: 'translateY(-8px) scale(0.97)' })),
      ]),
    ]),
    trigger('jump', [
      transition(':enter', [
        style({ opacity: 0, transform: 'translateX(-50%) translateY(8px) scale(0.8)' }),
        animate('260ms cubic-bezier(0.34, 1.4, 0.5, 1)',
          style({ opacity: 1, transform: 'translateX(-50%) translateY(0) scale(1)' })),
      ]),
      transition(':leave', [
        animate('160ms ease', style({ opacity: 0, transform: 'translateX(-50%) translateY(6px) scale(0.85)' })),
      ]),
    ]),
    trigger('thinkText', [
      transition('* => *', [
        style({ opacity: 0, transform: 'translateY(4px)' }),
        animate('280ms cubic-bezier(0.22, 1, 0.36, 1)', style({ opacity: 1, transform: 'none' })),
      ]),
    ]),
  ],
  template: `
    <div class="surf-page in tc-page">
      <app-page-tabs [tabs]="tabs" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Pregúntale a Maat</h1>
          <p class="surf-page-sub">Pregunta en lenguaje natural sobre gastos, compras, proveedores, deuda y hallazgos contables. Los números salen de los libros.</p>
        </div>
        @if (messages().length > 0) {
          <button pButton icon="pi pi-eraser" label="Nueva consulta" [text]="true" severity="secondary" size="small" (click)="reset()"></button>
        }
      </header>

      <div class="tc-thread" #thread [@.disabled]="reduce" (scroll)="onScroll()" (click)="onThreadClick($event)">
        @if (messages().length === 0) {
          <div class="tc-empty">
            <div class="tc-empty-icon"><i class="pi pi-comments" aria-hidden="true"></i></div>
            @if (briefing(); as bf) {
              <h3>Hola{{ userName() ? ', ' + userName() : '' }} 👋</h3>
              <p>{{ bf.greeting }}</p>
              <div class="tc-brief">
                @for (c of bf.cards; track c.label) {
                  <div class="tc-brief-card" [class.warn]="c.tone === 'warn'" [class.up]="c.tone === 'up'">
                    <i class="pi {{ c.icon }}" aria-hidden="true"></i>
                    <div class="tc-brief-body"><span class="tc-brief-val">{{ c.value }}</span><span class="tc-brief-lbl">{{ c.label }}</span></div>
                  </div>
                }
              </div>
              <p class="tc-empty-hint">Pregúntame lo que quieras, o empieza por aquí:</p>
            } @else {
              <h3>¿Qué quieres saber?</h3>
              <p>Prueba con una de estas:</p>
            }
            <div class="tc-suggest">
              @for (s of startSuggestions(); track s; let si = $index) {
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
              <i [class]="m.role === 'user' ? 'pi pi-user' : 'pi pi-sparkles'" aria-hidden="true"></i>
            </div>
            <div class="tc-bubble" [class.tc-err]="m.error">
              @if (m.pending) {
                <span class="tc-thinking">
                  <span class="tc-typing"><i></i><i></i><i></i></span>
                  <span class="tc-thinking-txt" [@thinkText]="thinkingLabel()">{{ thinkingLabel() }}</span>
                </span>
              } @else {
                @if (m.role === 'assistant') {
                  <div class="tc-text tc-md" [class.tc-streaming]="m.streaming" [innerHTML]="renderStream(m)"></div>
                } @else {
                  <div class="tc-text tc-reveal">{{ m.content }}</div>
                }
                @for (b of m.blocks || []; track b.title) {
                  <div class="tc-block tc-reveal" [style.animation-delay.ms]="120 + $index * 90">
                    <div class="tc-block-head">
                      <span class="tc-block-ic"><i [class]="b.icon" aria-hidden="true"></i></span>
                      <span class="tc-block-title">{{ b.title }}</span>
                      <span class="tc-block-badge">{{ b.total }} {{ b.total === 1 ? 'fila' : 'filas' }}</span>
                      <span class="tc-block-src"><i class="pi pi-verified" aria-hidden="true"></i> libros contables · Kepler</span>
                      <button type="button" class="tc-block-exp" (click)="exportBlock(b)" title="Descargar (CSV/Excel)"><i class="pi pi-download" aria-hidden="true"></i></button>
                    </div>

                    @if (b.chart) {
                      <p-chart type="bar" [data]="b.chart.data" [options]="chartOpts" height="220px"></p-chart>
                    } @else if (b.kpis) {
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
                            <tr>@for (c of b.cols; track c.key) { <th [class.tc-r]="c.type !== 'text'">{{ c.label }}</th> }@if (b.urlKey) { <th style="width:2.5rem"></th> }</tr>
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
                                @if (b.urlKey) {
                                  <td class="tc-r">
                                    @if (r[b.urlKey]) {
                                      <button type="button" class="tc-see" (click)="go(r[b.urlKey])" title="Ver póliza en Egresos"><i class="pi pi-external-link" aria-hidden="true"></i></button>
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
                    @if (m.messageId) {
                      <button type="button" class="tc-act" [class.tc-voted]="m.vote === 1" (click)="vote(mi, 1)" title="Respuesta útil">
                        <i class="pi pi-thumbs-up" aria-hidden="true"></i>
                      </button>
                      <button type="button" class="tc-act" [class.tc-voted-down]="m.vote === -1" (click)="vote(mi, -1)" title="Respuesta incorrecta o inútil">
                        <i class="pi pi-thumbs-down" aria-hidden="true"></i>
                      </button>
                    }
                  </div>
                  @if (mi === messages().length - 1 && !loading() && m.suggestions?.length) {
                    <div class="tc-followups">
                      @for (s of m.suggestions; track s) {
                        <button type="button" class="tc-followup" (click)="send(s)"><i class="pi pi-arrow-right" aria-hidden="true"></i>{{ s }}</button>
                      }
                    </div>
                  }
                }
              }
            </div>
          </div>
        }
      </div>

      @if (!atBottom() && messages().length) {
        <button type="button" class="tc-jump" @jump (click)="jumpToBottom()" aria-label="Ir al final de la conversación">
          <i class="pi pi-arrow-down" aria-hidden="true"></i>
        </button>
      }

      <app-thot-ai-input class="tc-composer" hintBase="Pregúntale a Maat sobre tus finanzas…" (ask)="onAsk($event)"></app-thot-ai-input>
    </div>
  `,
  styles: [`
    .tc-page { display: flex; flex-direction: column; position: relative; height: calc(100dvh - 7rem); }
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
      .tc-md { font-size: .95rem; line-height: 1.72; }
      .tc-suggest { gap: var(--sp-2); }
    }
    /* Columna de lectura centrada (patrón ChatGPT/Claude): en desktop ancho los
       mensajes ya no se pegan a la izquierda. Máscara suave = el contenido se
       desvanece contra el header y el composer en vez de cortarse en seco. */
    .tc-thread {
      flex: 1; overflow-y: auto; padding: var(--sp-3) var(--sp-1) var(--sp-4);
      display: flex; flex-direction: column; align-items: center; gap: var(--sp-4);
      scroll-padding-block: var(--sp-4);
      -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 var(--sp-4), #000 calc(100% - var(--sp-3)), transparent 100%);
              mask-image: linear-gradient(to bottom, transparent 0, #000 var(--sp-4), #000 calc(100% - var(--sp-3)), transparent 100%);
    }
    @media (prefers-reduced-motion: reduce) { .tc-thread { -webkit-mask-image: none; mask-image: none; } }

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
    .tc-msg { display: flex; gap: var(--sp-3); width: 100%; max-width: 820px; }
    .tc-user { flex-direction: row-reverse; align-self: flex-end; }
    .tc-avatar {
      width: 32px; height: 32px; border-radius: var(--r-md); flex: 0 0 auto;
      display: flex; align-items: center; justify-content: center;
      background: var(--surface-hover-bg); color: var(--text-muted); font-size: .85rem;
    }
    .tc-bot .tc-avatar {
      background: linear-gradient(135deg, var(--action) 0%, #F8B400 100%);
      color: #fff;
      box-shadow: 0 2px 10px -3px var(--action-ring, rgba(240, 90, 40, .45));
    }
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
    .tc-block { margin-top: var(--sp-4); }
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
    .tc-kpi-val { font-size: 1.35rem; font-weight: var(--fw-bold, 800); color: var(--text-main); font-family: var(--font-mono, ui-monospace, monospace); font-variant-numeric: tabular-nums; letter-spacing: -.01em; line-height: 1.15; }
    .tc-kpi-lbl { font-size: var(--fs-micro); color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; }

    .tc-table th.tc-r, .tc-table td.tc-r { text-align: right; font-variant-numeric: tabular-nums; }
    .tc-table td.tc-r { font-family: var(--font-mono, ui-monospace, monospace); }
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

    .tc-thinking { display: inline-flex; align-items: center; gap: var(--sp-2); padding: var(--sp-1) 0; }
    .tc-typing { display: inline-flex; gap: 4px; }
    .tc-typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--action); animation: tc-blink 1.2s infinite both; }
    .tc-typing i:nth-child(2) { animation-delay: .2s; } .tc-typing i:nth-child(3) { animation-delay: .4s; }
    @keyframes tc-blink { 0%,80%,100% { opacity: .25; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }
    /* Shimmer de gradiente sobre el texto (firma de Gemini al generar). */
    .tc-thinking-txt {
      font-size: var(--fs-sm); font-weight: var(--fw-medium, 500);
      background: linear-gradient(90deg, var(--text-faint) 20%, var(--action) 50%, var(--text-faint) 80%);
      background-size: 200% 100%;
      -webkit-background-clip: text; background-clip: text; color: transparent;
      animation: tc-shimmer 1.8s linear infinite;
    }
    @keyframes tc-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) {
      .tc-typing i { animation: none; }
      .tc-thinking-txt { animation: none; color: var(--text-muted); -webkit-text-fill-color: var(--text-muted); }
    }

    .tc-reveal { animation: tc-reveal 500ms cubic-bezier(0.22, 1, 0.36, 1) both; }
    @keyframes tc-reveal {
      from { opacity: 0; filter: blur(4px); transform: translateY(5px); }
      to   { opacity: 1; filter: blur(0);   transform: translateY(0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .tc-reveal, .tc-avatar.is-thinking { animation: none; }
    }

    .tc-composer { display: block; width: 100%; max-width: 820px; margin: var(--sp-3) auto 0; position: relative; z-index: 2; }

    /* Botón flotante "ir al final" — aparece al leer una respuesta larga y
       scrollear hacia arriba. Anclado sobre el composer, centrado con la columna. */
    .tc-jump {
      position: absolute; left: 50%; transform: translateX(-50%);
      bottom: 5rem; z-index: 3;
      width: 36px; height: 36px; border-radius: var(--r-pill);
      display: grid; place-items: center;
      background: var(--card-bg); color: var(--text-main);
      border: 1px solid var(--border-color); box-shadow: var(--shadow-hover);
      cursor: pointer; font-size: .85rem;
      transition: border-color .15s var(--ease-standard), color .15s var(--ease-standard), transform .15s var(--ease-standard);
    }
    .tc-jump:hover { border-color: var(--action); color: var(--action); transform: translateX(-50%) translateY(-2px); }
    .tc-jump:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }

    /* ── MARKDOWN en respuestas — tipografía de lectura ── */
    .tc-md {
      font-size: 1rem;
      line-height: 1.8;
      color: var(--text-main);
      letter-spacing: .001em;
      font-variant-numeric: tabular-nums;
    }
    .tc-md > p, .tc-md > ul, .tc-md > ol, .tc-md > blockquote, .tc-md > .tc-md-h { max-width: 68ch; }
    .tc-md > :first-child { margin-top: 0; }
    .tc-md > :last-child { margin-bottom: 0; }
    .tc-md p { margin: 0 0 1em; }
    .tc-md .tc-table-wrap { margin: 1em 0 1.15em; }
    .tc-md strong { font-weight: var(--fw-semibold, 600); color: var(--text-main); }
    .tc-md em { font-style: italic; }
    .tc-md ul, .tc-md ol { margin: .7em 0 1.1em; padding-left: 1.4em; }
    .tc-md li { margin: .4em 0; padding-left: .2em; }
    .tc-md li::marker { color: var(--action); }
    .tc-md code {
      font-family: var(--font-mono); font-size: .85em;
      background: var(--surface-hover-bg); color: var(--text-main);
      padding: .12em .4em; border-radius: var(--r-sm);
    }
    .tc-md a { color: var(--action); text-decoration: underline; text-underline-offset: 2px; }
    .tc-md a:hover { color: var(--action-hover, var(--action)); }
    /* Jerarquía suave (Gemini): encabezados aireados, H3 como etiqueta ember. */
    .tc-md .tc-md-h { font-weight: var(--fw-semibold, 600); color: var(--text-main); line-height: 1.35; margin: 1.5em 0 .6em; }
    .tc-md .tc-md-h1 { font-size: 1.3rem; letter-spacing: -.012em; }
    .tc-md .tc-md-h2 { font-size: 1.12rem; }
    .tc-md .tc-md-h3 { font-size: .82rem; color: var(--action); text-transform: uppercase; letter-spacing: .06em; font-weight: var(--fw-bold, 700); }
    .tc-md blockquote {
      margin: .6em 0; padding: .3em 0 .3em 1em;
      border-left: 3px solid var(--action); color: var(--text-muted);
    }
    .tc-md blockquote p { margin: .2em 0; }
    .tc-md-hr { border: none; border-top: 1px solid var(--border-color); margin: 1em 0; }

    /* ── ACCIONES por mensaje (copiar / regenerar / 👍👎) ── */
    .tc-actions { display: flex; gap: var(--sp-1); margin-top: var(--sp-2); }
    .tc-act {
      width: 28px; height: 28px; display: grid; place-items: center;
      border: none; background: transparent; color: var(--text-faint);
      border-radius: var(--r-sm); cursor: pointer;
      transition: background-color .15s var(--ease-standard), color .15s var(--ease-standard);
    }
    .tc-act:hover:not(:disabled) { background: var(--surface-hover-bg); color: var(--text-main); }
    .tc-act:disabled { opacity: .4; cursor: default; }
    .tc-act.tc-voted { color: var(--ok-fg); }
    .tc-act.tc-voted-down { color: var(--bad-fg); }

    /* ── Briefing (empty-state proactivo) ── */
    .tc-empty-hint { margin-top: var(--sp-4); font-size: var(--fs-sm); }
    .tc-brief { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: var(--sp-2); margin: var(--sp-4) 0 0; text-align: left; }
    .tc-brief-card { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); }
    .tc-brief-card > i { font-size: 1.1rem; color: var(--text-muted); flex: 0 0 auto; }
    .tc-brief-card.warn { border-color: color-mix(in srgb, var(--bad-fg) 35%, var(--border-color)); }
    .tc-brief-card.warn > i { color: var(--bad-fg); }
    .tc-brief-card.up > i { color: var(--action); }
    .tc-brief-body { display: flex; flex-direction: column; min-width: 0; }
    .tc-brief-val { font-weight: var(--fw-bold, 700); font-size: .95rem; color: var(--text-main); font-family: var(--font-mono, ui-monospace, monospace); font-variant-numeric: tabular-nums; }
    .tc-brief-lbl { font-size: var(--fs-micro); color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }

    /* ── Follow-up chips (repreguntas tras la respuesta) ── */
    .tc-followups { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: var(--sp-3); }
    .tc-followup {
      display: inline-flex; align-items: center; gap: var(--sp-2);
      border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-main);
      border-radius: var(--r-pill); padding: var(--sp-1) var(--sp-3); font-size: var(--fs-sm); cursor: pointer;
      transition: border-color .15s var(--ease-standard), background-color .15s var(--ease-standard);
    }
    .tc-followup i { color: var(--action); font-size: .78rem; }
    .tc-followup:hover { border-color: var(--action); background: var(--surface-hover-bg); }

    /* ── Botón "Ver póliza →" en filas de búsqueda + export + doclink inline ── */
    .tc-see { border: none; background: transparent; color: var(--action); cursor: pointer; padding: .1rem .3rem; border-radius: var(--r-sm); }
    .tc-see:hover { background: var(--ember-soft); }
    .tc-block-exp { margin-left: var(--sp-2); border: none; background: transparent; color: var(--text-faint); cursor: pointer; padding: .1rem .3rem; border-radius: var(--r-sm); }
    .tc-block-exp:hover { background: var(--surface-hover-bg); color: var(--text-main); }
    .tc-md a.tc-doclink { color: var(--action); text-decoration: none; font-weight: var(--fw-medium, 500); white-space: nowrap; }
    .tc-md a.tc-doclink i { font-size: .72rem; }
    .tc-md a.tc-doclink:hover { text-decoration: underline; }
  `],
})
export class FinanzasMaatChatComponent implements OnInit {
  readonly tabs = FINANZAS_TABS;
  private readonly svc = inject(MaatService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly thread = viewChild<ElementRef<HTMLElement>>('thread');

  readonly copiedIdx = signal<number | null>(null);
  readonly briefing = signal<MaatBriefing | null>(null);
  readonly userName = signal<string>('');
  private readonly mdCache = new Map<string, SafeHtml>();
  /** Sesión de audit en finance.chat_sessions (el backend la crea al primer turno). */
  private sessionId: string | null = null;

  /** Chips del empty-state: las del briefing si llegó, si no las genéricas. */
  readonly startSuggestions = computed(() => this.briefing()?.suggestions?.length ? this.briefing()!.suggestions : SUGGESTIONS);

  /** Opciones Chart.js (theme-agnóstico, ligero) para las gráficas de tendencia. */
  readonly chartOpts = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: { y: { ticks: { callback: (v: any) => '$' + Number(v).toLocaleString('es-MX') } } },
  };

  ngOnInit(): void {
    // Proactividad: briefing determinista para el empty-state.
    this.svc.briefing().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (b) => this.briefing.set(b), error: () => {} });
    // Deep-link contextual (ej. desde /finanzas/egresos con ?q=…): auto-envía.
    const q = this.route.snapshot.queryParamMap.get('q');
    if (q && q.trim()) this.send(q);
    this.destroyRef.onDestroy(() => this.stopReveal());
  }

  messages = signal<ChatMsg[]>([]);
  loading = signal(false);
  atBottom = signal(true);
  draft = '';

  /** Estado "pensando": label del paso REAL emitido por el backend (SSE). */
  readonly thinkingLabel = signal('Analizando tu pregunta…');

  readonly reduce = typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  private history = computed<MaatChatTurn[]>(() =>
    this.messages().filter((m) => !m.pending && !m.error && !m.streaming).map((m) => ({ role: m.role, content: m.content })),
  );

  private lastOpts: { think: boolean; deepSearch: boolean; image?: ThotImage | null } = { think: false, deepSearch: false };

  send(text: string, think = false, deepSearch = false, image?: ThotImage | null) {
    const q = (text || '').trim();
    if ((!q && !image) || this.loading()) return;
    const histForApi = this.history();
    const shown = q || (image ? `🖼️ ${image.name}` : '');
    this.messages.update((ms) => [...ms, { role: 'user', content: shown }]);
    this.draft = '';
    this.dispatch(histForApi, q || 'Analiza esta imagen.', { think, deepSearch, image });
  }

  onAsk(e: ThotAsk) {
    this.send(e.text, e.think, e.deepSearch, e.image);
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

  private dispatch(histForApi: MaatChatTurn[], q: string, opts: { think: boolean; deepSearch: boolean; image?: ThotImage | null }) {
    this.lastOpts = opts;
    this.messages.update((ms) => [...ms, { role: 'assistant', content: '', pending: true }]);
    this.loading.set(true);
    this.thinkingLabel.set('Analizando tu pregunta…');
    this.scroll();

    // Stream SSE: los pasos de "pensando" son los REALES (la tool que corre).
    this.svc.chatStream(histForApi, q, { ...opts, sessionId: this.sessionId })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (ev) => {
          if (ev.type === 'step') { if (ev.label) this.thinkingLabel.set(ev.label); }
          else if (ev.type === 'done') this.onResult(ev.result);
          else if (ev.type === 'error') this.showError();
        },
        // Si el stream falla de raíz, degradar al endpoint no-streaming.
        error: () => this.fallbackAsk(histForApi, q, opts),
      });
  }

  /** Procesa el resultado final: reveal progresivo del texto + tablas al terminar. */
  private onResult(res: MaatChatResult) {
    this.sessionId = res.session_id || this.sessionId;
    const blocks = (res.tools_used || []).map((t) => this.toBlock(t)).filter((b): b is DataBlock => !!b);
    const isErr = res.source === 'error';
    if (this.reduce || isErr || !res.answer) {
      this.replacePending({
        role: 'assistant', content: res.answer, blocks,
        error: isErr, messageId: res.message_id, vote: null, suggestions: res.suggestions || [],
      });
      this.loading.set(false);
      this.scroll();
      return;
    }
    this.replacePending({ role: 'assistant', content: '', streaming: true });
    this.scroll();
    this.streamReveal(res.answer, () => {
      this.messages.update((ms) => ms.map((m) =>
        m.streaming
          ? { ...m, content: res.answer, streaming: false, blocks, error: false, messageId: res.message_id, vote: null, suggestions: res.suggestions || [] }
          : m));
      this.loading.set(false);
      this.scroll();
    });
  }

  private showError() {
    this.replacePending({ role: 'assistant', content: 'No pude responder en este momento. Intenta de nuevo.', error: true });
    this.loading.set(false);
    this.scroll();
  }

  /** Fallback al endpoint clásico (sin streaming) si el SSE no está disponible. */
  private fallbackAsk(hist: MaatChatTurn[], q: string, opts: { think: boolean; deepSearch: boolean; image?: ThotImage | null }) {
    this.svc.chat(hist, q, { ...opts, sessionId: this.sessionId })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (res) => this.onResult(res), error: () => this.showError() });
  }

  copy(idx: number, content: string) {
    navigator.clipboard?.writeText(content).then(() => {
      this.copiedIdx.set(idx);
      setTimeout(() => { if (this.copiedIdx() === idx) this.copiedIdx.set(null); }, 1500);
    }).catch(() => {});
  }

  /** 👍/👎 — colector del aprendizaje (L2). Toggle visual + persistencia best-effort. */
  vote(idx: number, v: 1 | -1) {
    const m = this.messages()[idx];
    if (!m?.messageId) return;
    const next = m.vote === v ? null : v;
    this.messages.update((ms) => ms.map((x, i) => (i === idx ? { ...x, vote: next } : x)));
    if (next) this.svc.feedback(m.messageId, next).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ error: () => {} });
  }

  reset() {
    this.stopReveal();
    this.messages.set([]);
    this.draft = '';
    this.sessionId = null;
    this.loading.set(false);
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

  /** Extrae una tabla/KPI/gráfica del resultado de una tool (transparencia + tipado). */
  private toBlock(t: MaatToolTrace): DataBlock | null {
    const rows = this.extractRows(t.result);
    if (!rows.length) return null;
    // ui_url no es columna visible → se convierte en botón "Ver →".
    const urlKey = Object.keys(rows[0]).includes('ui_url') ? 'ui_url' : null;
    const keys = Object.keys(rows[0]).filter((k) => k !== '_truncated' && k !== 'ui_url' && !/_id$/.test(k)).slice(0, 7);
    if (!keys.length) return null;
    const shown = rows.slice(0, 12);
    const cols: ColMeta[] = keys.map((k) => ({ key: k, label: this.humanize(k), type: this.colType(k, rows) }));

    let kpis: KpiStat[] | null = null;
    if (rows.length === 1) {
      const num = cols.filter((c) => c.type !== 'text');
      if (num.length) kpis = num.map((c) => ({ label: c.label, value: this.fmtCell(rows[0][c.key], c.type) }));
    }

    // Serie temporal (col 'mes' + numérica) con 3+ puntos → gráfica de barras.
    let chart: DataBlock['chart'] = null;
    const mesCol = cols.find((c) => c.key === 'mes' || c.key === 'anio_mes');
    if (!kpis && mesCol && rows.length >= 3) {
      const numCols = cols.filter((c) => c.type !== 'text' && c.key !== 'movs');
      if (numCols.length) {
        const palette = this.chartPalette();
        chart = {
          labelKey: mesCol.key,
          data: {
            labels: rows.map((r) => String(r[mesCol.key])),
            datasets: numCols.slice(0, 3).map((c, i) => ({
              label: c.label, data: rows.map((r) => Number(r[c.key]) || 0), backgroundColor: palette[i % palette.length],
            })),
          },
        };
      }
    }

    let barKey: string | null = null;
    let barMax = 0;
    if (!kpis && !chart) {
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
      total: rows.length, barKey, barMax, kpis, urlKey, chart,
    };
  }

  /** Navega dentro de la SPA a un deep-link interno (ej. una póliza en Egresos). */
  go(url: string) {
    if (url && url.startsWith('/')) this.router.navigateByUrl(url);
  }

  /** Event-delegation: links markdown internos (data-internal) navegan sin recargar. */
  onThreadClick(ev: MouseEvent) {
    const a = (ev.target as HTMLElement)?.closest('a[data-internal]') as HTMLAnchorElement | null;
    if (!a) return;
    const href = a.getAttribute('href');
    if (href && href.startsWith('/')) { ev.preventDefault(); this.router.navigateByUrl(href); }
  }

  /** Exporta un bloque a CSV (Excel lo abre nativo). BOM para acentos. */
  exportBlock(b: DataBlock) {
    const cols = b.cols;
    const head = cols.map((c) => `"${c.label}"`).join(',');
    const lines = b.rows.map((r) => cols.map((c) => {
      const v = r[c.key];
      if (v == null) return '';
      const s = typeof v === 'number' ? String(v) : String(v).replace(/"/g, '""');
      return `"${s}"`;
    }).join(','));
    const blob = new Blob(['﻿' + [head, ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `maat_${(b.title || 'datos').toLowerCase().replace(/[^a-z0-9]+/g, '_')}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  private readonly LABELS: Record<string, string> = {
    proveedor: 'Proveedor', beneficiario: 'Beneficiario', cuenta: 'Cuenta', cuenta_mayor: 'Cuenta mayor',
    sucursal: 'Sucursal', area: 'Área', doc_tipo: 'Tipo doc', doc_folio: 'Folio', mes: 'Mes',
    importe: 'Importe', total: 'Total', compras: 'Compras', gastos: 'Gastos', movs: 'Movs',
    share_pct: 'Participación', compra_12m: 'Compra 12m', pagos_12m: 'Pagos 12m', saldo: 'Saldo',
    num_facturas: 'Facturas', ultima_compra: 'Última compra', dpo_dias: 'DPO (días)',
    producto: 'Producto', sku: 'SKU', cantidad: 'Cantidad', docs: 'Docs', costo_unitario: 'Costo u.',
    tipo: 'Tipo', num: '#', nota: 'Nota', fecha: 'Fecha', concepto: 'Concepto', rfc: 'RFC',
    iva: 'IVA', linea: '#', title: 'Título', body: 'Detalle', kind: 'Tipo', movimientos: 'Movimientos',
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
    if (/(importe|monto|total|saldo|compra|pago|gasto|costo|precio|iva|amount)/.test(k)) return 'currency';
    return 'num';
  }

  fmtCell(v: any, type: ColType): string {
    if (v == null || v === '') return '—';
    const n = Number(v);
    if (type === 'currency' && !isNaN(n)) return n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 });
    if (type === 'percent' && !isNaN(n)) { const p = Math.abs(n) <= 1 ? n * 100 : n; return p.toLocaleString('es-MX', { maximumFractionDigits: 1 }) + '%'; }
    if (type === 'num' && !isNaN(n)) return Number.isInteger(n) ? n.toLocaleString('es-MX') : n.toLocaleString('es-MX', { maximumFractionDigits: 2 });
    // Fechas ISO → dd/mm/aa compacto.
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) return d.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: '2-digit' });
    }
    return String(v);
  }

  barPct(b: DataBlock, r: Record<string, any>): number {
    if (!b.barKey || !b.barMax) return 0;
    return Math.max(0, Math.min(100, (Math.abs(Number(r[b.barKey]) || 0) / b.barMax) * 100));
  }

  private toolIcon(name: string): string {
    const n = name.toLowerCase();
    if (/proveedor/.test(n)) return 'pi pi-truck';
    if (/documento/.test(n)) return 'pi pi-receipt';
    if (/hallazgo/.test(n)) return 'pi pi-exclamation-triangle';
    if (/conocimiento/.test(n)) return 'pi pi-book';
    if (/serie/.test(n)) return 'pi pi-chart-line';
    if (/egreso/.test(n)) return 'pi pi-wallet';
    return 'pi pi-table';
  }

  /** MAAT.7 — re-expande el formato columnar {columns,data} del token-diet a objetos. */
  private expandColumnar(v: any): Record<string, any>[] | null {
    if (v && !Array.isArray(v) && Array.isArray(v.columns) && Array.isArray(v.data)) {
      return v.data.map((row: any[]) => Object.fromEntries(v.columns.map((c: string, i: number) => [c, row[i]])));
    }
    return null;
  }

  private extractRows(result: any): Record<string, any>[] {
    if (Array.isArray(result)) return result.filter((r) => r && typeof r === 'object');
    const colTop = this.expandColumnar(result);
    if (colTop) return colTop;
    if (result && typeof result === 'object') {
      for (const k of ['rows', 'proveedores', 'top_productos', 'resumen', 'posturas', 'lineas', 'items', 'data']) {
        const col = this.expandColumnar(result[k]);
        if (col && col.length) return col;
        if (Array.isArray(result[k]) && result[k].length) return result[k].filter((r: any) => r && typeof r === 'object');
      }
      // Objeto plano con métricas (ej. proveedor único) → KPI de 1 fila.
      const scalars = Object.entries(result).filter(([k, v]) => v == null || ['string', 'number', 'boolean'].includes(typeof v));
      if (scalars.length >= 3) return [Object.fromEntries(scalars)];
    }
    return [];
  }

  private toolLabel(name: string): string {
    return name.replace(/^maat_/, '').replace(/_/g, ' ');
  }

  // ── Reveal progresivo del texto (efecto ChatGPT/Gemini) ───────────────
  private revealTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Muestra la respuesta palabra por palabra con cadencia ~constante (~1.5 s
   * total, independiente del largo). El backend no streamea (loop de tools),
   * así que la "escritura" se simula en cliente re-renderizando el markdown
   * conforme crece el texto.
   */
  private streamReveal(full: string, done: () => void) {
    this.stopReveal();
    const tokens = full.match(/\S+\s*/g) || [full];
    const perTick = Math.max(1, Math.ceil(tokens.length / 70));
    let i = 0;
    this.revealTimer = setInterval(() => {
      i = Math.min(tokens.length, i + perTick);
      const shown = tokens.slice(0, i).join('');
      this.messages.update((ms) => ms.map((m) => (m.streaming ? { ...m, content: shown } : m)));
      if (this.atBottom()) this.scrollStream();
      if (i >= tokens.length) { this.stopReveal(); done(); }
    }, 22);
  }

  private stopReveal() {
    if (this.revealTimer) { clearInterval(this.revealTimer); this.revealTimer = null; }
  }

  /** Scroll inmediato (no smooth) durante el reveal para no pelear con el crecimiento. */
  private scrollStream() {
    const el = this.thread()?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }

  /** Durante el reveal renderiza markdown en vivo (sin cache, el texto parcial es único). */
  renderStream(m: ChatMsg): SafeHtml {
    if (m.streaming) return this.sanitizer.bypassSecurityTrustHtml(this.mdToHtml(m.content || ''));
    return this.renderMd(m.content);
  }

  /**
   * Render Markdown ligero y SEGURO: escapa todo el HTML primero y recién
   * después aplica un subconjunto (negritas, itálicas, code, links http, listas,
   * encabezados, tablas, saltos). Sin dependencias. Cacheado por texto.
   */
  renderMd(src: string): SafeHtml {
    const cached = this.mdCache.get(src);
    if (cached) return cached;
    const safe = this.sanitizer.bypassSecurityTrustHtml(this.mdToHtml(src || ''));
    this.mdCache.set(src, safe);
    return safe;
  }

  /** Paleta de series tokenizada (--chart-*, resuelta por tema; sin morado/azul crudo). */
  private chartPalette(): string[] {
    const g = (n: string, f: string): string => {
      if (typeof getComputedStyle === 'undefined') return f;
      const v = getComputedStyle(document.body).getPropertyValue(n).trim();
      return v || f;
    };
    return [g('--chart-1', '#F05A28'), g('--chart-2', '#185FA5'), g('--chart-3', '#16A34A'), g('--chart-4', '#D97706')];
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
      // links internos a la app (deep-links de Maat) → navegan por router (data-internal)
      .replace(/\[([^\]]+)\]\((\/[^\s)]+)\)/g,
        '<a href="$2" data-internal class="tc-doclink">$1 <i class="pi pi-external-link"></i></a>')
      // links externos → nueva pestaña
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

  /** Detecta si el usuario está cerca del fondo para mostrar/ocultar el botón "ir al final". */
  onScroll() {
    const el = this.thread()?.nativeElement;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.atBottom.set(dist < 80);
  }

  jumpToBottom() { this.scroll(); }

  private scroll() {
    setTimeout(() => {
      const el = this.thread()?.nativeElement;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior: this.reduce ? 'auto' : 'smooth' });
      this.atBottom.set(true);
    }, 50);
  }
}
