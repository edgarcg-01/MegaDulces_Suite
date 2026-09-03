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
  // Reemplazado por REPARTO_DESPACHAR + REPARTO_ENTREGAR (proyecto Reparto propio).
  Permission.LOGISTICS_HOME_DISPATCH,
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
          { id: 'salidas', label: 'Salidas por producto', route: '/comercial/salidas', view: [Permission.COMMERCIAL_SALIDAS_VER], manage: [] },
          { id: 'route-sales', label: 'Ventas por ruta', route: '/comercial/ventas-por-ruta', view: [Permission.COMMERCIAL_ROUTE_SALES_VER], manage: [] },
          { id: 'sales-docs', label: 'Documentos de venta', route: '/comercial/documentos', view: [Permission.COMMERCIAL_SALES_DOCS_VER], manage: [] },
          { id: 'customers360', label: 'Clientes 360', route: '/comercial/customers-360', view: [Permission.COMMERCIAL_CUSTOMERS360_VER], manage: [] },
          { id: 'historical', label: 'Histórico de venta', route: '/comercial/historical', view: [Permission.COMMERCIAL_HISTORICAL_VER], manage: [] },
          { id: 'customers', label: 'Clientes', route: '/comercial/customers', view: [Permission.COMMERCIAL_CUSTOMERS_VER], manage: [Permission.COMMERCIAL_CUSTOMERS_GESTIONAR] },
          { id: 'cartera', label: 'Cartera / asignación', route: '/comercial/cartera', view: [Permission.COMMERCIAL_CARTERA_VER], manage: [Permission.COMMERCIAL_CARTERA_GESTIONAR] },
          { id: 'pricing', label: 'Precios', route: '/comercial/pricing', view: [Permission.COMMERCIAL_PRICING_VER], manage: [Permission.COMMERCIAL_PRICING_GESTIONAR] },
          { id: 'promotions', label: 'Promociones', route: '/comercial/promotions', view: [Permission.COMMERCIAL_PROMOTIONS_VER], manage: [Permission.COMMERCIAL_PROMOTIONS_GESTIONAR] },
          { id: 'erp-promos', label: 'Promos del ERP', route: '/comercial/erp-promos', view: [Permission.COMMERCIAL_ERP_PROMOS_VER], manage: [] },
          { id: 'vendor-sales', label: 'Ventas de vendedor', route: '/comercial/vendor-sales', view: [Permission.COMMERCIAL_VENDOR_SALES_VER], manage: [] },
          { id: 'products', label: 'Productos', route: '/comercial/products', view: [Permission.COMMERCIAL_PRODUCTS_VER], manage: [Permission.COMMERCIAL_PRODUCTS_GESTIONAR] },
          { id: 'thot', label: 'Thot / IA comercial', route: '/comercial/thot-chat', view: [Permission.COMMERCIAL_THOT_VER], manage: [Permission.COMMERCIAL_THOT_GESTIONAR] },
          { id: 'route-control', label: 'Control de ruta / tickets', route: '/comercial/route-tickets', view: [Permission.ROUTE_CONTROL_VER], manage: [Permission.ROUTE_TICKET_CAPTURE] },
          { id: 'carga', label: 'Carga al camión', route: '/comercial/orders', view: [Permission.COMMERCIAL_CARGA_VER], manage: [Permission.COMMERCIAL_CARGA_GESTIONAR] },
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
          { id: 'receiving-auditor', label: 'Recepción (caducidad)', route: '/almacen/inventory/recepcion', view: [Permission.COMMERCIAL_INVENTORY_RECIBIR], manage: [Permission.COMMERCIAL_INVENTORY_RECIBIR, Permission.COMMERCIAL_INVENTORY_SUPERVISAR] },
          { id: 'prevention', label: 'Prevención de inventarios', route: '/almacen/prevencion', view: [Permission.COMMERCIAL_PREVENTION_VER], manage: [Permission.COMMERCIAL_PREVENTION_GESTIONAR] },
          { id: 'caducidades', label: 'Control de Caducidades', route: '/almacen/inventory/caducidades', view: [Permission.COMMERCIAL_EXPIRY_VER], manage: [Permission.COMMERCIAL_EXPIRY_CAPTURAR] },
          { id: 'dead-stock', label: 'Stock muerto', route: '/almacen/dead-stock', view: [Permission.COMMERCIAL_DEADSTOCK_VER], manage: [] },
          { id: 'inventory-health', label: 'Salud de inventario', route: '/almacen/inventory-health', view: [Permission.COMMERCIAL_INVHEALTH_VER], manage: [] },
          { id: 'cuadre', label: 'Cuadre / Supervisor de movimientos', route: '/almacen/cuadre', view: [Permission.RECONCILIATION_VER], manage: [Permission.RECONCILIATION_GESTIONAR] },
          { id: 'movimientos', label: 'Diario de movimientos', route: '/almacen/movimientos', view: [Permission.COMMERCIAL_MOVEMENTS_VER], manage: [Permission.COMMERCIAL_MOVEMENTS_GESTIONAR] },
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
          { id: 'store-arqueo', label: 'Arqueo ciego de caja', route: '/tienda/arqueo', view: [Permission.STORE_ARQUEO_VER], manage: [Permission.STORE_ARQUEO_CAPTURAR] },
          { id: 'store-caducidades', label: 'Control de Caducidades', route: '/tienda/caducidades', view: [Permission.COMMERCIAL_EXPIRY_VER], manage: [Permission.COMMERCIAL_EXPIRY_CAPTURAR] },
          { id: 'store-analytics', label: 'Análisis de ventas', route: '/tienda/analisis-semanal', view: [Permission.STORE_ANALYTICS_VER], manage: [] },
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
          { id: 'compras-pedido', label: 'Pedido', route: '/compras/pedido', view: [Permission.COMPRAS_PEDIDO_VER], manage: [Permission.COMPRAS_PEDIDO_GESTIONAR] },
          { id: 'compras-red', label: 'Red de abasto', route: '/compras/red', view: [Permission.COMPRAS_RED_VER], manage: [Permission.COMPRAS_RED_GESTIONAR] },
          { id: 'compras-requisiciones', label: 'Requisiciones', route: '/compras/requisiciones', view: [Permission.COMPRAS_REQUISICIONES_VER], manage: [Permission.COMPRAS_REQUISICIONES_GESTIONAR] },
          { id: 'compras-ordenes', label: 'Órdenes de compra', route: '/compras/ordenes', view: [Permission.COMPRAS_ORDENES_VER], manage: [Permission.COMPRAS_ORDENES_GESTIONAR] },
          { id: 'compras-oc-abiertas', label: 'Abiertas en Kepler', route: '/compras/oc-abiertas', view: [Permission.COMPRAS_PEDIDO_VER], manage: [] },
          { id: 'compras-entradas', label: 'Órdenes de entrada', route: '/compras/entradas', view: [Permission.COMPRAS_ENTRADAS_VER], manage: [Permission.COMPRAS_ENTRADAS_GESTIONAR, Permission.COMPRAS_ENTRADAS_VALIDAR] },
          // RE.20.1 — fusionada con `Control de entradas · Listado`: es la misma pantalla con
          // otro lente, así que la gatea el mismo permiso.
          //
          // `[AUTHZ.5]` — Acá decía que `COMPRAS_360_VER` "queda huérfano a propósito… un permiso
          // de más no le abre nada a nadie". Es cierto para el árbol y **falso para el guard**:
          // `purchase-adjustments.controller` exige esa clave en 2 rutas (`compras-360` y sus
          // filtros), que son las que llenan esta tabla. Estando fuera del árbol no se podía
          // otorgar a un rol nuevo desde `/admin/roles`. Va como `view` junto al otro.
          { id: 'compras-360', label: 'Costo por compra', route: '/compras/costo-por-compra', view: [Permission.COMPRAS_ENTRADAS_VER, Permission.COMPRAS_360_VER], manage: [] },
          { id: 'compras-costo-neto', label: 'Costo por proveedor', route: '/compras/costo-neto', view: [Permission.COMPRAS_COSTO_NETO_VER], manage: [] },
          { id: 'compras-descuentos', label: 'Descuentos y apoyos', route: '/compras/descuentos', view: [Permission.COMPRAS_DESCUENTOS_VER], manage: [Permission.COMPRAS_DESCUENTOS_GESTIONAR] },
          { id: 'compras-hallazgos', label: 'Hallazgos', route: '/compras/hallazgos', view: [Permission.COMPRAS_HALLAZGOS_VER], manage: [Permission.COMPRAS_HALLAZGOS_GESTIONAR] },
          { id: 'compras-proveedores', label: 'Proveedores', route: '/compras/proveedores', view: [Permission.COMPRAS_PROVEEDORES_VER], manage: [Permission.COMPRAS_PROVEEDORES_GESTIONAR] },
          { id: 'compras-categorias', label: 'Categorías', route: '/compras/categorias', view: [Permission.COMPRAS_CATEGORIAS_VER], manage: [Permission.COMPRAS_CATEGORIAS_GESTIONAR] },
        ],
      },
      {
        id: 'finanzas',
        label: 'Finanzas',
        icon: 'pi pi-wallet',
        route: '/finanzas',
        modules: [
          { id: 'bancos', label: 'Bancos (conciliación)', route: '/finanzas/bancos', view: [Permission.FINANCE_BANK_VER], manage: [Permission.FINANCE_BANK_GESTIONAR] },
          { id: 'cobranza', label: 'Cobranza (comprobantes)', route: '/finanzas/cobranza', view: [Permission.FINANCE_COLLECTIONS_VER], manage: [Permission.FINANCE_COLLECTIONS_GESTIONAR] },
          { id: 'cartera', label: 'Cartera de clientes', route: '/finanzas/cartera', view: [Permission.FINANCE_RECEIVABLES_VER], manage: [] },
          { id: 'pagos-comprobantes', label: 'Pagos a proveedor (comprobantes)', route: '/finanzas/pagos-comprobantes', view: [Permission.FINANCE_PAYMENTS_VER], manage: [Permission.FINANCE_PAYMENTS_GESTIONAR] },
          // `[AUTHZ.5]` `FINANCE_RECON_RECIBIR` estaba en el enum y **fuera del árbol**: no se podía
          // otorgar desde acá. No es un permiso de pantalla sino un MARCADOR — `maat-recon-tasks`
          // consulta `role_permissions` directo para saber a qué roles repartirle tareas. Sin
          // casilla, el equipo de conciliación sólo se podía cambiar por SQL.
          { id: 'tareas', label: 'Tareas de conciliación', route: '/finanzas/tareas', view: [Permission.FINANCE_BANK_VER], manage: [Permission.FINANCE_RECON_ASIGNAR, Permission.FINANCE_RECON_RECIBIR] },
          { id: 'egresos', label: 'Egresos contables', route: '/finanzas/egresos', view: [Permission.FINANCE_EXPENSES_VER], manage: [] },
          { id: 'solicitudes', label: 'Solicitudes de gasto (evidencia)', route: '/finanzas/solicitudes', view: [Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_VER_ALL], manage: [Permission.FINANCE_EXPENSES_COMPROBAR, Permission.FINANCE_FINDINGS_GESTIONAR] },
          { id: 'capturar-gasto', label: 'Capturar gasto (comprobante)', route: '/finanzas/capturar-gasto', view: [Permission.FINANCE_EXPENSES_CAPTURAR, Permission.FINANCE_EXPENSES_VER], manage: [] },
          { id: 'hallazgos', label: 'Hallazgos', route: '/finanzas/hallazgos', view: [Permission.FINANCE_AI_CHAT], manage: [Permission.FINANCE_FINDINGS_GESTIONAR] },
          { id: 'maat', label: 'Pregúntale a Maat', route: '/finanzas/maat', view: [Permission.FINANCE_AI_CHAT], manage: [Permission.FINANCE_FINDINGS_GESTIONAR] },
        ],
      },
      {
        id: 'contabilidad',
        label: 'Contabilidad',
        icon: 'pi pi-calculator',
        route: '/contabilidad',
        modules: [
          { id: 'listas-sat', label: 'Listas SAT (EFOS 69-B / Art. 69)', route: '/contabilidad/listas-sat', view: [Permission.FISCAL_LISTAS_VER], manage: [Permission.FISCAL_LISTAS_GESTIONAR] },
          { id: 'cfdi', label: 'CFDI', route: '/contabilidad/cfdi', view: [Permission.FISCAL_CFDI_VER], manage: [] },
          // Un solo módulo con dos pantallas (no asociados + libro completo del mes); el
          // par de permisos vive acá y en ningún otro nodo. La ruta apunta a la principal.
          { id: 'libro-compras', label: 'Libro de Compras (no asociados → TXT a ContPAQi)', route: '/contabilidad/movimientos-no-asociados', view: [Permission.FISCAL_PURCHASE_BOOK_VER], manage: [Permission.FISCAL_PURCHASE_BOOK_GESTIONAR] },
          { id: 'facturar', label: 'Facturación (emisión CFDI)', route: '/contabilidad/facturar', view: [Permission.FISCAL_FACTURAR_VER], manage: [Permission.FISCAL_FACTURAR_GESTIONAR] },
          { id: 'conciliacion', label: 'Conciliación fiscal', route: '/contabilidad/conciliacion', view: [Permission.FISCAL_CONCILIACION_VER], manage: [] },
          { id: 'diot', label: 'DIOT / IVA', route: '/contabilidad/diot', view: [Permission.FISCAL_DIOT_VER], manage: [] },
          { id: 'descarga', label: 'Descarga masiva CFDI', route: '/contabilidad/descarga', view: [Permission.FISCAL_DESCARGA_VER], manage: [Permission.FISCAL_DESCARGA_GESTIONAR] },
          { id: 'materialidad', label: 'Expediente de materialidad', route: '/contabilidad/materialidad', view: [Permission.FISCAL_MATERIALIDAD_VER], manage: [Permission.FISCAL_MATERIALIDAD_GESTIONAR] },
          { id: 'contabilidad', label: 'Contabilidad electrónica', route: '/contabilidad/contabilidad', view: [Permission.FISCAL_CONTAB_VER], manage: [Permission.FISCAL_CONTAB_GESTIONAR] },
          { id: 'impuestos', label: 'Impuestos provisionales', route: '/contabilidad/impuestos', view: [Permission.FISCAL_IMPUESTOS_VER], manage: [] },
          { id: 'credenciales', label: 'Credenciales SAT (e.firma)', route: '/contabilidad/credenciales', view: [], manage: [Permission.FISCAL_CREDENCIALES_GESTIONAR] },
        ],
      },
      {
        id: 'reparto',
        label: 'Reparto / Última Milla',
        icon: 'pi pi-send',
        route: '/reparto',
        modules: [
          { id: 'reparto-despacho', label: 'Despacho (tienda)', route: '/reparto', view: [Permission.REPARTO_DESPACHAR], manage: [] },
          { id: 'reparto-entrega', label: 'Entrega (repartidor)', route: '/reparto', view: [Permission.REPARTO_ENTREGAR], manage: [] },
        ],
      },
      {
        // `[AUTHZ.5]` — El bot de WhatsApp **no tiene pantalla todavía** (`libs/whatsapp` es sólo
        // backend), pero sus dos permisos ya los exige `whatsapp-broadcast.controller` en 4 rutas.
        // Estando fuera del árbol no había forma de otorgarlos desde `/admin/roles`: los 9 usuarios
        // que hoy los tienen los recibieron por seed, y un rol nuevo no podía. `route` vacío porque
        // aún no hay a dónde ir — el nodo existe para poder repartir el permiso, que es el punto.
        id: 'whatsapp',
        label: 'WhatsApp (bot)',
        icon: 'pi pi-whatsapp',
        route: '',
        modules: [
          { id: 'whatsapp-bot', label: 'Bot conversacional', route: '', view: [Permission.WHATSAPP_BOT_VER], manage: [Permission.WHATSAPP_BOT_GESTIONAR] },
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
