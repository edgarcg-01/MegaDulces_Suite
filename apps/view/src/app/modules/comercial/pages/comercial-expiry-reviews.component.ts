import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { DatePickerModule } from 'primeng/datepicker';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ComercialService, ExpiryReview, Warehouse } from '../comercial.service';
import { Permission } from '../../../core/constants/permissions';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';

/**
 * P2.6 — Control de Caducidades: lista de hojas de inspección de anaquel.
 * Reemplaza la hoja de papel "CONTROL DE CADUCIDADES". Al enviar una hoja,
 * los renglones con producto + caducidad alimentan FEFO (pestaña "Por vencer").
 */
@Component({
  selector: 'app-comercial-expiry-reviews',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule, DialogModule, DatePickerModule, InputTextModule, ToastModule],
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
          @if (canCapture()) {
            <button pButton size="small" (click)="openNew()"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span> Nueva hoja</button>
          }
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
          <tr><td colspan="6" class="comm-empty-cell"><div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-clipboard" aria-hidden="true"></i></div><h3>Sin hojas de caducidades</h3><p>Creá una hoja para capturar los productos por vencer de un anaquel.</p></div></td></tr>
        </ng-template>
      </p-table>
    </div>

    <p-dialog [(visible)]="newOpen" [modal]="true" header="Nueva hoja de caducidades" [style]="{ width: '26rem', maxWidth: '92vw' }">
      <div class="er-newform">
        <label class="er-field">
          <span class="er-lbl">Almacén / sucursal</span>
          <p-select [options]="warehouseOptions()" [(ngModel)]="newWarehouse" optionLabel="label" optionValue="value" placeholder="Elegí un almacén" appendTo="body" styleClass="er-full"></p-select>
        </label>
        <label class="er-field">
          <span class="er-lbl">Fecha de elaboración</span>
          <p-datepicker [(ngModel)]="newDate" dateFormat="yy-mm-dd" appendTo="body" styleClass="er-full"></p-datepicker>
        </label>
        <label class="er-field">
          <span class="er-lbl">Ubicación por defecto (opcional)</span>
          <input pInputText [(ngModel)]="newLocation" placeholder="Ej. Anaquel 3 / Bodega / Exhibidor caja" class="er-full" />
          <small class="er-hint">Se pre-llena en cada renglón; podés cambiarla por producto.</small>
        </label>
      </div>
      <ng-template #footer>
        <button pButton [text]="true" severity="secondary" (click)="newOpen.set(false)">Cancelar</button>
        <button pButton [disabled]="!newWarehouse || creating()" [loading]="creating()" (click)="create()">Crear y capturar</button>
      </ng-template>
    </p-dialog>
    `,
  styles: [`
    .er-head-actions { display: flex; gap: .5rem; align-items: center; }
    :host ::ng-deep .er-status { min-width: 160px; }
    .er-mono { font-family: var(--font-mono, monospace); font-size: var(--fs-sm, .85rem); }
    .er-row { cursor: pointer; }
    .er-chev { color: var(--text-muted); }
    .er-newform { display: flex; flex-direction: column; gap: 1rem; padding-top: .5rem; }
    .er-field { display: flex; flex-direction: column; gap: .35rem; }
    .er-lbl { font-size: var(--fs-sm, .85rem); color: var(--c-text-2, var(--text-muted)); }
    .er-hint { font-size: var(--fs-xs, .72rem); color: var(--c-text-3, var(--text-muted)); }
    :host ::ng-deep .er-full, :host ::ng-deep .er-full input { width: 100%; }
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
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly destroyRef = inject(DestroyRef);

  // WMS.1 — se fue `showInvTabs`: la barra de tabs ya no la pinta esta página.
  // La monta `AlmacenAreaShellComponent`, que solo envuelve `/almacen/*`, así
  // que la condición "solo bajo /almacen (no en /tienda)" ahora la resuelve el
  // árbol de rutas y no un check de URL acá.

  reviews = signal<ExpiryReview[]>([]);
  loading = signal(false);
  statusFilter = '';

  warehouses = signal<{ label: string; value: string }[]>([]);
  warehouseOptions = computed(() => this.warehouses());

  newOpen = signal(false);
  newWarehouse = '';
  newDate: Date = new Date();
  newLocation = '';
  creating = signal(false);

  canCapture = () =>
    this.perms.can('manage', 'all') || !!this.auth.user()?.permissions?.[Permission.COMMERCIAL_EXPIRY_CAPTURAR];

  constructor() {
    this.svc.listWarehouses(true)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (ws: Warehouse[]) => this.warehouses.set(
        ws.filter((w) => w.kind !== 'truck') // solo sucursales/CEDIS — sin camiones de ruta
          .map((w) => ({ label: w.name || w.code, value: w.id }))) });
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

  openNew() { this.newWarehouse = ''; this.newDate = new Date(); this.newLocation = ''; this.newOpen.set(true); }

  /** `date` de Postgres llega como ISO completo: se muestra el tramo YYYY-MM-DD, sin new Date(). */
  fmtDate(v: string | null | undefined): string {
    const ymd = String(v || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '—';
    const p = ymd.split('-');
    return p[2] + '/' + p[1] + '/' + p[0];
  }

  private toYmd(d: Date): string {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  create() {
    if (!this.newWarehouse) return;
    this.creating.set(true);
    this.svc.createExpiryReview({ warehouse_id: this.newWarehouse, review_date: this.toYmd(this.newDate), default_location: this.newLocation.trim() || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.creating.set(false); this.newOpen.set(false); this.router.navigate([r.id], { relativeTo: this.route }); },
        error: () => { this.creating.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo crear la hoja' }); },
      });
  }

  open(r: ExpiryReview) { this.router.navigate([r.id], { relativeTo: this.route }); }
}
