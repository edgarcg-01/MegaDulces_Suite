import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import type { MeContext, MePendiente, MeWork } from '@megadulces/contracts';
import { AuthService } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { MeContextService } from '../../core/services/me-context.service';
import { DataScopeService, type MyScope, type ScopeDim } from '../../core/services/data-scope.service';
import {
  LANDING_ROUTE,
  primaryDestinations,
  visibleSuiteMap,
  type VisibleSuiteMap,
} from '../../core/constants/suite-map';
import { LoadStateComponent } from '../../shared/components/load-state/load-state.component';
import { HlmBadgeDirective } from '../../shared/components/ui/badge/hlm-badge.directive';

/**
 * `[SN.3]` `[SN.8]` — "Mi trabajo": la landing de la plataforma web (`/projects`).
 *
 * ── Qué cambió y por qué (corrección de Edgar, 2026-09-10) ──────────────────────────────────
 * La primera versión de SN.3 tiró la tarjeta y puso filas de texto. Estaba mal: el diseño de
 * tarjetas YA era el correcto — lo que había que cambiar eran los NOMBRES, las POSICIONES (los 10
 * espacios de la especificación) y darle un espacio propio a "Mi trabajo". Esta versión vuelve a
 * la tarjeta de `modules/projects/` (icono en chip, título, línea de contenido, "Acceder →") y la
 * agrupa por espacio.
 *
 * Tres diferencias con la tarjeta vieja, todas por una razón medida:
 *  1. es un `<a routerLink>`, no un `<div (click)>` — teclado y ctrl+clic;
 *  2. la insignia deja de decir "Activo" (era literal siempre; §22 de la spec lo veta) y dice
 *     dónde vive la entrada ("Ventas › Mayoreo") o "Propuesta · P-xx";
 *  3. la línea de contenido se DERIVA de los módulos que ESTA persona puede abrir, en vez de una
 *     descripción a mano — §13 de la spec juzgó a Finanzas por una que llevaba meses vencida.
 *
 * ── "Mi trabajo" es un espacio, no una ficha ────────────────────────────────────────────────
 * Muestra lo que le toca HACER a la persona (`GET /users/me/work`), con dos etiquetas que no se
 * mezclan: lo que está **a tu nombre** (la fila trae tu `user_id`) y lo que está **en tus
 * bandejas** (cola compartida que abre tu permiso, que nadie repartió). Medido en prod: las tres
 * tablas de asignación nominal están en CERO filas — o sea que hoy nadie delega trabajo, y la
 * pantalla lo DICE en vez de disfrazar una cola de asignación personal.
 *
 * Tres estados que NO se confunden (ADR-056 / DESIGN pre-vuelo 6):
 *   · permisos `sin_cargar` → skeleton, nunca "no tienes nada";
 *   · error de red → banner de error, nunca "Sin puesto asignado" ni "0 pendientes";
 *   · cero entradas con permisos cargados → estado declarado con salida (cerrar sesión), NO el
 *     redirect ciego a `/dashboard/captures` de antes.
 *
 * Auto-entrada: con UN solo destino primario (kiosco, roles acotados) se entra directo. Escape:
 * `history.state.stay`, que manda el link "Mi trabajo" del sidebar.
 */

type Carga<T> = { status: 'loading' } | { status: 'ok'; data: T } | { status: 'error'; error: string };

interface CeldaContexto {
  etiqueta: string;
  valor: string;
  /** `true` cuando el valor es una declaración de ausencia ("Sin puesto asignado"). */
  ausente?: boolean;
}

const DIMENSIONES_ALCANCE: ReadonlyArray<{ dim: string; etiqueta: string; todo: string; plural: string }> = [
  { dim: 'warehouse', etiqueta: 'Sucursales', todo: 'toda la red', plural: 'sucursales' },
  { dim: 'zone', etiqueta: 'Zonas', todo: 'todas las zonas', plural: 'zonas' },
  { dim: 'route', etiqueta: 'Rutas', todo: 'todas las rutas', plural: 'rutas' },
];

/** Cuántos módulos se nombran en la tarjeta antes de resumir con "+N". */
const MAX_MODULOS_VISIBLES = 4;

@Component({
  selector: 'app-mi-trabajo',
  standalone: true,
  imports: [RouterLink, ButtonModule, LoadStateComponent, HlmBadgeDirective],
  templateUrl: './mi-trabajo.component.html',
  styleUrl: './mi-trabajo.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MiTrabajoComponent {
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly meCtx = inject(MeContextService);
  private readonly scope = inject(DataScopeService);
  private readonly destroyRef = inject(DestroyRef);

  readonly user = this.auth.user;
  readonly landingRoute = LANDING_ROUTE;

  /** `sin_cargar` = todavía no hay mapa con el que decidir: skeleton, no vacío. */
  readonly permisosCargados = computed(() => this.perms.cargado());

  readonly vis = computed<VisibleSuiteMap>(() =>
    visibleSuiteMap(this.user()?.permissions, this.perms.isAdmin(), this.user()?.role_name ?? null),
  );
  readonly espacios = computed(() => this.vis().spaces);
  readonly declarados = computed(() => this.vis().declared);
  readonly destinos = computed(() => primaryDestinations(this.vis()));
  readonly sinEspacios = computed(() => this.permisosCargados() && this.espacios().length === 0);
  /** Con ≥3 espacios, la fila de atajos vale el espacio que ocupa. */
  readonly conAtajos = computed(() => this.espacios().length >= 3);

  readonly contexto = signal<Carga<MeContext>>({ status: 'loading' });
  readonly alcance = signal<Carga<MyScope | null>>({ status: 'loading' });
  readonly trabajo = signal<Carga<MeWork>>({ status: 'loading' });

  /** Derivados: los templates estrictos no estrechan una unión entre dos llamadas a la señal. */
  readonly contextoCargando = computed(() => this.contexto().status === 'loading');
  readonly contextoError = computed(() => {
    const c = this.contexto();
    return c.status === 'error' ? c.error : null;
  });
  readonly trabajoCargando = computed(() => this.trabajo().status === 'loading');
  readonly trabajoError = computed(() => {
    const t = this.trabajo();
    return t.status === 'error' ? t.error : null;
  });

  /** Pendientes partidos en los dos grupos que NO significan lo mismo. */
  private readonly pendientes = computed<readonly MePendiente[]>(() => {
    const t = this.trabajo();
    return t.status === 'ok' ? t.data.pendientes : [];
  });
  readonly mios = computed(() => this.pendientes().filter((p) => p.alcance === 'mio'));
  readonly deBandeja = computed(() => this.pendientes().filter((p) => p.alcance === 'bandeja'));
  readonly sinPendientes = computed(() => this.trabajo().status === 'ok' && this.pendientes().length === 0);
  /** Bandejas que esta persona puede ver y NO se pudieron contar: se declaran, no bajan a cero. */
  readonly noMedido = computed(() => {
    const t = this.trabajo();
    return t.status === 'ok' ? t.data.no_medido : [];
  });

  readonly periodo = new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric' }).format(new Date());

  /** ¿La persona pidió QUEDARSE aunque tenga un solo destino? (link "Mi trabajo" del sidebar). */
  private readonly quedarse = leerStay(this.router);
  private autoEntrada = false;

  constructor() {
    this.cargarContexto();
    this.cargarTrabajo();
    this.scope
      .mine()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data) => this.alcance.set({ status: 'ok', data }),
        error: (e) => this.alcance.set({ status: 'error', error: describirError(e) }),
      });

    // Auto-entrada: UNA sola puerta primaria → adentro, salvo que pidieran quedarse.
    effect(() => {
      if (this.autoEntrada || this.quedarse || !this.permisosCargados()) return;
      const destinos = this.destinos();
      if (destinos.length === 1) {
        this.autoEntrada = true;
        void this.router.navigate([destinos[0]]);
      }
    });
  }

  // ── Mi contexto (tira compacta, no cuatro cajas) ────────────────────────────

  /** El nombre de la persona, no su usuario — si nunca se capturó, el usuario. */
  readonly nombreVisible = computed(() => {
    const ctx = this.contexto();
    const nombre = ctx.status === 'ok' ? ctx.data.nombre?.trim() : null;
    return nombre || this.user()?.username || '';
  });

  readonly celdas = computed<CeldaContexto[]>(() => {
    const ctx = this.contexto();
    if (ctx.status !== 'ok') return [];
    const c = ctx.data;
    const puesto: CeldaContexto = c.position
      ? { etiqueta: 'Puesto', valor: c.position.name }
      : { etiqueta: 'Puesto', valor: 'Sin puesto asignado', ausente: true };
    return [
      puesto,
      { etiqueta: 'Área', valor: c.department?.name ?? 'Sin área', ausente: !c.department },
      this.celdaAlcance(),
      { etiqueta: 'Periodo', valor: capitalizar(this.periodo) },
    ];
  });

  /**
   * El alcance sale de `me/scope` (ADR-050), no de la ficha: la ficha dice dónde está la persona,
   * el alcance dice qué filas puede ver. Cuando el servicio no contestó, se dice eso.
   */
  private celdaAlcance(): CeldaContexto {
    const a = this.alcance();
    if (a.status === 'loading') return { etiqueta: 'Alcance', valor: 'Consultando…' };
    if (a.status === 'error' || !a.data) {
      return { etiqueta: 'Alcance', valor: 'No se pudo consultar', ausente: true };
    }
    const partes: string[] = [];
    for (const d of DIMENSIONES_ALCANCE) {
      const dim = a.data.dimensions?.[d.dim];
      if (!dim) continue;
      partes.push(describirDimension(dim, d.todo, d.plural));
    }
    return partes.length
      ? { etiqueta: 'Alcance', valor: partes.join(' · ') }
      : { etiqueta: 'Alcance', valor: 'Sin dimensiones declaradas', ausente: true };
  }

  // ── Mis espacios ────────────────────────────────────────────────────────────

  /** "Bancos · Cobranza · Cartera · +4" — los módulos que ESTA persona puede abrir. */
  lineaModulos(labels: readonly string[]): string {
    if (!labels.length) return '';
    const visibles = labels.slice(0, MAX_MODULOS_VISIBLES);
    const resto = labels.length - visibles.length;
    return resto > 0 ? `${visibles.join(' · ')} · +${resto}` : visibles.join(' · ');
  }

  saltarA(ev: Event, id: string): void {
    ev.preventDefault();
    document.getElementById(`espacio-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── Carga ───────────────────────────────────────────────────────────────────

  recargarContexto(): void {
    this.meCtx.reset();
    this.cargarContexto();
  }

  private cargarContexto(): void {
    this.contexto.set({ status: 'loading' });
    this.meCtx
      .mine()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data) => this.contexto.set({ status: 'ok', data }),
        error: (e) => this.contexto.set({ status: 'error', error: describirError(e) }),
      });
  }

  cargarTrabajo(): void {
    this.trabajo.set({ status: 'loading' });
    this.meCtx
      .work()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data) => this.trabajo.set({ status: 'ok', data }),
        error: (e) => this.trabajo.set({ status: 'error', error: describirError(e) }),
      });
  }

  logout(): void {
    this.auth.logout();
    void this.router.navigate(['/login']);
  }
}

/** `history.state.stay` — el sidebar navega con `state: { stay: true }` para que N=1 no rebote. */
function leerStay(router: Router): boolean {
  const nav = router.getCurrentNavigation()?.extras?.state as { stay?: unknown } | undefined;
  if (nav?.stay === true) return true;
  try {
    return (history.state as { stay?: unknown } | null)?.stay === true;
  } catch {
    return false;
  }
}

function describirDimension(dim: ScopeDim, todo: string, plural: string): string {
  if (dim.mode === 'all') return todo;
  if (dim.mode === 'none') return 'sin alcance';
  if (dim.resolvable === false) return 'sin determinar (ficha incompleta)';
  const nombres = (dim.options ?? []).map((o) => o.label).filter(Boolean);
  if (!nombres.length) return dim.mode === 'own' ? 'la propia' : 'sin determinar';
  if (nombres.length <= 2) return nombres.join(', ');
  return `${nombres.length} ${plural}`;
}

function describirError(e: unknown): string {
  const status = (e as { status?: number } | null)?.status;
  if (status === 0) return 'Sin conexión con el servidor.';
  if (status === 404) return 'El servidor no tiene este servicio (falta actualizar la API).';
  if (status) return `El servidor respondió ${status}.`;
  return 'Error desconocido.';
}

function capitalizar(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
