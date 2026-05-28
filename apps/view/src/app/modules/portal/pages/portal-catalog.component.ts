import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { CardModule } from 'primeng/card';
import { SkeletonModule } from 'primeng/skeleton';
import { InputNumberModule } from 'primeng/inputnumber';
import { MessageService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin } from 'rxjs';
import { PortalService, PriceRow } from '../portal.service';

@Component({
  selector: 'app-portal-catalog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    TableModule,
    CardModule,
    SkeletonModule,
    InputNumberModule,
  ],
  template: `
    <h1 class="page-title">Catálogo</h1>
    <p class="page-subtitle" *ngIf="customerName()">
      Lista de precio aplicada a <b>{{ customerName() }}</b>
    </p>

    <p-skeleton *ngIf="loading()" height="500px"></p-skeleton>

    <p-card *ngIf="!loading() && prices().length === 0">
      <div class="empty">
        <i class="pi pi-info-circle"></i>
        <p>Aún no hay productos con precio configurado. Contacta a tu administrador.</p>
      </div>
    </p-card>

    <p-table
      *ngIf="!loading() && prices().length > 0"
      [value]="prices()"
      styleClass="p-datatable-sm catalog-table"
      [scrollable]="true"
      scrollHeight="calc(100vh - 280px)"
    >
      <ng-template pTemplate="header">
        <tr>
          <th>Producto</th>
          <th class="tr">Precio unitario</th>
          <th class="tr">IVA</th>
          <th class="tr">Min</th>
          <th class="tr">Cantidad</th>
          <th></th>
        </tr>
      </ng-template>
      <ng-template pTemplate="body" let-p>
        <tr>
          <td class="prod-name">{{ p.product_name }}</td>
          <td class="tr money">{{ fmtMoney(p.price) }}</td>
          <td class="tr">{{ fmtPct(p.tax_rate) }}</td>
          <td class="tr">{{ p.min_qty }}</td>
          <td class="tr qty-cell">
            <p-inputNumber
              [(ngModel)]="qtyByProduct[p.product_id]"
              [min]="p.min_qty"
              [showButtons]="true"
              buttonLayout="horizontal"
              spinnerMode="horizontal"
              [step]="1"
              [inputStyle]="{ width: '60px', textAlign: 'right' }"
            ></p-inputNumber>
          </td>
          <td class="tr">
            <button
              pButton
              icon="pi pi-shopping-cart"
              label="Agregar"
              size="small"
              [disabled]="!!adding[p.product_id]"
              (click)="addToCart(p)"
            ></button>
          </td>
        </tr>
      </ng-template>
    </p-table>
  `,
  styles: [
    `
      .page-title {
        margin: 0 0 0.25rem;
        font-size: 1.5rem;
      }
      .page-subtitle {
        margin: 0 0 1.25rem;
        color: var(--text-color-secondary);
        font-size: 0.875rem;
      }
      .tr {
        text-align: right;
      }
      .money {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
      }
      .prod-name {
        font-weight: 600;
      }
      .qty-cell ::ng-deep .p-inputnumber {
        display: inline-flex;
      }
      .empty {
        text-align: center;
        padding: 2rem;
        color: var(--text-color-secondary);
      }
      .empty i {
        font-size: 2rem;
        margin-bottom: 0.5rem;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PortalCatalogComponent implements OnInit {
  private readonly api = inject(PortalService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly prices = signal<PriceRow[]>([]);
  readonly customerName = signal<string>('');
  readonly customerId = signal<string>('');
  readonly warehouseId = signal<string>('');

  qtyByProduct: Record<string, number> = {};
  adding: Record<string, boolean> = {};

  ngOnInit(): void {
    this.loadAll();
  }

  private loadAll(): void {
    this.loading.set(true);
    forkJoin({
      customer: this.api.myCustomerInfo(),
      warehouses: this.api.listWarehouses(),
      priceLists: this.api.listPriceLists(),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ customer, warehouses, priceLists }) => {
          if (!customer) {
            this.toast.add({
              severity: 'error',
              summary: 'Sin customer',
              detail: 'Tu usuario no está linkeado a un cliente B2B.',
            });
            this.loading.set(false);
            return;
          }
          this.customerName.set(customer.name);
          this.customerId.set(customer.id);
          const defaultWh = warehouses.find((w: any) => w.is_default) || warehouses[0];
          this.warehouseId.set(defaultWh?.id || '');

          // Resolver lista de precio: la del customer si existe, sino la default
          const customerPriceList = customer.default_price_list_id
            ? priceLists.find((pl: any) => pl.id === customer.default_price_list_id)
            : priceLists.find((pl: any) => pl.is_default);

          if (!customerPriceList) {
            this.prices.set([]);
            this.loading.set(false);
            return;
          }

          this.api.listPricesForList(customerPriceList.id)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
              next: (rows) => {
                this.prices.set(rows);
                rows.forEach((r) => (this.qtyByProduct[r.product_id] = r.min_qty || 1));
                this.loading.set(false);
              },
              error: (e) => {
                this.toast.add({ severity: 'error', summary: 'Error', detail: e.message });
                this.loading.set(false);
              },
            });
        },
        error: (e) => {
          this.toast.add({ severity: 'error', summary: 'Error', detail: e.message });
          this.loading.set(false);
        },
      });
  }

  addToCart(p: PriceRow): void {
    const qty = Number(this.qtyByProduct[p.product_id]) || p.min_qty;
    if (qty < p.min_qty) {
      this.toast.add({
        severity: 'warn',
        summary: 'Cantidad mínima',
        detail: `Este producto requiere mínimo ${p.min_qty} unidades.`,
      });
      return;
    }
    this.adding[p.product_id] = true;

    this.api
      .ensureDraft(this.customerId(), this.warehouseId())
      .subscribe({
        next: (draft) => {
          this.api.addLine(draft.id, p.product_id, qty).subscribe({
            next: () => {
              this.adding[p.product_id] = false;
              this.toast.add({
                severity: 'success',
                summary: 'Agregado',
                detail: `${qty}x ${p.product_name} en el carrito.`,
                life: 2500,
              });
            },
            error: (err) => {
              this.adding[p.product_id] = false;
              this.toast.add({
                severity: 'error',
                summary: 'No se pudo agregar',
                detail: err.error?.message || err.message,
              });
            },
          });
        },
        error: (err) => {
          this.adding[p.product_id] = false;
          this.toast.add({
            severity: 'error',
            summary: 'No se pudo crear el carrito',
            detail: err.error?.message || err.message,
          });
        },
      });
  }

  fmtMoney(n: any): string {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'MXN',
    }).format(Number(n) || 0);
  }
  fmtPct(n: any): string {
    return ((Number(n) || 0) * 100).toFixed(0) + '%';
  }
}
