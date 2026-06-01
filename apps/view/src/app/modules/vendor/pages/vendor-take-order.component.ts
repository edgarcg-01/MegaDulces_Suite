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
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { CardModule } from 'primeng/card';
import { SkeletonModule } from 'primeng/skeleton';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { TagModule } from 'primeng/tag';
import { SelectButtonModule } from 'primeng/selectbutton';
import { ConfirmationService, MessageService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of, switchMap } from 'rxjs';
import { VendorService, VendorCustomer } from '../vendor.service';
import { PriceRow, OrderLine } from '../../portal/portal.service';
import { HapticService } from '../../../core/services/haptic.service';

@Component({
  selector: 'app-vendor-take-order',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    ButtonModule,
    TableModule,
    CardModule,
    SkeletonModule,
    InputNumberModule,
    InputTextModule,
    ConfirmDialogModule,
    TagModule,
    SelectButtonModule,
  ],
  providers: [ConfirmationService, MessageService],
  template: `
    <p-confirmDialog></p-confirmDialog>

    <a
      pButton
      label="Volver a clientes"
      icon="pi pi-arrow-left"
      severity="secondary"
      [text]="true"
      size="small"
      routerLink="/vendor/customers"
      class="back-link"
    ></a>

    <p-skeleton *ngIf="loading()" height="500px"></p-skeleton>

    <ng-container *ngIf="!loading() && customer() as c">
      <header class="customer-header">
        <h1>{{ c.name }}</h1>
        <span class="code">{{ c.code }}</span>
        <!-- J.6.6: tipo de entrega — afecta cómo logística arma el shipment -->
        <div class="delivery-type">
          <label>Tipo de entrega:</label>
          <p-selectButton
            [options]="deliveryTypeOptions"
            [(ngModel)]="deliveryType"
            (onChange)="onDeliveryTypeChange()"
            optionLabel="label"
            optionValue="value"
            [allowEmpty]="false"
          ></p-selectButton>
        </div>
      </header>

      <!-- Cart summary -->
      <p-card *ngIf="cartLines().length > 0" styleClass="cart-summary">
        <div class="cart-summary-row">
          <div class="info">
            <i class="pi pi-shopping-cart"></i>
            <span>
              <b>{{ cartLines().length }}</b> producto(s) ·
              <b>{{ cartUnitsTotal() }}</b> unidad(es) ·
              <b>{{ fmtMoney(cartTotal()) }}</b>
            </span>
          </div>
          <button
            pButton
            label="Ver carrito"
            icon="pi pi-arrow-up"
            size="small"
            severity="secondary"
            (click)="scrollToCart()"
          ></button>
        </div>
      </p-card>

      <!-- Search -->
      <div class="search-bar">
        <input
          pInputText
          type="search"
          placeholder="Buscar producto"
          [(ngModel)]="searchTerm"
          class="search-input"
          inputmode="search"
          enterkeyhint="search"
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
        />
      </div>

      <!-- Catalog -->
      <section class="catalog">
        <p-card
          *ngFor="let p of filteredPrices(); trackBy: trackProduct"
          styleClass="product-card"
        >
          <div class="product-row">
            <div class="info">
              <div class="name">{{ p.product_name }}</div>
              <div class="meta">
                <span class="price">{{ fmtMoney(p.price) }}</span>
                <span class="min" *ngIf="p.min_qty > 1">min {{ p.min_qty }}</span>
                <!-- J.6.7: badge stock disponible -->
                <p-tag
                  *ngIf="p.stock_available != null"
                  [severity]="stockSeverity(p)"
                  [value]="stockLabel(p)"
                  class="stock-tag"
                ></p-tag>
              </div>
            </div>
            <div class="qty-controls">
              <p-inputNumber
                [(ngModel)]="qtyByProduct[p.product_id]"
                [min]="p.min_qty || 1"
                [showButtons]="true"
                buttonLayout="horizontal"
                [inputStyle]="{ width: '50px', textAlign: 'center' }"
              ></p-inputNumber>
              <button
                pButton
                icon="pi pi-plus"
                size="small"
                severity="contrast"
                [disabled]="!!adding[p.product_id]"
                (click)="addToCart(p)"
              ></button>
            </div>
          </div>
        </p-card>
      </section>

      <!-- Cart detail -->
      <section #cartSection class="cart-detail" *ngIf="cartLines().length > 0">
        <h2>Carrito</h2>
        <p-table [value]="cartLines()" styleClass="p-datatable-sm">
          <ng-template pTemplate="header">
            <tr>
              <th>Producto</th>
              <th class="tr">Cantidad</th>
              <th class="tr">Total</th>
              <th></th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-l>
            <tr>
              <td>{{ productNameById(l.product_id) }}</td>
              <td class="tr">
                <p-inputNumber
                  [ngModel]="l.quantity"
                  (ngModelChange)="updateLineQty(l, $event)"
                  [min]="1"
                  [showButtons]="true"
                  buttonLayout="horizontal"
                  [inputStyle]="{ width: '50px' }"
                ></p-inputNumber>
              </td>
              <td class="tr money">{{ fmtMoney(l.line_total) }}</td>
              <td>
                <button
                  pButton
                  icon="pi pi-trash"
                  severity="danger"
                  text
                  size="small"
                  (click)="removeLine(l)"
                ></button>
              </td>
            </tr>
          </ng-template>
        </p-table>

        <div class="totals">
          <div class="row"><span>Subtotal</span><b>{{ fmtMoney(cartSubtotal()) }}</b></div>
          <div class="row"><span>IVA</span><b>{{ fmtMoney(cartTaxTotal()) }}</b></div>
          <div class="row total"><span>Total</span><b>{{ fmtMoney(cartTotal()) }}</b></div>
        </div>

        <div class="actions">
          <button
            pButton
            label="Cancelar"
            severity="secondary"
            outlined
            (click)="cancelDraft()"
          ></button>
          <button
            pButton
            label="Confirmar pedido"
            icon="pi pi-check"
            severity="contrast"
            [disabled]="confirming()"
            (click)="confirm()"
          ></button>
        </div>
      </section>
    </ng-container>
  `,
  styles: [
    `
      .back-link {
        display: inline-flex;
        margin-bottom: 0.5rem;
      }
      .customer-header {
        margin-bottom: 1rem;
      }
      .customer-header h1 { margin: 0; font-size: 1.5rem; color: var(--text-main); }
      .customer-header .code {
        color: var(--text-muted);
        font-size: 0.875rem;
      }
      /* J.6.6 — Toggle tipo de entrega en el header */
      .delivery-type {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-top: 0.5rem;
        font-size: 0.85rem;
        color: var(--text-muted);
      }
      :host ::ng-deep .delivery-type .p-selectbutton .p-button {
        padding: 0.25rem 0.65rem;
        font-size: 0.8rem;
      }
      /* J.6.7 — Badge stock en cada producto del catalog */
      .stock-tag { margin-left: auto; }
      :host ::ng-deep .meta .p-tag {
        font-size: 0.7rem;
        padding: 0.1rem 0.4rem;
      }
      /* Cart summary: bg brand-400 + text neutral-950 (regla #1 UX_TOKENS:
         brand-400 amarillo NUNCA con texto blanco encima — contraste 1.07). */
      :host ::ng-deep .p-card.cart-summary {
        background: var(--brand-400);
        color: var(--neutral-950);
        margin-bottom: 1rem;
        border: 1px solid var(--brand-500);
      }
      :host ::ng-deep .p-card.cart-summary .p-card-body { padding: 0.75rem 1rem; }
      :host ::ng-deep .p-card.cart-summary .p-card-content { padding: 0; color: var(--neutral-950); }
      .cart-summary-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
      }
      .cart-summary-row .info {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.875rem;
      }
      .cart-summary-row .info i { font-size: 1.125rem; }
      .search-bar { margin-bottom: 1rem; }
      .search-input { width: 100%; }
      .catalog {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      :host ::ng-deep .p-card.product-card {
        background: var(--card-bg);
        border: 1px solid var(--border-color);
      }
      :host ::ng-deep .p-card.product-card .p-card-body { padding: 0.75rem; }
      :host ::ng-deep .p-card.product-card .p-card-content { padding: 0; }
      .product-row {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }
      .product-row .info { flex: 1; min-width: 0; }
      .name {
        font-weight: 600;
        font-size: 0.95rem;
        line-height: 1.2;
        color: var(--text-main);
      }
      .meta {
        display: flex;
        gap: 0.75rem;
        font-size: 0.8rem;
        margin-top: 0.25rem;
        color: var(--text-muted);
      }
      .meta .price {
        font-weight: 700;
        color: var(--brand-700);
      }
      .meta .min { color: var(--text-muted); }
      .qty-controls {
        display: flex;
        gap: 0.375rem;
        align-items: center;
      }
      .cart-detail {
        margin-top: 2rem;
        padding-top: 1rem;
        border-top: 2px solid var(--border-color);
      }
      .cart-detail h2 { margin: 0 0 1rem; font-size: 1.25rem; color: var(--text-main); }
      .tr { text-align: right; }
      .money { font-variant-numeric: tabular-nums; }
      .totals {
        max-width: 280px;
        margin-left: auto;
        margin-top: 1rem;
      }
      .totals .row {
        display: flex;
        justify-content: space-between;
        padding: 0.25rem 0;
        color: var(--text-main);
      }
      .totals .total {
        border-top: 2px solid var(--brand-400);
        padding-top: 0.5rem;
        margin-top: 0.5rem;
        font-size: 1.125rem;
        font-weight: 700;
      }
      .actions {
        display: flex;
        gap: 0.5rem;
        margin-top: 1rem;
      }
      .actions button { flex: 1; }
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
  readonly confirming = signal(false);

  // J.6.6 — Tipo de entrega del pedido (route default; long_trip si es foráneo)
  deliveryType: 'route' | 'long_trip' = 'route';
  readonly deliveryTypeOptions = [
    { label: 'Por ruta', value: 'route' },
    { label: 'Viaje largo', value: 'long_trip' },
  ];

  qtyByProduct: Record<string, number> = {};
  adding: Record<string, boolean> = {};
  searchTerm = '';

  // J.6.7 — Stock helpers para badges
  stockSeverity(p: PriceRow): 'success' | 'warn' | 'danger' {
    const s = Number(p.stock_available ?? 0);
    if (s <= 0) return 'danger';
    if (s < (p.min_qty || 1)) return 'warn';
    return 'success';
  }
  stockLabel(p: PriceRow): string {
    const s = Number(p.stock_available ?? 0);
    if (s <= 0) return 'Sin stock';
    if (s < (p.min_qty || 1)) return `Stock bajo: ${s}`;
    return `Stock: ${s}`;
  }

  // J.6.6 — al cambiar tipo entrega: si hay draft, PATCH inmediato
  onDeliveryTypeChange(): void {
    const orderId = this.cartOrderId();
    if (!orderId) return; // Cambio antes de crear draft: queda en memoria.
    this.api.updateDraftHeader(orderId, { delivery_type: this.deliveryType }).subscribe({
      next: () =>
        this.toast.add({
          severity: 'info',
          summary: 'Tipo de entrega actualizado',
          life: 2000,
        }),
      error: (e) =>
        this.toast.add({
          severity: 'error',
          summary: 'Error',
          detail: e?.error?.message || 'No se pudo actualizar',
        }),
    });
  }

  // Filtrado client-side (catálogo chico — testdata 25 productos)
  readonly filteredPrices = computed(() => {
    const term = this.searchTerm.trim().toLowerCase();
    const all = this.prices();
    if (!term) return all;
    return all.filter((p) => p.product_name.toLowerCase().includes(term));
  });

  readonly cartUnitsTotal = computed(() =>
    this.cartLines().reduce((s, l) => s + Number(l.quantity), 0),
  );
  readonly cartSubtotal = computed(() =>
    this.cartLines().reduce((s, l) => s + Number(l.line_subtotal), 0),
  );
  readonly cartTaxTotal = computed(() =>
    this.cartLines().reduce((s, l) => s + Number(l.line_tax), 0),
  );
  readonly cartTotal = computed(() => this.cartSubtotal() + this.cartTaxTotal());

  ngOnInit(): void {
    const customerId = this.route.snapshot.paramMap.get('id');
    if (!customerId) return;

    // Cargamos warehouse primero (lo necesitamos para pedir el catalog con stock).
    // J.6.7: catalogForCustomer ahora recibe el warehouse_id y devuelve stock_available.
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
          prices.forEach((p) => (this.qtyByProduct[p.product_id] = p.min_qty || 1));
          if (existingDraft) {
            this.cartOrderId.set(existingDraft.id);
            // J.6.6: mantener delivery_type del draft existente para que el toggle refleje el real
            if ((existingDraft as any).delivery_type) {
              this.deliveryType = (existingDraft as any).delivery_type;
            }
            this.api.orderById(existingDraft.id).subscribe((full) => {
              this.cartLines.set(full.lines || []);
            });
          }
          this.loading.set(false);
        },
        error: (e) => {
          this.loading.set(false);
          this.toast.add({ severity: 'error', summary: 'Error', detail: e.error?.message || e.message });
        },
      });
  }

  addToCart(p: PriceRow): void {
    const c = this.customer();
    if (!c || !this.warehouseId()) return;
    const qty = Number(this.qtyByProduct[p.product_id]) || p.min_qty || 1;
    if (qty < (p.min_qty || 1)) {
      this.toast.add({
        severity: 'warn',
        summary: 'Mínimo',
        detail: `Mínimo ${p.min_qty} unidades.`,
      });
      return;
    }
    // J.6.7 — Si pedimos más de lo disponible, advertir (no bloquear: permite backorder)
    if (p.stock_available != null && qty > Number(p.stock_available)) {
      this.toast.add({
        severity: 'warn',
        summary: 'Sin stock suficiente',
        detail: `Sólo hay ${p.stock_available} disponibles. El pedido quedará en backorder hasta reabasto.`,
        life: 5000,
      });
      // No return: dejamos seguir.
    }
    this.adding[p.product_id] = true;

    const ensure$ = this.cartOrderId()
      ? of({ id: this.cartOrderId()! } as any)
      : this.api.ensureDraftForCustomer(c.id, this.warehouseId(), this.deliveryType);

    ensure$
      .pipe(switchMap((draft) => {
        this.cartOrderId.set(draft.id);
        return this.api.addLine(draft.id, p.product_id, qty);
      }))
      .subscribe({
        next: () => {
          this.adding[p.product_id] = false;
          this.haptic.selection();
          this.toast.add({
            severity: 'success',
            summary: 'Agregado',
            detail: `${qty}× ${p.product_name}`,
            life: 1500,
          });
          this.reloadCart();
        },
        error: (err) => {
          this.adding[p.product_id] = false;
          this.haptic.notification('error');
          this.toast.add({
            severity: 'error',
            summary: 'Error',
            detail: err.error?.message || err.message,
          });
        },
      });
  }

  updateLineQty(line: OrderLine, qty: number): void {
    const orderId = this.cartOrderId();
    if (!orderId) return;
    this.api.updateLine(orderId, line.id, qty).subscribe({
      next: () => this.reloadCart(),
      error: (err) =>
        this.toast.add({
          severity: 'error',
          summary: 'Error',
          detail: err.error?.message || err.message,
        }),
    });
  }

  removeLine(line: OrderLine): void {
    const orderId = this.cartOrderId();
    if (!orderId) return;
    this.api.removeLine(orderId, line.id).subscribe({
      next: () => this.reloadCart(),
      error: (err) =>
        this.toast.add({
          severity: 'error',
          summary: 'Error',
          detail: err.error?.message || err.message,
        }),
    });
  }

  confirm(): void {
    const orderId = this.cartOrderId();
    if (!orderId) return;
    this.confirmSvc.confirm({
      message: `¿Confirmar pedido por ${this.fmtMoney(this.cartTotal())}? Se reservará stock.`,
      header: 'Confirmar pedido',
      icon: 'pi pi-exclamation-triangle',
      accept: () => {
        this.confirming.set(true);
        this.api.confirm(orderId).subscribe({
          next: (confirmed) => {
            this.confirming.set(false);
            this.haptic.notification('success');
            this.toast.add({
              severity: 'success',
              summary: 'Pedido confirmado',
              detail: confirmed.code,
            });
            this.router.navigate(['/vendor/today']);
          },
          error: (err) => {
            this.confirming.set(false);
            this.haptic.notification('error');
            this.toast.add({
              severity: 'error',
              summary: 'Error',
              detail: err.error?.message || err.message,
            });
          },
        });
      },
    });
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

  scrollToCart(): void {
    document.querySelector('.cart-detail')?.scrollIntoView({ behavior: 'smooth' });
  }

  productNameById(id: string): string {
    return this.prices().find((p) => p.product_id === id)?.product_name || id.slice(0, 8);
  }

  trackProduct(_: number, p: PriceRow): string {
    return p.product_id;
  }

  private reloadCart(): void {
    const orderId = this.cartOrderId();
    if (!orderId) return;
    this.api.orderById(orderId).subscribe({
      next: (full) => this.cartLines.set(full.lines || []),
    });
  }

  fmtMoney(n: any): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);
  }
}
