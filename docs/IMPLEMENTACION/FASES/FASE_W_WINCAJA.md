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

## Pendiente operacional / prod

- Confirmar cadencia real de las "Concentrada" y si existe un `.mdb` "Actual" más fresco para 30/50.
- Cuenta de servicio read-only en el origen (no usar credencial admin para el job programado).
- Migración `wincaja.*` a Railway + agendar el importer (corre en `.245`, LAN).
