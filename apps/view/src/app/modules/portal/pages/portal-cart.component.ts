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
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { CardModule } from 'primeng/card';
import { SkeletonModule } from 'primeng/skeleton';
import { InputNumberModule } from 'primeng/inputnumber';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { PortalService, Order } from '../portal.service';

@Component({
  selector: 'app-portal-cart',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    TableModule,
    CardModule,
    SkeletonModule,
    InputNumberModule,
    ConfirmDialogModule,
  ],
  providers: [ConfirmationService],
  template: `
    <p-confirmDialog></p-confirmDialog>
    <h1 class="page-title">Carrito</h1>

    <p-skeleton *ngIf="loading()" height="300px"></p-skeleton>

    <p-card *ngIf="!loading() && !cart()">
      <div class="empty">
        <i class="pi pi-shopping-cart"></i>
        <p>Tu carrito está vacío.</p>
        <button
          pButton
          label="Ir al catálogo"
          icon="pi pi-list"
          (click)="goCatalog()"
        ></button>
      </div>
    </p-card>

    <ng-container *ngIf="!loading() && cart() as c">
      <div class="cart-header">
        <span class="code">{{ c.code }}</span>
        <span class="created">creado {{ fmtDate(c.created_at) }}</span>
      </div>

      <p-table
        [value]="c.lines || []"
        styleClass="p-datatable-sm"
        *ngIf="(c.lines || []).length > 0"
      >
        <ng-template pTemplate="header">
          <tr>
            <th>#</th>
            <th>Producto</th>
            <th class="tr">Precio</th>
            <th class="tr">Cantidad</th>
            <th class="tr">Subtotal</th>
            <th class="tr">IVA</th>
            <th class="tr">Total</th>
            <th></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-line>
          <tr>
            <td>{{ line.line_number }}</td>
            <td>{{ line.product_id.slice(0, 8) }}</td>
            <td class="tr money">{{ fmtMoney(line.unit_price) }}</td>
            <td class="tr">
              <p-inputNumber
                [ngModel]="line.quantity"
                (ngModelChange)="updateQty(line, $event)"
                [min]="1"
                [showButtons]="true"
                buttonLayout="horizontal"
                [inputStyle]="{ width: '60px', textAlign: 'right' }"
              ></p-inputNumber>
            </td>
            <td class="tr money">{{ fmtMoney(line.line_subtotal) }}</td>
            <td class="tr">{{ fmtMoney(line.line_tax) }}</td>
            <td class="tr money">{{ fmtMoney(line.line_total) }}</td>
            <td>
              <button
                pButton
                icon="pi pi-trash"
                severity="danger"
                text
                size="small"
                (click)="removeLine(line.id)"
              ></button>
            </td>
          </tr>
        </ng-template>
      </p-table>

      <div class="cart-footer">
        <div class="totals">
          <div class="row"><span>Subtotal</span><b>{{ fmtMoney(c.subtotal) }}</b></div>
          <div class="row"><span>IVA</span><b>{{ fmtMoney(c.tax_total) }}</b></div>
          <div class="row total"><span>Total</span><b>{{ fmtMoney(c.total) }}</b></div>
        </div>
        <div class="actions">
          <button
            pButton
            label="Vaciar carrito"
            severity="secondary"
            outlined
            icon="pi pi-times"
            (click)="cancelDraft()"
            [disabled]="confirming()"
          ></button>
          <button
            pButton
            label="Confirmar pedido"
            icon="pi pi-check"
            (click)="confirm()"
            [disabled]="confirming() || (c.lines || []).length === 0"
          ></button>
        </div>
      </div>
    </ng-container>
  `,
  styles: [
    `
      .page-title {
        margin: 0 0 1rem;
      }
      .empty {
        text-align: center;
        padding: 2rem;
      }
      .empty i {
        font-size: 3rem;
        color: var(--text-color-secondary);
        margin-bottom: 1rem;
        display: block;
      }
      .empty p {
        color: var(--text-color-secondary);
        margin: 0 0 1rem;
      }
      .cart-header {
        display: flex;
        justify-content: space-between;
        margin-bottom: 1rem;
        font-size: 0.875rem;
      }
      .code {
        font-weight: 700;
      }
      .created {
        color: var(--text-color-secondary);
      }
      .tr {
        text-align: right;
      }
      .money {
        font-variant-numeric: tabular-nums;
      }
      .cart-footer {
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
        margin-top: 1.5rem;
        flex-wrap: wrap;
        gap: 1rem;
      }
      .totals {
        min-width: 220px;
      }
      .totals .row {
        display: flex;
        justify-content: space-between;
        padding: 0.25rem 0;
      }
      .totals .total {
        border-top: 2px solid var(--primary-color);
        padding-top: 0.5rem;
        margin-top: 0.5rem;
        font-size: 1.125rem;
      }
      .actions {
        display: flex;
        gap: 0.5rem;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PortalCartComponent implements OnInit {
  private readonly api = inject(PortalService);
  private readonly toast = inject(MessageService);
  private readonly confirmSvc = inject(ConfirmationService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly cart = signal<Order | null>(null);
  readonly confirming = signal(false);

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
          // Fetch detalle con lines
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
    const c = this.cart();
    if (!c) return;
    this.api.updateLine(c.id, line.id, qty).subscribe({
      next: () => this.reload(),
      error: (err) =>
        this.toast.add({ severity: 'error', summary: 'Error', detail: err.error?.message || err.message }),
    });
  }

  removeLine(lineId: string): void {
    const c = this.cart();
    if (!c) return;
    this.api.removeLine(c.id, lineId).subscribe({
      next: () => this.reload(),
      error: (err) =>
        this.toast.add({ severity: 'error', summary: 'Error', detail: err.error?.message || err.message }),
    });
  }

  confirm(): void {
    const c = this.cart();
    if (!c) return;
    this.confirmSvc.confirm({
      message: `¿Confirmar pedido por ${this.fmtMoney(c.total)}? El stock se reservará.`,
      header: 'Confirmar pedido',
      icon: 'pi pi-exclamation-triangle',
      accept: () => {
        this.confirming.set(true);
        this.api.confirm(c.id).subscribe({
          next: (confirmed) => {
            this.confirming.set(false);
            this.toast.add({
              severity: 'success',
              summary: 'Pedido confirmado',
              detail: confirmed.code,
            });
            this.router.navigate(['/portal/orders', confirmed.id]);
          },
          error: (err) => {
            this.confirming.set(false);
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

  fmtMoney(n: any): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);
  }
  fmtDate(s: string): string {
    return new Date(s).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
  }
}
