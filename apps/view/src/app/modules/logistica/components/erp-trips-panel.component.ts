import { ChangeDetectionStrategy, Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';
import { TooltipModule } from 'primeng/tooltip';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { MapComponent, MapMarker } from '../../../shared/components/map/map.component';
import { environment } from '../../../../environments/environment';

/**
 * EMB — Los embarques REALES del ERP dentro de la pantalla de Embarques.
 *
 * Grano: el **viaje** (la guía de embarque de Kepler), no el documento suelto. Está medido:
 * ~2,500 guías agrupan ~5,700 embarques, hasta 32 paradas en una, y 386 de las 388 guías
 * multiparada llevan una sola unidad. Listar documentos mostraría 32 renglones de lo que fue
 * un camión saliendo una vez.
 *
 * ── ⛔ LO QUE ESTA PANTALLA NO AFIRMA ────────────────────────────────────────────────────
 * Kepler NO dice si la entrega llegó: `estatus` vale `EMBARCADO` en el 100% de los documentos,
 * y no hay hora ni acuse. Por eso acá no hay semáforo entregado/pendiente — sería dibujado.
 * Lo que sí se sabe y se muestra es **"en la calle"** (el viaje salió hoy), que es justo el
 * caso en el que el mapa en vivo sirve para algo.
 *
 * Y el mapa **declara su cobertura**: pintar 3 de 8 camiones sin decirlo hace creer que los
 * otros 5 no salieron. Cuando una unidad no es ubicable, la fila dice por qué (no tiene
 * rastreador / no está en la flota de la Suite), que son dos huecos distintos.
 */
@Component({
  selector: 'app-erp-trips-panel',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, TagModule,
    SkeletonModule, TooltipModule, InputTextModule, SelectModule, MapComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- KPI del día -->
    @if (kpis(); as k) {
      <div class="sheet cols-12">
        <article class="cell cell-span-3">
          <span class="cell-icon" aria-hidden="true"><i class="pi pi-send"></i></span>
          <span class="cell-label">Viajes hoy</span>
          <span class="cell-value is-headline">{{ k.viajes }}</span>
          <span class="cell-sub">{{ k.paradas }} parada{{ k.paradas === 1 ? '' : 's' }}</span>
        </article>
        <article class="cell cell-span-3">
          <span class="cell-icon" aria-hidden="true"><i class="pi pi-truck"></i></span>
          <span class="cell-label">Unidades en la calle</span>
          <span class="cell-value">{{ k.unidades }}</span>
          <span class="cell-sub">según el ERP</span>
        </article>
        <article class="cell cell-span-3">
          <span class="cell-icon" aria-hidden="true"><i class="pi pi-map-marker"></i></span>
          <span class="cell-label">Con rastreo</span>
          <span class="cell-value" [class.is-warn]="k.unidades_con_gps < k.unidades">
            {{ k.unidades_con_gps }} <span class="et-of">de {{ k.unidades }}</span>
          </span>
          <span class="cell-sub">
            @if (k.unidades_con_gps < k.unidades) { faltan {{ k.unidades - k.unidades_con_gps }} sin GPS }
            @else { todas ubicables }
          </span>
        </article>
        <article class="cell cell-span-3">
          <span class="cell-icon" aria-hidden="true"><i class="pi pi-dollar"></i></span>
          <span class="cell-label">Valor embarcado hoy</span>
          <span class="cell-value">{{ money(k.valor) }}</span>
          <span class="cell-sub">suma de los viajes del día</span>
        </article>
      </div>
    }

    <!-- MAPA EN VIVO — sólo cuando hay algo en la calle -->
    @if (live().length > 0) {
      <div class="sheet cols-12">
        <article class="cell cell-span-12 is-flush">
          <header class="et-maphead">
            <div>
              <h2 class="et-maptitle"><i class="pi pi-map" aria-hidden="true"></i> En la calle ahora</h2>
              <p class="et-mapsub">
                <b>{{ liveUbicables().length }}</b> de <b>{{ live().length }}</b> viaje{{ live().length === 1 ? '' : 's' }} de hoy se pueden ubicar.
                @if (liveUbicables().length < live().length) {
                  <span class="et-warn">
                    <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                    {{ live().length - liveUbicables().length }} sin rastreador — salieron, pero no se ven en el mapa.
                  </span>
                }
              </p>
            </div>
            <div class="et-mapactions">
              <span class="et-asof" *ngIf="lastRefresh()">actualizado {{ lastRefresh() }}</span>
              <button pButton size="small" [text]="true" severity="secondary" (click)="refreshLive()" [loading]="loadingLive()" pTooltip="Refrescar posiciones">
                <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
              </button>
            </div>
          </header>
          @if (!mapsEnabled) {
            <p class="et-empty">El mapa necesita el token de mapas configurado en el entorno.</p>
          } @else {
            <app-map
              [markers]="mapMarkers()"
              [path]="selectedTrack()"
              height="360px"
              autoFit="once"
              (markerClick)="onMarkerClick($event)"></app-map>
          }
        </article>
      </div>
    }

    <!-- FILTROS -->
    <div class="et-filters">
      <div class="et-segment" role="tablist" aria-label="Rango">
        <button type="button" role="tab" [attr.aria-selected]="soloHoy()" [class.act]="soloHoy()" (click)="setSoloHoy(true)">Hoy</button>
        <button type="button" role="tab" [attr.aria-selected]="!soloHoy()" [class.act]="!soloHoy()" (click)="setSoloHoy(false)">Últimos 30 días</button>
      </div>
      <p-select [options]="sucursales" [(ngModel)]="sucursal" optionLabel="label" optionValue="value"
                (onChange)="reload()" placeholder="Sucursal" [showClear]="true" styleClass="et-select"></p-select>
      <span class="et-search">
        <i class="pi pi-search" aria-hidden="true"></i>
        <input pInputText type="search" [(ngModel)]="search" (keyup.enter)="reload()"
               placeholder="Guía, placa, chofer o unidad" aria-label="Buscar viaje" />
      </span>
      <button pButton size="small" [text]="true" severity="secondary" (click)="reload()" [loading]="loading()">
        <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
      </button>
    </div>

    <!-- MASTER: viajes -->
    <div class="et-split">
      <section class="et-master" aria-label="Viajes del ERP">
        @if (loading()) {
          <p-skeleton height="220px"></p-skeleton>
        } @else if (trips().length === 0) {
          <p class="et-empty">No hay viajes en este rango.</p>
        } @else {
          <p-table [value]="trips()" [scrollable]="true" scrollHeight="460px" styleClass="p-datatable-sm et-table"
                   selectionMode="single" [(selection)]="selected" (selectionChange)="openTrip($event)" dataKey="guia_digital">
            <ng-template pTemplate="header">
              <tr>
                <th>Guía</th><th>Fecha</th><th class="num">Paradas</th>
                <th>Unidad</th><th>Chofer</th><th>Dónde está</th><th class="num">Valor</th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-t>
              <tr [pSelectableRow]="t" [class.et-row-hoy]="t.en_calle">
                <td><code class="et-code">{{ t.guia_digital }}</code></td>
                <td>{{ t.fecha | date: 'dd MMM' }}</td>
                <td class="num"><b>{{ t.paradas }}</b></td>
                <td>
                  <span class="et-unit">{{ t.transporte_descripcion || '—' }}</span>
                  <span class="et-plate">{{ t.vehicle_plate || t.transporte_placas || 'sin placa' }}</span>
                </td>
                <td>{{ t.chofer_nombre || '—' }}</td>
                <td>
                  @if (t.gps_status) {
                    <p-tag [value]="gpsLabel(t.gps_status)" [severity]="gpsSeverity(t.gps_status)"></p-tag>
                  } @else {
                    <span class="et-nogps" pTooltip="Esa unidad no tiene rastreador dado de alta. No es que no haya salido.">
                      <i class="pi pi-minus-circle" aria-hidden="true"></i> sin rastreo
                    </span>
                  }
                </td>
                <td class="num">{{ money(t.total) }}</td>
              </tr>
            </ng-template>
          </p-table>
          <p class="et-foot">
            {{ total() }} viaje{{ total() === 1 ? '' : 's' }} · fuente: documento de embarque del ERP (U-D-41), en vivo.
            <b>Kepler no confirma la entrega</b>, sólo la salida.
          </p>
        }
      </section>

      <!-- DETAIL: paradas + qué lleva -->
      <aside class="et-detail" aria-label="Detalle del viaje">
        @if (!detail()) {
          <p class="et-empty"><i class="pi pi-arrow-left" aria-hidden="true"></i> Elegí un viaje para ver sus paradas y qué lleva.</p>
        } @else if (loadingDetail()) {
          <p-skeleton height="320px"></p-skeleton>
        } @else {
          <header class="et-dhead">
            <div>
              <h3>{{ detail()!.trip.guia_digital }}</h3>
              <p class="et-dsub">
                {{ detail()!.trip.paradas }} parada{{ detail()!.trip.paradas === 1 ? '' : 's' }}
                · {{ detail()!.trip.transporte_descripcion }}
                · {{ detail()!.trip.chofer_nombre || 'sin chofer capturado' }}
              </p>
            </div>
            <span class="et-dtotal">{{ money(detail()!.trip.total) }}</span>
          </header>

          @if (!detail()!.rastreo_disponible) {
            <p class="et-note">
              <i class="pi pi-info-circle" aria-hidden="true"></i>
              Sin recorrido: {{ detail()!.rastreo_motivo }}.
            </p>
          }

          <ul class="et-stops">
            @for (p of detail()!.paradas; track p.folio_digital) {
              <li [class.act]="openStop() === p.folio_digital">
                <button type="button" class="et-stop" (click)="toggleStop(p)">
                  <span class="et-stopmain">
                    <span class="et-stopname">{{ p.destino_nombre || p.cliente_code }}</span>
                    <span class="et-stopmeta">{{ p.destino_ciudad || '' }} · {{ p.serie_label }}</span>
                  </span>
                  <span class="et-stopval">{{ money(p.total) }}</span>
                  <i class="pi" [class.pi-chevron-down]="openStop() !== p.folio_digital" [class.pi-chevron-up]="openStop() === p.folio_digital" aria-hidden="true"></i>
                </button>
                @if (openStop() === p.folio_digital) {
                  <div class="et-lines">
                    @if (loadingLines()) {
                      <p-skeleton height="90px"></p-skeleton>
                    } @else {
                      <p class="et-linesmeta">
                        Pedido <code>{{ p.pedido_folio_digital || p.pedido_folio || '—' }}</code>
                        · {{ lines().length }} renglón{{ lines().length === 1 ? '' : 'es' }}
                      </p>
                      <table class="et-linetable">
                        <thead><tr><th>Producto</th><th class="num">Cant.</th><th class="num">Cajas</th><th class="num">Importe</th></tr></thead>
                        <tbody>
                          @for (l of lines(); track l.nro_linea) {
                            <tr>
                              <td><span class="et-sku">{{ l.sku }}</span> {{ l.descripcion }}</td>
                              <td class="num">{{ l.cantidad }} <span class="et-uom">{{ l.unidad }}</span></td>
                              <td class="num">
                                @if (l.cajas !== null) {
                                  {{ l.cajas }} <span class="et-uom">{{ l.caja_label || 'CJA' }}</span>
                                } @else {
                                  <span class="et-uom" pTooltip="El resolvedor de unidad no cubre este SKU en esta sucursal. No es cero.">sin resolver</span>
                                }
                              </td>
                              <td class="num">{{ money(l.importe) }}</td>
                            </tr>
                          }
                        </tbody>
                      </table>
                      @if (p.comentarios) {
                        <p class="et-comment"><i class="pi pi-comment" aria-hidden="true"></i> {{ p.comentarios }}</p>
                      }
                    }
                  </div>
                }
              </li>
            }
          </ul>
        }
      </aside>
    </div>
  `,
  styles: [`
    :host { display:block; }
    .et-of { font-size:.7em; color:var(--text-dim,#78716c); font-weight:500; }
    .is-warn { color:var(--warn,#b45309); }

    .et-maphead { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; padding:.75rem .9rem .5rem; flex-wrap:wrap; }
    .et-maptitle { margin:0; font:700 .95rem 'Hanken Grotesk',sans-serif; display:flex; align-items:center; gap:.4rem; }
    .et-mapsub { margin:.2rem 0 0; font-size:.78rem; color:var(--text-dim,#78716c); }
    .et-warn { color:var(--warn,#b45309); margin-left:.5rem; }
    .et-mapactions { display:flex; align-items:center; gap:.5rem; }
    .et-asof { font-size:.7rem; color:var(--text-dim,#78716c); }

    .et-filters { display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; margin:.75rem 0; }
    .et-segment { display:flex; border:1px solid var(--border-color); border-radius:8px; overflow:hidden; }
    .et-segment button { border:0; background:transparent; padding:.36rem .7rem; font:600 .76rem 'Hanken Grotesk',sans-serif; color:var(--text-dim,#78716c); cursor:pointer; }
    .et-segment button + button { border-left:1px solid var(--border-color); }
    .et-segment button.act { background:var(--action,#F05A28); color:#fff; }
    .et-search { position:relative; display:inline-flex; align-items:center; }
    .et-search i { position:absolute; left:.5rem; font-size:.78rem; color:var(--text-dim,#78716c); }
    .et-search input { padding-left:1.7rem; min-width:16rem; }

    .et-split { display:grid; grid-template-columns:minmax(0,1.35fr) minmax(0,1fr); gap:1rem; align-items:start; }
    @media (max-width:1100px) { .et-split { grid-template-columns:1fr; } }
    .et-master, .et-detail { background:var(--card-bg,#fff); border:1px solid var(--border-color); border-radius:10px; padding:.6rem; }
    .et-table .num, th.num, td.num { text-align:right; font-variant-numeric:tabular-nums; }
    .et-code { font:600 .74rem 'Geist Mono',monospace; }
    .et-unit { display:block; font-size:.78rem; }
    .et-plate { display:block; font:600 .68rem 'Geist Mono',monospace; color:var(--text-dim,#78716c); }
    .et-nogps { display:inline-flex; align-items:center; gap:.25rem; font-size:.72rem; color:var(--text-dim,#78716c); }
    .et-row-hoy td:first-child { box-shadow:inset 3px 0 0 var(--action,#F05A28); }
    .et-foot, .et-empty { font-size:.74rem; color:var(--text-dim,#78716c); padding:.5rem .3rem 0; }
    .et-empty { text-align:center; padding:2rem .5rem; }

    .et-dhead { display:flex; justify-content:space-between; align-items:flex-start; gap:.75rem; padding:.2rem .3rem .6rem; border-bottom:1px solid var(--border-color); }
    .et-dhead h3 { margin:0; font:700 .9rem 'Hanken Grotesk',sans-serif; }
    .et-dsub { margin:.15rem 0 0; font-size:.74rem; color:var(--text-dim,#78716c); }
    .et-dtotal { font:700 .95rem 'Hanken Grotesk',sans-serif; font-variant-numeric:tabular-nums; }
    .et-note { display:flex; gap:.4rem; align-items:flex-start; font-size:.74rem; color:var(--text-dim,#78716c); background:var(--surface-2,#fafaf9); border-radius:6px; padding:.45rem .55rem; margin:.5rem 0 0; }

    .et-stops { list-style:none; margin:.5rem 0 0; padding:0; }
    .et-stops li { border-bottom:1px solid var(--border-color); }
    .et-stop { width:100%; display:flex; align-items:center; gap:.6rem; background:transparent; border:0; padding:.5rem .3rem; cursor:pointer; text-align:left; }
    .et-stop:hover { background:var(--surface-2,#fafaf9); }
    .et-stopmain { flex:1; min-width:0; }
    .et-stopname { display:block; font:600 .78rem 'Hanken Grotesk',sans-serif; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .et-stopmeta { display:block; font-size:.68rem; color:var(--text-dim,#78716c); }
    .et-stopval { font:600 .76rem 'Hanken Grotesk',sans-serif; font-variant-numeric:tabular-nums; }
    .et-lines { padding:.2rem .3rem .7rem; }
    .et-linesmeta { font-size:.7rem; color:var(--text-dim,#78716c); margin:.1rem 0 .35rem; }
    .et-linetable { width:100%; border-collapse:collapse; font-size:.72rem; }
    .et-linetable th { text-align:left; font-weight:600; color:var(--text-dim,#78716c); border-bottom:1px solid var(--border-color); padding:.2rem .25rem; }
    .et-linetable td { padding:.22rem .25rem; border-bottom:1px solid var(--surface-2,#fafaf9); }
    .et-sku { font:600 .68rem 'Geist Mono',monospace; color:var(--text-dim,#78716c); margin-right:.3rem; }
    .et-uom { font-size:.66rem; color:var(--text-dim,#78716c); }
    .et-comment { display:flex; gap:.35rem; font-size:.7rem; color:var(--text-dim,#78716c); margin:.4rem 0 0; }
  `],
})
export class ErpTripsPanelComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly api = `${environment.apiUrl}/logistics/erp-shipments`;
  readonly mapsEnabled = !!(environment as any).mapboxToken || true;

  readonly loading = signal(false);
  readonly loadingDetail = signal(false);
  readonly loadingLines = signal(false);
  readonly loadingLive = signal(false);
  readonly trips = signal<any[]>([]);
  readonly total = signal(0);
  readonly kpis = signal<any | null>(null);
  readonly live = signal<any[]>([]);
  readonly detail = signal<any | null>(null);
  readonly lines = signal<any[]>([]);
  readonly openStop = signal<string | null>(null);
  readonly soloHoy = signal(true);
  readonly lastRefresh = signal<string | null>(null);
  selected: any = null;
  sucursal: string | null = null;
  search = '';

  readonly sucursales = [
    { label: 'Todas', value: null }, { label: '00 Oficinas', value: '00' },
    { label: '01 Padre Hidalgo', value: '01' }, { label: '02 La Piedad Abastos', value: '02' },
    { label: '03 8 Esquinas', value: '03' }, { label: '04', value: '04' },
    { label: '05', value: '05' }, { label: '06 Canindo', value: '06' },
  ];

  /** Sólo los viajes que de verdad se pueden ubicar. El resto se cuenta, no se pinta. */
  readonly liveUbicables = computed(() => this.live().filter((r) => r.lat != null && r.lng != null));

  readonly mapMarkers = computed<MapMarker[]>(() =>
    this.liveUbicables().map((r) => ({
      lat: Number(r.lat), lng: Number(r.lng),
      title: `${r.guia_digital} · ${r.placa || ''} · ${r.paradas} parada(s)`,
      id: r.guia_digital, kind: 'truck' as const,
      ring: r.status === 'moving',
    })));

  readonly selectedTrack = computed(() => {
    const d = this.detail();
    if (!d || !d.recorrido?.length) return [];
    return d.recorrido.map((p: any) => ({ lat: Number(p.lat), lng: Number(p.lng) }));
  });

  private timer: any = null;

  ngOnInit() {
    this.reload();
    this.loadKpis();
    this.refreshLive();
    // El GPS entra cada minuto (FleetPoller); refrescar más seguido sería pedirle a la
    // pantalla lo que la fuente no tiene.
    this.timer = setInterval(() => this.refreshLive(), 60_000);
  }
  ngOnDestroy() { if (this.timer) clearInterval(this.timer); }

  money(v: any) {
    const n = Number(v || 0);
    return n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
  gpsLabel(s: string) {
    return { moving: 'en movimiento', stopped: 'detenido', offline: 'fuera de línea' }[s] || 'sin dato';
  }
  gpsSeverity(s: string): any {
    return { moving: 'success', stopped: 'warn', offline: 'danger' }[s] || 'secondary';
  }

  setSoloHoy(v: boolean) { this.soloHoy.set(v); this.reload(); }

  reload() {
    this.loading.set(true);
    const p: any = { limit: '100' };
    if (this.soloHoy()) p.solo_hoy = 'true';
    if (this.sucursal) p.sucursal = this.sucursal;
    if (this.search.trim()) p.search = this.search.trim();
    this.http.get<any>(`${this.api}/trips`, { params: p }).subscribe({
      next: (r) => { this.trips.set(r.rows || []); this.total.set(r.total || 0); this.loading.set(false); },
      error: () => { this.trips.set([]); this.total.set(0); this.loading.set(false); },
    });
  }

  loadKpis() {
    this.http.get<any>(`${this.api}/today`).subscribe({ next: (r) => this.kpis.set(r), error: () => this.kpis.set(null) });
  }

  refreshLive() {
    this.loadingLive.set(true);
    this.http.get<any>(`${this.api}/live`).subscribe({
      next: (r) => {
        this.live.set(r.rows || []);
        this.lastRefresh.set(new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }));
        this.loadingLive.set(false);
      },
      error: () => { this.live.set([]); this.loadingLive.set(false); },
    });
  }

  openTrip(t: any) {
    if (!t) return;
    this.loadingDetail.set(true);
    this.openStop.set(null);
    this.lines.set([]);
    this.http.get<any>(`${this.api}/trips/${t.sucursal}/${t.guia_embarque}`).subscribe({
      next: (r) => { this.detail.set(r); this.loadingDetail.set(false); },
      error: () => { this.detail.set(null); this.loadingDetail.set(false); },
    });
  }

  onMarkerClick(m: MapMarker) {
    const t = this.trips().find((x) => x.guia_digital === m.id) || this.live().find((x) => x.guia_digital === m.id);
    if (t) { this.selected = t; this.openTrip(t); }
  }

  toggleStop(p: any) {
    if (this.openStop() === p.folio_digital) { this.openStop.set(null); return; }
    this.openStop.set(p.folio_digital);
    this.loadingLines.set(true);
    const d = this.detail();
    this.http.get<any>(`${this.api}/lines/${d.trip.sucursal}/${p.serie}/${p.folio}`).subscribe({
      next: (r) => { this.lines.set(r.rows || []); this.loadingLines.set(false); },
      error: () => { this.lines.set([]); this.loadingLines.set(false); },
    });
  }
}
