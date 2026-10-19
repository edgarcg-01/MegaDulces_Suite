import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { MultitareaService } from '../../../core/services/multitarea.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ComprasService, PurchaseOrderRow, PurchaseOrderEstado, OrdenesPorProveedorRow } from '../compras.service';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { AuthService } from '../../../core/services/auth.service';
import { generarOrdenProveedorPdf } from '../orden-proveedor-pdf';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/**
 * RA.15 (ADR-031) — Órdenes de compra. Documento que se manda al proveedor (espejo
 * Kepler X-A-35). Progreso de recepción (recibido/pedido) + link al detalle donde se
 * registran las órdenes de entrada (OE). Superficie Operations (PrimeNG densa).
 */
@Component({
  selector: 'app-compras-ordenes',
  standalone: true,
  imports: [RouterLink, CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule, ToastModule, SegmentedComponent, SucursalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in oc-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Órdenes de compra</h1>
          <p class="surf-page-sub">Lo que se pide al proveedor. La recepción (orden de entrada) se registra en el detalle y mueve existencia.</p>
        </div>
      </header>

      <div class="oc-filters">
        <app-segmented [options]="vistaOpts" [value]="vista()" ariaLabel="Agrupación"
                       (valueChange)="setVista($any($event))"></app-segmented>
        <p-select [options]="estadoOpts" [(ngModel)]="fEstado" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Todos los estados" [showClear]="true" styleClass="oc-sel" appendTo="body"></p-select>
        <!-- [OC.1] El filtro que faltaba. El backend ya aceptaba supplier_id: lo que no habia
             era de dónde elegirlo. -->
        <p-select [options]="proveedorOpts()" [(ngModel)]="fProveedor" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Todos los proveedores"
                  [showClear]="true" [filter]="true" filterBy="label" styleClass="oc-sel oc-sel-prov"
                  appendTo="body" ariaLabel="Proveedor"></p-select>
      </div>

      @if (vista() === 'proveedor') {
        <!-- [OC.1] Agrupado en el SERVIDOR: la lista viene paginada de 50 sobre 152 órdenes, así
             que agrupar la página mostraría totales incompletos sin avisar. -->
        <p-table [value]="grupos()" [loading]="loadingGrupos()" [scrollable]="true" scrollHeight="flex"
                 styleClass="p-datatable-sm oc-table" [rowHover]="true">
          <ng-template #header>
            <tr>
              <th>Proveedor</th><th class="oc-r">Órdenes</th><th class="oc-r">Unidades</th>
              <th class="oc-r">Falta</th><th class="oc-r">Importe</th><th>Más vieja</th><th>Próxima entrega</th><th></th>
            </tr>
          </ng-template>
          <ng-template #body let-g>
            <tr>
              <td>
                <span class="oc-prov">{{ g.supplier_name }}</span>
                @if (g.supplier_code) { <span class="oc-mono oc-muted"> {{ g.supplier_code }}</span> }
              </td>
              <td class="oc-r">{{ g.ordenes }}</td>
              <td class="oc-r">{{ +g.unidades | number:'1.0-0' }}</td>
              <td class="oc-r">{{ +g.pendiente | number:'1.0-0' }}</td>
              <td class="oc-r">{{ money(+g.importe) }}</td>
              <td class="oc-muted">{{ g.mas_vieja | date:'dd/MM/yy' }}</td>
              <td class="oc-muted">{{ g.proxima_entrega ? (g.proxima_entrega | date:'dd/MM/yy') : '—' }}</td>
              <td class="oc-r">
                <button pButton type="button" class="p-button-sm p-button-text" [disabled]="imprimiendo() === g.supplier_id"
                        (click)="imprimir(g)" [title]="'Imprime en un solo papel todo lo que falta pedirle a ' + g.supplier_name">
                  <span class="p-button-icon p-button-icon-left pi" [class.pi-print]="imprimiendo() !== g.supplier_id" [class.pi-spinner]="imprimiendo() === g.supplier_id" aria-hidden="true"></span>
                  <span class="p-button-label">Imprimir pedido</span>
                </button>
                <button pButton type="button" class="p-button-sm p-button-text" (click)="verDocumentos(g)"
                        [title]="'Ver las ' + g.ordenes + ' orden(es) de ' + g.supplier_name">
                  <span class="p-button-label">Ver órdenes</span>
                </button>
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="8" class="oc-empty">
              @if (errorGrupos()) {
                <i class="pi pi-exclamation-triangle"></i> No se pudieron cargar los proveedores.
                <button pButton type="button" class="p-button-text p-button-sm" (click)="reload()"><span class="p-button-label">Reintentar</span></button>
              } @else {
                Sin órdenes de compra a proveedor con estos filtros.
                @if (!fEstado) { Se agrupa lo que falta surtir (abiertas y parciales). }
              }
            </td></tr>
          </ng-template>
        </p-table>
      } @else {

      <p-table [value]="rows()" [loading]="loading()" [scrollable]="true" scrollHeight="flex"
               [paginator]="true" [rows]="pageSize" [totalRecords]="total()" [lazy]="true" (onLazyLoad)="onPage($event)"
               styleClass="p-datatable-sm oc-table" [rowsPerPageOptions]="[50, 100, 200]"
               [rowHover]="true" (onRowSelect)="open($any($event.data))" selectionMode="single">
        <ng-template #header>
          <tr>
            <th>Folio</th><th>Estado</th><th>Origen</th><th>Proveedor / origen</th><th>Almacén</th>
            <th class="oc-r">Líneas</th><th class="oc-r">Pedido</th><th class="oc-r">Recibido</th><th class="oc-r">Avance</th>
            <th class="oc-r">Costo</th><th>Esperada</th><th>Creada</th>
          </tr>
        </ng-template>
        <ng-template #body let-r>
          <tr [pSelectableRow]="r">
            <td class="oc-mono"><a class="surf-cell-link" [routerLink]="multitarea.enlaceDetalle(['/compras/ordenes', r.id])" [target]="multitarea.target()" (click)="$event.stopPropagation()">{{ r.folio }}</a></td>
            <td><p-tag [value]="estadoLabel(r.estado)" [severity]="estadoSev(r.estado)"></p-tag></td>
            <td class="oc-muted">{{ r.source_type === 'branch' ? 'Traspaso' : 'Compra' }}</td>
            <td>{{ r.source_type === 'branch' ? (r.source_code || '—') : (r.supplier_name || '—') }}</td>
            <td class="oc-muted">{{ r.warehouse_code | sucursal }}</td>
            <td class="oc-r oc-muted">{{ r.total_lines }}</td>
            <td class="oc-r">{{ r.total_units | number:'1.0-0' }}</td>
            <td class="oc-r">{{ r.received_units | number:'1.0-0' }}</td>
            <td class="oc-r"><span class="oc-fill">{{ fill(r) | percent:'1.0-0' }}</span></td>
            <td class="oc-r">{{ money(r.total_cost) }}</td>
            <td class="oc-muted">{{ r.expected_date ? (r.expected_date | date:'dd/MM/yy') : '—' }}</td>
            <td class="oc-muted">{{ r.created_at | date:'dd/MM/yy' }}</td>
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="12" class="oc-empty">
            @if (error()) {
              <i class="pi pi-exclamation-triangle"></i> No se pudieron cargar las órdenes de compra.
              <button pButton type="button" class="p-button-text p-button-sm" (click)="reload()"><span class="p-button-label">Reintentar</span></button>
            } @else { Sin órdenes de compra con estos filtros. Genera una desde una requisición aprobada. }
          </td></tr>
        </ng-template>
      </p-table>
      }
      <p-toast></p-toast>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .oc-filters { display: flex; gap: .5rem; margin-bottom: .75rem; flex-wrap: wrap; align-items: center; }
    .oc-sel { min-width: 14rem; }
    .oc-sel-prov { min-width: 20rem; }
    .oc-prov { font-weight: 600; }
    .oc-table { font-size: .84rem; }
    .oc-r { text-align: right; font-variant-numeric: tabular-nums; }
    .oc-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .8rem; font-weight: 600; }
    .oc-muted { color: var(--text-muted); }
    .oc-fill { font-weight: 600; }
    .oc-empty { color: var(--text-muted); padding: 1.5rem; text-align: center; }
  `],
})
export class ComprasOrdenesComponent implements OnInit {
  /** `[MT.3]` Con la preferencia prendida, el detalle abre en otra ventana. */
  readonly multitarea = inject(MultitareaService);
  private readonly api = inject(ComprasService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);

  readonly pageSize = 50;
  rows = signal<PurchaseOrderRow[]>([]);
  total = signal(0);
  loading = signal(false);
  error = signal(false); // §6: falla de carga ≠ "sin órdenes"
  page = signal(1);
  fEstado = '';
  fProveedor: string | null = null;

  // ── `[OC.1]` Vista agrupada por proveedor ────────────────────────────────
  vista = signal<'proveedor' | 'documento'>('proveedor');
  readonly vistaOpts: SegOption[] = [
    { label: 'Por proveedor', value: 'proveedor' },
    { label: 'Por documento', value: 'documento' },
  ];
  grupos = signal<OrdenesPorProveedorRow[]>([]);
  loadingGrupos = signal(false);
  errorGrupos = signal(false);
  imprimiendo = signal<string | null>(null);
  private readonly proveedores = signal<{ id: string; name: string; code?: string | null }[]>([]);
  readonly proveedorOpts = computed(() => this.proveedores()
    .map((s) => ({ label: s.code ? `${s.code} · ${s.name}` : s.name, value: s.id })));

  estadoOpts = [
    { label: 'Abierta', value: 'open' },
    { label: 'Parcial', value: 'partial' },
    { label: 'Recibida', value: 'received' },
    { label: 'Cancelada', value: 'cancelled' },
  ];

  ngOnInit(): void {
    this.load();
    // Los proveedores del filtro salen del mismo catalogo que usa /compras/pedido.
    this.api.filters().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (f) => this.proveedores.set(f.suppliers ?? []), error: () => this.proveedores.set([]) });
  }

  reload(): void { this.page.set(1); this.load(); }

  private load(): void {
    if (this.vista() === 'proveedor') { this.loadGrupos(); return; }
    this.loading.set(true);
    this.api.listPurchaseOrders({ estado: this.fEstado || undefined, supplier_id: this.fProveedor || undefined, page: this.page(), pageSize: this.pageSize })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { this.rows.set(r.rows); this.total.set(r.total); this.loading.set(false); this.error.set(false); },
        error: () => { this.loading.set(false); this.error.set(true); },
      });
  }

  /** `[OC.1]` El agrupado lo arma el servidor; acá sólo se recorta al proveedor elegido. */
  private loadGrupos(): void {
    this.loadingGrupos.set(true);
    this.api.ordenesPorProveedor(this.fEstado || undefined)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          const rows = this.fProveedor ? r.rows.filter((g) => g.supplier_id === this.fProveedor) : r.rows;
          this.grupos.set(rows); this.loadingGrupos.set(false); this.errorGrupos.set(false);
        },
        error: () => { this.loadingGrupos.set(false); this.errorGrupos.set(true); },
      });
  }

  setVista(v: 'proveedor' | 'documento'): void { this.vista.set(v); this.page.set(1); this.load(); }

  /** Del grupo a la lista plana de ese proveedor: el camino para ver los folios. */
  verDocumentos(g: OrdenesPorProveedorRow): void {
    this.fProveedor = g.supplier_id;
    this.setVista('documento');
  }

  /**
   * `[OC.3]` **El pedido completo del proveedor, en un papel.**
   *
   * Pide el consolidado al servidor —una llamada, no una por orden— y dibuja el PDF. Si el
   * proveedor no tiene nada pendiente se DICE, en vez de bajar un papel en blanco.
   */
  imprimir(g: OrdenesPorProveedorRow): void {
    if (this.imprimiendo()) return;
    this.imprimiendo.set(g.supplier_id);
    this.api.consolidadoProveedor(g.supplier_id, this.fEstado || undefined)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: async (c) => {
          try {
            if (!c.lineas.length) {
              this.toast.add({ severity: 'warn', summary: 'Nada que imprimir', detail: `${g.supplier_name} no tiene renglones pendientes con este filtro.` });
              return;
            }
            await generarOrdenProveedorPdf({
              emitido: new Date(),
              elaboro: this.auth.user()?.username || 'sistema',
              proveedor: { code: c.supplier.code, name: c.supplier.name },
              ordenes: c.ordenes.map((o) => ({ folio: o.folio, warehouse_code: o.warehouse_code, expected_date: o.expected_date })),
              filas: c.lineas,
              totales: { cantidad: Number(c.totales.cantidad) || 0, pendiente: Number(c.totales.pendiente) || 0, importe: Number(c.totales.importe) || 0 },
            });
          } finally { this.imprimiendo.set(null); }
        },
        error: () => {
          this.imprimiendo.set(null);
          this.toast.add({ severity: 'error', summary: 'No se pudo armar el pedido', detail: 'El servidor no devolvió el consolidado. Reintenta.' });
        },
      });
  }

  onPage(e: TableLazyLoadEvent): void {
    const size = e.rows || this.pageSize;
    this.page.set(Math.floor((e.first || 0) / size) + 1);
    this.load();
  }

  open(r: PurchaseOrderRow): void { this.router.navigate(['/compras/ordenes', r.id]); }

  fill(r: PurchaseOrderRow): number { return Number(r.total_units) > 0 ? Number(r.received_units) / Number(r.total_units) : 0; }
  money(v: number | string | null | undefined) { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  estadoLabel(e: PurchaseOrderEstado) { return ({ open: 'Abierta', partial: 'Parcial', received: 'Recibida', cancelled: 'Cancelada' } as Record<PurchaseOrderEstado, string>)[e]; }
  estadoSev(e: PurchaseOrderEstado): Sev { return ({ open: 'info', partial: 'warn', received: 'success', cancelled: 'danger' } as Record<PurchaseOrderEstado, Sev>)[e]; }
}
