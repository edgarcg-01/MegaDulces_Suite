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
