# Fase W — Wincaja (POS Access 97) → plataforma

> **ADR-031.** Ingesta del POS legacy **Wincaja** (Access 97 / Jet 3.5) a un landing
> schema separado `wincaja.*`, con crosswalk a Kepler/warehouses. Objetivo real:
> **destapar las sucursales `30 MORELIA ABASTOS` y `50 CANINDO`**, que hoy operan en
> Wincaja y están **ciegas** en la plataforma (Kepler no las ve).

---

## Contexto verificado (2026-07-13)

| Hecho | Detalle |
|---|---|
| Formato | Access 97 (Jet 3.5). ACE 12/16 lo **rechazan**. Abre `Microsoft.Jet.OLEDB.4.0` **32-bit**, read-only. |
| Ubicación | `.245` → `D:\Salidas\Bases\` (= `Z:\...` desde el hub). **Dos carpetas:** `Actuales` (vivo, período corriente) + `Concentradas` (histórico consolidado). |
| Sucursales (8 pobladas) | `00 BPIRAPUATO` (archivo `MOV`), `10 PHIDALGO`, `30 MORELIA ABASTOS`, `32 MORELIA MADERO`, `40 8ESQUINAS`, `44 YURECUARO`, `50 CANINDO`, `54 ZAMORA CENTRO`. `42 PIEDAD` = vacía → fuera. (Pendiente confirmar con Edgar cuál de las 8 no es "sucursal" para el conteo de 7 — prob. BPIRAPUATO = CEDIS.) |
| Datasets | `Actuales` tiene las 8 (catálogo+existencias+caja al día, movs del período). `Concentradas` solo consolidó **10/30/32/50**. Coexisten vía columna **`source_dataset`** (parte del PK). |
| Relación con Kepler | Mismas sucursales físicas. **Kepler primario**; Wincaja vivo en `00/30/32/50` (movs julio); `40/44/54` último mov ene-mar (ya en Kepler → `md_03/04/05`); `10` a fin de junio (`md_01`). Las que Kepler no ve (30/32/50) hoy están ciegas en la plataforma. |
| Cadencia | `Actuales` diario; `Concentradas` mensual. Confirmar con Edgar. |
| Escala | `DetallesMovAlmacen` hasta ~940k (concentrada 30), `Precios` ~89k, `Articulos`/`Existencias` ~15k por sucursal-dataset. |

**Método de lectura probado:**
```powershell
& "C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe" -File extract.ps1 "<ruta.mdb>"
# provider: Provider=Microsoft.Jet.OLEDB.4.0;Data Source="...";Mode=Read;
```

---

## Arquitectura (ADR-031)

```
Access 97 (.mdb por sucursal, en .245)
        │  (A) extract: PowerShell 32-bit + Jet 4.0  →  JSONL por tabla
        ▼
JSONL en disco (.245)  ── artefacto auditable, desacopla Jet del load
        │  (B) load: Node → UPSERT (full-reload por source_branch en trx)
        ▼
wincaja.*  (landing / bronze — RLS forzado, tenant_id, source_branch)
        │  crosswalk wincaja.branches + articulo/cliente
        ▼
   ├─ 30/50: bridge → tablas canónicas (dejan de estar ciegas)     [W.5]
   └─ 10/32: conciliación Wincaja ↔ Kepler (feature, no bug)        [W.6 diferido]
```

**Reglas:** nunca merge físico en `commercial.*`/`analytics.*`; nunca write-back a Wincaja/Kepler; recarga full por sucursal = idempotente.

---

## Sprints

| Sprint | Tema | Estado |
|---|---|---|
| **W.0** | Feasibility + ADR-031 + schema `wincaja.*` (todos los dominios) + `wincaja.branches` crosswalk | 🔨 |
| **W.1** | Importer 2-etapas (extract PS → JSONL, load Node → UPSERT). Dominio **Catálogo** E2E en suc 30 | ⬜ |
| **W.2** | Dominio **Cartera** (`clientes`, `movimiento_clientes`) | ⬜ |
| **W.3** | Dominio **Caja/tesorería** (`pagos_dia`, `arqueos`, `retiros`, `cortes`, `formas_pago`) | ⬜ |
| **W.4** | Dominio **Ventas/almacén** (`maestro_mov_almacen`, `detalles_mov_almacen`) | ⬜ |
| **W.5** | **Bridge** 30/50 → canónico (visibles en Command Center/Maat/RA) | ⬜ |
| **W.6** | Conciliación Wincaja↔Kepler para 10/32 (alimenta SM/Maat) | ⏸️ diferido |

**Dominios pedidos por Edgar:** *todo* (Cartera + Caja + Ventas + Catálogo).

---

## Tablas landing `wincaja.*` (mapeo Access → PG)

Común a todas: `tenant_id uuid NOT NULL`, `source_branch text NOT NULL` (10/30/32/50), `imported_at timestamptz`.

| Dominio | Tabla PG | Access origen | PK natural |
|---|---|---|---|
| meta | `branches` | (crosswalk, no Access) | `source_branch` |
| Catálogo | `familias` | Familias | `(source_branch, familia)` |
| Catálogo | `subfamilias` | Subfamilias | `(source_branch, subfamilia)` |
| Catálogo | `articulos` | Articulos | `(source_branch, articulo)` |
| Catálogo | `precios` | Precios | `(source_branch, articulo, no_precio)` |
| Catálogo | `existencias` | Existencias | `(source_branch, almacen, articulo)` |
| Catálogo | `articulo_proveedor` | Productos | `(source_branch, articulo, proveedor)` |
| Cartera | `clientes` | Clientes | `(source_branch, cliente)` |
| Cartera | `movimiento_clientes` | MovimientoClientes | `(source_branch, documento, tipo)` |
| Compras | `proveedores` | Proveedores | `(source_branch, proveedor)` |
| Compras | `movimiento_proveedores` | MovimientoProveedores | `(source_branch, documento, tipo)` |
| Compras | `ordenes_compra` | OrdenesCompra | `(source_branch, consecutivo, articulo)` |
| Caja | `formas_pago` | FormasPago | `(source_branch, forma_pago)` |
| Caja | `pagos_dia` | PagosDia | `(source_branch, consecutivo)` |
| Caja | `cortes` | Cortes | `(source_branch, folio, caja)` |
| Caja | `arqueos` | Arqueos | `(source_branch, consecutivo, denominacion)` |
| Caja | `retiros` | Retiros | `(source_branch, folio, caja)` |
| Ventas | `maestro_mov_almacen` | MaestroMovAlmacen | `(source_branch, consecutivo)` |
| Ventas | `detalles_mov_almacen` | DetallesMovAlmacen | surrogate `bigserial` |
| Ref | `vendedores` | Vendedores | `(source_branch, vendedor)` |
| Ref | `ofertas` | Ofertas | `(source_branch, consecutivo)` |

---

## Mapa de usos (backlog de valor)

Dónde se puede consumir la data Wincaja, por módulo/motor. **Alcance:** 🔵 *ciegas* (30/32/50 — solo Wincaja, valor = destapar) · 🟣 *compartidas* (00/10/40/44/54 — en Kepler, valor = conciliar). **Data:** ✅ en `wincaja.*` · ⬜ en el `.mdb` pero falta ingerir.

| # | Consumidor | Uso concreto | Tablas Wincaja | Alcance | Data |
|---|---|---|---|:--:|:--:|
| U1 | Command Center / analytics | Venta diaria/mensual, AOV, unidades, clientes únicos por sucursal | detalles/maestro + pagos_dia | 🔵🟣 | ✅ |
| U2 | Sell-out | Venta por marca/familia/subfamilia | detalles + articulos→familias | 🔵🟣 | ✅ |
| U3 | analytics | Top productos / top clientes / por vendedor / por forma de pago | detalles, maestro, pagos_dia, vendedores | 🔵🟣 | ✅ |
| U4 | Command Center red | Comparación entre las 8 tiendas (surtido, ticket, dispersión) | detalles, precios, existencias | red | ✅ |
| U5 | RA / Compras | Punto de reorden + existencia crítica + sugerido (hoy sin política) | existencias + detalles (demanda) + articulo_proveedor (costo) | 🔵 | ✅ |
| U6 | RA / Compras | Demanda insatisfecha (venta perdida) → reorden | FaltantesDeCotizaciones | 🔵🟣 | ⬜ |
| U7 | RA / Compras | Safety stock estacional (26 años de histórico) | detalles (concentrada) | 🔵 | ✅ |
| U8 | RA / Compras | Sourcing por proveedor (mejor costo) + lead time | articulo_proveedor, ordenes_compra | 🔵🟣 | ✅ |
| U9 | SM (reconciliation) | **Cuadre de caja por denominación** (Kepler no lo tiene) | arqueos, cortes, retiros, pagos_dia | 🔵🟣 | ✅ |
| U10 | SM (reconciliation) | Conciliación Wincaja↔Kepler venta/existencia/corte por sku+suc+día | detalles, existencias, cortes | 🟣 | ✅ |
| U11 | SM / Almacén | Movimientos de inventario (entradas/salidas/traspasos/mermas) | maestro/detalles por tipo | 🔵 | ✅ |
| U12 | Prevención / auditoría | Cancelaciones/eliminaciones + overrides de supervisor | cortes (canceladas), Autorizaciones | 🔵🟣 | ⬜ (Autoriz.) |
| U13 | Maat (finanzas) | **Cartera / cobranza**: aging, vencimientos, límites, bloqueados | movimiento_clientes, clientes | 🔵 | ✅ |
| U14 | Maat (finanzas) | CxP / gasto por proveedor | movimiento_proveedores | 🔵🟣 | ✅ |
| U15 | Maat (finanzas) | Tesorería: cortes, retiros, flujo de efectivo | cortes, retiros, pagos_dia | 🔵🟣 | ✅ |
| U16 | Maat (finanzas) | Comisiones generadas/pendientes/pagadas (provisión) | movimiento_clientes.comision_*, vendedores | 🔵🟣 | ✅ |
| U17 | Thot (inteligencia) | Rotación por SKU×sucursal | detalles | 🔵 | ✅ |
| U18 | Thot (inteligencia) | Margen (precio − costo) por SKU×sucursal | precios, articulo_proveedor, existencias | 🔵 | ✅ |
| U19 | Thot (inteligencia) | Afinidad / canasta (co-ocurrencia por ticket) | detalles + maestro | 🔵🟣 | ✅ |
| U20 | Thot (inteligencia) | Whitespace (qué vende una tienda y otra no) | detalles (red) | red | ✅ |
| U21 | Thot / mapa comercial | Segmentación de cliente (territorio, frecuencia, saldo) | clientes, movimiento_clientes | 🔵 | ✅ |
| U22 | Take-order / vendor / portal | Gate de margen (costo real, única fuente para 30/32/50) | articulo_proveedor, existencias | 🔵 | ✅ |
| U23 | Take-order / portal | Precio por nivel del cliente (mayoreo/menudeo) | precios, clientes.precio | 🔵 | ✅ |
| U24 | Take-order / portal | "Tus frecuentes" / sugeridos por historial del cliente | detalles + maestro por tercero | 🔵 | ✅ |
| U25 | Etiquetera / Tienda | Precio de anaquel por sucursal + ofertas vigentes | precios, ofertas | 🔵🟣 | ✅ |
| U26 | Crédito y cobranza (Fase H) | Scoring: historial de pago, atrasos, plazo, sobre-límite | movimiento_clientes, clientes | 🔵 | ✅ |
| U27 | Growth / lealtad (Fase G) | Reactivar puntos + campañas por territorio | clientes.puntos_acumulados | 🔵 | ✅ (puntos) |
| U28 | WhatsApp bot (Fase F) | Recordatorio de cartera / confirmación de pedido a clientes | movimiento_clientes, clientes | 🔵 | ✅ |
| U29 | Catálogo maestro / AI (Fase K) | Enriquecer `catalog.products` con ~3,700 SKUs + barcodes faltantes | articulos, ArticulosRelacion | red | ✅ / ⬜ |
| U30 | Catálogo | Normalizar familias/subfamilias/categorías | familias, subfamilias, Categorias | red | ✅ / ⬜ |
| U31 | Vendedor / nómina | Desempeño y comisión por vendedor | vendedores, maestro.vendedor | 🔵🟣 | ✅ |
| U32 | Growth | Efectividad de promociones (venta con/sin oferta) | ofertas + detalles | 🔵🟣 | ✅ |
| U33 | **Migración / system-of-record** | On-ramp para migrar 30/32/50 a la plataforma y **retirar Wincaja** | todo | 🔵 | ✅ |
| U34 | Data quality | Readiness de migración: qué tan limpio migró Kepler (5 shared) | cruce vs Kepler | 🟣 | ✅ |

**Caveat transversal:** el raw es *bronze* — conteos/actividad confiables; **montos $ (saldos, costos) traen basura** y requieren limpieza en la capa silver antes de mostrarse.

**Cómo se libera:** casi todo (U1–U25) se destraba con **una capa silver** — vistas/MVs que traducen `wincaja.*` al shape canónico (`sku`/`warehouse_code`/`date`/`qty`/`$`) uniendo por producto (`articulo`=`sku`) + crosswalk de sucursal, limpiando montos. Con esa capa cada consumidor es "conectar uno más". U6/U12/U29 requieren ingerir tablas ⬜ primero (Autorizaciones, Cotizaciones/Faltantes, Categorias/Almacenes).

---

## Pendiente operacional / prod

- Confirmar cadencia real de las "Concentrada" y si existe un `.mdb` "Actual" más fresco para 30/50.
- Cuenta de servicio read-only en el origen (no usar credencial admin para el job programado).
- Migración `wincaja.*` a Railway + agendar el importer (corre en `.245`, LAN).
