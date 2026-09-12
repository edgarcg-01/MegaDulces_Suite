# Fase SN — Suite: navegación por espacios ("Mi trabajo" en `/projects`)

> **Estado:** 🧪 SN.0–SN.6 EN CÓDIGO Y PROBADO 2026-09-10 · **ADR-061** · Etapa 2 (*Navegación*) de la especificación de Dirección. **Pendiente:** validación visual en browser (dev servers de Edgar), reinicio de la API para la parte viva del smoke de `me/context`, redeploy api+view.
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

> ⚠️ **Corregido el 2026-09-11 (SN.8).** La primera versión tiró la tarjeta y puso filas de texto. Edgar lo rechazó: *"hiciste una interfaz compleja y poco interactiva, los módulos son poco profesionales y el trabajo no está delegado o asignado a una persona. El diseño de los módulos ya era correcto, sólo era cambiar los nombres y las posiciones, y darle un espacio a «Mi trabajo»"*. Lo que sigue describe la versión corregida; la de filas queda documentada sólo como lo que NO había que hacer.

**La tarjeta vuelve.** Es el organismo de `modules/projects/` desde siempre (chip de icono 40 px, título, línea de contenido, "Acceder →" con flecha que avanza en hover) y lo que había que cambiar eran los **nombres** y las **posiciones**: las 11 tarjetas sueltas pasan a agruparse por los espacios de §5.1, con `<h2>` por espacio. Tres diferencias con la tarjeta vieja, cada una con su motivo:

1. es `<a routerLink>` y no `<div (click)>` → teclado, ctrl+clic, botón medio;
2. la insignia deja de decir **"Activo"** (era literal siempre — §22 de la spec lo veta) y dice dónde vive la entrada (`Ventas › Mayoreo`) o `Propuesta · P-xx`;
3. la línea de contenido se **deriva** de los módulos que ESA persona puede abrir (máx. 4 + `+N`), en vez de una descripción a mano — §13 de la spec juzgó a Finanzas por una que llevaba meses vencida.

**Nota sobre DESIGN.md:** la regla "sin card grid" gobierna las superficies de **datos** de Operations (tabla densa + master-detail). Esta pantalla es el **lanzador**: no tiene registros que leer. Decisión de Edgar, 2026-09-11.

**"Mi trabajo" es el primer espacio**, no una ficha de contexto: trae los pendientes de `GET /users/me/work` (§4.5) en tarjetas con el número grande, partidos en **A tu nombre** / **En tus bandejas**, más una tira compacta de contexto (puesto · área · alcance · periodo) y el botón *Actualizar*. El nombre de la persona va en la cabecera. Una bandeja en 0 **no se pinta**; sin pendientes se dice con una línea; lo que no se pudo contar se **declara**.

Lo demás se conserva de SN.3: `estado()==='sin_cargar'` → skeleton, nunca el vacío; 0 entradas → estado declarado + salir (sin redirect a captures); N=1 destinos primarios → auto-entra salvo `history.state.stay`; `planned` declarados al pie.

#### 4.2.1 SN.9 — todo en una pantalla, con buscador (2026-09-11)

Pedido de Edgar: *"concentrar toda la información, módulos, mi trabajo, una barra de búsqueda súper inteligente, mis pendientes, en una pantalla que no necesite scroll"*. Opciones presentadas y elegidas: **rejilla densa con buscador arriba**, búsqueda de **módulos + pendientes en el cliente**, objetivo **1920×1080**.

**Cuánto tiene que caber**, medido: **22 entradas en 6 espacios** para el superadmin (Comercial 10 · Auditoría 5 · Almacenes 3 · Admin y Finanzas 2 · Dirección 1 · Configuración 1). Un usuario normal ve 1–5, así que el problema de espacio sólo existe arriba.

**Lo que se sacrifica, a conciencia:** la tarjeta pierde la descripción larga y el pie "Acceder →"; queda chip de icono + nombre + una línea de módulos truncada. La rejilla es de `12.5rem` mínimo, los espacios se acomodan en columnas de `26rem`. El contexto baja a una tira en la cabecera y los pendientes pasan de tarjeta a **píldora** (número + etiqueta), en una sola fila.

**"Sin scroll" no se cumple cortando contenido.** La página es `100dvh` en cinco filas de grid y sólo la de espacios es elástica (`minmax(0,1fr)` + `overflow:auto`): en 1920×1080 no aparece barra, y si no cupiera —pantalla chica, alguien con más entradas de las previstas— scrollea **esa zona**, nunca se esconde una puerta. Bajo 900 px de ancho o 620 px de alto la pantalla vuelve a ser documento normal.

**El buscador es de cliente, y eso es una decisión, no una limitación:** lo que busca —módulos y bandejas— ya está en memoria (el mapa se resuelve en el navegador, los pendientes vienen de una sola llamada). Reimplementa en chico lo que `applySmartSearch` hace en Postgres: **sin acentos** (`NFD` + quitar diacríticos, equivalente a `public.f_unaccent`) y **multi-token AND en cualquier orden**. Lo que **no** hace es tolerar typos — eso necesita `pg_trgm` y por lo tanto el servidor. El haystack de cada entrada incluye **los nombres de sus módulos**, así que "bancos" encuentra Finanzas. `Ctrl/⌘+K` y `/` enfocan, `Enter` abre el primer resultado, `Esc` limpia. Una búsqueda sin coincidencias **se dice**; no deja la pantalla en blanco.

**Fuera de alcance, declarado:** buscar entidades de negocio (clientes, folios, productos, pólizas) es otra capa — un endpoint nuevo que reúse `applySmartSearch`, con la decisión pendiente de qué dominios entran y respetando el permiso de cada uno. Y sobre eso, lenguaje natural (ya hay precedente con Maat/Thot/Horus). Ninguna de las dos entra en Etapa 2.

#### 4.2.2 SN.10 — la densidad se comió al contenido (2026-09-11)

Edgar pidió observaciones sobre la captura de SN.9. El costo real de apretar fue **mayor que el que declaré**: anuncié que se perdía "la descripción larga", y lo que se perdió fue el **nombre** de tres módulos y la **utilidad** de la línea secundaria en las 22 tarjetas. Nueve defectos, cada uno con su causa:

| # | Lo que se veía | Causa | Arreglo |
|---|---|---|---|
| 1 | «Atajo · vive en su espacio de ori…» **×12**, truncado, con el mismo peso que la información real | `entryModules()` de una entrada `kind:'module'` devuelve `[]` y el template rellenó el hueco con jerga | la segunda línea de un módulo enlazado dice **«de {Proyecto}»** (`entryOrigin()`) |
| 2 | **Dos «Hallazgos» idénticos y contiguos** en Auditoría (Finanzas y Compras) | `entryLabel()` no dice de qué proyecto sale el módulo | el origen los distingue: «de Finanzas» / «de Compras» |
| 3 | Títulos cortados: «Centro de Control (vista p…», «Compras / Reabastecimie…» | `white-space: nowrap` en `12.5rem` | dos líneas (`line-clamp: 2`) y tarjeta de `14rem` |
| 4 | **Iconos que decoraban en vez de distinguir**: el mismo carrito en 4 tarjetas, el mismo gráfico en 5 | `entryIcon()` devolvía **siempre** el del PROYECTO | `SuiteEntry.icon?` opcional; el icono es presentación y por eso vive en el mapa, **no** en `AuthzModule` (ADR-061) |
| 5 | «Telemarketing / Telemarketing» | proyecto con un único módulo homónimo | si la segunda línea repite el título, se omite |
| 6 | **Medio tablero vacío** bajo Dirección General (1 tarjeta) mientras Comercial (10) iba apretado | cada espacio era una **celda** de `grid`: reservaba una fila de la altura del espacio más alto | **mampostería** (`columns: 3` + `break-inside: avoid`); orden §5.1 intacto |
| 7 | La 2ª fila de pendientes (99 · 76 · 19 · 2) **sin la etiqueta «En tus bandejas»** → se leía como trabajo personal | píldoras y etiquetas en un solo `flex-wrap` | cada grupo es su propio bloque y envuelve dentro de sí |
| 8 | Casi toda línea secundaria cortada a media palabra | 3 módulos no caben en `12.5rem` | el ancho recuperado por la mampostería + `14rem` |
| 9 | «PUESTO Sistemas · ÁREA Sistemas» | el contexto se pintaba completo aunque coincidieran | si puesto == área, se muestra una vez |

**Los defectos 2 y 7 no eran cosméticos:** hacían que la pantalla **mintiera** sobre a quién le toca el trabajo y sobre qué bandeja se está abriendo.

**Lección para la fase:** cuando la información de una tarjeta se **deriva**, achicar la tarjeta no sólo la aprieta — puede dejar a la derivación sin nada que decir, y entonces el hueco se llena con relleno. La densidad se elige mirando **qué queda legible**, no cuántas tarjetas entran.

⚠️ **Incidente de entorno, ajeno:** a mitad de SN.10 `node_modules` apareció sin los scopes `@angular`, `@angular-devkit` y `@babel` completos (1398 paquetes presentes, esos tres ausentes desde ~1 h antes, sin `.staging` ni proceso npm vivo). Ni el build ni jest podían correr. La lógica se verificó igual **sin jest**, con un script ts-node contra el mapa real (8/8). Repuesto con `npm install` autorizado por Edgar; `package-lock.json` quedó **sin cambios**.

#### 4.2.3 SN.11 — la pantalla dejó de ser el menú (2026-09-11)

Edgar rechazó también SN.10: *"el diseño es horrible. hay que hacer nuevamente la interfaz. muéstrame opciones en artefactos de diseño profesionales. para esto primero realiza una investigación de ejemplos buenos, como Humand"*.

**El diagnóstico que faltaba: SN.3 y SN.9 eran la MISMA apuesta.** Una puso filas, la otra tarjetas, pero las dos hacían que **la pantalla fuera el menú**: 22 puertas ocupando el lienzo y el trabajo exprimido en una tira. Por eso cada ronda de "que quepa" costaba contenido y ningún retoque de la tarjeta iba a alcanzar. La investigación lo confirma — los productos que resuelven este problema invierten la jerarquía:

| Referencia | Qué hace en su *home* | Qué se tomó |
|---|---|---|
| **Humand** (el ejemplo que pidió Edgar) | Identidad de la persona arriba; el home es contenido, la navegación vive en un riel | Cabecera de identidad; el home deja de ser el menú |
| **SAP Fiori «My Home»** | Canon de suite empresarial, y llama *Spaces* a lo mismo que acá son espacios. Orden fijo **To-Dos → Pages → Apps → Insights** | El trabajo va **antes** que las puertas |
| **Asana «My Tasks»** · **Height** | El home es personal y accionable; lo organizacional va segundo | Bandejas ordenadas por lo que hay que hacer |
| **Linear** | Densidad, hairlines, mono tabular, cero color decorativo, ⌘K | Ya es lo que manda `DESIGN.md` |

**Se presentaron tres variantes** en un artefacto con maquetas a escala 1920×1080, con los tokens de `libs/design-tokens/tokens.css` y los datos reales (22 entradas con grupo y origen, seis conteos de bandeja): **A · Consola** (cero adorno, cumple `DESIGN.md` completo), **B · Híbrida**, **C · Portal cálido** (rompe «decoración nula» y el antipatrón de íconos en círculos de color → habría exigido excepción escrita). **Edgar eligió B.** Antes eligió, sobre preguntas puntuales: dos columnas mitad y mitad · el trabajo fijo y las puertas rodando.

**Lo que cambia:**

| | Antes (SN.9/SN.10) | Ahora (SN.11) |
|---|---|---|
| Estructura | 5 filas apiladas; sólo la de espacios elástica | Cabecera + **2 columnas** + pie; la izquierda fija, la derecha rueda |
| Trabajo | Tira de píldoras bajo el buscador | **Columna propia**, filas de 48 px con el número en mono tabular y riel de pertenencia |
| Identidad | Título "Mi trabajo" + nombre a la derecha | Inicial + nombre + contexto en una línea (la etiqueta queda para el lector de pantalla) |
| Tarjeta | Chip + título + 1 línea | Chip + **grupo** + título + línea de módulos (3 → **4** módulos nombrados) |
| Mampostería | `columns: 3` (parche al desbalance 10/5/3/2/1/1) | Se retira: con dos columnas el desbalance desaparece |
| Cifras | `1865` | `1,865` con separador |

**Se pinta lo que ya llegaba y se tiraba:** el `groupLabel` (se calculaba desde SN.6 y nunca se mostró), el `motivo` de cada bandeja no medida, y `medido_at`. Este último **como hora absoluta** ("contado a las 12:04"), no como "hace N minutos": el relativo se calcula restando el reloj del navegador y la Fase VP midió 21 píldoras de la app diciéndolo sin medición detrás (ADR-056). Si `medido_at` no vino, se declara. **Sigue sin pintarse `MePendiente.icono`** — en la variante elegida el número manda y un glifo a su izquierda rompería la alineación de las cifras; queda declarado como dato disponible no usado, no olvidado.

**El bloque «A tu nombre» ya no desaparece cuando está vacío.** Su vacío *es* el hecho medido —las tres tablas de asignación nominal en cero filas— y esconderlo haría creer que sí hay reparto. Se declara con su P-06.

**Corrección tras ver la pantalla corriendo (mismo día).** Edgar mandó la captura del dev server y se midió en vivo a 1920×1080. Tres defectos, y el peor fue de esta misma entrega:

| Qué | Medido | Arreglo |
|---|---|---|
| **9 de 21 segundas líneas cortadas a media palabra**, perdiendo el `+N` | La tarjeta queda en su mínimo de **249 px** y para que entrara la línea de Finanzas necesitaría **681**. Bajar de 4 módulos a 3 **no movía la aguja**: seguían las mismas 9 | La línea **envuelve a dos renglones** (`line-clamp: 2`) en vez de `nowrap`. **9 → 0**; quedan 3 que pedirían un tercer renglón y se cortan al final del segundo, no en la primera palabra |
| Los títulos de la 1ª fila de Comercial **desalineados 14 px** | "Ventas" no tiene grupo y sus cuatro vecinas sí | El renglón del grupo se **reserva siempre**, vaya vacío o no. Filas desalineadas **1 → 0** |
| **492 px vacíos** al pie de la columna de trabajo (de 938) | El contenido termina a los 445 | Las dos declaraciones del pie se mudan **cada una a la columna que declara** (el reparto nominal al trabajo, los espacios sin funciones a los espacios) y la columna de trabajo baja de 34 a **30 rem**. El vacío no se rellena con nada inventado: es real y se llena solo cuando la persona tiene más bandejas |

**Por qué la maqueta no lo detectó, que es la lección:** dije "datos reales" y en la segunda línea usé versiones que yo mismo había acortado (`Sell-Out` por `Sell-Out por empresa`). Medí *0 cortados* sobre un texto que no era el de producción — **la maqueta se autocumplió**. Y encima subí `MAX_MODULOS_VISIBLES` de 3 a 4 *después* de medir, con el argumento de que la columna había ganado ancho; la medición en vivo lo desmintió y volvió a 3. Una maqueta sólo vale si el texto que lleva es exactamente el que va a llevar la pantalla.

⚠️ **Incidente de entorno, por segunda vez el mismo día:** a `node_modules` le faltan **exactamente** los tres scopes de SN.10 — `@angular`, `@angular-devkit` y `@babel` — con los otros 1398 paquetes presentes, sin `.staging`, sin proceso de npm vivo y con `package-lock.json` intacto. Ni el build ni jest pueden correr. Que se repita el mismo recorte el mismo día deja de ser casualidad y merece causa raíz (candidatos a descartar: antivirus en cuarentena, un `npm prune`/`dedupe` de otra de las ~10 sesiones que comparten el repo). Mientras tanto se verificó de forma estática (70/70: selectores del spec presentes, miembros del componente declarados, cero clases huérfanas, cero restos de la versión anterior, cero tokens inexistentes, breakpoints en `rem`).

#### 4.2.4 SN.12 — reestructuración: color, delimitante, prioridad y registro de uso (2026-09-11)

Seis observaciones de Edgar sobre la pantalla ya corriendo. Tres se resolvieron con evidencia que **cambió el pedido**:

| Pedido | Lo que se midió | Qué se hizo |
|---|---|---|
| «un color a cada módulo según se haga hover» | `DESIGN.md` prohíbe decorar con color y veta el «ícono en círculo de color» — pero lo que veta es el ornamento **en reposo** | `--tono` por **entrada** (no por espacio), tomado de `--chart-*`/`--avatar-*` (la excepción declarada: el color codifica dato) y visible **sólo al señalar**. Medido: 22 tarjetas, 0 sin tono, **0 repeticiones dentro de un mismo espacio**. Sin morado a propósito: `--avatar-4` queda fuera porque `DESIGN.md` lo veta como identidad de IA, y la entrada que más lo pediría (Horus) es justo la que no debe llevarlo. ⚠️ `--chart-2` y `--avatar-2` son **el mismo hex** (`#185FA5`): son 15 tokens pero 14 colores |
| «no existe un delimitante entre Tu trabajo y Tus espacios» | Cierto: sólo las separaba un `gap` de 32 px | Hairline vertical + `padding-left`; apiladas en pantalla chica pasa a ser horizontal |
| «no hay prioridad en la bandeja» | Las 8 bandejas hacían `contarFilas()` y **devolvían un número y nada más**. El orden era por **volumen**, que no es prioridad | Cada bandeja reporta también `mas_viejo_at` (`count(*)` + `min(created_at)` en **una** pasada) y el orden pasa a ser **por antigüedad**. Verificadas las 6 tablas: todas tienen `created_at`. La que no pueda fecharse **no se asume reciente**: cae al final y se dice «sin fechar» (ADR-056) |
| «módulos que no son de mucho valor, como Scoring o Planogramas» | No es que valgan poco: **son pantallas de configuración**. Rutas `/dashboard/admin/*`, y `planograma` y `catalogs` declaran **`view: []`** — ni siquiera existe permiso de lectura, sólo `manage` | Las tres se mudan a **Configuración de la suite**. Nadie pierde acceso —cambian de lugar, no de puerta (§5.1 «ocultar ≠ autorizar»)—: Comercial **10 → 7**, Configuración **1 → 4**, total **22 sin cambio** |
| «registro de qué clickea cada usuario» | **Ya existía**: `commercial.portal_telemetry_events` + `CommercialTelemetryService` (junio 2026), cableado sólo al Portal B2B | Se **generaliza** en vez de inventar tabla: `POST /telemetry/suite`, **autenticado** (adentro siempre hay sesión, así que el `user_id` es el real y no un decode best-effort sin verificar firma). `UsoService` registra qué puerta y qué bandeja abre cada quien. **No** se registra lo que se escribe en el buscador |
| — | La migración original dejó escrito *«crece rápido. Follow-up: borrar > 90 días. No se implementa aquí»* y nunca se implementó | Se cierra: `@Cron` diario con `timeZone` explícito que purga en lotes de 5,000 y **declara** en el log lo que borró |

**La lección de fondo:** tres de los seis puntos no necesitaban diseño sino medición. «Scoring no vale» era en realidad «Scoring es un ajuste sentado en una silla de operación», «no hay prioridad» era «el backend nunca mandó con qué priorizar», y «quiero registrar clics» era «ya está construido y sirve a un solo dominio» — el caso exacto que ADR-056 llama primitivo sin generalizar.

**Pendiente:** el `mas_viejo_at` se ve como «sin fechar» hasta que se reinicie la API (el front ya lo pide, el backend ya lo manda, el proceso vivo todavía no). Y el registro de uso necesita historia antes de poder ordenar la pantalla por lo que cada quien usa — esa parte es SN.13.

#### 4.2.5 SN.13 — «Tu trabajo» no tenía presencia, y se pudo medir por qué (2026-09-11)

Edgar: *"hay que darle más vida a Tu trabajo, casi no tiene presencia"*. No era gusto: la asimetría se midió.

| | Tu trabajo | Tus espacios |
|---|---|---|
| Elementos con superficie propia | **0** | 30 |
| Área de la columna con superficie | **0 %** | 36.1 % |
| Cifra más grande | **18 px** (5 más que el título de una tarjeta) | — |
| Vacío al pie | 464 px de 975 (48 %) | — |

**La causa, en una línea:** la columna protagonista era *texto sobre el fondo*, y la otra era una rejilla de *objetos*. El ojo va a los objetos. Además la pantalla no tenía **ninguna** headline metric, cuando `DESIGN.md` reserva `--fs-display` (40 px) para exactamente una por vista.

Tres cambios, ninguno inventado:

1. **Titular.** La única headline metric de la vista: el total de pendientes a 40 px con su desglose («pendientes en 6 bandejas · 1 a tu nombre»). Suma colas distintas a propósito y se rotula literal — es un conteo de cosas que esperan, no un indicador de negocio.
2. **La fila pasa a ser un objeto**: mismo cuerpo que una puerta (fondo de tarjeta, hairline, radio, sin sombra), y la cifra sube de 18 a 20 px en negrita.
3. **Se pinta `MePendiente.icono`**, que llegaba del backend desde SN.7 y nunca se mostró — la deuda que SN.11 dejó declarada. El chip empareja visualmente las dos columnas; en lo que está a tu nombre va en `--action`.

**Medido después:** superficie **0 % → 35.2 %** (la otra columna tiene 36.1) · objetos **0 → 8** · vacío **464 → 309 px** · la página sigue sin rodar.

⚠️ **Y un defecto que introduje en el mismo paso:** al ganar el chip, la fila perdió ancho y **3 de 7** detalles pasaron a cortarse (antes 0). Se aplicó el mismo criterio que ya regía en las tarjetas —envolver a dos renglones, nunca cortar— y volvió a **0 de 7**. Es la tercera vez en esta fase que agregar algo a un renglón angosto rompe lo que ya cabía: **cuando se mete un elemento nuevo en una fila, hay que volver a medir lo que ya estaba en ella.**

**El orden por antigüedad quedó verificado con datos reales** (la API ya reiniciada): `1,208` con 15 días aparece **antes** que `1,865` con 14. Con el orden por volumen habría sido al revés.

#### 4.2.6 SN.14 — el buscador dibujaba DOS anillos de foco (2026-09-11)

Edgar mandó una captura del campo enfocado. Se veían dos cajas naranjas concéntricas de formas distintas; medido en vivo, la causa:

```
styles.css:753   input:focus { outline: 2px solid var(--action) !important; outline-offset: 2px !important; }
```

Ese `!important` global se come cualquier `outline: none` de componente, así que el anillo del **contenedor** (`:focus-within`, radio 12 px) convivía con el del **input** — y el del input era **rectangular**, porque el input no tenía radio, y **dejaba fuera la lupa y la tecla**: el campo iba de x 1399 a 1684, la lupa estaba en 1379 y el `Ctrl K` en 1692.

⚠️ **Me corregí antes de acusar al global:** iba a escribir que ese `!important` rompe todos los inputs compuestos de la suite. La medición dijo que **`focus-within` aparecía en UN solo archivo de la app** — éste. El choque lo introdujo este componente, no `styles.css`.

**Arreglo: que un solo elemento dibuje el foco, y que sea el input.** En vez de pelear `!important` contra `!important` —`DESIGN.md` lo veta como primera herramienta— el input deja de ser un trozo del control y **pasa a ser el control**: ocupa toda la caja, lleva el borde y el radio, y la lupa y la tecla se superponen sin quitarle área. El anillo global cae entonces donde debe, con la forma correcta, y no hay nada que anular.

**Medido después:** anillos que dibujan foco **2 → 1** · radio del anillo **0 → 12 px** · lupa y tecla **dentro** del anillo · la página sigue sin rodar.

De paso: **`Ctrl K` mentía en Mac.** El atajo acepta `metaKey` desde SN.9, así que ⌘K ya funcionaba, pero el rótulo decía Ctrl siempre. Ahora se anuncia la tecla que de verdad funciona en cada plataforma.

#### 4.2.7 SN.15 — la pantalla afirmaba que nadie te asigna trabajo, y era falso (2026-09-11)

Pedido de Edgar: *«analiza cómo funcionan los usuarios y los roles, y cómo debemos conectar esta interfaz con el funcionamiento de la interfaz que se hizo»*.

**El análisis encontró que la pieza que faltaba ya estaba construida, ese mismo día, por la fase `[OR.*]`** (9 migraciones, batches 377-381 ya en prod). Su regla, en `libs/contracts/src/work/task.contract.ts`:

> El **permiso** decide si podés ABRIRLO; la **responsabilidad** decide si es TUYO; la **tarea** dice que alguien te lo asignó, con nombre y fecha. **Una cola sin `assigned_to` no es una tarea: es una bandeja.**

La landing contestaba **sólo la primera** y la presentaba como si fuera la segunda.

##### Lo que se midió contra prod (`railway`, read-only) antes de tocar nada

`database/scripts/or-landing-gap-report.js`, nuevo. ⚠️ Resuelve `FLEET_DB_URL` **dentro de node** y aborta si la base no es `railway`: `DATABASE_URL_NEW` del `.env` apunta a la réplica de pruebas, y medir la brecha ahí habría dado cifras que no son de nadie.

| # | Medición | Resultado |
|---|---|---|
| 1 | Las 4 fuentes de tarea | `recon_tasks` 15 abiertas · `supervisor_tasks` 2 · `inventory_count_assignments` 18 · `daily_assignments` 119 → **151 con dueño activo** |
| 2 | Personas con trabajo a su nombre | **38 de 118 (32.2 %)** |
| 3 | Tareas que llevan a un 403 | **2** conteos asignados a gente sin `COMMERCIAL_INVENTORY_CONTAR` |
| 4 | God-mode invisible | **0** — hipótesis **refutada** (ver abajo) |
| 5 | Cobertura de sucursal | **93 % / 80 % / 74 %** de quienes ven las bandejas acotables **no tienen `warehouse_code`** |
| 6 | Eje de responsabilidad | catálogo 8 · puesto→responsabilidad **0** · excepciones **0** |

**⭐ La consecuencia directa: la pantalla mentía.** El texto «Nadie te asignó trabajo hoy · el reparto nominal está pendiente (P-06)» se apoyaba en una medición del **10-sep** que decía que las tablas de asignación estaban en cero. Era falso para **un tercio del padrón**. La frase estaba además **congelada en dos tests**, que la daban por buena.

##### Lo que se construyó

- **`libs/trade/src/lib/users/me-tasks.ts`** — lee las 4 tablas vía los `ADAPTADORES` del contrato. **No crea una quinta tabla**, que es justo lo que el contrato vino a cerrar. Los estados abiertos se **derivan** del mapeo (`dialectosAbiertos`), no se copian.
- **`trade.daily_assignments` NO suma al conteo de pendientes**: su propio adaptador declara que `status` es decoración (119/119 en `pendiente`, sin CHECK) y que `day_of_week` es **recurrencia, no vencimiento**. Entra como *«tu ruta de hoy»*, filtrada por **ISODOW en TZ MX** — el mismo patrón de `vendor-cartera.sql.ts`, no `DOW`, que arranca en 0.
- **La tarea cuyo dueño no tiene el permiso de su ruta se muestra SIN enlace**, con el motivo. Esconderla taparía que quien reparte y quien puede abrir no coinciden; enlazarla invitaría a un 403.
- **Un solo vocabulario**: `BandejaDef.responsabilidad` ata cada cola a su clave de `identity.responsibilities` (`cuadre` ↔ `almacen.cuadre`). Sin esto, el día que `[OR.3]` enrute no iba a poder cruzar.
- **`conteos-asignados` se mudó de bandeja a tarea**: su fila trae `assigned_by`, o sea que alguien la repartió. Estaba del lado equivocado de la línea que el contrato traza.

##### El acotado por sucursal, y la trampa que casi me cuesta

Sólo **una** de las 8 colas gana algo real: las otras 7 o no tienen columna de sucursal (5, medido) o ya filtran por persona (2). Para el reabasto, acotar lleva el número de **21,940 a 2,249** en una sucursal.

⚠️ **Iba a unir por `warehouses.code` y habría dado CERO a Morelia.** `branchKeySql` (`[RE.23]`) documenta que la llave canónica es el código de 2 dígitos: las 7 sucursales Kepler lo guardan en `code`, pero Morelia guarda `'MD-30'`/`'MD-32'` con el dígito en `wincaja_source_branch`. Medido: la ficha de esas 2 personas dice `'30'`/`'32'`, así que el filtro obvio les habría devuelto **0 teniendo 2,813 y 1,944**.

⛔ **Y el `[]` nunca se propaga.** `applyTo()` emite el mismo `WHERE false` para `none` que para un `own` sin ficha, y la ficha falta en el **74 %**. Acotar sin mirar habría convertido *«tu ficha no tiene sucursal»* en *«estás al día»*. Por eso el conteo sólo se acota si el alcance es **resoluble**, y si no, se cuenta la red y **la fila lo dice** (`ambito: 'red' | 'sucursal' | 'red_sin_ficha'`).

##### Lo que se corrigió de mí mismo

**La hipótesis del god-mode invisible era mía y quedó refutada.** Razoné que el backend evalúa `isPlatformAdminRole` sobre los roles frescos (unión de `user_roles`) y el frontend sobre el `role_name` del JWT (sólo el perfil base), y que como el trigger `sync_primary_role_from_user` **degrada en vez de borrar**, un ex-superadmin conservaría god-mode invisible. Medido: **cero cuentas** con rol de plataforma como complemento. El mecanismo existe; el caso no. Se midió antes de escribirlo como hallazgo.

##### Candados

`database/tests/test-newdb-me-context.js` → **93 OK · 0 FAIL · 8 NO MEDIDO**:
- **4b** — las 4 fuentes de tarea contra el guard de su ruta, igual que las bandejas. Encontró un **falso negativo del propio candado**: `guardDe` sólo entendía rutas multilínea y el bloque `dashboard` las declara en una sola, así que decía «no existe» sobre `/dashboard/supervisor-ai`, que existe y tiene guard. Ahora acepta los dos estilos.
- **4c** — **biyección** cola ↔ `identity.responsibilities` (8↔8), contra el catálogo leído de la migración.
- **5b** — en vivo: `tareas` declarado, `o lleva ruta o dice por qué no`, y `vencidas === null` cuando la fuente no maneja vencimiento (0 sería afirmar que ninguna venció sobre un dato que no existe).
- ⓘ **NO MEDIDO (exit 2), no FAIL**: la API viva responde sin los campos nuevos porque corre código anterior. Un rojo permanente enseña a ignorar el tablero; un verde sería no medir. Se declara con su motivo, usando `_lib/no-medido.js`.

⚠️ **No se creó `me-work.spec.ts`**, que el propio `me-work.ts` citaba como su prueba: **ese archivo nunca existió** y `libs/trade` no tiene target de test (sólo `lint`), así que habría sido una prueba huérfana más — la Fase VP contó 21. Se corrigió la cita y los candados viven donde sí corren.

##### Abierto, con evidencia

- **`position_responsibilities` sigue vacía** (decisión de Edgar: declararla, no sembrarla desde el permiso). Mientras tanto «es tuyo» no se puede calcular y la pantalla lo dice.
- **El reparto de permisos tiene desajustes que la landing hace visibles**, y que NO se tocaron acá: `auxiliar_mkt` —2 personas de marketing— puede abrir 6 de las 8 bandejas, incluidos **82,289 hallazgos de finanzas** (medido por `[OR.1b]`).
- **La visibilidad se mide por ROL y la pantalla se dibuja por PERSONA**: `suite-map-visibility-report.js` simula con `role_permissions` crudo — no ve los complementos de `user_roles` (135 filas, 129 espejo → **6 reales**) ni los overrides de `user_permissions` (**31 filas sobre 3 personas**).
- **`hideForRoles` sólo tapa la entrada primaria**: un vendedor con `COMMERCIAL_PROMOTIONS_VER` ve igual el proyecto por el cross-link.

#### 4.2.8 SN.16 — el trabajo que se cierra mes por mes (2026-09-12)

Pedido de Edgar: *«necesito que hagamos más interactiva la forma de mostrar "mi trabajo"; por ejemplo `mayra_gutierrez` tiene que conciliar los egresos por mes, entonces se me ocurre una gráfica o tabla donde se muestren los meses conciliados y no conciliados, y al dar clic a no conciliados que la redirija a la pantalla que la lleva a conciliar»*.

**No es una bandeja más bonita: es un tercer organismo.** Una bandeja contesta *«¿cuántas cosas esperan?»* (cola sin fin); una tarea, *«¿quién me lo asignó?»*; esto contesta *«¿qué parte del calendario ya cerré?»*. Por eso vive en su propio archivo, `me-cycles.ts`, junto a `me-work.ts` y `me-tasks.ts`.

##### Quién es Mayra, medido

`finanzas_operativo`, **auxiliar de finanzas**, activa, entró ayer. **13 permisos, todos `FINANCE_*`** — incluidos `FINANCE_BANK_VER` y `FINANCE_BANK_GESTIONAR`, o sea que puede ver *y* correr la conciliación. **Cero filas en las 4 tablas de tarea**; está en el pool de reparto de Maat (9 personas con `FINANCE_RECON_RECIBIR`) y nunca le tocó nada. Su columna «A tu nombre» está vacía con razón.

##### El estado real de su trabajo, medido en prod

| mes | egresos | casados | sin casar | qué es |
|---|---:|---:|---:|---|
| 2026-01 | 3,497 | 1,111 | 2,386 | corrió, faltan **$27.9M** |
| 2026-02 … 2026-05 | 10,448 | 0 | 0 | nunca corrió |
| **2026-06, 2026-07** | — | — | — | ⭐ **sin estado de cuenta: SIN DATOS** |
| 2026-08 | 3,744 | 854 | 1,043 | corrió, faltan $9.9M |
| 2026-09 | 1,237 | 0 | 0 | nunca corrió |

⭐ **Junio y julio son la razón por la que esto no se podía improvisar.** «Sin datos» y «sin conciliar» se ven igual si no se separan; pintarlos como pendientes le inventaría trabajo a alguien que no tiene con qué hacerlo. Un mes `sin_datos` **no es clickeable y no cuenta como pendiente** — y hay un candado que lo verifica.

##### Lo que NO se construyó, porque ya existía

- **El criterio de «listo»** lo señaló Edgar con un enlace: `?view=cuadre`. Es `GET /finance/bank/diagnostico`, que devuelve `cuadra` + 5 tipos de problema accionable. ⛔ **No se duplicó.** Cuesta ~8 consultas por mes (saldos por cuenta + P&L contra Kepler + evidencia renglón por renglón); la tira reporta **hechos baratos del avance** y el veredicto queda a un clic, con un solo dueño. Dos verdades sobre «cuadra» sería el defecto que ADR-054 retiró en autorización.
- **Las dos pantallas ya aceptan el mes por URL** y no se tocó ninguna: bancos lee `?view=&period=` y lo valida contra los periodos existentes; el Libro de Compras lee `?mes=` en su `ngOnInit`.
- **El patrón visual** se calcó del riel de meses del Libro de Compras, con su lección: *«Punto + texto, NO pastilla llena: 105 pastillas de color le compiten a la única acción naranja. El estado del mes es orientación, no alarma.»* El color va en 6 px de punto, nunca en el fondo.

##### Por qué no es una gráfica

⛔ **Chart.js quedó descartado por dos razones independientes.** `DESIGN.md:471` (BINDING): *«Micro-charts = SVG crudo (0 KB). Nada de Chart.js/Apex»*. Y **+205 KB** en la ruta crítica de `/projects`, que es el destino por defecto de todos al entrar. **Medido después: la tira costó +5,666 B** (chunk 69,577 → 75,243 B) — **36× menos**, con el inicial intacto en 1.25 MB.

##### Lo que la medición corrigió del plan

El plan fijaba un presupuesto de ~150 ms por consulta. La primera corrida dio **1,424 ms** (bancos) y **9,790 ms** (libro). `EXPLAIN ANALYZE` separó las dos causas:

- **La latencia a Railway es de 154 ms** y se estaba contando como si fuera costo de consulta. El ciclo A son **~7 ms** de servidor con caché caliente (394 ms en frío) — sirve.
- **Contar los CFDIs de cada mes cuesta 9,144 ms de ejecución en el servidor.** `fiscal.cfdis` son 167k filas y ni el `Index Only Scan` sobre `ix_fiscal_cfdis_fecha` la salva. **Se retiró**: el universo lo arma el calendario y el estado sale de `purchase_book_runs` (3 filas, **0.9 ms**). El número de facturas se **declara ausente** (`faltan: null`) en vez de pagar 9 s en la primera pantalla que todos abren. Que no se pueda contar no cambia el hecho de que el trámite no se hizo.

##### Decisiones de diseño

- **Va como cola compartida**, rotulada *«lo abre tu permiso, nadie te lo asignó»*. Mayra no tiene el trabajo declarado como suyo (`position_responsibilities` sigue vacía) y la pantalla no finge que sí. Lo verían **24 personas** (bancos) y **17** (libro de compras).
- ⚠️ **Sin `CASE` en cascada.** Los contadores viajan crudos y el estado se deriva arriba. Medido en `v_rd_period_summary`: su `CASE` excluyente reporta `sin_gasto = 0` no porque el gasto esté, sino porque dos ramas anteriores atrapan la fila — **colapsa motivos concurrentes**.
- La TZ se ancla al día 15: la API corre en UTC y el 30 de septiembre a las 19:00 de México ya es octubre en UTC.

##### Candados

`test-newdb-me-context.js` → **109 OK · 0 FAIL · 1 NO MEDIDO**. Bloque **4d** (la ruta de cada ciclo existe y su guard acepta su permiso) y **5c** en vivo: los 12 periodos siempre presentes, formato `YYYY-MM`, y la regla que da sentido a la fase — **`sin_datos` no navega, no inventa conteo, y no suma a `pendientes`**. `nx test view` 19 suites / **295** · `contracts` 35/35.

> ⓘ El único NO MEDIDO es el bloque 5c contra la API viva, que corre código anterior a SN.16. **Los 8 NO MEDIDO de SN.15 bajaron a 0**: la API se reinició y `tareas`/`ambito` quedaron verificados en vivo.

##### Abierto, medido y NO tocado

- **281 filas de `finance.findings.periodo` corruptas** (`"Wed Sep"` en vez de `"2026-09"`), por `String(fecha).slice(0,7)` sobre un `Date` — `maat-detector.service.ts:329,391,509`. **Efecto medible**: esos hallazgos **nunca generan tarea de conciliación**, porque el repartidor filtra por periodo. Es la **tercera** aparición del mismo patrón de fecha en este repo (LC.16 fue la anterior).
- **`finance.bank_statements.status` es cosmética**: 126 filas, 100 % `imported`, sin un solo `UPDATE` en todo el repo. Quien la lea como *«¿está conciliado el mes?»* va a leer siempre que no. Por eso el estado se deriva de `bank_movements.recon_status`.
- **Contar CFDIs por mes tarda 9.1 s** — afecta también a `listMeses()`, que es lo que abre la pantalla del Libro de Compras.

#### 4.2.9 SN.17 — el reparto real: Ivonne concilia ingresos, Mayra egresos (2026-09-12)

Edgar: *«ese es para un solo usuario, debemos personalizar según su puesto. ivonne es de ingresos, ella se encarga de conciliar ingresos»*.

##### ⛔ Por PUESTO no se puede, y está medido

```
mayra_gutierrez  → position_code = 'auxiliar_finanzas'  role = 'finanzas_operativo'
ivonne_cruz      → position_code = 'auxiliar_finanzas'  role = 'finanzas_operativo'
```

**El mismo puesto, y son 6 personas en él.** Lo único que `auxiliar_finanzas` declara hoy es `finanzas.hallazgos`. Partir el trabajo por puesto exigiría **partir el puesto** — decisión de organigrama, de Dirección.

Para eso existe `identity.user_responsibilities`: la **excepción por persona**, que `[OR.1b]` creó con `nota` NOT NULL y vigencia justamente para que cueste y quede explicada. Este es su caso canónico: dos personas del mismo puesto con trabajos distintos. ⚠️ **Si mañana hay que hacerlo con las otras 4, la excepción se volvió la norma** y la respuesta correcta pasa a ser partir el puesto. Queda dicho en la migración para que se note.

##### La conciliación de INGRESOS existe, y hubo que comprobarlo

El detalle de un depósito dice que *«el banco lo registra como UN depósito; en Kepler está repartido en N pólizas… se cuadra por total, no 1 a 1»*, así que el ciclo de ingresos podía no ser medible. **Medido: 2,696 filas de `bank_recon_matches` con `amount_in > 0`** y 2,683 movimientos casados. El matcher sí los parea; si no, la tira habría dicho «sin conciliar» para siempre. Estado real: 2026-01 con 2,065 casados de 3,050, 2026-08 con 618, el resto sin correr.

##### La regla que ordena sin autorizar

⛔ **La responsabilidad ORDENA, no gatea** — regla literal de `[OR.1b]`: *«el PERMISO decide si podés ABRIRLO; la RESPONSABILIDAD decide si es TUYO… si también gateara habría un cuarto sistema de autorización»*. Las **24 personas** con `FINANCE_BANK_VER` siguen viendo y abriendo las dos conciliaciones. Lo que cambia:

| | «A tu nombre» | «Por periodo» |
|---|---|---|
| Ivonne | Conciliación de **ingresos** | Conciliación de egresos |
| Mayra | Conciliación de **egresos** | Conciliación de ingresos |
| Las otras 4 auxiliares | — | las dos |

El resolvedor (`responsabilidadesDe`) une las dos fuentes con precedencia: lo del puesto más las excepciones por persona, donde `accion: 'resta'` quita y `'suma'` agrega, y una excepción **vencida no cuenta** (`valid_to`).

##### Migración

`20260912140000_responsabilidades_conciliacion.js` — **aplicada a prod, batch 405**. Agrega 2 claves al catálogo (`finanzas.conciliacion_ingresos` / `_egresos`) y 2 filas a `user_responsibilities` con la nota que explica por qué van por persona. ⛔ **No toca `position_responsibilities`**: decir que `auxiliar_finanzas` responde de una de las dos sería falso para las 6.

⚠️ Se aplicó **sola**, no con `migrate:latest`: hay migraciones de otras sesiones sin commitear en el directorio, y arrastrar su trabajo a medio hacer a producción es exactamente el accidente que el índice compartido ya provocó una vez en esta fase.

##### Candados y lo que costó

`test-newdb-me-context.js` → **107 OK · 0 FAIL · 1 NO MEDIDO**. El bloque 4c (biyección) tuvo que aprender que las colas viven en **tres** registros —bandejas, tareas y ciclos— y que el catálogo se siembra desde **más de una** migración: leyendo sólo la primera acusaba en falso a las dos claves nuevas. Ahora junta las claves de toda migración que inserte en `identity.responsibilities`. Biyección **10↔10**. `nx test view` 19 suites / **295**.

⚠️ **El bug del backtick, quinta aparición.** Un comentario CSS con `` `[SN.17]` `` dentro del `styles: [\`…\`]` cierra el template literal y `[SN.17]` se evalúa como código: `ReferenceError: SN is not defined`, con la suite entera sin correr. Está en `GOTCHAS` y volvió a pasar.

##### Abierto, ajeno y NO tocado

`landing-guards.spec.ts` falla en `almacen` por **`CATALOGO_INTERNO_VER` y `CATALOGO_INTERNO_COSTOS_VER` → `/almacen/catalogo-interno`, ruta que no existe en `app.routes.ts`**. Viene del commit `2b75ab89` `[CV.25]` de otra sesión: declararon los permisos en el árbol y la pantalla del frontend todavía no está. Es justo lo que ese candado existe para frenar; lo resuelve esa fase, creando la ruta o declarando la deuda.

### 4.3 Backend — `GET /users/me/context` (self-scoped, sin `@RequirePermissions`, antes de `:id`)

`{ user_id, username, nombre, role_name, kind, warehouse_code, zona, department:{code,name}|null, position:{code,name}|null }`. Contrato en `libs/contracts/src/http/identity-me.contract.ts`.

### 4.4 Layout

`currentProject`/`projectLabel` derivados del mapa (default `trademk` preservado → `isRestricted()` intacto); migaja Espacio › Proyecto › Página; "Administración" → "Configuración de la suite" (L448/L819; **L832 no**: es la sub-sección de catálogos de Trade); "Proyectos" → "Mi trabajo" con `state:{stay:true}`; link "Mi trabajo" en `TeleventaShellComponent`; `adminHomeGuard` (patrón `landingRedirectGuard` ×4).

### 4.5 Backend — `GET /users/me/work` y la medición que lo define (SN.7)

**Lo primero fue medir, no diseñar.** El pedido era que la landing mostrara *trabajo delegado o asignado a una persona*. Contra prod, read-only, 2026-09-10:

| Tabla pensada para asignar a una persona | Filas |
|---|---|
| `finance.recon_tasks` (`assigned_to`, Fase MA) | **0** |
| `commercial.supervisor_tasks` (`assigned_to_user`, Horus) | **0** |
| `trade.daily_assignments` / `public.daily_assignments` | **0** |
| `reconciliation.actions` (`responsable`) | **0** |
| `commercial.inventory_count_assignments` (`user_id`) | 12 — las 12 apuntan a sesiones **canceladas** |
| `commercial.expiry_reviews` (`responsible_user_id`) | 4 (1 `draft`) |

**Hoy nadie reparte trabajo nominalmente.** La infraestructura existe en tres lugares y está vacía en los tres. Lo que sí tiene volumen son **colas compartidas** que ya tienen su pantalla:

| Bandeja | Pendientes (prod) | Ruta | Permiso (= el guard de la ruta) |
|---|---|---|---|
| `reconciliation.discrepancies` `nuevo` | 1,865 | `/almacen/cuadre` | `RECONCILIATION_VER` |
| `finance.findings` `nuevo` | 1,208 | `/finanzas/hallazgos` | `FINANCE_AI_CHAT` |
| `commercial.commercial_actions` `pending_approval` | 99 | `/comercial/thot-curation` | `COMMERCIAL_THOT_GESTIONAR` |
| `finance.proposed_actions` `pending_approval` | 76 | `/finanzas/pagos-control` | `FINANCE_AI_CHAT` |
| `commercial.replenishment_findings` `open` | 19 | `/compras/hallazgos` | `COMPRAS_HALLAZGOS_VER` |
| `logistics.fleet_alerts` `open` | 7 | `/logistica/rastreo` | `LOGISTICS_FLEET_VER` |

Los 8 conteos (las 6 de arriba + las 2 nominales) corren en **≤69 ms** cada uno.

De ahí sale la decisión de diseño: cada pendiente declara su `alcance` — **`'mio'`** (la fila trae tu `user_id`) o **`'bandeja'`** (cola compartida que abre tu permiso, que nadie repartió) — y la pantalla los separa con esas dos palabras. Llamarle "tu trabajo" a una cola de la que nadie es responsable sería la misma clase de mentira que el badge "Activo".

Registro en `libs/trade/src/lib/users/me-work.ts` (declarativo + el `contar` de cada una), `workFor()` en `users.service.ts`, endpoint self-scoped junto a `me/context`. Reglas: sólo se cuenta la bandeja **cuyo permiso tiene la persona** (un conteo ya es información); una bandeja en 0 **no viaja**; lo que falla al contarse va a `no_medido` con motivo y **nunca baja a 0** (ADR-056). Conexión: `KNEX_CONNECTION` bypassa RLS → filtro `tenant_id` explícito, como `ReportsService`.

**Lo que NO se hizo, y por qué:** construir la capa de asignación nominal (repartir tareas a personas) es una función nueva, no navegación — Etapa 3, y necesita que Dirección defina quién reparte. Lo que la pantalla hace hoy es decirlo en una línea en vez de dibujarlo.

---

## 5. Gates (cada uno con prueba negativa ejercida)

| Gate | Qué asegura | Negativa |
|---|---|---|
| `suite-map.spec.ts` (libs/contracts, jest **nuevo**) | 10 espacios en orden §5.1; planned sin entradas; cada proyecto con UNA casa; refs existen; `gate` con `reason` y claves del árbol/LEGACY; URL por segmento; kiosco no ve nada; almacenista sólo Almacenes; vendedor sin back-office ni siendo admin; gates de Reparto/Configuración/Trade | proyecto falso, módulo falso, doble casa, sin casa, planned con entradas, activo vacío, gate sin motivo / clave inexistente, orden roto, árbol sin whatsapp |
| `suite-map.parity.spec.ts` | los 11 `anyOf` legacy **congelados**: cada clave sigue abriendo su destino Y una persona con UNA sola clave lo ve | quitar `USUARIOS_ASIGNAR_RUTA` al gate de Trade → rojo; `alsoAnyOf` en entrada de proyecto → 11 puertas cerradas detectadas |
| `database/scripts/suite-map-visibility-report.js` | por rol de prod (read-only): tarjetas legacy vs entradas; **nunca menos**; las ganadas se listan para revisión | exit 1 ante una puerta perdida |
| `test-newdb-me-context.js` | 200 con `position` objeto o **null declarado**; 401 sin token; `me/context` y `me/work` declarados antes de `:id` y sin `@RequirePermissions`; `me/work` manda `no_medido` siempre y ningún pendiente en 0 | mover la ruta después de `:id` → rojo |
| `test-newdb-me-context.js` bloque 4 (SN.7) | **cada bandeja lleva a una ruta cuyo guard acepta su permiso** — el conteo no puede invitar a un 403. 8/8 verde | cambiar el `anyOf` de `cuadre` a `USUARIOS_GESTIONAR` → `FAIL … {"guard":["RECONCILIATION_VER"],"bandeja":["USUARIOS_GESTIONAR"]}` ✅ ejercida |
| `mi-trabajo.component.spec.ts` / `mi-trabajo-route.spec.ts` | comportamiento por persona + gate estático de `app.routes.ts` | ver SN.3 |

---

## 6. Plan de commits

| Paso | Contenido | Estado |
|---|---|---|
| *(fix del build)* | `tsconfig.app.json` excluye el arnés → build de `view` vuelve a compilar | ✅ **superado**: lo hizo la sesión TDA.7 en `9cd6d107` con la misma línea; mi copia quedó idéntica a HEAD |
| `docs([SN.0])` | esta FASE + ADR-061 + tracker | ✅ 2026-09-10 |
| `feat([SN.1])` | `suite-map.ts` + jest en `libs/contracts` + aliases + shim + specs + `authz-tree.ts` L18/L83 + reporte de visibilidad | ✅ 2026-09-10 (35/35; reporte prod 0 perdidas) |
| `feat([SN.2])` | `identity-me.contract.ts` + `contextFor` + `GET /users/me/context` + smoke | ✅ `a0f23e43` — `nx build api` verde; smoke estático 5/5, parte viva **NO MEDIDA** (sin API local; no se levanta desde acá) |
| `feat([SN.3-4])` | `mi-trabajo.component.*` + `me-context.service.ts` + rutas + specs; borrar `modules/projects/`; layout + **home guards** + `landing-guards.spec.ts` + link en Telemarketing | ✅ `db6f2718` — un solo commit porque `app.routes.ts` llevaba las dos cosas. ⚠️ Arrastró la baja de `libs/shared-auth` que otra sesión tenía en el índice (§11) |
| `chore([SN.5])` | borrar `scripts/check-authz-tree.js`; corregir `FASE_AZ` L161, `GOTCHAS` §4, `CLAUDE_ONBOARDING` L48 | ✅ — la baja del script viajó en el commit ajeno `b39e90d1` (§11); los 3 docs en el commit de SN.5 |
| `docs([SN.6])` | tracker, log, CHANGELOG, fila en `CLAUDE.md`, INDEX, esta FASE | ✅ 2026-09-10 |
| `feat([SN.7-8])` | **corrección de Edgar**: vuelve la tarjeta agrupada por espacio; "Mi trabajo" pasa a ser el primer espacio con pendientes reales (`me-work.ts` + `workFor()` + `GET /users/me/work` + `MeContextService.work()`), y el smoke gana el bloque 4 (bandeja → guard de su ruta) | 🔨 2026-09-11 — `nx build api` ✅ · `nx build view` ✅ (1.25 MB, sin cambio) · `nx test view` 247/250 (3 todo) · `nx test contracts` 35/35 · gates estáticos 8/8 con negativa ejercida · **parte viva NO MEDIDA** (sin API local) |

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
| Después de SN.3/SN.4 | **1.25 MB** | 1.12 MB / 240.73 kB gz | **+20 kB crudos / +4.1 kB gz** por `AUTHZ_TREE` + `suite-map` en el chunk inicial (los importa el layout). 249.12 kB sobre el aviso; error en 1.4 MB. El plan B (índice compacto) no hace falta |

---

## 9. Deuda declarada (con nombre) y fuera de alcance

- `*NavGroups`/`*NavItems` del layout siguen a mano (3ª lista); unificarlos con el árbol es fase aparte.
- Choques guard vs árbol que el `gate` tapa (cuando se resuelvan, se quita su `gate` y la paridad sigue verde): `USUARIOS_VER` y `USUARIOS_PASSWORDS` no abren ninguna ruta · sidebar Roles pide `CONFIGURAR`, la ruta `VER` · `televenta` `VER`-only rebota en `televenta.guard.ts:32` · `reparto-entrega` (`ENTREGAR`) apunta a `/reparto` que exige `DESPACHAR` · `colaboradorGuard` ignora `RUTAS_VER`/`SUPERVISOR_AI_VER`/`TRADE_ROUTE_PLAN_VER`.
- Renombre `/projects` → `/mi-trabajo` y la cabecera "Esto ve Dirección General de mi gestión": Etapa 3, con el primer indicador con ficha.
- Espacios `planned` y **P-14** (dónde vive `trade`): decisiones de Dirección; el mapa las hace de una línea.
- Módulos del árbol cuya ruta representativa exige OTRA clave (rebotan aunque el permiso exista): `logistica/cartaporte` → `/logistica/shipments` (pide `SHIPMENTS_VER`); `almacen/receiving-auditor` view `RECIBIR` → su ruta real es `/almacen/inventory/recepcion-sesiones` (la del árbol dice `/recepcion`). Se declaran; alinear el árbol con las rutas es de Fase AZ, no de ésta.
- No se tocan guards de backend, permisos, roles ni migraciones de DB.

---

## 10. Verificación (2026-09-10)

| Qué | Resultado |
|---|---|
| `npx nx test contracts` | ✅ 2 suites / **35** pruebas (mapa + paridad, con negativas) |
| `npx nx test view` | ✅ 18 suites / **243** pruebas (+41: `mi-trabajo.component.spec` 13, `mi-trabajo-route.spec` 4, `landing-guards.spec` 24) |
| `node database/tests/test-authz-route-coverage.js` | ✅ 22/22 |
| `node database/scripts/suite-map-visibility-report.js` (prod, read-only) | ✅ 36 roles · 0 puertas perdidas · 17 ganan (§7) |
| `npx nx build api` | ✅ (la primera corrida falló por `store-arqueo.controller.ts`, WIP ajeno que la sesión SM.34 arregló en `cc9eea00`) |
| `npx nx build view` (producción, sin pipe) | ✅ 1.25 MB inicial (§8). Errores míos corregidos antes de commitear: unión no estrechada en template estricto (`contexto().error`), shim sin `findProject`, **acento grave en un template inline** (8ª vez en el repo) |
| `node database/tests/test-newdb-me-context.js` | estático 5/5 ✅ · **vivo NO MEDIDO** (sin API en :3334; regla: no se levanta desde acá) |
| `node database/run-all-tests.js` | **NO CORRIDO**: ~60 suites exigen la API viva; se corre cuando Edgar la reinicie |
| Browser (light + dark + 375px) | **PENDIENTE** — dev servers de Edgar. Guion: superadmin → 4 espacios activos + 2 propuestos con badge + línea de planned; `almacenista` → aterriza directo en `/almacen`; "Mi trabajo" desde el sidebar → se queda; `/admin/users` → migajas "Configuración de la suite / Usuarios"; `/dashboard/captures` → "Comercial / Auditoría en Ruta / Captura Diaria"; Tab recorre filas con ring; `/telemarketing` tiene "Mi trabajo"; `ROLES_VER` solo entra por `/admin` y aterriza en `/admin/roles`; `cajero` entra a Finanzas y aterriza en `/finanzas/capturar-gasto` |

**Lo que `landing-guards.spec.ts` destapó al nacer (rebotes PREEXISTENTES, no de esta fase):** `COMMERCIAL_INVENTORY_CONTAR` mandaba a `/almacen/inventory/sessions` (exige SUPERVISAR) cuando la pantalla del contador es `/almacen/inventory/count`; `COMPRAS_ENTRADAS_VER` mandaba a `/compras/entradas` (exige GESTIONAR desde RE.17) cuando la lectura es `/compras/entradas/control`; `COMPRAS_360_VER` apuntaba a un redirect. Los tres corregidos. La deuda árbol-vs-guard (58 pares, casi todos "manage sin view") quedó **enumerada con motivo** en el spec: agregar una nueva = rojo; arreglar una y no borrarla de la lista = rojo.

## 11. Incidente operativo: el índice de git es UNO para 10 sesiones

`ListAgents` mostró **10 sesiones** de Claude sobre este mismo árbol. Consecuencias medidas hoy:
- El build base falló por WIP ajeno (`store-arqueo.controller.ts`), y el primer intento de commit encontró el repo con **conflictos de merge de otra sesión** (`CHANGELOG.md`, tracker).
- `db6f2718` (SN.3-4) **arrastró la baja de `libs/shared-auth`** (15 archivos) que otra sesión tenía stageada. La lib estaba muerta (el gate [2b] de `test-authz-route-coverage.js` verifica cero importadores desde `[ID.28]`), así que no rompe nada — pero no era mía y el mensaje del commit no lo dice.
- Simétrico: `b39e90d1` (VL.2b, ajeno) **arrastró mi baja de `scripts/check-authz-tree.js`**.

**Regla que sale de esto:** `git commit -- <rutas>` (pathspec), que ignora lo que otros tengan en el índice, y `git diff --cached --stat` antes de cada commit. Guardada en memoria.

**Volvió a pasar el 2026-09-11, y el pathspec no alcanza.** El commit ajeno `d7af977d` (TDA, etiquetera) se llevó mis ediciones de `CHANGELOG.md` y `01_TRACKER_PROGRESO.md` para SN.9 **antes** de que yo commiteara: cuando corrí `git commit -- <rutas>` esos dos archivos ya estaban limpios, así que `7875f8bc` sólo tomó los cinco restantes. Verificado que el contenido llegó **íntegro** a `main` (las entradas de SN.7, SN.8 y SN.9 están completas en HEAD); lo único mal es la procedencia. No se amenda — hay commits encima.

**Lo que el pathspec NO protege:** el pathspec evita que YO me lleve lo ajeno; no evita que OTRO se lleve lo mío en la ventana entre que edito y commiteo. La mitigación real es **commitear pronto**, sobre todo los archivos calientes que todas las sesiones tocan (`CHANGELOG.md`, `01_TRACKER_PROGRESO.md`): cuanto más tiempo pase entre editarlos y commitearlos, más probable es que viajen en el commit de otro.

## 12. Etapa 3 y siguientes (fuera de esta fase)

Indicadores con ficha (P-06) y "Esto ve Dirección General de mi gestión"; renombre `/projects` → `/mi-trabajo`; Operación por zonas (la zona ya es eje de alcance); decisión P-14 (dónde vive `trade`) y P-03 (Auditoría como espacio propio); alinear árbol ↔ guards para ir vaciando `DEUDA`; unificar los `*NavGroups` del layout con el árbol.
