import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { MultitareaService } from '../../../core/services/multitarea.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { TabsModule } from 'primeng/tabs';
import { ComprasService, RequisitionRow, RequisitionEstado } from '../compras.service';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/** Fase RA (ADR-030) — bandeja de requisiciones de compra y traspasos entre sucursales. */
@Component({
  selector: 'app-compras-requisiciones',
  standalone: true,
  imports: [RouterLink, CommonModule, FormsModule, ButtonModule, TableModule, SelectModule, TagModule, TabsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in rq-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Requisiciones y Traspasos</h1>
          <p class="surf-page-sub">Gestión de abastecimiento interno entre sucursales y compras a proveedores.</p>
        </div>
      </header>

      <p-tabs [value]="tab()" (valueChange)="onTabChange($any($event))" styleClass="rq-tabs">
        <p-tablist>
          <p-tab value="supplier">
            <span class="rq-tab-title"><i class="pi pi-truck" aria-hidden="true"></i> Requerimientos a Proveedor</span>
          </p-tab>
          <p-tab value="branch">
            <span class="rq-tab-title"><i class="pi pi-arrow-right-arrow-left" aria-hidden="true"></i> Traspaso entre Sucursales</span>
          </p-tab>
        </p-tablist>

        <p-tabpanels>
          <!-- ── Pestaña 1: Requerimientos a Proveedor ── -->
          <p-tabpanel value="supplier">
            <div class="rq-filters">
              <p-select [options]="estadoOpts" [(ngModel)]="fEstado" (onChange)="reload()"
                        optionLabel="label" optionValue="value" placeholder="Todos los estados" [showClear]="true" styleClass="rq-sel" appendTo="body"></p-select>
            </div>

            <p-table [value]="rows()" [loading]="loading()" styleClass="p-datatable-sm rq-table"
                     [paginator]="true" [rows]="50" [totalRecords]="total()" [lazy]="true" (onLazyLoad)="onPage($event)">
              <ng-template #header>
                <tr>
                  <th>Folio</th><th>Almacén</th><th>Proveedor</th>
                  <th class="rq-r">Líneas</th><th class="rq-r">Unidades</th><th class="rq-r">Costo</th>
                  <th>Estado</th><th>Fecha</th><th><span class="sr-only">Acciones</span></th>
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr class="rq-row" (click)="open(r)">
                  <td class="rq-mono"><a class="surf-cell-link" [routerLink]="multitarea.enlaceDetalle(['/compras/requisiciones', r.id])" [target]="multitarea.target()" (click)="$event.stopPropagation()">{{ r.folio }}</a></td>
                  <td>{{ r.warehouse_code || '—' }}</td>
                  <td class="rq-muted">{{ r.supplier_name || 'Varios' }}</td>
                  <td class="rq-r">{{ r.total_lines | number }}</td>
                  <td class="rq-r">{{ r.total_units | number:'1.0-0' }}</td>
                  <td class="rq-r">{{ money(r.total_cost) }}</td>
                  <td><p-tag [value]="estadoLabel(r.estado)" [severity]="estadoSev(r.estado)"></p-tag></td>
                  <td class="rq-muted">{{ r.created_at | date:'dd/MM/yy HH:mm' }}</td>
                  <td><i class="pi pi-angle-right rq-muted"></i></td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="9" class="rq-empty">
                  @if (error()) {
                    <i class="pi pi-exclamation-triangle"></i> No se pudieron cargar las requisiciones.
                    <button pButton type="button" class="p-button-text p-button-sm" (click)="reload()"><span class="p-button-label">Reintentar</span></button>
                  } @else { Sin requerimientos a proveedor todavía. Genera uno desde Existencia crítica. }
                </td></tr>
              </ng-template>
            </p-table>
          </p-tabpanel>

          <!-- ── Pestaña 2: Traspaso entre Sucursales ── -->
          <p-tabpanel value="branch">
            <div class="rq-filters">
              <p-select [options]="estadoOpts" [(ngModel)]="fEstado" (onChange)="reload()"
                        optionLabel="label" optionValue="value" placeholder="Todos los estados" [showClear]="true" styleClass="rq-sel" appendTo="body"></p-select>
            </div>

            <p-table [value]="rows()" [loading]="loading()" styleClass="p-datatable-sm rq-table"
                     [paginator]="true" [rows]="50" [totalRecords]="total()" [lazy]="true" (onLazyLoad)="onPage($event)">
              <ng-template #header>
                <tr>
                  <th>Folio</th><th>Origen</th><th>Destino</th>
                  <th class="rq-r">Líneas</th><th class="rq-r">Unidades</th><th class="rq-r">Costo est.</th>
                  <th>Estado</th><th>Fecha</th><th><span class="sr-only">Acciones</span></th>
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr class="rq-row" (click)="open(r)">
                  <td class="rq-mono"><a class="surf-cell-link" [routerLink]="multitarea.enlaceDetalle(['/compras/requisiciones', r.id])" [target]="multitarea.target()" (click)="$event.stopPropagation()">{{ r.folio }}</a></td>
                  <td>
                    <span class="rq-wh-cell"><i class="pi pi-building rq-origin-icon" aria-hidden="true"></i> {{ r.source_warehouse_code || 'CEDIS' }}</span>
                  </td>
                  <td>
                    <span class="rq-wh-cell"><i class="pi pi-map-marker rq-dest-icon" aria-hidden="true"></i> {{ r.warehouse_code || '—' }}</span>
                  </td>
                  <td class="rq-r">{{ r.total_lines | number }}</td>
                  <td class="rq-r">{{ r.total_units | number:'1.0-0' }}</td>
                  <td class="rq-r">{{ money(r.total_cost) }}</td>
                  <td><p-tag [value]="estadoLabel(r.estado)" [severity]="estadoSev(r.estado)"></p-tag></td>
                  <td class="rq-muted">{{ r.created_at | date:'dd/MM/yy HH:mm' }}</td>
                  <td><i class="pi pi-angle-right rq-muted"></i></td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="9" class="rq-empty">
                  @if (error()) {
                    <i class="pi pi-exclamation-triangle"></i> No se pudieron cargar los traspasos.
                    <button pButton type="button" class="p-button-text p-button-sm" (click)="reload()"><span class="p-button-label">Reintentar</span></button>
                  } @else { Sin traspasos entre sucursales todavía. Genera uno desde Existencia crítica. }
                </td></tr>
              </ng-template>
            </p-table>
          </p-tabpanel>
        </p-tabpanels>
      </p-tabs>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rq-tab-title { display: inline-flex; align-items: center; gap: .5rem; font-weight: 600; }
    .rq-filters { margin-bottom: .75rem; } .rq-sel { min-width: 14rem; }
    .rq-table { font-size: .84rem; }
    .rq-row { cursor: pointer; } .rq-row:hover { background: var(--surface-hover-bg); }
    .rq-r { text-align: right; font-variant-numeric: tabular-nums; }
    .rq-mono { font-family: var(--font-mono, ui-monospace, monospace); font-weight: 600; }
    .rq-muted { color: var(--text-muted); }
    .rq-empty { color: var(--text-muted); padding: 1.5rem; text-align: center; }
    .rq-wh-cell { display: inline-flex; align-items: center; gap: .35rem; }
    .rq-origin-icon { color: var(--primary, #0284c7); font-size: .85rem; }
    .rq-dest-icon { color: var(--text-color, #1f2937); font-size: .85rem; }
  `],
})
export class ComprasRequisicionesComponent implements OnInit {
  /** `[MT.3]` Con la preferencia prendida, el detalle abre en otra ventana. */
  readonly multitarea = inject(MultitareaService);
  private readonly api = inject(ComprasService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  tab = signal<'supplier' | 'branch'>('supplier');
  rows = signal<RequisitionRow[]>([]);
  total = signal(0);
  loading = signal(false);
  error = signal(false); // §6: falla de carga ≠ "sin requisiciones"
  page = signal(1);
  fEstado = '';

  estadoOpts = [
    { label: 'Pendiente de aprobar', value: 'pending_approval' },
    { label: 'Aprobada', value: 'approved' },
    { label: 'Ordenada', value: 'ordered' },
    { label: 'Recibida', value: 'received' },
    { label: 'Cancelada', value: 'cancelled' },
  ];

  ngOnInit(): void {
    const qTab = this.route.snapshot.queryParamMap.get('tab') || this.route.snapshot.queryParamMap.get('tipo');
    if (qTab === 'branch' || qTab === 'traspaso' || qTab === 'traspasos') {
      this.tab.set('branch');
    }
    this.reload();
  }

  onTabChange(newTab: 'supplier' | 'branch'): void {
    if (this.tab() === newTab) return;
    this.tab.set(newTab);
    this.router.navigate([], { relativeTo: this.route, queryParams: { tab: newTab }, queryParamsHandling: 'merge' });
    this.reload();
  }

  reload(): void { this.page.set(1); this.load(); }

  private load(): void {
    this.loading.set(true);
    this.api.listRequisitions({
      estado: this.fEstado || undefined,
      source_type: this.tab(),
      page: this.page(),
      pageSize: 50,
    })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { this.rows.set(r.rows); this.total.set(r.total); this.loading.set(false); this.error.set(false); },
        error: () => { this.loading.set(false); this.error.set(true); },
      });
  }

  onPage(e: TableLazyLoadEvent): void {
    this.page.set(Math.floor((e.first || 0) / (e.rows || 50)) + 1);
    this.load();
  }

  open(r: RequisitionRow): void { this.router.navigate(['/compras/requisiciones', r.id]); }

  money(v: number | string | null | undefined) { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  estadoLabel(e: RequisitionEstado) { return ({ draft: 'Borrador', pending_approval: 'Pendiente', approved: 'Aprobada', ordered: 'Ordenada', received: 'Recibida', cancelled: 'Cancelada' } as Record<RequisitionEstado, string>)[e]; }
  estadoSev(e: RequisitionEstado): Sev { return ({ draft: 'secondary', pending_approval: 'warn', approved: 'success', ordered: 'info', received: 'success', cancelled: 'danger' } as Record<RequisitionEstado, Sev>)[e]; }
}
