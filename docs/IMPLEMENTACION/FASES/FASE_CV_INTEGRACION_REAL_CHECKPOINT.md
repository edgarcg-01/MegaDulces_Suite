# Fase CV — Checkpoint: integración real (auth-mt + kepler_ods + commercial.orders)

> **Qué es este documento:** checkpoint autocontenido para retomar el trabajo desde
> cero (otra sesión de Claude Code, otra herramienta como Claude.ai/Gemini, u otro
> dev). No depende de conversación previa. Generado 2026-09-05 tras 3 investigaciones
> profundas (agentes Explore) sobre el código real del monorepo. Todas las rutas de
> archivo, nombres de tabla/columna y fragmentos SQL citados abajo son reales,
> verificados contra el código — no inventados.
>
> **Para el lector sin contexto previo:** este proyecto es una Suite de trade
> marketing / B2B para Mega Dulces (distribuidora de dulces, México). Ver
> `CLAUDE.md` (raíz del repo) para el contexto completo del proyecto. Este doc
> es solo sobre UN sub-problema: la Fase CV (migración de un catálogo/tienda
> externo) y su reconciliación con la arquitectura real de la Suite.
>
> **⚠️ ACTUALIZADO 2026-09-05 (mismo día, más tarde) — LA INTEGRACIÓN DESCRITA
> ABAJO (auth-mt + `commercial.orders`) NO SE HIZO.** Se decidió un camino
> distinto: ver **§0** justo abajo para el desenlace real antes de leer el
> resto de este documento como si fuera el plan vigente. Las secciones 1-5
> quedan como **registro de la investigación** (siguen siendo útiles si algún
> día se retoma auth-mt o `commercial.orders` de verdad), pero **no son el
> plan que se ejecutó**.

---

## 0. Desenlace real — qué se decidió en vez de esto

Después de escribir este checkpoint (secciones 1-5, investigación completa de
los 3 frentes), **el usuario decidió NO completar la integración de
auth-mt/`commercial.orders`** y en su lugar:

1. **`apps/catalogo-kp` (PR #62) se recortó a SOLO el verificador de precios**
   (`GET /api/kp/precio`, `/api/kp/precios-todos`, `GET /api/sucursales` —
   público, sin sesión, sin pedidos). Este alcance no necesita auth-mt ni
   `commercial.orders` en absoluto. Detalle completo del recorte (CV.23) en
   [`FASE_CV_CATALOGO_TIENDA_MAYOREO.md`](FASE_CV_CATALOGO_TIENDA_MAYOREO.md).
2. **Todo lo demás (catálogo interno, admin/usuarios, dashboard, tienda
   completa con carrito/checkout/Mercado Pago) se sacó de la integración a la
   Suite** — no se descartó, se movió a **3 repos standalone nuevos y
   privados** bajo `github.com/0SistemasMD`:
   - [`catalogo-kp`](https://github.com/0SistemasMD/catalogo-kp) — catálogo
     interno + auth + admin, sin la tienda.
   - [`verificador-precios`](https://github.com/0SistemasMD/verificador-precios) —
     el mismo recorte que el punto 1, pero standalone (nació antes de CV.22,
     así que todavía lee `KP_CONCENTRADA` en vez de `kepler_ods`). Ya
     verificado end-to-end contra `KP_CONCENTRADA` real.
   - [`Ecommerce-Mayorista`](https://github.com/0SistemasMD/Ecommerce-Mayorista) —
     la tienda completa (backend `api/` + frontend Angular `web/`), con auth
     recortada a **solo verificación** del mismo JWT que emite `catalogo-kp`
     (sin login ni CRUD de usuarios propio).
3. **PR #62** se actualizó (título, descripción, un comentario explicando el
   pivot) y se **pidió re-review formal a Edgar y David** (`gh api
   .../requested_reviewers`) — sigue esperando respuesta.
4. **PR #63** (CV.18-20, encadenado sobre #62) quedó huérfano — dependía de
   los módulos `admin`/`auth`/`catalogo` que ya no están — y **se cerró** con
   nota apuntando a dónde sigue vivo ese trabajo (`catalogo-kp` standalone).

**Por qué:** los 2 frentes que este checkpoint investiga (auth-mt,
`commercial.orders`) tienen huecos reales del lado de la Suite que no
dependían de esfuerzo de este lado — no hay precedente de creación de orden
anónima en toda la Suite, y no existe pasarela de pago online
(`commercial.payments` sin `oxxo`/`spei`, sin SDK, sin webhook). Completar
ambos exigía negociar y construir infraestructura nueva de la Suite, no solo
adaptar `catalogo-kp`. En vez de bloquear el verificador (que no necesita
nada de esto) esperando esa negociación, se separó.

**Si en algún momento se retoma auth-mt o `commercial.orders`** (para el
repo standalone `catalogo-kp` o `Ecommerce-Mayorista`, ya sea integrándolos
de vuelta a la Suite o no), las secciones 1-5 de abajo siguen siendo la
investigación de referencia — aunque hay que re-verificar todo contra el
código real antes de confiar en ningún detalle (puede haber cambiado desde
2026-09-05).

---

## 1. Contexto — cómo llegamos acá

### 1.1 Qué es Fase CV

`apps/catalogo-kp` es el resultado de **migrar físicamente** (no reescribir) un
proyecto NestJS 10 standalone llamado `megadulces-api-ready` — que corría en
producción real en una máquina `.163`, construido por un dev externo
("Felipe-Diseño") — hacia este monorepo Nx. Es un catálogo público + verificador
de precios de mostrador + tienda mayorista (checkout con dinero real, Mercado
Pago/OXXO/SPEI). Lee directo de una base llamada `KP_CONCENTRADA` (Postgres
on-prem en `192.168.0.245`, poblada por `concentrate-kepler.js`), schema `kp.*`
— una **copia** de datos de Kepler (el ERP ya existente de Mega Dulces).

La migración (CV.0–CV.20) se hizo en múltiples sesiones previas y quedó
**completa y verificada en producción real** (login real, checkout real con
pedido `MD-2026-00012`, corte real del Service en `.163` reemplazado por este
monorepo). Detalle completo en
[`FASE_CV_CATALOGO_TIENDA_MAYOREO.md`](FASE_CV_CATALOGO_TIENDA_MAYOREO.md)
(el otro doc de esta misma carpeta — es la bitácora paso a paso CV.0–CV.20).

### 1.2 El problema de git (ya resuelto)

Toda la Fase CV (18 commits, CV.0–CV.17) se había commiteado solo en el `main`
**local** de la máquina de desarrollo, nunca subida a GitHub. Cuando se abrió un
PR con el trabajo de una sesión posterior (CV.18–19), la rama arrastró esos 18
commits nunca revisados + el `main` local estaba ~250 commits atrasado del
`main` real del equipo. Resultado: un PR de 223 archivos, imposible de revisar,
que Edgar (dueño del repo) rechazó.

**Se resolvió** reconstruyendo todo contra el `main` real y dividiendo en dos PRs:

- **PR #62** (`feat/cv-port-fisico-catalogo-kp` → `main`): el port físico
  original CV.0–CV.17, limpio, sin conflicto, más dos fixes encontrados al
  reconciliar (CVE de `xlsx` → migrado a `exceljs`; colisión de numeración
  `ADR-052` → renumerado a `ADR-056`, ya que el 052 real lo tiene *Contratos de
  tipos del boundary REST*).
- **PR #63** (`feat/cv18-20-usuarios-wix-variantes` → base PR #62, encadenado):
  CV.18–20 (panel de usuarios, filtro de sucursal en reporte Wix, "agregar
  variantes donde falten").
- PR #60 (el original, mal formado) — **cerrado**, referencia a los dos de arriba.

Esto **ya está hecho y pusheado a GitHub**. No es el problema actual.

### 1.3 El problema actual — la revisión de Edgar

Edgar revisó PR #62 el 2026-09-03 y dejó **dos mensajes seguidos** (una review y,
3 minutos después, una corrección a su propia review — la corrección es la que
vale, es más específica y más reciente):

**Veredicto final (el corregido) — de 5 puntos "diferidos", solo 2 quedan como
deuda documentada; 3 son bloqueantes, no negociables:**

| # | Punto | Veredicto de Edgar |
|---|---|---|
| 1 | Auth propio (`admin.usuarios` + JWT propio `CATALOGO_KP_JWT_SECRET`) | **⛔ NO aceptado** — "pone identidad real fuera de la plataforma". Debe integrar a `auth-mt` + `identity.users` + permisos (una sola identidad multi-tenant). |
| 2 | Lee `KP_CONCENTRADA` directo (copia de Kepler) | **⛔ NO aceptado** — regla ⭐ #1 del proyecto ("cero copias, todo del ODS"). Debe leer de `kepler_ods.*` en la DB de prod real (`postgres_platform`), alcanzable desde Railway, refrescada por CDC. |
| 3 | Ledger propio `tienda.pedidos`/`pedido_items`/`pedido_eventos` | **⛔ NO aceptado** — "pone dinero real fuera de la plataforma", invisible a analytics/Maat/cartera/RLS. Debe escribir a `commercial.orders` (el ledger único de toda la Suite, folio `PD-YYYY-NNNNN`, máquina de estados `draft→pending_approval→confirmed→fulfilled`). |
| 4 | Frontend HTML estático (no Angular+PrimeNG+`DESIGN.md`) | ✅ Aceptado como deuda documentada (ticket, no bloquea) |
| 5 | Imágenes commiteadas (112 `.jpg`, ~9MB, no Cloudinary) | ✅ Aceptado como deuda documentada (ticket, no bloquea) |

Edgar dio punteros concretos de dónde reusar (no reconstruir): `auth-mt`
(`apps/api/src/modules/auth-mt/`), `JwtAuthGuard`
(`libs/platform-core/src/lib/auth/`), el enum de permisos, y
`commercial-orders.controller.ts`/`CommercialOrdersService`
(`libs/commercial/src/lib/commercial-orders/`). Para datos, dio el mapeo 1:1:
`kp.kdii`→`kepler_ods.kdii`, `kp.kdil`→`kepler_ods.kdil`,
`kp.kdig`→`kepler_ods.kdig`, `kp.kdm2`→`kepler_ods.kdm2`, marcando como
crítico usar `analytics.v_product_box_factor`/`v_product_unit_ladder` en vez
de derivar el factor de caja a mano.

**Estado en el momento en que se escribió esta sección (ya superado — ver §0
para el desenlace real):**
- PR #62: `OPEN`, `CHANGES_REQUESTED`, sin ningún commit nuevo desde la
  corrección de Edgar (03-sep). Nadie había empezado a atacar esto todavía.
- PR #63: `OPEN`, sin review de Edgar (encadenado sobre #62).

*(Esto cambió por completo horas después — PR #62 se recortó y volvió a
pedir review, PR #63 se cerró. Ver §0.)*

---

## 2. Los 3 frentes de investigación (hallazgos completos)

Se lanzaron 3 agentes de exploración en paralelo sobre el código real. Resumen
organizado por frente — completo, no resumen superficial, porque este
documento tiene que servir para ejecutar sin releer todo el repo de cero.

---

### 2.1 FRENTE AUTH — migrar a `auth-mt` + `identity.users` + permisos

**Archivos clave del lado destino (a integrar):**
- `apps/api/src/modules/auth-mt/{auth-mt.controller,auth-mt.service,auth-mt.module}.ts`
  — **ojo: este módulo NO está registrado en `AppModule` todavía** ("convive con
  auth legacy hasta el cutover", según su propio comentario de cabecera).
- `libs/platform-core/src/lib/auth/jwt-auth.guard.ts` + `public.decorator.ts`
- `libs/platform-core/src/lib/guards/roles.guard.ts` (el guard que sí valida permisos)
- `libs/platform-core/src/lib/ability/permissions-cache.service.ts`
- `libs/platform-core/src/lib/decorators/req-user.decorator.ts` (`@ReqUser()`)
- `libs/platform-core/src/lib/decorators/permissions.decorator.ts`
  (`@RequirePermissions`/`@RequireAnyPermission`)
- `libs/platform-core/src/lib/constants/permissions.ts` (enum `Permission`, 164 keys)
- Precedente de **frontend** consumiendo auth-mt: `apps/vendor/src/app/core/services/auth.service.ts`
  (`loginMt()`) + `apps/vendor/src/app/core/http/auth.interceptor.ts`

**Cómo funciona `auth-mt` hoy (verificado leyendo el código):**

1. `POST /auth-mt/login` (`@Public()`), body `{ tenant_slug, username, password }`.
2. Resuelve `tenant_slug`→`tenant_id`, abre transacción con
   `SET LOCAL app.tenant_id`, busca `users` por `username`+`activo=true`,
   junta `role_permissions` + `identity.user_roles` (roles complementarios) +
   `identity.user_permissions` (overrides por usuario) + `zones`.
3. Rechaza `kind='servicio'` y `expires_at` vencido.
4. `bcrypt.compare`, firma JWT con claims:
   ```ts
   { sub, tenant_id, username, role_name, zona_id?, warehouse_code?, zona?, permissions?: Record<string, boolean> }
   ```
   — **`permissions` es solo snapshot para gating de UI**; el backend
   **re-lee siempre fresco** vía `RolesGuard`+`PermissionsCacheService` en cada
   request, nunca confía en el JWT para autorizar.
5. El secreto es `JWT_SECRET` (env var), **sin `requireJwtSecret()` helper** —
   cada módulo repite `process.env.JWT_SECRET || 'super_secret_dev_key_change_in_prod'`
   (fallback inseguro, sin fail-fast — contraste con el propio
   `CATALOGO_KP_JWT_SECRET` de catalogo-kp que SÍ hace fail-fast).

**El guard NO revalida contra DB directo** (`JwtAuthGuard` solo verifica firma/
expiración). La "revalidación cada 30s" es `PermissionsCacheService`: cache en
memoria `Map`, `TTL_MS = 30_000`, invalidación explícita en ediciones admin +
TTL como fallback. **Un revoke se propaga en ≤30s sin forzar logout; un grant
nuevo necesita re-login** (está horneado en el JWT también).

**`identity.users`** (schema `identity`, no `public` — migrado con
`ALTER TABLE ... SET SCHEMA identity`): `id UUID PK`, `tenant_id UUID FK`,
`username VARCHAR(100)` (único **por tenant**, no global), `password_hash`,
`nombre`, `zona_id`, `role_name` (FK a `role_permissions`), `supervisor_id`,
`activo BOOLEAN`, `kind VARCHAR(20)` (`interno|cliente|proveedor|externo|servicio`),
`expires_at`, `status` (`invited|active|suspended|terminated`),
`must_change_password`, más columnas de scoping (`warehouse_code`, `route_id`,
`department_code`, etc.). **RLS forzado** (`FORCE ROW LEVEL SECURITY`,
policy `tenant_isolation` sobre `tenant_id = current_tenant_id()`).

**El enum de permisos y el checklist real de "touch-points":**
Documentado literal en `docs/GOTCHAS.md` §4. **Importante: el checklist dice
"6 touch-points" pero ADR-054 (2026-09-02) retiró CASL por completo** —
`ability.factory.ts` ya no existe. Son **5 touch-points reales hoy**:
1. Enum backend (`libs/platform-core/.../constants/permissions.ts`).
2. Gate del endpoint con `@RequirePermissions(Permission.X)`.
3. Enum frontend (`apps/view/.../core/constants/permissions.ts` — copia manual).
4. `permission-meta.ts` (label/descripción/categoría) + `authz-tree.ts`
   (para que aparezca como checkbox en `/admin/roles`).
5. Gate a nivel botón en frontend:
   `perms.can('manage','all') || auth.user()?.permissions?.[Permission.X] === true`
   (el OR con `manage:all` es obligatorio o los admins pierden el botón).

Convención de nombres: `<MODULO>_VER` (lectura), `<MODULO>_GESTIONAR`
(escritura completa), verbos más finos donde aplica (`_CAPTURAR`, `_VALIDAR`,
`_APROBAR`, `_CONFIRMAR`, `_CANCELAR`, `_ASIGNAR`). **Un permiso nuevo no se
siembra por default** — se asigna a mano en `/admin/roles` + el usuario necesita
re-login.

**Qué hay que desarmar en catalogo-kp** (`apps/catalogo-kp/src/auth/*` y `src/admin/*`):
- `auth.module.ts`/`auth.service.ts`/`jwt.strategy.ts` — login propio contra
  `admin.usuarios` en `KP_CONCENTRADA`, JWT con claims `{ sub (int), email, rol, nombre }`
  (**sin tenant_id, sin mapa de permisos** — solo un string `rol`).
- `admin.controller.ts`/`admin.service.ts` — CRUD de usuarios propio, guard
  local `RolesGuard` (compara `rol==='admin'` como string, sin granularidad).
- `sesion.util.ts` — patrón de **auth opcional** ("si hay sesión válida, muestra
  costo/margen; si no, oculta") que **no tiene equivalente directo** en
  platform-core (su modelo `@Public()` es binario, autenticado o no).

**Gaps/decisiones reales que Edgar tiene que resolver antes de picar código:**

1. **Scoping por sucursal no está realmente enforced hoy.** `admin.usuarios.sucursales`
   (array) se guarda y se devuelve en el login, pero **nunca se mete en el JWT
   ni se valida en ningún guard/controller/service** (verificado por grep en
   todo el repo) — es dato de UI, no una frontera de seguridad real. El
   mecanismo correcto de la plataforma para "ve varias sucursales" es
   `identity.user_scopes`/`ScopeService` (`dimension:'warehouse', mode:'listed'`)
   pero es **opt-in por dominio** — hay que llamarlo explícitamente, no es automático.
2. **Dos DBs completamente separadas, sin conexión hoy.** `identity.users` vive
   en la DB de Railway (`postgres_platform`); catalogo-kp solo conecta a
   `KP_CONCENTRADA` on-prem (`.245`) por LAN. Integrar auth-mt significa un
   **segundo pool de conexión a Railway** — nueva dependencia externa para una
   app diseñada deliberadamente para ser autosuficiente on-prem (ver
   `FASE_CV_CATALOGO_TIENDA_MAYOREO.md` P1: "no Railway ciclo de vida"). Esto es
   una regresión operativa real que hay que nombrarle a Edgar explícitamente:
   hoy catalogo-kp solo cae si la LAN o `.245` caen; después de esto también
   depende de que Railway/internet estén arriba, en cada login y cada refresh
   de permisos.
3. **`username` no es email.** catalogo-kp usa email como login; `identity.users.username`
   es único por tenant, no tiene forma de email en otros lados de la Suite.
   Hay que decidir si el username de catalogo-kp se vuelve el username de
   `identity.users` (con `kind='interno'`) o si hace falta preservar email aparte.
4. **Semántica exacta vs. coarse-grained.** `RolesGuard` es exact-key, sin
   herencia entre sub-permiso y hermano amplio (documentado en GOTCHAS §4).
   Catalogo-kp tiene 8+ acciones bajo un solo string `rol='admin'` hoy — hay que
   decidir si se vuelven 8+ claves nuevas del enum o si se agrupan en 1-2,
   aceptando menos granularidad que el resto de la Suite.
5. **La separación de secretos (`CATALOGO_KP_JWT_SECRET` vs `JWT_SECRET`) fue
   una decisión de seguridad deliberada** (para que un leak en un sistema no
   sirva para forjar tokens en el otro) — migrar a `auth-mt` la revierte
   intencionalmente. Vale la pena que sea una decisión consciente, no un
   side-effect implícito.
6. **No existe precedente de "backend consume el login de otro backend".**
   `apps/portal`/`apps/vendor` son frontends Angular puros — llaman
   `/auth-mt/login` desde el navegador. Catalogo-kp **es un backend NestJS**
   con sus propios controllers. Dos caminos reales: **(a)** catalogo-kp importa
   directamente `JwtAuthGuard`+`RolesGuard`+`PermissionsCacheService`+`Permission`
   desde `@megadulces/platform-core` (ya es parte del mismo monorepo Nx, sin
   duplicar código) — **recomendado**, o **(b)** el frontend HTML de catalogo-kp
   llama `/auth-mt/login` directo (como vendor/portal) y el backend de
   catalogo-kp solo verifica tokens, nunca los emite.

---

### 2.2 FRENTE DATOS — migrar de `KP_CONCENTRADA` a `kepler_ods.*`

**Qué es `kepler_ods` (verificado en `docs/ERP_KEPLER.md` +
`docs/ARQUITECTURA_DATOS.md` + la migración real):**
Espejo crudo único de Kepler: 6 DBs Kepler por sucursal (01-06, Postgres) →
replicación lógica WAL → réplicas locales `kepler_md_01..06` → normalizador
`replicate-ods-live.js` → **`kepler_ods.*`** (una tabla por entidad, columna
`sucursal`) → vistas derivadas `analytics.*`/`commercial.*`. **CEDIS (sucursal
`00`) NO está en este pipeline** (corre Access 97, fase aparte `FASE_CA`, aún
sin integrar). `kepler_ods` es **single-tenant, sin `tenant_id`, sin RLS**
(confirmado en migración `20260811120000_kepler_ods_schema.js`). Frescura:
"near real-time", monitoreado por `kepler_ods._sync_status.last_push_at`
(umbrales de alerta 15min/1hr).

**Mapeo exacto de columnas usadas hoy por catalogo-kp** (extraído de
`apps/catalogo-kp/src/kp/kp.service.ts` línea por línea):

| Query/endpoint | Tabla `kp.*` hoy | Columnas exactas |
|---|---|---|
| `getProductos(sucursal?)` | `kp.kdii` (+ `kp.kdil` join existencia, + `kp.kdig` join proveedor) | `c1`=código, `c2`=nombre, `c18`=IVA raw, `c19`=IEPS raw, `c77`=costo, `c87`=margen, `c90/c91/c92`=precio u1/u2/u3, `c11/c80/c83`=etiquetas u1/u2/u3, `c81/c84`=factores u2/u3, `c3`=código proveedor (join a kdig) |
| `getExplorador()`/`calcularExplorador()` | `kp.kdii` + `kp.kdil` (existencia TODAS sucursales) + `kp.kdm2` (movimientos del año) | `kdil`: `c1`=almacén, `c3`=SKU, `c8`(entradas)-`c9`(salidas); `kdm2`: `c8`=SKU, `c9`=cantidad, `c32`=fecha, `c3`=naturaleza A/D |
| `getPrecio(q)` / `getPreciosTodos(sucursal?)` (**públicos, sin auth**) | `kp.kdii` | mismas columnas que `getProductos` + `c7/c82/c93/c95/c96`=códigos de barras alternativos |
| `getSchema()` | introspección de `kp.kdm2` | **candidato a eliminar** — existía por incertidumbre sobre las columnas de origen, que ya no aplica (todo documentado) |
| (en `catalogo.service.ts`/`tienda.service.ts`, fuera de `kp.service.ts`) | `kp.kdie`/`kp.kdif` (deptos/líneas), `kp.kdik.c5` (**una TERCERA fuente de existencia, distinta de `kdil`**), `kp.sync_control` | ver gaps abajo |

**Vistas canónicas que YA EXISTEN y hay que reusar (no derivar a mano):**

- **`analytics.v_product_box_factor`** — factor de caja canónico. Join key
  `tenant_id, product_id`. Columnas: `box_factor`, `source`
  (`override|kepler_c84|etiquetera|factor_sale|inner_box_guard|default`),
  `is_master_suspect`. ⚠️ **"leer siempre `source` junto al factor"** — el
  significado de `box_factor` cambia según `source`.
- **`analytics.v_product_unit_ladder`** — escalera de unidad por SKU, join key
  **solo `sku`** (sin tenant_id, sin RLS por construcción — deriva 100% de
  `kepler_ods.kdii`, excluye `sucursal='00'`, agrega por mediana/moda entre
  sucursales). Columnas: `unit_base`, `u2_label`/`u3_label`, `f2`/`f3`,
  `p1`/`p2`/`p3` (precios mediana).
- **`analytics.v_erp_stock_on_hand`** — stock/existencia canónico, UNION
  Kepler+Wincaja, join key `(tenant_id, warehouse_id, product_id)`. Construida
  `WITH (security_invoker=true)` — **SÍ hereda RLS** vía los joins a
  `catalog.products`/`commercial.warehouses`.
- Doc completo: `docs/UNIDADES_DE_MEDIDA.md` (leer antes de tocar cualquier
  factor de caja — regla dura del proyecto, ya costó caro dos veces según
  el propio CLAUDE.md: ADR-051 y CANON.0.1).

**Servicios existentes que ya consumen estas vistas — usar como plantilla:**
- `libs/commercial/src/lib/commercial-replenishment/commercial-replenishment.service.ts`
  (el más rico — usa `TenantKnexService`, hace `SELECT to_regclass('kepler_ods.kdm1')`
  defensivo antes de consultar).
- `libs/commercial/src/lib/commercial-analytics/route-promo.service.ts`
  (patrón `LATERAL` para resolver qué escalón de precio matcheó una venta real).
- `libs/commercial/src/lib/commercial-pricing/commercial-pricing.service.ts`
  (el ejemplo más limpio de DI: `TenantKnexService`+`TenantContextService`
  inyectados directo en el constructor).

**Gaps/ambigüedades reales — necesitan decisión de Edgar antes de migrar:**

1. **Precio por sucursal vs. mediana cross-sucursal.** `v_product_unit_ladder.p1/p2/p3`
   son **medianas entre TODAS las sucursales**; `getProductos(sucursal)` de
   catalogo-kp necesita el precio **de una plaza específica** (los precios
   legítimamente difieren por plaza — CV.19 corrigió justo un bug de esto). La
   vista canónica NO resuelve esto — probablemente hay que seguir leyendo
   `kepler_ods.kdii.c90/c91/c92` crudo por sucursal para el PRECIO, y usar
   `v_product_unit_ladder` solo para etiquetas/factores.
2. **`kp.kdie`/`kp.kdif`** (catálogos de depto/línea, usados en `catalogo.service.ts`/
   `tienda.service.ts`) **no están en el mapeo que dio Edgar** — falta confirmar
   que existen en `kepler_ods` con el mismo nombre.
3. **`kp.sync_control`** (freshness por sucursal, usado en `catalogo.service.ts`)
   **no tiene equivalente** — `kepler_ods._sync_status` es solo a nivel tabla,
   sin columna de sucursal.
4. **Divergencia YA EXISTENTE dentro de catalogo-kp**: `kp.service.ts` usa
   `kdil` (`c8-c9`) para existencia, pero `tienda.service.ts` usa **`kdik.c5`**
   — una tercera fuente distinta, que tampoco está en el mapeo de Edgar. Hay
   que resolver esta divergencia como parte de la migración, no cargarla dos veces.
5. **Costo/margen (`c77`/`c87`)** no tiene vista canónica mencionada en ningún
   doc — quedan como lectura cruda de `kepler_ods.kdii`. Vale preguntarle a
   Edgar si deberían pasar por `analytics.v_supplier_cost_ladder` (mencionada
   en `UNIDADES_DE_MEDIDA.md` §8quater) en vez de una columna `cN` sin resolver
   por el mismo motivo que aplicó a `c84`.
6. **Decisión de RLS/tenant real, no mecánica.** `kepler_ods.*` crudo no tiene
   RLS (conexión simple sirve). Pero en el momento en que catalogo-kp consulte
   `analytics.v_product_box_factor`/`v_erp_stock_on_hand` (que sí tocan
   `catalog.products`/`commercial.warehouses`, RLS-protegidas), esas queries
   **devuelven 0 filas en silencio** si no hay `SET LOCAL app.tenant_id`
   (el "síntoma más caro/invisible" según `docs/GOTCHAS.md` §1). Catalogo-kp
   hoy no tiene NINGUNA maquinaria multi-tenant. Dos caminos: importar
   `TenantKnexService`/`NewDatabaseModule` de `@megadulces/platform-core`, o
   simplemente hardcodear el tenant único (`00000000-0000-0000-0000-00000000d01c`,
   ya hay precedente de esto en una migración real) ya que la Suite hoy corre
   efectivamente single-tenant.
7. **Wiring DI concreto**: hoy `KNEX_KP_CONCENTRADA` (token en
   `apps/catalogo-kp/src/kp-concentrada/kp-concentrada.module.ts`, fail-fast si
   falta `DATABASE_URL_KP_CONCENTRADA`, rol dedicado `catalogo_kp_runtime`).
   El helper `pg-raw.util.ts` (`pgRaw()`, traduce `$N`→`?`) es reusable sin
   cambios contra cualquier Knex. Patrón destino: un módulo/token nuevo
   análogo a `STORE_KNEX`/`KNEX_KEPLER_CONSOLIDADO`
   (`apps/api/src/modules/store/store.module.ts`,
   `apps/api/src/modules/kepler-consolidado/kepler-consolidado.module.ts`) —
   pool propio contra `postgres_platform`, rol dedicado nuevo (no `app_runtime`,
   mismo criterio que ya se siguió en CV.8 — precedente de `GOTCHAS.md` §24).

---

### 2.3 FRENTE PEDIDOS — migrar de `tienda.pedidos` a `commercial.orders`

**Servicio destino:** `libs/commercial/src/lib/commercial-orders/`
(`commercial-orders.service.ts` — 93KB, grande — + `.controller.ts` +
`order-stock.service.ts`).

**Endpoints REST reales (`@Controller('commercial/orders')`, todos gateados
por `RolesGuard`+`RequirePermissions`):**

| Método | Path | Qué hace |
|---|---|---|
| POST | `/` | `createDraft` — crea orden `draft` |
| POST/PUT/PATCH/DELETE | `/:id/lines...` | agregar/reemplazar/actualizar/borrar líneas (solo en `draft`) |
| POST | `/:id/confirm` | `draft → pending_approval` (lado cliente) |
| POST | `/:id/approve` | `pending_approval → confirmed` (lado vendedor) |
| POST | `/:id/place` | atajo atómico: `draft\|pending_approval → confirmed` en 1 sola transacción (pensado para campo/preventa) |
| POST | `/:id/fulfill` | `confirmed → fulfilled`, consume stock |
| POST | `/:id/deliver-now` | fast-forward a `fulfilled` (autoventa) |
| POST | `/:id/cancel` | cancela desde cualquier estado salvo `fulfilled` |
| GET | `/my`, `/:id/history`, `/:id/shipments` | consultas |

**Máquina de estados:** `draft → pending_approval → confirmed → fulfilled`,
`cancelled` alcanzable desde cualquier estado no-`fulfilled`.

**Folio (`PD-YYYY-NNNNN`):** UPSERT atómico sobre `commercial.order_sequences`
`(tenant_id, year)` — mismo patrón conceptual que el `nextval('tienda.folio_seq')`
de catalogo-kp hoy, solo que scoped por año además de tenant.

**Reserva/consumo de stock:** atómico, `FOR UPDATE`, dentro de la MISMA
transacción del confirm/fulfill (`order-stock.service.ts`). Registra
`commercial.stock_movements` + `commercial.stock_lot_movements` (FEFO).

**Precio en línea:** snapshot inmutable al insertar (`pricing.resolvePriceForQty`),
NO se re-lee de una lista de precios viva después.

**Precedente de consumidor directo (sin wrapper service intermedio):**
`apps/portal`/`apps/vendor` llaman los endpoints REST de arriba
**directamente** desde su frontend Angular. `apps/vendor`'s
`offline-sync.service.ts` usa `client_uuid` como llave de idempotencia
(evita duplicar folio si se reintenta un POST perdido) — patrón necesario
para un checkout tolerante a reintentos como el de catalogo-kp.

**Cliente casual/walk-in — YA EXISTE, no es un gap:**
`libs/commercial/src/lib/commercial-home-delivery/commercial-home-delivery.service.ts::resolveCustomer()`
— si no hay `customer_id`, recibe `{name, phone}`, normaliza el teléfono,
deduplica contra `commercial.customers` por teléfono/whatsapp normalizado, y
si no existe lo crea con `code: 'CAS-'+últimos10dígitos`, `is_casual: true`
(columna agregada en migración `20260702182000_lm_customers_casual.js`,
explícitamente para excluir del análisis de cartera). Documentado en
`docs/IMPLEMENTACION/FASES/FASE_LM_ULTIMA_MILLA.md` §5.2 — **marcado
✅ EN CÓDIGO, no solo diseñado** (dato que corrige al resumen de CLAUDE.md,
que lo lista como "sin código aún" — está desactualizado en ese punto).

**Pagos — parcialmente construido, con un gap real:**
`libs/commercial/src/lib/commercial-payments/commercial-payments.service.ts`
YA EXISTE (contradice también el resumen de CLAUDE.md que dice "PaymentsService
deferred"). `PaymentMethod = 'cash'|'transfer'|'card'|'prepaid'`.
`recordPayment`/`deliverAndCollect`/`verifyTransfer`/`reversePayment` con lock
`FOR UPDATE`, idempotencia por `(order_id, reference)`.
⚠️ **`payment_method` en `commercial.orders` está efectivamente muerto/hardcodeado
a `'cash'`** en `createDraft` y nunca se actualiza — la verdad real vive en
`commercial.payments.payment_method`, por fila, desacoplada del header de la orden.

**Gaps reales que SÍ bloquean una migración 1:1 limpia:**

1. **Checkout público/anónimo — no hay precedente.** Todos los consumidores
   existentes (`portal`, `vendor`, `commercial-home-delivery`) requieren un
   usuario autenticado de la Suite (JWT+permiso) para llamar estos endpoints.
   El storefront de catalogo-kp es **totalmente anónimo** (tokens HMAC opacos,
   sin login). Migrar exige o bien un entrypoint nuevo anónimo-seguro
   (rate-limited, sin chequeo de permiso, envolviendo `createDraft`+resolución
   de cliente casual), o algún tipo de credencial de servicio para el
   storefront — **hoy no está diseñado**.
2. **Pasarela de pago online — no existe en la Suite.** `commercial.payments`
   soporta `cash|transfer|card|prepaid`, pero `'card'` significa "terminal
   externa ya cobró, solo registramos el hecho" — **no hay integración real
   con Mercado Pago, ni webhook, ni valores de enum `oxxo`/`spei`**. Este es
   el gap más grande: ni catalogo-kp ni la Suite tienen hoy un camino de pago
   online funcionando de punta a punta (el propio `pagos.service.ts` de
   catalogo-kp también dice "pendiente: falta habilitar captura manual" en
   sus propios comentarios).
3. **Campos de checkout que no existen en `commercial.orders`:** aceptación de
   aviso de privacidad + versión + IP, datos fiscales estructurados
   (RFC/razón social/régimen/uso CFDI/CP) para facturación opcional, y una
   fecha límite de confirmación (`confirmar_antes_de`, para holds de tarjeta).
   Necesitan columnas nuevas o una tabla lateral.
4. **`payment_method` en el header de la orden es vestigial** — cualquier
   UI/reporte que dependiera de leerlo de ahí necesita en realidad hacer join
   contra `commercial.payments`.

---

## 3. Matriz de decisiones pendientes — para llevarle a Edgar ANTES de escribir código

Esto no es opcional ni se puede resolver unilateralmente — necesita su input:

| # | Decisión | Opciones | Frente |
|---|---|---|---|
| D1 | ¿Catalogo-kp importa `platform-core` directo, o su frontend llama `auth-mt` como un cliente más? | (a) import directo de guards/services — recomendado; (b) frontend-only, backend solo verifica | Auth |
| D2 | ¿Aceptable que catalogo-kp pase a depender de Railway/internet para operar (hoy es 100% on-prem/LAN)? | Sí / No / mitigar con cache local de permisos | Auth |
| D3 | ¿Cómo se mapea `sucursales: string[]` de catalogo-kp al modelo de la plataforma? | `identity.user_scopes`/`ScopeService` (dimension `warehouse`, mode `listed`) — hay que confirmar que los códigos de sucursal Kepler calzan 1:1 con las claves canónicas de `commercial.warehouses` | Auth |
| D4 | ¿Precio por sucursal se sigue leyendo crudo de `kepler_ods.kdii`, o se fuerza a pasar por la vista canónica (que promedia)? | Hay tensión real: la vista NO resuelve el caso de uso de catalogo-kp tal cual | Datos |
| D5 | ¿`kp.kdik.c5` (usado hoy en `tienda.service.ts`) se reemplaza por `kdil` (como dice el mapeo de Edgar) o se investiga cuál de las dos fuentes de existencia es la correcta? | Resolver la divergencia interna PRIMERO, antes de mapear a `kepler_ods` | Datos |
| D6 | ¿Costo/margen (`c77`/`c87`) se queda crudo o pasa por `analytics.v_supplier_cost_ladder`? | — | Datos |
| D7 | ¿Cómo se resuelve un checkout 100% anónimo contra endpoints que hoy exigen JWT+permiso? | Nuevo entrypoint público rate-limited, o credencial de servicio | Pedidos |
| D8 | ¿Se construye de verdad la integración de Mercado Pago (gateway real) y los métodos `oxxo`/`spei`, o se acepta un checkout más simple (solo `cash`/`transfer` por ahora) para desbloquear el merge? | Impacta directamente el alcance/tiempo | Pedidos |
| D9 | ¿Los campos de checkout que faltan en `commercial.orders` (privacidad, fiscales, `confirmar_antes_de`) se agregan como columnas nuevas (migración) o se cargan en `notes`/`delivery_address` jsonb como parche temporal? | — | Pedidos |

---

## 4. Plan de ataque propuesto (borrador — NO EJECUTADO, ver §0)

> Este plan se escribió antes de la decisión de §0. No se ejecutó ninguna de
> sus fases — en vez de esto se recortó `catalogo-kp` al verificador. Queda
> como referencia por si algún día se retoma auth-mt/`commercial.orders` de
> verdad.

**Orden recomendado — de menor a mayor incertidumbre, cada fase entregable y
verificable por separado, cada una su propio PR chico encadenado (mismo patrón
que #62/#63):**

### Fase INT.0 — Alinear decisiones con Edgar (sin código)
Presentarle la matriz de §3, en particular D7/D8 (el checkout anónimo y el
pago real son los dos huecos que de verdad definen el tamaño del trabajo).
Sin esto, cualquier código escrito corre el riesgo de rehacerse.

### Fase INT.1 — Auth (el más autocontenido de los 3)
1. Registrar `AuthMtModule` en el `AppModule` de `apps/api` si aún no corre en
   ningún ambiente real (verificar primero).
2. En `apps/catalogo-kp`: agregar conexión Knex nueva a `postgres_platform`
   (rol dedicado nuevo, ver D2/D3), importar `JwtAuthGuard`+`RolesGuard`+
   `PermissionsCacheService`+`Permission` de `@megadulces/platform-core`.
3. Agregar al enum `Permission` las claves nuevas para catalogo-kp (según
   granularidad decidida en D-implícita: revisar cuántas necesita
   `admin.controller.ts` hoy — 8+ acciones bajo `rol='admin'`).
4. Reemplazar `auth.module.ts`/`admin.controller.ts`'s guards locales por los
   de plataforma. Decidir needs de `sesionDe()` (auth opcional) — puede
   necesitar un helper propio, no hay equivalente directo.
5. Migrar datos de `admin.usuarios` a `identity.users` (o decidir que quedan
   coexistiendo temporalmente con un mapeo de usuario).
6. Verificar: login real contra `auth-mt`, permiso gateando cada endpoint
   sensible, sucursales scoping (si D3 se resuelve) filtrando de verdad.

### Fase INT.2 — Datos (kepler_ods)
1. Resolver D5 (divergencia `kdil` vs `kdik`) ANTES de tocar nada — es un bug
   preexistente, no algo que la migración deba cargar dos veces.
2. Nuevo módulo/token Knex contra `postgres_platform` (patrón `STORE_KNEX`),
   rol dedicado, reusar `pgRaw()` sin cambios.
3. Remapear query por query (tabla en §2.2) — probar cada una contra
   `kepler_ods` real, comparando resultado byte a byte contra el
   comportamiento actual (mismo patrón de verificación que ya se usó en
   CV.7/CV.16/CV.19).
4. Resolver D4 (precio por sucursal) — probablemente lectura cruda de
   `kepler_ods.kdii` + `v_product_unit_ladder` solo para labels/factores.
5. Decidir sobre `kp.kdie`/`kp.kdif`/`kp.sync_control` (confirmar con Edgar si
   existen equivalentes, o si se puede vivir sin ellos).
6. Decisión de RLS/tenant (D-implícita en §2.2 punto 6) — probablemente
   hardcodear el tenant único, dado que la Suite corre single-tenant hoy.
7. Verificar: paridad de datos contra `.163`/`KP_CONCENTRADA` en un ambiente
   de transición (correr ambos en paralelo, comparar).

### Fase INT.3 — Pedidos (commercial.orders) — el más grande, depende de D7/D8
1. Resolver D7 primero (cómo entra un cliente anónimo) — bloquea todo lo demás.
2. Adaptar `CarritoService` a `createDraft`/`addLine`/`updateLine`/`removeLine`
   (mapeo casi 1:1 conceptual, carrito = orden `draft`).
3. Resolver cliente casual — reusar/extraer `resolveCustomer()` de
   `commercial-home-delivery.service.ts` (ya construido, solo falta hacerlo
   reusable — hoy es privado a un service).
4. `CheckoutService.checkout()` → `confirm()`/`place()`, con los campos
   faltantes (D9) resueltos.
5. Migrar `ColaService`/`AvisosService` (motor de cola genérico, reusable casi
   sin cambios) para que reaccione a eventos de `commercial.orders` en vez de
   `tienda.pedido_eventos`.
6. Pagos: según D8, o construir integración real de Mercado Pago +
   `commercial.payments` (agregar `oxxo`/`spei` al CHECK si aplica), o reducir
   alcance del checkout a métodos ya soportados (`cash`/`transfer`) para
   desbloquear el merge y dejar MP como fase futura.
7. Verificar: checkout de punta a punta con pedido real en
   `commercial.orders` (mismo rigor que CV.13 hizo con `tienda.pedidos`).

### Fase INT.4 — Cierre
Re-review con Edgar sobre PR #62 actualizado (o un PR nuevo si el diff es
grande), actualizar `CLAUDE.md`/tracker/`FASE_CV_CATALOGO_TIENDA_MAYOREO.md`
con el resultado, y solo entonces considerar el merge.

---

## 5. Cómo retomar esto en una sesión nueva

Si estás leyendo esto sin el contexto de la conversación original:

1. **Leer primero §0** — el desenlace real. Este checkpoint documenta una
   integración que **se decidió no hacer**; lo que sí se hizo (recortar
   `catalogo-kp` al verificador) está en
   [`FASE_CV_CATALOGO_TIENDA_MAYOREO.md`](FASE_CV_CATALOGO_TIENDA_MAYOREO.md)
   sección CV.23.
2. Verificar el estado ACTUAL de los PRs (esto puede haber cambiado de nuevo
   desde que se escribió §0): `gh pr view 62 --repo edgarcg-01/MegaDulces_Suite
   --json state,mergeable,reviews,comments` (PR #63 ya está cerrado — no hace
   falta chequearlo salvo curiosidad histórica).
3. Si lo que se busca es retomar auth-mt o `commercial.orders` de verdad (para
   alguno de los 3 repos standalone listados en §0, o para reintegrar alguno a
   la Suite), las secciones 1-5 de este documento (investigación completa,
   matriz de decisiones §3, plan §4) siguen siendo el punto de partida — pero
   **re-verificar todo contra el código real primero**, puede haber cambiado.
4. Todo lo citado (rutas de archivo, columnas, nombres de tabla) fue verificado
   contra el código real el 2026-09-05 — pero el código puede haber cambiado
   desde entonces. Releer el archivo real antes de confiar en un fragmento
   citado aquí si ya pasó tiempo.
