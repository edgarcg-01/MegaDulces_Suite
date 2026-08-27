# `[ID.13+]` — Esquema de usuarios para CRM/ERP

> **Disparador:** *"necesito que entiendas las necesidades de la empresa y bajo eso generes un esquema de usuarios. pensando para un CRM/ERP que cubra toda la empresa; anteriormente los usuarios eran pensados para ruta"* (Edgar, 2026-08-27).
>
> **Medido** en la DB de trabajo (`.245/platform_test`, 142 cuentas; prod trae 117 — la estructura de roles/permisos es la misma).
> Continúa [`FASE_ID_IDENTIDAD_ACCESOS_ALCANCE.md`](FASE_ID_IDENTIDAD_ACCESOS_ALCANCE.md) (ADR-050) y la auditoría de campos [`FASE_ID_AUDITORIA_CAMPOS_USUARIO.md`](FASE_ID_AUDITORIA_CAMPOS_USUARIO.md).

---

## 0. Estado — **EN PROD** el 2026-08-27 (batches 222-225)

| Sprint | Estado | Resultado medido |
|---|---|---|
`[ID.13]` **N:M** | ✅ | `identity.user_roles` + `users.kind` + `users.expires_at`. 142 perfiles base migrados, 0 huérfanos. Smoke 34/34 |
`[ID.14]` **catálogo** | ✅ | **47 → 28 roles** (25 perfiles + 3 complementos). 14 retirados · 14 renombrados · 5 fusionados. **Cero pérdidas** de permisos |
`[ID.15]` **el puesto propone** | ✅ | 43 puestos con departamento, **23 proponen perfil**; 20 sin perfil, listados |
`[ID.16]` **RH** | ⚠️ BLOCKED | `hr.*` existe pero **no hay módulo ni pantalla**: los permisos gatearían el vacío |
`[ID.17]` **perfiles que faltaban** | ✅ | Los **27** con una tarea como perfil base re-basados (`0 ganan / 0 pierden`) · `direccion` (79 permisos, todos lectura, `mode_write='none'`) · `auditor_externo` (16, con vencimiento) · `svc_feeds` (`kind='servicio'`, login rechazado) · 8 puestos más con perfil |
UI (parte de `[ID.9]`) | ✅ | Selector de **Complementos** + aviso "este rol es una tarea" + el puesto autocompleta departamento y perfil |
`[ID.21]` **permisos por persona** | 🧪 local | `identity.user_permissions` (la **diferencia** contra el estándar del puesto). Smoke 28/28 |
`[ID.22]` **el puesto manda** | 🧪 local | El alta pasó de 5 preguntas a 2: puesto + sucursal. Departamento y nivel de acceso derivados |
`[ID.23]` **sucursal → zona** | 🧪 local | `commercial.warehouses.zone_id` + `GET /users/branches`. 6/7 sucursales con plaza |

**Verificación:** `snapshot-user-permissions.js` antes/después → 128 idénticos ·
14 ganan (máx +2, cada uno listado) · **0 pierden**. Builds api + view verdes.
Smokes `user-roles` 34/34 · `identity-scopes` 30/30 · `user-dto` 32/32.

**PROD (Railway, batches 222·223·224·225):** las 4 migraciones aplicadas sobre
**117 usuarios**. Verificado con el arnés: **103 idénticos · 14 ganan · 0 PIERDEN**.
Estado final allá: **30 perfiles + 2 complementos** (+15 retirados) · 118 perfiles
base y 5 complementos en `user_roles` · **31 de 43 puestos proponen perfil** ·
**0 usuarios con una tarea como perfil base**.

Las 14 ganancias, todas listadas y todas de 1 o 2 permisos: los 9 `superadmin`
absorbieron `PORTAL_B2B_ACCESS` y `FINANCE_EXPENSES_VER_ALL` al fusionarse
`admin` (que en prod sí tenía 2 usuarios, así que fue por la rama de unión y esos
2 no perdieron nada), y los 5 de finanzas ganaron 1-2 permisos de conciliación al
consolidarse en `finanzas_operativo`.

Dos diferencias de prod vs local que conviene tener presente: **`captura_gastos`
no existe en prod** (los 22 nunca se crearon allá), y por eso prod tiene 2
complementos en vez de 3.

**Falta:** redeploy del código (api + view) + **re-login** — los permisos viajan
en el JWT. El deploy está trabado hasta que `feat/gastos-hotfix` **y**
`feat/id9-admin-ui` estén en `main`: Railway corre `migrate:latest` en el
`preDeployCommand` y falla con "directory is corrupt" mientras haya migraciones
aplicadas en prod cuyo archivo no esté en `main`.

**Lo que queda como decisión, no como código:**
- **12 puestos sin perfil** (choferes, receptor de mercancía, facturación,
  mayoreo, checador, RH, intendencia). Se asignan desde la UI cuando exista el
  criterio; inventarles un set de permisos es lo que llevó a 47 roles.
- **`administrativo` y `piso_tienda` tienen 0 permisos.** Es fiel a lo que esa
  gente puede hacer hoy. Cuando quieras darles algo, se edita **un** perfil.
- **`proveedor` y `rh` no se crearon**: no hay portal de proveedor ni módulo de
  asistencia. Serían roles muertos.
- **`[ID.18]`**: que los ~40 importers escriban `created_by = svc_feeds`. La
  identidad ya existe; falta usarla.

---

## 1. Qué es la empresa hoy — la superficie que un usuario puede tocar

| Dimensión | Cuánto | Dónde |
|---|---|---|
Departamentos | **13** | `identity.departments` |
Puestos del organigrama | **43** | `identity.positions` (con `org_labels`: las etiquetas reales de RH) |
Áreas funcionales (workspaces) | **11** | Administración · Auditoría en Ruta · Comercial · Almacén · Logística · Punto de Venta · Televenta · Compras · Finanzas · Contabilidad · Reparto |
Módulos con ruta propia | **99** | `authz-tree.ts` |
Apps | **3** | Plataforma Web · App Vendedor · Portal B2B |
Permisos | **162** | `libs/platform-core/.../permissions.ts` |
Dimensiones de alcance | **6** | sucursal · zona · ruta · marca · área de gasto · cliente |

La empresa ya **no** es un proyecto de rutas: de los 162 permisos, sólo 6 son de
trade/rutas (`VISITAS_*`, `RUTAS_VER`, `TRADE_*`). El peso está en
**COMMERCIAL 54 · COMPRAS 21 · FISCAL 15 · LOGISTICS 15 · FINANCE 15**.

Pero el **modelo de usuario** sigue siendo el de rutas. Eso es lo que hay que cambiar.

---

## 2. Los 8 hallazgos que obligan al rediseño

### H1 · El catálogo de roles se construyó por persona, no por función

**47 roles para 142 cuentas.** 22 de ellos tienen **1 o 2 usuarios**. Y los nombres
delatan el origen: `coordinadora_marketing`, `encargada_prevencion`,
`encargada_operaciones_compras`, `Coordinador_ecommerce` — están nombrados por
**quién** los ocupa (con género y todo), no por **qué** hacen. Además convive
`finanzas` / `auxiliar_finanzas` / **`auxiliar finanzas`** (con espacio) /
`gerente_finanzas` / `tesoreria` / `gestor_tesoreria`.

Cuando entra alguien nuevo, el camino de menor esfuerzo es **crear otro rol**. Así
se llega a 47.

### H2 · 11 pares de roles son casi el mismo rol

Similitud de Jaccard sobre los permisos realmente otorgados:

| Rol A | Rol B | Similitud |
|---|---|---|
`coordinadora_contabilidad` | `coordinador_presupuestos` | **1.00 — idénticos** |
`finanzas` | `contabilidad` | 0.99 |
`admin` | `superadmin` | 0.98 |
`superadmin` | `sistemas` | 0.95 |
`analista_credito_cobranza` | `gerente_finanzas` / `auxiliar_finanzas` / `gestor_egresos` | 0.92 |

Dos puestos distintos —contabilidad y presupuestos— con **exactamente** el mismo
set de permisos: nadie los diseñó, se copió uno del otro.

### H3 · Tres roles-dios, y el más poderoso no lo usa nadie

`admin` 153 permisos (2 usuarios) · `superadmin` 152 (7) · **`sistemas` 145 (0 usuarios)**.
Un rol con 145 permisos otorgados y cero personas es un arma cargada sobre la mesa:
basta asignarlo por error una vez.

### H4 · 13 roles muertos, varios con acceso amplio

Sin un solo usuario: `sistemas` (145 permisos), `prevencion_auditoria` (82),
`contabilidad` (66), `gerente_de_zona` (56), `mercadotecnia` (53), `cedis` (50),
`tesoreria` (44), `tele_operator` (44), `rutas` (39), `jefe_de_tienda` (31),
`sucursal` (25), `rh` (6), `Coordinador_ecommerce` (1).

### H5 · Un usuario = un rol → la misma persona necesita dos cuentas

`identity.users.role_name` es **una** columna varchar. La consecuencia está medida:
**6 personas tienen 2 cuentas.**

| Persona | Cuenta 1 | Cuenta 2 |
|---|---|---|
Mónica Mejía | `monica_mejia` / encargado_sucursal | **`04`** / cajera |
Claudia Pimentel | `claudia_pimentel` / encargado_sucursal | **`42gernta`** / cajera |
Cynthia López | `cynthia_lopez` / encargado_sucursal | **`03`** / cajera |
Dulce Alatorre | `dulce_alatorre` / auxiliar_sucursal | **`42dmar`** / cajera |
Ivette Cruz | `ivette_cruz` / encargado_sucursal | **`01jzico`** / **superadmin** |

La encargada de sucursal **también cobra en caja**. Como el rol es único, se abrió
una segunda cuenta con nombre de terminal. Y una de esas segundas cuentas es
**superadmin con username ilegible** — nadie que audite la lista se da cuenta.

### H6 · Hay "roles" que son tareas, y secuestran el departamento

`captura_gastos`: **22 usuarios, 1 permiso.** Eso no es un rol, es una tarea.
Y como el rol venía atado a un departamento, los 22 quedaron en `administracion`
— incluyendo a `tono_logistica` (Logística), `yadira_abastos` (una sucursal) y
`viviana_kepler`. **El rol le pisó el departamento a la persona.**

Lo mismo `etiquetas_tienda` (2 permisos) y `auxiliar_mercadotecnia` (3).

### H7 · El organigrama está cargado, pero el sistema no lo usa

43 puestos en `identity.positions`, **sólo 7 en uso**. Los 36 puestos sin ninguna
cuenta son funciones reales de la empresa: *bodeguero, receptor de mercancía,
chofer foráneo, facturador, encargado de cajas, anaquelista, auxiliar de RH,
intendencia, caja general, almacenista, surtidor…*

Es decir: **la empresa está descrita en la DB y el sistema de accesos la ignora.**
Se elige un rol de una lista de 47 en vez de derivarlo del puesto.

### H8 · Recursos Humanos no existe en el modelo de permisos

`hr.*` está construido (6 tablas, 10 checadores ZKTeco, Fase CH) y hay
**0 permisos** `RH_*` en el enum de 162. No aparece en `authz-tree`. Nadie puede
tener acceso a asistencia salvo un rol-dios.

**Cierre:** 69 de 142 cuentas **nunca entraron**; 52 activas en 30 días. Buena
parte del padrón es inventario, no usuarios.

---

## 3. Los tipos de usuario que un ERP de esta empresa necesita

Ésta es la respuesta a la pregunta. Cada tipo se define por **4 cosas**: qué app
usa, cuál es su **eje de alcance**, quién lo supervisa y si es empleado o no.

| # | Tipo | Empleado | App | Eje de alcance | Hoy |
|---|---|---|---|---|---|
1 | **Dirección** — lectura global, cero gestión | sí | Web | red completa, **solo lectura** | ✅ `[ID.17]` perfil `direccion`: 79 permisos de lectura + `mode_write='none'` en las 6 dimensiones |
2 | **Administrador de plataforma** — sistemas | sí | Web | todo | ✅ `[ID.14]` uno solo (`superadmin`); `admin` fusionado y `sistemas` retirado |
3 | **Gerente / supervisor de zona** | sí | Web + Vendedor | **zona** → expande a sus sucursales | ⚠️ rol muerto `gerente_de_zona`; falta `warehouses.zone_id` |
4 | **Encargado de sucursal** | sí | Web + Vendedor | **su sucursal** | ✅ 6 usuarios |
5 | **Piso de tienda** (anaquelista, empaquetador, surtidor, vendedor de piso) | sí | Web mínima / móvil | su sucursal | 🔨 `[ID.17]` perfil `piso_tienda` creado (0 permisos) y los 6 puestos ya lo proponen; falta decidir qué le toca ver |
6 | **Cajero / caja general** | sí | POS + Web mínima | **su sucursal + su caja** | ✅ 27, pero como cuentas-terminal |
7 | **Vendedor de ruta** (RD / vecinal / suplente) | sí | **Vendedor** | **su ruta / camión** | ⚠️ 34 usuarios, eje ruta **sin cargar** |
8 | **Supervisor de ruta** | sí | Vendedor + Web | sus rutas | ✅ 3 |
9 | **Chofer / auxiliar de chofer** | sí | Vendedor / Reparto | su vehículo + su guía | ❌ 0 cuentas; 24-56 en `logistics.drivers` |
10 | **Repartidor (última milla)** | sí | Reparto | su guía del día | ✅ 3 |
11 | **Televenta** | sí | Web | **su cartera** | ✅ 2 (rol `tele_operator` muerto) |
12 | **Mayoreo / venta local / facturación** | sí | Web | red o su sucursal | ❌ 3 puestos sin cuenta |
13 | **Almacén** (almacenista, bodeguero, surtidor) | sí | Web + WMS móvil | **su almacén** | ⚠️ 2 usuarios, 5 puestos |
14 | **Recepción de mercancía** | sí | Web + móvil | su almacén | ❌ 0 cuentas (y es el dueño del cuadre 3 vías de Fase RE) |
15 | **Prevención / auditoría de inventarios** | sí | Web | red completa, lectura + hallazgos | ⚠️ 2 usuarios, rol duplicado |
16 | **Compras / reabastecimiento** | sí | Web | red completa + **su categoría/proveedor** | ✅ 10 |
17 | **Finanzas / tesorería / cobranza** | sí | Web | red + **área de gasto** | ✅ ~14 repartidos en 8 roles distintos |
18 | **Contabilidad / fiscal** | sí | Web | red completa | ⚠️ rol muerto |
19 | **Marketing / trade** | sí | Web | zona o red | ✅ 6 en 4 roles |
20 | **Recursos Humanos** | sí | Web | **su sitio (checador)** | ❌ **0 permisos en el sistema** |
21 | **Capturista de gasto** (complemento, no rol) | sí | Web | su propio comprobante | ✅ `[ID.17]` los 22 pasaron a perfil `administrativo` + complemento `captura_gastos` |
22 | **Cliente B2B** | **no** | **Portal** | **su propio cliente** | ✅ 3 |
23 | **Proveedor** (sube factura / consulta su OC) | **no** | Portal proveedor | su propio proveedor | ❌ no existe (lo pide Fase RE/CC) |
24 | **Contador / auditor externo** | **no** | Web, solo lectura, **con vencimiento** | contabilidad + finanzas | ✅ `[ID.17]` perfil `auditor_externo` + `users.expires_at` con corte en el login |
25 | **Cuenta de servicio** (feeds, crons, réplica, bot WhatsApp) | **n/a** | API | lo que su tarea necesita | 🔨 `[ID.17]` `svc_feeds` (`kind='servicio'`, login rechazado por kind + hash inutilizable). Falta que los importers lo usen (`[ID.18]`) |

**5 tipos que un ERP necesita y hoy no existen:** dirección, RH, proveedor,
auditor externo y cuenta de servicio. Los tres primeros son negocio; los dos
últimos son control interno.

---

## 4. El modelo objetivo

```
identity.people            ← la PERSONA (1 fila por humano) · [ID.11]
   └── identity.users       ← la CUENTA (puede haber 2: web y POS)
         ├── kind            interno | cliente | proveedor | externo | servicio   ← NUEVO
         ├── position_code   → identity.positions   (QUÉ HACE en la empresa)
         ├── department_code → identity.departments
         ├── warehouse_code  → commercial.warehouses (DÓNDE ESTÁ BASADO)
         ├── supervisor_id   → identity.users        (DE QUIÉN DEPENDE)
         ├── identity.user_roles[]    ← NUEVO N:M: 1 perfil base + N complementos
         └── identity.user_scopes[]   ← QUÉ FILAS VE (6 dimensiones) · ya existe
```

Cuatro cambios estructurales:

**C1 · `user_roles` N:M en vez de `role_name` único.** Es lo que resuelve H5 y H6:
la encargada que también cobra en caja no necesita otra cuenta, y `captura_gastos`
deja de ser un rol para ser un **complemento**. `role_name` se conserva como
"perfil base" (compatibilidad: el JWT y los archivos que lo leen siguen
funcionando).

**C2 · El puesto propone el perfil.** `identity.positions.default_role` +
`default_scope`. Dar de alta a alguien pasa a ser: *persona + puesto + sucursal* →
el sistema **propone** perfil y alcance, y el humano confirma. Ahí muere el
crecimiento de 47 roles: nadie inventa un rol para dar de alta a una persona.

**C3 · El rol se nombra por función.** `snake_case`, sin género, sin nombre propio,
sin sucursal, sin mayúsculas sueltas. Un rol es un **puesto tipo**, no una persona.

**C4 · Un solo rol-dios.** `admin_plataforma`. `admin`, `superadmin` y `sistemas`
se consolidan. Dirección recibe un perfil **de lectura**, que es lo que
realmente necesita.

---

## 5. Catálogo propuesto: ~22 perfiles base + 8 complementos

De **47 roles → 22 + 8**, y cada uno mapeado a puestos reales del organigrama.

### Perfiles base (uno por cuenta)

| Perfil | Puestos que cubre | Alcance por default |
|---|---|---|
`direccion` | dirección | red completa, **solo lectura** |
`admin_plataforma` | sistemas | todo |
`gerente_zona` | jefe_zona · supervisor_zona | **zona** (expande a sucursales) |
`encargado_tienda` | encargado_sucursal · auxiliar_encargado | su sucursal |
`piso_tienda` | anaquelista · empaquetador · surtidor_tienda · vendedor_piso · auxiliar_piso_venta · vendedor_promociones | su sucursal |
`cajero` | cajera · encargado_cajas · caja_general | su sucursal + su caja |
`supervisor_ruta` | supervisor_rd · supervisor_rv | sus rutas |
`vendedor_ruta` | vendedor_ruta · vendedor_suplente · vendedor_vecinal | **su ruta** |
`chofer` | chofer_rd · chofer_local · chofer_foraneo · auxiliar_chofer | su vehículo / guía |
`repartidor` | reparto última milla | su guía del día |
`televenta` | coordinador_tlmk · vendedor_tlmk | su cartera |
`mayoreo` | vendedor_mayoreo · vendedor_local | su sucursal |
`facturacion` | facturador | red |
`almacen` | almacenista · auxiliar_almacen · bodeguero · surtidor · almacenista_surtidor_rv | su almacén |
`recepcion` | receptor_mercancia | su almacén |
`logistica` | encargado_logistica | red |
`compras` | auxiliar_compras · gerente_compras · encargado_operaciones | red + su categoría |
`finanzas` | tesorería · cobranza · egresos · presupuestos | red + su área de gasto |
`contabilidad` | contabilidad · fiscal | red |
`prevencion` | prevención / auditoría de inventarios | red, lectura + hallazgos |
`marketing` | mercadotecnia · auxiliar_mkt | zona o red |
`rh` | auxiliar_rh · checador | su sitio |
`cliente_b2b` | — (externo) | su cliente |
`auditor_externo` | — (externo) | contabilidad + finanzas, lectura, **con vencimiento** |

### Complementos (se suman al perfil base)

`captura_gastos` (22 personas hoy) · `arqueo_caja` · `etiquetas_anaquel` ·
`captura_caducidades` · `inventario_fisico` · `aprobador_requisiciones` ·
`aprobador_pagos` · `validador_evidencia`.

Un complemento es **una tarea con 1-3 permisos** que se le da a alguien
independientemente de su puesto. Es exactamente lo que hoy se disfraza de rol.

---

## 6. Qué NO cambia

- **El alcance ya está resuelto** (ADR-050): 6 dimensiones, `role_scopes` +
  `user_scopes`, fail-closed, `ScopeService` como único punto de aplicación, y el
  arnés `snapshot-user-scope.js` que prueba que nadie pierde acceso.
- **Los permisos siguen en el JWT** (cambio ⇒ re-login) y **el alcance en la DB**
  (cambio ⇒ 30s de TTL, sin re-login).
- **RLS se queda en `tenant_id`**, no se usa para alcance.

---

## 7. Plan por sprints

| Sprint | Qué | Estado | Verificación |
|---|---|---|---|
`[ID.13]` | `users.kind` + `identity.user_roles` N:M (con `role_name` como perfil base, compatible) | ✅ | smoke 34/34: unión de permisos, trigger bidireccional, degradación del perfil anterior |
`[ID.14]` | Normalizar el catálogo: renombrar a función, fusionar, retirar los muertos | ✅ | `snapshot-user-permissions`: **0 pierden**, 14 ganan (máx +2) |
`[ID.15]` | `positions.default_role`; el alta propone departamento y perfil | ✅ | 23/43 puestos proponen perfil; los 20 restantes reportados |
`[ID.16]` | Permisos de **RH** + workspace en `authz-tree` + perfil `rh` | ⚠️ BLOCKED | no hay módulo `hr` en `libs/` ni pantalla: el permiso no gatearía nada |
`[ID.17]` | Perfil `direccion` (lectura global) + `auditor_externo` con `expires_at` | bajo | smoke: escritura denegada en los 99 módulos |
`[ID.18]` | **Cuentas de servicio**: los feeds dejan de escribir sin identidad; `created_by` real | medio | los importers escriben con su cuenta |
`[ID.19]` | `person_id` → `identity.people`; la UI muestra "misma persona, 2 cuentas" | medio | las 6 personas duplicadas colapsan a 6 registros |
`[ID.20]` | Higiene de contraseñas: rotar los 2 hashes compartidos por 10 cuentas + `must_change_password` | bajo | ningún hash repetido |

**MVP = ID.13 + ID.14 + ID.15.** `[ID.16]` cambió de forma al ir a construirlo:
**`hr.*` no tiene módulo ni pantalla**, así que los permisos `RH_*` gatearían el
vacío. Lo que hace falta primero es el módulo de asistencia; los permisos salen
con él, en el mismo sprint, con la receta de 6 touch-points.

Dos cosas que se decidieron distinto al construir:

- **`positions.default_scope` no se hizo.** El alcance por default ya vive en
  `identity.role_scopes` (por rol, desde `[ID.3]`); duplicarlo en el puesto
  crearía dos fuentes de verdad para la misma pregunta, y cuando se contradicen
  gana la que nadie recuerda.
- **`superadmin` no se renombró a `admin_plataforma`.** Ese nombre está escrito
  como literal en `ELEVATED_ROLES` y en `isPlatformAdminRole`; renombrarlo sin
  tocar el código deja a los 7 gods sin god-mode. Se consolidó `admin` dentro de
  `superadmin` (con unión de permisos) y se retiró `sistemas`.

Precondición heredada de la auditoría de campos: **`commercial.warehouses.zone_id`**
(sin eso `gerente_zona` no puede expandir zona → sucursales) y la **topología de
camiones** (`source_warehouse_id`) para el eje ruta de los 34 de Rutas.

---

## 7bis. `[ID.21-23]` — El permiso baja a la persona y el alta pregunta menos

Los tres sprints salen de la misma observación de Edgar: **el puesto debería dar
el estándar, y la persona debería poder diferir de él**. Hasta acá el permiso
sólo existía a nivel rol, y ese es el origen medible de los 47 roles.

### `[ID.21]` Permisos por persona

    efectivos = unión(perfil base + complementos)  ±  overrides de la persona

`identity.user_permissions` guarda **la diferencia**, no el conjunto: `allow=true`
es "de más", `allow=false` es "de menos", y el override **gana** sobre el rol (al
revés no serviría de nada). El rol sigue siendo el paquete del puesto — se edita
una vez y aplica a los 20 que lo tienen.

Por qué la diferencia y no el set completo: hace legible la pantalla. Se puede
decir *"tiene 2 permisos de más que su puesto"* en vez de obligar a comparar 162
casillas contra las de un compañero. El caso que lo motivó, medido: **`cajero` son
27 personas con los mismos 3 permisos**; para que una viera costos había que
inflarle el rol a las 27, clonar el rol para una sola, o abrirle otra cuenta.

Tres cosas que el service **rechaza** en vez de dejar pasar:

1. **Overrides sobre `superadmin`/`admin`.** `buildAbility` les da `manage:all` y
   el guard corta ahí, antes de mirar el mapa: un `allow=false` quedaría guardado
   y no haría nada. Peor que no poder, porque el admin cree que revocó.
2. **Otorgar lo que quien edita no tiene.** Con `USUARIOS_GESTIONAR` alcanzaba
   para darse cualquier permiso del sistema.
3. **Editarse los permisos propios** (salvo superadmin, que ya tiene todo).

Y el detalle que hace que "dinámico" sea verdad: los permisos viajan en el JWT
(ADR-050), así que el backend aplicaba el cambio en ≤30s pero **el menú seguía
mostrando lo de antes hasta re-login**. `GET /users/me/access` devuelve los
permisos vigentes y el front refresca al arrancar. **Ni el endpoint ni el front
aceptan un mapa vacío**: reemplazar el snapshot con `{}` dejaría a la persona sin
menú — un fail-closed en el camino de arranque. Ante la duda gana el JWT.

### `[ID.22]` El puesto manda

El alta pedía 5 cosas y tres eran consecuencia de otra. Ahora el puesto va
primero, y el departamento y el nivel de acceso se derivan de él. Regla única
para los dos: **si el valor coincide con lo que el puesto propone, no se
pregunta.** El select aparece cuando falta, cuando el puesto no propone nada (los
12 sin perfil) o cuando el valor **diverge** — porque una divergencia es una
decisión que alguien tomó, y esconderla es cómo el dato se queda viejo.

### `[ID.23]` Sucursal → zona

`commercial.warehouses.zone_id` (la precondición que la auditoría de campos ya
había marcado). Lo que la data dijo, y que contradice "es lo mismo con dos
nombres":

- 8 zonas vs 7 sucursales. No hay biyección.
- `LA PIEDAD RD` tiene **3 sucursales** (01, 02, 03): la zona no está contenida
  en una sucursal, es la plaza que las tres comparten. Sucursal → zona es una
  función; al revés no.
- **4 zonas no tienen sucursal**: `MORELIA ABASTOS` y `MORELIA MADERO` son los
  almacenes sin código Kepler (MD-30/MD-32), y `ZAMORA VECINAL` / `LA PIEDAD
  VECINAL` **no son un lugar sino un tipo de ruta** sobre la misma plaza.
- De 143 usuarios: 75 tienen zona, 37 sucursal, **8 las dos**.

Por eso la columna vive en la sucursal y la zona del usuario **sigue existiendo**:
para el vendedor de ruta vecinal la zona es su territorio, no la tienda donde está
parado. El formulario hace **una** pregunta en el caso normal y dos sólo cuando
divergen de verdad. `04 Yurécuaro` queda sin plaza a propósito: no hay zona que le
corresponda y elegirle una sería inventarla.

**Lo que ya existía y no había que construir:** "ver otras sucursales" es alcance,
no permiso — `identity.user_scopes` dimensión `warehouse` con `mode='listed'` lo
resuelve desde `[ID.2]`, y cambiarlo **no exige re-login** (TTL 30s). Lo que falta
es la UI: hoy ningún componente del front llama a `/users/:id/scope` (`[ID.6]`).

---

## 8. Decisiones que necesito

1. **¿`user_roles` N:M?** Es el cambio de fondo. Sin él, la encargada-cajera sigue
   necesitando dos cuentas y `captura_gastos` sigue siendo un rol.
2. **¿Consolido los 3 roles-dios en uno** y le doy a dirección un perfil de lectura?
3. **¿Retiro los 13 roles muertos** (soft-delete, reversible)?
4. **¿Abro RH** en el sistema de permisos? `hr.*` ya está construido y no tiene puerta.
5. **Cuentas de POS** (`04`, `03`, `42dmar`): ¿son de la **persona** o de la
   **terminal**? Define si se renombran o se atan a `person_id` por turno.
6. **¿Auditor externo y proveedor** entran en el alcance del ERP o quedan para después?
