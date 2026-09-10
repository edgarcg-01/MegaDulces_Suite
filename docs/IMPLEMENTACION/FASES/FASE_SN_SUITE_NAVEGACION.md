# Fase SN — Suite: navegación por espacios ("Mi trabajo" en `/projects`)

> **Estado:** 🔨 EN CÓDIGO 2026-09-10 · **ADR-061** · Etapa 2 (*Navegación*) de la especificación de Dirección.
> **Origen:** `Especificacion_Reestructuracion_Suite_Mega_Dulces_v1.0.md` (Dirección, 2026-09-10), §2, §5, §6, §22, §23, §24.
> **Criterio de salida (§24):** *funciones existentes accesibles sin pérdida de permisos*, con redirecciones controladas.

**Decisiones tomadas (aprobadas 2026-09-10, ver §4):** se conserva la URL `/projects`; la landing se llama *Mi trabajo* pero NO estrena la cabecera de Dirección sobre bloques vacíos; los tres espacios sin módulo se declaran y no se pintan; el `trade` va a *Rutas de detalle* con P-14 abierta; `adminHomeGuard` es la única corrección de guard que entra; `scripts/check-authz-tree.js` se borra.

---

## 1. Lo que se pidió, y lo que la spec de verdad pide

Dirección: *"reestructurar la página principal `/projects`"*. La spec lo enmarca (§2): hoy la landing es un **catálogo de 11 tarjetas** al mismo nivel que mezcla áreas, canales, procesos y configuración técnica. Pide un menú por **10 espacios de responsabilidad** (§5.1), y advierte que **no está terminado porque las tarjetas tengan nombres nuevos** (§29).

Lo que esta fase construye es **sólo la Etapa 2**. Las etapas 3+ (indicadores con ficha, vista DG, acuerdos) dependen de P-01..P-13 y acá entran únicamente **declaradas**.

---

## 2. Etapa 0 · Diagnóstico medido (2026-09-10)

### 2.1 Tres listas de proyectos que ya discrepaban

| Lista | Dónde | Decidía | Problema |
|---|---|---|---|
| `AUTHZ_TREE` (12 proyectos → módulos → `view`/`manage`) | `libs/contracts/src/authz/authz-tree.ts` | `/admin/roles`, sugerencias 404/403 | Canónica, pero **la landing no la leía** (L40 decía "icono reusable por la landing" y no estaba cableado) |
| `allProjects: ProjectCard[]` (11 `anyOf` a mano) | `apps/view/.../projects/projects.component.ts` L39-224 | Qué tarjeta veía cada uno | Copia divergente; ya había cobrado **2 bugs**: `[AUTHZ.6]` (3 almacenistas sin tarjeta, mandados a captures) e `[IDG.9.6]` (promotoras con permiso de caducidades sin puerta a Tienda) |
| `currentProject` + `projectLabel` + `*NavGroups` | `apps/view/.../layout/layout.component.ts` L424-451, L271-711 | Sidebar y migaja | Union hardcodeada + `startsWith`; `/telemarketing` ni aparecía (usa `TeleventaShellComponent` propio, **sin vuelta al lanzador**) |

Etiquetas distintas entre listas: `comercial` = "Comercial / Ventas" vs "Ventas"; `pdv` = "Punto de Venta" vs "Tienda"; `compras` = "Compras / Reabastecimiento"; `reparto` = "Reparto / Última Milla".

### 2.2 Hechos verificados en código

- **Landing:** tarjetas `<div (click)>` (sin teclado, sin `routerLink`), `ChangeDetectionStrategy.Eager`, `status` siempre `'Activo'` literal, `roleOnly` muerto, `.css` vacío, **cero specs**. `ngOnInit`: 0 proyectos → `/dashboard/captures` (fallback que el propio comentario `[AUTHZ.6]` documenta como daño); 1 → auto-entra. Gate leyendo el snapshot JWT sin consultar `PermissionsService.estado()` (ternario `sin_cargar|jwt|servidor`, ADR-056).
- **7 referencias a `/projects`:** `app.routes.ts:1267`, `login.component.ts:96`, `layout.component.ts:988` (+html 171-181, menú L888), `forbidden.component.ts:89`, `not-found.component.ts:47,83`, `televenta.guard.ts:33`, `reparto.guard.ts:27`.
- **`nombre` no llega al front:** el JWT no lo trae y `loginMt()` descarta `response.user`. No existe `GET /users/me`; `GET /users/positions|departments` exigen `USUARIOS_VER` → un cajero recibe 403 preguntando por SU puesto.
- **Puesto:** `identity.users.department_code/position_code` + catálogos `identity.positions/departments`. La asignación vino por mapeo `role_name → puesto` (mig `20260820201000`) con NULL a propósito en `jefe_marketing` y `customer_b2b`; ~77 usuarios sin puesto.
- **Guards más estrictos que el árbol** (cada uno es un `gate` con `reason` en el mapa): `/admin` → `redirectTo:'users'` incondicional y `/admin/users` exige `USUARIOS_GESTIONAR` mientras el árbol da `view: USUARIOS_VER`; sidebar Roles pide `ROLES_CONFIGURAR` y la ruta `ROLES_VER`; `colaboradorGuard` manda a captures a quien no tenga `REPORTES_VER_EQUIPO|GLOBAL` en cualquier ruta de `/dashboard`; `reparto.guard.ts:26` exige `DESPACHAR` aunque el árbol tenga módulo `ENTREGAR` a la misma ruta. Módulo `hr-attendance-kiosk` **sin `route`**: la cuenta de kiosco "puede entrar y no tiene a dónde ir" (mig `20260909131000`).
- **Gates existentes:** `test-authz-route-coverage.js` [2] es real (piso >100). **`scripts/check-authz-tree.js` era VACUO**: leía los shims re-export de `apps/view` (una línea), contaba 0 claves y pintaba verde; re-apuntado se pondría rojo por ≥8 permisos compartidos a propósito (`EXISTENCIA_*`, `COMMERCIAL_EXPIRY_*`, `COMPRAS_PEDIDO_VER`×2, `FINANCE_EXPENSES_VER`×3, `FINANCE_AI_CHAT`×2…). `authz-tree.ts` L18 citaba un `authz-tree.spec.ts` **que nunca existió**; `libs/contracts` **no tenía target `test`**.
- **⚠️ El build de producción de `view` estaba ROTO en `main`** desde `f3fe9dfe` (TDA.7): `test-setup.ts` pasó a declarar una clase + `beforeEach` y `tsconfig.app.json` sólo excluía `*.spec.ts` → TS2593. Nadie había corrido `nx build view` después. Lo arreglé excluyendo `src/test-setup.ts` y `src/testing/**` y, al ir a commitear, **la sesión de TDA.7 ya lo había arreglado 11 minutos antes con la misma línea** (`9cd6d107`, + `scrollMargin` en el doble de `IntersectionObserver`) y fusionado `origin/main`. Mi versión quedó idéntica a HEAD: no hay commit mío de ese arreglo. Lección operativa: hay **10 sesiones** de Claude sobre este árbol (`ListAgents`); commitear chico y pronto, stagear sólo rutas propias.
- **Línea base del bundle** (2026-09-10, ya con el arreglo): `Initial total 1.23 MB` (main 1.09 MB / 236.63 kB gz, styles 134.68 kB). Ya excede el budget de aviso (1.00 MB) por 228.91 kB; error en 1.4 MB. `AUTHZ_TREE` hoy sólo entra en chunks lazy (`/admin/roles`, 404/403); llevarlo al layout lo mete al inicial → **se mide después** (§8).
- `tsconfig.base.json` y `apps/view/tsconfig.json` **no fusionan `paths`**: subruta nueva = alias en ambos + shim en `core/constants/` (patrón `[ID.28]`).

---

## 3. Revisión crítica de la especificación (qué NO se implementa tal cual, y por qué)

1. **§23 y §10 se contradicen sobre "Auditoría en Ruta".** §23 lo manda a *Ventas › Rutas de detalle*; §10 pone *Trade Marketing* bajo *Mercadotecnia*. El módulo `trade` tiene contenido de trade marketing (exhibiciones, planogramas, scoring, promotores) **pero sus capturadores son `colaborador` = vendedores de ruta directa** (Edgar 2026-08-20: "todos los colaboradores son de ruta"; `supervisor_ventas` = supervisor RD). **Decisión:** default §23, etiqueta honesta "Auditoría en Ruta" (el nombre "Gestión y ejecución de rutas" se estrena cuando exista la función), y *Mercadotecnia* enlaza sus módulos de configuración (planograma, scoring, catálogos). Queda **P-14** para Dirección; cambiarlo es una línea del mapa.
2. **§6 "Esto ve Dirección General de mi gestión" sobre bloques vacíos.** No hay indicador con ficha (P-06), ni metas, ni acuerdos. La cabecera afirmaría disponibilidad de información que no existe (§6.1 lo define así). **Decisión:** *Mi trabajo* trae lo que HOY es verdad —*Mi contexto* y *Mi operación*— y UNA declaración de lo pendiente. La frase va en Etapa 3 con el primer indicador real.
3. **§5.1 pide 10 espacios; 3 no tienen ni un módulo** (Operación por zonas, RRHH, Sistemas/Servicios/Mantenimiento). Pintarlos = "Próximamente", que §22 veta. **Decisión:** `planned` en el mapa (los conoce el test y la doc), **no se pintan**; una línea al pie los declara.
4. **§5.1 "visibles según el puesto".** El acceso es por `role_name` + permisos; `identity.positions` es eje organizacional y **no otorga permisos** (mig `20260820200000`; `positions.default_scope` rechazado, `03_LOG_REVISIONES`). El puesto se **muestra**, no gatea.
5. **"Puesto vigente" viene en parte de un mapeo por rol.** Se muestra `positions.name` cuando existe y `Sin puesto asignado` cuando es NULL. Nunca se deriva del rol en pantalla.
6. **P-01 dice "organigrama pendiente"; el repo ya ingirió "ORGANIGRAMA 2026"** (43 puestos de 59 etiquetas, `positions.org_labels`). P-01 debería ser "confirmar la versión vigente".
7. **§13 juzga Finanzas por la descripción de la tarjeta**, desactualizada ("egresos desde pólizas") cuando el módulo ya tiene bancos, cobranza, cartera, pagos, tareas, hallazgos y Maat. Lección: **las descripciones a mano mienten con el tiempo** → la línea secundaria de cada entrada se **deriva** de los módulos accesibles del árbol, por usuario.
8. **§5.2 Mayoreo › Atención presencial no tiene módulo propio.** Cartera/Clientes/Pedidos son back-office multicanal. Mayoreo agrupa sólo Telemarketing y lo declara.
9. **E-commerce (P-05):** `catalogo-kp` quedó recortado al verificador de mostrador (Pisos de venta); Portal B2B es otra app (`kind:'access'`) y no entra en `/projects` (decisión previa). WhatsApp (`route:''`) no es navegable. "Por clasificar" existe en el mapa y **no dibuja nada**.
10. **Derivar la visibilidad del árbol EXPANDE puertas — y tres rebotarían.** `view ∪ manage` es más completo que los `anyOf` a mano (por eso había gente con permiso en backend sin puerta en UI), pero en `admin`, `trade` y `reparto` el guard es más estricto que el árbol. **Decisión:** derivado por default + `gate` explícito **sólo** donde el guard es más estricto, con `reason`; paridad exige que nadie pierda una puerta; las puertas que se ABREN se **miden** contra `role_permissions` (§7) y se listan acá antes de mergear.

---

## 4. Diseño

### 4.1 Mapa de la suite — `libs/contracts/src/authz/suite-map.ts` (ADR-061)

Capa de PRESENTACIÓN sobre `AUTHZ_TREE`, igual que el árbol lo es sobre los permisos. Ningún guard la lee. `SUITE_SPACES` = los 10 espacios de §5.1 en su orden; cada entrada referencia un proyecto o un módulo del árbol y cita su fuente (`confirmado | propuesta | pendiente`).

Reglas: visibilidad = `isAdmin ∨ alguna clave de entryPermissions(e)`, donde `entryPermissions` = `gate.anyOf ?? view ∪ manage` de los módulos **con `route`**; `gate.alsoAnyOf` agrega una condición AND (shell con guard propio); `hideForRoles` gana incluso sobre god-mode (recorte de UX, no de seguridad); `planned` ⇒ 0 entradas y nunca se renderiza; `crossLink` = también vive en su casa primaria; **cada proyecto de `view` tiene exactamente una casa primaria** (espacio o `SUITE_UNCLASSIFIED`).

| # | Espacio (status) | Entradas → árbol | Cita |
|---|---|---|---|
| 1 | Mi trabajo (`landing`) | — es la pantalla | §6 · Confirmado |
| 2 | Dirección General (`proposed`, P-06) | `comercial/analytics` "Centro de Control (vista parcial: Comercial)" cross | §7 · Propuesta |
| 3 | Comercial (`active`) | `comercial` [Ventas] "Ventas (back-office)" `hideForRoles:['vendedor']` · `pdv` [Ventas › Pisos de venta] · `televenta` [Ventas › Mayoreo › Atención telefónica / Telemarketing] · `trade` [Ventas › Rutas de detalle] "Auditoría en Ruta" **gate = anyOf legacy** · `compras` [Compras] · cross [Mercadotecnia]: `comercial/promotions`, `comercial/erp-promos`, `trade/planograma`, `trade/scoring`, `trade/catalogs` (los de trade con `alsoAnyOf` = reportes de equipo, por `colaboradorGuard`) | §23 Confirmado · Mercadotecnia §10 Propuesta · trade **P-14** |
| 4 | Operación por zonas (`planned`) | ninguna | §11 · Pendiente |
| 5 | Almacenes y Logística (`active`) | `almacen` [Almacenes] · `logistica` [Transporte y embarques] · `reparto` [Entregas] **gate `[REPARTO_DESPACHAR]`** | §23 · Confirmado |
| 6 | Administración y Finanzas (`active`) | `finanzas` · `contabilidad` | §13/§23 · Confirmado |
| 7 | Auditoría, Prevención y Control (`proposed`, P-03) | cross: `almacen/prevention`, `almacen/cuadre`, `finanzas/hallazgos`, `compras/compras-hallazgos`, `trade/supervisor-ai` (alsoAnyOf) | §5.1 + §14 · Propuesta |
| 8 | Recursos Humanos (`planned`) | ninguna | §15 · Pendiente |
| 9 | Sistemas, Servicios y Mantenimiento (`planned`) | ninguna | §16 · Pendiente (P-10) |
| 10 | Configuración de la suite (`active`) | `admin` **gate `[USUARIOS_GESTIONAR, ROLES_VER, ROLES_CONFIGURAR]`** | §22/§23 · Confirmado |
| — | Por clasificar | `whatsapp` (route `''` → jamás enlace) | §19.2, P-05 · Pendiente |

Helpers: `visibleSuiteMap(perms, isAdmin, role)` → `{ spaces, declared }` · `primaryDestinations()` (decide la auto-entrada) · `resolveProjectForUrl()` / `resolveSpaceForUrl()` por **segmento** (no prefijo de texto; `route:''` nunca casa) · `validateSuiteMap()` (lo corre el spec, con mapas rotos a propósito).

### 4.2 Landing "Mi trabajo" — `apps/view/src/app/modules/mi-trabajo/`

Lista **seccionada de una columna** (no master-detail: las entradas son enlaces, un panel de detalle quedaría vacío; no card grid: DESIGN L398/L486/L521). Answer-first: (1) **Mi contexto** — 4 celdas hairline: persona, puesto (`Sin puesto asignado` si NULL), alcance (`all`/`own|listed`/`none`/`resolvable:false` → "sin determinar"), periodo; (2) **una** declaración de lo pendiente (P-06, P-01); (3) **Mi operación** — `<section>` por espacio visible, fila = `<a routerLink>` 48px con icono · etiqueta · **línea secundaria derivada** (módulos abribles por ESA persona) · grupo · flecha. Espacios `proposed` con badge "Propuesta · P-xx". Pie: los `planned`, declarados. `estado()==='sin_cargar'` → skeleton, nunca el vacío. 0 entradas → estado declarado + salir (sin redirect a captures). N=1 destinos primarios → auto-entra salvo `history.state.stay`.

### 4.3 Backend — `GET /users/me/context` (self-scoped, sin `@RequirePermissions`, antes de `:id`)

`{ user_id, username, nombre, role_name, kind, warehouse_code, zona, department:{code,name}|null, position:{code,name}|null }`. Contrato en `libs/contracts/src/http/identity-me.contract.ts`.

### 4.4 Layout

`currentProject`/`projectLabel` derivados del mapa (default `trademk` preservado → `isRestricted()` intacto); migaja Espacio › Proyecto › Página; "Administración" → "Configuración de la suite" (L448/L819; **L832 no**: es la sub-sección de catálogos de Trade); "Proyectos" → "Mi trabajo" con `state:{stay:true}`; link "Mi trabajo" en `TeleventaShellComponent`; `adminHomeGuard` (patrón `landingRedirectGuard` ×4).

---

## 5. Gates (cada uno con prueba negativa ejercida)

| Gate | Qué asegura | Negativa |
|---|---|---|
| `suite-map.spec.ts` (libs/contracts, jest **nuevo**) | 10 espacios en orden §5.1; planned sin entradas; cada proyecto con UNA casa; refs existen; `gate` con `reason` y claves del árbol/LEGACY; URL por segmento; kiosco no ve nada; almacenista sólo Almacenes; vendedor sin back-office ni siendo admin; gates de Reparto/Configuración/Trade | proyecto falso, módulo falso, doble casa, sin casa, planned con entradas, activo vacío, gate sin motivo / clave inexistente, orden roto, árbol sin whatsapp |
| `suite-map.parity.spec.ts` | los 11 `anyOf` legacy **congelados**: cada clave sigue abriendo su destino Y una persona con UNA sola clave lo ve | quitar `USUARIOS_ASIGNAR_RUTA` al gate de Trade → rojo; `alsoAnyOf` en entrada de proyecto → 11 puertas cerradas detectadas |
| `database/scripts/suite-map-visibility-report.js` | por rol de prod (read-only): tarjetas legacy vs entradas; **nunca menos**; las ganadas se listan para revisión | exit 1 ante una puerta perdida |
| `test-newdb-me-context.js` | 200 con `position` objeto o **null declarado**; 401 sin token; `me/context` declarado antes de `:id` | mover la ruta después de `:id` → rojo |
| `mi-trabajo.component.spec.ts` / `mi-trabajo-route.spec.ts` | comportamiento por persona + gate estático de `app.routes.ts` | ver SN.3 |

---

## 6. Plan de commits

| Paso | Contenido | Estado |
|---|---|---|
| *(fix del build)* | `tsconfig.app.json` excluye el arnés → build de `view` vuelve a compilar | ✅ **superado**: lo hizo la sesión TDA.7 en `9cd6d107` con la misma línea; mi copia quedó idéntica a HEAD |
| `docs([SN.0])` | esta FASE + ADR-061 + tracker | ✅ 2026-09-10 |
| `feat([SN.1])` | `suite-map.ts` + jest en `libs/contracts` + aliases + shim + specs + `authz-tree.ts` L18/L83 + reporte de visibilidad | ✅ 2026-09-10 (35/35; reporte prod 0 perdidas) |
| `feat([SN.2])` | `identity-me.contract.ts` + `contextFor` + `GET /users/me/context` + smoke | ⬜ |
| `feat([SN.3])` | `mi-trabajo.component.*` + `me-context.service.ts` + rutas + specs; borrar `modules/projects/` | ⬜ |
| `feat([SN.4])` | layout + **home guards** (`admin`, `finanzas`, `contabilidad` nuevos; `comercial` y `logistica` completados — ver §7) + spec "la puerta que la landing abre no rebota" + link en Telemarketing | ⬜ |
| `chore([SN.5])` | borrar `scripts/check-authz-tree.js`; corregir `FASE_AZ` L161, `GOTCHAS` §4, `CLAUDE_ONBOARDING` L48 | ⬜ |
| `docs([SN.6])` | tracker ✅, log, CHANGELOG, fila en `CLAUDE.md`, INDEX | ⬜ |

---

## 7. Medición de visibilidad por rol (prod, read-only, 2026-09-10)

`node database/scripts/suite-map-visibility-report.js` contra `DATABASE_URL_NEW`: **36 roles · 0 con puertas PERDIDAS · 17 con puertas ganadas (83 usuarios activos)**. Exit 0.

Ganadas por destino (rol × usuarios activos):

| Destino ganado | Roles | Por qué (clave que el `anyOf` viejo no listaba) |
|---|---|---|
| `finanzas` | cajero ×32 · promotor_ruta ×19 · encargado_tienda ×9 · auxiliar_tienda ×4 · auxiliar_compras ×4 · jefe_marketing ×2 · compras_operaciones · prevencion · supervisor_ventas · analisis_ventas · captura_gastos | `FINANCE_EXPENSES_CAPTURAR` (captura de gasto con comprobante, GX.8) y otras claves `FINANCE_*`: la tarjeta sólo pedía `FINANCE_EXPENSES_VER` |
| `compras` | almacenista ×2 · prevencion · prevencion_auxiliar · supervisor | `EXISTENCIA_VER` (pantalla compartida Almacén/Compras) |
| `almacenes` | auxiliar_compras ×4 · compras_operaciones · tesoreria | `EXISTENCIA_VER` |
| `configuracion-suite` | direccion · encargado_tienda ×9 | `ROLES_VER` sin `USUARIOS_GESTIONAR` |
| `ventas-backoffice` | contabilidad ×2 | una clave `COMMERCIAL_*` fuera del `anyOf` viejo |

Cross-links (Dirección General, Mercadotecnia, Auditoría) aparecen para 27 roles: cada uno lleva a una ruta con `permissionGuard` propio de la clave que la abre → no rebotan.

**Lectura crítica: "ganada" no es "abre".** Una puerta nueva vale sólo si el destino no rebota, y hoy:
- `/finanzas` → `redirectTo: 'egresos'` **fijo** (exige `FINANCE_EXPENSES_VER`) → los 32 cajeros y 19 promotores con sólo `FINANCE_EXPENSES_CAPTURAR` aterrizarían en `/sin-acceso`. Igual `/contabilidad` → `listas-sat` fijo, y `/admin` → `users` fijo (`ROLES_VER` solo rebota).
- `comercialHomeGuard` no lista `COMMISSIONS/PROMOTIONS/PRODUCTS/CARTERA/THOT/INTELLIGENCE/ROUTE_CONTROL/CARGA/SELLOUT_ANALYSIS`; `logisticaHomeGuard` no lista `GUIDES/ROUTE_EXPENSES/CARTAPORTE/CONFIG`. Quien entre por una de esas cae en `denied()` aunque su pantalla exista.

**Consecuencia para SN.4:** cada proyecto que la landing abre necesita un landing dinámico que cubra TODAS las claves con las que la landing lo abre: `finanzasHomeGuard`, `contabilidadHomeGuard`, `adminHomeGuard` nuevos (patrón `landingRedirectGuard`), `comercialHomeGuard` y `logisticaHomeGuard` completados, y un spec que lo haga invariante: `entryPermissions(entrada) ⊆ claves de los candidatos del guard`. Sin eso, la expansión sería el mismo bug `[AUTHZ.6]` con otro nombre.

---

## 8. Medición de bundle

| Momento | Initial total | main | Nota |
|---|---|---|---|
| Base (main + fix arnés) | **1.23 MB** | 1.09 MB / 236.63 kB gz | 228.91 kB sobre el aviso de 1.00 MB; error en 1.4 MB |
| Después de SN.3/SN.4 | _(pendiente)_ | | Plan B si excede: índice compacto de rutas para el layout en vez del árbol completo |

---

## 9. Deuda declarada (con nombre) y fuera de alcance

- `*NavGroups`/`*NavItems` del layout siguen a mano (3ª lista); unificarlos con el árbol es fase aparte.
- Choques guard vs árbol que el `gate` tapa (cuando se resuelvan, se quita su `gate` y la paridad sigue verde): `USUARIOS_VER` y `USUARIOS_PASSWORDS` no abren ninguna ruta · sidebar Roles pide `CONFIGURAR`, la ruta `VER` · `televenta` `VER`-only rebota en `televenta.guard.ts:32` · `reparto-entrega` (`ENTREGAR`) apunta a `/reparto` que exige `DESPACHAR` · `colaboradorGuard` ignora `RUTAS_VER`/`SUPERVISOR_AI_VER`/`TRADE_ROUTE_PLAN_VER`.
- Renombre `/projects` → `/mi-trabajo` y la cabecera "Esto ve Dirección General de mi gestión": Etapa 3, con el primer indicador con ficha.
- Espacios `planned` y **P-14** (dónde vive `trade`): decisiones de Dirección; el mapa las hace de una línea.
- Módulos del árbol cuya ruta representativa exige OTRA clave (rebotan aunque el permiso exista): `logistica/cartaporte` → `/logistica/shipments` (pide `SHIPMENTS_VER`); `almacen/receiving-auditor` view `RECIBIR` → su ruta real es `/almacen/inventory/recepcion-sesiones` (la del árbol dice `/recepcion`). Se declaran; alinear el árbol con las rutas es de Fase AZ, no de ésta.
- No se tocan guards de backend, permisos, roles ni migraciones de DB.

---

## 10. Verificación

- `npx nx test contracts` → **2 suites / 35 pruebas** ✅ (2026-09-10).
- `node database/tests/test-authz-route-coverage.js` · `node database/run-all-tests.js` · `npx nx test view` · `npx nx build view` (sin pipe; anotar en §8).
- `GET /users/me/context` vivo con `curl` (build verde ≠ endpoint vivo).
- Browser (light + dark + 375px) sobre los dev servers de Edgar: superadmin → 4 espacios activos + 2 propuestos con badge + línea de planned; `almacenista` → aterriza directo en `/almacen`; "Mi trabajo" desde el sidebar → se queda; `/admin/users` → migajas "Configuración de la suite / Usuarios"; `/dashboard/captures` → "Comercial / Auditoría en Ruta / Captura Diaria"; Tab recorre filas con ring; `/telemarketing` tiene "Mi trabajo"; usuario sólo `ROLES_VER` entra por `/admin` y aterriza en `/admin/roles`.
