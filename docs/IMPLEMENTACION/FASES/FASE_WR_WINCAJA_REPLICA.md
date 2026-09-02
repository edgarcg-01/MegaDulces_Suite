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
| **WR.2** | Destino réplica + DDL espejo | Crear `wincaja_XX` (o schema-por-sucursal) en `:5433` + auto-generar el DDL espejo desde el esquema Access (tipos → `text`/`numeric` sin precisión, **tolerante a valores corruptos** — el saneamiento vive en silver, no en la réplica cruda). | ✅ (w30/w32/w00, 70 tablas c/u) |
| **WR.3** | CDC dos carriles | Carril incremental (movimientos por watermark) + carril hash-delta (catálogos md5-en-JS vs shadow). Estado en schema `ods`. | ✅ (3 sucursales cargadas+verificadas) |
| **WR.4** | Orquestador + tarea continua | `replicate-wincaja-live.js` (hermano de `replicate-ods-live`) orquesta sucursales × tablas × carriles + `--watch=N` + launcher `.cmd` + tarea `WincajaLiveLoop` (continua). | ✅ (tarea `WincajaReplicaLoop` 15 min) |
| **WR.5** | Verificación + monitoreo | Fidelidad `.mdb` ↔ réplica (conteos + Σ montos, como se hizo con Kepler) + **db-health source** (frescura de la réplica Wincaja). | ✅ fidelidad (db-health source diferido) |
| **WR.6** | Re-apuntar consumidores (Fase 2) | `import-wincaja` + extractores leen de la **réplica Postgres** (SQL) en vez de Jet → el bronze deja de depender de la extracción Jet full-daily; el `WincajaSyncActual` 05:00 se retira o se vuelve micro-batch sobre la réplica. | 🧪 (flag `--source replica`; 30/32/00; daily apuntado) |

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

## 11. WR.2–5 — motor de réplica (código completo, live pendiente de Docker) 2026-08-18

**Archivos:**
- `lib/access-mirror.js` (genérico WR+CA): `mirrorDDL` (PK natural o `UNIQUE(_row_hash)`) + `conflictTarget` + `dataColumns`.
- `wincaja/wincaja-replica-config.js`: 3 sucursales (30/32/00) + mapa `INCREMENTAL` (6 tablas watermark) vs hash-delta.
- `wincaja/wincaja-replica-ddl.js` (WR.2): `ensureDatabase` + `CREATE SCHEMA` + DDL espejo. **DB `wincaja` + `w30` (70/70 tablas) aplicados.**
- `wincaja/replicate-wincaja-live.js` (WR.3+4): CDC dos carriles. Incremental = `WHERE Consecutivo/Folio > wm` → UPSERT + avanza `ods.wincaja_watermark`. Hash-delta = full-scan + `md5(fila)` en JS → UPSERT `WHERE _row_hash IS DISTINCT` (cero churn). Surrogate `_row_hash` → `DO NOTHING`. Flags `--dry/--once/--watch=N/--branch=/--only=`.
- `wincaja/wincaja-replica-verify.js` (WR.5): conteos `.mdb` ↔ espejo + Σ de control (ValorVenta/Existencia/Precio).
- `wincaja/run-wincaja-replica.ps1` (WR.4): launcher per-tick `--once` + heartbeat `wincaja_replica` + nota de tarea `WincajaReplicaLoop` (cada 5 min, IgnoreNew, timeout 5 min).

**BLOQUEADOR live:** el contenedor `pgvector-md` (`:5433`) estaba **caído** al probar (Docker Desktop apagado) → falta correr end-to-end. Pendiente cuando `:5433` vuelva: (1) `replicate-wincaja-live.js --branch=30 --once` (carga inicial + verifica), (2) `wincaja-replica-verify.js --branch=30`, (3) aplicar DDL + carga a 32/00, (4) agendar `WincajaReplicaLoop`.

**Deferred:** reconciliación de DELETEs en catálogos (el full-scan hash-delta captura INSERT/UPDATE, no borrados) → barrido periódico por diff de PK (WR.5.1). Rutas → tras probar 30/32.

---

## 12. WR MVP 🟢 EN VIVO (WR.0–5) — 2026-08-18

Réplica cruda continua operando en `:5433/wincaja`, 3 sucursales:

| Schema | Sucursal | Filas | Fidelidad (Σ de control) |
|---|---|---|---|
| `w30` | Morelia Abastos | 305,412 | ΣValorVenta $10,443,778.53 ✓ · ΣPrecio $6,358,296.77 ✓ (67/70 exactas) |
| `w32` | Morelia Madero | 286,885 | ΣValorVenta $4,862,614.28 ✓ · ΣPrecio $6,367,855.85 ✓ (69/70) |
| `w00` | CEDIS Irapuato | 214,939 | ΣValorVenta $153,594,831.67 ✓ · ΣPrecio $6,368,520.28 ✓ (69/70) |

- **Deltas de −1..−15 filas** = filas byte-idénticas de valor $0 colapsadas por el surrogate `_row_hash` (las Σ cuadran al centavo → cero pérdida real).
- **CEDIS 00**: el archivo bueno es `0 BPIRAPUATO MOV.MDB` (DB completa + movimientos); el `0 BPIRAPUATO.mdb` es catálogo viejo con movimientos=0 → se ignora (config corregida).
- **Steady-state**: catálogos ~3.6 min/sucursal (full-scan Jet, `wrote=0` cero churn); movimientos ~11s/sucursal (incremental, solo filas > watermark).

**WR.5.1 ✅ split de carriles (frescura real):** flag `--carril=inc|hash|all` en `replicate-wincaja-live.js` + `-Carril` en el launcher → **dos tareas**:
- **`WincajaReplicaMov`** (`-Carril inc`, movimientos/ventas) cada **3 min** (ciclo 3-suc ~35s) → frescura de ventas ~3 min.
- **`WincajaReplicaCat`** (`-Carril hash`, catálogos) cada **60 min** (timeout 20, ciclo ~11 min).
Escriben tablas disjuntas (inc vs hash) → sin contención. Ambas `SISTEMAS\Desarrollo MD` Interactive Highest, IgnoreNew.

**WR.6 ✅ re-apuntado del bronze:** flag `--source replica` en `import-wincaja.js` — para `--dataset actual`, las sucursales con espejo (30/32/00) leen de `:5433/wincaja` por SQL (~seg; ej. 90k Precios en 454ms vs Jet ~5s por tabla); las demás (10/40/44/54 + rutas) caen a Jet automáticamente. `mapRow` compartido (coerce+derive idéntico) → cero divergencia; resolución de columnas case-insensitive (Postgres es case-sensitive). `sync-wincaja-actual.ps1` (daily 05:00) ya usa `--source replica`. Dry-run branch 30 = 27 tablas OK, valores verificados. **Falta:** correr un `--apply` real contra prod bronze para cerrar 🧪→✅ (lo hace el próximo daily, o `--source replica --apply` manual).

**WR.7 ✅ falla fuerte en vez de girar en cero (2026-08-31, commit `3ff49337`):** del **27 al 31 de agosto la réplica estuvo 4 días sin mover un dato mientras `pm2 ls` decía "online"** — los dos carriles ciclaban puntuales reportando "0 tablas" en las 3 sucursales. No fue una falla sino **tres que se tapaban entre sí**:

1. **`branchSchema()` cacheaba el descubrimiento VACÍO.** Sin alcanzar `Z:` devolvía 0 tablas, lo cacheaba y no reintentaba nunca — ni volviendo la red se curaba sola. Ahora un esquema vacío **tira y no se cachea**.
2. **El heartbeat abortaba** por falta de `DATABASE_URL_NEW` (PM2 no hereda el entorno del shell de forma confiable) → lo único que podía avisar estaba roto. El ecosystem la pasa explícita y **falla al cargar** si no está; el replicador se niega a arrancar en watch sin destino de heartbeat, en vez de correr a ciegas.
3. **Una sucursal caída cortaba el ciclo entero** (30 fallaba → 32 y 00 ni se intentaban). Ahora se aísla por sucursal y el ciclo reporta cuántas fallaron.

Además: **preflight de la fuente en cada ciclo** (no sólo al arrancar → se cura sola cuando el share vuelve, sin reiniciar PM2); en watch un primer ciclo fallido ya no mata el proceso (PM2 quemaría sus `max_restarts` en minutos y quedaría "errored"). Verificado: `--dry` sale con **exit 1** y mensaje claro donde antes imprimía "0 tablas" y salía con **exit 0**.

**Causa raíz de fondo — `Z:` es una unidad MAPEADA:** los mapeos de Windows son **por sesión de login**; un servicio, una tarea como SYSTEM o un PM2 levantado en otra sesión puede no verla nunca. El mensaje de error ahora lo explica y recomienda **UNC** (`\\servidor\share\...`) en `WINCAJA_MDB_BASE`.

**Lección:** todos los chequeos que teníamos eran de **proceso vivo**, y el proceso estuvo vivo los 4 días. Un descubrimiento vacío nunca es un estado válido — es la fuente inalcanzable disfrazada de éxito.

**El sensor de datos SÍ funcionó (y ahí está el hueco real):** `wincaja_branch_stale` estaba en **critical con 154 h** (umbral 72 h) y llevaba **18.9 días abierta**, junto a otras 23 alertas — **ninguna reconocida**. La detección fue perfecta; falló el último tramo: el WS emite **sólo en transiciones**, así que el toast salió una vez hacia quien tuviera la pestaña abierta y después silencio. Sumado a que el scanner itera todos los tenants (3 de 4 son de prueba → 6 alertas reales se ven como 24), la bandeja se volvió tapiz. Ver `project_db_health_alerts`.

**Comparación que decide el rumbo:** el mismo día, **MD-32 empujaba en vivo** por `wincaja-store-agent.ps1` (agente que corre **en el servidor POS**, lee el `.mdb` local read-only, **no necesita drive mapeado**) mientras su réplica por `Z:` llevaba 6 días muerta. La misma tienda, viva por un transporte y muerta por el otro.

**Diferido:**
- **WR.5.2** — db-health source (frescura de la réplica en el tablero de salud).
- **WR.6.1** — sumar 10/40/44/54 (+rutas) a la réplica → más sucursales salen de Jet.
- Reconciliación de DELETEs en catálogos (barrido por diff de PK).
- **WR.8** — extender el agente-POS de tickets a las **12 tablas base** que alimentan las vistas que consume la app (`v_sales_daily`, `v_lost_demand`, `v_stock`, `v_ar_customer`, `v_cash_authorizations`, `mv_branch_kpis`) → mata la dependencia de SMB. No son 70 tablas.
- **MD-30**: tiene el agente desplegado pero **muerto desde el 13-ago** (447 h sin empujar) — sin diagnosticar.
- **Último tramo de alertas**: entrega out-of-app (Web Push / WhatsApp / correo) + sacar tenants de prueba del barrido. Es el cuello de botella real de la observabilidad, no faltan sensores.

---

## 13. WR-hist — el corpus HISTÓRICO a Postgres (🔨 en carga, 2026-09-01)

Decisión Edgar 2026-09-01: **mudar Wincaja actual e histórico a Postgres**, con tres definiciones —
el crudo completo vive **LOCAL** (a prod sólo suben agregados), alcance **2017–2025** primero, y las
**70 tablas** crudas. Más una directiva de orden: *"priorizar lo actual de prod, de reciente a viejo"*.

### 13.1 De dónde partíamos (medido)

| capa | dónde | cubría |
|---|---|---|
| bronze `wincaja.*` (28 tablas curadas) | Railway prod, 4.2 GB | `actual` = 21 sucursales · `concentrada` = 10/30/32/50 · `2025` = 18 sucursales |
| réplica cruda (70 tablas) | local `:5433/wincaja`, 615 MB | sólo `w00`/`w30`/`w32`, sólo `Actuales` |

**2026 sí estaba en prod**, pero dentro del corte `actual` (ene–ago 2026, 65–85k movs/mes), no como
corte propio. Ojo: la cobertura cae de 20 sucursales en enero a 9 en agosto — consistente con las
migraciones a Kepler, pero **sin verificar**. Y hay fechas basura (`2029-08-03` en el corte 2025,
`2026-12-06` en `actual`), igual que en Kepler: `max(fecha)` no sirve como señal de frescura.

Corpus en `Z:\Salidas\Bases`: `2017`–`2025` = **187 archivos / 22.4 GB** + `Actuales` (23) +
`Concentradas` (10) + `Cierres` (368 MB) + `2009`–`2016` en **8 `.7z`** (~960 MB comprimidos, 7-Zip
está instalado). Total del alcance actual: **206 unidades / 23.4 GB**.

### 13.2 Los dos hechos que definieron el diseño

**1. Cada carpeta `<año>` es el corte de ESE año, no un acumulado.** Verificado en la sucursal 32:

| archivo | cabeceras | rango de `Fecha` |
|---|---|---|
| `2017/32 MORELIA MADERO.MDB` | 121,980 | 2017-01-02 → 2017-12-31 |
| `2021/…` | 86,300 | 2021 (+ centinelas 2000-01-01) |
| `2025/…` | 129,760 | 2025 |

**2. El `Consecutivo` REINICIA en 1 cada año** — 2021 va `1..89,586` y 2025 va `1..129,760`: tickets
distintos con el mismo número. Por eso **el corte es parte obligatoria de la identidad**. El bronze
ya lo había resuelto con `source_dataset` en el PK; acá se replica el criterio con `_dataset`.

### 13.3 La herramienta: mdbtools, no Jet

El primer motor (Jet+PS32+INSERT, reusando `access-adapter.js`) funcionaba y era fiel, pero tardaba
**554 s** por archivo de 70 MB → ~49 h para el corpus. El benchmark mostró que **Postgres no era el
cuello**: escribir las 152,718 filas de `DetallesMovAlmacen` tardaba 16–31 s, contra ~129 s de
lectura. El cuello era `ConvertTo-Json` **por fila** en PowerShell.

**mdbtools** (C, lee Jet 3/4 directo, sin Jet ni PowerShell ni dependencia de 32 bits) corre en un
contenedor Docker — no se instala nada en la máquina. Contra el MISMO archivo:

| | Jet + PS32 + INSERT | mdbtools + COPY |
|---|---|---|
| las 70 tablas | 554 s | **156 s** (3.5×) |
| sólo el export | ~490 s | 91 s |
| `DetallesMovAlmacen` (152k filas) | 160 s | 15 s |
| filas / ΣValorVenta | 469,609 / $7,629,584.75 | **idénticos, al centavo** |

Dos trampas que costaron una iteración cada una:
- **Un contenedor por tabla mata la ventaja**: `docker run` cuesta ~1.5 s, y con 2 llamadas por tabla
  (header + export) × 70 se iban ~4 min por archivo. Se colapsó a **un contenedor por archivo**
  (`mdb-tools.dumpAll`: versión Jet + tablas + esquema + un CSV por tabla, todo de una).
- **Escribir los CSV al bind-mount de Docker Desktop cuesta el doble** (128 s vs 67 s): `mdb-export`
  emite en chunks chicos y cada uno cruza el puente de archivos de Windows. Se escribe en `/tmp` del
  contenedor y se copia todo junto al final.

Y una que mentía sin fallar: **`psql -q` se calla el `COPY n`** → el conteo de filas volvía 0 en todas
las tablas mientras la carga estaba perfecta. El reporte mentía, no el dato.

### 13.4 Arquitectura del carril histórico

```
Z:\Salidas\Bases\<corte>\NN NOMBRE.MDB
      │ copia local (~5.2 MB/s medido; Jet/mdbtools sobre SMB es inviable: un scan
      │ sobre el archivo de 559 MB llevaba >17 min sin terminar)
      ▼
  <STAGE>\hNN_<corte>.mdb
      │ UN contenedor mdbtools: mdb-ver + mdb-tables + mdb-schema --indexes + 70 CSV
      ▼
  <STAGE>\hNN_<corte>_csv\{0..69}.csv  +  _schema.sql  +  _tables.txt
      │ psql \copy → zstg.hNN__<Tabla> (UNLOGGED, todo text)
      ▼
  un solo INSERT..SELECT con cast + md5(fila) server-side
      ▼
  :5433/wincaja  →  hNN.<Tabla>  (identidad (_dataset, _row_hash))
```

- **Identidad = surrogate `(_dataset, _row_hash)`, nunca la PK natural.** Vivido en la primera unidad
  de la corrida: mdbtools reporta PK sobre `ArticulosRelacion.CodigoBarras` y **los propios datos la
  violan** (hay NULLs). Access declara índices que su contenido no respeta, y el espejo crudo no está
  para discutirle a la fuente. Se puede porque este carril es un append de cortes inmutables: no hay
  UPDATE que aplicar. La PK declarada queda anotada en el `COMMENT` de la tabla.
- **Drift de esquema entre cortes**: 9 años de versiones de Wincaja → se agregan las columnas que
  falten y, si el tipo choca, se **ensancha a `text`** (nunca se angosta).
- **Ledger `ods.wincaja_hist_load`** (schema, corte, tabla, filas, estado, lector) → la carga es
  reanudable e idempotente. `--force` borra la partición antes de recargar; hace falta al cambiar de
  lector, porque el `_row_hash` depende de él.
- **`Actuales` saltea 30/32/00**: ya las mantiene el carril vivo, más fresco. `--include-live` fuerza.

### 13.5 Prioridad de carga

`Actuales` → `Concentradas` → `2025` → `2024` → … → `2017`, y dentro de cada corte por relevancia
para prod (espejo de `wincaja.branches.status`): `live_on_wincaja` (00/30/32/50) → `transition` (10)
→ rutas → `legacy_on_kepler` (40/42/44/54) → las que ya no existen (20/24/25/51/70/300/301/CEDIS B).
Así lo que le falta a prod entra en la primera hora, no en la hora 14.

El histórico trae **sucursales que hoy no existen** — `20 COMISIONISTAS`, `70 TELEMARKETING`,
`51 CANINDO RD`, `CEDIS B`, rutas `24/25/300/301` — y eso es justamente parte del valor.

### 13.6 Archivos

| Archivo | Qué |
|---|---|
| `lib/mdbtools.Dockerfile` | imagen `mdbtools:local` (Debian slim + mdbtools 1.0.1) |
| `lib/mdb-tools.js` | adapter bulk: `ensureImage` · `dumpAll` · `describeFromCsv` · `schemaRaw` |
| `lib/access-read-bulk.ps1` | lector Jet alternativo (TSV con StringBuilder, sin `ConvertTo-Json`) — quedó como reserva; mdbtools lo superó |
| `wincaja/wincaja-hist-config.js` | inventario del corpus + prioridad + parser de nombres de `.mdb` |
| `wincaja/import-wincaja-hist.js` | el cargador (`--apply`, `--year`, `--branch`, `--force`, `--reader=mdbtools\|jet`) |
| `wincaja/wincaja-hist-verify.js` | (A) ledger vs espejo · (B) **cruce contra el bronze de prod**, que se cargó con OTRO lector desde la misma fuente |

`lib/access-mirror.js` recibió dos cambios **aditivos** (default apagado → el carril vivo no cambia):
`extraKeys` para prefijar columnas de partición a la identidad, y aceptar un tipo Postgres ya
resuelto (`c.pg`) además del tipo Jet crudo (`c.jet`).

### 13.7 Pendiente

- Terminar la corrida (206 unidades, ~14 h estimadas) y correr `wincaja-hist-verify.js`.
- Confirmar la caída de cobertura de sucursales de ene→ago 2026 en el corte `actual` de prod.
- `2009`–`2016`: descomprimir los `.7z` y revisar drift de esquema (Wincaja más viejo) antes de cargar.
- Los agregados que suben a prod desde el histórico local (la mitad "híbrida" de la decisión).
- **Fase CA** (CEDIS Kepler-Access) puede reusar mdbtools tal cual: mismo Jet3, otro esquema.

---

## 14. WR.8 — el agente-POS alimenta la BD, no sólo la pantalla (🔨 8.0+8.1 en código, 2026-09-01)

### 14.1 Por qué: el diagnóstico de frescura

Medido el 2026-09-01 a las 16:17 MX, el mismo dato por dos transportes:

| camino para MD-30 / MD-32 | último dato |
|---|---|
| **agente-POS** → `analytics.store_live_tickets` | **hoy 17:57** (minutos) |
| SMB `Z:` → bronze `wincaja.maestro_mov_almacen` | **30-ago** (2 días) |

La tienda vendió hoy. El feed corrió hoy a las 05:03 y está `ok`. Lo que está viejo es **la
copia-sombra que lee**: el `.mdb` en `Z:` se escribió a las 11:13 — *después* de que el ingest de las
05:03 lo leyera, así que el batch siempre ingiere una copia de ~18 h antes. Todo verde, dato viejo:
la misma clase de falla de WR.7.

Y hay **tres** alimentadores de `store_live_tickets`, sólo uno realmente vivo:

| alimentador | corre en | lee de | frescura |
|---|---|---|---|
| **`wincaja-store-agent.ps1`** | **el servidor POS** | el `.mdb` **VIVO local**, `Mode=Read` | **minutos** |
| `kepler/live-tickets-poller.js` | on-prem | `kepler_ods` (CDC) | minutos |
| `wincaja-tickets-poller.js` | on-prem | **el bronze ya importado** | hereda el atraso del batch |

El tercero lo confiesa su propio header. Es el que tapa el problema sin resolverlo.

También: **MD-30 está vivo** (contra la nota de WR.7 que lo daba por muerto desde el 13-ago), y el
**CEDIS `00` no tiene ningún camino vivo** aunque siga `live_on_wincaja`.

### 14.2 La tesis: el delta lo calcula Postgres, no la caja

`raw-upsert` (el handler que ya usa el CDC de Kepler) hace **UPSERT SIN CHURN**:
`ON CONFLICT … DO UPDATE … WHERE IS DISTINCT FROM` → una fila que no cambió **no se reescribe**.
Verificado: segundo push idéntico de `Existencias` (14,873 filas / 248.6 KB gzip) → `rowCount=0`.

Eso significa que **el POS no necesita hash-delta**. En el ODS de Kepler el hash existe para no pagar
egress desde la sucursal; acá la dirección (ingress a Railway) es la gratis. La caja sólo lee y manda;
el trabajo caro corre donde hay un motor de verdad. Y PowerShell **no puede** hacer trabajo por fila:
`ConvertTo-Json` por fila es exactamente lo que costó 8× en el lector Jet.

### 14.3 WR.8.0 — habilitación (✅ código + compuerta)

- `raw-upsert` acepta `meta.schema` contra whitelist `{kepler_ods, wincaja_ods}`. Default sin cambios
  → el carril Kepler no se entera. `_sync_status` pasa a ser **por schema**, y sólo el carril nuevo
  lleva sucursal en la llave (`Existencias@44`): cambiarla en `kepler_ods` le rompía el sensor a
  `db-health`, que ya lee esas llaves.
- **Dos bugs de CamelCase** que el carril Kepler nunca pisó porque sus columnas son `c1`/`c2`:
  `to_regclass` sobre un literal sin comillas baja el nombre a minúsculas → daba `null` para
  `Existencias` aunque existiera y el handler intentaba re-crearla; y `copyIntoTemp` insertaba sin
  citar → `column "almacen" of relation "stg_raw" does not exist`.
- `wincaja-ods-lib.ps1` — el sink sin Node: Jet `Mode=Read` → JSONL a mano con StringBuilder →
  GZipStream → POST. Resuelve los nombres de PK **case-insensitive** contra las columnas reales,
  porque Access es inconsistente (`Cortes` tiene `caja`, `Retiros` tiene `Caja`).
- `wincaja-feed-push.ps1` — CLI de una tabla (pruebas y empujes puntuales).

### 14.4 WR.8.1 — carril de movimientos (🔨 código + probado en estado estable)

`wincaja-ods-agent.ps1`: hermano del agente de tickets (que sigue igual, alimentando `/tienda/live`).
Dos carriles como el ODS, y la cadencia escalonada **por tamaño de tabla, no por tipo**:

| carril | tablas | llave | cadencia |
|---|---|---|---|
| incremental | `MaestroMovAlmacen` `DetallesMovAlmacen` `PagosDia` `Arqueos` `Cortes` `Retiros` | watermark `Consecutivo`/`Folio` | ~1 min |
| snapshot | `Existencias` (15.5k) · `Articulos` `Clientes` · `Ofertas` `Precios` (90k) | PK natural | 15 / 60 / 720 min |

**PKs verificadas contra la réplica** (índices reales descubiertos por Jet), no de memoria.

**`DetallesMovAlmacen` no tiene llave natural** y el hallazgo explica por qué:
`(Consecutivo, Articulo)` deja 0.04–0.15% de renglones repetidos, y al abrirlos son **venta mixta del
mismo SKU** — una línea en caja (`UnidadVenta=1`) y otra en pieza (`UnidadVenta=0`). Ese es el
mecanismo concreto detrás de la trampa del flag `unidad_venta`. Ni sumando `TipoPrecio` cierra
(quedan 34/7/14 filas) → la llave es `(Consecutivo, Articulo, UnidadVenta, _row_hash)`: prefijo
legible + hash de desempate. El hash sólo se calcula donde no hay PK natural, y ahí el delta son
cientos de filas por ciclo; los catálogos de 90k tienen PK y no hashean.

**Tres cosas que salieron de probarlo, no de diseñarlo:**

1. **La ventana tiene que tener tope.** Sin `chunk`, la primera pasada de `DetallesMovAlmacen`
   (152k filas) se llevó **más de 10 minutos** — inaceptable en una caja de producción. El tope va
   sobre el **valor de la llave**, no sobre el número de filas: un `Consecutivo` tiene N renglones y
   capar por filas cortaría un ticket a la mitad. Corolario: **la carga inicial no va por este
   carril** — se prima con el camino rápido (mdbtools+COPY) y el agente arranca desde ese watermark.
2. **El contador del origen REINICIA.** Wincaja archiva al cierre de año y el `Consecutivo` vuelve a
   1 (verificado en las carpetas por año: 2021 va `1..89,586` y 2025 va `1..129,760`). Con el
   watermark alto, `> wm` no devuelve **nada nunca más** y el carril queda mudo sin fallar. El agente
   lo detecta con un `MAX()` — y sólo cuando la ventana vino vacía, así no se paga el scan en el
   camino feliz. ⚠️ **El agente de tickets tiene el mismo hueco** y no lo detecta: al cierre de año
   `$ci -le $sinceCons` descarta todo y la tienda se va a silencio.
3. **El estado se escribe por tabla, no al final del ciclo.** Si el ciclo muere a la mitad, lo ya
   empujado no se re-empuja. Es idempotente igual, pero re-leer el `.mdb` de una caja no es gratis.

**Probado end-to-end** contra una instancia local de `feeds-ingest` (sin tocar prod), sobre un `.mdb`
real: ciclo de estado estable en **16 s**, con `MaestroMovAlmacen` mandando 885 filas y
`cambiaron=0` (churn cero también en el carril incremental). Fidelidad contra el lector independiente
(mdbtools+COPY sobre el mismo archivo): `MaestroMovAlmacen` **48,560 = 48,560**, `PagosDia`
**80,415 = 80,415**, `Cortes` **740 = 740**.

### 14.5 Pendiente de WR.8

- **Desplegar `services/feeds-ingest`** con el handler nuevo. Prod corre el viejo: hoy un push con
  `meta.schema` desde una caja escribiría en `kepler_ods`. Es el bloqueante para salir de local.
- **Desplegar el agente en el CEDIS `00`** (no tiene camino vivo) y en 30/32 junto al de tickets.
- **`MovimientoClientes` / `MovimientoProveedores` quedan fuera**: no tienen PK natural **y su
  `Saldo` muta** → con `_row_hash` por llave, un cambio insertaría fila nueva en vez de actualizar.
  Hay que identificar su llave real antes de entrarlas (WR.8.3).
- WR.8.4 ventana de reconciliación (tapa DELETEs y ediciones retroactivas, que ningún watermark ve).
- WR.8.5 cutover: `wincaja.*` pasa a derivarse de `wincaja_ods` y se retira el batch 05:00 + `Z:`.
- `deploy-wincaja-agent.ps1` **embebe una copia** del agente de tickets como here-string → el archivo
  canónico y el desplegado pueden driftear. Al tocar el agente hay que actualizar los dos.

---

## 8. Relacionado

- [`FASE_W_WINCAJA.md`](FASE_W_WINCAJA.md) (bronze/silver/gold actual) · [`FASE_CA_CEDIS_ACCESS_ODS.md`](FASE_CA_CEDIS_ACCESS_ODS.md) (mismo adapter) · `project_fase_w_wincaja` · `project_logical_replication_kepler` (réplicas `kepler_md_XX`, el molde) · `project_canindo_wincaja_to_kepler` (Canindo salió de Wincaja).
