import {
  ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, inject, input, signal, viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter, map } from 'rxjs/operators';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { PageTab } from '../../../shared/components/page-tabs/page-tabs.component';
import { pestanaVisible } from '../../../shared/components/page-tabs/pestanas-de-area';
import { CATALOGO_TABS } from '../catalogo-tabs';

/**
 * Compras › Catálogo: el menú «Ver» que reemplaza la fila de 11 pestañas (aprobado en la maqueta
 * catalogo-produccion.html). Las pestañas son las MISMAS de CATALOGO_TABS y se filtran por permiso con
 * la MISMA regla que app-page-tabs (pestanaVisible + manage:all), así que el menú nunca ofrece algo que la
 * barra no ofrecería ni esconde algo que sí.
 *
 * Agrupado por para qué sirve, cada opción con una línea que dice qué hay adentro. Las cuatro pantallas
 * vacías (Resumen, Solicitudes, Incidencias, Listas de precios) no se ofrecen: un destino vacío en un menú
 * es una promesa que no se cumple. Una pestaña nueva que nadie agrupó NO se pierde: cae en «Más».
 */

/** Las pantallas que hoy están vacías: no se ofrecen en el menú. */
export const CATALOGO_OCULTAS: readonly string[] = [
  '/compras/catalogo/resumen',
  '/compras/catalogo/solicitudes',
  '/compras/catalogo/incidencias',
  '/compras/catalogo/listas-precios',
];

/** Grupos del menú: ruta → la línea que dice qué hay adentro (textos de la maqueta aprobada). */
export const CATALOGO_GRUPOS: ReadonlyArray<{ titulo: string; items: ReadonlyArray<{ route: string; descripcion: string }> }> = [
  {
    titulo: 'Productos',
    items: [
      { route: '/compras/catalogo', descripcion: 'Buscar un producto, sus unidades y precio' },
      { route: '/compras/catalogo/nuevos', descripcion: 'Seguimiento a 30, 60 y 90 días' },
    ],
  },
  {
    titulo: 'Precios y costos',
    items: [
      { route: '/compras/catalogo/precios', descripcion: 'Precios de una sucursal y los que cambiaron' },
      { route: '/compras/catalogo/costos', descripcion: 'Sólo con permiso de costo' },
      { route: '/compras/catalogo/reporte', descripcion: 'Reporte de precios por proveedor para imprimir' },
    ],
  },
  {
    titulo: 'Por corregir',
    items: [
      { route: '/compras/catalogo/codigos', descripcion: 'Un código de barras en dos productos' },
      { route: '/compras/catalogo/no-registrados', descripcion: 'Escaneado en tienda y sin alta en Kepler' },
      { route: '/compras/catalogo/mantenimiento', descripcion: 'Diferencias entre sucursales y sin clasificar' },
    ],
  },
];

export interface OpcionMenu { label: string; route: string; descripcion: string | null }
export interface GrupoMenu { titulo: string; opciones: OpcionMenu[] }

/** Arma los grupos con las pestañas que la persona ve. Pura: la prueba la corre sin Angular. */
export function gruposDelMenu(tabs: readonly PageTab[], ve: (t: PageTab) => boolean): GrupoMenu[] {
  const visibles = tabs.filter((t) => ve(t) && !CATALOGO_OCULTAS.includes(t.route));
  const usadas = new Set<string>();
  const grupos: GrupoMenu[] = CATALOGO_GRUPOS.map((g) => ({
    titulo: g.titulo,
    opciones: g.items.flatMap((i) => {
      const t = visibles.find((x) => x.route === i.route);
      if (!t) return [];
      usadas.add(t.route);
      return [{ label: t.label, route: t.route, descripcion: i.descripcion }];
    }),
  }));
  const resto = visibles.filter((t) => !usadas.has(t.route)).map((t) => ({ label: t.label, route: t.route, descripcion: null }));
  if (resto.length) grupos.push({ titulo: 'Más', opciones: resto });
  return grupos.filter((g) => g.opciones.length);
}

/** La opción de la URL: la ruta exacta, si no la más larga que la contiene por segmento. */
export function opcionActual(opciones: readonly OpcionMenu[], url: string): OpcionMenu | null {
  const u = String(url ?? '').split(/[?#]/)[0];
  const exacta = opciones.find((o) => o.route === u);
  if (exacta) return exacta;
  return [...opciones].filter((o) => u.startsWith(o.route + '/')).sort((a, b) => b.route.length - a.route.length)[0] ?? null;
}

let siguienteId = 0;

@Component({
  selector: 'app-catalogo-menu',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cm">
      <button #boton type="button" class="cm-btn" aria-haspopup="menu" [attr.aria-expanded]="abierto()" [attr.aria-controls]="idMenu"
              (click)="alternar()" (keydown.arrowdown)="$event.preventDefault(); abrir()">
        <span class="cm-eti">Ver</span>
        <b class="cm-actual">{{ actual()?.label ?? 'Catálogo' }}</b>
        <i class="pi pi-chevron-down" aria-hidden="true"></i>
      </button>
      @if (abierto()) {
        <div #menu class="cm-menu" role="menu" [id]="idMenu" aria-label="Apartados del catálogo" (keydown)="teclado($event)">
          @for (g of grupos(); track g.titulo) {
            <div role="group" [attr.aria-label]="g.titulo">
              <p class="cm-g" aria-hidden="true">{{ g.titulo }}</p>
              @for (o of g.opciones; track o.route) {
                <a role="menuitem" class="cm-op" [class.is-on]="o.route === actual()?.route" [routerLink]="o.route"
                   [attr.aria-current]="o.route === actual()?.route ? 'page' : null" (click)="cerrar(false)">
                  <b>{{ o.label }}</b>
                  @if (o.descripcion) { <small>{{ o.descripcion }}</small> }
                </a>
              }
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: inline-block; position: relative; }
    .cm-btn { display: inline-flex; align-items: center; gap: var(--sp-2); min-height: 2.25rem; padding: 0 var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); color: var(--text-main);
      font: inherit; font-size: var(--fs-sm); cursor: pointer; }
    .cm-btn:hover { background: var(--overlay-hover); }
    .cm-btn:focus-visible, .cm-op:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .cm-eti { color: var(--text-muted); }
    .cm-actual { font-weight: var(--fw-bold); }
    .cm-btn .pi { font-size: var(--fs-xs); color: var(--text-muted); }
    .cm-menu { position: absolute; z-index: 30; top: calc(100% + var(--sp-1)); left: 0; min-width: 19rem; max-width: calc(100vw - 2rem);
      max-height: 70vh; overflow-y: auto; padding: var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-lg);
      background: var(--card-bg); box-shadow: var(--shadow-float); }
    .cm-g { margin: var(--sp-2) var(--sp-2) var(--sp-1); font-size: var(--fs-xs); font-weight: var(--fw-bold); color: var(--text-faint);
      text-transform: uppercase; letter-spacing: .04em; }
    .cm-op { display: flex; flex-direction: column; gap: 2px; padding: var(--sp-2); border-radius: var(--r-sm); color: var(--text-main);
      text-decoration: none; border-left: 2px solid transparent; }
    .cm-op:hover { background: var(--overlay-hover); }
    .cm-op.is-on { background: var(--overlay-selected); border-left-color: var(--action); }
    .cm-op b { font-size: var(--fs-sm); font-weight: var(--fw-bold); }
    .cm-op small { font-size: var(--fs-xs); color: var(--text-muted); }
    @media (pointer: coarse) { .cm-btn, .cm-op { min-height: 44px; } }
  `],
})
export class CatalogoMenuComponent {
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Las pestañas del catálogo; por default las de siempre. */
  readonly tabs = input<readonly PageTab[]>(CATALOGO_TABS);
  readonly idMenu = 'catalogo-menu-' + ++siguienteId;
  readonly abierto = signal(false);
  private readonly boton = viewChild<ElementRef<HTMLButtonElement>>('boton');
  private readonly menu = viewChild<ElementRef<HTMLElement>>('menu');

  private readonly url = toSignal(
    this.router.events.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd), map((e) => e.urlAfterRedirects)),
    { initialValue: this.router.url },
  );

  /** Mismo gate que app-page-tabs: manage:all ve todo; si no, la clave del permiso. */
  readonly grupos = computed(() => {
    const todo = this.perms.isAdmin();
    const tiene = (p: Permission) => this.auth.user()?.permissions?.[p] === true;
    return gruposDelMenu(this.tabs(), (t) => todo || pestanaVisible(t, tiene));
  });
  readonly actual = computed(() => opcionActual(this.grupos().flatMap((g) => g.opciones), this.url()));

  alternar(): void { if (this.abierto()) this.cerrar(true); else this.abrir(); }

  abrir(): void {
    this.abierto.set(true);
    // Al abrir, el foco va a la opción actual (o a la primera): las flechas siguen desde ahí.
    setTimeout(() => {
      const items = this.opciones();
      (items.find((a) => a.classList.contains('is-on')) ?? items[0])?.focus();
    });
  }

  cerrar(devolverFoco: boolean): void {
    if (!this.abierto()) return;
    this.abierto.set(false);
    if (devolverFoco) this.boton()?.nativeElement.focus();
  }

  teclado(e: KeyboardEvent): void {
    const items = this.opciones();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const ir = (n: number) => { e.preventDefault(); items[(n + items.length) % items.length]?.focus(); };
    if (e.key === 'ArrowDown') ir(i + 1);
    else if (e.key === 'ArrowUp') ir(i - 1);
    else if (e.key === 'Home') ir(0);
    else if (e.key === 'End') ir(items.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.cerrar(true); }
    else if (e.key === 'Tab') this.cerrar(false);
  }

  /** Un clic fuera cierra (sin robar el foco a donde se hizo clic). */
  @HostListener('document:click', ['$event'])
  fuera(e: MouseEvent): void {
    if (this.abierto() && !this.host.nativeElement.contains(e.target as Node)) this.cerrar(false);
  }

  private opciones(): HTMLElement[] {
    return Array.from(this.menu()?.nativeElement.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  }
}
