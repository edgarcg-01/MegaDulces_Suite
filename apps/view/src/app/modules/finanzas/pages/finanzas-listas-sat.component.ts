import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { FINANZAS_TABS } from '../finanzas-tabs';
import { ListasSatService, SatListMatch, RfcIssue, ListasStats, ListStatus, ExpenseDoc, FiscalEstado } from '../listas-sat.service';

/**
 * FISCAL.0/1 — Bandeja de riesgo de listas SAT (EFOS 69-B, Art. 69) + RFC issues.
 * Superficie Operations (proyecto Finanzas): estado de las listas cargadas + KPIs
 * de exposición + tabla densa de proveedores en lista con drill a documentos y
 * triage. Los hallazgos también se consolidan en la bandeja de Maat (Hallazgos).
 */
@Component({
  selector: 'app-finanzas-listas-sat',
  standalone: true,
  imports: [CommonModule, ButtonModule, TableModule, ToastModule, PageTabsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in ls-page">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs" />

      <header class="surf-page-head ls-head">
        <div class="surf-page-head-text">
          <h1>Listas SAT</h1>
          <p class="surf-page-sub">Proveedores del negocio que aparecen en las listas negras del SAT (EFOS 69-B y Art. 69) y RFCs con problema de captura. El cruce es determinista sobre tus egresos; el triage alimenta a Maat.</p>
        </div>
        <div class="ls-head-actions">
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
      @if (stats(); as s) {
        <div class="ls-kpis">
          <div class="ls-kpi" [class.bad]="s.pendientes_riesgo > 0"><span class="ls-kpi-val">{{ s.pendientes_riesgo | number }}</span><span class="ls-kpi-lbl">Proveedores en riesgo (pendientes)</span></div>
          <div class="ls-kpi"><span class="ls-kpi-val">{{ money(s.exposicion_riesgo_mxn) }}</span><span class="ls-kpi-lbl">$ expuesto en riesgo</span></div>
          <div class="ls-kpi"><span class="ls-kpi-val">{{ totalMatches() | number }}</span><span class="ls-kpi-lbl">Coincidencias totales</span></div>
          <div class="ls-kpi" [class.bad]="totalRfcIssues() > 0"><span class="ls-kpi-val">{{ totalRfcIssues() | number }}</span><span class="ls-kpi-lbl">RFC con problema</span></div>
        </div>
      }

      <!-- Filtros -->
      <div class="ls-filters">
        <div class="ls-seg">
          <button [class.active]="lista() === 'all'" (click)="lista.set('all')">Todas</button>
          <button [class.active]="lista() === '69B'" (click)="lista.set('69B')">EFOS 69-B</button>
          <button [class.active]="lista() === '69'" (click)="lista.set('69')">Art. 69</button>
        </div>
        <div class="ls-seg">
          <button [class.active]="estado() === 'pendientes'" (click)="estado.set('pendientes')">Pendientes</button>
          <button [class.active]="estado() === 'confirmado'" (click)="estado.set('confirmado')">Confirmados</button>
          <button [class.active]="estado() === 'descartado'" (click)="estado.set('descartado')">Descartados</button>
        </div>
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
              <td><span class="ls-sev" [ngClass]="'sev-' + sevOf(m.situacion)">{{ m.situacion }}</span></td>
              <td>
                <div class="ls-name">{{ m.nombre || m.rfc }}</div>
                <div class="ls-rfc mono">{{ m.rfc }}</div>
              </td>
              <td><span class="ls-tag">{{ listaLabel(m.lista) }}</span></td>
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
                <table class="ls-docs">
                  <thead><tr><th>Fecha</th><th>Sucursal</th><th>Documento</th><th>Concepto</th><th class="ta-r">Importe</th></tr></thead>
                  <tbody>
                    @for (d of docs()[m.rfc]; track d.doc_tipo + d.doc_folio + d.sucursal) {
                      <tr>
                        <td class="mono">{{ d.fecha | date:'dd/MM/yy' }}</td>
                        <td>{{ d.sucursal }}</td>
                        <td class="mono">{{ d.doc_tipo }} {{ d.doc_folio }}</td>
                        <td class="ls-doc-concepto">{{ d.concepto || '—' }}</td>
                        <td class="ta-r mono">{{ money(d.importe) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
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
                <td><span class="ls-tag" [ngClass]="'iss-' + it.issue_type">{{ issueLabel(it.issue_type) }}</span></td>
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
    .ls-head-actions { margin-left: auto; display: flex; gap: .4rem; align-items: center; }
    .ls-status { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1rem; }
    .ls-status-chip { display: inline-flex; flex-direction: column; gap: .1rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 10px); padding: .45rem .8rem; background: var(--card-bg); }
    .ls-status-chip.stale { border-color: color-mix(in srgb, var(--warn-fg, #d97706) 45%, var(--border-color)); }
    .ls-status-chip.off { opacity: .7; }
    .ls-status-name { font-size: .8rem; font-weight: 600; color: var(--text-main); }
    .ls-status-meta { font-size: .7rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .ls-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .75rem; margin-bottom: 1rem; }
    .ls-kpi { border: 1px solid var(--border-color); border-radius: var(--r-md, 10px); padding: .75rem 1rem; background: var(--card-bg); }
    .ls-kpi.bad { border-color: color-mix(in srgb, var(--bad-fg, #dc2626) 40%, var(--border-color)); }
    .ls-kpi-val { display: block; font-size: 1.3rem; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--text-main); }
    .ls-kpi-lbl { display: block; font-size: .7rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); margin-top: .15rem; }
    .ls-filters { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: .8rem; }
    .ls-seg { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--r-pill, 999px); overflow: hidden; }
    .ls-seg button { border: none; background: var(--card-bg); padding: .3rem .8rem; font-size: .8rem; cursor: pointer; color: var(--text-muted); }
    .ls-seg button.active { background: var(--action); color: var(--action-ink, #fff); font-weight: 600; }
    .ls-table { font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; } .strong { font-weight: 700; } .muted { color: var(--text-muted); }
    .bad { color: var(--bad-fg, #dc2626); }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; }
    .ls-name { font-weight: 600; color: var(--text-main); }
    .ls-rfc { color: var(--text-muted); margin-top: .05rem; }
    .ls-sev { display: inline-block; padding: .1rem .5rem; border-radius: var(--r-pill, 999px); font-size: .66rem; font-weight: 700; text-transform: capitalize; }
    .sev-critical { background: color-mix(in srgb, var(--bad-fg, #dc2626) 15%, transparent); color: var(--bad-fg, #dc2626); }
    .sev-warn { background: color-mix(in srgb, var(--warn-fg, #d97706) 16%, transparent); color: var(--warn-soft-fg, #b45309); }
    .sev-info { background: var(--surface-hover-bg, #f5f5f4); color: var(--text-muted); }
    .ls-tag { display: inline-block; padding: .08rem .5rem; border-radius: var(--r-pill, 999px); font-size: .7rem; font-weight: 600; background: var(--surface-hover-bg, #f5f5f4); color: var(--text-muted); }
    .iss-formato_invalido { background: color-mix(in srgb, var(--warn-fg, #d97706) 14%, transparent); color: var(--warn-soft-fg, #b45309); }
    .ls-acts { display: flex; align-items: center; gap: .1rem; }
    .ls-status-label { font-size: .75rem; font-weight: 600; }
    .st-confirmado { color: var(--ok-fg, #16a34a); } .st-descartado { color: var(--text-faint, #a8a29e); }
    .ls-ev { background: var(--surface-hover-bg, #fafaf9); padding: .8rem 1.2rem; }
    .ls-ev-loading, .ls-ev-empty { font-size: .82rem; color: var(--text-muted); padding: .4rem 0; }
    .ls-docs { width: 100%; border-collapse: collapse; font-size: .82rem; }
    .ls-docs th { text-align: left; font-size: .66rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); padding: .2rem .5rem; border-bottom: 1px solid var(--border-color); }
    .ls-docs td { padding: .25rem .5rem; border-bottom: 1px solid var(--border-color); color: var(--text-main); }
    .ls-docs .ta-r { text-align: right; }
    .ls-doc-concepto { max-width: 30ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }
    .ls-empty { padding: 2rem; text-align: center; color: var(--text-muted); }
    .ls-issues { padding: 1rem; margin-top: 1rem; }
    .ls-card-title { margin: 0 0 .6rem; font-size: .85rem; font-weight: 700; color: var(--text-main); }
  `],
})
export class FinanzasListasSatComponent implements OnInit {
  readonly tabs = FINANZAS_TABS;
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
  readonly expanded = signal<Record<string, boolean>>({});
  readonly docs = signal<Record<string, ExpenseDoc[]>>({});
  readonly docsLoading = signal<Record<string, boolean>>({});

  readonly filteredMatches = computed(() => {
    const l = this.lista();
    const e = this.estado();
    return this.allMatches().filter((m) => {
      if (l !== 'all' && m.lista !== l) return false;
      if (e === 'pendientes') return m.estado === 'nuevo' || m.estado === 'en_revision';
      return m.estado === e;
    });
  });
  readonly totalMatches = computed(() => this.allMatches().length);
  readonly totalRfcIssues = computed(() => this.rfcIssues().length);

  ngOnInit() { this.reload(); }

  private reload() {
    this.loading.set(true);
    this.svc.matches({ limit: 1000 }).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => { this.allMatches.set(r); this.loading.set(false); }, error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar las coincidencias.' }); } });
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
  listaLabel(l: string): string { return l === '69B' ? 'EFOS 69-B' : l === '69' ? 'Art. 69' : l; }
  issueLabel(t: string): string { return t === 'formato_invalido' ? 'Formato inválido' : t === 'rfc_generico' ? 'RFC genérico' : t; }
  estadoLabel(e: string): string { return e === 'confirmado' ? 'Confirmado' : e === 'descartado' ? 'Descartado' : e === 'en_revision' ? 'En revisión' : 'Nuevo'; }
  ageLabel(h: number | null): string { if (h == null) return '—'; if (h < 1) return 'reciente'; if (h < 24) return `hace ${Math.round(h)}h`; return `hace ${Math.round(h / 24)}d`; }
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
