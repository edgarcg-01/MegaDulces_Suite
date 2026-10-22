import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, NavigationEnd, Router, RouterLink, RouterOutlet, UrlTree } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map, startWith } from 'rxjs/operators';
import { resolveProjectForUrl } from '../constants/suite-map';
import { MultitareaService } from '../services/multitarea.service';

/**
 * `[MT.5]` **La columna derecha de la pantalla partida**, con su encabezado.
 *
 * ── Por qué es un componente y no sigue incrustada en el layout ──────────────
 * Vivía dentro de `LayoutComponent`, que es el contenedor de las 12 áreas. Eso
 * ataba el split a estar DENTRO de un área: al salir a «Mi trabajo»
 * (`/projects`, que no usa el layout) no había segundo panel donde dibujar nada
 * y la partición se perdía entera. Reportado por Edgar el 2026-10-16.
 *
 * El arreglo no es copiar el `<aside>` al otro contenedor —serían dos copias de
 * la misma pantalla, que es justo lo que ADR-056 prohíbe—: es sacarlo a una
 * pieza y que la usen los dos.
 *
 * ── Qué sabe y qué no ────────────────────────────────────────────────────────
 * Sabe todo lo del PANEL: si hay algo adentro, qué título lleva, si los dos
 * lados comparten estado, y cómo se cierra o se maximiza. **No** sabe de
 * permisos ni de kiosco: eso lo sabe quien la hospeda y se lo pasa por
 * `restringido`.
 *
 * ⚠️ `inject(ActivatedRoute)` devuelve la ruta del componente ANFITRIÓN —el
 * área cuando la usa el layout, `/projects` cuando la usa su shell—, que es
 * exactamente el nivel donde vive el outlet `panel`. Por eso cerrar funciona en
 * los dos sin que haya que pasarle nada.
 */
@Component({
  selector: 'app-panel-lateral',
  standalone: true,
  imports: [RouterLink, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'mt-panel',
    '[class.is-open]': 'visible()',
    '[class.is-arrastrando]': 'arrastrando()',
    // `[MT.6]` El ancho elegido viaja como variable: el CSS decide qué hacer con
    // ella (y la ignora cuando el panel está cerrado, que debe medir 0).
    '[style.--mt-panel-w.px]': 'multitarea.anchoPanel()',
    '[attr.aria-hidden]': 'visible() ? null : "true"',
    '[attr.inert]': 'visible() ? null : ""',
    'aria-label': 'Panel lateral',
    role: 'complementary',
  },
  template: `
    <!--
      \`[MT.6]\` El divisor. Es un \`separator\` de verdad, no un adorno: lleva
      \`aria-valuenow\` y se mueve con las flechas, porque acomodar la pantalla
      partida no puede depender de poder arrastrar un mouse. \`Home\` lo devuelve
      al default, igual que el doble clic.
    -->
    <div
      class="mt-panel-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label="Ancho del panel"
      [attr.aria-valuenow]="anchoActual()"
      [attr.aria-valuemin]="MIN"
      [attr.aria-valuemax]="maxPx()"
      tabindex="0"
      (pointerdown)="tomar($event)"
      (dblclick)="multitarea.ponerAnchoPanel(null)"
      (keydown)="porTeclado($event)"
    ></div>
    <header class="mt-panel-head">
      <span class="mt-panel-title">{{ titulo() }}</span>
      <!--
        \`[MT.5]\` Los 47: dashboard (28) y tienda (19) comparten estado de
        pantalla entre sus páginas, así que dos paneles de la MISMA familia se
        pisan los filtros. Se declara acá en vez de bloquearlo — el caso es real
        y quien lo abre tiene que saber qué está viendo.
      -->
      @if (mismaFamilia()) {
        <span class="mt-panel-warn" title="Las dos pantallas comparten sus filtros: cambiar uno mueve el otro">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i> comparten filtros
        </span>
      }
      <a class="mt-panel-btn" [routerLink]="enlaceACompleto()" title="Abrir a pantalla completa" aria-label="Abrir a pantalla completa">
        <i class="pi pi-window-maximize" aria-hidden="true"></i>
      </a>
      <a class="mt-panel-btn" [routerLink]="enlaceCerrar()" title="Cerrar el panel" aria-label="Cerrar el panel">
        <i class="pi pi-times" aria-hidden="true"></i>
      </a>
    </header>
    <div class="mt-panel-body">
      <router-outlet name="panel" (activate)="abierto.set(true)" (deactivate)="abierto.set(false)"></router-outlet>
    </div>
  `,
  styleUrl: './panel-lateral.component.css',
})
export class PanelLateralComponent {
  private readonly router = inject(Router);
  private readonly ruta = inject(ActivatedRoute);

  /**
   * Kiosco: lo sabe el layout (lo deduce de su nav) y lo declara en el
   * servicio. El panel vive en la raíz y no puede verlo por sí mismo.
   */
  // ⚠️ `readonly` y NO `private`: lo leen el host binding del ancho y el
  // `(dblclick)` del divisor, y una plantilla no puede ver miembros privados
  // (TS2341). `tsc --noEmit` suelto no lo marca — lo caza el compilador de
  // plantillas, o sea `Build & typecheck` en el CI.
  readonly multitarea = inject(MultitareaService);
  readonly restringido = this.multitarea.kiosco;

  /** ¿Hay algo en el panel? Lo dice el propio outlet al activarse, no la URL. */
  readonly abierto = signal(false);

  private readonly urlActual = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /**
   * Debajo de 64rem no hay ancho que partir. Es el MISMO corte que el CSS: si
   * los dos números se separaran, habría un tramo donde el panel está cerrado
   * para el CSS y abierto para el componente, o al revés.
   */
  private readonly mql = typeof window !== 'undefined' ? window.matchMedia('(max-width: 64rem)') : null;
  private readonly angosto = signal(this.mql?.matches ?? false);

  constructor() {
    this.mql?.addEventListener('change', (e) => this.angosto.set(e.matches));
  }

  readonly visible = computed(() => this.abierto() && !this.restringido() && !this.angosto());

  /** El camino que vive en el panel, leído de la URL (que es donde vive el split). */
  private readonly urlDelPanel = computed<string | null>(() => {
    const m = /panel:([^)]*)/.exec(this.urlActual());
    if (!m) return null;
    const ruta = m[1].split('//')[0];
    return ruta ? '/' + ruta : null;
  });

  readonly titulo = computed(() => {
    const u = this.urlDelPanel();
    if (!u) return '';
    return resolveProjectForUrl(u)?.label ?? u;
  });

  /**
   * `[MT.5]` Los 47 que se declaran en vez de bloquearse.
   *
   * `dashboard` (28 rutas) y `tienda` (19) comparten estado de PANTALLA entre
   * sus páginas — `FiltersStateService`, `TiendaStateService` y
   * `AnalisisStateService` son `providedIn: 'root'`, o sea uno solo para toda
   * la app. Dos paneles de la MISMA familia se pisan los filtros.
   *
   * Se avisa en vez de impedirlo: comparar dos reportes es un caso legítimo, y
   * el que lo abre tiene que saber qué está viendo. Medido: 47 de 225 rutas, y
   * sólo cuando los dos lados caen en la misma familia — los cruces que
   * motivaron la pantalla partida (cartera|documento, existencia|pedido) no
   * están afectados.
   */
  private static readonly FAMILIAS_QUE_COMPARTEN_ESTADO = ['dashboard', 'tienda'];
  readonly mismaFamilia = computed(() => {
    const p = this.urlDelPanel();
    if (!p) return false;
    const areaPanel = p.split('/')[1] ?? '';
    const areaPrimaria = (this.urlActual().split('/')[1] ?? '').split('(')[0];
    return areaPanel === areaPrimaria && PanelLateralComponent.FAMILIAS_QUE_COMPARTEN_ESTADO.includes(areaPanel);
  });

  /** Vaciar el outlet del panel, sin tocar lo de la izquierda. */
  readonly enlaceCerrar = computed(() => [{ outlets: { panel: null } }]);

  /**
   * Llevar lo del panel a pantalla completa.
   *
   * ⚠️ Un camino absoluto NO alcanza, y esto se midió: `createUrlTree` conserva
   * los outlets que los comandos no nombran, así que `/finanzas/bancos` daba
   * `/compras/(finanzas/bancos//panel:finanzas/bancos)` — la misma pantalla dos
   * veces y el split intacto. Un `UrlTree` parseado del camino es el árbol
   * COMPLETO, sin outlets heredados: es la única forma de que maximizar deshaga
   * la partición.
   */
  readonly enlaceACompleto = computed<UrlTree | string>(() => {
    const u = this.urlDelPanel();
    return u ? this.router.parseUrl(u) : '.';
  });

  /**
   * En kiosco o en pantalla angosta no hay ancho que partir. El CSS ya lo
   * esconde, pero esconder no es cerrar: el componente del panel seguiría vivo
   * consultando.
   */
  // ── `[MT.6]` El divisor ────────────────────────────────────────────────────
  /** Piso: debajo de esto la pantalla de la derecha deja de ser usable. */
  readonly MIN = 384; // 24rem, el mismo de `:host(.is-open)`
  private readonly host = inject(ElementRef<HTMLElement>);
  readonly arrastrando = signal(false);

  /** Techo: nunca dejar la izquierda como una tira. */
  maxPx(): number {
    const ventana = typeof window === 'undefined' ? 1600 : window.innerWidth;
    return Math.max(this.MIN, Math.round(ventana * 0.8));
  }

  /** Lo que mide HOY, para que el teclado empiece desde donde se ve. */
  anchoActual(): number {
    return Math.round(
      this.multitarea.anchoPanel() ?? (this.host.nativeElement as HTMLElement).getBoundingClientRect().width,
    );
  }

  private acotar(px: number): number {
    return Math.min(this.maxPx(), Math.max(this.MIN, px));
  }

  /**
   * Arrastre con *pointer events* y `setPointerCapture`: sigue al dedo o al
   * mouse aunque el puntero se salga del divisor, y cubre touch y lápiz sin
   * escribir tres caminos.
   *
   * ⚠️ `arrastrando` apaga la transición de ancho mientras dura. Sin eso el
   * panel persigue al cursor con 180 ms de retraso y se siente pegajoso —
   * la animación está para cuando el ancho cambia SOLO, no mientras lo movés.
   */
  tomar(ev: PointerEvent): void {
    ev.preventDefault();
    const destino = ev.target as HTMLElement;
    destino.setPointerCapture?.(ev.pointerId);
    this.arrastrando.set(true);
    const derecha = (this.host.nativeElement as HTMLElement).getBoundingClientRect().right;

    const mover = (e: PointerEvent): void => this.multitarea.ponerAnchoPanel(this.acotar(derecha - e.clientX));
    const soltar = (): void => {
      this.arrastrando.set(false);
      destino.removeEventListener('pointermove', mover);
      destino.removeEventListener('pointerup', soltar);
      destino.removeEventListener('pointercancel', soltar);
    };
    destino.addEventListener('pointermove', mover);
    destino.addEventListener('pointerup', soltar);
    destino.addEventListener('pointercancel', soltar);
  }

  /** Flechas mueven; con Shift van rápido; Home devuelve el default. */
  porTeclado(ev: KeyboardEvent): void {
    const paso = ev.shiftKey ? 64 : 16;
    if (ev.key === 'ArrowLeft') this.multitarea.ponerAnchoPanel(this.acotar(this.anchoActual() + paso));
    else if (ev.key === 'ArrowRight') this.multitarea.ponerAnchoPanel(this.acotar(this.anchoActual() - paso));
    else if (ev.key === 'Home') this.multitarea.ponerAnchoPanel(null);
    else return;
    ev.preventDefault();
  }

  private readonly cerrarDondeNoCabe = effect(() => {
    if (!this.abierto()) return;
    if (!this.angosto() && !this.restringido()) return;
    void this.router.navigate([{ outlets: { panel: null } }], { relativeTo: this.ruta });
  });
}
