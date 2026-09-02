# Fase CV — Catálogo, verificador de precios y tienda mayorista

> **Objetivo:** traer `megadulces-api-ready` (NestJS 10 standalone, corriendo hoy
> en producción real en `.163`) a este monorepo como `apps/catalogo-kp`,
> preservando su lógica y su fuente de datos (`KP_CONCENTRADA`) — no
> reescribirlo contra `commercial.*`. Migración física, no absorción funcional.
> Estado: 🧪 **CV.0–CV.8 completos** (2026-09-02, CV.4 diferido). Verificación de lectura contra `KP_CONCENTRADA` real completada (paridad byte a byte con `.163:3000`) y rol dedicado `catalogo_kp_runtime` ya aplicado y verificado en el cluster real — ver secciones "Verificación real 2026-09-02" y "Rol dedicado aplicado al cluster real". Pendiente: apuntar el `.env` de producción al rol nuevo, verificación del camino de escritura (`tienda`/`admin`, decisión de negocio), y el corte operacional.

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

## CV.6 — Modelo operativo — 📝 documentado, decisión pendiente de ejecutar (2026-09-01)

**Hallazgo que cambió el enfoque de esta sub-fase:** esta sesión de Claude
Code corre físicamente en `192.168.0.163` — la misma máquina que
`CHECKPOINT.md` describe como "la Aplicación". No hay que planear un cutover
en abstracto: se pudo verificar el estado real.

**Confirmado en vivo (sólo lectura, sin tocar nada):**
- El proceso Node del proyecto origen está corriendo ahora mismo como
  Windows Service (puerto 3000, responde `HTTP 200`).
- Las 3 tareas programadas de `CHECKPOINT.md` existen y están activas
  (`schtasks`, todas en estado "Listo"): `MegaDulces API - vigilante`,
  `MegaDulces - Vigilar sincronizacion de Kepler`, `MegaDulces - Actualizar
  verificador de precios`.
- `Vigilar_API.ps1` resuelve sus rutas en relativo a sí mismo
  (`$api = Split-Path $PSScriptRoot -Parent`) y lanza `node dist\main` — no
  tiene ninguna ruta absoluta al repo viejo hardcodeada, pero sí asume el
  layout de `nest build` (`<raíz>\dist\main.js`), no el de este monorepo
  (`dist\apps\catalogo-kp\main.js`, generado en la raíz del monorepo, no
  dentro de `apps\catalogo-kp\`).

**Hallazgo colateral, ya conocido por 0Sistemas (no es nuevo para este
intento de verificación):** la contraseña de `app_runtime` guardada en el
`.env` real del proyecto origen fue **rechazada** por el `KP_CONCENTRADA`
real (`28P01`, confirmado también con `psql` directo, sin pasar por
`catalogo-kp`) — el mismo síntoma de `GOTCHAS.md` §24. La API en `.163`
sigue arriba porque sus conexiones ya estaban abiertas antes del cambio;
**cualquier reinicio de ese proceso fallaría igual que el 27/08/2026** hasta
que se resuelva. Esto bloquea, de hecho, cualquier cutover real (no se puede
apuntar el Service a `catalogo-kp` sin que arranque con una credencial que
funcione) — pero es un problema de la credencial compartida, no de esta
migración, y ya está en conocimiento de 0Sistemas.

**Recomendación (no ejecutada — requiere ventana de mantenimiento y
autorización explícita, es un cambio a infraestructura viva):**

1. **No reescribir el tooling operativo.** Los vigilantes PowerShell operan
   a nivel de proceso/puerto/HTTP — no les importa de qué repo salió el
   código, sólo que algo responda en `:3000`. Reescribirlos en Node dentro
   del monorepo sería trabajo nuevo sin necesidad.
2. **El corte es de una sola pieza:** compilar `catalogo-kp` desde este
   monorepo (`nx build catalogo-kp`), copiar/enlazar `dist/apps/catalogo-kp/`
   a donde el Windows Service y las 3 tareas programadas ya esperan
   encontrar `dist/`, y ajustar la única asunción de ruta que no calza
   (`Vigilar_API.ps1` espera `dist\main.js` relativo a su propio directorio
   padre — con este layout hay que decirle dónde quedó, o copiar el build al
   lugar de siempre).
3. **Orden de las piezas, no todas a la vez:**
   a. Resolver la credencial de `app_runtime` (ajeno a esta fase, ya en curso).
   b. Aplicar `sql/007_rol_dedicado.sql` — con eso `catalogo-kp` deja de
      depender de esa misma credencial compartida desde el día uno del corte.
   c. Verificación end-to-end real (paridad de precios + carrito/checkout/
      cola contra datos reales) — la que quedó pendiente en CV.0-CV.5.
   d. Recién ahí, el corte del Service/tareas programadas al build nuevo,
      en una ventana acordada — un servicio que hoy sirve pedidos reales no
      se apunta a código nuevo sin haber hecho (a)-(c) primero.
4. **`ADMINISTRAR.bat`** (crear usuario, compilar seguro, configurar correo/
   Mercado Pago) sigue teniendo valor como panel de operación mientras no
   exista un equivalente en este monorepo — no hace falta portarlo para
   cerrar esta fase, sólo apuntar sus rutas al nuevo layout cuando se decida
   el corte.

**Qué NO se tocó en esta sesión:** el Windows Service, las tareas
programadas, ningún archivo de `herramientas/`, ninguna credencial real.
Todo lo de arriba es lectura (`schtasks`, `curl` local, inspección de
scripts) — cero cambios a la infraestructura viva.

**Checklist paso a paso para cuando llegue el momento del corte:**
[`RUNBOOKS/CV_CORTE_CATALOGO_KP.md`](../RUNBOOKS/CV_CORTE_CATALOGO_KP.md) —
secuencia completa (resolver credencial → aplicar rol dedicado vía
`ADMINISTRAR.bat` opción 8 → verificación real → corte del Service/tareas),
con los comandos exactos y las decisiones de riesgo marcadas donde no son
puramente técnicas.

---

## Verificación real 2026-09-02 — bug crítico encontrado y corregido

Con la credencial de `app_runtime` ya resuelta (ver CV.6), se arrancó
`catalogo-kp` contra `KP_CONCENTRADA` real por primera vez desde la migración.
**Ninguna query parametrizada funcionaba**: `/api/kp/precio?q=17083` fallaba
con `Error: Expected 1 bindings, saw 18`.

**Causa raíz** (diagnosticada leyendo `node_modules/knex/lib/raw.js` y
`node_modules/knex/lib/formatter/rawFormatter.js`): `db.raw(sql, bindings)` de
Knex sólo entiende su propia convención de placeholder `?` — no soporta los
placeholders nativos de Postgres `$1, $2, ...`. Cuando `bindings` es un array,
Knex cuenta literalmente cada `?` en el string SQL como un placeholder a
llenar. El código portado (fiel al original, que usaba `pg.Pool.query(sql,
$N)`) usaba `$1`/`$2`/... en todos lados, y además tres constantes de
validación (`RE_NUM` en `kp.service.ts`/`tienda.service.ts`/
`pedidos.service.ts`, `COSTO` en `catalogo.service.ts`) traían regex POSIX con
`?` como cuantificador ("cero o uno"), sumando `?` sueltos que Knex también
contaba como placeholders. Doble colisión con la misma convención.

El patrón ya establecido en la Suite (`kepler-consolidado.service.ts`) sí usa
`?`, no `$N` — este bug era exclusivo del código recién portado.

**Fix:** nuevo `apps/catalogo-kp/src/kp-concentrada/pg-raw.util.ts` — helper
`pgRaw(db, sql, params)` que traduce `$N` → `?` (expandiendo repeticiones)
antes de llamar a `db.raw()`, y devuelve el array de filas directo (no
`{rows: [...]}`). Se convirtieron sistemáticamente **12 archivos de servicio**
(`kp`, `catalogo`, `dashboard`, `auth`, `admin`, `monitor`, y los 8 de
`tienda/`) para pasar por `pgRaw()`, ajustando cada acceso `.rows`/`.rows[0]`/
`.rows.length` a array directo. Las 3 constantes regex con `?` literal se
reescribieron con `{0,1}` (equivalente POSIX libre de `?`).

**Verificado 2026-09-02** contra `KP_CONCENTRADA` real (puerto de prueba
`3092`, app completa con los 8 módulos):

| Endpoint | Resultado |
|---|---|
| `/api/kp/precio?q=17083` | Idéntico byte a byte vs `.163:3000` |
| `/api/kp/precios-todos?sucursal=03` | 9,479 productos, formato correcto |
| `/api/catalogo/sucursales` | Idéntico byte a byte vs `.163:3000` |
| `/api/kp/schema` | 401 sin token (guard-stub correcto) |
| `/api/auth/login` (credenciales inválidas) | 401 idéntico vs `.163:3000` (mismo mensaje) |
| `/api/admin/errores` sin token | 401 (guard correcto) |
| `/api/dashboard/resumen` sin token | 401 (guard correcto) |

Build final con los 8 módulos (`AdminModule`/`TiendaModule` de vuelta):
`webpack compiled successfully`, 304 KiB / 53 módulos — mismo tamaño que el
build de CV.5.

**Lección para el tracker/GOTCHAS:** el build y el boot simulado (CV.0–CV.5)
NO detectan bugs de binding de SQL crudo — sólo una llamada real con
parámetros los expone. Ninguna verificación anterior había ejecutado una
query parametrizada contra una base real hasta este punto.

**No verificado aún (fuera de alcance de esta pasada, requiere autorización
de riesgo de negocio):** el camino de escritura (`carrito`/`checkout`/`cola`)
contra datos reales — `ColaService`, `CarritoService`, `CheckoutService`, y
`PedidosService` usan el mismo `pgRaw()` y el mismo patrón de conversión, pero
no se ejercieron con un pedido real para no competir con la cola viva en
`.163`. Queda como paso explícito en
`RUNBOOKS/CV_CORTE_CATALOGO_KP.md`.

---

## Rol dedicado aplicado al cluster real — 2026-09-02

Con el bloqueante de credencial resuelto (ver CV.6), se aplicó
`sql/007_rol_dedicado.sql` contra `KP_CONCENTRADA` real, cerrando el riesgo
de credencial compartida (P2) que motivó parte de esta fase.

Ejecutado con `psql -h 192.168.0.245 -U postgres -d KP_CONCENTRADA -v
ON_ERROR_STOP=1 -f 007_rol_dedicado.sql` — el mismo mecanismo que usa
`ADMINISTRAR.bat` opción 8 en `.163`. Exit 0, las 17 sentencias
(`DO`/`GRANT`/`ALTER DEFAULT PRIVILEGES`) corrieron sin error, sin tocar
`app_runtime` ni ninguna tabla existente (aditivo, como estaba diseñado).

**Verificado contra el cluster real:**

| Chequeo | Resultado |
|---|---|
| `rolcanlogin` | `t` |
| `rolsuper` / `rolcreatedb` / `rolcreaterole` | `f` / `f` / `f` |
| Grants `kp.*` | SELECT en 368 tablas (sólo lectura) |
| Grants `admin.*` | SELECT en `admin.usuarios` únicamente |
| Grants `tienda.*` | SELECT/INSERT/UPDATE en 10 tablas — sin DELETE |
| Grants `monitor.*` | según spec del script (sin DELETE) |
| Smoke: `SELECT count(*) FROM kp.kdii` conectado como `catalogo_kp_runtime` | 66,682 filas — OK |
| Smoke: `DELETE FROM tienda.pedidos` conectado como `catalogo_kp_runtime` | `ERROR: permiso denegado` — esperado |

**Higiene de secretos:** la contraseña real generada para el rol nuevo se
escribió únicamente en la copia de `sql/007_rol_dedicado.sql` dentro de
`megadulces-api-ready` (carpeta externa a este git, igual que cualquier
`.env` con secretos reales). El archivo versionado en `apps/catalogo-kp/sql/`
de este monorepo mantiene el placeholder `CAMBIA_ESTE_PASSWORD` — nunca se
comiteó un secreto real.

**Pendiente:** `DATABASE_URL_KP_CONCENTRADA` del `.env` real de producción
sigue apuntando a `app_runtime`. El corte a `catalogo_kp_runtime` se puede
hacer sin downtime (ambos roles siguen concediendo acceso mientras tanto),
pero no se ejecutó en esta sesión por afectar el proceso que sirve
producción real — ver `RUNBOOKS/CV_CORTE_CATALOGO_KP.md` Paso 2.

---

## Preguntas abiertas para 0Sistemas

- ¿`/api/kp/concentrada` (kp-excel) — confirmado en uso, incluido en CV.0.
  Revisar si conviene migrar su fuente (JSON generado por un script Python
  externo) a algo más integrado en un sub-sprint futuro.
- ¿Cuándo aplicar `007_rol_dedicado.sql` contra el `KP_CONCENTRADA` real, y
  quién lo corre?
- ~~`salidas` (CV.4) — ¿sigue en uso en producción?~~ **Resuelto 2026-09-01:
  no está en uso real hoy. Diferido.**
- ~~Modelo operativo final (CV.6) — ¿`.163` sigue siendo el destino?~~
  **Resuelto 2026-09-01: sí, confirmado en vivo — `.163` es esta misma
  máquina, con el Service y las 3 tareas programadas activas.** Queda
  pendiente decidir CUÁNDO ejecutar el corte (ver recomendación en CV.6:
  después de resolver la credencial de `app_runtime` + `007_rol_dedicado.sql`
  + verificación end-to-end real).
- **Nuevo:** la credencial de `app_runtime` guardada en el `.env` de
  producción del proyecto origen no autentica contra el `KP_CONCENTRADA`
  real (confirmado 2026-09-01, ver CV.6) — 0Sistemas indica que ya está en
  conocimiento/gestión. Cualquier reinicio del Service en `.163` antes de
  resolverlo repetiría la caída del 27/08.
