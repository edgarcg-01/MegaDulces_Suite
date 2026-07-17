import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { ComprasService, RequisitionDetail, RequisitionEstado } from '../compras.service';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/** Fase RA (ADR-030) — detalle de requisición + aprobar/rechazar (HITL). */
@Component({
  selector: 'app-compras-requisicion-detalle',
  standalone: true,
  imports: [CommonModule, ButtonModule, TableModule, TagModule, ToastModule, MetricStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in rd-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <button pButton type="button" icon="pi pi-arrow-left" label="Requisiciones" class="p-button-text p-button-sm rd-back" (click)="back()"></button>
          @if (req(); as r) {
            <h1>{{ r.folio }} <p-tag [value]="estadoLabel(r.estado)" [severity]="estadoSev(r.estado)"></p-tag></h1>
            <p class="surf-page-sub">{{ r.warehouse_code }} · {{ r.warehouse_name }} · {{ r.total_lines }} líneas · objetivo {{ basisLabel(r.target_basis) }}</p>
          }
        </div>
        @if (req(); as r) {
          @if (canManage) {
            <div class="rd-actions">
              @if (r.estado === 'pending_approval') {
                <button pButton type="button" label="Rechazar" icon="pi pi-times" class="p-button-sm p-button-outlined p-button-danger" [loading]="busy()" (click)="reject()"></button>
                <button pButton type="button" label="Aprobar" icon="pi pi-check" class="p-button-sm" [loading]="busy()" (click)="approve()"></button>
              } @else if (r.estado === 'approved') {
                <button pButton type="button" label="Generar orden de compra" icon="pi pi-shopping-cart" class="p-button-sm" [loading]="busy()" (click)="generatePO()"></button>
              } @else if (r.estado === 'ordered' || r.estado === 'received') {
                <button pButton type="button" label="Ver orden de compra" icon="pi pi-arrow-right" class="p-button-sm p-button-outlined" (click)="goToPO()"></button>
              }
            </div>
          }
        }
      </header>

      @if (req(); as r) {
        <app-metric-strip [items]="kpiItems(r)" ariaLabel="Resumen de la requisición" />

        <p-table [value]="r.lines" styleClass="p-datatable-sm rd-table">
          <ng-template pTemplate="header">
            <tr>
              <th>SKU</th><th>Producto</th><th>Origen</th>
              <th class="rd-r">Existencia</th><th class="rd-r">Reorden</th><th class="rd-r">Sugerido</th>
              <th class="rd-r">Pedir</th>
              @if (showRecibido()) { <th class="rd-r">Recibido</th> }
              <th class="rd-r">Costo unit.</th><th class="rd-r">Importe</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-l>
            <tr>
              <td class="rd-mono">{{ l.sku }}</td>
              <td>{{ l.nombre }}</td>
              <td class="rd-muted">
                @if (l.source_type === 'branch') { <span class="rd-src-branch">Traspaso</span> }
                @else { {{ l.supplier_name || 'Proveedor' }} }
              </td>
              <td class="rd-r rd-muted">{{ l.on_hand | number:'1.0-0' }}</td>
              <td class="rd-r rd-muted">{{ l.reorder_point | number:'1.0-0' }}</td>
              <td class="rd-r rd-muted">{{ l.suggested_qty | number:'1.0-0' }}</td>
              <td class="rd-r rd-strong">{{ l.final_qty | number:'1.0-0' }}</td>
              @if (showRecibido()) {
                <td class="rd-r">{{ l.received_qty != null ? (l.received_qty | number:'1.0-0') : '—' }}
                  @if (l.received_qty != null && l.final_qty > 0) { <span class="rd-fill">{{ (l.received_qty / l.final_qty) | percent:'1.0-0' }}</span> }
                </td>
              }
              <td class="rd-r">{{ money(l.unit_cost) }}</td>
              <td class="rd-r">{{ money(l.line_cost) }}</td>
            </tr>
          </ng-template>
        </p-table>
      } @else if (!loading()) {
        <p class="rd-empty">Requisición no encontrada.</p>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rd-back { margin-bottom: .25rem; margin-left: -.5rem; }
    .surf-page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
    .rd-actions { display: flex; gap: .5rem; }
    app-metric-strip { display:block; margin: 1rem 0; }
    .rd-table { font-size: .84rem; }
    .rd-r { text-align: right; font-variant-numeric: tabular-nums; }
    .rd-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .8rem; }
    .rd-muted { color: var(--text-muted); } .rd-strong { font-weight: 700; }
    .rd-src-branch { color: var(--action); font-weight: 600; }
    .rd-fill { margin-left: .35rem; font-size: .72rem; color: var(--text-muted); }
    .rd-empty { color: var(--text-muted); padding: 2rem; text-align: center; }
  `],
})
export class ComprasRequisicionDetalleComponent implements OnInit {
  private readonly api = inject(ComprasService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly perms = inject(PermissionsService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  req = signal<RequisitionDetail | null>(null);

  kpiItems(r: RequisitionDetail): MetricStripItem[] {
    const fmtDate = (d: any) => d ? new Date(d).toLocaleString('es-MX', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
    const items: MetricStripItem[] = [
      { label: 'Unidades', value: r.total_units },
      { label: 'Costo estimado', value: r.total_cost, format: 'currency', tone: 'brand' },
      { label: 'Creada', value: fmtDate(r.created_at), format: 'text' },
    ];
    if (r.notes) items.push({ label: 'Nota', value: r.notes, format: 'text' });
    return items;
  }
  loading = signal(true);
  busy = signal(false);
  canManage = this.perms.can('manage', 'all') || !!this.auth.user()?.permissions?.[Permission.COMPRAS_GESTIONAR];
  private id = '';

  ngOnInit(): void {
    this.id = this.route.snapshot.paramMap.get('id') || '';
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.api.getRequisition(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.req.set(r); this.loading.set(false); },
      error: () => { this.loading.set(false); this.req.set(null); },
    });
  }

  approve(): void {
    this.busy.set(true);
    this.api.approve(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.busy.set(false); this.toast.add({ severity: 'success', summary: 'Aprobada' }); this.load(); },
      error: () => { this.busy.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo aprobar.' }); },
    });
  }
  reject(): void {
    this.busy.set(true);
    this.api.reject(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.busy.set(false); this.toast.add({ severity: 'info', summary: 'Rechazada' }); this.load(); },
      error: () => { this.busy.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo rechazar.' }); },
    });
  }
  /** RA.15 — genera la OC desde la requisición aprobada y navega a ella. */
  generatePO(): void {
    this.busy.set(true);
    this.api.createPOFromRequisition(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.busy.set(false); this.toast.add({ severity: 'success', summary: 'Orden de compra generada', detail: r.folio }); this.router.navigate(['/compras/ordenes', r.id]); },
      error: (e) => { this.busy.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo generar la OC.' }); },
    });
  }
  /** Navega a la OC ya generada desde esta requisición. */
  goToPO(): void {
    const poId = this.req()?.purchase_order_id;
    if (poId) this.router.navigate(['/compras/ordenes', poId]);
    else this.router.navigate(['/compras/ordenes']);
  }

  /** Muestra la columna Recibido cuando la requisición ya está en recepción o recibida. */
  showRecibido(): boolean { const e = this.req()?.estado; return e === 'ordered' || e === 'received'; }

  back(): void { this.router.navigate(['/compras/requisiciones']); }
  money(v: number | string | null | undefined) { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  basisLabel(b: string) { return ({ min: 'mínimo', reorder: 'reorden', max: 'máximo' } as Record<string, string>)[b] || b; }
  estadoLabel(e: RequisitionEstado) { return ({ draft: 'Borrador', pending_approval: 'Pendiente', approved: 'Aprobada', ordered: 'Ordenada', received: 'Recibida', cancelled: 'Cancelada' } as Record<RequisitionEstado, string>)[e]; }
  estadoSev(e: RequisitionEstado): Sev { return ({ draft: 'secondary', pending_approval: 'warn', approved: 'success', ordered: 'info', received: 'success', cancelled: 'danger' } as Record<RequisitionEstado, Sev>)[e]; }
}
