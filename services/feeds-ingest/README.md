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
| `STORE_NOTIFY_URL` | **`[TDA.1]`** Base del API al que se le avisa que cambió un precio de etiqueta (`POST /store/live/label-prices-changed`). Usar la URL **interna** del API (`*.railway.internal`) — es el mismo criterio que `DATABASE_URL_NEW`: interno = gratis. **Sin esto el aviso es un no-op** y la etiquetera vuelve a enterarse sólo al siguiente escaneo (lo declara en el log, una vez). |
| `STORE_INGEST_KEY` | **`[TDA.1]`** El **mismo** secreto que ya usa el API para el `StoreIngestGuard` (header `x-store-ingest-key`). No se genera uno nuevo: es la misma puerta máquina-a-máquina del poller de tickets. |
| `STORE_NOTIFY_TIMEOUT_MS` | Tope de espera del aviso. Default 3000. El aviso corre dentro del POST del carril @15 s, así que un API que no contesta **no puede** quedarse colgado ahí. |
| `STORE_NOTIFY_MAX_IDS` | Cuántos `product_id` van por aviso. Default 500. Pasado el tope se manda `truncated: true` y la pantalla refresca toda su cola en vez de creerle a una lista parcial. |

> **El aviso es fail-OPEN a propósito.** Si el API no contesta, el precio ya quedó guardado —lo
> escribió el hop-2 antes de avisar— y la pantalla lo verá en el próximo escaneo, que es el
> comportamiento de siempre. Un aviso caído nunca puede tumbar el carril que alimenta precio,
> costo, margen y reorden. Medido en `database/tests/test-newdb-label-price-notify.js` (22/22).

## Deploy en Railway (mismo proyecto que el API/Postgres)

1. **New Service → GitHub repo** (mismo repo). Root Directory = **raíz del repo** (necesita
   `node_modules` de raíz para `pg` y la ruta relativa a `database/importers/lib/`).
2. **Start Command**: `node services/feeds-ingest/server.js`.
3. **Variables**: `DATABASE_URL_NEW=${{Postgres.DATABASE_URL}}` (referencia al Postgres del proyecto →
   resuelve a la URL **interna**) + `FEEDS_INGEST_KEY=<secreto>`.
4. Habilitar dominio público (para que el runner on-prem le pegue por HTTPS).
5. Verificar: `GET https://<dominio>/health` → `{ ok: true }`.

## Activar el push desde on-prem (servidor `md`)

⚠️ **Desde el 2026-09-11 la ingesta corre en el servidor Linux `md` (192.168.0.222)**, no en la
máquina de escritorio `.249`. Ya no hay `run-feeds.cmd` ni Programador de Windows: los carriles son
contenedores de Docker Compose y el entorno sale de **`~/secrets/feeds.env`** en el servidor (que es
lo que `ops/vl/run-feed.sh` carga, porque busybox `crond` no hereda el entorno del contenedor).
Qué corre dónde: [`ops/README.md`](../../ops/README.md).

En ese archivo de entorno, setear:

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
