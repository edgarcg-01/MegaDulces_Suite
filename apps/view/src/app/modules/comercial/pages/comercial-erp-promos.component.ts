import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ComercialService, ErpPromoRow } from '../comercial.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { PROMOS_TABS } from '../promos-tabs';

/** KV.6 — Promos vigentes del ERP Kepler (descuento/gratis por cantidad o monto). */
@Component({
  selector: 'app-comercial-erp-promos',
  standalone: true,
  imports: [CommonModule, ButtonModule, TableModule, TagModule, ToastModule, PageTabsComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="promoTabs" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Promos del ERP</h1>
          <p class="surf-page-sub">Reglas de promoción vigentes en Kepler</p>
        </div>
        <button pButton icon="pi pi-refresh" [text]="true" severity="secondary" size="small" (click)="load()" [loading]="loading()"></button>
      </header>

      <p-table [value]="rows()" [loading]="loading()" styleClass="p-datatable-sm surf-table"
               [scrollable]="true" scrollHeight="flex" [paginator]="true" [rows]="50">
        <ng-template pTemplate="header">
          <tr>
            <th scope="col">SKU</th><th scope="col">Producto</th><th scope="col">Tipo</th>
            <th scope="col" class="ep-num">Umbral</th><th scope="col">Beneficio</th>
            <th scope="col">Vigencia</th><th scope="col">Almacén</th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-p>
          <tr>
            <td class="ep-mono">{{ p.sku }}</td>
            <td class="ep-name">{{ p.product_name }}</td>
            <td><p-tag [value]="typeLabel(p.promo_type)" [severity]="p.promo_type.startsWith('gratis') ? 'success' : 'info'"></p-tag></td>
            <td class="ep-num">{{ p.threshold | number:'1.0-0' }}{{ p.promo_type.endsWith('monto') ? ' $' : ' u' }}</td>
            <td>{{ benefitLabel(p) }}</td>
            <td>{{ (p.valid_from | date:'dd/MM/yy') }} → {{ (p.valid_to | date:'dd/MM/yy') }}</td>
            <td class="ep-mono">{{ p.warehouse_code || '—' }}</td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="7" class="comm-empty-cell">
            <div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-percentage" aria-hidden="true"></i></div>
              <h3>Sin promos vigentes</h3><p>No hay promociones activas en el ERP.</p></div>
          </td></tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [`
    .ep-mono { font-family: var(--font-mono,monospace); }
    .ep-name { max-width: 320px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ep-num { text-align: right; font-variant-numeric: tabular-nums; }
  `],
})
export class ComercialErpPromosComponent {
  readonly promoTabs = PROMOS_TABS;
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  rows = signal<ErpPromoRow[]>([]);
  loading = signal(false);

  constructor() { this.load(); }

  typeLabel(t: string): string {
    return ({
      descuento_qty: 'Descuento x cantidad',
      gratis_qty: 'Gratis x cantidad',
      descuento_monto: 'Descuento x monto',
      gratis_monto: 'Gratis x monto',
    } as Record<string, string>)[t] || t;
  }

  benefitLabel(p: ErpPromoRow): string {
    if (p.promo_type.startsWith('gratis')) {
      return `${p.benefit ?? 0} × ${p.free_product_name || 'producto'}`;
    }
    return `$${p.benefit ?? 0} desc.`;
  }

  load() {
    this.loading.set(true);
    this.svc.erpPromotions()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.rows.set(r); this.loading.set(false); },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error al cargar promos' }); },
      });
  }
}
