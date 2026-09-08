import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ComercialService, ExpiryReview } from '../comercial.service';

/**
 * P2.6 — Control de Caducidades: lista de hojas de inspección de anaquel.
 * Reemplaza la hoja de papel "CONTROL DE CADUCIDADES". Al enviar una hoja,
 * los renglones con producto + caducidad alimentan FEFO (pestaña "Por vencer").
 *
 * **2026-09-08 — se quitó el alta de hoja desde acá** (botón "Nueva hoja" +
 * diálogo almacén/fecha/ubicación-por-defecto): el arranque de una hoja se
 * rehace con otro flujo. Esta pantalla queda de solo lectura — lista y
 * navegación al detalle. El endpoint `POST /commercial/expiry-reviews` y
 * `ComercialService.createExpiryReview()` siguen existiendo, sin consumidor
 * en la UI hasta que aterrice el flujo nuevo.
 */
@Component({
  selector: 'app-comercial-expiry-reviews',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule, ToastModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Control de Caducidades</h1>
          <p class="surf-page-sub">Inspección de anaquel — captura de productos por vencer/vencidos + estado + acción</p>
        </div>
        <div class="er-head-actions">
          <p-select [options]="statusOptions" [(ngModel)]="statusFilter" optionLabel="label" optionValue="value"
            (onChange)="load()" styleClass="er-status"></p-select>
        </div>
      </header>

      <p-table [value]="reviews()" [loading]="loading()" styleClass="p-datatable-sm surf-table surf-table--zebra"
        [scrollable]="true" scrollHeight="flex" [paginator]="true" [rows]="25" [rowsPerPageOptions]="[25, 50, 100]">
        <ng-template #header>
          <tr>
            <th scope="col">Fecha</th><th scope="col">Almacén</th><th scope="col">Responsable</th>
            <th scope="col" class="num">Renglones</th><th scope="col">Estado</th><th scope="col"></th>
          </tr>
        </ng-template>
        <ng-template #body let-r>
          <tr class="er-row" (click)="open(r)">
            <td>{{ fmtDate(r.review_date) }}</td>
            <td class="er-mono">{{ r.warehouse_code }} · {{ r.warehouse_name }}</td>
            <td>{{ r.responsible_name || '—' }}</td>
            <td class="num">{{ r.line_count }}</td>
            <td><p-tag [value]="r.status === 'submitted' ? 'Enviada' : 'Borrador'" [severity]="r.status === 'submitted' ? 'success' : 'warn'"></p-tag></td>
            <td class="num"><i class="pi pi-chevron-right er-chev" aria-hidden="true"></i></td>
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="6" class="comm-empty-cell"><div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-clipboard" aria-hidden="true"></i></div><h3>Sin hojas de caducidades</h3><p>No hay hojas que coincidan con el filtro.</p></div></td></tr>
        </ng-template>
      </p-table>
    </div>
    `,
  styles: [`
    .er-head-actions { display: flex; gap: .5rem; align-items: center; }
    :host ::ng-deep .er-status { min-width: 160px; }
    .er-mono { font-family: var(--font-mono, monospace); font-size: var(--fs-sm, .85rem); }
    .er-row { cursor: pointer; }
    .er-chev { color: var(--text-muted); }
  `],
})
export class ComercialExpiryReviewsComponent {
  readonly statusOptions = [
    { label: 'Todas', value: '' },
    { label: 'Borrador', value: 'draft' },
    { label: 'Enviadas', value: 'submitted' },
  ];

  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  // WMS.1 — se fue `showInvTabs`: la barra de tabs ya no la pinta esta página.
  // La monta `AlmacenAreaShellComponent`, que solo envuelve `/almacen/*`, así
  // que la condición "solo bajo /almacen (no en /tienda)" ahora la resuelve el
  // árbol de rutas y no un check de URL acá.

  reviews = signal<ExpiryReview[]>([]);
  loading = signal(false);
  statusFilter = '';

  constructor() {
    this.load();
  }

  load() {
    this.loading.set(true);
    this.svc.listExpiryReviews({ status: this.statusFilter || undefined, pageSize: 100 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.reviews.set(r.data || []); this.loading.set(false); },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error al cargar hojas' }); },
      });
  }

  /** `date` de Postgres llega como ISO completo: se muestra el tramo YYYY-MM-DD, sin new Date(). */
  fmtDate(v: string | null | undefined): string {
    const ymd = String(v || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '—';
    const p = ymd.split('-');
    return p[2] + '/' + p[1] + '/' + p[0];
  }

  open(r: ExpiryReview) { this.router.navigate([r.id], { relativeTo: this.route }); }
}
