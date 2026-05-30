import {
  AfterViewChecked,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, CurrencyPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';
import { forkJoin } from 'rxjs';
import {
  AiSuggestion,
  ChatMessage,
  PortalService,
} from '../portal.service';
import { Router } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  suggestions?: AiSuggestion[];
  timestamp: number;
}

const EXAMPLES = [
  'Quiero 3 cajas de chocolate y 2 de paletas',
  'Surtido para una fiesta de 50 personas',
  '¿Qué me recomendás para reponer caramelos?',
  'Pedido de 5,000 pesos con dulces tradicionales',
];

const NEUTRAL_PALETTE = [
  '#3F3F46', '#52525B', '#71717A', '#27272A',
  '#404040', '#525252', '#262626', '#171717',
];

function hashColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return NEUTRAL_PALETTE[Math.abs(h) % NEUTRAL_PALETTE.length];
}

@Component({
  selector: 'app-portal-recommendations',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CurrencyPipe,
    ButtonModule,
    TooltipModule,
    ConfirmDialogModule,
  ],
  providers: [ConfirmationService],
  template: `
    <p-confirmDialog></p-confirmDialog>

    <div *ngIf="isAdmin()" class="portal-banner" role="status">
      <i class="pi pi-eye" aria-hidden="true"></i>
      <span><b>Vista administrador</b> — el chat usa el catálogo default del tenant. Las acciones de carrito están deshabilitadas.</span>
    </div>

    <div class="ai-chat">
      <header class="ai-head">
        <div class="ai-head-icon"><i class="pi pi-bolt"></i></div>
        <div class="ai-head-body">
          <span class="ai-head-eyebrow">Asistente</span>
          <h1>Pedido con IA</h1>
          <p>Decíme qué necesitás y armo el pedido con productos de tu catálogo.</p>
        </div>
        <button
          type="button"
          class="ai-manual"
          (click)="goManual()"
        >
          <i class="pi pi-th-large"></i>
          <span>Modo manual</span>
        </button>
      </header>

      <div class="ai-body" #scroll>
        <!-- Welcome / empty state -->
        <div *ngIf="turns().length === 0" class="ai-welcome">
          <div class="ai-welcome-icon">
            <i class="pi pi-sparkles"></i>
          </div>
          <h2>¿Qué vas a pedir hoy?</h2>
          <p>Escribime en lenguaje natural lo que necesitás. Te sugiero productos de tu catálogo con precios reales.</p>

          <span class="ai-welcome-label">Probá con:</span>
          <div class="ai-examples">
            <button
              *ngFor="let ex of examples"
              type="button"
              class="ai-ex-chip"
              (click)="sendMessage(ex)"
            >
              <i class="pi pi-comments"></i>
              <span>{{ ex }}</span>
            </button>
          </div>
        </div>

        <!-- Turns -->
        <article
          *ngFor="let t of turns(); let i = index; trackBy: trackByTurn"
          class="ai-turn"
          [class.ai-turn-user]="t.role === 'user'"
          [class.ai-turn-asst]="t.role === 'assistant'"
        >
          <div class="ai-avatar" [class.ai-avatar-user]="t.role === 'user'">
            <i [class]="t.role === 'user' ? 'pi pi-user' : 'pi pi-bolt'"></i>
          </div>

          <div class="ai-bubble-wrap">
            <span class="ai-bubble-role">
              {{ t.role === 'user' ? 'Vos' : 'Asistente' }}
            </span>
            <div class="ai-bubble">
              <div class="ai-bubble-text">{{ t.content }}</div>
            </div>

            <!-- Suggestions -->
            <div *ngIf="t.suggestions && t.suggestions.length > 0" class="ai-sug-block">
              <header class="ai-sug-block-head">
                <i class="pi pi-shopping-bag"></i>
                <span>{{ t.suggestions.length }} sugerencia(s)</span>
              </header>

              <div class="ai-sug-list">
                <div
                  class="ai-sug"
                  *ngFor="let s of t.suggestions; let si = index"
                >
                  <div
                    class="ai-sug-avatar"
                    [style.background]="sugGradient(s.product_id)"
                  >{{ sugInitials(s.product_name) }}</div>

                  <div class="ai-sug-info">
                    <span class="ai-sug-brand">{{ s.brand_name || 'Sin marca' }}</span>
                    <div class="ai-sug-name" [title]="s.product_name">{{ s.product_name }}</div>
                    <div class="ai-sug-reason" *ngIf="s.reason">
                      <i class="pi pi-info-circle"></i>
                      {{ s.reason }}
                    </div>
                    <div class="ai-sug-price">
                      {{ s.unit_price | currency:'MXN':'symbol-narrow':'1.2-2' }}/u
                    </div>
                  </div>

                  <div class="ai-sug-controls">
                    <div
                      class="ai-sug-qty"
                      role="group"
                      [attr.aria-label]="'Cantidad de ' + s.product_name"
                    >
                      <button
                        type="button"
                        class="ai-qty-btn"
                        (click)="changeQty(i, si, -1)"
                        [disabled]="s.qty <= (s.min_qty || 1)"
                        [attr.aria-label]="'Disminuir cantidad de ' + s.product_name"
                      >−</button>
                      <input
                        type="number"
                        min="1"
                        [(ngModel)]="t.suggestions![si].qty"
                        (change)="onQtyChange(i, si)"
                        [attr.aria-label]="'Cantidad de ' + s.product_name"
                      />
                      <button
                        type="button"
                        class="ai-qty-btn"
                        (click)="changeQty(i, si, 1)"
                        [attr.aria-label]="'Aumentar cantidad de ' + s.product_name"
                      >+</button>
                    </div>
                    <div class="ai-sug-subtotal">
                      {{ (s.qty * s.unit_price) | currency:'MXN':'symbol-narrow':'1.2-2' }}
                    </div>
                    <button
                      type="button"
                      class="ai-sug-remove"
                      (click)="removeSuggestion(i, si)"
                      pTooltip="Quitar"
                      aria-label="Quitar sugerencia"
                    >
                      <i class="pi pi-times"></i>
                    </button>
                  </div>
                </div>
              </div>

              <footer class="ai-sug-foot">
                <div class="ai-sug-foot-row">
                  <div class="ai-sug-total">
                    <span class="ai-total-label">Total estimado</span>
                    <b>{{ totalOf(t.suggestions!) | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
                  </div>
                  <button
                    type="button"
                    class="ai-add-cart"
                    [disabled]="adding() || isAdmin() || t.suggestions!.length === 0"
                    (click)="confirmToCart(t.suggestions!)"
                    [pTooltip]="isAdmin() ? 'Vista admin — solo lectura' : ''"
                  >
                    <i [class]="adding() ? 'pi pi-spin pi-spinner' : 'pi pi-shopping-cart'"></i>
                    {{ adding() ? 'Agregando…' : 'Agregar todo' }}
                  </button>
                </div>
                <div class="ai-sug-bulk">
                  <button
                    type="button"
                    class="ai-sug-bulk-btn"
                    [disabled]="isAdmin() || t.suggestions!.length === 0"
                    (click)="bumpAllQty(i, 1)"
                  >
                    <i class="pi pi-plus"></i>
                    Aumentar cantidades
                  </button>
                  <button
                    type="button"
                    class="ai-sug-bulk-btn ai-sug-bulk-btn-danger"
                    [disabled]="t.suggestions!.length === 0"
                    (click)="clearSuggestions(i)"
                  >
                    <i class="pi pi-times"></i>
                    Descartar
                  </button>
                </div>
              </footer>
            </div>
          </div>
        </article>

        <!-- Typing dots -->
        <div *ngIf="loading()" class="ai-typing">
          <div class="ai-avatar"><i class="pi pi-bolt"></i></div>
          <div class="ai-typing-bubble">
            <span class="ai-typing-dot"></span>
            <span class="ai-typing-dot"></span>
            <span class="ai-typing-dot"></span>
          </div>
        </div>
      </div>

      <footer class="ai-input">
        <textarea
          [(ngModel)]="input"
          rows="1"
          placeholder="Escribí lo que necesitás… (ej: 5 cajas de chocolate y 3 de paletas)"
          (keydown.enter)="handleEnter($event)"
          [disabled]="loading()"
          class="ai-input-field"
        ></textarea>
        <button
          type="button"
          class="ai-input-send"
          (click)="sendMessage()"
          [disabled]="!input.trim() || loading()"
          aria-label="Enviar"
        >
          <i class="pi pi-send"></i>
        </button>
      </footer>
    </div>
  `,
  styles: [
    `
      :host { display: block; }

      .ai-chat {
        display: flex;
        flex-direction: column;
        height: calc(100dvh - 160px);
        min-height: 480px;
        max-width: 900px;
        margin: 0 auto;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: 18px;
        overflow: hidden;
        box-shadow: 0 12px 28px -16px rgba(0, 0, 0, 0.1);
      }
      @media (max-width: 900px) {
        .ai-chat {
          height: calc(100dvh - 200px);
          border-radius: 14px;
        }
      }

      /* ── HEAD ──────────────────────────────────────────────────── */
      .ai-head {
        display: grid;
        grid-template-columns: 56px 1fr auto;
        gap: 1rem;
        align-items: center;
        padding: 1rem 1.25rem;
        background: var(--neutral-950);
        color: #fff;
        position: relative;
        overflow: hidden;
        border-bottom: 1px solid var(--neutral-900);
      }
      .ai-head::after {
        content: '';
        position: absolute;
        width: 220px;
        height: 220px;
        right: -60px;
        top: -80px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(253, 231, 7, 0.05), transparent 70%);
        pointer-events: none;
      }
      .ai-head-icon {
        width: 56px;
        height: 56px;
        border-radius: 14px;
        background: var(--neutral-900);
        color: var(--brand-400);
        display: grid;
        place-items: center;
        font-size: 1.5rem;
        position: relative;
        z-index: 1;
      }
      .ai-head-body { position: relative; z-index: 1; min-width: 0; }
      .ai-head-eyebrow {
        display: inline-block;
        font-size: 0.65rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        opacity: 0.85;
      }
      .ai-head h1 {
        margin: 0;
        font-size: 1.0625rem;
        font-weight: 800;
        letter-spacing: -0.01em;
      }
      .ai-head p {
        margin: 0.125rem 0 0;
        font-size: 0.75rem;
        opacity: 0.9;
        line-height: 1.3;
      }
      .ai-manual {
        background: var(--neutral-800);
        border: 1px solid var(--neutral-700);
        color: #fff;
        font-weight: 600;
        font-size: 0.75rem;
        padding: 0.5rem 0.75rem;
        border-radius: 10px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        position: relative;
        z-index: 1;
        transition: background-color 150ms var(--ease-standard);
      }
      .ai-manual:hover { background: var(--neutral-700); }
      @media (max-width: 640px) {
        .ai-manual span { display: none; }
        .ai-head { grid-template-columns: 48px 1fr auto; padding: 0.875rem 1rem; }
        .ai-head-icon { width: 48px; height: 48px; font-size: 1.25rem; }
      }

      /* ── BODY ──────────────────────────────────────────────────── */
      .ai-body {
        flex: 1;
        overflow-y: auto;
        padding: 1.25rem;
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
        background: var(--surface-ground);
        scroll-behavior: smooth;
      }
      .ai-body::-webkit-scrollbar { width: 6px; }
      .ai-body::-webkit-scrollbar-thumb { background: var(--neutral-200); border-radius: 3px; }

      /* ── WELCOME ───────────────────────────────────────────────── */
      .ai-welcome {
        text-align: center;
        padding: 2rem 1rem;
        margin: auto 0;
      }
      .ai-welcome-icon {
        width: 80px;
        height: 80px;
        margin: 0 auto 1rem;
        border-radius: 22px;
        background: var(--neutral-900);
        color: var(--brand-400);
        display: grid;
        place-items: center;
        font-size: 2rem;
        box-shadow: 0 12px 28px -8px rgba(0, 0, 0, 0.25);
        animation: floatY 3s ease-in-out infinite;
      }
      @keyframes floatY {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(-6px); }
      }
      @media (prefers-reduced-motion: reduce) {
        .ai-welcome-icon,
        .ai-typing-dot,
        .ai-turn { animation: none !important; }
        .ai-add-cart:hover,
        .ai-input-send:hover { transform: none !important; }
      }
      .ai-welcome h2 {
        font-size: 1.375rem;
        font-weight: 800;
        margin: 0 0 0.5rem;
        color: var(--text-main);
        letter-spacing: -0.015em;
      }
      .ai-welcome p {
        font-size: 0.9375rem;
        margin: 0 0 1.5rem;
        color: var(--text-muted);
        max-width: 480px;
        margin-left: auto;
        margin-right: auto;
        line-height: 1.45;
      }
      .ai-welcome-label {
        display: block;
        font-size: 0.7rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-faint);
        margin-bottom: 0.625rem;
      }
      .ai-examples {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        justify-content: center;
        max-width: 640px;
        margin: 0 auto;
      }
      .ai-ex-chip {
        background: var(--card-bg);
        border: 1.5px solid var(--border-color);
        border-radius: 999px;
        padding: 0.5rem 0.875rem;
        font-size: 0.8125rem;
        font-weight: 500;
        color: var(--text-main);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        transition: all 150ms var(--ease-standard);
      }
      .ai-ex-chip i {
        font-size: 0.7rem;
        color: var(--text-faint);
      }
      .ai-ex-chip:hover {
        border-color: var(--neutral-400);
        background: var(--neutral-100);
        transform: translateY(-1px);
      }

      /* ── TURNS ─────────────────────────────────────────────────── */
      .ai-turn {
        display: grid;
        grid-template-columns: 36px 1fr;
        gap: 0.625rem;
        align-items: flex-start;
        animation: turnIn 280ms var(--ease-decelerate) both;
      }
      @keyframes turnIn {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .ai-turn-user { grid-template-columns: 1fr 36px; }
      .ai-turn-user .ai-bubble-wrap { align-items: flex-end; text-align: right; }
      .ai-turn-user .ai-avatar { order: 2; }

      .ai-avatar {
        width: 36px;
        height: 36px;
        border-radius: 12px;
        background: var(--neutral-900);
        color: var(--brand-400);
        display: grid;
        place-items: center;
        font-size: 0.95rem;
        flex-shrink: 0;
      }
      .ai-avatar-user {
        background: var(--neutral-200);
        color: var(--text-main);
      }

      .ai-bubble-wrap {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        min-width: 0;
      }
      .ai-bubble-role {
        font-size: 0.65rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-faint);
      }
      .ai-bubble {
        max-width: 85%;
        padding: 0.75rem 0.875rem;
        border-radius: 14px;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        align-self: flex-start;
      }
      .ai-turn-user .ai-bubble {
        background: var(--neutral-900);
        border-color: var(--neutral-900);
        color: #fff;
        align-self: flex-end;
      }
      .ai-bubble-text {
        white-space: pre-wrap;
        line-height: 1.45;
        font-size: 0.9375rem;
        color: inherit;
      }
      .ai-turn-asst .ai-bubble-text {
        color: var(--text-main);
      }

      /* ── SUGGESTIONS BLOCK ────────────────────────────────────── */
      .ai-sug-block {
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: 14px;
        margin-top: 0.5rem;
        overflow: hidden;
        max-width: 100%;
      }
      .ai-sug-block-head {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        padding: 0.625rem 0.875rem;
        background: var(--surface-ground);
        border-bottom: 1px solid var(--border-color);
        font-size: 0.75rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-muted);
      }
      .ai-sug-block-head i { color: var(--text-muted); }

      .ai-sug-list {
        display: flex;
        flex-direction: column;
      }
      .ai-sug {
        display: grid;
        grid-template-columns: 44px 1fr auto;
        gap: 0.75rem;
        align-items: center;
        padding: 0.75rem 0.875rem;
        border-bottom: 1px solid var(--border-color);
      }
      .ai-sug:last-child { border-bottom: none; }
      @media (max-width: 640px) {
        .ai-sug {
          grid-template-columns: 40px 1fr;
          grid-template-areas:
            "avatar info"
            "controls controls";
          row-gap: 0.625rem;
        }
        .ai-sug-avatar { grid-area: avatar; }
        .ai-sug-info { grid-area: info; }
        .ai-sug-controls {
          grid-area: controls;
          justify-content: space-between;
        }
      }

      .ai-sug-avatar {
        width: 44px;
        height: 44px;
        border-radius: 10px;
        color: #fff;
        display: grid;
        place-items: center;
        font-weight: 800;
        font-size: 0.875rem;
        letter-spacing: 0.02em;
        box-shadow: inset 0 -6px 12px rgba(0,0,0,0.12);
      }
      @media (max-width: 640px) {
        .ai-sug-avatar { width: 40px; height: 40px; }
      }

      .ai-sug-info {
        display: flex;
        flex-direction: column;
        gap: 0.125rem;
        min-width: 0;
      }
      .ai-sug-brand {
        font-size: 0.6rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-weight: 700;
        color: var(--text-faint);
      }
      .ai-sug-name {
        font-weight: 600;
        color: var(--text-main);
        font-size: 0.875rem;
        line-height: 1.3;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ai-sug-reason {
        font-size: 0.7rem;
        color: var(--text-muted);
        margin-top: 0.125rem;
        display: inline-flex;
        align-items: flex-start;
        gap: 0.25rem;
        line-height: 1.35;
      }
      .ai-sug-reason i { color: var(--text-faint); flex-shrink: 0; margin-top: 1px; }
      .ai-sug-price {
        font-size: 0.7rem;
        color: var(--text-main);
        font-weight: 700;
        margin-top: 0.125rem;
        font-variant-numeric: tabular-nums;
      }

      .ai-sug-controls {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      .ai-sug-qty {
        display: flex;
        align-items: center;
        border: 1.5px solid var(--border-color);
        border-radius: 8px;
        overflow: hidden;
        height: 32px;
        background: var(--card-bg);
      }
      .ai-qty-btn {
        background: var(--surface-ground);
        border: none;
        width: 28px;
        height: 100%;
        cursor: pointer;
        color: var(--text-main);
        font-weight: 700;
        font-size: 0.95rem;
        display: grid;
        place-items: center;
        transition: background-color 100ms var(--ease-standard);
      }
      .ai-qty-btn:hover:not(:disabled) {
        background: var(--neutral-200);
        color: var(--text-main);
      }
      .ai-qty-btn:disabled { opacity: 0.35; cursor: not-allowed; }
      .ai-sug-qty input {
        width: 38px;
        text-align: center;
        border: none;
        outline: none;
        font-size: 0.8125rem;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        background: transparent;
        color: var(--text-main);
        -moz-appearance: textfield;
      }
      .ai-sug-qty input::-webkit-outer-spin-button,
      .ai-sug-qty input::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }

      .ai-sug-subtotal {
        font-weight: 800;
        color: var(--text-main);
        font-variant-numeric: tabular-nums;
        min-width: 76px;
        text-align: right;
        font-size: 0.875rem;
      }
      .ai-sug-remove {
        background: transparent;
        border: none;
        color: var(--text-faint);
        cursor: pointer;
        width: 28px;
        height: 28px;
        border-radius: 8px;
        display: grid;
        place-items: center;
        transition: background-color 150ms var(--ease-standard), color 150ms var(--ease-standard);
      }
      .ai-sug-remove:hover {
        background: rgba(220, 38, 38, 0.1);
        color: var(--bad-fg);
      }

      .ai-sug-foot {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding: 0.75rem 0.875rem;
        background: var(--surface-ground);
      }
      .ai-sug-foot-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        flex-wrap: wrap;
      }
      .ai-sug-bulk {
        display: flex;
        gap: 0.375rem;
        padding-top: 0.5rem;
        border-top: 1px solid var(--border-color);
      }
      .ai-sug-bulk-btn {
        flex: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.375rem;
        padding: 0.375rem 0.625rem;
        font-size: 0.7rem;
        font-weight: 600;
        color: var(--text-main);
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        cursor: pointer;
        transition: background-color 150ms var(--ease-standard), border-color 150ms var(--ease-standard), color 150ms var(--ease-standard);
      }
      .ai-sug-bulk-btn i { font-size: 0.7rem; }
      .ai-sug-bulk-btn:hover:not(:disabled) {
        background: var(--neutral-100);
        border-color: var(--neutral-300);
      }
      .ai-sug-bulk-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      .ai-sug-bulk-btn-danger:hover:not(:disabled) {
        background: rgba(220, 38, 38, 0.08);
        border-color: rgba(220, 38, 38, 0.25);
        color: var(--bad-fg);
      }
      .ai-sug-total {
        display: flex;
        flex-direction: column;
        gap: 0;
      }
      .ai-total-label {
        font-size: 0.65rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-weight: 700;
        color: var(--text-faint);
      }
      .ai-sug-total b {
        font-size: 1.25rem;
        font-weight: 800;
        color: var(--text-main);
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.01em;
      }

      .ai-add-cart {
        background: var(--neutral-900);
        color: #fff;
        border: none;
        border-radius: 10px;
        padding: 0.625rem 1rem;
        font-weight: 700;
        font-size: 0.8125rem;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        transition: filter 150ms var(--ease-standard), transform 120ms var(--ease-standard), box-shadow 200ms var(--ease-standard);
      }
      .ai-add-cart:hover:not(:disabled) {
        filter: brightness(1.18);
        transform: translateY(-1px);
        box-shadow: inset 0 -2px 0 var(--brand-500);
      }
      .ai-add-cart:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        box-shadow: none;
      }

      /* ── TYPING ────────────────────────────────────────────────── */
      .ai-typing {
        display: grid;
        grid-template-columns: 36px auto;
        gap: 0.625rem;
        align-items: center;
      }
      .ai-typing-bubble {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 0.875rem 1rem;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: 14px;
      }
      .ai-typing-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--text-muted);
        animation: typingBlink 1.2s infinite ease-in-out both;
      }
      .ai-typing-dot:nth-child(2) { animation-delay: 0.18s; }
      .ai-typing-dot:nth-child(3) { animation-delay: 0.36s; }
      @keyframes typingBlink {
        0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
        40% { opacity: 1; transform: scale(1.1); }
      }

      /* ── INPUT ─────────────────────────────────────────────────── */
      .ai-input {
        display: flex;
        gap: 0.5rem;
        align-items: flex-end;
        padding: 0.75rem;
        background: var(--card-bg);
        border-top: 1px solid var(--border-color);
        padding-bottom: calc(0.75rem + env(safe-area-inset-bottom));
      }
      .ai-input-field {
        flex: 1;
        resize: none;
        font-family: inherit;
        font-size: 0.9375rem;
        line-height: 1.4;
        padding: 0.625rem 0.875rem;
        border: 1.5px solid var(--border-color);
        border-radius: 12px;
        background: var(--surface-ground);
        color: var(--text-main);
        outline: none;
        min-height: 42px;
        max-height: 140px;
        transition: border-color 150ms var(--ease-standard), box-shadow 150ms var(--ease-standard), background-color 150ms var(--ease-standard);
      }
      .ai-input-field:focus {
        border-color: var(--neutral-700);
        background: var(--card-bg);
        box-shadow: 0 0 0 3px rgba(253, 231, 7, 0.16);
      }
      .ai-input-field:disabled { opacity: 0.6; cursor: not-allowed; }

      .ai-input-send {
        width: 42px;
        height: 42px;
        border-radius: 12px;
        border: none;
        background: var(--neutral-900);
        color: #fff;
        font-size: 1rem;
        cursor: pointer;
        display: grid;
        place-items: center;
        transition: filter 150ms var(--ease-standard), transform 120ms var(--ease-standard), box-shadow 200ms var(--ease-standard);
        flex-shrink: 0;
      }
      .ai-input-send:hover:not(:disabled) {
        filter: brightness(1.18);
        transform: translateY(-1px);
        box-shadow: inset 0 -2px 0 var(--brand-500);
      }
      .ai-input-send:active:not(:disabled) { transform: translateY(0) scale(0.94); }
      .ai-input-send:disabled {
        opacity: 0.4;
        cursor: not-allowed;
        box-shadow: none;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PortalRecommendationsComponent implements AfterViewChecked {
  private readonly portal = inject(PortalService);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);

  @ViewChild('scroll') scrollRef?: ElementRef<HTMLDivElement>;

  readonly isAdmin = signal<boolean>(this.auth.user()?.role_name === 'superadmin');
  readonly turns = signal<ChatTurn[]>([]);
  readonly loading = signal(false);
  readonly adding = signal(false);
  readonly examples = EXAMPLES;

  input = '';

  ngAfterViewChecked(): void {
    const el = this.scrollRef?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }

  handleEnter(ev: any): void {
    if (ev.shiftKey) return;
    ev.preventDefault();
    this.sendMessage();
  }

  sendMessage(presetText?: string): void {
    const text = (presetText || this.input).trim();
    if (!text || this.loading()) return;

    this.input = '';
    const userTurn: ChatTurn = { role: 'user', content: text, timestamp: Date.now() };
    this.turns.update((arr) => [...arr, userTurn]);
    this.loading.set(true);

    const history: ChatMessage[] = this.turns().slice(0, -1).map((t) => ({
      role: t.role,
      content: t.content,
    }));

    this.portal.aiOrderSuggest(text, history).subscribe({
      next: (r) => {
        this.turns.update((arr) => [
          ...arr,
          {
            role: 'assistant',
            content: r.assistant_message,
            suggestions: r.suggestions || [],
            timestamp: Date.now(),
          },
        ]);
        this.loading.set(false);
      },
      error: (e) => {
        this.loading.set(false);
        this.toast.add({
          severity: 'error',
          summary: 'Error AI',
          detail: e.error?.message || e.message || 'No se pudo procesar el mensaje',
        });
      },
    });
  }

  changeQty(turnIdx: number, sugIdx: number, delta: number): void {
    this.turns.update((arr) => {
      const copy = [...arr];
      const t = { ...copy[turnIdx] };
      const sugs = [...(t.suggestions || [])];
      const floor = Math.max(1, sugs[sugIdx].min_qty || 1);
      sugs[sugIdx] = { ...sugs[sugIdx], qty: Math.max(floor, sugs[sugIdx].qty + delta) };
      t.suggestions = sugs;
      copy[turnIdx] = t;
      return copy;
    });
  }

  onQtyChange(turnIdx: number, sugIdx: number): void {
    this.turns.update((arr) => {
      const copy = [...arr];
      const t = { ...copy[turnIdx] };
      const sugs = [...(t.suggestions || [])];
      const floor = Math.max(1, sugs[sugIdx].min_qty || 1);
      const q = Number(sugs[sugIdx].qty) || floor;
      sugs[sugIdx] = { ...sugs[sugIdx], qty: Math.max(floor, q) };
      t.suggestions = sugs;
      copy[turnIdx] = t;
      return copy;
    });
  }

  removeSuggestion(turnIdx: number, sugIdx: number): void {
    this.turns.update((arr) => {
      const copy = [...arr];
      const t = { ...copy[turnIdx] };
      const sugs = [...(t.suggestions || [])];
      sugs.splice(sugIdx, 1);
      t.suggestions = sugs;
      copy[turnIdx] = t;
      return copy;
    });
  }

  bumpAllQty(turnIdx: number, delta: number): void {
    this.turns.update((arr) => {
      const copy = [...arr];
      const t = { ...copy[turnIdx] };
      t.suggestions = (t.suggestions || []).map((s) => ({
        ...s,
        qty: Math.max(1, (s.qty || 1) + delta),
      }));
      copy[turnIdx] = t;
      return copy;
    });
  }

  clearSuggestions(turnIdx: number): void {
    this.turns.update((arr) => {
      const copy = [...arr];
      copy[turnIdx] = { ...copy[turnIdx], suggestions: [] };
      return copy;
    });
  }

  totalOf(suggestions: AiSuggestion[]): number {
    return suggestions.reduce((acc, s) => acc + s.qty * s.unit_price, 0);
  }

  confirmToCart(suggestions: AiSuggestion[]): void {
    if (this.isAdmin()) {
      this.toast.add({
        severity: 'info',
        summary: 'Vista admin',
        detail: 'Solo lectura. Iniciá sesión como cliente para confirmar pedidos.',
      });
      return;
    }
    if (suggestions.length === 0) return;
    const total = this.totalOf(suggestions);
    this.confirm.confirm({
      header: 'Confirmar al carrito',
      message: `¿Agregar ${suggestions.length} producto(s) al carrito por un total de $${total.toFixed(2)}?`,
      icon: 'pi pi-shopping-cart',
      acceptLabel: 'Agregar',
      rejectLabel: 'Cancelar',
      accept: () => this.addToCart(suggestions),
    });
  }

  private addToCart(suggestions: AiSuggestion[]): void {
    this.adding.set(true);
    forkJoin({
      customer: this.portal.myCustomerInfo(),
      warehouses: this.portal.listWarehouses(),
    }).subscribe({
      next: ({ customer, warehouses }) => {
        if (!customer) {
          this.adding.set(false);
          this.toast.add({
            severity: 'error',
            summary: 'Sin customer',
            detail: 'Tu usuario no está linkeado a un cliente.',
          });
          return;
        }
        const wh = warehouses.find((w: any) => w.is_default) || warehouses[0];
        if (!wh) {
          this.adding.set(false);
          this.toast.add({ severity: 'error', summary: 'Sin almacén', detail: 'No hay almacén configurado.' });
          return;
        }
        this.portal.ensureDraft(customer.id, wh.id).subscribe({
          next: (draft) => {
            let pending = suggestions.length;
            let added = 0;
            const failures: { name: string; reason: string }[] = [];
            for (const s of suggestions) {
              this.portal.addLine(draft.id, s.product_id, s.qty).subscribe({
                next: () => {
                  added++;
                  if (--pending === 0) this.finishAdding(added, failures);
                },
                error: (err) => {
                  const reason = err?.error?.message || err?.message || 'Error desconocido';
                  failures.push({ name: s.product_name, reason });
                  console.warn('[AI add] addLine FAIL', s.product_id, s.product_name, reason);
                  if (--pending === 0) this.finishAdding(added, failures);
                },
              });
            }
          },
          error: (e) => {
            this.adding.set(false);
            this.toast.add({ severity: 'error', summary: 'Error draft', detail: e.message });
          },
        });
      },
      error: (e) => {
        this.adding.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: e.message });
      },
    });
  }

  private finishAdding(added: number, failures: { name: string; reason: string }[]): void {
    this.adding.set(false);
    const failed = failures.length;
    if (failed === 0) {
      this.toast.add({
        severity: 'success',
        summary: '¡Listo!',
        detail: `${added} producto(s) agregado(s) al carrito.`,
      });
    } else {
      // Mostramos un toast por cada falla (max 3 para no saturar) con el
      // detalle del backend — usualmente "Cantidad mínima X" o "sin precio".
      this.toast.add({
        severity: added > 0 ? 'warn' : 'error',
        summary: added > 0 ? `${added} agregados, ${failed} fallaron` : `${failed} productos fallaron`,
        detail: 'Revisá los detalles abajo.',
        life: 5000,
      });
      for (const f of failures.slice(0, 3)) {
        this.toast.add({
          severity: 'error',
          summary: f.name.length > 40 ? f.name.slice(0, 37) + '…' : f.name,
          detail: f.reason,
          life: 6000,
        });
      }
      if (failures.length > 3) {
        this.toast.add({
          severity: 'info',
          summary: `+${failures.length - 3} más`,
          detail: 'Revisá la consola para el detalle completo.',
          life: 4000,
        });
      }
    }
    if (added > 0) {
      setTimeout(() => this.router.navigateByUrl('/portal/cart'), 1500);
    }
  }

  goManual(): void {
    this.router.navigateByUrl('/portal/catalog');
  }

  trackByTurn = (_i: number, t: ChatTurn) => t.timestamp;

  sugGradient(productId: string): string {
    const c = hashColor(productId || '');
    return `linear-gradient(135deg, ${c}, ${this.darken(c, 0.15)})`;
  }

  sugInitials(name: string): string {
    const n = (name || '?').trim();
    const words = n.split(/\s+/).slice(0, 2);
    return words.map((w) => w.charAt(0).toUpperCase()).join('') || '?';
  }

  private darken(hex: string, amount: number): string {
    const h = hex.replace('#', '');
    const r = Math.max(0, parseInt(h.slice(0, 2), 16) - Math.round(255 * amount));
    const g = Math.max(0, parseInt(h.slice(2, 4), 16) - Math.round(255 * amount));
    const b = Math.max(0, parseInt(h.slice(4, 6), 16) - Math.round(255 * amount));
    return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  }
}
