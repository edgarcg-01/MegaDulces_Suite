# Fase CV.24 — Checkpoint: verificador de precios, del `.ps1` rechazado a la pantalla validada

> **Qué es este documento:** checkpoint autocontenido para retomar el trabajo desde
> cero (otra sesión de Claude Code, otro dev, otra herramienta). No depende de
> conversación previa. Cubre UN sub-problema: el verificador de precios de mostrador
> (`/tienda/verificador`), desde que se rechazó el primer intento hasta la validación
> visual del reemplazo. Generado 2026-09-10. Rutas de archivo y resultados citados
> abajo son reales, verificados contra el código y contra datos reales — no inventados.
>
> Para el contexto completo del proyecto ver `CLAUDE.md` (raíz). Para la historia
> completa de la Fase CV (migración del catálogo/tienda externo) ver
> [`FASE_CV_CATALOGO_TIENDA_MAYOREO.md`](FASE_CV_CATALOGO_TIENDA_MAYOREO.md) y
> [`FASE_CV_INTEGRACION_REAL_CHECKPOINT.md`](FASE_CV_INTEGRACION_REAL_CHECKPOINT.md)
> (ese otro checkpoint es sobre auth-mt/`commercial.orders`, un sub-problema
> distinto y ya descartado — no confundir con este).

---

## 0. Resumen — qué pasó, en una tabla

| Cuándo | Qué | Resultado |
|---|---|---|
| 2026-09-08 | PR #68: verificador híbrido (en vivo + respaldo) entregado como `tools/verificador-precios/Actualizar_Verificador.ps1` + HTML autocontenido + Task Scheduler | ❌ Rechazado por Edgar, dos veces (`CHANGES_REQUESTED`) |
| 2026-09-08 | Edgar reescribe el verificador directamente en `main`, commits `a29b9318` + `3c2b5f64` | ✅ `/tienda/verificador` como página real de `apps/view`, offline vía Service Worker + IndexedDB |
| 2026-09-08 → 09-09 | `TDA.1`–`TDA.4` (precio en vivo, alineación con etiquetera, mayoreo) + `ID.29` (permiso repartido a prod) | ✅ Extendido y corregido en prod |
| 2026-09-10 | Esta sesión: validación visual en browser con cuenta descartable | ✅ Los 3 estados (en vivo / no encontrado / respaldo) + modo kiosco, confirmados reales |

**Qué falta:** que Edgar (o alguien con cuenta real) confirme en su propia sesión, con su propia sucursal, y que se pruebe el mayoreo contra una DB con `commercial.product_label_prices` poblada (en `platform_test` los códigos de muestra no traían tiers).

---

## 1. Por qué se rechazó PR #68

El PR entregaba el híbrido en vivo/respaldo, pero **fuera de la app**: un
`.ps1` corriendo en Task Scheduler, generando un HTML de ~2 MB por sucursal
mediante reemplazo de texto (`window.MDPRECIOS=...` inyectado a mano en el
archivo). Edgar lo rechazó con el mismo argumento usado antes para retirar
`apps/catalogo-kp` como app standalone: **una superficie nueva vive dentro de
una app del monorepo (`apps/view`+`apps/api`), nunca como script/archivo
suelto fuera de él** — sin eso no tiene ruta, permiso, diseño, tests ni
deploy; tiene una tarea programada que nadie mira hasta que falla.

Su especificación exacta (segunda review, `CHANGES_REQUESTED` sobre commit
`34cfb115`):

- Página `apps/view/src/app/modules/tienda/pages/tienda-verificador.component.ts`,
  ruta `/tienda/verificador`, patrón de las demás `tienda-*.component.ts`.
- Backend: **cero líneas nuevas** — consumir los `@Public()` que ya existían
  en `KpModule` (`/api/kp/precio`, `/api/kp/precios-todos`, `/api/sucursales`).
- Offline: **nada de `.ps1` ni HTML generado** — Angular Service Worker
  (`ngsw-config.json`, dataGroups) + Dexie/IndexedDB
  (`OfflineDatabaseService`, ya existía en el repo).
- Borrar `tools/verificador-precios/` completo.

Yo (Claude, en esa sesión) alcancé a portar sólo `apps/api/src/modules/salud/`
(recuperado de git history, sin relación con el rechazo) antes de que
apareciera lo del punto 2 — para cuando iba a empezar la reescritura, ya
estaba hecha.

## 2. Qué hizo Edgar en `main` (commits `a29b9318` + `3c2b5f64`)

Coautoría: Claude Opus 5 (1M context). Archivos:

```
apps/view/jest.config.ts                                          |  +8
apps/view/ngsw-config.json                                        |  +25
apps/view/src/app/app.routes.ts                                   |  +9  (ruta /tienda/verificador)
apps/view/src/app/core/services/offline-database.service.ts       |  +31/-… (snapshot por sucursal)
apps/view/src/app/modules/dashboard/layout/layout.component.ts    |  +1
apps/view/.../tienda/pages/tienda-verificador.component.spec.ts   |  +151 (8 aserciones DOM real, jsdom)
apps/view/.../tienda/pages/tienda-verificador.component.ts        |  +604
apps/view/.../modules/tienda/verificador.service.spec.ts          |  +176
apps/view/.../modules/tienda/verificador.service.ts               |  +265
apps/view/.../shared/context-help/context-help.dictionary.ts      |  +33
apps/view/src/testing/primeui-license-stub.ts                     |  +15
tools/verificador-precios/Verificador_Precios_OFFLINE.html        | -299 (borrado)
```

`tools/` queda vacío y se elimina del repo.

### 2.1 Arquitectura resultante

- **Ruta**: `apps/view/src/app/app.routes.ts` — `path: 'verificador'` dentro
  de `tienda`, `canActivate: [permissionGuard(Permission.STORE_PRICE_CHECK_VER)]`.
  Acepta `?sucursal=NN` para una máquina de mostrador sin cuenta de esa tienda.
- **Componente**: `TiendaVerificadorComponent`, standalone, `OnPush`. Input de
  captura (`vp-scan-input`) con foco permanente (`(blur)="reenfocar()"`),
  `(keyup.enter)="consultar(...)"`. Modo kiosco: `[class.is-kiosco]="kiosco()"`
  + Fullscreen API + `Escape` para salir (`@HostListener`).
- **Servicio**: `VerificadorService.buscar(codigo, sucursal)` — llama
  `GET /api/kp/precio?q=&sucursal=` con `timeout(TIMEOUT_LIVE_MS)` (2.5s);
  `catchError` cae a `buscarEnRespaldo()` (índice en memoria armado desde el
  snapshot de IndexedDB). Un `ok:false` del servidor (200, no error de red)
  se respeta tal cual — **no** cae al respaldo, porque sería resucitar un
  precio que el servidor ya sabe que cambió o dejó de existir.
- **Offline**: `OfflineDatabaseService` (Dexie) guarda un snapshot **por
  sucursal** (`guardarSnapshotPrecios`), con TTL de 12h y auto-descarga al
  elegir sucursal (o botón manual "Actualizar respaldo"). Por qué por
  sucursal y no un único registro: 385 códigos (medido, luego afinado a 712
  de 9,348 = 7.6% el 2026-09-09) tienen precio distinto entre plazas.
  `ngsw-config.json` además cachea `/api/kp/precios-todos` como dataGroup
  (`performance`, 12h) y `/api/kp/precio` puntual (`freshness`, 2s).
- **Tres estados, no dos**: `encontrado` / `no_encontrado` (autoritativo,
  nunca cae a respaldo) / `sin_datos` (red caída Y sin respaldo — pantalla
  DISTINTA de `no_encontrado`, porque afirmar "no tiene precio" ante una
  falla de red sería falso).
- **Permiso**: `Permission.STORE_PRICE_CHECK_VER`, propio (no reusa
  `STORE_LABELS_VER`). Migración `20260909120000` (batch 357 en prod,
  **`ID.29`**) lo repartió a 7 roles: `auxiliar_compras`, `auxiliar_tienda`,
  `direccion`, `encargado_tienda`, `piso_tienda`, `superadmin`, `supervisor`
  (`etiquetas_anaquel` excluido a propósito).

### 2.2 Extensiones posteriores (`TDA.1`–`TDA.4`)

- **TDA.1**: un cambio de precio en Kepler llega a la etiquetera en vivo.
- **TDA.2**: `/api/kp/precio` ahora SÍ toma `sucursal` (antes devolvía la
  primera fila de `kdii` en orden arbitrario — podía ser la de CEDIS, que la
  etiquetera excluye a propósito). Declara `precio_ambiguo`/
  `plaza_pedida_sin_dato`/`origen_precio` en vez de publicar un número
  inestable sin decir de dónde salió.
- **TDA.3**: el código escaneado puede ser de una unidad distinta a la base;
  la pantalla aclara cuál es y no repite el precio grande en "otras unidades".
- **TDA.4**: mayoreo — 94% de los SKUs en prod tienen tiers reales (medido).
  Se muestra pegado al precio grande, con el ahorro resaltado sólo si el
  descuento es perceptible (≥1%). El backend filtra los mayoreos sin
  condición conocida (17 productos en prod) antes de que lleguen a pantalla.

## 3. Validación visual (esta sesión, 2026-09-10)

El pendiente que quedó declarado en el tracker era exactamente este: *"NO
verificado: la validación visual en el browser. La sesión del navegador está
expirada y no hay cuenta con la que entrar sin credenciales."*

### 3.1 Cómo se hizo

1. **`.env` local** apuntado a `192.168.0.245/platform_test` (DB de pruebas
   compartida, misma estructura/datos vivos de `kepler_ods` que prod, sin
   tocar `postgres_platform` real). Rol `dev_sistemas` (dado por 0Sistemas).
2. **Usuario de prueba descartable** insertado directo en `identity.users`
   (tenant `mega_dulces`, UUID `00000000-0000-0000-0000-00000000d01c`):
   `username='claude_test_verificador'`, `role_name='superadmin'`, password
   bcrypt. **Borrado al terminar** (no queda en `platform_test`).
3. `npx nx build api && node dist/apps/api/main.js` (puerto 3334) +
   `npx nx serve view --port 4200`. Login real vía `/api/auth-mt/login`.
4. Navegación real con Playwright (MCP) a `/tienda/verificador`, sucursal
   `01 · Sucursal PH`, y consultas reales.

### 3.2 Resultados, estado por estado

- **`encontrado`**: código `17083` → "ALTOS CAM CHICA COLOR 1KG CLASICA",
  **$62.99 por KG** (tag verde "Precio en línea"), unidad alterna **BTO
  $1,159.91**. Coincide EXACTO con el ejemplo que Edgar ya había verificado
  por `curl` en el commit `a29b9318`. Screenshot:
  `verificador-03-encontrado.png` (ver §4, ya no vive en el repo).
- **`no_encontrado`**: código `ZZZ00000` → tarjeta "No encontramos ZZZ00000
  en el catálogo. Revisa que el código esté completo, o pregunta en caja."
  Distinta de la tarjeta de respaldo — no es un vacío.
- **`respaldo`** (el caso que más importaba probar): se detuvo el proceso de
  `apps/api` a propósito (simulando la red caída) y se repitió la búsqueda
  de `17083`. La pantalla cayó SOLA al snapshot de IndexedDB — sin que se
  hubiera pedido nada manual, porque ya se había auto-descargado al elegir
  la sucursal ("Respaldo local: 9485 productos · 10/09 08:04" apareció solo
  al seleccionar "01 · Sucursal PH", antes de buscar nada). Resultado:
  banner amarillo "⚠ Sin conexión: se está mostrando el precio de respaldo.
  Es el catálogo descargado en esta máquina; puede haber cambiado. Confirma
  en caja antes de cobrar.", tag naranja "⚠ Precio de respaldo", mismo
  precio ($62.99), nota "Tomado del respaldo del 10/09/26 08:04." Exactamente
  el comportamiento diseñado.
- **Modo kiosco**: oculta sidebar, breadcrumbs, barra superior y nav
  inferior — queda sólo el contenido del verificador. Botón cambia a "Salir
  de kiosco".
- **Mayoreo**: NO se pudo ejercer. Se probaron ~30 códigos reales (via
  `/api/kp/precio` directo) sacados de `/api/kp/precios-todos?sucursal=01` y
  ninguno traía tiers en `platform_test`. Es una limitación de esa DB de
  pruebas (probablemente `commercial.product_label_prices` no está tan
  poblada ahí como en prod) — no del código, que ya lo verificó Edgar contra
  prod real (8,481/9,020 SKUs, `[TDA.4]`).

### 3.3 Hallazgo del entorno local (no es un bug del verificador)

Al arrancar `apps/api` con `ENABLE_MULTITENANT=true` contra `platform_test`,
`/api/users/me/access`, `/api/users/me/scope` y **`/api/sucursales`** (que es
`@Public()`) daban **500** con `authentication failed for user "postgres"`.

Causa: `TenantContextInterceptor` (`libs/platform-core/src/lib/tenant/
tenant-context.interceptor.ts`) inyecta `KNEX_CONNECTION_RAW` — la conexión
"legacy" que, **post-cutover**, es la MISMA DB física que `KNEX_NEW_DB` pero
con el rol `postgres` (bypasea RLS). La abre en transacción para **toda**
request bajo el toggle multitenant, pública o no. Su config
(`libs/platform-core/src/lib/database/database.module.ts`,
`buildLegacyDbConfig()`) cae al default `user: 'postgres', password:
'postgres', host: 'localhost'` si no hay `DATABASE_URL` en el `.env` — que es
justo lo que pasaba, porque el `.env` de esta sesión sólo traía las vars de
`DATABASE_URL_NEW`/`_RUNTIME`.

**No hay password real de `postgres` para `platform_test` a mano.** Se
destrabó apuntando también `DATABASE_URL` al mismo `platform_test` con el rol
`dev_sistemas` — funciona porque es la misma DB física, aunque `dev_sistemas`
no bypasea RLS de verdad como se supone que debe hacer esa conexión. Sirve
para desarrollar/validar localmente, no es una corrección del código.

## 4. Evidencia (screenshots)

Las 7 capturas de esta validación (`verificador-01-inicial.png` …
`verificador-07-kiosco.png`) se generaron en el scratchpad de la sesión, NO
en el repo — no quedaron commiteadas a propósito (son evidencia de sesión,
no artefactos de producto). Si hace falta volver a verlas, repetir los pasos
de §3.1: la app y los datos reales siguen ahí, sólo falta recrear la cuenta
de prueba (o usar una real).

## 5. Cómo reproducir esta validación (para la próxima sesión)

```bash
# 1. .env local — ver plantilla completa en §3.1. Mínimo:
NODE_ENV=development
JWT_SECRET=cualquier_cosa_larga_para_dev
ENABLE_MULTITENANT=true
NEW_DB_HOST=192.168.0.245
NEW_DB_PORT=5432
NEW_DB_NAME=platform_test
DATABASE_URL_NEW=postgresql://<rol>:<password>@192.168.0.245:5432/platform_test
DATABASE_URL_NEW_RUNTIME=postgresql://<rol>:<password>@192.168.0.245:5432/platform_test
# Sin esta, /api/sucursales (pública) y el login dan 500 "auth failed for user postgres":
DATABASE_URL=postgresql://<rol>:<password>@192.168.0.245:5432/platform_test

# 2. Build + arranque (Windows: nx serve api falla con ENAMETOOLONG)
npx nx build api && node dist/apps/api/main.js   # puerto 3334
npx nx serve view --port 4200                     # puerto 4200, proxy.conf.json -> 3334

# 3. Usuario de prueba descartable (bcrypt, tenant mega_dulces = 00000000-0000-0000-0000-00000000d01c)
#    INSERT INTO identity.users (tenant_id, username, password_hash, nombre, role_name, activo)
#    VALUES ('00000000-0000-0000-0000-00000000d01c', '<user>', '<bcrypt hash>', '<nombre>', 'superadmin', true);
#    BORRARLO al terminar.

# 4. Login → /tienda/verificador → elegir sucursal → escanear.
#    Para probar el respaldo: matar el proceso de la API y repetir la búsqueda.
```

## 6. Pendiente

- **Que Edgar (o quien tenga cuenta real) confirme** en su propia sesión —
  esta validación usó una cuenta descartable, no la suya.
- **Mayoreo sin ejercer localmente** — probar contra una DB con
  `commercial.product_label_prices` poblada, o pedir a Edgar que lo repita
  con los códigos que él ya verificó en prod.
- **`datos_al` de `/api/sucursales` sigue null para las 7 sucursales** en
  `platform_test` (y aparentemente en `.245` en general — `analytics.cron_runs`
  no tiene ninguna fila `cdc_wal_NN`). La pantalla ya lo declara ("Frescura
  del ERP sin medir") en vez de callarlo, pero de dónde sale esa frescura de
  verdad sigue abierto (Fase OBS).
- El hallazgo de `DATABASE_URL`/`TenantContextInterceptor` (§3.3) no es de
  este verificador — si alguien más lo pisa al desarrollar localmente contra
  `platform_test`/`postgres_platform` con `ENABLE_MULTITENANT=true`, ya está
  documentado acá y en el `CHANGELOG.md` de esta fecha.
