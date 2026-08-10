# FASE SYNC — Sincronización en tiempo (casi) real de TODA la BD espejo del ERP

> Estado: 🔨 DISEÑO (planeación) — 2026-08-10
> Objetivo: que **todas las tablas que espejan Kepler + Wincaja** en el Postgres de Railway
> estén frescas al minuto, **sin reintroducir el costo** que en 2026-07 causó el incidente de ~200 GB/mes de egress.
> ADR asociado: **ADR-035 (propuesto)** — "El escritor vive dentro de Railway; on-prem solo empuja deltas por ingress gratis".

---

## 0. El hecho que habilita todo (verificado 2026-08-10)

Railway: **ingress (entrante) = gratis**, **egress (saliente) = $0.05/GB**, **tráfico interno `*.railway.internal` = gratis**.

Consecuencia de diseño: el camino caro de hoy es que el runner on-prem escribe al Postgres **por el proxy público** (`*.proxy.rlwy.net`) — las **respuestas** del Postgres (ACKs, `RETURNING`, resultados de `SELECT` de reconciliación, TLS) **salen** de Railway y se facturan como egress. La solución es mover el *escritor* adentro de Railway: on-prem solo **empuja** el delta (ingress, gratis) y un servicio interno escribe por red privada (gratis).

---

## 1. Reencuadre: "toda la BD fresca" = 3 capas

Las tablas del Postgres de Railway caen en 3 orígenes; cada uno se mantiene fresco distinto:

| Familia | Ejemplos | Se actualiza desde | Estado hoy | Meta |
|---|---|---|---|---|
| **Nativas del app** | `commercial.orders`, portal, vendor, `finance.findings`, aprobaciones | La propia app, en el momento | Ya al segundo | Sin cambio |
| **Espejo del ERP** | stock, ventas, catálogo, precios, proveedores, clientes, movimientos, contable, logística | Feeds Kepler/Wincaja | 15 min → nightly | **Al minuto (esta fase)** |
| **Derivadas** | rotación, ABC, reorder/DRP, márgenes, MVs analytics | Se **calculan** de las anteriores | Nightly | Recompute por cambio / micro-batch |

**Frescura ≠ frecuencia de trabajo.** Con delta/CDC solo se hace trabajo cuando algo cambió: mantener catálogo "al minuto" cuando nadie lo tocó cuesta ~0.

---

## 2. Arquitectura objetivo

```
CAPA 1 — Espejo crudo vivo (on-prem, gratis, NO toca Railway)
  6 sucursales Kepler ─► KP_CONCENTRADA (.245)  = ~330 tablas md.* espejadas (watermark)
  Wincaja .mdb        ─► wincaja.* bronze        = 21 tablas (Jet 32-bit)
  Decisión Capa 1 (Edgar 2026-08-10): LOOP WATERMARK CONTINUO (reusar lo existente,
    bajar KP-Concentrate + RefreshConsolidado a ~1 min). CDC/replicación lógica = diferido.

CAPA 2 — Transform + push (on-prem → Railway; INGRESS = gratis)
  Cada feed lee del espejo local, calcula su changeset (upserts + delete-scope)
  y lo POSTea gzip al servicio interno "feeds-ingest".
  Disparo por cambio (change marker que ya existe) en loop corto.

CAPA 3 — Derivadas (dentro de Railway; sin egress, sí cuesta CPU/RAM)
  Al llegar un changeset se marca "dirty" la derivada que depende de esa fuente.
  Un worker recomputa SOLO lo dirty (incremental) o en micro-batch cada N min.
```

---

## 3. Fase 1 — servicio `feeds-ingest` (el corazón)

### 3.1 Por qué servicio dedicado (no endpoint en el API)
El API ya sufre OOM → ECONNRESET/502 (ver `project_onprem_feeds_hang_pattern`). Meter ingest pesado ahí lo tumba. `feeds-ingest` es un servicio Railway aparte, chico, aislado en memoria, en el **mismo proyecto** (comparte red interna con el Postgres).

### 3.2 Contrato HTTP
- `POST /ingest/:table`
  - Auth: header `X-Ingest-Key` (secret en env, distinto del JWT del app).
  - Body: **gzip** de JSONL. Primera línea = metadata del changeset, resto = filas.
  - Metadata: `{ pk: ["tenant_id","id"], compare: [...cols...], delete_scope: {col:val}|null, batch_id }`.
  - `delete_scope`: si viene, se borran las filas de ese scope que **no** aparezcan en el changeset (reconciliación por ventana/partición, como hoy). Si es `null`, upsert-sin-delete.
- Respuesta: `{ ok, upserted, deleted, ms }` (payload minúsculo → egress despreciable).

### 3.3 Cómo aplica (reusa el patrón UPSERT-no-churn que ya tienes)
Dentro de Railway, por `*.railway.internal`:
```sql
CREATE TEMP TABLE stg (...) ON COMMIT DROP;
-- COPY de las filas del changeset
INSERT INTO <table> (...) SELECT ... FROM stg
  ON CONFLICT (<pk>) DO UPDATE SET ...
  WHERE (<compare>) IS DISTINCT FROM (EXCLUDED.<compare>);   -- solo cambia lo que cambió
-- si delete_scope:
DELETE FROM <table> t WHERE <scope> AND NOT EXISTS (SELECT 1 FROM stg s WHERE s.pk = t.pk);
```
Es **el mismo SQL** que hoy corre el importer, pero ahora del lado interno → cero egress, y la lógica de apply se centraliza (metadata-driven, cubre todas las tablas uniforme).

### 3.4 Garantías
- **Idempotente**: reenviar el mismo `batch_id` no duplica (ON CONFLICT).
- **Orden / dependencias**: el orquestador on-prem manda respetando FKs (dims antes que hechos), igual que hoy en `run-prod-feeds.js`.
- **Backpressure**: si el servicio va lento, el loop on-prem se auto-throttlea (IgnoreNew / cola local).
- **Auditoría**: cada batch escribe en `analytics.cron_runs` (o `ingest_runs`) con filas/ms.

---

## 4. Cambios on-prem (Capa 2) — mínimos y mecánicos

Introducir `database/importers/lib/sink.js`:
```js
// applyChangeset(table, { pk, compare, deleteScope, rows })
//   FEEDS_SINK=pg   -> aplica contra DATABASE_URL_NEW (comportamiento de hoy)
//   FEEDS_SINK=http -> gzip + POST a FEEDS_INGEST_URL con X-Ingest-Key
```
Cada importer hoy ya construye su `stg_*` + delete-set; se cambia la línea de "apply" por `applyChangeset(...)`. Migración importer por importer, con toggle → **rollback instantáneo** volviendo a `FEEDS_SINK=pg`. Sin big-bang.

El loop continuo: `run-prod-feeds.js` gana un modo `--watch` que, en vez de correr una vez, cicla los feeds "vivos" chequeando el change marker de cada fuente y salta los que no cambiaron.

---

## 5. Capa 3 — derivadas frescas sin quemar CPU

- Tabla `analytics.derived_deps(target, sources[])` = qué derivada depende de qué fuente.
- Al aplicar un changeset, `feeds-ingest` marca `dirty` las derivadas afectadas (`analytics.derived_state`).
- `AnalyticsRefreshService` (ya existe, @Cron) recomputa **solo las dirty**, no rebuild completo.
- Las pesadas (DRP de red, ABC, cadenas contables) → micro-batch cada 5–15 min o al cambiar su fuente. La operativa (stock/ventas/precios/movimientos) → al minuto.
- **Nota de costo**: recompute corre dentro de Railway = RAM/CPU (el otro ~42% de la factura), por eso NO se recomputa todo cada minuto — solo lo que cambió.

---

## 6. Modelo de costo

| Camino | Dirección | Facturado |
|---|---|---|
| on-prem → `feeds-ingest` (POST gzip delta) | ingress | **$0** |
| `feeds-ingest` → Postgres (`*.railway.internal`) | interno | **$0** |
| Recompute derivadas (dentro de Railway) | CPU/RAM | sí (acotado a lo dirty) |
| App/usuarios leyendo desde Railway | egress | sí (ya existía, no cambia) |

Resultado: el path de sincronización frecuente sale de la factura de egress. Se puede ir a 1 min en todo el espejo del ERP.

---

## 7. Rollout por rebanadas

- **Fase 0** (hoy, sin código): subir cadencias en Task Scheduler (`RefreshConsolidado` 1m, `Stock` 2m, `Live` 5m) y medir egress 2–3 días. Reversible.
- **Fase 1.1 ✅ EN CÓDIGO (local) 2026-08-10**: `feeds-ingest` service + `lib/sink.js` + `lib/apply-handlers.js` + feed piloto `stock-delta` migrado a `FEEDS_SINK=http`. Smoke de protocolo 10/10 (DB-free). Ver §7.1. **Pendiente**: deploy del servicio en Railway + activar `FEEDS_SINK=http` en el runner + verificar frescura/egress plano.
- **Fase 1.2**: migrar ventas + precios + catálogo + movimientos.
- **Fase 1.3**: migrar el resto del espejo (proveedores, clientes, contable, logística) → **todas las tablas-espejo**.
- **Fase 1.4**: Capa 3 dirty-flag + recompute incremental.
- **Fase 1.5**: bajar todo a 1 min + monitor de frescura por **fecha-dato** (`max(sale_date)`, `max(ticket_ts)`, etc.), no por heartbeat.
- **Diferido**: Wincaja al minuto (patrón `LivePoller` + watermark por `.mdb`, aterriza ~1–5 min por candado de Access) · replicación lógica/CDC real de Kepler (si el watermark continuo no da la latencia deseada).

### 7.1 Artefactos Fase 1.1 (construidos 2026-08-10)

| Archivo | Rol |
|---|---|
| `services/feeds-ingest/apply-handlers.js` | Registro de handlers de apply por feed = ÚNICA fuente del SQL de escritura (hoy: `stock-delta`). Vive junto al servicio; el modo `pg` on-prem lo reutiliza. |
| `database/importers/lib/sink.js` | `ship(feed,{rows,tenantId,client})` — modo `pg` (apply in-proc con el Client del importer) o `http` (gzip+POST al servicio). Toggle `FEEDS_SINK`. |
| `services/feeds-ingest/server.js` | Servicio Railway (Node plano): `POST /ingest/:feed` con `X-Ingest-Key`, gunzip JSONL, valida tenant UUID, aplica por `*.railway.internal`. Testeable (`setDbClientFactory`). |
| `services/feeds-ingest/README.md` | Deploy Railway + activación del push on-prem. |
| `database/importers/kepler/import-branch-stock-live.js` | Piloto: bloque de apply reemplazado por `sink.ship('stock-delta', …)`. Lógica de snapshot/delta/drops intacta. |
| `database/importers/kepler/_smoke-feeds-ingest.js` | Smoke de protocolo DB-free (10/10): round-trip gzip+JSONL, auth 401, feed 400, tenant 400. |

**Nota honesta**: el importer aún hace 1 `SELECT public.products` chico contra Railway por corrida (mapa sku→id) = egress mínimo (~KB). Optimización futura: resolver sku→id server-side o desde el espejo on-prem. El path pesado (el upsert del delta) ya va por ingress gratis en modo `http`.

**Deploy ✅ EN VIVO 2026-08-10**: servicio `feeds-ingest` en Railway (balanced-dream/production) →
`https://feeds-ingest-production.up.railway.app`. `/health`→{ok:true}; POST vacío `stock-delta`→
rowCount 0 en 50ms (auth + Postgres interno OK); key mala→401. Vars: `FEEDS_INGEST_KEY`,
`DATABASE_URL_NEW=${{Trade_marketing.DATABASE_URL_NEW}}`, `RAILWAY_DOCKERFILE_PATH=services/feeds-ingest/Dockerfile`.

**Gotcha de deploy (resuelto)**: `railway up` sube el **git root**, no la carpeta desde donde se corre →
por defecto tomaba el `Dockerfile` raíz (Nx del API, cache-mounts al service id del API) → build inválido → 404.
Fix scoped: `services/feeds-ingest/Dockerfile` propio + env `RAILWAY_DOCKERFILE_PATH` (no afecta otros servicios).

**Pendiente (runner `.249`, operacional)**:
1. En `run-feeds.cmd`: `FEEDS_SINK=http` + `FEEDS_INGEST_URL=https://feeds-ingest-production.up.railway.app` + `FEEDS_INGEST_KEY=<secreto>`.
2. Correr `import-branch-stock-live.js --apply` → verificar `[APPLY·http]` + frescura + egress plano. Rollback = quitar `FEEDS_SINK`.

---

## 8. Riesgos / gotchas

- **API OOM**: por eso `feeds-ingest` va separado del API.
- **Secreto de ingest**: `X-Ingest-Key` en env; rotar; NUNCA hardcodear (ver incidente de creds).
- **TLS**: el POST va por HTTPS al dominio público del servicio; el tráfico DB queda interno.
- **Orden de FKs**: respetar en el orquestador; el servicio no reordena.
- **Wincaja Jet 32-bit**: no hace CDC; su frescura la limita el candado de Access, no esta arquitectura.
- **Verificar frescura por fecha-dato**: el heartbeat prueba que arrancó, no que avanzó.

---

## 9. Decisiones abiertas

1. ADR-035 (aceptar el patrón push/ingress).
2. `feeds-ingest`: NestJS mínimo vs Node/Fastify plano (recomendado: Node plano, sin peso del framework).
3. Formato del changeset (JSONL gzip vs binario) — arrancar JSONL gzip.
4. ¿Cuándo, si acaso, subir a CDC/replicación lógica de Kepler (Capa 1)?
