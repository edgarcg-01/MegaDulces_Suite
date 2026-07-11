import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { FINANZAS_TABS } from '../finanzas-tabs';
import { FindingsService, Finding, FindingsStats, RuleHealth, FindingClase } from '../findings.service';
import { ActionsService, ProposedAction } from '../actions.service';

/**
 * MAAT.2 — Bandeja de hallazgos (motor de patrones). Superficie Operations:
 * KPIs + filtros + tabla densa con triage (confirmar/descartar = feedback que
 * entrena la precisión de la regla) + evidencia + link a la póliza. Panel de
 * salud de reglas (precisión, auto-supresión, pin).
 */
@Component({
  selector: 'app-finanzas-hallazgos',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, PageTabsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in fh-page">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs" />

      <header class="surf-page-head fh-head">
        <div class="surf-page-head-text">
          <h1>Hallazgos</h1>
          <p class="surf-page-sub">Patrones que el motor detecta en los libros: riesgos, errores de captura y oportunidades. Confirma o descarta — Maat aprende de cada veredicto.</p>
        </div>
        <div class="fh-head-actions">
          <button pButton type="button" [label]="rulesOpen() ? 'Ocultar reglas' : 'Reglas'" icon="pi pi-sliders-h" class="p-button-sm p-button-text" (click)="rulesOpen.set(!rulesOpen())"></button>
          <button pButton type="button" label="Escanear ahora" icon="pi pi-bolt" class="p-button-sm p-button-outlined" [loading]="scanning()" (click)="scan()"></button>
        </div>
      </header>

      <!-- KPIs -->
      @if (stats(); as s) {
        <div class="fh-kpis">
          <div class="fh-kpi"><span class="fh-kpi-val">{{ s.pendientes | number }}</span><span class="fh-kpi-lbl">Pendientes</span></div>
          <div class="fh-kpi" [class.bad]="s.criticos > 0"><span class="fh-kpi-val">{{ s.criticos | number }}</span><span class="fh-kpi-lbl">Críticos</span></div>
          <div class="fh-kpi"><span class="fh-kpi-val">{{ money(s.monto_en_riesgo) }}</span><span class="fh-kpi-lbl">$ en juego</span></div>
          @for (c of s.por_clase; track c.clase) {
            <div class="fh-kpi"><span class="fh-kpi-val">{{ c.n | number }}</span><span class="fh-kpi-lbl">{{ claseLabel(c.clase) }}</span></div>
          }
        </div>
      }

      <!-- Acciones propuestas por Maat (HITL — aprobar/rechazar) -->
      @if (actions().length) {
        <div class="card-premium card-flat fh-actions">
          <h3 class="fh-card-title"><i class="pi pi-bolt" aria-hidden="true"></i> Acciones propuestas por Maat <span class="muted">({{ actions().length }} pendiente{{ actions().length === 1 ? '' : 's' }} de aprobación)</span></h3>
          @for (a of actions(); track a.id) {
            <div class="fh-action">
              <div class="fh-action-body">
                <span class="fh-action-titulo">{{ a.titulo }}</span>
                @if (a.descripcion) { <span class="fh-action-desc">{{ a.descripcion }}</span> }
                @if (a.efecto) { <span class="fh-action-efecto"><i class="pi pi-arrow-right"></i> {{ a.efecto }}</span> }
              </div>
              <div class="fh-action-acts">
                <button pButton type="button" icon="pi pi-check" label="Aprobar" class="p-button-sm p-button-success" (click)="approve(a)"></button>
                <button pButton type="button" icon="pi pi-times" class="p-button-sm p-button-text p-button-danger" title="Rechazar" (click)="reject(a)"></button>
              </div>
            </div>
          }
        </div>
      }

      <!-- Panel de salud de reglas -->
      @if (rulesOpen()) {
        <div class="card-premium card-flat fh-rules">
          <h3 class="fh-card-title">Salud de las reglas <span class="muted">(precisión = confirmados / veredictos)</span></h3>
          <p-table [value]="rules()" styleClass="p-datatable-sm" [rowHover]="true">
            <ng-template pTemplate="header">
              <tr><th>Regla</th><th>Clase</th><th class="ta-r">Hallazgos</th><th class="ta-r">✓ / ✗</th><th class="ta-r">Precisión</th><th>Estado</th><th style="width:5rem"></th></tr>
            </ng-template>
            <ng-template pTemplate="body" let-r>
              <tr [class.fh-suppressed]="r.suppressed_auto">
                <td>{{ r.nombre }}</td>
                <td><span class="fh-tag" [ngClass]="'cls-' + r.clase">{{ claseLabel(r.clase) }}</span></td>
                <td class="ta-r">{{ r.findings_total | number }}</td>
                <td class="ta-r muted">{{ r.findings_confirmados }} / {{ r.findings_falsos }}</td>
                <td class="ta-r" [class.bad]="r.precision_score != null && r.precision_score < 0.3">{{ r.precision_score != null ? (r.precision_score * 100 | number:'1.0-0') + '%' : '—' }}</td>
                <td>
                  @if (r.suppressed_auto) { <span class="fh-tag cls-off">auto-suprimida</span> }
                  @else if (!r.enabled) { <span class="fh-tag cls-off">off</span> }
                  @else if (r.pinned) { <span class="fh-tag cls-pin">fijada</span> }
                  @else { <span class="muted">activa</span> }
                </td>
                <td class="ta-r"><button pButton type="button" [icon]="r.pinned ? 'pi pi-bookmark-fill' : 'pi pi-bookmark'" class="p-button-text p-button-sm" [title]="r.pinned ? 'Desfijar' : 'Fijar (nunca auto-suprimir)'" (click)="pin(r)"></button></td>
              </tr>
            </ng-template>
          </p-table>
        </div>
      }

      <!-- Filtros -->
      <div class="fh-filters">
        <div class="fh-seg">
          <button [class.active]="clase() === null" (click)="setClase(null)">Todos</button>
          <button [class.active]="clase() === 'riesgo'" (click)="setClase('riesgo')">Riesgo</button>
          <button [class.active]="clase() === 'error_captura'" (click)="setClase('error_captura')">Errores</button>
          <button [class.active]="clase() === 'oportunidad'" (click)="setClase('oportunidad')">Oportunidad</button>
        </div>
        <div class="fh-seg">
          <button [class.active]="status() === 'pendientes'" (click)="setStatus('pendientes')">Pendientes</button>
          <button [class.active]="status() === 'confirmado'" (click)="setStatus('confirmado')">Confirmados</button>
          <button [class.active]="status() === 'descartado'" (click)="setStatus('descartado')">Descartados</button>
        </div>
      </div>

      <!-- Tabla de hallazgos -->
      <div class="card-premium card-flat">
        <p-table [value]="findings()" styleClass="p-datatable-sm fh-table" [rowHover]="true" [loading]="loading()"
                 dataKey="id" [expandedRowKeys]="expanded()" [scrollable]="true" scrollHeight="560px" [paginator]="findings().length > 50" [rows]="50">
          <ng-template pTemplate="header">
            <tr><th style="width:2.5rem"></th><th style="width:6rem">Severidad</th><th>Hallazgo</th><th style="width:8rem">Clase</th><th class="ta-r" style="width:9rem">Importe</th><th style="width:13rem">Acciones</th></tr>
          </ng-template>
          <ng-template pTemplate="body" let-f let-expanded="expanded">
            <tr>
              <td><button pButton type="button" [icon]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" class="p-button-text p-button-sm" (click)="toggle(f)"></button></td>
              <td><span class="fh-sev" [ngClass]="'sev-' + f.severity">{{ sevLabel(f.severity) }}</span></td>
              <td>
                <div class="fh-titulo">{{ f.titulo }}</div>
                <div class="fh-resumen">{{ f.resumen }}</div>
              </td>
              <td><span class="fh-tag" [ngClass]="'cls-' + f.clase">{{ claseLabel(f.clase) }}</span></td>
              <td class="ta-r strong">{{ money(f.importe) }}</td>
              <td>
                <div class="fh-acts">
                  @if (docUrl(f); as u) { <button pButton type="button" icon="pi pi-external-link" class="p-button-text p-button-sm" title="Ver póliza" (click)="go(u)"></button> }
                  @if (f.status === 'nuevo' || f.status === 'en_revision') {
                    <button pButton type="button" icon="pi pi-check" label="Confirmar" class="p-button-sm p-button-success p-button-text" (click)="verdict(f, 'util')" title="Es real y útil"></button>
                    <button pButton type="button" icon="pi pi-times" class="p-button-sm p-button-danger p-button-text" (click)="verdict(f, 'falso')" title="Falso positivo"></button>
                  } @else {
                    <span class="fh-status" [ngClass]="'st-' + f.status">{{ statusLabel(f.status) }}</span>
                  }
                </div>
              </td>
            </tr>
          </ng-template>
          <ng-template pTemplate="rowexpansion" let-f>
            <tr><td colspan="6" class="fh-ev">
              <div class="fh-ev-grid">
                @for (kv of evidenceRows(f); track kv.k) { <div><span class="fh-ev-k">{{ kv.k }}</span><span class="fh-ev-v mono">{{ kv.v }}</span></div> }
              </div>
              <div class="fh-ev-meta muted">Regla: {{ f.regla || f.rule_key }} · detectado {{ f.first_seen | date:'dd/MM/yy' }} · visto {{ f.last_seen | date:'dd/MM/yy' }}</div>
            </td></tr>
          </ng-template>
          <ng-template pTemplate="emptymessage"><tr><td colspan="6" class="fh-empty">
            @if (loading()) { Cargando… } @else { Sin hallazgos {{ status() === 'pendientes' ? 'pendientes' : '' }}. Corre "Escanear ahora" o revisa otro filtro. }
          </td></tr></ng-template>
        </p-table>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .fh-head { display: flex; align-items: flex-start; gap: 1rem; }
    .fh-head-actions { margin-left: auto; display: flex; gap: .4rem; align-items: center; }
    .fh-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: .75rem; margin-bottom: 1rem; }
    .fh-kpi { border: 1px solid var(--border-color, #e7e5e4); border-radius: var(--r-md, 10px); padding: .75rem 1rem; background: var(--card-bg, #fff); }
    .fh-kpi.bad { border-color: color-mix(in srgb, var(--bad-fg, #dc2626) 40%, var(--border-color, #e7e5e4)); }
    .fh-kpi-val { display: block; font-size: 1.3rem; font-weight: 800; font-variant-numeric: tabular-nums; }
    .fh-kpi-lbl { display: block; font-size: .7rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted, #78716c); }
    .fh-filters { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: .8rem; }
    .fh-seg { display: inline-flex; border: 1px solid var(--border-color, #e7e5e4); border-radius: var(--r-pill, 999px); overflow: hidden; }
    .fh-seg button { border: none; background: var(--card-bg, #fff); padding: .3rem .8rem; font-size: .8rem; cursor: pointer; color: var(--text-muted, #57534e); }
    .fh-seg button.active { background: var(--action, #FB923C); color: #fff; font-weight: 600; }
    .fh-card-title { margin: 0 0 .6rem; font-size: .85rem; font-weight: 700; }
    .fh-rules { padding: 1rem; margin-bottom: 1rem; }
    .fh-table { font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; } .strong { font-weight: 700; } .muted { color: var(--text-muted, #78716c); }
    .bad { color: var(--bad-fg, #dc2626); font-weight: 600; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; }
    .fh-titulo { font-weight: 600; }
    .fh-resumen { font-size: .82rem; color: var(--text-muted, #78716c); margin-top: .1rem; max-width: 60ch; }
    .fh-sev { display: inline-block; padding: .1rem .5rem; border-radius: var(--r-pill, 999px); font-size: .68rem; font-weight: 700; text-transform: uppercase; }
    .sev-critical { background: color-mix(in srgb, var(--bad-fg, #dc2626) 15%, transparent); color: var(--bad-fg, #dc2626); }
    .sev-warn { background: color-mix(in srgb, #d97706 15%, transparent); color: #b45309; }
    .sev-info { background: var(--surface-hover-bg, #f5f5f4); color: var(--text-muted, #57534e); }
    .fh-tag { display: inline-block; padding: .08rem .5rem; border-radius: var(--r-pill, 999px); font-size: .7rem; font-weight: 600; }
    .cls-riesgo { background: color-mix(in srgb, var(--bad-fg, #dc2626) 12%, transparent); color: var(--bad-fg, #dc2626); }
    .cls-error_captura { background: color-mix(in srgb, #d97706 14%, transparent); color: #b45309; }
    .cls-oportunidad { background: color-mix(in srgb, var(--ok-fg, #16a34a) 14%, transparent); color: var(--ok-fg, #16a34a); }
    .cls-off { background: var(--surface-hover-bg, #f5f5f4); color: var(--text-muted, #78716c); }
    .cls-pin { background: color-mix(in srgb, var(--action, #FB923C) 15%, transparent); color: var(--action, #FB923C); }
    .fh-acts { display: flex; align-items: center; gap: .1rem; }
    .fh-status { font-size: .75rem; font-weight: 600; }
    .st-confirmado { color: var(--ok-fg, #16a34a); } .st-descartado { color: var(--text-muted, #a8a29e); } .st-corregido { color: var(--action, #FB923C); }
    .fh-suppressed { opacity: .55; }
    .fh-ev { background: var(--surface-hover-bg, #fafaf9); padding: .8rem 1.2rem; }
    .fh-ev-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .4rem 1.2rem; }
    .fh-ev-k { font-size: .68rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted, #78716c); display: block; }
    .fh-ev-v { font-size: .85rem; }
    .fh-ev-meta { font-size: .74rem; margin-top: .6rem; }
    .fh-empty { padding: 2rem; text-align: center; color: var(--text-muted, #78716c); }
    .fh-actions { padding: 1rem; margin-bottom: 1rem; border-left: 3px solid var(--action, #FB923C); }
    .fh-action { display: flex; align-items: center; gap: 1rem; padding: .6rem 0; border-top: 1px solid var(--border-color, #e7e5e4); }
    .fh-action:first-of-type { border-top: none; }
    .fh-action-body { display: flex; flex-direction: column; gap: .15rem; flex: 1; min-width: 0; }
    .fh-action-titulo { font-weight: 700; }
    .fh-action-desc { font-size: .84rem; color: var(--text-muted, #78716c); }
    .fh-action-efecto { font-size: .8rem; color: var(--action, #FB923C); }
    .fh-action-efecto i { font-size: .7rem; }
    .fh-action-acts { display: flex; gap: .3rem; flex-shrink: 0; }
  `],
})
export class FinanzasHallazgosComponent implements OnInit {
  readonly tabs = FINANZAS_TABS;
  private readonly svc = inject(FindingsService);
  private readonly actionsSvc = inject(ActionsService);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  readonly actions = signal<ProposedAction[]>([]);

  readonly findings = signal<Finding[]>([]);
  readonly stats = signal<FindingsStats | null>(null);
  readonly rules = signal<RuleHealth[]>([]);
  readonly loading = signal(false);
  readonly scanning = signal(false);
  readonly rulesOpen = signal(false);
  readonly clase = signal<FindingClase | null>(null);
  readonly status = signal<'pendientes' | 'confirmado' | 'descartado'>('pendientes');
  readonly expanded = signal<Record<string, boolean>>({});

  ngOnInit() { this.reload(); this.loadStats(); this.loadActions(); }

  private loadActions() {
    this.actionsSvc.list().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (a) => this.actions.set(a), error: () => {} });
  }

  approve(a: ProposedAction) {
    this.actionsSvc.approve(a.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.actions.update((arr) => arr.filter((x) => x.id !== a.id)); this.toast.add({ severity: 'success', summary: 'Aprobada', detail: r?.resultado || 'Acción ejecutada.' }); this.reload(); this.loadStats(); },
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo aprobar.' }),
    });
  }
  reject(a: ProposedAction) {
    this.actionsSvc.reject(a.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.actions.update((arr) => arr.filter((x) => x.id !== a.id)); this.toast.add({ severity: 'info', summary: 'Rechazada', detail: 'La acción no se ejecutará.' }); },
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo rechazar.' }),
    });
  }

  private reload() {
    this.loading.set(true);
    const status = this.status() === 'pendientes' ? undefined : this.status();
    this.svc.list({ clase: this.clase() || undefined, status, limit: 300 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => { this.findings.set(r); this.loading.set(false); }, error: () => this.loading.set(false) });
  }
  private loadStats() {
    this.svc.stats().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (s) => this.stats.set(s), error: () => {} });
    this.svc.rules().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.rules.set(r), error: () => {} });
  }

  setClase(c: FindingClase | null) { this.clase.set(c); this.reload(); }
  setStatus(s: 'pendientes' | 'confirmado' | 'descartado') { this.status.set(s); this.reload(); }

  scan() {
    this.scanning.set(true);
    this.svc.scan().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.scanning.set(false); this.toast.add({ severity: 'success', summary: 'Escaneo listo', detail: `${r.nuevos} hallazgo(s) nuevo(s) en ${r.reglas} reglas.` }); this.reload(); this.loadStats(); },
      error: () => { this.scanning.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo escanear.' }); },
    });
  }

  toggle(f: Finding) {
    this.expanded.update((e) => { const c = { ...e }; if (c[f.id]) delete c[f.id]; else c[f.id] = true; return c; });
  }

  verdict(f: Finding, v: 'util' | 'falso') {
    this.svc.feedback(f.id, v).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.findings.update((arr) => arr.filter((x) => x.id !== f.id));
        this.loadStats();
        const msg = v === 'util' ? 'Confirmado' : 'Descartado';
        const sup = res?.suppressed ? ' · regla auto-suprimida por baja precisión' : '';
        this.toast.add({ severity: v === 'util' ? 'success' : 'info', summary: msg, detail: `Maat aprende de esto${sup}.` });
      },
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo registrar.' }),
    });
  }

  pin(r: RuleHealth) {
    this.svc.pinRule(r.rule_key, !r.pinned).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.loadStats(), error: () => {},
    });
  }

  /** Deep-link a la póliza si el hallazgo apunta a un documento. */
  docUrl(f: Finding): string | null {
    const e = f.entity;
    if (!e || !e['doc_folio']) return null;
    const p = new URLSearchParams({ type: 'beneficiario', key: e['beneficiario'] || '(sin beneficiario)', doc_sucursal: e['sucursal'] || '', doc_tipo: e['doc_tipo'] || 'XA2001', doc_folio: e['doc_folio'] });
    return `/finanzas/egresos/detalle?${p.toString()}`;
  }
  go(url: string) { this.router.navigateByUrl(url); }

  evidenceRows(f: Finding): { k: string; v: string }[] {
    const e = { ...(f.entity || {}), ...(f.evidencia || {}) };
    return Object.entries(e).filter(([, v]) => v != null && typeof v !== 'object')
      .map(([k, v]) => ({ k: k.replace(/_/g, ' '), v: String(v) }));
  }

  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  claseLabel(c: string): string { return c === 'riesgo' ? 'Riesgo' : c === 'error_captura' ? 'Error' : c === 'oportunidad' ? 'Oportunidad' : c; }
  sevLabel(s: string): string { return s === 'critical' ? 'Crítico' : s === 'warn' ? 'Alerta' : 'Info'; }
  statusLabel(s: string): string { return s === 'confirmado' ? 'Confirmado' : s === 'descartado' ? 'Descartado' : s === 'corregido' ? 'Corregido' : s; }
}
