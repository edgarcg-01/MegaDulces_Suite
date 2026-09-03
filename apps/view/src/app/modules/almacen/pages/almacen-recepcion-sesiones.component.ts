import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ComercialService, Warehouse } from '../../comercial/comercial.service';
import { ErpOrderMatch, ReceivingSessionService, ReceivingSessionListItem, ErpOrderLookup, SucursalMapEntry } from '../receiving-session.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

/**
 * Fase WMS-REC (Pieza 1, ADR-044) — Lista de Vales de entrada (sesiones de recepción)
 * + apertura de una nueva (manual o desde orden de entrada del ERP).
 */
@Component({
  selector: 'app-almacen-recepcion-sesiones',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule, InputTextModule, DialogModule, ToastModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Recepción · Vales de entrada</h1>
          <p class="surf-page-sub">Escaneo caja→pieza contra lo esperado; faltantes y sobrantes por sesión</p>
        </div>
        <div class="rs-head-actions">
          <p-select [options]="statusOptions" [(ngModel)]="statusFilter" optionLabel="label" optionValue="value" (onChange)="reload()" styleClass="rs-status"></p-select>
          @if (canManageMap()) {
            <button pButton [text]="true" size="small" severity="secondary" (click)="openMap()"><span class="p-button-icon p-button-icon-left pi pi-sitemap" aria-hidden="true"></span> Almacenes×sucursal</button>
          }
          <button pButton size="small" (click)="openNew()"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span> Nueva sesión</button>
        </div>
      </header>

      <p-table [value]="sessions()" [loading]="loading()" styleClass="p-datatable-sm surf-table surf-table--zebra"
        [scrollable]="true" scrollHeight="flex" [paginator]="true" [rows]="25" [rowsPerPageOptions]="[25,50,100]">
        <ng-template #header>
          <tr>
            <th scope="col">Folio</th><th scope="col">Almacén</th><th scope="col">Proveedor</th><th scope="col">Origen</th>
            <th scope="col">Estado</th><th scope="col" class="num">Líneas</th><th scope="col" class="num">Discrep.</th><th scope="col">Creada</th>
          </tr>
        </ng-template>
        <ng-template #body let-s>
          <tr class="rs-row" (click)="openSession(s)">
            <td class="rs-mono">{{ s.folio }}</td>
            <td class="rs-mono">{{ s.warehouse_code }}</td>
            <td class="rs-mono">{{ s.supplier_code || '—' }}</td>
            <td>{{ s.source_kind === 'erp_receipt' ? ('ERP · ' + (s.source_ref || '')) : 'Manual' }}</td>
            <td><p-tag [value]="statusLabel(s.status)" [severity]="statusSeverity(s.status)"></p-tag></td>
            <td class="num">{{ s.line_count }}</td>
            <td class="num">
              @if (+s.discrepancy_count > 0) { <p-tag [value]="s.discrepancy_count" severity="warn"></p-tag> } @else { — }
            </td>
            <td class="rs-mono">{{ s.created_at | date:'dd/MM/yy HH:mm' }}</td>
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="8" class="comm-empty-cell"><div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-inbox" aria-hidden="true"></i></div><h3>Sin sesiones</h3><p>Abrí una nueva sesión de recepción para empezar a escanear.</p></div></td></tr>
        </ng-template>
      </p-table>

      <p-dialog [visible]="newOpen()" (visibleChange)="newOpen.set($event)" [modal]="true" [style]="{ width: '520px' }" header="Nueva sesión de recepción" [dismissableMask]="true">
        <div class="rs-form">
          @if (newSource === 'erp_receipt') {
            <!-- Un solo campo, y es lo PRIMERO de la pantalla: el folio del papel.
                 Sucursal, almacén y proveedor salen de la orden elegida. -->
            <label class="rs-field"><span>Folio del vale</span>
              <input pInputText [(ngModel)]="newErpFolio" (keyup.enter)="searchOrders()" (ngModelChange)="matches.set([])"
                     placeholder="Tecleá el folio y Enter — ej. 909" autofocus />
            </label>
            <button pButton [text]="true" severity="secondary" size="small" (click)="searchOrders()" [loading]="looking()" [disabled]="!newErpFolio">
              <span class="p-button-icon p-button-icon-left pi pi-search" aria-hidden="true"></span> Buscar en todas las sucursales
            </button>

            @if (searched() && !matches().length && !looking()) {
              <p class="rs-nores">Sin coincidencias para <strong>{{ newErpFolio }}</strong>.</p>
            }
            @if (matches().length) {
              <p class="rs-hint">{{ matches().length }} coincidencia(s) — el mismo folio existe en varias sucursales. Elegí la tuya:</p>
              <div class="rs-matches">
                @for (o of matches(); track o.sucursal + '/' + o.folio) {
                  <button type="button" class="rs-match" [class.on]="isPicked(o)" (click)="pick(o)">
                    <div class="rs-match-head">
                      <strong>{{ o.sucursal }} · {{ o.folio }}</strong>
                      <p-tag [value]="o.tipo === 'traspaso' ? 'Traspaso' : 'Compra'" [severity]="o.tipo === 'traspaso' ? 'warn' : 'info'"></p-tag>
                      <span class="rs-match-monto">{{ o.monto | currency:'MXN':'symbol-narrow':'1.0-2' }}</span>
                    </div>
                    <div class="rs-match-sub">
                      {{ o.proveedor_nombre || o.proveedor_code || '—' }}
                      @if (o.receipt_date) { · {{ fmtDate(o.receipt_date) }} }
                      @if (o.warehouse_code) { · → {{ o.warehouse_code }} }
                    </div>
                    <div class="rs-match-sub">
                      @if (o.line_count) { {{ o.line_count }} renglón(es) }
                      @else { <span class="rs-warn">sin renglones en el espejo (fuente Wincaja)</span> }
                      @if (o.service_count) { · <span class="rs-serv">{{ o.service_count }} servicio(s) — no se reciben</span> }
                      @if (o.oc_folio) { · OC {{ o.oc_folio }} }
                    </div>
                  </button>
                }
              </div>
            }
          } @else {
            <label class="rs-field"><span>Almacén destino *</span>
              <p-select [options]="warehouseOptions()" [(ngModel)]="newWarehouse" optionLabel="label" optionValue="value" placeholder="¿A qué almacén entra la mercancía?" styleClass="rs-w"></p-select>
            </label>
            <label class="rs-field"><span>Proveedor (opcional)</span><input pInputText [(ngModel)]="newSupplier" placeholder="ej. C001" /></label>
          }

          <button pButton (click)="create()" [disabled]="!canOpen()" [loading]="creating()"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span> Abrir vale</button>

          <!-- El caso normal es el vale del ERP; la entrada sin papel es la excepción,
               así que el selector va al final y discreto, no encabezando el diálogo. -->
          <label class="rs-field rs-origen"><span>Origen</span>
            <p-select [options]="sourceOptions" [(ngModel)]="newSource" optionLabel="label" optionValue="value" (onChange)="onSourceChange()" styleClass="rs-w"></p-select>
          </label>
        </div>
      </p-dialog>

      <p-dialog [visible]="mapOpen()" (visibleChange)="mapOpen.set($event)" [modal]="true" [style]="{ width: '540px' }" header="Almacén destino por sucursal ERP" [dismissableMask]="true">
        <p class="rs-hint">Configurá una vez a qué almacén entra cada sucursal del ERP; después el almacén se autollena al buscar la orden.</p>
        <div class="rs-map">
          @for (s of sucursalOptions; track s.value) {
            <div class="rs-map-row">
              <span class="rs-map-suc">{{ s.label }}</span>
              <p-select [options]="warehouseOptions()" [(ngModel)]="mapValues[s.value]" (onChange)="saveMapRow(s.value)" optionLabel="label" optionValue="value" placeholder="Sin asignar" [filter]="true" styleClass="rs-w"></p-select>
            </div>
          }
        </div>
      </p-dialog>
    </div>
  `,
  styles: [`
    .rs-matches { display: flex; flex-direction: column; gap: .4rem; max-height: 300px; overflow-y: auto; }
    .rs-match { text-align: left; background: transparent; border: 1px solid var(--surface-border); border-radius: 10px;
      padding: .5rem .65rem; cursor: pointer; font: inherit; color: inherit; }
    .rs-match:hover { background: var(--overlay-hover, rgba(0,0,0,.03)); }
    .rs-match.on { border-color: var(--action, #c2410c); background: var(--overlay-selected, rgba(0,0,0,.05)); }
    .rs-match:focus-visible { outline: 2px solid var(--action, #c2410c); outline-offset: 1px; }
    .rs-match-head { display: flex; align-items: center; gap: .45rem; }
    .rs-match-head > strong { font-family: var(--font-mono, monospace); }
    .rs-match-monto { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 700; }
    .rs-match-sub { font-size: .74rem; color: var(--text-color-secondary); margin-top: .15rem; }
    .rs-warn { color: var(--warn-fg, #b45309); }
    .rs-serv { color: var(--text-color-secondary); font-style: italic; }
    .rs-nores { font-size: .8rem; color: var(--text-color-secondary); }
    .rs-origen { margin-top: .9rem; padding-top: .7rem; border-top: 1px solid var(--surface-border); }
    .rs-origen > span { font-size: .72rem; color: var(--text-color-secondary); }
    @media (pointer: coarse) { .rs-match { min-height: 44px; } }
  `, `
    .rs-head-actions { display: flex; gap: .5rem; align-items: center; }
    :host ::ng-deep .rs-status { min-width: 160px; }
    :host ::ng-deep .rs-w { width: 100%; }
    .rs-row { cursor: pointer; }
    .rs-mono { font-family: var(--font-mono, monospace); }
    .rs-form { display: flex; flex-direction: column; gap: .25rem; }
    .rs-field { display: flex; flex-direction: column; gap: .25rem; margin-bottom: .75rem; }
    .rs-field > span { font-size: .8rem; color: var(--text-color-secondary); font-weight: 600; }
    .rs-field input[pInputText] { width: 100%; }
    .rs-row-form { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
    .rs-row { }
    .rs-hint { font-size: .78rem; color: var(--text-color-secondary); margin-bottom: .75rem; display: block; }
    .rs-found { display: flex; gap: .5rem; align-items: flex-start; margin: .5rem 0 .75rem; padding: .6rem .75rem; border-radius: 8px; background: var(--good-soft-bg, #ecfdf5); font-size: .85rem; }
    .rs-found i { color: var(--good-fg, #059669); margin-top: .1rem; }
    .rs-found-prov { color: var(--text-color-secondary); font-size: .8rem; margin-top: .1rem; }
    .rs-auto { color: var(--good-fg, #059669); font-weight: 600; }
    .rs-map { display: flex; flex-direction: column; gap: .5rem; }
    .rs-map-row { display: grid; grid-template-columns: 130px 1fr; gap: .5rem; align-items: center; }
    .rs-map-suc { font-size: .85rem; font-weight: 600; }
  `],
})
export class AlmacenRecepcionSesionesComponent implements OnInit {
  private readonly svc = inject(ReceivingSessionService);
  private readonly comercial = inject(ComercialService);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  readonly sessions = signal<ReceivingSessionListItem[]>([]);
  readonly loading = signal(false);
  statusFilter = 'open';
  readonly statusOptions = [
    { label: 'Abiertas', value: 'open' },
    { label: 'Cerradas', value: 'closed' },
    { label: 'Canceladas', value: 'cancelled' },
    { label: 'Todas', value: '' },
  ];

  readonly warehouses = signal<Warehouse[]>([]);
  readonly warehouseOptions = computed(() => this.warehouses().map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id })));
  readonly newOpen = signal(false);
  readonly creating = signal(false);
  newWarehouse = '';
  newSupplier = '';
  /**
   * El origen normal es el vale del ERP: el operador llega con el papel en la mano.
   * Arrancar en 'manual' obligaba a cambiar el selector antes de poder teclear el
   * folio, que es justo el paso de más que se quería quitar.
   */
  newSource: 'manual' | 'erp_receipt' = 'erp_receipt';
  newErpSucursal = '00';
  newErpFolio = '';
  readonly foundOrder = signal<ErpOrderLookup | null>(null);
  /** Coincidencias del folio en todas las sucursales, y la elegida. */
  readonly matches = signal<ErpOrderMatch[]>([]);
  readonly picked = signal<ErpOrderMatch | null>(null);
  readonly searched = signal(false);
  readonly looking = signal(false);
  readonly sourceOptions = [
    { label: 'Manual (escaneo libre)', value: 'manual' },
    { label: 'Desde orden de entrada (ERP)', value: 'erp_receipt' },
  ];
  readonly sucursalOptions = [
    { label: 'CEDIS (00)', value: '00' },
    { label: 'Padre Hidalgo (01)', value: '01' },
    { label: 'La Piedad Abastos (02)', value: '02' },
    { label: '8 Esquinas (03)', value: '03' },
    { label: 'Yurécuaro (04)', value: '04' },
    { label: 'Zamora Centro (05)', value: '05' },
    { label: 'Morelia Abastos (30)', value: '30' },
    { label: 'Morelia Madero (32)', value: '32' },
    { label: 'Canindo (50)', value: '50' },
  ];

  readonly mapOpen = signal(false);
  mapValues: Record<string, string> = {};

  ngOnInit(): void {
    this.comercial.listWarehouses().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ws: Warehouse[]) => this.warehouses.set(ws || []),
      error: () => this.warehouses.set([]),
    });
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.svc.list({ status: this.statusFilter || undefined, limit: 100 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.sessions.set(rows || []); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  openNew(): void {
    this.matches.set([]); this.picked.set(null); this.searched.set(false);
    this.newErpFolio = ''; this.newOpen.set(true);
  }
  onSourceChange(): void { this.matches.set([]); this.picked.set(null); this.searched.set(false); }

  /**
   * Busca SOLO por folio, en todas las sucursales. El folio de Kepler es por
   * sucursal, así que el mismo número existe en varias (verificado: `0000909`
   * está en la 02 con 50 renglones y en la 03 con 1) → se muestran para elegir.
   */
  searchOrders(): void {
    const folio = this.newErpFolio.trim();
    if (!folio) return;
    this.looking.set(true); this.picked.set(null);
    this.svc.searchErpOrders(folio).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => {
        this.looking.set(false); this.searched.set(true);
        this.matches.set(rows || []);
        // Si hay una sola, se elige sola: el operador no tiene que confirmar lo obvio.
        if ((rows || []).length === 1) this.pick(rows[0]);
      },
      error: (e) => {
        this.looking.set(false); this.searched.set(true); this.matches.set([]);
        this.toast.add({ severity: 'warn', summary: 'Búsqueda', detail: e?.error?.message || 'No pude buscar el folio' });
      },
    });
  }

  pick(o: ErpOrderMatch): void { this.picked.set(o); }
  isPicked(o: ErpOrderMatch): boolean {
    const p = this.picked();
    return !!p && p.sucursal === o.sucursal && p.folio === o.folio;
  }

  /** `date` de Postgres llega como ISO completo: se muestra el tramo YYYY-MM-DD. */
  fmtDate(v: string | null | undefined): string {
    const ymd = String(v || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '';
    const p = ymd.split('-');
    return p[2] + '/' + p[1] + '/' + p[0];
  }

  canOpen(): boolean {
    if (this.newSource === 'manual') return !!this.newWarehouse;
    return !!this.picked();
  }

  create(): void {
    if (!this.canOpen()) return;
    const o = this.picked();
    this.creating.set(true);
    this.svc.open({
      // Desde el ERP el almacén lo deriva el backend de la orden elegida: acá no se manda.
      warehouse_id: this.newSource === 'manual' ? this.newWarehouse : undefined,
      supplier_code: this.newSource === 'manual' ? (this.newSupplier?.trim() || undefined) : undefined,
      source_kind: this.newSource,
      erp_sucursal: this.newSource === 'erp_receipt' ? o?.sucursal : undefined,
      erp_folio: this.newSource === 'erp_receipt' ? o?.folio : undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => { this.creating.set(false); this.newOpen.set(false); this.router.navigate(['/almacen/inventory/recepcion-sesiones', s.id]); },
      error: (e) => { this.creating.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo abrir' }); },
    });
  }

  openSession(s: ReceivingSessionListItem): void {
    this.router.navigate(['/almacen/inventory/recepcion-sesiones', s.id]);
  }

  canManageMap(): boolean {
    return this.perms.isAdmin() || !!this.auth.user()?.permissions?.[Permission.COMMERCIAL_WAREHOUSES_GESTIONAR];
  }

  openMap(): void {
    this.svc.getSucursalMap().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows: SucursalMapEntry[]) => {
        const m: Record<string, string> = {};
        (rows || []).forEach((r) => (m[r.sucursal] = r.warehouse_id));
        this.mapValues = m;
        this.mapOpen.set(true);
      },
      error: () => { this.mapValues = {}; this.mapOpen.set(true); },
    });
  }

  saveMapRow(sucursal: string): void {
    const wid = this.mapValues[sucursal];
    if (!wid) return;
    this.svc.setSucursalMap(sucursal, wid).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.toast.add({ severity: 'success', summary: 'Guardado', detail: `Sucursal ${sucursal} → almacén` }),
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo guardar' }),
    });
  }

  statusLabel(s: string): string {
    return s === 'open' ? 'Abierta' : s === 'closed' ? 'Cerrada' : s === 'validating' ? 'Validando' : 'Cancelada';
  }
  statusSeverity(s: string): 'success' | 'secondary' | 'warn' | 'danger' {
    return s === 'open' ? 'success' : s === 'closed' ? 'secondary' : s === 'validating' ? 'warn' : 'danger';
  }
}
