# FASE CA — CEDIS (Kepler Access 97) → Postgres / ODS

> Estado: 🔨 DISEÑO (planeación) — 2026-08-18
> Objetivo: traer el **CEDIS (sucursal `00`)** — cuyo Kepler corre sobre **Microsoft Access 97 (`.mdb`)** — al mismo pipeline `kepler_ods.*` que ya alimentan las 6 sucursales Postgres, para que **existencias y movimientos del almacén central** estén al día, y cerrar el gap de los consumidores que hoy leen un `md_00` Postgres **de prueba**.
> ADR asociado: **ADR-045 (propuesto)** — "El CEDIS Access se integra detrás de un adapter que replica el patrón Wincaja (Jet 32-bit read-only sobre copia-sombra) y alimenta el mismo sink `raw-upsert`; el `.mdb` es read-only, el estado CDC vive en Postgres". Hereda ADR-035 (feeds-ingest) y el diseño de dos carriles de `replicate-ods-live.js`.
> Hermano de: [`FASE_SYNC_TIEMPO_REAL.md`](FASE_SYNC_TIEMPO_REAL.md) (que cubrió las 6 ramas Postgres vía replicación lógica; esta cubre la 7ª fuente, que es Access y no puede replicar lógicamente).

---

## 0. El hallazgo que define el trabajo (verificado 2026-08-18)

- Las **6 sucursales 01-06** corren Kepler sobre **PostgreSQL** → ya están en replicación lógica nativa → `kepler_ods.*` al segundo (verificado: existencias y ventas al día, fidelidad al centavo).
- El **CEDIS (sucursal `00`)** — el **almacén central mayorista**, la fuente más consumida por Compras/Finanzas/Recepción/Cobranza — corre su Kepler sobre **Microsoft Access 97 (`.mdb`, Jet 3.5)**. Access **no** habla replicación lógica → quedó fuera del pipeline (`ODS_LIVE_BRANCHES` default `01..06`).
- El `192.168.9.95:5432/md_00` (Postgres) que hoy leen varios importers **es un experimento con data de prueba, no el CEDIS vivo** (confirmado en `project_logical_replication_kepler`). Consecuencia silenciosa: **hay consumidores leyendo datos que no son el CEDIS real** (bancos, cobranza, recepción, reorden, ajustes de compra).

**Meta de la fase:** el CEDIS Access entra a `kepler_ods.*` con `sucursal='00'` como una rama más, y los consumidores dejan de leer el `md_00`-prueba.

---

## 1. La buena noticia: casi todo ya existe

No se construye desde cero — se **ensamblan piezas probadas en prod**:

| Pieza | De dónde sale | Estado |
|---|---|---|
| Lectura Access 97 (Jet 4.0 **32-bit**, `Mode=Read`, copia-sombra) | patrón **Wincaja** — `database/importers/wincaja/extract-query.ps1` + `wincaja-live-extract.js` | ✅ prod |
| CDC sin `ctid` (hash-delta + watermark de negocio) | **carril hash** de `database/importers/kepler/replicate-ods-live.js` | ✅ prod |
| Ship al destino (`raw-upsert` → `kepler_ods.<tabla>` con col `sucursal`) | mismo sink de las 6 ramas (`database/importers/lib/sink.js`) | ✅ el destino ya soporta `sucursal='00'` |
| Monitoreo de frescura por sucursal | `db-health` `kepler_ods_branch_stale` (hoy **excluye** `00`) | ⚠️ requiere source propio del CEDIS |

Lo genuinamente nuevo: un **adapter Access** que alimenta el pipeline, y mover el **estado CDC (watermark + shadow de hashes) a Postgres** porque al `.mdb` no se le escribe.

---

## 2. Arquitectura objetivo

```
ORIGEN (CEDIS, on-prem)
  Kepler Access 97  D:\...\<cedis>.mdb  (VIVO — el POS del CEDIS escribe aquí; NUNCA abrirlo)
        │  SyncBack / robocopy open-file cada N min
        ▼
  Copia-sombra      <staging local>\cedis.mdb   (read-only para nosotros)

ADAPTER (máquina de feeds, on-prem)
  replicate-cedis-access-live.js
    ├─ Carril INCREMENTAL (movimientos append-only: kdm1,kdm2,kdij,kdue,kdpord)
    │     extract-query.ps1 (Jet 32-bit) SELECT ... WHERE <col_monótona> > watermark
    │     → ship 'raw-upsert' sucursal='00' → avanza watermark
    └─ Carril HASH-DELTA (catálogos mutables: kdil,kdii,kdik,kdig,kdud,kdid,kduv)
          extract-query.ps1 full-scan → md5(fila JSON) en JS
          → contra shadow en Postgres → ship SOLO el delta

  Estado CDC (watermarks + shadow):  Postgres del contenedor :5433
                                     (DB `kepler_cedis_state`, schema `ods`)

DESTINO (Railway)
  feeds-ingest (handler 'raw-upsert', gzip, ingress gratis)
        ▼
  kepler_ods.<tabla>  con sucursal='00'   ← MISMO destino que 01-06, cero cambios
```

---

## 3. Estrategia CDC (dos carriles, adaptados de Postgres a Access)

Access no tiene `ctid` ni replicación lógica, así que los dos carriles de `replicate-ods-live` se re-implementan sobre el extractor:

### 3.1 Carril incremental — movimientos grandes append-only
`kdm1`, `kdm2`, `kdij`, `kdue`, `kdpord`. Watermark sobre una **columna monótona de negocio** (folio/consecutivo/fecha; se descubre en CA.0). `SELECT … WHERE <col> > wm ORDER BY <col>`. Análogo al `ctid` pero por clave de negocio.
- **Limitación heredada aceptada:** un UPDATE in-place de un movimiento no se propaga (igual que el `ctid`). En movimientos es rarísimo.

### 3.2 Carril hash-delta — catálogos chicos mutables
`kdil` (existencias ⭐), `kdii` (productos), `kdik` (costo), `kdig` (marcas), `kdud`/`kdid`/`kduv`. Full-scan del `.mdb` → `md5(fila)` computado **en JS sobre el JSON extraído** → contra un **shadow en Postgres** → shipea solo el delta. Captura todo UPDATE (existencia/precio/costo). `kdil` ~5k filas = barato.
- **Clave:** el `md5` se calcula sobre la **representación JSON del Access** (no sobre el row Postgres) y el shadow guarda ese hash. Consistencia Access-JSON ↔ shadow-de-Access-JSON. **No mezclar** con el `md5(t::text)` de las réplicas Postgres.

### 3.3 Estado CDC en Postgres (el `.mdb` es read-only)
Watermarks (`ods.ctl`) + shadow de hashes (`ods.shadow`) en una DB de estado del contenedor `:5433` (mismo esquema `ods` que las réplicas usan co-locado). Descartable/reconstruible (`--full` re-shipea y reconstruye shadow).

---

## 4. Sprints

Estados: ⬜ TODO · 🔨 EN CÓDIGO · 🧪 PROBADO · 🚀 STAGING · ✅ PROD

| # | Sprint | Entrega | Estado |
|---|---|---|---|
| **CA.0** | **Descubrimiento del `.mdb`** ⛔ ruta crítica | Localizar el `.mdb` vivo del CEDIS + montar **copia-sombra** (SyncBack/robocopy c/N min → staging) + volcar esquema real: tablas (¿`kdm1/kdil/…`?), **PKs**, tipos, **tamaños** (nº filas + peso vs límite 2 GB), y la **columna incremental** de cada tabla grande. Confirmar que **Jet.OLEDB.4.0 32-bit** abre el archivo (ACE lo rechaza). **Entregable:** mapa tabla→carril + PK + col-watermark. | ⬜ |
| **CA.1** | Adapter de lectura Access | Extractor Kepler-Access (clon de `extract-query.ps1`, Jet 32-bit, `Mode=Read`) + wrapper Node `readTable(t,{sinceCol,sinceVal})` / `readAll(t)` + extractor de **PK/schema** del `.mdb` (`OleDbSchemaGuid`/`MSysObjects`). Reusa `runQuery()` de `wincaja-live-extract`. | ⬜ |
| **CA.2** | Carril incremental | `kdm1/kdm2/kdij/kdue/kdpord` por watermark → `raw-upsert` `sucursal='00'` → avanza watermark en `ods.ctl`. Dry-run vs `--apply`. | ⬜ |
| **CA.3** | Carril hash-delta | `kdil/kdii/kdik/kdig/kdud/kdid/kduv` full-scan + md5(JSON) en JS vs `ods.shadow` → ship delta. **Existencias del CEDIS = objetivo estrella.** | ⬜ |
| **CA.4** | Orquestador + cadencia | `replicate-cedis-access-live.js` (hermano de `replicate-ods-live.js`) orquesta ambos carriles + launcher `C:\KeplerRunner\run-cedis-access-loop.cmd` + tarea programada + `FEEDS_SINK=http`. | ⬜ |
| **CA.5** | Cutover + monitoreo | Seed inicial (full catálogos + watermark movimientos) → arranque de la tarea → **db-health source propio del CEDIS** (mide existencias/movimientos de almacén, **no** ventas POS; umbral propio) → verificación de **fidelidad Access↔`kepler_ods`** (conteos + Σ existencias, como se hizo con las réplicas). | ⬜ |
| **CA.6** | Migrar consumidores del `md_00`-prueba | Re-apuntar los importers que hoy leen `192.168.9.95:5432/md_00` → `kepler_ods sucursal='00'` (o un `kepler_md_00` landing derivado). **Cierra el gap "leen data de prueba" — mayor valor de fondo.** Ver §7. | ⬜ |

**MVP = CA.0–CA.5** (el CEDIS entra al ODS al día). **CA.6** paga la deuda de fondo.

---

## 5. Gotchas (ya vividos en el proyecto)

1. **Jet 4.0 32-bit obligatorio** (`C:\Windows\SysWOW64\WindowsPowerShell\...`) para Access 97 — **ACE 12/16 rechazan el formato 97** (ADR-031, vivido). El extractor de Finanzas (`movimientos-caja/extract-mdb.ps1`) usa ACE 64-bit → **NO** sirve acá; usar el patrón Wincaja (`extract-query.ps1`).
2. **Nunca abrir el `.mdb` vivo** → copia-sombra (SyncBack open-file / robocopy). Un lock/corrupción del POS del CEDIS es inaceptable. Frescura = cadencia de la copia + del loop.
3. **Límite 2 GB del `.mdb`**: si `kdm1/kdm2` históricos son grandes, verificar en CA.0 si Kepler archiva o hay que acotar ventana (watermark desde fecha reciente).
4. **md5 del shadow** sobre el **JSON extraído del Access**, consistente consigo mismo. No compararlo contra el hash de las réplicas Postgres.
5. **Fechas Jet** en `#M/D/YYYY#` (US) para el watermark — helper `jetDate()` ya existe en `wincaja-live-extract`.
6. **El CEDIS no vende al público** → su frescura NO se mide por ventas `c4=10` (el monitor `kepler_ods_branch_stale` ya excluye `00`); se mide por **existencias/movimientos de almacén**, con umbral propio (CA.5).
7. **Tipos numéricos** (Currency/Double de Access): el extractor emite el número, el destino `raw-upsert` castea. Cuidar que el JSON del shadow sea canónico (mismo formato entre corridas) para no marcar falsos delta.
8. **Hard-DELETE no se propaga** (UPSERT no borra) — limitación heredada de todo el ODS. Si el CEDIS borra productos/movimientos, no se refleja (aceptado).

---

## 6. Decisiones abiertas (resolver antes de CA.0)

1. **Copia-sombra**: ¿existe ya SyncBack/robocopy del `.mdb` del CEDIS Kepler, o hay que montarla? **¿Ruta del `.mdb` vivo?** (input operacional de Edgar).
2. **Cadencia**: recomendación **~1-5 min** (no al-segundo — el CEDIS no vende a público). Catálogos por hash-delta (barato) + movimientos por watermark.
3. **Alcance CA.6**: recomendación **incluirlo** — es donde está el valor (finanzas/compras dejan de leer data de prueba). Confirmar.

---

## 7. CA.6 — consumidores del `md_00`-prueba a migrar (inventario)

Importers/servicios que hoy apuntan a `192.168.9.95:5432/md_00` (verificado 2026-08-18) y deberán leer `kepler_ods sucursal='00'`:

- `database/importers/kepler/import-collections.js` (cobranza U-A-5).
- `database/importers/kepler/import-bank-postings.js` (`kdc2YYMM` 102%).
- `database/importers/kepler/import-kepler-bank-movements.js` (tesorería `kdm1⋈kdb1`).
- `database/importers/kepler/import-purchase-adjustments.js` (X-D-40/55).
- `database/importers/kepler/import-goods-receipts.js` (multi-sucursal, incluye `00`).
- `database/importers/kepler/import-reorder-policy.js` (reorden lee `md_00`).
- `database/importers/import-catalog-bulk.js` + `_diag-catbulk.js` (catálogo/costo).
- `database/importers/kepler/import-product-sales-daily.js` (incluye `00`).
- Mapa central `database/importers/lib/kepler-branches.js` L29 — cambiar la fuente de `00` de Postgres a "vía ODS".

**Nota:** parte de la existencia del CEDIS hoy viene de **Wincaja Irapuato** (`import-cedis-stock-wincaja`), no de Kepler `md_00` (ver `import-branch-stock-live.js:52`). CA.6 debe reconciliar cuál es la fuente autoritativa de existencia del CEDIS (Kepler Access vs Wincaja) — decisión de CA.0/CA.6.

---

## 8. Relacionado

- [`FASE_SYNC_TIEMPO_REAL.md`](FASE_SYNC_TIEMPO_REAL.md) · [`FASE_W_WINCAJA.md`](FASE_W_WINCAJA.md) (patrón Access) · `project_logical_replication_kepler` · `reference_kepler_branch_databases` · `reference_prod_db_connection_topology` · `project_onprem_feeds_hang_pattern`.
