import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
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
interface DataBlock {
  title: string;
  columns: string[];
  rows: Record<string, any>[];
  extra: number;
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

      <div class="tc-thread" #thread>
        @if (messages().length === 0) {
          <div class="tc-empty">
            <div class="tc-empty-icon"><i class="pi pi-comments" aria-hidden="true"></i></div>
            <h3>¿Qué querés saber?</h3>
            <p>Probá con una de estas:</p>
            <div class="tc-suggest">
              @for (s of suggestions; track s) {
                <button class="tc-chip" (click)="send(s)">{{ s }}</button>
              }
            </div>
          </div>
        }

        @for (m of messages(); track $index) {
          <div class="tc-msg" [class.tc-user]="m.role === 'user'" [class.tc-bot]="m.role === 'assistant'">
            <div class="tc-avatar">
              <i [class]="m.role === 'user' ? 'pi pi-user' : 'pi pi-sparkles'" aria-hidden="true"></i>
            </div>
            <div class="tc-bubble" [class.tc-err]="m.error">
              @if (m.pending) {
                <span class="tc-typing"><i></i><i></i><i></i></span>
              } @else {
                <div class="tc-text">{{ m.content }}</div>
                @for (b of m.blocks || []; track b.title) {
                  <div class="tc-block">
                    <div class="tc-block-title">{{ b.title }}</div>
                    <div class="tc-table-wrap">
                      <table class="tc-table">
                        <thead>
                          <tr>@for (c of b.columns; track c) { <th>{{ c }}</th> }</tr>
                        </thead>
                        <tbody>
                          @for (r of b.rows; track $index) {
                            <tr>@for (c of b.columns; track c) { <td>{{ fmt(r[c]) }}</td> }</tr>
                          }
                        </tbody>
                      </table>
                    </div>
                    @if (b.extra > 0) { <div class="tc-more">+{{ b.extra }} filas más</div> }
                  </div>
                }
              }
            </div>
          </div>
        }
      </div>

      <form class="tc-input" (ngSubmit)="send(draft)">
        <input type="text" [(ngModel)]="draft" name="draft" [disabled]="loading()"
               placeholder="Escribí tu pregunta…" autocomplete="off" />
        <button pButton type="submit" icon="pi pi-send" [loading]="loading()" [disabled]="!draft.trim()"></button>
      </form>
    </div>
  `,
  styles: [`
    .tc-page { display: flex; flex-direction: column; height: calc(100vh - 7rem); }
    .tc-thread { flex: 1; overflow-y: auto; padding: .5rem .25rem 1rem; display: flex; flex-direction: column; gap: 1rem; }
    .tc-empty { margin: auto; text-align: center; max-width: 520px; color: var(--text-muted,var(--c-text-2)); }
    .tc-empty-icon { font-size: 2rem; opacity: .5; margin-bottom: .5rem; }
    .tc-empty h3 { margin: 0 0 .25rem; color: var(--text,var(--c-text-1)); }
    .tc-suggest { display: flex; flex-wrap: wrap; gap: .5rem; justify-content: center; margin-top: 1rem; }
    .tc-chip { background: var(--surface-card,var(--c-surface)); border: 1px solid var(--surface-200,var(--c-border)); border-radius: 999px; padding: .5rem .9rem; font-size: .82rem; cursor: pointer; transition: border-color .15s; color: var(--text,var(--c-text-1)); }
    .tc-chip:hover { border-color: var(--action); }
    .tc-msg { display: flex; gap: .65rem; max-width: 860px; }
    .tc-user { flex-direction: row-reverse; align-self: flex-end; }
    .tc-avatar { width: 30px; height: 30px; border-radius: 8px; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; background: var(--surface-100,var(--c-surface-2)); color: var(--text-muted,var(--c-text-2)); font-size: .85rem; }
    .tc-bot .tc-avatar { background: var(--action); color: #fff; }
    .tc-bubble { background: var(--surface-card,var(--c-surface)); border: 1px solid var(--surface-200,var(--c-border)); border-radius: 12px; padding: .7rem .9rem; font-size: .9rem; line-height: 1.5; }
    .tc-user .tc-bubble { background: var(--action-soft-bg,var(--surface-100)); }
    .tc-err { border-color: var(--bad-fg); }
    .tc-text { white-space: pre-wrap; }
    .tc-block { margin-top: .7rem; }
    .tc-block-title { font-size: .72rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted,var(--c-text-2)); margin-bottom: .3rem; }
    .tc-table-wrap { overflow-x: auto; border: 1px solid var(--surface-200,var(--c-border)); border-radius: 8px; }
    .tc-table { border-collapse: collapse; width: 100%; font-size: .8rem; }
    .tc-table th, .tc-table td { padding: .35rem .6rem; text-align: left; white-space: nowrap; border-bottom: 1px solid var(--surface-100,var(--c-surface-2)); }
    .tc-table th { font-weight: 600; color: var(--text-muted,var(--c-text-2)); background: var(--surface-50,var(--c-surface-2)); }
    .tc-table tbody tr:last-child td { border-bottom: none; }
    .tc-more { font-size: .72rem; color: var(--text-muted,var(--c-text-2)); margin-top: .3rem; }
    .tc-typing { display: inline-flex; gap: 4px; }
    .tc-typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted,var(--c-text-2)); animation: tc-blink 1.2s infinite both; }
    .tc-typing i:nth-child(2) { animation-delay: .2s; } .tc-typing i:nth-child(3) { animation-delay: .4s; }
    @keyframes tc-blink { 0%,80%,100% { opacity: .2; } 40% { opacity: 1; } }
    .tc-input { display: flex; gap: .5rem; padding-top: .5rem; border-top: 1px solid var(--surface-200,var(--c-border)); }
    .tc-input input { flex: 1; padding: .65rem .9rem; border: 1px solid var(--surface-200,var(--c-border)); border-radius: 10px; font-size: .9rem; background: var(--surface-card,var(--c-surface)); color: var(--text,var(--c-text-1)); }
    .tc-input input:focus { outline: none; border-color: var(--action); }
  `],
})
export class ComercialThotChatComponent {
  readonly tabs = ANALYTICS_TABS;
  readonly suggestions = SUGGESTIONS;
  private readonly svc = inject(ComercialService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly thread = viewChild<ElementRef<HTMLElement>>('thread');

  messages = signal<ChatMsg[]>([]);
  loading = signal(false);
  draft = '';

  /** Historial (solo texto) para mandar al backend. */
  private history = computed<ThotChatTurn[]>(() =>
    this.messages().filter((m) => !m.pending && !m.error).map((m) => ({ role: m.role, content: m.content })),
  );

  send(text: string) {
    const q = (text || '').trim();
    if (!q || this.loading()) return;
    const histForApi = this.history();
    this.messages.update((ms) => [...ms, { role: 'user', content: q }, { role: 'assistant', content: '', pending: true }]);
    this.draft = '';
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

  /** Extrae una tabla compacta del resultado de una tool (transparencia). */
  private toBlock(t: ThotToolTrace): DataBlock | null {
    const rows = this.extractRows(t.result);
    if (!rows.length) return null;
    const cols = Object.keys(rows[0]).filter((k) => k !== '_truncated' && !/_id$/.test(k)).slice(0, 7);
    if (!cols.length) return null;
    const shown = rows.slice(0, 10);
    return {
      title: this.toolLabel(t.name),
      columns: cols,
      rows: shown,
      extra: Math.max(0, rows.length - shown.length),
    };
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

  fmt(v: any): string {
    if (v == null) return '—';
    if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('es-MX') : v.toLocaleString('es-MX', { maximumFractionDigits: 2 });
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  private scroll() {
    setTimeout(() => {
      const el = this.thread()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    }, 50);
  }
}
