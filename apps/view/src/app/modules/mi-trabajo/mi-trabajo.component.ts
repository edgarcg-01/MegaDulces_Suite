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
import type { MeContext } from '@megadulces/contracts';
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
 * `[SN.3]` — "Mi trabajo": la landing de la plataforma web (`/projects`).
 *
 * Reemplaza al catálogo de 11 tarjetas con `anyOf` escritos a mano. Lo que se ve sale de DOS
 * fuentes y de ninguna lista propia:
 *   · `SUITE_SPACES` (`libs/contracts`) — los 10 espacios de la especificación de Dirección sobre
 *     `AUTHZ_TREE`; la visibilidad de cada entrada se DERIVA de los permisos de sus módulos con
 *     ruta (ADR-061). La línea secundaria de cada fila lista los módulos que ESTA persona puede
 *     abrir — no una descripción a mano que envejece (§13 de la spec juzgó Finanzas por una).
 *   · `GET /users/me/context` + `GET /users/me/scope` — persona, puesto, alcance de la FICHA.
 *
 * Tres estados que NO se confunden (ADR-056 / DESIGN pre-vuelo 6):
 *   · permisos `sin_cargar` → skeleton, nunca "no tienes nada";
 *   · error de red al pedir el contexto → banner de error, nunca "Sin puesto asignado";
 *   · cero entradas con permisos cargados → estado declarado ("tu cuenta no tiene ningún espacio")
 *     con salida (cerrar sesión), NO el redirect ciego a `/dashboard/captures` de antes — que el
 *     comentario `[AUTHZ.6]` de la tarjeta vieja ya documentaba como daño.
 *
 * Auto-entrada: con UN solo destino primario (kiosco, roles acotados) se entra directo, como hacía
 * la landing vieja. Escape: `history.state.stay` (el link "Mi trabajo" del sidebar lo manda) para
 * que la pantalla siga siendo alcanzable para esa persona.
 *
 * Lo que la spec pide y todavía NO existe (indicadores con ficha, compromisos, excepciones) se
 * DECLARA en un bloque, con sus decisiones pendientes (P-06, P-01). No se dibujan cuatro cajas
 * vacías ni se estrena la cabecera de Dirección sobre nada.
 */

type Carga<T> = { status: 'loading' } | { status: 'ok'; data: T } | { status: 'error'; error: string };

interface CeldaContexto {
  etiqueta: string;
  valor: string;
  /** Segunda línea, más apagada. */
  detalle?: string;
  /** `true` cuando el valor es una declaración de ausencia ("Sin puesto asignado"). */
  ausente?: boolean;
}

const DIMENSIONES_ALCANCE: ReadonlyArray<{ dim: string; etiqueta: string; todo: string; plural: string }> = [
  { dim: 'warehouse', etiqueta: 'Sucursales', todo: 'toda la red', plural: 'sucursales' },
  { dim: 'zone', etiqueta: 'Zonas', todo: 'todas las zonas', plural: 'zonas' },
  { dim: 'route', etiqueta: 'Rutas', todo: 'todas las rutas', plural: 'rutas' },
];

/** Cuántos módulos se listan por fila antes de resumir con "+N". */
const MAX_MODULOS_VISIBLES = 5;

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

  /** `sin_cargar` = todavía no hay mapa con el que decidir: se muestra skeleton, no vacío. */
  readonly permisosCargados = computed(() => this.perms.cargado());

  /**
   * El mapa visible. Lee el mapa de permisos que `AuthService` mantiene sincronizado con
   * `PermissionsService` (`aplicarAcceso` actualiza los dos) y el god-mode por nombre de rol.
   */
  readonly vis = computed<VisibleSuiteMap>(() =>
    visibleSuiteMap(this.user()?.permissions, this.perms.isAdmin(), this.user()?.role_name ?? null),
  );
  readonly espacios = computed(() => this.vis().spaces);
  readonly declarados = computed(() => this.vis().declared);
  readonly destinos = computed(() => primaryDestinations(this.vis()));
  readonly sinEspacios = computed(() => this.permisosCargados() && this.espacios().length === 0);
  /** Con ≥3 espacios, la fila de atajos (móvil) vale el espacio que ocupa. */
  readonly conAtajos = computed(() => this.espacios().length >= 3);

  readonly contexto = signal<Carga<MeContext>>({ status: 'loading' });
  readonly alcance = signal<Carga<MyScope | null>>({ status: 'loading' });
  /** Derivados para el template: los templates estrictos no estrechan una unión entre dos llamadas a la señal. */
  readonly contextoCargando = computed(() => this.contexto().status === 'loading');
  readonly contextoError = computed(() => {
    const c = this.contexto();
    return c.status === 'error' ? c.error : null;
  });

  readonly periodo = new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric' }).format(new Date());

  /** ¿La persona pidió QUEDARSE aunque tenga un solo destino? (link "Mi trabajo" del sidebar). */
  private readonly quedarse = leerStay(this.router);
  private autoEntrada = false;

  constructor() {
    this.meCtx
      .mine()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data) => this.contexto.set({ status: 'ok', data }),
        error: (e) => this.contexto.set({ status: 'error', error: describirError(e) }),
      });
    this.scope
      .mine()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data) => this.alcance.set({ status: 'ok', data }),
        error: (e) => this.alcance.set({ status: 'error', error: describirError(e) }),
      });

    // Auto-entrada: UNA sola puerta primaria → adentro, salvo que pidieran quedarse. Corre cuando
    // los permisos ya cargaron; una sola vez.
    effect(() => {
      if (this.autoEntrada || this.quedarse || !this.permisosCargados()) return;
      const destinos = this.destinos();
      if (destinos.length === 1) {
        this.autoEntrada = true;
        void this.router.navigate([destinos[0]]);
      }
    });
  }

  // ── Mi contexto ─────────────────────────────────────────────────────────────

  readonly celdas = computed<CeldaContexto[]>(() => {
    const ctx = this.contexto();
    if (ctx.status !== 'ok') return [];
    const c = ctx.data;
    const persona: CeldaContexto = {
      etiqueta: 'Persona',
      valor: c.nombre?.trim() || c.username,
      detalle: c.nombre?.trim() ? `${c.username} · ${c.role_name ?? 'sin rol'}` : (c.role_name ?? 'sin rol'),
    };
    const puesto: CeldaContexto = c.position
      ? { etiqueta: 'Puesto', valor: c.position.name, detalle: c.department?.name }
      : {
          etiqueta: 'Puesto',
          valor: 'Sin puesto asignado',
          detalle: c.department?.name ?? 'Se asigna desde Configuración de la suite › Usuarios',
          ausente: true,
        };
    return [persona, puesto, this.celdaAlcance(c), {
      etiqueta: 'Periodo',
      valor: capitalizar(this.periodo),
      detalle: 'mes calendario · corte por definir (P-11)',
    }];
  });

  /**
   * El alcance sale de `me/scope` (ADR-050), no de la ficha: la ficha dice dónde está la persona,
   * el alcance dice qué filas puede ver. Cuando el servicio no contestó, se dice eso — no se
   * pinta "toda la red" ni "sin alcance".
   */
  private celdaAlcance(c: MeContext): CeldaContexto {
    const a = this.alcance();
    if (a.status === 'loading') return { etiqueta: 'Alcance', valor: 'Consultando…' };
    if (a.status === 'error' || !a.data) {
      return { etiqueta: 'Alcance', valor: 'No se pudo consultar', detalle: 'el servicio de alcance no contestó', ausente: true };
    }
    const partes: string[] = [];
    for (const d of DIMENSIONES_ALCANCE) {
      const dim = a.data.dimensions?.[d.dim];
      if (!dim) continue;
      partes.push(`${d.etiqueta}: ${describirDimension(dim, d.todo, d.plural)}`);
    }
    const ficha = [c.warehouse_code ? `sucursal ${c.warehouse_code}` : null, c.zona ? `zona ${c.zona}` : null]
      .filter(Boolean)
      .join(' · ');
    return {
      etiqueta: 'Alcance',
      valor: partes.length ? partes.join(' · ') : 'Sin dimensiones declaradas',
      detalle: ficha ? `Ficha: ${ficha}` : undefined,
      ausente: partes.length === 0,
    };
  }

  // ── Mi operación ────────────────────────────────────────────────────────────

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

  recargarContexto(): void {
    this.meCtx.reset();
    this.contexto.set({ status: 'loading' });
    this.meCtx
      .mine()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data) => this.contexto.set({ status: 'ok', data }),
        error: (e) => this.contexto.set({ status: 'error', error: describirError(e) }),
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
  if (nombres.length <= 3) return nombres.join(', ');
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
