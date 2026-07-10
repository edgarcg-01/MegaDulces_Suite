import { Permission } from './permissions';

export interface PermissionMetaEntry {
  label: string;
  description: string;
  category: string;
}

/**
 * Metadata de presentación de cada permiso (label legible, descripción y
 * categoría). Fuente única compartida por el editor de permisos
 * (`admin-roles-permissions`) y la vista de roles (`admin-roles-grid`).
 *
 * Debe cubrir TODAS las claves del enum `Permission`; si se agrega un permiso
 * al enum, agregar su entrada aquí o saldrá con la key cruda en "Otros".
 */
export const PERMISSION_META: Record<string, PermissionMetaEntry> = {
  // Usuarios
  [Permission.USUARIOS_VER]: { label: 'Consultar Usuarios', description: 'Permite listar y ver el perfil de otros usuarios.', category: 'Usuarios' },
  [Permission.USUARIOS_GESTIONAR]: { label: 'Gestionar Usuarios', description: 'Alta, baja y edición de usuarios.', category: 'Usuarios' },
  [Permission.USUARIOS_PASSWORDS]: { label: 'Resetear Contraseñas', description: 'Permite cambiar contraseñas de cualquier usuario.', category: 'Usuarios' },
  [Permission.USUARIOS_ASIGNAR_RUTA]: { label: 'Asignar Rutas', description: 'Permite definir la agenda semanal de rutas para el equipo.', category: 'Usuarios' },

  // Reportes
  [Permission.REPORTES_VER_PROPIO]: { label: 'Ver Reportes Propios', description: 'Acceso básico a sus propios indicadores.', category: 'Reportes' },
  [Permission.REPORTES_VER_EQUIPO]: { label: 'Ver Reportes de Equipo', description: 'Acceso a indicadores de subordinados directos.', category: 'Reportes' },
  [Permission.REPORTES_VER_GLOBAL]: { label: 'Ver Reporte Global', description: 'Acceso total a la data de la compañía. Concede manage:all.', category: 'Reportes' },
  [Permission.REPORTES_EXPORTAR]: { label: 'Exportar Data (Excel/CSV)', description: 'Permite descargar crudos de información.', category: 'Reportes' },
  [Permission.REPORTES_GESTIONAR]: { label: 'Gestionar Reportes', description: 'Permite eliminar reportes almacenados en el sistema.', category: 'Reportes' },

  // Operación en campo
  [Permission.VISITAS_REGISTRAR]: { label: 'Registrar Visitas', description: 'Habilita el formulario de check-in/visto bueno.', category: 'Operación' },
  [Permission.VISITAS_VER]: { label: 'Ver Visitas', description: 'Acceso al listado y detalle de visitas registradas.', category: 'Operación' },
  [Permission.VISITAS_AUDITAR]: { label: 'Auditar Visitas', description: 'Permite validar y cerrar visitas de otros.', category: 'Operación' },
  [Permission.CAPTURE_TICKET_USE]: { label: 'Captura con Ticket (OCR)', description: 'Autollenar productos del exhibidor con foto del ticket vía IA.', category: 'Operación' },

  // Configuración
  [Permission.CATALOGO_GESTIONAR]: { label: 'Gestionar Catálogos', description: 'Control de conceptos, zonas y ubicaciones.', category: 'Configuración' },
  [Permission.PLANOGRAMAS_GESTIONAR]: { label: 'Gestionar Planogramas', description: 'Creación de marcas y jerarquías de productos.', category: 'Configuración' },
  [Permission.TIENDAS_VER]: { label: 'Ver Tiendas', description: 'Acceso al módulo de tiendas y sus detalles.', category: 'Configuración' },
  [Permission.TIENDAS_CREAR]: { label: 'Crear Tiendas', description: 'Permite registrar nuevas tiendas desde la captura de visitas.', category: 'Configuración' },
  [Permission.STORE_LIVE_VER]: { label: 'Monitor Tienda en Vivo', description: 'Acceder al monitor de tickets y cajas en tiempo real (Proyecto TDA).', category: 'Tienda' },
  [Permission.STORE_LABELS_VER]: { label: 'Etiquetas de anaquel', description: 'Generar e imprimir etiquetas de precio de anaquel (Proyecto Tienda).', category: 'Tienda' },
  [Permission.ROLES_CONFIGURAR]: { label: 'Configurar Roles y Funciones', description: 'ACCESO CRÍTICO: edita este panel de permisos para cualquier rol.', category: 'Configuración' },
  [Permission.SCORING_CONFIG_VER]: { label: 'Ver Config. Puntuación', description: 'Visualizar la configuración y parámetros de scoring.', category: 'Configuración' },
  [Permission.SCORING_CONFIG_GESTIONAR]: { label: 'Gestionar Config. Puntuación', description: 'Editar parámetros, versiones y puntuaciones del scoring.', category: 'Configuración' },

  // Seguimiento
  [Permission.VER_SEGUIMIENTO]: { label: 'Ver Seguimiento', description: 'Acceso al módulo de seguimiento de visitas y rutas en campo.', category: 'Seguimiento' },
  [Permission.RUTAS_VER]: { label: 'Ver Rutas', description: 'Apartado de análisis de rutas: tiendas por ruta, tiempos de visita y trazabilidad del recorrido.', category: 'Seguimiento' },
  [Permission.COMMERCIAL_MAP_VER]: { label: 'Ver Mapa Comercial', description: 'Mapa de tiendas con exhibidores Mega Dulces vs competencia + historial de exhibiciones por tienda.', category: 'Seguimiento' },
  [Permission.COMMERCIAL_MAP_PROSPECTS_VER]: { label: 'Ver Tiendas de Oportunidad', description: 'Capa de prospección: PdV reales (INEGI DENUE) que aún no son clientes, en el mapa comercial.', category: 'Seguimiento' },
  [Permission.COMMERCIAL_MAP_PROSPECTS_GESTIONAR]: { label: 'Gestionar Prospección', description: 'Cosechar de DENUE, deduplicar, descartar y convertir tiendas de oportunidad + configurar SCIAN/área.', category: 'Seguimiento' },

  // Comercial — clientes, almacenes, pricing, inventario
  [Permission.COMMERCIAL_CUSTOMERS_VER]: { label: 'Ver Clientes', description: 'Consultar la cartera de clientes B2B.', category: 'Comercial' },
  [Permission.COMMERCIAL_CUSTOMERS_GESTIONAR]: { label: 'Gestionar Clientes', description: 'Alta, edición y baja de clientes B2B.', category: 'Comercial' },
  [Permission.COMMERCIAL_WAREHOUSES_VER]: { label: 'Ver Almacenes', description: 'Consultar almacenes y centros de distribución.', category: 'Comercial' },
  [Permission.COMMERCIAL_WAREHOUSES_GESTIONAR]: { label: 'Gestionar Almacenes', description: 'Alta y edición de almacenes (incluye almacén default).', category: 'Comercial' },
  [Permission.COMMERCIAL_PRICING_VER]: { label: 'Ver Precios', description: 'Consultar listas de precios y precios por cliente.', category: 'Comercial' },
  [Permission.COMMERCIAL_PRICING_GESTIONAR]: { label: 'Gestionar Precios', description: 'Crear listas y cargar/editar precios de productos.', category: 'Comercial' },
  [Permission.COMMERCIAL_INVENTORY_VER]: { label: 'Ver Inventario', description: 'Consultar stock disponible por almacén.', category: 'Comercial' },
  [Permission.COMMERCIAL_INVENTORY_AJUSTAR]: { label: 'Ajustar Inventario', description: 'Registrar movimientos y ajustes de stock.', category: 'Comercial' },
  [Permission.COMMERCIAL_INVENTORY_CONTAR]: { label: 'Contar (inventario físico)', description: 'Registrar conteos ciegos en un folio de inventario físico (rol contador).', category: 'Comercial · Inventario físico' },
  [Permission.COMMERCIAL_INVENTORY_SUPERVISAR]: { label: 'Supervisar inventario físico', description: 'Abrir folios, ver avance/discrepancias y resolver. No reconcilia (rol supervisor).', category: 'Comercial · Inventario físico' },
  [Permission.COMMERCIAL_INVENTORY_RECONCILIAR]: { label: 'Reconciliar inventario físico', description: 'Autorizar el ajuste del saldo al físico contado y cerrar el folio (rol jefe).', category: 'Comercial · Inventario físico' },
  [Permission.COMMERCIAL_INVENTORY_ASIGNAR]: { label: 'Asignar personas al folio', description: 'Asignar contadores y supervisores a un folio de inventario específico.', category: 'Comercial · Inventario físico' },

  // Comercial — pedidos y cobros
  [Permission.COMMERCIAL_ORDERS_VER]: { label: 'Ver Pedidos', description: 'Consultar pedidos y su detalle.', category: 'Comercial · Pedidos' },
  [Permission.COMMERCIAL_ORDERS_CREAR]: { label: 'Crear Pedidos', description: 'Levantar pedidos en borrador.', category: 'Comercial · Pedidos' },
  [Permission.COMMERCIAL_ORDERS_CONFIRMAR]: { label: 'Confirmar Pedidos', description: 'Pasar pedidos de borrador a confirmado (reserva stock).', category: 'Comercial · Pedidos' },
  [Permission.COMMERCIAL_ORDERS_CANCELAR]: { label: 'Cancelar Pedidos', description: 'Cancelar pedidos y liberar el stock reservado.', category: 'Comercial · Pedidos' },
  [Permission.COMMERCIAL_ORDERS_FULFILL]: { label: 'Surtir Pedidos', description: 'Marcar pedidos como surtidos (consume stock).', category: 'Comercial · Pedidos' },
  [Permission.COMMERCIAL_PAYMENTS_REGISTRAR]: { label: 'Registrar Cobros', description: 'Registrar pagos de pedidos (cash en beta).', category: 'Comercial · Pedidos' },
  [Permission.COMMERCIAL_PAYMENTS_VERIFICAR]: { label: 'Verificar Cobros', description: 'Verificar cobros de última milla contra el corte del repartidor.', category: 'Comercial · Pedidos' },
  [Permission.COMMERCIAL_PAYMENTS_REVERSAR]: { label: 'Reversar Cobros', description: 'Reversar/anular un cobro registrado por error.', category: 'Comercial · Pedidos' },
  [Permission.COMMERCIAL_RIDER_LIQUIDATION_GESTIONAR]: { label: 'Liquidar Repartidor', description: 'Gestionar el corte de caja y liquidación del repartidor de última milla.', category: 'Comercial · Pedidos' },
  [Permission.VENDOR_APP_ACCESS]: { label: 'Acceso a App Vendedor', description: 'Permite entrar a la app de vendedor standalone (cartera, levantar pedidos, visitas y captura).', category: 'Comercial · Pedidos' },

  // Comercial — promociones
  [Permission.COMMERCIAL_PROMOTIONS_VER]: { label: 'Ver Promociones', description: 'Consultar campañas y promociones vigentes.', category: 'Comercial · Promociones' },
  [Permission.COMMERCIAL_PROMOTIONS_GESTIONAR]: { label: 'Gestionar Promociones', description: 'Crear y editar promociones y campañas.', category: 'Comercial · Promociones' },

  // Televenta
  [Permission.COMMERCIAL_TELEVENTA_VER]: { label: 'Ver Televenta', description: 'Acceso de lectura al módulo de televenta / call center.', category: 'Televenta' },
  [Permission.COMMERCIAL_TELEVENTA_OPERATE]: { label: 'Operar Televenta', description: 'Trabajar el pool: tomar cliente, registrar llamada, levantar pedido.', category: 'Televenta' },

  // Logística
  [Permission.LOGISTICS_FLEET_VER]: { label: 'Ver Flotilla', description: 'Consultar unidades, choferes y personal de logística.', category: 'Logística' },
  [Permission.LOGISTICS_FLEET_GESTIONAR]: { label: 'Gestionar Flotilla', description: 'Alta y edición de unidades y personal de logística.', category: 'Logística' },
  [Permission.LOGISTICS_SHIPMENTS_VER]: { label: 'Ver Embarques', description: 'Consultar embarques y su estado.', category: 'Logística' },
  [Permission.LOGISTICS_SHIPMENTS_GESTIONAR]: { label: 'Gestionar Embarques', description: 'Crear y avanzar embarques en su máquina de estados.', category: 'Logística' },
  [Permission.LOGISTICS_GUIDES_VER]: { label: 'Ver Guías', description: 'Consultar guías de entrega y destinatarios.', category: 'Logística' },
  [Permission.LOGISTICS_GUIDES_GESTIONAR]: { label: 'Gestionar Guías', description: 'Crear y editar guías y sus destinatarios.', category: 'Logística' },
  [Permission.LOGISTICS_EXPENSES_VER]: { label: 'Ver Costos', description: 'Consultar costos y gastos del viaje.', category: 'Logística' },
  [Permission.LOGISTICS_EXPENSES_GESTIONAR]: { label: 'Gestionar Costos', description: 'Registrar y editar costos del viaje.', category: 'Logística' },
  [Permission.LOGISTICS_PAYROLL_VER]: { label: 'Ver Liquidaciones', description: 'Consultar liquidaciones y períodos de pago.', category: 'Logística' },
  [Permission.LOGISTICS_PAYROLL_GESTIONAR]: { label: 'Gestionar Liquidaciones', description: 'Calcular y cerrar liquidaciones por período.', category: 'Logística' },
  [Permission.LOGISTICS_CONFIG_GESTIONAR]: { label: 'Configurar Logística', description: 'Parámetros financieros (factores, costo por km).', category: 'Logística' },
  [Permission.LOGISTICS_CARTAPORTE_VER]: { label: 'Ver Carta Porte', description: 'Consultar documentos Carta Porte timbrados.', category: 'Logística' },
  [Permission.LOGISTICS_CARTAPORTE_GESTIONAR]: { label: 'Timbrar Carta Porte', description: 'Validar y timbrar Carta Porte (CFDI Traslado) ante el SAT.', category: 'Logística' },

  // ── Fase AZ — permisos jerárquicos nuevos ─────────────────────────────
  [Permission.ROLES_VER]: { label: 'Ver Roles', description: 'Consultar roles y sus permisos (solo lectura).', category: 'Configuración' },
  [Permission.COMMERCIAL_ANALYTICS_VER]: { label: 'Ver Analítica Comercial', description: 'Command center, salidas, ventas por ruta, dead-stock, salud de inventario, cliente 360 e histórico de venta. (Sell-Out tiene su propio permiso.)', category: 'Comercial · Analítica' },
  [Permission.COMMERCIAL_SELLOUT_VER]: { label: 'Ver Sell-Out por empresa', description: 'Solo el reporte Sell-Out por empresa (RS): matriz producto × sucursal con cajas y monto, + XLSX/PDF. No abre el resto de la analítica.', category: 'Comercial · Analítica' },
  [Permission.COMMERCIAL_SALIDAS_VER]: { label: 'Ver Salidas por producto', description: 'Solo el reporte Salidas por producto (ventas/existencia/costos por sucursal × producto) + XLSX.', category: 'Comercial · Analítica' },
  [Permission.COMMERCIAL_ROUTE_SALES_VER]: { label: 'Ver Ventas por ruta', description: 'Solo el reporte Ventas por ruta (mensual sucursal × ruta) + XLSX.', category: 'Comercial · Analítica' },
  [Permission.COMMERCIAL_CUSTOMERS360_VER]: { label: 'Ver Clientes 360', description: 'Solo la ficha analítica Clientes 360 (compra agregada del ERP por cliente y sus productos).', category: 'Comercial · Analítica' },
  [Permission.COMMERCIAL_HISTORICAL_VER]: { label: 'Ver Histórico de venta', description: 'Solo el histórico de venta del ERP (diario, top productos, por zona, ranking, margen por categoría).', category: 'Comercial · Analítica' },
  [Permission.COMMERCIAL_DEADSTOCK_VER]: { label: 'Ver Stock muerto', description: 'Solo el reporte de stock muerto (productos sin rotación).', category: 'Comercial · Analítica' },
  [Permission.COMMERCIAL_INVHEALTH_VER]: { label: 'Ver Salud de inventario', description: 'Solo el reporte de salud de inventario (días de cobertura + status por producto × almacén).', category: 'Comercial · Analítica' },
  [Permission.COMMERCIAL_ERP_PROMOS_VER]: { label: 'Ver Promos del ERP', description: 'Solo la vista de promociones vigentes del ERP (Kepler). Distinto de gestionar promociones propias.', category: 'Comercial · Promociones' },
  [Permission.COMMERCIAL_VENDOR_SALES_VER]: { label: 'Ver Ventas de vendedor', description: 'Solo el reporte de ventas de vendedor (parte comercial del ticket OCR: por tienda/captura/ruta).', category: 'Comercial' },
  [Permission.COMMERCIAL_CARTERA_VER]: { label: 'Ver Cartera', description: 'Consultar la cartera de ventas y la asignación de rutas a vendedores.', category: 'Comercial · Cartera' },
  [Permission.COMMERCIAL_CARTERA_GESTIONAR]: { label: 'Gestionar Cartera', description: 'Asignar rutas y orden de visita a los vendedores.', category: 'Comercial · Cartera' },
  [Permission.COMMERCIAL_PRODUCTS_VER]: { label: 'Ver Productos', description: 'Consultar el catálogo comercial de productos.', category: 'Comercial' },
  [Permission.COMMERCIAL_PRODUCTS_GESTIONAR]: { label: 'Gestionar Productos', description: 'Alta y edición del catálogo comercial de productos.', category: 'Comercial' },
  [Permission.COMMERCIAL_THOT_VER]: { label: 'Ver Thot / IA', description: 'Chat comercial e inteligencia de recomendación (Thot).', category: 'Comercial · Thot' },
  [Permission.COMMERCIAL_THOT_GESTIONAR]: { label: 'Gestionar Thot / IA', description: 'Curar contenido y recomendaciones del motor Thot.', category: 'Comercial · Thot' },
  [Permission.TRADE_ROUTE_PLAN_VER]: { label: 'Ver Agenda de Rutas', description: 'Consultar la agenda diaria de rutas del equipo de campo.', category: 'Seguimiento' },
  [Permission.TRADE_ROUTE_PLAN_GESTIONAR]: { label: 'Gestionar Agenda de Rutas', description: 'Definir y editar la asignación diaria de rutas al equipo.', category: 'Seguimiento' },
  [Permission.LOGISTICS_TRANSFERS_VER]: { label: 'Ver Traspasos', description: 'Consultar traspasos y movimientos que no son venta (consolidación/recepción).', category: 'Logística' },
  [Permission.PORTAL_B2B_ACCESS]: { label: 'Acceso a Portal B2B', description: 'Permite entrar al portal de autoservicio para clientes B2B.', category: 'Portal B2B' },

  // ── Proyecto Finanzas ──────────────────────────────────────────────────
  [Permission.FINANCE_EXPENSES_VER]: { label: 'Ver Egresos Contables', description: 'Proyecto Finanzas: egresos contables (pólizas de gastos 6xx y compras 5xx), desglose por cuenta/beneficiario y drill a documentos.', category: 'Finanzas' },
  [Permission.FINANCE_AI_CHAT]: { label: 'Chat AI de Finanzas (Maat)', description: 'Conversar con Maat: consultas sobre balanza, egresos, proveedores y hallazgos. Solo lectura de datos.', category: 'Finanzas' },
  [Permission.FINANCE_FINDINGS_GESTIONAR]: { label: 'Gestionar Hallazgos y Conocimiento', description: 'Confirmar/descartar hallazgos del motor de patrones y curar la base de conocimiento de Maat.', category: 'Finanzas' },

  // ── Supervisor de Movimientos (cuadre) — ADR-029 ──────────────────────
  [Permission.RECONCILIATION_VER]: { label: 'Ver Cuadre de Movimientos', description: 'Bandeja de descuadres del supervisor: caja (arqueos), inventario y cruces. Solo lectura.', category: 'Almacén' },
  [Permission.RECONCILIATION_GESTIONAR]: { label: 'Gestionar Descuadres', description: 'Confirmar/descartar descuadres, asignar causa (merma/robo/error) y correr el escaneo de cuadre.', category: 'Almacén' },

  // ── Compras / Reabastecimiento (Fase RA — ADR-030) ────────────────────
  [Permission.COMPRAS_VER]: { label: 'Ver Compras', description: 'Existencia crítica, punto de reorden y sugerido de compra. Solo lectura.', category: 'Compras' },
  [Permission.COMPRAS_GESTIONAR]: { label: 'Gestionar Compras', description: 'Generar y aprobar requisiciones de compra a proveedor desde el sugerido de reabastecimiento.', category: 'Compras' },

  // ── Permisos que faltaban en el editor de permisos ────────────────────
  [Permission.SUPERVISOR_AI_VER]: { label: 'Ver Supervisor AI', description: 'Consultar el supervisor de ejecución AI (parte diario, auditoría de fotos, hallazgos de ruta).', category: 'Seguimiento' },
  [Permission.SUPERVISOR_AI_APROBAR]: { label: 'Aprobar acciones del Supervisor AI', description: 'Aprobar o rechazar las acciones propuestas por el supervisor AI (nivel co-piloto).', category: 'Seguimiento' },
  [Permission.ROUTE_CONTROL_VER]: { label: 'Ver Control de ruta', description: 'Consultar los tickets de venta/carga/combustible del cierre de ruta de vendedores.', category: 'Comercial' },
  [Permission.ROUTE_TICKET_CAPTURE]: { label: 'Capturar tickets de ruta', description: 'Registrar tickets del cierre de ruta (venta/carga/combustible).', category: 'Comercial' },
  [Permission.LOGISTICS_HOME_DISPATCH]: { label: 'Reparto a domicilio', description: 'Entrega a domicilio: captura de folio, asignación a repartidor y corte de caja con arqueo.', category: 'Logística' },
};

/**
 * Orden canónico de las categorías para mostrarlas agrupadas de forma estable.
 */
export const PERMISSION_CATEGORY_ORDER: readonly string[] = [
  'Usuarios',
  'Reportes',
  'Operación',
  'Configuración',
  'Seguimiento',
  'Comercial',
  'Comercial · Analítica',
  'Comercial · Cartera',
  'Comercial · Pedidos',
  'Comercial · Promociones',
  'Comercial · Thot',
  'Comercial · Inventario físico',
  'Televenta',
  'Logística',
  'Finanzas',
  'Tienda',
  'Portal B2B',
  'Otros',
];

/** Total de permisos definidos en el enum (denominador de cobertura). */
export const TOTAL_PERMISSIONS = Object.values(Permission).length;
