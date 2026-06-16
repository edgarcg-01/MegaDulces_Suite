import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { forkJoin, of } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { InputNumberModule } from 'primeng/inputnumber';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { VendorService } from '../../comercial/vendor.service';
import { TeleventaService } from '../televenta.service';
import { environment } from '../../../../environments/environment';

interface CartRow {
  product_id: string;
  name: string;
  brand: string | null;
  unit_price: number;
  stock_available: number | null;
  quantity: number; // 0 = no agregado
}

@Component({
  selector: 'app-televenta-take-order',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    ButtonModule,
    InputNumberModule,
    ProgressSpinnerModule,
    TableModule,
    TagModule,
    ConfirmDialogModule,
  ],
  providers: [ConfirmationService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-confirmDialog></p-confirmDialog>

    <section class="page" *ngIf="!loading() && customer(); else loadingTpl">
      <a [routerLink]="['/televenta/lead', customerId]" class="back-link">
        <i class="pi pi-arrow-left" aria-hidden="true"></i> Volver al cliente
      </a>

      <header class="head card">
        <div>
          <p class="code">{{ customer()?.code }}</p>
          <h1>Pedido para {{ customer()?.name }}</h1>
        </div>
        <div class="cart-total">
          <span class="label">Total</span>
          <span class="amount">\${{ cartTotal() | number:'1.2-2' }}</span>
        </div>
      </header>

      <!-- Catálogo + cantidades -->
      <div class="card">
        <h2>Catálogo del cliente <span class="count">({{ rows().length }} productos)</span></h2>
        <input
          type="search"
          [(ngModel)]="searchTerm"
          (ngModelChange)="onSearch($event)"
          placeholder="Buscar producto..."
          class="search"
          aria-label="Buscar producto"
          inputmode="search"
          enterkeyhint="search"
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
        />

        <div *ngIf="filteredRows().length === 0" class="empty-mini">Sin productos.</div>

        <div class="grid">
          <article *ngFor="let r of filteredRows(); trackBy: trackPid" class="prod"
                   [class.selected]="r.quantity > 0">
            <div class="prod-info">
              <p class="prod-name">{{ r.name }}</p>
              <p class="prod-meta">
                <span *ngIf="r.brand">{{ r.brand }}</span>
                <span>\${{ r.unit_price | number:'1.2-2' }}</span>
                <span *ngIf="r.stock_available !== null">{{ r.stock_available }} disp</span>
              </p>
            </div>
            <div class="prod-actions">
              <p-inputNumber
                [(ngModel)]="r.quantity"
                [min]="0"
                [max]="9999"
                [showButtons]="true"
                buttonLayout="horizontal"
                spinnerMode="horizontal"
                inputStyleClass="qty-input"
                [step]="1"
                (onInput)="onQtyChange()"
              ></p-inputNumber>
            </div>
          </article>
        </div>
      </div>

      <!-- Sticky footer con confirm -->
      <div class="sticky-footer">
        <div class="summary">
          <span>{{ cartCount() }} items</span>
          <span class="total">\${{ cartTotal() | number:'1.2-2' }}</span>
        </div>
        <button
          pButton
          icon="pi pi-check"
          label="Confirmar pedido + registrar venta"
          [disabled]="cartCount() === 0 || saving()"
          [loading]="saving()"
          (click)="confirmOrder()"
        ></button>
      </div>
    </section>

    <ng-template #loadingTpl>
      <div class="loading" aria-live="polite">
        <p-progressSpinner styleClass="w-12 h-12"></p-progressSpinner>
      </div>
    </ng-template>
  `,
  styles: [
    `
      .page { display: flex; flex-direction: column; gap: 1rem; padding-bottom: 6rem; }
      .back-link { display: inline-flex; align-items: center; gap: 0.4rem; color: var(--text-color-secondary); font-size: 0.875rem; text-decoration: none; min-height: 36px; }
      .back-link:hover { color: var(--primary-color); }
      .card { background: var(--surface-card); border: 1px solid var(--surface-border); border-radius: 16px; padding: 1.25rem; }
      .card h2 { font-size: 1rem; font-weight: 600; margin: 0 0 0.75rem; color: var(--text-color); }
      .count { font-size: 0.8rem; color: var(--text-color-secondary); font-weight: 400; }
      .head { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
      .head h1 { font-size: 1.25rem; font-weight: 700; margin: 0.25rem 0 0; color: var(--text-color); }
      .code { font-size: 0.75rem; color: var(--text-color-secondary); margin: 0; font-weight: 600; letter-spacing: 0.04em; }
      .cart-total { text-align: right; }
      .cart-total .label { font-size: 0.75rem; color: var(--text-color-secondary); display: block; }
      .cart-total .amount { font-size: 1.5rem; font-weight: 700; color: var(--primary-color); }
      .search {
        width: 100%;
        padding: 0.7rem 1rem;
        border: 1px solid var(--surface-border);
        border-radius: 10px;
        font-size: 0.9rem;
        margin-bottom: 1rem;
        min-height: 44px;
        box-sizing: border-box;
      }
      .search:focus { outline: 2px solid var(--primary-color); outline-offset: 1px; }
      .empty-mini { font-size: 0.85rem; color: var(--text-color-secondary); font-style: italic; padding: 1rem 0; text-align: center; }
      .grid { display: grid; grid-template-columns: 1fr; gap: 0.5rem; max-height: 60vh; overflow-y: auto; }
      .prod { display: flex; align-items: center; gap: 1rem; padding: 0.75rem; background: var(--neutral-50); border-radius: 10px; border: 1px solid transparent; min-height: 64px; }
      .prod.selected { border-color: var(--primary-color); background: var(--info-soft-bg); }
      .prod-info { flex: 1; min-width: 0; }
      .prod-name { font-size: 0.9rem; font-weight: 500; margin: 0; color: var(--text-color); }
      .prod-meta { font-size: 0.75rem; color: var(--text-color-secondary); margin: 0.15rem 0 0; display: flex; flex-wrap: wrap; gap: 0.75rem; }
      .prod-actions { flex-shrink: 0; }
      .qty-input { width: 70px !important; text-align: center; }
      .sticky-footer {
        position: sticky; bottom: 0; left: 0; right: 0;
        background: var(--surface-card); border-top: 1px solid var(--surface-border);
        padding: 0.85rem 1rem calc(0.85rem + env(safe-area-inset-bottom));
        margin: 0 -1rem -1rem;
        display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
        box-shadow: 0 -4px 12px rgba(0,0,0,0.04);
      }
      .summary { display: flex; align-items: baseline; gap: 1rem; flex: 1; font-size: 0.875rem; color: var(--text-color-secondary); }
      .summary .total { font-size: 1.25rem; font-weight: 700; color: var(--primary-color); }
      .loading { display: flex; justify-content: center; padding: 4rem 0; }
      @media (max-width: 640px) {
        .head { flex-direction: column; align-items: flex-start; }
        .cart-total { text-align: left; }
      }
    `,
  ],
})
export class TeleventaTakeOrderComponent implements OnInit {
  private readonly vendor = inject(VendorService);
  private readonly televenta = inject(TeleventaService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly confirmSvc = inject(ConfirmationService);
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  customerId = '';
  warehouseId: string | null = null;

  readonly customer = signal<{ id: string; code: string; name: string } | null>(null);
  readonly rows = signal<CartRow[]>([]);
  readonly loading = signal<boolean>(true);
  readonly saving = signal<boolean>(false);
  searchTerm = '';
  private searchSig = signal<string>('');

  readonly cartCount = computed(() =>
    this.rows().reduce((sum, r) => sum + (r.quantity > 0 ? 1 : 0), 0),
  );
  readonly cartTotal = computed(() =>
    this.rows().reduce((sum, r) => sum + r.quantity * r.unit_price, 0),
  );
  readonly filteredRows = computed(() => {
    const q = this.searchSig().trim().toLowerCase();
    if (!q) return this.rows();
    return this.rows().filter(
      (r) => r.name.toLowerCase().includes(q) || (r.brand || '').toLowerCase().includes(q),
    );
  });

  ngOnInit(): void {
    this.customerId = this.route.snapshot.paramMap.get('customer_id') || '';
    this.bootstrap();
  }

  trackPid(_: number, row: CartRow): string { return row.product_id; }

  onSearch(v: string) { this.searchSig.set(v); }
  onQtyChange() { /* signal-based total recomputes automatically */ }

  private bootstrap(): void {
    if (!this.customerId) {
      this.toast.add({ severity: 'error', summary: 'Sin cliente', detail: 'Falta customer_id en la URL.' });
      this.router.navigate(['/televenta/queue']);
      return;
    }

    forkJoin({
      customer: this.vendor.getCustomer(this.customerId),
      warehouses: this.http.get<any[]>(`${this.apiUrl}/commercial/warehouses`),
    }).subscribe({
      next: ({ customer, warehouses }) => {
        this.customer.set({ id: customer.id, code: customer.code, name: customer.name });
        const wh = warehouses.find((w) => w.is_default) || warehouses[0];
        if (!wh) {
          this.toast.add({ severity: 'error', summary: 'Sin almacén', detail: 'El tenant no tiene almacenes configurados.' });
          return;
        }
        this.warehouseId = wh.id;
        this.loadCatalog();
      },
      error: (err) => {
        this.loading.set(false);
        this.toast.add({
          severity: 'error',
          summary: 'Error',
          detail: err?.error?.message || 'No se pudo cargar el cliente o almacenes.',
        });
      },
    });
  }

  private loadCatalog(): void {
    if (!this.warehouseId) return;
    this.vendor.catalogForCustomer(this.customerId, this.warehouseId).subscribe({
      next: (items) => {
        this.rows.set(
          (items || []).map((it: any) => ({
            product_id: it.product_id,
            name: it.product_name || it.name,
            brand: it.brand_name || null,
            unit_price: Number(it.unit_price ?? it.price ?? 0),
            stock_available: it.stock_available !== undefined ? Number(it.stock_available) : null,
            quantity: 0,
          })),
        );
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.toast.add({
          severity: 'error',
          summary: 'Sin catálogo',
          detail: err?.error?.message || 'No se pudo cargar el catálogo de este cliente.',
        });
      },
    });
  }

  confirmOrder(): void {
    const selectedLines = this.rows().filter((r) => r.quantity > 0);
    if (selectedLines.length === 0) return;

    this.confirmSvc.confirm({
      message: `¿Confirmar pedido con ${selectedLines.length} productos por $${this.cartTotal().toFixed(2)}? Se registrará una llamada con resultado "venta" y se liberará la reserva.`,
      header: 'Confirmar venta',
      icon: 'pi pi-check-circle',
      acceptLabel: 'Sí, confirmar',
      rejectLabel: 'Cancelar',
      accept: () => this.executeOrder(selectedLines),
    });
  }

  private async executeOrder(lines: CartRow[]): Promise<void> {
    if (!this.warehouseId) return;
    this.saving.set(true);
    try {
      const draft: any = await this.vendor
        .ensureDraftForCustomer(this.customerId, this.warehouseId)
        .toPromise();
      if (!draft?.id) throw new Error('No se pudo crear el draft');

      // Add lines secuencial (idempotente: el backend hace UPDATE si la línea existe).
      for (const l of lines) {
        await this.vendor.addLine(draft.id, l.product_id, l.quantity).toPromise();
      }

      // Confirm el order.
      await this.vendor.confirm(draft.id).toPromise();

      // Registrar la llamada con outcome=sale + order_id + release reservation.
      await this.televenta
        .logCall({
          customer_id: this.customerId,
          outcome: 'sale',
          notes: `Pedido confirmado vía televenta: ${lines.length} productos, total $${this.cartTotal().toFixed(2)}.`,
          order_id: draft.id,
          release_reservation: true,
        })
        .toPromise();

      this.saving.set(false);
      this.toast.add({
        severity: 'success',
        summary: 'Pedido confirmado',
        detail: 'Llamada registrada como venta. Reserva liberada.',
        life: 4000,
      });
      this.router.navigate(['/televenta/queue']);
    } catch (err: any) {
      this.saving.set(false);
      this.toast.add({
        severity: 'error',
        summary: 'Error al confirmar',
        detail: err?.error?.message || err?.message || 'No se pudo confirmar el pedido.',
        life: 6000,
      });
    }
  }
}
