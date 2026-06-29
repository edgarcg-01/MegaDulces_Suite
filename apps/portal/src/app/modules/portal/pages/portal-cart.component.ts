import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  NgZone,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, CurrencyPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { TooltipModule } from 'primeng/tooltip';
import { ConfirmationService, MessageService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { PortalService, Order } from '../portal.service';
import { HapticService } from '../../../core/services/haptic.service';
import { cldImage } from '../../../core/util/cloudinary';
import { brandPlaceholderGradient } from '../../../core/util/brand-placeholder';
import { CountUpDirective } from '../ui/count-up.directive';

@Component({
  selector: 'app-portal-cart',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CurrencyPipe,
    ButtonModule,
    SkeletonModule,
    ConfirmDialogModule,
    TooltipModule,
    CountUpDirective,
  ],
  providers: [ConfirmationService, CurrencyPipe],
  template: `
    <p-confirmDialog></p-confirmDialog>

    <header class="portal-page-head">
      <div class="portal-page-head-text">
        <span class="portal-eyebrow">
          <i class="pi pi-shopping-cart" aria-hidden="true"></i>
          Tu carrito
        </span>
        <h1>Revisa tu pedido</h1>
        <p class="portal-page-sub" *ngIf="cart() as c">
          <span class="ca-code">{{ c.code }}</span>
          <span class="ca-sep">·</span>
          <span>creado {{ fmtDate(c.created_at) }}</span>
        </p>
      </div>
      <button
        type="button"
        class="portal-btn-ghost"
        (click)="goCatalog()"
      >
        <i class="pi pi-arrow-left" aria-hidden="true"></i> Seguir comprando
      </button>
    </header>

    <div *ngIf="loading()" class="ca-skel ca-layout" aria-hidden="true">
      <div class="ca-skel-lines">
        <div class="ca-skel-line" *ngFor="let i of [1, 2, 3, 4]">
          <p-skeleton width="56px" height="56px" borderRadius="12px"></p-skeleton>
          <div class="ca-skel-body">
            <p-skeleton width="35%" height="0.6rem"></p-skeleton>
            <p-skeleton width="72%" height="0.95rem"></p-skeleton>
          </div>
          <p-skeleton width="128px" height="44px" borderRadius="12px"></p-skeleton>
        </div>
      </div>
      <div class="ca-skel-sum">
        <p-skeleton width="45%" height="1rem"></p-skeleton>
        <p-skeleton width="100%" height="0.8rem"></p-skeleton>
        <p-skeleton width="100%" height="0.8rem"></p-skeleton>
        <p-skeleton width="100%" height="3rem" borderRadius="12px"></p-skeleton>
        <p-skeleton width="100%" height="2.9rem" borderRadius="999px"></p-skeleton>
      </div>
    </div>

    <!-- Empty state -->
    <div *ngIf="!loading() && !cart()" class="portal-empty">
      <div class="portal-empty-icon">
        <i class="pi pi-shopping-cart" aria-hidden="true"></i>
      </div>
      <h2>Tu carrito está vacío</h2>
      <p>Explora el catálogo y arma tu pedido en minutos.</p>
      <div class="portal-empty-actions">
        <button type="button" class="portal-btn-primary" (click)="goCatalog()">
          <i class="pi pi-th-large" aria-hidden="true"></i> Ir al catálogo
        </button>
        <button type="button" class="portal-btn-ghost" (click)="goAi()">
          <i class="pi pi-bolt" aria-hidden="true"></i> Pedir con IA
        </button>
      </div>
    </div>

    <!-- Cart content -->
    <ng-container *ngIf="!loading() && cart() as c">
      <div class="ca-layout">
        <section class="ca-lines" aria-label="Líneas del carrito">
          <div
            *ngFor="let line of (c.lines || []); trackBy: trackByLine"
            class="ca-line"
          >
            <div
              class="ca-line-avatar"
              [class.has-photo]="lineImg(line)"
              [style.background]="lineImg(line) ? null : linePh(line)"
            >
              <img *ngIf="lineImg(line) as src" [src]="src" [alt]="line.product_name || ''" loading="lazy" decoding="async" />
              <span *ngIf="!lineImg(line)" class="ca-line-mono" aria-hidden="true">{{ lineInitials(line) }}</span>
            </div>

            <div class="ca-line-body">
              <span class="ca-line-brand" *ngIf="line.brand_name">{{ line.brand_name }}</span>
              <span class="ca-line-name">{{ line.product_name || shortId(line.product_id) }}</span>
              <div class="ca-line-meta">
                <span class="ca-meta-item">
                  <i class="pi pi-tag"></i>
                  {{ line.unit_price | currency:'MXN':'symbol-narrow':'1.2-2' }}/u
                </span>
                <span class="ca-meta-item">
                  IVA {{ taxPct(line.tax_rate) }}%
                </span>
                <span class="ca-meta-item ca-meta-promo" *ngIf="line.applied_promo_code">
                  <i class="pi pi-megaphone"></i>
                  {{ line.applied_promo_code }}
                  <em *ngIf="lineSavings(line) > 0">
                    −{{ lineSavings(line) | currency:'MXN':'symbol-narrow':'1.2-2' }}
                  </em>
                </span>
              </div>
            </div>

            <div class="ca-line-qty">
              <button
                type="button"
                class="ca-qty-btn"
                (click)="updateQty(line, +line.quantity - 1)"
                [disabled]="+line.quantity <= 1 || !!updatingLine[line.id]"
                [attr.aria-label]="'Disminuir cantidad de línea ' + line.line_number"
              >−</button>
              <input
                type="number"
                inputmode="numeric"
                [ngModel]="+line.quantity"
                (ngModelChange)="updateQty(line, $event)"
                min="1"
                [disabled]="!!updatingLine[line.id]"
                [attr.aria-label]="'Cantidad de línea ' + line.line_number"
              />
              <button
                type="button"
                class="ca-qty-btn"
                (click)="updateQty(line, +line.quantity + 1)"
                [disabled]="!!updatingLine[line.id]"
                [attr.aria-label]="'Aumentar cantidad de línea ' + line.line_number"
              >+</button>
            </div>

            <div class="ca-line-total">
              <span class="ca-line-label">Total</span>
              <b>{{ line.line_total | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
            </div>

            <button
              type="button"
              class="ca-line-remove"
              (click)="removeLine(line.id)"
              pTooltip="Quitar del carrito"
              tooltipPosition="left"
              aria-label="Quitar"
            >
              <i class="pi pi-trash"></i>
            </button>
          </div>

          <div *ngIf="(c.lines || []).length === 0" class="ca-no-lines">
            <i class="pi pi-info-circle"></i>
            <p>Tu carrito no tiene líneas todavía.</p>
            <button pButton type="button" label="Agregar productos" icon="pi pi-arrow-right" (click)="goCatalog()"></button>
          </div>
        </section>

        <!-- Summary card -->
        <aside class="ca-summary" aria-label="Resumen del pedido">
          <div class="ca-summary-inner">
            <h3 class="ca-summary-title">Resumen</h3>
            <div class="ca-summary-rows">
              <div class="ca-summary-row">
                <span>Productos</span>
                <b>{{ (c.lines || []).length }}</b>
              </div>
              <div class="ca-summary-row">
                <span>Unidades</span>
                <b>{{ totalUnits() }}</b>
              </div>
              <div class="ca-summary-row">
                <span>Subtotal</span>
                <b [countUp]="+(c.subtotal || 0)"></b>
              </div>
              <div class="ca-summary-row">
                <span>IVA</span>
                <b>{{ c.tax_total | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
              </div>
              <div class="ca-summary-row ca-summary-savings" *ngIf="totalLineSavings() > 0">
                <span>
                  <i class="pi pi-tag"></i> Ahorro promos
                </span>
                <b>−{{ totalLineSavings() | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
              </div>
              <div class="ca-summary-row ca-summary-savings" *ngIf="basketDiscount() > 0">
                <span>
                  <i class="pi pi-megaphone"></i> {{ c.basket_promo_code }}
                </span>
                <b>−{{ basketDiscount() | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
              </div>
            </div>

            <!-- Upsell de mínimo: convierte la restricción en oportunidad (P1 #6). -->
            <div class="ca-min-upsell" *ngIf="minRemaining() > 0">
              <span class="ca-min-icon"><i class="pi pi-arrow-up" aria-hidden="true"></i></span>
              <div class="ca-min-text">
                Te faltan <b>{{ minRemaining() | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
                para el mínimo de {{ MIN_ORDER | currency:'MXN':'symbol-narrow':'1.0-0' }}.
                <span class="ca-min-prog"><i [style.width.%]="minPct()"></i></span>
              </div>
              <button type="button" class="ca-min-btn" (click)="goCatalog()">
                <i class="pi pi-plus" aria-hidden="true"></i> Sugerir
              </button>
            </div>

            <div class="ca-summary-total">
              <span>Total</span>
              <b [countUp]="+(c.total || 0)"></b>
            </div>

            <button
              type="button"
              class="portal-btn-primary portal-btn-primary-lg"
              [disabled]="confirming() || (c.lines || []).length === 0"
              (click)="confirm()"
            >
              <i [class]="confirming() ? 'pi pi-spin pi-spinner' : 'pi pi-check-circle'" aria-hidden="true"></i>
              {{ confirming() ? 'Confirmando…' : 'Confirmar pedido' }}
            </button>

            <button
              type="button"
              class="ca-cancel"
              [disabled]="confirming()"
              (click)="cancelDraft()"
            >
              <i class="pi pi-times"></i> Vaciar carrito
            </button>

            <p class="ca-summary-note">
              <i class="pi pi-info-circle"></i>
              Al confirmar reservamos el stock automáticamente.
            </p>
          </div>
        </aside>
      </div>
    </ng-container>
  `,
  styles: [
    `
      :host { display: block; }

      /* Header detail accents (eyebrow/sub vienen del global portal-*) */
      .ca-code {
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--text-main);
      }
      .ca-sep { opacity: 0.5; }

      .ca-layout {
        display: grid;
        grid-template-columns: 1fr 320px;
        gap: 1.25rem;
        align-items: start;
      }
      @media (max-width: 900px) {
        .ca-layout { grid-template-columns: 1fr; }
      }

      .ca-lines {
        display: flex;
        flex-direction: column;
        gap: 0.625rem;
      }

      .ca-line {
        display: grid;
        grid-template-columns: 56px 1fr auto auto auto;
        gap: 0.875rem;
        align-items: center;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: var(--r-lg);
        padding: 0.75rem 0.875rem;
        transition: border-color 150ms var(--ease-standard), box-shadow 200ms var(--ease-standard);
      }
      .ca-line:hover {
        border-color: var(--neutral-300);
        box-shadow: var(--shadow-float);
      }
      @media (max-width: 640px) {
        .ca-line {
          grid-template-columns: 48px 1fr auto;
          grid-template-areas:
            "avatar body remove"
            "qty qty total";
          row-gap: 0.625rem;
        }
        .ca-line-avatar { grid-area: avatar; }
        .ca-line-body { grid-area: body; }
        .ca-line-remove { grid-area: remove; }
        .ca-line-qty {
          grid-area: qty;
          justify-self: stretch;
        }
        .ca-line-total {
          grid-area: total;
          text-align: right;
        }
      }

      .ca-line-avatar {
        position: relative;
        width: 56px;
        height: 56px;
        border-radius: var(--r-md);
        overflow: hidden;
        display: grid;
        place-items: center;
        flex-shrink: 0;
      }
      .ca-line-avatar.has-photo { background: #fff; border: 1px solid var(--border-color); }
      .ca-line-avatar img { width: 100%; height: 100%; object-fit: contain; padding: 6px; }
      .ca-line-mono {
        font-family: var(--font-display);
        font-weight: 700;
        font-size: var(--fs-h3);
        color: #fff;
        letter-spacing: -0.01em;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
      }
      @media (max-width: 640px) {
        .ca-line-avatar { width: 48px; height: 48px; }
      }

      .ca-line-body {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        min-width: 0;
      }
      .ca-line-label {
        font-size: var(--fs-nano);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-weight: 700;
        color: var(--text-faint);
      }
      .ca-line-brand {
        font-size: var(--fs-nano);
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-muted);
      }
      .ca-line-name {
        font-size: var(--fs-body);
        font-weight: 700;
        color: var(--text-main);
        line-height: 1.25;
      }
      .ca-line-meta {
        display: flex;
        gap: 0.75rem;
        font-size: var(--fs-xs);
        color: var(--text-muted);
      }
      .ca-meta-item { display: inline-flex; align-items: center; gap: 0.25rem; }
      .ca-meta-promo {
        background: var(--warn-soft-bg);
        color: var(--warn-soft-fg);
        font-weight: 700;
        padding: 0.1rem 0.5rem;
        border-radius: var(--r-pill);
        border: 1px solid var(--warn-border);
      }

      .ca-line-qty {
        display: flex;
        align-items: center;
        border: 1.5px solid var(--border-color);
        border-radius: var(--r-md);
        overflow: hidden;
        height: 44px;
        background: var(--card-bg);
      }
      .ca-line-qty input {
        width: 44px;
        text-align: center;
        border: none;
        outline: none;
        font-size: var(--fs-body);
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        background: transparent;
        color: var(--text-main);
        -moz-appearance: textfield;
      }
      .ca-line-qty input::-webkit-outer-spin-button,
      .ca-line-qty input::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      /* iOS hace zoom al enfocar inputs <16px; en touch subimos a 16px. */
      @media (pointer: coarse) {
        .ca-line-qty input { font-size: 16px; }
      }
      .ca-qty-btn {
        background: var(--surface-ground);
        border: none;
        width: 44px;
        height: 100%;
        cursor: pointer;
        color: var(--text-main);
        font-weight: 700;
        font-size: var(--fs-h3);
        display: grid;
        place-items: center;
        transition: background-color 100ms var(--ease-standard);
      }
      .ca-qty-btn:hover:not(:disabled) {
        background: var(--neutral-200);
        color: var(--text-main);
      }
      .ca-qty-btn:disabled { opacity: 0.35; cursor: not-allowed; }

      .ca-line-total {
        min-width: 90px;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 0.125rem;
      }
      .ca-line-total b {
        font-size: var(--fs-h3);
        font-weight: 800;
        color: var(--text-main);
        font-variant-numeric: tabular-nums;
      }

      .ca-line-remove {
        width: 36px;
        height: 36px;
        border: none;
        background: transparent;
        color: var(--text-faint);
        border-radius: var(--r-md);
        cursor: pointer;
        display: grid;
        place-items: center;
        transition: background-color 150ms var(--ease-standard), color 150ms var(--ease-standard);
      }
      .ca-line-remove:hover {
        background: rgba(220, 38, 38, 0.1);
        color: var(--bad-fg);
      }
      /* Touch target ≥44px en punteros gruesos (DESIGN binding). */
      @media (pointer: coarse) {
        .ca-line-remove { width: 44px; height: 44px; }
      }

      .ca-no-lines {
        text-align: center;
        padding: 2rem 1rem;
        background: var(--card-bg);
        border: 1px dashed var(--border-color);
        border-radius: var(--r-md);
        color: var(--text-muted);
      }
      .ca-no-lines i { font-size: var(--fs-h2); display: block; margin-bottom: 0.5rem; }

      /* ── SUMMARY ────────────────────────────────────────────────── */
      .ca-summary {
        position: sticky;
        top: 1rem;
      }
      @media (max-width: 900px) {
        .ca-summary {
          position: sticky;
          bottom: calc(72px + env(safe-area-inset-bottom));
          top: auto;
          z-index: 10;
        }
      }
      .ca-summary-inner {
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: var(--r-lg);
        padding: 1.25rem;
        box-shadow: var(--shadow-float);
      }
      .ca-summary-title {
        margin: 0 0 1rem;
        font-size: var(--fs-body);
        font-weight: 700;
        color: var(--text-main);
      }
      .ca-summary-rows {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        margin-bottom: 1rem;
      }
      .ca-summary-row {
        display: flex;
        justify-content: space-between;
        font-size: var(--fs-body);
      }
      .ca-summary-row span { color: var(--text-muted); }
      .ca-summary-row b {
        color: var(--text-main);
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .ca-summary-savings span,
      .ca-summary-savings b {
        color: var(--ok-soft-fg);
        font-weight: 700;
      }
      .ca-summary-savings i { margin-right: 0.25rem; }

      .ca-meta-promo em {
        font-style: normal;
        font-weight: 700;
        color: var(--ok-soft-fg);
        margin-left: 0.375rem;
      }
      /* ── Upsell de mínimo de pedido (P1 #6) ─────────────────────── */
      .ca-min-upsell {
        display: flex;
        align-items: center;
        gap: 0.65rem;
        background: var(--surface-ground);
        border: 1px solid var(--border-color);
        border-left: 3px solid var(--action);
        border-radius: var(--r-md);
        padding: 0.65rem 0.7rem;
        margin-bottom: 0.75rem;
      }
      .ca-min-icon {
        width: 30px;
        height: 30px;
        border-radius: 8px;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        display: grid;
        place-items: center;
        color: var(--action);
        flex-shrink: 0;
      }
      .ca-min-text {
        flex: 1;
        font-size: var(--fs-xs);
        color: var(--text-muted);
        line-height: 1.35;
        min-width: 0;
      }
      .ca-min-text b { color: var(--action); font-weight: 800; }
      .ca-min-prog {
        display: block;
        height: 5px;
        background: var(--neutral-200);
        border-radius: var(--r-pill);
        margin-top: 0.35rem;
        overflow: hidden;
      }
      .ca-min-prog i {
        display: block;
        height: 100%;
        background: var(--action);
        border-radius: var(--r-pill);
        transition: width 300ms var(--ease-standard);
      }
      .ca-min-btn {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        font-size: var(--fs-xs);
        font-weight: 700;
        color: var(--action);
        background: transparent;
        border: 1px solid var(--border-color);
        border-radius: var(--r-pill);
        padding: 0.35rem 0.65rem;
        cursor: pointer;
        white-space: nowrap;
        transition: background-color 150ms var(--ease-standard), border-color 150ms var(--ease-standard);
      }
      .ca-min-btn:hover { background: var(--hover-bg); border-color: var(--action); }

      .ca-summary-total {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        padding: 0.875rem 1rem;
        background: var(--neutral-100);
        border: 1px solid var(--border-color);
        border-radius: var(--r-md);
        margin-bottom: 0.875rem;
      }
      .ca-summary-total span {
        font-size: var(--fs-sm);
        font-weight: 700;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .ca-summary-total b {
        font-size: var(--fs-h1);
        font-weight: 800;
        color: var(--text-main);
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.01em;
      }

      .ca-cancel {
        width: 100%;
        background: transparent;
        color: var(--text-muted);
        border: none;
        padding: 0.625rem;
        font-weight: 600;
        font-size: var(--fs-sm);
        cursor: pointer;
        margin-top: 0.5rem;
        border-radius: var(--r-md);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.375rem;
        transition: background-color 150ms var(--ease-standard), color 150ms var(--ease-standard);
      }
      .ca-cancel:hover:not(:disabled) {
        background: rgba(220, 38, 38, 0.08);
        color: var(--bad-fg);
      }
      .ca-cancel:disabled { opacity: 0.4; cursor: not-allowed; }

      .ca-summary-note {
        margin: 0.875rem 0 0;
        font-size: var(--fs-xs);
        color: var(--text-faint);
        text-align: center;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.25rem;
        line-height: 1.4;
      }

      /* ── Skeleton con forma (filas + summary), refleja el layout real ── */
      .ca-skel-lines { display: flex; flex-direction: column; gap: 0.625rem; }
      .ca-skel-line {
        display: grid;
        grid-template-columns: 56px 1fr 128px;
        gap: 0.875rem;
        align-items: center;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: var(--r-lg);
        padding: 0.75rem 0.875rem;
      }
      .ca-skel-body { display: flex; flex-direction: column; gap: 0.45rem; min-width: 0; }
      .ca-skel-sum {
        align-self: start;
        display: flex;
        flex-direction: column;
        gap: 0.7rem;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: var(--r-lg);
        padding: 1.25rem;
        box-shadow: var(--shadow-float);
      }
      @media (max-width: 640px) {
        .ca-skel-line { grid-template-columns: 56px 1fr; }
        .ca-skel-line > :last-child { display: none; }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PortalCartComponent implements OnInit {
  private readonly api = inject(PortalService);
  private readonly toast = inject(MessageService);
  private readonly haptic = inject(HapticService);
  private readonly confirmSvc = inject(ConfirmationService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly zone = inject(NgZone);

  readonly loading = signal(true);
  readonly cart = signal<Order | null>(null);
  readonly confirming = signal(false);
  /** Track de líneas con request en vuelo — evita clicks duplicados / race conditions. */
  updatingLine: Record<string, boolean> = {};

  readonly totalUnits = computed(() => {
    const c = this.cart();
    if (!c?.lines) return 0;
    return c.lines.reduce((sum, l) => sum + (Number(l.quantity) || 0), 0);
  });

  readonly totalLineSavings = computed(() => {
    const c = this.cart();
    if (!c?.lines) return 0;
    return c.lines.reduce((sum, l) => sum + (Number(l.discount_amount) || 0), 0);
  });

  readonly basketDiscount = computed(() => {
    const c = this.cart();
    return Number(c?.basket_discount_amount) || 0;
  });

  /** Mínimo de pedido (beta: constante, alineado al trust-strip del home/catálogo). */
  readonly MIN_ORDER = 2500;
  readonly minRemaining = computed(() => {
    const sub = Number(this.cart()?.subtotal) || 0;
    return Math.max(0, this.MIN_ORDER - sub);
  });
  readonly minPct = computed(() => {
    const sub = Number(this.cart()?.subtotal) || 0;
    return Math.min(100, Math.round((sub / this.MIN_ORDER) * 100));
  });

  ngOnInit(): void {
    this.reload();
  }

  private reload(): void {
    this.loading.set(true);
    this.api
      .getActiveDraft()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (draft) => {
          if (!draft) {
            this.cart.set(null);
            this.loading.set(false);
            return;
          }
          this.api.orderById(draft.id).subscribe({
            next: (full) => {
              this.cart.set(full);
              this.loading.set(false);
              this.revealLines();
            },
            error: () => {
              this.cart.set(draft);
              this.loading.set(false);
              this.revealLines();
            },
          });
        },
        error: () => {
          this.cart.set(null);
          this.loading.set(false);
        },
      });
  }

  updateQty(line: any, qty: number): void {
    if (qty == null || qty < 1) return;
    if (qty === Number(line.quantity)) return;
    if (this.updatingLine[line.id]) return;
    const c = this.cart();
    if (!c) return;
    this.updatingLine[line.id] = true;
    this.api.updateLine(c.id, line.id, qty).subscribe({
      next: () => {
        this.updatingLine[line.id] = false;
        this.reload();
      },
      error: (err) => {
        this.updatingLine[line.id] = false;
        this.toast.add({ severity: 'error', summary: 'Error', detail: err.error?.message || err.message });
      },
    });
  }

  removeLine(lineId: string): void {
    if (this.updatingLine[lineId]) return;
    const c = this.cart();
    if (!c) return;
    this.updatingLine[lineId] = true;
    this.api.removeLine(c.id, lineId).subscribe({
      next: () => {
        delete this.updatingLine[lineId];
        this.reload();
      },
      error: (err) => {
        delete this.updatingLine[lineId];
        this.toast.add({ severity: 'error', summary: 'Error', detail: err.error?.message || err.message });
      },
    });
  }

  private currency = inject(CurrencyPipe);

  confirm(): void {
    const c = this.cart();
    if (!c) return;
    this.confirmSvc.confirm({
      message: `¿Confirmar pedido por ${this.currency.transform(c.total, 'MXN', 'symbol-narrow', '1.2-2')}? Vamos a reservar el stock y avisar a Mega Dulces para que lo aprueben.`,
      header: 'Confirmar pedido',
      icon: 'pi pi-exclamation-triangle',
      accept: () => {
        this.confirming.set(true);
        this.api.confirm(c.id).subscribe({
          next: (confirmed) => {
            this.confirming.set(false);
            this.haptic.notification('success');
            this.toast.add({
              severity: 'success',
              summary: 'Pedido enviado',
              detail: `${confirmed.code} · Esperando confirmación`,
              life: 3500,
            });
            this.router.navigate(['/portal/orders', confirmed.id], {
              state: { justConfirmed: true },
            });
          },
          error: (err) => {
            this.confirming.set(false);
            this.haptic.notification('error');
            this.toast.add({
              severity: 'error',
              summary: 'No se pudo confirmar',
              detail: err.error?.message || err.message,
            });
          },
        });
      },
    });
  }

  cancelDraft(): void {
    const c = this.cart();
    if (!c) return;
    this.confirmSvc.confirm({
      message: '¿Descartar este carrito? Se borrarán todas las líneas.',
      header: 'Vaciar carrito',
      icon: 'pi pi-trash',
      accept: () => {
        this.api.cancel(c.id, 'Cancelado por el cliente desde el portal').subscribe({
          next: () => {
            this.toast.add({ severity: 'info', summary: 'Carrito vaciado' });
            this.cart.set(null);
          },
          error: (err) =>
            this.toast.add({
              severity: 'error',
              summary: 'Error',
              detail: err.error?.message || err.message,
            }),
        });
      },
    });
  }

  goCatalog(): void {
    this.router.navigateByUrl('/portal/catalog');
  }

  goAi(): void {
    this.router.navigateByUrl('/portal/recommendations');
  }

  trackByLine = (_i: number, l: any) => l.id;

  shortId(id: string): string {
    return id?.slice(0, 8) || '—';
  }

  lineSavings(line: any): number {
    return Number(line?.discount_amount) || 0;
  }

  /** Thumbnail Cloudinary si la línea trae imagen (futuro backend), sino null. */
  lineImg(line: any): string | null {
    return line?.image_url ? cldImage(line.image_url, 120) : null;
  }
  /** Placeholder Stone canónico (mismo que las cards). */
  linePh(line: any): string {
    return brandPlaceholderGradient(line?.product_id || line?.product_name);
  }
  lineInitials(line: any): string {
    const words = (line?.product_name || '?').trim().split(/\s+/).slice(0, 2);
    return words.map((w: string) => w.charAt(0).toUpperCase()).join('') || '?';
  }

  taxPct(rate: any): string {
    const n = Number(rate) || 0;
    if (n <= 1) return (n * 100).toFixed(0);
    return String(n);
  }

  fmtDate(s: string): string {
    return new Date(s).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' } as any);
  }

  // ── Reveal GSAP de las líneas (solo primera carga) ─────────────
  private didReveal = false;
  private cartG: any = null;
  private cartGsapLoading?: Promise<any>;

  private ensureGsap(): Promise<any> {
    if (this.cartG) return Promise.resolve(this.cartG);
    if (this.cartGsapLoading) return this.cartGsapLoading;
    this.cartGsapLoading = import('gsap').then((m: any) => (this.cartG = m.gsap || m.default));
    return this.cartGsapLoading;
  }

  /**
   * Entrada escalonada de las líneas + el summary. Solo la PRIMERA vez que hay
   * líneas — los `reload()` por cambio de qty no re-animan (evita flicker).
   * Bajo prefers-reduced-motion no anima (marca como hecho y sale).
   */
  private revealLines(): void {
    if (this.didReveal || typeof window === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      this.didReveal = true;
      return;
    }
    this.zone.runOutsideAngular(() =>
      requestAnimationFrame(async () => {
        const el = this.host.nativeElement;
        const rows = Array.from(el.querySelectorAll('.ca-line')) as HTMLElement[];
        if (!rows.length) return; // sin líneas todavía → reintenta en la próxima carga
        this.didReveal = true;
        const summary = el.querySelector('.ca-summary-inner') as HTMLElement | null;
        try {
          const gsap = await this.ensureGsap();
          gsap.from(rows, {
            opacity: 0,
            y: 16,
            duration: 0.42,
            stagger: 0.05,
            ease: 'power3.out',
            clearProps: 'opacity,transform',
          });
          if (summary) {
            gsap.from(summary, {
              opacity: 0,
              y: 16,
              duration: 0.45,
              delay: 0.08,
              ease: 'power3.out',
              clearProps: 'opacity,transform',
            });
          }
        } catch {
          /* sin gsap: visible */
        }
      }),
    );
  }
}
