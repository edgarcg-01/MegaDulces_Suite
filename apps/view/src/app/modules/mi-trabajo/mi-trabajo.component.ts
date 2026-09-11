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
import { UsoService } from '../../core/services/uso.service';
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
 * `[SN.3]` `[SN.8]` `[SN.9]` `[SN.11]` — "Mi trabajo": la landing de la plataforma web (`/projects`).
 *
 * ── Historia de tres correcciones ───────────────────────────────────────────────────────────
 * SN.3 tiró la tarjeta y puso filas de texto. Edgar lo rechazó: el diseño de los módulos ya era
 * correcto, lo que había que cambiar eran los nombres y las posiciones. SN.8 devolvió la tarjeta
 * agrupada por espacio. SN.9 la apretó —todo en una pantalla, sin scroll— y SN.10 arregló nueve
 * defectos de esa compresión, pero la pantalla se rechazó igual.
 *
 * ── SN.11: por qué apretar nunca iba a alcanzar ─────────────────────────────────────────────
 * Las dos versiones rechazadas eran la MISMA apuesta: que la pantalla FUERA el menú. Las 22 puertas
 * ocupaban el lienzo y el trabajo quedaba exprimido en una tira de píldoras. Los productos que
 * resuelven este problema hacen lo contrario — SAP Fiori "My Home" (que llama *Spaces* a lo mismo
 * que acá son espacios) ordena **To-Dos → Pages → Apps**; Asana y Height abren con lo personal y
 * dejan lo organizacional a un clic; Humand pone a la persona arriba y la navegación en un riel.
 * Decisión de Edgar (2026-09-11, sobre tres maquetas a escala): **dos columnas mitad y mitad**,
 * el trabajo fijo a la izquierda y las puertas rodando a la derecha; nada se corta para caber.
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
  /**
   * `[SN.11]` El grupo, recortado a dos niveles para la línea superior de la tarjeta. El completo
   * («Ventas › Mayoreo › Atención telefónica / Telemarketing») no cabe y tampoco aporta: el tercer
   * nivel repite el nombre de la entrada. El completo sigue vivo en `groupLabel` para el `title`
   * y para el haystack del buscador.
   */
  grupo: string;
  /** `[SN.12]` El tono propio de este módulo, que aparece al señalarlo. Ver `COLOR_ENTRADA`. */
  color: string;
  /**
   * `[SN.10]` La segunda línea de la tarjeta. Para una entrada de proyecto son los módulos que
   * ESTA persona puede abrir; para un módulo enlazado, de qué proyecto sale ("de Finanzas") — que
   * es lo único que distingue dos «Hallazgos» pegados. Vacía si repetiría el título.
   */
  detalle: string;
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

/**
 * `[SN.12]` Un color por MÓDULO, y sólo en hover.
 *
 * DESIGN.md prohíbe decorar con color y lista como antipatrón el «ícono en círculo de color»; lo
 * que prohíbe es el ornamento EN REPOSO. Acá el color no adorna: identifica la puerta que estás por
 * abrir, y sólo aparece mientras la señalás. En reposo la tarjeta sigue siendo hairline
 * monocromática. Sale de las rampas `--chart-*` y `--avatar-*` —la excepción ya declarada del
 * sistema, «el color codifica dato»— y NUNCA de un hex inventado.
 *
 * Tres reglas al asignarlos:
 *  · se mapea por **id de entrada**, no por posición: si cambia el orden de §5.1, Finanzas sigue
 *    siendo del mismo verde y la memoria de quien lo usa a diario no se rompe;
 *  · dentro de un mismo espacio **no se repite ninguno** — es donde el ojo compara. Entre espacios
 *    distintos sí, porque están separados por su encabezado y su regla;
 *  · **sin morado**: `--avatar-4` queda fuera a propósito. DESIGN.md lo veta como identidad de IA,
 *    y la entrada que más lo pediría (Supervisor AI / Horus) es justamente la que no debe llevarlo.
 */
const COLOR_ENTRADA: Readonly<Record<string, string>> = {
  // Dirección General
  'dg-centro-de-control': 'var(--chart-2)',
  // Comercial
  'ventas-backoffice': 'var(--chart-1)',
  'pisos-de-venta': 'var(--chart-7)',
  'mayoreo-telemarketing': 'var(--chart-4)',
  'rutas-auditoria': 'var(--chart-3)',
  compras: 'var(--chart-5)',
  'mkt-promociones': 'var(--avatar-7)',
  'mkt-erp-promos': 'var(--avatar-2)',
  // Almacenes y Logística
  almacenes: 'var(--chart-6)',
  'transporte-y-embarques': 'var(--avatar-5)',
  'entregas-reparto': 'var(--chart-2)',
  // Administración y Finanzas
  finanzas: 'var(--chart-3)',
  contabilidad: 'var(--avatar-3)',
  // Auditoría, Prevención y Control
  'apc-prevencion-inventarios': 'var(--avatar-6)',
  'apc-cuadre': 'var(--chart-7)',
  'apc-hallazgos-finanzas': 'var(--chart-5)',
  'apc-hallazgos-compras': 'var(--avatar-1)',
  'apc-supervisor-ai': 'var(--chart-4)',
  // Configuración de la suite
  'configuracion-suite': 'var(--chart-8)',
  'mkt-planograma': 'var(--avatar-8)',
  'mkt-scoring': 'var(--chart-1)',
  'mkt-catalogos-captura': 'var(--avatar-2)',
};
const DIMENSIONES_ALCANCE: ReadonlyArray<{ dim: string; todo: string; plural: string }> = [
  { dim: 'warehouse', todo: 'toda la red', plural: 'sucursales' },
  { dim: 'zone', todo: 'todas las zonas', plural: 'zonas' },
  { dim: 'route', todo: 'todas las rutas', plural: 'rutas' },
];

/**
 * Cuántos módulos se nombran en la tarjeta antes de resumir con "+N".
 * `[SN.11]` Subió a 4 con el argumento de que la columna había ganado ancho, y la medición en vivo
 * lo desmintió: la tarjeta queda en su mínimo de 249 px y 9 de 21 segundas líneas se cortaban — las
 * mismas 9 con 3 que con 4. Vuelve a 3 y el arreglo real va en el CSS (dos renglones).
 */
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
  private readonly uso = inject(UsoService);
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
        // Un módulo enlazado no tiene submódulos que listar; lo útil es de dónde sale.
        const detalle = modulos || (e.origin ? `de ${e.origin}` : '');
        return {
          id: e.entry.id,
          label: e.label,
          icon: e.icon,
          route: e.route,
          groupLabel: e.groupLabel,
          grupo: e.groupLabel ? e.groupLabel.split(' › ').slice(0, 2).join(' › ') : '',
          color: COLOR_ENTRADA[e.entry.id] ?? 'var(--action)',
          // Repetir el título en la segunda línea ("Telemarketing / Telemarketing") no informa.
          detalle: normalizar(detalle) === normalizar(e.label) ? '' : detalle,
          // El haystack incluye los módulos y el origen: "bancos" tiene que encontrar Finanzas.
          buscable: normalizar(
            [e.label, e.groupLabel, s.space.label, e.origin ?? '', e.modules.map((m) => m.label).join(' ')].join(' '),
          ),
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
  /**
   * `[SN.13]` El titular de la columna. Medido antes de ponerlo: la columna de trabajo tenía **0**
   * objetos con superficie propia contra 30 de la de puertas, y su cifra más grande era de 18 px —
   * 5 más que el título de una tarjeta. El dato por el que existe la pantalla pesaba como una
   * etiqueta. Es la ÚNICA headline metric de la vista, que es lo que DESIGN.md permite.
   *
   * Suma filas de colas distintas a propósito y se rotula literal — "pendientes en N bandejas" —
   * porque eso es lo que cuenta: cuántas cosas esperan, no un indicador de negocio.
   */
  readonly totalPendientes = computed(() => this.deBandeja().reduce((n, p) => n + p.total, 0));
  readonly bandejasConTrabajo = computed(() => this.deBandeja().length);
  readonly totalMio = computed(() => this.mios().reduce((n, p) => n + p.total, 0));

  readonly sinPendientes = computed(
    () => this.trabajo().status === 'ok' && !this.buscando() && this.pendientes().length === 0,
  );
  /** Bandejas que esta persona puede ver y NO se pudieron contar: se declaran, no bajan a cero. */
  readonly noMedido = computed(() => {
    const t = this.trabajo();
    return t.status === 'ok' ? t.data.no_medido : [];
  });

  /**
   * `[SN.11]` Cuándo se contó, del `medido_at` que manda el servidor. Se muestra la HORA, no un
   * "hace N minutos": el relativo se calcula restando el reloj del navegador y la Fase VP ya midió
   * 21 píldoras de la app diciendo "actualizado hace 2 min" sin ninguna medición detrás (ADR-056).
   * Una hora absoluta no se puede falsear por desfase de relojes. Si no vino, se declara.
   */
  readonly medidoAt = computed<string | null>(() => {
    const t = this.trabajo();
    return t.status === 'ok' ? t.data.medido_at ?? null : null;
  });
  readonly horaConteo = computed<string | null>(() => {
    const iso = this.medidoAt();
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit' }).format(d);
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

  /** `[SN.11]` Dos letras para la marca de identidad de la cabecera. Nunca una foto: no existe. */
  readonly iniciales = computed(() => {
    const partes = this.nombreVisible().split(/\s+/).filter(Boolean);
    if (!partes.length) return '··';
    const letras = partes.length === 1 ? partes[0].slice(0, 2) : partes[0][0] + partes[1][0];
    return letras.toUpperCase();
  });

  readonly celdas = computed<CeldaContexto[]>(() => {
    const ctx = this.contexto();
    if (ctx.status !== 'ok') return [];
    const c = ctx.data;
    const puesto: CeldaContexto = c.position
      ? { etiqueta: 'Puesto', valor: c.position.name }
      : { etiqueta: 'Puesto', valor: 'Sin puesto asignado', ausente: true };
    const celdas = [puesto];
    // `[SN.10]` "PUESTO Sistemas · ÁREA Sistemas" decía lo mismo dos veces y le robaba ancho al
    // alcance, que es el dato que sí cambia entre personas.
    const area = c.department?.name;
    if (area && area !== c.position?.name) celdas.push({ etiqueta: 'Área', valor: area });
    else if (!area) celdas.push({ etiqueta: 'Área', valor: 'Sin área', ausente: true });
    celdas.push(this.celdaAlcance(), { etiqueta: 'Periodo', valor: capitalizar(this.periodo) });
    return celdas;
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

  /**
   * `[SN.12]` Deja constancia de lo que esta persona abre desde la landing, para poder ordenarle
   * la pantalla por lo que de verdad usa. Es un efecto secundario del clic: no bloquea la
   * navegación y no falla nunca hacia afuera. Se registra el DESTINO, nunca lo que escribe en el
   * buscador.
   */
  abrioPuerta(e: EntradaVisible, s: EspacioVisible): void {
    this.uso.registrarApertura('puerta', e.id, { espacio: s.id, ruta: e.route });
  }

  abrioBandeja(p: MePendiente): void {
    this.uso.registrarApertura('bandeja', p.id, { alcance: p.alcance, ruta: p.ruta });
  }

  /** `[SN.11]` 1865 → "1,865". Cifras alineadas (tabular-nums lo hace en CSS); el separador acá. */
  formatoTotal(n: number): string {
    return new Intl.NumberFormat('es-MX').format(n);
  }

  /**
   * `[SN.12]` Hace cuánto entró el pendiente más viejo de la cola. Es lo que ordena la bandeja:
   * el volumen mide tamaño, no urgencia. Lo que no vino fechado se DECLARA — "sin fechar" — en
   * vez de pasar por recién llegado (ADR-056).
   */
  antiguedad(p: MePendiente): string {
    if (!p.mas_viejo_at) return 'sin fechar';
    const ms = Date.now() - Date.parse(p.mas_viejo_at);
    if (!Number.isFinite(ms) || ms < 0) return 'sin fechar';
    const dias = Math.floor(ms / 86_400_000);
    if (dias >= 365) return `${Math.floor(dias / 365)} a`;
    if (dias >= 1) return `${dias} d`;
    const horas = Math.floor(ms / 3_600_000);
    return horas >= 1 ? `${horas} h` : 'hoy';
  }

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
