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
  template: `
    <div class="p-4 md:p-6 space-y-4">
      <header class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-xl font-semibold text-content-main">Rutas</h1>
          <p class="text-sm text-content-soft">Tiendas por ruta, tiempos de visita y trazabilidad del recorrido.</p>
        </div>
        <div class="flex items-end gap-2">
          <label for="routes-date-from" class="text-xs text-content-soft">Desde
            <input id="routes-date-from" type="date" [(ngModel)]="startDate" (change)="reload()"
              class="block mt-1 px-2 py-1.5 rounded-md border border-divider bg-surface-card text-content-main text-sm
                focus:outline-none focus-visible:ring-2 focus-visible:ring-brand" />
          </label>
          <label for="routes-date-to" class="text-xs text-content-soft">Hasta
            <input id="routes-date-to" type="date" [(ngModel)]="endDate" (change)="reload()"
              class="block mt-1 px-2 py-1.5 rounded-md border border-divider bg-surface-card text-content-main text-sm
                focus:outline-none focus-visible:ring-2 focus-visible:ring-brand" />
          </label>
        </div>
      </header>

      <div class="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
        <!-- Maestro: lista de rutas (mobile: oculto cuando hay selecci&oacute;n) -->
        <aside [class.hidden]="selectedId()"
          class="lg:!block bg-surface-card border border-divider rounded-lg p-2 lg:max-h-[70vh] overflow-auto">
          @if (loadingMaster()) {
            <p-skeleton height="2.5rem" styleClass="mb-2" *ngFor="let _ of [1,2,3,4,5]"></p-skeleton>
          } @else if (routes().length === 0) {
            <div class="p-4 text-center space-y-2">
              <i class="pi pi-map text-2xl text-content-soft opacity-50"></i>
              <p class="text-sm text-content-soft">Ninguna ruta registra actividad entre {{ fmtDateShort(startDate) }} y {{ fmtDateShort(endDate) }}.</p>
              <button type="button" (click)="widenRange()"
                class="text-xs text-brand hover:underline">Ampliar a 30 d&iacute;as</button>
            </div>
          } @else {
            @for (r of routes(); track r.id) {
              <button type="button" (click)="select(r.id)"
                [attr.aria-current]="r.id === selectedId() ? 'true' : null"
                [attr.aria-label]="r.name + ', ' + r.visitas + ' visitas, zona ' + (r.zona || 'sin zona')"
                class="w-full text-left px-3 py-2 rounded-md mb-1 transition-colors
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
                [class.bg-brand]="r.id === selectedId()"
                [class.text-white]="r.id === selectedId()"
                [class.hover:bg-surface-hover]="r.id !== selectedId()">
                <div class="flex items-center justify-between gap-2">
                  <span class="font-medium truncate">{{ r.name }}</span>
                  <span class="text-xs opacity-80">{{ r.visitas }} vis</span>
                </div>
                <div class="text-xs opacity-70 truncate">{{ r.zona || '—' }}</div>
              </button>
            }
          }
        </aside>

        <!-- Detalle de la ruta seleccionada (mobile: oculto sin selecci&oacute;n) -->
        <section [class.hidden]="!selectedId()" class="lg:!block space-y-4 min-w-0">
          @if (selectedId()) {
            <button type="button" (click)="clearSelection()"
              class="lg:hidden inline-flex items-center gap-1 text-xs text-content-soft hover:text-content-main">
              <i class="pi pi-arrow-left"></i> Volver al listado
            </button>
          }
          @if (!selectedId()) {
            <div class="bg-surface-card border border-divider rounded-lg p-8 text-center space-y-2">
              <i class="pi pi-arrow-left text-2xl text-content-soft opacity-50"></i>
              <p class="text-sm text-content-main font-medium">Eleg&iacute; una ruta del listado</p>
              <p class="text-xs text-content-soft">Ver&aacute;s cobertura (tiendas asignadas vs visitadas), tiempos de cada visita y el recorrido del vendedor en el mapa.</p>
            </div>
          } @else if (hasNoActivity()) {
            <div class="bg-surface-card border border-divider rounded-lg p-8 text-center space-y-2">
              <i class="pi pi-calendar-times text-2xl text-content-soft opacity-50"></i>
              <p class="text-sm text-content-main font-medium">Sin actividad en el rango</p>
              <p class="text-xs text-content-soft">Esta ruta no tiene visitas ni tiendas asignadas entre {{ fmtDateShort(startDate) }} y {{ fmtDateShort(endDate) }}.</p>
              <button type="button" (click)="widenRange()"
                class="text-xs text-brand hover:underline">Ampliar a 30 d&iacute;as</button>
            </div>
          } @else {
            <!-- KPIs -->
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div class="bg-surface-card border border-divider rounded-lg p-3">
                <div class="text-xs text-content-soft">Tiendas</div>
                <div class="text-lg font-semibold text-content-main">{{ stores().length }}</div>
              </div>
              <div class="bg-surface-card border border-divider rounded-lg p-3">
                <div class="text-xs text-content-soft">Cobertura</div>
                <div class="text-lg font-semibold text-content-main">{{ coveragePct() }}%</div>
                <div class="text-xs text-content-soft">{{ visitedCount() }}/{{ stores().length }} visitadas</div>
              </div>
              <div class="bg-surface-card border border-divider rounded-lg p-3">
                <div class="text-xs text-content-soft">Visitas</div>
                <div class="text-lg font-semibold text-content-main">{{ filteredVisits().length }}</div>
                @if (vendorFilter()) {
                  <div class="text-xs text-content-soft">de {{ visits().length }} totales</div>
                }
              </div>
              <div class="bg-surface-card border border-divider rounded-lg p-3">
                <div class="text-xs text-content-soft">Tiempo prom.</div>
                <div class="text-lg font-semibold text-content-main">{{ avgDuration() }} min</div>
                @if (avgDeltaVsTarget() != null) {
                  <div class="text-xs"
                    [class.text-green-600]="avgSeverity() === 'good'"
                    [class.text-amber-600]="avgSeverity() === 'neutral'"
                    [class.text-red-600]="avgSeverity() === 'bad'">
                    {{ avgDeltaVsTarget()! > 0 ? '+' : '' }}{{ avgDeltaVsTarget() }} vs {{ targetMinutes }} min target
                  </div>
                }
              </div>
            </div>

            <!-- Mapa: recorrido + cobertura -->
            <div class="bg-surface-card border border-divider rounded-lg p-2">
              <div class="flex items-center justify-between px-2 py-1">
                <h2 class="text-sm font-semibold text-content-main">Recorrido y cobertura</h2>
                <div class="flex items-center gap-3 text-xs text-content-soft">
                  <span class="inline-flex items-center gap-1"><i class="w-3 h-3 rounded-full inline-block" style="background:var(--brand,#f97316)"></i>visitada (en orden)</span>
                  <span class="inline-flex items-center gap-1"><i class="w-3 h-3 rounded-full inline-block" style="background:#9ca3af"></i>sin visitar</span>
                </div>
              </div>
              @if (loadingDetail()) {
                <p-skeleton height="420px"></p-skeleton>
              } @else if (mapMarkers().length === 0) {
                <div class="p-8 text-center text-content-soft text-sm">Sin coordenadas para mapear en esta ruta.</div>
              } @else {
                <app-map [markers]="mapMarkers()" [path]="mapPath()" height="420px"></app-map>
              }
            </div>

            <!-- Tiempos por visita -->
            <div class="bg-surface-card border border-divider rounded-lg overflow-hidden">
              <div class="flex items-center justify-between gap-2 px-3 py-2 border-b border-divider">
                <h2 class="text-sm font-semibold text-content-main">Visitas y tiempos</h2>
                @if (vendorOptions().length > 1) {
                  <p-select
                    [options]="vendorOptions()"
                    [ngModel]="vendorFilter()"
                    (ngModelChange)="vendorFilter.set($event)"
                    placeholder="Todos los vendedores"
                    [showClear]="true"
                    styleClass="text-xs"
                    appendTo="body"></p-select>
                }
              </div>
              <p-table [value]="filteredVisits()" [loading]="loadingDetail()" styleClass="p-datatable-sm" [scrollable]="true" scrollHeight="320px" sortField="hora_inicio" [sortOrder]="1">
                <ng-template pTemplate="header">
                  <tr>
                    <th>#</th>
                    <th>Tienda</th>
                    <th>Vendedor</th>
                    <th pSortableColumn="hora_inicio">Inicio <p-sortIcon field="hora_inicio"></p-sortIcon></th>
                    <th>Fin</th>
                    <th pSortableColumn="duration_min">Duraci&oacute;n <p-sortIcon field="duration_min"></p-sortIcon></th>
                    <th pSortableColumn="score">Score <p-sortIcon field="score"></p-sortIcon></th>
                  </tr>
                </ng-template>
                <ng-template pTemplate="body" let-v let-i="rowIndex">
                  <tr>
                    <td>{{ i + 1 }}</td>
                    <td>
                      <a [routerLink]="['/dashboard/stores']" [queryParams]="{ q: v.store_nombre }"
                        class="font-medium text-content-main hover:text-brand hover:underline">
                        {{ v.store_nombre }}
                      </a>
                    </td>
                    <td class="text-content-soft">{{ v.captured_by_username }}</td>
                    <td>{{ fmtTime(v.hora_inicio) }}</td>
                    <td>{{ fmtTime(v.hora_fin) }}</td>
                    <td>{{ v.duration_min != null ? v.duration_min + ' min' : '—' }}</td>
                    <td>{{ v.score }}</td>
                  </tr>
                </ng-template>
                <ng-template pTemplate="emptymessage">
                  <tr><td colspan="7" class="text-center text-content-soft py-4">
                    @if (stores().length > 0) {
                      0 visitas registradas. Las {{ stores().length }} tiendas asignadas siguen visibles abajo.
                    } @else {
                      Sin visitas en este rango.
                    }
                  </td></tr>
                </ng-template>
              </p-table>
            </div>

            <!-- Cobertura: tiendas asignadas -->
            <div class="bg-surface-card border border-divider rounded-lg overflow-hidden">
              <h2 class="text-sm font-semibold text-content-main px-3 py-2 border-b border-divider">Tiendas de la ruta</h2>
              <p-table [value]="stores()" [loading]="loadingDetail()" styleClass="p-datatable-sm" [scrollable]="true" scrollHeight="320px">
                <ng-template pTemplate="header">
                  <tr><th>Tienda</th><th>Zona</th><th>Estado</th></tr>
                </ng-template>
                <ng-template pTemplate="body" let-s>
                  <tr>
                    <td>
                      <a [routerLink]="['/dashboard/stores']" [queryParams]="{ q: s.nombre }"
                        class="font-medium text-content-main hover:text-brand hover:underline">
                        {{ s.nombre }}
                      </a>
                    </td>
                    <td class="text-content-soft">{{ s.zona_name || '—' }}</td>
                    <td>
                      <p-tag [value]="s.visited ? 'Visitada' : 'Sin visitar'"
                        [severity]="s.visited ? 'success' : 'secondary'"></p-tag>
                    </td>
                  </tr>
                </ng-template>
                <ng-template pTemplate="emptymessage">
                  <tr><td colspan="3" class="text-center text-content-soft py-4">
                    @if (visits().length > 0) {
                      Visitas registradas sin maestro de tiendas asociado. Revisar asignaci&oacute;n formal de la ruta.
                    } @else {
                      Esta ruta no tiene tiendas asignadas.
                    }
                  </td></tr>
                </ng-template>
              </p-table>
            </div>
          }
        </section>
      </div>
    </div>
  `,
})
export class RoutesAnalysisComponent implements OnInit {
  private http = inject(HttpClient);

  startDate = isoOffset(-7);
  endDate = isoOffset(0);

  loadingMaster = signal(false);
  loadingDetail = signal(false);
  routes = signal<RouteRow[]>([]);
  selectedId = signal<string | null>(null);
  stores = signal<RouteStore[]>([]);
  visits = signal<RouteVisit[]>([]);
  vendorFilter = signal<string | null>(null);
  readonly targetMinutes = 15;

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
        out.push({ lat: v.latitud, lng: v.longitud, seq: i + 1, color: 'var(--brand, #f97316)', title: `${i + 1}. ${v.store_nombre} · ${this.fmtTime(v.hora_inicio)}` });
    });
    this.stores().filter((s) => !s.visited).forEach((s) => {
      if (s.latitud != null && s.longitud != null)
        out.push({ lat: s.latitud, lng: s.longitud, color: '#9ca3af', title: `${s.nombre} (sin visitar)` });
    });
    return out;
  });
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
        if (!this.selectedId() && this.routes().length && this.isDesktop()) {
          this.select(this.routes()[0].id);
        }
      },
      error: () => this.loadingMaster.set(false),
    });
  }

  private isDesktop(): boolean {
    return typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches;
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
    this.vendorFilter.set(null);
  }

  private loadDetail(id: string): void {
    this.loadingDetail.set(true);
    this.stores.set([]);
    this.visits.set([]);
    const params = this.dateParams();
    let pending = 2;
    const done = () => { if (--pending === 0) this.loadingDetail.set(false); };
    this.http.get<RouteStore[]>(`${environment.apiUrl}/reports/routes/${id}/stores`, { params }).subscribe({
      next: (r) => { this.stores.set(r || []); done(); }, error: done,
    });
    this.http.get<RouteVisit[]>(`${environment.apiUrl}/reports/routes/${id}/visits`, { params }).subscribe({
      next: (r) => { this.visits.set(r || []); done(); }, error: done,
    });
  }

  fmtTime(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
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
