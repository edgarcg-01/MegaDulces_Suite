import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';

export interface BrandFacet {
  brand_id: string | null;
  brand_name: string | null;
  count: number;
}

/**
 * Carrusel "Marcas top" — marquee auto-scroll continuo (GSAP). Pausa al hover y
 * al tocar; bajo prefers-reduced-motion (o sin GSAP) cae a scroll manual. Logo
 * desde /assets/brands/<slug>.svg con fallback a monograma.
 */
@Component({
  selector: 'portal-brands-carousel',
  standalone: true,
  imports: [CommonModule, RouterModule],
  template: `
    <section class="bc" *ngIf="brands?.length">
      <header class="bc-head">
        <h2>Marcas top</h2>
        <a routerLink="/portal/catalog" class="bc-link">Ver todas →</a>
      </header>
      <div class="bc-viewport">
        <div class="bc-track">
          <a
            *ngFor="let b of loop; let i = index; trackBy: trackByIdx"
            class="bc-card"
            [routerLink]="['/portal/catalog']"
            [queryParams]="{ brand: b.brand_id }"
            [attr.aria-hidden]="i >= brands.length ? 'true' : null"
            [attr.tabindex]="i >= brands.length ? -1 : null"
            [attr.aria-label]="'Ver productos de ' + label(b.brand_name)"
          >
            <span class="bc-logo">
              <img
                *ngIf="!failed.has(b.brand_id || '')"
                [src]="logo(b.brand_name)"
                [alt]="label(b.brand_name)"
                loading="lazy"
                decoding="async"
                (error)="onErr(b.brand_id || '')"
              />
              <span *ngIf="failed.has(b.brand_id || '')" class="bc-mono">{{ mono(b.brand_name) }}</span>
            </span>
            <span class="bc-name">{{ label(b.brand_name) }}</span>
          </a>
        </div>
      </div>
    </section>
  `,
  styles: [
    `
      :host { display: block; margin-bottom: 2.25rem; }
      .bc-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        margin: 0.3rem 0.1rem 0.9rem;
      }
      .bc-head h2 {
        font-family: var(--font-display);
        font-size: var(--text-display-lg);
        font-weight: 700;
        letter-spacing: -0.02em;
        line-height: 1.05;
        color: var(--neutral-950);
        margin: 0;
      }
      .bc-link { font-size: var(--fs-sm); font-weight: 700; color: var(--brand-700); text-decoration: none; white-space: nowrap; }

      /* Default = scroll manual (fallback accesible). El marquee añade .is-marquee. */
      .bc-viewport {
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: thin;
      }
      :host(.is-marquee) .bc-viewport { overflow: hidden; }
      .bc-track {
        display: flex;
        gap: 0.75rem;
        width: max-content;
        padding-bottom: 0.5rem;
      }
      :host(.is-marquee) .bc-track { will-change: transform; }

      .bc-card {
        flex: 0 0 auto;
        width: 116px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.5rem;
        padding: 0.875rem 0.625rem;
        background: var(--card-bg);
        border: 1px solid var(--neutral-200);
        border-radius: var(--r-lg);
        text-decoration: none;
        color: inherit;
        transition: transform 180ms var(--ease-standard), border-color 180ms var(--ease-standard), box-shadow 200ms var(--ease-standard);
      }
      .bc-card:hover { transform: translateY(-3px); border-color: var(--neutral-300); box-shadow: 0 14px 26px -16px rgba(16, 13, 9, 0.3); }
      .bc-card:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
      .bc-logo {
        width: 72px;
        height: 72px;
        border-radius: 50%;
        background: #fff;
        border: 1px solid var(--neutral-200);
        display: grid;
        place-items: center;
        overflow: hidden;
        flex-shrink: 0;
      }
      .bc-logo img { width: 100%; height: 100%; object-fit: contain; padding: 12px; }
      .bc-mono { font-family: var(--font-display); font-weight: 700; font-size: var(--fs-h2); color: var(--neutral-500); }
      .bc-name {
        font-size: var(--fs-sm);
        font-weight: 700;
        color: var(--neutral-950);
        line-height: 1.2;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 100%;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrandsCarouselComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) brands: BrandFacet[] = [];

  /** Lista duplicada para el loop continuo sin costura. */
  loop: BrandFacet[] = [];
  readonly failed = new Set<string>();

  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);

  private viewReady = false;
  private armed = false;
  private G: any = null;
  private gsapLoading?: Promise<any>;
  private tween: any = null;
  private readonly cleanupFns: Array<() => void> = [];

  ngOnChanges(): void {
    this.loop = this.brands?.length ? [...this.brands, ...this.brands] : [];
    this.tryArm();
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    this.tryArm();
    this.destroyRef.onDestroy(() => this.teardown());
  }

  ngOnDestroy(): void {
    this.teardown();
  }

  private teardown(): void {
    this.tween?.kill?.();
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns.length = 0;
  }

  private tryArm(): void {
    if (this.armed || !this.viewReady || !this.brands?.length) return;
    if (typeof window === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return; // scroll manual
    this.armed = true;
    this.ensureGsap().then((gsap) => gsap && this.startMarquee(gsap)).catch(() => {});
  }

  private ensureGsap(): Promise<any> {
    if (this.G) return Promise.resolve(this.G);
    if (this.gsapLoading) return this.gsapLoading;
    this.gsapLoading = (async () => {
      const mod: any = await import('gsap');
      this.G = mod.gsap || mod.default;
      return this.G;
    })();
    return this.gsapLoading;
  }

  private startMarquee(gsap: any): void {
    const el = this.host.nativeElement as HTMLElement;
    const track = el.querySelector('.bc-track') as HTMLElement | null;
    const vp = el.querySelector('.bc-viewport') as HTMLElement | null;
    if (!track || !vp || this.tween) return;

    el.classList.add('is-marquee');
    // Velocidad proporcional al # de marcas (~3s por marca). ease none = constante.
    const duration = Math.max(18, this.brands.length * 3);

    this.zone.runOutsideAngular(() => {
      this.tween = gsap.to(track, { xPercent: -50, duration, ease: 'none', repeat: -1 });

      const pause = () => this.tween?.pause();
      const play = () => this.tween?.play();
      vp.addEventListener('mouseenter', pause);
      vp.addEventListener('mouseleave', play);
      vp.addEventListener('focusin', pause);
      vp.addEventListener('focusout', play);
      vp.addEventListener('pointerdown', pause);
      window.addEventListener('pointerup', play);
      this.cleanupFns.push(() => {
        vp.removeEventListener('mouseenter', pause);
        vp.removeEventListener('mouseleave', play);
        vp.removeEventListener('focusin', pause);
        vp.removeEventListener('focusout', play);
        vp.removeEventListener('pointerdown', pause);
        window.removeEventListener('pointerup', play);
      });
    });
  }

  trackByIdx = (i: number) => i;

  /**
   * Match por palabra clave: el catálogo devuelve razones sociales
   * ("Effem Mexico", "Mondelez Mexico", "Hershey Mexico"…), no la marca de
   * consumo. Detectamos la marca por keyword → slug del logo + etiqueta limpia.
   */
  private readonly KNOWN: Array<{ re: RegExp; slug: string; label: string }> = [
    { re: /hershey/, slug: 'hersheys', label: "Hershey's" },
    { re: /\bmars\b|effem/, slug: 'mars', label: 'Mars' },
    { re: /mondelez|ricolino/, slug: 'ricolino', label: 'Ricolino' },
    { re: /ferrero/, slug: 'ferrero', label: 'Ferrero' },
    { re: /arcor/, slug: 'arcor', label: 'Arcor' },
    { re: /perfetti|van melle/, slug: 'perfetti-van-melle', label: 'Perfetti' },
    { re: /barcel|bimbo/, slug: 'bimbo', label: 'Barcel' },
    { re: /canel/, slug: 'canels', label: "Canel's" },
    { re: /de la rosa|dulces de la rosa/, slug: 'de-la-rosa', label: 'De la Rosa' },
    { re: /jovy/, slug: 'jovy', label: 'Jovy' },
    { re: /payaso|globo/, slug: 'globo-payaso', label: 'Paleta Payaso' },
    { re: /delicias/, slug: 'delicias', label: 'Delicias' },
    { re: /gonac/, slug: 'gonac', label: 'Gonac' },
    { re: /nutresa/, slug: 'nutresa', label: 'Nutresa' },
  ];
  private norm(name: string | null | undefined): string {
    return (name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  }
  private match(name: string | null | undefined) {
    const n = this.norm(name);
    return this.KNOWN.find((k) => k.re.test(n)) || null;
  }
  logo(name: string | null | undefined): string {
    const m = this.match(name);
    const slug = m ? m.slug : this.norm(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `/assets/brands/${slug}.svg`;
  }
  /** Etiqueta limpia: marca de consumo si la reconocemos, sino la razón social tal cual. */
  label(name: string | null | undefined): string {
    return this.match(name)?.label || (name || '').trim();
  }
  mono(name: string | null | undefined): string {
    const src = this.label(name) || '?';
    return src.split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
  }
  onErr(id: string): void {
    this.failed.add(id);
  }
}
