# apps/portal — Tienda B2B (deploy aparte)

App Angular **independiente** del portal B2B de Mega Dulces, separada de `apps/view`
(la app interna: dashboard/trade/comercial/logística). Mismo backend, distinto bundle
y distinto link.

## Qué contiene
- Copia del módulo `portal/` + los 4 servicios que necesita (`auth`, `theme`, `haptic`,
  `alerts-socket`) + `environment` + estilos globales (`styles.css` + `styles/tokens.css`).
- Rutas: se conserva el prefijo `/portal/*` (los routerLink internos están hardcodeados);
  la raíz redirige a `/portal/home`.
- Build: `nx build portal` → `dist/apps/portal/browser` (builder `application`).

## Local
```bash
npx nx serve portal        # dev server
npx nx build portal        # build producción
```
`environment.ts` resuelve `apiUrl`: `http://localhost:3334/api` en localhost, `/api` en prod
(el nginx del contenedor proxya `/api` al backend).

## Deploy (Railway, servicio aparte)
1. Crear un **nuevo servicio** en Railway apuntando a este repo, con Dockerfile
   `apps/portal/Dockerfile` (build context = raíz del repo).
2. Variables del servicio:
   - `PORT` → la asigna Railway.
   - `API_UPSTREAM` → URL del backend (servicio principal). Ej:
     - pública: `https://<app-principal>.up.railway.app`
     - interna Railway: `http://<api-service>.railway.internal:3333`
3. Asignar el dominio/subdominio (ej. `pedidos.megadulces.com`).
4. El nginx del portal sirve el SPA y proxya `/api/` + `/reports/socket.io/` (alertas WS)
   a `$API_UPSTREAM`. Como el browser pega al **mismo origen** del portal, no hay CORS.

## Pendiente / notas
- Es una **copia transitoria** del portal que vive también en `apps/view`. Cuando este
  servicio esté en producción, conviene **remover `/portal/*` de `apps/view`** (rutas +
  `modules/portal`) para evitar duplicación.
- No incluye Service Worker (la versión de `apps/view` sí). Agregar si se quiere PWA offline.
- El warning de budget CSS del catálogo (~32kB) se resuelve al terminar el refactor
  `ProductCard` (borrar el CSS dead-code de `portal-catalog`).
