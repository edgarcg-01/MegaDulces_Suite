import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { MessageService } from 'primeng/api';
import { Subject, debounceTime } from 'rxjs';
import { ComprasService, AdjustmentsSummary, AdjustmentRow, AdjustmentsSupplierRow, DuplicateGroup } from '../compras.service';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';
type ViewMode = 'ajustes' | 'duplicados';

/**
 * RE.10 — Descuentos y apoyos de compra + posibles facturas duplicadas. Hace VISIBLE
 * lo que el Excel de recepción no veía: los ajustes de compra de Kepler (X-D-40
 * "Devolución" / X-D-55 "Nota crédito") clasificados por su motivo (`c24`) — descuentos,
 * pronto pago, apoyo de marca — y un detector proactivo de facturas duplicadas (mismo
 * proveedor + monto exacto repetido en pocos días). Superficie Operations (PrimeNG denso).
 */
@Component({
  selector: 'app-compras-descuentos',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, ToastModule, SelectModule, TagModule, InputTextModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in dx-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Descuentos y apoyos</h1>
          <p class="surf-page-sub">Notas de crédito y devoluciones de compra de Kepler (X-D-40 / X-D-55) clasificadas por su motivo: descuentos, apoyos de marca y pronto pago — más un detector de facturas duplicadas.</p>
        </div>
        <div class="dx-toggle" role="tablist">
          <button type="button" class="dx-tog" [class.dx-tog-on]="view() === 'ajustes'" (click)="setView('ajustes')">Ajustes</button>
          <button type="button" class="dx-tog" [class.dx-tog-on]="view() === 'duplicados'" (click)="setView('duplicados')">Posibles duplicados</button>
        </div>
      </header>

      @if (view() === 'ajustes') {
        <div class="dx-kpis">
          @for (g of summary()?.by_grupo || []; track g.key) {
            <div class="dx-kpi" [attr.data-grupo]="g.key">
              <span class="dx-kpi-label">{{ grupoLabel(g.key) }}</span>
              <span class="dx-kpi-val">{{ money(g.monto) }}</span>
              <span class="dx-kpi-sub">{{ g.n | number }} nota(s)</span>
            </div>
          }
          <div class="dx-kpi dx-kpi-total">
            <span class="dx-kpi-label">Total</span>
            <span class="dx-kpi-val">{{ money(summary()?.total?.monto || 0) }}</span>
            <span class="dx-kpi-sub">{{ (summary()?.total?.n || 0) | number }} nota(s)</span>
          </div>
        </div>

        <div class="dx-filters">
          <p-select [options]="grupoOpts" [(ngModel)]="fGrupo" (onChange)="reload()" optionLabel="label" optionValue="value" placeholder="Todos los grupos" [showClear]="true" styleClass="dx-sel"></p-select>
          <p-select [options]="doctypeOpts" [(ngModel)]="fDoctype" (onChange)="reload()" optionLabel="label" optionValue="value" placeholder="Ambos documentos" [showClear]="true" styleClass="dx-sel"></p-select>
          <input pInputText type="text" [(ngModel)]="fSearch" (ngModelChange)="search$.next($event)" placeholder="Proveedor o motivo…" class="dx-search" />
          <span class="dx-count">{{ total() | number }} ajuste(s)</span>
        </div>

        <div class="dx-grid">
          <p-table [value]="rows()" [loading]="loading()" [scrollable]="true" scrollHeight="flex" styleClass="p-datatable-sm dx-table">
            <ng-template #header>
              <tr>
                <th class="dx-w-date">Fecha</th><th class="dx-w-doc">Doc</th><th>Proveedor</th>
                <th class="dx-w-cat">Categoría</th><th>Motivo</th><th class="dx-r dx-w-amt">Monto</th>
              </tr>
            </ng-template>
            <ng-template #body let-a>
              <tr>
                <td class="dx-muted">{{ a.adjustment_date ? (a.adjustment_date | date:'dd/MM/yy') : '—' }}</td>
                <td><span class="dx-doc">{{ a.doctype === 'XD40' ? 'Devolución' : 'Nota créd.' }}</span></td>
                <td class="dx-prov">{{ a.proveedor_nombre || a.proveedor_code || '—' }}</td>
                <td><p-tag [value]="catLabel(a.categoria)" [severity]="grupoTag(a.grupo)"></p-tag></td>
                <td class="dx-motivo" [title]="a.motivo || ''">{{ a.motivo || '—' }}</td>
                <td class="dx-r dx-strong">{{ money(a.monto) }}</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="6" class="dx-empty">Sin ajustes con estos filtros.</td></tr>
            </ng-template>
          </p-table>

          <aside class="dx-side">
            <h2 class="dx-side-title">Top proveedores</h2>
            @for (s of suppliers(); track s.proveedor_code) {
              <div class="dx-supplier">
                <span class="dx-supplier-name" [title]="s.proveedor_nombre || ''">{{ s.proveedor_nombre || s.proveedor_code || '—' }}</span>
                <span class="dx-supplier-val">{{ money(s.monto) }}</span>
              </div>
            }
            @if (!suppliers().length) { <p class="dx-empty">—</p> }
          </aside>
        </div>
      } @else {
        <div class="dx-dup-banner">
          <span class="dx-dup-risk">{{ money(dupRisk()) }}</span>
          <span class="dx-dup-txt">en riesgo · <strong>{{ dupGroups() | number }}</strong> proveedores facturaron el <strong>mismo monto exacto ≥2 veces</strong> dentro de {{ dupWindow() }} días. Revisar: posible captura doble del comprobante.</span>
        </div>
        <p-table [value]="dups()" [loading]="dupsLoading()" [scrollable]="true" scrollHeight="flex" styleClass="p-datatable-sm dx-table">
          <ng-template #header>
            <tr>
              <th>Proveedor</th><th class="dx-r dx-w-amt">Monto</th><th class="dx-r dx-w-x">Veces</th>
              <th class="dx-w-per">Periodo</th><th>Folios</th><th class="dx-r dx-w-amt">$ en riesgo</th>
            </tr>
          </ng-template>
          <ng-template #body let-d>
            <tr>
              <td class="dx-prov">{{ d.proveedor_nombre || d.proveedor_code || '—' }}</td>
              <td class="dx-r">{{ money(d.monto) }}</td>
              <td class="dx-r dx-strong">×{{ d.veces }}</td>
              <td class="dx-muted">{{ d.desde | date:'dd/MM/yy' }}<span *ngIf="d.span_dias > 0"> – {{ d.hasta | date:'dd/MM/yy' }} ({{ d.span_dias }}d)</span></td>
              <td class="dx-mono">{{ (d.folios || []).join(', ') }}</td>
              <td class="dx-r dx-strong dx-bad">{{ money(d.monto_riesgo) }}</td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="6" class="dx-empty">Sin duplicados potenciales en la ventana.</td></tr>
          </ng-template>
        </p-table>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .surf-page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
    .dx-toggle { display: inline-flex; border: 1px solid var(--surf-border, var(--border, #e5e1dc)); border-radius: var(--radius-md, 8px); overflow: hidden; flex: 0 0 auto; }
    .dx-tog { border: 0; background: transparent; padding: .4rem .8rem; font-size: .82rem; cursor: pointer; color: var(--text-muted); }
    .dx-tog-on { background: var(--surf-2, var(--surface-hover, #f2efeb)); color: var(--text, inherit); font-weight: 600; }
    .dx-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: .6rem; margin-bottom: .9rem; }
    .dx-kpi { display: flex; flex-direction: column; gap: .15rem; padding: .7rem .85rem; border: 1px solid var(--surf-border, var(--border, #e5e1dc)); border-left: 3px solid var(--surf-border, var(--border, #e5e1dc)); border-radius: var(--radius-md, 8px); background: var(--surf-card, var(--surface-card, #fff)); }
    .dx-kpi[data-grupo="comercial"] { border-left-color: var(--action, #c2410c); }
    .dx-kpi[data-grupo="error"] { border-left-color: var(--bad-fg, #b91c1c); }
    .dx-kpi[data-grupo="operacional"] { border-left-color: var(--warn-fg, #b45309); }
    .dx-kpi-total { border-left-color: var(--text, #1c1917); }
    .dx-kpi-label { font-size: .72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .02em; }
    .dx-kpi-val { font-size: 1.25rem; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text, inherit); }
    .dx-kpi-sub { font-size: .74rem; color: var(--text-muted); }
    .dx-filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-bottom: .75rem; }
    .dx-sel { min-width: 12rem; }
    .dx-search { min-width: 14rem; }
    .dx-count { color: var(--text-muted); font-size: .82rem; margin-left: auto; }
    .dx-grid { display: grid; grid-template-columns: 1fr 15rem; gap: .9rem; align-items: start; }
    @media (max-width: 900px) { .dx-grid { grid-template-columns: 1fr; } }
    .dx-table { font-size: .82rem; }
    .dx-r { text-align: right; font-variant-numeric: tabular-nums; }
    .dx-w-date { width: 5.5rem; } .dx-w-doc { width: 6rem; } .dx-w-cat { width: 9rem; } .dx-w-amt { width: 7rem; } .dx-w-x { width: 4rem; } .dx-w-per { width: 11rem; }
    .dx-muted { color: var(--text-muted); }
    .dx-strong { font-weight: 700; }
    .dx-bad { color: var(--bad-fg, #b91c1c); }
    .dx-doc { font-size: .74rem; color: var(--text-muted); }
    .dx-prov { max-width: 18rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dx-motivo { max-width: 22rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }
    .dx-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .76rem; color: var(--text-muted); }
    .dx-empty { color: var(--text-muted); padding: 1rem; text-align: center; }
    .dx-side { border: 1px solid var(--surf-border, var(--border, #e5e1dc)); border-radius: var(--radius-md, 8px); padding: .7rem .85rem; background: var(--surf-card, var(--surface-card, #fff)); }
    .dx-side-title { font-size: .82rem; font-weight: 700; margin: 0 0 .5rem; }
    .dx-supplier { display: flex; justify-content: space-between; gap: .5rem; padding: .28rem 0; border-bottom: 1px solid var(--surf-border, var(--border, #f0ece7)); font-size: .8rem; }
    .dx-supplier:last-child { border-bottom: 0; }
    .dx-supplier-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dx-supplier-val { font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; }
    .dx-dup-banner { display: flex; align-items: baseline; gap: .5rem; padding: .6rem .85rem; margin-bottom: .75rem; border: 1px solid var(--surf-border, var(--border, #e5e1dc)); border-left: 3px solid var(--bad-fg, #b91c1c); border-radius: var(--radius-md, 8px); background: var(--surf-card, var(--surface-card, #fff)); }
    .dx-dup-risk { font-size: 1.15rem; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--bad-fg, #b91c1c); }
    .dx-dup-txt { font-size: .84rem; color: var(--text-muted); }
  `],
})
export class ComprasDescuentosComponent implements OnInit {
  private readonly api = inject(ComprasService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  view = signal<ViewMode>('ajustes');

  summary = signal<AdjustmentsSummary | null>(null);
  rows = signal<AdjustmentRow[]>([]);
  suppliers = signal<AdjustmentsSupplierRow[]>([]);
  total = signal(0);
  loading = signal(false);

  dups = signal<DuplicateGroup[]>([]);
  dupsLoading = signal(false);
  dupRisk = signal(0);
  dupGroups = signal(0);
  dupWindow = signal(30);
  private dupsLoaded = false;

  fGrupo = '';
  fDoctype = '';
  fSearch = '';
  search$ = new Subject<string>();

  grupoOpts = [
    { label: 'Descuentos y apoyos', value: 'comercial' },
    { label: 'Faltantes / devoluciones', value: 'operacional' },
    { label: 'Errores de captura', value: 'error' },
    { label: 'Sin clasificar', value: 'sin_clasificar' },
  ];
  doctypeOpts = [
    { label: 'Nota de crédito', value: 'XD55' },
    { label: 'Devolución de compra', value: 'XD40' },
  ];

  private readonly CAT_LABEL: Record<string, string> = {
    faltante: 'Faltante', no_solicitado: 'No solicitado', mal_estado: 'Mal estado', cambiada: 'Cambios/reposición',
    devolucion_otra: 'Devolución', factura_duplicada: 'Factura duplicada', diferencia_monto: 'Diferencia de monto',
    pronto_pago: 'Pronto pago', apoyo_marca: 'Apoyo de marca', descuento_comercial: 'Descuento comercial',
    saldo_favor: 'Saldo a favor', otro: 'Otro',
  };
  private readonly GRUPO_LABEL: Record<string, string> = {
    comercial: 'Descuentos y apoyos', operacional: 'Faltantes / devoluciones', error: 'Errores de captura', sin_clasificar: 'Sin clasificar',
  };

  ngOnInit(): void {
    this.search$.pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef)).subscribe(() => this.reload());
    this.loadSummary();
    this.reload();
  }

  setView(v: ViewMode): void {
    this.view.set(v);
    if (v === 'duplicados' && !this.dupsLoaded) this.loadDuplicates();
  }

  private query() {
    return { grupo: this.fGrupo || undefined, doctype: this.fDoctype || undefined, search: this.fSearch.trim() || undefined };
  }

  loadSummary(): void {
    this.api.adjustmentsSummary(this.query()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => this.summary.set(s),
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el resumen.' }),
    });
    this.api.adjustmentsBySupplier(this.query()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.suppliers.set(r.slice(0, 12)),
      error: () => {},
    });
  }

  reload(): void {
    this.loading.set(true);
    this.api.adjustments({ ...this.query(), pageSize: 200 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.rows.set(r.rows); this.total.set(r.total); this.loading.set(false); this.loadSummary(); },
      error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar los ajustes.' }); },
    });
  }

  loadDuplicates(): void {
    this.dupsLoading.set(true);
    this.api.adjustmentsDuplicates(30).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.dups.set(r.rows); this.dupRisk.set(r.total_riesgo); this.dupGroups.set(r.groups); this.dupWindow.set(r.window_days); this.dupsLoading.set(false); this.dupsLoaded = true; },
      error: () => { this.dupsLoading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar los duplicados.' }); },
    });
  }

  money(v: number | string | null | undefined) { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  grupoLabel(k: string) { return this.GRUPO_LABEL[k] || k; }
  catLabel(c: string | null) { return c ? (this.CAT_LABEL[c] || c) : 'Sin motivo'; }
  grupoTag(g: string): Sev { return ({ comercial: 'success', error: 'danger', operacional: 'warn', sin_clasificar: 'secondary' } as Record<string, Sev>)[g] || 'secondary'; }
}
