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
import { brandPlaceholderGradient } from '../../../core/util/brand-placeholder';
import { CountUpDirective } from '../ui/count-up.directive';

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  suggestions?: AiSuggestion[];
  timestamp: number;
}

const EXAMPLES = [
  'Quiero 3 cajas de chocolate y 2 de paletas',
  'Surtido para una fiesta de 50 personas',
  '¿Qué me recomiendas para reponer caramelos?',
  'Pedido de 5,000 pesos con dulces tradicionales',
];

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
    CountUpDirective,
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
          <p>Dime qué necesitas y armo el pedido con productos de tu catálogo.</p>
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
          <p>Escríbeme en lenguaje natural lo que necesitas. Te sugiero productos de tu catálogo con precios reales.</p>

          <span class="ai-welcome-label">Prueba con:</span>
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
              {{ t.role === 'user' ? 'Tú' : 'Asistente' }}
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
                    <b [countUp]="totalOf(t.suggestions!)"></b>
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
          placeholder="Escribe lo que necesitas… (ej: 5 cajas de chocolate y 3 de paletas)"
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
        border-radius: var(--r-lg);
        overflow: hidden;
        box-shadow: var(--shadow-float);
      }
      @media (max-width: 900px) {
        .ai-chat {
          height: calc(100dvh - 200px);
          border-radius: var(--r-lg);
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
        border-radius: var(--r-lg);
        background: var(--ember-grad);
        color: #fff;
        display: grid;
        place-items: center;
        font-size: var(--fs-h2);
        position: relative;
        z-index: 1;
      }
      .ai-head-body { position: relative; z-index: 1; min-width: 0; }
      .ai-head-eyebrow {
        display: inline-block;
        font-size: var(--fs-nano);
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        opacity: 0.85;
      }
      .ai-head h1 {
        margin: 0;
        font-size: var(--fs-h3);
        font-weight: 800;
        letter-spacing: -0.01em;
      }
      .ai-head p {
        margin: 0.125rem 0 0;
        font-size: var(--fs-xs);
        opacity: 0.9;
        line-height: 1.3;
      }
      .ai-manual {
        background: var(--neutral-800);
        border: 1px solid var(--neutral-700);
        color: #fff;
        font-weight: 600;
        font-size: var(--fs-xs);
        padding: 0.5rem 0.75rem;
        border-radius: var(--r-md);
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
        .ai-head-icon { width: 48px; height: 48px; font-size: var(--fs-h2); }
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
        border-radius: var(--r-xl);
        background: var(--ember-grad);
        color: #fff;
        display: grid;
        place-items: center;
        font-size: var(--fs-h1);
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
        font-size: var(--fs-h2);
        font-weight: 800;
        margin: 0 0 0.5rem;
        color: var(--text-main);
        letter-spacing: -0.015em;
      }
      .ai-welcome p {
        font-size: var(--fs-body);
        margin: 0 0 1.5rem;
        color: var(--text-muted);
        max-width: 480px;
        margin-left: auto;
        margin-right: auto;
        line-height: 1.45;
      }
      .ai-welcome-label {
        display: block;
        font-size: var(--fs-micro);
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
        border-radius: var(--r-pill);
        padding: 0.5rem 0.875rem;
        font-size: var(--fs-sm);
        font-weight: 500;
        color: var(--text-main);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        transition: all 150ms var(--ease-standard);
      }
      .ai-ex-chip i {
        font-size: var(--fs-micro);
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
        border-radius: var(--r-md);
        background: var(--ember-grad);
        color: #fff;
        display: grid;
        place-items: center;
        font-size: var(--fs-h3);
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
        font-size: var(--fs-nano);
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-faint);
      }
      .ai-bubble {
        max-width: 85%;
        padding: 0.75rem 0.875rem;
        border-radius: var(--r-lg);
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
        font-size: var(--fs-body);
        color: inherit;
      }
      .ai-turn-asst .ai-bubble-text {
        color: var(--text-main);
      }

      /* ── SUGGESTIONS BLOCK ────────────────────────────────────── */
      .ai-sug-block {
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: var(--r-lg);
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
        font-size: var(--fs-xs);
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
        border-radius: var(--r-md);
        color: #fff;
        display: grid;
        place-items: center;
        overflow: hidden;
        font-family: var(--font-display);
        font-weight: 700;
        font-size: var(--fs-body);
        letter-spacing: 0.01em;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
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
        font-size: var(--fs-nano);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-weight: 700;
        color: var(--text-faint);
      }
      .ai-sug-name {
        font-weight: 600;
        color: var(--text-main);
        font-size: var(--fs-body);
        line-height: 1.3;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ai-sug-reason {
        font-size: var(--fs-micro);
        color: var(--text-muted);
        margin-top: 0.125rem;
        display: inline-flex;
        align-items: flex-start;
        gap: 0.25rem;
        line-height: 1.35;
      }
      .ai-sug-reason i { color: var(--text-faint); flex-shrink: 0; margin-top: 1px; }
      .ai-sug-price {
        font-size: var(--fs-micro);
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
        border-radius: var(--r-sm);
        overflow: hidden;
        height: 40px;
        background: var(--card-bg);
      }
      .ai-qty-btn {
        background: var(--surface-ground);
        border: none;
        width: 38px;
        height: 100%;
        cursor: pointer;
        color: var(--text-main);
        font-weight: 700;
        font-size: var(--fs-h3);
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
        font-size: var(--fs-sm);
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
        font-size: var(--fs-body);
      }
      .ai-sug-remove {
        background: transparent;
        border: none;
        color: var(--text-faint);
        cursor: pointer;
        width: 28px;
        height: 28px;
        border-radius: var(--r-sm);
        display: grid;
        place-items: center;
        transition: background-color 150ms var(--ease-standard), color 150ms var(--ease-standard);
      }
      .ai-sug-remove:hover {
        background: rgba(220, 38, 38, 0.1);
        color: var(--bad-fg);
      }
      /* Touch targets ≥44px en punteros gruesos (DESIGN binding). */
      @media (pointer: coarse) {
        .ai-sug-qty { height: 44px; }
        .ai-qty-btn { width: 44px; }
        .ai-sug-qty input { width: 42px; }
        .ai-sug-remove { width: 44px; height: 44px; }
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
        font-size: var(--fs-micro);
        font-weight: 600;
        color: var(--text-main);
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: var(--r-sm);
        cursor: pointer;
        transition: background-color 150ms var(--ease-standard), border-color 150ms var(--ease-standard), color 150ms var(--ease-standard);
      }
      .ai-sug-bulk-btn i { font-size: var(--fs-micro); }
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
        font-size: var(--fs-nano);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-weight: 700;
        color: var(--text-faint);
      }
      .ai-sug-total b {
        font-size: var(--fs-h2);
        font-weight: 800;
        color: var(--text-main);
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.01em;
      }

      .ai-add-cart {
        background: var(--action);
        color: var(--action-ink, #fff);
        border: none;
        border-radius: var(--r-md);
        padding: 0.625rem 1rem;
        min-height: 44px;
        font-weight: 700;
        font-size: var(--fs-sm);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        box-shadow: 0 8px 20px -10px var(--action-ring);
        transition: background-color 150ms var(--ease-standard), transform 120ms var(--ease-standard), box-shadow 200ms var(--ease-standard);
      }
      .ai-add-cart:hover:not(:disabled) {
        background: var(--action-hover);
        transform: translateY(-1px);
        box-shadow: 0 12px 26px -10px var(--action-ring);
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
        border-radius: var(--r-lg);
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
        font-size: var(--fs-body);
        line-height: 1.4;
        padding: 0.625rem 0.875rem;
        border: 1.5px solid var(--border-color);
        border-radius: var(--r-md);
        background: var(--surface-ground);
        color: var(--text-main);
        outline: none;
        min-height: 42px;
        max-height: 140px;
        transition: border-color 150ms var(--ease-standard), box-shadow 150ms var(--ease-standard), background-color 150ms var(--ease-standard);
      }
      .ai-input-field:focus {
        border-color: var(--action);
        background: var(--card-bg);
        box-shadow: 0 0 0 3px var(--action-ring);
      }
      .ai-input-field:disabled { opacity: 0.6; cursor: not-allowed; }

      .ai-input-send {
        width: 44px;
        height: 44px;
        border-radius: var(--r-md);
        border: none;
        background: var(--action);
        color: var(--action-ink, #fff);
        font-size: var(--fs-h3);
        cursor: pointer;
        display: grid;
        place-items: center;
        transition: background-color 150ms var(--ease-standard), transform 120ms var(--ease-standard), box-shadow 200ms var(--ease-standard);
        flex-shrink: 0;
      }
      .ai-input-send:hover:not(:disabled) {
        background: var(--action-hover);
        transform: translateY(-1px);
        box-shadow: 0 8px 18px -8px var(--action-ring);
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
        detail: 'Solo lectura. Inicia sesión como cliente para confirmar pedidos.',
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
            const batch = suggestions.map((s) => ({
              product_id: s.product_id,
              quantity: s.qty,
              label: s.product_name,
            }));
            this.portal.addLinesBatch(draft.id, batch).subscribe({
              next: (results) => {
                const added = results.filter((r) => r.ok).length;
                const failures = results
                  .filter((r): r is { ok: false; reason: string; label?: string } => !r.ok)
                  .map((r) => ({ name: r.label || '(sin nombre)', reason: r.reason }));
                for (const f of failures) {
                  console.warn('[AI add] addLine FAIL', f.name, f.reason);
                }
                this.finishAdding(added, failures);
              },
              error: (e) => {
                this.adding.set(false);
                this.toast.add({ severity: 'error', summary: 'Error al agregar', detail: e?.message || 'Error desconocido' });
              },
            });
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
        detail: 'Revisa los detalles abajo.',
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
          detail: 'Revisa la consola para el detalle completo.',
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

  /** Placeholder Stone canónico (mismo que cards/carrito/order-detail). */
  sugGradient(productId: string): string {
    return brandPlaceholderGradient(productId);
  }

  sugInitials(name: string): string {
    const n = (name || '?').trim();
    const words = n.split(/\s+/).slice(0, 2);
    return words.map((w) => w.charAt(0).toUpperCase()).join('') || '?';
  }
}
