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
import { SelectButtonModule } from 'primeng/selectbutton';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { CONTABILIDAD_TABS } from '../contabilidad-tabs';
import { ListasSatService, SatListMatch, RfcIssue, ListasStats, ListStatus, ExpenseDoc, FiscalEstado } from '../listas-sat.service';

/**
 * FISCAL.0/1 — Bandeja de riesgo de listas SAT (EFOS 69-B, Art. 69) + RFC issues.
 * Superficie Operations (proyecto Finanzas): estado de las listas cargadas + KPIs
 * de exposición + tabla densa de proveedores en lista con drill a documentos y
 * triage. Los hallazgos también se consolidan en la bandeja de Maat (Hallazgos).
 */
@Component({
  selector: 'app-contabilidad-listas-sat',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, InputTextModule, IconFieldModule, InputIconModule, SelectModule, SelectButtonModule, TagModule, PageTabsComponent, MetricStripComponent, FreshnessPillComponent, ContextHelpComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in ls-page">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs" variant="liquid" />

      <header class="surf-page-head ls-head">
        <div class="surf-page-head-text">
          <h1 class="ls-h1">Listas SAT <app-context-help topic="listas-sat" /></h1>
          <p class="surf-page-sub">Proveedores del negocio que aparecen en las listas negras del SAT (EFOS 69-B y Art. 69) y RFCs con problema de captura. El cruce es determinista sobre tus egresos; el triage alimenta a Maat.</p>
        </div>
        <div class="ls-head-actions">
          @if (loadedAt()) { <app-freshness-pill [since]="loadedAt()" /> }
          <button pButton type="button" label="Escanear" icon="pi pi-bolt" class="p-button-sm p-button-outlined" [loading]="scanning()" (click)="scan()"></button>
          <button pButton type="button" label="Refrescar listas SAT" icon="pi pi-cloud-download" class="p-button-sm p-button-text" [loading]="refreshing()" (click)="refresh()"></button>
        </div>
      </header>

      <!-- Estado de las listas cargadas -->
      <div class="ls-status">
        @for (s of status(); track s.lista) {
          <div class="ls-status-chip" [class.stale]="s.edad_horas != null && s.edad_horas > 72" [class.off]="!s.cargada">
            <span class="ls-status-name">{{ s.label }}</span>
            @if (s.cargada) {
              <span class="ls-status-meta">{{ s.total_rfcs | number }} RFC · {{ ageLabel(s.edad_horas) }}</span>
            } @else {
              <span class="ls-status-meta">sin cargar</span>
            }
          </div>
        }
        @if (!status().length && !loading()) {
          <div class="ls-status-chip off"><span class="ls-status-meta">No hay listas cargadas — corre "Refrescar listas SAT"</span></div>
        }
      </div>

      <!-- KPIs -->
      @if (stats()) {
        <app-metric-strip [items]="kpiItems()" ariaLabel="Resumen de listas SAT" />
      }

      <!-- Filtros -->
      <div class="ls-filters">
        <p-selectButton styleClass="sb-liquid" [options]="listaOpts" [ngModel]="lista()" (ngModelChange)="lista.set($event)" optionLabel="label" optionValue="value" [allowEmpty]="false" ariaLabel="Filtrar por lista" />
        <p-selectButton styleClass="sb-liquid" [options]="estadoOpts" [ngModel]="estado()" (ngModelChange)="estado.set($event)" optionLabel="label" optionValue="value" [allowEmpty]="false" ariaLabel="Filtrar por estado de triage" />
        <p-iconfield iconPosition="left" styleClass="ls-search">
          <p-inputicon styleClass="pi pi-search" />
          <input type="text" pInputText placeholder="Buscar RFC o proveedor…" [ngModel]="search()" (ngModelChange)="search.set($event)" aria-label="Buscar proveedor" />
        </p-iconfield>
        <label class="ls-fld"><span>Severidad</span>
          <p-select [options]="sevOpts" [ngModel]="sev()" (ngModelChange)="sev.set($event)" optionLabel="label" optionValue="value" styleClass="ls-sel sel-liquid" ariaLabel="Filtrar por severidad" />
        </label>
      </div>

      <!-- Tabla de coincidencias -->
      <div class="card-premium card-flat">
        <p-table [value]="filteredMatches()" styleClass="p-datatable-sm ls-table" [rowHover]="true" [loading]="loading()"
                 dataKey="id" [expandedRowKeys]="expanded()" [scrollable]="true" scrollHeight="520px"
                 [paginator]="filteredMatches().length > 50" [rows]="50">
          <ng-template pTemplate="header">
            <tr>
              <th style="width:2.5rem"></th>
              <th style="width:6rem">Situación</th>
              <th>Proveedor</th>
              <th style="width:7rem">Lista</th>
              <th class="ta-r" style="width:5rem">Docs</th>
              <th class="ta-r" style="width:9rem">Importe</th>
              <th style="width:13rem">Acciones</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-m let-expanded="expanded">
            <tr>
              <td><button pButton type="button" [icon]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" class="p-button-text p-button-sm" [attr.aria-label]="expanded ? 'Ocultar documentos' : 'Ver documentos'" (click)="toggle(m)"></button></td>
              <td><p-tag [value]="m.situacion" [severity]="sevSev(m.situacion)" styleClass="ls-chip" /></td>
              <td>
                <div class="ls-name">{{ m.nombre || m.rfc }}</div>
                <div class="ls-rfc mono">{{ m.rfc }}</div>
              </td>
              <td><p-tag [value]="listaLabel(m.lista)" severity="secondary" styleClass="ls-chip" /></td>
              <td class="ta-r mono">{{ m.doc_count | number }}</td>
              <td class="ta-r strong mono">{{ money(m.importe_total) }}</td>
              <td>
                <div class="ls-acts">
                  @if (m.estado === 'nuevo' || m.estado === 'en_revision') {
                    <button pButton type="button" icon="pi pi-check" label="Revisado" class="p-button-sm p-button-success p-button-text" title="Marcar como confirmado" (click)="setEstado(m, 'confirmado')"></button>
                    <button pButton type="button" icon="pi pi-times" class="p-button-sm p-button-danger p-button-text" title="Descartar (falso positivo / RFC homónimo)" (click)="setEstado(m, 'descartado')"></button>
                  } @else {
                    <span class="ls-status-label" [ngClass]="'st-' + m.estado">{{ estadoLabel(m.estado) }}</span>
                    <button pButton type="button" icon="pi pi-undo" class="p-button-sm p-button-text" title="Reabrir" (click)="setEstado(m, 'nuevo')"></button>
                  }
                </div>
              </td>
            </tr>
          </ng-template>
          <ng-template pTemplate="rowexpansion" let-m>
            <tr><td colspan="7" class="ls-ev">
              @if (docsLoading()[m.rfc]) {
                <div class="ls-ev-loading">Cargando documentos…</div>
              } @else if (docs()[m.rfc]?.length) {
                <p-table [value]="docs()[m.rfc] || []" styleClass="p-datatable-sm ls-docs-tbl" [rowHover]="true">
                  <ng-template pTemplate="header"><tr><th>Fecha</th><th>Sucursal</th><th>Documento</th><th>Concepto</th><th class="ta-r">Importe</th></tr></ng-template>
                  <ng-template pTemplate="body" let-d>
                    <tr>
                      <td class="mono">{{ d.fecha | date:'dd/MM/yy' }}</td>
                      <td>{{ d.sucursal }}</td>
                      <td class="mono">{{ d.doc_tipo }} {{ d.doc_folio }}</td>
                      <td class="ls-doc-concepto">{{ d.concepto || '—' }}</td>
                      <td class="ta-r mono">{{ money(d.importe) }}</td>
                    </tr>
                  </ng-template>
                </p-table>
              } @else {
                <div class="ls-ev-empty">Sin documentos para este RFC en el periodo cargado.</div>
              }
            </td></tr>
          </ng-template>
          <ng-template pTemplate="emptymessage"><tr><td colspan="7" class="ls-empty">
            @if (loading()) { Cargando… }
            @else { Ningún proveedor coincide con {{ lista() === 'all' ? 'las listas SAT' : listaLabel(lista()) }} en estado "{{ estado() }}". Corre "Escanear" o revisa otro filtro. }
          </td></tr></ng-template>
        </p-table>
      </div>

      <!-- RFC con problema estructural -->
      @if (rfcIssues().length) {
        <div class="card-premium card-flat ls-issues">
          <h3 class="ls-card-title">RFC de proveedor con problema <span class="muted">({{ rfcIssues().length }})</span></h3>
          <p-table [value]="rfcIssues()" styleClass="p-datatable-sm ls-table" [rowHover]="true">
            <ng-template pTemplate="header">
              <tr><th>RFC</th><th style="width:11rem">Problema</th><th class="ta-r" style="width:5rem">Docs</th><th class="ta-r" style="width:9rem">Importe</th><th style="width:11rem">Acciones</th></tr>
            </ng-template>
            <ng-template pTemplate="body" let-it>
              <tr>
                <td class="mono">{{ it.rfc }}</td>
                <td><p-tag [value]="issueLabel(it.issue_type)" severity="warn" styleClass="ls-chip" /></td>
                <td class="ta-r mono">{{ it.doc_count | number }}</td>
                <td class="ta-r mono">{{ money(it.importe_total) }}</td>
                <td>
                  @if (it.estado === 'nuevo' || it.estado === 'en_revision') {
                    <button pButton type="button" icon="pi pi-check" label="Revisado" class="p-button-sm p-button-success p-button-text" (click)="setIssueEstado(it, 'confirmado')"></button>
                    <button pButton type="button" icon="pi pi-times" class="p-button-sm p-button-danger p-button-text" title="Descartar" (click)="setIssueEstado(it, 'descartado')"></button>
                  } @else {
                    <span class="ls-status-label" [ngClass]="'st-' + it.estado">{{ estadoLabel(it.estado) }}</span>
                  }
                </td>
              </tr>
            </ng-template>
          </p-table>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ls-head { display: flex; align-items: flex-start; gap: 1rem; }
    .ls-h1 { display: inline-flex; align-items: center; gap: .3rem; }
    .ls-head-actions { margin-left: auto; display: flex; gap: .4rem; align-items: center; }
    .ls-status { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1rem; }
    .ls-status-chip { display: inline-flex; flex-direction: column; gap: .1rem; border: 1px solid var(--border-color); border-radius: var(--r-md); padding: .45rem .8rem; background: var(--card-bg); }
    .ls-status-chip.stale { border-color: color-mix(in srgb, var(--warn-fg) 45%, var(--border-color)); }
    .ls-status-chip.off { opacity: .7; }
    .ls-status-name { font-size: .8rem; font-weight: 600; color: var(--text-main); }
    .ls-status-meta { font-size: .7rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    app-metric-strip { display:block; margin-bottom: 1rem; }
    .ls-filters { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: .8rem; }
    .ls-search input { min-width: 220px; }
    :host ::ng-deep .ls-chip .p-tag { font-size: .66rem; font-weight: 700; padding: .1rem .5rem; text-transform: capitalize; }
    .ls-fld { display: flex; flex-direction: column; gap: .15rem; font-size: .68rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
    .ls-filters { align-items: flex-end; }
    .ls-table { font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; } .strong { font-weight: 700; } .muted { color: var(--text-muted); }
    .bad { color: var(--bad-fg); }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; }
    .ls-name { font-weight: 600; color: var(--text-main); }
    .ls-rfc { color: var(--text-muted); margin-top: .05rem; }
    .ls-acts { display: flex; align-items: center; gap: .1rem; }
    .ls-status-label { font-size: .75rem; font-weight: 600; }
    .st-confirmado { color: var(--ok-fg); } .st-descartado { color: var(--text-faint); }
    .ls-ev { background: var(--surface-hover-bg); padding: .8rem 1.2rem; }
    .ls-ev-loading, .ls-ev-empty { font-size: .82rem; color: var(--text-muted); padding: .4rem 0; }
    .ls-doc-concepto { max-width: 30ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }
    .ls-empty { padding: 2rem; text-align: center; color: var(--text-muted); }
    .ls-issues { padding: 1rem; margin-top: 1rem; }
    .ls-card-title { margin: 0 0 .6rem; font-size: .85rem; font-weight: 700; color: var(--text-main); }
  `],
})
export class ContabilidadListasSatComponent implements OnInit {
  readonly tabs = CONTABILIDAD_TABS;
  private readonly svc = inject(ListasSatService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly allMatches = signal<SatListMatch[]>([]);
  readonly rfcIssues = signal<RfcIssue[]>([]);
  readonly stats = signal<ListasStats | null>(null);
  readonly status = signal<ListStatus[]>([]);
  readonly loading = signal(false);
  readonly scanning = signal(false);
  readonly refreshing = signal(false);
  readonly lista = signal<'all' | '69B' | '69'>('all');
  readonly estado = signal<'pendientes' | 'confirmado' | 'descartado'>('pendientes');
  readonly loadedAt = signal<number | null>(null);
  readonly listaOpts = [{ label: 'Todas', value: 'all' }, { label: 'EFOS 69-B', value: '69B' }, { label: 'Art. 69', value: '69' }];
  readonly estadoOpts = [{ label: 'Pendientes', value: 'pendientes' }, { label: 'Confirmados', value: 'confirmado' }, { label: 'Descartados', value: 'descartado' }];
  readonly search = signal('');
  readonly sev = signal<'all' | 'critical' | 'warn' | 'info'>('all');
  readonly sevOpts = [{ label: 'Todas', value: 'all' }, { label: 'Crítica', value: 'critical' }, { label: 'Media', value: 'warn' }, { label: 'Baja', value: 'info' }];
  readonly expanded = signal<Record<string, boolean>>({});
  readonly docs = signal<Record<string, ExpenseDoc[]>>({});
  readonly docsLoading = signal<Record<string, boolean>>({});

  readonly filteredMatches = computed(() => {
    const l = this.lista();
    const e = this.estado();
    const q = this.search().trim().toLowerCase();
    const sv = this.sev();
    return this.allMatches().filter((m) => {
      if (l !== 'all' && m.lista !== l) return false;
      if (e === 'pendientes') { if (!(m.estado === 'nuevo' || m.estado === 'en_revision')) return false; }
      else if (m.estado !== e) return false;
      if (sv !== 'all' && this.sevOf(m.situacion) !== sv) return false;
      if (q && !(`${m.nombre || ''} ${m.rfc || ''}`.toLowerCase().includes(q))) return false;
      return true;
    });
  });
  readonly totalMatches = computed(() => this.allMatches().length);
  readonly totalRfcIssues = computed(() => this.rfcIssues().length);
  readonly kpiItems = computed<MetricStripItem[]>(() => {
    const s = this.stats();
    if (!s) return [];
    return [
      { label: 'Proveedores en riesgo', value: s.pendientes_riesgo, tone: s.pendientes_riesgo > 0 ? 'bad' : 'default' },
      { label: '$ expuesto en riesgo', value: s.exposicion_riesgo_mxn, format: 'currency' },
      { label: 'Coincidencias totales', value: this.totalMatches() },
      { label: 'RFC con problema', value: this.totalRfcIssues(), tone: this.totalRfcIssues() > 0 ? 'bad' : 'default' },
    ];
  });

  ngOnInit() { this.reload(); }

  private reload() {
    this.loading.set(true);
    this.svc.matches({ limit: 1000 }).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => { this.allMatches.set(r); this.loading.set(false); this.loadedAt.set(Date.now()); }, error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar las coincidencias.' }); } });
    this.svc.stats().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (s) => this.stats.set(s), error: () => {} });
    this.svc.status().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (s) => this.status.set(s), error: () => {} });
    this.svc.rfcIssues({ limit: 500 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.rfcIssues.set(r), error: () => {} });
  }

  scan() {
    this.scanning.set(true);
    this.svc.scan().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.scanning.set(false); const nuevos = (r.maat?.inserted ?? 0); this.toast.add({ severity: 'success', summary: 'Escaneo listo', detail: `Cruce y validación completos. ${nuevos} hallazgo(s) nuevo(s) enviado(s) a Maat.` }); this.reload(); },
      error: () => { this.scanning.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo escanear (requiere permiso de gestión).' }); },
    });
  }

  refresh() {
    this.refreshing.set(true);
    this.svc.refresh().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.refreshing.set(false); this.toast.add({ severity: 'success', summary: 'Listas actualizadas', detail: `${r.matched} coincidencia(s), ${r.issues} RFC con problema.` }); this.reload(); },
      error: () => { this.refreshing.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron refrescar las listas del SAT.' }); },
    });
  }

  toggle(m: SatListMatch) {
    const isOpen = !!this.expanded()[m.id];
    this.expanded.update((e) => { const c = { ...e }; if (isOpen) delete c[m.id]; else c[m.id] = true; return c; });
    if (!isOpen && !this.docs()[m.rfc]) this.loadDocs(m.rfc);
  }

  private loadDocs(rfc: string) {
    this.docsLoading.update((d) => ({ ...d, [rfc]: true }));
    this.svc.documents(rfc).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.docs.update((d) => ({ ...d, [rfc]: r })); this.docsLoading.update((d) => ({ ...d, [rfc]: false })); },
      error: () => { this.docs.update((d) => ({ ...d, [rfc]: [] })); this.docsLoading.update((d) => ({ ...d, [rfc]: false })); },
    });
  }

  setEstado(m: SatListMatch, estado: FiscalEstado) {
    const prev = m.estado;
    this.allMatches.update((arr) => arr.map((x) => x.id === m.id ? { ...x, estado } : x)); // optimista
    this.svc.setMatchEstado(m.id, estado).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.svc.stats().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (s) => this.stats.set(s), error: () => {} }); },
      error: () => { this.allMatches.update((arr) => arr.map((x) => x.id === m.id ? { ...x, estado: prev } : x)); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo actualizar (requiere permiso de gestión).' }); },
    });
  }

  setIssueEstado(it: RfcIssue, estado: FiscalEstado) {
    const prev = it.estado;
    this.rfcIssues.update((arr) => arr.map((x) => x.id === it.id ? { ...x, estado } : x));
    this.svc.setIssueEstado(it.id, estado).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {}, error: () => { this.rfcIssues.update((arr) => arr.map((x) => x.id === it.id ? { ...x, estado: prev } : x)); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo actualizar.' }); },
    });
  }

  sevOf(situacion: string): 'critical' | 'warn' | 'info' {
    const s = (situacion || '').toLowerCase();
    if (s === 'definitivo' || s === 'firme') return 'critical';
    if (['presunto', 'no localizado', 'exigible', 'sentencia'].includes(s)) return 'warn';
    return 'info';
  }
  sevSev(situacion: string): 'danger' | 'warn' | 'secondary' { const s = this.sevOf(situacion); return s === 'critical' ? 'danger' : s === 'warn' ? 'warn' : 'secondary'; }
  listaLabel(l: string): string { return l === '69B' ? 'EFOS 69-B' : l === '69' ? 'Art. 69' : l; }
  issueLabel(t: string): string { return t === 'formato_invalido' ? 'Formato inválido' : t === 'rfc_generico' ? 'RFC genérico' : t; }
  estadoLabel(e: string): string { return e === 'confirmado' ? 'Confirmado' : e === 'descartado' ? 'Descartado' : e === 'en_revision' ? 'En revisión' : 'Nuevo'; }
  ageLabel(h: number | null): string { if (h == null) return '—'; if (h < 1) return 'reciente'; if (h < 24) return `hace ${Math.round(h)}h`; return `hace ${Math.round(h / 24)}d`; }
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
