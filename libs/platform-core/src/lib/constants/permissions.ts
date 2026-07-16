export enum Permission {
  // Módulo: Usuarios
  USUARIOS_VER = 'USUARIOS_VER',
  USUARIOS_GESTIONAR = 'USUARIOS_GESTIONAR',
  USUARIOS_PASSWORDS = 'USUARIOS_PASSWORDS',
  USUARIOS_ASIGNAR_RUTA = 'USUARIOS_ASIGNAR_RUTA',

  // Módulo: Reportes y KPI
  REPORTES_VER_PROPIO = 'REPORTES_VER_PROPIO',
  REPORTES_VER_EQUIPO = 'REPORTES_VER_EQUIPO',
  REPORTES_VER_GLOBAL = 'REPORTES_VER_GLOBAL',
  REPORTES_EXPORTAR = 'REPORTES_EXPORTAR',
  REPORTES_GESTIONAR = 'REPORTES_GESTIONAR',

  // Módulo: Operación en Campo (Auditoría)
  VISITAS_REGISTRAR = 'VISITAS_REGISTRAR',
  VISITAS_VER = 'VISITAS_VER',
  VISITAS_AUDITAR = 'VISITAS_AUDITAR',

  // Módulo: Administración (Catálogos y Sistema)
  CATALOGO_GESTIONAR = 'CATALOGO_GESTIONAR',
  PLANOGRAMAS_GESTIONAR = 'PLANOGRAMAS_GESTIONAR',
  TIENDAS_VER = 'TIENDAS_VER',
  TIENDAS_CREAR = 'TIENDAS_CREAR',
  ROLES_CONFIGURAR = 'ROLES_CONFIGURAR',
  SCORING_CONFIG_VER = 'SCORING_CONFIG_VER',
  SCORING_CONFIG_GESTIONAR = 'SCORING_CONFIG_GESTIONAR',

  // Módulo: Seguimiento
  VER_SEGUIMIENTO = 'VER_SEGUIMIENTO',

  // Módulo: Rutas (análisis: tiendas por ruta, tiempos de visita, trazabilidad)
  RUTAS_VER = 'RUTAS_VER',

  // Módulo: Mapa Comercial (exhibidores Mega Dulces vs competencia en mapa + historial por tienda)
  COMMERCIAL_MAP_VER = 'COMMERCIAL_MAP_VER',

  // Módulo: Prospección DENUE (tiendas de oportunidad descubiertas en INEGI DENUE)
  COMMERCIAL_MAP_PROSPECTS_VER = 'COMMERCIAL_MAP_PROSPECTS_VER',
  COMMERCIAL_MAP_PROSPECTS_GESTIONAR = 'COMMERCIAL_MAP_PROSPECTS_GESTIONAR',

  // Módulo: Supervisor AI de ejecución (Horus) — parte diario, auditoría visual, fraude (co-piloto)
  SUPERVISOR_AI_VER = 'SUPERVISOR_AI_VER',
  SUPERVISOR_AI_APROBAR = 'SUPERVISOR_AI_APROBAR',

  // Módulo: Tienda — monitor de tickets de venta en vivo (proyecto TDA)
  STORE_LIVE_VER = 'STORE_LIVE_VER',
  // Módulo: Tienda — etiquetera de anaquel (impresión de etiquetas)
  STORE_LABELS_VER = 'STORE_LABELS_VER',
  // Módulo: Tienda — arqueo ciego de caja para cajeras (captura + ver). Superficie
  // acotada del arqueo del Supervisor de Movimientos (sin el motor de reconciliación).
  STORE_ARQUEO_CAPTURAR = 'STORE_ARQUEO_CAPTURAR',
  STORE_ARQUEO_VER = 'STORE_ARQUEO_VER',
  // Módulo: Tienda — análisis semanal de venta por sucursal (ISO week, WoW + tendencia)
  STORE_ANALYTICS_VER = 'STORE_ANALYTICS_VER',

  // Módulo: Comercial — Clientes B2B (Fase B)
  COMMERCIAL_CUSTOMERS_VER = 'COMMERCIAL_CUSTOMERS_VER',
  COMMERCIAL_CUSTOMERS_GESTIONAR = 'COMMERCIAL_CUSTOMERS_GESTIONAR',

  // Módulo: Comercial — Almacenes y Pricing
  COMMERCIAL_WAREHOUSES_VER = 'COMMERCIAL_WAREHOUSES_VER',
  COMMERCIAL_WAREHOUSES_GESTIONAR = 'COMMERCIAL_WAREHOUSES_GESTIONAR',
  COMMERCIAL_PRICING_VER = 'COMMERCIAL_PRICING_VER',
  COMMERCIAL_PRICING_GESTIONAR = 'COMMERCIAL_PRICING_GESTIONAR',

  // Módulo: Comercial — Inventario
  COMMERCIAL_INVENTORY_VER = 'COMMERCIAL_INVENTORY_VER',
  COMMERCIAL_INVENTORY_AJUSTAR = 'COMMERCIAL_INVENTORY_AJUSTAR',
  // Inventario físico (Fase I): jerarquía contador → supervisor → reconciliador
  COMMERCIAL_INVENTORY_CONTAR = 'COMMERCIAL_INVENTORY_CONTAR',
  COMMERCIAL_INVENTORY_SUPERVISAR = 'COMMERCIAL_INVENTORY_SUPERVISAR',
  COMMERCIAL_INVENTORY_RECONCILIAR = 'COMMERCIAL_INVENTORY_RECONCILIAR',
  COMMERCIAL_INVENTORY_ASIGNAR = 'COMMERCIAL_INVENTORY_ASIGNAR',

  // Módulo: Comercial — Pedidos y Cobros (Sprint B.2, declarados acá para tener el set completo)
  COMMERCIAL_ORDERS_VER = 'COMMERCIAL_ORDERS_VER',
  COMMERCIAL_ORDERS_CREAR = 'COMMERCIAL_ORDERS_CREAR',
  COMMERCIAL_ORDERS_CONFIRMAR = 'COMMERCIAL_ORDERS_CONFIRMAR',
  COMMERCIAL_ORDERS_CANCELAR = 'COMMERCIAL_ORDERS_CANCELAR',
  COMMERCIAL_ORDERS_FULFILL = 'COMMERCIAL_ORDERS_FULFILL',
  COMMERCIAL_PAYMENTS_REGISTRAR = 'COMMERCIAL_PAYMENTS_REGISTRAR',
  // Fase LM — Última milla: verificar/reversar cobros + gestionar corte de caja del repartidor
  COMMERCIAL_PAYMENTS_VERIFICAR = 'COMMERCIAL_PAYMENTS_VERIFICAR',
  COMMERCIAL_PAYMENTS_REVERSAR = 'COMMERCIAL_PAYMENTS_REVERSAR',
  COMMERCIAL_RIDER_LIQUIDATION_GESTIONAR = 'COMMERCIAL_RIDER_LIQUIDATION_GESTIONAR',

  // Módulo: Comercial — Promociones (Fase G.2)
  COMMERCIAL_PROMOTIONS_VER = 'COMMERCIAL_PROMOTIONS_VER',
  COMMERCIAL_PROMOTIONS_GESTIONAR = 'COMMERCIAL_PROMOTIONS_GESTIONAR',

  // Módulo: Comercial — Televenta / Remote Manager (Fase E)
  COMMERCIAL_TELEVENTA_VER = 'COMMERCIAL_TELEVENTA_VER',
  COMMERCIAL_TELEVENTA_OPERATE = 'COMMERCIAL_TELEVENTA_OPERATE',

  // Fase V — Vendedor de campo con OCR de ticket
  CAPTURE_TICKET_USE = 'CAPTURE_TICKET_USE',

  // Acceso a la app de vendedor standalone (gate administrable desde /admin/roles)
  VENDOR_APP_ACCESS = 'VENDOR_APP_ACCESS',

  // Módulo: Comercial — Cierre de ruta (tickets venta/carga/combustible)
  ROUTE_TICKET_CAPTURE = 'ROUTE_TICKET_CAPTURE', // vendedor: subir/ver sus tickets
  ROUTE_CONTROL_VER = 'ROUTE_CONTROL_VER', // admin: ver todos + reportes de ruta

  // Módulo: Logística — Flotilla y choferes (Fase J)
  LOGISTICS_FLEET_VER = 'LOGISTICS_FLEET_VER',
  LOGISTICS_FLEET_GESTIONAR = 'LOGISTICS_FLEET_GESTIONAR',

  // Módulo: Logística — Embarques (state machine)
  LOGISTICS_SHIPMENTS_VER = 'LOGISTICS_SHIPMENTS_VER',
  LOGISTICS_SHIPMENTS_GESTIONAR = 'LOGISTICS_SHIPMENTS_GESTIONAR',

  // Módulo: Logística — Guías + destinatarios
  LOGISTICS_GUIDES_VER = 'LOGISTICS_GUIDES_VER',
  LOGISTICS_GUIDES_GESTIONAR = 'LOGISTICS_GUIDES_GESTIONAR',
  // Fase LM-K — despacho a domicilio desde folio Kepler (persona de tienda captura + asigna)
  LOGISTICS_HOME_DISPATCH = 'LOGISTICS_HOME_DISPATCH',

  // Módulo: Logística — Costos del viaje
  LOGISTICS_EXPENSES_VER = 'LOGISTICS_EXPENSES_VER',
  LOGISTICS_EXPENSES_GESTIONAR = 'LOGISTICS_EXPENSES_GESTIONAR',

  // Módulo: Logística — Liquidaciones y períodos
  LOGISTICS_PAYROLL_VER = 'LOGISTICS_PAYROLL_VER',
  LOGISTICS_PAYROLL_GESTIONAR = 'LOGISTICS_PAYROLL_GESTIONAR',

  // Módulo: Logística — Configuración financiera (factores, costo km)
  LOGISTICS_CONFIG_GESTIONAR = 'LOGISTICS_CONFIG_GESTIONAR',

  // Módulo: Logística — Carta Porte 3.1 (CFDI Traslado vía PAC)
  LOGISTICS_CARTAPORTE_VER = 'LOGISTICS_CARTAPORTE_VER',
  LOGISTICS_CARTAPORTE_GESTIONAR = 'LOGISTICS_CARTAPORTE_GESTIONAR',

  // ── Fase AZ — permisos jerárquicos (App → Proyecto → Módulo) ──────────
  // Nacen al partir permisos que antes gateaban varios módulos a la vez, para
  // que cada módulo tenga los suyos. Backfill determinista en la migración.
  // Ver docs/IMPLEMENTACION/FASES/FASE_AZ_AUTHZ_JERARQUICO.md.
  ROLES_VER = 'ROLES_VER',
  // COMMERCIAL_ANALYTICS_VER = paraguas del Command Center + endpoints agregados
  // (overview/network/top-*/erp-*). Cada REPORTE tiene su propio permiso abajo
  // para poder acotar un rol a un solo reporte sin abrir todo el analytics.
  COMMERCIAL_ANALYTICS_VER = 'COMMERCIAL_ANALYTICS_VER',
  COMMERCIAL_SELLOUT_VER = 'COMMERCIAL_SELLOUT_VER',
  COMMERCIAL_SALIDAS_VER = 'COMMERCIAL_SALIDAS_VER',
  COMMERCIAL_ROUTE_SALES_VER = 'COMMERCIAL_ROUTE_SALES_VER',
  // Traspasos NO tiene permiso propio nuevo: reusa el ya existente
  // LOGISTICS_TRANSFERS_VER (la ruta /logistica/traspasos ya lo usa).
  COMMERCIAL_CUSTOMERS360_VER = 'COMMERCIAL_CUSTOMERS360_VER',
  COMMERCIAL_HISTORICAL_VER = 'COMMERCIAL_HISTORICAL_VER',
  COMMERCIAL_DEADSTOCK_VER = 'COMMERCIAL_DEADSTOCK_VER',
  COMMERCIAL_INVHEALTH_VER = 'COMMERCIAL_INVHEALTH_VER',
  // Páginas independientes que estaban bajo un permiso compartido:
  COMMERCIAL_ERP_PROMOS_VER = 'COMMERCIAL_ERP_PROMOS_VER',   // /comercial/erp-promos (promos del ERP)
  COMMERCIAL_VENDOR_SALES_VER = 'COMMERCIAL_VENDOR_SALES_VER', // /comercial/vendor-sales (ventas de vendedor)
  COMMERCIAL_CARTERA_VER = 'COMMERCIAL_CARTERA_VER',
  COMMERCIAL_CARTERA_GESTIONAR = 'COMMERCIAL_CARTERA_GESTIONAR',
  COMMERCIAL_PRODUCTS_VER = 'COMMERCIAL_PRODUCTS_VER',
  COMMERCIAL_PRODUCTS_GESTIONAR = 'COMMERCIAL_PRODUCTS_GESTIONAR',
  COMMERCIAL_THOT_VER = 'COMMERCIAL_THOT_VER',
  COMMERCIAL_THOT_GESTIONAR = 'COMMERCIAL_THOT_GESTIONAR',
  TRADE_ROUTE_PLAN_VER = 'TRADE_ROUTE_PLAN_VER',
  TRADE_ROUTE_PLAN_GESTIONAR = 'TRADE_ROUTE_PLAN_GESTIONAR',
  LOGISTICS_TRANSFERS_VER = 'LOGISTICS_TRANSFERS_VER',
  PORTAL_B2B_ACCESS = 'PORTAL_B2B_ACCESS',

  // ── Proyecto Finanzas (egresos contables, CxP, hallazgos) ─────────────
  // Separado de ventas: un rol contable no debe arrastrar permisos comerciales.
  FINANCE_EXPENSES_VER = 'FINANCE_EXPENSES_VER',
  // MAAT (ADR-028) — chat AI de finanzas + gestión de hallazgos/conocimiento
  FINANCE_AI_CHAT = 'FINANCE_AI_CHAT',
  FINANCE_FINDINGS_GESTIONAR = 'FINANCE_FINDINGS_GESTIONAR',

  // ── Supervisor de Movimientos (cuadre / reconciliación) — ADR-029 ─────
  RECONCILIATION_VER = 'RECONCILIATION_VER',
  RECONCILIATION_GESTIONAR = 'RECONCILIATION_GESTIONAR',

  // ── Compras / Reabastecimiento (Fase RA — ADR-030) ────────────────────
  COMPRAS_VER = 'COMPRAS_VER',
  COMPRAS_GESTIONAR = 'COMPRAS_GESTIONAR',

  // ── Fiscal (auditoría CFDI / cumplimiento SAT — libs/fiscal) ──────────
  // FISCAL.0/1 = motor de listas SAT (EFOS 69-B, Art. 69) + validación RFC.
  FISCAL_LISTAS_VER = 'FISCAL_LISTAS_VER',
  FISCAL_LISTAS_GESTIONAR = 'FISCAL_LISTAS_GESTIONAR',
  // FISCAL.2 = bóveda de credenciales SAT (e.firma/CIEC) — muy sensible.
  FISCAL_CREDENCIALES_GESTIONAR = 'FISCAL_CREDENCIALES_GESTIONAR',
  // FISCAL.4 = descarga masiva de CFDI (WS SAT).
  FISCAL_DESCARGA_VER = 'FISCAL_DESCARGA_VER',
  FISCAL_DESCARGA_GESTIONAR = 'FISCAL_DESCARGA_GESTIONAR',
  // FISCAL.4.2 = almacén CFDI 4.0 (parser + fiscal.cfdis).
  FISCAL_CFDI_VER = 'FISCAL_CFDI_VER',
  // FISCAL.5 = conciliación CFDI↔póliza + PUE/PPD↔REP (saldo insoluto).
  FISCAL_CONCILIACION_VER = 'FISCAL_CONCILIACION_VER',
  // FISCAL.8 = DIOT + conciliación de IVA (efectivamente pagado).
  FISCAL_DIOT_VER = 'FISCAL_DIOT_VER',
  // FISCAL.9 = contabilidad electrónica (XMLs SAT: catálogo + balanza).
  FISCAL_CONTAB_VER = 'FISCAL_CONTAB_VER',
  // FE.11 = gestión del mapeo cuenta mayor → código agrupador SAT.
  FISCAL_CONTAB_GESTIONAR = 'FISCAL_CONTAB_GESTIONAR',
  // FE = facturación electrónica (emisión/timbrado CFDI 4.0 vía PAC SW/Conectia).
  FISCAL_FACTURAR_VER = 'FISCAL_FACTURAR_VER',
  FISCAL_FACTURAR_GESTIONAR = 'FISCAL_FACTURAR_GESTIONAR',
}
