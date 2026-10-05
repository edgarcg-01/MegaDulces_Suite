import { AfterViewInit, ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, input, viewChild, viewChildren } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs/operators';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

export interface PageTab {
  label: string;
  route: string;
  icon?: string;
  /** Si se especifica, el tab solo se muestra si el user tiene ese permiso. */
  permission?: Permission;
  /**
   * Alternativa a `permission` cuando UNA pantalla sirve a dos públicos con permisos
   * distintos: basta con tener cualquiera de estos. Mismo nombre que `NavItem.anyOf`
   * del sidebar, que ya resolvía este caso — un segundo nombre para el mismo concepto
   * sólo obliga a recordar cuál va en cada lugar. Nace en «Gastos», que es una sola
   * ruta que muestra el tablero a quien puede ver y la captura a quien sólo captura.
   * Con un permiso único, uno de los dos grupos perdía el tab aunque el guard lo dejara
   * entrar — y no es un caso raro: 5 roles tienen VER sin CAPTURAR y 11 al revés.
   */
  anyOf?: Permission[];
  /** routerLinkActiveOptions.exact (default true). */
  exact?: boolean;
  /**
   * Rutas ADICIONALES donde este tab se sigue viendo activo, aunque no sean su `route`.
   * Para un tab que es la puerta de un submódulo con más de una vista: sin esto, estando
   * adentro el tab se apaga y la barra deja de decir dónde estás — que es lo único que
   * la barra hace.
   *
   * Nace en «Cartera», que abre en `/finanzas/cartera` y contiene además
   * `/finanzas/cobranza`. `routerLinkActive` sólo compara contra `route`, y esas dos URLs
   * no comparten prefijo, así que `exact: false` tampoco alcanzaba.
   */
  alsoActiveOn?: string[];
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
        <nav class="modern-tabs-wrapper liquid-tabs-host pt-liquid-wrap" [attr.aria-label]="ariaLabel()">
          <div class="liquid-tabs liquid-tabs--scroll" #lqContainer>
            <span class="liquid-tabs-indicator" aria-hidden="true" #lqIndicator></span>
            @for (t of visibleTabs(); track t.route) {
              <a
                class="liquid-tab"
                #lqTab
                [routerLink]="t.route"
                routerLinkActive="is-active"
                #rla="routerLinkActive"
                [routerLinkActiveOptions]="{ exact: t.exact ?? true }"
                [class.is-active]="activoPorAlias(t)"
                [attr.aria-current]="rla.isActive || activoPorAlias(t) ? 'page' : null"
              >
                @if (t.icon) { <i [class]="t.icon" aria-hidden="true"></i> }
                <span>{{ t.label }}</span>
              </a>
            }
          </div>
        </nav>
      } @else {
        <nav class="ptabs" [attr.aria-label]="ariaLabel()">
          @for (t of visibleTabs(); track t.route) {
            <a
              class="ptab"
              [routerLink]="t.route"
              routerLinkActive="is-active"
              #rla="routerLinkActive"
              [routerLinkActiveOptions]="{ exact: t.exact ?? true }"
              [class.is-active]="activoPorAlias(t)"
              [attr.aria-current]="rla.isActive || activoPorAlias(t) ? 'page' : null"
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
  private readonly perms = inject(PermissionsService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * ¿La URL viva está en `alsoActiveOn` de este tab? Se suma a `routerLinkActive`, no lo
   * reemplaza: el caso normal (la URL ES su `route`) lo sigue resolviendo el router.
   * Se compara sin query string — un filtro no cambia en qué sección estás.
   */
  activoPorAlias(t: PageTab): boolean {
    const alias = t.alsoActiveOn;
    if (!alias?.length) return false;
    const url = this.router.url.split(String.fromCharCode(63))[0];
    return alias.some((a) => url === a || url.startsWith(a + "/"));
  }

  readonly tabs = input.required<PageTab[]>();
  /**
   * `[TAB.1]` — **El default es `liquid` desde el 2026-10-05** (decisión de Edgar: *"cambiemos
   * todo este tipo de pestañas al selector tipo iOS"*).
   *
   * No se construyó nada: la variante existía desde antes y ya estaba probada en los dos casos
   * extremos del repo — **almacén con 23 pestañas** y **contabilidad con 15** — así que el
   * desbordamiento con scroll ya estaba resuelto cuando se tomó la decisión. Lo que cambió es
   * cuál de las dos se sirve sin pedirla: 29 pantallas la heredan, 8 ya la pedían a mano.
   *
   * `underline` se CONSERVA, no se retira: es una línea de escape por pantalla si alguna queda
   * mal con el riel. Retirarla el mismo día que se cambia el default deja sin salida al primero
   * que encuentre un caso raro.
   */
  readonly variant = input<'underline' | 'liquid'>('liquid');

  /**
   * `[TAB.2]` — Nombre de la barra para el lector de pantalla.
   *
   * ⛔ Antes decía `role="tablist"` con `role="tab"` en cada enlace **y ningún `tabpanel` en toda
   * la pantalla**, que es justo lo que la regla **D.4(c)** de `DESIGN.md` prohíbe: el lector
   * anuncia *"pestaña 1 de 7"* y no hay panel al que ir, porque **no son pestañas: son enlaces
   * a rutas hermanas**. Cada una es una PÁGINA con su propio permiso y su propia URL.
   *
   * La semántica correcta de eso es `nav` + `aria-current="page"`, que además le dice al lector
   * cuál está abierta — información que el `role="tab"` no daba. Como hay varias barras de
   * navegación en la pantalla (el sidebar, ésta), la barra lleva nombre o se anuncian iguales.
   */
  readonly ariaLabel = input<string>('Secciones de esta pantalla');

  readonly lqContainer = viewChild<ElementRef<HTMLElement>>('lqContainer');
  readonly lqIndicator = viewChild<ElementRef<HTMLSpanElement>>('lqIndicator');
  readonly lqTabs = viewChildren<ElementRef<HTMLAnchorElement>>('lqTab');

  /**
   * Gate por permiso. El shortcut `manage:all` está a propósito: sin él, un
   * superadmin cuyo JSONB de permisos no tenga la clave literal de un permiso
   * NUEVO (los restrictivos nacen sin seed, ej. `COMMERCIAL_INVENTORY_RECIBIR`)
   * veía la barra vacía aunque `permissionGuard` sí lo dejara entrar a la ruta
   * — el mismo trap que ya resuelven el guard y el sidebar.
   */
  readonly visibleTabs = computed(() => {
    const all = this.perms.isAdmin();
    const tiene = (p: Permission) => this.auth.user()?.permissions?.[p] === true;
    return this.tabs().filter((t) => {
      if (all) return true;
      if (t.anyOf?.length) return t.anyOf.some(tiene);
      return !t.permission || tiene(t.permission);
    });
  });

  ngAfterViewInit(): void {
    if (this.variant() !== 'liquid') return;
    // `routerLinkActive` marca .is-active tras el primer ciclo → un reintento corto alcanza.
    [0, 120].forEach((d) => setTimeout(() => this.syncIndicator(), d));

    /**
     * ⛔ **La tipografía movía la píldora y nadie volvía a medir.** Acá había un tercer
     * `setTimeout(350)` y un `ResizeObserver` sobre el CONTENEDOR. Con el riel a ancho fijo,
     * cuando Hanken Grotesk termina de cargar cambian los anchos de las PESTAÑAS, no el del
     * contenedor: el observer no dispara, y la píldora se queda del ancho que midió con la
     * fuente de respaldo. El timer de 350 ms lo tapaba cuando la fuente venía de caché —
     * o sea, siempre en la máquina de quien lo escribió, y no en la red del campo.
     * El arreglo es esperar la SEÑAL, no adivinar el tiempo.
     */
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => this.syncIndicator());
    }
    // Re-sync en cada navegación: cuando la barra vive en un shell de área
    // (Fase WMS.1) la instancia NO se recrea al cambiar de tab, así que sin
    // esto el blob se quedaba clavado en el tab inicial. En las páginas que la
    // montan una por una (Contabilidad) es un no-op inofensivo.
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => [0, 120].forEach((d) => setTimeout(() => this.syncIndicator(), d)));
    // El observer mira el contenedor Y cada pestaña: lo que mueve la píldora es el ancho de
    // la pestaña activa, y ése cambia sin que el contenedor se entere (fuente, zoom, idioma).
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this.syncIndicator());
      const container = this.lqContainer()?.nativeElement;
      if (container) ro.observe(container);
      for (const t of this.lqTabs()) ro.observe(t.nativeElement);
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
