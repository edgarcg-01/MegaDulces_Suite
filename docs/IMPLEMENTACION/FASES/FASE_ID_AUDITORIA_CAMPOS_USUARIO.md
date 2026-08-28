# `[ID.9b]` — Auditoría de los campos de `identity.users`

> **Medido contra prod el 2026-08-27** · 29 columnas · 117 usuarios vivos.
> **Pregunta que responde:** qué campo sobra, qué falta, y qué se puede derivar en vez de guardar.
> **Disparador:** *"la sucursal ya va asociada a la zona. necesito que hagas un análisis de los campos que tienen ahora los usuarios, para que sepas qué quitar o agregar"* (Edgar).

---

## 1. El hallazgo principal: el eslabón zona ↔ sucursal no existe en la DB

La jerarquía que planteás es correcta — **una sucursal pertenece a una zona** — pero
hoy **no está escrita en ningún lado**:

```
commercial.warehouses: id · tenant_id · code · name · address · is_default · active
                       kind · owner_user_id · fiscal_address · latitude · longitude
                       source_warehouse_id · kepler_code · wincaja_source_branch · sells_to_public
                       ↑ NO hay zone_id
```

Por eso el usuario carga **las dos cosas** (`zona_id` **y** `warehouse_code`), y por eso
se pueden contradecir. Medido en los 35 usuarios que tienen sucursal:

| Zona del usuario | Sucursales que aparecen |
|---|---|
`LA PIEDAD RD` | **01, 02 y 03** |
`OFICINAS` | **02** ← incoherente: Oficinas no es una zona de venta |
`(sin zona)` | 01, 02, 03, 04, 05 |
`ZAMORA` | 05 |

Que `LA PIEDAD RD` abarque 01/02/03 es **correcto** (1 zona → N sucursales). Que un
usuario de `OFICINAS` tenga sucursal 02 es **incoherente**, y hoy nada lo impide.

**Lo que hay que agregar:** `commercial.warehouses.zone_id`. Con eso:

- la zona del usuario **se deriva** de su sucursal → `users.zona_id` deja de ser un dato
  a mantener y pasa a ser un JOIN;
- la incoherencia se vuelve **imposible** en vez de invisible;
- un supervisor de zona se puede scopear a su zona y que el sistema expanda a las
  sucursales que la componen — hoy no se puede porque nadie sabe cuáles son.

---

## 2. Las 29 columnas, con veredicto

Llenado sobre 117 usuarios vivos. "Archivos" = archivos `.ts` que mencionan el nombre.

### Identidad — se quedan

| Columna | Llenos | Dist | Veredicto |
|---|---|---|---|
`id` `tenant_id` | 117 | 117 / 1 | ✅ |
`username` | 117 | 117 | ✅ **26 son códigos de POS** (`42gernta`, `44c02`, `5452`) — legible es otra discusión |
`password_hash` | 117 | **109** | ✅ pero **10 usuarios comparten 2 hashes** (`[UN.7]`) |
`nombre` | 115 | 115 | ✅ faltan 2 |

### Organigrama — se quedan, es el eje de control

| Columna | Llenos | Veredicto |
|---|---|---|
`department_code` | **116** | ✅ el eje que separa Tienda / Rutas / Administrativo |
`position_code` | 70 | ✅ faltan 47 |
`supervisor_id` | 31 | ✅ pero 4 valores distintos: la jerarquía está a medio cargar |

### Sucursal / zona — acá está la duplicación

| Columna | Llenos | Dist | Archivos | Veredicto |
|---|---|---|---|---|
`warehouse_code` | 35 | 5 | 109 | ✅ **fuente única** — es lo que valida el DTO y lo que usa la dimensión de alcance |
`warehouse_id` | 34 | 5 | 100 | ⚠️ **mismo hecho, dos columnas.** Ya se desincronizó: `ivette_cruz` tiene `code=03` y `warehouse_id` vacío, porque se escribió una sola. Dejar una y derivar la otra |
`zona_id` | 75 | 8 | 25 | ⚠️ **derivable** en cuanto exista `warehouses.zone_id`. Mientras no exista, se queda |

### Ciclo de vida — recién puesto en `[ID.8]`

| Columna | Llenos | Veredicto |
|---|---|---|
`status` | 117 (todos `active`) | ✅ fuente de verdad |
`activo` | 117 (todos `true`) | ⚠️ **derivado de `status`** por trigger. Pasarlo a GENERATED necesita DROP+ADD (autorización) y romper 3 writers. **208 archivos lo leen** → el shim se queda un rato |
`must_change_password` | 117 (`false`) | ✅ infraestructura lista, sin usar |
`password_changed_at` | **0** | ✅ se empieza a llenar en las altas nuevas |
`terminated_at` | **0** | ✅ idem |
`deleted_at` `deleted_by` | **0** | ✅ nunca se dio de baja a nadie; convive con `status='terminated'` |

### Auditoría — el agujero

| Columna | Llenos | Veredicto |
|---|---|---|
`created_at` `updated_at` | 117 | ✅ |
`created_by` | **0/117** | ❌ **no sabemos quién dio de alta a nadie.** `[ID.8]` ya lo llena en las altas nuevas |
`updated_by` | 74 | ⚠️ 2 valores distintos |
`last_login_at` | 72 | ✅ útil: 45 usuarios **nunca entraron** |
`last_login_ip` | 72 | ✅ 3 archivos |
`last_login_user_agent` | 72 | 🗑️ **1 archivo lo escribe, ninguno lo lee.** `text` sin tope útil. Candidato a quitar |

### Restos y casos especiales

| Columna | Llenos | Veredicto |
|---|---|---|
`finance_expense_area_ids` | 7 filas, **todas con array VACÍO** | 🗑️ **cero valores reales.** Su función la hace `user_scopes` dimensión `expense_area`. Migrar y quitar |
`customer_id` | 3 | ✅ enlace al portal B2B (`customer_b2b`) |
`meta_puntos` | 117 (todos **5000**) | ✅ **NO es basura**: `scoring-v2.service` la lee y Horus la escribe (`set_target`). Nadie la personalizó todavía. Es dominio Trade, no identidad — mudarla es opcional |

---

## 3. Qué QUITAR

Ordenado por relación beneficio / riesgo. **Ninguno se ejecuta sin autorización explícita**
(borrar columnas es regla del proyecto).

| # | Columna | Por qué | Antes hay que |
|---|---|---|---|
1 | `finance_expense_area_ids` | 0 valores reales; `user_scopes` la reemplaza | migrar los 7 (vacíos) y apuntar `expense-proofs` al `ScopeService` |
2 | `last_login_user_agent` | se escribe y no se lee | nada |
3 | `warehouse_id` **o** `warehouse_code` | mismo hecho ×2, ya desincronizado | elegir cuál queda (recomiendo `code`) y derivar la otra por vista |
4 | `zona_id` | derivable de la sucursal | crear `warehouses.zone_id` y migrar los 25 archivos que la leen |
5 | `activo` | derivada de `status` | que ningún writer la toque; después DROP+ADD como GENERATED |

---

## 4. Qué AGREGAR

| # | Qué | Por qué | Prioridad |
|---|---|---|---|
1 | **`commercial.warehouses.zone_id`** | el eslabón que falta; vuelve la zona derivable y hace imposible la incoherencia | 🔴 alta — desbloquea el punto 4 de arriba |
2 | **Ruta / camión del vendedor** | los **34 de Rutas** no tienen dónde guardar su eje de control. Va como dimensión `route` de `user_scopes` + `warehouses.source_warehouse_id` para saber de qué sucursal cuelga cada camión | 🔴 alta — es lo único que traba a 34 usuarios |
3 | **Contacto: `email` y `telefono`** | **no existe ninguno de los dos.** Sin email no hay recuperación de contraseña ni aviso; sin teléfono no hay WhatsApp ni forma de avisarle a un vendedor | 🟡 media |
4 | `person_id` → `identity.people` | la misma persona está hasta 3 veces (`users` 117 · `wincaja.vendedores` 140 · `logistics.drivers` 56 · `erp.staff` 9) | 🟡 media (`[ID.11]`) |
5 | `warehouses.zone_id` + expansión de zona en el alcance | un supervisor de zona ve sus sucursales sin listarlas una por una | 🟢 sigue al punto 1 |

---

## 5. Cómo queda el modelo si se hace todo

```
PERSONA        identity.people ← person_id
IDENTIDAD      username · password_hash · email · telefono · status · must_change_password
ORGANIGRAMA    department_code · position_code · supervisor_id
UBICACIÓN      warehouse_code            (la zona SE DERIVA de la sucursal)
ALCANCE        identity.user_scopes      (warehouse · zone · route · brand · expense_area · customer)
AUDITORÍA      created_by · updated_by · last_login_* · identity.user_events
TRADE          meta_puntos               (scoring; podría mudarse a su dominio)
PORTAL         customer_id
```

De 29 columnas a ~20, sin perder nada: lo que se va es duplicado (`warehouse_id`,
`zona_id`, `activo`), muerto (`finance_expense_area_ids`, `last_login_user_agent`) o
derivable.

---

## 6. Decisiones que necesito

1. **`warehouses.zone_id`**: ¿lo creo y cargo la zona de cada una de las 7 sucursales? Es el desbloqueo de todo lo demás.
2. **Sucursal: `code` o `id`?** Recomiendo `code` (es lo que ya usan el DTO, la dimensión de alcance y Kepler) y dejar `warehouse_id` como derivado.
3. **`email` / `telefono`**: ¿se agregan? Sin eso no hay reset de contraseña autoservicio.
4. **Los 34 de Rutas**: ¿cargamos la sucursal madre de los 13 camiones (`source_warehouse_id`)? Con eso salen derivados.
5. **Bajas**: `status='terminated'` y `deleted_at` conviven. ¿`terminated` es la baja y `deleted_at` se reserva para borrado real?
