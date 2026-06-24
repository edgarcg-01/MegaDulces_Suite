import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SkeletonModule } from 'primeng/skeleton';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { ButtonModule } from 'primeng/button';
import { DatePickerModule } from 'primeng/datepicker';
import { DialogModule } from 'primeng/dialog';
import { AutoCompleteModule } from 'primeng/autocomplete';
import { MapComponent, MapLayer, MapMarker } from '../../../shared/components/map/map.component';
import { MapLegendComponent, LegendLayer } from '../../../shared/components/map-legend/map-legend.component';
import { MapLiveLayerService } from '../../../core/services/map-live-layer.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { environment } from '../../../../environments/environment';
import {
  CommercialMapService,
  HistoryVisit,
  MapStore,
  Presence,
  Prospect,
  ProductOption,
  ProductPresence,
  StoreHistory,
  StoreTopProducts,
} from './commercial-map.service';

type PresenceFilter = 'any' | 'own' | 'competitor' | 'both';
type Period = 'todo' | 'hoy' | 'semana' | 'mes' | 'custom';

/**
 * Mapa Comercial: tiendas geolocalizadas con exhibidores Mega Dulces vs
 * competencia (flag `perteneceMegaDulces` de las capturas). Click en tienda →
 * historial de visitas/exhibiciones separado propio vs competencia.
 * Superficie Operations (DESIGN.md): denso, master-detail, sin Fraunces.
 * Filtros de presencia/zona/búsqueda son client-side; el rango de fechas
 * recarga del server (afecta la agregación). Gateado por COMMERCIAL_MAP_VER.
 */
@Component({
  selector: 'app-commercial-map',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    SkeletonModule,
    TagModule,
    SelectModule,
    ButtonModule,
    DatePickerModule,
    DialogModule,
    AutoCompleteModule,
    MapComponent,
    MapLegendComponent,
  ],
  templateUrl: './commercial-map.component.html',
  styleUrl: './commercial-map.component.css',
  providers: [MapLiveLayerService],
})
export class CommercialMapComponent implements OnInit, OnDestroy {
  private readonly service = inject(CommercialMapService);
  protected readonly live = inject(MapLiveLayerService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  /** Capa "Personal en vivo": superpone vendedores en tiempo real sobre las tiendas. */
  readonly showLive = signal(false);
  private liveStarted = false;
  readonly canSeeLive = computed(
    () =>
      this.perms.can('read', 'routes_analytics' as any) ||
      this.auth.user()?.permissions?.[Permission.RUTAS_VER] === true,
  );
  /** Capa "Tiendas de oportunidad": PdV reales (DENUE) que aún no son clientes. */
  readonly showProspects = signal(false);
  private prospectsLoaded = false;
  readonly prospects = signal<Prospect[]>([]);
  readonly loadingProspects = signal(false);
  readonly ingesting = signal(false);
  readonly selectedProspect = signal<Prospect | null>(null);
  readonly showProspectDialog = signal(false);
  readonly canSeeProspects = computed(
    () =>
      this.perms.can('read', 'commercial_map_prospects' as any) ||
      this.auth.user()?.permissions?.[Permission.COMMERCIAL_MAP_PROSPECTS_VER] === true,
  );
  readonly canManageProspects = computed(
    () =>
      this.perms.can('create', 'commercial_map_prospects' as any) ||
      this.auth.user()?.permissions?.[Permission.COMMERCIAL_MAP_PROSPECTS_GESTIONAR] === true,
  );

  readonly mapToolsLegend = computed<LegendLayer[]>(() => {
    const out: LegendLayer[] = [];
    if (this.canSeeLive())
      out.push({ id: 'live', label: 'Personal en vivo', color: 'var(--ok-fg, #16a34a)', count: this.live.counts().total, visible: this.showLive() });
    if (this.canSeeProspects())
      out.push({ id: 'prospects', label: 'Tiendas de oportunidad', color: 'var(--action)', count: this.prospects().length, visible: this.showProspects() });
    return out;
  });

  readonly mapLayers = computed<MapLayer[]>(() => {
    const layers: MapLayer[] = [];
    if (this.showLive())
      layers.push({ id: 'live', persistent: true, visible: true, markers: this.live.markers() });
    if (this.showProspects())
      layers.push({
        id: 'prospects',
        visible: true,
        markers: this.prospects()
          .filter((p) => p.lat != null && p.lng != null)
          .map((p) => ({
            id: `prospect:${p.id}`,
            lat: p.lat as number,
            lng: p.lng as number,
            color: 'var(--action)',
            ring: true,
            kind: 'pin' as const,
            title: p.nombre,
          })),
      });
    return layers;
  });

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly stores = signal<MapStore[]>([]);
  readonly unlocatedCount = signal(0);

  readonly period = signal<Period>('todo');
  readonly customRange = signal<Date[]>([]);
  readonly presence = signal<PresenceFilter>('any');
  readonly zonaFilter = signal<string | null>(null);
  readonly search = signal('');

  readonly selectedId = signal<string | null>(null);
  readonly detail = signal<StoreHistory | null>(null);
  readonly loadingDetail = signal(false);

  readonly topProducts = signal<StoreTopProducts | null>(null);
  readonly loadingTopProducts = signal(false);

  readonly selectedVisit = signal<HistoryVisit | null>(null);
  readonly showVisitDialog = signal(false);
  readonly visitDialogTitle = computed(() => {
    const v = this.selectedVisit();
    return v ? `Visita · ${v.fecha ?? ''}` : 'Visita';
  });
  readonly storeName = computed(() => this.detail()?.store?.nombre ?? '');
  readonly storeRuta = computed(() => this.detail()?.store?.ruta ?? '');

  readonly showImagePreview = signal(false);
  readonly previewImageUrl = signal('');

  // Superbuscador de productos (autocomplete: elegí UN producto).
  // ngModel two-way a un campo plano (no signal) para no pisar lo tecleado.
  acModel: ProductOption | null = null;
  readonly productSuggestions = signal<ProductOption[]>([]);
  readonly searching = signal(false);
  readonly searchActive = signal(false);
  readonly searchResult = signal<ProductPresence | null>(null);

  readonly presenceOptions: { label: string; value: PresenceFilter }[] = [
    { label: 'Todas', value: 'any' },
    { label: 'Mega Dulces', value: 'own' },
    { label: 'Competencia', value: 'competitor' },
    { label: 'Ambas', value: 'both' },
  ];

  readonly periodOptions: { label: string; value: Period }[] = [
    { label: 'Todo', value: 'todo' },
    { label: 'Hoy', value: 'hoy' },
    { label: 'Semana', value: 'semana' },
    { label: 'Mes', value: 'mes' },
    { label: 'Personalizado', value: 'custom' },
  ];

  readonly zonaOptions = computed(() => {
    const set = new Set<string>();
    for (const s of this.stores()) if (s.zona) set.add(s.zona);
    return [...set].sort().map((z) => ({ label: z, value: z }));
  });

  readonly filteredStores = computed(() => {
    let list = this.stores();
    const p = this.presence();
    if (p !== 'any') list = list.filter((s) => s.presence === p);
    const z = this.zonaFilter();
    if (z) list = list.filter((s) => s.zona === z);
    const q = this.search().trim().toLowerCase();
    if (q) list = list.filter((s) => s.nombre.toLowerCase().includes(q));
    return list;
  });

  readonly mapMarkers = computed<MapMarker[]>(() => {
    // Búsqueda de producto activa → solo las tiendas donde aparece (resaltadas).
    if (this.searchActive()) {
      return (this.searchResult()?.stores ?? [])
        .filter((s) => s.located)
        .map((s) => ({
          id: s.id,
          lat: s.lat as number,
          lng: s.lng as number,
          color: 'var(--action)',
          title: s.nombre,
        }));
    }
    return this.filteredStores()
      .filter((s) => s.located)
      .map((s) => ({
        id: s.id,
        lat: s.lat as number,
        lng: s.lng as number,
        color: this.presenceColor(s.presence),
        title: s.nombre,
      }));
  });

  /** Conteo por presencia sobre el set completo (para la leyenda). */
  readonly presenceCounts = computed(() => {
    const c = { own: 0, competitor: 0, both: 0, unknown: 0, none: 0 };
    for (const s of this.stores()) c[s.presence]++;
    return c;
  });

  readonly mappableCount = computed(() => this.filteredStores().filter((s) => s.located).length);

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.service
      .getStores(this.resolvePeriodDates())
      .subscribe({
        next: (res) => {
          this.stores.set(res.stores || []);
          this.unlocatedCount.set(res.unlocatedCount || 0);
          this.loading.set(false);
        },
        error: (err) => {
          this.error.set(err?.error?.message || 'No se pudo cargar el mapa.');
          this.loading.set(false);
        },
      });
  }

  onMarkerClick(m: MapMarker): void {
    if (m.kind === 'user') return; // marcador de personal en vivo, no es tienda
    const id = m.id ? String(m.id) : '';
    if (id.startsWith('prospect:')) {
      const p = this.prospects().find((x) => x.id === id.slice('prospect:'.length));
      if (p) this.openProspect(p);
      return;
    }
    if (id) this.selectStore(id);
  }

  /** Conmuta la capa de personal en vivo (arranca el stream la primera vez). */
  toggleLive(): void {
    const next = !this.showLive();
    this.showLive.set(next);
    if (next && !this.liveStarted) {
      this.liveStarted = true;
      void this.live.start();
    }
  }

  /** Router del toggle de la leyenda de capas (live / prospects). */
  onLayerToggle(id: string): void {
    if (id === 'live') this.toggleLive();
    else if (id === 'prospects') this.toggleProspects();
  }

  /** Conmuta la capa de prospectos (carga perezosa la primera vez). */
  toggleProspects(): void {
    const next = !this.showProspects();
    this.showProspects.set(next);
    if (next && !this.prospectsLoaded) this.loadProspects();
  }

  loadProspects(): void {
    this.loadingProspects.set(true);
    this.service.listProspects({ status: 'candidate' }).subscribe({
      next: (res) => {
        this.prospects.set(res.prospects || []);
        this.prospectsLoaded = true;
        this.loadingProspects.set(false);
      },
      error: () => this.loadingProspects.set(false),
    });
  }

  /** Cosecha oportunidades DENUE alrededor del centroide de las tiendas visibles. */
  ingestHere(): void {
    if (!this.canManageProspects() || this.ingesting()) return;
    const located = this.filteredStores().filter((s) => s.located);
    if (located.length === 0) return;
    const lat = located.reduce((a, s) => a + (s.lat as number), 0) / located.length;
    const lng = located.reduce((a, s) => a + (s.lng as number), 0) / located.length;
    this.ingesting.set(true);
    if (!this.showProspects()) this.showProspects.set(true);
    this.service.ingestNearby(lat, lng).subscribe({
      next: (res) => {
        this.ingesting.set(false);
        if (!res.enabled) {
          this.error.set('DENUE no está configurado (falta DENUE_TOKEN en el servidor).');
          return;
        }
        this.loadProspects();
      },
      error: (err) => {
        this.ingesting.set(false);
        this.error.set(err?.error?.message || 'No se pudo cosechar de DENUE.');
      },
    });
  }

  openProspect(p: Prospect): void {
    this.selectedProspect.set(p);
    this.showProspectDialog.set(true);
  }

  closeProspect(): void {
    this.showProspectDialog.set(false);
    this.selectedProspect.set(null);
  }

  dismissProspect(p: Prospect): void {
    this.service.dismissProspect(p.id).subscribe({
      next: () => {
        this.prospects.set(this.prospects().filter((x) => x.id !== p.id));
        this.closeProspect();
      },
    });
  }

  ngOnDestroy(): void {
    if (this.liveStarted) { this.live.watch([]); this.live.stop(); }
  }

  selectStore(id: string): void {
    this.selectedId.set(id);
    this.detail.set(null);
    this.loadingDetail.set(true);
    this.service
      .getStoreHistory(id, this.resolvePeriodDates())
      .subscribe({
        next: (res) => {
          this.detail.set(res);
          this.loadingDetail.set(false);
        },
        error: () => {
          this.loadingDetail.set(false);
        },
      });
    // Productos más pedidos por la tienda (motor Thot) — independiente del período.
    this.topProducts.set(null);
    this.loadingTopProducts.set(true);
    this.service.getStoreTopProducts(id).subscribe({
      next: (res) => {
        this.topProducts.set(res);
        this.loadingTopProducts.set(false);
      },
      error: () => this.loadingTopProducts.set(false),
    });
  }

  closeDetail(): void {
    this.selectedId.set(null);
    this.detail.set(null);
    this.topProducts.set(null);
  }

  /**
   * Autocomplete del superbuscador (siempre inteligente): contains instantáneo;
   * si no hay match literal, interpreta con el matcher IA (Voyage). Muestra las
   * opciones para elegir UN producto.
   */
  completeProducts(event: { query: string }): void {
    const q = (event?.query || '').trim();
    if (q.length < 2) {
      this.productSuggestions.set([]);
      return;
    }
    this.service.productSearch(q).subscribe({
      next: (opts) => {
        if (opts.length > 0) {
          this.productSuggestions.set(opts);
          return;
        }
        // Sin match literal → interpretar con IA (best-effort).
        this.service.aiMatch(q).subscribe({
          next: (res) => this.productSuggestions.set(this.aiToOptions(res)),
          error: () => this.productSuggestions.set([]),
        });
      },
      error: () => this.productSuggestions.set([]),
    });
  }

  /** Al elegir un producto → presencia (tiendas + visitas donde aparece). */
  onProductSelected(event: { value?: ProductOption } | ProductOption): void {
    const p = (event as { value?: ProductOption })?.value ?? (event as ProductOption);
    if (!p?.id) return;
    this.acModel = p;
    this.selectedId.set(null);
    this.searching.set(true);
    this.service
      .productPresence({ product_ids: [p.id], ...this.resolvePeriodDates() })
      .subscribe({
        next: (r) => this.applySearchResult(r),
        error: () => this.searching.set(false),
      });
  }

  clearProductSearch(): void {
    this.acModel = null;
    this.productSuggestions.set([]);
    this.searchActive.set(false);
    this.searchResult.set(null);
    this.selectedId.set(null);
  }

  private applySearchResult(r: ProductPresence): void {
    this.searchResult.set(r);
    this.searchActive.set(true);
    this.searching.set(false);
  }

  /** Sugerencias del matcher IA → opciones de producto (suggested + alternativas). */
  private aiToOptions(res: {
    items?: Array<{
      suggested?: { product_id: string; product_name?: string; brand_name?: string } | null;
      alternatives?: Array<{ product_id: string; product_name?: string; brand_name?: string }>;
    }>;
  } | null): ProductOption[] {
    const seen = new Set<string>();
    const out: ProductOption[] = [];
    const push = (m?: { product_id: string; product_name?: string; brand_name?: string } | null) => {
      if (!m?.product_id || seen.has(m.product_id)) return;
      seen.add(m.product_id);
      out.push({ id: m.product_id, nombre: m.product_name || 'Producto', sku: '', brand_name: m.brand_name || '' });
    };
    for (const it of res?.items ?? []) {
      push(it?.suggested);
      for (const alt of it?.alternatives ?? []) push(alt);
    }
    return out;
  }

  /** Abre una ventana (dialog) con la descripción completa de la visita (como Seguimiento). */
  openVisit(v: HistoryVisit): void {
    this.selectedVisit.set(v);
    this.showVisitDialog.set(true);
  }

  closeVisit(): void {
    this.showVisitDialog.set(false);
    this.selectedVisit.set(null);
  }

  /** Abre la foto de exhibición ampliada en un lightbox (como en Seguimiento). */
  openImagePreview(url: unknown): void {
    const safe = this.getImageUrl(url);
    if (!safe) return;
    this.previewImageUrl.set(safe);
    this.showImagePreview.set(true);
  }

  closeImagePreview(): void {
    this.showImagePreview.set(false);
    this.previewImageUrl.set('');
  }

  /** Resuelve la URL: acepta http(s) absoluta o path relativo del backend; bloquea esquemas peligrosos. */
  getImageUrl(url: unknown): string {
    if (typeof url !== 'string' || !url.trim()) return '';
    const trimmed = url.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return '';
    return `${environment.apiUrl}/${trimmed.replace(/^\/+/, '')}`;
  }

  /** Selección de período: setea el signal y recarga (salvo 'custom', que espera al datepicker). */
  onPeriodSelected(p: Period): void {
    this.period.set(p);
    if (p !== 'custom') this.reload();
  }

  /** Rango personalizado: recarga solo cuando ambas fechas están elegidas. */
  onCustomRange(range: Date[]): void {
    this.customRange.set(range || []);
    if (range?.[0] && range?.[1]) this.reload();
  }

  /** Recarga lista + detalle abierto con el período actual. */
  private reload(): void {
    this.load();
    const id = this.selectedId();
    if (id) this.selectStore(id);
  }

  /** Período → rango YYYY-MM-DD (TZ local, como /reports). 'todo' = sin filtro. */
  private resolvePeriodDates(): { date_from?: string; date_to?: string } {
    const p = this.period();
    if (p === 'todo') return {};
    if (p === 'custom') {
      const r = this.customRange();
      return r?.[0] && r?.[1]
        ? { date_from: this.fmtDate(r[0]), date_to: this.fmtDate(r[1]) }
        : {};
    }
    const offset = p === 'hoy' ? 0 : p === 'semana' ? -7 : -30;
    return { date_from: this.dateOffset(offset), date_to: this.dateOffset(0) };
  }

  private fmtDate(d: Date): string {
    return d.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  }

  private dateOffset(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return this.fmtDate(d);
  }

  presenceColor(p: Presence): string {
    switch (p) {
      case 'own':
        return 'var(--ok-fg)';
      case 'competitor':
        return 'var(--bad-fg)';
      case 'both':
        return 'var(--warn-fg)';
      case 'unknown':
        return 'var(--info-fg)';
      default:
        return 'var(--neutral-400)';
    }
  }

  presenceLabel(p: Presence): string {
    switch (p) {
      case 'own':
        return 'Mega Dulces';
      case 'competitor':
        return 'Competencia';
      case 'both':
        return 'Ambas';
      case 'unknown':
        return 'Sin clasificar';
      default:
        return 'Sin visitar';
    }
  }

}
