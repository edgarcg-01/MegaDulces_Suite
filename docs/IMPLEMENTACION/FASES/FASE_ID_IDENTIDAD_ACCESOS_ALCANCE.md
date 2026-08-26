# Fase ID — Identidad, Accesos y Alcance de Datos

> **Estado:** 🔨 DISEÑADO (planeación) · 2026-08-26 · diagnóstico **medido contra prod** (117 usuarios / 33 roles / 27 almacenes)
> **Tesis:** el proyecto nació como auditoría de rutas y la tabla de usuarios sigue teniendo esa forma. Para operar como ERP/CRM hay que separar **cuatro ejes ortogonales** — *persona · organigrama · permiso · **alcance*** — y volver el **alcance** (qué filas ve cada quien) un dato de primera clase: explícito, `fail-closed`, configurable por rol con override por usuario, y resuelto en **un solo lugar** en vez de en 41 módulos.
> **ADR propuesto:** ADR-050 — El permiso dice *qué acción*; el alcance dice *sobre qué filas*. Son dimensiones distintas, se almacenan distinto y se invalidan distinto (permiso = JWT → re-login; alcance = DB + TTL → sin re-login).
> **Continúa:** los items `[UN.*]` del tracker (que quedaron sueltos sin doc de fase). Hereda ADR-010 (multi-tenant), ADR-016 (el motor decide), Fase AZ (authz jerárquico).

---

## 1. De dónde viene la deuda

El sistema arrancó con un modelo de una sola forma: **una zona, un supervisor, un colaborador que captura**. `users.zona_id` alcanzaba para todo, y "el rol" era a la vez el puesto de la persona y su bundle de permisos.

Hoy hay **41 módulos**, 7 sucursales operando, proyectos de Compras / Finanzas / Contabilidad / Logística / Tienda / Televenta, y 117 usuarios — y la tabla de usuarios sigue siendo la de rutas con **10 columnas pegadas encima**. Cada vez que un módulo necesitó "que este usuario vea solo lo suyo", inventó su propio mecanismo. Hoy hay **seis mecanismos de alcance distintos** y ninguno compartido.

Esta fase no agrega features: **quita la ambigüedad**. El entregable que importa es poder responder, para cualquier usuario y sin adivinar: *¿qué ve exactamente, y por qué?*

---

## 2. Diagnóstico (medido en prod, 2026-08-26)

### 2.1 El alcance es implícito y **fail-open** ← el hallazgo central

| Medición | Valor |
|---|---|
| Usuarios totales (activos) | **117** |
| Sin `warehouse_code` (= "ve todas las sucursales") | **83** (71%) |
| Sin `zona_id` | **42** (36%) |
| Usuarios en CEDIS `00` o Canindo `06` | **0** |
| Usuarios desactivados alguna vez (`activo=false`) | **0** |
| Usuarios borrados alguna vez (`deleted_at`) | **0** |

La convención vigente está escrita en el propio DTO: `"Sucursal Kepler ('00'..'05'). Vacío = ve todas (rol global)"`. O sea: **la ausencia de dato significa acceso ilimitado**. Al revés de lo que necesita un ERP.

Y el enforcement es por-controller. El patrón real, en [store-analytics.controller.ts:34](../../../libs/commercial/src/lib/commercial-analytics/store-analytics.controller.ts#L34):

```ts
const effective = user?.warehouse_code || warehouseCode || undefined;
```

Léase: *si el usuario tiene sucursal se le fuerza; si no la tiene, se respeta lo que venga por query param; si tampoco, sin filtro*. Consecuencias medibles:

1. Un alta nueva sin sucursal **ve la red completa** hasta que alguien se acuerde de asignarla. Pasó en `[UN.10.1]`: las 22 cuentas de captura de gastos nacieron con departamento vacío.
2. No hay forma de expresar **"ve su sucursal + la 03"** (dos sucursales), ni **"ve toda la red pero escribe solo en la suya"**, ni **"ve su zona"** (que son 2-3 sucursales).
3. El `|| warehouseCode` significa que un usuario global puede pedir cualquier sucursal por URL — correcto para un gerente, invisible para un auditor.

### 2.2 Seis mecanismos de alcance, ninguno compartido

| Mecanismo | Dónde vive | Filas en prod | Quién lo aplica |
|---|---|---|---|
| `users.warehouse_code` (varchar) | `identity.users` | 34/117 | cada controller a mano (56 archivos del front lo tocan) |
| `users.warehouse_id` (uuid FK) | `identity.users` | 34/117 | casi nadie — **ni siquiera está expuesto en la vista `public.users`** |
| `users.zona_id` | `identity.users` | 75/117 | 10 servicios de `libs/trade` |
| `users.finance_expense_area_ids` (uuid[]) | `identity.users` | 7/117 | `expense-proofs`, `expense-comprobaciones` |
| `users.customer_id` | `identity.users` | 3/117 | `resolveCustomerIdFromCtx()` — **reimplementado por servicio** |
| `commercial.promoter_brands` (user × marca) | tabla puente | 0 | `promoter-brands.service` |
| `trade.vendor_sales_routes` (user × ruta) | tabla puente | 0 | nadie (tabla muerta) |

Dos columnas para el mismo hecho (`warehouse_code` + `warehouse_id`), un array ad-hoc, una tabla puente sin uso y otra sin filas. Cada nuevo módulo elige.

### 2.3 Dieciséis nombres para decir "qué sucursal"

Conteo de `@Query(...)` en los controllers:

| Param | Veces | | Param | Veces |
|---|---|---|---|---|
| `warehouse_id` | 45 | | `route_id` | 3 |
| `sucursal` | 20 | | `route` | 3 |
| `zona` | 9 | | `almacen` | 2 |
| `warehouse_ids` | 8 | | `zone_id` / `zone` | 1 / 1 |
| `warehouses` | 7 | | `zona_id` | 1 |
| `warehouse_code` | 6 | | `ruta_id` | 1 |
| `branch` | 4 | | `branch_store_id` | 1 |
| `routes` | 3 | | | |

**115 ocurrencias, 16 nombres.** Cuatro idiomas mezclados (`sucursal`/`branch`/`almacen`/`warehouse`) contra la convención de CLAUDE.md (English snake_case). Cada nombre distinto es un lugar donde el filtro se puede olvidar.

### 2.4 Los inputs repetidos (lo que reportaste)

**Backend — DTOs duplicados:**

| | `CreateUserDto` | `UpdateUserDto` |
|---|---|---|
| Campos | 10 | 12 |
| Duplicados literal | **9** (`username`, `password`, `nombre`, `zona`, `zona_id`, `role_name`, `supervisor_id`, `department_code`, `position_code`, `warehouse_code`) | |
| Asimetrías | no puede setear `finance_expense_area_ids` ni `activo` | no exige `department_code` (el create sí) |

Y **`zona` + `zona_id` son dos entradas para el mismo hecho**: el form tiene los dos controles y una suscripción a `valueChanges` que traduce el nombre a UUID. El DTO acepta ambos.

Bonus: el `@Matches(/^[0-9]{2}$/)` de `warehouse_code` acepta `'99'` — valida *forma*, no *existencia*. Y el texto dice `'00'..'05'` cuando hay 7 sucursales (`00`..`06`).

**Frontend — sin componente compartido:**

| Medición | Valor |
|---|---|
| Archivos del front que tocan `warehouse_code` | **56** |
| Componente compartido de selector de sucursal | **no existe** (`shared/components/` tiene 16 y ninguno es este) |
| Controles del form de usuario escritos a mano | 13, espejo manual del DTO |
| Copias del enum `Permission` | **5** — `platform-core` 162 · `view` 162 · `vendor` 60 · `portal` 54 · `shared-auth` **36 (muerto)** |

Cada pantalla que filtra por sucursal reimplementó su dropdown, y ninguno sabe qué sucursales puede ver el usuario que lo está mirando.

### 2.5 Restos de la era rutas

- `meta_puntos`: 1 valor distinto en 117 filas (meta de puntos del colaborador de ruta).
- `created_by`: **0/117** — nunca se llenó. No sabemos quién dio de alta a nadie.
- `activo`: `true` en los 117, incluidas las **9 cuentas POS muertas** identificadas en `[UN.2]`. No hay ciclo de vida: no existe "suspendido", "baja", ni "invitado".
- `public.users` (la vista que lee el login) expone **24 de las 25 columnas**: le falta `warehouse_id`, agregada después sin actualizar la vista.
- `commercial.warehouses` tiene **27 filas**: 7 sucursales reales + `MD-30`/`MD-32` + 13 `RUTA-*` + 5 borradas. Un selector de "sucursal" sobre esa dimensión ofrece rutas.
- CEDIS `00` tiene **`kepler_code` NULL** (rompe el crosswalk al ERP).
- **10 usuarios comparten 2 hashes bcrypt** (`[UN.7]`). No hay `must_change_password`.
- **33 roles para 117 usuarios**, 14 sin ningún usuario (`[UN.5]`). El rol sigue haciendo dos trabajos: título del puesto y bundle de permisos.

### 2.6 Cinco padrones de personas sin llave común

| Padrón | Filas |
|---|---|
| `identity.users` | 117 |
| `wincaja.vendedores` | 140 |
| `logistics.drivers` | 56 |
| `erp.staff` | 9 |
| `hr.employees` | 0 (feed sin correr en prod) |

La misma persona aparece hasta 3 veces sin forma de saber que es la misma (`[UN.8]`).

---

## 3. Modelo objetivo

### 3.1 Los cuatro ejes

| Eje | Responde | Hoy | Después |
|---|---|---|---|
| **Persona** | ¿quién es? | `users.nombre` + 4 padrones sueltos | `identity.people` + `users.person_id` |
| **Organigrama** | ¿dónde está en la empresa? | `department_code`, `position_code`, `supervisor_id` ✅ | igual (ya normalizado en `[UN.1]`) |
| **Permiso** | ¿qué **acciones** puede? | `role_name` → JSONB ✅ | igual (no se toca) |
| **Alcance** | ¿sobre **qué filas**? | 6 mecanismos dispersos ❌ | `role_scopes` + `user_scopes` |

El punto del ADR: **el permiso y el alcance no son lo mismo y no se invalidan igual.** `COMMERCIAL_INVENTORY_VER` dice "puede ver existencias"; el alcance dice "las de la sucursal 03". Hoy los dos viven mezclados en el rol, y por eso hay 33 roles: cada combinación de permiso × sucursal terminó siendo un rol nuevo.

### 3.2 Schema propuesto

```sql
-- Catálogo de dimensiones. Nace con 6 filas; agregar una es un INSERT, no código.
identity.scope_dimensions (
  code        text PK,          -- warehouse | zone | route | brand | expense_area | customer
  label       text NOT NULL,
  ref_table   text NOT NULL,    -- commercial.warehouses | trade.zones | ...
  ref_key     text NOT NULL,    -- code | id
  orden       int
);

-- Default por ROL: se configura una vez, aplica a todos los del rol.
identity.role_scopes (
  tenant_id uuid, role_name text, dimension text,
  mode       text NOT NULL,     -- all | listed | own | none
  values     text[] ,           -- solo si mode='listed'
  mode_write text,              -- NULL = igual que `mode`
  PRIMARY KEY (tenant_id, role_name, dimension)
);

-- Override por USUARIO. Gana sobre el rol.
identity.user_scopes (
  tenant_id uuid, user_id uuid, dimension text,
  mode text NOT NULL, values text[], mode_write text,
  granted_by uuid, granted_at timestamptz, nota text,
  PRIMARY KEY (tenant_id, user_id, dimension)
);
```

**Resolución:** `user_scopes` → `role_scopes` → `none`. Cuatro modos:

| `mode` | Significa |
|---|---|
| `none` | no ve nada de esa dimensión (**default si no hay fila**) |
| `own` | lo que dice su propia ficha (`users.warehouse_code`) — evita repetir el valor en cada fila |
| `listed` | exactamente los valores de `values[]` (permite "la suya + la 03") |
| `all` | toda la dimensión (rol global, explícito) |

**`mode_write` separado** es lo que hoy no se puede expresar y un ERP necesita: *"el supervisor de zona **ve** las 3 sucursales de su zona pero **captura** solo en la suya"*. Va en el schema desde el día 1 aunque se aplique después — agregarlo luego obliga a re-migrar.

**`fail-closed` con materialización.** Sin fila = `none`. Por eso la migración de arranque es obligatoria: **materializa como `all` explícito el permiso implícito que hoy tienen los 83 usuarios sin sucursal**, para que nadie pierda acceso el día del deploy. Misma disciplina que `[UN.13]`: primero el backfill que preserva, después el corte. Sin eso, el deploy es un apagón.

### 3.3 Un solo punto de aplicación

- **`ScopeResolver`** en `libs/platform-core`: resuelve las 6 dimensiones **una vez por request** y las deja en el CLS junto al `tenantId` — `TenantContextService` ya es exactamente ese lugar (hoy lleva `tenantId`, `userId`, `username`, `roleName`).
- **Un helper de query**, no 41 implementaciones:
  ```ts
  scoped(qb, 'warehouse', 'i.warehouse_code')   // agrega el WHERE que corresponda
  ```
- **`@ScopeDimension('warehouse')`** en el controller para declarar qué dimensión aplica, y un **test de cobertura** que falla si un endpoint que consulta una tabla con `warehouse_code` no la declara. Esto es lo que evita que la fuga vuelva: el mismo tipo de test que faltó y produjo las fugas de Finanzas (`[UN.4]`) y Compras (`[UN.11]`).
- **El alcance NO va en el JWT.** Son arrays que cambian y el token ya carga 162 permisos + rules de CASL. Va en DB con cache TTL (como el `permsCache` de 30s). Efecto práctico y deseado: **cambiar un alcance no exige re-login; cambiar un permiso sí.** Hay que decirlo en la UI, porque hoy todo exige re-login y nadie lo sabe.
- **RLS no se usa para esto.** RLS ya fuerza `tenant_id` y ahí se queda: hacer alcance con RLS exigiría 6 GUCs y policies por tabla en ~200 tablas, y `analytics.*` no tiene RLS por diseño. El alcance vive en la capa de query, y eso queda escrito en el ADR para que nadie lo "arregle" después.

### 3.4 Frontend: un input, no 56

- `shared/components/scope-picker/` con `<md-branch-select>` (y hermanos por dimensión). Lee un `ScopeStore` alimentado por **`GET /me/scope`**, así que:
  - muestra **solo** lo que el usuario puede ver,
  - si su alcance es un solo valor, **se auto-selecciona y se deshabilita** (deja de ser una decisión),
  - si es `all`, ofrece "Todas" + la lista.
- **Contrato canónico de params:** `warehouse_codes` (CSV), `zone_ids`, `route_codes`. Capa de alias que sigue aceptando los 16 nombres viejos y loguea la deprecación — nada se rompe, todo converge.
- La dimensión "sucursal" se sirve de `commercial.warehouses` **filtrada por `kind='branch'`** (columna nueva), para que los 13 almacenes-ruta dejen de aparecer.

### 3.5 DTO único

`UserWriteDto` como base compartida; `CreateUserDto extends` con los `required`; `UpdateUserDto = PartialType(UserWriteDto)`. Se va `zona` (queda `zone_id`, con alias temporal). `warehouse_code` se valida **contra el catálogo**, no con un regex. Y un test que compara las claves del `FormGroup` con las del DTO, para que no vuelvan a divergir.

### 3.6 Ciclo de vida e historia

- `status`: `invited | active | suspended | terminated`. `activo` queda como **columna GENERATED** (`status='active'`) para no tocar los 41 módulos que la leen — el patrón ya probado en `[K-debt]`.
- `must_change_password`, `password_changed_at`, `terminated_at` → cierra `[UN.7]` (10 usuarios con hash compartido) con flujo, no con un reset manual.
- **`identity.user_events`**: alta, baja, cambio de rol, cambio de alcance, reset de contraseña — con quién, cuándo y desde dónde. Hoy `created_by` está vacío en los 117: no hay rastro de nada.

### 3.7 `identity.people`

Crosswalk de los 5 padrones (`[UN.8]`), con `person_id` en `users`, `drivers` y el match a `wincaja.vendedores` / `erp.staff`. Habilita cosas que hoy no se pueden: "este vendedor de Wincaja es este usuario y este chofer", asistencia de checadores ligada al usuario, y el organigrama validado contra las 120 plazas del PDF.

---

## 4. La pantalla `/admin/usuarios` objetivo

Master-detail (Operations, density compact++, sin ilustraciones — `DESIGN.md`).

**Tabla:** navegador por departamento (ya está) + columnas *Persona · Puesto · Rol · Alcance · Última actividad · Estado*. La columna **Alcance** es la que hoy no existe: muestra `CEDIS+3` / `Todas` / `Su sucursal` de un vistazo.

**Filtros:** departamento, puesto, rol, sucursal, zona, estado, sin-departamento, sin-alcance, sin login en 90 días.

**Panel de detalle en 4 pestañas, espejando los 4 ejes:**
1. **Persona** — nombre, username, contacto, padrones ligados.
2. **Organigrama** — departamento, puesto, jefe, sucursal base.
3. **Acceso** — rol + los permisos que trae (read-only, se editan en `/admin/roles`).
4. **Alcance** — las 6 dimensiones con su `mode`, de dónde viene cada una (**heredado del rol** vs **override**), y quién lo otorgó.

**Las dos features que cambian la operación:**

- **"Acceso efectivo"** — la respuesta explicada: *ve existencias (rol `auxiliar_sucursal` → `COMMERCIAL_INVENTORY_VER`) de la sucursal 03 (heredado del rol) y de la 05 (override tuyo del 12-ago)*. Explicable, no un tablero de checkboxes opaco.
- **"Ver como"** — abrir la app en modo lectura con el alcance de ese usuario. Mata el ciclo *asigno → pido que re-loguee → me dice que no era*.

**Acciones masivas:** asignar departamento / puesto / sucursal, forzar cambio de contraseña, suspender. Los 22 usuarios de `[UN.10.1]` sin departamento son el caso de prueba.

---

## 5. Sprints

Ruta crítica en negrita. Cada sprint cierra con el snapshot de no-regresión verde.

| # | Sprint | Entrega | Depende |
|---|---|---|---|
| **ID.0** | **Inventario y arnés** | Extender `snapshot-user-privileges.js` a **snapshot de alcance** (usuario → qué filas ve por dimensión, hoy). Es el test de aceptación de toda la fase: sin esto no se puede probar que nadie perdió ni ganó acceso. | — |
| **ID.1** | **Schema de alcance** | `scope_dimensions` (6) + `role_scopes` + `user_scopes` + `warehouses.kind` + `public.users` con `warehouse_id`. Aditivo, RLS forzado, sin tocar nada vivo. | ID.0 |
| **ID.2** | **`ScopeResolver` + helper** | Resolución en CLS, cache TTL, `scoped(qb, dim, col)`, `GET /me/scope`. Todavía **nadie lo usa** — se despliega inerte. | ID.1 |
| **ID.3** | **Migración de no-regresión** | Materializa el estado actual: los 34 con sucursal → `own`; los 83 sin sucursal → `all` **explícito**; `finance_expense_area_ids` → `listed`; `customer_id` → `own`. Snapshot ID.0 debe dar **cero delta**. | ID.2 |
| **ID.4** | **Primer dominio real** | Aplicar el resolver a **Tienda/Inventario** (el que más pide alcance por sucursal) y borrar ahí el `user?.x \|\| query.x`. Un dominio, medido, antes de tocar los otros. | ID.3 |
| ID.5 | Contrato de params | `warehouse_codes`/`zone_ids`/`route_codes` canónicos + capa de alias con log de deprecación para los 16 nombres. | ID.2 |
| ID.6 | `<md-scope-picker>` | Componente compartido + `ScopeStore`; migrar los 3 pantallas de mayor uso. Las 53 restantes van por goteo. | ID.5 |
| ID.7 | DTO único + form | `UserWriteDto` base, muere `zona`, validación contra catálogo, test form↔DTO. | ID.1 |
| ID.8 | Ciclo de vida | `status` + `activo` GENERATED + `must_change_password` + `identity.user_events`. Cierra `[UN.7]` y da de baja las 9 cuentas POS muertas. | ID.1 |
| ID.9 | Pantalla nueva | Master-detail 4 pestañas + Acceso efectivo + acciones masivas. | ID.3, ID.7 |
| ID.10 | "Ver como" | Impersonación read-only auditada. | ID.9 |
| ID.11 | `identity.people` | Crosswalk de los 5 padrones (`[UN.8]`). | ID.1 |
| ID.12 | Limpieza | Enum `Permission` a fuente única (muere `shared-auth`, 36 claves), archivar los 14 roles sin usuarios (`[UN.5]`), tirar `meta_puntos`. | ID.7 |

**MVP = ID.0 → ID.4.** Es lo mínimo que convierte el alcance en un dato real y lo prueba en un dominio. ID.5–ID.9 es lo que se nota en el uso diario. ID.10–ID.12 es deuda.

---

## 6. Riesgos y gotchas

| Riesgo | Mitigación |
|---|---|
| **`fail-closed` sin materializar = apagón** para 83 usuarios | ID.3 es obligatoria y va **antes** del deploy de ID.4. Orden verificado con el snapshot de ID.0, como en `[UN.13]`. |
| 41 módulos que filtran a mano | No se migra de golpe: **dimensión por dimensión, dominio por dominio**. El resolver se despliega inerte en ID.2. |
| Dos semánticas de invalidación (permiso=re-login, alcance=TTL) | Decirlo en la UI de `/admin/usuarios`, y que el toast al guardar diga cuál aplica. |
| `commercial.warehouses` contaminada con almacenes-ruta | `kind` en ID.1; el picker filtra `kind='branch'`. |
| CEDIS `00` con `kepler_code` NULL | Arreglarlo en ID.1 (afecta también a Fase CA). |
| Regresión silenciosa de permisos | El snapshot de privilegios ya existe y funciona; ID.0 lo extiende a alcance. |
| `public.users` es vista leída en login **sin contexto de tenant** | Nada de JOINs ahí. Las columnas nuevas se agregan con `CREATE OR REPLACE VIEW` (solo append) — gotcha ya vivido. |
| Enum `Permission` ×5 divergiendo | ID.12; mientras tanto, cada permiso nuevo toca las 2 copias vivas (recipe de 6 touch-points). |

---

## 7. Decisiones que necesito de Edgar

| # | Decisión | Mi recomendación |
|---|---|---|
| 1 | ¿`fail-closed` de verdad (ausencia = no ve nada)? | **Sí**, con la materialización de ID.3. Es el cambio de fondo; sin esto la fase no sirve. |
| 2 | ¿`mode_write` separado de lectura? | **Sí en el schema desde ID.1**, aplicarlo en ID.4+. Agregarlo después obliga a re-migrar. |
| 3 | ¿Alcance por **zona** que expanda a sucursales? (supervisor de zona ve sus 3 sucursales sin listarlas) | **Sí**, dimensión `zone` con expansión — si no, cada cambio de zona obliga a editar N usuarios. |
| 4 | ¿Default por rol + override por usuario, o solo por usuario? | **Rol + override**. Con 33 roles y 117 usuarios, configurar 117 veces es la garantía de que quede mal. |
| 5 | ¿`activo` boolean → `status` con GENERATED? | **Sí** (patrón ya probado en `[K-debt]`). |
| 6 | ¿Cuántos padrones unifica ID.11? | Arrancar con `users` + `drivers` + `wincaja.vendedores` (los 3 con volumen). `erp.staff` y `hr.employees` después. |
| 7 | Las 9 cuentas POS muertas: ¿`terminated` o borrado? | `terminated` — hay capturas históricas apuntando a ellas. |
| 8 | ¿Se borra `libs/shared-auth` (enum de 36 claves)? | **Sí**, está muerto y es una bomba de tiempo si alguien lo importa. |

---

## 8. Lo que esta fase **no** hace

- No toca los permisos ni el contenido de los roles: `role_permissions` queda como está (el alcance es un eje aparte).
- No fusiona roles. Reducir de 33 a ~12 es consecuencia natural de tener alcance separado, pero es una decisión comercial posterior.
- No mete RLS por sucursal (ver §3.3).
- No toca CORS ni credenciales (bloqueado por decisión de 2026-05-26).
