import { Permission } from './permissions';
import {
  AUTHZ_TREE,
  LEGACY_PERMISSIONS,
  type AuthzApp,
  type AuthzModule,
  type AuthzProject,
} from './authz-tree';

/**
 * SUITE_SPACES — el mapa de la suite: los ESPACIOS de responsabilidad que ve una persona al
 * entrar (`/projects`, "Mi trabajo") y cómo se reparten en ellos los proyectos de `AUTHZ_TREE`.
 *
 * Es una capa de PRESENTACIÓN sobre el árbol de autorización, igual que el árbol lo es sobre
 * los permisos atómicos (Fase AZ). No define permisos, no los otorga y ningún guard la lee:
 * decide en qué sección se ofrece cada puerta y con qué etiqueta. La visibilidad de una entrada
 * se DERIVA de los permisos de los módulos del árbol que referencia — nunca de una segunda
 * lista escrita a mano. Antes había tres listas de proyectos que ya discrepaban entre sí (el
 * árbol, las 11 tarjetas de `/projects` con sus `anyOf`, y el `switch` del layout), y las dos
 * copias cobraron dos bugs: `[AUTHZ.6]` (almacenistas sin tarjeta) y `[IDG.9.6]` (promotoras
 * sin Tienda). Ver ADR-061 y `FASE_SN_SUITE_NAVEGACION.md`.
 *
 * Reglas del modelo:
 *  - Los 10 espacios son los de §5.1 de la especificación de Dirección (2026-09-10), en su
 *    orden. Cada entrada cita de dónde sale (`source`): confirmado / propuesta / pendiente.
 *  - `planned` = la especificación lo pide y la suite NO tiene ni un módulo que ofrecer ahí.
 *    Existe en el mapa para que el test, la doc y `/admin/roles` lo conozcan, y **no se
 *    pinta** — una tarjeta "Próximamente" es exactamente lo que §22 veta.
 *  - Sólo los módulos CON `route` aportan permisos a la visibilidad: un permiso sin pantalla
 *    (`HR_ATTENDANCE_CHECAR`, cuenta de kiosco) no abre nada y no debe hacer visible un espacio.
 *  - `gate` se declara SÓLO donde el guard de ruta es más estricto que el árbol, y siempre con
 *    `reason`. Sin él, ofrecer la puerta sería ofrecer un rebote (403 o redirect). Cada `gate` es
 *    deuda con nombre: cuando el guard y el árbol se alineen, se quita y la paridad sigue verde.
 *  - `crossLink` = la entrada también vive en su espacio de origen; un espacio transversal
 *    (Auditoría, Mercadotecnia, Dirección General) enlaza, no se apropia del módulo.
 */

export type SuiteSpaceStatus = 'active' | 'proposed' | 'planned';
export type SuiteSourceStatus = 'confirmado' | 'propuesta' | 'pendiente';

export interface SuiteGate {
  /**
   * Reemplaza a la derivación (`view ∪ manage` de los módulos con ruta): ver la entrada exige
   * ALGUNA de estas claves. Se usa cuando el guard de la ruta pide menos que el árbol ofrece
   * o cuando conserva a propósito la lista legacy de la tarjeta (paridad "nadie pierde").
   */
  readonly anyOf?: readonly Permission[];
  /**
   * ADEMÁS de lo anterior (derivado o `anyOf`), exige alguna de estas claves. Es el caso de
   * un shell con guard propio: `/dashboard/*` rebota a captures a quien no tenga reportes de
   * equipo, así que un módulo suyo no se ofrece a quien el shell va a rebotar.
   */
  readonly alsoAnyOf?: readonly Permission[];
  /** Por qué el árbol no alcanza acá. Obligatorio: un gate sin motivo es una lista a mano. */
  readonly reason: string;
}

export interface SuiteEntry {
  /** Único en todo el mapa (espacios + sin clasificar). */
  readonly id: string;
  readonly kind: 'project' | 'module';
  /** `AuthzProject.id` de la app `view`. */
  readonly project: string;
  /** `AuthzModule.id` dentro de ese proyecto. Obligatorio si `kind === 'module'`. */
  readonly module?: string;
  /** Sub-agrupación dentro del espacio, del más general al más específico (`['Ventas','Mayoreo']`). */
  readonly group?: readonly string[];
  /** Etiqueta visible. Default: la del proyecto o módulo en el árbol. */
  readonly label?: string;
  /** La entrada también vive (como primaria) en otro espacio. */
  readonly crossLink?: boolean;
  readonly gate?: SuiteGate;
  /** Roles que NO ven la entrada aunque tengan permiso (se evalúa antes del god-mode, como hoy). */
  readonly hideForRoles?: readonly string[];
  /** Nivel de la especificación del que sale esta ubicación, con su cita. */
  readonly source: { readonly status: SuiteSourceStatus; readonly cite: string };
}

export interface SuiteSpace {
  readonly id: string;
  /** Posición en el menú principal (§5.1). Única y contigua desde 1. */
  readonly order: number;
  readonly label: string;
  /** Icono PrimeNG. */
  readonly icon: string;
  /** Una línea, en voz operativa: qué se resuelve acá. */
  readonly description: string;
  readonly status: SuiteSpaceStatus;
  /** Decisión pendiente que lo sostiene como propuesta (`P-03`, `P-06`…). */
  readonly proposal?: string;
  /** `true` sólo para "Mi trabajo": es la pantalla misma, no una sección con entradas. */
  readonly landing?: boolean;
  readonly entries: readonly SuiteEntry[];
}

/** La landing. Se conserva la URL de siempre: renombrarla es cosmético y toca 7 archivos. */
export const LANDING_ROUTE = '/projects';

/**
 * `anyOf` de la tarjeta legacy "Auditoría en Ruta" (`projects.component.ts`, 2026-09-10).
 * Se conserva como gate porque el árbol ofrece MÁS (`RUTAS_VER`, `SUPERVISOR_AI_VER`,
 * `TRADE_ROUTE_PLAN_VER`…) y el shell `/dashboard` tiene `colaboradorGuard`: a quien no tenga
 * reportes de equipo/global lo manda a `/dashboard/captures`, o sea que ofrecerle la puerta por
 * `RUTAS_VER` solo sería ofrecerle un rebote. `USUARIOS_ASIGNAR_RUTA` es LEGACY (fuera del árbol)
 * y sigue acá porque el sidebar todavía lo honra.
 */
const TRADE_LEGACY_ANYOF: readonly Permission[] = [
  Permission.VISITAS_REGISTRAR,
  Permission.REPORTES_VER_PROPIO,
  Permission.REPORTES_VER_EQUIPO,
  Permission.REPORTES_VER_GLOBAL,
  Permission.TIENDAS_VER,
  Permission.VER_SEGUIMIENTO,
  Permission.PLANOGRAMAS_GESTIONAR,
  Permission.CATALOGO_GESTIONAR,
  Permission.USUARIOS_ASIGNAR_RUTA,
];

/** Lo que `colaboradorGuard` exige para cualquier ruta de `/dashboard` que no sea captures. */
const TRADE_SHELL_ALSO: readonly Permission[] = [
  Permission.REPORTES_VER_EQUIPO,
  Permission.REPORTES_VER_GLOBAL,
];
const TRADE_SHELL_REASON =
  '`colaboradorGuard` (`/dashboard/*`) redirige a captures a quien no tenga REPORTES_VER_EQUIPO|GLOBAL; ' +
  'un enlace directo a un módulo de Trade sin eso es un rebote.';

export const SUITE_SPACES: readonly SuiteSpace[] = [
  {
    id: 'mi-trabajo',
    order: 1,
    label: 'Mi trabajo',
    icon: 'pi pi-home',
    description: 'Quién eres en la suite, qué alcance tienes y a qué puedes entrar.',
    status: 'active',
    landing: true,
    entries: [],
  },
  {
    id: 'direccion-general',
    order: 2,
    label: 'Dirección General',
    icon: 'pi pi-compass',
    description: 'Lectura consolidada del negocio. Hoy sólo la parte comercial; el tablero integral es Etapa 3.',
    status: 'proposed',
    proposal: 'P-06',
    entries: [
      {
        id: 'dg-centro-de-control',
        kind: 'module',
        project: 'comercial',
        module: 'analytics',
        label: 'Centro de Control (vista parcial: Comercial)',
        crossLink: true,
        source: { status: 'propuesta', cite: '§7.1 — el resto del tablero depende de P-06 (fórmulas y metas)' },
      },
    ],
  },
  {
    id: 'comercial',
    order: 3,
    label: 'Comercial',
    icon: 'pi pi-shopping-cart',
    description: 'Ventas por canal, compras y mercadotecnia.',
    status: 'active',
    entries: [
      {
        id: 'ventas-backoffice',
        kind: 'project',
        project: 'comercial',
        // Sin `group`: ES el nivel "Ventas" del árbol de §5.2; los canales cuelgan debajo. La
        // etiqueta también viaja a la migaja del layout ("Comercial › Ventas › Pedidos").
        label: 'Ventas',
        // El vendedor tiene COMMERCIAL_ORDERS_* pero no debe ver el admin de Comercial
        // (mostraría pedidos de toda la tenant): trabaja en su app (`apps/vendor`).
        hideForRoles: ['vendedor'],
        source: { status: 'confirmado', cite: '§23 fila Ventas — unificar consultas y segmentar por canal' },
      },
      {
        id: 'pisos-de-venta',
        kind: 'project',
        project: 'pdv',
        group: ['Ventas', 'Pisos de venta'],
        source: { status: 'confirmado', cite: '§8.3 + §23 fila Tienda' },
      },
      {
        id: 'mayoreo-telemarketing',
        kind: 'project',
        project: 'televenta',
        group: ['Ventas', 'Mayoreo', 'Atención telefónica / Telemarketing'],
        // §5.2 confirmado: Telemarketing es MODALIDAD de Mayoreo, no un canal aparte.
        // "Atención presencial" no tiene módulo propio hoy (cartera/clientes son back-office
        // multicanal) y no se inventa una hoja para ella.
        source: { status: 'confirmado', cite: '§5.2 + §8.4 + §23 fila Telemarketing' },
      },
      {
        id: 'rutas-auditoria',
        kind: 'project',
        project: 'trade',
        group: ['Ventas', 'Rutas de detalle'],
        // Se llama por lo que ES hoy. "Gestión y ejecución de rutas" (§8.7) es a lo que debe
        // convertirse; estrenar el nombre antes que la función es lo que §29 llama fracaso.
        label: 'Auditoría en Ruta',
        gate: {
          anyOf: TRADE_LEGACY_ANYOF,
          reason:
            'Paridad con la tarjeta legacy: el árbol ofrece más claves (RUTAS_VER, SUPERVISOR_AI_VER…) pero ' +
            '`colaboradorGuard` rebota a captures a quien no tenga reportes de equipo/global.',
        },
        // P-14: §23 lo manda acá y §10 pone Trade Marketing bajo Mercadotecnia. Los capturadores
        // son `colaborador` = vendedores de ruta directa (Edgar 2026-08-20), así que §23 tiene
        // sustento operativo; el contenido (exhibiciones, planogramas) es marketing. Decisión de
        // Dirección; mientras, Mercadotecnia enlaza sus módulos de configuración.
        source: { status: 'propuesta', cite: '§23 fila Auditoría en Ruta vs §10 — P-14' },
      },
      {
        id: 'compras',
        kind: 'project',
        project: 'compras',
        group: ['Compras'],
        source: { status: 'confirmado', cite: '§9 + §23 fila Compras' },
      },
      {
        id: 'mkt-promociones',
        kind: 'module',
        project: 'comercial',
        module: 'promotions',
        group: ['Mercadotecnia'],
        crossLink: true,
        source: { status: 'propuesta', cite: '§10 — campañas y promociones' },
      },
      {
        id: 'mkt-erp-promos',
        kind: 'module',
        project: 'comercial',
        module: 'erp-promos',
        group: ['Mercadotecnia'],
        crossLink: true,
        source: { status: 'propuesta', cite: '§10 — promociones vigentes en el ERP' },
      },
      {
        id: 'mkt-planograma',
        kind: 'module',
        project: 'trade',
        module: 'planograma',
        group: ['Mercadotecnia'],
        crossLink: true,
        gate: { alsoAnyOf: TRADE_SHELL_ALSO, reason: TRADE_SHELL_REASON },
        source: { status: 'propuesta', cite: '§10 — exhibiciones / Trade Marketing' },
      },
      {
        id: 'mkt-scoring',
        kind: 'module',
        project: 'trade',
        module: 'scoring',
        group: ['Mercadotecnia'],
        crossLink: true,
        gate: { alsoAnyOf: TRADE_SHELL_ALSO, reason: TRADE_SHELL_REASON },
        source: { status: 'propuesta', cite: '§10 — medición de la ejecución' },
      },
      {
        id: 'mkt-catalogos-captura',
        kind: 'module',
        project: 'trade',
        module: 'catalogs',
        group: ['Mercadotecnia'],
        crossLink: true,
        gate: { alsoAnyOf: TRADE_SHELL_ALSO, reason: TRADE_SHELL_REASON },
        source: { status: 'propuesta', cite: '§10 — materiales y catálogos de captura' },
      },
    ],
  },
  {
    id: 'operacion-por-zonas',
    order: 4,
    label: 'Operación por zonas',
    icon: 'pi pi-map',
    description: 'La vista territorial del gerente (La Piedad, Zamora, Morelia). La zona ya es eje de alcance (ADR-050); todavía no hay pantalla que la recorra.',
    status: 'planned',
    entries: [],
  },
  {
    id: 'almacenes-y-logistica',
    order: 5,
    label: 'Almacenes y Logística',
    icon: 'pi pi-truck',
    description: 'Inventarios, recepción, preparación, embarques y entregas.',
    status: 'active',
    entries: [
      {
        id: 'almacenes',
        kind: 'project',
        project: 'almacen',
        group: ['Almacenes'],
        source: { status: 'confirmado', cite: '§12.1 + §23 fila Almacén' },
      },
      {
        id: 'transporte-y-embarques',
        kind: 'project',
        project: 'logistica',
        group: ['Transporte y embarques'],
        source: { status: 'confirmado', cite: '§12.2 + §23 fila Logística' },
      },
      {
        id: 'entregas-reparto',
        kind: 'project',
        project: 'reparto',
        group: ['Entregas'],
        gate: {
          anyOf: [Permission.REPARTO_DESPACHAR],
          reason:
            '`reparto.guard.ts` exige REPARTO_DESPACHAR para todo `/reparto`; el módulo "Entrega (repartidor)" ' +
            'del árbol (REPARTO_ENTREGAR) apunta a la misma ruta y rebotaría.',
        },
        source: { status: 'confirmado', cite: '§12.2 + §23 fila Reparto' },
      },
    ],
  },
  {
    id: 'administracion-y-finanzas',
    order: 6,
    label: 'Administración y Finanzas',
    icon: 'pi pi-wallet',
    description: 'Tesorería, bancos, cobranza, pagos, contabilidad y cumplimiento fiscal.',
    status: 'active',
    entries: [
      {
        id: 'finanzas',
        kind: 'project',
        project: 'finanzas',
        // §13 juzga esta tarjeta por su descripción vieja ("egresos desde pólizas"). El
        // alcance real se deriva de los módulos accesibles y se pinta como línea secundaria.
        source: { status: 'confirmado', cite: '§13 + §23 fila Finanzas' },
      },
      {
        id: 'contabilidad',
        kind: 'project',
        project: 'contabilidad',
        source: { status: 'confirmado', cite: '§13 + §23 fila Contabilidad' },
      },
    ],
  },
  {
    id: 'auditoria-prevencion-control',
    order: 7,
    label: 'Auditoría, Prevención y Control',
    icon: 'pi pi-shield',
    description: 'Hallazgos, cuadres, investigaciones y prevención. Enlaza a los módulos que ya lo hacen en cada área.',
    status: 'proposed',
    proposal: 'P-03',
    entries: [
      {
        id: 'apc-prevencion-inventarios',
        kind: 'module',
        project: 'almacen',
        module: 'prevention',
        crossLink: true,
        source: { status: 'propuesta', cite: '§14 — revisar inventarios y ajustes' },
      },
      {
        id: 'apc-cuadre',
        kind: 'module',
        project: 'almacen',
        module: 'cuadre',
        crossLink: true,
        source: { status: 'propuesta', cite: '§14 — traspasos y movimientos' },
      },
      {
        id: 'apc-hallazgos-finanzas',
        kind: 'module',
        project: 'finanzas',
        module: 'hallazgos',
        crossLink: true,
        source: { status: 'propuesta', cite: '§14 — hallazgos con evidencia (Maat)' },
      },
      {
        id: 'apc-hallazgos-compras',
        kind: 'module',
        project: 'compras',
        module: 'compras-hallazgos',
        crossLink: true,
        source: { status: 'propuesta', cite: '§14 — hallazgos de reabastecimiento' },
      },
      {
        id: 'apc-supervisor-ai',
        kind: 'module',
        project: 'trade',
        module: 'supervisor-ai',
        crossLink: true,
        gate: { alsoAnyOf: TRADE_SHELL_ALSO, reason: TRADE_SHELL_REASON },
        source: { status: 'propuesta', cite: '§8.7 + §14 — auditoría de ejecución (Horus)' },
      },
    ],
  },
  {
    id: 'recursos-humanos',
    order: 8,
    label: 'Recursos Humanos',
    icon: 'pi pi-users',
    description: 'Organización, talento y desarrollo. El organigrama ya está cargado (43 puestos); no hay pantalla de RH todavía.',
    status: 'planned',
    entries: [],
  },
  {
    id: 'sistemas-servicios-mantenimiento',
    order: 9,
    label: 'Sistemas, Servicios y Mantenimiento',
    icon: 'pi pi-wrench',
    description: 'Solicitudes, continuidad y proyectos. Sin módulo todavía (P-10).',
    status: 'planned',
    entries: [],
  },
  {
    id: 'configuracion-de-la-suite',
    order: 10,
    label: 'Configuración de la suite',
    icon: 'pi pi-cog',
    description: 'Usuarios, roles, permisos y alcances. Antes "Administración".',
    status: 'active',
    entries: [
      {
        id: 'configuracion-suite',
        kind: 'project',
        project: 'admin',
        gate: {
          anyOf: [Permission.USUARIOS_GESTIONAR, Permission.ROLES_VER, Permission.ROLES_CONFIGURAR],
          reason:
            'Las rutas de `/admin` exigen USUARIOS_GESTIONAR (users, promotores, db-health) o ROLES_VER (roles); ' +
            'USUARIOS_VER y USUARIOS_PASSWORDS, que el árbol lista, no abren ninguna pantalla.',
        },
        source: { status: 'confirmado', cite: '§22 + §23 fila Administración → Configuración de la suite' },
      },
    ],
  },
];

/**
 * Lo heredado sin clasificación (§19.2): se identifica como "Por clasificar", no se asigna por
 * conjetura. WhatsApp no tiene pantalla (`route: ''`), así que además nunca es navegable; el
 * Portal B2B es otra app (`kind: 'access'`) y no entra en esta landing por decisión previa.
 */
export const SUITE_UNCLASSIFIED: readonly SuiteEntry[] = [
  {
    id: 'whatsapp-bot',
    kind: 'project',
    project: 'whatsapp',
    source: { status: 'pendiente', cite: '§19.2 "Por clasificar" + P-05 (canales digitales)' },
  },
];

// ── Lecturas del árbol ───────────────────────────────────────────────────────

export function viewApp(tree: readonly AuthzApp[] = AUTHZ_TREE): AuthzApp | undefined {
  return tree.find((a) => a.id === 'view');
}

export function viewProjects(tree: readonly AuthzApp[] = AUTHZ_TREE): readonly AuthzProject[] {
  return viewApp(tree)?.projects ?? [];
}

export function findProject(id: string, tree: readonly AuthzApp[] = AUTHZ_TREE): AuthzProject | undefined {
  return viewProjects(tree).find((p) => p.id === id);
}

export function findModule(
  projectId: string,
  moduleId: string,
  tree: readonly AuthzApp[] = AUTHZ_TREE,
): AuthzModule | undefined {
  return findProject(projectId, tree)?.modules.find((m) => m.id === moduleId);
}

/** Módulos que la entrada representa: todos los del proyecto, o el módulo puntual. */
export function entryModules(e: SuiteEntry, tree: readonly AuthzApp[] = AUTHZ_TREE): readonly AuthzModule[] {
  if (e.kind === 'module') {
    const m = e.module ? findModule(e.project, e.module, tree) : undefined;
    return m ? [m] : [];
  }
  return findProject(e.project, tree)?.modules ?? [];
}

/** Ruta a la que lleva la entrada. `''` = no navegable (no se pinta como enlace). */
export function entryRoute(e: SuiteEntry, tree: readonly AuthzApp[] = AUTHZ_TREE): string {
  if (e.kind === 'module') return entryModules(e, tree)[0]?.route ?? '';
  return findProject(e.project, tree)?.route ?? '';
}

export function entryLabel(e: SuiteEntry, tree: readonly AuthzApp[] = AUTHZ_TREE): string {
  if (e.label) return e.label;
  if (e.kind === 'module') return entryModules(e, tree)[0]?.label ?? e.id;
  return findProject(e.project, tree)?.label ?? e.id;
}

export function entryIcon(e: SuiteEntry, tree: readonly AuthzApp[] = AUTHZ_TREE): string {
  return findProject(e.project, tree)?.icon ?? 'pi pi-circle';
}

/**
 * Claves que ABREN la entrada. Si hay `gate.anyOf`, esa lista; si no, la unión `view ∪ manage`
 * de los módulos que tienen ruta. Un módulo sin ruta no cuenta: no hay a dónde ir.
 */
export function entryPermissions(e: SuiteEntry, tree: readonly AuthzApp[] = AUTHZ_TREE): Permission[] {
  if (e.gate?.anyOf) return [...e.gate.anyOf];
  const set = new Set<Permission>();
  for (const m of entryModules(e, tree)) {
    if (!m.route) continue;
    m.view.forEach((p) => set.add(p));
    m.manage.forEach((p) => set.add(p));
  }
  return [...set];
}

const hasAny = (perms: Readonly<Record<string, boolean>>, keys: readonly Permission[]): boolean =>
  keys.some((k) => perms[k] === true);

/**
 * ¿Esta persona ve la entrada? `hideForRoles` gana incluso sobre el god-mode (es un recorte
 * de UX, no de seguridad: el vendedor no debe ver el back-office aunque tenga la clave).
 * Sin ruta no hay entrada. Admin de plataforma ve todo lo demás.
 */
export function isEntryVisible(
  e: SuiteEntry,
  perms: Readonly<Record<string, boolean>>,
  isAdmin: boolean,
  roleName?: string | null,
  tree: readonly AuthzApp[] = AUTHZ_TREE,
): boolean {
  if (e.hideForRoles && roleName && e.hideForRoles.includes(roleName)) return false;
  if (!entryRoute(e, tree)) return false;
  if (isAdmin) return true;
  if (!hasAny(perms, entryPermissions(e, tree))) return false;
  if (e.gate?.alsoAnyOf && !hasAny(perms, e.gate.alsoAnyOf)) return false;
  return true;
}

/** Módulos de la entrada que ESTA persona puede abrir (con ruta). Alimenta la línea secundaria. */
export function accessibleModules(
  e: SuiteEntry,
  perms: Readonly<Record<string, boolean>>,
  isAdmin: boolean,
  tree: readonly AuthzApp[] = AUTHZ_TREE,
): AuthzModule[] {
  return entryModules(e, tree).filter(
    (m) => !!m.route && (isAdmin || hasAny(perms, [...m.view, ...m.manage])),
  );
}

export interface VisibleEntry {
  readonly entry: SuiteEntry;
  readonly label: string;
  readonly icon: string;
  readonly route: string;
  /** `'Ventas › Mayoreo › Atención telefónica'`, o `''`. */
  readonly groupLabel: string;
  /** Módulos abribles por la persona; vacío cuando la entrada es un módulo suelto. */
  readonly modules: readonly AuthzModule[];
}

export interface VisibleSpace {
  readonly space: SuiteSpace;
  readonly entries: readonly VisibleEntry[];
}

export interface VisibleSuiteMap {
  /** Espacios con al menos una entrada visible, en orden §5.1. Nunca incluye `planned` ni la landing. */
  readonly spaces: readonly VisibleSpace[];
  /** Espacios `planned`: se DECLARAN al pie, no se dibujan. */
  readonly declared: readonly SuiteSpace[];
}

export function visibleSuiteMap(
  perms: Readonly<Record<string, boolean>> | null | undefined,
  isAdmin: boolean,
  roleName?: string | null,
  spaces: readonly SuiteSpace[] = SUITE_SPACES,
  tree: readonly AuthzApp[] = AUTHZ_TREE,
): VisibleSuiteMap {
  const p = perms ?? {};
  const ordered = [...spaces].sort((a, b) => a.order - b.order);
  const out: VisibleSpace[] = [];
  for (const space of ordered) {
    if (space.landing || space.status === 'planned') continue;
    const entries: VisibleEntry[] = [];
    for (const e of space.entries) {
      if (!isEntryVisible(e, p, isAdmin, roleName, tree)) continue;
      entries.push({
        entry: e,
        label: entryLabel(e, tree),
        icon: entryIcon(e, tree),
        route: entryRoute(e, tree),
        groupLabel: (e.group ?? []).join(' › '),
        modules: e.kind === 'project' ? accessibleModules(e, p, isAdmin, tree) : [],
      });
    }
    if (entries.length) out.push({ space, entries });
  }
  return { spaces: out, declared: ordered.filter((s) => s.status === 'planned') };
}

/**
 * Destinos PRIMARIOS distintos (entradas de proyecto, sin cross-links). Es lo que decide la
 * auto-entrada: una sola puerta → se entra directo, como hacía la landing vieja.
 */
export function primaryDestinations(vis: VisibleSuiteMap): string[] {
  const routes = new Set<string>();
  for (const s of vis.spaces) {
    for (const v of s.entries) {
      if (v.entry.kind === 'project' && !v.entry.crossLink && v.route) routes.add(v.route);
    }
  }
  return [...routes];
}

// ── URL → proyecto / espacio (para la migaja del layout) ────────────────────

const firstSegment = (url: string): string => {
  const clean = url.split(/[?#]/)[0];
  return '/' + (clean.split('/').filter(Boolean)[0] ?? '');
};

/**
 * Proyecto del árbol al que pertenece una URL, por PRIMER SEGMENTO (no por prefijo de texto:
 * `/administracion` no es `/admin`). Un proyecto con `route: ''` nunca casa — `startsWith('')`
 * es verdadero para cualquier cosa y WhatsApp se llevaría todas las URLs sin proyecto.
 */
export function resolveProjectForUrl(url: string, tree: readonly AuthzApp[] = AUTHZ_TREE): AuthzProject | null {
  const seg = firstSegment(url);
  if (seg === '/') return null;
  return viewProjects(tree).find((p) => !!p.route && firstSegment(p.route) === seg) ?? null;
}

/** Espacio + entrada PRIMARIA (proyecto, no cross-link) que contiene la URL. */
export function resolveSpaceForUrl(
  url: string,
  spaces: readonly SuiteSpace[] = SUITE_SPACES,
  tree: readonly AuthzApp[] = AUTHZ_TREE,
): { space: SuiteSpace; entry: SuiteEntry } | null {
  const project = resolveProjectForUrl(url, tree);
  if (!project) return null;
  for (const space of spaces) {
    const entry = space.entries.find((e) => e.kind === 'project' && !e.crossLink && e.project === project.id);
    if (entry) return { space, entry };
  }
  return null;
}

// ── Validación (lo corre el spec; lo negativo también) ──────────────────────

/**
 * Invariantes del mapa. Devuelve la lista de errores (vacía = sano). Se parametriza para que el
 * test pueda pasarle un mapa ROTO a propósito y ver el rojo — un gate sin prueba negativa es una
 * intención (ADR-056).
 */
export function validateSuiteMap(
  spaces: readonly SuiteSpace[] = SUITE_SPACES,
  unclassified: readonly SuiteEntry[] = SUITE_UNCLASSIFIED,
  tree: readonly AuthzApp[] = AUTHZ_TREE,
): string[] {
  const errors: string[] = [];
  const treePerms = new Set<string>();
  for (const p of viewProjects(tree)) {
    for (const m of p.modules) {
      m.view.forEach((k) => treePerms.add(k));
      m.manage.forEach((k) => treePerms.add(k));
    }
  }
  LEGACY_PERMISSIONS.forEach((k) => treePerms.add(k));

  // Espacios: ids únicos, orden 1..N contiguo.
  const spaceIds = new Set<string>();
  for (const s of spaces) {
    if (spaceIds.has(s.id)) errors.push(`espacio duplicado: ${s.id}`);
    spaceIds.add(s.id);
  }
  const orders = [...spaces].map((s) => s.order).sort((a, b) => a - b);
  orders.forEach((o, i) => {
    if (o !== i + 1) errors.push(`orden no contiguo: se esperaba ${i + 1} y hay ${o}`);
  });

  // Entradas.
  const entryIds = new Set<string>();
  const primaryByProject = new Map<string, string[]>();
  const allEntries: { space: string; e: SuiteEntry }[] = [
    ...spaces.flatMap((s) => s.entries.map((e) => ({ space: s.id, e }))),
    ...unclassified.map((e) => ({ space: '(sin clasificar)', e })),
  ];
  for (const { space, e } of allEntries) {
    if (entryIds.has(e.id)) errors.push(`entrada duplicada: ${e.id}`);
    entryIds.add(e.id);
    const project = findProject(e.project, tree);
    if (!project) {
      errors.push(`${space}/${e.id}: proyecto inexistente en el árbol: ${e.project}`);
      continue;
    }
    if (e.kind === 'module') {
      if (!e.module) errors.push(`${space}/${e.id}: kind module sin module`);
      else if (!findModule(e.project, e.module, tree)) {
        errors.push(`${space}/${e.id}: módulo inexistente: ${e.project}/${e.module}`);
      }
    }
    if (e.kind === 'project' && !e.crossLink) {
      primaryByProject.set(e.project, [...(primaryByProject.get(e.project) ?? []), e.id]);
    }
    if (e.gate) {
      if (!e.gate.reason?.trim()) errors.push(`${space}/${e.id}: gate sin reason`);
      if (!e.gate.anyOf && !e.gate.alsoAnyOf) errors.push(`${space}/${e.id}: gate vacío`);
      for (const k of [...(e.gate.anyOf ?? []), ...(e.gate.alsoAnyOf ?? [])]) {
        if (!treePerms.has(k)) errors.push(`${space}/${e.id}: gate con clave fuera del árbol y de LEGACY: ${k}`);
      }
    }
    if (!e.source?.cite?.trim()) errors.push(`${space}/${e.id}: sin cita de la especificación`);
  }

  // Cada proyecto de `view` tiene EXACTAMENTE una casa primaria (espacio o sin clasificar).
  for (const p of viewProjects(tree)) {
    const homes = primaryByProject.get(p.id) ?? [];
    if (homes.length !== 1) {
      errors.push(`proyecto ${p.id}: ${homes.length} entradas primarias (${homes.join(', ') || 'ninguna'}); debe ser 1`);
    }
  }
  // Un cross-link apunta a algo que ya tiene casa.
  for (const { space, e } of allEntries) {
    if (e.crossLink && !(primaryByProject.get(e.project) ?? []).length) {
      errors.push(`${space}/${e.id}: cross-link a un proyecto sin entrada primaria (${e.project})`);
    }
  }
  // Estado vs contenido.
  for (const s of spaces) {
    if (s.landing) {
      if (s.entries.length) errors.push(`${s.id}: la landing no lleva entradas`);
      continue;
    }
    if (s.status === 'planned' && s.entries.length) errors.push(`${s.id}: planned con entradas`);
    if (s.status !== 'planned' && !s.entries.length) errors.push(`${s.id}: ${s.status} sin entradas`);
    if (s.status === 'proposed' && !s.proposal) errors.push(`${s.id}: proposed sin decisión pendiente (P-xx)`);
  }
  return errors;
}
