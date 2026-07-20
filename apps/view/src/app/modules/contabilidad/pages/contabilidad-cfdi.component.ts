import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { SelectButtonModule } from 'primeng/selectbutton';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { DatePickerModule } from 'primeng/datepicker';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { CONTABILIDAD_TABS } from '../contabilidad-tabs';
import { CfdiService, CfdiRow, CfdiStats, CfdiFilters } from '../cfdi.service';

/**
 * FISCAL.4.2 — Almacén de CFDI 4.0 (Operations). KPIs de exposición + filtros
 * (rol/tipo/método/fechas/búsqueda) + tabla densa. Los CFDI se pueblan al correr
 * la descarga masiva; vacío = estado esperado hasta entonces (no error).
 * PrimeNG-first: p-selectButton (rol/tipo), p-datepicker (fechas), p-tag (estatus/método).
 */
@Component({
  selector: 'app-contabilidad-cfdi',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, InputTextModule, IconFieldModule, InputIconModule, SelectButtonModule, SelectModule, TagModule, DatePickerModule, PageTabsComponent, MetricStripComponent, FreshnessPillComponent, ContextHelpComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs" variant="liquid" />

      <header class="surf-page-head cf-head">
        <div class="surf-page-head-text">
          <h1 class="cf-h1">CFDI <app-context-help topic="cfdi" /></h1>
          <p class="surf-page-sub">Almacén de comprobantes 4.0 descargados del SAT. Se pobla al correr la descarga masiva. Cifras en flujo de emisión.</p>
        </div>
        <div class="cf-head-actions">
          <p-selectButton [options]="rolOpts" [ngModel]="rol()" (ngModelChange)="setRol($event)" optionLabel="label" optionValue="value" [allowEmpty]="false" styleClass="cf-sb sb-liquid" ariaLabel="Rol de los comprobantes" />
          @if (loadedAt()) { <app-freshness-pill [since]="loadedAt()" /> }
        </div>
      </header>

      @if (stats(); as s) {
        <app-metric-strip [items]="kpiItems(s)" ariaLabel="Resumen de CFDI" />
      }

      <div class="cf-filters">
        <p-iconfield iconPosition="left" styleClass="cf-search">
          <p-inputicon styleClass="pi pi-search" />
          <input type="text" pInputText placeholder="Buscar RFC, nombre, folio, UUID…" [(ngModel)]="search" (keyup.enter)="applyFilters()" aria-label="Buscar CFDI" />
        </p-iconfield>
        <label class="cf-field"><span>Desde</span>
          <p-datepicker [(ngModel)]="fromD" (onSelect)="applyFilters()" (onClear)="applyFilters()" dateFormat="yy-mm-dd" [showIcon]="true" [showClear]="true" appendTo="body" placeholder="Desde" styleClass="cf-dp" />
        </label>
        <label class="cf-field"><span>Hasta</span>
          <p-datepicker [(ngModel)]="toD" (onSelect)="applyFilters()" (onClear)="applyFilters()" dateFormat="yy-mm-dd" [showIcon]="true" [showClear]="true" appendTo="body" placeholder="Hasta" styleClass="cf-dp" />
        </label>
        <p-selectButton [options]="tipoOpts" [ngModel]="tipo()" (ngModelChange)="setTipo($event)" optionLabel="label" optionValue="value" [allowEmpty]="false" styleClass="cf-sb sb-liquid" ariaLabel="Tipo de comprobante" />
        <label class="cf-field"><span>Estatus</span>
          <p-select [options]="estatusOpts" [ngModel]="estatus()" (ngModelChange)="setEstatus($event)" optionLabel="label" optionValue="value" styleClass="cf-sel sel-liquid" ariaLabel="Estatus SAT" />
        </label>
        <label class="cf-field"><span>Método</span>
          <p-select [options]="metodoOpts" [ngModel]="metodo()" (ngModelChange)="setMetodo($event)" optionLabel="label" optionValue="value" styleClass="cf-sel sel-liquid" ariaLabel="Método de pago" />
        </label>
        <button pButton type="button" label="Buscar" icon="pi pi-filter" class="p-button-sm p-button-outlined" (click)="applyFilters()"></button>
        <button pButton type="button" label="Exportar ZIP" icon="pi pi-download" class="p-button-sm p-button-text" [loading]="exporting()" (click)="exportZip()" title="Descarga los XML del filtro actual, en carpetas por RFC (+ índice CSV)"></button>
      </div>

      <div class="card-premium card-flat">
        <p-table [value]="rows()" styleClass="p-datatable-sm cf-table" [rowHover]="true" [loading]="loading()"
                 [scrollable]="true" scrollHeight="560px" [paginator]="total() > 50" [rows]="50" [totalRecords]="total()"
                 [lazy]="true" (onLazyLoad)="onPage($event)">
          <ng-template pTemplate="header">
            <tr>
              <th style="width:4rem">Tipo</th>
              <th>Emisor</th>
              <th>Receptor</th>
              <th style="width:7rem">Fecha</th>
              <th style="width:5rem">Método</th>
              <th class="ta-r" style="width:10rem">Total</th>
              <th style="width:8rem">Estatus</th>
              <th style="width:3rem"></th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-c>
            <tr>
              <td><span class="cf-tipo" [ngClass]="'t-' + (c.tipo_comprobante || 'x')">{{ c.tipo_comprobante || '—' }}</span></td>
              <td><div class="cf-name">{{ c.emisor_nombre || c.emisor_rfc || '—' }}</div><div class="cf-rfc mono">{{ c.emisor_rfc }}</div></td>
              <td><div class="cf-name">{{ c.receptor_nombre || c.receptor_rfc || '—' }}</div><div class="cf-rfc mono">{{ c.receptor_rfc }}</div></td>
              <td class="mono">{{ c.fecha ? (c.fecha | date:'dd/MM/yy') : '—' }}</td>
              <td>@if (c.metodo_pago) { <p-tag [value]="c.metodo_pago" severity="secondary" styleClass="cf-chip" /> } @else { — }</td>
              <td class="ta-r strong mono">{{ money(c.total) }}</td>
              <td><p-tag [value]="estatusLabel(c.estatus_sat)" [severity]="estatusSev(c.estatus_sat)" styleClass="cf-chip" /></td>
              <td class="ta-r">@if (c.has_xml) { <button pButton type="button" icon="pi pi-download" class="p-button-text p-button-sm" title="Descargar XML" aria-label="Descargar XML" (click)="downloadXml(c)"></button> }</td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage"><tr><td colspan="8" class="cf-empty">
            @if (loading()) { Cargando… }
            @else if (errored()) { <i class="pi pi-exclamation-triangle"></i> No se pudieron cargar los CFDI. <button pButton type="button" label="Reintentar" class="p-button-sm p-button-text" (click)="reload()"></button> }
            @else { <i class="pi pi-inbox"></i> Sin CFDI en este filtro. El almacén se llena al correr la <strong>descarga masiva</strong> del SAT. }
          </td></tr></ng-template>
        </p-table>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cf-head { display: flex; align-items: flex-start; gap: 1rem; }
    .cf-h1 { display: inline-flex; align-items: center; gap: .3rem; }
    .cf-head-actions { margin-left: auto; display: flex; flex-direction: column; align-items: flex-end; gap: .4rem; }
    app-metric-strip { display:block; margin-bottom: 1rem; }
    .cf-filters { display: flex; gap: .6rem; flex-wrap: wrap; align-items: flex-end; margin-bottom: .8rem; }
    .cf-search input { min-width: 260px; }
    .cf-field { display: flex; flex-direction: column; gap: .15rem; font-size: .68rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
    .cf-table { font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; } .strong { font-weight: 700; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; }
    .cf-name { font-weight: 600; color: var(--text-main); max-width: 24ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cf-rfc { color: var(--text-muted); margin-top: .05rem; }
    .cf-tipo { display: inline-flex; align-items: center; justify-content: center; width: 1.5rem; height: 1.5rem; border-radius: var(--r-sm); font-size: .72rem; font-weight: 800; background: var(--surface-hover-bg); color: var(--text-muted); }
    .cf-tipo.t-P { background: color-mix(in srgb, var(--action) 14%, transparent); color: var(--action); }
    :host ::ng-deep .cf-chip .p-tag { font-size: .66rem; font-weight: 700; padding: .1rem .5rem; }
    .cf-empty { padding: 2.5rem 1rem; text-align: center; color: var(--text-muted); }
    .cf-empty .pi { display: block; font-size: 1.5rem; margin-bottom: .5rem; opacity: .6; }
  `],
})
export class ContabilidadCfdiComponent implements OnInit {
  readonly tabs = CONTABILIDAD_TABS;
  private readonly svc = inject(CfdiService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly rolOpts = [{ label: 'Recibidas', value: 'recibidas' }, { label: 'Emitidas', value: 'emitidas' }, { label: 'Todos', value: 'all' }];
  readonly tipoOpts = [{ label: 'Todos', value: 'all' }, { label: 'I', value: 'I' }, { label: 'E', value: 'E' }, { label: 'P', value: 'P' }];
  readonly estatusOpts = [{ label: 'Todos', value: 'all' }, { label: 'Vigente', value: 'vigente' }, { label: 'Cancelado', value: 'cancelado' }];
  readonly metodoOpts = [{ label: 'Todos', value: 'all' }, { label: 'PUE', value: 'PUE' }, { label: 'PPD', value: 'PPD' }];

  readonly rows = signal<CfdiRow[]>([]);
  readonly total = signal(0);
  readonly stats = signal<CfdiStats | null>(null);
  readonly loading = signal(false);
  readonly errored = signal(false);
  readonly exporting = signal(false);
  readonly loadedAt = signal<number | null>(null);
  readonly rol = signal<'recibidas' | 'emitidas' | 'all'>('recibidas');
  readonly tipo = signal<'all' | 'I' | 'E' | 'P'>('all');
  readonly estatus = signal<'all' | 'vigente' | 'cancelado'>('all');
  readonly metodo = signal<'all' | 'PUE' | 'PPD'>('all');
  fromD: Date | null = null; toD: Date | null = null; search = '';
  private offset = 0;

  ngOnInit() { this.reload(); }

  /** yyyy-mm-dd local (el backend filtra por fecha, no por instante). */
  private fmt(d: Date | null): string | undefined {
    if (!d) return undefined;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private filters(): CfdiFilters {
    return {
      rol: this.rol() === 'all' ? undefined : this.rol(),
      tipo: this.tipo() === 'all' ? undefined : this.tipo(),
      estatus_sat: this.estatus() === 'all' ? undefined : this.estatus(),
      metodo_pago: this.metodo() === 'all' ? undefined : this.metodo(),
      from: this.fmt(this.fromD), to: this.fmt(this.toD), search: this.search || undefined,
      limit: 50, offset: this.offset,
    };
  }

  reload() {
    this.loading.set(true); this.errored.set(false);
    this.svc.list(this.filters()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.rows.set(r.rows); this.total.set(r.total); this.loading.set(false); this.loadedAt.set(Date.now()); },
      error: () => { this.loading.set(false); this.errored.set(true); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar los CFDI.' }); },
    });
    this.svc.stats(this.filters()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (s) => this.stats.set(s), error: () => {} });
  }

  downloadXml(c: CfdiRow) {
    this.svc.xml(c.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (xml) => {
        const blob = new Blob([xml], { type: 'application/xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `${c.uuid || c.id}.xml`; a.click();
        URL.revokeObjectURL(url);
      },
      error: () => this.toast.add({ severity: 'warn', summary: 'Sin documento', detail: 'Este CFDI no tiene XML guardado. Re-descarga el periodo.' }),
    });
  }

  /** MAT — exporta el filtro actual como ZIP con carpetas por RFC (+ _index.csv). */
  exportZip() {
    this.exporting.set(true);
    this.svc.exportZip(this.filters()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (blob) => {
        this.exporting.set(false);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'expediente-cfdi.zip'; a.click();
        URL.revokeObjectURL(url);
      },
      error: () => { this.exporting.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo generar el ZIP.' }); },
    });
  }

  applyFilters() { this.offset = 0; this.reload(); }
  onPage(e: { first?: number }) { const f = e.first ?? 0; if (f !== this.offset) { this.offset = f; this.reload(); } }
  setRol(r: 'recibidas' | 'emitidas' | 'all') { this.rol.set(r); this.applyFilters(); }
  setTipo(t: 'all' | 'I' | 'E' | 'P') { this.tipo.set(t); this.applyFilters(); }
  setEstatus(e: 'all' | 'vigente' | 'cancelado') { this.estatus.set(e); this.applyFilters(); }
  setMetodo(m: 'all' | 'PUE' | 'PPD') { this.metodo.set(m); this.applyFilters(); }

  ppdCount(s: CfdiStats): number { return Number(s.porMetodo?.find((m) => m.metodo_pago === 'PPD')?.n ?? 0); }

  kpiItems(s: CfdiStats): MetricStripItem[] {
    return [
      { label: 'CFDI', value: s.total },
      { label: 'Monto total', value: s.monto, format: 'currency' },
      { label: 'IVA trasladado', value: s.iva, format: 'currency' },
      { label: 'PPD (crédito)', value: this.ppdCount(s) },
    ];
  }
  estatusLabel(e: string): string { return e === 'vigente' ? 'Vigente' : e === 'cancelado' ? 'Cancelado' : 'Sin verificar'; }
  estatusSev(e: string): 'success' | 'danger' | 'secondary' { return e === 'vigente' ? 'success' : e === 'cancelado' ? 'danger' : 'secondary'; }
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
