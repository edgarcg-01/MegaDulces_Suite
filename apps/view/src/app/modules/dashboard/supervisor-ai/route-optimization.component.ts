import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { SkeletonModule } from 'primeng/skeleton';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { MapComponent, MapLayer } from '../../../shared/components/map/map.component';
import { SupervisorAiService, RouteOptRow, RouteOptDetail } from './supervisor-ai.service';

/**
 * Horus ACT.2/ACT.3 — mapa "Rutas reconvertidas". Muestra cada ruta en dos
 * versiones sobre el mapa: cómo se recorre HOY (línea gris, por visit_sequence) vs
 * cómo DEBERÍA recorrerse (línea verde numerada, orden nearest-neighbor), con las
 * tiendas de oportunidad (INEGI/DENUE) cercanas como pines ámbar. Read-only: el
 * reorden real lo aplica el supervisor aprobando la acción del co-piloto.
 * Superficie Operations (DESIGN.md): sin Fraunces, denso, tokens.
 */
@Component({
  selector: 'app-route-optimization',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, ButtonModule, SelectModule, SkeletonModule, MapComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ro">
      <header class="ro__head">
        <div>
          <a routerLink="/dashboard/supervisor-ai" class="ro__back"><i class="pi pi-arrow-left"></i> Supervisor IA</a>
          <h1 class="ro__title">Rutas reconvertidas</h1>
          <p class="ro__sub">Cómo se recorre hoy vs cómo debería — y las tiendas de oportunidad cercanas</p>
        </div>
        <div class="ro__pick">
          <p-select
            [options]="routeOptions()"
            [(ngModel)]="selected"
            (onChange)="loadDetail($event.value)"
            optionLabel="label"
            optionValue="value"
            placeholder="Elegí una ruta"
            [filter]="true"
            styleClass="ro__select"
          />
        </div>
      </header>

      @if (loading()) {
        <p-skeleton height="4rem" styleClass="mb-3" />
        <p-skeleton height="30rem" />
      } @else if (routes().length === 0) {
        <div class="card empty">
          Sin rutas con clientes geolocalizados suficientes. Cargá coordenadas de clientes (app vendedor)
          para poder optimizar el recorrido.
        </div>
      } @else {
        @if (detail(); as d) {
          <div class="kpis">
            <div class="kpi">
              <span class="kpi__l">Recorrido hoy</span>
              <span class="kpi__v">{{ d.metrics?.current_km ?? '—' }} km</span>
            </div>
            <div class="kpi">
              <span class="kpi__l">Recorrido óptimo</span>
              <span class="kpi__v kpi__v--ok">{{ d.metrics?.proposed_km ?? '—' }} km</span>
            </div>
            <div class="kpi">
              <span class="kpi__l">Mejora</span>
              <span class="kpi__v" [class.kpi__v--ok]="(d.metrics?.improvement_pct ?? 0) > 0">
                {{ d.metrics?.improvement_pct ?? 0 }}%
              </span>
            </div>
            <div class="kpi">
              <span class="kpi__l">Paradas · oportunidades</span>
              <span class="kpi__v">{{ d.metrics?.stops ?? 0 }} · {{ d.opportunities.length }}</span>
            </div>
          </div>

          <div class="legend">
            <button type="button" class="lg" [class.lg--off]="!showCurrent()" (click)="showCurrent.set(!showCurrent())">
              <span class="sw sw--cur"></span> Como es hoy
            </button>
            <button type="button" class="lg" [class.lg--off]="!showProposed()" (click)="showProposed.set(!showProposed())">
              <span class="sw sw--prop"></span> Como debería
            </button>
            <button type="button" class="lg" [class.lg--off]="!showOpp()" (click)="showOpp.set(!showOpp())">
              <span class="sw sw--opp"></span> Tiendas de oportunidad
            </button>
          </div>

          <div class="card map-card">
            <app-map [layers]="layers()" height="520px" autoFit="once" [showBasemapToggle]="true" />
          </div>

          <div class="grid2">
            <section class="card">
              <h2 class="card__title">Orden propuesto ({{ d.proposed.length }} paradas)</h2>
              <ol class="stops">
                @for (s of d.proposed; track s.id) {
                  <li class="stop">
                    <span class="stop__seq">{{ s.seq }}</span>
                    <span class="stop__name">{{ s.name }}</span>
                    @if (prevSeq(s.id); as p) {
                      <span class="stop__was" [class.stop__was--up]="p > s.seq" [class.stop__was--down]="p < s.seq">
                        antes #{{ p }}
                      </span>
                    }
                  </li>
                }
              </ol>
            </section>

            <section class="card">
              <h2 class="card__title">Tiendas de oportunidad ({{ d.opportunities.length }})</h2>
              @if (d.opportunities.length === 0) {
                <p class="empty">Sin prospectos DENUE cercanos a esta ruta (≤3 km).</p>
              } @else {
                <ul class="opps">
                  @for (o of d.opportunities; track o.prospect_id) {
                    <li class="opp">
                      <span class="opp__dot"></span>
                      <div class="opp__body">
                        <span class="opp__name">{{ o.name || 'PdV' }}</span>
                        <span class="opp__meta">
                          {{ o.scian_label || 'PdV' }} · a {{ o.nearest_customer_m }} m
                          @if (o.whitespace_score != null) { · score {{ o.whitespace_score | number: '1.0-0' }} }
                        </span>
                      </div>
                    </li>
                  }
                </ul>
              }
            </section>
          </div>
        }
      }
    </div>
  `,
  styles: [
    `
      .ro { padding: 1.25rem; max-width: 1100px; margin: 0 auto; color: var(--text, #1c1917); }
      .ro__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap; }
      .ro__back { font-size: .78rem; color: var(--text-soft, #78716c); text-decoration: none; display: inline-flex; align-items: center; gap: .3rem; }
      .ro__back:hover { color: var(--action, #ea580c); }
      .ro__title { font-size: 1.5rem; font-weight: 700; margin: .25rem 0 0; }
      .ro__sub { margin: .2rem 0 0; color: var(--text-soft, #78716c); font-size: .85rem; }
      .ro__pick { min-width: 15rem; }
      .card { background: var(--card-bg, #fff); border: 1px solid var(--border-color, #e7e5e4); border-radius: var(--radius, 12px); padding: 1rem 1.1rem; margin-bottom: 1rem; }
      .card__title { font-size: .95rem; font-weight: 600; margin: 0 0 .6rem; }
      .empty { color: var(--text-soft, #78716c); font-size: .88rem; margin: .25rem 0; }
      .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: .75rem; margin-bottom: 1rem; }
      .kpi { background: var(--card-bg, #fff); border: 1px solid var(--border-color, #e7e5e4); border-radius: var(--radius, 12px); padding: .7rem .85rem; display: flex; flex-direction: column; gap: .25rem; }
      .kpi__l { font-size: .72rem; color: var(--text-soft, #78716c); text-transform: uppercase; letter-spacing: .03em; }
      .kpi__v { font-size: 1.35rem; font-weight: 700; font-variant-numeric: tabular-nums; }
      .kpi__v--ok { color: var(--ok, #16a34a); }
      .legend { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: .6rem; }
      .lg { display: inline-flex; align-items: center; gap: .4rem; font-size: .76rem; font-weight: 600; padding: .3rem .6rem; border-radius: 999px; border: 1px solid var(--border-color, #e7e5e4); background: var(--card-bg, #fff); color: var(--text, #44403c); cursor: pointer; }
      .lg--off { opacity: .4; }
      .sw { width: .9rem; height: .9rem; border-radius: 3px; flex: 0 0 auto; }
      .sw--cur { background: #9ca3af; }
      .sw--prop { background: var(--ok, #16a34a); }
      .sw--opp { background: var(--warn, #d97706); border-radius: 50%; }
      .map-card { padding: .4rem; }
      .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
      .stops { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
      .stop { display: flex; align-items: center; gap: .6rem; padding: .4rem 0; border-bottom: 1px solid var(--border-color, #f0efed); font-size: .86rem; }
      .stop:last-child { border-bottom: none; }
      .stop__seq { flex: 0 0 auto; width: 1.5rem; height: 1.5rem; border-radius: 50%; background: var(--ok, #16a34a); color: #fff; font-weight: 700; font-size: .72rem; display: inline-flex; align-items: center; justify-content: center; }
      .stop__name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .stop__was { flex: 0 0 auto; font-size: .68rem; color: var(--text-soft, #a8a29e); }
      .stop__was--up { color: var(--ok, #16a34a); }
      .stop__was--down { color: var(--bad, #dc2626); }
      .opps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
      .opp { display: flex; align-items: center; gap: .55rem; padding: .4rem 0; border-bottom: 1px solid var(--border-color, #f0efed); }
      .opp:last-child { border-bottom: none; }
      .opp__dot { flex: 0 0 auto; width: .7rem; height: .7rem; border-radius: 50%; background: var(--warn, #d97706); }
      .opp__body { display: flex; flex-direction: column; gap: .05rem; min-width: 0; }
      .opp__name { font-weight: 600; font-size: .86rem; }
      .opp__meta { font-size: .76rem; color: var(--text-soft, #78716c); }
      .mb-3 { margin-bottom: .75rem; }
      @media (max-width: 760px) { .kpis { grid-template-columns: repeat(2, 1fr); } .grid2 { grid-template-columns: 1fr; } }
    `,
  ],
})
export class RouteOptimizationComponent implements OnInit {
  private readonly api = inject(SupervisorAiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly routes = signal<RouteOptRow[]>([]);
  readonly detail = signal<RouteOptDetail | null>(null);
  selected: string | null = null;

  readonly showCurrent = signal(true);
  readonly showProposed = signal(true);
  readonly showOpp = signal(true);

  readonly routeOptions = computed(() =>
    this.routes().map((r) => ({
      value: r.sales_route,
      label: `${r.sales_route} · ${r.improvement_pct > 0 ? '−' + r.improvement_pct + '% km' : 'ya óptima'}${
        r.has_action ? ' · sugerida' : ''
      }`,
    })),
  );

  /** Capas del mapa: línea gris (hoy) + línea verde numerada (óptima) + pines de oportunidad. */
  readonly layers = computed<MapLayer[]>(() => {
    const d = this.detail();
    if (!d) return [];
    const coords = (arr: { lat: number | null; lng: number | null }[]) =>
      arr.filter((s) => s.lat != null && s.lng != null).map((s) => ({ lat: s.lat as number, lng: s.lng as number }));
    return [
      {
        id: 'current',
        label: 'Como es hoy',
        visible: this.showCurrent(),
        tracks: [{ points: coords(d.current), color: '#9ca3af' }],
      },
      {
        id: 'proposed',
        label: 'Como debería',
        visible: this.showProposed(),
        tracks: [{ points: coords(d.proposed), color: 'var(--ok, #16a34a)' }],
        markers: d.proposed
          .filter((s) => s.lat != null && s.lng != null)
          .map((s) => ({
            lat: s.lat as number,
            lng: s.lng as number,
            seq: s.seq,
            color: 'var(--ok, #16a34a)',
            title: `<b>#${s.seq}</b> ${s.name}`,
          })),
      },
      {
        id: 'opp',
        label: 'Oportunidades',
        visible: this.showOpp(),
        markers: d.opportunities.map((o) => ({
          lat: o.lat,
          lng: o.lng,
          kind: 'pin' as const,
          color: 'var(--warn, #d97706)',
          title: `<b>${o.name || 'PdV'}</b><br>${o.scian_label || 'PdV'} · a ${o.nearest_customer_m} m${
            o.whitespace_score != null ? '<br>score ' + Math.round(o.whitespace_score) : ''
          }`,
        })),
      },
    ];
  });

  private prevSeqMap = new Map<string, number>();
  prevSeq(id: string): number | null {
    return this.prevSeqMap.get(id) ?? null;
  }

  ngOnInit(): void {
    this.api
      .routeOptimizations()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.routes.set(r.routes ?? []);
          this.loading.set(false);
          const first = r.routes?.[0];
          if (first) {
            this.selected = first.sales_route;
            this.loadDetail(first.sales_route);
          }
        },
        error: () => this.loading.set(false),
      });
  }

  loadDetail(salesRoute: string): void {
    if (!salesRoute) return;
    this.api
      .routeOptimizationDetail(salesRoute)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => {
          this.prevSeqMap = new Map(d.current.map((s) => [s.id, s.seq]));
          this.detail.set(d);
        },
      });
  }
}
