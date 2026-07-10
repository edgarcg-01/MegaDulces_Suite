import { Permission } from './permissions';

/**
 * AUTHZ_TREE — fuente de verdad de la jerarquía de autorización
 * (App → Proyecto → Módulo → {Ver, Gestionar}).
 *
 * Es una capa de PRESENTACIÓN sobre los permisos atómicos: el editor de roles
 * la usa para asignar permisos por app / proyecto / módulo, pero al guardar todo
 * se colapsa al mismo `Record<string, boolean>` que consume el backend. Los
 * guards NO leen este árbol; siguen validando permisos atómicos.
 *
 * Reglas del modelo (Fase AZ):
 *  - Sin permisos compartidos: cada permiso vive en UN solo módulo (o app).
 *  - Ver + Gestionar por módulo; acciones finas cuelgan de Gestionar.
 *  - Apps Vendedor y Portal = acceso general (un solo permiso, entras/no entras).
 *
 * Al agregar un permiso al enum hay que ubicarlo aquí (o marcarlo LEGACY) o el
 * test de completitud (`authz-tree.spec.ts`) fallará.
 *
 * Ver docs/IMPLEMENTACION/FASES/FASE_AZ_AUTHZ_JERARQUICO.md.
 */

export type AuthzAppId = 'view' | 'vendor' | 'portal';

export interface AuthzModule {
  /** id estable (para el árbol de la UI y como key de selección). */
  id: string;
  label: string;
  /** Ruta representativa del módulo (trazabilidad / navegación). */
  route?: string;
  /** Permisos de lectura del módulo. */
  view: Permission[];
  /** Permisos de gestión/acción del módulo (crear, editar, aprobar…). */
  manage: Permission[];
}

export interface AuthzProject {
  id: string;
  label: string;
  /** Icono PrimeNG (reusable por la landing /projects). */
  icon: string;
  /** Prefijo de ruta del proyecto. */
  route: string;
  modules: AuthzModule[];
}

export interface AuthzApp {
  id: AuthzAppId;
  label: string;
  icon: string;
  /** 'workspace' = se desglosa en proyectos/módulos. 'access' = un solo toggle. */
  kind: 'workspace' | 'access';
  /** Solo para kind 'access': el permiso de acceso a la app. */
  accessPermission?: Permission;
  /** Solo para kind 'workspace'. */
  projects: AuthzProject[];
}

/**
 * Permisos que existen en el enum por retrocompatibilidad pero YA NO se asignan
 * desde la UI (su función se movió a permisos dedicados por módulo). El backfill
 * los usa como origen; se eliminan del enum en F4.
 */
export const LEGACY_PERMISSIONS: readonly Permission[] = [
  // Repartido en TRADE_ROUTE_PLAN_* (agenda de rutas) + COMMERCIAL_CARTERA_* (cartera).
  Permission.USUARIOS_ASIGNAR_RUTA,
];

export const AUTHZ_TREE: readonly AuthzApp[] = [
  // ═══════════════════════════════════════════════════════════════════════
  // APP: Plataforma Web (apps/view)
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'view',
    label: 'Plataforma Web',
    icon: 'pi pi-desktop',
    kind: 'workspace',
    projects: [
      {
        id: 'admin',
        label: 'Administración',
        icon: 'pi pi-cog',
        route: '/admin',
        modules: [
          { id: 'users', label: 'Usuarios', route: '/admin/users', view: [Permission.USUARIOS_VER], manage: [Permission.USUARIOS_GESTIONAR, Permission.USUARIOS_PASSWORDS] },
          { id: 'roles', label: 'Roles y permisos', route: '/admin/roles', view: [Permission.ROLES_VER], manage: [Permission.ROLES_CONFIGURAR] },
        ],
      },
      {
        id: 'trade',
        label: 'Auditoría en Ruta',
        icon: 'pi pi-chart-bar',
        route: '/dashboard',
        modules: [
          { id: 'captures', label: 'Captura y visitas', route: '/dashboard/captures', view: [Permission.VISITAS_VER], manage: [Permission.VISITAS_REGISTRAR, Permission.VISITAS_AUDITAR, Permission.CAPTURE_TICKET_USE] },
          { id: 'reports', label: 'Reportes operativos', route: '/dashboard/reports', view: [Permission.REPORTES_VER_PROPIO, Permission.REPORTES_VER_EQUIPO, Permission.REPORTES_VER_GLOBAL], manage: [Permission.REPORTES_EXPORTAR, Permission.REPORTES_GESTIONAR] },
          { id: 'seguimiento', label: 'Seguimiento en ruta', route: '/dashboard/seguimiento', view: [Permission.VER_SEGUIMIENTO], manage: [] },
          { id: 'routes', label: 'Análisis de rutas', route: '/dashboard/routes', view: [Permission.RUTAS_VER], manage: [] },
          { id: 'commercial-map', label: 'Mapa comercial y prospección', route: '/dashboard/commercial-map', view: [Permission.COMMERCIAL_MAP_VER, Permission.COMMERCIAL_MAP_PROSPECTS_VER], manage: [Permission.COMMERCIAL_MAP_PROSPECTS_GESTIONAR] },
          { id: 'supervisor-ai', label: 'Supervisor AI (Horus)', route: '/dashboard/supervisor-ai', view: [Permission.SUPERVISOR_AI_VER], manage: [Permission.SUPERVISOR_AI_APROBAR] },
          { id: 'stores', label: 'Tiendas', route: '/dashboard/stores', view: [Permission.TIENDAS_VER], manage: [Permission.TIENDAS_CREAR] },
          { id: 'catalogs', label: 'Catálogos de captura', route: '/dashboard/admin/catalogs', view: [], manage: [Permission.CATALOGO_GESTIONAR] },
          { id: 'scoring', label: 'Scoring', route: '/dashboard/admin/scoring', view: [Permission.SCORING_CONFIG_VER], manage: [Permission.SCORING_CONFIG_GESTIONAR] },
          { id: 'planograma', label: 'Planogramas', route: '/dashboard/admin/planograma', view: [], manage: [Permission.PLANOGRAMAS_GESTIONAR] },
          { id: 'route-plan', label: 'Agenda de rutas', route: '/dashboard/daily-assignments', view: [Permission.TRADE_ROUTE_PLAN_VER], manage: [Permission.TRADE_ROUTE_PLAN_GESTIONAR] },
        ],
      },
      {
        id: 'comercial',
        label: 'Comercial / Ventas',
        icon: 'pi pi-shopping-cart',
        route: '/comercial',
        modules: [
          { id: 'orders', label: 'Pedidos', route: '/comercial/orders', view: [Permission.COMMERCIAL_ORDERS_VER], manage: [Permission.COMMERCIAL_ORDERS_CREAR, Permission.COMMERCIAL_ORDERS_CONFIRMAR, Permission.COMMERCIAL_ORDERS_CANCELAR, Permission.COMMERCIAL_ORDERS_FULFILL, Permission.COMMERCIAL_PAYMENTS_REGISTRAR, Permission.COMMERCIAL_PAYMENTS_VERIFICAR, Permission.COMMERCIAL_PAYMENTS_REVERSAR, Permission.COMMERCIAL_RIDER_LIQUIDATION_GESTIONAR] },
          { id: 'analytics', label: 'Analítica comercial', route: '/comercial/command-center', view: [Permission.COMMERCIAL_ANALYTICS_VER], manage: [] },
          { id: 'sellout', label: 'Sell-Out por empresa', route: '/comercial/sell-out', view: [Permission.COMMERCIAL_SELLOUT_VER], manage: [] },
          { id: 'customers', label: 'Clientes', route: '/comercial/customers', view: [Permission.COMMERCIAL_CUSTOMERS_VER], manage: [Permission.COMMERCIAL_CUSTOMERS_GESTIONAR] },
          { id: 'cartera', label: 'Cartera / asignación', route: '/comercial/cartera', view: [Permission.COMMERCIAL_CARTERA_VER], manage: [Permission.COMMERCIAL_CARTERA_GESTIONAR] },
          { id: 'pricing', label: 'Precios', route: '/comercial/pricing', view: [Permission.COMMERCIAL_PRICING_VER], manage: [Permission.COMMERCIAL_PRICING_GESTIONAR] },
          { id: 'promotions', label: 'Promociones', route: '/comercial/promotions', view: [Permission.COMMERCIAL_PROMOTIONS_VER], manage: [Permission.COMMERCIAL_PROMOTIONS_GESTIONAR] },
          { id: 'products', label: 'Productos', route: '/comercial/products', view: [Permission.COMMERCIAL_PRODUCTS_VER], manage: [Permission.COMMERCIAL_PRODUCTS_GESTIONAR] },
          { id: 'thot', label: 'Thot / IA comercial', route: '/comercial/thot-chat', view: [Permission.COMMERCIAL_THOT_VER], manage: [Permission.COMMERCIAL_THOT_GESTIONAR] },
          { id: 'route-control', label: 'Control de ruta / tickets', route: '/comercial/route-tickets', view: [Permission.ROUTE_CONTROL_VER], manage: [Permission.ROUTE_TICKET_CAPTURE] },
        ],
      },
      {
        id: 'almacen',
        label: 'Almacén',
        icon: 'pi pi-box',
        route: '/almacen',
        modules: [
          { id: 'inventory', label: 'Existencias', route: '/almacen/inventory', view: [Permission.COMMERCIAL_INVENTORY_VER], manage: [Permission.COMMERCIAL_INVENTORY_AJUSTAR] },
          { id: 'warehouses', label: 'Almacenes', route: '/almacen/warehouses', view: [Permission.COMMERCIAL_WAREHOUSES_VER], manage: [Permission.COMMERCIAL_WAREHOUSES_GESTIONAR] },
          { id: 'physical-inventory', label: 'Inventario físico', route: '/almacen/inventory/sessions', view: [Permission.COMMERCIAL_INVENTORY_SUPERVISAR], manage: [Permission.COMMERCIAL_INVENTORY_CONTAR, Permission.COMMERCIAL_INVENTORY_RECONCILIAR, Permission.COMMERCIAL_INVENTORY_ASIGNAR] },
        ],
      },
      {
        id: 'logistica',
        label: 'Logística',
        icon: 'pi pi-truck',
        route: '/logistica',
        modules: [
          { id: 'shipments', label: 'Embarques', route: '/logistica/shipments', view: [Permission.LOGISTICS_SHIPMENTS_VER], manage: [Permission.LOGISTICS_SHIPMENTS_GESTIONAR] },
          { id: 'guides', label: 'Guías', route: '/logistica/guides', view: [Permission.LOGISTICS_GUIDES_VER], manage: [Permission.LOGISTICS_GUIDES_GESTIONAR] },
          { id: 'fleet', label: 'Flotilla y personal', route: '/logistica/fleet', view: [Permission.LOGISTICS_FLEET_VER], manage: [Permission.LOGISTICS_FLEET_GESTIONAR] },
          { id: 'expenses', label: 'Costos', route: '/logistica/costs', view: [Permission.LOGISTICS_EXPENSES_VER], manage: [Permission.LOGISTICS_EXPENSES_GESTIONAR] },
          { id: 'payroll', label: 'Liquidaciones / nómina', route: '/logistica/payroll', view: [Permission.LOGISTICS_PAYROLL_VER], manage: [Permission.LOGISTICS_PAYROLL_GESTIONAR] },
          { id: 'cartaporte', label: 'Carta Porte', route: '/logistica/shipments', view: [Permission.LOGISTICS_CARTAPORTE_VER], manage: [Permission.LOGISTICS_CARTAPORTE_GESTIONAR] },
          { id: 'transfers', label: 'Traspasos', route: '/logistica/traspasos', view: [Permission.LOGISTICS_TRANSFERS_VER], manage: [] },
          { id: 'config', label: 'Configuración', route: '/logistica/config', view: [], manage: [Permission.LOGISTICS_CONFIG_GESTIONAR] },
        ],
      },
      {
        id: 'pdv',
        label: 'Punto de Venta',
        icon: 'pi pi-shop',
        route: '/tienda',
        modules: [
          { id: 'store-live', label: 'Tienda en Vivo', route: '/tienda/live', view: [Permission.STORE_LIVE_VER], manage: [] },
          { id: 'store-labels', label: 'Etiquetas de anaquel', route: '/tienda/etiquetas', view: [Permission.STORE_LABELS_VER], manage: [] },
        ],
      },
      {
        id: 'televenta',
        label: 'Televenta',
        icon: 'pi pi-headphones',
        route: '/televenta',
        modules: [
          { id: 'televenta', label: 'Televenta', route: '/televenta', view: [Permission.COMMERCIAL_TELEVENTA_VER], manage: [Permission.COMMERCIAL_TELEVENTA_OPERATE] },
        ],
      },
      {
        id: 'compras',
        label: 'Compras / Reabastecimiento',
        icon: 'pi pi-shopping-bag',
        route: '/compras',
        modules: [
          { id: 'compras', label: 'Compras', route: '/compras', view: [Permission.COMPRAS_VER], manage: [Permission.COMPRAS_GESTIONAR] },
        ],
      },
      {
        id: 'finanzas',
        label: 'Finanzas',
        icon: 'pi pi-wallet',
        route: '/finanzas',
        modules: [
          { id: 'egresos', label: 'Egresos contables', route: '/finanzas/egresos', view: [Permission.FINANCE_EXPENSES_VER], manage: [] },
          { id: 'hallazgos', label: 'Hallazgos', route: '/finanzas/hallazgos', view: [Permission.FINANCE_AI_CHAT], manage: [Permission.FINANCE_FINDINGS_GESTIONAR] },
          { id: 'maat', label: 'Pregúntale a Maat', route: '/finanzas/maat', view: [Permission.FINANCE_AI_CHAT], manage: [Permission.FINANCE_FINDINGS_GESTIONAR] },
        ],
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // APP: Vendedor (apps/vendor) — acceso general
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'vendor',
    label: 'App Vendedor',
    icon: 'pi pi-briefcase',
    kind: 'access',
    accessPermission: Permission.VENDOR_APP_ACCESS,
    projects: [],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // APP: Portal B2B (apps/portal) — acceso general
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'portal',
    label: 'Portal B2B',
    icon: 'pi pi-shop',
    kind: 'access',
    accessPermission: Permission.PORTAL_B2B_ACCESS,
    projects: [],
  },
];

/** Todos los permisos referenciados por el árbol (hojas + accesos de app). */
export function allTreePermissions(): Set<Permission> {
  const set = new Set<Permission>();
  for (const app of AUTHZ_TREE) {
    if (app.accessPermission) set.add(app.accessPermission);
    for (const project of app.projects) {
      for (const mod of project.modules) {
        mod.view.forEach((p) => set.add(p));
        mod.manage.forEach((p) => set.add(p));
      }
    }
  }
  return set;
}
