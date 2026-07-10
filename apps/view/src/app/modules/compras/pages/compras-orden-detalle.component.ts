import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { ComprasService, PurchaseOrderDetail, PurchaseOrderLine, PurchaseOrderEstado, CreateReceiptLine } from '../compras.service';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/** Línea editable del diálogo de recepción (OE). */
interface RecvLine {
  po_line_id: string;
  sku: string;
  nombre: string;
  ordered_qty: number;
  already: number;
  pending: number;
  received_qty: number; // a recibir ahora
  unit_cost: number;
}

/**
 * RA.15 (ADR-031) — Detalle de OC + recepción (OE). El detalle muestra pedido vs
 * recibido por línea; "Registrar recepción" abre el diálogo que captura lo que llegó
 * (permite parciales) y al confirmar MUEVE stock (movimiento 'in'; Kepler reconcilia).
 */
@Component({
  selector: 'app-compras-orden-detalle',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, ButtonModule, TableModule, TagModule, DialogModule, InputTextModule, ToastModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in od-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <button pButton type="button" icon="pi pi-arrow-left" label="Órdenes de compra" class="p-button-text p-button-sm od-back" (click)="back()"></button>
          @if (po(); as p) {
            <h1>{{ p.folio }} <p-tag [value]="estadoLabel(p.estado)" [severity]="estadoSev(p.estado)"></p-tag></h1>
            <p class="surf-page-sub">
              {{ p.source_type === 'branch' ? 'Traspaso desde ' + (p.source_code || '—') : (p.supplier_name || 'Proveedor') }}
              · destino {{ p.warehouse_code }}
              @if (p.requisition_folio) { · req <a class="od-link" [routerLink]="['/compras/requisiciones', p.requisition_id]">{{ p.requisition_folio }}</a> }
              @if (p.expected_date) { · esperada {{ p.expected_date | date:'dd/MM/yy' }} }
            </p>
          }
        </div>
        @if (po(); as p) {
          @if (canManage) {
            <div class="od-actions">
              @if (p.estado === 'open' || p.estado === 'partial') {
                <button pButton type="button" label="Registrar recepción" icon="pi pi-inbox" class="p-button-sm" (click)="openReceive()"></button>
              }
              @if (p.estado === 'open' && p.received_units === 0) {
                <button pButton type="button" label="Cancelar OC" icon="pi pi-times" class="p-button-sm p-button-outlined p-button-danger" [loading]="busy()" (click)="cancel()"></button>
              }
            </div>
          }
        }
      </header>

      @if (po(); as p) {
        <div class="od-kpis">
          <div class="od-kpi"><span class="od-kpi-val">{{ p.total_units | number:'1.0-0' }}</span><span class="od-kpi-lbl">Pedido</span></div>
          <div class="od-kpi"><span class="od-kpi-val">{{ p.received_units | number:'1.0-0' }}</span><span class="od-kpi-lbl">Recibido</span></div>
          <div class="od-kpi"><span class="od-kpi-val">{{ fill(p) | percent:'1.0-0' }}</span><span class="od-kpi-lbl">Avance (fill rate)</span></div>
          <div class="od-kpi"><span class="od-kpi-val">{{ money(p.total_cost) }}</span><span class="od-kpi-lbl">Costo pactado</span></div>
        </div>

        <h2 class="od-h2">Líneas</h2>
        <p-table [value]="p.lines" styleClass="p-datatable-sm od-table">
          <ng-template pTemplate="header">
            <tr><th>SKU</th><th>Producto</th><th class="od-r">Pedido</th><th class="od-r">Recibido</th><th class="od-r">Pendiente</th><th class="od-r">Costo unit.</th><th class="od-r">Importe</th></tr>
          </ng-template>
          <ng-template pTemplate="body" let-l>
            <tr>
              <td class="od-mono">{{ l.sku }}</td>
              <td>{{ l.nombre }}</td>
              <td class="od-r">{{ l.ordered_qty | number:'1.0-0' }}</td>
              <td class="od-r">{{ l.received_qty | number:'1.0-0' }}</td>
              <td class="od-r" [class.od-pending]="(l.ordered_qty - l.received_qty) > 0">{{ (l.ordered_qty - l.received_qty) | number:'1.0-0' }}</td>
              <td class="od-r od-muted">{{ money(l.unit_cost) }}</td>
              <td class="od-r">{{ money(l.line_cost) }}</td>
            </tr>
          </ng-template>
        </p-table>

        @if (p.receipts.length) {
          <h2 class="od-h2">Recepciones (órdenes de entrada)</h2>
          <p-table [value]="p.receipts" styleClass="p-datatable-sm od-table">
            <ng-template pTemplate="header">
              <tr><th>Folio OE</th><th>Fecha</th><th class="od-r">Unidades</th><th class="od-r">Costo</th><th>Stock</th><th>Nota</th></tr>
            </ng-template>
            <ng-template pTemplate="body" let-g>
              <tr>
                <td class="od-mono">{{ g.folio }}</td>
                <td class="od-muted">{{ g.received_at | date:'dd/MM/yy HH:mm' }}</td>
                <td class="od-r">{{ g.total_units | number:'1.0-0' }}</td>
                <td class="od-r">{{ money(g.total_cost) }}</td>
                <td>@if (g.stock_applied) { <span class="od-applied"><i class="pi pi-check"></i> aplicado</span> } @else { <span class="od-muted">—</span> }</td>
                <td class="od-muted">{{ g.notes || '—' }}</td>
              </tr>
            </ng-template>
          </p-table>
        }
      } @else if (!loading()) {
        <p class="od-empty">Orden de compra no encontrada.</p>
      }
    </div>

    <!-- Diálogo recepción (OE) -->
    <p-dialog [visible]="recvOpen()" (visibleChange)="recvOpen.set($event)" [modal]="true" appendTo="body" [style]="{ width: '48rem', maxWidth: '96vw' }" header="Registrar recepción" [dismissableMask]="true">
      <div class="od-dlg">
        <p class="od-dlg-sub">Captura lo que llegó de verdad (default = pendiente). Al confirmar suma a existencia del almacén destino.</p>
        <div class="od-dlg-lines">
          @for (l of recvLines(); track l.po_line_id) {
            <div class="od-dlg-line" [class.od-dlg-done]="l.pending <= 0">
              <span class="od-dlg-name"><span class="od-mono">{{ l.sku }}</span> {{ l.nombre }}
                <span class="od-muted">· pend. {{ l.pending | number:'1.0-0' }}</span></span>
              <input pInputText type="number" min="0" [(ngModel)]="l.received_qty" class="od-dlg-qty" title="Cantidad recibida" />
              <input pInputText type="number" min="0" step="0.01" [(ngModel)]="l.unit_cost" class="od-dlg-cost" title="Costo unitario real" />
            </div>
          }
        </div>
        <input pInputText type="text" [(ngModel)]="recvNotes" placeholder="Nota / referencia de la entrada (opcional)" class="od-dlg-notes" />
      </div>
      <ng-template pTemplate="footer">
        <button pButton type="button" label="Cancelar" class="p-button-text p-button-sm" (click)="recvOpen.set(false)"></button>
        <button pButton type="button" label="Confirmar recepción" icon="pi pi-check" class="p-button-sm" [loading]="saving()" (click)="confirmReceive()"></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    .od-back { margin-bottom: .25rem; margin-left: -.5rem; }
    .surf-page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
    .od-actions { display: flex; gap: .5rem; }
    .od-link { color: var(--action); text-decoration: none; } .od-link:hover { text-decoration: underline; }
    .od-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .5rem; margin: 1rem 0; }
    .od-kpi { display: flex; flex-direction: column; gap: .15rem; padding: .7rem .9rem; border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); }
    .od-kpi-val { font-size: 1.2rem; font-weight: 700; line-height: 1.1; }
    .od-kpi-lbl { font-size: .72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
    .od-h2 { font-size: .95rem; font-weight: 700; margin: 1.25rem 0 .5rem; }
    .od-table { font-size: .84rem; }
    .od-r { text-align: right; font-variant-numeric: tabular-nums; }
    .od-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .8rem; }
    .od-muted { color: var(--text-muted); }
    .od-pending { color: var(--warn-fg); font-weight: 600; }
    .od-applied { color: var(--good-fg, var(--action)); font-size: .78rem; }
    .od-empty { color: var(--text-muted); padding: 2rem; text-align: center; }
    .od-dlg-sub { color: var(--text-muted); font-size: .85rem; margin-bottom: .6rem; }
    .od-dlg-lines { max-height: 26rem; overflow-y: auto; display: flex; flex-direction: column; gap: .35rem; }
    .od-dlg-line { display: flex; gap: .5rem; align-items: center; }
    .od-dlg-done { opacity: .55; }
    .od-dlg-name { font-size: .82rem; flex: 1; min-width: 0; }
    .od-dlg-qty { width: 5.5rem; text-align: right; }
    .od-dlg-cost { width: 6rem; text-align: right; }
    .od-dlg-notes { width: 100%; margin-top: .6rem; }
  `],
})
export class ComprasOrdenDetalleComponent implements OnInit {
  private readonly api = inject(ComprasService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly perms = inject(PermissionsService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  po = signal<PurchaseOrderDetail | null>(null);
  loading = signal(true);
  busy = signal(false);
  saving = signal(false);
  recvOpen = signal(false);
  recvLines = signal<RecvLine[]>([]);
  recvNotes = '';
  canManage = this.perms.can('manage', 'all') || !!this.auth.user()?.permissions?.[Permission.COMPRAS_GESTIONAR];
  private id = '';

  ngOnInit(): void { this.id = this.route.snapshot.paramMap.get('id') || ''; this.load(); }

  private load(): void {
    this.loading.set(true);
    this.api.getPurchaseOrder(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => { this.po.set(p); this.loading.set(false); },
      error: () => { this.loading.set(false); this.po.set(null); },
    });
  }

  openReceive(): void {
    const p = this.po();
    if (!p) return;
    this.recvLines.set(p.lines.map((l: PurchaseOrderLine) => {
      const pending = Math.max(0, Number(l.ordered_qty) - Number(l.received_qty));
      return {
        po_line_id: l.id, sku: l.sku, nombre: l.nombre,
        ordered_qty: Number(l.ordered_qty), already: Number(l.received_qty), pending,
        received_qty: pending, unit_cost: Number(l.unit_cost) || 0,
      };
    }));
    this.recvNotes = '';
    this.recvOpen.set(true);
  }

  confirmReceive(): void {
    const lines: CreateReceiptLine[] = this.recvLines()
      .filter((l) => Number(l.received_qty) > 0)
      .map((l) => ({ po_line_id: l.po_line_id, received_qty: Number(l.received_qty), unit_cost: Number(l.unit_cost) || 0 }));
    if (!lines.length) { this.toast.add({ severity: 'warn', summary: 'Sin cantidades', detail: 'Captura lo recibido (> 0).' }); return; }
    this.saving.set(true);
    this.api.createReceipt(this.id, { lines, notes: this.recvNotes || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.saving.set(false); this.recvOpen.set(false);
          this.toast.add({ severity: 'success', summary: `Recepción ${r.folio}`, detail: `${r.total_units} u · stock actualizado · OC ${this.estadoLabel(r.po_estado)}` });
          this.load();
        },
        error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo registrar la recepción.' }); },
      });
  }

  cancel(): void {
    this.busy.set(true);
    this.api.cancelPurchaseOrder(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.busy.set(false); this.toast.add({ severity: 'info', summary: 'OC cancelada' }); this.load(); },
      error: (e) => { this.busy.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cancelar.' }); },
    });
  }

  back(): void { this.router.navigate(['/compras/ordenes']); }
  fill(p: PurchaseOrderDetail): number { return Number(p.total_units) > 0 ? Number(p.received_units) / Number(p.total_units) : 0; }
  money(v: number | string | null | undefined) { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  estadoLabel(e: PurchaseOrderEstado) { return ({ open: 'Abierta', partial: 'Parcial', received: 'Recibida', cancelled: 'Cancelada' } as Record<PurchaseOrderEstado, string>)[e]; }
  estadoSev(e: PurchaseOrderEstado): Sev { return ({ open: 'info', partial: 'warn', received: 'success', cancelled: 'danger' } as Record<PurchaseOrderEstado, Sev>)[e]; }
}
