/**
 * Seed de roles para la DB legacy (Trade Marketing).
 *
 * Fuente de verdad de las claves: enum `Permission` en
 * apps/api/src/shared/constants/permissions.ts. Mantener en sync.
 *
 * Reglas:
 *   - NUNCA claves legacy `LOG_*` (fueron reemplazadas por `LOGISTICS_*` en
 *     Fase J; la migración 20260522104500 ya las removió de la DB viva).
 *   - Todo rol declara TODAS las claves del enum (true/false explícito) para
 *     que el panel /roles no muestre filas indefinidas y para que el backfill
 *     no tenga que adivinar.
 *
 * Idempotente: solo inserta los roles que aún no existen (no pisa cambios
 * hechos manualmente vía /admin/roles en un rol ya creado).
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function (knex) {
  // Set completo de permisos (espejo del enum Permission del backend).
  const ALL_PERMS = {
    // Usuarios
    USUARIOS_VER: true,
    USUARIOS_GESTIONAR: true,
    USUARIOS_PASSWORDS: true,
    USUARIOS_ASIGNAR_RUTA: true,
    // Reportes
    REPORTES_VER_PROPIO: true,
    REPORTES_VER_EQUIPO: true,
    REPORTES_VER_GLOBAL: true,
    REPORTES_EXPORTAR: true,
    REPORTES_GESTIONAR: true,
    // Visitas
    VISITAS_REGISTRAR: true,
    VISITAS_VER: true,
    VISITAS_AUDITAR: true,
    // Catálogos / Sistema
    CATALOGO_GESTIONAR: true,
    PLANOGRAMAS_GESTIONAR: true,
    TIENDAS_VER: true,
    TIENDAS_CREAR: true,
    ROLES_CONFIGURAR: true,
    SCORING_CONFIG_VER: true,
    SCORING_CONFIG_GESTIONAR: true,
    // Seguimiento
    VER_SEGUIMIENTO: true,
    // Comercial (Fase B/C)
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
    // Televenta (Fase E)
    COMMERCIAL_TELEVENTA_VER: true,
    COMMERCIAL_TELEVENTA_OPERATE: true,
    // Vendedor con OCR de ticket (Fase V)
    CAPTURE_TICKET_USE: true,
    // Logística (Fase J)
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

  const NO_PERMS = Object.fromEntries(
    Object.keys(ALL_PERMS).map((k) => [k, false]),
  );

  // Supervisor de trade marketing: audita campo + lectura comercial + maneja
  // pedidos del equipo (confirmar/cancelar/fulfill). Sin gestión de sistema.
  const SUPERVISOR_PERMS = {
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
  };

  // Jefe de marketing: análisis + define promociones. Comercial solo lectura.
  const JEFE_MARKETING_PERMS = {
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
    COMMERCIAL_CUSTOMERS_VER: true,
    COMMERCIAL_PRICING_VER: true,
    COMMERCIAL_ORDERS_VER: true,
    COMMERCIAL_PROMOTIONS_VER: true,
    COMMERCIAL_PROMOTIONS_GESTIONAR: true,
  };

  // Colaborador / ejecutivo de campo: registra visitas, toma pedidos y cobra.
  // V.1: el vendedor gestiona su cartera de punta a punta — aprueba preventa
  // (CONFIRMAR), marca entregado en campo (FULFILL) y puede cancelar (CANCELAR).
  const FIELD_PERMS = {
    ...NO_PERMS,
    REPORTES_VER_PROPIO: true,
    VISITAS_REGISTRAR: true,
    VISITAS_VER: true,
    TIENDAS_VER: true,
    TIENDAS_CREAR: true,
    SCORING_CONFIG_VER: true,
    VER_SEGUIMIENTO: true,
    COMMERCIAL_CUSTOMERS_VER: true,
    COMMERCIAL_PRICING_VER: true,
    COMMERCIAL_INVENTORY_VER: true,
    COMMERCIAL_ORDERS_VER: true,
    COMMERCIAL_ORDERS_CREAR: true,
    COMMERCIAL_ORDERS_CONFIRMAR: true,
    COMMERCIAL_ORDERS_CANCELAR: true,
    COMMERCIAL_ORDERS_FULFILL: true,
    COMMERCIAL_PAYMENTS_REGISTRAR: true,
  };

  // Nombres canónicos snake_case (se reemplazaron los crípticos `Jefe_M` →
  // `jefe_marketing` y `supervisor_v` → `supervisor_ventas`). UUIDs estables
  // para no romper FKs ni referencias históricas si el seed corre en una DB
  // recreada.
  const ALL_ROLES = [
    {
      id: '67515dde-792c-4a79-aa29-69589003b5df',
      role_name: 'superadmin',
      permissions: { ...ALL_PERMS },
    },
    {
      id: '7d3a6972-0d01-476d-a6f7-1f11a6313188',
      role_name: 'admin',
      permissions: { ...ALL_PERMS },
    },
    {
      id: 'f39b3209-99c5-4afa-b611-92ae7edc3a82',
      role_name: 'supervisor',
      permissions: { ...SUPERVISOR_PERMS },
    },
    {
      id: 'fe1928f8-2311-43c1-82c8-84a33e22af2d',
      role_name: 'supervisor_ventas',
      permissions: { ...SUPERVISOR_PERMS },
    },
    {
      id: '62836db5-759e-4e91-87ec-6be63e076fcb',
      role_name: 'jefe_marketing',
      permissions: { ...JEFE_MARKETING_PERMS },
    },
    {
      id: '3ebb520b-0ed7-4f3e-8318-9bd154c67016',
      role_name: 'colaborador',
      permissions: { ...FIELD_PERMS },
    },
    {
      id: '4ba46777-93be-432f-8bff-8a7552cc4933',
      role_name: 'ejecutivo',
      permissions: { ...FIELD_PERMS },
    },
  ];

  const existing = await knex('role_permissions').select('role_name');
  const existingNames = new Set(existing.map((r) => r.role_name));

  const toInsert = ALL_ROLES.filter((r) => !existingNames.has(r.role_name)).map(
    (r) => ({
      id: r.id,
      role_name: r.role_name,
      permissions: JSON.stringify(r.permissions),
    }),
  );

  if (toInsert.length === 0) {
    console.log('[00_roles] Todos los roles ya existen, skip.');
    return;
  }

  await knex('role_permissions').insert(toInsert);
  console.log(`[00_roles] Insertados ${toInsert.length} rol(es) nuevos.`);
};
