# Wincaja — Modelo operativo (cómo funciona)

> Fase W. Cómo fluye la mercancía, el dinero y los datos en el POS Wincaja (Access 97),
> y cómo lo modelamos en la plataforma. Complementa [`WINCAJA_TABLAS.md`](WINCAJA_TABLAS.md)
> (catálogo de tablas) y [`WINCAJA_KEPLER_RELACION.md`](WINCAJA_KEPLER_RELACION.md).

## 1. Unidades físicas (un `.mdb` por unidad)

Cada archivo Access es una base Wincaja **completa e independiente** (mismo esquema de ~65 tablas).

| Tipo | Archivos | Ejemplo | source_branch |
|---|---|---|---|
| **Sucursal / almacén** | 8 | `30 MORELIA ABASTOS.MDB` | `30` |
| **Ruta de reparto** | 13 | `21 RUTA 21.MDB` | `21` |

Carpetas en `.245`: `Actuales` (vivo) y `Concentradas` (histórico, solo sucursales 10/30/32/50).
Las rutas solo existen en `Actuales`.

Mapeo ruta → sucursal madre:

```
Sucursal 10 (Padre Hidalgo) ── rutas 21, 22, 23, 26, 27, 28
Sucursal 32 (Morelia Madero) ── rutas 321, 322
Sucursal 50 (Canindo)        ── rutas 501, 502, 503, 504, 505
```

## 2. Tipo de documento = primera letra del folio

`MaestroMovAlmacen.tipo` / `documento` (ej. `F100035375`):

| tipo | Significado | Folio ej. |
|---|---|---|
| **V** | Venta (F=factura, T=ticket) | `F100…`, `T…` |
| **C** | Compra / recepción de mercancía | `C95…` |
| **D** | Devolución | `D100…` |
| **E** | Entrada (ajuste) | `E000…` |
| **S** | Salida (ajuste) | `S000…` |
| **X** | Traspaso / ajuste de existencia | `X13…` |
| **P** | Pedido | `P95…` |
| **I** | Inventario físico | `I95…` |

## 3. Taxonomía de CAJA (crosswalk `wincaja.caja_channels`)

La `caja` no es solo un cajón físico: codifica el **canal**. El significado es consistente
entre sucursales (verificado). Se modela en `wincaja.caja_channels (source_branch, caja → channel, es_venta)`;
las cajas no listadas = mostrador / venta.

| Caja | Canal | ¿Venta? | Qué es |
|---|---|---|---|
| 10-14, 30-34, 40-46, 50-55… | `mostrador` | ✅ | Venta en mostrador de la sucursal |
| **15** | `preventa_vecinal` | ✅ | Venta minorista intensiva con **servicio a la puerta del cliente** (contado) |
| **70** | `mayoreo_credito` | ✅ | Mayoreo a crédito (clientes mayoristas) |
| **90** | `almacen` | ❌ | Entradas/salidas/traspasos físicos |
| **95** | `compras` | ❌ | Recepción de compra a proveedor |
| **96** | `compras` | ❌ | Recepción de traspasos (compra interna) |
| **98** | `ruta_bordo` | ❌ | **Traspaso a ruta** (carga a camioneta; la venta ocurre a bordo) |
| **99** | `traspaso_almacen` | ❌ | Traspaso inter-almacén / CEDIS |
| (dentro de un `.mdb` de ruta) | `ruta_venta` | ✅ | **Venta a bordo** al cliente final |

## 4. Flujo de mercancía y dinero

```
                         PROVEEDOR
                            │  compra (caja 95, tipo C)
                            ▼
   ┌─────────────────────  ALMACÉN / SUCURSAL  ─────────────────────┐
   │                                                                │
   │  ventas directas:                     traspasos (NO venta):     │
   │   • mostrador (cajas físicas)          • inter-almacén (caja 99)│
   │   • preventa vecinal (caja 15)  ◄──►   • a ruta       (caja 98) │
   │   • mayoreo a crédito (caja 70)                    │            │
   └───────────────────────────────────────────────────┼────────────┘
                                                        │ carga camioneta
                                                        ▼
                                      RUTA DE REPARTO (.mdb propio)
                                        recibe como Compra (C)
                                        vende A BORDO (caja=ruta, tipo V)
                                                        │
                                                        ▼
                                              CLIENTE FINAL (tiendita)
```

**Anti-doble-conteo (clave):** la caja 98 (traspaso a ruta) se **excluye** de la venta
de la sucursal; la venta real es la **venta a bordo** en el `.mdb` de la ruta. Igual la
caja 99 (inter-almacén). Entonces la venta total sin duplicar =
`mostrador + preventa_vecinal + mayoreo_credito (sucursales) + ruta_venta (rutas)`.

## 5. Capas en la plataforma (medallion, ADR-031)

```
BRONZE  wincaja.*            21 tablas espejo (RLS, tenant_id, source_branch, source_dataset)
                            + wincaja.branches   (crosswalk: sucursal/ruta, parent_branch, is_route, kepler_code)
                            + wincaja.caja_channels (crosswalk: caja → channel, es_venta)
   │
   ▼
SILVER  wincaja.v_*          vistas canónicas (security_invoker → RLS aplica)
        v_sales_lines        línea de venta REAL: excluye traspasos (es_venta / ALMAC%),
                             etiqueta sale_channel (mostrador/preventa_vecinal/mayoreo_credito/ruta_venta),
                             anti-doble-conteo actual↔concentrada por corte de fecha
        v_sales_daily        rollup sku × sucursal × día × canal
        v_stock, v_ar_*, v_cash_*, v_prices …
   │
   ▼
GOLD    analytics.sales_daily   solo sucursales que Kepler NO ve (30/32/50), channel='wincaja'
        commercial.stock        existencia de 30/32/50
        wincaja.mv_branch_kpis  KPIs por sucursal (overview instantáneo)
```

### Regla de atribución (decisión Edgar 2026-07-14)

- **La venta de una ruta se atribuye a la RUTA, no a la tienda madre.** Cada ruta es una
  **unidad de venta propia** en los reportes (RUTA 21, RUTA 22, … como renglones aparte,
  no sumadas a la sucursal 10). `parent_branch` queda solo como referencia jerárquica.
- **Preventa vecinal (caja 15)** = venta minorista intensiva con **servicio a la puerta**
  del cliente; es venta de la **sucursal** (no de una ruta), canal `preventa_vecinal`.

> Rutas en **bronze + silver + gold** (venta a bordo ~$31M ene-jul 2026, 13 rutas;
> sell-through real que **no duplica** con las sucursales — la caja 98 está excluida).
> Cada ruta es su propia unidad gold: warehouse `RUTA-<code>` (kind='truck') y
> `analytics.sales_daily channel='wincaja_ruta'`, separada de la sucursal madre y del
> canal `wincaja` (mostrador/preventa/mayoreo). El feed de **stock excluye** RUTA-*
> (no metemos inventario de camión). W.10.

## 6. Importer

`database/importers/wincaja/import-wincaja.js` — `--branch <code|all|branches|routes>`.
`resolveFile` distingue sucursal (evita `RUTA`) de ruta (match `RUTA <code>.MDB`). Recarga
full idempotente por `(source_branch, source_dataset)`. Sync automático del `actual` en
[`sync-wincaja-actual.ps1`](../../database/importers/wincaja/sync-wincaja-actual.ps1) (tarea Windows).
