# Runbook — Corte de `megadulces-api-ready` a `apps/catalogo-kp`

> Checklist para cuando se decida apuntar `.163` al build de este monorepo en
> vez del repo standalone. **No ejecutar de un tirón** — cada paso depende de
> que el anterior haya salido bien. Plan de fondo en
> [`FASE_CV`](../FASES/FASE_CV_CATALOGO_TIENDA_MAYOREO.md), sección CV.6.

**Estado (2026-09-03): runbook 100% completo — los 4 pasos hechos y
verificados.** `.163` corre en producción real desde este monorepo. El
bloqueante de credencial (`app_runtime` rechazada, `28P01`) se resolvió
fuera de esta migración; el `.env` real usa `catalogo_kp_runtime` desde
Paso 2; Paso 3a (lectura) verificado con paridad byte a byte; Paso 3b
(escritura) completado con el primer pedido real de la historia
(`MD-2026-00012`, cancelado por ser de prueba); **Paso 4 (corte real del
Service) completado 2026-09-03** — ver detalle en `FASE_CV`, sección
"CV.15 — Corte real del Service en `.163`" (tres hallazgos reales
resueltos antes de cortar: módulo `salud` nunca portado, un bug crítico de
orden de `dotenv.config()` que habría causado un crash-loop en cualquier
arranque real, y la resolución de dependencias externalizadas vía
`NODE_PATH`). 0 fallos en las 11 pruebas de verificación, downtime real de
unos segundos.

---

## Paso 0 — Ver dónde está parado el sistema hoy ✅ 2026-09-02

`ADMINISTRAR.bat` (raíz de `megadulces-api-ready`, en `.163`) → **opción 3,
"Ver estado del sistema"**. Sin riesgo, sólo lee. Correrla antes de tocar
cualquier otra cosa, y otra vez después de cada paso de abajo, para
confirmar que nada se rompió.

## Paso 1 — Resolver la credencial de `app_runtime` ✅ resuelto 2026-09-01

Resuelto fuera de esta migración (administración del cluster `.245`). El
`.env` de `megadulces-api-ready` quedó con la contraseña vigente; el
vigilante confirma sin fallos desde 2026-09-01 23:12.

## Paso 2 — Aplicar el rol dedicado (`catalogo_kp_runtime`) ✅ aplicado 2026-09-02

Por qué: hoy `catalogo-kp` (en este monorepo) está preparado para usar un rol
propio, no `app_runtime` — ver `apps/catalogo-kp/sql/007_rol_dedicado.sql` y
el hallazgo de `GOTCHAS.md` §24 (compartir `app_runtime` con
`postgres_platform` en el mismo cluster acopla el blast radius de una
rotación de credencial).

1. Editar `apps/catalogo-kp/sql/007_rol_dedicado.sql` y reemplazar
   `CAMBIA_ESTE_PASSWORD` por una contraseña real (generarla, no reusar
   ninguna existente — este rol es nuevo, no hereda nada).
2. Copiar ese archivo a `sql\007_rol_dedicado.sql` dentro de
   `megadulces-api-ready` (la carpeta que usa el menú en `.163`) — el script
   `Aplicar_migracion.ps1` sólo lista lo que hay en el `sql\` de ese
   proyecto, no en este monorepo.
3. En `.163`: `ADMINISTRAR.bat` → **opción 8, "Aplicar una migración"** →
   elegir `007_rol_dedicado.sql` → contraseña de `postgres` (se pide oculta,
   no se guarda). Es aditivo — no toca `app_runtime` ni ninguna tabla
   existente, así que no hay nada que revertir si algo sale mal antes de
   este paso.
4. Verificar que el rol quedó creado y con los permisos esperados:
   ```sql
   -- Correr como postgres, con la opción 8 otra vez y este SQL suelto,
   -- o desde cualquier cliente que ya tenga acceso de postgres.
   SELECT rolname FROM pg_roles WHERE rolname = 'catalogo_kp_runtime';
   ```

**Hecho 2026-09-02** — aplicado vía `psql` directo (mismo mecanismo que
`Aplicar_migracion.ps1`: `-h 192.168.0.245 -U postgres -d KP_CONCENTRADA -v
ON_ERROR_STOP=1 -f 007_rol_dedicado.sql`), exit code 0, las 17 sentencias
(`DO`/`GRANT`/`ALTER DEFAULT PRIVILEGES`) corrieron sin error. Verificado:
`rolcanlogin=t`, `rolsuper/rolcreatedb/rolcreaterole=f`; grants exactos —
`kp.*` 368 tablas SELECT-only, `admin.usuarios` SELECT-only, `tienda.*` 10
tablas SELECT/INSERT/UPDATE (sin DELETE), `monitor.*` según diseño. Smoke
test conectado como `catalogo_kp_runtime`: `SELECT count(*) FROM kp.kdii`
→ 66,682 filas OK; `DELETE FROM tienda.pedidos` → `ERROR: permiso denegado`
(comportamiento esperado). La contraseña real del rol nuevo quedó sólo en
`sql/007_rol_dedicado.sql` dentro de `megadulces-api-ready` (fuera de este
git) — el archivo versionado en este monorepo sigue con el placeholder
`CAMBIA_ESTE_PASSWORD`, nunca se comitea un secreto real.

**Hecho 2026-09-02 (autorizado por 0Sistemas, "opción 1"):** `.env` real de
`megadulces-api-ready` en `.163` (`PG_USER`/`PG_PASSWORD`) actualizado de
`app_runtime` a `catalogo_kp_runtime`. Respaldo previo:
`.env.bak-2026-09-02_1725`. Reinicio siguiendo el mismo mecanismo confiable
de `Compilar_seguro.ps1` (detener el proceso en :3000, relanzar vía la
tarea programada `MegaDulces API - vigilante`, verificar) — 0 fallos en las
5 pruebas de siempre (`catalogo/estado`, `catalogo/sucursales`, `kp/precio`,
`kp/precios-todos`, `kp/productos` 401). `vigilar_api.log` confirma
recuperación limpia sin error de credenciales. `pg_stat_activity` confirma
la conexión real del proceso (`client_addr=192.168.0.163`) usando
`catalogo_kp_runtime`. Antes de aplicar se verificó que el único `DELETE`
del código (`monitor.errores_detalle`, limpieza de retención) ya tenía
manejo gracioso (`.catch()`) porque **`app_runtime` tampoco tenía ese
permiso** — no es una regresión, el comportamiento es idéntico al de antes.
Páginas reales (`catalogo.html`/`tienda.html`/`verificador-01.html`)
confirmadas en 200 después del corte.

## Paso 3 — Verificación end-to-end real

**3a. Sólo lectura (bajo riesgo) — catálogo y precios. ✅ verificado 2026-09-02**
(hecho con `app_runtime`, antes de tener el rol dedicado listo — ver `FASE_CV`
sección "Verificación real 2026-09-02" para el detalle completo, incluido el
bug de bindings SQL encontrado y corregido en esa misma pasada).

Build de `catalogo-kp` sin `AdminModule`/`TiendaModule` (para no competir con
la cola ya viva en `.163` — ver la nota en el propio `app.module.ts` de la
corrida de verificación de CV.6), apuntado a `KP_CONCENTRADA` real con
`catalogo_kp_runtime`:

```bash
nx build catalogo-kp
DATABASE_URL_KP_CONCENTRADA="postgresql://catalogo_kp_runtime:<password>@192.168.0.245:5432/KP_CONCENTRADA" \
CATALOGO_KP_JWT_SECRET="<cualquiera, sólo para esta corrida>" \
PORT=3092 node dist/apps/catalogo-kp/main.js
```

Comparar contra la app viva en el mismo `.163`:

```bash
curl -s "http://localhost:3000/api/kp/precio?q=17083" > viejo.json
curl -s "http://localhost:3092/api/kp/precio?q=17083" > nuevo.json
diff viejo.json nuevo.json   # debe ser idéntico

curl -s "http://localhost:3000/api/kp/precios-todos?sucursal=03" > viejo_todos.json
curl -s "http://localhost:3092/api/kp/precios-todos?sucursal=03" > nuevo_todos.json
diff viejo_todos.json nuevo_todos.json
```

**3b. Camino de escritura (carrito/checkout/cola) — decisión de riesgo, no
sólo técnica. ✅ Completo 2026-09-02: canario verificado y carrito real de
punta a punta ejecutado (no se esperó ventana fuera de horario — 0Sistemas
autorizó el envío final en el momento, ver `FASE_CV`).**

0Sistemas eligió el enfoque de menor riesgo: canario ahora (no toca dinero),
carrito real después, en una ventana fuera de horario de pedidos a definir.
Corrido en horario de oficina (13:42–13:47) contra `KP_CONCENTRADA` real,
app completa (`tienda`+`admin`) usando ya **`catalogo_kp_runtime`** (primera
vez que el rol dedicado se ejercita en escritura, no sólo lectura):

- `POST /api/admin/cola/prueba` simple → tomado por el trabajador, `HECHO` en
  el primer intento. `cuenta.hechos` 0→1, sin competir visiblemente con la
  cola del proceso viejo en `.163` (mismo `KP_CONCENTRADA`, `FOR UPDATE SKIP
  LOCKED` funcionando como está diseñado).
- `POST /api/admin/cola/prueba` con `fallar_hasta:2` → falló 2 veces, esperó
  el backoff exponencial exacto (60s, luego 120s — `esperaSegundos()`), y
  sanó al tercer intento. `reintentos` 0→2, `HECHO` final sin `fallidos` ni
  `PENDIENTE` colgado.

Confirma: el motor de colas (reintentos, backoff, `SKIP LOCKED`) funciona
igual contra datos reales que en el código portado, y el rol
`catalogo_kp_runtime` tiene los permisos de escritura correctos sobre
`tienda.trabajos`. **No se corrió el carrito real de punta a punta** (crear→
agregar producto→checkout OXXO→confirmar→verificar aviso) — eso queda para
la ventana que 0Sistemas defina, siguiendo exactamente los pasos de abajo.

Correr `catalogo-kp` completo (con `tienda`) contra el mismo
`KP_CONCENTRADA` real pone su motor de colas a competir por trabajos con el
que ya está vivo en `.163` — es seguro por diseño (`FOR UPDATE SKIP LOCKED`
está hecho exactamente para eso), pero significa que un `aviso_cliente` de un
pedido **real** podría tocarle al proceso nuevo, todavía no probado en
producción. Dos formas de bajar ese riesgo, a elegir según qué tan cómodos
estén con el riesgo residual:

- **Ventana corta, fuera de horario de pedidos reales**, con el canario
  (`POST /api/admin/cola/prueba`, no toca dinero) primero, y un carrito real
  de punta a punta después (crear → agregar un producto de bajo movimiento →
  checkout con OXXO → confirmar desde `/admin/pedidos/por-confirmar` →
  verificar que el aviso se envió). Es la prueba más real que se puede hacer.
- **Detener el proceso viejo primero** (el Service en `.163`) durante la
  ventana de prueba, para que sólo el worker nuevo procese la cola — pero
  eso es downtime real de la tienda, y hay que sopesarlo contra lo que se
  gana en certeza.

Ninguna de las dos se hace sin decirle a 0Sistemas primero — es la decisión
de negocio, no técnica.

## Paso 4 — El corte real (Service + tareas programadas) ✅ completo 2026-09-03

Autorizado explícitamente por 0Sistemas ("Opción 2"). Detalle completo,
hallazgos y verificación en `FASE_CV`, sección "CV.15 — Corte real del
Service en `.163`". Resumen de lo hecho:

1. **Tres hallazgos reales resueltos ANTES de tocar el proceso en vivo**
   (probados primero en el puerto `:3093`, sin exportar nada a mano —
   exactamente cómo lanza el proceso el vigilante):
   - Módulo `salud` (`GET /api/salud`) nunca se había portado — apareció en
     el proyecto origen después de que CV.0–CV.10 terminaran de portar
     módulo por módulo. Portado literal a `apps/catalogo-kp/src/salud/`.
   - Bug crítico: `import { AppModule }` estático en `main.ts` se resolvía
     (con el `throw` a nivel de módulo de `AuthModule`) ANTES que
     `dotenv.config()`, pese a aparecer después en el archivo — un
     despliegue real dependiendo sólo del `.env` habría entrado en
     crash-loop infinito. Fix: `require('./app.module')` dentro de
     `bootstrap()`, no `import` estático arriba.
   - El bundle no es autocontenido (`knex`/`pg`/`bcryptjs`/`@nestjs/*` externalizados) —
     resuelto con `NODE_PATH` apuntando al `node_modules` de la Suite, en
     vez de reconciliar cada dependencia dentro del proyecto viejo.
2. **Ejecutado:**
   - `main.js` (build de `nx build catalogo-kp`) copiado a la **raíz** de
     `megadulces-api-ready` (no a `dist/`) — así `join(__dirname,'public')`
     sigue resolviendo al `public/` real y de siempre, sin tocar
     `Actualizar_Verificador.ps1` ni ningún otro script.
   - `public/tienda/` (build de `apps/tienda`) agregado ahí mismo.
   - `.env` real: agregadas `DATABASE_URL_KP_CONCENTRADA` y
     `CATALOGO_KP_JWT_SECRET` (mismo valor que `JWT_SECRET`, para no
     invalidar sesiones/carritos ya emitidos).
   - `Vigilar_API.ps1`: única asunción de ruta cambiada (`dist\main.js` →
     `main.js`, `node dist\main` → `node main.js`) + `NODE_PATH` agregado
     al lanzar el proceso. El resto del vigilante no se tocó.
   - `Compilar_seguro.ps1`: banner de aviso agregado (sigue siendo
     inofensivo correrlo, pero ya no actualiza nada — el código nuevo se
     compila en la Suite).
3. **Corte:** detener el proceso viejo → `Start-ScheduledTask` → **0 fallos**
   en 11 pruebas (los 5 endpoints de siempre + `/api/salud` +
   `catalogo.html`/`tienda.html`/`verificador-01.html` + `/tienda/`
   completo) → `pg_stat_activity` confirma la conexión real usando
   `catalogo_kp_runtime`. **Downtime real: unos segundos.**

**Con esto, este runbook queda 100% completo.** Pendiente, no bloqueante:
vigilar de cerca las próximas horas (0Sistemas decide cuánto tiempo).
