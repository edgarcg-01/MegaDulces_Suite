import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal, computed } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { TabsModule } from 'primeng/tabs';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { MessageService } from 'primeng/api';
import {
  CommercialIntelligenceService, CommercialFinding, CommercialDiagnosis,
  CommercialAction, RuleStat, AutonomyPolicy, ActionExplain,
} from '../commercial-intelligence.service';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/**
 * Fase CT · Track A — Cockpit de razonamiento de Thot (ADR-018/016/023).
 * Expone la pista que vivía sólo en la API: hallazgos → diagnósticos → acciones
 * co-piloto (HITL) → dial de autonomía → scorecard de aprendizaje (L2).
 * El motor decide de forma determinista; el humano confirma y aprueba.
 */
@Component({
  selector: 'app-comercial-razonamiento',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, SelectModule, TagModule, TabsModule, DialogModule, InputNumberModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in rz-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Razonamiento de Thot</h1>
          <p class="surf-page-sub">Del hallazgo a la acción: el motor detecta y propone; tú confirmas y apruebas. El LLM comunica, nunca decide sobre el dinero.</p>
        </div>
      </header>

      <p-tabs [value]="0" (valueChange)="onTab($any($event))">
        <p-tablist>
          <p-tab [value]="0">Hallazgos</p-tab>
          <p-tab [value]="1">Diagnósticos</p-tab>
          <p-tab [value]="2">Acciones</p-tab>
          <p-tab [value]="3">Autonomía</p-tab>
          <p-tab [value]="4">Aprendizaje</p-tab>
        </p-tablist>
        <p-tabpanels>

          <!-- ── 0 · HALLAZGOS ── -->
          <p-tabpanel [value]="0">
            <div class="rz-bar">
              <div class="rz-kpis">
                @for (k of findingKpis(); track k.type) {
                  <button class="rz-kpi" [class.on]="fType === k.type" (click)="toggleType(k.type)">
                    <span class="rz-kpi-v">{{ k.n | number }}</span><span class="rz-kpi-k">{{ typeLabel(k.type) }}</span>
                  </button>
                }
              </div>
              <div class="rz-actions">
                <p-select [options]="statusOpts" [(ngModel)]="fStatus" (onChange)="loadFindings()" optionLabel="label" optionValue="value" styleClass="rz-sel"></p-select>
                <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="busy()==='findings'" (click)="recompute('findings')"><span class="p-button-icon p-button-icon-left pi pi-sync" aria-hidden="true"></span><span class="p-button-label">Recalcular</span></button>
              </div>
            </div>
            <p-table [value]="findings()" [loading]="loading()==='findings'" styleClass="p-datatable-sm rz-table" dataKey="id">
              <ng-template #header><tr><th style="width:2.5rem"></th><th>Severidad</th><th>Tipo</th><th>Sujeto</th><th class="rz-r">Score</th><th>Explicación</th><th>Detectado</th><th style="width:11rem">Triage</th></tr></ng-template>
              <ng-template #body let-f let-expanded="expanded">
                <tr [class.rz-done]="f.status!=='open'">
                  <td><p-button type="button" [icon]="expanded?'pi pi-chevron-down':'pi pi-chevron-right'" styleClass="p-button-text p-button-sm" [pRowToggler]="f"></p-button></td>
                  <td><p-tag [value]="sevLabel(f.severity)" [severity]="sevTag(f.severity)"></p-tag></td>
                  <td class="rz-strong">{{ typeLabel(f.finding_type) }}</td>
                  <td>{{ f.label }}</td>
                  <td class="rz-r">{{ f.score!=null ? (f.score|number:'1.0-1') : '—' }}</td>
                  <td class="rz-expl">{{ f.explanation || '—' }}</td>
                  <td class="rz-muted">{{ f.created_at | date:'dd/MM/yy' }}</td>
                  <td>
                    @if (f.status==='open') {
                      <button pButton type="button" class="p-button-sm p-button-text rz-ok" (click)="reviewFinding(f,'confirmed')"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Confirmar</span></button>
                      <button pButton type="button" class="p-button-sm p-button-text rz-no" (click)="reviewFinding(f,'dismissed')"><span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span><span class="p-button-label">Descartar</span></button>
                    } @else {
                      <span class="rz-status">{{ statusLabel(f.status) }}</span>
                      <button pButton type="button" class="p-button-sm p-button-text" pTooltip="Reabrir" (click)="reviewFinding(f,'open')"><span class="p-button-icon p-button-icon-left pi pi-undo" aria-hidden="true"></span></button>
                    }
                  </td>
                </tr>
              </ng-template>
              <ng-template #expandedrow let-f>
                <tr class="rz-ev-row"><td colspan="8"><pre class="rz-json">{{ pretty(f.evidence) }}</pre></td></tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="8" class="rz-empty">Sin hallazgos. El motor los computa tras el refresh de customer_360 + feature store; corre <b>Recalcular</b>.</td></tr></ng-template>
            </p-table>
          </p-tabpanel>

          <!-- ── 1 · DIAGNÓSTICOS ── -->
          <p-tabpanel [value]="1">
            <div class="rz-bar"><span class="rz-count">{{ diagnoses().length }} diagnóstico(s) · causa raíz (≥2 hallazgos correlacionados)</span>
              <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="busy()==='diagnoses'" (click)="recompute('diagnoses')"><span class="p-button-icon p-button-icon-left pi pi-sync" aria-hidden="true"></span><span class="p-button-label">Recalcular</span></button></div>
            <p-table [value]="diagnoses()" [loading]="loading()==='diagnoses'" styleClass="p-datatable-sm rz-table" dataKey="id">
              <ng-template #header><tr><th>Severidad</th><th>Causa raíz</th><th>Sujeto</th><th class="rz-r">Confianza</th><th>Resumen</th><th>Hallazgos</th><th style="width:9rem">Revisión</th></tr></ng-template>
              <ng-template #body let-d>
                <tr [class.rz-done]="d.status!=='open'">
                  <td><p-tag [value]="sevLabel(d.severity)" [severity]="sevTag(d.severity)"></p-tag></td>
                  <td class="rz-strong">{{ d.root_cause }}</td>
                  <td>{{ d.label }}</td>
                  <td class="rz-r">{{ d.confidence!=null ? ((d.confidence*100)|number:'1.0-0')+'%' : '—' }}</td>
                  <td class="rz-expl">{{ d.summary || '—' }}</td>
                  <td class="rz-muted">{{ (d.finding_types||[]).join(', ') }}</td>
                  <td>
                    @if (d.status==='open') {
                      <button pButton type="button" class="p-button-sm p-button-text rz-ok" pTooltip="Confirmar" (click)="reviewDiagnosis(d,'confirmed')"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span></button>
                      <button pButton type="button" class="p-button-sm p-button-text rz-no" pTooltip="Descartar" (click)="reviewDiagnosis(d,'dismissed')"><span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span></button>
                    } @else { <span class="rz-status">{{ statusLabel(d.status) }}</span> }
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="7" class="rz-empty">Sin diagnósticos. Requieren ≥2 hallazgos abiertos sobre el mismo sujeto.</td></tr></ng-template>
            </p-table>
          </p-tabpanel>

          <!-- ── 2 · ACCIONES ── -->
          <p-tabpanel [value]="2">
            <div class="rz-bar"><span class="rz-count">{{ actions().length }} acción(es) propuesta(s) · aprobar = efecto real (HITL)</span>
              <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="busy()==='actions'" (click)="recompute('actions')"><span class="p-button-icon p-button-icon-left pi pi-bolt" aria-hidden="true"></span><span class="p-button-label">Proponer</span></button></div>
            <p-table [value]="actions()" [loading]="loading()==='actions'" styleClass="p-datatable-sm rz-table" dataKey="id">
              <ng-template #header><tr><th class="rz-r">Prioridad</th><th>Tipo</th><th>Acción</th><th class="rz-r">Confianza</th><th>Impacto esperado</th><th>Estado</th><th style="width:14rem"></th></tr></ng-template>
              <ng-template #body let-a>
                <tr [class.rz-done]="a.status!=='pending_approval'">
                  <td class="rz-r">{{ a.priority!=null ? (a.priority|number:'1.0-0') : '—' }}</td>
                  <td class="rz-muted">{{ a.action_type }}</td>
                  <td class="rz-strong">{{ a.title || a.label }}</td>
                  <td class="rz-r">{{ a.confidence!=null ? ((a.confidence*100)|number:'1.0-0')+'%' : '—' }}</td>
                  <td class="rz-expl">{{ a.expected_impact || '—' }}</td>
                  <td><p-tag [value]="actionStatusLabel(a.status)" [severity]="actionStatusTag(a.status)"></p-tag>@if (a.auto_executed) { <span class="rz-auto">auto</span> }</td>
                  <td>
                    <button pButton type="button" class="p-button-sm p-button-text" (click)="explain(a)"><span class="p-button-icon p-button-icon-left pi pi-info-circle" aria-hidden="true"></span><span class="p-button-label">Explicar</span></button>
                    @if (a.status==='pending_approval') {
                      <button pButton type="button" class="p-button-sm p-button-text rz-ok" pTooltip="Aprobar" (click)="approve(a)"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span></button>
                      <button pButton type="button" class="p-button-sm p-button-text rz-no" pTooltip="Rechazar" (click)="reject(a)"><span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span></button>
                    }
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="7" class="rz-empty">Sin acciones propuestas. Corre <b>Proponer</b> sobre diagnósticos + hallazgos abiertos.</td></tr></ng-template>
            </p-table>
          </p-tabpanel>

          <!-- ── 3 · AUTONOMÍA ── -->
          <p-tabpanel [value]="3">
            <div class="rz-bar"><span class="rz-count">Dial por tipo de acción · el motor ejecuta sólo lo que habilites (default OFF)</span>
              <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="busy()==='autonomy'" (click)="runAutonomy()"><span class="p-button-icon p-button-icon-left pi pi-play" aria-hidden="true"></span><span class="p-button-label">Ejecutar habilitadas</span></button></div>
            <p-table [value]="policies()" [loading]="loading()==='autonomy'" styleClass="p-datatable-sm rz-table">
              <ng-template #header><tr><th>Tipo de acción</th><th style="width:11rem">Modo</th><th class="rz-r">Confianza mín</th><th class="rz-r">Tope diario</th><th class="rz-r">Tope $ (MXN)</th><th style="width:7rem"></th></tr></ng-template>
              <ng-template #body let-p>
                <tr [class.rz-kill]="p.action_type==='__global__'">
                  <td class="rz-strong">{{ p.action_type==='__global__' ? 'GLOBAL (kill-switch)' : p.action_type }}</td>
                  <td><p-select [options]="modeOpts" [(ngModel)]="p.mode" optionLabel="label" optionValue="value" styleClass="rz-sel-sm"></p-select></td>
                  <td class="rz-r"><p-inputnumber [(ngModel)]="p.min_confidence" [min]="0" [max]="1" mode="decimal" [minFractionDigits]="0" [maxFractionDigits]="2" inputStyleClass="rz-num"></p-inputnumber></td>
                  <td class="rz-r"><p-inputnumber [(ngModel)]="p.daily_cap" [min]="0" inputStyleClass="rz-num"></p-inputnumber></td>
                  <td class="rz-r"><p-inputnumber [(ngModel)]="p.value_cap_mxn" [min]="0" inputStyleClass="rz-num"></p-inputnumber></td>
                  <td><button pButton type="button" class="p-button-sm p-button-text" pTooltip="Guardar" (click)="savePolicy(p)"><span class="p-button-icon p-button-icon-left pi pi-save" aria-hidden="true"></span></button></td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="6" class="rz-empty">Sin políticas de autonomía configuradas (todo en OFF por default).</td></tr></ng-template>
            </p-table>
          </p-tabpanel>

          <!-- ── 4 · APRENDIZAJE ── -->
          <p-tabpanel [value]="4">
            <div class="rz-bar"><span class="rz-count">Precisión por regla (L2) · confirmar/descartar entrena qué hallazgos sirven</span>
              <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="busy()==='learning'" (click)="recompute('learning')"><span class="p-button-icon p-button-icon-left pi pi-sync" aria-hidden="true"></span><span class="p-button-label">Recalcular</span></button></div>
            <p-table [value]="rules()" [loading]="loading()==='learning'" styleClass="p-datatable-sm rz-table">
              <ng-template #header><tr><th>Regla</th><th class="rz-r">Total</th><th class="rz-r">Confirm.</th><th class="rz-r">Descart.</th><th class="rz-r">Precisión</th><th>Estado</th><th style="width:12rem">Override</th></tr></ng-template>
              <ng-template #body let-r>
                <tr>
                  <td class="rz-strong">{{ typeLabel(r.finding_type) }}</td>
                  <td class="rz-r">{{ r.n_total|number }}</td>
                  <td class="rz-r rz-ok-t">{{ r.n_confirmed|number }}</td>
                  <td class="rz-r rz-no-t">{{ r.n_dismissed|number }}</td>
                  <td class="rz-r">{{ r.precision!=null ? ((r.precision*100)|number:'1.0-0')+'%' : '—' }}</td>
                  <td>@if (r.auto_suppressed) { <p-tag value="suprimida" severity="danger"></p-tag> } @else if (r.floor_met) { <p-tag value="activa" severity="success"></p-tag> } @else { <span class="rz-muted">muestra baja</span> }</td>
                  <td><p-select [options]="overrideOpts" [ngModel]="r.manual_override" (ngModelChange)="overrideRule(r,$event)" optionLabel="label" optionValue="value" [showClear]="true" placeholder="auto" styleClass="rz-sel-sm"></p-select></td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="7" class="rz-empty">Sin estadísticas todavía. Aparecen cuando hay hallazgos revisados (confirmar/descartar).</td></tr></ng-template>
            </p-table>
          </p-tabpanel>
        </p-tabpanels>
      </p-tabs>

      <p-dialog [(visible)]="explainVisible" [modal]="true" [style]="{width:'42rem'}" header="Por qué esta acción">
        @if (explainData(); as e) {
          <p class="rz-narr">{{ e.narrative || 'Sin narración disponible.' }}</p>
          <pre class="rz-json">{{ pretty(e.chain ?? e) }}</pre>
        } @else { <p class="rz-muted">Cargando…</p> }
      </p-dialog>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rz-bar { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: .5rem 0 .75rem; }
    .rz-actions { display: flex; gap: .5rem; align-items: center; margin-left: auto; }
    .rz-kpis { display: flex; flex-wrap: wrap; gap: .5rem; }
    .rz-kpi { display: flex; flex-direction: column; gap: .15rem; align-items: flex-start; background: var(--surface-card, var(--card-bg)); border: 1px solid var(--border-color); border-radius: 8px; padding: .4rem .7rem; cursor: pointer; min-width: 7.5rem; }
    .rz-kpi:hover { border-color: var(--text-muted); }
    .rz-kpi.on { border-color: var(--action); box-shadow: inset 0 -2px 0 var(--action); }
    .rz-kpi-v { font-variant-numeric: tabular-nums; font-size: 1.2rem; font-weight: 700; line-height: 1; }
    .rz-kpi-k { font-size: .7rem; color: var(--text-muted); }
    .rz-count { color: var(--text-muted); font-size: .82rem; }
    .rz-table { font-size: .82rem; margin-top: .25rem; }
    .rz-r { text-align: right; font-variant-numeric: tabular-nums; }
    .rz-sel { min-width: 10rem; } .rz-sel-sm { min-width: 8rem; }
    :host ::ng-deep .rz-num { width: 6rem; text-align: right; }
    .rz-strong { font-weight: 700; } .rz-muted { color: var(--text-muted); }
    .rz-expl { color: var(--text-main); max-width: 30rem; }
    .rz-done { opacity: .6; } .rz-kill { background: var(--surface-hover, rgba(0,0,0,.03)); }
    .rz-status { font-size: .78rem; color: var(--text-muted); margin-right: .35rem; }
    .rz-auto { font-size: .68rem; color: var(--action); margin-left: .35rem; text-transform: uppercase; letter-spacing: .05em; }
    :host ::ng-deep .rz-ok .p-button-label { color: var(--good-fg, #3f7d3f); }
    :host ::ng-deep .rz-no .p-button-label { color: var(--bad-fg, #b0342a); }
    .rz-ok-t { color: var(--good-fg, #3f7d3f); } .rz-no-t { color: var(--bad-fg, #b0342a); }
    .rz-empty { color: var(--text-muted); padding: 1.25rem; text-align: center; line-height: 1.6; }
    .rz-ev-row td { background: var(--surface-hover, rgba(0,0,0,.02)); }
    .rz-json { font-family: var(--font-mono, ui-monospace, monospace); font-size: .72rem; margin: 0; white-space: pre-wrap; word-break: break-word; color: var(--text-main); max-height: 22rem; overflow: auto; }
    .rz-narr { font-size: .9rem; line-height: 1.55; margin: 0 0 .75rem; }
  `],
})
export class ComercialRazonamientoComponent implements OnInit {
  private readonly api = inject(CommercialIntelligenceService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  findings = signal<CommercialFinding[]>([]);
  diagnoses = signal<CommercialDiagnosis[]>([]);
  actions = signal<CommercialAction[]>([]);
  policies = signal<AutonomyPolicy[]>([]);
  rules = signal<RuleStat[]>([]);
  loading = signal<string>('');
  busy = signal<string>('');
  explainVisible = false;
  explainData = signal<ActionExplain | null>(null);
  private loaded = new Set<number>();

  fStatus = 'open';
  fType = '';
  statusOpts = [
    { label: 'Abiertos', value: 'open' }, { label: 'Confirmados', value: 'confirmed' },
    { label: 'Descartados', value: 'dismissed' }, { label: 'Resueltos', value: 'resolved' },
  ];
  modeOpts = [{ label: 'Apagado', value: 'off' }, { label: 'Simulación', value: 'dry_run' }, { label: 'Automático', value: 'auto' }];
  overrideOpts = [{ label: 'Forzar activa', value: 'enabled' }, { label: 'Suprimir', value: 'suppressed' }];

  findingKpis = computed(() => {
    const by = new Map<string, number>();
    for (const r of this.findings()) by.set(r.finding_type, (by.get(r.finding_type) || 0) + 1);
    return [...by.entries()].map(([type, n]) => ({ type, n })).sort((a, b) => b.n - a.n);
  });

  ngOnInit(): void { this.loadFindings(); this.loaded.add(0); }

  onTab(v: number): void {
    if (this.loaded.has(v)) return;
    this.loaded.add(v);
    if (v === 1) this.load('diagnoses', () => this.api.diagnoses('open'), this.diagnoses);
    else if (v === 2) this.load('actions', () => this.api.actions({ status: 'pending_approval' }), this.actions);
    else if (v === 3) this.load('autonomy', () => this.api.autonomyPolicies(), this.policies);
    else if (v === 4) this.load('learning', () => this.api.learningRules(), this.rules);
  }

  private load<T>(key: string, call: () => any, target: { set: (v: T) => void }): void {
    this.loading.set(key);
    call().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r: T) => { target.set(r); this.loading.set(''); },
      error: () => { this.loading.set(''); this.toast.add({ severity: 'error', summary: 'Error', detail: `No se pudo cargar ${key}.` }); },
    });
  }

  loadFindings(): void {
    this.loading.set('findings');
    this.api.findings({ status: this.fStatus }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.findings.set(this.fType ? r.filter((x) => x.finding_type === this.fType) : r); this.loading.set(''); },
      error: () => { this.loading.set(''); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar los hallazgos.' }); },
    });
  }
  toggleType(t: string): void { this.fType = this.fType === t ? '' : t; this.loadFindings(); }

  recompute(kind: 'findings' | 'diagnoses' | 'actions' | 'learning'): void {
    this.busy.set(kind);
    const call = kind === 'findings' ? this.api.computeFindings()
      : kind === 'diagnoses' ? this.api.computeDiagnoses()
      : kind === 'actions' ? this.api.computeActions() : this.api.recomputeLearning();
    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.busy.set(''); this.toast.add({ severity: 'success', summary: 'Recalculado', detail: kind });
        if (kind === 'findings') this.loadFindings();
        else if (kind === 'diagnoses') this.load('diagnoses', () => this.api.diagnoses('open'), this.diagnoses);
        else if (kind === 'actions') this.load('actions', () => this.api.actions({ status: 'pending_approval' }), this.actions);
        else this.load('learning', () => this.api.learningRules(), this.rules);
      },
      error: (e) => { this.busy.set(''); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo recalcular (¿permiso de gestión?).' }); },
    });
  }

  reviewFinding(f: CommercialFinding, status: string): void { this.act(this.api.reviewFinding(f.id, status), () => this.loadFindings(), status); }
  reviewDiagnosis(d: CommercialDiagnosis, status: string): void { this.act(this.api.reviewDiagnosis(d.id, status), () => this.load('diagnoses', () => this.api.diagnoses('open'), this.diagnoses), status); }
  approve(a: CommercialAction): void { this.act(this.api.approveAction(a.id), () => this.load('actions', () => this.api.actions({ status: 'pending_approval' }), this.actions), 'aprobada'); }
  reject(a: CommercialAction): void { this.act(this.api.rejectAction(a.id), () => this.load('actions', () => this.api.actions({ status: 'pending_approval' }), this.actions), 'rechazada'); }

  explain(a: CommercialAction): void {
    this.explainData.set(null); this.explainVisible = true;
    this.api.explainAction(a.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (e) => this.explainData.set(e),
      error: () => this.explainData.set({ narrative: 'No se pudo cargar la explicación.' }),
    });
  }

  savePolicy(p: AutonomyPolicy): void {
    this.act(this.api.setAutonomyPolicy(p.action_type, { mode: p.mode, min_confidence: p.min_confidence, daily_cap: p.daily_cap, value_cap_mxn: p.value_cap_mxn }), () => {}, 'guardada');
  }
  runAutonomy(): void {
    this.busy.set('autonomy');
    this.api.runAutonomy().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.busy.set(''); this.toast.add({ severity: 'success', summary: 'Autonomía ejecutada', detail: 'Se ejecutó lo que el dial habilita.' }); },
      error: (e) => { this.busy.set(''); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo ejecutar.' }); },
    });
  }
  overrideRule(r: RuleStat, value: string | null): void { this.act(this.api.overrideRule(r.finding_type, value), () => this.load('learning', () => this.api.learningRules(), this.rules), 'override'); }

  private act(obs: any, after: () => void, label: string): void {
    obs.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.toast.add({ severity: 'success', summary: 'Listo', detail: label }); after(); },
      error: (e: any) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo (¿permiso de gestión?).' }),
    });
  }

  pretty(v: unknown): string { try { return v ? JSON.stringify(v, null, 2) : '—'; } catch { return String(v); } }
  typeLabel(t: string): string {
    return ({ low_rotation_priced: 'Rotación con precio', margin_laggard: 'Margen rezagado', distribution_gap: 'Gap de distribución', churn_risk: 'Riesgo de churn' } as Record<string, string>)[t] || t;
  }
  sevLabel(s: string): string { return ({ critica: 'Crítica', alta: 'Alta', media: 'Media' } as Record<string, string>)[s] || s; }
  sevTag(s: string): Sev { return ({ critica: 'danger', alta: 'warn', media: 'secondary' } as Record<string, Sev>)[s] || 'info'; }
  statusLabel(s: string): string { return ({ open: 'reabierto', confirmed: 'confirmado', dismissed: 'descartado', resolved: 'resuelto' } as Record<string, string>)[s] || s; }
  actionStatusLabel(s: string): string { return ({ pending_approval: 'Por aprobar', approved: 'Aprobada', rejected: 'Rechazada', executed: 'Ejecutada' } as Record<string, string>)[s] || s; }
  actionStatusTag(s: string): Sev { return ({ pending_approval: 'warn', approved: 'success', rejected: 'secondary', executed: 'info' } as Record<string, Sev>)[s] || 'info'; }
}
