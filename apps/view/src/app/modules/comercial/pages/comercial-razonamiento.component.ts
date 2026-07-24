import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal, computed } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import { CommercialIntelligenceService, CommercialFinding } from '../commercial-intelligence.service';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/**
 * Fase CT · Track A (CT-A.1) — Bandeja de hallazgos comerciales de Thot.
 * El motor detecta (dead-stock, margen rezagado, gap de distribución, riesgo de churn);
 * el humano confirma o descarta (HITL). El triage entrena el scorecard de precisión (L2).
 * Superficie Operations (PrimeNG denso). Antes sólo existía por API.
 */
@Component({
  selector: 'app-comercial-razonamiento',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, SelectModule, TagModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in rz-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Razonamiento de Thot · Hallazgos</h1>
          <p class="surf-page-sub">Lo que el motor detecta en el portafolio: rotación con precio, margen rezagado, gaps de distribución y riesgo de churn. Confirma o descarta — tu juicio calibra las reglas.</p>
        </div>
        <div class="rz-head-actions">
          <button pButton type="button" label="Recalcular" icon="pi pi-sync" class="p-button-sm p-button-outlined" [loading]="computing()" (click)="recompute()"></button>
        </div>
      </header>

      <div class="rz-kpis">
        @for (k of kpis(); track k.type) {
          <button class="rz-kpi" [class.on]="fType === k.type" (click)="toggleType(k.type)">
            <span class="rz-kpi-v">{{ k.n | number }}</span>
            <span class="rz-kpi-k">{{ typeLabel(k.type) }}</span>
          </button>
        }
      </div>

      <div class="rz-filters">
        <p-select [options]="statusOpts" [(ngModel)]="fStatus" (onChange)="reload()" optionLabel="label" optionValue="value" styleClass="rz-sel"></p-select>
        <p-select [options]="sevOpts" [(ngModel)]="fSev" (onChange)="reload()" optionLabel="label" optionValue="value" placeholder="Toda severidad" [showClear]="true" styleClass="rz-sel"></p-select>
        <span class="rz-count">{{ rows().length | number }} hallazgo(s)</span>
      </div>

      <p-table [value]="rows()" [loading]="loading()" [scrollable]="true" scrollHeight="flex"
               styleClass="p-datatable-sm rz-table" dataKey="id" [expandedRowKeys]="expanded">
        <ng-template pTemplate="header">
          <tr>
            <th style="width:2.5rem"></th>
            <th>Severidad</th><th>Tipo</th><th>Sujeto</th><th class="rz-r">Score</th>
            <th>Explicación</th><th>Detectado</th><th style="width:11rem">Triage</th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-f let-expanded="expanded">
          <tr [class.rz-done]="f.status !== 'open'">
            <td><button pButton type="button" [icon]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" class="p-button-text p-button-sm rz-exp" [pRowToggler]="f"></button></td>
            <td><p-tag [value]="sevLabel(f.severity)" [severity]="sevTag(f.severity)"></p-tag></td>
            <td class="rz-type">{{ typeLabel(f.finding_type) }}</td>
            <td>{{ f.label }}</td>
            <td class="rz-r rz-strong">{{ f.score != null ? (f.score | number:'1.0-1') : '—' }}</td>
            <td class="rz-expl">{{ f.explanation || '—' }}</td>
            <td class="rz-muted">{{ f.created_at | date:'dd/MM/yy' }}</td>
            <td>
              @if (f.status === 'open') {
                <button pButton type="button" label="Confirmar" icon="pi pi-check" class="p-button-sm p-button-text rz-ok" (click)="review(f, 'confirmed')"></button>
                <button pButton type="button" label="Descartar" icon="pi pi-times" class="p-button-sm p-button-text rz-no" (click)="review(f, 'dismissed')"></button>
              } @else {
                <span class="rz-status">{{ statusLabel(f.status) }}</span>
                <button pButton type="button" icon="pi pi-undo" class="p-button-sm p-button-text rz-undo" pTooltip="Reabrir" (click)="review(f, 'open')"></button>
              }
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="rowexpansion" let-f>
          <tr class="rz-ev-row"><td colspan="8">
            <div class="rz-ev">
              <div class="rz-ev-col"><span class="rz-ev-lbl">Sujeto</span><span class="rz-mono">{{ f.subject_type }} · {{ f.subject_id || '—' }}</span></div>
              <div class="rz-ev-col"><span class="rz-ev-lbl">Fuente</span><span>{{ f.source || 'motor' }}</span></div>
              <div class="rz-ev-col rz-ev-json"><span class="rz-ev-lbl">Evidencia</span><pre class="rz-json">{{ pretty(f.evidence) }}</pre></div>
            </div>
          </td></tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="8" class="rz-empty">
            Sin hallazgos {{ fStatus === 'open' ? 'abiertos' : '' }}. El motor los computa tras el refresh nocturno de datos (customer_360 + feature store).
            Si esperabas datos, corre <b>Recalcular</b> o verifica que la venta por cliente y las señales de zona/afinidad estén pobladas.
          </td></tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rz-head-actions { display: flex; gap: .5rem; align-items: center; }
    .rz-kpis { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: .75rem; }
    .rz-kpi { display: flex; flex-direction: column; gap: .15rem; align-items: flex-start; background: var(--surface-card, var(--card-bg)); border: 1px solid var(--border-color); border-radius: var(--r-md, 8px); padding: .5rem .75rem; cursor: pointer; min-width: 8rem; }
    .rz-kpi:hover { border-color: var(--text-muted); }
    .rz-kpi.on { border-color: var(--action); box-shadow: inset 0 -2px 0 var(--action); }
    .rz-kpi-v { font-variant-numeric: tabular-nums; font-size: 1.25rem; font-weight: 700; line-height: 1; }
    .rz-kpi-k { font-size: .72rem; color: var(--text-muted); }
    .rz-filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-bottom: .75rem; }
    .rz-sel { min-width: 11rem; }
    .rz-count { color: var(--text-muted); font-size: .82rem; margin-left: auto; }
    .rz-table { font-size: .82rem; }
    .rz-r { text-align: right; font-variant-numeric: tabular-nums; }
    .rz-type { font-weight: 600; }
    .rz-expl { color: var(--text-main); max-width: 32rem; }
    .rz-muted { color: var(--text-muted); }
    .rz-strong { font-weight: 700; }
    .rz-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .78rem; }
    .rz-done { opacity: .6; }
    .rz-ok :deep(.p-button-label) { color: var(--good-fg, #3f7d3f); }
    .rz-no :deep(.p-button-label) { color: var(--bad-fg, #b0342a); }
    .rz-status { font-size: .78rem; color: var(--text-muted); margin-right: .35rem; }
    .rz-empty { color: var(--text-muted); padding: 1.25rem; text-align: center; line-height: 1.6; }
    .rz-ev-row td { background: var(--surface-hover, rgba(0,0,0,.02)); }
    .rz-ev { display: flex; gap: 1.5rem; flex-wrap: wrap; padding: .35rem .25rem; }
    .rz-ev-col { display: flex; flex-direction: column; gap: .2rem; }
    .rz-ev-json { flex: 1; min-width: 16rem; }
    .rz-ev-lbl { font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted); }
    .rz-json { font-family: var(--font-mono, ui-monospace, monospace); font-size: .72rem; margin: 0; white-space: pre-wrap; word-break: break-word; color: var(--text-main); }
  `],
})
export class ComercialRazonamientoComponent implements OnInit {
  private readonly api = inject(CommercialIntelligenceService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  rows = signal<CommercialFinding[]>([]);
  loading = signal(false);
  computing = signal(false);
  expanded: Record<string, boolean> = {};

  fStatus = 'open';
  fSev = '';
  fType = '';
  statusOpts = [
    { label: 'Abiertos', value: 'open' },
    { label: 'Confirmados', value: 'confirmed' },
    { label: 'Descartados', value: 'dismissed' },
    { label: 'Resueltos', value: 'resolved' },
  ];
  sevOpts = [
    { label: 'Crítica', value: 'critica' },
    { label: 'Alta', value: 'alta' },
    { label: 'Media', value: 'media' },
  ];

  kpis = computed(() => {
    const by = new Map<string, number>();
    for (const r of this.rows()) by.set(r.finding_type, (by.get(r.finding_type) || 0) + 1);
    return [...by.entries()].map(([type, n]) => ({ type, n })).sort((a, b) => b.n - a.n);
  });

  ngOnInit(): void { this.reload(); }

  reload(): void {
    this.loading.set(true);
    this.api.findings({ status: this.fStatus, severity: this.fSev || undefined, subject_type: undefined })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          const rows = this.fType ? r.filter((x) => x.finding_type === this.fType) : r;
          this.rows.set(rows); this.loading.set(false);
        },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar los hallazgos.' }); },
      });
  }

  toggleType(t: string): void { this.fType = this.fType === t ? '' : t; this.reload(); }

  review(f: CommercialFinding, status: string): void {
    this.api.reviewFinding(f.id, status).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.toast.add({ severity: 'success', summary: 'Listo', detail: `Hallazgo ${this.statusLabel(status)}` });
        this.reload();
      },
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo actualizar (¿permiso de gestión?).' }),
    });
  }

  recompute(): void {
    this.computing.set(true);
    this.api.computeFindings().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.computing.set(false); this.toast.add({ severity: 'success', summary: 'Recalculado', detail: `${r?.findings ?? '—'} hallazgo(s)` }); this.reload(); },
      error: (e) => { this.computing.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo recalcular (¿permiso de gestión?).' }); },
    });
  }

  pretty(v: unknown): string { try { return v ? JSON.stringify(v, null, 2) : '—'; } catch { return String(v); } }
  typeLabel(t: string): string {
    return ({
      low_rotation_priced: 'Rotación con precio', margin_laggard: 'Margen rezagado',
      distribution_gap: 'Gap de distribución', churn_risk: 'Riesgo de churn',
    } as Record<string, string>)[t] || t;
  }
  sevLabel(s: string): string { return ({ critica: 'Crítica', alta: 'Alta', media: 'Media' } as Record<string, string>)[s] || s; }
  sevTag(s: string): Sev { return ({ critica: 'danger', alta: 'warn', media: 'secondary' } as Record<string, Sev>)[s] || 'info'; }
  statusLabel(s: string): string { return ({ open: 'reabierto', confirmed: 'confirmado', dismissed: 'descartado', resolved: 'resuelto' } as Record<string, string>)[s] || s; }
}
