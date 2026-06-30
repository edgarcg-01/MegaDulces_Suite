import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { PortalService } from '../portal.service';

interface Msg { role: 'user' | 'assistant'; content: string; blocks?: Block[]; pending?: boolean; error?: boolean; }
interface Block { title: string; columns: string[]; rows: Record<string, any>[]; }

const SUGGESTIONS = [
  '¿Qué me conviene pedir hoy?',
  'Repíteme mi último pedido',
  '¿Tienen Bubaloo disponible?',
  '¿Qué promociones hay para mí?',
  '¿Qué suelo comprar?',
];

/**
 * TC-P — Asistente de compras del Portal B2B (Storefront). Habla SOLO de la cuenta
 * del cliente (scoped server-side). Surtido desde PH. No expone márgenes ni datos
 * de terceros.
 */
@Component({
  selector: 'app-portal-assistant',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pa">
      <header class="pa-head">
        <h1>Tu asistente</h1>
        <p>Preguntame qué te conviene pedir, tus pedidos, promociones o si hay algo disponible.</p>
      </header>

      <div class="pa-thread" #thread>
        @if (messages().length === 0) {
          <div class="pa-empty">
            <div class="pa-chips">
              @for (s of suggestions; track s) {
                <button class="pa-chip" (click)="send(s)">{{ s }}</button>
              }
            </div>
          </div>
        }
        @for (m of messages(); track $index) {
          <div class="pa-msg" [class.me]="m.role === 'user'">
            <div class="pa-bubble" [class.err]="m.error">
              @if (m.pending) { <span class="pa-dots"><i></i><i></i><i></i></span> }
              @else {
                <p class="pa-text">{{ m.content }}</p>
                @for (b of m.blocks || []; track b.title) {
                  <div class="pa-block">
                    <table>
                      <thead><tr>@for (c of b.columns; track c) { <th>{{ c }}</th> }</tr></thead>
                      <tbody>
                        @for (r of b.rows; track $index) {
                          <tr>@for (c of b.columns; track c) { <td>{{ fmt(r[c]) }}</td> }</tr>
                        }
                      </tbody>
                    </table>
                  </div>
                }
              }
            </div>
          </div>
        }
        @if (messages().length > 0) {
          <a routerLink="/portal/catalog" class="pa-cta">Ir al catálogo a armar mi pedido →</a>
        }
      </div>

      <form class="pa-input" (ngSubmit)="send(draft)">
        <input [(ngModel)]="draft" name="draft" [disabled]="loading()" placeholder="Escribí tu pregunta…" autocomplete="off" />
        <button type="submit" [disabled]="!draft.trim() || loading()" aria-label="Enviar"><i class="pi pi-arrow-up"></i></button>
      </form>
    </div>
  `,
  styles: [`
    .pa { display: flex; flex-direction: column; height: calc(100vh - 9rem); max-width: 760px; margin: 0 auto; padding: 1rem; }
    .pa-head h1 { font-family: var(--font-display, 'Fraunces', serif); font-size: 1.9rem; margin: 0 0 .2rem; }
    .pa-head p { color: var(--c-text-2, #6b6b6b); margin: 0 0 1rem; }
    .pa-thread { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: .9rem; padding-bottom: 1rem; }
    .pa-empty { margin-top: 1rem; }
    .pa-chips { display: flex; flex-wrap: wrap; gap: .5rem; }
    .pa-chip { border: 1px solid var(--c-border, #e6e1d8); background: var(--c-surface, #fff); border-radius: 999px; padding: .55rem 1rem; font-size: .9rem; cursor: pointer; }
    .pa-chip:hover { border-color: var(--action, #d2691e); }
    .pa-msg { display: flex; }
    .pa-msg.me { justify-content: flex-end; }
    .pa-bubble { max-width: 88%; background: var(--c-surface, #fff); border: 1px solid var(--c-border, #e6e1d8); border-radius: 16px; padding: .8rem 1rem; line-height: 1.6; }
    .pa-msg.me .pa-bubble { background: var(--action-soft-bg, #faf3ec); }
    .pa-bubble.err { border-color: #c0392b; }
    .pa-text { margin: 0; white-space: pre-wrap; }
    .pa-block { margin-top: .6rem; overflow-x: auto; }
    .pa-block table { border-collapse: collapse; width: 100%; font-size: .85rem; }
    .pa-block th, .pa-block td { padding: .35rem .6rem; text-align: left; border-bottom: 1px solid var(--c-border, #eee); white-space: nowrap; }
    .pa-block th { color: var(--c-text-2, #777); font-weight: 600; }
    .pa-cta { align-self: flex-start; color: var(--action, #d2691e); font-weight: 600; text-decoration: none; margin-top: .25rem; }
    .pa-dots { display: inline-flex; gap: 4px; }
    .pa-dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--c-text-2, #aaa); animation: pad 1.2s infinite both; }
    .pa-dots i:nth-child(2) { animation-delay: .2s; } .pa-dots i:nth-child(3) { animation-delay: .4s; }
    @keyframes pad { 0%,80%,100% { opacity: .2; } 40% { opacity: 1; } }
    .pa-input { display: flex; gap: .5rem; padding-top: .5rem; border-top: 1px solid var(--c-border, #e6e1d8); }
    .pa-input input { flex: 1; padding: .7rem 1rem; border: 1px solid var(--c-border, #e6e1d8); border-radius: 999px; font-size: .95rem; }
    .pa-input input:focus { outline: none; border-color: var(--action, #d2691e); }
    .pa-input button { width: 44px; height: 44px; border: none; border-radius: 50%; background: var(--action, #d2691e); color: #fff; cursor: pointer; }
    .pa-input button:disabled { opacity: .4; cursor: default; }
  `],
})
export class PortalAssistantComponent {
  readonly suggestions = SUGGESTIONS;
  private readonly svc = inject(PortalService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly thread = viewChild<ElementRef<HTMLElement>>('thread');

  messages = signal<Msg[]>([]);
  loading = signal(false);
  draft = '';

  private history = computed(() => this.messages().filter((m) => !m.pending && !m.error).map((m) => ({ role: m.role, content: m.content })));

  send(text: string) {
    const q = (text || '').trim();
    if (!q || this.loading()) return;
    const hist = this.history();
    this.messages.update((ms) => [...ms, { role: 'user', content: q }, { role: 'assistant', content: '', pending: true }]);
    this.draft = '';
    this.loading.set(true);
    this.scroll();
    this.svc.thotChat(hist, q).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        const blocks = (res.tools_used || []).map((t) => this.toBlock(t.result)).filter((b): b is Block => !!b);
        this.replacePending({ role: 'assistant', content: res.answer, blocks, error: res.source === 'error' });
        this.loading.set(false); this.scroll();
      },
      error: () => { this.replacePending({ role: 'assistant', content: 'No pude responder ahora. Probá de nuevo.', error: true }); this.loading.set(false); this.scroll(); },
    });
  }

  private replacePending(msg: Msg) {
    this.messages.update((ms) => { const c = [...ms]; const i = c.findIndex((m) => m.pending); if (i >= 0) c[i] = msg; else c.push(msg); return c; });
  }

  private toBlock(result: any): Block | null {
    const rows = Array.isArray(result) ? result : (result?.items || result?.rows || result?.customers || null);
    if (!Array.isArray(rows) || !rows.length || typeof rows[0] !== 'object') return null;
    const cols = Object.keys(rows[0]).filter((k) => !/_id$|^id$/.test(k)).slice(0, 5);
    if (!cols.length) return null;
    return { title: 'datos', columns: cols, rows: rows.slice(0, 8) };
  }

  fmt(v: any): string {
    if (v == null) return '—';
    if (typeof v === 'boolean') return v ? 'Sí' : 'No';
    if (typeof v === 'number') return v.toLocaleString('es-MX', { maximumFractionDigits: 2 });
    return String(v);
  }

  private scroll() { setTimeout(() => { const el = this.thread()?.nativeElement; if (el) el.scrollTop = el.scrollHeight; }, 50); }
}
