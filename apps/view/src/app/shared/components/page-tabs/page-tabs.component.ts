import { AfterViewInit, ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, input, viewChild, viewChildren } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';

export interface PageTab {
  label: string;
  route: string;
  icon?: string;
  /** Si se especifica, el tab solo se muestra si el user tiene ese permiso. */
  permission?: Permission;
  /** routerLinkActiveOptions.exact (default true). */
  exact?: boolean;
}

/**
 * Tab-bar por ruta reutilizable para Operations. Cada tab es un routerLink a una
 * página hermana; filtra tabs por permiso (fallback legacy del JWT). Se esconde si
 * queda 1 tab visible.
 *
 * Dos variantes visuales (`variant`):
 *  - `underline` (default): subrayado sobrio (quiet-luxury) — el resto de la app.
 *  - `liquid`: segmented control estilo iOS con blob deslizante (reusa las clases
 *    globales `.liquid-tabs*` de styles.css). El indicador se posiciona midiendo el
 *    tab activo (`routerLinkActive`). Usado en Contabilidad.
 *
 * Uso:
 *   <app-page-tabs [tabs]="tabs" />
 *   <app-page-tabs [tabs]="tabs" variant="liquid" />
 */
@Component({
  selector: 'app-page-tabs',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visibleTabs().length > 1) {
      @if (variant() === 'liquid') {
        <div class="modern-tabs-wrapper liquid-tabs-host pt-liquid-wrap">
          <div class="liquid-tabs liquid-tabs--scroll" role="tablist" #lqContainer>
            <span class="liquid-tabs-indicator" aria-hidden="true" #lqIndicator></span>
            @for (t of visibleTabs(); track t.route) {
              <a
                class="liquid-tab"
                role="tab"
                #lqTab
                [routerLink]="t.route"
                routerLinkActive="is-active"
                [routerLinkActiveOptions]="{ exact: t.exact ?? true }"
              >
                @if (t.icon) { <i [class]="t.icon" aria-hidden="true"></i> }
                <span>{{ t.label }}</span>
              </a>
            }
          </div>
        </div>
      } @else {
        <nav class="ptabs" role="tablist">
          @for (t of visibleTabs(); track t.route) {
            <a
              class="ptab"
              [routerLink]="t.route"
              routerLinkActive="is-active"
              [routerLinkActiveOptions]="{ exact: t.exact ?? true }"
            >
              @if (t.icon) {
                <i [class]="t.icon" aria-hidden="true"></i>
              }
              <span>{{ t.label }}</span>
            </a>
          }
        </nav>
      }
    }
  `,
  styles: [
    `
      .ptabs {
        display: flex;
        gap: 2px;
        border-bottom: 1px solid var(--border-color);
        margin-bottom: 1rem;
        overflow-x: auto;
        scrollbar-width: none;
      }
      .ptabs::-webkit-scrollbar {
        display: none;
      }
      .ptab {
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
        padding: 0.6rem 0.95rem;
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--text-muted);
        text-decoration: none;
        white-space: nowrap;
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
        transition: color 0.15s ease, border-color 0.15s ease;
      }
      .ptab:hover {
        color: var(--text-main);
      }
      .ptab.is-active {
        color: var(--text-main);
        border-bottom-color: var(--action);
      }
      .ptab i {
        font-size: 0.9rem;
      }
      .pt-liquid-wrap {
        margin-bottom: 1rem;
      }
      .pt-liquid-wrap .liquid-tab {
        text-decoration: none;
      }
    `,
  ],
})
export class PageTabsComponent implements AfterViewInit {
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  readonly tabs = input.required<PageTab[]>();
  readonly variant = input<'underline' | 'liquid'>('underline');

  readonly lqContainer = viewChild<ElementRef<HTMLElement>>('lqContainer');
  readonly lqIndicator = viewChild<ElementRef<HTMLSpanElement>>('lqIndicator');
  readonly lqTabs = viewChildren<ElementRef<HTMLAnchorElement>>('lqTab');

  readonly visibleTabs = computed(() =>
    this.tabs().filter(
      (t) => !t.permission || this.auth.user()?.permissions?.[t.permission] === true,
    ),
  );

  ngAfterViewInit(): void {
    if (this.variant() !== 'liquid') return;
    // `routerLinkActive` marca .is-active tras el primer ciclo → reintentos escalonados.
    [0, 120, 350].forEach((d) => setTimeout(() => this.syncIndicator(), d));
    const container = this.lqContainer()?.nativeElement;
    if (container && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this.syncIndicator());
      ro.observe(container);
      this.destroyRef.onDestroy(() => ro.disconnect());
    }
  }

  /** Posiciona el blob bajo el tab activo (mismo enfoque que los liquid-tabs de reports). */
  private syncIndicator(): void {
    const indicator = this.lqIndicator()?.nativeElement;
    if (!indicator) return;
    const active = this.lqTabs().map((r) => r.nativeElement).find((el) => el.classList.contains('is-active'));
    if (!active) { indicator.style.width = '0px'; return; }
    indicator.style.transform = `translate3d(${active.offsetLeft}px, 0, 0)`;
    indicator.style.width = `${active.offsetWidth}px`;
    active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}
