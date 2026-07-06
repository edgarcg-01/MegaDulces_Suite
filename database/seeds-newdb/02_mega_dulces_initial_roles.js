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
 * Los permisos vienen del enum `Permission` en libs/platform-core/src/lib/constants/permissions.ts.
 *
 * Idempotente: usa onConflict para no duplicar.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function (knex) {
  const MEGA_DULCES_TENANT_ID = '00000000-0000-0000-0000-00000000d01c';

  // Set completo de permisos (mantener en sync con libs/platform-core/src/lib/constants/permissions.ts)
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
    RUTAS_VER: true,
    COMMERCIAL_MAP_VER: true,
    COMMERCIAL_MAP_PROSPECTS_VER: true,
    COMMERCIAL_MAP_PROSPECTS_GESTIONAR: true,
    // Fase B — Comercial
    COMMERCIAL_CUSTOMERS_VER: true,
    COMMERCIAL_CUSTOMERS_GESTIONAR: true,
    COMMERCIAL_WAREHOUSES_VER: true,
    COMMERCIAL_WAREHOUSES_GESTIONAR: true,
    COMMERCIAL_PRICING_VER: true,
    COMMERCIAL_PRICING_GESTIONAR: true,
    COMMERCIAL_INVENTORY_VER: true,
    COMMERCIAL_INVENTORY_AJUSTAR: true,
    COMMERCIAL_INVENTORY_CONTAR: true,
    COMMERCIAL_INVENTORY_SUPERVISAR: true,
    COMMERCIAL_INVENTORY_RECONCILIAR: true,
    COMMERCIAL_INVENTORY_ASIGNAR: true,
    COMMERCIAL_ORDERS_VER: true,
    COMMERCIAL_ORDERS_CREAR: true,
    COMMERCIAL_ORDERS_CONFIRMAR: true,
    COMMERCIAL_ORDERS_CANCELAR: true,
    COMMERCIAL_ORDERS_FULFILL: true,
    COMMERCIAL_PAYMENTS_REGISTRAR: true,
    // Fase LM — Última milla (entrega a domicilio)
    COMMERCIAL_PAYMENTS_VERIFICAR: true,
    COMMERCIAL_PAYMENTS_REVERSAR: true,
    COMMERCIAL_RIDER_LIQUIDATION_GESTIONAR: true,
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
    LOGISTICS_HOME_DISPATCH: true,
    LOGISTICS_EXPENSES_VER: true,
    LOGISTICS_EXPENSES_GESTIONAR: true,
    LOGISTICS_PAYROLL_VER: true,
    LOGISTICS_PAYROLL_GESTIONAR: true,
    LOGISTICS_CONFIG_GESTIONAR: true,
    LOGISTICS_CARTAPORTE_VER: true,
    LOGISTICS_CARTAPORTE_GESTIONAR: true,
    // Fase V — Vendedor con OCR de ticket
    CAPTURE_TICKET_USE: true,
    // Acceso a la app de vendedor standalone
    VENDOR_APP_ACCESS: true,
    // Comercial — Cierre de ruta
    ROUTE_TICKET_CAPTURE: true,
    ROUTE_CONTROL_VER: true,
    // Horus — Supervisor AI de ejecución (Trade)
    SUPERVISOR_AI_VER: true,
    SUPERVISOR_AI_APROBAR: true,
    // Proyecto Finanzas — egresos contables
    FINANCE_EXPENSES_VER: true,
  };

  const NO_PERMS = Object.fromEntries(Object.keys(ALL_PERMS).map((k) => [k, false]));

  // Fase AZ — deriva los permisos jerárquicos nuevos de los que los originaron,
  // igual que la migración de backfill 20260702190000 (seed == migración → un rol
  // recreado desde cero queda idéntico a uno migrado). customer_b2b (externo) NO
  // hereda analítica/traspasos internos aunque tenga ORDERS_VER (ve SUS pedidos).
  const withDerivedAz = (perms, roleName) => {
    const internal = roleName !== 'customer_b2b';
    return {
      ...perms,
      COMMERCIAL_ANALYTICS_VER: internal && !!perms.COMMERCIAL_ORDERS_VER,
      LOGISTICS_TRANSFERS_VER: internal && !!perms.COMMERCIAL_ORDERS_VER,
      COMMERCIAL_CARTERA_VER: !!perms.USUARIOS_ASIGNAR_RUTA,
      COMMERCIAL_CARTERA_GESTIONAR: !!perms.USUARIOS_ASIGNAR_RUTA,
      TRADE_ROUTE_PLAN_VER: !!perms.USUARIOS_ASIGNAR_RUTA,
      TRADE_ROUTE_PLAN_GESTIONAR: !!perms.USUARIOS_ASIGNAR_RUTA,
      COMMERCIAL_PRODUCTS_VER: !!perms.CATALOGO_GESTIONAR,
      COMMERCIAL_PRODUCTS_GESTIONAR: !!perms.CATALOGO_GESTIONAR,
      COMMERCIAL_THOT_VER: !!perms.COMMERCIAL_CUSTOMERS_GESTIONAR,
      COMMERCIAL_THOT_GESTIONAR: !!perms.COMMERCIAL_CUSTOMERS_GESTIONAR,
      ROLES_VER: !!perms.ROLES_CONFIGURAR,
      PORTAL_B2B_ACCESS: roleName === 'customer_b2b',
      // Finanzas — igual que la migración 20260706170000 (seed == migración)
      FINANCE_EXPENSES_VER: internal && !!perms.COMMERCIAL_ORDERS_VER,
    };
  };

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
        RUTAS_VER: true,
        COMMERCIAL_MAP_VER: true,
        COMMERCIAL_MAP_PROSPECTS_VER: true,
        // Comercial: lectura completa + cancelar/fulfill pedidos del equipo
        COMMERCIAL_CUSTOMERS_VER: true,
        COMMERCIAL_WAREHOUSES_VER: true,
        COMMERCIAL_PRICING_VER: true,
        COMMERCIAL_INVENTORY_VER: true,
        // Inventario físico: el supervisor analiza y resuelve discrepancias + puede contar.
        // RECONCILIAR (ajuste del saldo = autoridad del dinero) queda en admin/superadmin.
        COMMERCIAL_INVENTORY_CONTAR: true,
        COMMERCIAL_INVENTORY_SUPERVISAR: true,
        COMMERCIAL_INVENTORY_ASIGNAR: true,
        COMMERCIAL_ORDERS_VER: true,
        COMMERCIAL_ORDERS_CREAR: true, // override gerencial: toma pedidos en la app de vendedor
        COMMERCIAL_ORDERS_CONFIRMAR: true,
        COMMERCIAL_ORDERS_CANCELAR: true,
        COMMERCIAL_ORDERS_FULFILL: true,
        COMMERCIAL_PROMOTIONS_VER: true,
        COMMERCIAL_TELEVENTA_VER: true,
        // Horus — Supervisor AI: ve el parte/hallazgos y aprueba acciones (co-piloto)
        SUPERVISOR_AI_VER: true,
        SUPERVISOR_AI_APROBAR: true,
        // Override gerencial: puede entrar a la app de vendedor
        VENDOR_APP_ACCESS: true,
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
        RUTAS_VER: true,
        COMMERCIAL_MAP_VER: true,
        COMMERCIAL_MAP_PROSPECTS_VER: true,
        // Comercial: solo lectura (rol enfocado en marketing/análisis)
        // Promociones SÍ gestiona — marketing es quien las define.
        COMMERCIAL_CUSTOMERS_VER: true,
        COMMERCIAL_PRICING_VER: true,
        COMMERCIAL_ORDERS_VER: true,
        COMMERCIAL_PROMOTIONS_VER: true,
        COMMERCIAL_PROMOTIONS_GESTIONAR: true,
        // Horus — observa el parte/hallazgos; NO aprueba acciones laborales
        SUPERVISOR_AI_VER: true,
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
        // Comercial: vendedor de campo — toma pedidos + cobra.
        // El stock para vender llega por el catálogo (/commercial/catalog/products)
        // bajo ORDERS_VER — el vendedor NO necesita el módulo de inventario
        // (COMMERCIAL_INVENTORY_VER) sólo para "ver almacén". Conserva CONTAR para
        // el conteo físico ciego (que ni siquiera muestra el teórico).
        COMMERCIAL_CUSTOMERS_VER: true,
        COMMERCIAL_PRICING_VER: true,
        COMMERCIAL_INVENTORY_CONTAR: true, // contador de piso en inventario físico
        COMMERCIAL_ORDERS_VER: true,
        COMMERCIAL_ORDERS_CREAR: true,
        COMMERCIAL_ORDERS_CONFIRMAR: true, // /orders/:id/place y /approve (draft→confirmed)
        COMMERCIAL_ORDERS_CANCELAR: true,
        COMMERCIAL_ORDERS_FULFILL: true, // /orders/:id/fulfill y /deliver-now (autoventa)
        COMMERCIAL_PAYMENTS_REGISTRAR: true,
        VENDOR_APP_ACCESS: true, // vendedor de campo: usa la app de vendedor
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
        COMMERCIAL_TELEVENTA_VER: true, // lectura de cola/snapshot/dashboard de televenta
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
      // Rol nuevo Fase V — Vendedor de campo con OCR de ticket.
      // Igual que `colaborador` pero con CAPTURE_TICKET_USE: en su flujo de
      // captura toma foto del exhibidor + foto del ticket, y los productos
      // del ticket se autorellenan en la sección "Productos del exhibidor"
      // vía Claude Haiku vision + AI product matcher (Voyage embeddings).
      role_name: 'vendedor',
      permissions: {
        ...NO_PERMS,
        REPORTES_VER_PROPIO: true,
        VISITAS_REGISTRAR: true,
        VISITAS_VER: true,
        TIENDAS_VER: true,
        TIENDAS_CREAR: true,
        SCORING_CONFIG_VER: true,
        VER_SEGUIMIENTO: true,
        CAPTURE_TICKET_USE: true,
        ROUTE_TICKET_CAPTURE: true,
        VENDOR_APP_ACCESS: true,
        // Stock via catálogo bajo ORDERS_VER — sin módulo de inventario.
        COMMERCIAL_CUSTOMERS_VER: true,
        COMMERCIAL_PRICING_VER: true,
        COMMERCIAL_ORDERS_VER: true,
        COMMERCIAL_ORDERS_CREAR: true,
        COMMERCIAL_ORDERS_CONFIRMAR: true, // /place y /approve
        COMMERCIAL_ORDERS_CANCELAR: true,
        COMMERCIAL_ORDERS_FULFILL: true, // /fulfill y /deliver-now (autoventa)
        COMMERCIAL_PAYMENTS_REGISTRAR: true,
      },
    },
    {
      // Rol nuevo Fase LM — Repartidor de última milla (entrega a domicilio en moto).
      // Usa la app de vendedor: ve SUS guías (my-driver), marca entrega/incidencia,
      // cobra (efectivo/transferencia/tarjeta = registro) y sube tickets de cierre.
      // NO tiene cartera completa, inventario ni trade marketing.
      role_name: 'repartidor',
      permissions: {
        ...NO_PERMS,
        VENDOR_APP_ACCESS: true, // login a la app de vendedor (rutas /repartidor)
        LOGISTICS_SHIPMENTS_VER: true, // sus embarques/guías vía my-driver
        LOGISTICS_GUIDES_VER: true,
        LOGISTICS_GUIDES_GESTIONAR: true, // marcar parada entregada / incidencia / POD
        COMMERCIAL_CUSTOMERS_VER: true, // ver datos del cliente de la parada
        COMMERCIAL_PRICING_VER: true,
        COMMERCIAL_ORDERS_VER: true,
        COMMERCIAL_ORDERS_FULFILL: true, // entregar (deliver-now / fulfill)
        COMMERCIAL_ORDERS_CANCELAR: true, // rechazo del cliente
        COMMERCIAL_PAYMENTS_REGISTRAR: true, // cobrar en la entrega
        ROUTE_TICKET_CAPTURE: true, // tickets de cierre de ruta
      },
    },
    {
      // Rol nuevo Fase LM — Encargado de sucursal.
      // Back-office de la sucursal: intake de pedidos a domicilio, verifica
      // transferencias, reversa cobros, cierra el corte de caja del repartidor
      // (arqueo), autoriza cancelaciones/devoluciones. NO configura sistema.
      role_name: 'encargado_sucursal',
      permissions: {
        ...NO_PERMS,
        REPORTES_VER_EQUIPO: true,
        REPORTES_EXPORTAR: true,
        COMMERCIAL_CUSTOMERS_VER: true,
        COMMERCIAL_CUSTOMERS_GESTIONAR: true, // alta de cliente casual en intake
        COMMERCIAL_WAREHOUSES_VER: true,
        COMMERCIAL_PRICING_VER: true,
        COMMERCIAL_INVENTORY_VER: true,
        COMMERCIAL_ORDERS_VER: true,
        COMMERCIAL_ORDERS_CREAR: true, // intake a domicilio
        COMMERCIAL_ORDERS_CONFIRMAR: true,
        COMMERCIAL_ORDERS_CANCELAR: true,
        COMMERCIAL_ORDERS_FULFILL: true,
        COMMERCIAL_PAYMENTS_REGISTRAR: true,
        COMMERCIAL_PAYMENTS_VERIFICAR: true, // verifica comprobante de transferencia
        COMMERCIAL_PAYMENTS_REVERSAR: true,
        COMMERCIAL_RIDER_LIQUIDATION_GESTIONAR: true, // abre/cierra el corte de caja
        COMMERCIAL_PROMOTIONS_VER: true,
        ROUTE_CONTROL_VER: true, // ve todos los tickets/cortes de la sucursal
        LOGISTICS_FLEET_VER: true,
        LOGISTICS_SHIPMENTS_VER: true,
        LOGISTICS_SHIPMENTS_GESTIONAR: true, // arma/asigna la entrega
        LOGISTICS_GUIDES_VER: true,
        LOGISTICS_GUIDES_GESTIONAR: true,
        LOGISTICS_HOME_DISPATCH: true, // captura folio Kepler + asigna (fallback mientras no existan roles de tienda)
        LOGISTICS_EXPENSES_VER: true,
      },
    },
    {
      // Fase LM-K — Jefe de tienda: captura folio Kepler de domicilio + asigna
      // repartidor. Scoped a SU sucursal (allowlist logistics.home_delivery_warehouses).
      role_name: 'jefe_de_tienda',
      permissions: {
        ...NO_PERMS,
        STORE_LIVE_VER: true, // monitor de tickets de su tienda
        COMMERCIAL_CUSTOMERS_VER: true,
        COMMERCIAL_ORDERS_VER: true,
        LOGISTICS_FLEET_VER: true,
        LOGISTICS_SHIPMENTS_VER: true,
        LOGISTICS_GUIDES_VER: true,
        LOGISTICS_GUIDES_GESTIONAR: true,
        LOGISTICS_HOME_DISPATCH: true,
        ROUTE_CONTROL_VER: true,
      },
    },
    {
      // Fase LM-K — Auxiliar de tienda: mismo alcance operativo que el jefe para
      // el despacho a domicilio (comparten LOGISTICS_HOME_DISPATCH; se parte si el
      // negocio pide que solo el jefe asigne).
      role_name: 'auxiliar_de_tienda',
      permissions: {
        ...NO_PERMS,
        STORE_LIVE_VER: true,
        COMMERCIAL_CUSTOMERS_VER: true,
        COMMERCIAL_ORDERS_VER: true,
        LOGISTICS_SHIPMENTS_VER: true,
        LOGISTICS_GUIDES_VER: true,
        LOGISTICS_GUIDES_GESTIONAR: true,
        LOGISTICS_HOME_DISPATCH: true,
      },
    },
    {
      // Fase LM-K — Gerente de zona: despacho a domicilio sobre las sucursales de
      // su zona (scope multi-store por zona_id, resuelto en el servicio). Además ve
      // reportes de equipo.
      role_name: 'gerente_de_zona',
      permissions: {
        ...NO_PERMS,
        REPORTES_VER_EQUIPO: true,
        REPORTES_EXPORTAR: true,
        STORE_LIVE_VER: true,
        COMMERCIAL_CUSTOMERS_VER: true,
        COMMERCIAL_ORDERS_VER: true,
        LOGISTICS_FLEET_VER: true,
        LOGISTICS_SHIPMENTS_VER: true,
        LOGISTICS_GUIDES_VER: true,
        LOGISTICS_GUIDES_GESTIONAR: true,
        LOGISTICS_HOME_DISPATCH: true,
        ROUTE_CONTROL_VER: true,
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
        COMMERCIAL_WAREHOUSES_VER: true,    // portal B2B usa default warehouse para el carrito
        COMMERCIAL_PROMOTIONS_VER: true,    // portal B2B muestra promos activas en Home/Promos
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
          permissions: JSON.stringify(withDerivedAz(role.permissions, role.role_name)),
        })
        .onConflict(['tenant_id', 'role_name'])
        .merge(['permissions', 'updated_at']);
      console.log(`[02_mega_dulces_initial_roles] Rol '${role.role_name}' upserted.`);
    }
  });
};
