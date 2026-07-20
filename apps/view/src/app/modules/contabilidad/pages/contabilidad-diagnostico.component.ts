import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { SelectModule } from 'primeng/select';
import { SelectButtonModule } from 'primeng/selectbutton';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { CONTABILIDAD_TABS } from '../contabilidad-tabs';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { DiagnosticoService, DiagnosticRow, DiagnosticStats, EmissionErrorKind, HealthCheck } from '../diagnostico.service';
import { FacturasService } from '../facturas.service';

/**
 * FD.4 — Tablero de Diagnóstico de facturación (Operations). Junta los errores de
 * emisión capturados, los traduce con la base de conocimiento SAT/PAC (FD.1) y
 * propone la solución + acción (reintentar / ir a arreglar / descartar).
 */
@Component({
  selector: 'app-contabilidad-diagnostico',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, ButtonModule, TableModule, ToastModule, TooltipModule, SelectModule, SelectButtonModule, TagModule, PageTabsComponent, MetricStripComponent, FreshnessPillComponent, ContextHelpComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs" variant="liquid" />

      <header class="surf-page-head di-head">
        <div class="surf-page-head-text">
          <h1 class="di-h1">Diagnóstico de facturación <app-context-help topic="diagnostico" /></h1>
          <p class="surf-page-sub">Errores de timbrado, cancelación y complementos de pago — con la causa y la solución que propone el SAT/PAC.</p>
        </div>
        <div class="di-head-actions">
          @if (loadedAt()) { <app-freshness-pill [since]="loadedAt()" /> }
          <button pButton type="button" label="Refrescar" icon="pi pi-refresh" class="p-button-sm p-button-text" [loading]="loading()" (click)="reload()"></button>
          @if (canManage && stats() && stats()!.open_total > 0) {
            <button pButton type="button" label="Reintentar timbrado de pedidos" icon="pi pi-replay" class="p-button-sm" [loading]="retrying()" (click)="retryOrders()"></button>
          }
        </div>
      </header>

      <!-- Revisión preventiva (FD.3) -->
      @if (healthAlerts().length > 0) {
        <div class="di-health">
          <div class="di-health-head"><i class="pi pi-shield"></i> Revisión preventiva</div>
          @for (h of healthAlerts(); track h.key) {
            <div class="di-check" [ngClass]="'c-' + h.status">
              <i class="pi" [ngClass]="h.status === 'critical' ? 'pi-times-circle' : 'pi-exclamation-triangle'"></i>
              <div class="di-check-body">
                <div class="di-check-tit">{{ h.titulo }}</div>
                <div class="di-check-det">{{ h.detalle }}</div>
                @if (h.solucion) { <div class="di-check-sol">{{ h.solucion }}</div> }
              </div>
              @if (h.deep_link) {
                <a pButton [routerLink]="h.deep_link" class="p-button-sm p-button-text" [label]="h.fix_label || 'Arreglar'" icon="pi pi-external-link"></a>
              }
            </div>
          }
        </div>
      }

      <!-- KPIs -->
      @if (stats(); as s) {
        <app-metric-strip [items]="kpiItems(s)" ariaLabel="Resumen de errores de facturación" />
      }

      <!-- Filtros -->
      <div class="di-filters">
        <p-selectButton styleClass="sb-liquid" [options]="statusOpts" [ngModel]="fStatus()" (ngModelChange)="setStatus($event)" optionLabel="label" optionValue="value" [allowEmpty]="false" ariaLabel="Estado del error" />
        <p-select [options]="kindOpts" [ngModel]="fKind()" (ngModelChange)="setKind($event)" optionLabel="label" optionValue="value" appendTo="body" styleClass="di-sel sel-liquid" ariaLabel="Tipo de error" />
      </div>

      <div class="card-premium card-flat">
        <p-table [value]="rows()" dataKey="id" styleClass="p-datatable-sm di-table" [rowHover]="true" [loading]="loading()"
                 [scrollable]="true" scrollHeight="560px" [paginator]="rows().length > 50" [rows]="50">
          <ng-template pTemplate="header">
            <tr>
              <th style="width:2.5rem"></th>
              <th style="width:6rem">Sev.</th>
              <th style="width:8rem">Tipo</th>
              <th>Qué pasó</th>
              <th style="width:7rem">Código</th>
              <th>Comprobante / cliente</th>
              <th class="ta-c" style="width:4rem">Int.</th>
              <th style="width:12rem"></th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-r let-expanded="expanded">
            <tr>
              <td><button type="button" pButton [pRowToggler]="r" class="p-button-text p-button-sm" [icon]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" aria-label="Detalle"></button></td>
              <td><p-tag [value]="sevLabel(r.solucion.severity)" [severity]="sevSev(r.solucion.severity)" styleClass="di-chip" /></td>
              <td>{{ kindLabel(r.kind) }}</td>
              <td><div class="di-tit">{{ r.solucion.titulo }}</div></td>
              <td class="mono">{{ r.pac_code || '—' }}</td>
              <td>
                <div>{{ r.receptor_nombre || '—' }}</div>
                <div class="mono di-sub">{{ (r.serie || '') + (r.folio || '') }}{{ r.receptor_rfc ? ' · ' + r.receptor_rfc : '' }}</div>
              </td>
              <td class="ta-c mono">{{ r.attempts }}</td>
              <td class="ta-r">
                @if (r.status === 'open') {
                  @if (r.solucion.deep_link) {
                    <a pButton [routerLink]="r.solucion.deep_link" class="p-button-text p-button-sm" [label]="r.solucion.fix_label || 'Arreglar'" icon="pi pi-external-link"></a>
                  }
                  @if (canManage) {
                    <button pButton type="button" icon="pi pi-check" class="p-button-text p-button-sm" pTooltip="Descartar (ya atendido)" (click)="dismiss(r)"></button>
                  }
                } @else {
                  <span class="di-resolved"><i class="pi pi-check-circle"></i> Resuelto</span>
                }
              </td>
            </tr>
          </ng-template>
          <ng-template pTemplate="rowexpansion" let-r>
            <tr class="di-exp-row">
              <td colspan="8">
                <div class="di-exp">
                  <div class="di-exp-main">
                    <div class="di-exp-block">
                      <span class="di-exp-lbl">Por qué pasó</span>
                      <p>{{ r.solucion.causa }}</p>
                    </div>
                    <div class="di-exp-block di-exp-sol">
                      <span class="di-exp-lbl"><i class="pi pi-lightbulb"></i> Cómo se arregla</span>
                      <p>{{ r.solucion.solucion }}</p>
                      <div class="di-exp-actions">
                        @if (r.solucion.deep_link) {
                          <a pButton [routerLink]="r.solucion.deep_link" class="p-button-sm" [label]="r.solucion.fix_label || 'Ir a arreglar'" icon="pi pi-external-link"></a>
                        }
                        @if (r.can_retry_order && canManage) {
                          <button pButton type="button" label="Reintentar este pedido" icon="pi pi-replay" class="p-button-sm p-button-outlined" [loading]="retrying()" (click)="retryOrders()"></button>
                        }
                      </div>
                    </div>
                  </div>
                  <div class="di-exp-tech">
                    <span class="di-exp-lbl">Respuesta del PAC</span>
                    <div class="di-tech-grid">
                      <span>Código</span><b class="mono">{{ r.pac_code || '—' }}</b>
                      <span>HTTP</span><b class="mono">{{ r.http_status || '—' }}</b>
                      <span>Mensaje</span><b>{{ r.error_message || '—' }}</b>
                      @if (r.error_detail) { <span>Detalle</span><b>{{ r.error_detail }}</b> }
                    </div>
                    <button pButton type="button" label="Ver respuesta cruda" icon="pi pi-code" class="p-button-text p-button-sm" [loading]="rawLoading()===r.id" (click)="loadRaw(r)"></button>
                    @if (rawById()[r.id]) { <pre class="di-raw">{{ rawById()[r.id] }}</pre> }
                  </div>
                </div>
              </td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage"><tr><td colspan="8" class="di-empty">
            @if (loading()) { Cargando… }
            @else if (errored()) { <i class="pi pi-exclamation-triangle"></i> No se pudo cargar. <button pButton type="button" label="Reintentar" class="p-button-sm p-button-text" (click)="reload()"></button> }
            @else { <i class="pi pi-check-circle di-ok"></i> Sin errores {{ fStatus()==='open' ? 'abiertos' : '' }}. Todo en orden. }
          </td></tr></ng-template>
        </p-table>
      </div>
      <p class="di-note"><i class="pi pi-info-circle"></i> Los errores se registran automáticamente al fallar un timbrado/cancelación/REP y se resuelven solos cuando un intento posterior tiene éxito. El reintento de timbrado de pedidos es idempotente.</p>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .di-head { display: flex; align-items: flex-start; gap: 1rem; }
    .di-h1 { display: inline-flex; align-items: center; gap: .3rem; }
    .di-head-actions { margin-left: auto; display: flex; gap: .4rem; align-items: center; }
    app-metric-strip { display: block; margin-bottom: 1rem; }
    /* revisión preventiva */
    .di-health { border: 1px solid var(--border-color); border-radius: var(--r-md); padding: .9rem 1.1rem; margin-bottom: 1rem; background: var(--card-bg); }
    .di-health-head { font-size: .72rem; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); display: flex; align-items: center; gap: .4rem; margin-bottom: .7rem; }
    .di-check { display: flex; align-items: flex-start; gap: .7rem; padding: .6rem 0; border-top: 1px solid var(--border-color); }
    .di-check:first-of-type { border-top: none; }
    .di-check > .pi { font-size: 1.1rem; margin-top: .1rem; }
    .di-check.c-critical > .pi { color: var(--bad-fg); }
    .di-check.c-warn > .pi { color: var(--warn-fg); }
    .di-check-body { flex: 1; min-width: 0; }
    .di-check-tit { font-weight: 700; color: var(--text-main); font-size: .88rem; }
    .di-check-det { font-size: .8rem; color: var(--text-muted); margin-top: .1rem; }
    .di-check-sol { font-size: .8rem; color: var(--text-main); margin-top: .3rem; }
    .di-check a { flex-shrink: 0; }
    .di-filters { display: flex; gap: .6rem; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; }
    .di-table { font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; } .ta-c { text-align: center; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; }
    .di-tit { color: var(--text-main); font-weight: 600; }
    .di-sub { color: var(--text-muted); font-size: .72rem; }
    :host ::ng-deep .di-chip .p-tag { font-size: .64rem; font-weight: 800; text-transform: uppercase; letter-spacing: .03em; padding: .1rem .5rem; }
    .di-resolved { color: var(--ok-fg); font-size: .78rem; font-weight: 600; }
    .di-resolved .pi { font-size: .8rem; margin-right: .2rem; }
    .di-empty { padding: 2.5rem 1rem; text-align: center; color: var(--text-muted); }
    .di-empty .pi { display: block; font-size: 1.5rem; margin-bottom: .5rem; opacity: .6; }
    .di-empty .di-ok { color: var(--ok-fg); opacity: 1; }
    /* expansión */
    .di-exp-row td { background: var(--surface-hover-bg); }
    .di-exp { display: grid; grid-template-columns: 1.4fr 1fr; gap: 1.4rem; padding: 1rem 1.2rem; }
    @media (max-width: 820px) { .di-exp { grid-template-columns: 1fr; } }
    .di-exp-main { display: flex; flex-direction: column; gap: 1rem; }
    .di-exp-block p { margin: .3rem 0 0; font-size: .85rem; color: var(--text-main); line-height: 1.5; }
    .di-exp-lbl { font-size: .66rem; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted); display: inline-flex; align-items: center; gap: .3rem; }
    .di-exp-sol { background: color-mix(in srgb, var(--action) 6%, var(--card-bg)); border: 1px solid color-mix(in srgb, var(--action) 22%, transparent); border-radius: var(--r-md); padding: .8rem .95rem; }
    .di-exp-sol .di-exp-lbl { color: var(--action); }
    .di-exp-actions { display: flex; gap: .5rem; margin-top: .7rem; flex-wrap: wrap; }
    .di-exp-tech { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); padding: .8rem .95rem; }
    .di-tech-grid { display: grid; grid-template-columns: auto 1fr; gap: .3rem .8rem; margin: .5rem 0 .7rem; font-size: .8rem; }
    .di-tech-grid span { color: var(--text-muted); }
    .di-tech-grid b { color: var(--text-main); font-weight: 600; word-break: break-word; }
    .di-raw { margin: .6rem 0 0; padding: .7rem; background: var(--surface-hover-bg); color: var(--text-muted); border: 1px solid var(--border-color); border-radius: var(--r-sm); font-family: var(--font-mono, monospace); font-size: .72rem; max-height: 240px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
    .di-note { font-size: .75rem; color: var(--text-muted); margin: 1rem 0 0; display: flex; gap: .4rem; align-items: baseline; }
  `],
})
export class ContabilidadDiagnosticoComponent implements OnInit {
  readonly tabs = CONTABILIDAD_TABS;
  private readonly svc = inject(DiagnosticoService);
  private readonly facturas = inject(FacturasService);
  private readonly toast = inject(MessageService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  readonly canManage = this.auth.user()?.permissions?.[Permission.FISCAL_FACTURAR_GESTIONAR] === true;
  readonly rows = signal<DiagnosticRow[]>([]);
  readonly stats = signal<DiagnosticStats | null>(null);
  readonly health = signal<HealthCheck[]>([]);
  readonly healthAlerts = computed(() => this.health().filter((h) => h.status !== 'ok'));
  readonly loading = signal(false);
  readonly errored = signal(false);
  readonly retrying = signal(false);
  readonly rawLoading = signal<string | null>(null);
  readonly rawById = signal<Record<string, string>>({});
  readonly fStatus = signal<'open' | 'resolved' | 'all'>('open');
  readonly fKind = signal<EmissionErrorKind | ''>('');
  readonly loadedAt = signal<number | null>(null);

  readonly statusOpts = [{ label: 'Abiertos', value: 'open' }, { label: 'Resueltos', value: 'resolved' }, { label: 'Todos', value: 'all' }];
  readonly kindOpts = [
    { label: 'Todos los tipos', value: '' }, { label: 'Timbrado', value: 'timbrado' },
    { label: 'Nota de crédito', value: 'nota_credito' }, { label: 'Complemento de pago', value: 'rep' }, { label: 'Cancelación', value: 'cancelacion' },
  ];

  kpiItems(s: DiagnosticStats): MetricStripItem[] {
    return [
      { label: 'Errores abiertos', value: s.open_total, tone: s.open_total > 0 ? 'warn' : 'default' },
      { label: 'Críticos', value: s.criticos, tone: s.criticos > 0 ? 'bad' : 'default' },
      ...(s.por_tipo || []).map((t) => ({ label: this.kindLabel(t.kind), value: t.count } as MetricStripItem)),
    ];
  }

  ngOnInit() { this.reload(); }

  reload() {
    this.loading.set(true); this.errored.set(false);
    this.svc.list({ status: this.fStatus(), kind: this.fKind() || undefined }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.rows.set(r); this.loading.set(false); this.loadedAt.set(Date.now()); },
      error: () => { this.loading.set(false); this.errored.set(true); },
    });
    this.svc.stats().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (s) => this.stats.set(s), error: () => {} });
    this.svc.health().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (h) => this.health.set(h), error: () => {} });
  }

  setStatus(s: 'open' | 'resolved' | 'all') { this.fStatus.set(s); this.reload(); }
  setKind(k: string) { this.fKind.set((k || '') as EmissionErrorKind | ''); this.reload(); }

  retryOrders() {
    this.retrying.set(true);
    this.facturas.retryInvoices({}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.retrying.set(false);
        this.toast.add({ severity: r.invoiced > 0 ? 'success' : 'info', summary: `Reintento: ${r.invoiced}/${r.attempted} facturados`, detail: r.failed ? `${r.failed} siguen pendientes` : undefined, life: 6000 });
        this.reload();
      },
      error: (e) => { this.retrying.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo reintentar.' }); },
    });
  }

  dismiss(r: DiagnosticRow) {
    this.svc.dismiss(r.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.toast.add({ severity: 'info', summary: 'Descartado', life: 2500 }); this.reload(); },
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo descartar.' }),
    });
  }

  loadRaw(r: DiagnosticRow) {
    if (this.rawById()[r.id]) return;
    this.rawLoading.set(r.id);
    this.svc.detail(r.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.rawLoading.set(null);
        const raw = typeof d.pac_raw === 'string' ? d.pac_raw : JSON.stringify(d.pac_raw, null, 2);
        this.rawById.update((m) => ({ ...m, [r.id]: raw || '(sin respuesta cruda)' }));
      },
      error: () => { this.rawLoading.set(null); this.toast.add({ severity: 'warn', summary: 'Sin detalle técnico' }); },
    });
  }

  kindLabel(k: EmissionErrorKind): string {
    return k === 'timbrado' ? 'Timbrado' : k === 'nota_credito' ? 'Nota de crédito' : k === 'rep' ? 'Compl. de pago' : k === 'cancelacion' ? 'Cancelación' : k;
  }
  sevLabel(s?: string): string { return s === 'critical' ? 'Crítico' : s === 'info' ? 'Info' : 'Aviso'; }
  sevSev(s?: string): 'danger' | 'warn' | 'secondary' { return s === 'critical' ? 'danger' : s === 'info' ? 'secondary' : 'warn'; }
}
