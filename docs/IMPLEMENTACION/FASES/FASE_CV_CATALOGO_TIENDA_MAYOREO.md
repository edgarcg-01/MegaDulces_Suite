# Fase CV — Catálogo, verificador de precios y tienda mayorista

> **Objetivo:** traer `megadulces-api-ready` (NestJS 10 standalone, corriendo hoy
> en producción real en `.163`) a este monorepo como `apps/catalogo-kp`,
> preservando su lógica y su fuente de datos (`KP_CONCENTRADA`) — no
> reescribirlo contra `commercial.*`. Migración física, no absorción funcional.
> Estado: 🔨 **CV.2 en código** (2026-09-01).

---

## 0. Por qué existe esta fase

0Sistemas pidió integrar varios proyectos externos a la estructura de esta
Suite. El primero: un catálogo público + verificador de precios de mostrador +
tienda mayorista en construcción, construido de forma independiente por
"Felipe-Diseño", corriendo en 3 máquinas físicas on-prem (`.249` pipeline
Kepler → `.245` Postgres `KP_CONCENTRADA` → `.163` la API NestJS + páginas
HTML). Está a mitad de su propia Fase 2 (tienda transaccional): carrito,
checkout, confirmación de pedidos y una cola de trabajos ya funcionan; sólo
falta el cobro real (Mercado Pago, credenciales pendientes).

**No es terreno nuevo para la Suite.** `KP_CONCENTRADA` ya es un activo
documentado — `docs/IMPLEMENTACION/RUNBOOKS/KP_CONCENTRADA.md` — poblado por
`database/importers/kepler/concentrate-kepler.js`. El proyecto a migrar es un
consumidor adicional, no documentado hasta ahora, de esa misma base. Y
comparte, sin que el equipo lo supiera, el mismo **cluster** Postgres `.245`
que `postgres_platform` — `docs/GOTCHAS.md` §24 ya advertía sobre esto y
nombra `KP_CONCENTRADA` explícitamente. Es probable (no confirmado) que esto
haya causado la caída de 6 horas del 27/08/2026 que el proyecto origen
registra como "nadie sabe quién cambió la contraseña en `.245`".

## 1. Principios de arquitectura (aplican a todos los sub-sprints)

| # | Principio | Por qué |
|---|---|---|
| P1 | **On-prem, no Railway.** Ninguna base de Kepler es alcanzable desde Railway (mismo principio ya aceptado en `FASE_KV_EXPLOTACION_KEPLER.md` §0, A1 para `kepler-consolidado`). `catalogo-kp` sigue corriendo en `.163` (o donde decida operaciones), compilado desde este monorepo. Sin `railway.catalogo-kp.json`, sin Dockerfile — primer app Nx de la Suite sin ciclo de vida en Railway. |
| P2 | **Credencial propia, no compartida.** `catalogo_kp_runtime` (dedicado), nunca `app_runtime` — ver GOTCHAS §24 y `apps/catalogo-kp/sql/007_rol_dedicado.sql`. |
| P3 | **Lógica preservada, no reescrita.** El SQL crudo, las reglas de negocio (mayoreo, envío, verificador) y el motor de colas se portan tal cual — sólo cambia el mecanismo de conexión (`pg.Pool` → Knex plano) y el framework (NestJS 10 → 11). |
| P4 | **Migraciones SQL crudas, aplicadas a mano.** `sql/*.sql` por `psql` como superusuario — nunca por el framework Knex de migraciones de la Suite, para no aflojar la separación de privilegios (`catalogo_kp_runtime` sin DDL) que el proyecto origen ya documenta como deliberada. |
| P5 | **Sin dependencias nativas nuevas.** `bcrypt` (nativo) del proyecto origen se porta como `bcryptjs` (ya usado en toda la Suite) — mismo hash `$2a$/$2b$`, sin tocar el árbol de dependencias nativas del monorepo. |
| P6 | **Nada se expone sin verificar auth.** Mientras `auth` no esté portado, los endpoints que en origen exigían sesión responden 503 (`PendingAuthGuard`), no quedan abiertos. |
| P7 | **Secretos con nombre propio, no compartido.** `CATALOGO_KP_JWT_SECRET`, no `JWT_SECRET` — ese nombre ya lo usa el auth multi-tenant de esta Suite (33 archivos); compartirlo firmaría/validaría tokens de dos sistemas de auth distintos con el mismo secreto. Mismo criterio que P2 (rol de DB dedicado), aplicado a JWT. |

## 2. Mapa de la fase

```
CV.0  Scaffold + conexión DB + rol dedicado + módulo kp completo   ✅
CV.1  auth (JWT+bcryptjs) + admin (usuarios/roles)                 ✅
CV.2  catalogo (tablero interno, gating costo/margen) + dashboard  ← esta entrega
CV.3  monitor (captura de errores del navegador)
CV.4  salidas (reporte genérico)
CV.5  tienda completo: carrito, checkout, cola.service.ts, avisos, pagos   ← dinero real
CV.6  (aparte, no bloqueante) modelo operativo: watchdogs/alertas/secret-wizards de herramientas/
```

**Orden recomendado:** CV.0 → CV.1 → CV.2 → CV.3 → CV.4 → CV.5. CV.6 se resuelve cuando haya decisión de dónde y cómo corre `catalogo-kp` en producción a largo plazo — no bloquea nada de lo anterior.

---

## CV.0 — Scaffold + módulo `kp` — 🧪 código+build+boot verificados (2026-09-01)

**Qué entrega:** `apps/catalogo-kp` compilando (NestJS 11), sirviendo estáticos
(`catalogo.html`) y respondiendo `/api/kp/*` con datos en vivo de
`KP_CONCENTRADA`. Sólo el módulo `kp` (incluye `kp-excel` — el endpoint
`/concentrada` sigue en uso). `auth`/`tienda`/`admin`/etc. no estaban portados
en esta entrega; sus rutas equivalentes (las que en origen exigían sesión)
respondían 503 explícito vía `PendingAuthGuard` (retirado en CV.1, ver abajo).

**Decisiones de esta entrega:**
- Conexión: provider Knex plano `KNEX_KP_CONCENTRADA` (`src/kp-concentrada/`),
  **fail-fast** si `DATABASE_URL_KP_CONCENTRADA` falta — a diferencia del
  patrón `kepler-consolidado` (cron opcional, null-safe), esta conexión es el
  núcleo del app, no algo que pueda quedar inerte en silencio.
- Rol dedicado `catalogo_kp_runtime` preparado en `sql/007_rol_dedicado.sql`
  (aditivo, no toca `app_runtime`) — su aplicación contra el cluster real de
  `.245` la confirma 0Sistemas o quien administre esa base.
- `public/img/productos/` (112 fotos, ~9.3MB) versionado. Los
  `verificador-NN.html` reales (se regeneran a diario) **no se versionan**
  (`.gitignore`).
- SQL crudo idéntico al original; único cambio mecánico: `pool.query()` →
  `knex.raw()`.

**Verificado en sesión (sin LAN a `.245`):** `nx build`/`nx lint` limpios (0
errores). Arranque real con DB simulada inalcanzable — **encontró y corrigió
un bug propio de la migración**: la ruta de estáticos (`join(__dirname, '..',
'public')`, fiel al layout plano del `nest build` original) daba 404 en el
layout de Nx, donde `public/` es hermano de `main.js`, no un nivel arriba.
Corregido a `join(__dirname, 'public')`. Confirmado: estáticos + API en el
mismo proceso, errores de DB devuelven JSON controlado (no tumban el
proceso), endpoints protegidos sin fuga de datos. `nx build api` sigue verde.

**Pendiente (requiere LAN on-prem a `.245`):** la comparación byte a byte de
`/api/kp/precio` y `/api/kp/precios-todos` contra `.163:3000` con datos
reales, y aplicar `sql/007_rol_dedicado.sql`.

**Deferido explícitamente de CV.0:** `drive.service.ts` (código muerto en el
proyecto origen — no wireado en `AppModule`, sin credencial en `.env` — no se
porta hasta que haya un uso real).

---

## CV.1 — `auth` + `admin` (usuarios) — 🧪 código+build+boot verificados (2026-09-01)

**Qué entrega:** JWT propio + `bcryptjs` sobre `admin.usuarios`
(`AuthService`/`AuthController`/`JwtStrategy`), y `AdminController`/
`RolesGuard`/`roles.decorator.ts` para el CRUD de usuarios del tablero (rol
`admin`). Los endpoints de `kp` que en CV.0 tenían `PendingAuthGuard` (503)
ahora usan `AuthGuard('jwt')` de verdad — `PendingAuthGuard` se retiró del
código, ya no lo usa nadie.

**Decisión nueva — P7, secreto propio:** `CATALOGO_KP_JWT_SECRET`, no
`JWT_SECRET`. Se encontró que `JWT_SECRET` ya está en uso en 33 archivos del
auth multi-tenant de esta Suite — reusar el nombre habría firmado/validado
tokens de dos sistemas de auth completamente distintos con el mismo secreto
si algún día comparten `.env` de dev. Mismo criterio que llevó a
`catalogo_kp_runtime` en CV.0 (GOTCHAS §24), aplicado a JWT en vez de a DB.

**El fallback inseguro se retira.** El original traía
`process.env.JWT_SECRET || 'megadulces-secret-cambiar-en-prod'` como
respaldo silencioso. Se reemplaza por **fail-fast**: `AuthModule` y
`JwtStrategy` hacen `throw` en boot si `CATALOGO_KP_JWT_SECRET` falta —
mismo criterio que `KpConcentradaModule` en CV.0. Verificado: sin el secreto,
el proceso ni siquiera llega a intentar la conexión a la DB.

**Recorte de alcance real, no cosmético:** el `AdminController` original
también fronteaba `pedidos/pagos/cola` — pero esas rutas dependen de
`PagosService`/`ColaService`/`PedidosService`/`AvisosService`, todos del
módulo `tienda` (CV.5, aún no portado). Se agregan al mismo controller
(mismas rutas `/api/admin/pedidos/*`, `/api/admin/pagos`, `/api/admin/cola*`)
cuando `tienda` aterrice, no antes — no tiene sentido fingir esas rutas con
otro guard-stub cuando de todas formas van a cambiar de forma en CV.5.

**Verificado en sesión (sin LAN a `.245`):** `nx build`/`nx lint` limpios (0
errores, 52 warnings `no-explicit-any` heredados del estilo original).
Arranque real: sin `CATALOGO_KP_JWT_SECRET` falla antes de tocar la DB; con
ambos secretos (DB falsa) — `/api/admin/usuarios` y `/api/kp/productos` sin
token → 401 (ya no 503); `/api/kp/precio` sigue público; `/api/auth/login`
falla controlado (500 genérico de Nest, sin filtrar nada) cuando la DB no
responde — mismo comportamiento que tendría el original ante el mismo fallo,
no es una regresión.

**Pendiente (requiere LAN on-prem a `.245`):** login real contra
`admin.usuarios` con un usuario de verdad, y confirmar que un hash bcrypt
existente (creado con `bcrypt` nativo en origen) valida igual con
`bcryptjs` — ambos implementan el mismo algoritmo y prefijo `$2a$/$2b$`, pero
no se verificó contra un hash real todavía.

## CV.2 — `catalogo` (tablero interno) + `dashboard` — 🧪 código+build+boot verificados (2026-09-01)

**Qué entrega:** `CatalogoService`/`CatalogoController` (catálogo paginado con
existencia/precio por sucursal, sucursales, filtros familia/subfamilia/marca,
frescura de datos, ficha de producto) y `DashboardService`/
`DashboardController` (rollup de ventas anual/mensual + top-3 sucursales).
Sin dependencias de módulos aún no portados — puerto directo.

**Bug encontrado y corregido antes de probarlo** (mismo tipo que el de
`main.ts`/estáticos en CV.0): `getImagenes()` leía
`join(__dirname, '..', '..', 'public', 'img', 'productos')`, ruta correcta
para el layout de `nest build` del proyecto origen (`dist/catalogo/*.js`,
dos niveles hasta la raíz) pero rota en el bundle único de Nx
(`dist/apps/catalogo-kp/main.js`, `public/` ya es hermano directo). Corregida
a `join(__dirname, 'public', 'img', 'productos')` **antes** de compilar, no
descubierta por un 404 — se identificó por inspección al portar, y se
verificó después: `/api/catalogo/imagenes` devuelve las 112 fotos reales.

**Gating de costo/margen preservado tal cual:** `esInterno(req)` (de
`auth/sesion.util.ts`, CV.1) decide si `getCatalogo`/`getProducto` incluyen
costo, margen y valor de inventario — mismo mecanismo de "sesión opcional"
del proyecto origen, sin guard que rechace: el mismo endpoint sirve a la
tienda anónima y al tablero interno.

**Verificado en sesión (sin LAN a `.245`):** `nx build`/`nx lint` limpios (0
errores). Un import de un tipo (`CatalogoQuery`) se corrigió a
`import type` — sin eso, SWC/webpack lo dejaba como `require` en el JS
emitido y generaba un warning de export inexistente en runtime (la interfaz
no existe compilada; el TS del proyecto origen lo elidía solo, este
toolchain no). Arranque real: rutas de `catalogo`/`dashboard` mapeadas,
`/api/catalogo/imagenes` correcto contra el disco real, `/api/catalogo`
falla controlado ante DB inalcanzable (500 genérico, mismo comportamiento
que tendría el original ante el mismo fallo — no hay try/catch en
`getCatalogo` tampoco en origen), `/api/dashboard/resumen` sin token → 401.

## CV.3 — `monitor` (captura de errores del navegador) — ⬜ TODO

Ingesta pública de errores del navegador con dedupe por hash, sin Sentry.

## CV.4 — `salidas` (reporte genérico) — ⬜ TODO

Módulo parametrizable por env (`SALIDAS_TABLA`/`SALIDAS_*`) apuntando a
`public.salidas`. Confirmar con 0Sistemas si sigue en uso antes de portarlo.

## CV.5 — `tienda` completo — ⬜ TODO — dinero real

El módulo más grande y de mayor riesgo: `carrito.service.ts` (tokens HMAC),
`checkout.service.ts` (folio, datos fiscales, aviso de privacidad),
`pedidos.service.ts` (confirmación en lote, `FOR UPDATE`),
`cola.service.ts` (motor `SKIP LOCKED` + backoff exponencial + reclamo de
huérfanos — **portar sin cambiar ni un detalle de comportamiento**, es el
componente que garantiza "ningún pedido se pierde si la API muere a medio
proceso"), `avisos.service.ts` (SMTP, ya wireado), `pagos.service.ts`
(Mercado Pago, credenciales aún no cargadas). Incluye agregar las rutas
`pedidos/pagos/cola` al `AdminController` de CV.1 (recortadas ahí por
depender de estos servicios — ver CV.1). Migraciones `002`-`005` ya copiadas
en CV.0 (sql/), pendiente de aplicar en el `KP_CONCENTRADA` real si no lo
están ya.

## CV.6 — Modelo operativo (aparte, no bloqueante) — ⬜ TODO

`herramientas/` del proyecto origen mezcla (a) scripts de prueba de
integración reusables como tests y (b) tooling atado al modelo actual
on-prem-Windows: vigilantes PowerShell (`Vigilar_API.ps1`,
`Vigilar_Sincronizacion.ps1`), tareas programadas, un `.bat` de menú, wizards
interactivos que escriben secretos al `.env`. Ninguna de (b) se porta como
código — es una decisión de despliegue separada (¿sigue siendo un Windows
Service en `.163`? ¿se moderniza a algo supervisado desde este monorepo?) que
no bloquea CV.1-CV.5.

---

## Preguntas abiertas para 0Sistemas

- ¿`/api/kp/concentrada` (kp-excel) — confirmado en uso, incluido en CV.0.
  Revisar si conviene migrar su fuente (JSON generado por un script Python
  externo) a algo más integrado en un sub-sprint futuro.
- ¿Cuándo aplicar `007_rol_dedicado.sql` contra el `KP_CONCENTRADA` real, y
  quién lo corre?
- `salidas` (CV.4) — ¿sigue en uso en producción?
- Modelo operativo final (CV.6) — ¿`.163` sigue siendo el destino, o cambia
  con esta migración?
