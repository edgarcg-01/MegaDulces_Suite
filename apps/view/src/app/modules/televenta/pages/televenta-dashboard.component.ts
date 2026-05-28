import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ProgressBarModule } from 'primeng/progressbar';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { TeleventaDashboard, TeleventaService } from '../televenta.service';

type Severity = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/**
 * E.4 — Dashboard de métricas televenta.
 *
 * Productividad de operadores + conversión + outcomes breakdown + queue
 * preview. Para managers (todos los operadores) y operadores (sus propias
 * stats destacadas).
 */
@Component({
  selector: 'app-televenta-dashboard',
  standalone: true,
  imports: [
    CommonModule, RouterLink,
    ButtonModule, CardModule, TableModule, TagModule, ProgressBarModule, ToastModule,
  ],
  providers: [MessageService],
  template: `
    <p-toast></p-toast>

    <div class="header-row">
      <div>
        <h2>Dashboard Televenta</h2>
        <p class="muted">Productividad del día + conversión 7d + ranking operadores.</p>
      </div>
      <button pButton icon="pi pi-refresh" label="Actualizar" severity="secondary" (click)="reload()" [loading]="loading()"></button>
    </div>

    <ng-container *ngIf="data() as d">

      <!-- Mi performance (operador) -->
      <div class="my-stats" *ngIf="d.my_stats">
        <p-card>
          <h3><i class="pi pi-user"></i> Mi performance hoy</h3>
          <div class="mini-grid">
            <div>
              <div class="kpi-label">Llamadas</div>
              <div class="kpi-value">{{ d.my_stats.my_calls }}</div>
            </div>
            <div>
              <div class="kpi-label">Pedidos cerrados</div>
              <div class="kpi-value pos">{{ d.my_stats.my_orders }}</div>
            </div>
            <div>
              <div class="kpi-label">Minutos en línea</div>
              <div class="kpi-value">{{ d.my_stats.my_minutes }}</div>
            </div>
            <div>
              <div class="kpi-label">Mi conversión</div>
              <div class="kpi-value">{{ myConversion(d) | number:'1.1-1' }}%</div>
            </div>
          </div>
        </p-card>
      </div>

      <!-- KPIs del equipo (hoy) -->
      <h3 class="section-title">Equipo · Hoy</h3>
      <div class="kpi-grid">
        <div class="kpi-card kpi-purple">
          <div class="kpi-icon"><i class="pi pi-phone"></i></div>
          <div class="kpi-label">Llamadas hoy</div>
          <div class="kpi-value">{{ d.today.calls }}</div>
          <div class="kpi-sub muted">{{ d.today.total_minutes }} min totales</div>
        </div>

        <div class="kpi-card kpi-green">
          <div class="kpi-icon"><i class="pi pi-check-circle"></i></div>
          <div class="kpi-label">Pedidos cerrados</div>
          <div class="kpi-value">{{ d.today.orders_taken }}</div>
          <div class="kpi-sub muted">{{ todayConversion(d) | number:'1.1-1' }}% conversión</div>
        </div>

        <div class="kpi-card kpi-warn">
          <div class="kpi-icon"><i class="pi pi-clock"></i></div>
          <div class="kpi-label">Reservas activas</div>
          <div class="kpi-value">{{ d.active_reservations.total }}</div>
          <div class="kpi-sub muted">{{ d.active_reservations.unique_operators }} operadores</div>
        </div>

        <div class="kpi-card kpi-info">
          <div class="kpi-icon"><i class="pi pi-chart-line"></i></div>
          <div class="kpi-label">Conversión 7d</div>
          <div class="kpi-value">{{ d.conversion_7d.conversion_pct }}%</div>
          <div class="kpi-sub muted">{{ d.conversion_7d.orders_taken }} / {{ d.conversion_7d.total_calls }} llamadas</div>
        </div>
      </div>

      <!-- Two-column -->
      <div class="two-col">
        <!-- Top operadores -->
        <p-card>
          <h3>Top operadores · hoy</h3>
          <p-table [value]="d.top_operators" responsiveLayout="scroll" styleClass="p-datatable-sm">
            <ng-template pTemplate="header">
              <tr>
                <th>#</th>
                <th>Operador</th>
                <th class="num">Llamadas</th>
                <th class="num">Pedidos</th>
                <th class="num">Min</th>
                <th class="num">Conv.</th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-op let-i="rowIndex">
              <tr>
                <td><strong>{{ i + 1 }}</strong></td>
                <td>{{ op.username || '—' }}</td>
                <td class="num">{{ op.calls }}</td>
                <td class="num pos">{{ op.orders }}</td>
                <td class="num">{{ op.minutes }}</td>
                <td class="num">{{ opConversion(op) | number:'1.1-1' }}%</td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage">
              <tr><td colspan="6" class="muted">Sin actividad hoy.</td></tr>
            </ng-template>
          </p-table>
        </p-card>

        <!-- Outcomes breakdown (7d) -->
        <p-card>
          <h3>Outcomes · últimos 7 días</h3>
          <div class="outcome-row" *ngFor="let o of d.outcomes_7d">
            <div class="outcome-header">
              <p-tag [value]="outcomeLabel(o.outcome)" [severity]="outcomeSeverity(o.outcome)"></p-tag>
              <span class="outcome-count">{{ o.count }}</span>
            </div>
            <p-progressBar [value]="outcomePct(o, d)" [showValue]="false"></p-progressBar>
          </div>
          <p *ngIf="d.outcomes_7d.length === 0" class="muted">Sin llamadas registradas en los últimos 7 días.</p>
        </p-card>
      </div>

      <!-- Queue preview (top 5 leads urgentes) -->
      <p-card class="queue-preview">
        <div class="card-header-row">
          <h3>Cola priorizada · próximos a llamar</h3>
          <a pButton routerLink="/televenta/queue" label="Ver cola completa" icon="pi pi-arrow-right" iconPos="right" severity="secondary" [text]="true" size="small"></a>
        </div>
        <p-table [value]="d.queue_preview" responsiveLayout="scroll" styleClass="p-datatable-sm">
          <ng-template pTemplate="header">
            <tr>
              <th>Código</th>
              <th>Cliente</th>
              <th>Teléfono</th>
              <th>Último pedido</th>
              <th></th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-c>
            <tr>
              <td><code>{{ c.code }}</code></td>
              <td><strong>{{ c.name }}</strong></td>
              <td>{{ c.phone || '—' }}</td>
              <td>{{ c.last_order_at ? (c.last_order_at | date:'mediumDate') : '—' }}</td>
              <td><a pButton [routerLink]="['/televenta/lead', c.id]" label="Tomar" icon="pi pi-phone" size="small" [text]="true"></a></td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage">
            <tr><td colspan="5" class="muted">Cola al día 🎉</td></tr>
          </ng-template>
        </p-table>
      </p-card>
    </ng-container>
  `,
  styles: [`
    :host { display:block; }
    .header-row { display:flex; justify-content:space-between; align-items:flex-end; gap:1rem; flex-wrap:wrap; margin-bottom:1rem; }
    .header-row h2 { margin:0 0 .25rem; font-size:1.25rem; }
    .muted { color: var(--text-color-secondary); font-size:.85rem; margin:0; }
    .section-title { margin: 1.5rem 0 .75rem; font-size: .9rem; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--text-color-secondary); }
    code { background: var(--surface-100); padding:.1rem .35rem; border-radius:3px; font-size:.85rem; }

    .my-stats h3 { margin:0 0 .75rem; font-size:1rem; }
    .my-stats h3 i { margin-right: .35rem; color: var(--primary-color); }
    .mini-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem; }
    .mini-grid > div { padding: .5rem 0; }

    .kpi-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:1rem; margin-bottom:1.5rem; }
    .kpi-card {
      background: var(--surface-card, var(--surface-50));
      border-left: 4px solid var(--surface-300);
      border-radius: 8px;
      padding: 1rem 1.25rem;
    }
    .kpi-purple { border-left-color: #9333ea; }
    .kpi-purple .kpi-icon { color: #9333ea; }
    .kpi-green { border-left-color: #16a34a; }
    .kpi-green .kpi-icon { color: #16a34a; }
    .kpi-warn { border-left-color: #eab308; }
    .kpi-warn .kpi-icon { color: #eab308; }
    .kpi-info { border-left-color: #0ea5e9; }
    .kpi-info .kpi-icon { color: #0ea5e9; }
    .kpi-icon { font-size:1.25rem; margin-bottom:.5rem; }
    .kpi-label { font-size:.75rem; text-transform:uppercase; letter-spacing:.05em; color: var(--text-color-secondary); }
    .kpi-value { font-size:1.75rem; font-weight:700; margin-top:.25rem; }
    .kpi-value.pos { color: #16a34a; }
    .kpi-sub { font-size:.75rem; margin-top:.5rem; }

    .two-col { display:grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap:1rem; }
    .two-col h3 { margin: 0 0 .75rem; font-size: 1rem; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .num.pos { color: #16a34a; font-weight: 600; }

    .outcome-row { margin-bottom: .75rem; }
    .outcome-header { display:flex; justify-content:space-between; align-items:center; margin-bottom: .25rem; }
    .outcome-count { font-weight: 600; }

    .queue-preview { margin-top: 1rem; }
    .card-header-row { display:flex; justify-content:space-between; align-items:center; margin-bottom: .75rem; }
    .card-header-row h3 { margin: 0; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TeleventaDashboardComponent {
  private readonly api = inject(TeleventaService);
  private readonly toast = inject(MessageService);

  readonly data = signal<TeleventaDashboard | null>(null);
  readonly loading = signal(false);

  constructor() {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.api.getDashboard().subscribe({
      next: (d) => { this.data.set(d); this.loading.set(false); },
      error: () => {
        this.loading.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se cargó el dashboard' });
      },
    });
  }

  todayConversion(d: TeleventaDashboard): number {
    if (!d.today.calls) return 0;
    return (d.today.orders_taken / d.today.calls) * 100;
  }
  myConversion(d: TeleventaDashboard): number {
    if (!d.my_stats || !d.my_stats.my_calls) return 0;
    return (d.my_stats.my_orders / d.my_stats.my_calls) * 100;
  }
  opConversion(op: { calls: number; orders: number }): number {
    if (!op.calls) return 0;
    return (op.orders / op.calls) * 100;
  }
  outcomePct(o: { count: number }, d: TeleventaDashboard): number {
    const total = d.outcomes_7d.reduce((acc, x) => acc + x.count, 0);
    return total > 0 ? (o.count / total) * 100 : 0;
  }
  outcomeLabel(outcome: string): string {
    const map: Record<string, string> = {
      pedido_tomado: 'Pedido tomado',
      no_contesto: 'No contestó',
      callback_solicitado: 'Callback',
      callback_scheduled: 'Callback',
      no_interesado: 'No interesado',
      error_contacto: 'Error contacto',
    };
    return map[outcome] || outcome;
  }
  outcomeSeverity(outcome: string): Severity {
    if (outcome === 'pedido_tomado') return 'success';
    if (outcome === 'callback_solicitado' || outcome === 'callback_scheduled') return 'info';
    if (outcome === 'no_interesado') return 'danger';
    return 'warn';
  }
}
