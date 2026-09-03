# Fase CV — Catálogo, verificador de precios y tienda mayorista

> **Objetivo:** traer `megadulces-api-ready` (NestJS 10 standalone, corriendo hoy
> en producción real en `.163`) a este monorepo como `apps/catalogo-kp`,
> preservando su lógica y su fuente de datos (`KP_CONCENTRADA`) — no
> reescribirlo contra `commercial.*`. Migración física, no absorción funcional.
> Estado: 🟢 **CV.0–CV.16 completos — migración cerrada** (2026-09-03, CV.4 diferido). `.163` corre en producción real desde este monorepo: rol dedicado, lectura/escritura verificadas de punta a punta (incluido el primer pedido real de la historia, folio `MD-2026-00012`), frontend Angular nuevo (`apps/tienda`) para el checkout transaccional, el corte real del Service (Paso 4 del runbook) completado y verificado con 0 fallos, y un reporte nuevo para MKT (`actualizar-wix.html`) que reemplaza el flujo manual Python+laptop+artefacto de sincronización con Wix. Pendiente, no bloqueante: panel interno (fuera de alcance de esta fase) y vigilar de cerca las próximas horas.

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

## Camino de escritura — canario verificado, carrito real pendiente (2026-09-02)

0Sistemas autorizó avanzar con el Paso 3b del runbook, con el enfoque de
menor riesgo: canario ahora (no toca dinero), carrito real de punta a punta
en una ventana fuera de horario a definir después.

Corrido en horario de oficina, app completa (`tienda`+`admin`) contra
`KP_CONCENTRADA` real, ya con **`catalogo_kp_runtime`** (primera vez que el
rol dedicado se ejercita en escritura):

| Prueba | Resultado |
|---|---|
| `POST /api/admin/cola/prueba` (simple) | `HECHO` al primer intento, `cuenta.hechos` 0→1 |
| `POST /api/admin/cola/prueba` con `fallar_hasta:2` | Falló 2 veces, backoff exacto (60s, 120s — `esperaSegundos()`), `HECHO` al 3er intento, sin `fallidos` ni `PENDIENTE` colgado |

Confirma el motor de colas (`FOR UPDATE SKIP LOCKED`, reintentos, backoff
exponencial) funcionando contra datos reales sin competir visiblemente con
el proceso viejo de `.163`, y confirma que `catalogo_kp_runtime` tiene los
permisos de escritura correctos sobre `tienda.trabajos`.

**No se ejecutó** el carrito real de punta a punta (crear→agregar producto→
checkout OXXO→confirmar→verificar aviso) — queda para la ventana fuera de
horario que 0Sistemas defina. Detalle de la ejecución en
`RUNBOOKS/CV_CORTE_CATALOGO_KP.md`, Paso 3b.

**Actualización 2026-09-02:** completado. El carrito/checkout de punta a
punta, incluido el envío final, se ejerció contra producción real — ver
CV.11 (frontend nuevo) y la sección "Verificación final: primer pedido
real de la historia" más abajo. Folio `MD-2026-00012`, cancelado después
por ser explícitamente de prueba.

---

## Revisión visual de la interfaz — 2 archivos estáticos faltantes encontrados y corregidos (2026-09-02)

0Sistemas pidió revisar la interfaz completa. Al inventariar qué páginas
existen en el proyecto origen (`public/*.html`) contra lo que CV.0 había
portado, aparecieron **dos gaps reales**, ninguno detectado por la
verificación de API de CV.0–CV.7 porque esa verificación probó respuestas
JSON, no la carga de cada página HTML servida:

- **`public/tienda.html` nunca se portó.** Es la vista de catálogo para el
  cliente mayorista (browse + carrito **local**, en `localStorage` — no
  llama a `/api/carrito` ni `/api/checkout`, sólo a `/api/catalogo/*` y
  `/api/kp/precio`, todos ya portados desde CV.2). Copiado literal a
  `apps/catalogo-kp/public/tienda.html`.
- **`public/reportar-errores.js` nunca se portó** — y esto es más grave:
  `catalogo.html` (ya "verificado" desde CV.0/CV.2) lo referencia
  (`<script src="/reportar-errores.js">`), así que esa página llevaba desde
  el principio un 404 silencioso en su primer script, sin que ninguna
  verificación anterior lo notara (probaban rutas de API, no la carga
  completa de la página en un navegador real). Copiado literal a
  `apps/catalogo-kp/public/reportar-errores.js`.

**Verificado con un navegador real (Playwright) contra `KP_CONCENTRADA`
real**, `nx build` con ambos archivos incluidos:

| Página | Resultado |
|---|---|
| `catalogo.html` | Carga limpio (sólo 404 de `favicon.ico`, inocuo). Gate de login se activa correctamente sin sesión ("Esta vista muestra costos y márgenes. Requiere cuenta."). |
| `tienda.html` | Carga con datos reales: 6,168 productos / 11 categorías / 6 sucursales, timestamp de inventario al minuto. Filtros (subcategoría, marca, disponibilidad, precio) visibles. "Agregar" al carrito local funciona (badge del carrito se actualiza). |
| `reportar-errores.js` | Sirve 200, ya no 404. |

**Lección para el tracker:** ninguna fase de esta migración había cargado
una página HTML completa en un navegador hasta ahora — todas las
verificaciones anteriores (CV.0–CV.7) probaron endpoints JSON directamente.
Un 404 de un `<script>` no rompe la carga de la página (por eso pasó
desapercibido), pero si `reportar-errores.js` fuera el único mecanismo para
detectar errores de checkout en producción, esa telemetría llevaba
apagada desde el día uno de la migración.

---

## CV.11 — Frontend Angular real para el checkout transaccional (2026-09-02)

0Sistemas pidió revisar toda la interfaz y, al confirmar que `tienda.html`
sólo arma un carrito local para WhatsApp (nunca llama al backend real —
ver "Revisión visual de la interfaz" arriba), decidió construir el primer
frontend real del checkout transaccional en vez de replicar ese flujo.
Plan de diseño completo (contratos de backend, árbol de rutas, estado,
sistema de diseño) en `docs/IMPLEMENTACION/RUNBOOKS/` no aplica — el plan
vivió en el plan-mode de la sesión; este documento resume el resultado.

**Nuevo app Nx standalone: `apps/tienda`** (Angular 22, zoneless, esbuild),
siguiendo el patrón ya establecido donde `apps/portal`/`apps/vendor` son
apps propios, no módulos de `apps/view`. Detalle de arquitectura y comandos
de build/deploy en [`apps/tienda/README.md`](../../../apps/tienda/README.md).

**Decisión de despliegue:** on-prem, junto al backend — el build se copia a
`apps/catalogo-kp/public/tienda/` y lo sirve el mismo proceso NestJS (mismo
origen, cero CORS nuevo, cero exposición pública nueva). `tienda.html`
sigue viva sin tocarse en su URL de siempre; el app nuevo vive en `/tienda/`
(con barra, para no confundirse con el archivo `.html`) — aditivo, no
destructivo, hasta que 0Sistemas decida promoverlo.

**Alcance:** catálogo (grid/lista, filtros, búsqueda) → ficha de producto →
carrito → checkout de 4 pasos (contacto/dirección/pago/revisión) →
seguimiento de pedido. Llama de verdad a `/api/tienda/carrito` y
`/api/tienda/carrito/:token/checkout` — es el primer consumidor real de ese
backend en la historia del proyecto.

**Corrección de fondo respecto a `tienda.html`:** el catálogo del app nuevo
usa `GET /api/tienda/catalogo` (PH-only, reglas de mayoreo) — NO
`/api/catalogo` (multi-sucursal, el que `tienda.html` usa por error desde
siempre). El carrito real sólo entiende productos de esa sucursal fija
(`SUC_TIENDA` en `carrito.service.ts`), así que navegar y comprar ahora
usan la misma fuente de verdad.

**Estado (`CarritoStateService`):** el token del carrito vive en
`localStorage`; el total/subtotal/avisos SIEMPRE vienen del servidor
(`GET /tienda/carrito/:token` revalida precio/existencia en vivo) — nunca
se computan en el cliente, siguiendo el criterio que el propio backend
documenta (`carrito.controller.ts`). Validadores del formulario de
checkout **espejan exactamente** las reglas server-side: `ESTADOS_MX` (32
estados, lista cerrada) y el regex de RFC (`RE_RFC`) copiados literal de
`checkout.service.ts`.

**Bug encontrado y corregido durante la propia verificación:** el
`<base href="/tienda/">` del `index.html` compilado no coincidía con el
nombre de carpeta usado en el primer intento (`tienda-app/`) → los assets
(CSS/JS) daban 404 aunque el `index.html` sí cargaba. Corregido renombrando
la carpeta a `public/tienda/` (coincide con la base href) — documentado en
`apps/tienda/README.md` para que un futuro rename no repita el error.

**Verificación real (2026-09-02), con Playwright contra `KP_CONCENTRADA`
real, rol `catalogo_kp_runtime`:**

| Paso | Resultado |
|---|---|
| `/tienda/` catálogo | 4,562 productos reales, búsqueda "mazapan" → 31 resultados correctos |
| Ficha de producto | Precio/presentación/máximo calculado correctos |
| Agregar al carrito | Carrito real creado en `tienda.pedidos` (estado `CARRITO`) |
| `/tienda/carrito` tras recarga completa | Recuperado desde `localStorage`, revalidado, envío gratis calculado bien ($1,361 > $999) |
| Checkout paso 1 (contacto) | `POST /tienda/carrito/:token/cliente` real, avanza |
| Checkout paso 2 (dirección) | Validación de estado/CP ok, avanza |
| Checkout paso 3 (pago) | `metodos_pago` renderizado desde el servidor — **sólo OXXO y SPEI, TARJETA ausente** (Mercado Pago sin configurar, tal cual predicho) |
| Checkout paso 4 (revisión) | Refresca el carrito antes de mostrar, resumen correcto |
| Envío final (`POST .../checkout`) | **NO ejecutado a propósito** — crearía el primer pedido real de la historia; se canceló el carrito de prueba (`DELETE /tienda/carrito/:token`) para no dejar basura |

**Hallazgo de datos, no de código, para 0Sistemas:** el orden por defecto
(`orden=nombre`) del catálogo de la tienda muestra primero productos con
nombres como `* DESC BOL ROLLO...` o `DESC CHEVEMIX...` — parecen ajustes/
descuentos contables, no mercancía real, y pasan el filtro de "unidad de
mayoreo" de `tienda.service.ts` (que sólo excluye `unidad='SER'`). No se
tocó esa lógica — es una decisión de negocio (qué patrón de nombre excluir),
no un bug de esta migración. Sólo afecta la vista sin buscar/filtrar; una
búsqueda por nombre real (ej. "mazapan") no los muestra.

**Pendiente:**
- Panel interno (reemplazo de `catalogo.html`) — explícitamente fuera de
  alcance de este corte.
- Promover `/tienda/` a la URL principal (retirar `tienda.html`) — decisión
  de 0Sistemas, no automática.

---

## CV.12 — Ocultar "* DESC" + exponer unidad base (pieza/paquete individual) (2026-09-02)

0Sistemas resolvió el hallazgo de CV.11 con contexto de negocio: los
productos `* DESC ...` son un código de producto aparte en Kepler para un
descuento por volumen (aplica desde 3 piezas/cajas/paquetes) — no mercancía
normal. Pidió ocultarlos por ahora y, aprovechando la investigación,
exponer también la unidad BASE (individual) en el catálogo/ficha para que
el cliente elija pieza/paquete individual vs. caja de mayoreo.

**Investigación en la base real** (antes de tocar código, siguiendo la
regla de "nunca adivinar una fuente de datos"): los productos `* DESC` no
tienen una contraparte "normal" separada — son la ÚNICA fila para ese
producto en `kp.kdii`, con el descuento ya aplicado en el precio de la
propia fila. El patrón de nombre varía (`* DESC ...`, `***DESC. ...`,
`***Desc ...`, `DESCUENTO A FACTURA...`); un regex de prefijo
(`^\*{0,3}\s*DESC`, insensible a mayúsculas) los captura todos sin falsos
positivos — se probó contra `LECHE SEMIDESCREMADA` y `MANIOBRA DE
DESCARGA`, que NO coinciden. **937 de 9,485 filas** en sucursal PH.

Por separado, se confirmó que `kdii.c90` (precio de la unidad BASE — c11,
casi siempre `PZA` o a veces el empaque más chico real, ej. `PAQ`) **ya se
leía pero nunca se exponía** en `tienda.service.ts` — la tienda sólo dejaba
comprar por caja/paquete completo de mayoreo, nunca individual, aunque el
dato de precio individual siempre existió.

**Cambios en `apps/catalogo-kp/src/tienda/tienda.service.ts`:**
- `FILTRO_DESCUENTO` — nueva constante SQL (`TRIM(i.c2) !~* '^\*{0,3}\s*DESC'`),
  aplicada en el `WHERE` de `getCatalogo()` y `getProducto()`. Comentario en
  el código lo marca explícitamente como **oculto TEMPORAL**, a revisar
  cuando se decida cómo representar el descuento por volumen correctamente
  (¿tabla de precios por cantidad sobre el producto normal?).
- `armarUnidades()` — nueva función `agregarBase()` que agrega la unidad
  `c11`/`c90` con `piezas: 1`, **sin** pasar por `esUnidadMayoreo` (esa regla
  exige `factor > 1` a propósito, para mayoreo) — usa su propio piso de
  sanidad (`precio no nulo && >= 1`) para no reabrir el problema original de
  marcadores contables a $0.01 que motivó la regla de mayoreo. Nueva
  `etiquetaBase()` para el texto ("Pieza individual", "Paquete individual",
  etc.). `c90` (`pv1`) agregado al `SELECT` de ambos métodos.

**Verificado contra `KP_CONCENTRADA` real:**

| Chequeo | Resultado |
|---|---|
| Búsqueda "mazapan" | 0 resultados con "DESC" (antes los tenía) |
| Catálogo por defecto (sin buscar) | Ya no empieza con productos `* DESC...`; total sube de 4,562 a 5,908 (productos que sólo tenían unidad base ahora califican) |
| Ficha `07303` (AVILA MAZAPAN) | Ahora muestra 2 unidades: "Paquete individual" $75.15 y "Caja de 20 piezas" $1,361.12 — antes sólo la caja |
| UI (Playwright) | Ambas opciones seleccionables, precio tabular correcto |

---

## Verificación final: primer pedido real de la historia (2026-09-02)

Con el hallazgo de CV.12 corregido, 0Sistemas pidió completar el clic final
del checkout que se había dejado pendiente en CV.11 — la prueba de punta a
punta que el runbook (Paso 3b) dejaba para una ventana fuera de horario.

**Ejecutado en vivo contra producción real:** catálogo → producto 07303
(unidad "Paquete individual", nueva desde CV.12) → carrito → checkout
completo (contacto/dirección OXXO/revisión) → **`POST
/tienda/carrito/:token/checkout` real, sin frenar esta vez**.

**Resultado — folio `MD-2026-00012`:**

| Verificación | Resultado |
|---|---|
| `tienda.pedidos` | Fila real, estado `PENDIENTE_CONFIRMACION`, subtotal $75.15 + envío $199 = total $274.15 |
| `tienda.pedido_items` | 1 línea, código 07303, unidad `PAQ`, cantidad 1, importe 75.15 |
| `tienda.avisos` | Aviso `PEDIDO_CREADO` encolado y **`enviado_en` con timestamp real** — el correo de confirmación se mandó de verdad por SMTP |
| Página `/tienda/pedido/:seguimiento` | Muestra estado, fecha límite de confirmación y totales correctos |

**Confirma de punta a punta:** checkout → orden → cola de trabajos → envío
de correo real, todo contra la base de producción, con el frontend nuevo
como único cliente. Es el primer pedido creado a través de una interfaz de
usuario en la historia de este backend.

**Limpieza:** el pedido era explícitamente de prueba (nombre "Prueba QA
Playwright", correo de prueba) y habría aparecido en la bandeja real de
`/admin/pedidos/por-confirmar` que usa el equipo de e-commerce — 0Sistemas
pidió cancelarlo. Cancelado vía la API real (`POST
/api/admin/pedidos/34/cancelar`, mismo endpoint que usa el panel de
administración) con motivo explícito ("Pedido de prueba QA — verificación
end-to-end del checkout, no es un pedido real"), no borrado ni tocado
directo en la base — queda como registro auditable de que fue una prueba,
no un pedido real cancelado sin explicación.

**Con esto, el Paso 3b del runbook de corte queda completo.**

---

## CV.14 — Corte del `.env` de producción al rol dedicado (2026-09-02)

Único pendiente operacional que quedaba de CV.8/CV.9: el `.env` real de
`megadulces-api-ready` en `.163` seguía usando `app_runtime`, el rol
compartido con `postgres_platform` (`GOTCHAS.md` §24). Preguntado
explícitamente cómo autorizar el corte, 0Sistemas eligió la "opción 1"
(sólo el `.env`, no el corte completo del Service — eso queda como Paso 4
aparte).

**Verificación de seguridad antes de aplicar** (no bastaba con que los
GRANTs coincidieran en el papel — había que confirmar que el código real
no dependía de algo que `catalogo_kp_runtime` no tiene): único `DELETE` en
todo el código fuente, en `monitor/errores.service.ts`
(`DELETE FROM monitor.errores_detalle`, limpieza de retención). El propio
comentario del código **original** (no el migrado) ya decía *"`app_runtime`
tampoco tiene DELETE en monitor"* y lo envuelve en `.catch()` sin romper el
reporte de errores — es decir, el gap de permiso ya existía con
`app_runtime` y el desarrollador original ya lo había resuelto. Cambiar de
rol no introduce ninguna regresión ahí.

**Ejecutado:**
1. Respaldo del `.env` (`.env.bak-2026-09-02_1725`).
2. `PG_USER=catalogo_kp_runtime` / `PG_PASSWORD=<el generado en CV.8>`.
3. Reinicio con el **mismo mecanismo** que ya usa `herramientas/Compilar_seguro.ps1`
   para sus propios despliegues (detener el proceso en `:3000`, relanzar
   vía la tarea programada `MegaDulces API - vigilante`, esperar y correr
   la misma batería de 5 pruebas que ese script) — no se inventó un
   mecanismo nuevo para esta operación de riesgo.

**Verificado:**

| Chequeo | Resultado |
|---|---|
| Las 5 pruebas de `Compilar_seguro.ps1` | 0 fallos (`catalogo/estado`, `catalogo/sucursales`, `kp/precio`, `kp/precios-todos`, `kp/productos`→401) |
| `vigilar_api.log` | Recuperación limpia, sin mensaje de error de credenciales (`28P01`) |
| `pg_stat_activity` | La conexión real del proceso (`client_addr=192.168.0.163`) usa `catalogo_kp_runtime` |
| `catalogo.html` / `tienda.html` / `verificador-01.html` | 200 después del corte |

**Con esto se cierra de punta a punta, para `catalogo-kp`, el riesgo de
credencial compartida de `GOTCHAS.md` §24** — rotar `app_runtime` en
cualquier otra parte del cluster `.245` ya no puede volver a tumbar este
proceso.

**Pendiente (en ese momento):** sólo el **Paso 4** del runbook — ver CV.15,
completado a continuación.

---

## CV.15 — Corte real del Service en `.163` (Paso 4, completo) — 2026-09-03

Autorizado explícitamente por 0Sistemas ("Opción 2"). Es el paso de mayor
riesgo de toda la fase: reemplazar el proceso que sirve producción real
(el repo standalone `megadulces-api-ready`) por el build de
`apps/catalogo-kp` de este monorepo. Antes de tocar el proceso en vivo se
investigó y corrigió todo lo que hiciera falta, y se probó en un puerto de
prueba (`:3093`) contra el `.env` real hasta dejar cero fallos.

### Tres hallazgos reales antes de cortar

**1. Módulo `salud` nunca portado.** El proyecto origen ganó un endpoint
`GET /api/salud` (público, siempre 200 aunque la base esté caída, dice por
separado si el PROCESO vive y si la BASE responde) en algún punto
**después** de que las sub-fases CV.0–CV.10 terminaran de portar módulo por
módulo — así que nunca hubo oportunidad de portarlo. `Vigilar_API.ps1` lo
usa específicamente para no repetir los incidentes del 27/08 y 01/09 (donde
confundir "API muerta" con "base rechaza credenciales" costó horas de
reinicios inútiles). Sin este endpoint, el corte real habría vuelto a
exponer al vigilante al mismo síntoma que ya casó dos incidentes.
**Portado literal** a `apps/catalogo-kp/src/salud/`, única adaptación:
`DATABASE_URL_KP_CONCENTRADA` (connectionString única) en vez de las 5
variables discretas `PG_*` del original. Verificado contra la base real:
`{"api":"ok","base":{"estado":"ok"},"accion":"ninguna"}`.

**2. Bug crítico de orden en `main.ts`: `dotenv.config()` corría DESPUÉS
de que ya hiciera falta.** `import { AppModule }` estático se resuelve (y
con él, el `throw` a nivel de módulo de `AuthModule` si falta
`CATALOGO_KP_JWT_SECRET`) antes de que `dotenv.config()` — aunque
textualmente apareciera primero en el archivo — llegara a ejecutarse:
ambos son *statements* top-level de main.ts, y en el bundle compilado el
`require` de `AppModule` queda antes. **Nunca se notó en las ~15 corridas
de prueba de esta sesión** porque todas exportaban las variables a mano
antes de lanzar `node` — un despliegue real, dependiendo sólo del `.env`
(que es exactamente cómo lo lanza `Vigilar_API.ps1`), habría entrado en
**crash-loop infinito desde el primer arranque**. Fix:
`require('./app.module')` **dentro** de `bootstrap()`, no `import`
estático arriba — se resuelve recién cuando el control de ejecución llega
ahí, ya después de `dotenv.config()`. (Un `await import()` dinámico se
probó primero pero webpack lo separa en un chunk aparte (`1.js`) que el
despliegue no contempla — `require()` síncrono queda inline en el mismo
bundle y de todas formas se aplaza en el tiempo por ser una llamada de
función, no una declaración de import.)

**3. El bundle no es autocontenido — sus dependencias externalizadas
(`knex`, `pg`, `bcryptjs`, todo `@nestjs/*`, etc.) necesitan resolverse
desde algún `node_modules`.** Se investigaron dos caminos:

- *Descartado:* instalar cada dependencia faltante en el propio
  `node_modules` de `megadulces-api-ready` (se llegó a instalar `knex` ahí
  y confirmar que `pg`/`xlsx` ya estaban) — funciona, pero exige
  reconciliar TODO el árbol de dependencias de NestJS 11 dentro de un
  proyecto NestJS 10 aparte, package por package, cada vez que cambie.
- **Elegido:** variable de entorno `NODE_PATH` apuntando al `node_modules`
  de la Suite (`C:\proyectos\Suite MD\MegaDulces_Suite\node_modules`), que
  YA tiene todo instalado y correcto. `main.js` sigue viviendo físicamente
  en la raíz de `megadulces-api-ready` (para que `join(__dirname,'public')`
  siga resolviendo al `public/` real y de siempre — el mismo que
  `Actualizar_Verificador.ps1` escribe a diario — sin tocar esos scripts),
  pero sus `require()` externalizados se resuelven contra la Suite. Es la
  única pieza nueva que depende de que este checkout de la Suite siga
  existiendo en esta máquina — coherente con el principio de la fase (P1:
  `catalogo-kp` vive on-prem justamente porque necesita LAN a `.245`, y
  corre desde este mismo checkout).

### Cambios de infraestructura (fuera de este git, en `.163`)

- `megadulces-api-ready/main.js` — el build de `nx build catalogo-kp`
  (`dist/apps/catalogo-kp/main.js`) copiado a la raíz del proyecto viejo
  (no a `dist/`, para que la ruta de `public/` calce sin tocar ningún otro
  script).
- `megadulces-api-ready/public/tienda/` — build de `apps/tienda` agregado
  (nuevo, `catalogo.html`/`tienda.html`/`img/`/`verificador-*.html`
  intactos, sin tocarse).
- `megadulces-api-ready/.env` — agregadas `DATABASE_URL_KP_CONCENTRADA`
  (construida a partir de las `PG_*` ya corregidas en CV.14) y
  `CATALOGO_KP_JWT_SECRET` (**mismo valor que `JWT_SECRET`**, a propósito —
  para no invalidar sesiones de admin ni tokens de carrito ya emitidos por
  el proceso viejo). Variables viejas (`PG_*`, `JWT_SECRET`) se dejan,
  no se borran — sirven de referencia y a `Alertas.ps1`, que las sigue
  usando.
- `herramientas/Vigilar_API.ps1` — la única asunción de ruta que el
  runbook ya anticipaba: `dist\main.js` → `main.js`, `node dist\main` →
  `node main.js`, y se agregó `$psi.EnvironmentVariables['NODE_PATH']`
  antes de lanzar el proceso. El resto del vigilante (sondeo de `/api/salud`,
  racha de fallos, alertas) no se tocó.
- `herramientas/Compilar_seguro.ps1` — banner de aviso agregado al inicio:
  sigue siendo inofensivo correrlo (compila el `src/` viejo, ya congelado,
  a un `dist/` que nadie lee; su paso de reinicio termina relanzando el
  proceso real igual, vía el `Vigilar_API.ps1` ya corregido), pero no
  actualiza nada — el código nuevo se compila en la Suite y se copia a
  mano. **No se reescribió** el script para evitar ampliar el alcance de
  un corte ya grande.

### Higiene de secretos

Ningún valor real (contraseña de `catalogo_kp_runtime`, `JWT_SECRET`) se
escribió en este repositorio ni se mostró en texto plano en la
conversación — se leyeron y reescribieron con `sed`/Node siempre
redirigidos a variables de shell, nunca impresos.

### Verificación (puerto de prueba `:3093`, antes de tocar `:3000`)

Con el `.env` real, sin exportar NADA a mano (la prueba más estricta —
exactamente cómo lo lanza el vigilante):

| Endpoint | Resultado |
|---|---|
| `/api/salud` | `{"api":"ok","base":{"estado":"ok"}}` |
| `/api/catalogo/estado`, `/sucursales`, `/kp/precio`, `/kp/precios-todos` | 200 |
| `/api/kp/productos` sin token | 401 |
| `/catalogo.html`, `/tienda.html`, `/verificador-01.html` | 200 (public real) |
| `/tienda/`, `/tienda/carrito`, asset real (`styles-*.css`) | 200 |

### El corte real (puerto `:3000`)

1. Detener el proceso viejo (`Stop-Process` sobre el PID en `:3000`).
2. `Start-ScheduledTask 'MegaDulces API - vigilante'` (mismo mecanismo que
   ya usa `Compilar_seguro.ps1` para sus propios despliegues).
3. Las mismas 11 pruebas de arriba, ahora contra `:3000` real: **0 fallos.**
4. `vigilar_api.log`: `"Lanzando node main.js (NODE_PATH -> node_modules de
   la Suite)"` → `"OK. La API respondio tras 5 segundos."` — recuperación
   limpia, sin síntoma de credenciales.
5. `pg_stat_activity`: 5 conexiones reales desde `192.168.0.163` usando
   `catalogo_kp_runtime` — el proceso nuevo, con el rol dedicado, en vivo.

**Downtime real: unos segundos** (el tiempo entre detener el proceso viejo
y que el vigilante levantara el nuevo).

### Con esto, el runbook `CV_CORTE_CATALOGO_KP.md` queda 100% completo — los
4 pasos hechos y verificados. `.163` corre desde este monorepo.

**Pendiente (no bloqueante, no de esta fase):**
- Vigilar de cerca las próximas horas (tal como pide el propio Paso 4) —
  0Sistemas decide cuánto tiempo.
- Repuntar `Compilar_seguro.ps1` a un flujo real de `nx build` (hoy sólo
  tiene el banner de aviso) — mejora de comodidad operativa, no urgente.
- Panel interno (reemplazo de `catalogo.html`) — fuera de alcance de esta
  fase.
- Promover `/tienda/` sobre `tienda.html` como URL principal — decisión de
  0Sistemas, no automática.
- El "1.js" huérfano de un build anterior se descartó — no interfiere, pero
  si algún día reaparece un chunk separado en `dist/apps/catalogo-kp/`,
  significa que algo volvió a usar `import()` dinámico y hay que copiarlo
  también o volver a `require()`.

---

## CV.16 — Reporte "Actualizar Wix" para MKT (2026-09-03)

0Sistemas compartió un checkpoint
(`checkpoint_actualizar_wix_2026-09-03.json`, carpeta
`DataCenter\DataBases Sucursales\MES GLOBAL\`) del proceso manual que MKT
usa para refrescar el catálogo de la tienda Wix: una laptop conectada a la
red de Kepler levanta una copia LOCAL de la API vieja, un script de Python
(`kepler_export_productos.py`) hace login por JWT y exporta
`kp_costos.csv`/`kepler_explorador.json`, y un artefacto Claude/Cowork
(`Actualizar_Wix_MegaDulces.html`) procesa esos archivos + el catálogo
exportado de Wix para producir el CSV final. Un tercer script
(`generar_variantes_wix.py`) agrega aparte el menú de presentaciones
(Pieza/Paquete/Caja) como variantes.

**Hallazgo (leyendo el código antes de tocar nada):**
`apps/catalogo-kp/src/kp/kp.service.ts::getProductos()`
(`GET /api/kp/productos`, ya migrado y en producción) **ya devuelve todo lo
que las 3 herramientas necesitaban**: `precio_con_iva` (el precio final ya
resuelto — `c90` si existe, si no la fórmula de respaldo
costo×margen×IVA×IEPS), `costo`, `margen`, `iva`/`ieps` (fracción decimal),
`existencia_ph`, y las 3 unidades con sus precios/factores
(`u_base/p_u1`, `u2_nom/p_u2/u2_factor`, `u3_nom/p_u3/u3_factor` — literalmente
los mismos nombres que ya usaba `generar_variantes_wix.py`). **Cero cambios
de backend** — sólo hacía falta una página nueva que consumiera este
endpoint ya vivo y ya autenticado.

**Nuevo:** `apps/catalogo-kp/public/actualizar-wix.html` — reemplaza el
flujo completo. Reutiliza la misma sesión que `catalogo.html`
(`localStorage` `megadulces_tablero_sesion`, mismo login) — si MKT ya
inició sesión ahí, entra directo. Al cargar pide `GET /api/kp/productos`
en vivo (reemplaza laptop + Python + login JWT aparte); MKT sólo sube **un**
archivo (el catálogo exportado de Wix, ya no `kp_costos.csv` ni
`kepler_explorador.json`) y elige modo:

- **Precio + existencia** (uso diario): puerto de
  `Actualizar_Wix_MegaDulces.html::procesar()`, simplificado porque el
  endpoint ya resuelve qué precio gana (`precio_con_iva` directo, sin
  reimplementar la fórmula de respaldo en JS). Reglas preservadas: la
  existencia sólo se escribe si es positiva (nunca borra inventario), una
  fila `Variant` sin match hereda el precio del `Product` anterior, columnas
  de auditoría al final (`margen_utilidad, costo_base, tipo_impuesto,
  existencia_ph, precio_kepler_c90`).
- **Con presentaciones**: puerto de `generar_variantes_wix.py` a JS —
  `unidades_de()` (unidades reales, sin duplicar, de más barata a más
  cara), `surcharge` = precio_unidad − precio_base, `inventory` =
  existencia_ph / factor (redondeado hacia abajo), `discountMode=AMOUNT`
  forzado a 0 en productos con variantes (Wix no lo admite), checkbox
  "forzar Pieza" opcional que deduce el precio del nombre cuando Kepler no
  trae unidad de pieza (dejando claro que ese precio no es real del POS).

Enlace de entrada agregado en `catalogo.html` ("🛒 Actualizar Wix", junto a
"⬇ Exportar CSV").

**Verificado con Playwright contra `KP_CONCENTRADA` real** (sesión
inyectada con un JWT de prueba propio, sin usar credenciales reales de
ningún usuario): con un CSV de 3 SKUs reales conocidos (`07303`, `17083`,
y `99999` — este último resultó ser real también, "APOYO PUBLICITARIO",
un marcador administrativo), **ambos modos coinciden byte a byte** con los
valores calculados a mano desde `GET /api/kp/productos`:

| Modo | Verificado |
|---|---|
| Precio + existencia | Precio, existencia e impuesto correctos en los 3 SKUs; `discountMode/Value` sin tocar (correcto para este modo) |
| Con presentaciones | 2 productos con menú (2 unidades c/u, 4 variantes), 1 con una sola presentación (sin tocar), `surcharge`/`inventory` exactos por unidad, descuento `AMOUNT` forzado a 0 en el producto con variantes |

Desplegado en `.163` (`megadulces-api-ready/public/actualizar-wix.html` +
`catalogo.html` actualizado con el enlace), copiado igual que
`tienda.html`/`reportar-errores.js` en su momento.

**Qué NO cambió:** cero cambios de backend, cero cambios de base de datos.
Subir el CSV final a Wix sigue siendo manual (Wix no expone una API de
importación masiva accesible para esto). Las herramientas viejas
(`kepler_export_productos.py`, el `.html` externo, `generar_variantes_wix.py`,
el instructivo de la laptop) **no se borraron** — quedan de respaldo hasta
que MKT confirme que el reporte nuevo cubre su flujo real.

**Pendiente:** validación con MKT usando su export real de Wix (esta
sesión probó con un CSV mínimo armado a mano, no el catálogo real
completo); decidir cuándo retirar las herramientas viejas.

---

## CV.17 — Incidente real: el rol dedicado no tenía permiso de login (2026-09-03)

Con el reporte de CV.16 ya en producción, alguien inició sesión de verdad
en `catalogo.html`/`actualizar-wix.html` — y ese fue el primer login REAL
contra `catalogo_kp_runtime` desde el corte de CV.15 (todas las
verificaciones anteriores usaban JWTs auto-firmados, nunca el endpoint
`/api/auth/login` de punta a punta). El login sí escribe
(`UPDATE admin.usuarios SET ultimo_login = NOW()`), y el rol dedicado sólo
tenía `SELECT` ahí — "permiso denegado a la tabla usuarios" en
`api3000.log`, y poco después el proceso dejó de responder.

**Detectado y resuelto de inmediato** (producción estuvo abajo unos
minutos hasta el reinicio):
1. `GRANT UPDATE ON admin.usuarios TO catalogo_kp_runtime` aplicado al
   cluster real + corregido en `apps/catalogo-kp/sql/007_rol_dedicado.sql`.
2. Verificado con un `UPDATE ... SET ultimo_login = ultimo_login` (no-op,
   no altera datos reales) conectado como el rol — ya no da error.
3. Defensa en profundidad en `auth.service.ts`: el `UPDATE` de
   `ultimo_login` ahora va en `try/catch` no fatal (mismo criterio que el
   `DELETE` de `monitor/errores.service.ts`) — una falla de auditoría no
   debe volver a impedir un login.
4. Reconstruido y redesplegado en `.163` con el mismo mecanismo de CV.15
   (detener, copiar `main.js`, relanzar vía el vigilante). Verificado con
   la misma batería de páginas/endpoints — todo en 200.

**Detalle completo, incluida la lección de diseño, en `docs/GOTCHAS.md`
§33.**

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
