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
import { filter, throttleTime } from 'rxjs/operators';
import { asyncScheduler } from 'rxjs';
import { Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import type {
  MeCanal,
  MeCiclo,
  MeContext,
  MePendiente,
  MePeriodo,
  MeTarea,
  MeWork,
  MeZona,
  MeZonaPeriodo,
} from '@megadulces/contracts';
import { AuthService } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { MeContextService } from '../../core/services/me-context.service';
import { StoreSocketService } from '../tienda/store-socket.service';
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
import { PeriodoStripComponent } from './periodo-strip.component';

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
  /*
   * `[SN.25]` Acá vivía `color`: un tono por módulo que pintaba el chip en hover.
   *
   * Se retiró con el mapa `COLOR_ENTRADA` entero. La justificación que tenía —«sólo en hover, en
   * reposo es monocromática»— defendía el momento, no el criterio: ese color **no codificaba ningún
   * dato**, era arbitrario por id, y DESIGN.md Q.6 pide tinte o borde, nunca fill saturado, y
   * siempre con leyenda. Un color que hay que explicar no está codificando nada.
   */
  /**
   * `[SN.10]` La segunda línea de la tarjeta. Para una entrada de proyecto son los módulos que
   * ESTA persona puede abrir; para un módulo enlazado, de qué proyecto sale ("de Finanzas") — que
   * es lo único que distingue dos «Hallazgos» pegados. Vacía si repetiría el título.
   */
  detalle: string;
  buscable: string;
  /**
   * `[SN.25]` **Esta entrada no es un módulo: es un submódulo de otro módulo, sacado a la portada.**
   *
   * Medido contra el árbol: **10 de las 22 tarjetas** son esto. «Promociones» y «Promos del ERP» ya
   * están dentro de Ventas; «Prevención» y «Cuadre» dentro de Almacén; «Planogramas», «Scoring»,
   * «Catálogos de captura» y «Supervisor AI» dentro de Auditoría en Ruta. Y por eso hay **dos
   * «Hallazgos» idénticos**: uno es el de Finanzas y el otro el de Compras.
   *
   * Hasta ahora llevaban el mismo cuerpo, el mismo tamaño y el mismo peso que un módulo de 21
   * submódulos. Con esto se pintan distinto y dicen de dónde salen.
   */
  esAlias: boolean;
  /** `[SN.25]` Una sola línea, la que distingue. Truncada con puntos suspensivos, nunca dos renglones. */
  sub: string;
  /** `[SN.25]` Cuántos submódulos abre esta persona acá. `0` en un acceso directo. */
  nSub: number;
}

/**
 * `[SN.25]` Un submódulo como destino del buscador. Los 101 traen ruta propia (verificado contra el
 * árbol), así que `Ctrl K` deja de encontrar sólo los 22 módulos y encuentra **todo**: escribir
 * «Clientes 360» ya no te deja en Ventas para que busques adentro, te lleva ahí.
 */
interface SubHallado {
  id: string;
  label: string;
  route: string;
  modulo: string;
  buscable: string;
}

/** `[SN.25]` Cuántos accesos recientes se muestran, y cuántos se recuerdan. */
const MAX_ACCESOS = 6;
const MAX_RECORDADOS = 12;
/** Tope de submódulos que el buscador lista: más que esto deja de ser una lista y es un volcado. */
const MAX_SUBMODULOS = 24;
const CLAVE_RECIENTES = 'mt.accesos.v1';

/**
 * `[SN.25]` Lee los accesos recientes del navegador.
 *
 * ⛔ Siempre en `try/catch`: en una ventana privada o con los datos del sitio bloqueados, el mero
 * ACCESO a `localStorage` tira excepción — no devuelve vacío. Y el peor caso tiene que ser que la
 * fila no aparezca, nunca que la pantalla no cargue.
 */
function leerRecientes(): string[] {
  try {
    const raw = localStorage.getItem(CLAVE_RECIENTES);
    const v: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(v)) return [];
    /*
     * ⚠️ Se deduplica **al leer**, no sólo al escribir. Lo destapó su propia prueba: `guardarReciente`
     * ya evitaba el repetido, pero un valor viejo o tocado a mano salía con duplicados y la fila
     * mostraba el mismo módulo dos veces. Confiar en que lo escrito siempre esté sano es la clase de
     * supuesto que este repo ya pagó caro.
     */
    return [...new Set(v.filter((x): x is string => typeof x === 'string'))];
  } catch {
    return [];
  }
}

/** Pone `id` al frente, sin repetir, y recorta. Devuelve la lista nueva aunque no se pueda guardar. */
function guardarReciente(id: string, prev: readonly string[]): string[] {
  const lista = [id, ...prev.filter((x) => x !== id)].slice(0, MAX_RECORDADOS);
  try {
    localStorage.setItem(CLAVE_RECIENTES, JSON.stringify(lista));
  } catch {
    /* sin persistencia: la fila igual funciona mientras dure la pestaña */
  }
  return lista;
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
  imports: [RouterLink, ButtonModule, LoadStateComponent, HlmBadgeDirective, PeriodoStripComponent],
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
  /*
   * `[JZ.5]` ⚠️ **Deuda con nombre, no acoplamiento de módulo.** `StoreSocketService` es
   * `providedIn: 'root'` —un singleton de la app por declaración— pero vive físicamente en
   * `modules/tienda/`, y hasta hoy todos sus consumidores estaban ahí adentro. Su casa correcta es
   * `core/services/`; mudarlo toca 8 archivos que otras sesiones están editando, así que se
   * importa desde acá y queda dicho. Lo que NO se hace es abrir un segundo socket: sería una
   * conexión de más por persona para escuchar exactamente los mismos eventos.
   */
  private readonly storeSocket = inject(StoreSocketService);

  private readonly cajaBusqueda = viewChild<ElementRef<HTMLInputElement>>('buscador');

  readonly user = this.auth.user;

  /**
   * `[SN.14]` La tecla que se anuncia tiene que ser la que de verdad funciona. El atajo acepta
   * `metaKey` desde SN.9, así que en Mac ⌘K ya servía — pero la etiqueta decía "Ctrl K" siempre y
   * mentía a media oficina. `navigator.platform` está deprecado; se mira el userAgent con un
   * fallback, y ante la duda queda el rótulo de Windows, que es el parque real de esta suite.
   */
  readonly atajoBuscar = /Mac|iPhone|iPad|iPod/i.test(
    (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || '',
  )
    ? '⌘ K'
    : 'Ctrl K';
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
        /*
         * `[SN.25]` **Una sola línea, y la que distingue.**
         *
         * Antes iban tres módulos y un «+N» — y el corte era POR POSICIÓN, los tres primeros tal
         * como fueron declarados. Medido: «Ventas» tiene 21 submódulos y nombraba tres; el «+18»
         * escondía el 70% del catálogo y no se podía tocar. A 52 px de alto no entra una lista, así
         * que la tarjeta deja de fingir que es un índice: dice **de dónde sale** si es un acceso
         * directo, y **cuántos submódulos abre** si es un módulo. Lo demás lo resuelve `Ctrl K`,
         * que ahora sí llega a los 101.
         */
        const esAlias = !!e.entry.crossLink;
        const sub = esAlias
          ? (e.origin ? `de ${e.origin}` : 'acceso directo')
          : e.modules.length
            ? `${e.modules.length} ${e.modules.length === 1 ? 'submódulo' : 'submódulos'}`
            : '';
        return {
          id: e.entry.id,
          label: e.label,
          icon: e.icon,
          route: e.route,
          groupLabel: e.groupLabel,
          grupo: e.groupLabel ? e.groupLabel.split(' › ').slice(0, 2).join(' › ') : '',
          // Repetir el título en la segunda línea ("Telemarketing / Telemarketing") no informa.
          detalle: normalizar(detalle) === normalizar(e.label) ? '' : detalle,
          esAlias,
          sub,
          nSub: e.modules.length,
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

  /**
   * `[SN.25]` — **«Tus accesos»: lo ÚLTIMO que abriste, no «lo más usado».**
   *
   * El brief pedía los módulos más utilizados (patrón ClickUp). ⛔ **Hoy no se puede, y no se
   * inventa.** El registro de uso escribe de verdad (`UsoService` → `POST /telemetry/suite` →
   * `commercial.portal_telemetry_events`) pero **nadie lo lee**: cero endpoints, cero lectores,
   * instrumentado en una sola pantalla, nacido el 2026-09-11, y la tabla tiene 534 filas casi todas
   * del portal B2B, sin índice por `user_id` y con purga a 90 días. Un «más usado» calculado sobre
   * eso sería un ranking inventado.
   *
   * Lo que SÍ es cierto desde el primer día: lo que esta persona abrió en ESTE navegador. Vive en
   * `localStorage`, arranca **vacía** —y entonces la fila no se dibuja, no se pinta una caja
   * prometiendo algo que no hay— y se llena sola con el uso.
   *
   * ⚠️ `localStorage` puede tirar (ventana privada, datos bloqueados): cada lectura y cada escritura
   * van en `try/catch` y el peor caso es que la fila no aparezca.
   */
  private readonly recientes = signal<string[]>(leerRecientes());

  /** Hasta 6, y sólo las que esta persona TODAVÍA puede abrir: un permiso revocado no deja rastro. */
  readonly accesos = computed<EntradaVisible[]>(() => {
    if (this.buscando()) return [];
    const porId = new Map<string, EntradaVisible>();
    for (const s of this.espaciosTodos()) for (const e of s.entradas) porId.set(e.id, e);
    return this.recientes()
      .map((id) => porId.get(id))
      .filter((e): e is EntradaVisible => !!e)
      .slice(0, MAX_ACCESOS);
  });

  /**
   * `[SN.25]` Los submódulos que casan con la búsqueda. Son 101 y cada uno trae ruta propia, así que
   * `Ctrl K` deja de dejarte en la puerta del módulo para que busques adentro.
   */
  readonly submodulos = computed<SubHallado[]>(() => {
    if (!this.buscando()) return [];
    const out: SubHallado[] = [];
    for (const s of this.vis().spaces) {
      for (const e of s.entries) {
        // Un acceso directo no aporta submódulos: los suyos ya los listó su módulo de origen.
        if (e.entry.crossLink) continue;
        for (const m of e.modules) {
          if (!m.route) continue;
          const heno = normalizar(`${m.label} ${e.label} ${s.space.label}`);
          if (this.casa(heno)) {
            out.push({ id: `${e.entry.id}:${m.id}`, label: m.label, route: m.route, modulo: e.label, buscable: heno });
          }
        }
      }
    }
    return out.slice(0, MAX_SUBMODULOS);
  });

  readonly totalEntradas = computed(() => this.espaciosTodos().reduce((n, s) => n + s.entradas.length, 0));
  readonly entradasVisibles = computed(() => this.espacios().reduce((n, s) => n + s.entradas.length, 0));
  /** Buscando y sin una sola coincidencia: se dice, no se deja la pantalla en blanco. */
  readonly sinCoincidencias = computed(
    () => this.buscando() && this.entradasVisibles() === 0 && this.pendientes().length === 0,
  );

  /**
   * Enter va al primer resultado — el que está arriba a la izquierda.
   *
   * ⚠️ `[SN.25]` Y ahora el primero puede ser un SUBMÓDULO: el bloque de submódulos se pinta antes
   * que los espacios. Lo destapó la prueba de «Enter abre el primer resultado», que quedó roja
   * porque el foco saltaba al primer módulo mientras la pantalla mostraba otra cosa arriba. Enter
   * tiene que abrir **lo que se ve primero**, no lo que el código listó primero.
   */
  irAlPrimero(): void {
    const sub = this.submodulos()[0];
    if (sub) {
      this.abrioSubmodulo(sub);
      void this.router.navigate([sub.route]);
      return;
    }
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

  /**
   * `[JZ.4]` El grano del bloque «Cómo va tu zona». Arranca en `'mes'` porque es la pregunta que
   * el jefe hace primero («¿cómo va el mes?») y la única de las tres que incluye el día de hoy.
   */
  readonly periodoZona = signal<MeZonaPeriodo>('mes');
  readonly PERIODOS: readonly { id: MeZonaPeriodo; label: string; ayuda: string }[] = [
    { id: 'dia', label: 'Día', ayuda: 'El último día cerrado, contra el mismo día de la semana anterior' },
    { id: 'semana', label: 'Semana', ayuda: 'Los últimos 7 días cerrados, contra los 7 anteriores' },
    { id: 'mes', label: 'Mes', ayuda: 'Del día 1 a hoy, contra el mismo tramo del mes pasado' },
  ];

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
   * ⚠️ `[SN.29]` **Lo que cambió es CUÁL número ocupa esos 40 px, y era un defecto de fondo.**
   * Acá iba la suma de `deBandeja()` — o sea, **por construcción, lo único de la pantalla que no
   * es de nadie**. La tesis entera de `[SN.7]`/`[SN.15]`/`[SN.20]` es que «a tu nombre» y «en tus
   * bandejas» no se mezclan, y después la pantalla ponía lo segundo a 40 px y lo primero a 12 px
   * en el subtítulo: en la captura que disparó esta corrección, **1** era tuyo y **2,082** no.
   *
   * Y el 2,082 tampoco era un total honesto: el 89.6 % era una sola cola (`cuadre`) que —medido
   * contra prod— **jamás ha tenido una fila resuelta**. Nadie puede «hacer» 2,082 de nada.
   *
   * El titular pasa a ser lo que esta persona puede TERMINAR: lo asignado + sus borradores. Si es
   * 1, dice 1. El volumen de las colas compartidas sigue visible fila por fila, que es donde se
   * puede juzgar con su veredicto al lado.
   */
  readonly totalPendientes = computed(() => this.totalMio());
  readonly bandejasConTrabajo = computed(() => this.deBandeja().length);
  /** Cuántos items esperan en las colas compartidas. Baja al subtítulo: no es de nadie. */
  readonly totalBandejas = computed(() => this.deBandeja().reduce((n, p) => n + p.total, 0));

  /**
   * `[SN.15]` Lo que ALGUIEN te asignó, con nombre y fecha — distinto de una cola que abre tu
   * permiso. Hasta hoy la pantalla afirmaba «Nadie te asignó trabajo hoy» apoyada en una medición
   * del 10-sep que decía que las tablas de asignación estaban vacías; medido de nuevo el 11-sep
   * contra prod hay **151 tareas vivas sobre 38 de 118 personas**. La frase mentía para un tercio
   * del padrón.
   */
  readonly tareas = computed<readonly MeTarea[]>(() => {
    const t = this.trabajo();
    const todas = t.status === 'ok' ? t.data.tareas ?? [] : [];
    if (!this.buscando()) return todas;
    return todas.filter((x) => this.casa(normalizar(`${x.label} ${x.detalle}`)));
  });
  /** Lo tuyo = lo que te asignaron + lo que vos empezaste. Las dos cosas llevan tu nombre. */
  readonly totalMio = computed(
    () =>
      this.tareas().reduce((n, t) => n + t.total, 0) +
      this.mios().reduce((n, p) => n + p.total, 0),
  );
  readonly hayAlgoMio = computed(
    () => this.tareas().length > 0 || this.mios().length > 0 || this.ciclosMios().length > 0,
  );
  /**
   * `[SN.17]` El desglose del titular. Un ciclo propio no se cuenta en `totalMio` porque su unidad
   * es el MES, no el item — sumar meses con hallazgos daría un número que no significa nada. Pero
   * callarlo era peor: la pantalla decía «ninguno a tu nombre» con el ciclo de Ivonne dibujado
   * justo arriba. Cada cosa se cuenta en su unidad y se dicen las dos.
   */
  readonly resumenMio = computed(() => {
    const meses = this.ciclosMios().reduce((n, c) => n + c.pendientes, 0);
    const partes: string[] = [];
    if (meses > 0) partes.push(`${meses} ${meses === 1 ? 'mes' : 'meses'} por cerrar`);
    const enColas = this.totalBandejas();
    if (enColas > 0) {
      const n = this.bandejasConTrabajo();
      /*
       * ⚠️ `[SN.31]` Acá decía «N colas compartidas», y con `[SN.30]` eso pasó a ser FALSO: si una
       * cola llega a esta lista es porque esta persona responde de ella. El término se retiró del
       * rótulo del grupo en `[SN.30]` y este subtítulo se quedó atrás — el defecto apareció al
       * medir qué ve un jefe de zona, cuya única fila decía «126 en 1 cola compartida» sobre una
       * actividad que es suya.
       */
      partes.push(
        `${this.formatoTotal(enColas)} en ${n} ${n === 1 ? 'actividad que respondes' : 'actividades que respondes'}`,
      );
    }
    return partes.join(' · ');
  });

  /** `[SN.29]` ¿Hay algo que mostrar en el titular? Incluye lo compartido: un 0 propio es un dato. */
  readonly hayTrabajo = computed(
    () => this.totalMio() > 0 || this.deBandeja().length > 0 || this.ciclos().length > 0,
  );

  /**
   * `[JZ.3]` **Cómo va tu zona.** El cuarto organismo, y el único que no cuenta pendientes.
   *
   * Se filtra con el buscador igual que lo demás: si escribís «ruta 28» tiene que quedar esa
   * fila, no desaparecer el bloque entero. Un bloque que se queda sin filas por el filtro no se
   * pinta — igual que una bandeja en 0 (regla 4 de `me-work.ts`).
   */
  readonly zona = computed<MeZona | null>(() => {
    const t = this.trabajo();
    const z = t.status === 'ok' ? t.data.zona ?? null : null;
    if (!z || !this.buscando()) return z;
    const bloques = z.bloques
      .map((b) => ({
        ...b,
        canales: b.canales.filter((c) => this.casa(normalizar(`${c.label} ${c.detalle}`))),
      }))
      .filter((b) => b.canales.length > 0);
    return bloques.length ? { ...z, bloques } : null;
  });

  /**
   * `[SN.29]` **Las colas congeladas se declaran aparte, y no se suman a nada.**
   *
   * Medido contra prod el 2026-09-14: de las cinco colas que la pantalla publicaba como «trabajo
   * pendiente», **dos no han tenido una sola fila resuelta** — `reconciliation.discrepancies`
   * (2,409 de 2,409 en `nuevo` desde el 8-jul) y `finance.proposed_actions` (192 de 198, las
   * únicas 6 decididas el 6-ago). Juntas eran el 90 % del titular viejo.
   *
   * Es el mismo criterio que `[SN.18]` usó para retirar `finance.findings` —*«una cola que nadie
   * trabaja no es trabajo pendiente»*— pero sin decidir por Edgar que se apaguen: se muestran con
   * su veredicto y se resumen al pie con lo que les falta, que es un DUEÑO, no un clic.
   */
  readonly congeladas = computed(() => this.deBandeja().filter((p) => p.veredicto === 'congelada'));
  /** Cuántas de tus tareas ya pasaron su fecha. `null` en una fuente que no maneja vencimiento. */
  readonly tareasVencidas = computed(() => this.tareas().reduce((n, t) => n + (t.vencidas ?? 0), 0));

  /**
   * `[SN.16]` Trabajo que se cierra mes por mes. Se filtra con el buscador igual que lo demás —
   * si escribís "conciliación" tiene que aparecer acá, no sólo en las bandejas.
   */
  readonly ciclos = computed<readonly MeCiclo[]>(() => {
    const t = this.trabajo();
    const todos = t.status === 'ok' ? t.data.ciclos ?? [] : [];
    if (!this.buscando()) return todos;
    return todos.filter((c) => this.casa(normalizar(`${c.label} ${c.detalle}`)));
  });
  /**
   * `[SN.17]` Los ciclos de los que ESTA persona responde suben a «A tu nombre»; el resto se queda
   * abajo como cola compartida. **Nadie pierde acceso**: la responsabilidad ordena, no gatea
   * (regla de `[OR.1b]`). Medido: Ivonne y Mayra son las dos `auxiliar_finanzas`, así que el
   * reparto vive en `user_responsibilities` — ingresos a una, egresos a la otra.
   */
  readonly ciclosMios = computed(() => this.ciclos().filter((c) => c.es_mio));
  readonly ciclosCompartidos = computed(() => this.ciclos().filter((c) => !c.es_mio));

  /**
   * `[SN.15]` ¿Se puede siquiera calcular "esto es tuyo"?
   *
   * `false` = ni el puesto ni la ficha dicen de qué responde esta persona. La pantalla lo DECLARA
   * en vez de callarlo, que es la diferencia entre "no te toca nada" y "nadie definió qué te toca".
   *
   * ⚠️ `[SN.21]` Acá decía que era «el caso de TODOS, porque `[OR.1b]` la dejó vacía». Medido de
   * nuevo contra prod el 2026-09-12: **42 filas en `position_responsibilities`, 28 de 122 personas
   * con reparto**. El comentario estaba vencido; la pantalla no mentía porque el dato se calcula
   * en vivo, pero es el mismo defecto que `[SN.15]` tuvo que corregir y conviene no repetirlo.
   */
  readonly sinReparto = computed(() => {
    const t = this.trabajo();
    return t.status === 'ok' && t.data.tiene_responsabilidades === false;
  });

  /**
   * `[SN.21]` Qué le hizo el reparto a esta lista. Si recortó algo, se dice: una lista recortada en
   * silencio se lee igual que una completa, y entonces «ya no hay nada» y «lo demás no es tuyo» se
   * confunden. `null` = las responsabilidades no se pudieron leer.
   */
  readonly delegacion = computed(() => {
    const t = this.trabajo();
    return t.status === 'ok' ? t.data.delegacion ?? null : null;
  });
  readonly recorteVisible = computed(() => {
    const d = this.delegacion();
    return d && d.activa && d.ocultas > 0 ? d : null;
  });

  /**
   * `[SN.30]` **Tenés reparto, pero TODAS tus actividades están apagadas.**
   *
   * Devuelve el texto de esas claves, o `null` si no es el caso. Es el cuarto estado del bloque
   * vacío y existe porque sin él la pantalla les diría *«nadie te asignó nada»* a **6 personas**
   * medidas en prod (`diana_rodriguez`, `ernesto_zarate`, `maria_rodriguez`, `jesus_carrillo`,
   * `perla_garcia`, `julio_torres`) cuya única responsabilidad es `finanzas.hallazgos`, retirada
   * desde `[SN.18]`. Sí tienen trabajo asignado; lo que pasa es que su bandeja está apagada, y
   * son dos hechos distintos.
   */
  readonly soloRetiradas = computed(() => {
    const d = this.delegacion();
    if (!d || d.claves.length === 0) return null;
    const ret = d.retiradas ?? [];
    // Todas las claves que tiene apuntan a una superficie apagada.
    if (ret.length === 0 || ret.length !== d.claves.length) return null;
    return this.listaLegible(ret);
  });

  /** Las responsabilidades de esta persona, en prosa. Para el estado "estás al día". */
  readonly clavesTexto = computed(() => this.listaLegible(this.delegacion()?.claves ?? []));

  /**
   * `almacen.cuadre` → «Cuadre». Se usa el último segmento y se capitaliza: la clave es el
   * vocabulario del catálogo (`[OR.1b]`), no algo que una persona deba leer tal cual.
   */
  private listaLegible(claves: readonly string[]): string {
    const nombres = claves.map((k) => {
      const hoja = (k.split('.').pop() ?? k).replace(/_/g, ' ');
      return hoja.charAt(0).toUpperCase() + hoja.slice(1);
    });
    if (nombres.length <= 1) return nombres[0] ?? '';
    return `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`;
  }

  readonly sinPendientes = computed(
    () =>
      this.trabajo().status === 'ok' &&
      !this.buscando() &&
      this.pendientes().length === 0 &&
      this.tareas().length === 0 &&
      this.ciclos().length === 0,
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
    this.escucharVentaEnVivo();
    this.scope
      .mine()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data) => this.alcance.set({ status: 'ok', data }),
        error: (e) => this.alcance.set({ status: 'error', error: describirError(e) }),
      });

    /*
     * Auto-entrada: UNA sola puerta primaria → adentro, salvo que pidieran quedarse.
     *
     * `[SN.21]` **…y salvo que tengan trabajo propio que mostrarles.** Con un solo destino la
     * landing navegaba sola, así que Ivonne y Mayra —que tienen su conciliación delegada— nunca
     * llegaban a ver la pantalla que se construyó para ellas: entraban directo a `/finanzas`.
     *
     * Medido antes de tocarlo: **18 personas tienen exactamente 1 destino** (10 a `/tienda`, 5 a
     * `/finanzas`, 3 a `/almacen`) y de ésas **sólo 3 tienen algo propio** (Ivonne y Mayra por su
     * ciclo, `jesus_carrillo` por una tarea asignada). Las otras 15 siguen entrando directo.
     *
     * ⚠️ El costo es real y se paga en el arranque: la decisión ya no se puede tomar con el JWT
     * solo, hay que esperar a `GET /users/me/work`. Esas 15 personas ven la landing —con su
     * esqueleto— durante esa llamada antes de que la app las redirija. Se prefiere eso a decidir
     * sin el dato: navegar antes de saber si hay trabajo propio es justo lo que rompía la pantalla.
     *
     * ⛔ Si la llamada FALLA no se auto-entra. No se sabe si hay trabajo, y ADR-056 dice que lo que
     * no se pudo medir se declara: la pantalla muestra el error y la única puerta está a un clic.
     */
    effect(() => {
      if (this.autoEntrada || this.quedarse || !this.permisosCargados()) return;
      const destinos = this.destinos();
      if (destinos.length !== 1) return;
      const t = this.trabajo();
      if (t.status !== 'ok') return;
      if (this.hayTrabajoPropioCrudo(t.data)) return;
      this.autoEntrada = true;
      void this.router.navigate([destinos[0]]);
    });
  }

  /**
   * `[SN.21]` ¿Hay algo con TU nombre en esta respuesta? Las tres formas de «tuyo» que la suite
   * distingue: te lo asignaron, lo empezaste, o responde de él tu reparto.
   *
   * Lee el dato CRUDO a propósito. `hayAlgoMio()` pasa por el buscador, y atar la auto-entrada al
   * buscador haría que escribir en la caja cambiara si la app te redirige o no.
   *
   * ⛔ `no_medido` NO cuenta. Es tentador —"algo falló, que lo vea"— pero haría que una falla
   * transitoria de UNA cola compartida le quitara el atajo a las 15 personas que sí lo quieren.
   * Lo que no se pudo medir se declara DENTRO de la pantalla, no reteniendo a quien no la pidió.
   */
  private hayTrabajoPropioCrudo(w: MeWork): boolean {
    return (
      (w.tareas ?? []).length > 0 ||
      w.pendientes.some((p) => p.alcance === 'mio') ||
      (w.ciclos ?? []).some((c) => c.es_mio)
    );
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
    // `[SN.25]` Y se recuerda acá mismo, para «Tus accesos». Ver `recientes`.
    this.recientes.update((prev) => guardarReciente(e.id, prev));
  }

  /** `[SN.25]` Un submódulo abierto desde el buscador. Se registra igual: es una puerta. */
  abrioSubmodulo(x: SubHallado): void {
    this.uso.registrarApertura('puerta', x.id, { ruta: x.route, via: 'buscador' });
  }

  abrioBandeja(p: MePendiente): void {
    // `[SN.24]` `ruta` puede ser null (la actividad es tuya y tu permiso no la abre). Esa fila no
    // es un enlace, así que este método no se llama; el `?? ''` es para que el tipo lo diga igual.
    this.uso.registrarApertura('bandeja', p.id, { alcance: p.alcance, ruta: p.ruta ?? '' });
  }

  /** `[SN.16]` Qué MES de qué ciclo abrió. El periodo es el dato que hace útil este registro. */
  abrioPeriodo(c: MeCiclo, p: MePeriodo): void {
    if (!p.ruta) return; // un mes sin datos no navega
    this.uso.registrarApertura('bandeja', c.id, { alcance: 'ciclo', ruta: p.ruta, periodo: p.periodo });
  }

  /** `[SN.15]` Igual que la bandeja, pero el id es la FUENTE — que es lo que identifica a la tarea. */
  abrioTarea(t: MeTarea): void {
    if (!t.ruta) return; // sin permiso no hay navegación que registrar
    this.uso.registrarApertura('bandeja', t.fuente, { alcance: 'tarea', ruta: t.ruta });
  }

  /**
   * `[SN.15]` Cuándo vence lo más próximo de esta tarea. Tres respuestas distintas, y ninguna se
   * disfraza de otra: `null` es **la fuente no maneja vencimiento** (lo declara su adaptador), no
   * "no vence"; vencido se dice vencido; y lo demás va en días.
   */
  vencimiento(t: MeTarea): string | null {
    if (!t.vence_at) return null;
    const ms = Date.parse(t.vence_at) - Date.now();
    if (!Number.isFinite(ms)) return null;
    const dias = Math.round(ms / 86_400_000);
    if (dias < 0) return `venció hace ${Math.abs(dias)} d`;
    if (dias === 0) return 'vence hoy';
    return `vence en ${dias} d`;
  }

  /** `[SN.11]` 1865 → "1,865". Cifras alineadas (tabular-nums lo hace en CSS); el separador acá. */
  formatoTotal(n: number): string {
    return new Intl.NumberFormat('es-MX').format(n);
  }

  /**
   * `[JZ.3]` **10,214,832 → "10.21 MDP"; 337,976 → "337,976".**
   *
   * El corte está en el millón porque es donde el número deja de leerse de un vistazo: ocho
   * dígitos alineados obligan a contar comas. Debajo de eso el peso exacto informa más que un
   * redondeo — una ruta que hizo 337,976 no es "0.34 MDP".
   */
  formatoDinero(n: number | null): string {
    if (n === null) return '—';
    return n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(2)} MDP`
      : new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 }).format(n);
  }

  /**
   * `[JZ.3]` `0.084` → `"+8.4%"`. ⛔ `null` devuelve `null`, **nunca "0%" ni "−100%"**: es la
   * regla por la que existe este bloque. Las 5 rutas de ZAMORA no venden desde el 12-ago porque
   * dejó de llegar el dato; un −100% manda al jefe a buscar al vendedor equivocado.
   */
  formatoVariacion(p: number | null): string | null {
    if (p === null) return null;
    const signo = p > 0 ? '+' : p < 0 ? '−' : '';
    return `${signo}${Math.abs(p * 100).toFixed(1)}%`;
  }

  /** Clase de color: sube, baja, o **no se sabe** — que es un tercer estado, no un gris de relleno. */
  claseVariacion(p: number | null): string {
    if (p === null) return 'is-nd';
    return p > 0 ? 'is-up' : p < 0 ? 'is-down' : 'is-plano';
  }

  /** El texto de la segunda línea de un canal: la comparación, o por qué no hay cifra. */
  detalleCanal(c: MeCanal): string {
    return c.sin_medir ?? c.detalle;
  }

  /**
   * `[SN.12]` Hace cuánto entró el pendiente más viejo de la cola. Es lo que ordena la bandeja:
   * el volumen mide tamaño, no urgencia. Lo que no vino fechado se DECLARA — "sin fechar" — en
   * vez de pasar por recién llegado (ADR-056).
   */
  antiguedad(p: { mas_viejo_at: string | null }): string {
    if (!p.mas_viejo_at) return 'sin fechar';
    const ms = Date.now() - Date.parse(p.mas_viejo_at);
    if (!Number.isFinite(ms) || ms < 0) return 'sin fechar';
    const dias = Math.floor(ms / 86_400_000);
    if (dias >= 365) return `${Math.floor(dias / 365)} a`;
    if (dias >= 1) return `${dias} d`;
    const horas = Math.floor(ms / 3_600_000);
    return horas >= 1 ? `${horas} h` : 'hoy';
  }

  /**
   * `[SN.29]` El veredicto, en una palabra que se pueda leer de reojo.
   *
   * ⛔ `al_dia` devuelve `null` a propósito: **lo sano no lleva insignia**. Ponerle una a las cinco
   * filas volvería a dejarlas todas iguales, que es el defecto que esto vino a corregir — y
   * `DESIGN.md` Q.6 ya lo dice para el color. La insignia marca lo que se sale de la norma.
   */
  veredictoTexto(p: MePendiente): string | null {
    switch (p.veredicto) {
      case 'se_acumula':
        return 'crece';
      case 'atrasada':
        return 'atrasada';
      case 'congelada':
        return 'congelada';
      case 'sin_medir':
        return 'sin medir';
      default:
        return null;
    }
  }

  /** El motivo largo del veredicto, para el `title`. Dice contra QUÉ vara se juzgó. */
  veredictoMotivo(p: MePendiente): string {
    const f = p.flujo;
    switch (p.veredicto) {
      case 'se_acumula':
        return `Entraron ${f.entradas_30d} en 30 días y salieron ${f.cerradas_30d}: la cola crece.`;
      case 'atrasada':
        return `El más viejo lleva más de ${p.umbral_dias} ${p.umbral_dias === 1 ? 'día' : 'días'}, que es el umbral declarado para esta cola.`;
      case 'congelada':
        return 'Cero filas resueltas en 30 días, medido. No es trabajo pendiente hasta que tenga dueño.';
      case 'sin_medir':
        return 'Esta cola no pudo reportar su flujo. No se asume que esté al día.';
      default:
        return `Sale al menos tanto como entra y nada pasó el umbral de ${p.umbral_dias} ${p.umbral_dias === 1 ? 'día' : 'días'}.`;
    }
  }

  /**
   * `[SN.29]` La línea de flujo: qué entró y qué salió. Es lo que convierte un stock en algo que
   * se puede juzgar — y de paso resuelve que la pantalla no tuviera noción de «desde la última
   * vez»: abrirla dos veces al día mostraba el mismo total sin decir si había mejorado.
   *
   * ⛔ `cerradas_30d === null` NO se pinta como «0 resueltas»: se dice que la fuente no lo reporta.
   */
  flujoTexto(p: MePendiente): string | null {
    const { entradas_7d, cerradas_30d } = p.flujo;
    const partes: string[] = [];
    if (entradas_7d !== null && entradas_7d > 0) {
      partes.push(`+${this.formatoTotal(entradas_7d)} esta semana`);
    }
    if (cerradas_30d === null) partes.push('salidas sin medir');
    else partes.push(`${this.formatoTotal(cerradas_30d)} resueltas en 30 d`);
    return partes.length ? partes.join(' · ') : null;
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

  /**
   * `[JZ.4]` Cambiar el grano del bloque de zona. Vuelve a pedir `me/work` porque el COMPARADOR
   * lo calcula el servidor: recortar en el navegador daría el mismo total contra el tramo
   * equivocado, que es el error más difícil de ver de los tres.
   */
  cambiarPeriodo(p: MeZonaPeriodo): void {
    if (p === this.periodoZona()) return;
    this.periodoZona.set(p);
    this.cargarTrabajo();
  }

  /**
   * `[JZ.5]` — **El WebSocket de tienda mantiene vivo el bloque de zona.**
   *
   * Edgar: *«tienda/live usa un websocket para mostrar los resultados, también deberíamos
   * aprovecharlo»*. Se aprovecha como **disparador**, no como fuente, y esa distinción la decidió
   * la medición contra prod:
   *
   *   · el stream cubre las 8 tiendas al minuto (MD-30 incluida) y **cero rutas** — `RUTA%` no
   *     existe en `analytics.store_live_tickets`, nunca;
   *   · y sus totales **no son** los del fact: hoy la sucursal `01` da 124.9 % del fact y la `06`
   *     un **49.7 %**, porque el stream es de MOSTRADOR y el `06` también vende crédito y mayoreo.
   *
   * Tomar el total del stream habría publicado una cifra que no es ni el mostrador ni la venta.
   * Así que el ticket sólo dice **«volvé a preguntar»**, y el número sigue saliendo de
   * `analytics.sales_daily`: una sola verdad.
   *
   * ⛔ **Sólo se conecta quien TIENE el bloque.** Son 3 personas de 122; abrir un socket para las
   * otras 119 sería una conexión por sesión para escuchar algo que no van a mostrar.
   *
   * ⚠️ **El filtro por sucursal de la zona es obligatorio, no una optimización.** Quien no tiene
   * `warehouse_code` en su ficha entra al room del tenant COMPLETO (`StoreGateway.handleConnection`)
   * y recibe los tickets de las 8 sucursales — dos de los tres jefes están en ese caso. Sin
   * filtrar, la venta de Zamora refrescaría la portada de Morelia.
   *
   * ⚠️ **El operador es `throttleTime` con `leading` Y `trailing`, y los tres se eligieron con
   * motivo.** `debounceTime` es el error obvio: con un ticket cada ~45 s en una zona de tres
   * sucursales, una espera de 20 s vence casi siempre y dispara igual por cada ticket — no acota
   * nada. `auditTime` sí acota, pero **retrasa la PRIMERA emisión la ventana entera**: tras un
   * rato quieto, la primera venta tardaría 20 s en verse. `throttleTime(…, leading, trailing)`
   * junta las dos mitades: el primer ticket refresca en el acto y el techo queda en un refresco
   * cada 20 s pase lo que pase.
   */
  private escucharVentaEnVivo(): void {
    this.storeSocket.ticket$
      .pipe(
        filter((t) => this.sucursalesDeMiZona().has(String(t.warehouse_code).trim())),
        throttleTime(20_000, asyncScheduler, { leading: true, trailing: true }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.refrescarZona());

    /*
     * Conectar/desconectar sigue al bloque, no al montaje: el reparto puede llegar en la respuesta
     * de `me/work`, que es posterior al constructor. El `effect` también cierra el socket si la
     * persona deja de tener el bloque (le quitaron la responsabilidad entre dos cargas).
     */
    effect(() => {
      if (this.sucursalesDeMiZona().size > 0) this.storeSocket.connect();
      else this.storeSocket.disconnect();
    });
    this.destroyRef.onDestroy(() => this.storeSocket.disconnect());
  }

  /**
   * Los códigos de sucursal del bloque de TIENDAS de esta zona. Vacío = no hay nada que escuchar.
   *
   * ⛔ Sólo `tienda`: el stream no trae una sola ruta, así que incluirlas acá prometería un vivo
   * que no existe. Lo que las rutas tienen es el refresco manual y la recarga de la pantalla.
   */
  private readonly sucursalesDeMiZona = computed<ReadonlySet<string>>(() => {
    const z = this.zonaCruda();
    if (!z) return new Set();
    const tiendas = z.bloques.find((b) => b.grupo === 'tienda');
    return new Set((tiendas?.canales ?? []).map((c) => c.id));
  });

  /** La zona SIN el filtro del buscador: para escuchar el socket no importa qué esté buscando. */
  private readonly zonaCruda = computed<MeZona | null>(() => {
    const t = this.trabajo();
    return t.status === 'ok' ? t.data.zona ?? null : null;
  });

  /**
   * `[JZ.5]` Vuelve a pedir **sólo** la zona y la parcha dentro de `trabajo()`, para que
   * `zona()` —y su filtro de búsqueda— sigan saliendo de una sola fuente.
   *
   * ⛔ Si falla, el bloque se va: dejar el número viejo en pantalla después de un refresco fallido
   * es peor que no tenerlo, porque nadie puede saber que quedó viejo (ADR-056).
   */
  private refrescarZona(): void {
    this.meCtx
      .workZona(this.periodoZona())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          const t = this.trabajo();
          if (t.status !== 'ok') return;
          this.trabajo.set({ status: 'ok', data: { ...t.data, zona: r.zona } });
          this.zonaMedidaAt.set(r.medido_at);
        },
        error: () => {
          /* Un refresco fallido no toca lo que hay: el número sigue siendo el de la última carga
             buena, y `zonaMedidaAt` sigue diciendo de cuándo es. Vaciar la pantalla por una falla
             transitoria del socket sería peor que mostrar un número con su hora. */
        },
      });
  }

  /** `[JZ.5]` De cuándo es el número de la zona. `null` = el de la carga inicial. */
  readonly zonaMedidaAt = signal<string | null>(null);

  /**
   * `[JZ.5]` ¿El socket está conectado Y hay sucursales que escuchar?
   *
   * ⛔ Las dos condiciones, no una. `connected` solo diría «en vivo» durante los segundos en que
   * el socket sigue abierto después de que la persona perdió el bloque; y `size > 0` solo lo diría
   * con el socket caído. La etiqueta afirma que el número se está actualizando, así que tiene que
   * ser cierto de las dos puntas.
   */
  readonly vivo = computed(
    () => this.storeSocket.connected() && this.sucursalesDeMiZona().size > 0,
  );

  /** Qué cubre exactamente ese «en vivo», dicho en el tooltip y no dejado a la imaginación. */
  readonly tituloVivo = computed(() => {
    const at = this.zonaMedidaAt();
    const base =
      'Se vuelve a medir cuando entra un ticket de tus tiendas. La cifra sale de la venta ' +
      'consolidada, no del ticket. Las rutas no tienen vivo: su fuente no publica tickets.';
    if (!at) return base;
    const h = new Date(at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    return `Medido a las ${h}. ${base}`;
  });

  cargarTrabajo(): void {
    this.trabajo.set({ status: 'loading' });
    this.meCtx
      .work(this.periodoZona())
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
