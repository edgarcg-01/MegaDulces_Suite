/**
 * Seed: roles iniciales para el tenant Mega Dulces.
 *
 * Roles canónicos (todos snake_case, sin Jefe_M ni supervisor_v):
 *   - superadmin   → acceso total (todos los permisos = true)
 *   - admin        → acceso total excepto configuración de roles
 *   - supervisor   → ver reportes equipo, asignar rutas, sin gestión sistema
 *   - jefe_marketing → similar a supervisor pero más limitado
 *   - colaborador  → registrar visitas, ver propios reportes
 *
 * Los permisos vienen del enum `Permission` en apps/api/src/shared/constants/permissions.ts.
 *
 * Idempotente: usa onConflict para no duplicar.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function (knex) {
  const MEGA_DULCES_TENANT_ID = '00000000-0000-0000-0000-00000000d01c';

  // Set completo de permisos (mantener en sync con apps/api/src/shared/constants/permissions.ts)
  const ALL_PERMS = {
    USUARIOS_VER: true,
    USUARIOS_GESTIONAR: true,
    USUARIOS_PASSWORDS: true,
    USUARIOS_ASIGNAR_RUTA: true,
    REPORTES_VER_PROPIO: true,
    REPORTES_VER_EQUIPO: true,
    REPORTES_VER_GLOBAL: true,
    REPORTES_EXPORTAR: true,
    REPORTES_GESTIONAR: true,
    VISITAS_REGISTRAR: true,
    VISITAS_VER: true,
    VISITAS_AUDITAR: true,
    CATALOGO_GESTIONAR: true,
    PLANOGRAMAS_GESTIONAR: true,
    TIENDAS_VER: true,
    TIENDAS_CREAR: true,
    ROLES_CONFIGURAR: true,
    SCORING_CONFIG_VER: true,
    SCORING_CONFIG_GESTIONAR: true,
    VER_SEGUIMIENTO: true,
    // Fase B — Comercial
    COMMERCIAL_CUSTOMERS_VER: true,
    COMMERCIAL_CUSTOMERS_GESTIONAR: true,
    COMMERCIAL_WAREHOUSES_VER: true,
    COMMERCIAL_WAREHOUSES_GESTIONAR: true,
    COMMERCIAL_PRICING_VER: true,
    COMMERCIAL_PRICING_GESTIONAR: true,
    COMMERCIAL_INVENTORY_VER: true,
    COMMERCIAL_INVENTORY_AJUSTAR: true,
    COMMERCIAL_ORDERS_VER: true,
    COMMERCIAL_ORDERS_CREAR: true,
    COMMERCIAL_ORDERS_CONFIRMAR: true,
    COMMERCIAL_ORDERS_CANCELAR: true,
    COMMERCIAL_ORDERS_FULFILL: true,
    COMMERCIAL_PAYMENTS_REGISTRAR: true,
    COMMERCIAL_PROMOTIONS_VER: true,
    COMMERCIAL_PROMOTIONS_GESTIONAR: true,
    // Fase E — Televenta
    COMMERCIAL_TELEVENTA_VER: true,
    COMMERCIAL_TELEVENTA_OPERATE: true,
    // Fase J — Logística
    LOGISTICS_FLEET_VER: true,
    LOGISTICS_FLEET_GESTIONAR: true,
    LOGISTICS_SHIPMENTS_VER: true,
    LOGISTICS_SHIPMENTS_GESTIONAR: true,
    LOGISTICS_GUIDES_VER: true,
    LOGISTICS_GUIDES_GESTIONAR: true,
    LOGISTICS_EXPENSES_VER: true,
    LOGISTICS_EXPENSES_GESTIONAR: true,
    LOGISTICS_PAYROLL_VER: true,
    LOGISTICS_PAYROLL_GESTIONAR: true,
    LOGISTICS_CONFIG_GESTIONAR: true,
  };

  const NO_PERMS = Object.fromEntries(Object.keys(ALL_PERMS).map((k) => [k, false]));

  const roles = [
    {
      role_name: 'superadmin',
      permissions: { ...ALL_PERMS },
    },
    {
      role_name: 'admin',
      permissions: { ...ALL_PERMS, ROLES_CONFIGURAR: false },
    },
    {
      role_name: 'supervisor',
      permissions: {
        ...NO_PERMS,
        USUARIOS_VER: true,
        USUARIOS_ASIGNAR_RUTA: true,
        REPORTES_VER_PROPIO: true,
        REPORTES_VER_EQUIPO: true,
        REPORTES_EXPORTAR: true,
        VISITAS_REGISTRAR: true,
        VISITAS_VER: true,
        VISITAS_AUDITAR: true,
        TIENDAS_VER: true,
        TIENDAS_CREAR: true,
        SCORING_CONFIG_VER: true,
        VER_SEGUIMIENTO: true,
        // Comercial: lectura completa + cancelar/fulfill pedidos del equipo
        COMMERCIAL_CUSTOMERS_VER: true,
        COMMERCIAL_WAREHOUSES_VER: true,
        COMMERCIAL_PRICING_VER: true,
        COMMERCIAL_INVENTORY_VER: true,
        COMMERCIAL_ORDERS_VER: true,
        COMMERCIAL_ORDERS_CONFIRMAR: true,
        COMMERCIAL_ORDERS_CANCELAR: true,
        COMMERCIAL_ORDERS_FULFILL: true,
        COMMERCIAL_PROMOTIONS_VER: true,
        COMMERCIAL_TELEVENTA_VER: true,
      },
    },
    {
      role_name: 'jefe_marketing',
      permissions: {
        ...NO_PERMS,
        USUARIOS_VER: true,
        USUARIOS_ASIGNAR_RUTA: true,
        REPORTES_VER_PROPIO: true,
        REPORTES_VER_EQUIPO: true,
        REPORTES_EXPORTAR: true,
        VISITAS_VER: true,
        TIENDAS_VER: true,
        SCORING_CONFIG_VER: true,
        VER_SEGUIMIENTO: true,
        // Comercial: solo lectura (rol enfocado en marketing/análisis)
        // Promociones SÍ gestiona — marketing es quien las define.
        COMMERCIAL_CUSTOMERS_VER: true,
        COMMERCIAL_PRICING_VER: true,
        COMMERCIAL_ORDERS_VER: true,
        COMMERCIAL_PROMOTIONS_VER: true,
        COMMERCIAL_PROMOTIONS_GESTIONAR: true,
      },
    },
    {
      role_name: 'colaborador',
      permissions: {
        ...NO_PERMS,
        REPORTES_VER_PROPIO: true,
        VISITAS_REGISTRAR: true,
        VISITAS_VER: true,
        TIENDAS_VER: true,
        TIENDAS_CREAR: true,
        SCORING_CONFIG_VER: true,
        VER_SEGUIMIENTO: true,
        // Comercial: vendedor de campo — toma pedidos + cobra
        COMMERCIAL_CUSTOMERS_VER: true,
        COMMERCIAL_PRICING_VER: true,
        COMMERCIAL_INVENTORY_VER: true,
        COMMERCIAL_ORDERS_VER: true,
        COMMERCIAL_ORDERS_CREAR: true,
        COMMERCIAL_PAYMENTS_REGISTRAR: true,
      },
    },
    {
      // Rol nuevo Fase E — operador de call center (televenta).
      // Pool autoservicio: ve clientes priorizados, toma uno, lo trabaja
      // (snapshot + pedido en su nombre + log de llamada), lo libera.
      // Cartera scoped: el endpoint /queue oculta clientes reservados por
      // otros operadores. Sin trade marketing data.
      role_name: 'tele_operator',
      permissions: {
        ...NO_PERMS,
        COMMERCIAL_TELEVENTA_OPERATE: true,
        COMMERCIAL_CUSTOMERS_VER: true,
        COMMERCIAL_PRICING_VER: true,
        COMMERCIAL_INVENTORY_VER: true,
        COMMERCIAL_ORDERS_VER: true,
        COMMERCIAL_ORDERS_CREAR: true,
        COMMERCIAL_ORDERS_CONFIRMAR: true,
        COMMERCIAL_PROMOTIONS_VER: true,
      },
    },
    {
      // Rol nuevo Fase D — para customer users del Portal B2B.
      // Solo ven SUS propios pedidos y pueden crear nuevos. No tocan trade
      // marketing data ni gestiones de admin.
      role_name: 'customer_b2b',
      permissions: {
        ...NO_PERMS,
        COMMERCIAL_CUSTOMERS_VER: true,    // ver SU propio perfil (scoped por customer_id)
        COMMERCIAL_PRICING_VER: true,       // ver SU lista de precio
        COMMERCIAL_INVENTORY_VER: true,     // ver stock disponible
        COMMERCIAL_ORDERS_VER: true,        // ver SUS pedidos
        COMMERCIAL_ORDERS_CREAR: true,      // crear pedidos
        COMMERCIAL_ORDERS_CANCELAR: true,   // cancelar SUS propios drafts
      },
    },
  ];

  // IMPORTANTE: usamos transacción con tenant context para que RLS permita el insert.
  // Como app_runtime NO puede bypass RLS, el seed debe correr como postgres (que sí puede,
  // pero igual seteamos el contexto para que WITH CHECK pase).
  await knex.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${MEGA_DULCES_TENANT_ID}'`);

    for (const role of roles) {
      await trx('role_permissions')
        .insert({
          tenant_id: MEGA_DULCES_TENANT_ID,
          role_name: role.role_name,
          permissions: JSON.stringify(role.permissions),
        })
        .onConflict(['tenant_id', 'role_name'])
        .merge(['permissions', 'updated_at']);
      console.log(`[02_mega_dulces_initial_roles] Rol '${role.role_name}' upserted.`);
    }
  });
};
