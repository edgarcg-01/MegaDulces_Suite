import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnDestroy,
  Output,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { PortalService, PriceRow } from '../portal.service';
import { TopProductsComponent } from './top-products.component';
import { PortalProductCardComponent } from './portal-product-card.component';

type FeedStatus = 'loading' | 'ready' | 'empty';

interface FeedBlock {
  id: string;
  kind: 'rail' | 'banner' | 'grid';
  status: FeedStatus;
  eyebrow?: string;
  heading?: string;
  bannerUrl?: string;
  products?: PriceRow[];
}

interface RailSpec {
  kind: 'rail' | 'banner';
  eyebrow?: string;
  heading?: string;
  brandId?: string;
  query?: string;
  bannerUrl?: string;
}

/**
 * Feed de descubrimiento "casi infinito" del home. Genera bloques BAJO DEMANDA
 * al acercarse el sentinel (IntersectionObserver): rails por marca y categoría +
 * banners intercalados, y al agotar la receta, una grilla paginada del catálogo
 * que sigue cargando hasta el final.
 *
 * Disciplina mobile:
 *  - Carga SERIALIZADA (flag `busy`) → un request a la vez (anti-429).
 *  - `content-visibility:auto` por bloque → el navegador no pinta lo que está
 *    fuera de pantalla (clave para un feed largo, sin virtualización JS).
 *  - Dedup global por product_id → ningún producto se repite entre bloques.
 *  - Rails reusan portal-top-products; la grilla reusa portal-product-card.
 * Presentacional: emite open/add hacia el home (top-sheet + fly-to-cart).
 */
@Component({
  selector: 'portal-home-feed',
  standalone: true,
  imports: [CommonModule, RouterModule, TopProductsComponent, PortalProductCardComponent],
  template: `
    <div class="hf" *ngIf="blocks().length || busy()">
      <ng-container *ngFor="let b of blocks(); trackBy: trackBlock">
        <div
          class="hf-block"
          [class.hf-block-grid]="b.kind === 'grid'"
          [class.hf-block-hidden]="b.status === 'empty'"
        >
          <!-- skeleton mientras carga -->
          <div *ngIf="b.status === 'loading'" class="hf-skel" aria-hidden="true">
            <div class="hf-skel-head"></div>
            <div class="hf-skel-row">
              <span></span><span></span><span></span>
            </div>
          </div>

          <!-- rail (marca / categoría) -->
          <portal-top-products
            *ngIf="b.status === 'ready' && b.kind === 'rail'"
            [products]="b.products!"
            [eyebrow]="b.eyebrow!"
            [heading]="b.heading!"
            meta=""
            [showRank]="false"
            [addingId]="addingId"
            [addedIds]="addedIds"
            (open)="open.emit($event)"
            (add)="add.emit($event)"
          ></portal-top-products>

          <!-- banner de marketing -->
          <a
            *ngIf="b.status === 'ready' && b.kind === 'banner'"
            class="hf-banner"
            routerLink="/portal/promotions"
            aria-label="Ver promociones"
          >
            <img [src]="b.bannerUrl" alt="Promoción" loading="lazy" decoding="async" />
          </a>

          <!-- grilla paginada (cola infinita) -->
          <section *ngIf="b.status === 'ready' && b.kind === 'grid'" class="hf-gridsec">
            <header *ngIf="b.heading" class="hf-gridhead">
              <span class="hf-eyebrow">{{ b.eyebrow }}</span>
              <h2>{{ b.heading }}</h2>
            </header>
            <div class="hf-grid">
              <portal-product-card
                *ngFor="let p of b.products!; trackBy: trackProd"
                [product]="p"
                [adding]="addingId === p.product_id"
                (open)="open.emit(p)"
                (add)="add.emit(p)"
              ></portal-product-card>
            </div>
          </section>
        </div>
      </ng-container>

      <div #sentinel class="hf-sentinel" aria-hidden="true"></div>

      <div *ngIf="busy()" class="hf-more" aria-live="polite">
        <i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Cargando más…
      </div>

      <div *ngIf="exhausted() && !busy()" class="hf-end">
        <span class="hf-end-emoji" aria-hidden="true">🍬</span>
        <p>Llegaste al final del feed</p>
        <a routerLink="/portal/catalog" class="portal-btn-primary portal-btn-pill hf-end-cta">
          Ir al catálogo completo
          <i class="pi pi-arrow-right" aria-hidden="true"></i>
        </a>
      </div>
    </div>
  `,
  styles: [
    `
      :host { display: block; }
      .hf { display: flex; flex-direction: column; gap: 2.5rem; }

      /* El navegador omite render/layout de bloques fuera de pantalla. */
      .hf-block {
        content-visibility: auto;
        contain-intrinsic-size: 0 380px;
      }
      /* Sobre-estimado a propósito: sub-estimar provoca saltos de scroll al
         resolver la altura real de una grilla de 24 cards. */
      .hf-block-grid { contain-intrinsic-size: 0 2400px; }
      .hf-block-hidden { display: none; }

      /* ── Skeleton por bloque ── */
      .hf-skel { display: flex; flex-direction: column; gap: 0.9rem; }
      .hf-skel-head {
        width: 42%;
        height: 1.6rem;
        border-radius: var(--r-pill);
        background: var(--skeleton-bg, #e6e0d6);
      }
      .hf-skel-row { display: flex; gap: 0.85rem; overflow: hidden; }
      .hf-skel-row span {
        flex: 0 0 auto;
        width: clamp(184px, 62vw, 220px);
        height: 232px;
        border-radius: var(--r-xl);
        background: linear-gradient(100deg, var(--skeleton-bg, #e6e0d6) 30%, rgba(255,255,255,0.45) 50%, var(--skeleton-bg, #e6e0d6) 70%);
        background-size: 220% 100%;
        animation: hfShimmer 1.3s ease-in-out infinite;
      }
      @keyframes hfShimmer { from { background-position: 180% 0; } to { background-position: -40% 0; } }

      /* ── Banner ── */
      .hf-banner {
        display: block;
        width: 100%;
        border-radius: var(--r-xl);
        overflow: hidden;
        border: 1px solid var(--border-color);
        box-shadow: var(--shadow-float);
        transition: transform 220ms var(--ease-spring), box-shadow 220ms var(--ease-standard);
      }
      .hf-banner:hover { transform: translateY(-3px); box-shadow: var(--shadow-hover); }
      .hf-banner img { display: block; width: 100%; height: auto; }

      /* ── Grilla ── */
      .hf-gridhead { margin: 0 0.1rem 1rem; }
      .hf-eyebrow {
        display: block;
        font-size: var(--fs-micro);
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--brand-700);
        margin-bottom: 0.2rem;
      }
      .hf-gridhead h2 {
        font-family: var(--font-display);
        font-size: var(--text-display-lg);
        font-weight: 700;
        letter-spacing: -0.02em;
        line-height: 1.05;
        color: var(--neutral-950);
        margin: 0;
      }
      .hf-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
        gap: 0.85rem;
      }
      @media (min-width: 560px) {
        .hf-grid { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); }
      }

      .hf-sentinel { width: 100%; height: 1px; }

      .hf-more {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        padding: 1rem;
        color: var(--text-muted);
        font-size: var(--fs-sm);
        font-weight: 600;
      }

      .hf-end {
        text-align: center;
        padding: 1.5rem 1rem 0.5rem;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.5rem;
      }
      .hf-end-emoji { font-size: 1.8rem; }
      .hf-end p { margin: 0; color: var(--text-muted); font-weight: 600; }
      .hf-end-cta { margin-top: 0.5rem; }

      @media (prefers-reduced-motion: reduce) {
        .hf-skel-row span { animation: none; }
        .hf-banner { transition: none; }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomeFeedComponent implements AfterViewInit, OnDestroy {
  @Input() warehouseId: string | null = null;
  @Input() bannerUrl: string | null = null;
  @Input() addingId: string | null = null;
  @Input() addedIds = new Set<string>();

  /** Marcas top (de catalogFacets). Al llegar, arma la receta y arranca el feed. */
  @Input() set brands(v: Array<{ brand_id: string | null; brand_name: string | null }>) {
    if (this.recipeReady || !v?.length) return;
    this.buildRecipe(v);
    this.recipeReady = true;
    this.arm();
  }

  @Output() open = new EventEmitter<PriceRow>();
  @Output() add = new EventEmitter<PriceRow>();

  /** Setter: el sentinel vive dentro de un *ngIf, así que engancha el IO
   *  recién cuando el elemento aparece (tras el primer bloque), no en AfterViewInit. */
  @ViewChild('sentinel') set sentinel(ref: ElementRef<HTMLElement> | undefined) {
    if (ref?.nativeElement) this.attachIO(ref.nativeElement);
  }

  private readonly api = inject(PortalService);

  readonly blocks = signal<FeedBlock[]>([]);
  readonly busy = signal<boolean>(false);
  readonly exhausted = signal<boolean>(false);

  private readonly CATEGORIES = [
    { term: 'gomita', label: 'Gomitas' },
    { term: 'chocolate', label: 'Chocolates' },
    { term: 'tamarindo', label: 'Tamarindo' },
    { term: 'enchilado', label: 'Enchilados' },
    { term: 'paleta', label: 'Paletas' },
    { term: 'mazapan', label: 'Mazapán' },
    { term: 'chicle', label: 'Chicles' },
    { term: 'bombon', label: 'Bombones' },
  ];

  private specs: RailSpec[] = [];
  private specIndex = 0;
  private gridPage = 1;
  private firstGrid = true;
  private gridEmptyStreak = 0;
  /** Tope de páginas de grilla → acota el DOM del feed "casi infinito". */
  private readonly MAX_GRID_PAGES = 12;
  private readonly seen = new Set<string>();

  private arr: FeedBlock[] = [];
  private uid = 0;
  private recipeReady = false;
  private viewReady = false;
  private armed = false;
  private nearBottom = false;
  private io?: IntersectionObserver;

  ngAfterViewInit(): void {
    this.viewReady = true;
    this.arm();
  }

  ngOnDestroy(): void {
    this.io?.disconnect();
  }

  private arm(): void {
    if (this.armed || !this.viewReady || !this.recipeReady) return;
    this.armed = true;
    // Siembra inicial (2 bloques); el resto lo dispara el sentinel vía IO.
    void this.appendNext().then(() => this.appendNext());
  }

  private attachIO(el: HTMLElement): void {
    if (this.io || typeof IntersectionObserver === 'undefined') return;
    this.io = new IntersectionObserver(
      (entries) => {
        this.nearBottom = entries.some((e) => e.isIntersecting);
        if (this.nearBottom) void this.appendNext();
      },
      { rootMargin: '700px 0px' },
    );
    this.io.observe(el);
  }

  /** Receta intercalada: marca → categoría → … + banner temprano. */
  private buildRecipe(brands: Array<{ brand_id: string | null; brand_name: string | null }>): void {
    const brandSpecs: RailSpec[] = brands
      .filter((b) => b.brand_id && b.brand_name)
      .slice(0, 8)
      .map((b) => ({ kind: 'rail', eyebrow: 'Marca', heading: b.brand_name!, brandId: b.brand_id! }));
    const catSpecs: RailSpec[] = this.CATEGORIES.map((c) => ({
      kind: 'rail',
      eyebrow: 'Categoría',
      heading: c.label,
      query: c.term,
    }));
    const out: RailSpec[] = [];
    const max = Math.max(brandSpecs.length, catSpecs.length);
    for (let i = 0; i < max; i++) {
      if (brandSpecs[i]) out.push(brandSpecs[i]);
      if (catSpecs[i]) out.push(catSpecs[i]);
      if (this.bannerUrl && i === 1) out.push({ kind: 'banner', bannerUrl: this.bannerUrl });
    }
    this.specs = out;
  }

  private commit(): void {
    this.blocks.set([...this.arr]);
  }

  /** Agrega el siguiente bloque. SERIALIZADO por `busy` → un request a la vez. */
  private async appendNext(): Promise<void> {
    if (this.busy() || this.exhausted() || !this.armed) return;
    this.busy.set(true);
    try {
      if (this.specIndex < this.specs.length) {
        await this.loadSpec(this.specs[this.specIndex++]);
      } else {
        await this.loadGrid();
      }
    } catch {
      /* un bloque que falla no rompe el feed */
    } finally {
      this.busy.set(false);
    }
    // Si el sentinel sigue cerca tras cargar, seguir llenando (el IO no
    // re-dispara solo cuando el elemento queda dentro del viewport).
    if (this.nearBottom && !this.exhausted()) void this.appendNext();
  }

  private async loadSpec(spec: RailSpec): Promise<void> {
    if (spec.kind === 'banner') {
      this.arr.push({ id: `b${this.uid++}`, kind: 'banner', status: 'ready', bannerUrl: spec.bannerUrl });
      this.commit();
      return;
    }
    const block: FeedBlock = {
      id: `r${this.uid++}`,
      kind: 'rail',
      status: 'loading',
      eyebrow: spec.eyebrow,
      heading: spec.heading,
    };
    this.arr.push(block);
    this.commit();

    try {
      const r = await firstValueFrom(
        this.api.listCatalogPage({
          brandId: spec.brandId,
          q: spec.query,
          page: 1,
          pageSize: 24,
          warehouseId: this.warehouseId || undefined,
        }),
      );
      // Los rails NO tocan el `seen` global (eso starvaba rails posteriores).
      // El dedup exacto-una-vez solo importa en la grilla; los rails son
      // descubrimiento curado y pueden repetir entre sí o vs la grilla.
      const picked = (r?.data || []).filter((p) => p.price != null).slice(0, 10);
      if (picked.length >= 4) {
        block.products = picked;
        block.status = 'ready';
      } else {
        block.status = 'empty';
      }
    } catch {
      block.status = 'empty'; // un bloque que falla no deja skeleton colgado
    }
    this.commit();
  }

  private async loadGrid(): Promise<void> {
    const block: FeedBlock = {
      id: `g${this.uid++}`,
      kind: 'grid',
      status: 'loading',
      eyebrow: this.firstGrid ? 'Explora todo' : undefined,
      heading: this.firstGrid ? 'Todo el catálogo' : undefined,
    };
    this.firstGrid = false;
    this.arr.push(block);
    this.commit();

    try {
      const r = await firstValueFrom(
        this.api.listCatalogPage({
          page: this.gridPage,
          pageSize: 24,
          warehouseId: this.warehouseId || undefined,
        }),
      );
      const data = r?.data || [];
      const fresh = data.filter((p) => !this.seen.has(p.product_id));
      fresh.forEach((p) => this.seen.add(p.product_id));
      block.products = fresh;
      block.status = fresh.length ? 'ready' : 'empty';

      const pag = r?.pagination;
      this.gridPage += 1;
      this.gridEmptyStreak = fresh.length === 0 ? this.gridEmptyStreak + 1 : 0;
      // Termina si: no hay paginación, página corta, pasó el total, varias
      // páginas seguidas 100% deduplicadas, o tope de páginas (cota de DOM).
      if (
        !pag ||
        data.length < 24 ||
        (pag.pageCount && this.gridPage > pag.pageCount) ||
        this.gridEmptyStreak >= 2 ||
        this.gridPage > this.MAX_GRID_PAGES
      ) {
        this.exhausted.set(true);
      }
    } catch {
      block.status = 'empty';
      this.exhausted.set(true);
    }
    this.commit();
  }

  trackBlock = (_i: number, b: FeedBlock) => b.id;
  trackProd = (_i: number, p: PriceRow) => p.product_id;
}
