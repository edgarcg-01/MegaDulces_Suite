# Runbook — Proyecto Tienda (monitor de tickets en vivo) a prod

Monitor `/tienda` que muestra los tickets POS de cada sucursal en tiempo real por
WebSocket. Arquitectura: **poller on-prem (~25s) → `POST /store/live/ingest` (API
Railway) → Socket.IO `/store` → navegador**. Único punto de polling = runner↔Kepler
(Kepler no notifica; el WebSocket no hace polling del navegador).

Ver diseño en la memoria `project_proyecto_tienda_live` y el `CHANGELOG` (Fase TDA).

## Estado
- Código: **EN CÓDIGO**, builds api+view verdes. Poller verificado en vivo (dry-run: 662 tickets de 5 sucursales, payloads correctos).
- Deploy: **pendiente** (pasos abajo).

## Pasos de deploy

### 1. Migraciones (se aplican solas al desplegar el API)
- `20260702180000_analytics_store_live_tickets` — tabla buffer de tickets.
- `20260702190000_grant_store_live_ver` — otorga `STORE_LIVE_VER` a superadmin/admin/supervisor.
NO registrar a mano en `knex_migrations` (crash loop). Dejar que el deploy las corra.

### 2. Env en el API (Railway)
- `STORE_INGEST_KEY` = clave larga aleatoria (la MISMA que el poller).
- (opcional) `STORE_LARGE_TICKET` = umbral $ de la alerta "ticket grande" (default 3000).
- `JWT_SECRET` ya existente (el gateway valida el token del handshake con ese secret).

### 3. Deploy del API
Expone `POST /commercial…`→ en realidad `POST /api/store/live/ingest` + `GET /api/store/live/snapshot` + el namespace WS `/store` (sobre el path `/reports/socket.io` que ya proxea nginx).

### 4. Poller on-prem (runner 192.168.0.249)
- Copiar `database/importers/kepler/store-poller.template.cmd` → `store-poller.cmd`, rellenar `REPO`, `STORE_INGEST_URL` (= `https://<api-prod>/api/store/live/ingest`) y `STORE_INGEST_KEY` (= la del API).
- Arrancar al inicio (1 sola instancia):
  ```
  schtasks /Create /TN "Tienda\LivePoller" /TR "C:\ruta\store-poller.cmd" /SC ONSTART /RU SYSTEM /RL HIGHEST /F
  ```
- El `.cmd` reinicia el proceso si node cae.

### 5. Permisos / acceso
- superadmin/admin ya acceden (manage:all); supervisor por el backfill. **Re-login obligatorio** (el permiso viaja en el JWT).
- Otros roles: agregar `STORE_LIVE_VER` en `/admin/roles` + re-login.

## Verificación
- Poller local sin push: `WINDOW_MINUTES=180 node database/importers/kepler/live-tickets-poller.js --dry` → debe listar tickets de las sucursales.
- Post-deploy: entrar a `/tienda` → indicador **EN VIVO** (verde) + ticker que crece; `GET /api/store/live/snapshot` devuelve KPIs del día.
- WS: DevTools → Network → `reports/socket.io` (101 Switching Protocols) + frames `ticket`.

## Notas / follow-ups
- El WS hoy valida solo tenant (no `STORE_LIVE_VER`) — gatearlo por permiso es un follow-up.
- `analytics.store_live_tickets` es un buffer (retención corta); NO es fuente de verdad de venta (esa es `analytics.sales_daily`). Falta job de limpieza > 3 días.
- Latencia efectiva ≈ `WINDOW`/cadencia del poller (~25s) + minuto de Kepler.
