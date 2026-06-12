# Fase — Separar el Vendedor a app propia (`apps/vendor`)

> Decisión 2026-06-11 (ADR-019). El módulo vendedor sale de `apps/view` a una **app
> Nx propia en el monorepo** (`apps/vendor`), con deploy independiente, compartiendo
> código vía libs. Luego se **borran** del monorepo el módulo `vendor/` viejo **y** el
> `portal/` (este último ya tiene su standalone vivo en `Portal_MegaDulces`).

## ADR-019 — App Nx en el monorepo (NO repo-fork)

**Contexto:** el portal se separó como **repo-fork** (`Portal_MegaDulces`, Angular CLI +
nginx proxy, vivo en `portalmegadulces-production.up.railway.app`). Ese patrón **duplica**
PortalService + core + tokens (el README admite "conviene remover /portal del monorepo
para no mantener dos copias" — y hoy existen las dos → drift vivo).

**Decisión:** el vendedor se separa como **app Nx (`apps/vendor`)** que **comparte libs**,
NO como repo-fork. Razones:
- El vendedor depende fuerte de `PortalService` + core services → forkear = 3ra copia → drift a 3 bandas.
- Es la app **Capacitor + Dexie offline** (GPS, cámara, háptico, cola de sync); mantener Capacitor en el monorepo es más simple que recrearlo en un repo aparte.
- Nx da bundle chico + deploy independiente **sin** duplicar código.

**Invariante de seguridad:** **no borrar** las implementaciones viejas hasta que `apps/vendor`
esté **verificado en prod** (mismo criterio que el README del portal).

## Hallazgos del workspace (2026-06-11)
- Nx **20.8** + `@nx/angular` **20.0**, Angular **18.2**. Generador `@nx/angular:application` OK.
- `apps/view` build = `@nx/angular:browser-esbuild`, standalone, **serviceWorker** (`ngsw-config.json`), styles `styles.css` + `styles/tokens.css`.
- `@capacitor/core` **8.3** es **runtime-only** (sin `@capacitor/cli` ni build nativo en el repo) → los plugins (geo/cámara/háptico) corren con fallback web → **apps/vendor como PWA funciona sin build nativo**.
- Libs hoy = backend (`@megadulces/commercial|contracts|logistics|platform-core|trade`) + `shared-auth` (core/ui — posible auth frontend) + `shared-scoring`. **No hay lib frontend de UI/servicios todavía** → hay que crearla.
- **Dependencias del módulo vendedor a extraer:** `PortalService` (+ tipos `PriceRow`/`OrderLine`/`Order`…), core services (`AuthService`, `ThemeService`, `GeolocationService`, `HapticService`, `status-bar`), `permissions`, interceptor de auth, `environments`, `tokens.css` + estilos base, Dexie/offline.

## Plan por fases

| Fase | Qué | Estado |
|---|---|---|
| **V-S.0** | Generar `apps/vendor` (Nx Angular, esbuild, standalone) + sanity build | ✅ 2026-06-11 (build verde 251 kB) |
| **V-S.2** | **app autocontenida (build verde dev+prod, 741 kB / 172 kB gzip)**. Ver "Cómo se hizo realmente" abajo. | ✅ 2026-06-11 |
| ~~V-S.1~~ | **Reemplazada por V-S.2 (copia).** La extracción de libs queda como **V-S.1b cleanup opcional** (dedup). | ↪️ |
| **V-S.3** | Build verde + **Docker listo** (`apps/vendor/Dockerfile` + `nginx.conf` + `start.sh`, patrón del portal: nginx estático + `proxy_pass $API_UPSTREAM`, build context = raíz monorepo, `nx build vendor`). Deploy Railway (servicio propio desde el monorepo, `RAILWAY_DOCKERFILE_PATH=apps/vendor/Dockerfile`, var `API_UPSTREAM`) + **verificar en prod** (login → ruta → take-order → finalizar visita → captura). | 🧪 Docker listo · deploy/verify = usuario |
| **V-S.4** | **BORRAR** del monorepo: `apps/view/.../vendor/` + `apps/view/.../portal/` + sus rutas en `app.routes.ts` + imports muertos. Auditar que ningún módulo restante de `apps/view` importe de `portal/` (hoy `VendorService` sí → se va con el vendedor). Quitar de nav/guards. | ⬜ (SOLO post V-S.3 verificado) |

## Cómo se hizo realmente (V-S.2, 2026-06-11)

Para "que funcione" rápido y **sin tocar `apps/view`** (cero riesgo a la app interna corriendo), `apps/vendor` se armó **autocontenida copiando el cierre transitivo**, NO extrayendo libs (desviación pragmática de ADR-019 — ver V-S.1b):

- **Cierre transitivo = 33 archivos** (calculado con script de imports relativos desde los entrypoints del vendedor). Copiados **mirroreando estructura** en `apps/vendor/src` → los imports relativos (`../../portal/portal.service`, `../../../core/services/...`) **resuelven sin reescribir**.
- Incluye: módulo `vendor/` completo + `portal/portal.service.ts` + `dashboard/vendor-capture/` + `dashboard/captures/{daily-capture.service,daily-capture.models}` + core (`auth/theme/geolocation/haptic/offline-database/offline-sync/offline-daily-capture/route-ping/permissions/geo-validation`.service, `constants/permissions`, `http/{auth.interceptor,visit-form-data}`, `utils/{geo,mx-date}`, `guards/{auth,permission}`) + `modules/auth/login/` + `environments` + `styles/tokens.css` + `tailwind.config.js`/`postcss.config.js`/`styles.css`/`assets`.
- **Wiring nuevo:** `app.routes.ts` (login + `/vendor/*` + redirects, URLs preservadas), `app.config.ts` (router + http+`authInterceptor` + animations + PrimeNG Aura `darkModeSelector .theme-monochrome` + Confirmation/MessageService), `app.component` (router-outlet + `p-toast`), `index.html` (fuentes/manifest/PWA), assets → `public/`, budgets subidos, leaflet dropeado.
- **environment** auto-detecta (localhost→`:3334/api`, prod→`/api`) igual que view/portal. **Sin proxy** (view/portal usan API absoluta en localhost y funcionan → la API permite CORS dev).
- **Sin Service Worker** todavía (offline = Dexie, no necesita el SW de Angular). Agregar `ngsw-config.json` + `provideServiceWorker` si se quiere PWA cacheada.

**Serve local:** `nx serve vendor --port 4201` (view sigue en 4200). **Build:** `nx build vendor` (verde).

**Pendiente runtime (V-S.3):** verificar que el `login.component` post-auth navegue a `/vendor` (en view podía ir a otra ruta por rol; acá el `**`→`/vendor` lo atrapa, pero conviene confirmar/afinar).

## Riesgos / notas
- **V-S.1 churn:** extraer core services obliga a reapuntar imports en los módulos que `apps/view` conserva (dashboard/comercial/logística/admin usan `AuthService`/`ThemeService`). Mecánico pero amplio → hacerlo con find-replace por alias y build tras cada lib.
- **Borrado de `/portal` (V-S.4):** el standalone `Portal_MegaDulces` ya está en prod, así que borrar el `/portal` del monorepo cierra la deuda de "dos copias". Pero **no** se puede borrar antes de cortar la dependencia `VendorService → PortalService` (se resuelve en V-S.1/V-S.2 al mover el vendedor a la lib `commercial-client`).
- **Deploy del vendedor:** decidir A (repo/servicio nginx-proxy como portal, build del monorepo) vs B (otra estrategia). El portal prueba el patrón nginx `proxy_pass $API_UPSTREAM` (mismo origen, sin CORS) — reusable.
- **Capacitor nativo:** si en el futuro se quiere APK/iOS del vendedor, se agrega `@capacitor/cli` + proyecto nativo en `apps/vendor`; hoy PWA basta.
