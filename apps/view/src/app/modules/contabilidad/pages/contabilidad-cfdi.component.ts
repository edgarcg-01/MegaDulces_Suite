import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { InputTextModule } from 'primeng/inputtext';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { CONTABILIDAD_TABS } from '../contabilidad-tabs';
import { CfdiService, CfdiRow, CfdiStats, CfdiFilters } from '../cfdi.service';

/**
 * FISCAL.4.2 — Almacén de CFDI 4.0 (Operations). KPIs de exposición + filtros
 * (rol/tipo/método/fechas/búsqueda) + tabla densa. Los CFDI se pueblan al correr
 * la descarga masiva; vacío = estado esperado hasta entonces (no error).
 */
@Component({
  selector: 'app-contabilidad-cfdi',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, InputTextModule, PageTabsComponent, MetricStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs" />

      <header class="surf-page-head cf-head">
        <div class="surf-page-head-text">
          <h1>CFDI</h1>
          <p class="surf-page-sub">Almacén de comprobantes 4.0 descargados del SAT. Se pobla al correr la descarga masiva. Cifras en flujo de emisión.</p>
        </div>
        <div class="cf-head-actions">
          <div class="cf-seg" role="tablist" aria-label="Rol">
            <button role="tab" [attr.aria-selected]="rol()==='recibidas'" [class.active]="rol()==='recibidas'" (click)="setRol('recibidas')">Recibidas</button>
            <button role="tab" [attr.aria-selected]="rol()==='emitidas'" [class.active]="rol()==='emitidas'" (click)="setRol('emitidas')">Emitidas</button>
            <button role="tab" [attr.aria-selected]="rol()==='all'" [class.active]="rol()==='all'" (click)="setRol('all')">Todos</button>
          </div>
        </div>
      </header>

      @if (stats(); as s) {
        <app-metric-strip [items]="kpiItems(s)" ariaLabel="Resumen de CFDI" />
      }

      <div class="cf-filters">
        <span class="p-input-icon-left cf-search">
          <i class="pi pi-search"></i>
          <input type="text" pInputText placeholder="Buscar RFC, nombre, folio, UUID…" [(ngModel)]="search" (keyup.enter)="applyFilters()" aria-label="Buscar CFDI" />
        </span>
        <label class="cf-field"><span>Desde</span><input type="date" [(ngModel)]="from" (change)="applyFilters()" /></label>
        <label class="cf-field"><span>Hasta</span><input type="date" [(ngModel)]="to" (change)="applyFilters()" /></label>
        <div class="cf-seg">
          <button [class.active]="tipo()==='all'" (click)="setTipo('all')">Todos</button>
          <button [class.active]="tipo()==='I'" (click)="setTipo('I')" title="Ingreso">I</button>
          <button [class.active]="tipo()==='E'" (click)="setTipo('E')" title="Egreso">E</button>
          <button [class.active]="tipo()==='P'" (click)="setTipo('P')" title="Pago (REP)">P</button>
        </div>
        <button pButton type="button" label="Buscar" icon="pi pi-filter" class="p-button-sm p-button-outlined" (click)="applyFilters()"></button>
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
              <th style="width:7rem">Estatus</th>
              <th style="width:3rem"></th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-c>
            <tr>
              <td><span class="cf-tipo" [ngClass]="'t-' + (c.tipo_comprobante || 'x')">{{ c.tipo_comprobante || '—' }}</span></td>
              <td><div class="cf-name">{{ c.emisor_nombre || c.emisor_rfc || '—' }}</div><div class="cf-rfc mono">{{ c.emisor_rfc }}</div></td>
              <td><div class="cf-name">{{ c.receptor_nombre || c.receptor_rfc || '—' }}</div><div class="cf-rfc mono">{{ c.receptor_rfc }}</div></td>
              <td class="mono">{{ c.fecha ? (c.fecha | date:'dd/MM/yy') : '—' }}</td>
              <td>@if (c.metodo_pago) { <span class="cf-tag">{{ c.metodo_pago }}</span> } @else { — }</td>
              <td class="ta-r strong mono">{{ money(c.total) }}</td>
              <td><span class="cf-est" [ngClass]="'e-' + c.estatus_sat">{{ estatusLabel(c.estatus_sat) }}</span></td>
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
    .cf-head-actions { margin-left: auto; }
    app-metric-strip { display:block; margin-bottom: 1rem; }
    .cf-filters { display: flex; gap: .6rem; flex-wrap: wrap; align-items: flex-end; margin-bottom: .8rem; }
    .cf-search input { min-width: 260px; }
    .cf-field { display: flex; flex-direction: column; gap: .15rem; font-size: .68rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
    .cf-field input { border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px); padding: .35rem .5rem; background: var(--card-bg); color: var(--text-main); font-family: var(--font-mono, monospace); }
    .cf-seg { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--r-pill, 999px); overflow: hidden; }
    .cf-seg button { border: none; background: var(--card-bg); padding: .3rem .8rem; font-size: .8rem; cursor: pointer; color: var(--text-muted); }
    .cf-seg button.active { background: var(--action); color: var(--action-ink, #fff); font-weight: 600; }
    .cf-table { font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; } .strong { font-weight: 700; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; }
    .cf-name { font-weight: 600; color: var(--text-main); max-width: 24ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cf-rfc { color: var(--text-muted); margin-top: .05rem; }
    .cf-tag { display: inline-block; padding: .08rem .5rem; border-radius: var(--r-pill, 999px); font-size: .7rem; font-weight: 600; background: var(--surface-hover-bg, #f5f5f4); color: var(--text-muted); }
    .cf-tipo { display: inline-flex; align-items: center; justify-content: center; width: 1.5rem; height: 1.5rem; border-radius: var(--r-sm, 6px); font-size: .72rem; font-weight: 800; background: var(--surface-hover-bg, #f5f5f4); color: var(--text-muted); }
    .cf-tipo.t-P { background: color-mix(in srgb, var(--action) 14%, transparent); color: var(--action); }
    .cf-est { display: inline-block; padding: .1rem .5rem; border-radius: var(--r-pill, 999px); font-size: .66rem; font-weight: 700; }
    .e-vigente { background: color-mix(in srgb, var(--ok-fg, #16a34a) 14%, transparent); color: var(--ok-fg, #16a34a); }
    .e-cancelado { background: color-mix(in srgb, var(--bad-fg, #dc2626) 15%, transparent); color: var(--bad-fg, #dc2626); }
    .e-desconocido { background: var(--surface-hover-bg, #f5f5f4); color: var(--text-muted); }
    .cf-empty { padding: 2.5rem 1rem; text-align: center; color: var(--text-muted); }
    .cf-empty .pi { display: block; font-size: 1.5rem; margin-bottom: .5rem; opacity: .6; }
  `],
})
export class ContabilidadCfdiComponent implements OnInit {
  readonly tabs = CONTABILIDAD_TABS;
  private readonly svc = inject(CfdiService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly rows = signal<CfdiRow[]>([]);
  readonly total = signal(0);
  readonly stats = signal<CfdiStats | null>(null);
  readonly loading = signal(false);
  readonly errored = signal(false);
  readonly rol = signal<'recibidas' | 'emitidas' | 'all'>('recibidas');
  readonly tipo = signal<'all' | 'I' | 'E' | 'P'>('all');
  from = ''; to = ''; search = '';
  private offset = 0;

  ngOnInit() { this.reload(); }

  private filters(): CfdiFilters {
    return {
      rol: this.rol() === 'all' ? undefined : this.rol(),
      tipo: this.tipo() === 'all' ? undefined : this.tipo(),
      from: this.from || undefined, to: this.to || undefined, search: this.search || undefined,
      limit: 50, offset: this.offset,
    };
  }

  reload() {
    this.loading.set(true); this.errored.set(false);
    this.svc.list(this.filters()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.rows.set(r.rows); this.total.set(r.total); this.loading.set(false); },
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

  applyFilters() { this.offset = 0; this.reload(); }
  onPage(e: { first?: number }) { const f = e.first ?? 0; if (f !== this.offset) { this.offset = f; this.reload(); } }
  setRol(r: 'recibidas' | 'emitidas' | 'all') { this.rol.set(r); this.applyFilters(); }
  setTipo(t: 'all' | 'I' | 'E' | 'P') { this.tipo.set(t); this.applyFilters(); }

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
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
