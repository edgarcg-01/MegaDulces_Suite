import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import {
  ComercialService,
  RouteTicketAdmin,
  RouteResumen,
} from '../comercial.service';
import { todayMx, toMxDateKey } from '../../../core/utils/mx-date';
import { MetricCardComponent } from '../../../shared/components/metric-card/metric-card.component';

/**
 * Cierre de ruta (admin) — control de los tickets que suben los vendedores:
 * corte de venta, carga y combustible. KPIs de ruta + listado filtrable.
 * `carga` se excluye del gasto (regla de negocio).
 */
@Component({
  selector: 'app-comercial-route-tickets',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, TagModule, ButtonModule, SelectModule, MetricCardComponent],
  template: `
    <div class="surf-page rt">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Cierre de ruta</h1>
          <p class="surf-page-sub">Tickets de venta, carga y combustible que suben los vendedores</p>
        </div>
      </header>

      <div class="filters">
        <input type="date" [(ngModel)]="dateFrom" (change)="reload()" />
        <span>→</span>
        <input type="date" [(ngModel)]="dateTo" (change)="reload()" />
        <p-select
          [options]="typeOptions"
          [(ngModel)]="type"
          (onChange)="reload()"
          optionLabel="label"
          optionValue="value"
          placeholder="Tipo"
          [showClear]="true"
          styleClass="type-select"
        ></p-select>
        <button pButton icon="pi pi-refresh" severity="secondary" [text]="true" (click)="reload()"></button>
      </div>

      <div class="surf-grid rt-bento">
        <app-metric-card class="panel-col-3"
          label="Ventas (corte)" [value]="resumen()?.ventas ?? 0" format="currency"
          accent="var(--ok-fg)" sub="suma de cortes de venta"></app-metric-card>
        <app-metric-card class="panel-col-3"
          label="Combustible" [value]="resumen()?.gasto ?? 0" format="currency"
          accent="var(--bad-fg)" sub="gasto (carga excluida)"></app-metric-card>
        <app-metric-card class="panel-col-3"
          label="Rentabilidad" [value]="resumen()?.rentabilidad ?? 0" format="currency"
          [accent]="profitAccent()" sub="ventas − combustible"></app-metric-card>
        <app-metric-card class="panel-col-3"
          label="Tickets" [value]="resumen()?.tickets ?? 0" format="number"
          accent="var(--chart-2)" sub="en el rango"></app-metric-card>
      </div>

      <p-table [value]="tickets()" [loading]="loading()" responsiveLayout="scroll"
               styleClass="p-datatable-sm surf-table surf-table--sticky surf-table--frozen-first surf-table--zebra"
               [paginator]="tickets().length > 25" [rows]="25" [rowsPerPageOptions]="[25, 50, 100]">
        <ng-template pTemplate="header">
          <tr>
            <th scope="col">Tipo</th><th scope="col">Ruta</th><th scope="col">Fecha</th><th scope="col">Vendedor</th>
            <th scope="col" class="num">Total</th><th scope="col">Corte / Folio</th><th scope="col" class="num">Litros</th>
            <th scope="col">Ticket</th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-t>
          <tr>
            <td><p-tag [value]="label(t.ticket_type)" [severity]="sev(t.ticket_type)"></p-tag></td>
            <td>RD{{ t.route_code }}</td>
            <td>{{ t.ticket_date }}<span class="rt-time" *ngIf="t.ticket_time"> · {{ hhmm(t.ticket_time) }}</span></td>
            <td>{{ t.vendor_name || t.vendor_username || '—' }}</td>
            <td class="num">{{ t.total != null ? money(t.total) : '—' }}</td>
            <td>{{ t.corte_number || t.folio || t.reference || '—' }}</td>
            <td class="num">{{ t.liters != null ? t.liters : '—' }}</td>
            <td>
              <a *ngIf="t.photo_url; else noPhoto" class="ticket-link" [href]="t.photo_url" target="_blank" rel="noopener" aria-label="Ver foto del ticket">
                <i class="pi pi-image" aria-hidden="true"></i> Ver
              </a>
              <ng-template #noPhoto><span class="ticket-none">—</span></ng-template>
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr>
            <td colspan="8" class="comm-empty-cell">
              <div class="comm-empty">
                <div class="comm-empty-icon"><i class="pi pi-receipt" aria-hidden="true"></i></div>
                <h3>Sin tickets</h3>
                <p>No hay tickets de ruta en el rango seleccionado. Los suben los vendedores al cerrar su día.</p>
              </div>
            </td>
          </tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [
    `
      .filters { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem; }
      .filters input[type=date] { padding: 0.5rem; border: 1px solid var(--border-color); border-radius: 8px; background: var(--card-bg); color: var(--text-main); }
      .rt-bento { margin-bottom: 1rem; }
      .ticket-link { display: inline-flex; align-items: center; gap: 0.3rem; font-weight: 600; font-size: 0.8125rem; color: var(--action); text-decoration: none; }
      .ticket-link:hover { text-decoration: underline; }
      .ticket-link i { font-size: 0.85rem; }
      .ticket-none { color: var(--text-faint); }
      .rt-time { color: var(--text-muted); font-variant-numeric: tabular-nums; }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComercialRouteTicketsComponent implements OnInit {
  private readonly api = inject(ComercialService);

  readonly tickets = signal<RouteTicketAdmin[]>([]);
  readonly resumen = signal<RouteResumen | null>(null);
  readonly loading = signal(false);

  dateFrom = this.daysAgo(30);
  dateTo = this.today();
  type: 'venta' | 'carga' | 'combustible' | null = null;

  readonly typeOptions = [
    { label: 'Venta (corte)', value: 'venta' },
    { label: 'Carga', value: 'carga' },
    { label: 'Combustible', value: 'combustible' },
  ];

  /** Color de la card de rentabilidad: verde si gana, rojo si pierde, neutro en cero. */
  readonly profitAccent = computed(() => {
    const r = Number(this.resumen()?.rentabilidad ?? 0);
    if (r > 0) return 'var(--ok-fg)';
    if (r < 0) return 'var(--bad-fg)';
    return 'var(--chart-8)';
  });

  ngOnInit(): void {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    const range = { date_from: this.dateFrom, date_to: this.dateTo };
    this.api.listRouteTickets({ ...range, ticket_type: this.type ?? undefined, pageSize: 100 }).subscribe({
      next: (r) => { this.tickets.set(r.data || []); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
    this.api.routeResumen(range).subscribe({ next: (r) => this.resumen.set(r), error: () => this.resumen.set(null) });
  }

  label(t: string): string {
    return t === 'venta' ? 'Venta' : t === 'carga' ? 'Carga' : 'Combustible';
  }
  sev(t: string): 'success' | 'info' | 'warn' {
    return t === 'venta' ? 'success' : t === 'combustible' ? 'warn' : 'info';
  }
  money(n: any): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);
  }
  /** TIME de pg ("15:33:00") → "15:33". */
  hhmm(t: string | null): string {
    return t ? t.slice(0, 5) : '';
  }
  private today(): string { return todayMx(); }
  private daysAgo(d: number): string {
    return toMxDateKey(new Date(Date.now() - d * 86400000));
  }
}
