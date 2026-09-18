# Fase LT — Rastreo de flota GPS (MagniTracking)

> **Estado:** 🟢 LT.0 + LT.1 + LT.2 + LT.3 + LT.5 (bootstrap) + LT.6 (alertas server-side) ✅ local (beta) — 2026-07-27.
> **ADR:** ADR-034 (proveedor de rastreo detrás de puerto; sin API oficial → sesión).
> Hereda ADR-016 (el motor/adaptador trae datos, el LLM fuera).

## Objetivo

Traer las posiciones reales de la flota (camionetas de ruta, camiones de reparto,
motos) al dominio Logística para tener **control de vehículos en vivo** dentro de
la plataforma, en vez de depender del portal externo del proveedor.

## Contexto del proveedor

Mega Dulces rastrea su flota en **magnitracking.net**, un white-label de
**GPS-Server.net v4** (cuenta `enterprise_id=614`, ~50 dispositivos; trackers
Ruptela + dashcams Streamax). **NO hay API oficial** (confirmado por Edgar) → la
integración replica el flujo de la web (reverse-engineered y verificado):

```
1) GET  /index.php                                  → cookie anónima PHPSESSID
2) POST /api/v1/fn_connect.php  cmd=login&username&password&remember_me&mobile
   → éxito = texto "LOGIN_TRACKING"; misma PHPSESSID queda autenticada
3) POST /api/v1/main/fn_objects.php  cmd=load_object_data  → flota en vivo
   { "<IMEI>": { name, st(m/s/off), ststr, sim_number, p(rotocolo), o(dómetro),
     d:[[dt_server, dt_tracker, lat, lng, alt, rumbo, velocidad, {acc,...}]] } }
```

**Credenciales SIEMPRE por env** (`MAGNI_USER`, `MAGNI_PASS`, opcional
`MAGNI_BASE_URL`, `MEGADULCES_TENANT_ID`). Nunca en repo. El password que se
compartió en chat debe **rotarse**.

## Arquitectura

Nueva feature `libs/logistics/src/lib/logistics-tracking/`:

- **`FleetProviderPort`** (`fleet-provider.port.ts`) — interfaz + token `FLEET_PROVIDER_PORT`.
- **`MagniTrackingAdapter`** — implementa el puerto: login de sesión + poll + normalización
  (status m/s/off → moving/stopped/offline, `dt_tracker` → ISO `-06:00` porque MX
  no tiene DST desde 2022). Cambiar de proveedor = cambiar solo este adapter.
- **`LogisticsTrackingService`** — `sync()` (UPSERT trackers + posiciones + auto-match
  por placa), `listLive()`, `history()`, `linkTracker()`.
- **`FleetPollerService`** — `@Cron(EVERY_MINUTE)` con guard de re-entrancy; no corre
  si el proveedor no tiene credenciales (env ausente).
- **`LogisticsTrackingController`** — `GET /logistics/tracking/live`,
  `/trackers`, `/trackers/:id/history`, `POST /sync-now`, `PATCH /trackers/:id/link`.
  Permisos reusados `LOGISTICS_FLEET_VER` / `LOGISTICS_FLEET_GESTIONAR` (sin seed nuevo).

## Schema (2 migraciones)

- **`logistics.trackers`** (mig `20260727180000`, RLS forzado, ~decenas de filas) —
  un row por IMEI. Un vehículo físico puede tener varios trackers (GPS + dashcam) →
  `vehicle_id` (FK composite nullable) los agrupa. Guarda la **última posición
  denormalizada** (`last_*`) para el mapa en vivo. `route_code` = R-NN parseado.
- **`logistics.vehicle_positions`** (mig `20260727181000`, **sin RLS**, alto volumen) —
  breadcrumbs. Patrón `route_location_pings`: tenant_id explícito, filtro manual,
  dedupe `UNIQUE (tenant_id, tracker_id, captured_at)`. GRANT SELECT/INSERT/DELETE.

## Frontend

Nueva página **`/logistica/rastreo`** ("Rastreo GPS", nav `LOGISTICS_FLEET_VER`),
superficie Operations (quiet-luxury, `surf-page`, `p-tag` por estado, Geist mono):
- Mapa `app-map` con marcadores por estado (movimiento/detenido/offline, ring en vivo),
  KPIs, master-detail con panel de detalle.
- **Alertas** client-side: sin señal (>90 min) + exceso de velocidad (>90 km/h).
- **Recorrido histórico** del día (toggle → `trackerHistory` → `path` en el mapa).
- Vinculación tracker→vehículo (select) + botón Sincronizar.

## Verificación

- `nx build api` ✅ y `nx build view` ✅ (prod, sin caché).
- Smoke `database/tests/test-newdb-logistics-tracking.js` **8/8** contra la DB nueva
  como `app_runtime` con RLS: 50 objetos → 50 trackers/posiciones, dedupe idempotente,
  auto-match por placa. (Standalone: requiere `MAGNI_USER/PASS` — no está en la
  regression suite por default porque pega al proveedor real.)

## Pendiente / diferido

- **Prod (Railway):** aplicar migs `20260727180000` + `20260727181000`; setear
  `MAGNI_USER`/`MAGNI_PASS` (y `MEGADULCES_TENANT_ID` si difiere) en el env del API;
  redeploy api+view. **Rotar** el password del proveedor.
- **Auto-match (resuelto por LT.5 bootstrap):** el sync inline solo vinculaba 2/50
  (placas seed ≠ nombres GPS). `POST /logistics/tracking/bootstrap-vehicles` (botón
  "Vincular por placa") crea vehículos desde el nombre del GPS (`extractPlate`/
  `extractBrand`) y vincula → **48/50** (2 sin placa: "DESCONTINUADO" + numérica).
  Idempotente; dos trackers con la misma placa (GPS + dashcam) comparten vehículo.
- **LT.6 alertas server-side ✅** — tabla `logistics.fleet_alerts` (mig `20260727182000`,
  RLS, UNIQUE parcial anti-spam por tracker+kind abierto) + `FleetAlertsScannerService`
  (`@Cron` 5 min) detecta sin-señal (90 min–24 h) y exceso de velocidad (>90 km/h);
  endpoints `GET /alerts`, `POST /alerts/scan-now`, `PATCH /alerts/:id/ack`. La página
  lee alertas persistidas con botón reconocer. Diferido: push por WS al campo
  (requiere `FLEET_NOTIFIER_PORT` en el app-shell, `libs/logistics` no importa commercial).
- **TZ:** se asume MX `-06:00` fijo. Validar si la cuenta reporta en otra zona.
- Retención de `vehicle_positions` (purga/partición) cuando crezca el volumen.

---

## LT.9 — La flota vive en DOS cuentas del proveedor (2026-09-17)

Disparado por una revisión de la implementación. **La app sólo veía una de las dos
cuentas MagniTracking de Mega Dulces**, así que las unidades pesadas nunca existieron
para el sistema. Medido contra el proveedor antes de tocar código:

| cuenta | objetos | qué trae |
|---|---|---|
| `MAGNI_USER` | 49 | camionetas de ruta y reparto |
| `MAGNI_USER2` | 7 | HINO 500, FREIGHTLINER, 3× INTERNATIONAL + 2 repetidos |
| **unión** | **54** | **+5 unidades que no se veían** |

Los 2 IMEIs compartidos (`00D206F7D0`, `868018070358984`) devuelven **el mismo fix al
segundo**, así que deduplicar por IMEI es seguro.

**Tres decisiones que el código sostiene:**

1. **Cookie jar por cuenta.** GPS-Server identifica la sesión por cookie: con el jar
   único que había, el login de la 2ª cuenta pisaba el de la 1ª y las dos consultas
   devolvían la misma flota. El token de la API oficial también pasa a ser por cuenta.
   El smoke lleva la prueba negativa (si se pisaran, la unión no traería objetos de
   más de una cuenta).
2. **Dedupe por IMEI con el fix más fresco**, no "gana la primera": el resultado no
   depende del orden de lectura.
3. **El umbral de alarma es POR CUENTA, no sobre el total.** Si se cae la que trae las
   7 pesadas, el total sigue siendo 49 — un número sano que esconde media flota callada.

Se leen `MAGNI_USER`/`MAGNI_PASS` y `MAGNI_USER2..9`/`MAGNI_PASS2..9`; pares incompletos
se ignoran (media credencial suelta sería un login fallido por minuto contra una cuenta
compartida).

**Dos ceros que se publicaban como éxito, cerrados de paso:** el camino legacy devolvía
`[]` cuando `fn_objects` no contestaba tras el re-login (sesión rota = "flota vacía"), y
la API oficial no miraba `res.ok` (un 401 se leía como flota vacía).

**`st='i'` no estaba mapeado** y caía en `unknown`, que significa "no sabemos" — y sí
sabíamos: lo dice el propio proveedor en `ststr` (*"Ralenti 2 H 8 Min 57 S"*, `speed=0`,
`acc=1`), que ya guardábamos en `last_status_text`. Es **ralentí**; para el mapa y las
alertas es una unidad detenida.

### LT.9.1 / LT.9.2 — se retira el carril duplicado

La revisión encontró que **dos pollers hacían el mismo trabajo cada minuto**: el
`FleetPollerService` del API (worker tier) y `database/scripts/fleet-poll-onprem.js` en
`md`. Medido con `pg_stat_statements` sobre 56.5 h:

| escritor | intentos de insert | filas reales | útiles |
|---|---|---|---|
| knex (API Railway) | 167,584 | **25,498** | 15.2 % |
| raw (on-prem `md`) | 166,373 | **2,385** | 1.4 % |

El API pone el **91.4 %**. El on-prem disparaba en el mismo borde del minuto pero
tardaba **22.7 s** en llegar (49 viajes secuenciales a Railway, uno por unidad) y para
entonces casi todo le daba conflicto. Costo: **1.35 % del tiempo de ejecución de toda la
base** + 98 UPDATEs/min sobre una tabla de 50 filas (15,385 autovacuums).

⛔ **Y el latido estaba colgado del carril equivocado:** `fleet_gps` lo escribía el
on-prem, que entregaba ~0. Si moría el API, el tablero seguía verde; si moría el
on-prem, se pintaba rojo con el dato fluyendo igual.

Orden de ejecución (ADR-060: no se apaga un carril sin que el que queda tenga latido
verde **en prod**):

1. **LT.9.1** — `FleetPollerService` escribe `analytics.cron_runs` (misma llave
   `fleet_gps`, mismo umbral en `CRON_JOBS`; cambia el escritor, no el contrato).
   Mide **entrega** (`positions` — verificado que knex devuelve `rowCount` en
   `ON CONFLICT DO NOTHING`: 1 nueva / 0 conflicto) y su error es por cuenta.
2. **Verificado en prod** `host='api'`.
3. **LT.9.2** — se saca la línea de `ops/vl/crontab.feeds` y se despliega `feeds-cron`.

⚠️ **Lo que se pierde, dicho:** ese 8.6 % de breadcrumbs eran fixes de la ventana de 20 s
entre un poll y el otro. No se pierde cobertura (el minuto siguiente trae la última
posición igual), se pierde **densidad de traza**. Si hace falta esa resolución, la
respuesta no es revivir el carril: es que el poller del API corra dos veces por minuto,
o encender `history.php` de la API oficial, que devuelve **todos** los fixes.

⚠️ **La premisa que justificaba el carril ya no se sostiene** ("GPS-Server ata la sesión
a la IP: 0 objetos desde Railway"): 167,584 inserts / 56.5 h = exactamente 49/min desde
Railway. Si volviera a atarse, el síntoma sería `fleet_gps` en error con "0 objetos" y la
línea vuelve. El script **no se borra**: es el plan B y ya soporta las dos cuentas.

⭐ **Trampa de despliegue:** las credenciales se habían puesto en el servicio `MegaDulces`
de Railway, **que no corre los crons** — el poller vive en el servicio **`worker`**
(`WORKER=1`, "Worker-tier arriba: crons + cola pg-boss"). Sin copiarlas ahí, el desglose
por cuenta no iba a aparecer nunca. *Para cualquier variable que consuma un `@Cron`, el
servicio a tocar es `worker`.*

**Y dos canarios rotos en el healthcheck de `feeds-cron`**, uno de ellos roto por este
mismo cambio — el comentario del propio archivo lo anticipaba (*"atarlo a un solo carril
lo deja en bucle de reinicio eterno el día que ese carril se retire"*):
`fleet_gps` (ya no la escribe ese contenedor → diría "sano" mirando una llave de OTRA
máquina) y `feed_receipts` (canario muerto desde DB-MEM.2: pasó de cada minuto a
`30 4 * * *`, vencido 23 de cada 24 h contra `MAX_MIN=10`). Ahora:
`feed_contpaqi` · `contpaqi_add_cfdis` · `health_watchdog`.

### Verificación (2026-09-17, prod)

- Smoke `test-newdb-logistics-tracking` **25/25** contra `platform_test` con las dos
  cuentas reales (unión 54, traslape 2, `created 5`, sync y bootstrap idempotentes).
- En prod, log del worker:
  `sync: 54 objetos [MAGNI_USER=49 MAGNI_USER2=7] → 5 nuevos, 49 act, 3 vinculados, 13 posiciones (1085ms)`
  — **1,085 ms contra los 22,695 ms** del carril retirado.
- Latido: `host=api status=ok` con el desglose por cuenta en `note`.
- **0 intentos de insert del carril on-prem en 90 s** de medición posterior al corte.
- `logistics.trackers` 50 → **55**; **0** trackers en estado `unknown`.
- `feeds-cron` en `md`: `healthy` con los canarios nuevos.

### Pendiente de LT.9

- **2 de las 5 unidades nuevas quedaron sin vehículo** (`FREIGHTLINER 882EW9`,
  `HINO 500-67BB9C`): salen en el mapa, pero sin `vehicle_id` no entran a viajes,
  cumplimiento de ruta ni productividad. Se resuelve con el botón **"Vincular por
  placa"** (`POST /logistics/tracking/bootstrap-vehicles`, idempotente) — o dándolas
  de alta a mano si se les quiere poner número económico real en vez del derivado
  del nombre del GPS.
- Sigue abierto lo que la revisión encontró y esta entrega no tocó: la API oficial
  apagada (`MAGNI_API_CLIENT_ID` no existe en ningún env → `syncRoutesOperators` y
  `backfillHistory` devuelven cero como éxito), los km inflados 3–14 % en los 7
  vehículos con dos trackers, las 10 unidades muertas fuera del techo de 24 h de la
  alerta offline, `route_number IS NULL` significando dos cosas, el sensor
  `fleet_positions` costando 1.25 % de la base por dos `max(captured_at)` sin índice,
  la ausencia de timeouts en los `fetch`, y la retención de `vehicle_positions`.
