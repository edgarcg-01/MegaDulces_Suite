# FASE WR — Réplica cruda local continua de las Wincaja (Access 97 → Postgres)

> Estado: 🔨 DISEÑO (planeación) — 2026-08-18
> Objetivo: tener un **espejo Postgres crudo y continuo** de cada base **Wincaja** (Access 97 `.mdb`), local en el contenedor `:5433`, **análogo a las réplicas `kepler_md_XX`** — consultable por SQL, siempre fresco (~1-5 min), sin depender de Jet para cada análisis. Base uniforme: Kepler y Wincaja ambos como réplicas Postgres locales.
> Decisión (Edgar 2026-08-18): **réplica cruda local completa** + **frescura continua (~1-5 min)**.
> ADR asociado: **ADR-045** (adapter "Access → Postgres", el mismo de [`FASE_CA`](FASE_CA_CEDIS_ACCESS_ODS.md) para el CEDIS Kepler-Access) + hereda **ADR-031** (Wincaja Jet 4.0 32-bit).

---

## 0. El encuadre — qué cambia vs lo que ya hay

Wincaja **ya tiene** un espejo parcial en Postgres: el bronze `wincaja.*` (21 tablas curadas en Railway, **full-daily** vía extractores Jet ~26 min, tarea 05:00) + `wincaja-live-extract` (tickets vivos ~5 min sobre copia-sombra). Ver [`FASE_W_WINCAJA`](FASE_W_WINCAJA.md).

Lo que WR agrega es **el equivalente de `kepler_md_XX`**: un espejo **crudo** (todas las tablas del `.mdb`, no las 21 curadas), **local** (`:5433`), **continuo** (CDC ~1-5 min, no recarga full diaria). Es decir, la capa que a Kepler le da la replicación lógica nativa — pero Access no la tiene, así que se implementa con **Jet + hash-delta**.

| | Kepler | Wincaja hoy | Wincaja WR (esto) |
|---|---|---|---|
| Réplica local cruda | `kepler_md_XX` @ :5433 | — | `wincaja_XX` @ :5433 |
| Mecanismo | replicación lógica nativa | extractores Jet full-daily | **CDC Jet + hash-delta ~1-5 min** |
| Frescura | al-segundo | diario 05:00 (+ tickets 5 min) | ~1-5 min, todas las tablas |

**Sucursales objetivo:** `30` Morelia Abastos, `32` Morelia Madero, CEDIS Irapuato `00`, + los `.mdb` de **rutas** (321/322, etc.). Canindo `50` **ya migró a Kepler** (Fase Canindo) → fuera. PH `10` congelada 31/05 → histórico (no continuo).

---

## 1. Piezas que ya existen (se reusan)

| Pieza | De dónde | Estado |
|---|---|---|
| Lectura Access 97 (Jet 4.0 **32-bit** `Mode=Read` sobre copia-sombra) | `extract-table.ps1` / `wincaja-live-extract.js` | ✅ prod |
| Copia-sombra de los `.mdb` (SyncBack → `Z:`) | live-extract ya la usa (30/32/50) | ✅ (confirmar 00/rutas) |
| CDC dos carriles (watermark incremental + hash-delta) | `replicate-ods-live.js` (Kepler) + adapter Fase CA | ✅ patrón probado |
| Watermark por consecutivo (movimientos append-only) | `wincaja-live-extract` (max consecutivo) | ✅ prod |
| Contenedor de réplicas locales `:5433` (pgvector-md) | donde viven `kepler_md_XX` | ✅ |

Lo genuinamente nuevo: el **orquestador** que espeja **todas** las tablas de cada `.mdb` (no solo ventas) a una réplica Postgres, en loop continuo.

---

## 2. Arquitectura objetivo

```
ORIGEN (.245, Access 97)
  Wincaja .mdb VIVO  (Z:\Salidas\Bases\Concentradas\30 MORELIA ABASTOS.MDB, …)  — NUNCA abrir el vivo
        │  SyncBack / robocopy open-file cada ~5 min
        ▼
  Copia-sombra       <staging local>\30.mdb, 32.mdb, 00.mdb, <rutas>.mdb

ADAPTER (máquina de feeds, on-prem — Jet 32-bit vive acá)
  replicate-wincaja-live.js   (loop --watch=N, hermano de replicate-ods-live)
    por sucursal × tabla:
    ├─ Carril INCREMENTAL (movimientos append-only: MaestroMovAlmacen, DetallesMovAlmacen, Cortes…)
    │     extract (Jet 32-bit) WHERE consecutivo > watermark  → UPSERT
    └─ Carril HASH-DELTA (catálogos mutables: Articulos, Precios, Existencias, Clientes, Proveedores…)
          extract full → md5(fila JSON) en JS  → vs shadow  → UPSERT solo el delta

  Estado CDC (watermark + shadow):  Postgres :5433 (schema `ods` en la réplica, como Kepler)

DESTINO (Postgres local :5433)
  wincaja_30.*  /  wincaja_32.*  /  wincaja_00.*  /  wincaja_<ruta>.*   (o schema-por-sucursal)
     = espejo CRUDO de TODAS las tablas Access, consultable por SQL, fresco ~1-5 min
        │
        ▼ (Fase 2, WR.6)
  el pipeline bronze `import-wincaja` lee de la RÉPLICA (SQL), no de Jet
```

---

## 3. Estrategia CDC (dos carriles sobre Jet)

Access no tiene `ctid` ni replicación lógica → se replican los dos carriles del `replicate-ods-live`, con **Jet como reader**:

### 3.1 Carril incremental — movimientos append-only
`MaestroMovAlmacen`, `DetallesMovAlmacen`, `Cortes`, `PagosDia`… Watermark sobre la **columna monótona** (consecutivo del ticket / fecha). `SELECT … WHERE consecutivo > wm` vía Jet. Es lo que `wincaja-live-extract` ya hace para ventas — se generaliza a todas las tablas de movimiento.

### 3.2 Carril hash-delta — catálogos mutables
`Articulos` (productos), `Precios`, `Existencias`, `Clientes`, `Proveedores`… Full-scan del `.mdb` vía Jet → `md5(fila JSON)` en **JS** → contra shadow en Postgres → UPSERT solo el delta. Captura UPDATE (precio/existencia/costo).

### 3.3 Estado CDC en Postgres
Watermarks + shadow de hashes en la réplica local (schema `ods`, como las réplicas Kepler). El `.mdb` es read-only.

---

## 4. Sprints

Estados: ⬜ TODO · 🔨 EN CÓDIGO · 🧪 PROBADO · 🚀 STAGING · ✅ PROD

| # | Sprint | Entrega | Estado |
|---|---|---|---|
| **WR.0** | **Descubrimiento** ⛔ ruta crítica | Inventario de `.mdb` objetivo (30/32/00/rutas): ruta, **copia-sombra existe?** (SyncBack cubre 30/32/50; confirmar 00 + rutas), tablas, PKs, tipos, tamaños, **columna incremental** por tabla de movimiento. Entregable: mapa tabla→carril + PK + col-watermark por sucursal. | ⬜ |
| **WR.1** | Adapter de lectura + esquema | Extractor Jet 32-bit genérico (reusa `extract-table.ps1`) + descubridor de **tablas/columnas/PK** del `.mdb` (`OleDbSchemaGuid`/`MSysObjects`) + wrapper Node `readTable(t,{sinceCol,sinceVal})` / `readAll(t)`. | 🧪 |
| **WR.2** | Destino réplica + DDL espejo | Crear `wincaja_XX` (o schema-por-sucursal) en `:5433` + auto-generar el DDL espejo desde el esquema Access (tipos → `text`/`numeric` sin precisión, **tolerante a valores corruptos** — el saneamiento vive en silver, no en la réplica cruda). | ⬜ |
| **WR.3** | CDC dos carriles | Carril incremental (movimientos por watermark) + carril hash-delta (catálogos md5-en-JS vs shadow). Estado en schema `ods`. | ⬜ |
| **WR.4** | Orquestador + tarea continua | `replicate-wincaja-live.js` (hermano de `replicate-ods-live`) orquesta sucursales × tablas × carriles + `--watch=N` + launcher `.cmd` + tarea `WincajaLiveLoop` (continua). | ⬜ |
| **WR.5** | Verificación + monitoreo | Fidelidad `.mdb` ↔ réplica (conteos + Σ montos, como se hizo con Kepler) + **db-health source** (frescura de la réplica Wincaja). | ⬜ |
| **WR.6** | Re-apuntar consumidores (Fase 2) | `import-wincaja` + extractores leen de la **réplica Postgres** (SQL) en vez de Jet → el bronze deja de depender de la extracción Jet full-daily; el `WincajaSyncActual` 05:00 se retira o se vuelve micro-batch sobre la réplica. | ⬜ |

**MVP = WR.0–WR.5** (la réplica cruda existe y está fresca). **WR.6** cosecha el beneficio (el pipeline deja de depender de Jet).

---

## 5. Gotchas (ADR-031 + Fase W, vividos)

1. **Jet 4.0 32-bit obligatorio** (`SysWOW64`) — ACE 12/16 **rechazan** Access 97 ("base creada con versión anterior"). Mismo reader que Wincaja.
2. **Nunca abrir el `.mdb` vivo** → copia-sombra (SyncBack). Frescura = cadencia de la copia + del loop.
3. **Valores corruptos** (ej. `CostoPromedio` 2.29e16, la fila POS de $995 **billones**): la réplica **cruda los espeja tal cual** (`numeric` sin precisión / `text`). El saneamiento (`valor<10M AND qty<10M`, costo saneado) vive en las vistas silver, NO en la réplica.
4. **PKs duplicadas** en origen (ej. `Productos (articulo,proveedor)` duplicado) → dedup last-wins al UPSERT (como `import-wincaja.js`).
5. **Tiempos raros** (`PagosDia.Hora` = time-only epoch 1899) → espejar tal cual; la semántica se resuelve aguas abajo.
6. **Tamaño**: los `.mdb` full llegan a ~450 MB (PH 2025) — el full-scan hash de catálogos es barato, el de movimientos NO → por eso movimientos van por **watermark**, no hash.
7. **Access 97 no distingue** ediciones in-place en movimientos → si Wincaja edita un ticket viejo, el watermark no lo recaptura (aceptado, igual que el ctid de Kepler).
8. **On-prem only**: Jet 32-bit + `Z:` viven en la máquina de feeds (`.249`) → el loop corre ahí, como `WincajaSyncActual`. NO en Railway.

---

## 6. Decisiones (resueltas por Edgar 2026-08-18)

1. **Topología del destino ✅ DB centralizada `wincaja`** con **schema por sucursal** (`w30.*`, `w32.*`, `w00.*`, `w<ruta>.*`) en `:5433`. Una sola DB que gestionar; el schema separa las tablas homónimas (`MaestroMovAlmacen`…).
2. **Copia-sombra ✅ TODAS** las bases se copian (SyncBack) — 30/32/CEDIS-00/rutas. No hay que montar copia nueva.
3. **Rutas ✅ INCLUIDAS** en la réplica continua (traen la venta a bordo).
4. **Datasets**: `Concentradas` (actual) = objetivo continuo de WR. El histórico por año (`Z:\Salidas\Bases\<año>`) = one-shot (carga inicial, no CDC).
5. **WR.6** (re-apuntar el bronze a la réplica) queda como Fase 2 tras el MVP (WR.0–5).

---

## 7. Relación con Fase CA (un solo adapter)

WR y [`FASE_CA`](FASE_CA_CEDIS_ACCESS_ODS.md) (CEDIS Kepler-Access) son **el mismo problema** (Access 97 → Postgres, Jet + hash-delta) sobre esquemas distintos (Wincaja: `MaestroMovAlmacen`…; Kepler-Access: `kdXX`). **Conviene construir el adapter Access → Postgres una vez** (reader Jet + descubridor de esquema + CDC dos carriles + DDL espejo auto) y aplicarlo a ambos. Orden sugerido: hacer el adapter en la que arranque primero; la otra reusa.

---

## 9. WR.0 — hallazgos del descubrimiento (✅ 2026-08-18)

**Ubicación (copia-sombra, SyncBack):** `Z:\Salidas\Bases\Actuales\` — CEDIS Irapuato `0 BPIRAPUATO.mdb` (19.9MB) + `0 BPIRAPUATO MOV.MDB` (30.9MB, **2 archivos**: catálogo + movimientos), `30 MORELIA ABASTOS.MDB` (58MB), `32 MORELIA MADERO.MDB` (50MB), rutas `32 RUTA 321/322`, `21-28 RUTA` (PH), `50 RUTA 501-505` (Canindo). Histórico: `Z:\Salidas\Bases\Concentradas\` (285MB Morelia) + por año `Z:\Salidas\Bases\<año>` (one-shot).

**Esquema UNIFORME entre bases** (verificado 30 Morelia Abastos + CEDIS Irapuato-MOV, mismo Wincaja): **70 tablas** (~40 con datos). Tipos Jet: `Int32`/`String`/`Double`/`DateTime`/`Byte`/`Boolean`.

**Clasificación por carril:**
- **Incremental (watermark = `Consecutivo` Int32 monótono):** `MaestroMovAlmacen` (cabeceras: Consecutivo/Tipo/Documento/Tercero/Fecha/Hora/Almacen/Caja/Cajero/Vendedor/Cancelado…), `DetallesMovAlmacen` (líneas: Consecutivo/Articulo/CantidadRegular/ValorVenta/ValorCosto…), `MovimientoClientes`, `MovimientoProveedores`, `PagosDia`, `Retiros`, `Arqueos`, `Cortes` (Folio), `MaestroCotizaciones`/`DetalleCotizaciones`.
- **Hash-delta (catálogos mutables):** `Articulos` (~15.4k), `Existencias` (~15.4k), `Precios` (~90k), `Clientes`, `Proveedores`, `Categorias`/`Familias`/`Subfamilias`, `Ofertas`, `ArticulosRelacion`, `Productos`, `Vendedores`, `Cajas`/`Cajeros`.
- **Config chicas (full cada corrida):** `Almacenes`, `FormasPago`, `IVA`/`IEPS`, `Monedas`, `Unidades`, `Operaciones`, `Seguridad`.

**Notas para WR.1+:** (1) CEDIS Irapuato = 2 `.mdb` (base + MOV) → replicar ambos como `w00_base.*`/`w00_mov.*` o unir. (2) Rutas de Canindo `50 RUTA 50X` = la venta a bordo que **ya se migró a Kepler** (import-canindo-routes) → decidir si su `.mdb` entra a WR (histórico) o se omite. (3) Jet `GetOleDbSchemaTable(Columns/Primary_Keys)` es inestable → descubrir columnas con `SELECT * WHERE 1=0` (reader.GetName/GetFieldType), como el script `wincaja-schema-discovery.ps1`. (4) PS32 rompe con caracteres no-ASCII (em-dash) → scripts solo ASCII.

---

## 10. WR.1 — adapter de lectura Access (✅ 2026-08-18)

**El adapter único** (reusable WR + CA, [`FASE_CA`](FASE_CA_CEDIS_ACCESS_ODS.md)) vive en `database/importers/lib/`:

- `access-adapter.js` (Node): `discoverSchema(mdb)` · `readTable(mdb,t,{columns,where,orderBy})` · `readIncremental(mdb,t,{sinceCol,sinceVal})` · `query(mdb,sql)` · `jetToPg(jet)` · `rowHash(row)` (md5 canónico para el carril hash-delta).
- `access-read.ps1` (PS32): SELECT arbitrario o tabla → JSONL (ancestro `wincaja/extract-query.ps1`).
- `access-schema.ps1` (PS32): tablas + columnas + tipos Jet + **PK** + row counts → JSONL.

**Smoke real (30 Morelia Abastos):** 70 tablas / 41 con datos en 21s. **PK discovery SÍ funcionó** (contra la nota WR.0 de "inestable" — el `try/catch` lo hace robusto de todos modos):

| Tabla | filas | PK descubierta | carril |
|---|---|---|---|
| `Precios` | 89,987 | `[Articulo,NoPrecio]` | hash-delta |
| `DetallesMovAlmacen` | 88,754 | `[]` ⚠️ | incremental (por `Consecutivo`) |
| `MovimientoClientes` | 22,448 | `[]` ⚠️ | incremental |
| `Articulos` | 15,448 | `[Articulo]` | hash-delta |
| `Existencias` | 15,448 | `[Almacen,Articulo]` | hash-delta |
| `MaestroMovAlmacen` | 10,396 | `[Consecutivo]` | incremental |
| `Clientes` | 8,877 | `[Cliente]` | hash-delta |
| `PagosDia` | 16,287 | `[]` ⚠️ | incremental |

**Para WR.2 (DDL + conflict target):** las tablas de movimiento SIN PK declarada (`DetallesMovAlmacen`, `MovimientoClientes`, `PagosDia`, `DetalleCotizaciones`, `FaltantesDeCotizaciones`) necesitan **conflict-target por convención** — `DetallesMovAlmacen` se une a `MaestroMovAlmacen` por `Consecutivo` pero tiene N líneas → hará falta inspeccionar sus 25 columnas para el par `(Consecutivo, <renglón/artículo>)`. Las tablas CON PK (catálogos + `MaestroMovAlmacen`) usan su PK como conflict target directo. Tipos Jet vistos: `Int32`/`String`/`Double`/`DateTime`/`Byte`/`Boolean` → `numeric`/`text`/`boolean` (fechas como `text`, ISO desde el PS).

---

## 8. Relacionado

- [`FASE_W_WINCAJA.md`](FASE_W_WINCAJA.md) (bronze/silver/gold actual) · [`FASE_CA_CEDIS_ACCESS_ODS.md`](FASE_CA_CEDIS_ACCESS_ODS.md) (mismo adapter) · `project_fase_w_wincaja` · `project_logical_replication_kepler` (réplicas `kepler_md_XX`, el molde) · `project_canindo_wincaja_to_kepler` (Canindo salió de Wincaja).
