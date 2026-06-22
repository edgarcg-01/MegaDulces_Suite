import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpParams } from '@angular/common/http';
import { RouterModule } from '@angular/router';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';
import { SelectModule } from 'primeng/select';
import { environment } from '../../../../environments/environment';
import { MapComponent, MapMarker } from '../../../shared/components/map/map.component';

interface RouteRow {
  id: string;
  name: string;
  zona: string;
  visitas: number;
  score: number;
}
interface RouteStore {
  id: string;
  nombre: string;
  zona_name: string;
  latitud: number | null;
  longitud: number | null;
  visited: boolean;
}
interface RouteVisit {
  capture_id: string;
  store_nombre: string;
  captured_by_username: string;
  hora_inicio: string;
  hora_fin: string | null;
  duration_min: number | null;
  latitud: number | null;
  longitud: number | null;
  score: number;
}
interface RouteIdleSegment {
  user_id: string;
  vendor: string;
  from_capture_id: string;
  to_capture_id: string;
  from_store: string;
  to_store: string;
  gap_min: number;
  dist_km: number | null;
  travel_est_min: number | null;
  idle_min: number;
  is_dead: boolean;
  // Refinamiento Fase 2 (presentes solo si hubo breadcrumbs GPS en la ventana).
  moving_min?: number;
  traveled_km?: number;
  has_breadcrumbs?: boolean;
}
interface RouteIdle {
  segments: RouteIdleSegment[];
  total_idle_min: number;
  total_travel_min: number;
  dead_count: number;
}
interface RouteTrackPoint {
  lat: number;
  lng: number;
  at: string;
  speed_mps: number | null;
}
interface RouteTrack {
  user_id: string;
  username: string;
  points: RouteTrackPoint[];
  count: number;
  last: RouteTrackPoint | null;
}

/**
 * Apartado "Rutas": análisis de ejecución por ruta.
 *   - Maestro: lista de rutas (GET /reports/routes).
 *   - Detalle: cobertura (tiendas asignadas vs visitadas), tiempos por visita
 *     (hora_inicio→fin, duración) y trazabilidad del recorrido en mapa Leaflet.
 * Gateado por RUTAS_VER (ruta lazy). Filtro de fechas local (no acopla estado
 * con el módulo Reportes).
 */
@Component({
  selector: 'app-routes-analysis',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, TableModule, TagModule, SkeletonModule, SelectModule, MapComponent],
  styles: [`
    /* ── layout ──────────────────────────────────────────────── */
    .ru-layout {
      display: grid;
      grid-template-columns: 1fr;
      gap: 1rem;
      align-items: start;
    }
    @media (min-width: 1024px) {
      .ru-layout { grid-template-columns: 272px 1fr; }
    }

    /* ── sidebar ─────────────────────────────────────────────── */
    .ru-sidebar { overflow: hidden; }
    @media (min-width: 1024px) {
      .ru-sidebar { max-height: 75vh; overflow-y: auto; }
    }
    .ru-sidebar--hidden { display: none; }
    @media (min-width: 1024px) { .ru-sidebar--hidden { display: block; } }

    /* ── route list ──────────────────────────────────────────── */
    .ru-route-list { list-style: none; margin: 0; padding: 0.25rem; }
    .ru-route-item {
      width: 100%; text-align: left; background: none; border: none;
      cursor: pointer; padding: 0.6rem 0.75rem; border-radius: 7px;
      display: flex; flex-direction: column; gap: 0.15rem;
      transition: background-color 100ms ease;
    }
    .ru-route-item:hover:not(.is-selected) { background: var(--hover-bg); }
    .ru-route-item.is-selected { background: var(--action); color: #fff; }
    .ru-route-item.is-selected .ru-route-zona { opacity: 0.7; }
    .ru-route-item:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 0; border-radius: 7px; }
    .ru-route-item-main { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
    .ru-route-name { font-size: 0.8125rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ru-route-badge {
      font-size: 0.6875rem; font-weight: 600; font-variant-numeric: tabular-nums;
      background: var(--surface-ground); color: var(--text-muted);
      border-radius: 999px; padding: 0.1rem 0.45rem; flex-shrink: 0; line-height: 1.4;
    }
    .ru-route-item.is-selected .ru-route-badge { background: rgba(255,255,255,.22); color: #fff; }
    .ru-route-zona { font-size: 0.6875rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ru-route-item.is-selected .ru-route-zona { color: inherit; }

    /* ── detail pane ─────────────────────────────────────────── */
    .ru-detail { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
    .ru-detail--hidden { display: none; }
    @media (min-width: 1024px) { .ru-detail--hidden { display: flex; } }

    /* ── filter bar ──────────────────────────────────────────── */
    .ru-filter-bar { display: flex; align-items: flex-end; gap: 0.75rem; flex-wrap: wrap; }
    .ru-date-field { display: flex; flex-direction: column; gap: 0.25rem; }
    .ru-date-label {
      font-size: 0.6875rem; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-faint);
    }
    .ru-date-input {
      height: 32px; padding: 0 0.625rem;
      border: 1px solid var(--border-color); border-radius: 7px;
      background: var(--card-bg); color: var(--text-main);
      font-size: 0.8125rem; font-family: inherit; outline: none;
    }
    .ru-date-input:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 0; }

    /* ── empty / placeholder states ──────────────────────────── */
    .ru-empty, .ru-placeholder {
      display: flex; flex-direction: column; align-items: center;
      gap: 0.5rem; padding: 2.5rem 1.5rem; text-align: center;
    }
    .ru-empty-icon { font-size: 1.625rem; color: var(--text-faint); margin-bottom: 0.125rem; }
    .ru-empty-title { font-size: 0.8125rem; font-weight: 700; color: var(--text-main); margin: 0; }
    .ru-empty-msg { font-size: 0.75rem; color: var(--text-muted); margin: 0; max-width: 280px; }
    .ru-link-btn {
      margin-top: 0.25rem; font-size: 0.75rem; color: var(--action);
      background: none; border: none; cursor: pointer; text-decoration: underline; padding: 0;
    }
    .ru-link-btn:hover { opacity: 0.8; }

    /* ── skeleton padding ────────────────────────────────────── */
    .ru-list-skeleton { padding: 0.5rem; display: flex; flex-direction: column; gap: 0.375rem; }

    /* ── map legend ──────────────────────────────────────────── */
    .ru-legend { display: flex; align-items: center; gap: 0.875rem; }
    .ru-legend-item {
      display: inline-flex; align-items: center; gap: 0.3rem;
      font-size: 0.6875rem; color: var(--text-faint);
    }
    .ru-legend-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
    .ru-map-empty { padding: 2.5rem; text-align: center; color: var(--text-muted); font-size: 0.8125rem; }

    /* ── table helpers ───────────────────────────────────────── */
    /* Tablas densas: scroll horizontal propio en pantallas chicas para
       NO empujar el ancho de toda la página (rompía el layout en móvil). */
    .ru-table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    :host ::ng-deep .ru-table-wide table { min-width: 660px; }
    .ru-table-empty { text-align: center; color: var(--text-muted); font-size: 0.8125rem; padding: 1.5rem; }
    .ru-cell-strong { font-weight: 600; color: var(--text-main); }
    .ru-cell-link { color: inherit; text-decoration: none; }
    .ru-cell-link:hover { color: var(--action); text-decoration: underline; }
    .ru-num { text-align: right; font-variant-numeric: tabular-nums; }
    .ru-idle-tag {
      font-size: 0.6875rem; font-weight: 600; font-variant-numeric: tabular-nums;
      background: var(--surface-ground); color: var(--text-muted);
      border-radius: 999px; padding: 0.1rem 0.45rem; line-height: 1.4; white-space: nowrap;
    }
    .ru-idle-tag.is-dead {
      background: var(--bad-soft-bg); color: var(--bad-soft-fg);
    }

    /* ── back button (mobile) ────────────────────────────────── */
    .ru-back-btn {
      display: inline-flex; align-items: center; gap: 0.375rem;
      font-size: 0.8125rem; color: var(--text-muted);
      background: none; border: none; cursor: pointer; padding: 0;
    }
    .ru-back-btn:hover { color: var(--text-main); }
    @media (min-width: 1024px) { .ru-back-btn { display: none; } }

    /* ── KPI grid: 4 individual cards con icon badge ────────── */
    .ru-kpi-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0.75rem;
    }
    @media (min-width: 900px) { .ru-kpi-grid { grid-template-columns: repeat(5, 1fr); } }

    .ru-kpi {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 1rem 1.125rem;
      display: flex;
      align-items: flex-start;
      gap: 0.875rem;
      min-height: 84px;
      position: relative;
      overflow: hidden;
    }
    /* Franja izquierda sutil */
    .ru-kpi::before {
      content: '';
      position: absolute;
      left: 0; top: 0; bottom: 0;
      width: 3px;
      background: var(--border-color);
    }
    .ru-kpi.is-ok::before  { background: var(--ok-fg); }
    .ru-kpi.is-warn::before { background: var(--warn-fg); }
    .ru-kpi.is-bad::before  { background: var(--bad-fg); }

    .ru-kpi-icon {
      width: 34px; height: 34px; border-radius: 8px; flex-shrink: 0;
      background: var(--surface-ground); color: var(--action);
      display: grid; place-items: center; font-size: 1rem;
      margin-top: 0.1rem;
    }
    .ru-kpi.is-ok   .ru-kpi-icon { background: rgba(22,163,74,.14);  color: var(--ok-fg); }
    .ru-kpi.is-warn .ru-kpi-icon { background: rgba(245,158,11,.16); color: var(--warn-fg); }
    .ru-kpi.is-bad  .ru-kpi-icon { background: rgba(220,38,38,.14);  color: var(--bad-fg); }

    .ru-kpi-body { flex: 1; min-width: 0; }
    .ru-kpi-label {
      font-size: 0.6875rem; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--text-faint); line-height: 1.2; margin: 0 0 0.35rem;
    }
    .ru-kpi-value {
      font-size: 1.75rem; font-weight: 800; letter-spacing: -0.03em;
      color: var(--text-main); line-height: 1; font-variant-numeric: tabular-nums;
    }
    .ru-kpi-sub {
      font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem;
      font-variant-numeric: tabular-nums; line-height: 1.3;
    }
    .ru-kpi-sub.is-ok   { color: var(--ok-fg); }
    .ru-kpi-sub.is-warn { color: var(--warn-fg); }
    .ru-kpi-sub.is-bad  { color: var(--bad-fg); }
    .ru-kpi-unit { font-size: 0.8125rem; font-weight: 600; color: var(--text-faint); margin-left: 0.2rem; letter-spacing: 0; }

    /* ── KPI mini-visualizaciones ───────────────────────────── */
    .ru-kpi-viz {
      width: 44px; height: 44px; flex-shrink: 0;
      display: grid; place-items: center; align-self: center;
    }

    /* Censo de tiendas: grilla de puntos visitada/pendiente */
    .ru-dots { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; width: 44px; }
    .ru-dot { width: 7px; height: 7px; border-radius: 50%; background: transparent; border: 1.5px solid var(--border-color); }
    .ru-dot.is-on { background: var(--ok-fg); border-color: var(--ok-fg); }
    .ru-dot-more { grid-column: span 4; font-size: 0.5rem; line-height: 1; color: var(--text-faint); }

    /* Donut radial de cobertura */
    .ru-donut { width: 44px; height: 44px; transform: rotate(-90deg); }
    .ru-donut-track { fill: none; stroke: var(--border-color); stroke-width: 5; }
    .ru-donut-arc {
      fill: none; stroke: var(--action); stroke-width: 5; stroke-linecap: round;
      transition: stroke-dasharray 0.5s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .ru-donut-arc.is-ok   { stroke: var(--ok-fg); }
    .ru-donut-arc.is-warn { stroke: var(--warn-fg); }
    .ru-donut-arc.is-bad  { stroke: var(--bad-fg); }

    /* Sparkline de visitas por hora */
    .ru-spark { display: flex; align-items: flex-end; gap: 2px; width: 44px; height: 34px; }
    .ru-spark-bar { flex: 1; min-height: 2px; background: var(--action); border-radius: 1px; opacity: 0.85; }

    /* Reloj-gauge de tiempo promedio */
    .ru-clock { width: 44px; height: 44px; }
    .ru-clock-face { fill: none; stroke: var(--border-color); stroke-width: 2; }
    .ru-clock-tick { stroke: var(--text-faint); stroke-width: 1.5; }
    .ru-clock-hand {
      stroke: var(--action); stroke-width: 2.5; stroke-linecap: round;
      transition: all 0.5s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .ru-clock-hand.is-ok   { stroke: var(--ok-fg); }
    .ru-clock-hand.is-warn { stroke: var(--warn-fg); }
    .ru-clock-hand.is-bad  { stroke: var(--bad-fg); }
    .ru-clock-pivot { fill: var(--text-main); }

    /* Barra split muerto/traslado */
    .ru-split { display: flex; width: 44px; height: 10px; border-radius: 999px; overflow: hidden; background: var(--surface-ground); }
    .ru-split-seg { display: block; height: 100%; transition: flex 0.5s cubic-bezier(0.4, 0, 0.2, 1); }
    .ru-split-seg.is-idle   { background: var(--bad-fg); }
    .ru-split-seg.is-travel { background: var(--neutral-400); }

    @media (prefers-reduced-motion: reduce) {
      .ru-donut-arc, .ru-clock-hand, .ru-split-seg { transition: none; }
    }

    /* ── map row: selector izq + mapa der ───────────────────── */
    .ru-map-row {
      display: grid;
      grid-template-columns: 272px 1fr;
      gap: 1rem;
      align-items: start;
    }
    @media (max-width: 1023px) {
      .ru-map-row { grid-template-columns: 1fr; }
    }

    /* ── sidebar min height ──────────────────────────────────── */
    .ru-sidebar { min-height: 120px; }
  `],
  template: `
    <div class="surf-page">

      <!-- PAGE HEADER ─────────────────────────────────────────────── -->
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Rutas</h1>
          <p class="surf-page-sub">Cobertura de tiendas, tiempos de visita y trazabilidad del recorrido.</p>
        </div>
        <div class="ru-filter-bar">
          <label class="ru-date-field" for="routes-date-from">
            <span class="ru-date-label">Desde</span>
            <input id="routes-date-from" type="date" [(ngModel)]="startDate" (change)="reload()" class="ru-date-input" />
          </label>
          <label class="ru-date-field" for="routes-date-to">
            <span class="ru-date-label">Hasta</span>
            <input id="routes-date-to" type="date" [(ngModel)]="endDate" (change)="reload()" class="ru-date-input" />
          </label>
        </div>
      </header>

      <!-- DETAIL — full width ─────────────────────────────────────── -->
      <section class="ru-detail">

          <!-- Placeholder: ninguna ruta seleccionada -->
          @if (!selectedId()) {
            <div class="surf-panel">
              <div class="ru-placeholder">
                <i class="pi pi-map ru-empty-icon" aria-hidden="true"></i>
                <p class="ru-empty-title">Seleccioná una ruta</p>
                <p class="ru-empty-msg">Verás cobertura de tiendas, tiempos de cada visita y el recorrido en el mapa.</p>
              </div>
            </div>
          }

          <!-- Sin actividad en el rango -->
          @else if (hasNoActivity()) {
            <div class="surf-panel">
              <div class="ru-placeholder">
                <i class="pi pi-calendar-times ru-empty-icon" aria-hidden="true"></i>
                <p class="ru-empty-title">Sin actividad en el rango</p>
                <p class="ru-empty-msg">Esta ruta no tiene visitas entre {{ fmtDateShort(startDate) }} y {{ fmtDateShort(endDate) }}.</p>
                <button type="button" class="ru-link-btn" (click)="widenRange()">Ampliar a 30 días</button>
              </div>
            </div>
          }

          @else {

            <!-- KPI STRIP ─── cards con mini-visualizaciones ─────────── -->
            <div class="ru-kpi-grid">

              <!-- TIENDAS: censo de puntos (visitada/pendiente) -->
              <div class="ru-kpi">
                <div class="ru-kpi-viz">
                  <div class="ru-dots" [attr.aria-label]="visitedCount() + ' de ' + stores().length + ' tiendas visitadas'">
                    @for (on of storeDots().dots; track $index) {
                      <span class="ru-dot" [class.is-on]="on"></span>
                    }
                    @if (storeDots().extra > 0) { <span class="ru-dot-more">+{{ storeDots().extra }}</span> }
                  </div>
                </div>
                <div class="ru-kpi-body">
                  <div class="ru-kpi-label">Tiendas</div>
                  <div class="ru-kpi-value">{{ stores().length }}</div>
                  <div class="ru-kpi-sub">{{ visitedCount() }} visitadas · {{ stores().length - visitedCount() }} pend.</div>
                </div>
              </div>

              <!-- COBERTURA: donut radial -->
              <div class="ru-kpi"
                [class.is-ok]="coverageSeverity() === 'good'"
                [class.is-warn]="coverageSeverity() === 'warn'"
                [class.is-bad]="coverageSeverity() === 'bad'">
                <div class="ru-kpi-viz">
                  <svg viewBox="0 0 40 40" class="ru-donut" aria-hidden="true">
                    <circle cx="20" cy="20" r="16" class="ru-donut-track"></circle>
                    <circle cx="20" cy="20" r="16" class="ru-donut-arc"
                      [class.is-ok]="coverageSeverity() === 'good'"
                      [class.is-warn]="coverageSeverity() === 'warn'"
                      [class.is-bad]="coverageSeverity() === 'bad'"
                      [attr.stroke-dasharray]="coverageDash()"></circle>
                  </svg>
                </div>
                <div class="ru-kpi-body">
                  <div class="ru-kpi-label">Cobertura</div>
                  <div class="ru-kpi-value">{{ coveragePct() }}%</div>
                  <div class="ru-kpi-sub">{{ visitedCount() }}/{{ stores().length }} visitadas</div>
                </div>
              </div>

              <!-- VISITAS: sparkline por hora del día -->
              <div class="ru-kpi">
                <div class="ru-kpi-viz">
                  @if (visitsSpark().bars.length) {
                    <div class="ru-spark" aria-hidden="true">
                      @for (b of visitsSpark().bars; track $index) {
                        <span class="ru-spark-bar" [style.height.%]="(b / visitsSpark().max) * 100"></span>
                      }
                    </div>
                  } @else {
                    <div class="ru-kpi-icon"><i class="pi pi-chart-bar"></i></div>
                  }
                </div>
                <div class="ru-kpi-body">
                  <div class="ru-kpi-label">Visitas</div>
                  <div class="ru-kpi-value">{{ filteredVisits().length }}</div>
                  <div class="ru-kpi-sub">
                    @if (vendorFilter()) { de {{ visits().length }} totales }
                    @else { por hora del día }
                  </div>
                </div>
              </div>

              <!-- TIEMPO PROM.: reloj-gauge con manecilla -->
              <div class="ru-kpi"
                [class.is-ok]="avgSeverity() === 'good'"
                [class.is-warn]="avgSeverity() === 'neutral'"
                [class.is-bad]="avgSeverity() === 'bad'">
                <div class="ru-kpi-viz">
                  <svg viewBox="0 0 44 44" class="ru-clock" aria-hidden="true">
                    <circle cx="22" cy="22" r="17" class="ru-clock-face"></circle>
                    <line x1="22" y1="7" x2="22" y2="10" class="ru-clock-tick"></line>
                    <line x1="37" y1="22" x2="34" y2="22" class="ru-clock-tick"></line>
                    <line x1="22" y1="37" x2="22" y2="34" class="ru-clock-tick"></line>
                    <line x1="7" y1="22" x2="10" y2="22" class="ru-clock-tick"></line>
                    <line x1="22" y1="22" [attr.x2]="clockHand().x" [attr.y2]="clockHand().y"
                      class="ru-clock-hand"
                      [class.is-ok]="avgSeverity() === 'good'"
                      [class.is-warn]="avgSeverity() === 'neutral'"
                      [class.is-bad]="avgSeverity() === 'bad'"></line>
                    <circle cx="22" cy="22" r="1.8" class="ru-clock-pivot"></circle>
                  </svg>
                </div>
                <div class="ru-kpi-body">
                  <div class="ru-kpi-label">Tiempo prom.</div>
                  <div class="ru-kpi-value">{{ avgDuration() }}<span class="ru-kpi-unit">min</span></div>
                  <div class="ru-kpi-sub"
                    [class.is-ok]="avgSeverity() === 'good'"
                    [class.is-warn]="avgSeverity() === 'neutral'"
                    [class.is-bad]="avgSeverity() === 'bad'">
                    @if (avgDeltaVsTarget() != null) {
                      {{ avgDeltaVsTarget()! > 0 ? '+' : '' }}{{ avgDeltaVsTarget() }} vs {{ targetMinutes }} min
                    } @else { objetivo {{ targetMinutes }} min }
                  </div>
                </div>
              </div>

              <!-- TIEMPO MUERTO: barra split muerto/traslado -->
              <div class="ru-kpi" [class.is-bad]="deadCount() > 0">
                <div class="ru-kpi-viz">
                  @if (totalIdleMin() + totalTravelMin() > 0) {
                    <div class="ru-split" aria-hidden="true"
                      [attr.title]="totalIdleMin() + ' min muerto · ' + totalTravelMin() + ' min traslado'">
                      <span class="ru-split-seg is-idle" [style.flex]="totalIdleMin() || 0.001"></span>
                      <span class="ru-split-seg is-travel" [style.flex]="totalTravelMin() || 0.001"></span>
                    </div>
                  } @else {
                    <div class="ru-kpi-icon"><i class="pi pi-hourglass"></i></div>
                  }
                </div>
                <div class="ru-kpi-body">
                  <div class="ru-kpi-label">Tiempo muerto</div>
                  <div class="ru-kpi-value">{{ totalIdleMin() }}<span class="ru-kpi-unit">min</span></div>
                  <div class="ru-kpi-sub" [class.is-bad]="deadCount() > 0">
                    @if (deadCount() > 0) { {{ deadCount() }} gap{{ deadCount() === 1 ? '' : 's' }} > {{ idleThreshold }} min }
                    @else { sin gaps muertos }
                  </div>
                </div>
              </div>
            </div>

            <!-- MAP ROW: selector izquierdo + mapa ────────────── -->
            <div class="ru-map-row">

              <!-- SELECTOR DE RUTAS -->
              <aside class="surf-panel">
                <div class="surf-panel-head">
                  <h3><i class="pi pi-map" aria-hidden="true"></i>&nbsp;Rutas</h3>
                  @if (routes().length > 0) {
                    <span class="text-[10px] text-content-faint uppercase tracking-widest">{{ routes().length }} rutas</span>
                  }
                </div>
                <div class="surf-panel-body is-flush" style="max-height:428px;overflow-y:auto">
                  @if (loadingMaster()) {
                    <div class="ru-list-skeleton">
                      @for (_ of [1,2,3,4,5]; track _) {
                        <p-skeleton height="2.25rem"></p-skeleton>
                      }
                    </div>
                  } @else {
                    <ul class="ru-route-list" role="listbox" aria-label="Rutas disponibles">
                      @for (r of routes(); track r.id) {
                        <li role="option" [attr.aria-selected]="r.id === selectedId()">
                          <button type="button" class="ru-route-item" (click)="select(r.id)"
                            [class.is-selected]="r.id === selectedId()"
                            [attr.aria-label]="r.name + ', ' + r.visitas + ' visitas, zona ' + (r.zona || 'sin zona')">
                            <div class="ru-route-item-main">
                              <span class="ru-route-name">{{ r.name }}</span>
                              <span class="ru-route-badge">{{ r.visitas }} vis</span>
                            </div>
                            <span class="ru-route-zona">{{ r.zona || '—' }}</span>
                          </button>
                        </li>
                      }
                    </ul>
                  }
                </div>
              </aside>

              <!-- MAPA -->
              <div class="surf-panel">
                <div class="surf-panel-head">
                  <h3><i class="pi pi-map" aria-hidden="true"></i>&nbsp;Recorrido y cobertura</h3>
                  <div class="ru-legend">
                    <span class="ru-legend-item">
                      <i class="ru-legend-dot" style="background:var(--action)" aria-hidden="true"></i>Visitada
                    </span>
                    <span class="ru-legend-item">
                      <i class="ru-legend-dot" style="background:var(--neutral-400)" aria-hidden="true"></i>Sin visitar
                    </span>
                    @if (mapTracks().length) {
                      <span class="ru-legend-item">
                        <i class="ru-legend-dot" style="background:#0E9BA8" aria-hidden="true"></i>Recorrido GPS
                      </span>
                    }
                  </div>
                </div>
                <div class="surf-panel-body is-flush">
                  @if (loadingDetail()) {
                    <p-skeleton height="420px"></p-skeleton>
                  } @else if (mapMarkers().length === 0 && mapTracks().length === 0) {
                    <div class="ru-map-empty">Sin coordenadas para mapear en esta ruta.</div>
                  } @else {
                    <app-map [markers]="mapMarkers()" [path]="mapPath()" [tracks]="mapTracks()" height="420px"></app-map>
                  }
                </div>
              </div>

            </div>

          }
      </section>

      <!-- TABLAS full-width ───────────────────────────────────────── -->
      @if (selectedId() && !hasNoActivity()) {

        <!-- VISITAS TABLE -->
        <div class="surf-panel">
          <div class="surf-panel-head">
            <h3><i class="pi pi-list" aria-hidden="true"></i>&nbsp;Visitas y tiempos</h3>
            @if (vendorOptions().length > 1) {
              <p-select [options]="vendorOptions()" [ngModel]="vendorFilter()"
                (ngModelChange)="vendorFilter.set($event)"
                placeholder="Todos los vendedores" [showClear]="true"
                styleClass="text-xs" appendTo="body"></p-select>
            }
          </div>
          <div class="surf-panel-body is-flush ru-table-scroll ru-table-wide">
            <p-table [value]="filteredVisits()" [loading]="loadingDetail()"
              styleClass="p-datatable-sm"
              sortField="hora_inicio" [sortOrder]="1">
              <ng-template pTemplate="header">
                <tr>
                  <th style="width:2.5rem">#</th>
                  <th>Tienda</th>
                  <th>Vendedor</th>
                  <th pSortableColumn="hora_inicio">Inicio <p-sortIcon field="hora_inicio"></p-sortIcon></th>
                  <th>Fin</th>
                  <th pSortableColumn="duration_min">Dur. <p-sortIcon field="duration_min"></p-sortIcon></th>
                  <th>Muerto antes</th>
                  <th pSortableColumn="score" style="text-align:right">Score <p-sortIcon field="score"></p-sortIcon></th>
                </tr>
              </ng-template>
              <ng-template pTemplate="body" let-v let-i="rowIndex">
                <tr>
                  <td class="comm-muted" style="font-size:0.75rem">{{ i + 1 }}</td>
                  <td>
                    <a [routerLink]="['/dashboard/stores']" [queryParams]="{ q: v.store_nombre }"
                      class="ru-cell-link ru-cell-strong">{{ v.store_nombre }}</a>
                  </td>
                  <td class="comm-muted">{{ v.captured_by_username }}</td>
                  <td><code class="comm-code">{{ fmtTime(v.hora_inicio) }}</code></td>
                  <td><code class="comm-code">{{ fmtTime(v.hora_fin) }}</code></td>
                  <td><code class="comm-code">{{ v.duration_min != null ? v.duration_min + ' min' : '—' }}</code></td>
                  <td>
                    @if (idleBeforeMap().get(v.capture_id); as seg) {
                      <span [class]="seg.is_dead ? 'ru-idle-tag is-dead' : 'ru-idle-tag'"
                        [attr.title]="seg.has_breadcrumbs
                          ? ('GPS · gap ' + seg.gap_min + ' min · estacionado ' + seg.idle_min + ' min · movimiento ' + (seg.moving_min ?? '—') + ' min · ' + (seg.traveled_km ?? '—') + ' km recorridos')
                          : ('estimado · gap ' + seg.gap_min + ' min · traslado est. ' + (seg.travel_est_min ?? '—') + ' min · ' + (seg.dist_km ?? '—') + ' km')">
                        {{ seg.idle_min }} min@if (seg.has_breadcrumbs) { <i class="pi pi-map-marker" style="font-size:0.6rem" aria-hidden="true"></i> }
                      </span>
                    } @else { <span class="comm-muted">—</span> }
                  </td>
                  <td class="ru-num">{{ v.score }}</td>
                </tr>
              </ng-template>
              <ng-template pTemplate="emptymessage">
                <tr><td colspan="8" class="ru-table-empty">
                  @if (stores().length > 0) { 0 visitas — {{ stores().length }} tiendas asignadas aparecen abajo. }
                  @else { Sin visitas en este rango. }
                </td></tr>
              </ng-template>
            </p-table>
          </div>
        </div>

        <!-- TIENDAS TABLE -->
        <div class="surf-panel">
          <div class="surf-panel-head">
            <h3><i class="pi pi-building" aria-hidden="true"></i>&nbsp;Tiendas de la ruta</h3>
            <span class="comm-muted is-small">{{ stores().length }} asignadas</span>
          </div>
          <div class="surf-panel-body is-flush ru-table-scroll">
            <p-table [value]="stores()" [loading]="loadingDetail()"
              styleClass="p-datatable-sm">
              <ng-template pTemplate="header">
                <tr>
                  <th>Tienda</th>
                  <th>Zona</th>
                  <th style="width:7rem">Estado</th>
                </tr>
              </ng-template>
              <ng-template pTemplate="body" let-s>
                <tr>
                  <td>
                    <a [routerLink]="['/dashboard/stores']" [queryParams]="{ q: s.nombre }"
                      class="ru-cell-link ru-cell-strong">{{ s.nombre }}</a>
                  </td>
                  <td class="comm-muted">{{ s.zona_name || '—' }}</td>
                  <td>
                    <p-tag [value]="s.visited ? 'Visitada' : 'Sin visitar'"
                      [severity]="s.visited ? 'success' : 'secondary'"></p-tag>
                  </td>
                </tr>
              </ng-template>
              <ng-template pTemplate="emptymessage">
                <tr><td colspan="3" class="ru-table-empty">
                  @if (visits().length > 0) { Visitas sin maestro de tiendas — revisar asignación de la ruta. }
                  @else { Esta ruta no tiene tiendas asignadas. }
                </td></tr>
              </ng-template>
            </p-table>
          </div>
        </div>

      }

    </div>
  `,
})
export class RoutesAnalysisComponent implements OnInit {
  private http = inject(HttpClient);

  startDate = isoOffset(0);
  endDate = isoOffset(0);

  loadingMaster = signal(false);
  loadingDetail = signal(false);
  routes = signal<RouteRow[]>([]);
  selectedId = signal<string | null>(null);
  stores = signal<RouteStore[]>([]);
  visits = signal<RouteVisit[]>([]);
  idle = signal<RouteIdle>({ segments: [], total_idle_min: 0, total_travel_min: 0, dead_count: 0 });
  tracks = signal<RouteTrack[]>([]);
  vendorFilter = signal<string | null>(null);
  /** Paleta categórica para las trazas GPS (estable por vendedor); evita morado/azul de acción. */
  static readonly TRACK_PALETTE = ['#0E9BA8', '#13A864', '#E8833A', '#C13DA8', '#5B6CC9', '#D64545'];
  readonly targetMinutes = 15;
  readonly idleThreshold = 20;
  /** Circunferencia del donut de cobertura (r=16). */
  readonly DONUT_C = 2 * Math.PI * 16;

  vendorOptions = computed(() => {
    const set = new Set(this.visits().map((v) => v.captured_by_username).filter(Boolean));
    return Array.from(set)
      .sort((a, b) => a.localeCompare(b, 'es-MX'))
      .map((u) => ({ label: u, value: u }));
  });

  filteredVisits = computed(() => {
    const f = this.vendorFilter();
    return f ? this.visits().filter((v) => v.captured_by_username === f) : this.visits();
  });

  // Tiempos muertos — filtrados por el mismo vendedor que la tabla de visitas.
  filteredIdle = computed(() => {
    const f = this.vendorFilter();
    return f ? this.idle().segments.filter((s) => s.vendor === f) : this.idle().segments;
  });
  totalIdleMin = computed(() =>
    Math.round(this.filteredIdle().reduce((a, s) => a + s.idle_min, 0)),
  );
  deadCount = computed(() => this.filteredIdle().filter((s) => s.is_dead).length);
  /** Mapa to_capture_id → segmento, para mostrar "muerto antes" por fila de visita. */
  idleBeforeMap = computed(() => {
    const m = new Map<string, RouteIdleSegment>();
    for (const s of this.filteredIdle()) m.set(s.to_capture_id, s);
    return m;
  });

  // ── Mini-visualizaciones de las KPI cards ──────────────────────────
  /** Donut de cobertura: longitud del arco según %. */
  coverageDash = computed(() => {
    const c = this.DONUT_C;
    return `${(this.coveragePct() / 100) * c} ${c}`;
  });
  coverageSeverity = computed<'good' | 'warn' | 'bad'>(() => {
    const p = this.coveragePct();
    return p >= 80 ? 'good' : p >= 50 ? 'warn' : 'bad';
  });
  /** Censo de tiendas: hasta 16 puntos (visitada/pendiente) + overflow. */
  storeDots = computed(() => {
    const ss = this.stores();
    const cap = 16;
    return {
      dots: ss.slice(0, cap).map((s) => s.visited),
      extra: Math.max(0, ss.length - cap),
    };
  });
  /** Sparkline de visitas por hora (TZ MX) sobre el rango filtrado. */
  visitsSpark = computed(() => {
    const byHour = new Array(24).fill(0);
    for (const v of this.filteredVisits()) {
      const h = this.mxHour(v.hora_inicio);
      if (h >= 0) byHour[h]++;
    }
    let lo = byHour.findIndex((c) => c > 0);
    if (lo < 0) return { bars: [] as number[], max: 0 };
    let hi = 23 - [...byHour].reverse().findIndex((c) => c > 0);
    lo = Math.max(0, lo - 1);
    hi = Math.min(23, hi + 1);
    const bars = byHour.slice(lo, hi + 1);
    return { bars, max: Math.max(...bars, 1) };
  });
  totalTravelMin = computed(() =>
    Math.round(this.filteredIdle().reduce((a, s) => a + (s.travel_est_min || 0), 0)),
  );
  /** Reloj-gauge: avg mapeado sobre [0, 2×target] → punta de la manecilla. */
  clockHand = computed(() => {
    const f = Math.min(this.avgDuration() / (2 * this.targetMinutes || 1), 1);
    const a = ((f * 360 - 90) * Math.PI) / 180;
    const cx = 22, cy = 22, L = 12;
    return { x: +(cx + L * Math.cos(a)).toFixed(2), y: +(cy + L * Math.sin(a)).toFixed(2) };
  });

  visitedCount = computed(() => this.stores().filter((s) => s.visited).length);
  coveragePct = computed(() => {
    const t = this.stores().length;
    return t > 0 ? Math.round((this.visitedCount() / t) * 100) : 0;
  });
  avgDuration = computed(() => {
    const ds = this.filteredVisits().map((v) => v.duration_min).filter((d): d is number => d != null);
    return ds.length ? Math.round((ds.reduce((a, b) => a + b, 0) / ds.length) * 10) / 10 : 0;
  });
  avgDeltaVsTarget = computed(() => {
    const avg = this.avgDuration();
    if (!avg) return null;
    return Math.round((avg - this.targetMinutes) * 10) / 10;
  });
  avgSeverity = computed<'good' | 'bad' | 'neutral'>(() => {
    const d = this.avgDeltaVsTarget();
    if (d == null) return 'neutral';
    if (d <= 0) return 'good';
    return d <= 3 ? 'neutral' : 'bad';
  });
  hasNoActivity = computed(
    () => !this.loadingDetail() && this.visits().length === 0 && this.stores().length === 0,
  );

  // Mapa: pins de visitas (numerados, en orden) + pins de tiendas no visitadas (gris).
  mapMarkers = computed<MapMarker[]>(() => {
    const out: MapMarker[] = [];
    this.filteredVisits().forEach((v, i) => {
      if (v.latitud != null && v.longitud != null)
        out.push({ lat: v.latitud, lng: v.longitud, seq: i + 1, color: 'var(--action)', title: `${i + 1}. ${v.store_nombre} · ${this.fmtTime(v.hora_inicio)}` });
    });
    this.stores().filter((s) => !s.visited).forEach((s) => {
      if (s.latitud != null && s.longitud != null)
        out.push({ lat: s.latitud, lng: s.longitud, color: 'var(--neutral-400)', title: `${s.nombre} (sin visitar)` });
    });
    // Camión en la última posición conocida de cada traza GPS.
    this.visibleTracks().forEach((t) => {
      if (t.last && Number.isFinite(t.last.lat) && Number.isFinite(t.last.lng))
        out.push({ lat: t.last.lat, lng: t.last.lng, kind: 'truck', color: this.trackColor(t.username), title: `${t.username} · última posición ${this.fmtTime(t.last.at)}` });
    });
    return out;
  });
  /** Trazas con puntos, filtradas por el vendedor seleccionado (si hay). */
  visibleTracks = computed(() => {
    const f = this.vendorFilter();
    return this.tracks().filter((t) => (t.points?.length || 0) > 0 && (!f || t.username === f));
  });
  /** Trazas para el mapa: polyline sólida coloreada por vendedor. */
  mapTracks = computed(() =>
    this.visibleTracks().map((t) => ({
      points: t.points.map((p) => ({ lat: p.lat, lng: p.lng })),
      color: this.trackColor(t.username),
    })),
  );
  /** Color estable por vendedor (índice en la lista completa de trazas). */
  private trackColor(username: string): string {
    const pal = RoutesAnalysisComponent.TRACK_PALETTE;
    const idx = this.tracks().findIndex((t) => t.username === username);
    return pal[(idx < 0 ? 0 : idx) % pal.length];
  }
  mapPath = computed(() =>
    this.filteredVisits()
      .filter((v) => v.latitud != null && v.longitud != null)
      .map((v) => ({ lat: v.latitud as number, lng: v.longitud as number })),
  );

  ngOnInit(): void {
    this.loadMaster();
  }

  reload(): void {
    this.loadMaster();
    if (this.selectedId()) this.loadDetail(this.selectedId() as string);
  }

  private dateParams(): HttpParams {
    let p = new HttpParams();
    if (this.startDate) p = p.set('startDate', this.startDate);
    if (this.endDate) p = p.set('endDate', this.endDate);
    return p;
  }

  loadMaster(): void {
    this.loadingMaster.set(true);
    this.http.get<{ routes: RouteRow[] }>(`${environment.apiUrl}/reports/routes`, { params: this.dateParams() }).subscribe({
      next: (res) => {
        this.routes.set(res?.routes || []);
        this.loadingMaster.set(false);
        // Auto-seleccionar la primera ruta en TODOS los dispositivos: el selector
        // de rutas vive dentro del bloque que solo se pinta con una ruta elegida,
        // así que en móvil sin auto-select la página quedaba en el placeholder sin
        // forma de elegir. El selector full-width arriba permite cambiar de ruta.
        if (!this.selectedId() && this.routes().length) {
          this.select(this.routes()[0].id);
        }
      },
      error: () => this.loadingMaster.set(false),
    });
  }

  select(id: string): void {
    this.selectedId.set(id);
    this.vendorFilter.set(null);
    this.loadDetail(id);
  }

  clearSelection(): void {
    this.selectedId.set(null);
    this.stores.set([]);
    this.visits.set([]);
    this.tracks.set([]);
    this.vendorFilter.set(null);
  }

  private loadDetail(id: string): void {
    this.loadingDetail.set(true);
    this.stores.set([]);
    this.visits.set([]);
    this.tracks.set([]);
    this.idle.set({ segments: [], total_idle_min: 0, total_travel_min: 0, dead_count: 0 });
    const params = this.dateParams();
    let pending = 4;
    const done = () => { if (--pending === 0) this.loadingDetail.set(false); };
    this.http.get<RouteStore[]>(`${environment.apiUrl}/reports/routes/${id}/stores`, { params }).subscribe({
      next: (r) => { this.stores.set(r || []); done(); }, error: done,
    });
    this.http.get<RouteVisit[]>(`${environment.apiUrl}/reports/routes/${id}/visits`, { params }).subscribe({
      next: (r) => { this.visits.set(r || []); done(); }, error: done,
    });
    this.http.get<RouteIdle>(`${environment.apiUrl}/reports/routes/${id}/idle`, { params }).subscribe({
      next: (r) => { this.idle.set(r || { segments: [], total_idle_min: 0, total_travel_min: 0, dead_count: 0 }); done(); }, error: done,
    });
    this.http.get<{ tracks: RouteTrack[] }>(`${environment.apiUrl}/reports/routes/${id}/track`, { params }).subscribe({
      next: (r) => { this.tracks.set(r?.tracks || []); done(); }, error: done,
    });
  }

  fmtTime(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
  }

  /** Hora del día (0–23) en TZ MX para el sparkline de visitas. -1 si inválida. */
  private mxHour(iso: string | null): number {
    if (!iso) return -1;
    const s = new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/Mexico_City',
      hour: '2-digit',
      hour12: false,
    });
    const h = parseInt(s, 10);
    return isNaN(h) ? -1 : h === 24 ? 0 : h;
  }

  fmtDateShort(iso: string): string {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y.slice(2)}`;
  }

  widenRange(): void {
    this.startDate = isoOffset(-30);
    this.endDate = isoOffset(0);
    this.reload();
  }
}

/** Fecha YYYY-MM-DD con offset de días, en local (suficiente para el filtro). */
function isoOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA');
}
