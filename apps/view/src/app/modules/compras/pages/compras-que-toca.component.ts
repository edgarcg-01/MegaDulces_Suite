import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { InputTextModule } from 'primeng/inputtext';
import { MessageService } from 'primeng/api';
import { ComprasService, WorklistRow, ReplenishmentFilters } from '../compras.service';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/**
 * RA-PRO.8 — "Qué toca": ciclos de reabasto. Por (almacén × proveedor) con canal activo,
 * muestra cuándo toca el próximo pedido (cadencia derivada del histórico X-A-40/traspaso)
 * y el sugerido con horizonte = cadencia + lead + colchón. Traspaso vs compra explícito.
 * Presets de territorio (analista). Superficie Operations (PrimeNG denso, tokens, quiet-luxury).
 */
@Component({
  selector: 'app-compras-que-toca',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, SelectModule, MultiSelectModule, TagModule, TooltipModule, InputTextModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in qt-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Qué toca hoy</h1>
          <p class="surf-page-sub">Ciclos de reabasto por proveedor y sucursal. La cadencia se deriva del histórico de entradas; el sugerido cubre hasta el próximo pedido (cadencia + lead + colchón).</p>
        </div>
      </header>

      <div class="qt-kpis">
        <button class="qt-kpi" [class.on]="fStatus==='due'" (click)="setStatus('due')">
          <span class="qt-kpi-n qt-bad">{{ vencidos() | number }}</span><span class="qt-kpi-l">Vencidos</span>
        </button>
        <div class="qt-kpi">
          <span class="qt-kpi-n qt-warn">{{ hoy() | number }}</span><span class="qt-kpi-l">Hoy</span>
        </div>
        <div class="qt-kpi">
          <span class="qt-kpi-n">{{ prox7() | number }}</span><span class="qt-kpi-l">Próx. 7 días</span>
        </div>
        <div class="qt-kpi">
          <span class="qt-kpi-n qt-strong">{{ money(sugeridoTotal()) }}</span><span class="qt-kpi-l">Sugerido (visible)</span>
        </div>
      </div>

      <div class="qt-filters">
        <div class="qt-terr">
          <span class="qt-terr-lbl">Territorio:</span>
          <button *ngFor="let t of territories" pButton type="button" [label]="t.label"
                  class="p-button-sm" [ngClass]="isTerr(t.codes) ? 'p-button-outlined' : 'p-button-text'"
                  (click)="applyTerr(t.codes)"></button>
        </div>
        <p-multiSelect [options]="warehouses()" [(ngModel)]="fWh" (onChange)="reload()"
                       optionLabel="label" optionValue="id" placeholder="Almacenes" [showClear]="true"
                       [maxSelectedLabels]="2" selectedItemsLabel="{0} almacenes" styleClass="qt-sel"></p-multiSelect>
        <p-select [options]="viaOpts" [(ngModel)]="fVia" (onChange)="reload()" optionLabel="label" optionValue="value"
                  placeholder="Canal" [showClear]="true" styleClass="qt-sel-sm"></p-select>
        <p-select [options]="statusOpts" [(ngModel)]="fStatus" (onChange)="reload()" optionLabel="label" optionValue="value" styleClass="qt-sel-sm"></p-select>
        <input type="text" pInputText [(ngModel)]="fSearch" (keyup.enter)="reload()" placeholder="Proveedor…" class="qt-search" />
        <button pButton type="button" icon="pi pi-search" class="p-button-sm p-button-text" (click)="reload()"></button>
        <span class="qt-count">{{ total() | number }} par(es) activo(s)</span>
      </div>

      <p-table [value]="rows()" [loading]="loading()" [scrollable]="true" scrollHeight="flex"
               styleClass="p-datatable-sm qt-table">
        <ng-template pTemplate="header">
          <tr>
            <th>Estado</th><th>Próximo</th><th>Proveedor</th><th>Almacén</th><th>Canal</th>
            <th class="qt-r">Cadencia</th><th>Última</th><th class="qt-r">SKUs</th>
            <th class="qt-r">Sugerido</th><th class="qt-r">Costo est.</th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-r>
          <tr>
            <td><p-tag [value]="estLabel(r)" [severity]="estSev(r)"></p-tag></td>
            <td class="qt-nowrap" [class.qt-bad]="(r.days_to_due ?? 0) < 0">
              {{ r.next_due_date | date:'dd/MM/yy' }}
              <span class="qt-dd">{{ ddLabel(r.days_to_due) }}</span>
            </td>
            <td>{{ r.supplier_name || '—' }}</td>
            <td class="qt-muted">{{ r.warehouse_code }}</td>
            <td>
              <span *ngIf="r.via==='transfer'" class="qt-via qt-via-t" [pTooltip]="'Traspaso desde ' + (r.source_warehouse_code||'?')">
                <i class="pi pi-arrow-right-arrow-left"></i> Traspaso <span class="qt-muted">← {{ r.source_warehouse_code || '?' }}</span>
              </span>
              <span *ngIf="r.via!=='transfer'" class="qt-via qt-via-c"><i class="pi pi-shopping-cart"></i> Compra</span>
            </td>
            <td class="qt-r">
              <span class="qt-cad">{{ r.cadence_days != null ? (r.cadence_days | number:'1.0-1') + 'd' : '—' }}</span>
              <p-tag *ngIf="r.health_band" [value]="bandLabel(r.health_band)" [severity]="bandSev(r.health_band)" styleClass="qt-band"></p-tag>
            </td>
            <td class="qt-muted qt-nowrap">{{ r.last_delivery_date | date:'dd/MM/yy' }}</td>
            <td class="qt-r"><span [class.qt-strong]="r.n_below>0">{{ r.n_below | number }}</span><span class="qt-muted">/{{ r.n_skus | number }}</span></td>
            <td class="qt-r">{{ r.suggested_qty | number:'1.0-0' }}</td>
            <td class="qt-r qt-strong">{{ money(r.suggested_cost) }}</td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="10" class="qt-empty">Sin ciclos activos con estos filtros. Ajusta el territorio o corre el job de cadencia.</td></tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .qt-kpis { display: flex; flex-wrap: wrap; gap: .6rem; margin-bottom: .9rem; }
    .qt-kpi { display: flex; flex-direction: column; gap: .1rem; padding: .55rem .9rem; min-width: 8rem;
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md, 8px); text-align: left; }
    button.qt-kpi { cursor: pointer; font: inherit; }
    button.qt-kpi.on { border-color: var(--action); box-shadow: inset 0 0 0 1px var(--action); }
    .qt-kpi-n { font-size: 1.35rem; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
    .qt-kpi-l { font-size: .72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
    .qt-filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-bottom: .75rem; }
    .qt-terr { display: flex; align-items: center; gap: .15rem; flex-wrap: wrap; }
    .qt-terr-lbl { font-size: .78rem; color: var(--text-muted); margin-right: .25rem; }
    .qt-sel { min-width: 14rem; }
    .qt-sel-sm { min-width: 9rem; }
    .qt-search { font-size: .82rem; padding: .35rem .5rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, 6px);
      background: var(--card-bg); color: var(--text-main); }
    .qt-count { color: var(--text-muted); font-size: .82rem; margin-left: auto; }
    .qt-table { font-size: .82rem; }
    .qt-r { text-align: right; font-variant-numeric: tabular-nums; }
    .qt-nowrap { white-space: nowrap; }
    .qt-muted { color: var(--text-muted); }
    .qt-strong { font-weight: 700; }
    .qt-bad { color: var(--bad-fg); font-weight: 600; }
    .qt-dd { font-size: .72rem; color: var(--text-muted); margin-left: .35rem; }
    .qt-via { display: inline-flex; align-items: center; gap: .3rem; font-size: .78rem; }
    .qt-via i { font-size: .7rem; }
    .qt-via-t { color: var(--action, #b45309); }
    .qt-cad { font-variant-numeric: tabular-nums; margin-right: .35rem; }
    :host ::ng-deep .qt-band { font-size: .62rem !important; padding: .05rem .3rem !important; }
    .qt-empty { color: var(--text-muted); padding: 1rem; text-align: center; }
  `],
})
export class ComprasQueTocaComponent implements OnInit {
  private readonly api = inject(ComprasService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  rows = signal<WorklistRow[]>([]);
  warehouses = signal<{ id: string; code: string; label: string }[]>([]);
  total = signal(0);
  vencidos = signal(0);
  hoy = signal(0);
  prox7 = signal(0);
  loading = signal(false);
  sugeridoTotal = computed(() => this.rows().reduce((s, r) => s + (Number(r.suggested_cost) || 0), 0));

  fWh: string[] = [];
  fVia = '';
  fStatus = '';
  fSearch = '';
  viaOpts = [{ label: 'Compra', value: 'purchase' }, { label: 'Traspaso', value: 'transfer' }];
  statusOpts = [{ label: 'Activos', value: '' }, { label: 'Solo lo que toca (≤ hoy)', value: 'due' }];
  // Presets de territorio (por código de almacén; ver reference_kepler_supply_network_topology).
  territories = [
    { label: 'Bajío', codes: ['01', '02', '03', '04'] },
    { label: 'Morelia', codes: ['MD-30', 'MD-32'] },
    { label: 'Zamora', codes: ['05', 'MD-50'] },
    { label: 'CEDIS', codes: ['00'] },
  ];

  ngOnInit(): void {
    this.api.filters().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (f: ReplenishmentFilters) => this.warehouses.set(f.warehouses.map((w) => ({ id: w.id, code: w.code, label: `${w.code} · ${w.name}` }))),
      error: () => {},
    });
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.api.worklist({ warehouse_ids: this.fWh.length ? this.fWh : undefined, via: this.fVia || undefined, status: this.fStatus || undefined, search: this.fSearch || undefined, pageSize: 500 })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { this.rows.set(r.rows); this.total.set(r.total); this.vencidos.set(r.vencidos); this.hoy.set(r.hoy); this.prox7.set(r.prox7); this.loading.set(false); },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el worklist.' }); },
      });
  }

  setStatus(s: string): void { this.fStatus = this.fStatus === s ? '' : s; this.reload(); }

  isTerr(codes: string[]): boolean {
    const ids = this.idsForCodes(codes);
    return ids.length > 0 && ids.length === this.fWh.length && ids.every((i) => this.fWh.includes(i));
  }
  applyTerr(codes: string[]): void {
    const ids = this.idsForCodes(codes);
    this.fWh = this.isTerr(codes) ? [] : ids; // toggle
    this.reload();
  }
  private idsForCodes(codes: string[]): string[] {
    return this.warehouses().filter((w) => codes.includes(w.code)).map((w) => w.id);
  }

  estLabel(r: WorklistRow): string {
    const d = r.days_to_due ?? 99;
    return d < 0 ? 'Vencido' : d === 0 ? 'Hoy' : d <= 7 ? 'Próximo' : 'Futuro';
  }
  estSev(r: WorklistRow): Sev {
    const d = r.days_to_due ?? 99;
    return d < 0 ? 'danger' : d === 0 ? 'warn' : d <= 7 ? 'info' : 'secondary';
  }
  ddLabel(d: number | null): string {
    if (d == null) return '';
    if (d < 0) return `${Math.abs(d)}d tarde`;
    if (d === 0) return 'hoy';
    return `en ${d}d`;
  }
  bandLabel(b: string): string { return ({ rapida: 'rápida', promedio: 'promedio', mal_abasto: 'lento' } as Record<string, string>)[b] || b; }
  bandSev(b: string): Sev { return ({ rapida: 'success', promedio: 'info', mal_abasto: 'danger' } as Record<string, Sev>)[b] || 'secondary'; }
  money(v: number | string | null | undefined) { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
