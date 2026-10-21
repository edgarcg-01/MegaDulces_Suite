import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ProgressBarModule } from 'primeng/progressbar';
import { TeleventaDashboard, TeleventaService } from '../televenta.service';
import { callOutcomeLabel, callOutcomeSeverity } from '../call-outcomes';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';

const MXN = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

/**
 * E.4 — Resumen del canal de telemarketing.
 *
 * Jerarquía: primario = la facturación del canal (ERP) · secundario = las tablas por operador y
 * las últimas facturas · terciario = la actividad de llamadas, que sólo se pinta si existe.
 *
 * Auditoría 2026-10-21 (`[E.14]`): la cola se titulaba «priorizada» y no lo estaba, la actividad
 * dibujaba ceros que el propio aviso declaraba sin medir, el vencido dejaba fuera la deuda vieja
 * y las etiquetas de resultado usaban claves que el backend nunca manda.
 */
@Component({
  selector: 'app-televenta-dashboard',
  standalone: true,
  imports: [
    CommonModule, RouterLink,
    ButtonModule, CardModule, TableModule, TagModule, ProgressBarModule,
    MetricStripComponent, LoadStateComponent, FreshnessPillComponent,
  ],
  template: `
    <!-- [E.13] El encabezado nombra la PÁGINA, no el proyecto: la migaja ya dice Telemarketing. -->
    <div class="header-row">
      <div>
        <h1>Resumen del canal</h1>
        <p class="muted">Facturación del canal (ERP) y actividad de llamadas.</p>
      </div>
      <div class="header-actions">
        <app-freshness-pill measures="fetch" [since]="loadedAt()" />
        <button pButton severity="secondary" (click)="reload()" [loading]="loading()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
      </div>
    </div>

    <app-load-state [loading]="loading() && !data()" [error]="error()" [skeletonRows]="8"
      errorTitle="No se pudo cargar el resumen" (retry)="reload()">
      @if (data(); as d) {
        <!-- ── FACTURACIÓN: el resultado del canal. Va primero porque es lo que existe todos
             los días; la captura de llamadas puede no haber arrancado. -->
        <h2 class="section-title">
          <i class="pi pi-file" aria-hidden="true"></i> Facturación del canal
          @if (d.billing.ultima_factura) {
            <span class="asof">última factura {{ d.billing.ultima_factura | date: 'dd/MM/yy' }}</span>
          }
        </h2>
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
              <i class="pi pi-info-circle" aria-hidden="true"></i>
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

        <!-- ── ACTIVIDAD: sólo existe si alguien capturó llamadas. Sin captura no se pintan
             indicadores: un cero sin registro no es desempeño (ADR-056). -->
        <h2 class="section-title"><i class="pi pi-phone" aria-hidden="true"></i> Actividad de llamadas</h2>
        @if (!d.actividad.registrada) {
          <p class="aviso">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            <span>
              <strong>No hay llamadas capturadas en este módulo</strong>, así que no hay actividad
              que medir. Los indicadores aparecen cuando los operadores registren sus llamadas
              desde la cola. La facturación de arriba no depende de esto: sale del ERP.
            </span>
          </p>
        } @else {
          @if (d.my_stats) {
            <h3 class="sub-title"><i class="pi pi-user" aria-hidden="true"></i> Mis llamadas · hoy</h3>
            <app-metric-strip [items]="myItems(d)" ariaLabel="Mis llamadas de hoy" />
          }
          <h3 class="sub-title">Equipo · hoy</h3>
          <app-metric-strip [items]="teamItems(d)" ariaLabel="Llamadas del equipo hoy" />
          <div class="two-col">
            <p-card>
              <h3>Operadores con más llamadas · hoy</h3>
              <p-table [value]="d.top_operators" styleClass="p-datatable-sm">
                <ng-template #header>
                  <tr>
                    <th>#</th>
                    <th>Operador</th>
                    <th class="num">Llamadas</th>
                    <th class="num">Ventas</th>
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
                  <tr><td colspan="6" class="muted">Nadie ha registrado llamadas hoy.</td></tr>
                </ng-template>
              </p-table>
            </p-card>
            <p-card>
              <h3>Resultado de las llamadas · 7 días</h3>
              @for (o of d.outcomes_7d; track o.outcome) {
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
        }

        <!-- Los primeros 5 de la cola, en el mismo orden que /telemarketing/queue. -->
        <p-card class="queue-preview">
          <div class="card-header-row">
            <h3>Cola · próximos a llamar</h3>
            <a pButton routerLink="/telemarketing/queue" severity="secondary" [text]="true" size="small"><span class="p-button-label">Ver cola completa</span><span class="p-button-icon p-button-icon-right pi pi-arrow-right" aria-hidden="true"></span></a>
          </div>
          @if (d.billing.clientes_en_cola < d.billing.d30.clientes) {
            <p class="aviso">
              <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
              <span>
                La cola sale del padrón de clientes de la plataforma, no de quien compra por este
                canal: de los <strong>{{ d.billing.d30.clientes | number }}</strong> clientes facturados
                en 30 días, <strong>{{ d.billing.clientes_en_cola | number }}</strong> están en ella.
              </span>
            </p>
          }
          <p-table [value]="d.queue_preview" styleClass="p-datatable-sm">
            <ng-template #header>
              <tr>
                <th>Código</th>
                <th>Cliente</th>
                <th>Teléfono</th>
                <th>Último pedido</th>
                <th><span class="sr-only">Acciones</span></th>
              </tr>
            </ng-template>
            <ng-template #body let-c>
              <tr>
                <td><code>{{ c.code }}</code></td>
                <td><strong>{{ c.name }}</strong></td>
                <td>{{ c.phone || 'sin teléfono' }}</td>
                <td>{{ c.last_order_at ? (c.last_order_at | date: 'dd/MM/yy') : 'nunca' }}</td>
                <td><a pButton [routerLink]="['/telemarketing/lead', c.id]" size="small" [text]="true"><span class="p-button-icon p-button-icon-left pi pi-phone" aria-hidden="true"></span><span class="p-button-label">Tomar</span></a></td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="5" class="muted">Sin clientes por llamar en la cola.</td></tr>
            </ng-template>
          </p-table>
        </p-card>
      }
    </app-load-state>
  `,
  styles: [`
    :host { display:block; }
    .header-row { display:flex; justify-content:space-between; align-items:flex-end; gap:var(--sp-4); flex-wrap:wrap; margin-bottom:var(--sp-4); }
    .header-row h1 { margin:0 0 var(--sp-1); font-size:var(--fs-h2); font-weight:var(--fw-bold); }
    .header-actions { display:flex; align-items:center; gap:var(--sp-3); }
    .muted { color: var(--text-muted); font-size:var(--fs-sm); margin:0; }
    .section-title { margin: var(--sp-6) 0 var(--sp-3); font-size: var(--fs-micro); font-weight: var(--fw-bold); text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); }
    .section-title .asof { margin-left: var(--sp-2); text-transform: none; letter-spacing: 0; font-weight: var(--fw-regular); }
    code { background: var(--surface-100); padding:.1rem .35rem; border-radius:var(--r-sm); font-size:var(--fs-xs); }
    app-metric-strip { display:block; margin-bottom:var(--sp-6); }

    .two-col { display:grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr)); gap:var(--sp-4); }
    .two-col h3, .queue-preview h3 { margin: 0 0 var(--sp-3); font-size: var(--fs-h3); }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .num.pos { color: var(--ok-fg); font-weight: var(--fw-bold); }
    .num.debe { color: var(--bad-fg); font-weight: var(--fw-bold); }
    .sub-title { margin: var(--sp-4) 0 var(--sp-2); font-size: var(--fs-xs); font-weight: var(--fw-bold); color: var(--text-muted); }
    .sub-title i { margin-right: .35rem; }
    .sub { display: inline-block; margin-left: .35rem; font-size: var(--fs-xs); color: var(--text-muted); }
    .sub.bad { color: var(--bad-fg); }
    .mono { font-family: var(--font-mono); }
    .nota { display: flex; gap: .4rem; margin: var(--sp-3) 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
    /* Lo que no se pudo medir o no cubre el universo se DECLARA (ADR-056). */
    .aviso {
      display: flex; gap: var(--sp-2); align-items: flex-start; margin: 0 0 var(--sp-3);
      padding: .625rem .75rem; border-radius: var(--r-md);
      background: var(--warn-soft-bg); border: 1px solid var(--warn-border);
      font-size: var(--fs-sm); line-height: 1.45;
    }
    .aviso i { margin-top: .1rem; color: var(--warn-fg); }

    .outcome-row { margin-bottom: var(--sp-3); }
    .outcome-header { display:flex; justify-content:space-between; align-items:center; margin-bottom: var(--sp-1); }
    .outcome-count { font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }

    .queue-preview { display:block; margin-top: var(--sp-4); }
    .card-header-row { display:flex; justify-content:space-between; align-items:center; gap: var(--sp-2); margin-bottom: var(--sp-3); }
    .card-header-row h3 { margin: 0; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TeleventaDashboardComponent {
  private readonly api = inject(TeleventaService);

  readonly data = signal<TeleventaDashboard | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** Hora del navegador en que llegó la respuesta: la píldora dice «cargado», no «dato al». */
  readonly loadedAt = signal<Date | null>(null);

  constructor() {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.getDashboard().subscribe({
      next: (d) => {
        this.data.set(d);
        this.loadedAt.set(new Date());
        this.loading.set(false);
      },
      error: (e) => {
        this.loading.set(false);
        this.error.set(e?.error?.message || e?.message || 'El servidor no respondió.');
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
   * E.9 — el dinero del canal. Cada cifra dice su ventana en el rótulo: la sección ya no lleva
   * «últimos 30 días» porque el vencido abarca toda la cartera.
   * «Ya cobrado» es de lo FACTURADO en 30 días (importe − saldo), no el dinero que entró en
   * esos días — por eso no se rotula «Cobrado 30d».
   */
  billingItems(d: TeleventaDashboard): MetricStripItem[] {
    const b = d.billing;
    const cobrado = b.d30.importe - b.d30.saldo;
    const pctCobrado = b.d30.importe > 0 ? (cobrado / b.d30.importe) * 100 : null;
    const v = b.cartera_vencida;
    return [
      {
        label: 'Facturado 30 días', value: b.d30.importe, format: 'currency',
        sub: `${b.d30.facturas.toLocaleString('es-MX')} facturas · ${b.d30.clientes.toLocaleString('es-MX')} clientes`,
      },
      { label: 'Este mes', value: b.mes.importe, format: 'currency', sub: `${b.mes.facturas.toLocaleString('es-MX')} facturas` },
      {
        label: 'Ya cobrado', value: cobrado, format: 'currency',
        sub: pctCobrado == null ? 'de lo facturado en 30 días' : `${pctCobrado.toFixed(0)}% de lo facturado en 30 días`,
      },
      {
        label: 'Vencido · toda la cartera', value: v.saldo, format: 'currency',
        tone: v.saldo > 0 ? 'bad' : undefined,
        sub: `${v.facturas.toLocaleString('es-MX')} facturas · ${MXN.format(b.d30.saldo_vencido)} de los últimos 30 días`,
      },
    ];
  }

  myItems(d: TeleventaDashboard): MetricStripItem[] {
    const m = d.my_stats!;
    return [
      { label: 'Llamadas', value: m.my_calls },
      { label: 'Ventas confirmadas', value: m.my_orders, tone: m.my_orders > 0 ? 'ok' : undefined },
      { label: 'Minutos en línea', value: m.my_minutes },
      this.conversionItem('Mi conversión', m.my_orders, m.my_calls, 'sin llamadas tuyas hoy'),
    ];
  }

  teamItems(d: TeleventaDashboard): MetricStripItem[] {
    const c7 = d.conversion_7d;
    const conv7 = this.conversionItem('Conversión 7 días', c7.orders_taken, c7.total_calls, 'sin llamadas en 7 días');
    return [
      { label: 'Llamadas hoy', value: d.today.calls, sub: `${d.today.total_minutes} min totales` },
      {
        label: 'Ventas confirmadas', value: d.today.orders_taken,
        tone: d.today.orders_taken > 0 ? 'ok' : undefined,
        sub: d.today.calls ? `${((d.today.orders_taken / d.today.calls) * 100).toFixed(1)}% de las llamadas` : 'sin llamadas hoy',
      },
      { label: 'Reservas activas', value: d.active_reservations.total, sub: `${d.active_reservations.unique_operators} operadores` },
      { ...conv7, sub: c7.total_calls ? `${c7.orders_taken} / ${c7.total_calls} llamadas` : conv7.sub },
    ];
  }

  /** Sin llamadas no hay conversión: se declara «no medido», no se dibuja un 0 %. */
  private conversionItem(label: string, ventas: number, llamadas: number, motivo: string): MetricStripItem {
    if (!llamadas) {
      return { label, value: '—', format: 'text', state: 'no_medido', stateNote: motivo, sub: motivo };
    }
    return { label, value: (ventas / llamadas) * 100, format: 'percent' };
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
    return callOutcomeLabel(outcome);
  }
  outcomeSeverity(outcome: string): ReturnType<typeof callOutcomeSeverity> {
    return callOutcomeSeverity(outcome);
  }
}
