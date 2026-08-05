import {
  ChangeDetectionStrategy,
  Component,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { MultiSelectModule } from 'primeng/multiselect';
import { DatePickerModule } from 'primeng/datepicker';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { MapComponent, MapMarker, MapLayer } from '../../../shared/components/map/map.component';
import {
  LogisticaService,
  FleetAdherenceRow,
  AdherenceDiagnostic,
  FleetAuditUnit,
  AuditStop,
  AuditTicket,
  AuditRoute,
} from '../logistica.service';
import { todayMx, parseLocalDate } from '../../../core/utils/mx-date';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';

/** Paleta categórica por ruta (encoding de datos). Usa la secuencia tokenizada
 *  `--chart-1..8` (light+dark) en vez de hex fijos → adapta al tema oscuro. */
const ROUTE_PALETTE = Array.from({ length: 8 }, (_, i) => `var(--chart-${i + 1})`);

interface RouteEntry {
  route_number: number | null;
  vehicle_id: string;
  vehicle_plate: string | null;
  coverage_pct: number | null;
  visited_count: number;
  planned_with_coords: number;
  skipped_count: number;
  sales_docs: number; // venta real (documentos) — fuente ventas-por-ruta
  sales_total: number;
  color: string;
}

/**
 * LTV.18 — Auditoría de ruta, MAPA MULTI-RUTA (map-first). El mapa es el organismo
 * principal: seguimiento de TODAS las rutas del día a la vez (recorrido + paradas
 * + tiendas visitadas/saltadas + tickets ubicados), color por ruta. Filtros arriba
 * (una o varias rutas). Al enfocar una ruta: resumen + botón "Historial de visitas"
 * (→ Apartado Rutas). El recorrido (pesado) entra togglable, apagado por default.
 * La tabla de cumplimiento numérico queda como panel colapsable.
 */
@Component({
  selector: 'app-logistica-auditoria-ruta',
  standalone: true,
  imports: [FormsModule, ButtonModule, MultiSelectModule, DatePickerModule, TableModule, TooltipModule, MapComponent, ContextHelpComponent],
  template: `
    <div class="surf-page rk-mapfirst">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <span class="rk-eyebrow"><i class="pi pi-check-circle" aria-hidden="true"></i> Auditoría en Ruta</span>
          <h1>Mapa de rutas</h1>
          <p class="surf-page-sub">
            {{ visibleUnits().length }} de {{ units().length }} ruta{{ units().length === 1 ? '' : 's' }} en el mapa
            <span class="rk-muted">· seguimiento del día</span>
            @if (lastGpsAt(); as ts) {
              <span class="rk-gps" pTooltip="Última posición recibida del rastreo GPS"><i class="pi pi-map-marker" aria-hidden="true"></i> GPS {{ fmtClock(ts) }}</span>
            }
          </p>
        </div>
        <div class="rk-actions">
          <p-datepicker [ngModel]="dateObj()" (ngModelChange)="onDatePick($event)" [maxDate]="todayObj"
            dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" inputStyleClass="rk-date" styleClass="rk-dp"
            [inputStyle]="{ width: '8.5rem' }" ariaLabel="Fecha" />
          <button pButton [text]="true" size="small" [loading]="loading()" (click)="refresh()" aria-label="Refrescar"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
          <app-context-help topic="route-compliance" />
        </div>
      </header>

      <!-- Filtros: rutas + capas -->
      <div class="rk-filters">
        <p-multiselect
          [options]="routeOptions()" [ngModel]="selectedRoutes()" (ngModelChange)="onRoutesChange($event)"
          optionLabel="label" optionValue="value" [filter]="true" [showToggleAll]="true" appendTo="body"
          placeholder="Todas las rutas" selectedItemsLabel="{0} rutas" styleClass="rk-ms" [maxSelectedLabels]="3"
          [disabled]="!routeOptions().length" />
        <span class="rk-sep" aria-hidden="true"></span>
        <button type="button" class="rk-chip" [class.on]="showRecorrido()" [attr.aria-pressed]="showRecorrido()" (click)="showRecorrido.set(!showRecorrido())" pTooltip="Puede ser pesado con muchas rutas"><i class="rk-dash" aria-hidden="true"></i> Recorrido</button>
        <button type="button" class="rk-chip" [class.on]="showParadas()" [attr.aria-pressed]="showParadas()" (click)="showParadas.set(!showParadas())"><i class="rk-num" aria-hidden="true">③</i> Paradas</button>
        <button type="button" class="rk-chip" [class.on]="showTiendas()" [attr.aria-pressed]="showTiendas()" (click)="showTiendas.set(!showTiendas())"><i class="rk-dot-lg" style="background:var(--ok-fg)" aria-hidden="true"></i> Tiendas</button>
        <button type="button" class="rk-chip" [class.on]="showTickets()" [attr.aria-pressed]="showTickets()" (click)="showTickets.set(!showTickets())"><i class="rk-dot-lg" style="background:var(--action)" aria-hidden="true"></i> Ventas</button>
        @if (focusedRoute() != null) {
          <button type="button" class="rk-chip rk-chip-calles" [class.on]="porCalles()" [attr.aria-pressed]="porCalles()" [disabled]="snapLoading()" (click)="togglePorCalles()" pTooltip="Pega el recorrido de la ruta enfocada a las calles"><i class="pi" [class.pi-directions]="!snapLoading()" [class.pi-spinner]="snapLoading()" [class.pi-spin]="snapLoading()" aria-hidden="true"></i> Por calles</button>
        }
      </div>

      @if (!hasData() && (loading() || unitsLoading())) {
        <div class="rk-loading"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Cargando rutas del día…</div>
      } @else if (hasData()) {
        <div class="rk-map-grid">
          <!-- Mapa principal -->
          <div class="rk-map-main">
            <app-map #map [layers]="mapLayers()" autoFit="once" height="100%"></app-map>
          </div>

          <!-- Lista de rutas / leyenda -->
          <aside class="rk-routes">
            <div class="rk-routes-head">
              <span>Rutas del día</span>
              @if (focusedRoute() != null) { <button type="button" class="rk-link" (click)="clearFocus()">ver todas</button> }
            </div>
            <ul class="rk-route-list">
              @for (r of routeList(); track r.vehicle_id) {
                <li class="rk-route-item" role="button" tabindex="0" [class.on]="isSelected(r.route_number)" [class.focus]="focusedRoute() === r.route_number" (click)="focusRoute(r.route_number)" (keydown.enter)="focusRoute(r.route_number)" (keydown.space)="focusRoute(r.route_number); $event.preventDefault()">
                  <span class="rk-route-sw" [style.background]="r.color"></span>
                  <div class="rk-route-main">
                    <div class="rk-route-top">
                      <span class="rk-route-name">{{ r.route_number != null ? 'R-' + r.route_number : (r.vehicle_plate || 'Unidad') }}</span>
                      <span class="rk-route-cov" [style.color]="coverageColor(r.coverage_pct)">{{ r.coverage_pct != null ? r.coverage_pct + '%' : '—' }}</span>
                    </div>
                    <div class="rk-route-sub">{{ r.visited_count }}/{{ r.planned_with_coords }} tiendas · {{ r.sales_docs }} venta{{ r.sales_docs === 1 ? '' : 's' }}@if (r.sales_total > 0) { · {{ money(r.sales_total) }} }</div>
                  </div>
                </li>
              }
            </ul>

            @if (focusedUnit(); as u) {
              <div class="rk-focus">
                <h4>{{ focusedRoute() != null ? 'R-' + focusedRoute() : (u.vehicle_plate || 'Unidad') }}</h4>
                <p class="rk-muted">{{ u.vehicle_plate || shortId(u.vehicle_id) }} · {{ u.stops.length }} parada{{ u.stops.length === 1 ? '' : 's' }} · {{ u.sales_docs }} venta{{ u.sales_docs === 1 ? '' : 's' }}@if (u.sales_total > 0) { · {{ money(u.sales_total) }} }</p>
                @if (u.located_sales?.length) {
                  <p class="rk-muted rk-locsales"><i class="pi pi-map-marker" aria-hidden="true"></i> {{ locatedCount(u) }} de {{ u.located_sales.length }} ventas ubicadas por hora</p>
                } @else {
                  <p class="rk-muted rk-locsales rk-dim">Sin hora de venta para ubicar (Kepler PH)</p>
                }
                <button pButton size="small" (click)="verHistorial()"><span class="p-button-icon p-button-icon-left pi pi-history" aria-hidden="true"></span><span class="p-button-label">Historial de visitas</span></button>
              </div>
            }
          </aside>
        </div>

        <!-- Tabla de cumplimiento (colapsable) -->
        <div class="rk-table-panel">
          <button type="button" class="rk-table-toggle" (click)="tableOpen.set(!tableOpen())" [attr.aria-expanded]="tableOpen()">
            <i class="pi" [class.pi-chevron-right]="!tableOpen()" [class.pi-chevron-down]="tableOpen()" aria-hidden="true"></i>
            Detalle de cumplimiento ({{ rows().length }})
          </button>
          @if (tableOpen()) {
            <p-table [value]="rows()" dataKey="vehicle_id"
              selectionMode="single" [metaKeySelection]="false"
              [selection]="focusedRow()" (selectionChange)="onTableSelect($event)"
              [scrollable]="true" [rowHover]="true" styleClass="p-datatable-sm rk-ptable">
              <ng-template #header>
                <tr>
                  <th pFrozenColumn>Ruta</th>
                  <th>Unidad</th>
                  <th style="width:26%">Cumplimiento</th>
                  <th class="num" pTooltip="Tiendas visitadas / plan con coordenadas">Visitadas</th>
                  <th class="num" pTooltip="Visitadas con captura de auditoría">Auditadas</th>
                  <th class="num" pTooltip="Tiendas del plan que no visitó">Saltadas</th>
                  <th class="num" pTooltip="Paradas en tiendas fuera de la ruta">Fuera</th>
                </tr>
              </ng-template>
              <ng-template #body let-row>
                <tr [pSelectableRow]="row">
                  <td pFrozenColumn class="rk-unit"><span class="rk-route-sw sm" [style.background]="routeColor(row.route_number)"></span> {{ row.route_number != null ? 'R-' + row.route_number : '—' }}</td>
                  <td>{{ row.vehicle_plate || shortId(row.vehicle_id) }}</td>
                  <td>
                    @if (row.evaluable) {
                      <div class="rk-bar"><span [style.width.%]="row.coverage_pct ?? 0" [style.background]="coverageColor(row.coverage_pct)"></span></div>
                      <span class="rk-bar-lbl">{{ row.coverage_pct }}%</span>
                    } @else { <span class="rk-na">sin plan</span> }
                  </td>
                  <td class="num">{{ row.evaluable ? row.visited_count + '/' + row.planned_with_coords : '—' }}</td>
                  <td class="num">{{ row.evaluable ? row.captured_count : '—' }}</td>
                  <td class="num" [class.rk-warn]="row.skipped_count > 0">{{ row.evaluable ? row.skipped_count : '—' }}</td>
                  <td class="num rk-dim">{{ row.off_route_count }}</td>
                </tr>
              </ng-template>
            </p-table>
          }
        </div>
      } @else if (errored()) {
        <div class="rk-empty">
          <div class="rk-empty-icon"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i></div>
          <h3>No se pudo cargar la auditoría</h3>
          <p>Revisá tu conexión y reintentá.</p>
          <div class="rk-empty-actions">
            <button pButton size="small" [loading]="loading()" (click)="refresh()"><span class="p-button-label">Reintentar</span></button>
          </div>
        </div>
      } @else {
        <div class="rk-empty">
          <div class="rk-empty-icon"><i class="pi pi-map" aria-hidden="true"></i></div>
          <h3>Sin rutas para auditar</h3>
          @if (diagnostic(); as d) {
            <p class="rk-diag-reason">{{ d.reason }}</p>
            <p class="rk-muted">Posiciones ese día: <b>{{ d.positions_day }}</b>@if (d.last_position_at) { · última {{ fmtDt(d.last_position_at) }} }</p>
          }
          <div class="rk-empty-actions">
            @if (lastDataDay(); as ld) { <button pButton size="small" (click)="goToLastDataDay()"><span class="p-button-icon p-button-icon-left pi pi-calendar" aria-hidden="true"></span><span class="p-button-label">Ver datos del {{ ld }}</span></button> }
            <button pButton size="small" severity="secondary" [text]="true" [loading]="loading()" (click)="refresh()"><span class="p-button-label">Reintentar</span></button>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .rk-eyebrow { display:inline-flex; align-items:center; gap:.35rem; font-size:var(--fs-micro); font-weight:var(--fw-bold); text-transform:uppercase; letter-spacing:.08em; color:var(--c-text-2); margin-bottom:.35rem; }
    .rk-muted { color:var(--c-text-3); }
    .rk-gps { display:inline-flex; align-items:center; gap:.25rem; margin-left:.4rem; padding:.05rem .4rem; border-radius:99px; background:var(--overlay-selected); color:var(--c-text-2); font-size:var(--fs-micro); font-weight:var(--fw-medium); font-variant-numeric:tabular-nums; }
    .rk-gps .pi { font-size:.7rem; color:var(--ok-fg); }
    .rk-actions { display:flex; gap:.4rem; align-items:center; }
    .rk-date { padding:.4rem .5rem; border:1px solid var(--border-color); border-radius:var(--r-md,8px); background:var(--card-bg); color:var(--c-text-1); font:inherit; font-size:var(--fs-sm); }
    .rk-date:focus-visible { outline:2px solid var(--action); outline-offset:1px; }

    .rk-filters { display:flex; gap:.4rem; align-items:center; flex-wrap:wrap; margin:.25rem 0 .75rem; }
    .rk-sep { width:1px; height:1.4rem; background:var(--c-divider); margin:0 .2rem; }
    :host ::ng-deep .rk-ms { min-width:14rem; }
    .rk-chip { display:inline-flex; align-items:center; gap:.3rem; padding:.32rem .6rem; border:1px solid var(--border-color); border-radius:99px; background:var(--card-bg); color:var(--c-text-3); font:inherit; font-size:var(--fs-micro); font-weight:var(--fw-medium); cursor:pointer; transition:color .12s, border-color .12s, background-color .12s; }
    .rk-chip:focus-visible { outline:2px solid var(--action); outline-offset:1px; }
    .rk-chip:hover { color:var(--c-text-1); border-color:var(--c-text-3); }
    .rk-chip.on { color:var(--c-text-1); border-color:var(--action); background:var(--overlay-selected); }
    .rk-chip:disabled { opacity:.5; cursor:default; }
    .rk-chip .rk-dot-lg { width:8px; height:8px; border-radius:99px; }
    .rk-chip .rk-num { font-style:normal; font-size:.85rem; line-height:1; }
    .rk-chip-calles.on { border-color:var(--action); color:var(--action); }
    .rk-dash { width:16px; height:0; border-top:2px dashed currentColor; display:inline-block; }

    .rk-map-grid { display:grid; grid-template-columns:1fr 20rem; gap:.75rem; height:64vh; min-height:420px; }
    .rk-map-main { min-width:0; border-radius:var(--r-lg,12px); overflow:hidden; }
    .rk-map-main ::ng-deep app-map, .rk-map-main ::ng-deep .map-shell { height:100%; }
    @media (max-width: 900px) { .rk-map-grid { grid-template-columns:1fr; height:auto; } .rk-map-main { height:52vh; } }

    .rk-routes { display:flex; flex-direction:column; border:1px solid var(--border-color); border-radius:var(--r-lg,12px); background:var(--card-bg); overflow:hidden; min-height:0; }
    .rk-routes-head { display:flex; align-items:center; justify-content:space-between; padding:.6rem .75rem; border-bottom:1px solid var(--c-divider); font-size:var(--fs-micro); text-transform:uppercase; letter-spacing:.06em; color:var(--c-text-3); font-weight:var(--fw-bold); }
    .rk-link { border:0; background:none; color:var(--action); font:inherit; font-size:var(--fs-micro); cursor:pointer; text-transform:none; letter-spacing:0; }
    .rk-route-list { list-style:none; margin:0; padding:0; overflow-y:auto; flex:1; min-height:0; }
    .rk-route-item { display:flex; gap:.55rem; align-items:center; padding:.5rem .75rem; border-top:1px solid var(--c-divider); cursor:pointer; }
    .rk-route-item:first-child { border-top:none; }
    .rk-route-item:hover { background:var(--overlay-hover); }
    .rk-route-item:focus-visible { outline:2px solid var(--action); outline-offset:-2px; }
    .rk-route-item.focus { background:var(--overlay-selected); box-shadow:inset 3px 0 0 var(--action); }
    .rk-route-item:not(.on) { opacity:.45; }
    .rk-route-sw { flex:0 0 auto; width:12px; height:12px; border-radius:3px; }
    .rk-route-sw.sm { width:9px; height:9px; display:inline-block; vertical-align:middle; margin-right:.3rem; }
    .rk-route-main { flex:1; min-width:0; }
    .rk-route-top { display:flex; justify-content:space-between; gap:.5rem; align-items:baseline; }
    .rk-route-name { font-weight:var(--fw-medium); font-size:var(--fs-sm); }
    .rk-route-cov { font-family:var(--font-mono,'Geist Mono',monospace); font-variant-numeric:tabular-nums; font-size:var(--fs-sm); font-weight:var(--fw-bold); }
    .rk-route-sub { font-size:var(--fs-micro); color:var(--c-text-3); }
    .rk-focus { padding:.75rem; border-top:1px solid var(--c-divider); background:var(--c-surface-2); }
    .rk-focus h4 { margin:0 0 .1rem; font-size:var(--fs-h4,1rem); font-weight:var(--fw-bold); }
    .rk-focus p { margin:0 0 .6rem; font-size:var(--fs-micro); }
    .rk-locsales { display:flex; align-items:center; gap:.3rem; margin-top:-.35rem; }
    .rk-locsales .pi { font-size:.7rem; }

    .rk-table-panel { margin-top:.75rem; border:1px solid var(--border-color); border-radius:var(--r-md,8px); overflow:hidden; }
    .rk-table-toggle { width:100%; text-align:left; display:flex; align-items:center; gap:.4rem; padding:.55rem .75rem; border:0; background:var(--card-bg); font:inherit; font-size:var(--fs-sm); font-weight:var(--fw-medium); color:var(--c-text-1); cursor:pointer; }
    .rk-table-toggle:hover { background:var(--overlay-hover); }
    :host ::ng-deep .rk-ptable { border-top:1px solid var(--c-divider); }
    :host ::ng-deep .rk-ptable .p-datatable-thead > tr > th { text-align:left; text-transform:uppercase; letter-spacing:.05em; font-size:var(--fs-micro); font-weight:var(--fw-bold); color:var(--c-text-3); white-space:nowrap; }
    :host ::ng-deep .rk-ptable th.num, :host ::ng-deep .rk-ptable td.num { text-align:right; font-variant-numeric:tabular-nums; }
    :host ::ng-deep .rk-ptable td.num { font-family:var(--font-mono,'Geist Mono',monospace); }
    :host ::ng-deep .rk-ptable .p-datatable-tbody > tr { cursor:pointer; }
    :host ::ng-deep .rk-ptable .p-datatable-tbody > tr.p-datatable-row-selected { background:var(--overlay-selected); box-shadow:inset 3px 0 0 var(--action); }
    :host ::ng-deep .rk-ptable .p-datatable-tbody > tr:focus-visible { outline:2px solid var(--action); outline-offset:-2px; }
    .rk-unit { font-weight:var(--fw-medium); }
    .rk-warn { color:var(--warn-fg); } .rk-dim { color:var(--c-text-3); }
    .rk-na { color:var(--c-text-3); font-size:var(--fs-micro); font-style:italic; }
    .rk-bar { display:inline-block; width:calc(100% - 3rem); height:6px; border-radius:99px; background:var(--c-surface-2); overflow:hidden; vertical-align:middle; }
    .rk-bar span { display:block; height:100%; background:var(--ok-fg); }
    .rk-bar-lbl { display:inline-block; width:2.6rem; text-align:right; font-family:var(--font-mono,'Geist Mono',monospace); font-variant-numeric:tabular-nums; font-size:var(--fs-micro); color:var(--c-text-2); }

    .rk-loading { display:flex; align-items:center; justify-content:center; gap:.5rem; padding:4rem 1.5rem; color:var(--c-text-3); font-size:var(--fs-sm); }
    .rk-empty { text-align:center; padding:3rem 1.5rem; max-width:460px; margin:0 auto; }
    .rk-empty-icon { width:56px; height:56px; margin:0 auto 1rem; border-radius:14px; background:var(--c-surface-2); color:var(--c-text-2); display:grid; place-items:center; font-size:1.5rem; }
    .rk-empty h3 { margin:0 0 .375rem; font-size:var(--fs-h3); font-weight:var(--fw-bold); }
    .rk-empty p { margin:0 0 .5rem; color:var(--c-text-2); font-size:var(--fs-sm); }
    .rk-diag-reason { color:var(--c-text-1); font-weight:var(--fw-medium); }
    .rk-empty-actions { display:flex; gap:.5rem; justify-content:center; margin-top:.75rem; flex-wrap:wrap; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogisticaAuditoriaRutaComponent {
  private readonly api = inject(LogisticaService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  @ViewChild('map') map?: MapComponent;

  readonly today = todayMx();
  readonly date = signal<string>(this.today);
  /** p-datepicker trabaja con Date; el estado canónico es 'YYYY-MM-DD' (TZ-safe, mx-date). */
  readonly todayObj = parseLocalDate(this.today);
  readonly dateObj = computed(() => parseLocalDate(this.date()));
  readonly rows = signal<FleetAdherenceRow[]>([]);
  readonly units = signal<FleetAuditUnit[]>([]);
  readonly loading = signal(false);
  readonly unitsLoading = signal(false);
  readonly errored = signal(false);
  readonly diagnostic = signal<AdherenceDiagnostic | null>(null);
  /** Hora de la última posición GPS recibida (freshness del poller). */
  readonly lastGpsAt = signal<string | null>(null);

  readonly selectedRoutes = signal<number[]>([]); // vacío = todas
  readonly showRecorrido = signal(false);
  readonly showParadas = signal(true);
  readonly showTiendas = signal(true);
  readonly showTickets = signal(true);
  readonly porCalles = signal(false);
  readonly snappedRoute = signal<AuditRoute | null>(null);
  readonly snapLoading = signal(false);
  readonly tableOpen = signal(false);

  /** Números de ruta ordenados (para asignar color estable). */
  private readonly routeOrder = computed(() => {
    const nums = Array.from(new Set(this.units().map((u) => u.route_number).filter((n): n is number => n != null))).sort((a, b) => a - b);
    return nums;
  });

  readonly routeList = computed<RouteEntry[]>(() =>
    this.units().map((u) => {
      const row = this.rows().find((r) => r.vehicle_id === u.vehicle_id);
      const skipped = row?.skipped_count ?? Math.max(0, u.planned_with_coords - u.visited_count);
      return {
        route_number: u.route_number,
        vehicle_id: u.vehicle_id,
        vehicle_plate: u.vehicle_plate,
        coverage_pct: u.coverage_pct,
        visited_count: u.visited_count,
        planned_with_coords: u.planned_with_coords,
        skipped_count: skipped,
        sales_docs: u.sales_docs ?? 0,
        sales_total: u.sales_total ?? 0,
        color: this.routeColor(u.route_number),
      };
    }),
  );

  readonly routeOptions = computed(() =>
    this.routeList()
      .filter((r) => r.route_number != null)
      .map((r) => ({ label: `R-${r.route_number} · ${r.coverage_pct != null ? r.coverage_pct + '%' : '—'}`, value: r.route_number as number })),
  );

  readonly visibleUnits = computed(() => {
    const sel = this.selectedRoutes();
    if (!sel.length) return this.units();
    const set = new Set(sel);
    return this.units().filter((u) => u.route_number != null && set.has(u.route_number));
  });

  /** Ruta enfocada = cuando hay exactamente una seleccionada. */
  readonly focusedRoute = computed(() => (this.selectedRoutes().length === 1 ? this.selectedRoutes()[0] : null));
  readonly focusedUnit = computed(() => {
    const rn = this.focusedRoute();
    return rn != null ? this.units().find((u) => u.route_number === rn) ?? null : null;
  });
  /** Fila del p-table correspondiente a la ruta enfocada (para `[selection]`). */
  readonly focusedRow = computed(() => {
    const rn = this.focusedRoute();
    return rn != null ? this.rows().find((r) => r.route_number === rn) ?? null : null;
  });

  readonly hasData = computed(() => this.units().length > 0);

  readonly mapLayers = computed<MapLayer[]>(() => {
    const units = this.visibleUnits();
    const layers: MapLayer[] = [];
    if (this.showRecorrido()) {
      const snap = this.focusedRoute() != null ? this.snappedRoute() : null;
      if (snap && snap.coordinates.length >= 2) {
        layers.push({ id: 'recorrido', visible: true, tracks: [{ points: snap.coordinates.map((c) => ({ lat: c[1], lng: c[0] })), color: this.routeColor(this.focusedRoute()) }] });
      } else {
        const tracks = units.filter((u) => u.path.length >= 2).map((u) => ({ points: u.path.map((p) => ({ lat: p.lat, lng: p.lng })), color: this.routeColor(u.route_number) }));
        if (tracks.length) layers.push({ id: 'recorrido', visible: true, tracks });
      }
    }
    if (this.showTiendas()) {
      const markers: MapMarker[] = units.flatMap((u) =>
        u.planned.filter((p) => p.lat != null && p.lng != null).map((p) => ({
          lat: p.lat!, lng: p.lng!, kind: 'pin' as const, id: 's:' + u.vehicle_id + ':' + p.customer_id,
          color: p.captured ? 'var(--ok-fg)' : p.visited ? 'var(--warn-fg)' : 'var(--bad-fg)',
          title: `${p.name || 'Tienda'} · R-${u.route_number} · ${p.captured ? 'visitada + captura' : p.visited ? 'visitada' : 'saltada'}`,
        })),
      );
      if (markers.length) layers.push({ id: 'tiendas', visible: true, markers });
    }
    if (this.showParadas()) {
      const markers: MapMarker[] = units.flatMap((u) =>
        u.stops.map((st) => ({
          lat: st.lat, lng: st.lng, seq: st.seq, kind: 'pin' as const, id: 'stop:' + u.vehicle_id + ':' + st.seq,
          color: this.routeColor(u.route_number),
          title: `R-${u.route_number} · Parada ${st.seq} · ${this.fmtClock(st.arrived_at)} (${st.minutes} min)${st.store_name ? ' · ' + st.store_name : ''}`,
        })),
      );
      if (markers.length) layers.push({ id: 'paradas', visible: true, markers });
    }
    if (this.showTickets()) {
      // Ventas REALES ubicadas por hora vs GPS (cuando hay hora: Wincaja a bordo).
      const markers: MapMarker[] = units.flatMap((u) =>
        (u.located_sales || []).filter((s) => s.at_lat != null && s.at_lng != null).map((s) => ({
          lat: s.at_lat!, lng: s.at_lng!, kind: 'pin' as const, id: 'sale:' + u.vehicle_id + ':' + s.consecutivo, color: 'var(--action)',
          title: `R-${u.route_number} · Venta ${s.consecutivo}${s.hora ? ' · ' + s.hora : ''} · ${this.money(s.total)}${s.near_store_name ? ' · ' + s.near_store_name : ''}`,
        })),
      );
      if (markers.length) layers.push({ id: 'tickets', visible: true, markers });
    }
    return layers;
  });

  constructor() {
    const q = this.route.snapshot.queryParamMap;
    const qDate = q.get('date');
    if (qDate && /^\d{4}-\d{2}-\d{2}$/.test(qDate)) this.date.set(qDate);
    const qr = q.get('routes');
    if (qr) {
      const nums = qr.split(',').map(Number).filter((n) => Number.isFinite(n));
      if (nums.length) this.selectedRoutes.set(nums);
    }
    this.refresh();
  }

  setDate(d: string) {
    if (!d) return;
    this.date.set(d);
    this.selectedRoutes.set([]);
    this.snappedRoute.set(null);
    this.porCalles.set(false);
    this.writeUrl();
    this.refresh();
  }

  /** Fecha + rutas seleccionadas en la URL (compartible/recargable), sin ensuciar historial. */
  private writeUrl() {
    const r = this.selectedRoutes();
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { date: this.date(), routes: r.length ? r.join(',') : null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** Selección del p-table = enfocar esa ruta (o "ver todas" si se deselecciona). */
  onTableSelect(row: FleetAdherenceRow | null) {
    if (row && row.route_number != null) this.focusRoute(row.route_number);
    else this.clearFocus();
  }

  /** p-datepicker devuelve Date → normaliza a 'YYYY-MM-DD' local (sin corrimiento TZ). */
  onDatePick(d: Date | null) {
    if (!d) return;
    const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    this.setDate(s);
  }

  refresh() {
    this.loading.set(true);
    this.unitsLoading.set(true);
    this.diagnostic.set(null);
    this.api.fleetAdherence(this.date()).subscribe({
      next: (r) => { this.rows.set(r || []); this.errored.set(false); this.loading.set(false); if (!(r && r.length)) this.loadDiagnostic(); },
      error: () => { this.errored.set(true); this.loading.set(false); },
    });
    this.api.fleetAuditDetail(this.date()).subscribe({
      next: (u) => { this.units.set(u || []); this.unitsLoading.set(false); },
      error: () => { this.units.set([]); this.unitsLoading.set(false); this.errored.set(true); },
    });
    // Freshness del rastreo GPS (última señal recibida por el poller).
    this.api.liveTracking('route').subscribe({
      next: (rows) => {
        const ts = (rows || []).map((r) => r.last_seen_at).filter((t): t is string => !!t).map((t) => new Date(t).getTime());
        this.lastGpsAt.set(ts.length ? new Date(Math.max(...ts)).toISOString() : null);
      },
      error: () => this.lastGpsAt.set(null),
    });
  }

  private loadDiagnostic() {
    this.api.fleetAdherenceDiagnostic(this.date()).subscribe({ next: (d) => this.diagnostic.set(d), error: () => this.diagnostic.set(null) });
  }

  onRoutesChange(sel: number[]) {
    this.selectedRoutes.set(sel || []);
    this.snappedRoute.set(null);
    this.porCalles.set(false);
    this.writeUrl();
  }
  focusRoute(rn: number | null) {
    if (rn == null) return;
    this.selectedRoutes.set([rn]);
    this.snappedRoute.set(null);
    this.porCalles.set(false);
    this.writeUrl();
  }
  clearFocus() { this.selectedRoutes.set([]); this.writeUrl(); }
  isSelected(rn: number | null) { const s = this.selectedRoutes(); return !s.length || (rn != null && s.includes(rn)); }

  togglePorCalles() {
    const u = this.focusedUnit();
    if (!u) return;
    const next = !this.porCalles();
    this.porCalles.set(next);
    if (next && !this.snappedRoute()) {
      this.snapLoading.set(true);
      this.api.vehicleAuditRoute(u.vehicle_id, this.date()).subscribe({
        next: (r) => { this.snappedRoute.set(r); this.snapLoading.set(false); },
        error: () => { this.snapLoading.set(false); this.porCalles.set(false); },
      });
    }
  }

  /** Botón "Historial de visitas": al Apartado Rutas con la ruta preseleccionada. */
  verHistorial() {
    const rn = this.focusedRoute();
    this.router.navigate(['/dashboard/routes'], { queryParams: rn != null ? { route_number: rn } : {} });
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  shortId(id: string) { return id ? id.slice(0, 8) : '—'; }
  locatedCount(u: FleetAuditUnit): number { return (u.located_sales || []).filter((s) => s.located).length; }
  routeColor(rn: number | null): string {
    if (rn == null) return 'var(--c-text-3)';
    const idx = this.routeOrder().indexOf(rn);
    return ROUTE_PALETTE[(idx < 0 ? rn : idx) % ROUTE_PALETTE.length];
  }
  coverageColor(pct: number | null): string {
    if (pct == null) return 'var(--c-text-3)';
    if (pct >= 85) return 'var(--ok-fg)';
    if (pct >= 60) return 'var(--warn-fg)';
    return 'var(--bad-fg)';
  }
  ticketLabel(t: AuditTicket['ticket_type']): string { return t === 'venta' ? 'Venta' : t === 'carga' ? 'Carga' : 'Combustible'; }
  fmtTime(t: string | null): string { return t ? String(t).slice(0, 5) : '—'; }
  fmtClock(iso: string): string { return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Mexico_City' }); }
  money(n: number | null): string { return n == null ? '—' : new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 }).format(Number(n)); }
  lastDataDay(): string | null {
    const iso = this.diagnostic()?.last_position_at;
    if (!iso) return null;
    const d = new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    return d && d !== this.date() ? d : null;
  }
  goToLastDataDay(): void { const d = this.lastDataDay(); if (d) this.setDate(d); }
  fmtDt(iso: string | null): string { return iso ? new Date(iso).toLocaleString('es-MX', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Mexico_City' }) : '—'; }
}
