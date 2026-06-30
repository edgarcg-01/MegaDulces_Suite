import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { VendorService } from '../vendor.service';

interface Msg { role: 'user' | 'assistant'; content: string; blocks?: Block[]; pending?: boolean; error?: boolean; }
interface Block { columns: string[]; rows: Record<string, any>[]; }

const SUGGESTIONS = [
  '¿A quién visito hoy?',
  '¿Quién no me ha comprado?',
  '¿Qué le ofrezco a...?',
  '¿Hay stock de Bubaloo?',
  '¿Cómo va mi día?',
];

/**
 * TC-V — Copiloto del vendedor en ruta (mobile-first + voz). Scoped a su cartera
 * (server-side). Stock desde PH. Reusa Web Speech (es-MX) para dictar.
 */
@Component({
  selector: 'app-vendor-assistant',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="va">
      <header class="va-head"><h1>Copiloto Thot</h1></header>

      <div class="va-thread" #thread>
        @if (messages().length === 0) {
          <div class="va-chips">
            @for (s of suggestions; track s) { <button class="va-chip" (click)="send(s)">{{ s }}</button> }
          </div>
        }
        @for (m of messages(); track $index) {
          <div class="va-msg" [class.me]="m.role === 'user'">
            <div class="va-bubble" [class.err]="m.error">
              @if (m.pending) { <span class="va-dots"><i></i><i></i><i></i></span> }
              @else {
                <p>{{ m.content }}</p>
                @for (b of m.blocks || []; track $index) {
                  <div class="va-block">
                    <table>
                      <thead><tr>@for (c of b.columns; track c) { <th>{{ c }}</th> }</tr></thead>
                      <tbody>@for (r of b.rows; track $index) { <tr>@for (c of b.columns; track c) { <td>{{ fmt(r[c]) }}</td> }</tr> }</tbody>
                    </table>
                  </div>
                }
              }
            </div>
          </div>
        }
      </div>

      <form class="va-input" (ngSubmit)="send(draft)">
        @if (voiceSupported) {
          <button type="button" class="va-mic" [class.on]="listening()" (click)="toggleVoice()" aria-label="Dictar">
            <i class="pi" [class.pi-microphone]="!listening()" [class.pi-stop-circle]="listening()"></i>
          </button>
        }
        <input [(ngModel)]="draft" name="draft" [disabled]="loading()" [placeholder]="listening() ? 'Escuchando…' : 'Preguntá o dictá…'" autocomplete="off" />
        <button type="submit" class="va-send" [disabled]="!draft.trim() || loading()" aria-label="Enviar"><i class="pi pi-arrow-up"></i></button>
      </form>
    </div>
  `,
  styles: [`
    .va { display: flex; flex-direction: column; height: 100dvh; background: var(--c-bg, #f7f5f1); }
    .va-head { padding: .9rem 1rem; border-bottom: 1px solid var(--c-border, #e6e1d8); background: var(--c-surface, #fff); }
    .va-head h1 { margin: 0; font-size: 1.2rem; }
    .va-thread { flex: 1; overflow-y: auto; padding: 1rem; display: flex; flex-direction: column; gap: .7rem; }
    .va-chips { display: flex; flex-wrap: wrap; gap: .5rem; }
    .va-chip { border: 1px solid var(--c-border, #e6e1d8); background: var(--c-surface, #fff); border-radius: 999px; padding: .6rem 1rem; font-size: .9rem; }
    .va-msg { display: flex; } .va-msg.me { justify-content: flex-end; }
    .va-bubble { max-width: 90%; background: var(--c-surface, #fff); border: 1px solid var(--c-border, #e6e1d8); border-radius: 14px; padding: .7rem .9rem; line-height: 1.5; font-size: .95rem; }
    .va-msg.me .va-bubble { background: var(--action-soft-bg, #eef4ff); }
    .va-bubble.err { border-color: #c0392b; }
    .va-bubble p { margin: 0; white-space: pre-wrap; }
    .va-block { margin-top: .5rem; overflow-x: auto; }
    .va-block table { border-collapse: collapse; width: 100%; font-size: .82rem; }
    .va-block th, .va-block td { padding: .3rem .5rem; text-align: left; border-bottom: 1px solid var(--c-border, #eee); white-space: nowrap; }
    .va-block th { color: var(--c-text-2, #777); }
    .va-dots { display: inline-flex; gap: 4px; }
    .va-dots i { width: 6px; height: 6px; border-radius: 50%; background: #aaa; animation: vad 1.2s infinite both; }
    .va-dots i:nth-child(2) { animation-delay: .2s; } .va-dots i:nth-child(3) { animation-delay: .4s; }
    @keyframes vad { 0%,80%,100% { opacity: .2; } 40% { opacity: 1; } }
    .va-input { display: flex; gap: .5rem; padding: .6rem; border-top: 1px solid var(--c-border, #e6e1d8); background: var(--c-surface, #fff); align-items: center; }
    .va-input input { flex: 1; padding: .8rem 1rem; border: 1px solid var(--c-border, #e6e1d8); border-radius: 999px; font-size: 1rem; }
    .va-input input:focus { outline: none; border-color: var(--action, #2f6fed); }
    .va-mic, .va-send { width: 46px; height: 46px; border: none; border-radius: 50%; flex: 0 0 auto; cursor: pointer; }
    .va-mic { background: var(--c-surface-2, #eee); color: #444; }
    .va-mic.on { background: #c0392b; color: #fff; animation: vapulse 1.2s infinite; }
    .va-send { background: var(--action, #2f6fed); color: #fff; }
    .va-send:disabled { opacity: .4; }
    @keyframes vapulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.08); } }
  `],
})
export class VendorAssistantComponent {
  readonly suggestions = SUGGESTIONS;
  private readonly svc = inject(VendorService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly thread = viewChild<ElementRef<HTMLElement>>('thread');

  messages = signal<Msg[]>([]);
  loading = signal(false);
  listening = signal(false);
  draft = '';

  private recog: any = null;
  readonly voiceSupported = typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

  private history = computed(() => this.messages().filter((m) => !m.pending && !m.error).map((m) => ({ role: m.role, content: m.content })));

  send(text: string) {
    const q = (text || '').trim();
    if (!q || this.loading()) return;
    this.stopVoice();
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
      error: () => { this.replacePending({ role: 'assistant', content: 'No pude responder ahora.', error: true }); this.loading.set(false); this.scroll(); },
    });
  }

  toggleVoice() {
    if (this.listening()) { this.stopVoice(); return; }
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Ctor) return;
    this.recog = new Ctor();
    this.recog.lang = 'es-MX';
    this.recog.interimResults = true;
    this.recog.continuous = false;
    this.recog.onresult = (e: any) => {
      let txt = '';
      for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
      this.draft = txt;
    };
    this.recog.onend = () => { this.listening.set(false); if (this.draft.trim()) this.send(this.draft); };
    this.recog.onerror = () => this.listening.set(false);
    this.listening.set(true);
    try { this.recog.start(); } catch { this.listening.set(false); }
  }

  private stopVoice() { if (this.recog) { try { this.recog.stop(); } catch { /* noop */ } } this.listening.set(false); }

  private replacePending(msg: Msg) {
    this.messages.update((ms) => { const c = [...ms]; const i = c.findIndex((m) => m.pending); if (i >= 0) c[i] = msg; else c.push(msg); return c; });
  }

  private toBlock(result: any): Block | null {
    const rows = Array.isArray(result) ? result : (result?.items || result?.rows || result?.customers || result?.usual_products || null);
    if (!Array.isArray(rows) || !rows.length || typeof rows[0] !== 'object') return null;
    const cols = Object.keys(rows[0]).filter((k) => !/_id$|^id$/.test(k)).slice(0, 4);
    if (!cols.length) return null;
    return { columns: cols, rows: rows.slice(0, 8) };
  }

  fmt(v: any): string {
    if (v == null) return '—';
    if (typeof v === 'boolean') return v ? 'Sí' : 'No';
    if (typeof v === 'number') return v.toLocaleString('es-MX', { maximumFractionDigits: 2 });
    return String(v);
  }

  private scroll() { setTimeout(() => { const el = this.thread()?.nativeElement; if (el) el.scrollTop = el.scrollHeight; }, 50); }
}
