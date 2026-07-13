import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { catchError, of } from 'rxjs';
import { ComercialService, WincajaBranchKpi } from '../comercial.service';

/**
 * Fase W — Overview Wincaja (POS Access). Operations surface, tabla densa.
 * Destapa las sucursales que Kepler no ve (30/32/50) + muestra las 8.
 * Consume /commercial/wincaja/overview (capa silver). Montos = bronze "mejor esfuerzo".
 */
@Component({
  selector: 'app-comercial-wincaja',
  standalone: true,
  imports: [CommonModule, TableModule, TagModule, ButtonModule, TooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Sucursales Wincaja</h1>
          <p class="surf-page-sub">
            POS Access (legacy). Las marcadas <strong>Sólo Wincaja</strong> (Morelia Abastos/Madero, Canindo)
            no existen en Kepler — antes invisibles en la plataforma. Montos = mejor esfuerzo (bronze).
          </p>
        </div>
        <button pButton type="button" icon="pi pi-refresh" [text]="true"
                aria-label="Recargar" (click)="load()"></button>
      </header>

      @if (error()) {
        <div class="wcj-banner" role="alert">
          No se pudo cargar la data de Wincaja. <button pButton type="button" label="Reintentar" [text]="true" (click)="load()"></button>
        </div>
      }

      <div class="card-premium card-flat wcj-wrap">
        <p-table [value]="rows()" [loading]="loading()" styleClass="p-datatable-sm" [scrollable]="true"
                 [tableStyle]="{ 'min-width': '60rem' }">
          <ng-template pTemplate="header">
            <tr>
              <th>Sucursal</th>
              <th>Estado</th>
              <th class="num">Venta</th>
              <th class="num">Unidades</th>
              <th class="num">Inventario</th>
              <th class="num">Cartera</th>
              <th class="num">Clientes</th>
              <th class="num">Venta perdida</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-r>
            <tr [class.wcj-blind]="r.wincaja_only">
              <td>
                <span class="wcj-code">{{ r.warehouse_code }}</span>
                <span class="wcj-name">{{ r.branch_name }}</span>
              </td>
              <td><p-tag [value]="statusLabel(r)" [severity]="statusSeverity(r)" /></td>
              <td class="num strong">{{ money(r.venta_total) }}</td>
              <td class="num">{{ int(r.unidades) }}</td>
              <td class="num">{{ money(r.inventario_valor) }}</td>
              <td class="num">{{ money(r.cartera) }}</td>
              <td class="num">{{ int(r.cartera_clientes) }}</td>
              <td class="num" [class.wcj-alert]="r.venta_perdida > 0">{{ money(r.venta_perdida) }}</td>
            </tr>
          </ng-template>
          <ng-template pTemplate="footer">
            @if (rows().length) {
              <tr class="wcj-total">
                <td>Red ({{ rows().length }})</td><td></td>
                <td class="num strong">{{ money(totals().venta) }}</td>
                <td class="num">{{ int(totals().unidades) }}</td>
                <td class="num">{{ money(totals().inv) }}</td>
                <td class="num">{{ money(totals().cartera) }}</td>
                <td class="num">{{ int(totals().clientes) }}</td>
                <td class="num">{{ money(totals().perdida) }}</td>
              </tr>
            }
          </ng-template>
          <ng-template pTemplate="emptymessage">
            <tr><td colspan="8" class="wcj-empty">
              @if (!loading()) { Sin data de Wincaja. Corré el importer en .245 y el feed gold. }
            </td></tr>
          </ng-template>
        </p-table>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .wcj-wrap { padding: 0; overflow: hidden; }
    .wcj-banner {
      display: flex; align-items: center; gap: .5rem; margin-bottom: var(--sp-3, .75rem);
      padding: .625rem .875rem; border: 1px solid var(--border-color);
      border-radius: var(--r-md, 8px); color: var(--text-main);
      background: color-mix(in srgb, var(--danger, #b4413a) 8%, transparent);
    }
    .wcj-code { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; margin-right: .5rem; color: var(--text-muted); }
    .wcj-name { font-weight: 600; }
    th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
    td.num { font-family: var(--font-mono, monospace); }
    td.num.strong { font-weight: 600; color: var(--text-main); }
    .wcj-blind { background: color-mix(in srgb, var(--action, #d9772e) 5%, transparent); }
    .wcj-alert { color: var(--danger, #b4413a); }
    .wcj-total td { font-weight: 700; border-top: 2px solid var(--border-color); background: var(--surface-2, transparent); }
    .wcj-empty { text-align: center; color: var(--text-muted); padding: 1.5rem; }
  `],
})
export class ComercialWincajaComponent {
  private readonly api = inject(ComercialService);
  private readonly destroyRef = inject(DestroyRef);

  readonly rows = signal<WincajaBranchKpi[]>([]);
  readonly loading = signal(false);
  readonly error = signal(false);

  readonly totals = computed(() => {
    const acc = { venta: 0, unidades: 0, inv: 0, cartera: 0, clientes: 0, perdida: 0 };
    for (const r of this.rows()) {
      acc.venta += Number(r.venta_total) || 0;
      acc.unidades += Number(r.unidades) || 0;
      acc.inv += Number(r.inventario_valor) || 0;
      acc.cartera += Number(r.cartera) || 0;
      acc.clientes += Number(r.cartera_clientes) || 0;
      acc.perdida += Number(r.venta_perdida) || 0;
    }
    return acc;
  });

  private readonly currency = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  private readonly integer = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });

  constructor() { this.load(); }

  money(v: unknown): string { return this.currency.format(Number(v) || 0); }
  int(v: unknown): string { return this.integer.format(Number(v) || 0); }

  statusLabel(r: WincajaBranchKpi): string {
    if (r.wincaja_only) return 'Sólo Wincaja';
    if (r.status === 'transition') return 'En transición';
    return 'En Kepler';
  }
  statusSeverity(r: WincajaBranchKpi): 'success' | 'warn' | 'secondary' {
    if (r.wincaja_only) return 'success';
    if (r.status === 'transition') return 'warn';
    return 'secondary';
  }

  load(): void {
    this.loading.set(true);
    this.error.set(false);
    this.api.wincajaOverview()
      .pipe(
        catchError(() => { this.error.set(true); return of([] as WincajaBranchKpi[]); }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((data) => { this.rows.set(data ?? []); this.loading.set(false); });
  }
}
