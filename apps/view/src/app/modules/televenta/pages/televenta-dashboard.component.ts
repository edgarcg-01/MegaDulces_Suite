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
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';

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
    ButtonModule, CardModule, TableModule, TagModule, ProgressBarModule, ToastModule, MetricStripComponent,
  ],
  providers: [MessageService],
  template: `
    <p-toast></p-toast>
    
    <div class="header-row">
      <div>
        <h2>Telemarketing</h2>
        <p class="muted">Facturación del canal + productividad del día + conversión 7d.</p>
      </div>
      <button pButton severity="secondary" (click)="reload()" [loading]="loading()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
    </div>
    
    @if (data(); as d) {
      <!-- ── FACTURACIÓN: el resultado del canal. Va primero porque es lo que existe ──
           (el ERP factura telemarketing todos los días; la captura de llamadas puede no
           haber arrancado, y entonces los bloques de actividad son ceros sin significado) -->
      <h3 class="section-title">
        <i class="pi pi-file"></i> Facturación del canal · últimos 30 días
        @if (d.billing.ultima_factura) {
          <span class="asof">última factura {{ d.billing.ultima_factura | date: 'dd/MM/yy' }}</span>
        }
      </h3>
      <app-metric-strip [items]="billingItems(d)" ariaLabel="Facturación de telemarketing" />

      <div class="two-col">
        <p-card>
          <div class="card-header-row">
            <h3>Por operador · 30 días</h3>
            <span class="muted">atribución del ERP</span>
          </div>
          <p-table [value]="d.billing.por_operador" styleClass="p-datatable-sm">
            <ng-template #header>
              <tr>
                <th>Operador</th>
                <th class="num">Facturas</th>
                <th class="num">Clientes</th>
                <th class="num">Facturado</th>
                <th class="num">Por cobrar</th>
              </tr>
            </ng-template>
            <ng-template #body let-o>
              <tr>
                <td>
                  <strong>{{ o.vendedor_nombre || 'Sin vendedor asignado' }}</strong>
                  @if (o.vendedor_code) { <span class="sub mono">{{ o.vendedor_code }}</span> }
                </td>
                <td class="num">{{ o.facturas }}</td>
                <td class="num">{{ o.clientes }}</td>
                <td class="num">{{ +o.importe | currency: 'MXN':'symbol-narrow':'1.0-0':'es-MX' }}</td>
                <td class="num debe">{{ +o.saldo | currency: 'MXN':'symbol-narrow':'1.0-0':'es-MX' }}</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="5" class="muted">Sin facturas de telemarketing en los últimos 30 días.</td></tr>
            </ng-template>
          </p-table>
          <p class="nota">
            <i class="pi pi-info-circle"></i>
            El operador lo asigna el ERP (<code>vendedor_code</code>). No se puede cruzar con el
            usuario que registra las llamadas: no hay campo que los ligue.
          </p>
        </p-card>

        <p-card>
          <div class="card-header-row">
            <h3>Últimas facturas</h3>
            <a pButton routerLink="/comercial/documentos" severity="secondary" [text]="true" size="small"
              ><span class="p-button-label">Ver todas</span
              ><span class="p-button-icon p-button-icon-right pi pi-arrow-right" aria-hidden="true"></span
            ></a>
          </div>
          <p-table [value]="d.billing.ultimas" styleClass="p-datatable-sm">
            <ng-template #header>
              <tr><th>Folio</th><th>Cliente</th><th class="num">Total</th><th>Cobro</th></tr>
            </ng-template>
            <ng-template #body let-f>
              <tr>
                <td>
                  <code>{{ f.sucursal }} {{ f.doc_prefix }}-{{ f.folio }}</code>
                  <span class="sub">{{ f.fecha | date: 'dd/MM/yy' }}</span>
                </td>
                <td>{{ f.cliente_nombre }}</td>
                <td class="num">{{ +f.total | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</td>
                <td>
                  <p-tag [severity]="COBRO_TONE[f.estatus_cobro]" [value]="COBRO_LABEL[f.estatus_cobro]"></p-tag>
                  @if (f.vencida) { <span class="sub bad">vencida</span> }
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="4" class="muted">Sin facturas en el periodo.</td></tr>
            </ng-template>
          </p-table>
        </p-card>
      </div>

      <!-- ── ACTIVIDAD: sólo significa algo si alguien capturó llamadas ── -->
      <h3 class="section-title"><i class="pi pi-phone"></i> Actividad de llamadas</h3>
      @if (!d.actividad.registrada) {
        <p class="sin-captura">
          <i class="pi pi-exclamation-triangle"></i>
          <span>
            <strong>No hay llamadas capturadas en este módulo</strong>, así que los indicadores de
            actividad están en cero por falta de registro, no por falta de trabajo. Se llenan solos
            cuando los operadores empiecen a registrar sus llamadas desde la cola.
            La facturación de arriba no depende de esto: sale del ERP.
          </span>
        </p>
      }
      <!-- Mi performance (operador) -->
      @if (d.my_stats) {
        <h4 class="sub-title"><i class="pi pi-user"></i> Mi performance hoy</h4>
        <app-metric-strip [items]="myItems(d)" ariaLabel="Mi performance de hoy" />
      }
      <!-- KPIs del equipo (hoy) -->
      <h4 class="sub-title">Equipo · Hoy</h4>
      <app-metric-strip [items]="teamItems(d)" ariaLabel="Métricas del equipo hoy" />
      <!-- Two-column -->
      <div class="two-col">
        <!-- Top operadores -->
        <p-card>
          <h3>Top operadores · hoy</h3>
          <p-table [value]="d.top_operators" styleClass="p-datatable-sm">
            <ng-template #header>
              <tr>
                <th>#</th>
                <th>Operador</th>
                <th class="num">Llamadas</th>
                <th class="num">Pedidos</th>
                <th class="num">Min</th>
                <th class="num">Conv.</th>
              </tr>
            </ng-template>
            <ng-template #body let-op let-i="rowIndex">
              <tr>
                <td><strong>{{ i + 1 }}</strong></td>
                <td>{{ op.username || '—' }}</td>
                <td class="num">{{ op.calls }}</td>
                <td class="num pos">{{ op.orders }}</td>
                <td class="num">{{ op.minutes }}</td>
                <td class="num">{{ opConversion(op) | number:'1.1-1' }}%</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="6" class="muted">Sin actividad hoy.</td></tr>
            </ng-template>
          </p-table>
        </p-card>
        <!-- Outcomes breakdown (7d) -->
        <p-card>
          <h3>Outcomes · últimos 7 días</h3>
          @for (o of d.outcomes_7d; track o) {
            <div class="outcome-row">
              <div class="outcome-header">
                <p-tag [value]="outcomeLabel(o.outcome)" [severity]="outcomeSeverity(o.outcome)"></p-tag>
                <span class="outcome-count">{{ o.count }}</span>
              </div>
              <p-progressbar [value]="outcomePct(o, d)" [showValue]="false"></p-progressbar>
            </div>
          }
          @if (d.outcomes_7d.length === 0) {
            <p class="muted">Sin llamadas registradas en los últimos 7 días.</p>
          }
        </p-card>
      </div>
      <!-- Queue preview (top 5 leads urgentes) -->
      <p-card class="queue-preview">
        <div class="card-header-row">
          <h3>Cola priorizada · próximos a llamar</h3>
          <a pButton routerLink="/televenta/queue" severity="secondary" [text]="true" size="small"><span class="p-button-label">Ver cola completa</span><span class="p-button-icon p-button-icon-right pi pi-arrow-right" aria-hidden="true"></span></a>
        </div>
        <p-table [value]="d.queue_preview" styleClass="p-datatable-sm">
          <ng-template #header>
            <tr>
              <th>Código</th>
              <th>Cliente</th>
              <th>Teléfono</th>
              <th>Último pedido</th>
              <th></th>
            </tr>
          </ng-template>
          <ng-template #body let-c>
            <tr>
              <td><code>{{ c.code }}</code></td>
              <td><strong>{{ c.name }}</strong></td>
              <td>{{ c.phone || '—' }}</td>
              <td>{{ c.last_order_at ? (c.last_order_at | date:'mediumDate') : '—' }}</td>
              <td><a pButton [routerLink]="['/telemarketing/lead', c.id]" size="small" [text]="true"><span class="p-button-icon p-button-icon-left pi pi-phone" aria-hidden="true"></span><span class="p-button-label">Tomar</span></a></td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="5" class="muted">Cola al día 🎉</td></tr>
          </ng-template>
        </p-table>
      </p-card>
    }
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
    app-metric-strip { display:block; margin-bottom:1.5rem; }

    .two-col { display:grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap:1rem; }
    .two-col h3 { margin: 0 0 .75rem; font-size: 1rem; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .num.pos { color: var(--ok-fg); font-weight: 600; }
    /* E.9 — facturación */
    .sub-title { margin: 1rem 0 .5rem; font-size: .8rem; font-weight: 600; color: var(--text-color-secondary); }
    .sub-title i { margin-right: .35rem; }
    .section-title .asof { margin-left: .5rem; text-transform: none; letter-spacing: 0; font-weight: 400; opacity: .8; }
    .num.debe { color: var(--danger, var(--text-color)); font-weight: 600; }
    .sub { display: inline-block; margin-left: .35rem; font-size: .75rem; color: var(--text-color-secondary); }
    .sub.bad { color: var(--danger, var(--text-color)); }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); }
    .nota { display: flex; gap: .4rem; margin: .75rem 0 0; font-size: .75rem; color: var(--text-color-secondary); }
    /* Lo que no se pudo medir se declara, no se dibuja como cero (ADR-056) */
    .sin-captura {
      display: flex; gap: .5rem; align-items: flex-start; margin: 0 0 .75rem;
      padding: .625rem .75rem; border-radius: var(--radius-md, 6px);
      background: var(--warn-bg, rgba(234,179,8,.08));
      border: 1px solid var(--warn-border, rgba(234,179,8,.28));
      font-size: .8rem; line-height: 1.45;
    }
    .sin-captura i { margin-top: .1rem; color: var(--warn-fg, #b45309); }

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

  readonly COBRO_LABEL: Record<string, string> = {
    pagada: 'Pagada', parcial: 'Parcial', pendiente: 'Pendiente',
    sin_cartera: 'Sin cartera', cancelada: 'Cancelada',
  };
  readonly COBRO_TONE: Record<string, 'success' | 'warn' | 'danger' | 'secondary' | 'info'> = {
    pagada: 'success', parcial: 'warn', pendiente: 'info',
    sin_cartera: 'secondary', cancelada: 'secondary',
  };

  /**
   * E.9 — el dinero del canal. Lo que se cobra va como tono `ok` y lo vencido como `bad`:
   * el saldo total no es malo (es crédito vivo), el vencido sí.
   */
  billingItems(d: TeleventaDashboard): MetricStripItem[] {
    const b = d.billing;
    return [
      { label: 'Facturado 30d', value: b.d30.importe, format: 'currency' },
      { label: 'Facturas', value: b.d30.facturas, format: 'number', sub: `${b.d30.clientes} clientes` },
      { label: 'Este mes', value: b.mes.importe, format: 'currency', sub: `${b.mes.facturas} facturas` },
      { label: 'Cobrado 30d', value: b.d30.importe - b.d30.saldo, format: 'currency', tone: 'ok' },
      {
        label: 'Vencido por cobrar', value: b.d30.saldo_vencido, format: 'currency',
        tone: b.d30.saldo_vencido > 0 ? 'bad' : undefined,
        sub: `${b.d30.facturas_vencidas} facturas`,
      },
    ];
  }

  myItems(d: TeleventaDashboard): MetricStripItem[] {
    const m = d.my_stats!;
    return [
      { label: 'Llamadas', value: m.my_calls },
      { label: 'Pedidos cerrados', value: m.my_orders, tone: 'ok' },
      { label: 'Minutos en línea', value: m.my_minutes },
      { label: 'Mi conversión', value: this.myConversion(d), format: 'percent' },
    ];
  }
  teamItems(d: TeleventaDashboard): MetricStripItem[] {
    return [
      { label: 'Llamadas hoy', value: d.today.calls, sub: `${d.today.total_minutes} min totales` },
      { label: 'Pedidos cerrados', value: d.today.orders_taken, tone: 'ok', sub: `${this.todayConversion(d).toFixed(1)}% conversión` },
      { label: 'Reservas activas', value: d.active_reservations.total, tone: 'warn', sub: `${d.active_reservations.unique_operators} operadores` },
      { label: 'Conversión 7d', value: d.conversion_7d.conversion_pct, format: 'percent', sub: `${d.conversion_7d.orders_taken} / ${d.conversion_7d.total_calls} llamadas` },
    ];
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
