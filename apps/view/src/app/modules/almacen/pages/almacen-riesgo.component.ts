import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { RiesgoService, RiskRow } from '../riesgo.service';

/**
 * Fase PREV.3 — Índice de riesgo de inventario (Apéndice B §14-15). Lista priorizada
 * por (almacén, producto) para dirigir recursos de Prevención. NO por persona.
 * Ver = COMMERCIAL_PREVENTION_VER, recalcular = COMMERCIAL_PREVENTION_GESTIONAR.
 */
@Component({
  selector: 'app-almacen-riesgo',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule, ToastModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Índice de riesgo</h1>
          <p class="surf-page-sub">Prioridad de Prevención por SKU y almacén — reincidencia + pérdidas no identificadas</p>
        </div>
        <div class="rk-head-actions">
          <p-select [options]="levelOptions" [(ngModel)]="levelFilter" optionLabel="label" optionValue="value" (onChange)="reload()" styleClass="rk-lvl"></p-select>
          @if (canManage()) {
            <button pButton size="small" (click)="recompute()" [loading]="computing()"><span class="p-button-icon p-button-icon-left pi pi-sync" aria-hidden="true"></span> Recalcular</button>
          }
        </div>
      </header>

      @if (items().length > 0) {
        <div class="rk-kpis">
          <div class="rk-kpi rk-critico"><span class="rk-kpi-n">{{ countBy('critico') }}</span><span class="rk-kpi-l">críticos</span></div>
          <div class="rk-kpi rk-alto"><span class="rk-kpi-n">{{ countBy('alto') }}</span><span class="rk-kpi-l">alto</span></div>
          <div class="rk-kpi rk-medio"><span class="rk-kpi-n">{{ countBy('medio') }}</span><span class="rk-kpi-l">medio</span></div>
          <div class="rk-kpi"><span class="rk-kpi-n">{{ totalShrink() | currency:'MXN':'symbol-narrow':'1.0-0' }}</span><span class="rk-kpi-l">merma acumulada</span></div>
        </div>
      }

      <p-table [value]="items()" [loading]="loading()" styleClass="p-datatable-sm surf-table surf-table--zebra" [scrollable]="true" scrollHeight="flex" [paginator]="true" [rows]="50" [rowsPerPageOptions]="[50,100,200]">
        <ng-template #header>
          <tr>
            <th scope="col">Nivel</th><th scope="col" class="num">Score</th><th scope="col">Producto</th><th scope="col">Almacén</th>
            <th scope="col" class="num">Exp.</th><th scope="col" class="num">PNI</th><th scope="col" class="num">Monit.</th><th scope="col" class="num">Merma</th><th scope="col">Últ. evento</th>
          </tr>
        </ng-template>
        <ng-template #body let-r>
          <tr>
            <td><p-tag [value]="levelLabel(r.risk_level)" [severity]="levelSeverity(r.risk_level)"></p-tag></td>
            <td class="num rk-strong">{{ r.risk_score }}</td>
            <td class="rk-name">{{ r.product_name || r.product_id }}</td>
            <td class="rk-mono">{{ r.warehouse_code }}</td>
            <td class="num">{{ r.investigations_count }}</td>
            <td class="num" [class.rk-neg]="+r.pni_count > 0">{{ r.pni_count }}</td>
            <td class="num">{{ r.monitoring_losses }}</td>
            <td class="num">{{ r.shrink_value | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
            <td class="rk-mono">{{ r.last_event_at | date:'dd/MM/yy' }}</td>
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="9" class="comm-empty-cell"><div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-chart-bar" aria-hidden="true"></i></div><h3>Sin índice</h3><p>Recalculá para poblar el índice desde los expedientes y el monitoreo (ventana 90 días).</p></div></td></tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [`
    .rk-head-actions { display: flex; gap: .5rem; align-items: center; }
    :host ::ng-deep .rk-lvl { min-width: 150px; }
    .rk-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: .75rem; margin: 0 0 1rem; }
    .rk-kpi { background: var(--surface-card, var(--surface-0)); border: 1px solid var(--surface-border); border-radius: 10px; padding: .6rem .8rem; display: flex; flex-direction: column; }
    .rk-kpi-n { font-size: 1.4rem; font-weight: 800; font-variant-numeric: tabular-nums; }
    .rk-kpi-l { font-size: .74rem; color: var(--text-color-secondary); text-transform: uppercase; letter-spacing: .04em; }
    .rk-critico .rk-kpi-n { color: var(--bad-fg, #b91c1c); }
    .rk-alto .rk-kpi-n { color: var(--warn-fg, #b45309); }
    .rk-mono { font-family: var(--font-mono, monospace); }
    .rk-strong { font-weight: 800; }
    .rk-neg { color: var(--bad-fg, #b91c1c); font-weight: 700; }
    .rk-name { max-width: 280px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  `],
})
export class AlmacenRiesgoComponent implements OnInit {
  private readonly svc = inject(RiesgoService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  readonly items = signal<RiskRow[]>([]);
  readonly loading = signal(false);
  readonly computing = signal(false);
  levelFilter = '';

  readonly levelOptions = [
    { label: 'Todos los niveles', value: '' },
    { label: 'Crítico', value: 'critico' },
    { label: 'Alto', value: 'alto' },
    { label: 'Medio', value: 'medio' },
    { label: 'Bajo', value: 'bajo' },
  ];

  ngOnInit(): void { this.reload(); }

  reload(): void {
    this.loading.set(true);
    this.svc.list({ risk_level: this.levelFilter || undefined, limit: 300 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.items.set(rows || []); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  recompute(): void {
    this.computing.set(true);
    this.svc.compute().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.computing.set(false); this.toast.add({ severity: 'success', summary: 'Índice recalculado', detail: `${r.computed} SKU con riesgo` }); this.reload(); },
      error: (e) => { this.computing.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo recalcular' }); },
    });
  }

  countBy(level: string): number { return this.items().filter((r) => r.risk_level === level).length; }
  totalShrink(): number { return this.items().reduce((a, r) => a + Number(r.shrink_value), 0); }

  canManage(): boolean {
    return this.perms.can('manage', 'all') || !!this.auth.user()?.permissions?.[Permission.COMMERCIAL_PREVENTION_GESTIONAR];
  }

  levelLabel(l: string): string {
    return l === 'critico' ? 'Crítico' : l === 'alto' ? 'Alto' : l === 'medio' ? 'Medio' : 'Bajo';
  }
  levelSeverity(l: string): 'danger' | 'warn' | 'info' | 'secondary' {
    return l === 'critico' ? 'danger' : l === 'alto' ? 'warn' : l === 'medio' ? 'info' : 'secondary';
  }
}
