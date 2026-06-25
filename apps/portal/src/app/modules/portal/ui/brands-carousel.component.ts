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
    <section class="bc" *ngIf="loop.length">
      <header class="bc-head">
        <h2>Marcas top</h2>
        <a routerLink="/portal/catalog" class="bc-link">Ver todas →</a>
      </header>
      <div class="bc-viewport">
        <div class="bc-track">
          <a
            *ngFor="let b of loop; let i = index; trackBy: trackByIdx"
            class="bc-card"
            [class.is-fallback]="failed.has(b.brand_id || '')"
            [style.--bc]="brandColor(b.brand_name)"
            [style.--bc-ink]="brandInk(b.brand_name)"
            [style.background]="failed.has(b.brand_id || '') ? null : logoBg(b.brand_name)"
            [routerLink]="['/portal/catalog']"
            [queryParams]="{ brand: b.brand_id }"
            [attr.aria-hidden]="i >= half ? 'true' : null"
            [attr.tabindex]="i >= half ? -1 : null"
            [attr.aria-label]="'Ver productos de ' + label(b.brand_name)"
          >
            <img
              *ngIf="!failed.has(b.brand_id || '')"
              [src]="srcFor(b)"
              [alt]="label(b.brand_name)"
              [style.padding.px]="logoPad(b.brand_name)"
              loading="lazy"
              decoding="async"
              (error)="onErr(b, $event)"
            />
            <span *ngIf="failed.has(b.brand_id || '')" class="bc-mono">{{ mono(b.brand_name) }}</span>
          </a>
        </div>
      </div>
    </section>
  `,
  styles: [
    `
      :host { display: block; margin-bottom: 1.5rem; }
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
        gap: 1rem;
        width: max-content;
        padding: 0.25rem 0.1rem 0.6rem;
      }
      :host(.is-marquee) .bc-track { will-change: transform; }

      /* Card = chip circular logo-only. El color de marca (--bc) entra como
         acento en hover/focus y como relleno del fallback (sin logo). */
      .bc-card {
        flex: 0 0 auto;
        width: 92px;
        height: 92px;
        border-radius: 50%;
        background: #fff;
        border: 1px solid var(--neutral-200);
        display: grid;
        place-items: center;
        overflow: hidden;
        text-decoration: none;
        transition: transform 200ms var(--ease-standard), border-color 200ms var(--ease-standard), box-shadow 240ms var(--ease-standard);
      }
      .bc-card:hover {
        transform: translateY(-4px);
        border-color: var(--bc, var(--neutral-300));
        box-shadow: 0 16px 30px -14px color-mix(in srgb, var(--bc, #000) 45%, transparent);
      }
      .bc-card:focus-visible { outline: 2px solid var(--bc, var(--action)); outline-offset: 2px; }
      .bc-card img { width: 100%; height: 100%; object-fit: contain; padding: 20px; }
      .bc-card.is-fallback { background: var(--bc, var(--neutral-900)); border-color: transparent; }
      .bc-mono { font-family: var(--font-display); font-weight: 700; font-size: var(--fs-h2); color: var(--bc-ink, #fff); }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrandsCarouselComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) brands: BrandFacet[] = [];

  /** Lista duplicada para el loop continuo sin costura (solo marcas reconocidas). */
  loop: BrandFacet[] = [];
  half = 0;
  readonly failed = new Set<string>();
  /** ids cuyo .svg ya falló → reintentamos con .png antes de caer a monograma. */
  private readonly triedPng = new Set<string>();

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
    // Solo marcas reconocidas (logo-only sin nombre necesita identidad clara).
    const recognized = (this.brands || []).filter((b) => this.match(b.brand_name));
    this.half = recognized.length;
    this.loop = recognized.length ? [...recognized, ...recognized] : [];
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
    if (this.armed || !this.viewReady || !this.loop.length) return;
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
  // `bg` = color de fondo del PROPIO logo (cuando el SVG trae un fondo sólido
  // de borde a borde). Sin `bg` el chip va blanco. Rellena las esquinas del
  // círculo con el mismo color → sin huecos para logos cuadrados (ej. Ricolino).
  // `bg` = relleno del chip (logo cuadrado con fondo de color). `pad` = padding
  // del logo en px para normalizar tamaños (algunos PNG vienen sin margen).
  private readonly KNOWN: Array<{ re: RegExp; slug: string; label: string; color: string; bg?: string; pad?: number }> = [
    { re: /hershey/, slug: 'hersheys', label: "Hershey's", color: '#6F4E37' },
    { re: /\bmars\b|effem/, slug: 'mars', label: 'Mars', color: '#CC2229' },
    { re: /mondelez|ricolino/, slug: 'ricolino', label: 'Ricolino', color: '#304C9C', bg: '#304C9C' },
    { re: /ferrero/, slug: 'ferrero', label: 'Ferrero', color: '#5C2E2E' },
    { re: /arcor/, slug: 'arcor', label: 'Arcor', color: '#2D4F9E' },
    { re: /perfetti|van melle/, slug: 'perfetti-van-melle', label: 'Perfetti', color: '#CC262D' },
    { re: /barcel|bimbo/, slug: 'bimbo', label: 'Barcel', color: '#C32B30' },
    { re: /canel/, slug: 'canels', label: "Canel's", color: '#202A83' },
    { re: /\bla rosa\b|de la rosa/, slug: 'de-la-rosa', label: 'De la Rosa', color: '#D81F26' },
    { re: /jovy/, slug: 'jovy', label: 'Jovy', color: '#1E2B8F' },
    { re: /payaso|globo/, slug: 'globo-payaso', label: 'Paleta Payaso', color: '#E2231A' },
    { re: /delicias/, slug: 'delicias', label: 'Delicias', color: '#FFE600', bg: '#FFE600' },
    { re: /gonac/, slug: 'gonac', label: 'Gonac', color: '#111111' },
    { re: /nutresa/, slug: 'nutresa', label: 'Nutresa', color: '#2E6B3E', pad: 28 },
  ];
  private norm(name: string | null | undefined): string {
    return (name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  }
  /** Reconocida = matchea una marca de consumo conocida (tiene slug + color). */
  match(name: string | null | undefined) {
    const n = this.norm(name);
    return this.KNOWN.find((k) => k.re.test(n)) || null;
  }
  private slugFor(name: string | null | undefined): string {
    return this.match(name)?.slug || this.norm(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  /** Intenta .svg; tras fallar una vez, .png (ver onErr). */
  srcFor(b: BrandFacet): string {
    const ext = this.triedPng.has(b.brand_id || '') ? 'png' : 'svg';
    return `/assets/brands/${this.slugFor(b.brand_name)}.${ext}`;
  }
  label(name: string | null | undefined): string {
    return this.match(name)?.label || (name || '').trim();
  }
  /** Color de marca para acento/relleno; CSS var. */
  brandColor(name: string | null | undefined): string {
    return this.match(name)?.color || 'var(--neutral-400)';
  }
  /** Fondo del chip cuando hay logo = fondo propio del SVG (blanco por defecto). */
  logoBg(name: string | null | undefined): string {
    return this.match(name)?.bg || '#ffffff';
  }
  /** Padding del logo (px) para normalizar tamaños entre marcas. */
  logoPad(name: string | null | undefined): number {
    return this.match(name)?.pad ?? 20;
  }
  /** Tinta legible (negro/blanco) sobre el color de marca, según luminancia. */
  brandInk(name: string | null | undefined): string {
    const hex = this.match(name)?.color;
    if (!hex || !hex.startsWith('#')) return '#ffffff';
    const c = hex.replace('#', '');
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.62 ? '#100D09' : '#ffffff';
  }
  mono(name: string | null | undefined): string {
    const src = this.label(name) || '?';
    return src.split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
  }
  onErr(b: BrandFacet, ev: Event): void {
    const id = b.brand_id || '';
    const img = ev.target as HTMLImageElement | null;
    const src = img?.currentSrc || img?.src || '';
    // Decidir por la URL que REALMENTE falló — robusto al duplicado del marquee
    // (dos <img> por marca dispararían el contador de más).
    if (src.endsWith('.svg')) this.triedPng.add(id); // no hay svg → reintentar png
    else this.failed.add(id); // png también falló → monograma de color
  }
}
