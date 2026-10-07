# App Vendedor — `apps/vendor`

App **Angular standalone** del vendedor de campo (toma de pedidos, ruta, captura
offline). Vive en el **monorepo Nx `Trade_marketing`** como app propia (`apps/vendor`)
con **deploy independiente** (su propio servicio Railway). Consume el **mismo backend**
(servicio principal): el nginx del contenedor proxya `/api` y el WebSocket vía
`API_UPSTREAM` (mismo origen para el browser → sin CORS).

Decisión: [ADR-019](../../docs/IMPLEMENTACION/02_DECISIONES_ARQUITECTURA.md) ·
plan: [FASE_VENDOR_STANDALONE.md](../../docs/IMPLEMENTACION/FASES/FASE_VENDOR_STANDALONE.md).

## Desarrollo
```bash
nx serve vendor --port 4201      # http://localhost:4201  (view sigue en :4200)
nx build vendor                  # build producción → dist/apps/vendor/browser
```
`environment.ts` autodetecta: `apiUrl` = `http://localhost:3334/api` en localhost, `/api` en prod.

## Estructura
- `src/app/modules/vendor/` — shell + pages (ruta, take-order, pending, visitas, hoy, cierre, carga, success, notificaciones).
- `src/app/modules/dashboard/vendor-capture/` — captura offline (Dexie) reusada en `/vendor/capture`.
- `src/app/modules/portal/portal.service.ts` — cliente comercial (catálogo/carrito/pedidos).
- `src/app/modules/auth/login/` — login.
- `src/app/core/` — servicios (auth, theme, geo, haptic, offline-*, route-ping), interceptor, guards, utils.
- Rutas: `/login` + `/vendor/*` (raíz → `/vendor`).

> Nota: app **autocontenida** (copia del cierre transitivo, no libs compartidas todavía —
> ver V-S.1b en el Fase doc). Hay duplicación temporal de core-services con `apps/view`
> hasta el cleanup opcional.

## Deploy (Railway) — servicio propio desde el monorepo
1. Servicio nuevo apuntando a **este monorepo**, con `RAILWAY_DOCKERFILE_PATH=apps/vendor/Dockerfile`
   (build context = raíz del monorepo; el Dockerfile corre `nx build vendor`).
2. Variables:
   - `API_UPSTREAM` = URL del backend (ej. `https://<trade>.up.railway.app` o `http://<api>.railway.internal:3333`).
   - `PORT` lo asigna Railway.
3. Dominio: ej. `vendedor.megadulces.com`.
4. (Opcional) Service ID real en los `--mount=type=cache,id=s/<ID>-npm` del Dockerfile → cache de build persistente.

## Pendiente
- Service Worker / PWA cacheada (`ngsw-config.json` + `provideServiceWorker`) — hoy el offline es solo Dexie.
- Verificar redirect post-login a `/vendor`.
