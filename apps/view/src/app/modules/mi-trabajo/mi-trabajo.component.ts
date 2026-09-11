import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  viewChild,
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
 * `[SN.3]` `[SN.8]` `[SN.9]` — "Mi trabajo": la landing de la plataforma web (`/projects`).
 *
 * ── Historia de dos correcciones ────────────────────────────────────────────────────────────
 * SN.3 tiró la tarjeta y puso filas de texto. Edgar lo rechazó: el diseño de los módulos ya era
 * correcto, lo que había que cambiar eran los nombres y las posiciones. SN.8 devolvió la tarjeta
 * agrupada por espacio. SN.9 la aprieta: **todo en una pantalla, sin scroll** (objetivo 1920×1080),
 * con un **buscador** como centro de gravedad. El precio elegido a conciencia: la tarjeta pierde
 * la descripción larga y queda en chip de icono + nombre + una línea de módulos.
 *
 * ── Por qué el buscador es de cliente ───────────────────────────────────────────────────────
 * Lo que busca —módulos y bandejas— **ya está en memoria**: el mapa de la suite se resuelve en el
 * navegador y los pendientes vienen de una sola llamada. Un endpoint no lo haría más rápido, sólo
 * más frágil. Reimplementa en chico lo que `applySmartSearch` hace en Postgres: sin acentos y
 * multi-token en cualquier orden (lo que NO hace es tolerar typos — eso necesita pg_trgm).
 * Buscar entidades de negocio (clientes, folios, productos) es otra capa y otro endpoint.
 *
 * ── Lo que sigue valiendo de SN.7/SN.8 ──────────────────────────────────────────────────────
 * "Mi trabajo" es el primer bloque y trae los pendientes de `GET /users/me/work`, separando lo que
 * está **a tu nombre** de lo que está **en una cola compartida** — medido en prod: las tres tablas
 * de asignación nominal están en cero filas, o sea que hoy nadie reparte trabajo. Una bandeja en 0
 * no se pinta; la que no se pudo contar se declara. Tres estados que no se confunden: permisos
 * `sin_cargar` → skeleton (nunca "no tienes nada"), error de red → error (nunca vacío), cero
 * puertas → estado declarado con salida (nunca el redirect ciego a captures). N=1 destino primario
 * → auto-entra salvo `history.state.stay`.
 */

type Carga<T> = { status: 'loading' } | { status: 'ok'; data: T } | { status: 'error'; error: string };

interface CeldaContexto {
  etiqueta: string;
  valor: string;
  /** `true` cuando el valor es una declaración de ausencia ("Sin puesto asignado"). */
  ausente?: boolean;
}

/** Una entrada ya lista para pintar, con su haystack de búsqueda precalculado. */
interface EntradaVisible {
  id: string;
  label: string;
  icon: string;
  route: string;
  groupLabel: string;
  modulos: string;
  esAtajo: boolean;
  buscable: string;
}

interface EspacioVisible {
  id: string;
  label: string;
  icon: string;
  status: string;
  proposal?: string;
  entradas: EntradaVisible[];
}

const DIMENSIONES_ALCANCE: ReadonlyArray<{ dim: string; todo: string; plural: string }> = [
  { dim: 'warehouse', todo: 'toda la red', plural: 'sucursales' },
  { dim: 'zone', todo: 'todas las zonas', plural: 'zonas' },
  { dim: 'route', todo: 'todas las rutas', plural: 'rutas' },
];

/** Cuántos módulos se nombran en la tarjeta compacta antes de resumir con "+N". */
const MAX_MODULOS_VISIBLES = 3;

/** Sin acentos y en minúsculas — el mismo criterio que `public.f_unaccent` en el backend. */
function normalizar(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

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

  private readonly cajaBusqueda = viewChild<ElementRef<HTMLInputElement>>('buscador');

  readonly user = this.auth.user;
  readonly landingRoute = LANDING_ROUTE;

  /** `sin_cargar` = todavía no hay mapa con el que decidir: skeleton, no vacío. */
  readonly permisosCargados = computed(() => this.perms.cargado());

  private readonly vis = computed<VisibleSuiteMap>(() =>
    visibleSuiteMap(this.user()?.permissions, this.perms.isAdmin(), this.user()?.role_name ?? null),
  );
  readonly declarados = computed(() => this.vis().declared);
  readonly destinos = computed(() => primaryDestinations(this.vis()));

  /** Los espacios ya aplanados, con el texto contra el que busca el filtro. */
  private readonly espaciosTodos = computed<EspacioVisible[]>(() =>
    this.vis().spaces.map((s) => ({
      id: s.space.id,
      label: s.space.label,
      icon: s.space.icon,
      status: s.space.status,
      proposal: s.space.proposal,
      entradas: s.entries.map((e) => {
        const modulos = this.lineaModulos(e.modules.map((m) => m.label));
        return {
          id: e.entry.id,
          label: e.label,
          icon: e.icon,
          route: e.route,
          groupLabel: e.groupLabel,
          modulos,
          esAtajo: !!e.entry.crossLink,
          // El haystack incluye los módulos: "bancos" tiene que encontrar Finanzas.
          buscable: normalizar([e.label, e.groupLabel, s.space.label, e.modules.map((m) => m.label).join(' ')].join(' ')),
        };
      }),
    })),
  );

  readonly sinEspacios = computed(() => this.permisosCargados() && this.espaciosTodos().length === 0);

  // ── Buscador ────────────────────────────────────────────────────────────────

  readonly consulta = signal('');
  /** Tokens normalizados; un espacio de más no cambia el resultado. */
  private readonly tokens = computed(() => normalizar(this.consulta()).split(/\s+/).filter(Boolean));
  readonly buscando = computed(() => this.tokens().length > 0);

  /** Multi-token en cualquier orden: se exigen TODOS (AND), como `applySmartSearch`. */
  private casa(heno: string): boolean {
    const t = this.tokens();
    return t.length === 0 || t.every((tok) => heno.includes(tok));
  }

  readonly espacios = computed<EspacioVisible[]>(() => {
    if (!this.buscando()) return this.espaciosTodos();
    return this.espaciosTodos()
      .map((s) => ({ ...s, entradas: s.entradas.filter((e) => this.casa(e.buscable)) }))
      .filter((s) => s.entradas.length > 0);
  });

  readonly totalEntradas = computed(() => this.espaciosTodos().reduce((n, s) => n + s.entradas.length, 0));
  readonly entradasVisibles = computed(() => this.espacios().reduce((n, s) => n + s.entradas.length, 0));
  /** Buscando y sin una sola coincidencia: se dice, no se deja la pantalla en blanco. */
  readonly sinCoincidencias = computed(
    () => this.buscando() && this.entradasVisibles() === 0 && this.pendientes().length === 0,
  );

  /** Enter va al primer resultado — el que está arriba a la izquierda. */
  irAlPrimero(): void {
    const primera = this.espacios()[0]?.entradas[0];
    if (primera) {
      void this.router.navigate([primera.route]);
      return;
    }
    const p = this.pendientes()[0];
    if (p) void this.router.navigate([p.ruta]);
  }

  limpiar(): void {
    this.consulta.set('');
    this.enfocarBuscador();
  }

  enfocarBuscador(): void {
    this.cajaBusqueda()?.nativeElement.focus();
  }

  /** Ctrl/⌘+K desde cualquier parte de la pantalla, y `/` cuando no se está escribiendo. */
  @HostListener('document:keydown', ['$event'])
  atajoTeclado(ev: KeyboardEvent): void {
    const enCampo = ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      this.enfocarBuscador();
      return;
    }
    if (ev.key === '/' && !enCampo) {
      ev.preventDefault();
      this.enfocarBuscador();
      return;
    }
    if (ev.key === 'Escape' && enCampo && this.consulta()) {
      ev.preventDefault();
      this.consulta.set('');
    }
  }

  // ── Estado remoto ───────────────────────────────────────────────────────────

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

  /** Pendientes, filtrados por el buscador igual que los módulos. */
  readonly pendientes = computed<readonly MePendiente[]>(() => {
    const t = this.trabajo();
    const todos = t.status === 'ok' ? t.data.pendientes : [];
    if (!this.buscando()) return todos;
    return todos.filter((p) => this.casa(normalizar(`${p.label} ${p.detalle}`)));
  });
  readonly mios = computed(() => this.pendientes().filter((p) => p.alcance === 'mio'));
  readonly deBandeja = computed(() => this.pendientes().filter((p) => p.alcance === 'bandeja'));
  readonly sinPendientes = computed(
    () => this.trabajo().status === 'ok' && !this.buscando() && this.pendientes().length === 0,
  );
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

  // ── Mi contexto (una tira, no cuatro cajas) ─────────────────────────────────

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

  // ── Utilidades ──────────────────────────────────────────────────────────────

  /** "Bancos · Cobranza · Cartera · +4" — los módulos que ESTA persona puede abrir. */
  lineaModulos(labels: readonly string[]): string {
    if (!labels.length) return '';
    const visibles = labels.slice(0, MAX_MODULOS_VISIBLES);
    const resto = labels.length - visibles.length;
    return resto > 0 ? `${visibles.join(' · ')} · +${resto}` : visibles.join(' · ');
  }

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
