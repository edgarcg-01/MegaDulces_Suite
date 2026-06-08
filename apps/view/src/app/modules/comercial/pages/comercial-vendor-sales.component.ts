import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { ComercialService, VendorSaleCapture, VendorSaleLine } from '../comercial.service';

/**
 * Ventas de vendedor (admin) — la parte "comercial" del ticket OCR de la captura
 * del vendedor: una fila por captura/ticket (commercial.vendor_sale_lines agrupado
 * por capture_ref). Drill-down al detalle: foto del ticket + líneas detectadas.
 * NO es el "Cierre de ruta" (esos son route_tickets venta/carga/combustible).
 */
@Component({
  selector: 'app-comercial-vendor-sales',
  standalone: true,
  imports: [CommonModule, FormsModule, CardModule, TableModule, TagModule, ButtonModule, DialogModule],
  template: `
    <div class="surf-page vs">
      <header class="vs-head">
        <div>
          <h1>Ventas de vendedor</h1>
          <p>Tickets de venta capturados por OCR en la visita del vendedor</p>
        </div>
      </header>

      <div class="filters">
        <input type="date" [(ngModel)]="dateFrom" (change)="reload()" aria-label="Desde" />
        <span>→</span>
        <input type="date" [(ngModel)]="dateTo" (change)="reload()" aria-label="Hasta" />
        <button pButton icon="pi pi-refresh" severity="secondary" [text]="true" (click)="reload()" aria-label="Recargar"></button>
      </div>

      <div class="kpis">
        <p-card styleClass="kpi"><div class="k"><span class="v">{{ captures().length }}</span><span class="l">Tickets</span></div></p-card>
        <p-card styleClass="kpi"><div class="k"><span class="v">{{ totalLineas() }}</span><span class="l">Líneas</span></div></p-card>
        <p-card styleClass="kpi"><div class="k"><span class="v">{{ totalUnidades() }}</span><span class="l">Unidades</span></div></p-card>
      </div>

      <p-table [value]="captures()" [loading]="loading()" styleClass="p-datatable-sm" [paginator]="captures().length > 25" [rows]="25">
        <ng-template pTemplate="header">
          <tr>
            <th>Fecha</th><th>Tienda</th><th>Vendedor</th><th>Ruta</th>
            <th class="num">Líneas</th><th class="num">Unidades</th><th></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-c>
          <tr>
            <td>{{ c.sale_date }}</td>
            <td class="strong">{{ c.store_name || '—' }}</td>
            <td>{{ c.vendor_name || c.vendor_username || '—' }}</td>
            <td>{{ c.route_name || '—' }}</td>
            <td class="num">{{ +c.lineas }}</td>
            <td class="num">{{ +c.unidades }}</td>
            <td class="actions">
              <button pButton size="small" [text]="true" icon="pi pi-receipt" label="Ver ticket"
                      (click)="openDetail(c)"></button>
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="7" class="empty">Sin ventas de vendedor en el rango seleccionado.</td></tr>
        </ng-template>
      </p-table>
    </div>

    <p-dialog [(visible)]="detailOpen" [modal]="true" [style]="{ width: '46rem', maxWidth: '95vw' }"
              [draggable]="false" header="Ticket de venta">
      <div class="detail" *ngIf="selected() as c">
        <div class="detail-meta">
          <div><span class="dl">Tienda</span><span class="dv">{{ c.store_name || '—' }}</span></div>
          <div><span class="dl">Vendedor</span><span class="dv">{{ c.vendor_name || c.vendor_username || '—' }}</span></div>
          <div><span class="dl">Fecha</span><span class="dv">{{ c.sale_date }}</span></div>
          <div><span class="dl">Ruta</span><span class="dv">{{ c.route_name || '—' }}</span></div>
        </div>

        <div class="detail-grid">
          <div class="ticket-photo">
            <a *ngIf="c.ticket_photo_url" [href]="c.ticket_photo_url" target="_blank" rel="noopener">
              <img [src]="c.ticket_photo_url" alt="Foto del ticket de venta" />
            </a>
            <div *ngIf="!c.ticket_photo_url" class="no-photo">Sin foto de ticket</div>
          </div>

          <div class="lines">
            <h3>Productos detectados</h3>
            <p-table [value]="lines()" [loading]="loadingLines()" styleClass="p-datatable-sm" [scrollable]="true" scrollHeight="320px">
              <ng-template pTemplate="header">
                <tr><th>SKU</th><th>Producto</th><th class="num">Cant.</th></tr>
              </ng-template>
              <ng-template pTemplate="body" let-l>
                <tr>
                  <td class="mono">{{ l.sku }}</td>
                  <td>{{ l.product_name || '—' }}</td>
                  <td class="num">{{ +l.quantity }}</td>
                </tr>
              </ng-template>
              <ng-template pTemplate="emptymessage">
                <tr><td colspan="3" class="empty">Sin líneas.</td></tr>
              </ng-template>
            </p-table>
          </div>
        </div>
      </div>
    </p-dialog>
  `,
  styles: [
    `
      .vs-head { margin-bottom: 1rem; }
      .vs-head h1 { margin: 0; font-size: 1.5rem; color: var(--text-main); }
      .vs-head p { margin: 0.25rem 0 0; color: var(--text-muted); font-size: 0.875rem; }
      .filters { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem; }
      .filters input[type=date] { padding: 0.5rem; border: 1px solid var(--border-color); border-radius: 8px; background: var(--card-bg); color: var(--text-main); }
      .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem; margin-bottom: 1rem; }
      @media (max-width: 720px) { .kpis { grid-template-columns: repeat(3, 1fr); } }
      :host ::ng-deep .p-card.kpi .p-card-body { padding: 0.875rem; }
      .k { text-align: center; display: flex; flex-direction: column; gap: 0.25rem; }
      .k .v { font-size: 1.25rem; font-weight: 700; color: var(--text-main); font-variant-numeric: tabular-nums; }
      .k .l { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
      .num { text-align: right; font-variant-numeric: tabular-nums; }
      .strong { font-weight: 600; color: var(--text-main); }
      .actions { text-align: right; }
      .mono { font-family: var(--font-mono, monospace); font-size: 0.8rem; color: var(--text-muted); }
      .empty { text-align: center; color: var(--text-muted); padding: 1.5rem; }
      .detail-meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem 1rem; margin-bottom: 1rem; }
      .detail-meta .dl { display: block; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
      .detail-meta .dv { display: block; color: var(--text-main); font-weight: 500; }
      .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
      @media (max-width: 640px) { .detail-grid { grid-template-columns: 1fr; } }
      .ticket-photo img { width: 100%; border-radius: 8px; border: 1px solid var(--border-color); object-fit: contain; max-height: 420px; background: #000; }
      .no-photo { padding: 2rem; text-align: center; color: var(--text-muted); border: 1px dashed var(--border-color); border-radius: 8px; }
      .lines h3 { margin: 0 0 0.5rem; font-size: 0.95rem; color: var(--text-main); }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComercialVendorSalesComponent implements OnInit {
  private readonly api = inject(ComercialService);

  readonly captures = signal<VendorSaleCapture[]>([]);
  readonly loading = signal(false);
  readonly lines = signal<VendorSaleLine[]>([]);
  readonly loadingLines = signal(false);
  readonly selected = signal<VendorSaleCapture | null>(null);
  detailOpen = false;

  readonly totalLineas = computed(() => this.captures().reduce((a, c) => a + Number(c.lineas || 0), 0));
  readonly totalUnidades = computed(() => this.captures().reduce((a, c) => a + Number(c.unidades || 0), 0));

  dateFrom = this.daysAgo(30);
  dateTo = this.today();

  ngOnInit(): void {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.api.vendorSalesPorCaptura({ date_from: this.dateFrom, date_to: this.dateTo }).subscribe({
      next: (r) => { this.captures.set(r || []); this.loading.set(false); },
      error: () => { this.captures.set([]); this.loading.set(false); },
    });
  }

  openDetail(c: VendorSaleCapture): void {
    this.selected.set(c);
    this.detailOpen = true;
    this.lines.set([]);
    this.loadingLines.set(true);
    this.api.vendorSaleLines(c.capture_ref).subscribe({
      next: (r) => { this.lines.set(r || []); this.loadingLines.set(false); },
      error: () => { this.lines.set([]); this.loadingLines.set(false); },
    });
  }

  private today(): string { return new Date().toISOString().slice(0, 10); }
  private daysAgo(d: number): string {
    const x = new Date(); x.setDate(x.getDate() - d); return x.toISOString().slice(0, 10);
  }
}
