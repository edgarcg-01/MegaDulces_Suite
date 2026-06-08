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
  [Permission.ROLES_CONFIGURAR]: { label: 'Configurar Roles y Funciones', description: 'ACCESO CRÍTICO: edita este panel de permisos para cualquier rol.', category: 'Configuración' },
  [Permission.SCORING_CONFIG_VER]: { label: 'Ver Config. Puntuación', description: 'Visualizar la configuración y parámetros de scoring.', category: 'Configuración' },
  [Permission.SCORING_CONFIG_GESTIONAR]: { label: 'Gestionar Config. Puntuación', description: 'Editar parámetros, versiones y puntuaciones del scoring.', category: 'Configuración' },

  // Seguimiento
  [Permission.VER_SEGUIMIENTO]: { label: 'Ver Seguimiento', description: 'Acceso al módulo de seguimiento de visitas y rutas en campo.', category: 'Seguimiento' },
  [Permission.RUTAS_VER]: { label: 'Ver Rutas', description: 'Apartado de análisis de rutas: tiendas por ruta, tiempos de visita y trazabilidad del recorrido.', category: 'Seguimiento' },

  // Comercial — clientes, almacenes, pricing, inventario
  [Permission.COMMERCIAL_CUSTOMERS_VER]: { label: 'Ver Clientes', description: 'Consultar la cartera de clientes B2B.', category: 'Comercial' },
  [Permission.COMMERCIAL_CUSTOMERS_GESTIONAR]: { label: 'Gestionar Clientes', description: 'Alta, edición y baja de clientes B2B.', category: 'Comercial' },
  [Permission.COMMERCIAL_WAREHOUSES_VER]: { label: 'Ver Almacenes', description: 'Consultar almacenes y centros de distribución.', category: 'Comercial' },
  [Permission.COMMERCIAL_WAREHOUSES_GESTIONAR]: { label: 'Gestionar Almacenes', description: 'Alta y edición de almacenes (incluye almacén default).', category: 'Comercial' },
  [Permission.COMMERCIAL_PRICING_VER]: { label: 'Ver Precios', description: 'Consultar listas de precios y precios por cliente.', category: 'Comercial' },
  [Permission.COMMERCIAL_PRICING_GESTIONAR]: { label: 'Gestionar Precios', description: 'Crear listas y cargar/editar precios de productos.', category: 'Comercial' },
  [Permission.COMMERCIAL_INVENTORY_VER]: { label: 'Ver Inventario', description: 'Consultar stock disponible por almacén.', category: 'Comercial' },
  [Permission.COMMERCIAL_INVENTORY_AJUSTAR]: { label: 'Ajustar Inventario', description: 'Registrar movimientos y ajustes de stock.', category: 'Comercial' },

  // Comercial — pedidos y cobros
  [Permission.COMMERCIAL_ORDERS_VER]: { label: 'Ver Pedidos', description: 'Consultar pedidos y su detalle.', category: 'Comercial · Pedidos' },
  [Permission.COMMERCIAL_ORDERS_CREAR]: { label: 'Crear Pedidos', description: 'Levantar pedidos en borrador.', category: 'Comercial · Pedidos' },
  [Permission.COMMERCIAL_ORDERS_CONFIRMAR]: { label: 'Confirmar Pedidos', description: 'Pasar pedidos de borrador a confirmado (reserva stock).', category: 'Comercial · Pedidos' },
  [Permission.COMMERCIAL_ORDERS_CANCELAR]: { label: 'Cancelar Pedidos', description: 'Cancelar pedidos y liberar el stock reservado.', category: 'Comercial · Pedidos' },
  [Permission.COMMERCIAL_ORDERS_FULFILL]: { label: 'Surtir Pedidos', description: 'Marcar pedidos como surtidos (consume stock).', category: 'Comercial · Pedidos' },
  [Permission.COMMERCIAL_PAYMENTS_REGISTRAR]: { label: 'Registrar Cobros', description: 'Registrar pagos de pedidos (cash en beta).', category: 'Comercial · Pedidos' },

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
  'Comercial · Pedidos',
  'Comercial · Promociones',
  'Televenta',
  'Logística',
  'Otros',
];

/** Total de permisos definidos en el enum (denominador de cobertura). */
export const TOTAL_PERMISSIONS = Object.values(Permission).length;
