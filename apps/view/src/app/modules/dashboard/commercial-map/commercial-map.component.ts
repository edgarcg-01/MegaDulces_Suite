import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SkeletonModule } from 'primeng/skeleton';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { ButtonModule } from 'primeng/button';
import { DatePickerModule } from 'primeng/datepicker';
import { DialogModule } from 'primeng/dialog';
import { MapComponent, MapMarker } from '../../../shared/components/map/map.component';
import { environment } from '../../../../environments/environment';
import {
  CommercialMapService,
  HistoryVisit,
  MapStore,
  Presence,
  ProductPresence,
  StoreHistory,
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
    MapComponent,
  ],
  templateUrl: './commercial-map.component.html',
  styleUrl: './commercial-map.component.css',
})
export class CommercialMapComponent implements OnInit {
  private readonly service = inject(CommercialMapService);

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

  // Superbuscador de productos.
  readonly productQuery = signal('');
  readonly smartSearch = signal(false);
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
    if (m.id) this.selectStore(String(m.id));
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
  }

  closeDetail(): void {
    this.selectedId.set(null);
    this.detail.set(null);
  }

  /**
   * Superbuscador: si "inteligente" está ON, interpreta el texto vía matcher IA
   * (Voyage) → product_ids → presencia; si la IA no da match o falla, cae a
   * contains (ILIKE) sin romper. OFF = contains directo.
   */
  runProductSearch(): void {
    const q = this.productQuery().trim();
    if (q.length < 2) return;
    this.selectedId.set(null);
    this.searching.set(true);
    const dates = this.resolvePeriodDates();
    const contains = () =>
      this.service.productPresence({ q, ...dates }).subscribe({
        next: (r) => this.applySearchResult(r),
        error: () => this.searching.set(false),
      });

    if (this.smartSearch()) {
      this.service.aiMatch(q).subscribe({
        next: (res) => {
          const ids = this.collectAiIds(res);
          if (ids.length === 0) {
            contains();
            return;
          }
          this.service.productPresence({ product_ids: ids, ...dates }).subscribe({
            next: (r) => this.applySearchResult(r),
            error: () => contains(),
          });
        },
        error: () => contains(),
      });
    } else {
      contains();
    }
  }

  clearProductSearch(): void {
    this.productQuery.set('');
    this.searchActive.set(false);
    this.searchResult.set(null);
    this.selectedId.set(null);
  }

  private applySearchResult(r: ProductPresence): void {
    this.searchResult.set(r);
    this.searchActive.set(true);
    this.searching.set(false);
  }

  /** product_ids de las sugerencias IA con confianza alta/media + alternativas. */
  private collectAiIds(res: { items?: any[] } | null): string[] {
    const ids = new Set<string>();
    for (const it of res?.items ?? []) {
      const s = it?.suggested;
      if (s?.product_id && (s.confidence === 'high' || s.confidence === 'medium')) {
        ids.add(s.product_id);
      }
      for (const alt of it?.alternatives ?? []) {
        if (alt?.product_id) ids.add(alt.product_id);
      }
    }
    return [...ids];
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
    return d.toLocaleDateString('en-CA');
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
