import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import {
  ComercialService,
  RouteTicketAdmin,
  RouteResumen,
} from '../comercial.service';

/**
 * Cierre de ruta (admin) — control de los tickets que suben los vendedores:
 * corte de venta, carga y combustible. KPIs de ruta + listado filtrable.
 * `carga` se excluye del gasto (regla de negocio).
 */
@Component({
  selector: 'app-comercial-route-tickets',
  standalone: true,
  imports: [CommonModule, FormsModule, CardModule, TableModule, TagModule, ButtonModule, SelectModule],
  template: `
    <div class="surf-page rt">
      <header class="rt-head">
        <div>
          <h1>Cierre de ruta</h1>
          <p>Tickets de venta, carga y combustible que suben los vendedores</p>
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

      <div class="kpis">
        <p-card styleClass="kpi"><div class="k"><span class="v ok">{{ money(resumen()?.ventas) }}</span><span class="l">Ventas (corte)</span></div></p-card>
        <p-card styleClass="kpi"><div class="k"><span class="v bad">{{ money(resumen()?.gasto) }}</span><span class="l">Combustible</span></div></p-card>
        <p-card styleClass="kpi"><div class="k"><span class="v">{{ money(resumen()?.rentabilidad) }}</span><span class="l">Rentabilidad</span></div></p-card>
        <p-card styleClass="kpi"><div class="k"><span class="v">{{ resumen()?.tickets ?? 0 }}</span><span class="l">Tickets</span></div></p-card>
      </div>

      <p-table [value]="tickets()" [loading]="loading()" styleClass="p-datatable-sm" [paginator]="false">
        <ng-template pTemplate="header">
          <tr>
            <th>Tipo</th><th>Ruta</th><th>Fecha</th><th>Vendedor</th>
            <th class="num">Total</th><th>Corte / Folio</th><th class="num">Litros</th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-t>
          <tr>
            <td><p-tag [value]="label(t.ticket_type)" [severity]="sev(t.ticket_type)"></p-tag></td>
            <td>RD{{ t.route_code }}</td>
            <td>{{ t.ticket_date }}</td>
            <td>{{ t.vendor_name || t.vendor_username || '—' }}</td>
            <td class="num">{{ t.total != null ? money(t.total) : '—' }}</td>
            <td>{{ t.corte_number || t.reference || '—' }}</td>
            <td class="num">{{ t.liters != null ? t.liters : '—' }}</td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="7" class="empty">Sin tickets en el rango seleccionado.</td></tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [
    `
      .rt-head { margin-bottom: 1rem; }
      .rt-head h1 { margin: 0; font-size: 1.5rem; color: var(--text-main); }
      .rt-head p { margin: 0.25rem 0 0; color: var(--text-muted); font-size: 0.875rem; }
      .filters { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem; }
      .filters input[type=date] { padding: 0.5rem; border: 1px solid var(--border-color); border-radius: 8px; background: var(--card-bg); color: var(--text-main); }
      .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.75rem; margin-bottom: 1rem; }
      @media (max-width: 720px) { .kpis { grid-template-columns: repeat(2, 1fr); } }
      :host ::ng-deep .p-card.kpi .p-card-body { padding: 0.875rem; }
      .k { text-align: center; display: flex; flex-direction: column; gap: 0.25rem; }
      .k .v { font-size: 1.25rem; font-weight: 700; color: var(--text-main); font-variant-numeric: tabular-nums; }
      .k .v.ok { color: var(--ok-soft-fg); }
      .k .v.bad { color: var(--bad-soft-fg); }
      .k .l { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
      .num { text-align: right; font-variant-numeric: tabular-nums; }
      .empty { text-align: center; color: var(--text-muted); padding: 1.5rem; }
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
  private today(): string { return new Date().toISOString().slice(0, 10); }
  private daysAgo(d: number): string {
    const x = new Date(); x.setDate(x.getDate() - d); return x.toISOString().slice(0, 10);
  }
}
