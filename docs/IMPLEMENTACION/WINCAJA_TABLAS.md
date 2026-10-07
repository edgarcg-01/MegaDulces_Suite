# Wincaja — catálogo de tablas (POS Access 97 de Mega Dulces)

> **Inventario tabla por tabla** del POS **Wincaja**, un `.mdb` (Access 97 / Jet 3.5) por sucursal.
> Análogo al de Kepler ([`KEPLER_CATALOGO_TABLAS.md`](KEPLER_CATALOGO_TABLAS.md) / [`KEPLER_TABLAS_COMPLETO.md`](KEPLER_TABLAS_COMPLETO.md)).
> Ingesta y arquitectura: [`FASES/FASE_W_WINCAJA.md`](FASES/FASE_W_WINCAJA.md) · decisión: **ADR-031** en [`02_DECISIONES_ARQUITECTURA.md`](02_DECISIONES_ARQUITECTURA.md).
> Generado 2026-07-13. Row counts = `COUNT(*)` exacto de la sucursal **30 MORELIA ABASTOS** (dataset `Concentradas`), como referencia; **otras sucursales/datasets varían**.

## Método y ventaja vs Kepler

- A diferencia del schema `md` de Kepler (ofuscado `kdXX`/`cN`), **Wincaja usa nombres claros en español** (`Articulos`, `Clientes`, `MovimientoClientes`…). El mapeo NO se infiere: se lee directo.
- **Lectura:** `Microsoft.Jet.OLEDB.4.0` en proceso **32-bit** (ACE 12/16 rechazan el formato 97), read-only. Ver `database/importers/wincaja/`.
- **70 tablas** por `.mdb`. Este doc las cubre todas. Muchas están **vacías** (features del POS que Mega Dulces no usa: puntos de lealtad, ediciones, inventario físico, vistas configurables).
- **8 sucursales pobladas:** `00 BPIRAPUATO`, `10 PHIDALGO`, `30 MORELIA ABASTOS`, `32 MORELIA MADERO`, `40 8ESQUINAS`, `44 YURECUARO`, `50 CANINDO`, `54 ZAMORA CENTRO`. Dos carpetas: `Actuales` (vivo, período corriente) + `Concentradas` (histórico). En el landing conviven vía `source_dataset`.

## Leyenda de relevancia

✅ **Ingerido** a `wincaja.*` (landing) · 🟢 **Alto valor, integrar** · 🟡 **Medio / a futuro** · ⚪ **Bajo / ignorar** (config, plomería, vacías)

Distribución: **✅ 20** · **🟢 6** · **🟡 12** · **⚪ 32** (70 tablas).

## Modelo de ingesta (landing `wincaja.*`)

Cada tabla ingerida se copia 1:1 a `wincaja.<nombre_snake_case>` con `tenant_id` + `source_branch` (00/10/30/32/40/44/50/54) + `source_dataset` (`actual`|`concentrada`) + `imported_at`. Recarga full por (sucursal, dataset), idempotente. RLS forzado. **Nunca** se mezcla con `commercial.*`/`analytics.*` (Kepler): el cruce se hace en una capa de vistas sobre el crosswalk `wincaja.branches`.

## Resumen por dominio

| Dominio | Tablas | Núcleo |
|---|---:|---|
| Ventas / movimientos de almacén | 4 | `MaestroMovAlmacen` + `DetallesMovAlmacen` (transacción línea a línea) |
| Caja / tesorería | 7 | `PagosDia`, `Arqueos`, `Retiros`, `Cortes`, `Cajas`, `Cajeros`, `Autorizaciones` |
| Cartera / clientes | 3 | `Clientes`, `MovimientoClientes` (AR) |
| Catálogo de productos | 12 | `Articulos`, `Precios`, `Existencias`, `Familias`/`Subfamilias`/`Categorias` |
| Compras / proveedores | 6 | `Proveedores`, `MovimientoProveedores`, `Productos` (costo x proveedor), `OrdenesCompra` |
| Cotizaciones | 4 | `MaestroCotizaciones` + `DetalleCotizaciones` |
| Promos / lealtad / descuentos | 9 | `Ofertas` (resto vacías) |
| Impuestos / monedas / unidades | 6 | `IVA`, `IEPS`, `Monedas`, `Unidades` |
| Inventario físico / ediciones | 6 | (todas vacías en MD) |
| Config / seguridad / vistas / plomería | 13 | `Seguridad`, `Vistas`, `FacturaLibre`… |
| **TOTAL** | **70** | |

---

### Ventas / movimientos de almacén
El corazón transaccional: cada documento (venta, compra, traspaso, ajuste, merma) es un encabezado en `MaestroMovAlmacen` + N líneas en `DetallesMovAlmacen`.

| Tabla | Filas | Cols | Rel. | Qué es | Columnas clave |
|---|---:|---:|:--:|---|---|
| `DetallesMovAlmacen` | 941,434 | 25 | ✅ `detalles_mov_almacen` | Líneas de cada movimiento (ítem por documento). La tabla más grande. | `Consecutivo`=folio interno · `Articulo` · `CantidadRegular` · `ValorCosto` · `ValorVenta` · `IVA`/`IEPS` · `Descuento1..5` · `TipoPrecio` · `Tipo`+`Documento`=tipo de doc |
| `MaestroMovAlmacen` | 108,840 | 22 | ✅ `maestro_mov_almacen` | Encabezado de cada movimiento de almacén/venta | `Consecutivo` · `Tipo`+`Documento`=clase de doc · `Tercero`=cliente/proveedor · `Fecha`/`Hora` · `Almacen` · `Caja`/`Cajero`/`Vendedor` · `Cancelado` |
| `AjusteSN` | 0 | 5 | ⚪ | Ajustes por número de serie (sin uso en MD) | `Articulo`,`NumSerie`,`Almacen` |
| `Operaciones` | 31 | 3 | 🟡 | Bitácora de operaciones del POS (apertura/cierre/procesos) | `Folio`,`Tipo`,`Fecha` |

### Caja / tesorería
Cobros del día, arqueo por denominación, retiros y el corte que amarra todo. Base para conciliación de caja (cruza con Kepler `kdpv_folio_caja` y fase SM).

| Tabla | Filas | Cols | Rel. | Qué es | Columnas clave |
|---|---:|---:|:--:|---|---|
| `PagosDia` | 177,633 | 12 | ✅ `pagos_dia` | Cobros del día por forma de pago (renglón por pago de un ticket) | `Consecutivo` · `Folio`=ticket · `FormaPago` · `Pagado`=monto · `Hora` · `Caja` · `Cobranza`=si aplica a CxC · `Propina` |
| `Retiros` | 20,067 | 11 | ✅ `retiros` | Retiros de efectivo de caja (y dotación inicial) | `Folio` · `Caja` · `Monto` · `Fecha` · `FormaDePago` · `Cajero` · `DotacionInicial` · `PorDiferenciaCorte` |
| `Arqueos` | 4,657 | 5 | ✅ `arqueos` | Conteo físico de caja **por denominación** (billetes/monedas) | `Consecutivo` · `Folio`=corte · `Caja` · `Denominacion` · `Cantidad`=piezas de esa denominación |
| `Autorizaciones` | 3,503 | 6 | 🟢 | Autorizaciones/overrides de supervisor en caja (auditoría/prevención) | `Autorizo` · `Cajero` · `Fecha`/`Hora` · `Referencia` · `Caja` |
| `Cortes` | 769 | 14 | ✅ `cortes` | Corte de caja (amarra rango de folios de retiros/pagos/movimientos) | `Folio` · `caja` · `FechaCorte` · `Cajero` · `FolioInicial/Final Retiro/Pago/Movto` · `Canceladas`/`MontoCanceladas` |
| `Cajeros` | 38 | 5 | 🟢 | Catálogo de cajeros (usuario, nivel, password) | `Cajero` · `Nombre` · `NivelSeguridad` · `cajaactual` |
| `Cajas` | 29 | 22 | 🟡 | Config de cada caja + folios actuales por tipo de documento | `Caja` · `habilitada` · `Estado` · `FolioActual*` (ticket/factura/corte/compras/devolución…) |

### Cartera / clientes
Padrón de clientes con saldo/crédito y el detalle de sus movimientos (facturas, abonos, comisiones).

| Tabla | Filas | Cols | Rel. | Qué es | Columnas clave |
|---|---:|---:|:--:|---|---|
| `MovimientoClientes` | 123,336 | 30 | ✅ `movimiento_clientes` | Movimientos de cuenta por cliente (cargos/abonos, CxC) | `Documento`+`Tipo`=doc · `Tercero`=cliente · `Fecha`/`FechaVencimiento`/`FechaUltimoPago` · `Valor` · `Saldo` · `Vendedor` · `ComisionGenerada`/`Pendiente` |
| `Clientes` | 8,727 | 38 | ✅ `clientes` | Padrón de clientes con saldo, crédito, RFC, territorio, puntos | `Cliente` · `Nombre`/`Razon` · `RFC` · `Vendedor` · `SaldoMN`/`MaximoMN` · `Plazo`/`Credito` · `Territorio` · `Bloqueado` · `PuntosAcumulados` |
| `Credito` | 1 | 3 | ⚪ | Parámetros globales de crédito (intereses/moratorios) | `Tipo`,`Intereses`,`Moratorio` |

### Catálogo de productos
Maestro de artículos, precios por nivel, existencia por almacén, y las jerarquías familia/subfamilia/categoría.

| Tabla | Filas | Cols | Rel. | Qué es | Columnas clave |
|---|---:|---:|:--:|---|---|
| `Precios` | 89,303 | 11 | ✅ `precios` | Precio por artículo y **nivel de precio** (mayoreo/menudeo…) + margen | `Articulo` · `NoPrecio`=nivel · `Precio` · `CantidadAutomatico`=cantidad p/precio auto · `MargenUtilidad` · `ComisionVendedor` |
| `Articulos` | 15,334 | 49 | ✅ `articulos` | Maestro de artículos (rico: unidades, factores, impuestos, venta acumulada) | `Articulo` · `CodigoBarras` · `Subfamilia` · `Nombre` · `Categoria` · `UnidadCompra`/`Venta` · `Factor*` · `IVAVenta`/`IEPSVenta` · `VentaValorAnual` |
| `Existencias` | 15,332 | 23 | ✅ `existencias` | Existencia por almacén (existencia = inicial + entradas − salidas, se calcula en el load) | `Almacen` · `Articulo` · `Ubicacion` · `ExistenciaInicialRegular` · `EntradaRegular`/`SalidaRegular` · `StockMaximo`/`Minimo` · `CostoPromedio`/`UltimoCosto` · `Apartado` |
| `Categorias` | 1,380 | 5 | 🟡 | Catálogo de categorías de artículo (nivel extra a familia/subfamilia) | `Categoria`,`Descripcion` |
| `Familias` | 1,074 | 4 | ✅ `familias` | Familias de producto (nivel 1 de la jerarquía) | `Familia`,`Descripcion` |
| `Subfamilias` | 1,073 | 5 | ✅ `subfamilias` | Subfamilias (nivel 2; FK a `Familia`) | `Subfamilia`,`Descripcion`,`Familia` |
| `ArticulosRelacion` | 2,147 | 3 | 🟡 | Códigos de barras alternos / equivalencias por artículo | `Articulo`,`CodigoBarras`,`CantidadRelacion` |
| `Unidades` | 5 | 3 | 🟡 | Catálogo de unidades de medida | `Unidad`,`Pesable`,`Fraccionaria` |
| `Compuestos` | 0 | 5 | ⚪ | Recetas/kits (artículo padre → hijos). Sin uso en MD | `ArticuloPadre`,`ArticuloHijo`,`Cantidad` |
| `Comodines` | 0 | 2 | ⚪ | Artículos comodín. Vacía | `Clave`,`Descripcion` |
| `Series` / `MovNumSeries` | 0 | 4/3 | ⚪ | Números de serie por artículo. Sin uso | `Articulo`,`NumSerie` |
| `Almacenes` | 1 | 3 | 🟡 | Catálogo de almacenes de la sucursal | `Almacen`,`Descripcion`,`FechaExistenciaInicial` |

### Compras / proveedores
Padrón de proveedores, su cuenta (AP), el costo por proveedor-artículo y órdenes de compra.

| Tabla | Filas | Cols | Rel. | Qué es | Columnas clave |
|---|---:|---:|:--:|---|---|
| `Productos` | 2,194 | 6 | ✅ `articulo_proveedor` | Costo y prioridad por **artículo × proveedor** (de quién y a cuánto se compra) | `Articulo` · `Proveedor` · `CodigoProveedor` · `Costo` · `Prioridad` · `FechaUltimaCompra` |
| `MovimientoProveedores` | 1,789 | 26 | ✅ `movimiento_proveedores` | Movimientos de cuenta por proveedor (AP: facturas/pagos) | `Documento`+`Tipo` · `Tercero`=proveedor · `Fecha`/`FechaVencimiento` · `Valor` · `Saldo` · `InteresMoratorio` |
| `Proveedores` | 1,092 | 22 | ✅ `proveedores` | Padrón de proveedores con saldo y límite de crédito | `Proveedor` · `Nombre` · `RFC` · `SaldoMN` · `LimitecreditoMN` · `Tipo` |
| `OrdenesCompra` | 0 | 23 | ✅ `ordenes_compra` | OC por artículo (pedido/surtido/costos por proveedor). Vacía en suc 30 | `Consecutivo` · `Articulo` · `CodigoProveedor` · `CantidadPedida`/`Surtida` · `CostoPedido` · `Almacen` |
| `OrdenesResurtido` | 0 | 10 | ⚪ | Órdenes de resurtido inter-almacén. Vacía | `Consecutivo`,`Articulo`,`AlmacenResurt`,`CantidadPedida` |
| `CondicionesPago` | 0 | 7 | ⚪ | Condiciones de pago por proveedor. Vacía | `Proveedor`,`Plazo`,`Descuento`,`InteresMensual` |

### Cotizaciones
Cotizaciones que aún no son venta (encabezado + líneas) y los faltantes que generan.

| Tabla | Filas | Cols | Rel. | Qué es | Columnas clave |
|---|---:|---:|:--:|---|---|
| `DetalleCotizaciones` | 19,543 | 21 | 🟢 | Líneas de cotizaciones (ítem por cotización) | `Consecutivo` · `Articulo` · `CantidadRegular` · `ValorVenta` · `TipoPrecio` |
| `FaltantesDeCotizaciones` | 4,433 | 12 | 🟡 | Artículos faltantes detectados al cotizar (demanda no surtida) | `Articulo` · `CantidadRegular` · `Cliente` · `Fecha` · `Almacen` · `ValorVenta` |
| `MaestroCotizaciones` | 1,709 | 22 | 🟢 | Encabezado de cotizaciones (cliente, si se vendió/suspendió) | `Consecutivo` · `Tercero`=cliente · `Fecha` · `Vendedor` · `Vendida` · `FacturaSugerida` |
| `Faltantes` | 0 | 9 | ⚪ | Faltantes generales de inventario. Vacía | `Articulo`,`Almacen`,`Cantidad`,`ProveedorSugerido` |

### Promociones / lealtad / descuentos
Solo `Ofertas` tiene datos; el resto son features de puntos/descuentos que MD no usa.

| Tabla | Filas | Cols | Rel. | Qué es | Columnas clave |
|---|---:|---:|:--:|---|---|
| `Ofertas` | 5,195 | 13 | ✅ `ofertas` | Ofertas/descuentos por artículo con vigencia | `Consecutivo` · `Articulo` · `Descuento`/`Porcentaje` · `NivelPrecio` · `FechaInicial`/`Final` · `Limite`/`Remanente` · `NoCaduca` |
| `OfertasAgrupador` | 0 | 9 | ⚪ | Ofertas por grupo de artículos. Vacía | `Consecutivo`,`Elemento`,`Descuento` |
| `DescuentosVentas` | 0 | 3 | ⚪ | Escalas de descuento por venta. Vacía | `Id`,`Monto`,`Descuento` |
| `DescuentosComisiones` | 0 | 3 | ⚪ | Descuentos que afectan comisión. Vacía | `DescID`,`DesdeDia`,`Descuento` |
| `CambioPrecioHora` | 0 | 7 | ⚪ | Precios por franja horaria (happy hour). Vacía | `Folio`,`Inicio`,`Fin`,`Precio` |
| `PreciosAutomaticos` | 0 | 3 | ⚪ | Precios automáticos por cantidad. Vacía | `Elemento`,`NoPrecio`,`CantidadUnidadVenta` |
| `PuntosCobrados` / `PuntosVentas` | 0 | 5/3 | ⚪ | Programa de puntos (canje/otorga). Vacías | `Cliente`,`Puntos` |
| `GeneradoresPuntosDesc` / `ReceptoresPuntosDesc` | 0 | 4 | ⚪ | Reglas de puntos/descuento. Vacías | `Id`,`Elemento`,`Tipo`,`Condicion` |

### Impuestos / monedas / unidades

| Tabla | Filas | Cols | Rel. | Qué es | Columnas clave |
|---|---:|---:|:--:|---|---|
| `IVA` | 2 | 3 | 🟡 | Tasas de IVA | `Impuesto`,`Descripcion`,`Taza` |
| `IEPS` | 2 | 3 | 🟡 | Tasas de IEPS | `Impuesto`,`Descripcion`,`Taza` |
| `ISuntuoso` | 1 | 3 | ⚪ | Impuesto suntuoso | `Impuesto`,`Descripcion`,`Taza` |
| `Monedas` | 2 | 10 | 🟡 | Catálogo de monedas y paridades | `Moneda`,`Simbolo`,`NombredeMoneda`,`Compra*`/`Venta*` |
| `FormasPago` | 4 | 14 | ✅ `formas_pago` | Catálogo de formas de pago (efectivo/tarjeta/crédito/vale) | `FormaPago` · `Descripcion` · `Credito` · `Tarjetadecredito` · `ValeInterno` · `Paridad` |
| `Vendedores` | 13 | 6 | ✅ `vendedores` | Catálogo de vendedores con esquema de comisión | `Vendedor` · `Nombre` · `Comision` · `ComisionPorArticulo`/`Utilidad`/`Cartera` |

### Inventario físico / ediciones (todas vacías en MD)

| Tabla | Filas | Cols | Rel. | Qué es |
|---|---:|---:|:--:|---|
| `InventarioFisico` | 0 | 9 | ⚪ | Conteo físico de inventario |
| `InventarioEdiciones` | 0 | 6 | ⚪ | Ediciones de inventario |
| `ExistenciaEdiciones` | 0 | 5 | ⚪ | Ediciones de existencia |
| `MovimEdiciones` | 0 | 4 | ⚪ | Movimientos de edición |
| `Vales` | 0 | 5 | ⚪ | Vales de mercancía |
| `Eliminacion` | 181 | 6 | 🟡 | Log de elementos eliminados (auditoría) — `Clave`,`TipoElemento`,`Elemento`,`Fecha` |

### Config / seguridad / vistas / plomería (⚪ ignorar)

| Tabla | Filas | Qué es |
|---|---:|---|
| `Seguridad` | 5 | Niveles de seguridad del POS (cadenas de permisos por módulo) |
| `SegBD` | 0 | Pregunta/respuesta de seguridad de la BD |
| `Vistas` / `VistaDetalle` / `VistaSeguridad` / `VistasLibres` | 0 | Config de reportes/vistas parametrizables del POS |
| `FacturaLibre` / `MaestroFacturaLibre` | 197 / 3 | Plantillas de formato de factura (posición de campos) |
| `Impresion` | 0 | Config de impresoras |
| `ProcesosLibres` | 0 | Procesos SQL definidos por el usuario |
| `Traduccion` | 0 | Traducción de textos de UI |

---

## Tablas landing `wincaja.*` (20 + crosswalk)

Cada una lleva `tenant_id`, `source_branch`, `source_dataset`, `imported_at`. Ver el mapeo columna a columna en `database/importers/wincaja/import-wincaja.js` (constante `DOMAINS`).

| Dominio (flag `--domain`) | Tablas landing |
|---|---|
| `catalogo` | `familias`, `subfamilias`, `articulos`, `precios`, `existencias`, `articulo_proveedor` |
| `cartera` | `clientes`, `movimiento_clientes` |
| `compras` | `proveedores`, `movimiento_proveedores`, `ordenes_compra` |
| `caja` | `formas_pago`, `pagos_dia`, `cortes`, `arqueos`, `retiros` |
| `ventas` | `maestro_mov_almacen`, `detalles_mov_almacen` |
| `ref` | `vendedores`, `ofertas` |
| *(crosswalk)* | `branches` — mapea `source_branch` ↔ `kepler_code` ↔ `warehouse_code` + `status` |

**Candidatas a integrar después (🟢):** `Autorizaciones` (prevención/auditoría de caja), `Cajeros`, `MaestroCotizaciones`+`DetalleCotizaciones` (demanda no cerrada), `Categorias`, `Almacenes`.
