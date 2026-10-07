# Wincaja ↔ Kepler — qué se relaciona y qué no

> Mapeo empírico entre el POS **Wincaja** (Access 97, `wincaja.*`) y el ERP **Kepler**
> (`catalog.*`/`analytics.*`/`commercial.*`). Base para el bridge/conciliación (Fase W, W.5/W.6).
> Complementa [`WINCAJA_TABLAS.md`](WINCAJA_TABLAS.md) y [`KEPLER_CATALOGO_TABLAS.md`](KEPLER_CATALOGO_TABLAS.md).
> Medido 2026-07-13 sobre sucursal **30 MORELIA ABASTOS** (dataset `actual`) vs data Kepler ya ingerida en `postgres_platform`.

## TL;DR

- **Productos: SE RELACIONAN 1:1 y limpio.** `wincaja.articulos.articulo` == `catalog.products.sku` (mismo espacio de códigos, verificado: `00000`="ADMINISTRATIVO" idéntico en ambos). El código de barras también matchea. **Es la única llave fuerte entre los dos sistemas.**
- **Sucursales: se relacionan por crosswalk** (`wincaja.branches.kepler_code`), pero con numeración distinta y **cobertura parcial**.
- **Clientes: NO se relacionan** (8 RFC en común de 982). Poblaciones distintas.
- **Proveedores: NO se relacionan** por llave directa (códigos distintos, sin RFC compartido).
- **Documentos (ventas/caja/movimientos): NO se relacionan a nivel folio** — cada sistema numera lo suyo. Se comparan **por producto+sucursal+fecha** (conciliación), no por identidad de documento.

## Evidencia (medición)

### Productos — puente fuerte ✅
| Prueba | Resultado |
|---|---|
| Wincaja(30) artículos | 15,367 (15,303 códigos de barras distintos) |
| Kepler `catalog.products` | 11,949 filas · 11,607 barcodes · 11,645 skus |
| match **`wcj.articulo` = `kepler.sku`** | **11,645** (todos los de Kepler) |
| match `wcj.codigo_barras` = `kepler.barcode` | 11,594 |
| Wincaja(30) sin match en Kepler | ~3,700 (inactivos / locales / no en catálogo activo) |

→ **Wincaja es superset de Kepler en producto.** El SKU es idéntico; se une por `articulo`=`sku` (y barcode como respaldo). `catalog.products` incluso conserva su propia columna `articulo`.

### Clientes — no se relacionan ❌
| Prueba | Resultado |
|---|---|
| Wincaja(30) clientes | 8,744 (solo **982** con RFC; el resto = mostrador/público) |
| Kepler `analytics.erp_customers` | 1,188 (309 RFC) |
| `commercial.customers` | 3 (test data) |
| match RFC (wcj vs erp_customers) | **8** |

→ Dos padrones **distintos**: Wincaja = clientes de mostrador por tienda; Kepler = cartera de mayoreo/crédito/ruta. Códigos de cliente no comparten espacio; RFC casi nunca capturado en Wincaja. **No hay identidad de cliente entre sistemas.**

### Proveedores — no se relacionan por llave ❌
`catalog.suppliers` (Kepler) = `id, code, name, lead_time_days, min_order_boxes` — **sin RFC**. `wincaja.proveedores` tiene RFC/código propio. Sin llave común directa; requeriría match difuso por nombre (no confiable).

## Mapa de relación por entidad

| Entidad | Wincaja | Kepler (local) | Llave de unión | ¿Relaciona? |
|---|---|---|---|:--:|
| **Producto** | `wincaja.articulos` | `catalog.products` | `articulo` = `sku` (o `barcode`) | ✅ fuerte 1:1 |
| Familia/Subfamilia/Categoría | `wincaja.familias`/`subfamilias` | `catalog.categories`/`brands` | por nombre (no por código) | 🟡 débil |
| **Sucursal** | `source_branch` | `md_XX` / `warehouse_code` | `wincaja.branches.kepler_code` | ✅ crosswalk (parcial) |
| Existencia | `wincaja.existencias` | `analytics.stock_ledger` / `inventory.warehouse_stock` | sku + sucursal | ✅ vía producto (para conciliar) |
| Precio | `wincaja.precios` | `commercial.product_prices` / `catalog` | sku + nivel | ✅ vía producto |
| **Venta / movimiento** | `maestro_mov_almacen`+`detalles` | `analytics.sales_*` (kdm1/kdm2/kdij) | **NO por folio**; sí por sku+sucursal+fecha | 🟡 solo agregado/conciliación |
| **Corte / caja** | `cortes`+`arqueos`+`pagos_dia` | `analytics.cash_cuts` (kdpv_folio_caja) | sucursal+caja+fecha | 🟡 conciliación (folios distintos) |
| **Cliente** | `wincaja.clientes` | `analytics.erp_customers`/`commercial.customers` | RFC (8/982) | ❌ no |
| **Proveedor** | `wincaja.proveedores` | `catalog.suppliers` | — (sin llave común) | ❌ no |

## Qué NO se relaciona (existe en un solo sistema)

**Solo en Kepler (no en Wincaja):**
- Fiscal / CFDI-SAT (`kdfe*`, `kdmx*`), pólizas contables (`kdc2*`), catálogo contable (`kdco`).
- Reparto/ruta: push de venta a camionetas, `kdm_rutas`, embarques/logística.
- Consolidación multi-sucursal, presupuesto→factura, márgenes calculados del ERP.

**Solo en Wincaja (no en Kepler):**
- **Cotizaciones** (`MaestroCotizaciones`+`DetalleCotizaciones`) y sus faltantes (demanda no cerrada).
- **Autorizaciones** de supervisor en caja (overrides — valor para prevención/auditoría).
- **Arqueo por denominación** (`Arqueos`: billetes/monedas pieza por pieza) — Kepler solo trae el total del corte.
- Padrón de **clientes de mostrador** por tienda (el grueso, sin RFC).
- Programa de **puntos/lealtad** (tablas vacías, pero el esquema existe).

**Sucursales — cobertura parcial (crosswalk):**
| source_branch | Wincaja | Kepler `md_XX` | Situación |
|---|:--:|:--:|---|
| 00 BPIRAPUATO | ✅ | md_00 (CEDIS) | en ambos |
| 10 PHIDALGO | ✅ | md_01 | en ambos (Wincaja congelándose) |
| 40 8ESQUINAS | ✅ | md_03 | en ambos (Wincaja ya frío) |
| 44 YURECUARO | ✅ | md_04 | en ambos (Wincaja ya frío) |
| 54 ZAMORA CENTRO | ✅ | md_05 | en ambos (Wincaja ya frío) |
| **30 MORELIA ABASTOS** | ✅ | — | **solo Wincaja** (Kepler no la ve) |
| **32 MORELIA MADERO** | ✅ | — | **solo Wincaja** |
| **50 CANINDO** | ✅ | — | **solo Wincaja** |
| — | — | md_02 (La Piedad) | Wincaja `42 PIEDAD` está vacía |

## Implicaciones para el bridge (W.5/W.6)

1. **Producto es el eje.** Toda vista que cruce Wincaja↔Kepler se une por `sku`. Un `wincaja.articulos` sin match en `catalog.products` = producto local/inactivo (marcar, no descartar).
2. **30/32/50 = fuente única.** No hay Kepler contra qué conciliar → su venta/existencia/caja de Wincaja alimenta directo los tableros (dejan de estar ciegas). Se les asigna `warehouse_code` MD-30/32/50.
3. **00/10/40/44/54 = conciliación.** Mismo producto+sucursal en ambos → comparar venta/existencia/corte Wincaja vs Kepler = detección de descuadres (insumo para SM / Maat). **No** intentar casar folios: comparar agregados por sku+sucursal+día.
4. **Cliente y proveedor: mantener separados.** No hay identidad cruzable; cada sistema conserva su padrón. Cualquier unificación futura sería match difuso (nombre/teléfono), fuera de alcance del bridge determinista.
