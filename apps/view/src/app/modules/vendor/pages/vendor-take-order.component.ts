import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import { InputTextModule } from 'primeng/inputtext';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of, switchMap } from 'rxjs';
import { VendorService, VendorCustomer } from '../vendor.service';
import { PriceRow, OrderLine } from '../../portal/portal.service';
import { HapticService } from '../../../core/services/haptic.service';

type OrderMode = 'instante' | 'futuro';

/**
 * Tomar pedido (rediseño Mercado mobile-first). Modos:
 *  - instante (autoventa): "Cobrar y entregar" → deliver-now (consume stock).
 *  - futuro: fecha de entrega agendada → confirma (queda pendiente para reparto).
 * Catálogo con "+" 44px, carrito con steppers, y cart pill flotante en la zona
 * del pulgar como CTA único.
 */
@Component({
  selector: 'app-vendor-take-order',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    SkeletonModule,
    InputTextModule,
    ConfirmDialogModule,
  ],
  providers: [ConfirmationService, MessageService],
  template: `
    <p-confirmDialog></p-confirmDialog>

    <!-- Header sticky -->
    <header class="to-head" *ngIf="customer() as c">
      <button class="bk" (click)="back()" aria-label="Volver"><i class="pi pi-arrow-left"></i></button>
      <span class="av">{{ initials(c.name) }}</span>
      <div class="ci">
        <div class="nm">{{ c.name }}</div>
        <div class="cd">{{ c.code }}</div>
      </div>
      <span class="mode" [class.fut]="mode() === 'futuro'">
        <i class="pi" [ngClass]="mode() === 'futuro' ? 'pi-calendar' : 'pi-bolt'"></i>
        {{ mode() === 'futuro' ? 'Agendar' : 'Entrega ya' }}
      </span>
    </header>

    <p-skeleton *ngIf="loading()" height="500px" styleClass="mt"></p-skeleton>

    <ng-container *ngIf="!loading() && customer()">
      <div class="scroll">
        <!-- Fecha de entrega (futuro) -->
        <div class="date-row" *ngIf="mode() === 'futuro'">
          <label><i class="pi pi-calendar"></i> Fecha de entrega</label>
          <input type="date" [(ngModel)]="requestedDate" [min]="minDate" class="date-input" />
        </div>

        <!-- Search -->
        <div class="search">
          <i class="pi pi-search"></i>
          <input pInputText type="search" placeholder="Buscar producto"
            [(ngModel)]="searchTerm" inputmode="search" enterkeyhint="search"
            autocapitalize="none" autocorrect="off" spellcheck="false" />
        </div>

        <!-- Catálogo -->
        <div class="catalog">
          <div class="prod" *ngFor="let p of filteredPrices(); trackBy: trackProduct" [class.in]="cartQty(p.product_id) > 0">
            <div class="ph"><i class="pi pi-box"></i></div>
            <div class="pb">
              <div class="pn">{{ p.product_name }}</div>
              <div class="pm">
                <span class="pr">{{ fmtMoney(p.price) }}</span>
                <span *ngIf="p.min_qty > 1">· min {{ p.min_qty }}</span>
                <span class="stk" [ngClass]="stockClass(p)" *ngIf="p.stock_available != null">{{ stockLabel(p) }}</span>
              </div>
            </div>
            <span class="qbadge" *ngIf="cartQty(p.product_id) > 0">{{ cartQty(p.product_id) }}</span>
            <button class="add" [disabled]="!!adding[p.product_id]" (click)="addToCart(p)" aria-label="Agregar"><i class="pi pi-plus"></i></button>
          </div>
        </div>

        <!-- Carrito -->
        <section class="cart" *ngIf="cartLines().length > 0">
          <h2>Carrito</h2>
          <div class="cline" *ngFor="let l of cartLines(); trackBy: trackLine">
            <div class="cl-info">
              <div class="cl-n">{{ productNameById(l.product_id) }}</div>
              <div class="cl-t">{{ fmtMoney(l.line_total) }}</div>
            </div>
            <div class="stepper">
              <button (click)="dec(l)" aria-label="Menos">−</button>
              <span class="q">{{ l.quantity }}</span>
              <button (click)="inc(l)" aria-label="Más">+</button>
            </div>
            <button class="rm" (click)="removeLine(l)" aria-label="Quitar"><i class="pi pi-trash"></i></button>
          </div>
          <div class="totals">
            <div class="row"><span>Subtotal</span><b>{{ fmtMoney(cartSubtotal()) }}</b></div>
            <div class="row"><span>IVA</span><b>{{ fmtMoney(cartTaxTotal()) }}</b></div>
            <div class="row total"><span>Total</span><b>{{ fmtMoney(cartTotal()) }}</b></div>
          </div>
          <button class="cancel" (click)="cancelDraft()"><i class="pi pi-trash"></i> Cancelar borrador</button>
        </section>

        <div class="empty-cart" *ngIf="cartLines().length === 0">
          <i class="pi pi-shopping-cart"></i>
          <p>Tocá <b>+</b> en un producto para empezar el pedido.</p>
        </div>
      </div>

      <!-- Cart pill (zona del pulgar) -->
      <button class="cartpill" *ngIf="cartLines().length > 0" [disabled]="submitting()" (click)="submit()">
        <span class="cp-info">
          <b>{{ fmtMoney(cartTotal()) }}</b>
          <span>{{ cartUnitsTotal() }} u · {{ cartLines().length }} SKU</span>
        </span>
        <span class="cp-cta">
          {{ mode() === 'futuro' ? 'Agendar pedido' : 'Cobrar y entregar' }}
          <i class="pi" [ngClass]="submitting() ? 'pi-spin pi-spinner' : 'pi-arrow-right'"></i>
        </span>
      </button>
    </ng-container>
  `,
  styles: [
    `
      :host { display: block; }
      .to-head {
        display: flex; align-items: center; gap: 0.7rem;
        margin: -1rem -1rem 0.75rem; padding: 0.7rem 1rem; background: var(--card-bg); border-bottom: 1px solid var(--border-color);
      }
      .to-head .bk { width: 2.25rem; height: 2.25rem; border-radius: 14px; border: none; background: var(--surface-ground); color: var(--text-main); display: grid; place-items: center; font-size: 1.05rem; flex-shrink: 0; }
      .to-head .av { width: 2.35rem; height: 2.35rem; border-radius: 14px; background: var(--brand-400); color: var(--stone-950); display: grid; place-items: center; font-weight: 800; flex-shrink: 0; }
      .to-head .ci { flex: 1; min-width: 0; }
      .to-head .nm { font-weight: 700; font-size: 0.95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .to-head .cd { font-family: var(--font-mono); font-size: 0.72rem; color: var(--text-muted); }
      .to-head .mode { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.7rem; font-weight: 700; color: var(--action); background: var(--ember-soft); border: 1px solid var(--ember-border); padding: 0.25rem 0.55rem; border-radius: var(--r-pill, 999px); flex-shrink: 0; }
      .to-head .mode.fut { color: var(--info-soft-fg); background: var(--info-soft-bg); border-color: var(--info-border); }
      .mt { margin-top: 1rem; }

      .scroll { padding-bottom: 6rem; }
      .date-row { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 0.875rem; }
      .date-row label { font-size: 0.8rem; font-weight: 600; color: var(--text-muted); display: flex; align-items: center; gap: 0.4rem; }
      .date-input { width: 100%; height: 2.9rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); padding: 0 0.875rem; font-family: var(--font-body); font-size: 0.95rem; background: var(--card-bg); color: var(--text-main); }

      .search { display: flex; align-items: center; gap: 0.6rem; background: var(--surface-ground); border: 1px solid var(--border-color); border-radius: var(--r-pill, 999px); padding: 0.1rem 0.95rem; margin-bottom: 0.875rem; }
      .search i { color: var(--text-muted); }
      .search input { flex: 1; border: none; background: none; outline: none; height: 2.7rem; font-family: var(--font-body); font-size: 0.95rem; color: var(--text-main); }

      .catalog { display: flex; flex-direction: column; gap: 0.5rem; }
      .prod { display: flex; align-items: center; gap: 0.75rem; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); padding: 0.55rem 0.7rem; }
      .prod.in { border-color: var(--action); box-shadow: 0 0 0 1px var(--action) inset; }
      .prod .ph { width: 2.5rem; height: 2.5rem; border-radius: 14px; background: var(--stone-100); display: grid; place-items: center; color: var(--stone-400); font-size: 1.05rem; flex-shrink: 0; }
      .prod .pb { flex: 1; min-width: 0; }
      .prod .pn { font-weight: 600; font-size: 0.9rem; color: var(--text-main); line-height: 1.2; }
      .prod .pm { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; font-size: 0.78rem; color: var(--text-muted); margin-top: 0.15rem; }
      .prod .pm .pr { font-family: var(--font-mono); font-weight: 700; color: var(--action); font-variant-numeric: tabular-nums; }
      .prod .pm .stk { font-weight: 600; }
      .prod .pm .stk.ok { color: var(--ok-fg); } .prod .pm .stk.warn { color: var(--warn-fg); } .prod .pm .stk.bad { color: var(--bad-fg); }
      .qbadge { font-family: var(--font-mono); font-weight: 700; font-size: 0.8rem; color: var(--action); min-width: 1.4rem; text-align: right; font-variant-numeric: tabular-nums; }
      .add { width: 2.75rem; height: 2.75rem; border-radius: 14px; border: none; background: var(--action); color: #fff; font-size: 1.15rem; display: grid; place-items: center; flex-shrink: 0; transition: transform 0.07s var(--ease, ease); }
      .add:active { transform: scale(0.92); } .add:disabled { opacity: 0.5; }

      .cart { margin-top: 1.5rem; padding-top: 1rem; border-top: 2px solid var(--border-color); }
      .cart h2 { font-size: 1.05rem; font-weight: 800; margin-bottom: 0.75rem; color: var(--text-main); }
      .cline { display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0; border-bottom: 1px solid var(--border-color); }
      .cl-info { flex: 1; min-width: 0; }
      .cl-n { font-weight: 600; font-size: 0.9rem; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .cl-t { font-family: var(--font-mono); font-size: 0.78rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
      .stepper { display: flex; align-items: center; border: 1px solid var(--border-color); border-radius: var(--r-pill, 999px); overflow: hidden; flex-shrink: 0; }
      .stepper button { width: 2.5rem; height: 2.5rem; border: none; background: var(--surface-ground); color: var(--action); font-size: 1.15rem; font-weight: 700; }
      .stepper .q { width: 2rem; text-align: center; font-family: var(--font-mono); font-weight: 700; font-variant-numeric: tabular-nums; }
      .rm { width: 2.5rem; height: 2.5rem; border: none; background: none; color: var(--bad-fg); font-size: 1rem; flex-shrink: 0; }
      .totals { margin: 0.875rem 0 0 auto; max-width: 16rem; }
      .totals .row { display: flex; justify-content: space-between; padding: 0.2rem 0; color: var(--text-main); font-size: 0.9rem; }
      .totals .row b { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
      .totals .total { border-top: 2px solid var(--brand-400); padding-top: 0.4rem; margin-top: 0.4rem; font-size: 1.1rem; font-weight: 800; }
      .cancel { margin-top: 0.875rem; background: none; border: none; color: var(--bad-fg); font-weight: 600; font-size: 0.85rem; display: inline-flex; align-items: center; gap: 0.4rem; }

      .empty-cart { text-align: center; padding: 2.5rem 1rem; color: var(--text-muted); }
      .empty-cart i { font-size: 2.25rem; display: block; margin-bottom: 0.5rem; color: var(--text-faint); }

      .cartpill {
        position: fixed; left: 1rem; right: 1rem; bottom: calc(4.75rem + env(safe-area-inset-bottom));
        height: 3.6rem; border: none; border-radius: var(--r-lg, 16px); background: var(--stone-900); color: #fff;
        display: flex; align-items: center; gap: 0.75rem; padding: 0 0.6rem 0 1.1rem; z-index: 40;
        box-shadow: 0 14px 32px -6px rgba(0,0,0,0.5); transition: transform 0.07s var(--ease, ease);
      }
      .cartpill:active { transform: scale(0.99); } .cartpill:disabled { opacity: 0.7; }
      .cp-info { text-align: left; } .cp-info b { display: block; font-family: var(--font-mono); font-size: 1.05rem; font-variant-numeric: tabular-nums; }
      .cp-info span { font-size: 0.7rem; color: var(--stone-400); }
      .cp-cta { margin-left: auto; height: 2.75rem; padding: 0 1.1rem; border-radius: var(--r-md, 12px); background: var(--action); color: #fff; font-weight: 700; font-size: 0.9rem; display: flex; align-items: center; gap: 0.5rem; }

      @media (prefers-reduced-motion: reduce) { .add, .cartpill { transition: none; } }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorTakeOrderComponent implements OnInit {
  private readonly api = inject(VendorService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly confirmSvc = inject(ConfirmationService);
  private readonly toast = inject(MessageService);
  private readonly haptic = inject(HapticService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly customer = signal<VendorCustomer | null>(null);
  readonly prices = signal<PriceRow[]>([]);
  readonly cartLines = signal<OrderLine[]>([]);
  readonly cartOrderId = signal<string | null>(null);
  readonly warehouseId = signal<string>('');
  readonly submitting = signal(false);
  readonly mode = signal<OrderMode>('instante');

  // Para "pedido futuro": fecha de entrega agendada.
  requestedDate = '';
  readonly minDate = new Date().toISOString().slice(0, 10);

  adding: Record<string, boolean> = {};
  searchTerm = '';

  stockClass(p: PriceRow): 'ok' | 'warn' | 'bad' {
    const s = Number(p.stock_available ?? 0);
    if (s <= 0) return 'bad';
    if (s < (p.min_qty || 1)) return 'warn';
    return 'ok';
  }
  stockLabel(p: PriceRow): string {
    const s = Number(p.stock_available ?? 0);
    if (s <= 0) return 'Sin stock';
    if (s < (p.min_qty || 1)) return `Stock ${s}`;
    return `Stock ${s}`;
  }

  readonly filteredPrices = computed(() => {
    const term = this.searchTerm.trim().toLowerCase();
    const all = this.prices();
    if (!term) return all;
    return all.filter((p) => p.product_name.toLowerCase().includes(term));
  });

  readonly cartUnitsTotal = computed(() => this.cartLines().reduce((s, l) => s + Number(l.quantity), 0));
  readonly cartSubtotal = computed(() => this.cartLines().reduce((s, l) => s + Number(l.line_subtotal), 0));
  readonly cartTaxTotal = computed(() => this.cartLines().reduce((s, l) => s + Number(l.line_tax), 0));
  readonly cartTotal = computed(() => this.cartSubtotal() + this.cartTaxTotal());

  cartQty(productId: string): number {
    const l = this.cartLines().find((x) => x.product_id === productId);
    return l ? Number(l.quantity) : 0;
  }

  ngOnInit(): void {
    const m = this.route.snapshot.queryParamMap.get('mode');
    if (m === 'futuro') this.mode.set('futuro');

    const customerId = this.route.snapshot.paramMap.get('id');
    if (!customerId) return;

    this.api
      .defaultWarehouseId()
      .pipe(
        switchMap((warehouseId) =>
          forkJoin({
            customer: this.api.getCustomer(customerId),
            prices: this.api.catalogForCustomer(customerId, warehouseId || undefined),
            warehouseId: of(warehouseId),
            existingDraft: this.api.draftForCustomer(customerId),
          }),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: ({ customer, prices, warehouseId, existingDraft }) => {
          this.customer.set(customer);
          this.prices.set(prices);
          this.warehouseId.set(warehouseId || '');
          if (existingDraft) {
            this.cartOrderId.set(existingDraft.id);
            this.api.orderById(existingDraft.id).subscribe((full) => this.cartLines.set(full.lines || []));
          }
          this.loading.set(false);
        },
        error: (e) => {
          this.loading.set(false);
          this.toast.add({ severity: 'error', summary: 'Error', detail: e.error?.message || e.message });
        },
      });
  }

  back(): void {
    this.router.navigate(['/vendor/route-home']);
  }

  addToCart(p: PriceRow): void {
    const c = this.customer();
    if (!c || !this.warehouseId()) return;
    const qty = p.min_qty || 1;
    if (p.stock_available != null && qty > Number(p.stock_available)) {
      this.toast.add({ severity: 'warn', summary: 'Sin stock suficiente', detail: `Sólo hay ${p.stock_available}. Queda en backorder.`, life: 4000 });
    }
    this.adding[p.product_id] = true;
    const ensure$ = this.cartOrderId()
      ? of({ id: this.cartOrderId()! } as any)
      : this.api.ensureDraftForCustomer(c.id, this.warehouseId(), 'route');
    ensure$
      .pipe(switchMap((draft) => {
        this.cartOrderId.set(draft.id);
        return this.api.addLine(draft.id, p.product_id, qty);
      }))
      .subscribe({
        next: () => {
          this.adding[p.product_id] = false;
          this.haptic.selection();
          this.reloadCart();
        },
        error: (err) => {
          this.adding[p.product_id] = false;
          this.haptic.notification('error');
          this.toast.add({ severity: 'error', summary: 'Error', detail: err.error?.message || err.message });
        },
      });
  }

  inc(line: OrderLine): void {
    this.setQty(line, Number(line.quantity) + 1);
  }
  dec(line: OrderLine): void {
    const next = Number(line.quantity) - 1;
    if (next <= 0) { this.removeLine(line); return; }
    this.setQty(line, next);
  }
  private setQty(line: OrderLine, qty: number): void {
    const orderId = this.cartOrderId();
    if (!orderId) return;
    this.haptic.selection();
    this.api.updateLine(orderId, line.id, qty).subscribe({
      next: () => this.reloadCart(),
      error: (err) => this.toast.add({ severity: 'error', summary: 'Error', detail: err.error?.message || err.message }),
    });
  }

  removeLine(line: OrderLine): void {
    const orderId = this.cartOrderId();
    if (!orderId) return;
    this.api.removeLine(orderId, line.id).subscribe({
      next: () => this.reloadCart(),
      error: (err) => this.toast.add({ severity: 'error', summary: 'Error', detail: err.error?.message || err.message }),
    });
  }

  submit(): void {
    const orderId = this.cartOrderId();
    if (!orderId || this.submitting()) return;

    if (this.mode() === 'futuro') {
      if (!this.requestedDate) {
        this.toast.add({ severity: 'warn', summary: 'Elegí la fecha de entrega' });
        return;
      }
      const pretty = new Date(this.requestedDate + 'T00:00:00').toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
      this.confirmSvc.confirm({
        header: 'Agendar pedido',
        message: `¿Agendar ${this.fmtMoney(this.cartTotal())} para entrega el ${pretty}?`,
        icon: 'pi pi-calendar',
        acceptLabel: 'Agendar', rejectLabel: 'Cancelar',
        accept: () => {
          this.submitting.set(true);
          this.api
            .updateDraftHeader(orderId, { requested_delivery_date: this.requestedDate })
            .pipe(switchMap(() => this.api.confirm(orderId)))
            .subscribe({
              next: (o) => this.onDone(o),
              error: (err) => this.onError(err),
            });
        },
      });
      return;
    }

    // instante (autoventa)
    this.confirmSvc.confirm({
      header: 'Cobrar y entregar',
      message: `¿Cobrar ${this.fmtMoney(this.cartTotal())} y entregar ahora? Se descuenta del inventario.`,
      icon: 'pi pi-bolt',
      acceptLabel: 'Cobrar y entregar', rejectLabel: 'Cancelar',
      accept: () => {
        this.submitting.set(true);
        this.api.deliverNow(orderId).subscribe({
          next: (o) => this.onDone(o),
          error: (err) => this.onError(err),
        });
      },
    });
  }

  private onDone(o: { code?: string; total?: number | string } | null): void {
    this.submitting.set(false);
    const c = this.customer();
    this.router.navigate(['/vendor/order-success'], {
      queryParams: {
        mode: this.mode(),
        code: o?.code || '',
        total: o?.total ?? this.cartTotal(),
        units: this.cartUnitsTotal(),
        name: c?.name || '',
        wa: c?.whatsapp || '',
        date: this.mode() === 'futuro' ? this.requestedDate : '',
      },
    });
  }
  private onError(err: any): void {
    this.submitting.set(false);
    this.haptic.notification('error');
    this.toast.add({ severity: 'error', summary: 'No se pudo completar', detail: err?.error?.message || err?.message || 'Intentá de nuevo.' });
  }

  cancelDraft(): void {
    const orderId = this.cartOrderId();
    if (!orderId) return;
    this.confirmSvc.confirm({
      message: '¿Cancelar este borrador?',
      header: 'Cancelar pedido',
      icon: 'pi pi-trash',
      accept: () => {
        this.api.cancel(orderId, 'Cancelado por el vendedor').subscribe({
          next: () => {
            this.cartLines.set([]);
            this.cartOrderId.set(null);
            this.toast.add({ severity: 'info', summary: 'Borrador cancelado' });
          },
          error: (err) => this.toast.add({ severity: 'error', summary: 'Error', detail: err.error?.message || err.message }),
        });
      },
    });
  }

  productNameById(id: string): string {
    return this.prices().find((p) => p.product_id === id)?.product_name || id.slice(0, 8);
  }
  initials(name: string): string {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  trackProduct(_: number, p: PriceRow): string { return p.product_id; }
  trackLine(_: number, l: OrderLine): string { return l.id; }

  private reloadCart(): void {
    const orderId = this.cartOrderId();
    if (!orderId) return;
    this.api.orderById(orderId).subscribe({ next: (full) => this.cartLines.set(full.lines || []) });
  }

  fmtMoney(n: unknown): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);
  }
}
