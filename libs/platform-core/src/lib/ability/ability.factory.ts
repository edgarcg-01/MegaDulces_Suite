import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { Permission } from '../constants/permissions';
import type { Action, AppAbility, AppSubject } from './ability.types';

export const permissionToSubject: Record<string, AppSubject> = {
  [Permission.USUARIOS_VER]: 'users',
  [Permission.USUARIOS_GESTIONAR]: 'users',
  [Permission.USUARIOS_PASSWORDS]: 'users_passwords',
  [Permission.USUARIOS_ASIGNAR_RUTA]: 'users_assign_route',
  [Permission.REPORTES_VER_PROPIO]: 'reports_own',
  [Permission.REPORTES_VER_EQUIPO]: 'reports_team',
  [Permission.REPORTES_VER_GLOBAL]: 'reports_global',
  [Permission.REPORTES_EXPORTAR]: 'reports_export',
  [Permission.REPORTES_GESTIONAR]: 'reports_manage',
  [Permission.VISITAS_REGISTRAR]: 'visits',
  [Permission.VISITAS_VER]: 'visits',
  [Permission.VISITAS_AUDITAR]: 'visits_audit',
  [Permission.CATALOGO_GESTIONAR]: 'catalogs',
  [Permission.TIENDAS_VER]: 'stores',
  [Permission.TIENDAS_CREAR]: 'stores_create',
  [Permission.PLANOGRAMAS_GESTIONAR]: 'planograms',
  [Permission.ROLES_CONFIGURAR]: 'roles_config',
  [Permission.SCORING_CONFIG_VER]: 'scoring_config',
  [Permission.SCORING_CONFIG_GESTIONAR]: 'scoring_config',
  [Permission.VER_SEGUIMIENTO]: 'seguimiento',
  [Permission.RUTAS_VER]: 'routes_analytics',
  [Permission.COMMERCIAL_MAP_VER]: 'commercial_map',
  [Permission.SUPERVISOR_AI_VER]: 'supervisor_ai',
  [Permission.SUPERVISOR_AI_APROBAR]: 'supervisor_ai',
  [Permission.COMMERCIAL_CUSTOMERS_VER]: 'commercial_customers',
  [Permission.COMMERCIAL_CUSTOMERS_GESTIONAR]: 'commercial_customers',
  [Permission.COMMERCIAL_WAREHOUSES_VER]: 'commercial_warehouses',
  [Permission.COMMERCIAL_WAREHOUSES_GESTIONAR]: 'commercial_warehouses',
  [Permission.COMMERCIAL_PRICING_VER]: 'commercial_pricing',
  [Permission.COMMERCIAL_PRICING_GESTIONAR]: 'commercial_pricing',
  [Permission.COMMERCIAL_INVENTORY_VER]: 'commercial_inventory',
  [Permission.COMMERCIAL_INVENTORY_AJUSTAR]: 'commercial_inventory',
  [Permission.COMMERCIAL_INVENTORY_CONTAR]: 'commercial_inventory',
  [Permission.COMMERCIAL_INVENTORY_SUPERVISAR]: 'commercial_inventory',
  [Permission.COMMERCIAL_INVENTORY_RECONCILIAR]: 'commercial_inventory',
  [Permission.COMMERCIAL_INVENTORY_ASIGNAR]: 'commercial_inventory',
  [Permission.COMMERCIAL_ORDERS_VER]: 'commercial_orders',
  [Permission.COMMERCIAL_ORDERS_CREAR]: 'commercial_orders',
  [Permission.COMMERCIAL_ORDERS_CONFIRMAR]: 'commercial_orders',
  [Permission.COMMERCIAL_ORDERS_CANCELAR]: 'commercial_orders',
  [Permission.COMMERCIAL_ORDERS_FULFILL]: 'commercial_orders',
  [Permission.COMMERCIAL_PAYMENTS_REGISTRAR]: 'commercial_payments',
  [Permission.COMMERCIAL_PROMOTIONS_VER]: 'commercial_promotions',
  [Permission.COMMERCIAL_PROMOTIONS_GESTIONAR]: 'commercial_promotions',
  [Permission.COMMERCIAL_TELEVENTA_VER]: 'commercial_televenta',
  [Permission.COMMERCIAL_TELEVENTA_OPERATE]: 'commercial_televenta',
  [Permission.LOGISTICS_FLEET_VER]: 'logistics_fleet',
  [Permission.LOGISTICS_FLEET_GESTIONAR]: 'logistics_fleet',
  [Permission.LOGISTICS_SHIPMENTS_VER]: 'logistics_shipments',
  [Permission.LOGISTICS_SHIPMENTS_GESTIONAR]: 'logistics_shipments',
  [Permission.LOGISTICS_GUIDES_VER]: 'logistics_guides',
  [Permission.LOGISTICS_GUIDES_GESTIONAR]: 'logistics_guides',
  [Permission.LOGISTICS_EXPENSES_VER]: 'logistics_expenses',
  [Permission.LOGISTICS_EXPENSES_GESTIONAR]: 'logistics_expenses',
  [Permission.LOGISTICS_PAYROLL_VER]: 'logistics_payroll',
  [Permission.LOGISTICS_PAYROLL_GESTIONAR]: 'logistics_payroll',
  [Permission.LOGISTICS_CONFIG_GESTIONAR]: 'logistics_config',
  [Permission.CAPTURE_TICKET_USE]: 'capture_ticket',
  [Permission.ROUTE_TICKET_CAPTURE]: 'route_ticket',
  [Permission.ROUTE_CONTROL_VER]: 'route_ticket',
  [Permission.VENDOR_APP_ACCESS]: 'vendor_app',
};

const permissionToAction: Record<string, Action | Action[]> = {
  [Permission.USUARIOS_VER]: 'read',
  [Permission.USUARIOS_GESTIONAR]: ['read', 'create', 'update', 'delete'],
  [Permission.USUARIOS_PASSWORDS]: ['read', 'update'],
  [Permission.USUARIOS_ASIGNAR_RUTA]: ['read', 'update'],
  [Permission.REPORTES_VER_PROPIO]: 'read',
  [Permission.REPORTES_VER_EQUIPO]: 'read',
  [Permission.REPORTES_VER_GLOBAL]: 'read',
  [Permission.REPORTES_EXPORTAR]: 'read',
  [Permission.REPORTES_GESTIONAR]: ['read', 'delete'],
  [Permission.VISITAS_REGISTRAR]: 'create',
  [Permission.VISITAS_VER]: 'read',
  [Permission.VISITAS_AUDITAR]: ['read', 'update'],
  [Permission.CATALOGO_GESTIONAR]: ['read', 'create', 'update', 'delete'],
  [Permission.TIENDAS_VER]: 'read',
  [Permission.TIENDAS_CREAR]: 'read',
  [Permission.PLANOGRAMAS_GESTIONAR]: ['read', 'create', 'update', 'delete'],
  [Permission.ROLES_CONFIGURAR]: 'manage',
  [Permission.SCORING_CONFIG_VER]: 'read',
  [Permission.SCORING_CONFIG_GESTIONAR]: ['read', 'create', 'update', 'delete'],
  [Permission.VER_SEGUIMIENTO]: 'read',
  [Permission.RUTAS_VER]: 'read',
  [Permission.COMMERCIAL_MAP_VER]: 'read',
  [Permission.SUPERVISOR_AI_VER]: 'read',
  [Permission.SUPERVISOR_AI_APROBAR]: ['read', 'update'],
  [Permission.COMMERCIAL_CUSTOMERS_VER]: 'read',
  [Permission.COMMERCIAL_CUSTOMERS_GESTIONAR]: ['read', 'create', 'update', 'delete'],
  [Permission.COMMERCIAL_WAREHOUSES_VER]: 'read',
  [Permission.COMMERCIAL_WAREHOUSES_GESTIONAR]: ['read', 'create', 'update', 'delete'],
  [Permission.COMMERCIAL_PRICING_VER]: 'read',
  [Permission.COMMERCIAL_PRICING_GESTIONAR]: ['read', 'create', 'update', 'delete'],
  [Permission.COMMERCIAL_INVENTORY_VER]: 'read',
  [Permission.COMMERCIAL_INVENTORY_AJUSTAR]: ['read', 'update'],
  [Permission.COMMERCIAL_INVENTORY_CONTAR]: ['read', 'create', 'update'],
  [Permission.COMMERCIAL_INVENTORY_SUPERVISAR]: ['read', 'update'],
  [Permission.COMMERCIAL_INVENTORY_RECONCILIAR]: ['read', 'create', 'update', 'delete'],
  [Permission.COMMERCIAL_INVENTORY_ASIGNAR]: ['read', 'create', 'update', 'delete'],
  [Permission.COMMERCIAL_ORDERS_VER]: 'read',
  [Permission.COMMERCIAL_ORDERS_CREAR]: ['read', 'create'],
  [Permission.COMMERCIAL_ORDERS_CONFIRMAR]: ['read', 'update'],
  [Permission.COMMERCIAL_ORDERS_CANCELAR]: ['read', 'update'],
  [Permission.COMMERCIAL_ORDERS_FULFILL]: ['read', 'update'],
  [Permission.COMMERCIAL_PAYMENTS_REGISTRAR]: ['read', 'create'],
  [Permission.COMMERCIAL_PROMOTIONS_VER]: 'read',
  [Permission.COMMERCIAL_PROMOTIONS_GESTIONAR]: ['read', 'create', 'update', 'delete'],
  [Permission.COMMERCIAL_TELEVENTA_VER]: 'read',
  [Permission.COMMERCIAL_TELEVENTA_OPERATE]: ['read', 'create', 'update'],
  [Permission.LOGISTICS_FLEET_VER]: 'read',
  [Permission.LOGISTICS_FLEET_GESTIONAR]: ['read', 'create', 'update', 'delete'],
  [Permission.LOGISTICS_SHIPMENTS_VER]: 'read',
  [Permission.LOGISTICS_SHIPMENTS_GESTIONAR]: ['read', 'create', 'update', 'delete'],
  [Permission.LOGISTICS_GUIDES_VER]: 'read',
  [Permission.LOGISTICS_GUIDES_GESTIONAR]: ['read', 'create', 'update', 'delete'],
  [Permission.LOGISTICS_EXPENSES_VER]: 'read',
  [Permission.LOGISTICS_EXPENSES_GESTIONAR]: ['read', 'create', 'update', 'delete'],
  [Permission.LOGISTICS_PAYROLL_VER]: 'read',
  [Permission.LOGISTICS_PAYROLL_GESTIONAR]: ['read', 'create', 'update', 'delete'],
  [Permission.LOGISTICS_CONFIG_GESTIONAR]: ['read', 'create', 'update', 'delete'],
  [Permission.CAPTURE_TICKET_USE]: 'read',
  [Permission.ROUTE_TICKET_CAPTURE]: ['read', 'create', 'update'],
  [Permission.ROUTE_CONTROL_VER]: 'read',
  [Permission.VENDOR_APP_ACCESS]: 'read',
};

export function buildAbility(permissions: Record<string, boolean>): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

  for (const [permKey, allowed] of Object.entries(permissions)) {
    if (!allowed) continue;
    const subject = permissionToSubject[permKey];
    const actions = permissionToAction[permKey];
    if (!subject || !actions) continue;
    can(actions, subject);
  }

  if (permissions[Permission.REPORTES_VER_EQUIPO] || permissions[Permission.REPORTES_VER_GLOBAL]) {
    can('manage', 'team_management');
    can('manage', 'kpi_goals');
  }

  if (permissions[Permission.REPORTES_VER_GLOBAL]) {
    can('manage', 'all');
  }

  return build();
}
