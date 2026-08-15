# Orquestador de feeds (pg-boss + PM2)

Reemplazo **gradual** del Task Scheduler de Windows para los feeds Kepler→prod. Un
solo proceso Node (`feed-worker.js`), siempre-vivo bajo PM2, agenda los modos de
`run-prod-feeds.js` con **pg-boss** (cola en Postgres, reintentos + historial, sin
Redis ni Docker).

## Por qué

Hoy: ~18 tareas de Windows + `.vbs` + `.cmd`, sin reintentos, sin historial, y una
tarea-loop que "dice Running" aunque el proceso esté zombie. pg-boss da: reintentos
con backoff, historial en `pgboss.job`, catch-up si la PC estuvo apagada, y un solo
lugar de logs (`pm2 logs`).

**Clave:** pg-boss NO reimplementa los feeds. Dispara el MISMO `run-prod-feeds.js
<modo> --apply` que hoy corre el Task Scheduler → el heartbeat `feed_*` (Salud BD),
el timeout por paso y el barrido de huérfanos siguen intactos.

## Cómo funciona pg-boss (mental model)

Pull/polling, **no triggers**. El worker jala jobs "listos" de `pgboss.job` cada ~2s
con `SELECT … FOR UPDATE SKIP LOCKED`. El cron vive en `pgboss.schedule`; un reloj
líder encola el job al llegar la hora (TZ `America/Mexico_City`). La cola vive en un
Postgres durable — **la .245** (siempre encendida), no Railway (evita polling por WAN).

## Prerrequisitos

1. **pg-boss** ya está en `node_modules` (v12).
2. **Postgres para la cola en `.245`.** Recomendado: una DB dedicada.
   ```sql
   -- en 192.168.0.245 (psql -U postgres)
   CREATE DATABASE feeds_orchestrator;
   ```
   pg-boss crea solo el schema `pgboss` y sus tablas en el primer `start()`.
3. **Archivo de entorno** `orchestrator.local.env` (gitignored) en esta carpeta. Copiá
   los valores desde `C:\KeplerRunner\run-feeds.cmd` (NO los pegues en el repo):
   ```
   PGBOSS_DATABASE_URL=postgresql://postgres:<pass>@192.168.0.245:5432/feeds_orchestrator
   PGBOSS_MODES=
   DATABASE_URL_NEW=<proxy Railway prod>
   DATABASE_URL_KEPLER_CONSOLIDADO=postgresql://postgres:superoot@localhost:5433/kepler_consolidado
   MEGA_DULCES_URL=postgresql://postgres:superoot@192.168.0.245:5432/Mega_Dulces
   FEEDS_SINK=http
   FEEDS_INGEST_URL=https://feeds-ingest-production.up.railway.app
   FEEDS_INGEST_KEY=<key>
   RECEIPTS_DAYS=7
   ```
   `PGBOSS_MODES` arranca **vacío** = agenda nada (boot seguro). Ver migración abajo.

## Instalar PM2 como servicio de Windows

```powershell
npm install -g pm2
# PM2 como servicio que arranca en boot (elegí uno):
#   A) pm2-installer (recomendado en Windows): https://github.com/jessety/pm2-installer
#   B) npm i -g pm2-windows-startup && pm2-startup install
pm2 start database/importers/orchestrator/ecosystem.config.js
pm2 save
pm2 logs feed-worker      # verificá el boot
```

## Smoke test (sin tocar nada en producción)

Con `PGBOSS_MODES=` vacío, el worker arranca, conecta a la cola y **no agenda nada**.
Para probar UN modo sin apagar su tarea de Windows (correrá doble un rato, es
idempotente por UPSERT):

```
PGBOSS_MODES=receipts   → pm2 restart feed-worker → pm2 logs feed-worker
```
Deberías ver `agendado feed_receipts: '* * * * *'` y, al minuto, `▶ receipts … ✔ receipts OK`.
Confirmá el latido en **/admin/db-health** (feed_receipts fresco).

## Migración gradual (cutover por modo, sin big-bang)

Por cada modo, en orden de menor riesgo (receipts → contpaqi → stock → live →
intraday → contpaqi-slow → catalog → nightly):

1. Agregá el modo a `PGBOSS_MODES` (coma-separado) y `pm2 restart feed-worker`.
2. **Deshabilitá la tarea de Windows** equivalente:
   `Disable-ScheduledTask -TaskPath "\Kepler\" -TaskName "Receipts"`.
3. Verificá 1–2 ciclos del `feed_<modo>` en /admin/db-health (fresco, sin error).

Mapa modo → tarea de Windows:

| modo pg-boss    | tarea de Windows        | cadencia      |
|-----------------|-------------------------|---------------|
| receipts        | `\Kepler\Receipts`      | cada 1 min    |
| contpaqi        | `\Kepler\Contpaqi`      | cada 1 min    |
| stock           | `\Kepler\Stock`         | cada 15 min   |
| live            | `\Kepler\Live`          | cada 30 min   |
| intraday        | `\Kepler\Intraday`      | cada 1 h      |
| contpaqi-slow   | `\Kepler\ContpaqiSlow`  | cada 2 h      |
| catalog         | `\Kepler\Catalog`       | diario 02:00  |
| nightly         | `\Kepler\Nightly`       | diario 03:00  |

**Loops NO migrados** (siguen como tareas-loop): `livefast` (`\Tienda\LiveFastLoop`),
`ods-fast` (`\Tienda\OdsFastLoop`), `RefreshConsolidado`, `WincajaLive`,
`KP-Concentrate`, `WincajaSync*`. Migran después si conviene.

## Rollback

1. `PGBOSS_MODES=` vacío → `pm2 restart feed-worker` (deja de agendar).
2. Re-habilitá las tareas de Windows: `Enable-ScheduledTask -TaskPath "\Kepler\" -TaskName "<Tarea>"`.

Sin destruir nada: pg-boss y el Task Scheduler pueden coexistir; el peor caso de un
solapamiento es una corrida doble idempotente.

## Operación

```
pm2 status                    # estado del worker
pm2 logs feed-worker          # logs en vivo
pm2 restart feed-worker       # tras cambiar env o schedules.js
```
Historial de jobs (reintentos, duración, fallos) en la cola:
```sql
SELECT name, state, retry_count, created_on, completed_on
FROM pgboss.job ORDER BY created_on DESC LIMIT 50;  -- en feeds_orchestrator (.245)
```
