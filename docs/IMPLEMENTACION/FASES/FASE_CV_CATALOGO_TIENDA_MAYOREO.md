# Fase CV — Catálogo, verificador de precios y tienda mayorista

> **Objetivo:** traer `megadulces-api-ready` (NestJS 10 standalone, corriendo hoy
> en producción real en `.163`) a este monorepo como `apps/catalogo-kp`,
> preservando su lógica y su fuente de datos (`KP_CONCENTRADA`) — no
> reescribirlo contra `commercial.*`. Migración física, no absorción funcional.
> Estado: 🧪 **CV.5 en código, roadmap principal cerrado** (2026-09-01). Sólo queda CV.6 (modelo operativo, no bloqueante) y CV.4 diferido.

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
CV.2  catalogo (tablero interno, gating costo/margen) + dashboard  ✅
CV.3  monitor (captura de errores del navegador)                   ✅
CV.4  salidas (reporte genérico)                                   ⏸️ diferido — sin uso real hoy (confirmado por 0Sistemas, 2026-09-01)
CV.5  tienda completo: carrito, checkout, cola.service.ts, avisos, pagos   ✅ — dinero real
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

## CV.3 — `monitor` (captura de errores del navegador) — 🧪 código+build+boot verificados (2026-09-01)

**Qué entrega:** `ErroresService`/`ErroresController` — ingesta pública
(`POST /api/errores`) de errores del navegador, con dedupe por hash SHA-256
(mensaje + origen + primera línea del rastro, números normalizados), tope de
20/min por IP, recorte de todos los campos, y tablero interno
(`GET/POST /api/admin/errores*`, `AuthGuard('jwt')` real desde CV.1). Sin
dependencias de módulos no portados — puerto directo.

**El contrato más importante del módulo, verificado exacto:** `POST
/api/errores` **nunca** falla visible al navegador, ni con la base
completamente inalcanzable — el visitante ya tuvo un error, no se le suma
otro. Probado con `DATABASE_URL_KP_CONCENTRADA` apuntando a un puerto muerto:
`{"ok":true}` de todas formas.

**Sin bugs de ruta esta vez** — `errores.service.ts` no toca el disco (a
diferencia de `getImagenes()` en CV.2), así que no había ningún `__dirname`
que ajustar.

**Verificado en sesión (sin LAN a `.245`):** `nx build`/`nx lint` limpios (0
errores). Arranque real: las 4 rutas mapeadas
(`/api/errores`, `/api/admin/errores`, `/api/admin/errores/:id`,
`/api/admin/errores/:id/resolver`) sin colisión con las rutas de
`AdminController` (`/api/admin/usuarios*`) pese a compartir el prefijo
`/api/admin`; `POST /api/errores` → `{"ok":true}` con DB inalcanzable;
`GET /api/admin/errores` sin token → 401.

## CV.4 — `salidas` (reporte genérico) — ⬜ TODO

Módulo parametrizable por env (`SALIDAS_TABLA`/`SALIDAS_*`) apuntando a
`public.salidas`. Confirmar con 0Sistemas si sigue en uso antes de portarlo.

## CV.5 — `tienda` completo — 🧪 código+build+boot verificados (2026-09-01) — dinero real

**Qué entrega:** los 9 archivos de dominio de `tienda` completos —
`tienda.service.ts`/`.controller.ts` (catálogo de mayoreo, reglas de unidad y
envío), `carrito.service.ts`/`.controller.ts` (tokens HMAC, revalidación de
precio/existencia), `checkout.service.ts`/`.controller.ts` (folio, datos
fiscales, aviso de privacidad, dos flujos de pago), `cola.service.ts` (el
motor `SKIP LOCKED` + backoff exponencial + reclamo de huérfanos),
`avisos.service.ts` (SMTP), `pagos.service.ts` (config de Mercado Pago, sin
tocar DB), `pedidos.service.ts` (pantalla de confirmación en lote), y
`horario.ts` (copiado literal, sin cambios — es lógica pura). Las rutas
`pedidos/pagos/cola` vuelven al `AdminController` de CV.1, que ahora importa
`TiendaModule`.

**Decisión de arquitectura — transacciones con Knex, no `pg.Pool.connect()`:**
el original abría una conexión dedicada por servicio (`this.pool.connect()` +
`BEGIN`/`COMMIT`/`ROLLBACK` manual) y pasaba ese `PoolClient` entre servicios
para enlazar operaciones en la misma transacción (p. ej. `checkout()` inserta
el pedido y programa su aviso en la MISMA transacción). Se porta con
`this.db.transaction(async (trx) => {...})` — commit automático si resuelve,
rollback automático si lanza — y el `PoolClient` se reemplaza por el objeto
`trx` (tipo `Knex`), que se pasa exactamente igual entre `checkout.service` →
`avisos.programar(..., trx)`, o `pedidos.service` → `avisar(trx, ...)` →
`avisos.programar(..., trx)`. Mismo comportamiento transaccional, sin BEGIN/
COMMIT/ROLLBACK manual. Simplificación adicional en `carrito.service.ts`:
`quitar()`/`cancelar()` tomaban una conexión sólo para anotar un evento sin
ninguna transacción real de por medio (ni BEGIN ni COMMIT en el original) —
se llama `this.anotar(this.db, ...)` directo, comportamiento idéntico.

**`ColaService` ya no abre su propia conexión dedicada** (`max:4` en el
original) — usa la `KNEX_KP_CONCENTRADA` compartida de todo el app (`max:10`),
mismo criterio que el resto de los servicios desde CV.0. Por eso
`onModuleDestroy` ya no cierra el pool: no es dueño de esa conexión. El resto
del motor —`FOR UPDATE SKIP LOCKED`, `intentos` sumados al tomar no al fallar,
`GRACIA_ARRANQUE_MIN=2` no-cero, `devolverEnVuelo()` al apagar— se portó
línea por línea sin cambiar ninguna constante ni ninguna consulta.

**P7 aplicado dos veces más:** `carrito.service.ts` y `checkout.service.ts`
firman sus tokens (HMAC del carrito, token de seguimiento del pedido) con
`CATALOGO_KP_JWT_SECRET`, no `JWT_SECRET` — mismo criterio que CV.1 aplicado
a la firma de tokens, no sólo a las sesiones JWT.

**Verificado en sesión (sin LAN a `.245`):** `nx build`/`nx lint` limpios (0
errores; 195 warnings `no-explicit-any` heredados). Un error de tipos
(`const resultados = []` inferido como `never[]` por este toolchain, no por
el original) se corrigió con una anotación explícita. Arranque real con DB
simulada inalcanzable:
- Las 3 comprobaciones de migración (`carrito`/`checkout`/`cola`) fallan
  gracioso con el mismo mensaje que el original ("falta la migración...").
- `TiendaModule.onModuleInit()` — el punto más delicado de inyección cruzada
  (`PagosService`+`ColaService`+`AvisosService` en el constructor del módulo,
  más el registro del manejador `aviso_cliente`) — funcionó: log
  `Manejador registrado para 'aviso_cliente'`.
- `GET /api/tienda/config` y `GET /api/tienda/checkout/opciones` responden
  correcto (el segundo ya excluye TARJETA de los métodos porque Mercado Pago
  no está configurado — `pagos.metodosDisponibles()` real, no simulado).
- `POST /api/tienda/carrito` con DB inalcanzable → mensaje de migración
  faltante, no un 500 crudo.
- `GET /api/admin/cola` y `GET /api/admin/pagos` sin token → 401.
- Las 26 rutas de `tienda`/`carrito`/`checkout` y las 12 de
  `admin/pedidos`+`admin/cola`+`admin/pagos` quedaron mapeadas sin colisión.
- `nx build api` sigue verde con las 2 dependencias nuevas (`nodemailer`,
  `jsonwebtoken` ya venía de CV.1).

**Pendiente (requiere LAN on-prem a `.245`), y es lo único que falta para dar
por cerrada la fase principal:**
- Ejercer el motor de la cola contra Postgres real: `FOR UPDATE SKIP LOCKED`,
  reintentos, reclamo de huérfanos — el original tiene sus propios bancos de
  prueba (`herramientas/probar_cola.js`, `probar_cola_avanzado.js`) que valen
  la pena portar o al menos correr manualmente antes de confiar en esto con
  dinero real.
- Un checkout de punta a punta: crear carrito → agregar → checkout → aparece
  en `/admin/pedidos/por-confirmar` → confirmar → aviso encolado y enviado
  (requiere SMTP real).
- Aplicar `sql/007_rol_dedicado.sql` + comparación de precios contra
  `.163:3000` (pendiente desde CV.0).

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
