# feeds-ingest

Servicio de ingesta que vive **dentro de Railway** (Fase SYNC 1.1). Recibe changesets de los feeds
on-prem por HTTPS (**ingress = gratis**) y los escribe por red interna `*.railway.internal`
(**interno = gratis**), usando el mismo SQL de apply (`apply-handlers.js`, en esta misma carpeta;
el modo `pg` on-prem lo reutiliza). Aislado del API a propósito (el API sufre OOM).

Ver diseño completo: [`docs/IMPLEMENTACION/FASES/FASE_SYNC_TIEMPO_REAL.md`](../../docs/IMPLEMENTACION/FASES/FASE_SYNC_TIEMPO_REAL.md).

## Protocolo

- `POST /ingest/:feed` — header `X-Ingest-Key: <FEEDS_INGEST_KEY>`; body = `gzip(JSONL)`
  (línea 0 = `{tenant_id, meta, count}`, líneas 1..N = filas). → `200 { ok, feed, received, rowCount, ms }`.
- `GET /health` → `200 { ok }`.

Feeds soportados hoy: `stock-delta` (piloto). Agregar más = registrar un handler en `apply-handlers.js`.

## Env

| Var | Para qué |
|---|---|
| `DATABASE_URL_NEW` | Postgres destino. **Usar la URL INTERNA** `postgres.railway.internal` (no el proxy público) para que la escritura no cueste egress. |
| `FEEDS_INGEST_KEY` | Secreto del header `X-Ingest-Key`. Generar aleatorio; NUNCA hardcodear. |
| `PORT` | Lo inyecta Railway. Default 8080. |
| `MAX_BODY_MB` | Tope de body gzip. Default 32. |

## Deploy en Railway (mismo proyecto que el API/Postgres)

1. **New Service → GitHub repo** (mismo repo). Root Directory = **raíz del repo** (necesita
   `node_modules` de raíz para `pg` y la ruta relativa a `database/importers/lib/`).
2. **Start Command**: `node services/feeds-ingest/server.js`.
3. **Variables**: `DATABASE_URL_NEW=${{Postgres.DATABASE_URL}}` (referencia al Postgres del proyecto →
   resuelve a la URL **interna**) + `FEEDS_INGEST_KEY=<secreto>`.
4. Habilitar dominio público (para que el runner on-prem le pegue por HTTPS).
5. Verificar: `GET https://<dominio>/health` → `{ ok: true }`.

## Activar el push desde on-prem (runner .249)

En el entorno del runner (`run-feeds.cmd` / Task Scheduler), setear:

```
FEEDS_SINK=http
FEEDS_INGEST_URL=https://<dominio-del-servicio>
FEEDS_INGEST_KEY=<mismo secreto>
```

Con eso, `import-branch-stock-live.js` empuja el delta al servicio en vez de escribir por el proxy.
**Rollback instantáneo**: quitar `FEEDS_SINK` (o `=pg`) → vuelve al comportamiento previo.

## Smoke (sin DB)

```
node database/importers/kepler/_smoke-feeds-ingest.js   # 10/10 protocolo sink→server→handler
```
