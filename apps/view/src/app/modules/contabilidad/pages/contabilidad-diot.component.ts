import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { CONTABILIDAD_TABS } from '../contabilidad-tabs';
import { DiotService, DiotRow, DiotResult, IvaResumen } from '../diot.service';

/**
 * FISCAL.8.1 — DIOT + resumen de IVA (Operations). Selector de periodo (YYYY-MM),
 * resumen de IVA (acreditable/trasladado → a cargo/favor, con flujo efectivo
 * PUE/PPD) + DIOT por proveedor. Se llena al poblar fiscal.cfdis.
 */
@Component({
  selector: 'app-contabilidad-diot',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, InputTextModule, IconFieldModule, InputIconModule, SelectModule, DatePickerModule, TagModule, PageTabsComponent, MetricStripComponent, FreshnessPillComponent, ContextHelpComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs" variant="liquid" />

      <header class="surf-page-head di-head">
        <div class="surf-page-head-text">
          <h1 class="di-h1">DIOT / IVA <app-context-help topic="diot" /></h1>
          <p class="surf-page-sub">Operaciones con terceros e IVA con flujo efectivo (PUE en emisión, PPD al pagarse el REP). Cálculo determinista sobre los CFDI recibidos/emitidos.</p>
        </div>
        <div class="di-head-actions">
          @if (loadedAt()) { <app-freshness-pill [since]="loadedAt()" /> }
          <label class="di-period"><span>Periodo</span>
            <p-datepicker [(ngModel)]="periodD" (onSelect)="onPeriod()" view="month" dateFormat="mm/yy" [showIcon]="true" appendTo="body" ariaLabel="Periodo (mes)" styleClass="di-dp" />
          </label>
          <button pButton type="button" label="Actualizar" icon="pi pi-refresh" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="reload()"></button>
        </div>
      </header>

      @if (iva(); as v) {
        <app-metric-strip [items]="kpiItems(v)" ariaLabel="Resumen DIOT / IVA" />
      }

      <div class="card-premium card-flat">
        <div class="di-card-head">
          <h3 class="di-card-title">DIOT — operaciones con terceros @if (diot(); as d) { <span class="muted">· {{ d.totales.proveedores | number }} proveedores · IVA {{ money(d.totales.iva16) }}</span> }</h3>
          <div class="di-card-filters">
            <p-iconfield iconPosition="left" styleClass="di-search">
              <p-inputicon styleClass="pi pi-search" />
              <input type="text" pInputText placeholder="Buscar proveedor / RFC…" [ngModel]="search()" (ngModelChange)="search.set($event)" aria-label="Buscar proveedor" />
            </p-iconfield>
            <p-select [options]="terceroOpts" [ngModel]="tercero()" (ngModelChange)="tercero.set($event)" optionLabel="label" optionValue="value" styleClass="di-sel sel-liquid" ariaLabel="Tipo de tercero" />
          </div>
        </div>
        <p-table [value]="filteredRows()" styleClass="p-datatable-sm di-table" [rowHover]="true" [loading]="loading()" [scrollable]="true" scrollHeight="520px" [paginator]="filteredRows().length > 50" [rows]="50">
          <ng-template pTemplate="header">
            <tr>
              <th>Proveedor</th>
              <th style="width:6rem">Tercero</th>
              <th style="width:5rem">Op.</th>
              <th class="ta-r" style="width:10rem">Base</th>
              <th class="ta-r" style="width:9rem">IVA 16%</th>
              <th class="ta-r" style="width:9rem">IVA ret.</th>
              <th class="ta-r" style="width:5rem">CFDI</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-r>
            <tr>
              <td><div class="di-name">{{ r.nombre || r.rfc }}</div><div class="di-rfc mono">{{ r.rfc }}</div></td>
              <td><p-tag [value]="terceroLabel(r.tipo_tercero)" severity="secondary" styleClass="di-chip" /></td>
              <td class="mono">{{ r.tipo_operacion }}</td>
              <td class="ta-r mono">{{ money(r.base) }}</td>
              <td class="ta-r strong mono">{{ money(r.iva16) }}</td>
              <td class="ta-r mono">{{ money(r.iva_retenido) }}</td>
              <td class="ta-r mono">{{ r.num_cfdis | number }}</td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage"><tr><td colspan="7" class="di-empty">
            @if (loading()) { Cargando… }
            @else if (errored()) { <i class="pi pi-exclamation-triangle"></i> No se pudo calcular la DIOT. <button pButton type="button" label="Reintentar" class="p-button-sm p-button-text" (click)="reload()"></button> }
            @else if (hasFilters()) { <i class="pi pi-filter-slash"></i> Ningún proveedor coincide con el filtro. <button pButton type="button" label="Limpiar" class="p-button-sm p-button-text" (click)="clearFilters()"></button> }
            @else { <i class="pi pi-inbox"></i> Sin operaciones con terceros en {{ period }}. Se llena al correr la <strong>descarga masiva</strong> de CFDI. }
          </td></tr></ng-template>
        </p-table>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .di-head { display: flex; align-items: flex-start; gap: 1rem; }
    .di-h1 { display: inline-flex; align-items: center; gap: .3rem; }
    .di-head-actions { margin-left: auto; display: flex; gap: .5rem; align-items: flex-end; }
    .di-period { display: flex; flex-direction: column; gap: .15rem; font-size: .68rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
    app-metric-strip { display:block; margin-bottom: 1rem; }
    .di-card-head { padding: .75rem 1rem .25rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
    .di-card-filters { display: flex; gap: .5rem; align-items: center; }
    .di-search input { min-width: 200px; }
    .di-card-title { margin: 0; font-size: .85rem; font-weight: 700; color: var(--text-main); }
    .muted { color: var(--text-muted); font-weight: 400; }
    .di-table { font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; } .strong { font-weight: 700; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; }
    .di-name { font-weight: 600; color: var(--text-main); max-width: 32ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .di-rfc { color: var(--text-muted); margin-top: .05rem; }
    :host ::ng-deep .di-chip .p-tag { font-size: .68rem; font-weight: 600; padding: .08rem .5rem; }
    .di-empty { padding: 2.5rem 1rem; text-align: center; color: var(--text-muted); }
    .di-empty .pi { display: block; font-size: 1.5rem; margin-bottom: .5rem; opacity: .6; }
  `],
})
export class ContabilidadDiotComponent implements OnInit {
  readonly tabs = CONTABILIDAD_TABS;
  private readonly svc = inject(DiotService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  period = this.currentMonth();
  periodD: Date = new Date();
  readonly loadedAt = signal<number | null>(null);
  readonly diot = signal<DiotResult | null>(null);
  readonly iva = signal<IvaResumen | null>(null);

  kpiItems(v: IvaResumen): MetricStripItem[] {
    return [
      { label: 'IVA trasladado', value: v.iva_trasladado, format: 'currency' },
      { label: 'IVA acreditable', value: v.iva_acreditable, format: 'currency' },
      { label: 'IVA a cargo', value: v.iva_a_cargo, format: 'currency', tone: v.iva_a_cargo > 0 ? 'bad' : 'default' },
      { label: 'IVA a favor', value: v.iva_a_favor, format: 'currency', tone: v.iva_a_favor > 0 ? 'ok' : 'default' },
    ];
  }
  readonly rows = signal<DiotRow[]>([]);
  readonly loading = signal(false);
  readonly errored = signal(false);
  readonly search = signal('');
  readonly tercero = signal<'all' | '04' | '05' | '15'>('all');
  readonly terceroOpts = [{ label: 'Todos los terceros', value: 'all' }, { label: 'Nacional', value: '04' }, { label: 'Extranjero', value: '05' }, { label: 'Global', value: '15' }];
  readonly filteredRows = computed(() => {
    const q = this.search().trim().toLowerCase();
    const t = this.tercero();
    return this.rows().filter((r) => {
      if (t !== 'all' && r.tipo_tercero !== t) return false;
      if (q && !(`${r.nombre || ''} ${r.rfc || ''}`.toLowerCase().includes(q))) return false;
      return true;
    });
  });
  hasFilters(): boolean { return !!(this.search().trim() || this.tercero() !== 'all'); }
  clearFilters() { this.search.set(''); this.tercero.set('all'); }

  ngOnInit() { this.reload(); }

  reload() {
    if (!/^\d{4}-\d{2}$/.test(this.period)) { this.toast.add({ severity: 'warn', summary: 'Periodo inválido', detail: 'Elige un mes válido.' }); return; }
    this.loading.set(true); this.errored.set(false);
    this.svc.build(this.period).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.diot.set(d); this.rows.set(d.rows); this.loading.set(false); this.loadedAt.set(Date.now()); },
      error: () => { this.loading.set(false); this.errored.set(true); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo calcular la DIOT.' }); },
    });
    this.svc.iva(this.period).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (v) => this.iva.set(v), error: () => {} });
  }

  /** El p-datepicker (vista mes) maneja una Date; derivamos el periodo YYYY-MM. */
  onPeriod() { if (this.periodD) { this.period = `${this.periodD.getFullYear()}-${String(this.periodD.getMonth() + 1).padStart(2, '0')}`; this.reload(); } }
  private currentMonth(): string { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
  terceroLabel(t: string): string { return t === '04' ? 'Nacional' : t === '05' ? 'Extranjero' : t === '15' ? 'Global' : t; }
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
