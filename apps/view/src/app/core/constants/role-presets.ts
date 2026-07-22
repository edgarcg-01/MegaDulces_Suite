import { Permission } from './permissions';

/**
 * Plantillas de roles por ÁREA (organigrama Mega Dulces).
 *
 * Modelo (decidido 2026-07-11): 1 rol por área con permisos en 2 niveles.
 *   - PRIMARIO: los módulos core del área → VER + GESTIONAR.
 *   - SECUNDARIO: módulos de otras áreas, "por orden y estética" → también
 *     VER + GESTIONAR (preferencia del usuario), salvo `prevencion_auditoria`
 *     que recibe el secundario en SOLO-VER (un auditor no opera lo que audita).
 *   `sistemas` = acceso total (todos los grupos, full).
 *
 * Fuente única: `MODULE_GROUPS` + `AREA_PRESETS`. La migración
 * `..._area_role_presets_seed.js` replica esta misma composición para crear los
 * roles en DB; el editor de /admin/roles la usa para el botón "Aplicar plantilla".
 */

/** Grupos de permisos por módulo/proyecto. */
export const MODULE_GROUPS: Record<string, Permission[]> = {
  usuarios: [
    Permission.USUARIOS_VER,
    Permission.USUARIOS_GESTIONAR,
    Permission.USUARIOS_PASSWORDS,
    Permission.USUARIOS_ASIGNAR_RUTA,
  ],
  roles: [Permission.ROLES_VER, Permission.ROLES_CONFIGURAR],
  trade: [
    Permission.VISITAS_REGISTRAR,
    Permission.VISITAS_VER,
    Permission.VISITAS_AUDITAR,
    Permission.REPORTES_VER_PROPIO,
    Permission.REPORTES_VER_EQUIPO,
    Permission.REPORTES_VER_GLOBAL,
    Permission.REPORTES_EXPORTAR,
    Permission.REPORTES_GESTIONAR,
    Permission.CATALOGO_GESTIONAR,
    Permission.PLANOGRAMAS_GESTIONAR,
    Permission.TIENDAS_VER,
    Permission.TIENDAS_CREAR,
    Permission.SCORING_CONFIG_VER,
    Permission.SCORING_CONFIG_GESTIONAR,
    Permission.VER_SEGUIMIENTO,
    Permission.TRADE_ROUTE_PLAN_VER,
    Permission.TRADE_ROUTE_PLAN_GESTIONAR,
  ],
  rutas: [
    Permission.RUTAS_VER,
    Permission.COMMERCIAL_MAP_VER,
    Permission.COMMERCIAL_MAP_PROSPECTS_VER,
    Permission.COMMERCIAL_MAP_PROSPECTS_GESTIONAR,
    Permission.ROUTE_CONTROL_VER,
    Permission.ROUTE_TICKET_CAPTURE,
    Permission.COMMERCIAL_VENDOR_SALES_VER,
  ],
  supervisor_ai: [Permission.SUPERVISOR_AI_VER, Permission.SUPERVISOR_AI_APROBAR],
  tienda: [Permission.STORE_LIVE_VER, Permission.STORE_LABELS_VER, Permission.STORE_ARQUEO_CAPTURAR, Permission.STORE_ARQUEO_VER, Permission.STORE_ANALYTICS_VER],
  comercial: [
    Permission.COMMERCIAL_CUSTOMERS_VER,
    Permission.COMMERCIAL_CUSTOMERS_GESTIONAR,
    Permission.COMMERCIAL_PRICING_VER,
    Permission.COMMERCIAL_PRICING_GESTIONAR,
    Permission.COMMERCIAL_PRODUCTS_VER,
    Permission.COMMERCIAL_PRODUCTS_GESTIONAR,
    Permission.COMMERCIAL_CARTERA_VER,
    Permission.COMMERCIAL_CARTERA_GESTIONAR,
    Permission.COMMERCIAL_ORDERS_VER,
    Permission.COMMERCIAL_ORDERS_CREAR,
    Permission.COMMERCIAL_ORDERS_CONFIRMAR,
    Permission.COMMERCIAL_ORDERS_CANCELAR,
    Permission.COMMERCIAL_ORDERS_FULFILL,
    Permission.COMMERCIAL_PROMOTIONS_VER,
    Permission.COMMERCIAL_PROMOTIONS_GESTIONAR,
    Permission.COMMERCIAL_ERP_PROMOS_VER,
    Permission.COMMERCIAL_THOT_VER,
    Permission.COMMERCIAL_THOT_GESTIONAR,
  ],
  pagos: [
    Permission.COMMERCIAL_PAYMENTS_REGISTRAR,
    Permission.COMMERCIAL_PAYMENTS_VERIFICAR,
    Permission.COMMERCIAL_PAYMENTS_REVERSAR,
    Permission.COMMERCIAL_RIDER_LIQUIDATION_GESTIONAR,
  ],
  analytics: [
    Permission.COMMERCIAL_ANALYTICS_VER,
    Permission.COMMERCIAL_SELLOUT_VER,
    Permission.COMMERCIAL_SALIDAS_VER,
    Permission.COMMERCIAL_ROUTE_SALES_VER,
    Permission.COMMERCIAL_CUSTOMERS360_VER,
    Permission.COMMERCIAL_HISTORICAL_VER,
    Permission.COMMERCIAL_DEADSTOCK_VER,
    Permission.COMMERCIAL_INVHEALTH_VER,
  ],
  almacen: [
    Permission.COMMERCIAL_INVENTORY_VER,
    Permission.COMMERCIAL_INVENTORY_AJUSTAR,
    Permission.COMMERCIAL_INVENTORY_CONTAR,
    Permission.COMMERCIAL_INVENTORY_SUPERVISAR,
    Permission.COMMERCIAL_INVENTORY_RECONCILIAR,
    Permission.COMMERCIAL_INVENTORY_ASIGNAR,
    Permission.COMMERCIAL_WAREHOUSES_VER,
    Permission.COMMERCIAL_WAREHOUSES_GESTIONAR,
  ],
  cuadre: [Permission.RECONCILIATION_VER, Permission.RECONCILIATION_GESTIONAR],
  compras: [Permission.COMPRAS_VER, Permission.COMPRAS_GESTIONAR],
  logistica: [
    Permission.LOGISTICS_FLEET_VER,
    Permission.LOGISTICS_FLEET_GESTIONAR,
    Permission.LOGISTICS_SHIPMENTS_VER,
    Permission.LOGISTICS_SHIPMENTS_GESTIONAR,
    Permission.LOGISTICS_GUIDES_VER,
    Permission.LOGISTICS_GUIDES_GESTIONAR,
    Permission.LOGISTICS_EXPENSES_VER,
    Permission.LOGISTICS_EXPENSES_GESTIONAR,
    Permission.LOGISTICS_CONFIG_GESTIONAR,
    Permission.LOGISTICS_CARTAPORTE_VER,
    Permission.LOGISTICS_CARTAPORTE_GESTIONAR,
    Permission.LOGISTICS_TRANSFERS_VER,
  ],
  nomina: [Permission.LOGISTICS_PAYROLL_VER, Permission.LOGISTICS_PAYROLL_GESTIONAR],
  reparto: [Permission.REPARTO_DESPACHAR, Permission.REPARTO_ENTREGAR],
  televenta: [Permission.COMMERCIAL_TELEVENTA_VER, Permission.COMMERCIAL_TELEVENTA_OPERATE],
  finanzas: [
    Permission.FINANCE_EXPENSES_VER,
    Permission.FINANCE_AI_CHAT,
    Permission.FINANCE_FINDINGS_GESTIONAR,
    Permission.FINANCE_BANK_VER,
    Permission.FINANCE_BANK_GESTIONAR,
  ],
};

export interface AreaPreset {
  /** role_name canónico (snake_case minúscula). */
  role: string;
  label: string;
  description: string;
  /** Grupos con VER + GESTIONAR completo. */
  primary: string[];
  /** Grupos secundarios (orden/estética). */
  secondary: string[];
  /** Si 'ver', el secundario se recorta a permisos *_VER (auditoría). */
  secondaryMode?: 'full' | 'ver';
  /** Atajo: incluir TODOS los grupos en full (sistemas). */
  all?: boolean;
}

export const AREA_PRESETS: AreaPreset[] = [
  {
    role: 'sistemas',
    label: 'Sistemas',
    description: 'TI: usuarios, roles y acceso total al sistema.',
    primary: ['usuarios', 'roles'],
    secondary: [],
    all: true,
  },
  {
    role: 'contabilidad',
    label: 'Contabilidad',
    description: 'Egresos contables y hallazgos; ve compras, analítica y costos.',
    primary: ['finanzas'],
    secondary: ['compras', 'analytics', 'logistica'],
  },
  {
    role: 'compras',
    label: 'Compras',
    description: 'Reabastecimiento y requisiciones; opera almacén y analítica.',
    primary: ['compras'],
    secondary: ['almacen', 'analytics'],
  },
  {
    role: 'mercadotecnia',
    label: 'Mercadotecnia',
    description: 'Auditoría en ruta (captura, exhibidores, scoring) + reportes de venta.',
    primary: ['trade', 'analytics'],
    secondary: ['rutas', 'comercial'],
  },
  {
    role: 'credito_cobranza',
    label: 'Crédito y Cobranza',
    description: 'Clientes, pedidos y pagos; ve/opera finanzas y analítica.',
    primary: ['comercial', 'pagos'],
    secondary: ['finanzas', 'analytics'],
  },
  {
    role: 'prevencion_auditoria',
    label: 'Prevención y Auditoría',
    description: 'Supervisor AI y cuadre; ve TODO en solo-lectura (integridad de auditoría).',
    primary: ['supervisor_ai', 'cuadre'],
    secondary: [
      'usuarios', 'trade', 'rutas', 'tienda', 'comercial', 'pagos', 'analytics',
      'almacen', 'compras', 'logistica', 'nomina', 'reparto', 'televenta', 'finanzas',
    ],
    secondaryMode: 'ver',
  },
  {
    role: 'tesoreria',
    label: 'Tesorería',
    description: 'Finanzas, pagos y corte de caja de reparto; ve cuadre y analítica.',
    primary: ['finanzas', 'pagos', 'reparto'],
    secondary: ['cuadre', 'analytics'],
  },
  {
    role: 'finanzas',
    label: 'Finanzas',
    description: 'Maat, egresos y hallazgos; ve compras, analítica y costos.',
    primary: ['finanzas'],
    secondary: ['compras', 'analytics', 'logistica'],
  },
  {
    role: 'rh',
    label: 'Recursos Humanos',
    description: 'Usuarios y nómina de logística.',
    primary: ['usuarios', 'nomina'],
    secondary: [],
  },
  {
    role: 'sucursal',
    label: 'Sucursal',
    description: 'Tienda en vivo, etiquetas y existencias; ve cuadre y analítica.',
    primary: ['tienda', 'almacen'],
    secondary: ['cuadre', 'analytics'],
  },
  {
    role: 'cedis',
    label: 'CEDIS',
    description: 'Almacén, logística y compras del centro de distribución.',
    primary: ['almacen', 'logistica', 'compras'],
    secondary: ['analytics'],
  },
  {
    role: 'rutas',
    label: 'Rutas',
    description: 'Análisis de rutas, mapa vivo, historial y control de ruta.',
    primary: ['rutas'],
    secondary: ['comercial'],
  },
  {
    role: 'telemarketing',
    label: 'Telemarketing',
    description: 'Televenta (call center B2B); ve/opera comercial.',
    primary: ['televenta'],
    secondary: ['comercial'],
  },
];

const verOnly = (perms: Permission[]): Permission[] =>
  perms.filter((p) => p.endsWith('_VER'));

/** Expande un preset de área a la lista de permisos concreta (deduplicada). */
export function resolveAreaPreset(preset: AreaPreset): Permission[] {
  const set = new Set<Permission>();
  const groups = preset.all ? Object.keys(MODULE_GROUPS) : preset.primary;
  for (const g of groups) for (const p of MODULE_GROUPS[g] ?? []) set.add(p);
  if (!preset.all) {
    for (const g of preset.secondary) {
      const perms = MODULE_GROUPS[g] ?? [];
      const eff = preset.secondaryMode === 'ver' ? verOnly(perms) : perms;
      for (const p of eff) set.add(p);
    }
  }
  return [...set];
}

/** `{ PERMISSION: true }` listo para el JSONB del rol. */
export function resolveAreaPresetMap(preset: AreaPreset): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const p of resolveAreaPreset(preset)) out[p] = true;
  return out;
}

// ── Agrupamiento de usuarios/roles por área (UI /admin) ────────────────────

export interface AreaMeta {
  slug: string;
  label: string;
  icon: string;
}

/**
 * Áreas para agrupar roles y usuarios en el admin, en orden de despliegue.
 * Las 13 primeras son las áreas del organigrama (coinciden con los role_name de
 * las plantillas). `externos` y `otros` son cajones para portal B2B y roles sin
 * mapear.
 */
export const AREAS: AreaMeta[] = [
  { slug: 'sistemas', label: 'Sistemas', icon: 'pi pi-cog' },
  { slug: 'mercadotecnia', label: 'Mercadotecnia', icon: 'pi pi-megaphone' },
  { slug: 'compras', label: 'Compras', icon: 'pi pi-shopping-bag' },
  { slug: 'contabilidad', label: 'Contabilidad', icon: 'pi pi-calculator' },
  { slug: 'finanzas', label: 'Finanzas', icon: 'pi pi-wallet' },
  { slug: 'tesoreria', label: 'Tesorería', icon: 'pi pi-money-bill' },
  { slug: 'credito_cobranza', label: 'Crédito y Cobranza', icon: 'pi pi-credit-card' },
  { slug: 'prevencion_auditoria', label: 'Prevención y Auditoría', icon: 'pi pi-shield' },
  { slug: 'rh', label: 'Recursos Humanos', icon: 'pi pi-id-card' },
  { slug: 'sucursal', label: 'Sucursal', icon: 'pi pi-shop' },
  { slug: 'cedis', label: 'CEDIS', icon: 'pi pi-box' },
  { slug: 'rutas', label: 'Rutas', icon: 'pi pi-directions' },
  { slug: 'telemarketing', label: 'Telemarketing', icon: 'pi pi-headphones' },
  { slug: 'externos', label: 'Externos (Portal B2B)', icon: 'pi pi-globe' },
  { slug: 'otros', label: 'Otros / heredados', icon: 'pi pi-ellipsis-h' },
];

const AREA_BY_SLUG = new Map(AREAS.map((a) => [a.slug, a]));

/**
 * Mapeo de roles LEGACY (no-plantilla) a un área, para que el agrupamiento sea
 * útil desde ya (los usuarios migran a los roles de área gradualmente).
 * Editable: si un rol cae en el área equivocada, ajustá acá.
 */
export const LEGACY_ROLE_AREA: Record<string, string> = {
  superadmin: 'sistemas',
  admin: 'sistemas',
  jefe_marketing: 'mercadotecnia',
  coordinadora_marketing: 'mercadotecnia',
  auxiliar_mercadotecnia: 'mercadotecnia',
  coordinador_ecommerce: 'mercadotecnia',
  colaborador: 'mercadotecnia',
  ejecutivo: 'mercadotecnia',
  supervisor: 'rutas',
  supervisor_ventas: 'rutas',
  gerente_de_zona: 'rutas',
  vendedor: 'rutas',
  tele_operator: 'telemarketing',
  gerente_compras: 'compras',
  coordinador_presupuestos: 'finanzas',
  encargado_sucursal: 'sucursal',
  jefe_de_tienda: 'sucursal',
  auxiliar_sucursal: 'sucursal',
  supervisora: 'sucursal',
  etiquetas_tienda: 'sucursal',
  repartidor: 'cedis',
  chofer: 'cedis',
  customer_b2b: 'externos',
};

const PRESET_ROLES = new Set(AREA_PRESETS.map((p) => p.role));

/** Área a la que pertenece un role_name (case-insensitive). */
export function roleAreaSlug(roleName: string | null | undefined): string {
  const r = (roleName ?? '').toLowerCase();
  if (PRESET_ROLES.has(r)) return r; // los 13 roles de área = su propio slug
  return LEGACY_ROLE_AREA[r] ?? 'otros';
}

export function areaMeta(slug: string): AreaMeta {
  return AREA_BY_SLUG.get(slug) ?? { slug: 'otros', label: 'Otros / heredados', icon: 'pi pi-ellipsis-h' };
}
