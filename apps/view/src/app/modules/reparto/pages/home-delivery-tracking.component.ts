import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { SelectButtonModule } from 'primeng/selectbutton';
import { DispatchedDelivery, HomeDeliveryService } from '../home-delivery.service';

/**
 * Reparto — SEGUIMIENTO para el personal de tienda: dónde va cada pedido
 * despachado hoy (estado + repartidor + hora de entrega). Auto-refresca cada
 * 30 s; también se puede refrescar a mano. Muestra `delivered_at` cuando el
 * repartidor cierra la entrega (§ "mostrar cuándo terminó de entregarlo").
 */
@Component({
  selector: 'app-home-delivery-tracking',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, TagModule, ButtonModule, SelectButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="trk">
      <header class="trk-head">
        <div>
          <h1>Seguimiento de entregas</h1>
          <p class="sub">Dónde va cada pedido despachado hoy</p>
        </div>
        <div class="head-actions">
          <p-selectButton [options]="filters" [(ngModel)]="statusFilter" optionLabel="label" optionValue="value"
                          (onChange)="load()" [allowEmpty]="false" />
          <button pButton icon="pi pi-refresh" [label]="loading() ? 'Actualizando…' : 'Actualizar'"
                  size="small" severity="secondary" (click)="load()" [disabled]="loading()"></button>
        </div>
      </header>

      <div class="kpis">
        <div class="kpi"><span>Total</span><b>{{ rows().length }}</b></div>
        <div class="kpi"><span>En camino</span><b class="pend">{{ countBy('pendiente') }}</b></div>
        <div class="kpi"><span>Entregadas</span><b class="ok">{{ countBy('entregado') }}</b></div>
        <div class="kpi"><span>Incidencias</span><b class="bad">{{ incidents() }}</b></div>
      </div>

      <p-table [value]="rows()" [loading]="loading()" styleClass="p-datatable-sm" [scrollable]="true"
               [rowHover]="true" dataKey="delivery_id">
        <ng-template pTemplate="header">
          <tr>
            <th>Folio</th>
            <th>Cliente</th>
            <th>Domicilio</th>
            <th>Repartidor</th>
            <th class="num">Cobro</th>
            <th>Estado</th>
            <th>Despachado</th>
            <th>Entregado</th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-d>
          <tr>
            <td class="mono">{{ d.folio }}<div class="sub2" *ngIf="d.kepler_folio">Kepler {{ d.kepler_folio }}</div></td>
            <td>{{ d.customer_name }}<div class="sub2" *ngIf="d.phone">{{ d.phone }}</div></td>
            <td class="addr">{{ d.delivery_address?.street || '—' }}</td>
            <td>{{ d.rider_name || d.rider_username || '—' }}</td>
            <td class="num">
              @if (d.collect_on_delivery) { {{ money(d.amount_to_collect) }} }
              @else { <span class="paid">pagado</span> }
            </td>
            <td><p-tag [value]="statusLabel(d)" [severity]="statusSeverity(d.status)" /></td>
            <td class="mono">{{ time(d.dispatched_at) }}</td>
            <td class="mono">{{ d.delivered_at ? time(d.delivered_at) : '—' }}</td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="8" class="empty">Sin entregas despachadas hoy.</td></tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [`
    :host { display: block; padding: 1rem 1.25rem; }
    .trk-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 1rem; flex-wrap: wrap; }
    h1 { font-size: 1.2rem; margin: 0; font-weight: 700; }
    .sub { margin: .1rem 0 0; color: var(--text-muted); font-size: .85rem; }
    .head-actions { display: flex; gap: .6rem; align-items: center; }
    .kpis { display: flex; gap: .6rem; margin: 1rem 0; flex-wrap: wrap; }
    .kpi { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 10px; padding: .5rem .9rem; min-width: 100px; }
    .kpi span { display: block; font-size: .72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
    .kpi b { font-size: 1.3rem; font-variant-numeric: tabular-nums; }
    .kpi b.pend { color: #b45309; } .kpi b.ok { color: #16a34a; } .kpi b.bad { color: #dc2626; }
    .mono { font-variant-numeric: tabular-nums; }
    .num { text-align: right; }
    .addr { max-width: 240px; }
    .sub2 { font-size: .74rem; color: var(--text-muted); }
    .paid { color: #16a34a; font-size: .8rem; }
    .empty { text-align: center; color: var(--text-muted); padding: 1.5rem; }
  `],
})
export class HomeDeliveryTrackingComponent implements OnInit, OnDestroy {
  private readonly svc = inject(HomeDeliveryService);

  readonly rows = signal<DispatchedDelivery[]>([]);
  readonly loading = signal(false);
  statusFilter: '' | 'pendiente' | 'entregado' = '';
  readonly filters = [
    { label: 'Todas', value: '' },
    { label: 'En camino', value: 'pendiente' },
    { label: 'Entregadas', value: 'entregado' },
  ];

  private timer: any = null;

  readonly incidents = computed(() => this.rows().filter((r) => !!r.incident_type).length);

  ngOnInit(): void {
    this.load();
    this.timer = setInterval(() => this.load(), 30000); // auto-refresh liviano
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  load(): void {
    this.loading.set(true);
    this.svc.listDispatched({ status: this.statusFilter || undefined }).subscribe({
      next: (r) => { this.rows.set(r || []); this.loading.set(false); },
      error: () => { this.rows.set([]); this.loading.set(false); },
    });
  }

  countBy(status: string): number {
    return this.rows().filter((r) => r.status === status).length;
  }

  money(v: number | string | null | undefined): string {
    return Number(v ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }

  time(iso?: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  }

  statusLabel(d: DispatchedDelivery): string {
    if (d.status === 'pendiente') return 'En camino';
    return { entregado: 'Entregado', no_entregado: 'No entregado', rechazado: 'Rechazado' }[d.status] || d.status;
  }

  statusSeverity(s: string): 'success' | 'warn' | 'danger' | 'info' {
    if (s === 'entregado') return 'success';
    if (s === 'rechazado') return 'danger';
    if (s === 'no_entregado') return 'warn';
    return 'info';
  }
}
