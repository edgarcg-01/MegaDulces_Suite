# Matriz de accesos y restricciones por puesto

> ⚙️ **Generado — no editar a mano.** Regenerar con `npm run docs:matriz-accesos` (lee prod en
> sesión de sólo lectura + el árbol `libs/contracts/src/authz/authz-tree.ts`).
> Generado el **2026-10-10** · última migración aplicada en prod: `20261009182612_contpaqi_bridge_permisos.js`.
> El repo es público: aquí sólo hay **conteos** de personas, nunca nombres.

**Para qué sirve:** antes de construir un módulo nuevo, ver qué puesto/rol debe verlo y quién debe
poder operarlo; y al terminarlo, seguir la [checklist del §6](#6-checklist-para-un-módulo-nuevo).

## 1. Cómo se concede un acceso (léase primero)

| Pieza | Dónde vive | Qué decide |
|---|---|---|
| **Puesto** | `identity.positions` | **Propone** un rol (`default_role`) y complementos. ⛔ No concede nada por sí mismo. |
| **Rol principal** | `identity.users.role_name` → `identity.role_permissions` | Concede: mapa `{ CLAVE: true }`. Es lo que lee `RolesGuard` en cada request. |
| **Roles complementarios** | `identity.user_roles` | Se **suman** al principal (unión). |
| **Ajuste por persona** | `identity.user_permissions` | `allow=true` agrega, `allow=false` **quita** aunque el rol lo dé. |
| **Alcance (qué filas)** | `identity.role_scopes` → `ScopeService` (ADR-050) | El permiso **abre la pantalla**; el alcance decide **qué sucursales/zonas/clientes** ve. |
| **God-mode** | nombre de rol `superadmin` / `admin` (ADR-054) | Todo, sin mirar el mapa. |

Permiso = **clave exacta** (ADR-054, sin CASL). Convención: `<MÓDULO>_VER` abre, `<MÓDULO>_GESTIONAR`
opera; acciones de control (`_AUTORIZAR`, `_VALIDAR`, `_APROBAR`) van **aparte** para separar funciones.
Un cambio de permisos exige **re-login** (el menú sale del JWT).

## 2. Puestos → rol

"Rol propuesto" es lo que dice el catálogo de puestos; "Roles reales" es lo que tienen hoy las
personas activas en ese puesto (principal + complementos). Cuando no coinciden, manda el real.

### Dirección de Zona · alcance natural: `zona`

| Puesto | Nivel | Rol propuesto | Complementos | Personas | Roles reales (personas) |
|---|---|---|---|---|---|
| Dirección General | direccion | direccion | — | 2 | direccion (2), superadmin (2) |
| Gerencia de Zona | gerencia | supervisor_ventas | — | 3 | superadmin (3), encargado_tienda (1) |

### Tienda / Piso de Venta · alcance natural: `sucursal`

| Puesto | Nivel | Rol propuesto | Complementos | Personas | Roles reales (personas) |
|---|---|---|---|---|---|
| Empaque | operativo | piso_tienda | — | — | — |
| Promotora | operativo | piso_tienda | — | 3 | cajero (2), administrativo (1), analisis_ventas (1) |
| Encargado(a) de Sucursal | coordinacion | encargado_tienda | — | 6 | encargado_tienda (6) |
| Anaquelista de Sucursal | operativo | piso_tienda | — | 1 | repartidor (1) |
| Auxiliar de Encargado | operativo | auxiliar_tienda | — | 5 | auxiliar_tienda (3), encargado_tienda (1), cajero (1) |
| Coordinador de Piso de Ventas | coordinacion | ⚠️ sin definir | — | — | — |
| Multifuncional | operativo | ⚠️ sin definir | — | 1 | superadmin (1), supervisor (1) |
| Vendedora de Piso | operativo | piso_tienda | — | — | — |
| Vigilancia | operativo | ⚠️ sin definir | — | — | — |

### Cajas · alcance natural: `sucursal`

| Puesto | Nivel | Rol propuesto | Complementos | Personas | Roles reales (personas) |
|---|---|---|---|---|---|
| Caja General | operativo | cajero | — | 1 | cajero (1) |
| Practicante Administrativo de Caja General | practicante | ⚠️ sin definir | — | — | — |
| Auxiliar de Caja General de Zona | operativo | ⚠️ sin definir | — | 1 | finanzas_operativo (1) |
| Cajero(a) de Sucursal | operativo | cajero | — | 14 | cajero (13), etiquetas_anaquel (1), auxiliar_tienda (1) |
| Coordinador de Cajas | coordinacion | cajero | — | — | — |

### Ruta Directa (RD) · alcance natural: `ruta`

| Puesto | Nivel | Rol propuesto | Complementos | Personas | Roles reales (personas) |
|---|---|---|---|---|---|
| Supervisor de Ventas Ruta Directa | supervision | supervisor_ventas | — | 2 | supervisor_ventas (2) |
| Cajero Ruta Directa | operativo | ⚠️ sin definir | — | — | — |
| Surtidor de Ventas | operativo | ⚠️ sin definir | — | — | — |
| Vendedor Ruta Directa | operativo | vendedor_ruta | — | 26 | promotor_ruta (17), vendedor_ruta (9), supervisor_ventas (1) |
| Vendedor Suplente | operativo | vendedor_ruta | — | 2 | vendedor_ruta (2) |

### Ruta Vecinal (RV) · alcance natural: `ruta`

| Puesto | Nivel | Rol propuesto | Complementos | Personas | Roles reales (personas) |
|---|---|---|---|---|---|
| Supervisor de Ventas Vecinal | supervision | supervisor_ventas | — | 2 | supervisor_ventas (2) |
| Cajero Vecinal | operativo | cajero | — | 2 | cajero (1), auxiliar_tienda (1) |
| Repartidor Vecinal | operativo | ⚠️ sin definir | — | — | — |
| Vendedor Vecinal | operativo | vendedor_ruta | — | 9 | vendedor_ruta (8), promotor_ruta (2), cajero (1), superadmin (1) |

### Telemarketing (TLMK) · alcance natural: `cartera`

| Puesto | Nivel | Rol propuesto | Complementos | Personas | Roles reales (personas) |
|---|---|---|---|---|---|
| Coordinador de Telemarketing | — | telemarketing | — | 2 | telemarketing (2) |
| Vendedor de Telemarketing | — | vendedor_telemarketing | — | 3 | vendedor_telemarketing (3), telemarketing (1) |

### Mayoreo y Venta Local · alcance natural: `sucursal`

| Puesto | Nivel | Rol propuesto | Complementos | Personas | Roles reales (personas) |
|---|---|---|---|---|---|
| Facturación CEDIS | operativo | facturacion | — | 1 | facturacion (1), auxiliar_compras (1) |
| Facturación | operativo | facturacion | — | 2 | telemarketing (2) |
| Vendedor Mayoreo | operativo | ⚠️ sin definir | — | — | — |

### Almacén y Recepción · alcance natural: `sucursal`

| Puesto | Nivel | Rol propuesto | Complementos | Personas | Roles reales (personas) |
|---|---|---|---|---|---|
| Encargado de Almacén CEDIS | coordinacion | ⚠️ sin definir | — | — | — |
| Almacenista CEDIS | operativo | ⚠️ sin definir | — | — | — |
| Checador CEDIS | operativo | checador | — | — | — |
| Entradas y Salidas de Almacén CEDIS | operativo | ⚠️ sin definir | — | — | — |
| Recepción de Producto CEDIS | operativo | ⚠️ sin definir | — | — | — |
| Surtidor CEDIS | operativo | ⚠️ sin definir | — | — | — |
| Checador | operativo | ⚠️ sin definir | — | 1 | verificador_precios (1), checador_kiosco (1) |
| Recepción de Mercancía de Zona | operativo | ⚠️ sin definir | — | — | — |
| Supervisor de inventarios | — | supervisor | — | 1 | supervisor (1), superadmin (1) |
| Surtidor de Zona | operativo | almacenista | — | — | — |
| Almacenista de Sucursal | operativo | almacenista | — | 5 | almacenista (4), cajero (1), superadmin (1) |
| Bodeguero de Sucursal | operativo | almacenista | — | — | — |
| Recepción de Mercancía de Sucursal | operativo | ⚠️ sin definir | — | — | — |
| Surtidor de Sucursal | operativo | surtidor | — | 3 | surtidor (2), piso_tienda (1) |
| Checador de Pedidos | operativo | checador | — | — | — |

### Logística · alcance natural: `red`

| Puesto | Nivel | Rol propuesto | Complementos | Personas | Roles reales (personas) |
|---|---|---|---|---|---|
| Jefatura de CEDIS y Operaciones Logísticas | jefatura | ⚠️ sin definir | — | 1 | almacenista (1) |
| Auxiliar de CEDIS | operativo | ⚠️ sin definir | — | — | — |
| Coordinador de Logística | coordinacion | ⚠️ sin definir | — | — | — |
| Auxiliar Administrativo de Logística | operativo | almacenista | — | 2 | almacenista (1), encargado_bodega (1), administrativo (1) |
| Auxiliar de Chofer | operativo | ⚠️ sin definir | — | — | — |
| Auxiliar de Logística – Flotilla | operativo | ⚠️ sin definir | — | — | — |
| Chofer | operativo | ⚠️ sin definir | — | — | — |
| Repartidor | operativo | repartidor | — | — | — |
| Auxiliar de Reparto | operativo | ⚠️ sin definir | — | — | — |
| Chofer de Zona | operativo | ⚠️ sin definir | — | — | — |
| Embarques | operativo | coordinador_embarques | — | 1 | coordinador_embarques (1) |

### Operaciones · alcance natural: `red`

| Puesto | Nivel | Rol propuesto | Complementos | Personas | Roles reales (personas) |
|---|---|---|---|---|---|
| Coordinador de Operaciones de Zona | coordinacion | compras_operaciones | — | 1 | compras_operaciones (1) |

### Compras · alcance natural: `red`

| Puesto | Nivel | Rol propuesto | Complementos | Personas | Roles reales (personas) |
|---|---|---|---|---|---|
| Coordinación de Compras | coordinacion | gerente_compras | — | 2 | gerente_compras (2) |
| Analista de Abastecimiento Comercial | operativo | ⚠️ sin definir | — | 1 | auxiliar_compras (1) |
| Analista de Catálogo de Productos | operativo | ⚠️ sin definir | — | — | — |
| Analista de Órdenes de Entrada | operativo | auxiliar_compras | — | 5 | auxiliar_compras (4), compras (1) |
| Comprador | — | compras | — | 1 | compras (1) |
| Analista Regional de Abastecimiento Comercial | operativo | ⚠️ sin definir | — | — | — |

### Prevención y Auditoría · alcance natural: `red`

| Puesto | Nivel | Rol propuesto | Complementos | Personas | Roles reales (personas) |
|---|---|---|---|---|---|
| Coordinación de Auditoría Operativa y Prevención de Pérdidas | coordinacion | prevencion | — | 1 | prevencion (1) |
| Auxiliar de Auditoría y Prevención | operativo | prevencion_auxiliar | — | 2 | prevencion_auxiliar (2) |

### Administración · alcance natural: `red`

| Puesto | Nivel | Rol propuesto | Complementos | Personas | Roles reales (personas) |
|---|---|---|---|---|---|
| Encargado de Activos e Insumos | operativo | ⚠️ sin definir | — | — | — |
| Jefe de Mantenimiento | jefatura | ⚠️ sin definir | — | 1 | administrativo (1) |
| Dirección Comercial y Marketing | direccion | ⚠️ sin definir | — | — | — |
| Auxiliar Administrativo de Zona | operativo | administrativo | analisis_ventas | — | — |
| Intendencia | operativo | ⚠️ sin definir | — | — | — |

### Contabilidad · alcance natural: `red`

| Puesto | Nivel | Rol propuesto | Complementos | Personas | Roles reales (personas) |
|---|---|---|---|---|---|
| Encargado de Contabilidad | coordinacion | ⚠️ sin definir | — | — | — |
| Analista Contable | operativo | contabilidad | — | 3 | contabilidad (3) |

### Finanzas · alcance natural: `red`

| Puesto | Nivel | Rol propuesto | Complementos | Personas | Roles reales (personas) |
|---|---|---|---|---|---|
| Gerencia Administrativa y Financiera | gerencia | finanzas | — | 2 | finanzas (2), finanzas_operativo (1), administrativo (1), almacenista (1), analisis_ventas (1), auditor_externo (1), auxiliar_compras (1), auxiliar_tienda (1), cajero (1), checador_kiosco (1), compras (1), compras_operaciones (1), contabilidad (1), credito_cobranza (1), customer_b2b (1), direccion (1), encargado_bodega (1), encargado_tienda (1), etiquetas_anaquel (1), gerente_compras (1), jefe_marketing (1), marketing (1), piso_tienda (1), prevencion (1), prevencion_auxiliar (1), promotor_ruta (1), recursos_humanos (1), repartidor (1), servicio (1), superadmin (1), supervisor (1), supervisor_ventas (1), telemarketing (1), tesoreria (1), vendedor_ruta (1), verificador_precios (1) |
| Presupuestos y Compras Corporativas | operativo | ⚠️ sin definir | — | 1 | contabilidad (1) |
| Auxiliar de finanzas | — | finanzas_operativo | — | 4 | finanzas_operativo (4) |

### Tesorería · alcance natural: `red`

| Puesto | Nivel | Rol propuesto | Complementos | Personas | Roles reales (personas) |
|---|---|---|---|---|---|
| Jefe de Tesorería | jefatura | tesoreria | — | 1 | tesoreria (1), analisis_ventas (1), finanzas (1) |
| Analista de Egresos | operativo | ⚠️ sin definir | — | — | — |
| Analista de Ingresos | operativo | ⚠️ sin definir | — | — | — |

### Crédito y Cobranza · alcance natural: `red`

| Puesto | Nivel | Rol propuesto | Complementos | Personas | Roles reales (personas) |
|---|---|---|---|---|---|
| Crédito y Cobranza | operativo | credito_cobranza | — | 3 | credito_cobranza (2), finanzas_operativo (1) |

### Mercadotecnia · alcance natural: `red`

| Puesto | Nivel | Rol propuesto | Complementos | Personas | Roles reales (personas) |
|---|---|---|---|---|---|
| Inteligencia Comercial | operativo | ⚠️ sin definir | — | — | — |
| Jefe de Marketing | jefatura | jefe_marketing | — | 1 | jefe_marketing (1) |
| Coordinador de Marketing Digital y Ecommerce | coordinacion | ⚠️ sin definir | — | — | — |
| Practicante de Diseño Gráfico y Marca | practicante | ⚠️ sin definir | — | — | — |
| Practicante de Producción Audiovisual | practicante | ⚠️ sin definir | — | — | — |
| Trade Marketing | operativo | ⚠️ sin definir | — | — | — |
| Auxiliar de Mercadotecnia de Zona | operativo | marketing | — | 4 | marketing (2), administrativo (2), analisis_ventas (2), etiquetas_anaquel (1), piso_tienda (1) |
| Ejecutivo de Trade Marketing | operativo | ⚠️ sin definir | — | — | — |

### Recursos Humanos · alcance natural: `red`

| Puesto | Nivel | Rol propuesto | Complementos | Personas | Roles reales (personas) |
|---|---|---|---|---|---|
| Jefatura de Capital Humano | jefatura | ⚠️ sin definir | — | — | — |
| Reclutamiento y Onboarding | operativo | ⚠️ sin definir | — | — | — |
| Practicante de Atracción de Talento y Selección | practicante | ⚠️ sin definir | — | — | — |
| Servicios al Personal | operativo | ⚠️ sin definir | — | 1 | administrativo (1) |
| Practicante de Control Documental de RH | practicante | ⚠️ sin definir | — | — | — |

### Sistemas · alcance natural: `red`

| Puesto | Nivel | Rol propuesto | Complementos | Personas | Roles reales (personas) |
|---|---|---|---|---|---|
| Jefatura de Sistemas y Transformación Digital | jefatura | superadmin | — | 3 | superadmin (3) |
| Full Stack Developer | operativo | ⚠️ sin definir | — | 1 | superadmin (1) |
| Infraestructura y Seguridad | operativo | ⚠️ sin definir | — | — | — |

### ⚠️ Personas activas sin puesto: 16

| Rol | Personas |
|---|---|
| etiquetas_anaquel | 8 |
| customer_b2b | 3 |
| checador_kiosco | 2 |
| verificador_precios | 2 |
| servicio | 1 |

## 3. Roles (lo que de verdad concede)

| Rol | Permisos | Personas (principal) | Personas (complemento) | Alcance (`role_scopes`) | Puestos que lo proponen |
|---|---|---|---|---|---|
| `administrativo` | 3 | 5 | 2 | brand:none/esc:none, customer:none/esc:none, expense_area:none/esc:none, route:none/esc:none, warehouse:all/esc:none, zone:all/esc:none | Auxiliar Administrativo de Zona |
| `almacenista` | 14 | 6 | 1 | brand:all, customer:all, expense_area:none, route:all, warehouse:all, warehouse:own, zone:own | Surtidor de Zona, Almacenista de Sucursal, Bodeguero de Sucursal, Auxiliar Administrativo de Logística |
| `analisis_ventas` | 5 | 0 | 5 | brand:all, customer:all, expense_area:none, route:all, warehouse:all, zone:own | Auxiliar Administrativo de Zona |
| `auditor_externo` | 24 | 0 | 1 | brand:all/esc:none, customer:all/esc:none, expense_area:all/esc:none, route:all/esc:none, warehouse:all/esc:none, zone:all/esc:none | — |
| `auxiliar_compras` | 38 | 5 | 2 | brand:all, customer:all, expense_area:none, route:all, warehouse:all, zone:all | Analista de Órdenes de Entrada |
| `auxiliar_tienda` | 25 | 5 | 1 | brand:all, customer:all, expense_area:none, route:all, warehouse:own, zone:own | Auxiliar de Encargado |
| `cajero` | 7 | 19 | 2 | brand:all, customer:all, expense_area:none, route:all, warehouse:own, zone:own | Caja General, Cajero(a) de Sucursal, Coordinador de Cajas, Cajero Vecinal |
| `checador` | 3 | 0 | 0 | brand:none, customer:none, expense_area:none, route:none, warehouse:own, zone:own | Checador CEDIS, Checador de Pedidos |
| `checador_kiosco` | 1 | 2 | 2 | brand:none, customer:none, expense_area:none, route:none, warehouse:own, zone:own | — |
| `compras` | 64 | 2 | 1 | brand:all, customer:all, expense_area:none, route:all, warehouse:all, zone:all | Comprador |
| `compras_operaciones` | 35 | 1 | 1 | brand:all, customer:all, expense_area:none, route:all, warehouse:all, zone:all | Coordinador de Operaciones de Zona |
| `contabilidad` | 40 | 4 | 1 | brand:all, customer:all, expense_area:none, route:all, warehouse:all, zone:all | Analista Contable |
| `coordinador_embarques` | 6 | 1 | 0 | brand:all, customer:all, expense_area:none, route:all, warehouse:own, zone:own | Embarques |
| `credito_cobranza` | 74 | 2 | 1 | brand:all, customer:all, expense_area:none, route:all, warehouse:all, zone:all | Crédito y Cobranza |
| `customer_b2b` | 9 | 3 | 1 | brand:all, customer:own, expense_area:none, route:all, warehouse:none, zone:none | — |
| `direccion` | 123 | 2 | 1 | brand:all/esc:none, customer:all/esc:none, expense_area:all/esc:none, route:all/esc:none, warehouse:all/esc:none, zone:all/esc:none | Dirección General |
| `encargado_bodega` | 5 | 1 | 1 | warehouse:listed | — |
| `encargado_tienda` | 93 | 7 | 2 | brand:all, customer:all, expense_area:none, route:all, warehouse:own, zone:own | Encargado(a) de Sucursal |
| `etiquetas_anaquel` | 2 | 8 | 3 | brand:none, customer:none, expense_area:none, route:none, warehouse:own, zone:own | — |
| `facturacion` | 9 | 1 | 0 | brand:all, customer:all, expense_area:none, route:all, warehouse:own, zone:own | Facturación, Facturación CEDIS |
| `finanzas` | 92 | 1 | 2 | brand:all, customer:all, expense_area:none, route:all, warehouse:all, zone:all | Gerencia Administrativa y Financiera |
| `finanzas_operativo` | 19 | 7 | 0 | brand:all, customer:all, expense_area:none, route:all, warehouse:all, zone:all | Auxiliar de finanzas |
| `gerente_compras` | 127 | 2 | 1 | brand:all, customer:all, expense_area:none, route:all, warehouse:all, zone:all | Coordinación de Compras |
| `jefe_marketing` | 53 | 1 | 1 | brand:all, customer:all, expense_area:none, route:all, warehouse:all, zone:all | Jefe de Marketing |
| `marketing` | 129 | 2 | 1 | brand:all, customer:all, expense_area:none, route:all, warehouse:all, zone:all | Auxiliar de Mercadotecnia de Zona |
| `piso_tienda` | 19 | 1 | 2 | brand:none/esc:none, customer:none/esc:none, expense_area:none/esc:none, route:none/esc:none, warehouse:own/esc:none, zone:own/esc:none | Empaque, Promotora, Anaquelista de Sucursal, Vendedora de Piso |
| `prevencion` | 18 | 1 | 1 | brand:all, customer:all, expense_area:none, route:all, warehouse:all, zone:all | Coordinación de Auditoría Operativa y Prevención de Pérdidas |
| `prevencion_auxiliar` | 17 | 2 | 1 | brand:all, customer:all, expense_area:none, route:all, warehouse:all, zone:all | Auxiliar de Auditoría y Prevención |
| `promotor_ruta` | 22 | 17 | 3 | brand:all, customer:all, expense_area:none, route:all, warehouse:own, zone:own | — |
| `recursos_humanos` | 15 | 0 | 1 | brand:none, customer:none, expense_area:none, route:all, warehouse:all, zone:all | — |
| `repartidor` | 31 | 1 | 1 | brand:all, customer:all, expense_area:none, route:all, warehouse:all, zone:own | Repartidor |
| `servicio` | 0 | 1 | 1 | brand:none/esc:none, customer:none/esc:none, expense_area:none/esc:none, route:none/esc:none, warehouse:none/esc:none, zone:none/esc:none | — |
| `superadmin` | TODOS (god-mode) | 8 | 6 | — (default) | Jefatura de Sistemas y Transformación Digital |
| `supervisor` | 38 | 1 | 2 | brand:all, customer:all, expense_area:none, route:all, warehouse:own, zone:own | Supervisor de inventarios |
| `supervisor_ventas` | 33 | 5 | 1 | brand:all, customer:all, expense_area:none, route:all, warehouse:own, zone:own | Gerencia de Zona, Supervisor de Ventas Ruta Directa, Supervisor de Ventas Vecinal |
| `surtidor` | 4 | 2 | 0 | brand:none, customer:none, expense_area:none, route:none, warehouse:own, zone:own | Surtidor de Sucursal |
| `telemarketing` | 43 | 4 | 2 | brand:all, customer:all, expense_area:none, route:all, warehouse:own, zone:own | Coordinador de Telemarketing |
| `tesoreria` | 47 | 1 | 1 | brand:all, customer:all, expense_area:all, route:all, warehouse:all, zone:all | Jefe de Tesorería |
| `vendedor_ruta` | 30 | 19 | 1 | brand:all, customer:all, expense_area:none, route:all, warehouse:own, zone:own | Vendedor Ruta Directa, Vendedor Suplente, Vendedor Vecinal |
| `vendedor_telemarketing` | 11 | 3 | 0 | brand:all, customer:all, expense_area:none, route:all, warehouse:own, zone:own | Vendedor de Telemarketing |
| `verificador_precios` | 4 | 3 | 1 | brand:none, customer:none, expense_area:none, route:none, warehouse:own, zone:own | — |

## 4. Matriz rol × módulo, por proyecto

**G** = gestiona (tiene al menos una acción del módulo) · **V** = sólo ve · vacío = sin acceso.
`superadmin` se omite (lo tiene todo). Sólo aparecen los roles con algún acceso al proyecto.

### App: Plataforma Web

#### Configuración de la suite · `/admin`

| Rol | Personas | Puestos | Responsabilidades | Roles y permisos |
|---|---|---|---|---|
| `direccion` | V | V | V | V |
| `encargado_tienda` | V | V | V | V |
| `jefe_marketing` | V | V | V |  |
| `recursos_humanos` | G | G | G | V |
| `supervisor_ventas` | V | V | V |  |

#### Venta al detalle · `/dashboard`

| Rol | Captura y visitas | Reportes operativos | Seguimiento en ruta | Análisis de rutas | Mapa comercial y prospección | Supervisor AI (Horus) | Tiendas | Catálogos de captura | Scoring | Planogramas | Agenda de rutas | Salud de la plataforma | Áreas de gasto | Promotores de marca |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `direccion` | V | V | V | V | V | V | V |  | V |  | V |  |  |  |
| `encargado_tienda` | V |  |  |  |  |  | G |  |  |  | V |  |  |  |
| `gerente_compras` | G | G |  |  |  |  |  |  |  |  |  |  |  |  |
| `jefe_marketing` | V | G | V | V | V | V | G | G | G | G | G |  |  |  |
| `marketing` | G | G |  |  |  |  | G |  |  |  |  |  |  |  |
| `promotor_ruta` | G | V | V |  |  |  | G |  | V |  |  |  |  |  |
| `recursos_humanos` |  |  |  |  |  |  |  |  |  |  |  | V | G | G |
| `supervisor_ventas` | G | G | V | V | V |  | G | G | V |  | G |  |  |  |
| `vendedor_ruta` | G | V |  |  |  |  | G |  | V |  |  |  |  |  |

#### Comercial / Ventas · `/comercial`

| Rol | Pedidos | Analítica comercial | Rentabilidad | Sell-Out por empresa | Análisis (Sell-Out BI) | Salidas por producto | Ventas por ruta | Comisiones de ruta | Rentabilidad de Ruta Directa | Facturación de Telemarketing | Tickets de venta | Clientes 360 | Histórico de venta | Clientes | Cartera / asignación | Precios | Experimentos de precio | Motor de margen | Ventas de vendedor | Thot / IA comercial | Inteligencia (hallazgos / acciones / autonomía) | Control de ruta / tickets | Carga al camión |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `analisis_ventas` |  |  |  | V | V | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `auxiliar_compras` |  |  |  |  |  | V |  |  |  |  |  |  | V |  |  |  |  |  |  |  |  |  |  |
| `compras` |  | V | V | V | G | V | V |  |  |  |  | V | V |  |  |  |  | V |  |  |  |  |  |
| `compras_operaciones` |  |  |  | V | V | V | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `contabilidad` |  |  |  |  |  |  |  | V | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `credito_cobranza` | G | V | V | V | G | V | V |  |  | V | V | V | V | G | G | G |  |  |  | G | V |  | G |
| `customer_b2b` | G |  |  |  |  |  |  |  |  |  |  |  |  | V |  | V |  |  |  |  |  |  |  |
| `direccion` | V | V | V | V | G | V | V | G | V | V | V | V | V | V | V | V | G | V | V | V | V | V | V |
| `encargado_tienda` | G |  |  | V | V |  |  |  |  | V | V |  |  | G | V |  |  |  |  |  | V | V | G |
| `facturacion` | V |  |  |  |  |  |  |  |  | V |  |  |  | V | V |  |  |  |  |  |  |  |  |
| `finanzas` |  | V | V | V | G | V | V | G | V |  |  | V | V |  |  |  |  | V |  |  |  |  |  |
| `gerente_compras` | G | V | V | V | G | V |  |  |  | V | V |  |  | G | G | G | G | V |  | G | V | G | G |
| `jefe_marketing` | V | V | V | V | G | V | V |  |  | V | V | V | V | V | G | V | V | V |  |  | V |  | V |
| `marketing` | G | V | V | V | G | V | V |  |  | V | V |  | V | G | V | G | G | V | V | G | V | G | G |
| `promotor_ruta` | G |  |  |  |  |  |  |  |  |  |  |  |  | V | V | V |  |  |  |  | V |  |  |
| `repartidor` | G | V | V | V | G | V | V |  |  | V | V | V | V | V | V | V |  |  |  |  | V | G | G |
| `supervisor_ventas` | G |  |  |  |  |  |  |  |  | V | V |  |  |  | V |  |  |  |  |  | V |  |  |
| `telemarketing` | G | V | V | V | G | V | V |  |  | V | V | V | V | G | G | G | V |  |  | G | V |  | G |
| `vendedor_ruta` | G |  |  |  |  |  |  |  |  | V | V |  |  | G | G | V |  |  |  | G | V | G | G |
| `vendedor_telemarketing` | G |  |  |  |  |  |  |  |  | V |  |  |  | V |  | V |  |  |  |  |  |  |  |

#### MKT · `/mkt`

| Rol | Promociones | Promos del ERP | Acuerdos con proveedor |
|---|---|---|---|
| `auxiliar_compras` |  |  | V |
| `auxiliar_tienda` |  |  | V |
| `cajero` |  |  | V |
| `credito_cobranza` | G | V | V |
| `customer_b2b` | V |  |  |
| `direccion` | V | V | V |
| `encargado_tienda` |  |  | V |
| `jefe_marketing` | G | V | G |
| `marketing` | G |  | G |
| `piso_tienda` |  |  | V |
| `supervisor` |  |  | V |
| `telemarketing` | G | V | V |
| `verificador_precios` |  |  | V |

#### Almacén · `/almacen`

| Rol | Existencia | Ajustes de stock | Almacenes | Inventario físico | Recepción (caducidad) | Prevención de inventarios | Control de Caducidades | Stock muerto | Salud de inventario | Diario de movimientos | Pedidos | Guías de carga (preventa) | Llegadas al andén | Ubicaciones | Checar pedidos | Consola de surtido | Análisis BI | Autoabasto | Nivelación de inventarios | Catálogo interno (mostrador) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `administrativo` |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | G |
| `almacenista` |  | V |  | G | G |  |  |  |  |  | V |  |  | G | G |  | V | V |  |  |
| `auxiliar_compras` | G |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | G |  |  |
| `auxiliar_tienda` |  |  |  |  |  |  |  |  |  |  | V | G |  | G |  |  |  |  |  |  |
| `cajero` |  |  |  |  |  |  |  |  |  |  |  | G |  |  |  |  |  |  |  |  |
| `checador` |  |  |  |  |  |  |  |  |  |  |  |  |  | V | G |  |  |  |  |  |
| `compras` | G | G | G | G | G |  |  | V | V | G | V |  |  | V |  |  | V | G |  |  |
| `compras_operaciones` | G |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | G |  |  |
| `coordinador_embarques` |  |  |  |  |  |  |  |  |  |  | V |  |  | V |  | G |  |  |  |  |
| `credito_cobranza` |  |  |  |  |  |  |  | V | V |  |  |  |  |  |  |  |  |  |  |  |
| `customer_b2b` |  | V | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `direccion` | V | V | V |  |  | V | V | V | V | V | V |  |  | V |  |  | V | G |  |  |
| `encargado_bodega` |  |  |  |  |  |  |  |  |  |  | V |  |  | G |  |  |  |  |  |  |
| `encargado_tienda` | G | G | G | G |  |  | G |  |  | V | V | G |  | G |  | G | V | G |  |  |
| `facturacion` |  |  |  |  |  |  |  |  |  |  | V |  |  | V |  |  |  |  |  |  |
| `finanzas` | G |  |  |  |  |  |  | V | V |  |  |  |  |  |  |  |  | G |  |  |
| `gerente_compras` | G | G | G | G | G |  |  |  |  | G | V |  |  | V |  |  | V | G |  |  |
| `jefe_marketing` |  |  | G |  |  |  |  | V | V |  |  |  |  |  |  |  |  |  |  |  |
| `marketing` | G | G | G | G | G |  |  |  |  | G | V |  |  |  |  |  | V | G |  |  |
| `piso_tienda` |  |  |  |  |  |  | G |  |  |  |  | G |  | G |  |  |  |  |  | G |
| `prevencion` | V | V | V |  |  | G |  |  |  | G | V |  |  | V |  |  | V | V |  |  |
| `prevencion_auxiliar` | V | V | G |  |  | V |  |  |  | G | V |  |  | V |  |  | V | V |  |  |
| `promotor_ruta` |  |  | V |  |  |  | G |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `repartidor` |  |  |  |  |  |  |  | V | V |  |  |  |  |  |  |  |  |  |  |  |
| `supervisor` | G | G | G | G | G |  |  | V | V | G | V |  |  | G |  | G | V | G |  |  |
| `surtidor` |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |  |
| `telemarketing` |  |  |  |  |  |  |  | V | V |  | V |  |  | V |  |  |  |  |  |  |
| `tesoreria` | G |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | G |  |  |
| `vendedor_ruta` |  |  | G |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

#### Logística · `/logistica`

| Rol | Embarques | Guías | Flotilla y personal | Gasto de flota (RD) | Costos | Liquidaciones / nómina | Carta Porte | Traspasos | Configuración |
|---|---|---|---|---|---|---|---|---|---|
| `coordinador_embarques` | V |  |  |  |  |  |  |  |  |
| `direccion` | V | V | V | V | V | V | V | V |  |
| `encargado_tienda` |  |  |  |  | V |  |  |  |  |
| `finanzas` | G | G | G | G | G |  | G | V | G |
| `jefe_marketing` |  |  |  |  |  |  |  | V |  |
| `marketing` |  |  |  |  |  |  |  | V |  |
| `repartidor` | V | G |  |  |  |  |  | V |  |

#### Punto de Venta · `/tienda`

| Rol | Tienda en Vivo | Etiquetas de anaquel | Arqueo ciego de caja | Control de Caducidades | Análisis de ventas | Verificador de precios | Lista de faltantes | Retiros en caja | Checador de asistencia (kiosco) |
|---|---|---|---|---|---|---|---|---|---|
| `auditor_externo` |  |  |  |  |  |  |  | V |  |
| `auxiliar_compras` |  | V |  |  |  | V | G |  |  |
| `auxiliar_tienda` | V | V | G |  | V | V | G | G |  |
| `cajero` |  |  | G |  |  |  | G |  |  |
| `checador_kiosco` |  |  |  |  |  |  |  |  | G |
| `compras` |  |  |  |  |  |  |  | V |  |
| `direccion` | V | V | V | V | V | V | G | G |  |
| `encargado_tienda` | V | V | G | G | V | V | G | G |  |
| `etiquetas_anaquel` |  | V |  |  |  |  |  |  |  |
| `facturacion` |  |  |  |  |  | V |  |  |  |
| `gerente_compras` |  |  |  |  |  |  |  | V |  |
| `marketing` |  |  |  |  |  |  |  | V |  |
| `piso_tienda` | V | V | G | G | V | V | G | G |  |
| `prevencion` |  |  |  |  |  |  |  | V |  |
| `prevencion_auxiliar` |  |  |  |  |  |  |  | V |  |
| `promotor_ruta` |  |  |  | G |  |  |  |  |  |
| `supervisor` |  | V |  |  |  | V | G | V |  |
| `verificador_precios` |  |  |  |  |  | V | G |  |  |

#### Telemarketing · `/telemarketing`

| Rol | Telemarketing | Cotizaciones |
|---|---|---|
| `direccion` | V | V |
| `supervisor` |  | G |
| `supervisor_ventas` |  | G |
| `telemarketing` | G | G |
| `vendedor_telemarketing` | G | G |

#### Compras / Reabastecimiento · `/compras`

| Rol | Existencia | Pedido | Red de abasto | Requisiciones | Órdenes de compra | Abiertas en Kepler | Órdenes de entrada | Costo por compra | Costo por proveedor | Costo estándar | Descuentos y apoyos | Hallazgos | Reclamos de recepción | Faltantes de piso | Proveedores | Categorías | Catálogo | Obligaciones a proveedor | Cuentas de pago a proveedor |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `auxiliar_compras` | G | G | G | G | G | V | G | V | V | V | G | G | G | G | G | G | V | G | G |
| `auxiliar_tienda` |  |  |  |  |  |  | G | V |  |  |  |  |  |  |  |  |  |  |  |
| `compras` | G | G | G | G | G | V | G | V | V | V | G | G | G | G | G | G | V | G | G |
| `compras_operaciones` | G | G | G | G | G | V | G | V | V | V | G | G | G | G | G | G | V | G | G |
| `credito_cobranza` |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | G |  |  |
| `direccion` | V | V | V | V | V | V | V | V | V | V | V | V | V | V | V | V | V | G | V |
| `encargado_tienda` | G | G | G | G | G | V | G | V | V | V | G | G | G | G | G | G |  | V | V |
| `facturacion` |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |
| `finanzas` | G | G | G | G | G | V | G | V | V | V | G | G | G | G | G | G |  |  |  |
| `gerente_compras` | G | G | G | G | G | V | G | V | V | V | G | G | G | G | G | G | G | G | G |
| `jefe_marketing` |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | G |  |  |
| `marketing` | G | G | G | G | G | V | G | V | V | V | G | G | G | G | G | G | G |  |  |
| `prevencion` | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `prevencion_auxiliar` | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `supervisor` | G |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `telemarketing` |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | G |  |  |
| `tesoreria` | G | G | G | G | G | V | G | V | V | V | G | G | G | G | G | G |  |  |  |

#### Finanzas · `/finanzas`

| Rol | Bancos (conciliación) | Cobranza (comprobantes) | Crédito de clientes | Pagos a proveedor (comprobantes) | Estado de cuenta de acreedores | Caja General | Caja Fuerte (CAOS) | Cuadre / Supervisor de movimientos | Calendario de pagos | Tareas de conciliación | Egresos contables | Ingresos contables | Cortes / Sucursales | Gastos (solicitudes, captura y evidencia) | Hallazgos | Pregúntale a Maat |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `analisis_ventas` |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |
| `auditor_externo` | V | V | V | V | V | V | V | V | V | V | V | V | V | V |  |  |
| `auxiliar_compras` |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |
| `auxiliar_tienda` |  |  |  |  |  |  |  |  |  |  |  |  | V | V |  |  |
| `cajero` |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |
| `compras` |  |  |  |  |  |  |  | G |  |  |  |  |  |  |  |  |
| `compras_operaciones` |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |
| `contabilidad` | G | G | V | G | V | G | V |  | G | G | V | V | V | G | G | G |
| `credito_cobranza` | G | G | V | G | V | G | V |  | G | G | V | V | V | G | G | G |
| `direccion` | V | V | V | V | V | G | V | V | G | V | V | V | V | V |  |  |
| `encargado_tienda` |  |  |  |  |  |  |  | V |  |  |  |  | V | V |  |  |
| `finanzas` | G | G | V | G | V | G | V |  | G | G | V | V | V | G | G | G |
| `finanzas_operativo` | G | G | V | G | V | G | V |  | G | G | V | V | V | G | G | G |
| `gerente_compras` | G | G | V | G | V | G | V | G | G | G | V | V | V | G | G | G |
| `jefe_marketing` |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |
| `marketing` | G | G | V | G | V | G | V | G | G | G | V | V | V | G | G | G |
| `prevencion` |  |  |  |  |  |  |  | G |  |  |  |  |  | V |  |  |
| `prevencion_auxiliar` |  |  |  |  |  |  |  | G |  |  |  |  |  |  |  |  |
| `promotor_ruta` |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |
| `supervisor` |  |  |  |  |  |  |  | G |  |  |  |  |  |  |  |  |
| `supervisor_ventas` |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |
| `tesoreria` | G | G | V | G | V | G | V |  | G | G | V | V | V | G | G | G |

#### Presupuestos · `/presupuesto`

| Rol | Presupuesto | Tesorería · diagnóstico |
|---|---|---|
| `direccion` | G | V |
| `finanzas` | V | V |

#### Contabilidad · `/contabilidad`

| Rol | Listas SAT (EFOS 69-B / Art. 69) | CFDI | Libro de Compras (no asociados → TXT a ContPAQi) | Facturación (emisión CFDI) | Conciliación fiscal | DIOT / IVA | Descarga masiva CFDI | Expediente de materialidad | Contabilidad electrónica | Impuestos provisionales | Credenciales SAT (e.firma) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `auditor_externo` | V | V | V | V | V | V | V | V | V | V |  |
| `contabilidad` | G | V | G | G | V | V | G | G | G | V | G |
| `credito_cobranza` | G | V | G | G | V | V | G | G | G | V | G |
| `direccion` | V | V | V | V | V | V | V | V | V | V |  |
| `finanzas` | G | V | G | G | V | V | G | G | G | V | G |
| `gerente_compras` | G | V | G | G | V | V | G | G | G | V | G |
| `marketing` | G | V | G | G | V | V | G | G | G | V | G |

#### Reparto / Última Milla · `/reparto`

| Rol | Despacho (tienda) | Entrega (repartidor) | Surtido |
|---|---|---|---|
| `almacenista` |  |  | G |
| `auxiliar_tienda` | V |  |  |
| `compras` |  |  | G |
| `coordinador_embarques` |  |  | V |
| `direccion` |  |  | V |
| `encargado_tienda` | V |  | G |
| `gerente_compras` |  |  | G |
| `marketing` |  |  | G |
| `prevencion` |  |  | V |
| `prevencion_auxiliar` |  |  | V |
| `repartidor` |  | V |  |
| `supervisor` |  |  | G |
| `surtidor` |  |  | G |

#### WhatsApp (bot)

| Rol | Bot conversacional |
|---|---|
| `auxiliar_tienda` | G |
| `direccion` | V |
| `encargado_tienda` | G |

#### Desarrolladores · `/desarrolladores`

_Ningún rol (salvo superadmin) tiene acceso._

#### Personal · `/rh`

| Rol | Asistencia | Incidencias y cierre semanal | Relojes checadores |
|---|---|---|---|
| `contabilidad` |  | V |  |
| `recursos_humanos` | G | G | G |

#### Mesa de Servicio · `/servicio`

| Rol | Reportar un problema | Atención de solicitudes | Coordinación y configuración | Reportes de la mesa |
|---|---|---|---|---|
| `administrativo` | V |  |  |  |
| `almacenista` | V |  |  |  |
| `analisis_ventas` | V |  |  |  |
| `auditor_externo` | V |  |  |  |
| `auxiliar_compras` | V |  |  |  |
| `auxiliar_tienda` | V |  |  |  |
| `cajero` | V |  |  |  |
| `checador` | V |  |  |  |
| `compras` | V |  |  |  |
| `compras_operaciones` | V |  |  |  |
| `contabilidad` | V |  |  |  |
| `coordinador_embarques` | V |  |  |  |
| `credito_cobranza` | V |  |  |  |
| `direccion` | V |  |  |  |
| `encargado_bodega` | V |  |  |  |
| `encargado_tienda` | V |  |  |  |
| `etiquetas_anaquel` | V |  |  |  |
| `facturacion` | V |  |  |  |
| `finanzas` | V |  |  |  |
| `finanzas_operativo` | V |  |  |  |
| `gerente_compras` | V |  |  |  |
| `jefe_marketing` | V |  |  |  |
| `marketing` | V |  |  |  |
| `piso_tienda` | V |  |  |  |
| `prevencion` | V |  |  |  |
| `prevencion_auxiliar` | V |  |  |  |
| `promotor_ruta` | V |  |  |  |
| `recursos_humanos` | V |  |  |  |
| `repartidor` | V |  |  |  |
| `supervisor` | V |  |  |  |
| `supervisor_ventas` | V |  |  |  |
| `surtidor` | V |  |  |  |
| `telemarketing` | V |  |  |  |
| `tesoreria` | V |  |  |  |
| `vendedor_ruta` | V |  |  |  |
| `vendedor_telemarketing` | V |  |  |  |

### App: App Vendedor

Acceso único `VENDOR_APP_ACCESS` → `marketing`, `promotor_ruta`, `repartidor`, `supervisor_ventas`, `vendedor_ruta`

### App: Portal B2B

Acceso único `PORTAL_B2B_ACCESS` → `customer_b2b`

## 5. Restricciones y separación de funciones

### 5.1 Reglas que todo módulo debe respetar

1. **Quien prepara no autoriza.** Las acciones de control (`*_AUTORIZAR`, `*_VALIDAR`, `*_APROBAR`)
   son una clave aparte del `_GESTIONAR` y se reparten a pocos roles. Ej.: Calendario de Pagos —
   `FINANCE_PAYMENTS_GESTIONAR` prepara, `FINANCE_PAYMENT_CALENDAR_AUTORIZAR` libera (fuera de todo
   grupo de plantilla para que nadie lo reciba "de paquete"). Ej.: Entradas — `COMPRAS_ENTRADAS_GESTIONAR`
   ≠ `COMPRAS_ENTRADAS_VALIDAR`.
2. **Quien audita no opera lo que audita.** Prevención/auditor externo reciben los módulos ajenos en
   **sólo-VER**.
3. **Conteo ciego.** Quien cuenta inventario (`almacenista`) tiene `COMMERCIAL_INVENTORY_CONTAR` pero **no**
   `_SUPERVISAR`: ese endpoint devuelve el teórico y rompería el conteo.
4. **El permiso abre, el alcance filtra.** La tienda ve sólo su sucursal vía `role_scopes`
   (`warehouse = own`), no con un permiso `_VER_ALL`.
5. **Externos encerrados.** `customer_b2b` sólo entra al Portal; `auditor_externo` tiene vencimiento
   (`users.expires_at`) y `mode_write = none`.
6. **Un permiso declarado no está entregado** hasta que una migración lo **reparte** en prod
   (lección LC.6.2: módulo en prod que nadie podía abrir).
7. **No pisar un `false` explícito** al repartir: es una decisión de alguien en `/admin/roles`.
8. **Claves a todos sin destino** (`SERVICIO_REPORTAR`): se reparten a todos pero no abren un
   espacio, o rompen la auto-entrada de `/projects`.

### 5.2 Permisos sensibles: quién los tiene hoy

| Permiso | Qué hace | Roles que lo tienen (sin superadmin) |
|---|---|---|
| `AUTOABASTO_AUTORIZAR` | Autorizar abasto (dentro del tope) | `auxiliar_compras`, `compras`, `compras_operaciones`, `direccion`, `encargado_tienda`, `finanzas`, `gerente_compras`, `marketing`, `tesoreria` |
| `COMMERCIAL_INVENTORY_RECONCILIAR` | Reconciliar inventario físico | `compras`, `gerente_compras`, `supervisor` |
| `COMMERCIAL_INVENTORY_SUPERVISAR` | Supervisar inventario físico | `compras`, `gerente_compras`, `marketing`, `supervisor` |
| `COMMERCIAL_PAYMENTS_REVERSAR` | Reversar Cobros | `credito_cobranza`, `encargado_tienda`, `gerente_compras`, `marketing` |
| `COMPRAS_ENTRADAS_VALIDAR` | Validar Órdenes de entrada | `auxiliar_compras`, `compras`, `compras_operaciones`, `encargado_tienda`, `finanzas`, `gerente_compras`, `tesoreria` |
| `COMPRAS_PLAZOS_AUTORIZAR` | Autorizar plazos de pago a proveedor | `compras`, `direccion`, `gerente_compras` |
| `COMPRAS_REQUISICIONES_AUTORIZAR` | Autorizar Requisiciones | **nadie** |
| `FINANCE_CAJA_AUTORIZAR` | Autorizar corte de Caja General | `direccion` |
| `FINANCE_PAYMENT_CALENDAR_AUTORIZAR` | Autorizar Calendario de Pagos | `direccion` |
| `PRESUPUESTOS_APROBAR` | Aprobar Presupuestos | `direccion` |
| `ROLES_CONFIGURAR` | Configurar Roles y Funciones | **nadie** |
| `SUPERVISOR_AI_APROBAR` | Aprobar acciones del Supervisor AI | **nadie** |
| `USUARIOS_GESTIONAR` | Gestionar Usuarios | `recursos_humanos` |
| `USUARIOS_PASSWORDS` | Resetear Contraseñas | `recursos_humanos` |

### 5.3 Huecos medidos

- **Puestos sin rol propuesto:** 49 de 95 (46 puestos tienen gente).
  Mientras `default_role` esté vacío, dar de alta a alguien en ese puesto **no le propone nada**.
- **Personas cuyo rol no es el que propone su puesto:** 39.
- **Personas activas sin puesto:** 16.
- **Roles sin ninguna persona (ni principal ni complemento):** `checador`.
- **Ajustes por persona (`user_permissions`):** 36 que agregan, 238 que quitan.
  Cada uno es una excepción que no se ve en la matriz de roles.

- **Permisos que ningún rol tiene (sólo superadmin):** 13. Si el módulo ya está en prod, nadie más lo puede abrir:

| Permiso | Qué hace |
|---|---|
| `ALMACEN_LLEGADAS_VER` | Ver llegadas al andén (Almacén) |
| `COMMERCIAL_MAP_PROSPECTS_GESTIONAR` | Gestionar Prospección |
| `COMPRAS_REQUISICIONES_AUTORIZAR` | Autorizar Requisiciones |
| `DEV_PROJECTS_GESTIONAR` | Dar de alta y editar proyectos de desarrollo |
| `DEV_PROJECTS_VER` | Ver proyectos de desarrollo |
| `FINANCE_EXPENSES_HISTORIAL_TODOS` | Ver el historial de gastos de TODOS |
| `LOGISTICS_PAYROLL_GESTIONAR` | Gestionar Liquidaciones |
| `NIVELACION_GESTIONAR` | Gestionar traspasos |
| `NIVELACION_VER` | Ver Nivelación de inventarios |
| `ROLES_CONFIGURAR` | Configurar Roles y Funciones |
| `SERVICIO_ATENDER` | Atender solicitudes de servicio |
| `SERVICIO_COORDINAR` | Coordinar la Mesa de Servicio |
| `SUPERVISOR_AI_APROBAR` | Aprobar acciones del Supervisor AI |

- **Módulos a los que sólo entra superadmin:** Almacén › Llegadas al andén · Almacén › Nivelación de inventarios · Desarrolladores › Proyectos · Mesa de Servicio › Atención de solicitudes · Mesa de Servicio › Coordinación y configuración · Mesa de Servicio › Reportes de la mesa


## 6. Checklist para un módulo nuevo

1. **Decidir el acceso con esta matriz:** qué puestos lo usan → qué roles (§2/§3) → quién VE, quién
   GESTIONA y si hay una acción de control que deba ir aparte (§5.1 regla 1).
2. **Clave en el enum** `libs/contracts/src/authz/permissions.ts`: `<MODULO>_VER` + `<MODULO>_GESTIONAR`
   (+ `_AUTORIZAR`/`_VALIDAR` si aplica). Nombre en inglés snake_case mayúscula.
3. **Etiqueta** en `permission-meta.ts` (si no, sale la clave cruda en "Otros").
4. **Ubicarlo en `authz-tree.ts`** (proyecto → módulo con `route`, `view`/`manage`). Sin esto no se
   puede otorgar desde `/admin/roles` y falla `database/tests/test-authz-route-coverage.js`.
5. **Proyecto nuevo** → darle casa en `suite-map.ts` (o falla `suite-map.spec.ts`).
6. **Backend:** `@RequirePermissions(...)` en **toda** ruta de escritura (sin decorador queda abierta a
   cualquier autenticado).
7. **Frontend:** `permissionGuard` en la ruta + el ítem de navegación gateado con la misma clave.
8. **Alcance:** si los datos son por sucursal/zona/cliente, filtrar con `ScopeService`; revisar que los
   roles que lo reciben tengan su fila en `identity.role_scopes`.
9. **Migración de reparto** (`database/migrations-newdb/`): idempotente, `SET LOCAL lock_timeout`,
   `permissions -> 'CLAVE' IS NULL` (no el operador `?`), **derivada del estado vivo** (los roles de §3,
   no las plantillas de `role-presets.ts`), sin pisar `false`. Ejemplo:
   `20261005210000_grant_finance_cortes_ver_tienda.js`.
10. **Aplicar en prod + re-login** de los usuarios afectados.
11. **Regenerar esta matriz** (`npm run docs:matriz-accesos`) y commitearla con el módulo.
