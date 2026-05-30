import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
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
  ],
  providers: [ConfirmationService],
  template: `
    <p-confirmDialog></p-confirmDialog>

    <header class="portal-page-head">
      <div class="portal-page-head-text">
        <span class="portal-eyebrow">
          <i class="pi pi-shopping-cart" aria-hidden="true"></i>
          Tu carrito
        </span>
        <h1>Revisá tu pedido</h1>
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

    <p-skeleton *ngIf="loading()" height="320px"></p-skeleton>

    <!-- Empty state -->
    <div *ngIf="!loading() && !cart()" class="portal-empty">
      <div class="portal-empty-icon">
        <i class="pi pi-shopping-cart" aria-hidden="true"></i>
      </div>
      <h2>Tu carrito está vacío</h2>
      <p>Explorá el catálogo y armá tu pedido en minutos.</p>
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
              [style.background]="lineGradient(line.product_id)"
            >{{ line.line_number }}</div>

            <div class="ca-line-body">
              <span class="ca-line-label">Producto</span>
              <code class="ca-line-id">{{ shortId(line.product_id) }}</code>
              <div class="ca-line-meta">
                <span class="ca-meta-item">
                  <i class="pi pi-tag"></i>
                  {{ fmtMoney(line.unit_price) }}/u
                </span>
                <span class="ca-meta-item">
                  IVA {{ taxPct(line.tax_rate) }}%
                </span>
                <span class="ca-meta-item ca-meta-promo" *ngIf="promoCodeOf(line) as pc">
                  <i class="pi pi-megaphone"></i>
                  {{ pc }}
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
                [ngModel]="line.quantity"
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
              <b>{{ fmtMoney(line.line_total) }}</b>
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
                <b>{{ fmtMoney(c.subtotal) }}</b>
              </div>
              <div class="ca-summary-row">
                <span>IVA</span>
                <b>{{ fmtMoney(c.tax_total) }}</b>
              </div>
            </div>

            <div class="ca-summary-total">
              <span>Total</span>
              <b>{{ fmtMoney(c.total) }}</b>
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
        border-radius: 14px;
        padding: 0.75rem 0.875rem;
        transition: border-color 150ms var(--ease-standard), box-shadow 200ms var(--ease-standard);
      }
      .ca-line:hover {
        border-color: var(--neutral-300);
        box-shadow: 0 4px 12px -6px rgba(0,0,0,0.08);
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
        width: 56px;
        height: 56px;
        border-radius: 12px;
        color: #fff;
        display: grid;
        place-items: center;
        font-weight: 800;
        font-size: 1.125rem;
        font-variant-numeric: tabular-nums;
        box-shadow: inset 0 -8px 14px rgba(0,0,0,0.12);
        flex-shrink: 0;
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
        font-size: 0.625rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-weight: 700;
        color: var(--text-faint);
      }
      .ca-line-id {
        font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.8125rem;
        color: var(--text-main);
        background: var(--neutral-100);
        padding: 0.125rem 0.5rem;
        border-radius: 6px;
        align-self: flex-start;
      }
      .ca-line-meta {
        display: flex;
        gap: 0.75rem;
        font-size: 0.75rem;
        color: var(--text-muted);
      }
      .ca-meta-item { display: inline-flex; align-items: center; gap: 0.25rem; }
      .ca-meta-promo {
        background: var(--brand-50, #fef3c7);
        color: var(--brand-800, #92400e);
        font-weight: 700;
        padding: 0.1rem 0.5rem;
        border-radius: 999px;
        border: 1px solid var(--brand-200, #fde68a);
      }

      .ca-line-qty {
        display: flex;
        align-items: center;
        border: 1.5px solid var(--border-color);
        border-radius: 10px;
        overflow: hidden;
        height: 36px;
        background: var(--card-bg);
      }
      .ca-line-qty input {
        width: 44px;
        text-align: center;
        border: none;
        outline: none;
        font-size: 0.875rem;
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
      .ca-qty-btn {
        background: var(--surface-ground);
        border: none;
        width: 32px;
        height: 100%;
        cursor: pointer;
        color: var(--text-main);
        font-weight: 700;
        font-size: 1rem;
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
        font-size: 1rem;
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
        border-radius: 10px;
        cursor: pointer;
        display: grid;
        place-items: center;
        transition: background-color 150ms var(--ease-standard), color 150ms var(--ease-standard);
      }
      .ca-line-remove:hover {
        background: rgba(220, 38, 38, 0.1);
        color: var(--bad-fg);
      }

      .ca-no-lines {
        text-align: center;
        padding: 2rem 1rem;
        background: var(--card-bg);
        border: 1px dashed var(--border-color);
        border-radius: 12px;
        color: var(--text-muted);
      }
      .ca-no-lines i { font-size: 1.5rem; display: block; margin-bottom: 0.5rem; }

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
        border-radius: 14px;
        padding: 1.25rem;
        box-shadow: 0 8px 24px -10px rgba(0,0,0,0.08);
      }
      .ca-summary-title {
        margin: 0 0 1rem;
        font-size: 0.9375rem;
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
        font-size: 0.875rem;
      }
      .ca-summary-row span { color: var(--text-muted); }
      .ca-summary-row b {
        color: var(--text-main);
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .ca-summary-total {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        padding: 0.875rem 1rem;
        background: var(--neutral-100);
        border: 1px solid var(--border-color);
        border-left: 3px solid var(--brand-500);
        border-radius: 12px;
        margin-bottom: 0.875rem;
      }
      .ca-summary-total span {
        font-size: 0.8125rem;
        font-weight: 700;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .ca-summary-total b {
        font-size: 1.5rem;
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
        font-size: 0.8125rem;
        cursor: pointer;
        margin-top: 0.5rem;
        border-radius: 10px;
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
        font-size: 0.75rem;
        color: var(--text-faint);
        text-align: center;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.25rem;
        line-height: 1.4;
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
            },
            error: () => {
              this.cart.set(draft);
              this.loading.set(false);
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

  confirm(): void {
    const c = this.cart();
    if (!c) return;
    this.confirmSvc.confirm({
      message: `¿Confirmar pedido por ${this.fmtMoney(c.total)}? Vamos a reservar el stock y avisar a Mega Dulces para que lo aprueben.`,
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
            this.router.navigate(['/portal/orders', confirmed.id]);
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

  /**
   * Extrae el code de promo aplicada desde line.notes. El backend escribe
   * `Promo aplicada: <CODE>` cuando recalcOrderTotals detecta y aplica una promo
   * a la línea. Devuelve null si no hay promo activa.
   */
  promoCodeOf(line: any): string | null {
    const n = (line?.notes || '').trim();
    if (!n.startsWith('Promo aplicada:')) return null;
    const after = n.slice('Promo aplicada:'.length).trim();
    return after.split(/[·\s]/)[0] || null;
  }

  lineGradient(productId: string): string {
    const c = hashColor(productId || '');
    return `linear-gradient(135deg, ${c}, ${this.darken(c, 0.15)})`;
  }

  taxPct(rate: any): string {
    const n = Number(rate) || 0;
    if (n <= 1) return (n * 100).toFixed(0);
    return String(n);
  }

  fmtMoney(n: any): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);
  }
  fmtDate(s: string): string {
    return new Date(s).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' } as any);
  }

  private darken(hex: string, amount: number): string {
    const h = hex.replace('#', '');
    const r = Math.max(0, parseInt(h.slice(0, 2), 16) - Math.round(255 * amount));
    const g = Math.max(0, parseInt(h.slice(2, 4), 16) - Math.round(255 * amount));
    const b = Math.max(0, parseInt(h.slice(4, 6), 16) - Math.round(255 * amount));
    return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  }
}
