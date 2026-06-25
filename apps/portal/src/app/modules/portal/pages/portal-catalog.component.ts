import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { CommonModule, CurrencyPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  trigger,
  transition,
  style,
  animate,
  keyframes,
} from '@angular/animations';
import { forkJoin } from 'rxjs';
import {
  PortalService,
  PriceRow,
  SmartSearchResult,
  CatalogHistoryRow,
  CatalogSuggestedRow,
  CatalogWithPromoRow,
  CatalogFacets,
} from '../portal.service';
import { AuthService } from '../../../core/services/auth.service';
import { cldImage } from '../../../core/util/cloudinary';
import { brandPlaceholderGradient } from '../../../core/util/brand-placeholder';
import { PortalProductCardComponent } from '../ui/portal-product-card.component';
import { Subject } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap } from 'rxjs/operators';

interface BrandGroup {
  brand_id: string;
  brand_name: string;
  count: number;
  color: string;
  initial: string;
}

/**
 * Paleta de grises usada para los avatars/placeholders. Hash determinístico
 * sobre el id para variar levemente la luminosidad y que distintas marcas /
 * productos no queden idénticas — pero sin color saturado.
 */
const NEUTRAL_PALETTE = [
  '#3F3F46', '#52525B', '#71717A', '#27272A',
  '#404040', '#525252', '#262626', '#171717',
];

function hashColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return NEUTRAL_PALETTE[Math.abs(h) % NEUTRAL_PALETTE.length];
}

function initial(name: string): string {
  return (name || '?').trim().charAt(0).toUpperCase() || '?';
}

@Component({
  selector: 'app-portal-catalog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CurrencyPipe,
    ButtonModule,
    SkeletonModule,
    InputNumberModule,
    InputTextModule,
    TagModule,
    TooltipModule,
    PortalProductCardComponent,
  ],
  templateUrl: './portal-catalog.component.html',
  styleUrls: ['./portal-catalog.component.css'],
  animations: [
    trigger('badgePop', [
      transition(':increment', [
        animate(
          '420ms cubic-bezier(0.34, 1.4, 0.5, 1)',
          keyframes([
            style({ transform: 'scale(1)', offset: 0 }),
            style({ transform: 'scale(1.5)', offset: 0.35 }),
            style({ transform: 'scale(0.88)', offset: 0.65 }),
            style({ transform: 'scale(1)', offset: 1 }),
          ]),
        ),
      ]),
    ]),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PortalCatalogComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly api = inject(PortalService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);
  readonly cart = inject(PortalService);

  readonly isAdmin = signal<boolean>(this.auth.user()?.role_name === 'superadmin');
  readonly loading = signal(true);
  readonly prices = signal<PriceRow[]>([]);
  readonly customerName = signal<string>('');
  readonly customerId = signal<string>('');
  readonly warehouseId = signal<string>('');
  readonly selectedBrandId = signal<string>('__all__');
  readonly searchSignal = signal<string>('');
  readonly drawerOpen = signal(false);

  /**
   * Productos que el customer ya pidió (90d). Driver del chip "Reordenar".
   * Vacío para admins/superadmin (no hay customer linkeado) o clientes nuevos
   * sin historial — el chip se oculta en ese caso.
   */
  readonly historyProducts = signal<CatalogHistoryRow[]>([]);
  /**
   * Canasta IA D.4 hidratada (chip "Sugeridos IA"). Cubre a customers sin
   * historial recurrente — la heurística mezcla base + focus + exploration +
   * innovation, así que casi siempre devuelve algo si el tenant tiene ventas.
   */
  readonly suggestedProducts = signal<CatalogSuggestedRow[]>([]);
  /**
   * Productos con promoción activa (chip "Con promo"). Una promo por
   * producto (la de mayor priority cuando aplica más de una).
   */
  readonly promoProducts = signal<CatalogWithPromoRow[]>([]);
  /**
   * Atajo personalizado activo. `null` = catálogo completo + brand filter.
   */
  readonly quickFilter = signal<'reorder' | 'suggested' | 'promo' | null>(null);

  /** Vista del catálogo: grid (default) o lista densa. Persistida por usuario. */
  readonly viewMode = signal<'grid' | 'list'>(
    (typeof localStorage !== 'undefined' &&
      localStorage.getItem('portal_catalog_view') === 'list')
      ? 'list'
      : 'grid',
  );

  setViewMode(mode: 'grid' | 'list'): void {
    this.viewMode.set(mode);
    try { localStorage.setItem('portal_catalog_view', mode); } catch { /* private mode */ }
  }

  /**
   * Top sellers del tenant (MV products_top_sellers — top 1000 últimos 90d).
   * Drive del strip "Más vendidos" al inicio del catálogo. Crece con volumen
   * real de ventas — al inicio puede tener pocos rows.
   */
  readonly topSellers = signal<PriceRow[]>([]);

  /** Counts agregados del backend para drive del panel de filtros. */
  readonly facets = signal<CatalogFacets | null>(null);
  /** Panel de filtros abierto/cerrado (desktop y mobile lo comparten). */
  readonly filtersOpen = signal<boolean>(false);
  /**
   * Bucket de precio activo (uno solo) — referencia al objeto del facets para
   * que el matcheo del computed sea por identidad (max=null = "más de X").
   */
  readonly priceBucket = signal<{ min: number; max: number | null } | null>(null);
  /** Toggle "solo con stock" (requiere warehouseId, sino el filtro no aplica). */
  readonly onlyWithStock = signal<boolean>(false);
  /** Search interno dentro del panel para los 30+ brands top. */
  readonly brandPanelSearch = signal<string>('');

  /**
   * # de filtros del panel activos (excluye los quick-chips y el search top).
   * Drive del badge "Filtros (N)" cuando hay algo aplicado.
   */
  readonly activeFiltersCount = computed<number>(() => {
    let n = 0;
    if (this.selectedBrandId() !== '__all__') n++;
    if (this.priceBucket()) n++;
    if (this.onlyWithStock()) n++;
    return n;
  });

  /**
   * Render-budget: cuántos cards del grid renderizar en DOM. Antes
   * cargábamos los 7,569 cards de una → lag de scroll en mobile y CD lento.
   * Ahora: 60 iniciales + 60 por batch al scrollear cerca del fondo (via
   * IntersectionObserver sobre `#scrollSentinel`). Reset a 60 cuando cambia
   * el set visible (filtro nuevo / search / quick-chip).
   */
  /**
   * Server-side pagination — el backend filtra y pagina. `prices()` acumula
   * los resultados del fetch inicial + las páginas siguientes cargadas vía
   * IntersectionObserver. Los quick-chips (history/suggested/promo) usan
   * sus propios endpoints (sets chicos) y no pasan por aquí.
   */
  private readonly PAGE_SIZE = 60;
  readonly currentPage = signal<number>(1);
  readonly totalCount = signal<number>(0);
  readonly loadingMore = signal<boolean>(false);
  readonly hasMorePages = computed<boolean>(() => {
    if (this.quickFilter()) return false;
    return this.prices().length < this.totalCount();
  });

  private _sentinelEl?: HTMLElement;
  @ViewChild('scrollSentinel')
  set scrollSentinelRef(ref: ElementRef<HTMLElement> | undefined) {
    // Setter porque el `*ngIf` del sentinel hace que el elemento aparezca y
    // desaparezca. Reobserva siempre que cambia la referencia (o desconecta
    // si quedó null).
    if (this._sentinelEl && this.scrollObserver) {
      this.scrollObserver.unobserve(this._sentinelEl);
    }
    this._sentinelEl = ref?.nativeElement;
    if (this._sentinelEl && this.scrollObserver) {
      this.scrollObserver.observe(this._sentinelEl);
    }
  }
  private scrollObserver?: IntersectionObserver;

  constructor() {
    // Effect: cuando cambian los filtros del panel (brand / bucket / stock)
    // → reset y fetch page 1 server-side. Search NO va aquí — usa su propio
    // pipeline con debounce en wireSmartSearch para no spamear al backend.
    effect(() => {
      // Dependencias explícitas que disparan el refetch.
      this.selectedBrandId();
      this.priceBucket();
      this.onlyWithStock();
      untracked(() => {
        // Solo dispara si ya pasamos por el load inicial (`prices` no vacío
        // o totalCount seteado). Sin esto el effect corre al construir el
        // componente cuando warehouseId aún es '' y mete una request basura.
        if (this.totalCount() > 0 || this.prices().length > 0) {
          this.resetAndFetch();
        }
      });
    });
  }

  readonly aiSearch = signal(false);
  readonly searching = signal(false);
  readonly smartResults = signal<SmartSearchResult[]>([]);
  readonly smartMode = signal<'semantic' | 'fallback_like' | null>(null);
  readonly scoreById = signal<Record<string, number>>({});
  readonly searchHistory = signal<string[]>([]);
  private readonly searchSubject = new Subject<string>();
  private readonly HISTORY_KEY = 'portal:catalog:search-history';
  private readonly HISTORY_LIMIT = 6;

  search = '';
  qtyByProduct: Record<string, number> = {};
  adding: Record<string, boolean> = {};

  /**
   * Sheet de detalle del producto (se abre con el botón `+`).
   * Muestra info extra del producto + stepper grande + botón "Agregar al carrito".
   * El commit es explícito (no auto-debounce).
   */
  readonly sheetProductId = signal<string | null>(null);
  readonly sheetQty = signal<number>(1);
  readonly sheetProduct = computed<PriceRow | null>(() => {
    const id = this.sheetProductId();
    if (!id) return null;
    return this.prices().find((p) => p.product_id === id) || null;
  });
  readonly sheetSubtotal = computed<number>(() => {
    const p = this.sheetProduct();
    if (!p) return 0;
    return this.sheetQty() * (Number(p.price) || 0);
  });

  /**
   * Cross-sell "Va bien con esto" (P1 #6): hasta 3 SKUs distintos al actual,
   * con precio. Reusa top-sellers (señal de demanda) y cae al catálogo
   * cargado — sin endpoint de relacionados nuevo.
   */
  readonly sheetCrossSell = computed<PriceRow[]>(() => {
    const cur = this.sheetProductId();
    if (!cur) return [];
    const seen = new Set<string>([cur]);
    const out: PriceRow[] = [];
    for (const pool of [this.topSellers(), this.prices()]) {
      for (const p of pool) {
        if (out.length >= 3) break;
        if (!p || p.price == null || seen.has(p.product_id)) continue;
        seen.add(p.product_id);
        out.push(p);
      }
      if (out.length >= 3) break;
    }
    return out;
  });


  /**
   * Index product_id → metadata de su promo activa. Permite al template
   * decorar el card del catálogo completo con un badge "Con promo", no solo
   * cuando el chip está activo. Lookup O(1).
   */
  readonly promoByProductId = computed<Record<string, { promo_code: string; promo_name: string; promo_type: string }>>(() => {
    const out: Record<string, { promo_code: string; promo_name: string; promo_type: string }> = {};
    for (const p of this.promoProducts()) {
      out[p.product_id] = {
        promo_code: p.promo_code,
        promo_name: p.promo_name,
        promo_type: p.promo_type,
      };
    }
    return out;
  });

  readonly brands = computed<BrandGroup[]>(() => {
    const map = new Map<string, BrandGroup>();
    for (const p of this.prices()) {
      const bid = p.brand_id || '__unknown__';
      const bname = p.brand_name || 'Sin marca';
      const g = map.get(bid) || {
        brand_id: bid,
        brand_name: bname,
        count: 0,
        color: 'var(--neutral-100)',
        initial: initial(bname),
      };
      g.count++;
      map.set(bid, g);
    }
    return [...map.values()].sort((a, b) => a.brand_name.localeCompare(b.brand_name));
  });

  readonly visibleProducts = computed<PriceRow[]>(() => {
    // Modo IA: el orden viene del KNN backend (no aplicamos brand filter local
    // porque sería contraintuitivo — el usuario pidió por semántica, no por marca).
    if (this.aiSearch() && this.searchSignal().trim()) {
      return this.smartResults().map((r) => ({
        id: r.product_id,
        product_id: r.product_id,
        product_name: r.product_name,
        brand_id: r.brand_id,
        brand_name: r.brand_name,
        price: r.price,
        tax_rate: r.tax_rate,
        min_qty: r.min_qty,
        stock_available: r.stock_available,
      }));
    }
    const term = this.searchSignal().trim().toLowerCase();

    // Quick filters: el set base viene del backend ya ordenado (frecuencia
    // para 'reorder', score IA para 'suggested'). Brand filter no aplica
    // para no confundir al cliente — la idea es "ver mi short-list", no
    // recortarla más.
    const qf = this.quickFilter();
    if (qf === 'reorder' || qf === 'suggested' || qf === 'promo') {
      let arr: PriceRow[] =
        qf === 'reorder' ? this.historyProducts()
        : qf === 'suggested' ? this.suggestedProducts()
        : this.promoProducts();
      if (term) {
        arr = arr.filter(
          (p) =>
            (p.product_name || '').toLowerCase().includes(term) ||
            (p.brand_name || '').toLowerCase().includes(term),
        );
      }
      return arr;
    }

    // Catálogo paginado: `prices()` ya viene filtrado por el backend con
    // brand/price/stock/q. No re-filtramos local — sería incorrecto contra
    // un set parcial (página 1 de N) y duplicaría trabajo del SQL.
    return this.prices();
  });

  readonly selectedBrandName = computed<string>(() => {
    if (this.aiSearch() && this.searchSignal().trim()) {
      return `Resultados para "${this.searchSignal().trim()}"`;
    }
    if (this.quickFilter() === 'reorder') {
      return 'Para reordenar — productos que ya pediste';
    }
    if (this.quickFilter() === 'suggested') {
      return 'Sugeridos para ti — canasta IA';
    }
    if (this.quickFilter() === 'promo') {
      return 'En promoción — descuentos vigentes';
    }
    const bid = this.selectedBrandId();
    if (bid === '__all__') return 'Todos los productos';
    const b = this.brands().find((x) => x.brand_id === bid);
    return b ? b.brand_name : '—';
  });

  ngOnInit(): void {
    // Deep-link de marca (carrusel "Marcas top" del home → ?brand=<id>).
    // Se setea antes de loadAll para que el primer fetch ya venga filtrado.
    const brandParam = this.route.snapshot.queryParamMap.get('brand');
    if (brandParam) this.selectedBrandId.set(brandParam);

    this.loadAll();
    this.wireSmartSearch();
    this.loadHistory();
  }

  ngAfterViewInit(): void {
    // SSR-safe: IntersectionObserver no existe en server-side. La app es CSR
    // (Capacitor + browser puro) pero por defensividad chequeamos.
    if (typeof IntersectionObserver === 'undefined') return;
    this.scrollObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && this.hasMorePages()) {
            this.loadNextPage();
          }
        }
      },
      // `rootMargin` 400px: empezar a cargar el siguiente batch ANTES de que
      // el sentinel sea visible — el usuario no debería ver el "Cargando..."
      // a menos que tipee scroll muy rápido.
      { rootMargin: '400px 0px' },
    );
    // Si el ViewChild ya se asignó antes del ngAfterViewInit (setter corrió
    // primero), reobservamos. Sino, el setter lo hará cuando el *ngIf monte.
    if (this._sentinelEl) {
      this.scrollObserver.observe(this._sentinelEl);
    }
  }

  ngOnDestroy(): void {
    this.scrollObserver?.disconnect();
  }

  private wireSmartSearch(): void {
    // Search debounced. Bifurca según `aiSearch()`:
    //   - aiSearch=true  → /catalog/search (vectorial Voyage + pgvector)
    //   - aiSearch=false → /catalog/products?q=... (ILIKE server-side paginado)
    // En ambos casos respetamos el quick-chip: si reorder/suggested/promo está
    // activo, el filtro corre en cliente sobre ese set (ver visibleProducts).
    this.searchSubject
      .pipe(
        debounceTime(300),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((q) => {
        const term = (q || '').trim();
        if (this.aiSearch()) {
          if (!term) {
            this.searching.set(false);
            this.smartResults.set([]);
            this.smartMode.set(null);
            return;
          }
          this.searching.set(true);
          this.api.smartSearch(term, 24).subscribe({
            next: (res: any) => {
              this.searching.set(false);
              if (res && Array.isArray(res.results)) {
                this.smartResults.set(res.results);
                this.smartMode.set(res.mode);
                const scores: Record<string, number> = {};
                for (const r of res.results) scores[r.product_id] = r.score;
                this.scoreById.set(scores);
                this.pushHistory(this.search);
              }
            },
            error: () => {
              this.searching.set(false);
              this.smartResults.set([]);
              this.smartMode.set(null);
              this.scoreById.set({});
            },
          });
        } else {
          // Search regular: si hay quick-chip activo, el filtro se hace en
          // cliente vía visibleProducts (sobre history/suggested/promo).
          // Sin quick-chip, refetch del catálogo paginado.
          if (!this.quickFilter()) {
            this.resetAndFetch();
          }
          if (term) this.pushHistory(term);
        }
      });
  }

  private loadHistory(): void {
    try {
      const raw = localStorage.getItem(this.HISTORY_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) this.searchHistory.set(arr.slice(0, this.HISTORY_LIMIT));
      }
    } catch { /* ignore corrupt storage */ }
  }

  private pushHistory(q: string): void {
    const t = (q || '').trim();
    if (!t || t.length < 3) return;
    const next = [t, ...this.searchHistory().filter((x) => x.toLowerCase() !== t.toLowerCase())]
      .slice(0, this.HISTORY_LIMIT);
    this.searchHistory.set(next);
    try { localStorage.setItem(this.HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }

  clearHistory(): void {
    this.searchHistory.set([]);
    try { localStorage.removeItem(this.HISTORY_KEY); } catch { /* ignore */ }
  }

  useHistory(q: string): void {
    this.search = q;
    this.searchSignal.set(q);
    if (!this.aiSearch()) this.aiSearch.set(true);
    this.searchSubject.next(q);
  }

  productScore(p: PriceRow): number | null {
    if (!this.aiSearch() || !this.searchSignal().trim()) return null;
    const s = this.scoreById()[p.product_id];
    return typeof s === 'number' ? Math.round(s * 100) : null;
  }

  toggleAiSearch(): void {
    const next = !this.aiSearch();
    this.aiSearch.set(next);
    if (next && this.search.trim()) {
      this.searchSubject.next(this.search);
    } else {
      this.smartResults.set([]);
      this.smartMode.set(null);
    }
  }

  private loadAll(): void {
    this.loading.set(true);

    // Nuevo flujo: el catálogo es la tabla `public.products` (la del RAG), no
    // `commercial.product_prices`. El backend `/catalog/products` hace LEFT JOIN
    // al precio del customer y al stock del warehouse, devolviendo TODOS los
    // productos activos del tenant. price=null si no hay precio configurado.
    const wsLoader = this.api.listWarehouses().pipe(takeUntilDestroyed(this.destroyRef));

    if (this.isAdmin()) {
      this.customerName.set('Vista admin — sin customer linkeado');
      wsLoader.subscribe({
        next: (warehouses) => {
          const defaultWh = warehouses.find((w: any) => w.is_default) || warehouses[0];
          this.warehouseId.set(defaultWh?.id || '');
          this.fetchCatalog();
        },
        error: () => this.loading.set(false),
      });
      return;
    }

    forkJoin({
      customer: this.api.myCustomerInfo(),
      warehouses: this.api.listWarehouses(),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ customer, warehouses }) => {
          if (!customer) {
            this.toast.add({
              severity: 'error',
              summary: 'Sin customer',
              detail: 'Tu usuario no está linkeado a un cliente B2B.',
            });
            this.loading.set(false);
            return;
          }
          this.customerName.set(customer.name);
          this.customerId.set(customer.id);
          const defaultWh = warehouses.find((w: any) => w.is_default) || warehouses[0];
          this.warehouseId.set(defaultWh?.id || '');
          this.fetchCatalog();
        },
        error: (e) => {
          this.toast.add({ severity: 'error', summary: 'Error', detail: e.message });
          this.loading.set(false);
        },
      });
  }

  private fetchCatalog(): void {
    // Catálogo paginado server-side. La página 1 se trae acá; las siguientes
    // se cargan via IntersectionObserver cuando el sentinel entra al viewport.
    this.loading.set(true);
    this.loadCatalogPage(1, /* replace */ true);

    // Cargar historial + canasta IA en paralelo. Para admin/sin customer
    // ambos endpoints devuelven [] (no error), así que los chips
    // simplemente no aparecen. La canasta IA puede demorar más (compute
    // si está stale >24h) — el chip aparece cuando termina, lazy.
    const wh = this.warehouseId() || undefined;
    this.api.myCatalogHistory(wh)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rows) => {
          this.historyProducts.set(rows);
          rows.forEach((r) => {
            if (!this.qtyByProduct[r.product_id]) {
              this.qtyByProduct[r.product_id] = r.min_qty || 1;
            }
          });
        },
        error: () => this.historyProducts.set([]),
      });

    this.api.myCatalogSuggested(wh)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rows) => {
          this.suggestedProducts.set(rows);
          rows.forEach((r) => {
            if (!this.qtyByProduct[r.product_id]) {
              this.qtyByProduct[r.product_id] = r.min_qty || 1;
            }
          });
        },
        error: () => this.suggestedProducts.set([]),
      });

    // Top sellers del tenant (MV refrescada cada 15min). Resuelve price_list
    // del customer via myCustomerInfo (default_price_list_id). Si no hay
    // customer o no tiene price_list asignada, el strip queda vacío sin error.
    this.api.myCustomerInfo()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (customer: any) => {
          const plId = customer?.default_price_list_id;
          if (!plId) {
            this.topSellers.set([]);
            return;
          }
          this.api.listTopSellers(plId, wh, 1000)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
              next: (rows) => this.topSellers.set(rows || []),
              error: () => this.topSellers.set([]),
            });
        },
        error: () => this.topSellers.set([]),
      });

    this.api.myCatalogWithPromo(wh)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rows) => {
          this.promoProducts.set(rows);
          rows.forEach((r) => {
            if (!this.qtyByProduct[r.product_id]) {
              this.qtyByProduct[r.product_id] = r.min_qty || 1;
            }
          });
        },
        error: () => this.promoProducts.set([]),
      });

    // Facets del backend — counts reales para los chips del panel.
    this.api.catalogFacets(wh, 30)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (f) => this.facets.set(f),
        error: () => this.facets.set(null),
      });
  }

  /**
   * SKU empujado como unidad nativa "Destacado" al tope de resultados (P0 #4).
   * Solo en catálogo completo (sin quick-chip, sin búsqueda) para no competir
   * con la intención explícita del usuario. Reusa promoProducts() ya cargado.
   */
  readonly featuredPromoProduct = computed<CatalogWithPromoRow | null>(() => {
    if (this.quickFilter() || (this.aiSearch() && this.searchSignal().trim()) || this.searchSignal().trim()) {
      return null;
    }
    return this.promoProducts()[0] || null;
  });

  /** Cast estrecho: CatalogWithPromoRow → PriceRow para reusar openSheet/addToCart. */
  asPrice(p: CatalogWithPromoRow): PriceRow {
    return p as unknown as PriceRow;
  }

  selectBrand(brandId: string): void {
    this.selectedBrandId.set(brandId);
  }

  /**
   * Fetch de UNA página del catálogo paginado. Si `replace=true`, reemplaza
   * `prices()` (usado para page 1 y resets). Si `false`, append (usado para
   * infinite scroll). `loadingMore` lockea contra carrera con observer.
   */
  private loadCatalogPage(page: number, replace: boolean): void {
    if (this.loadingMore()) return;
    this.loadingMore.set(true);
    const bid = this.selectedBrandId();
    const bucket = this.priceBucket();
    this.api
      .listCatalogPage({
        warehouseId: this.warehouseId() || undefined,
        page,
        pageSize: this.PAGE_SIZE,
        q: this.searchSignal().trim() || undefined,
        brandId: bid !== '__all__' ? bid : undefined,
        priceMin: bucket?.min,
        priceMax: bucket?.max ?? undefined,
        hasStock: this.onlyWithStock() || undefined,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          if (replace) this.prices.set(r.data);
          else this.prices.update((arr) => [...arr, ...r.data]);
          r.data.forEach((p) => {
            if (!this.qtyByProduct[p.product_id]) {
              this.qtyByProduct[p.product_id] = p.min_qty || 1;
            }
          });
          this.totalCount.set(r.pagination.total);
          this.currentPage.set(r.pagination.page);
          this.loadingMore.set(false);
          this.loading.set(false);
        },
        error: (e) => {
          this.toast.add({ severity: 'error', summary: 'Error', detail: e.message });
          if (replace) this.prices.set([]);
          this.loadingMore.set(false);
          this.loading.set(false);
        },
      });
  }

  /** Reset al cambiar filtros del panel o search — vuelve a página 1. */
  private resetAndFetch(): void {
    this.currentPage.set(1);
    this.loadCatalogPage(1, /* replace */ true);
  }

  /** Disparado por IntersectionObserver al ver el sentinel. */
  private loadNextPage(): void {
    if (!this.hasMorePages() || this.loadingMore()) return;
    this.loadCatalogPage(this.currentPage() + 1, /* replace */ false);
  }

  openFilters(): void { this.filtersOpen.set(true); }
  closeFilters(): void { this.filtersOpen.set(false); }

  togglePriceBucket(b: { min: number; max: number | null }): void {
    const cur = this.priceBucket();
    const same = cur && cur.min === b.min && cur.max === b.max;
    this.priceBucket.set(same ? null : { min: b.min, max: b.max });
  }

  toggleStockOnly(): void {
    this.onlyWithStock.set(!this.onlyWithStock());
  }

  /** Limpiar TODOS los filtros del panel (no quick-chips ni search). */
  clearPanelFilters(): void {
    this.selectedBrandId.set('__all__');
    this.priceBucket.set(null);
    this.onlyWithStock.set(false);
    this.brandPanelSearch.set('');
  }

  /**
   * Filtrado del listado de brands del panel: aplica el search interno del
   * panel sobre los top-N que vienen del facets. Para "ver todas" hace falta
   * un endpoint paginado dedicado (futuro).
   */
  readonly filteredBrandFacets = computed(() => {
    const f = this.facets();
    if (!f) return [];
    const term = this.brandPanelSearch().trim().toLowerCase();
    if (!term) return f.brands;
    return f.brands.filter((b) =>
      (b.brand_name || '').toLowerCase().includes(term),
    );
  });

  /**
   * Label corto del pill de promo en el card. La descripción larga del
   * descuento (porcentaje, tiers, n×m, bundle) requiere parsear `rules` —
   * el portal-promotions ya lo hace y es trabajo aparte. Acá solo tipo.
   */
  promoLabel(type: string): string {
    switch (type) {
      case 'percent_off_product': return '% OFF';
      case 'nxm': return 'N×M';
      case 'volume_discount': return 'Volumen';
      case 'bundle_fixed_price': return 'Combo';
      case 'cross_sell_discount': return 'Cross-sell';
      default: return 'Promo';
    }
  }

  /**
   * Activa/desactiva un atajo personalizado. Click sobre el mismo chip lo
   * apaga (vuelve al catálogo completo); click sobre otro lo cambia.
   */
  toggleQuickFilter(key: 'reorder' | 'suggested' | 'promo'): void {
    this.quickFilter.set(this.quickFilter() === key ? null : key);
    // Salir de IA / search al cambiar de modo — sino el grid queda en estado
    // raro mostrando KNN results del catálogo completo cuando el user pidió
    // "lo que ya compré" o "lo sugerido".
    if (this.quickFilter() && this.aiSearch()) {
      this.aiSearch.set(false);
      this.smartResults.set([]);
      this.smartMode.set(null);
    }
  }

  onSearchChange(v: string): void {
    this.searchSignal.set(v);
    // Siempre disparar el subject — wireSmartSearch decide adónde va el query
    // (smart-search IA si aiSearch=true, /catalog/products?q=... sino).
    this.searchSubject.next(v);
  }

  clearSearch(): void {
    this.search = '';
    this.searchSignal.set('');
    this.smartResults.set([]);
    this.smartMode.set(null);
    // Refetch sin q solo si no hay quick-chip activo (sino el filtro va sobre
    // el set in-memory del quick-chip).
    if (!this.quickFilter() && !this.loading()) {
      this.resetAndFetch();
    }
  }

  inc(p: PriceRow): void {
    this.qtyByProduct[p.product_id] = (Number(this.qtyByProduct[p.product_id]) || p.min_qty) + 1;
  }

  dec(p: PriceRow): void {
    const cur = Number(this.qtyByProduct[p.product_id]) || p.min_qty;
    this.qtyByProduct[p.product_id] = Math.max(p.min_qty, cur - 1);
  }

  addToCart(p: PriceRow): void {
    if (this.isAdmin()) {
      this.toast.add({
        severity: 'info',
        summary: 'Vista admin',
        detail: 'Solo lectura. Inicia sesión como cliente para agregar al carrito.',
      });
      return;
    }
    if (!this.customerId() || !this.warehouseId()) {
      this.toast.add({
        severity: 'error',
        summary: 'No se pudo agregar',
        detail: 'Falta customer o warehouse. Recarga la página.',
      });
      return;
    }
    if (p.price == null) {
      this.toast.add({
        severity: 'warn',
        summary: 'Sin precio',
        detail: 'Este producto no tiene precio configurado para tu lista. Contacta a soporte.',
      });
      return;
    }
    const qty = Number(this.qtyByProduct[p.product_id]) || p.min_qty;
    if (qty < p.min_qty) {
      this.toast.add({
        severity: 'warn',
        summary: 'Cantidad mínima',
        detail: `Este producto requiere mínimo ${p.min_qty} unidades.`,
      });
      return;
    }
    this.adding[p.product_id] = true;
    this.api.ensureDraft(this.customerId(), this.warehouseId()).subscribe({
      next: (draft) => {
        this.api.addLine(draft.id, p.product_id, qty).subscribe({
          next: () => {
            this.adding[p.product_id] = false;
            this.toast.add({
              severity: 'success',
              summary: 'Agregado',
              detail: `${qty}× ${p.product_name}`,
              life: 2000,
            });
            this.openDrawer();
          },
          error: (err) => {
            this.adding[p.product_id] = false;
            this.toast.add({
              severity: 'error',
              summary: 'No se pudo agregar',
              detail: err.error?.message || err.message,
            });
          },
        });
      },
      error: (err) => {
        this.adding[p.product_id] = false;
        this.toast.add({
          severity: 'error',
          summary: 'No se pudo crear el carrito',
          detail: err.error?.message || err.message,
        });
      },
    });
  }

  openDrawer(): void {
    this.drawerOpen.set(true);
    this.cart.refreshCartDetail();
  }
  closeDrawer(): void { this.drawerOpen.set(false); }

  bumpDrawerQty(line: any, delta: number): void {
    const cid = this.cart.cartId();
    if (!cid) return;
    const next = Math.max(1, Number(line.quantity) + delta);
    if (next === Number(line.quantity)) return;
    this.api.updateLine(cid, line.id, next).subscribe({
      error: (err) =>
        this.toast.add({
          severity: 'error',
          summary: 'Error',
          detail: err.error?.message || err.message,
        }),
    });
  }

  removeDrawerLine(line: any): void {
    const cid = this.cart.cartId();
    if (!cid) return;
    this.api.removeLine(cid, line.id).subscribe({
      error: (err) =>
        this.toast.add({
          severity: 'error',
          summary: 'Error',
          detail: err.error?.message || err.message,
        }),
    });
  }

  trackByLineId = (_i: number, l: any) => l.id;

  shortId(id: string): string {
    return id?.slice(0, 8) || '—';
  }

  lineGradient(_productId: string): string {
    // Estilo Rappi: avatares neutros, no colorful per-product (eso se ve a AI).
    return 'var(--neutral-100)';
  }

  goCart(): void {
    this.closeDrawer();
    this.router.navigateByUrl('/portal/cart');
  }

  trackByProduct(_i: number, p: PriceRow): string { return p.product_id; }
  trackByBrand(_i: number, b: BrandGroup): string { return b.brand_id; }
  trackByString = (_i: number, s: string) => s;
  trackByBrandFacet = (_i: number, b: { brand_id: string | null }) => b.brand_id || '__unknown__';
  trackByBucket = (_i: number, b: { min: number; max: number | null }) => `${b.min}-${b.max ?? 'inf'}`;

  hasQty(p: PriceRow): boolean {
    return this.isInCart(p);
  }

  isInCart(p: PriceRow): boolean {
    const lines = this.cart.cartDetail()?.lines;
    if (!lines) return false;
    return lines.some((l: any) => l.product_id === p.product_id);
  }

  cartLineQty(p: PriceRow): number {
    const lines = this.cart.cartDetail()?.lines;
    if (!lines) return 0;
    const line = lines.find((l: any) => l.product_id === p.product_id);
    return line ? Number(line.quantity) || 0 : 0;
  }

  private cartLineFor(p: PriceRow): any | null {
    const lines = this.cart.cartDetail()?.lines;
    if (!lines) return null;
    return lines.find((l: any) => l.product_id === p.product_id) || null;
  }

  // ── Sheet de detalle del producto ──────────────────────────────
  openSheet(p: PriceRow): void {
    if (this.isAdmin()) {
      this.toast.add({
        severity: 'info',
        summary: 'Vista admin',
        detail: 'Solo lectura. Inicia sesión como cliente para agregar.',
      });
      return;
    }
    this.sheetQty.set(p.min_qty || 1);
    this.sheetProductId.set(p.product_id);
  }

  closeSheet(): void {
    this.sheetProductId.set(null);
  }

  sheetInc(): void {
    this.sheetQty.update((v) => v + 1);
  }

  sheetDec(): void {
    const p = this.sheetProduct();
    const min = p?.min_qty || 1;
    this.sheetQty.update((v) => Math.max(min, v - 1));
  }

  confirmAddFromSheet(): void {
    const p = this.sheetProduct();
    if (!p) return;
    const qty = this.sheetQty();
    if (qty < (p.min_qty || 1)) {
      this.toast.add({
        severity: 'warn',
        summary: 'Cantidad mínima',
        detail: `Este producto requiere mínimo ${p.min_qty} unidad(es).`,
      });
      return;
    }
    const id = p.product_id;
    this.adding[id] = true;
    this.api.ensureDraft(this.customerId(), this.warehouseId()).subscribe({
      next: (draft) => {
        this.api.addLine(draft.id, id, qty).subscribe({
          next: () => {
            this.adding[id] = false;
            this.toast.add({
              severity: 'success',
              summary: 'Agregado',
              detail: `${qty}× ${p.product_name}`,
              life: 1800,
            });
            this.closeSheet();
          },
          error: (err) => {
            this.adding[id] = false;
            this.toast.add({
              severity: 'error',
              summary: 'No se pudo agregar',
              detail: err.error?.message || err.message,
            });
          },
        });
      },
      error: (err) => {
        this.adding[id] = false;
        this.toast.add({
          severity: 'error',
          summary: 'No se pudo crear carrito',
          detail: err.error?.message || err.message,
        });
      },
    });
  }

  incrementCartLine(p: PriceRow): void {
    if (this.isAdmin()) return;
    const cid = this.cart.cartId();
    const line = this.cartLineFor(p);
    if (!cid || !line) return;
    const next = (Number(line.quantity) || 0) + 1;
    this.adding[p.product_id] = true;
    this.api.updateLine(cid, line.id, next).subscribe({
      next: () => { this.adding[p.product_id] = false; },
      error: (err) => {
        this.adding[p.product_id] = false;
        this.toast.add({
          severity: 'error',
          summary: 'Error',
          detail: err.error?.message || err.message,
        });
      },
    });
  }

  decrementCartLine(p: PriceRow): void {
    if (this.isAdmin()) return;
    const cid = this.cart.cartId();
    const line = this.cartLineFor(p);
    if (!cid || !line) return;
    const cur = Number(line.quantity) || 0;
    const min = Math.max(1, p.min_qty || 1);
    this.adding[p.product_id] = true;
    // MOQ: no existe línea por debajo del mínimo mayorista. Al tocar el piso,
    // el siguiente decremento quita la línea completa.
    if (cur <= min) {
      this.api.removeLine(cid, line.id).subscribe({
        next: () => { this.adding[p.product_id] = false; },
        error: (err) => {
          this.adding[p.product_id] = false;
          this.toast.add({
            severity: 'error',
            summary: 'Error',
            detail: err.error?.message || err.message,
          });
        },
      });
    } else {
      this.api.updateLine(cid, line.id, cur - 1).subscribe({
        next: () => { this.adding[p.product_id] = false; },
        error: (err) => {
          this.adding[p.product_id] = false;
          this.toast.add({
            severity: 'error',
            summary: 'Error',
            detail: err.error?.message || err.message,
          });
        },
      });
    }
  }

  goAi(): void {
    this.router.navigateByUrl('/portal/recommendations');
  }

  brandColor(_brandId?: string | null): string {
    return 'var(--text-muted)';
  }

  cardGradient(p: PriceRow): string {
    return brandPlaceholderGradient(p?.product_id || p?.product_name);
  }

  private imgFailedSet = new Set<string>();

  hasImg(p: PriceRow): boolean {
    return !!p.image_url && !this.imgFailedSet.has(p.product_id);
  }

  /** URL Cloudinary optimizada (Fase 4). width: 400 thumbnails, 800 sheet. */
  img(p: { image_url?: string | null }, width = 400): string {
    return cldImage(p?.image_url, width);
  }

  onImgError(p: PriceRow): void {
    this.imgFailedSet.add(p.product_id);
  }

  productInitials(p: PriceRow): string {
    const name = p.product_name || '?';
    const words = name.trim().split(/\s+/).slice(0, 2);
    return words.map((w) => w.charAt(0).toUpperCase()).join('') || '?';
  }

  private darken(hex: string, amount: number): string {
    const h = hex.replace('#', '');
    const r = Math.max(0, parseInt(h.slice(0, 2), 16) - Math.round(255 * amount));
    const g = Math.max(0, parseInt(h.slice(2, 4), 16) - Math.round(255 * amount));
    const b = Math.max(0, parseInt(h.slice(4, 6), 16) - Math.round(255 * amount));
    return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  }
}
