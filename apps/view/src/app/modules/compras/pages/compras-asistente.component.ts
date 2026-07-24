import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, ViewChild, inject, signal, computed } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { ComprasService, saveXlsxResponse } from '../compras.service';

interface Msg { role: 'user' | 'assistant'; content: string; pending?: boolean; error?: boolean; tools?: string[]; download?: { id: string; folio: string }; }

/**
 * TOT-C — Asistente conversacional de compras. Arma/ajusta requisiciones a proveedor
 * conversando; el motor RA pone cantidades y costo; el comprador confirma (HITL).
 * Chat compacto (Operations); pega al endpoint /commercial/intelligence/compras/thot/chat.
 */
@Component({
  selector: 'app-compras-asistente',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in ca-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Asistente de compras</h1>
          <p class="surf-page-sub">Armá la requisición conversando: "¿qué toca pedir?", "arma Fabricas Selectas para Padre Hidalgo a cadencia", "sube el globo dorado a 20 cajas", "créala". El motor pone las cantidades; tú apruebas.</p>
        </div>
        @if (messages().length) { <button pButton type="button" label="Nueva" icon="pi pi-plus" class="p-button-sm p-button-text" (click)="reset()"></button> }
      </header>

      <div class="ca-thread" #thread>
        @if (!messages().length) {
          <div class="ca-empty">
            <i class="pi pi-shopping-cart ca-empty-ic"></i>
            <p>Empecemos un pedido. Probá:</p>
            <div class="ca-chips">
              @for (s of samples; track s) { <button class="ca-chip" (click)="send(s)">{{ s }}</button> }
            </div>
          </div>
        }
        @for (m of messages(); track $index) {
          <div class="ca-msg" [class.ca-user]="m.role==='user'" [class.ca-ai]="m.role==='assistant'">
            <div class="ca-bubble" [class.ca-err]="m.error">
              @if (m.pending) { <span class="ca-dots"><i></i><i></i><i></i></span> }
              @else { <div class="ca-text">{{ m.content }}</div>
                @if (m.download) { <button pButton type="button" icon="pi pi-file-excel" [label]="'Descargar ' + m.download.folio + ' (Excel)'" class="p-button-sm ca-dl" [loading]="downloading()===m.download.id" (click)="download(m.download!)"></button> }
                @if (m.tools?.length) { <div class="ca-tools">{{ m.tools!.join(' · ') }}</div> } }
            </div>
          </div>
        }
      </div>

      <form class="ca-input" (ngSubmit)="send(draft)">
        <input type="text" [(ngModel)]="draft" name="draft" [disabled]="sending()"
               placeholder="Escribe tu pedido o pregunta…" autocomplete="off" />
        <button pButton type="submit" icon="pi pi-send" [disabled]="sending() || !draft.trim()" class="p-button-sm"></button>
      </form>
      <p class="ca-note">El asistente crea la requisición en estado <b>pendiente de aprobación</b>. Nada se pide en firme sin tu confirmación.</p>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ca-page { display: flex; flex-direction: column; height: calc(100vh - 7rem); }
    .ca-thread { flex: 1; overflow-y: auto; padding: .5rem .25rem; display: flex; flex-direction: column; gap: .6rem; }
    .ca-empty { margin: auto; text-align: center; color: var(--text-muted); max-width: 30rem; }
    .ca-empty-ic { font-size: 2rem; opacity: .5; display: block; margin-bottom: .5rem; }
    .ca-chips { display: flex; flex-wrap: wrap; gap: .4rem; justify-content: center; margin-top: .75rem; }
    .ca-chip { border: 1px solid var(--border-color); background: var(--surface-card, var(--card-bg)); border-radius: 999px; padding: .35rem .8rem; font-size: .8rem; cursor: pointer; color: var(--text-main); }
    .ca-chip:hover { border-color: var(--action); }
    .ca-msg { display: flex; }
    .ca-user { justify-content: flex-end; }
    .ca-ai { justify-content: flex-start; }
    .ca-bubble { max-width: 82%; padding: .6rem .85rem; border-radius: 14px; font-size: .88rem; line-height: 1.5; }
    .ca-user .ca-bubble { background: var(--action); color: #fff; border-bottom-right-radius: 4px; }
    .ca-ai .ca-bubble { background: var(--surface-card, var(--card-bg)); border: 1px solid var(--border-color); border-bottom-left-radius: 4px; }
    .ca-err { border-color: var(--bad-fg, #b0342a) !important; }
    .ca-text { white-space: pre-wrap; word-break: break-word; }
    .ca-dl { margin-top: .5rem; }
    .ca-tools { font-size: .68rem; color: var(--text-muted); margin-top: .4rem; font-family: var(--font-mono, ui-monospace, monospace); }
    .ca-dots { display: inline-flex; gap: .25rem; }
    .ca-dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); animation: caBlink 1.2s infinite both; }
    .ca-dots i:nth-child(2) { animation-delay: .2s; } .ca-dots i:nth-child(3) { animation-delay: .4s; }
    @keyframes caBlink { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .ca-dots i { animation: none; } }
    .ca-input { display: flex; gap: .5rem; padding: .5rem 0; }
    .ca-input input { flex: 1; padding: .6rem .85rem; border: 1px solid var(--border-color); border-radius: 10px; background: var(--surface-card, var(--card-bg)); color: var(--text-main); font-size: .9rem; }
    .ca-input input:focus { outline: 2px solid var(--action); outline-offset: 1px; }
    .ca-note { font-size: .72rem; color: var(--text-muted); margin: 0 0 .25rem; text-align: center; }
  `],
})
export class ComprasAsistenteComponent {
  private readonly api = inject(ComprasService);
  private readonly destroyRef = inject(DestroyRef);
  @ViewChild('thread') thread?: ElementRef<HTMLElement>;

  messages = signal<Msg[]>([]);
  sending = signal(false);
  downloading = signal<string>('');
  draft = '';
  samples = ['¿Qué toca pedir hoy?', 'Arma Fabricas Selectas para Padre Hidalgo a cadencia', 'Requisiciones pendientes'];

  private history = computed(() => this.messages().filter((m) => !m.pending && !m.error).map((m) => ({ role: m.role, content: m.content })));

  send(text: string): void {
    const t = (text || '').trim();
    if (!t || this.sending()) return;
    this.draft = '';
    this.messages.update((ms) => [...ms, { role: 'user', content: t }]);
    const hist = this.history();
    this.messages.update((ms) => [...ms, { role: 'assistant', content: '', pending: true }]);
    this.sending.set(true);
    this.scroll();
    this.api.comprasChat(hist).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        // ¿alguna tool preparó una descarga? (create/export → requisition_id + download_xlsx)
        const dl = (res.tools_used || []).map((t) => t.result).reverse()
          .find((r) => r && r.download_xlsx && r.requisition_id);
        this.replacePending({
          role: 'assistant', content: res.answer || 'Sin respuesta.',
          tools: (res.tools_used || []).map((x) => x.name), error: res.source === 'error',
          download: dl ? { id: String(dl.requisition_id), folio: String(dl.folio || 'requisición') } : undefined,
        });
        this.sending.set(false); this.scroll();
      },
      error: () => {
        this.replacePending({ role: 'assistant', content: 'No pude responder ahora. Intenta de nuevo.', error: true });
        this.sending.set(false); this.scroll();
      },
    });
  }

  private replacePending(msg: Msg): void {
    this.messages.update((arr) => { const i = arr.findIndex((m) => m.pending); if (i >= 0) { const c = [...arr]; c[i] = msg; return c; } return [...arr, msg]; });
  }
  download(d: { id: string; folio: string }): void {
    this.downloading.set(d.id);
    this.api.exportRequisitionXlsx(d.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (resp) => { saveXlsxResponse(resp, `${d.folio}.xlsx`); this.downloading.set(''); },
      error: () => { this.downloading.set(''); },
    });
  }
  private scroll(): void { setTimeout(() => { const el = this.thread?.nativeElement; if (el) el.scrollTop = el.scrollHeight; }, 30); }
  reset(): void { this.messages.set([]); this.draft = ''; }
}
