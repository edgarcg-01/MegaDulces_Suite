# FASE MS.7 — La Mesa de Servicio multi-área: empezar por Mantenimiento

> **Estado:** 🧪 **MS.7.1 y MS.7.6 EN CÓDIGO 2026-10-06** (el resto: 📋 diseñado). Ver §9. **Decisiones de Sistemas del 2026-10-06 incorporadas** (M2, M3, M4, M5, M11 y lo de infraestructura; ver §2 y §7). Sub-fase de [`FASE_MS`](FASE_MS_MESA_DE_SERVICIO.md) (ADR-081); ocupa el renglón *«MS.7 más colas (Mantenimiento)»* que esa fase dejó reservado.
> **Origen:** pedido de Sistemas: agregar todos los departamentos de la empresa a la Mesa de Servicio, con **un responsable por área** que atienda cada orden. Se empieza por **Mantenimiento**. Llegó con un plan en dos archivos (`CLAUDE.md` + `PLAN_MANTENIMIENTO.md`, de la parte de Sistemas/Frank); este documento **lo contrasta con el código real** y lo adecua.
> **Para quién:** Sistemas (dueño de la Mesa), Frank (negocio de Mantenimiento), Edgar (revisión) y el dev que lo construya.

---

## 1. Lo medido antes de adecuar el plan

El plan original parte de que hay que *generalizar* una mesa que sólo sabe de TI. **La mitad de eso ya está hecho y la otra mitad es más delicada de lo que parece.** Medido en el repo (`main` al 2026-10-06):

| El plan dice | Lo que hay en el código | Consecuencia |
|---|---|---|
| 1.1 «generaliza el modelo para varias colas: tablas de cola, categoría…» | **Ya existe**: `servicedesk.queues`, `categories` (por cola), `requests.queue_id`, y `config-admin` ya crea/edita colas y categorías desde `/servicio/configuracion`. | 1.1 **se reduce** a lo que de verdad falta (ver §3). |
| 1.3 «permisos por cola; un técnico de Mantenimiento no ve tickets de TI» | ⛔ **No existe.** `SERVICIO_ATENDER`/`SERVICIO_COORDINAR` son claves **globales** y `puedeVer = esAgente \|\| es el solicitante` (`requests.service.ts:934`). `inbox`, `stats`, `reports`, `agents.listIn` (de donde salen los destinatarios de avisos, el ruteo y las alertas de SLA) no miran la cola. | **Es el cambio más delicado y va primero.** Sembrar Mantenimiento *sin* esto mete sus tickets —y sus fotos— en la bandeja de TI y al revés. |
| 1.6 SLA por cola y prioridad | `sla_policies` es **por prioridad y global del tenant** (`UNIQUE (tenant_id, priority)`). | Agregar la dimensión cola (con *fallback* al general). |
| 1.6 prioridad por «riesgo para personas × detiene la operación» | La matriz actual es **impacto × bloquea** (`domain/priority.ts`), distinta. | Modelo de prioridad **configurable por cola** (no un `if`). |
| 1.7 estados configurables por cola (Diagnóstico, Esperando refacción…) | Los estados viven en **11 CHECK de la base + una máquina pura global** (`request-state.ts`). `en_espera` ya pausa el reloj. | No se configuran por cola sin reescribir ambas capas. Resuelto (**M3**): misma máquina + motivo de pausa; sin «Diagnóstico». |
| 1.2 prefijo de folio `MTO` | El folio es `SRV-AAAA-NNNNN`, con CHECK `^SRV-…`, consecutivo **por año** y regex en el código. | Resuelto (**M2**): **un solo folio**. |
| 1.1 campos extra por cola | **No existe** (`requests` no tiene datos extra). | Tabla de definición + `requests.extra jsonb`. |
| 1.2 `is_test` | **No existe.** Los tickets de prueba de TI hoy se limpian a mano en el E2E. | Columna + acción de coordinación. |
| 1.2 «11 ubicaciones» | Ya hay **10**: CEDIS + 8 sucursales (`00`–`08`) + Oficinas (`OF`, `SD_UBICACIONES_EXTRA`). Falta **Estacionamiento CEDIS**. Las *zonas* no existen. | Un código extra (sin migración) + tabla de zonas. |
| 1.8 asignación por ubicación y categoría | `routing_rules` asigna por **categoría o palabra clave → persona**; ubicación no. | Sumar la dimensión ubicación y un responsable por omisión del área. |
| 1.8 reasignar entre colas | No existe (sólo se asigna a una **persona**). | Operación nueva `transferir`. |
| 1.9 correo + notificación interna | Existe el motor (correo, WhatsApp, campana). ⚠️ **`SMTP_*` y `S3_*` siguen sin configurar en prod** (sin ellos: sin correo y sin adjuntos), y la foto de Mantenimiento **depende de S3**. | Decisión de Sistemas: se quedan como están, **no son obligatorios** → la foto es **opcional** por ahora y el correo sigue como hoy. |
| 1.10 reporte mínimo | `reports.service` ya da abiertas por ubicación, tiempo por categoría y % en SLA. | Sólo falta filtrar por cola y excluir `is_test`. |
| Fase 2 «QR como el Inventario de Equipos» | **No hay inventario de equipos ni librería de QR** en este repo. Sí hay mantenimiento de **vehículos** (`logistics.vehicle_usage_maintenance`). | Fase 2 es una **fase propia** (ver §6), no un sprint más. |
| `CLAUDE.md` «copia a la raíz» | La raíz ya tiene un `CLAUDE.md` de ~100 KB que **es la memoria del proyecto**. | **No se copia ni se pega al final.** Las reglas útiles están en §8; el resto ya está cubierto por las del repo. |

**Lo que sí encaja tal cual:** la regla 1 («lo específico de un área es configuración, no código») es exactamente cómo se diseñó la Mesa (ADR-081: *sumar un área es una fila*); la regla 5 (`is_test`), las reglas de SLA/prioridad con pruebas automáticas, el SLA que se pausa, el cierre por confirmación con auto-cierre a 3 días (`settings.auto_close_days` ya vale 3) y «no romper TI».

---

## 2. Decisiones

Las marcadas ✅ las **resolvió Sistemas el 2026-10-06** (con la opción que se recomendaba, salvo donde se indica); las ⚠️ siguen abiertas y se confirman antes del sprint que las usa.

| # | Decisión | Recomendación y por qué |
|---|---|---|
| **M1** | **Dónde vive «quién atiende qué área».** | **Es un dato, no una clave de permiso:** tabla `servicedesk.queue_members (cola, persona, rol: coordinador \| técnico)`. Las claves `SERVICIO_ATENDER/COORDINAR` siguen siendo *capacidades* («puede atender / puede repartir») y la membresía dice *dónde*. Se administra **desde la pantalla** (`/servicio/configuracion`), como pidió Edgar para todo lo de personas. **Se rechaza** una clave por área (`SERVICIO_MANTENIMIENTO_ATENDER`): obligaría a tocar enum, árbol de permisos y roles por cada departamento, o sea exactamente el `if (cola === …)` que la regla 1 prohíbe. Efecto colateral bueno: **no hay permisos nuevos → no hace falta re-login.** |
| **M2** ✅ | **Folio.** | **Resuelto: un solo folio `SRV-AAAA-NNNNN` para todas las áreas**; la cola se ve como etiqueta en la lista y en la ficha. Razón: transferir un ticket TI→Mantenimiento *no cambia de folio* (el plan pedía «registrar el cambio de folio o la relación»: con folio único no hay nada que registrar), no se toca el CHECK, el consecutivo, el regex ni los enlaces de la campana. Si Frank exige `MTO-…`, el costo es: `queues.folio_prefix`, CHECK nuevo, consecutivo por `(prefijo, año)`, `parseFolio`, búsqueda y deep-links, **y** decidir qué pasa con el folio al transferir. |
| **M3** ✅ | **Estados de Mantenimiento.** | **Resuelto: «Diagnóstico» no se necesita.** Misma máquina para todas las áreas, más un **motivo de pausa** en `en_espera` (`proveedor`, `refaccion`, `aprobacion`, `solicitante`, `otro`). «Esperando refacción o proveedor» = `en_espera` + motivo (ya pausa el SLA). «Diagnóstico» = `en_proceso` (se ve por el hilo/nota). Sin estado nuevo: no se tocan los 11 CHECK ni la máquina. |
| **M4** ✅ | **Prioridad.** | `queues.priority_model`: `impacto` (el de hoy, default → TI sin cambios) o `riesgo_operacion` (la matriz de Mantenimiento). Se elige **por el valor configurado**, nunca por el nombre de la cola. «Crítica» del plan = `urgente` del sistema, y **resuelto: no se renombra** (en pantalla sigue «Urgente»; el enum no se toca). Y la regla de ADR-081 se mantiene: **la persona no cambia su prioridad**, sólo quien atiende (el plan dejaba que la persona «la baje a Baja»; es inocuo, pero es una excepción que no vale la pena). |
| **M5** ✅ | **SLA por cola.** | `sla_policies.queue_id` (NULL = general) con *fallback* cola → general. **Resuelto: todo en horario hábil** (`clock='business'`). Se siembra, como **propuesta sin calibrar** (D5 de la Mesa: primero miden), con «1 día» = 8 h hábiles = 480 min: **Urgente 60 / 240 · Alta 240 / 480 · Media 480 / 1,440 · Baja 1,440 / 4,800** (minutos hábiles; primera respuesta / resolución). ⚠️ **Dos lecturas a confirmar con Frank:** (a) «24 h» de Alta se tomó como **1 día hábil** (480 min); leído como 24 horas *hábiles* serían 1,440 min = 3 días y empataría con la resolución de Media; (b) con reloj hábil, una **Urgente fuera de horario (noche, domingo) no corre hasta la mañana** — en TI la urgente corre corrida. Es un campo editable por política: si Frank quiere la urgente corrida, se cambia en pantalla, sin código. |
| **M6** | **Transferir entre colas.** | **Mueve el mismo ticket** (mismo folio, hilo y adjuntos; no clona): cambia cola y categoría, quita la asignación, recalcula prioridad y SLA con la política de la cola nueva, deja un mensaje de sistema en el hilo (de→a, quién, por qué) y avisa a la cola destino. Lo puede hacer **quien coordina la cola de origen**. |
| **M7** | **Ubicaciones y zonas.** | `EC` = «Estacionamiento CEDIS» en `SD_UBICACIONES_EXTRA` (mismo mecanismo que Oficinas: sin migración, no toca `STORE_BRANCHES`). **Zonas** = tabla propia `servicedesk.zones` (bodega, andén, oficina, baños, exterior…) y `requests.zone_code` opcional; no es parte de la ubicación. |
| **M8** | **Tickets de prueba.** | `requests.is_test`; lo marca **la coordinación desde la ficha** (queda en el hilo), y se excluye de reportes, tablero, «Mi trabajo» y avisos. El «Prueba de tickets» (SRV-2026-00003) se marca **desde la pantalla**, no editando datos de prod a mano. |
| **M9** ✅ | **Responsable del área.** | **Resuelto: el responsable de Mantenimiento es Ubaldo Barajas Valencia** (personal de la empresa, **no** un proveedor externo). Es el miembro con rol **coordinador** (reparte y reasigna). Si una cola define `default_assignee_id`, los tickets sin regla le caen a esa persona; si no, quedan «Sin asignar» y los ven todos los miembros de la cola (el comportamiento actual de TI). **Nunca** se asigna a alguien que no sea miembro. |
| **M10** | **Escalamiento.** | Sigue **apagado** (`escalation_enabled`) hasta medir ~30 días por cola. Hereda D5. |
| **M11** ✅ | **¿Un coordinador ve todas las áreas?** | **Resuelto: se deja como está hoy.** El acceso es por membresía de cola; sólo el god-mode (por nombre de rol, ADR-054) ve todo. Quien hoy atiende TI se **respalda como miembro de TI** en la migración, para que nadie pierda acceso. Si más adelante Dirección quiere un acceso «todas las colas», será una membresía por cola (o una bandera `all_queues`), sin rediseño. |

---

## 3. Modelo de datos (todo aditivo e idempotente)

| Objeto | Cambio |
|---|---|
| `servicedesk.queue_members` | **Nueva.** `(tenant_id, queue_id, user_id, role ∈ {coordinador, tecnico}, active, audit)`, FK compuestas `(tenant_id, id)`, RLS forzado, `UNIQUE (queue, user)`. **Backfill:** todo usuario con `SERVICIO_ATENDER`/`COORDINAR` efectivo → miembro de `ti` (coordinador si tiene COORDINAR). |
| `servicedesk.queues` | `+ default_assignee_id uuid NULL`, `+ priority_model text NOT NULL DEFAULT 'impacto'` (CHECK). |
| `servicedesk.sla_policies` | `+ queue_id uuid NULL`; la unicidad pasa a `(tenant, queue, priority)` con `NULL` tratado como «general» (índice único de expresión). |
| `servicedesk.zones` | **Nueva** (`code`, `name`, `sort_order`, `active`). `requests.zone_code varchar(30) NULL`. |
| `servicedesk.queue_fields` | **Nueva:** definición de campos extra por cola (`code`, `label`, `type ∈ {boolean, select, text, photo}`, `required`, `options jsonb`, `feeds_priority`, `sort_order`). `requests.extra jsonb NOT NULL DEFAULT '{}'`. |
| `servicedesk.requests` | `+ is_test boolean NOT NULL DEFAULT false` (+ índice parcial), `+ pause_reason text NULL` (CHECK de valores). |
| `servicedesk.routing_rules` | `+ warehouse_code varchar(20) NULL`; se relaja `routing_rules_trigger_ck` (categoría **o** palabras **o** ubicación). |
| `servicedesk.request_messages` | El CHECK de `kind` admite `'transfer'` (el historial de transferencias es **mensaje de sistema**, no tabla nueva: es registro, sin UPDATE/DELETE). |
| Contrato | `SD_UBICACIONES_EXTRA` + `EC`; tipos de cola, miembro, campo y motivo de pausa en `libs/contracts`. |

**Sin permisos nuevos.** Las nuevas pantallas cuelgan de `SERVICIO_COORDINAR` (configuración, miembros, transferir, marcar prueba) y `SERVICIO_ATENDER` (bandeja), como hoy.

---

## 4. Plan por capas (BD → lógica → visual)

Orden de la Mesa: primero la base, luego la lógica con sus pruebas, al final la pantalla. **Regla de oro de la fase: la cola Mantenimiento NO se siembra hasta que MS.7.6 (acceso por cola) esté verificado** — antes de eso sus tickets caerían en la bandeja de TI.

### Capa 1 — Base de datos

| Sprint | Qué | Listo cuando |
|---|---|---|
| **MS.7.1** | `queue_members` + backfill a TI + columnas de `queues`. | Cada agente actual de TI es miembro de `ti`; migración reversible; nada cambia a la vista. |
| **MS.7.2** | SLA por cola (`queue_id`, unicidad de expresión). | Las 4 políticas actuales siguen siendo las generales; el cálculo de TI da lo mismo. |
| **MS.7.3** ✅ | `zones`, `requests.zone_code`, `queues.asks_zone`. (`EC` ya estaba desde MS.7.14.) Ver §9.6. | Las 5 zonas sembradas, sin tocar `STORE_BRANCHES`; la zona sólo viaja si la cola la pregunta. |
| **MS.7.4** ✅ | `queue_fields`, `requests.extra` (`is_test` **no** se construyó: nadie lo pidió). Ver §9.7. | Los tickets existentes quedan con `extra = {}`; ninguna cola trae campos de fábrica. |
| **MS.7.5** ✅ | `pause_reason`, `routing_rules.warehouse_code`, `kind='transfer'`. Ver §9.8. | CHECKs nuevos aceptan todo lo existente. |

### Capa 2 — Lógica (`libs/service-desk`, con pruebas)

| Sprint | Qué | Pruebas que no pueden faltar |
|---|---|---|
| **MS.7.6 ⚠️** | **Acceso por cola.** `ActorCtx` trae las colas del actor (`todas` para god-mode); `puedeVer`, `inbox`, `stats`, `reports`, `agents.listIn(cola)`, take/assign (el destino debe ser miembro) y los avisos filtran por cola. El solicitante **siempre** ve lo suyo. **Se diseña ya con el hueco de la confidencialidad de RH:** una función única `accesoATicket` que devuelve `completo \| basico \| ninguno` (ver [`FASE_RH_MESA_DE_SERVICIO`](FASE_RH_MESA_DE_SERVICIO.md)). | Un técnico de MTO **no ve** un ticket de TI (404 en la ficha, ausente en inbox/stats/reporte, sin avisos); TI sigue idéntico; el solicitante ve el suyo; **mutación**: abrir `puedeVer` debe poner rojas varias comprobaciones. |
| **MS.7.7** | Prioridad por modelo de cola (`riesgo_operacion`) + SLA con *fallback* cola→general. | La matriz completa (4 combinaciones), el *max* con la prioridad de la categoría, y que TI siga calculando con `impacto`. |
| **MS.7.8** | Campos extra y **foto (opcional por ahora)**: validador puro (requeridos, tipos, opciones) leído de `queue_fields`. La capacidad de exigir foto (`required`) queda construida, pero **Mantenimiento no la activa** (decisión de Sistemas: adjuntos como están hoy, sin almacenamiento obligatorio). | Falta un campo requerido → 400; una cola que SÍ exige foto sin foto → 400 (probado con una cola de prueba, no con la real); Mantenimiento acepta el ticket sin foto; TI sin campos → igual que hoy. |
| **MS.7.9** ✅ | Ver §9.9. Motivo de pausa en `en_espera` (pausa el SLA); auto-cierre a 3 días ya existente, probado también por cola. | Pausar con motivo, reanudar, el reloj no corre en pausa. |
| **MS.7.10** ✅ | Ver §9.10. Ruteo por ubicación + responsable por omisión; el destino debe ser **miembro** de la cola del ticket. | Gana la regla más específica y primera por orden; sin regla → default o «sin asignar»; no se asigna a no-miembros. |
| **MS.7.11** ✅ | Ver §9.11. `transferir` (M6). | Mismo folio/hilo/adjuntos; la categoría debe ser de la cola destino; recalcula SLA; mensaje de sistema; sólo coordina el origen; no se pierde el ticket en una cola que nadie atiende (la destino debe tener al menos un miembro activo). |
| **MS.7.12** | `is_test` + reportes por cola. | Un `is_test` no aparece en ningún reporte ni contador; el filtro por cola respeta el acceso. |
| **MS.7.13** | Avisos por cola (destinatarios = miembros), plantillas con la cola. | Nadie fuera de la cola recibe el aviso. |

### Siembra

| Sprint | Qué |
|---|---|
| **MS.7.14** | Cola **Mantenimiento** (`code='mantenimiento'`, `priority_model='riesgo_operacion'`), las **11 categorías** del plan, SLA propio, las **zonas**, los dos campos de riesgo/operación (la foto **opcional**), y los miembros: **Ubaldo Barajas Valencia como coordinador** más los técnicos que él defina desde la pantalla. Sólo después de verificar MS.7.6. |

### Capa 3 — Visual (`apps/view`, Operations)

| Sprint | Qué |
|---|---|
| **MS.7.15** | «Nueva solicitud»: elegir **área** → categorías de esa área → ubicación (ya visible) → zona → campos dinámicos → foto (opcional). |
| **MS.7.16** | Bandeja y ficha por cola: selector de cola (sólo las permitidas), etiqueta de cola en filas y ficha, motivo de pausa, **Transferir a otra área**, **Marcar como prueba**. |
| **MS.7.17** | Configuración de colas: miembros (coordinador/técnicos), responsable por omisión, modelo de prioridad, SLA por cola, campos, zonas. Demuestra la regla 1: **crear otra área sin tocar código**. |
| **MS.7.18** | Reportes con filtro de cola; «Mi trabajo»: lo «por asignar» de **cada cola que reparte** esa persona. |
| **MS.7.19** | Prueba punta a punta en copia: levantar → asignar → pausar → resolver → cerrar → transferir; acceso cruzado TI↔MTO. Despliegue: migraciones **una por una** (`apply-one-migration-prod.js`), nada de `migrate:latest`. |

---

## 5. Qué se quita o cambia del plan original

- **Fase 0 (reconocimiento): hecha** — es este documento (y §8 completa la sección *Stack*).
- **1.1 y 1.2** se reparten en MS.7.1–7.5 y 7.14: sin crear colas ni categorías desde cero, con la siembra **después** del acceso por cola.
- **Estados configurables por cola** → motivo de pausa, sin «Diagnóstico» (M3 ✅). **Prefijo de folio por cola** → folio único (M2 ✅).
- **Foto obligatoria de Mantenimiento** → foto opcional por ahora (los adjuntos siguen como están; ver §7).
- **«La persona puede bajar la prioridad»** → no (M4 ✅).
- **«Crítica»** → se queda «Urgente» en pantalla (M4 ✅).

---

## 6. Fases 2 y 3 del plan: se conservan, pero como fases propias

No entran a MS.7 y **no deben empezar antes de calibrar la Fase 1** (30 días de SLA medido):

- **Fase 2 (preventivo y activos)** → fase nueva «activos y preventivos de Mantenimiento». Hallazgos: no hay inventario de equipos ni QR en el repo (hay que decidir la librería y si se reaprovecha el módulo de **flota** para vehículos, que ya tiene su mantenimiento); el job diario de preventivos **debe ser idempotente** (patrón de los barredores con `@Cron` y cooldown ya usado en la Suite); la aprobación por monto sigue el patrón de **requisiciones de Compras** (HITL: aprobar/rechazar, nunca auto-ejecutar). Esto absorbe el *MS.9 vínculo con inventario de equipos (`asset_id`)* que ya estaba reservado.
- **Fase 3 (plantilla de cola, padre-hijo, escalamiento, encuesta, tablero):** la «plantilla de cola sin código» **ya está a medias** (colas y categorías se editan hoy) y MS.7.17 la completa; el escalamiento sigue la política de medir primero; el tablero para Power BI debe salir de **vistas** sobre las tablas de la Mesa (nada de copias).

---

## 7. Resuelto y pendiente

**Resuelto por Sistemas (2026-10-06):**
1. **Folio:** único `SRV-AAAA-NNNNN` (M2).
2. **«Diagnóstico»:** no se necesita (M3).
3. **«Crítica»:** no se renombra; sigue «Urgente» (M4).
4. **Reloj del SLA:** horario hábil para todas las políticas (M5).
5. **Visión de Dirección:** se deja como está hoy — por membresía de cola, god-mode ve todo (M11).
6. **Responsable de Mantenimiento:** **Ubaldo Barajas Valencia**, personal de la empresa; **no hay proveedores externos** en el alcance (el catálogo de proveedores de la Fase 2 del plan queda fuera por ahora).
7. **Infraestructura:** `SMTP_*` y `S3_*` **se quedan como están**; no son obligatorios. Consecuencia: la foto de Mantenimiento es **opcional** y los avisos por correo siguen como hoy.

**Pendiente (no bloquea empezar por la capa de BD):**
- **Alta de Ubaldo en la Mesa:** confirmar en producción que tiene usuario y que su rol le da `SERVICIO_ATENDER` **y** `SERVICIO_COORDINAR` (esta máquina no tiene su ficha: sólo se verifica en prod). Si no, se reparte desde `/admin/personas`. Ver también:
- **Departamento «Mantenimiento»:** el catálogo (`identity.departments`) **no tiene** uno; la cola puede quedar con `department_code` en blanco (es opcional) o se crea el departamento aparte, que es decisión de RH/administración, no de la Mesa.
- **Quién atiende en cada sitio** (los técnicos de Mantenimiento): se cargan como miembros desde la pantalla de MS.7.17; no hace falta tenerlos antes de construir.
- **Monto que exige aprobación y plazos finales:** sólo importan para la Fase 2 (aprobación por monto) y para calibrar el SLA tras 30 días.
- **Las dos lecturas del SLA** de M5 (24 h de Alta; Urgente en horario hábil).
- **Aplicar las migraciones de la Mesa en prod** (las 6 anteriores, una por una) antes que las de MS.7.

---

## 8. Reglas de trabajo (lo útil del `CLAUDE.md` del plan, adecuado al repo)

- **Stack real:** NestJS 11 + Knex + PostgreSQL 18 con **RLS forzado** (`servicedesk.*`), Angular 18 + PrimeNG, contratos en `libs/contracts`; pruebas **vitest** (`service-desk`, `view`, `contracts`) y **E2E HTTP** en `database/tests/http-service-desk-test.js`; despliegue automático desde `origin/main` (K3s en `md`), con las **migraciones aplicadas a mano, una por una**.
- **Una rama y un PR por sprint** (`feat/ms7-N-…`), revisor `edgarcg-01`, squash a `main`. Código de ticket en el commit: `feat([MS.7.6]): …`.
- **Migraciones aditivas, idempotentes (`hasColumn`/`IF NOT EXISTS`) y reversibles.** Nunca se borra un archivo de migración aplicado. Se prueban contra el Postgres de desarrollo (`ms-postgres`), **nunca contra producción**; en prod las aplica quien tenga autorización.
- **Tablas nuevas con `tenant_id` + RLS forzado + grants por tabla a `app_runtime`** (sin `DEFAULT PRIVILEGES`).
- **Todo lo específico de un área es configuración.** Si una pantalla o regla pregunta «¿es Mantenimiento?», está mal: pregunta por la configuración de la cola.
- **Un gate sin prueba negativa es una intención:** cada regla de acceso, prioridad y SLA se rompe a propósito una vez para ver el rojo.
- **Lo que no se pudo medir se declara**, no se dibuja como cero (hereda ADR-056): una cola sin tickets muestra «—», no «0 min».
- **Al cerrar un sprint:** tracker (⬜→🔨→🧪→🚀→✅), CHANGELOG, `03_LOG_REVISIONES` y la fila **MS** de `CLAUDE.md`. Interfaz y mensajes en español.
- **Sin secretos en código ni commits**; `SMTP_*`, `S3_*` y las credenciales van por entorno.

---

## 9. Avance — MS.7.1 y MS.7.6 construidos (2026-10-06)

**Lo construido** (rama `feat/ms-7-1-acceso-por-cola`):

- **MS.7.1 — base:** migración `20261006130000_servicedesk_queue_members.js` (aditiva, idempotente, reversible; probada subida/reversa/subida): `servicedesk.queue_members` (`coordinador | tecnico`, RLS forzado, sin DELETE: quitar = `active=false`), `queues.default_assignee_id`, `queues.priority_model` (sólo la columna; la lógica es MS.7.7) y el **backfill**: quien hoy atiende TI (permiso EFECTIVO, mismo cálculo que `agents.service`) queda como miembro de `ti`.
- **MS.7.6 — acceso por cola** (`domain/queue-access.ts`, puro): poder efectivo = **clave ∩ pertenencia**. `accesoATicket` ya devuelve `completo | basico | ninguno` (el hueco de RH; `basico` hoy cae del lado seguro: no abre la ficha). Acota `puedeVer`, la bandeja, el tablero, el reporte, tomar / asignar / notas internas / tiempo / prioridad, los avisos (`nuevo_prioritario` y los de SLA van a la cola del ticket) y el ruteo (una regla de palabra clave cuyo destino atiende OTRA cola no dispara aquí; un destino sin cola alguna sí gana y deja su nota). `GET /agents` y las personas que se ofrecen al asignar salen de la cola del ticket.
- **API de miembros:** `GET/PUT/DELETE /service-desk/config/queues/:id/members[/:userId]`. Sólo la coordinación **de esa cola** (o el god-mode) agrega, cambia de rol o quita; no se agrega a quien no tiene la clave (con mensaje que dice cuál pedir a Administración); la cola **nunca se queda sin coordinación**; no se quita a quien tiene solicitudes abiertas asignadas. Quien crea una cola queda como su coordinador.
- **Pruebas:** `service-desk` 179 · view (servicio) 132 · E2E **438/0** (bloque 22: técnico de Mantenimiento no ve TI y al revés, ni el coordinador de TI ve Mantenimiento, quien tiene las claves pero ninguna cola ve **0** y no «todo», god-mode ve ambas, asignar sólo a miembros, miembros, configuración, ruteo y avisos por cola) · `test-newdb-service-desk` 130/0. **Mutaciones atrapadas:** `puedeAtenderCola` siempre verdadero + `colasDeLectura` sin acotar ponen rojas **6 pruebas unitarias y 28 comprobaciones de HTTP**.

**⚠️ Cómo se despliega (el orden importa):**
1. **Aplicar la migración ANTES del deploy** (una por una, `apply-one-migration-prod.js`). Es aditiva: el código viejo la ignora. **Con la tabla vacía el código nuevo no deja ver ningún ticket a nadie**; el backfill es lo que lo evita.
2. Desplegar api + view. No hay permisos nuevos → **sin re-login**.
3. A partir de aquí, **dar `SERVICIO_ATENDER` ya no basta**: la persona debe ser además **miembro de una cola** (la coordinación la agrega con `PUT …/members/:userId`). Esto aplica a Felipe Galván y David Cisneros si todavía no estaban entre quienes atendían al aplicar la migración.

**Declarado, no construido (siguen en el plan):**
- **La pantalla de miembros** (MS.7.17): hoy se administran por API. Es la deuda que más se va a sentir al dar de alta a alguien nuevo.
- **«Mi trabajo»** (`me-work.ts` y `me-tasks.ts`, en `libs/trade`) **sigue sin acotar por cola**: sus conteos de «por asignar» y «a tu cargo» no miran la cola (MS.7.18). ⛔ **Debe resolverse antes de sembrar Mantenimiento (MS.7.14)**, o los conteos de TI incluirían los de Mantenimiento.
- **Configuración global** (horario hábil, SLA por prioridad, reglas de ruteo): sigue editable por cualquier coordinador; llega por cola con MS.7.2 y MS.7.17.
- **Levantar a nombre de otra persona** sigue siendo una capacidad global (no se acota por cola): importa a partir de RH (hallazgo H7).
- `priority_model` y `default_assignee_id` son sólo columnas; todavía nada las lee.

### 9.1 MS.7.18 construido (2026-10-07): «Mi trabajo» y Reportes por cola

- **«Mi trabajo»** (`libs/trade/.../me-work.ts`, bandeja `servicio-sin-asignar`): ahora cuenta **sólo las colas a las que la persona pertenece** (mismas colas y mismo filtro que su alcance «Sin asignar» de la bandeja). ⛔ **Sin ninguna cola NO devuelve 0**: se declara en `no_medido` con el motivo («no perteneces a ninguna cola… la coordinación te agrega»), porque un «0 por asignar» se leería «estás al día» cuando la persona no puede ver ninguna bandeja. **Con esto cae la compuerta que impedía sembrar Mantenimiento (MS.7.14).**
- **Reportes:** la respuesta declara `colas` (las que la persona coordina; el god-mode, todas) y `cola_id` (la elegida), y la pantalla ofrece el selector de cola **sólo si coordina más de una**. El filtro en el servidor (`queue_id`) ya existía desde MS.7.6.
- **Pruebas:** E2E **445/0** (bloque 23: la cola nueva cuenta sus 2 y no los de TI; TI no suma la cola nueva; quien responde pero no tiene cola sale en `no_medido`; al agregarlo, la siguiente lectura ya cuenta; el reporte declara sus colas) · view (servicio) con 4 pruebas nuevas del selector (incluida la negativa: con una sola cola no aparece). **Mutación atrapada:** quitar el `whereIn('queue_id', …)` pone en rojo 3 comprobaciones.
- **Declarado:** `me-tasks.ts` («Solicitudes a tu cargo», `assigned_to = tú`) **no se acota por cola a propósito**: un ticket asignado a ti es tuyo aunque cambie la membresía, y el API no deja quitar a quien tiene tickets abiertos. Cuando RH llegue, esa fuente **no debe mostrar títulos** de tickets confidenciales (hoy sólo cuenta).

### 9.2 MS.7.17 construido (2026-10-07): la pantalla de miembros de la cola

- **Dónde:** `/servicio/configuracion` › «Colas y categorías» › cada cola trae **«Quién atiende esta cola»** (se abre a demanda: no hace N llamadas al cargar). Componente `SdQueueMembersComponent`.
- **Qué hace:** lista a los miembros con su rol, **marca «sin permiso»** al que perdió la clave, y —sólo si el servidor dice `can_manage` (coordinas ESA cola)— permite **agregar** (selector con quienes ya tienen la clave y aún no son miembros), **cambiar de rol** y **quitar**. Sin `can_manage` es de sólo lectura: no hay formulario ni se piden candidatos.
- **Backend nuevo:** `GET /service-desk/config/queues/:id/candidates` (sólo la coordinación de esa cola) y `can_manage` en la respuesta de miembros. Las reglas siguen siendo del servidor (la cola no se queda sin coordinación, no se quita a quien tiene tickets abiertos, la clave es obligatoria); la pantalla muestra **su mensaje tal cual** y, para nombrar coordinación, avisa **antes** quién no tiene la clave de coordinar.
- **Pruebas:** E2E **455/0** (candidatos: sólo con la clave y no miembros, no el solicitante; el coordinador de TI y el técnico → 403; `can_manage`: coordinación sí, técnico no, god-mode sí) · 13 pruebas del componente (incluye las negativas: sólo lectura, 409 con su mensaje, cambio de rol rechazado que recarga). La prueba **atrapó un defecto real**: tras un cambio de rol rechazado la recarga borraba el motivo que se acababa de mostrar. Revisado en navegador (agregar a una persona de punta a punta).
- **Con esto el alta de una persona nueva ya no necesita API** (runbook §11): la coordinación de la cola la agrega desde la pantalla, siempre que Administración le haya dado antes `SERVICIO_ATENDER`.

### 9.3 MS.7.14 preparada (2026-10-07): la siembra de Mantenimiento

**Qué es:** la migración `20261007240000_servicedesk_seed_mantenimiento.js` (aditiva, idempotente, reversible): la cola **Mantenimiento** y sus **11 categorías**. Sólo configuración; ninguna línea de lógica por nombre de cola. Más `EC` = «Estacionamiento CEDIS» en `SD_UBICACIONES_EXTRA` (la 11.ª ubicación; sin migración).

**⛔ Nace APAGADA y SIN miembros, a propósito.** Encendida y sin nadie, el catálogo ofrecería sus categorías a toda la empresa y cada ticket nacería en una bandeja que nadie ve. El catálogo ya esconde las categorías de una cola apagada, así que **sembrarla no cambia nada visible**. El camino para activarla es el de la pantalla (MS.7.17): 1) un administrador nombra coordinador a Ubaldo Barajas Valencia; 2) él agrega a su gente y **enciende la cola**. La migración no agrega a nadie (su usuario no está confirmado en prod y no se adivina).

**Qué trae y qué no (declarado, no fingido):**
- ✅ Cola + 11 categorías (eléctrico e iluminación, climatización y refrigeración, plomería, obra civil y pintura, herrería/puertas/cortinas, mobiliario y anaqueles, equipo de almacén, seguridad y protección civil, plagas y limpieza, fachada y rotulación, estacionamiento) + la ubicación `EC`.
- ⚠️ **Dos valores por validar con Frank** (se cambian desde la pantalla): todas las categorías nacen con prioridad por defecto `media` (el plan no fija ninguna) y todas **exigen ubicación**.
- ✅ **SLA propio en horario hábil → MS.7.2** (§9.4, ya construido). Mientras no estuviera, sus tickets habrían heredado los generales (la urgente de TI corre corrida).
- ✅ **Prioridad por riesgo × operación → MS.7.7** (§9.5, ya construido; la cola pasó a `riesgo_operacion` hasta que el código la aplicó, no antes).
- ❌ **Zonas (MS.7.3) y los dos campos de riesgo (MS.7.4/7.8).**
- ❌ Un departamento «Mantenimiento» en el catálogo de áreas **no existe**; la cola va sin `department_code` (es opcional).

**Pruebas:** `test-newdb-mantenimiento-seed` **19/0** (apagada, sin miembros, 11 categorías, no finge matriz ni SLA, idempotente: re-correrla no pisa lo que la coordinación ajustó ni apaga una cola ya encendida, el `down` conserva la cola si tiene tickets) · E2E **451/0** con el bloque 24 (apagada no se ofrece ni admite tickets; el god-mode la ve; quien no es de la cola no la enciende → 403; **el camino real**: un administrador nombra a la coordinación, ésta enciende la cola, el catálogo ofrece las 11 categorías, `EC` es válida, sin ubicación → 400, el ticket aparece en su bandeja y **no** en la de TI) · specs de la lista de ubicaciones (11). **Mutación atrapada:** sembrarla encendida pone en rojo la prueba.

**Orden de despliegue (compuertas):** #272 (acceso por cola) ya en `main`; **#287** (Mi trabajo por cola) y **#288** (pantalla de miembros) deben estar desplegados **antes** de encender la cola; la migración de `queue_members` aplicada y verificada. Sembrar (esta migración) es seguro en cualquier momento posterior: no cambia nada visible.

### 9.4 MS.7.2 construido (2026-10-07): el SLA por cola, y Mantenimiento en horario hábil

- **Qué cambia:** `sla_policies.queue_id` (NULL = la política **general** del tenant, la de siempre). La política de un ticket es la de **su cola** para esa prioridad y, si la cola no la cambió, **la general**: una cola nueva hereda todo sin sembrar nada y puede cambiar sólo algunas prioridades. La unicidad es `(tenant, cola, prioridad)` con NULL tratado como «la general» (**índice único de expresión**: un `UNIQUE` normal dejaría duplicar la general).
- **Dónde rige:** el alta del ticket, el cambio de prioridad, la reanudación tras una pausa, la vista de plazo, el **barrido** que marca lo vencido y el **reporte** (mide cada ticket contra la política de su cola). Un helper puro (`politicaEfectiva`) y uno de lectura (`politicaDe`): nadie vuelve a leer `config.policies[prioridad]` a pelo.
- **Para TI no cambia nada:** sus 4 filas conservan `queue_id = NULL` y la urgente sigue corrida.
- **Los plazos de Mantenimiento** (decisión de Sistemas: **horario hábil**), sembrados con la migración `20261007250000` como propuesta sin calibrar: **Urgente 60/240 · Alta 240/480 · Media 480/1,440 · Baja 1,440/4,800** (minutos hábiles; primera respuesta / resolución). ⚠️ **Las dos lecturas siguen por confirmar con Frank** y se cambian desde la pantalla: (a) el «24 h» de Alta se tomó como 1 día hábil (480); (b) con reloj hábil una **Urgente fuera de horario (noche, domingo) no corre hasta la mañana**.
- **API:** `PUT /service-desk/config/policies/:priority?queue_id=` (sin `queue_id` = la general, igual que siempre; con él nace como copia de la general con el cambio o edita la propia) y `DELETE …?queue_id=` (la cola vuelve a heredar). Sólo la **coordinación de esa cola** (o el god-mode) toca los plazos de una cola; la respuesta de `/config` marca de qué cola es cada plazo (`queue_id`).
- **Pantalla:** en «Plazos por prioridad» un selector «¿De qué cola?» (General / cada cola): en una cola cada prioridad sale **«propio»** o **«heredado»** y hay «Volver al general».
- **Pruebas:** `test-newdb-sla-por-cola` **21/0** (la general no cambió; **no se puede duplicar la general**, la negativa que un UNIQUE normal no atrapa; una cola sólo una política por prioridad; FK; invariantes; los plazos de Mantenimiento; permisos reales como `app_runtime`) · `service-desk` 185 (la herencia parcial y que lo de una cola no se filtre a otra) · 8 pruebas de la pantalla · E2E **491/0** (bloque 25: otra coordinación → 403; el ticket nuevo se mide a los 100 min de SU cola y uno de TI sigue con la general; cambiar otra vez edita sin duplicar; **herencia parcial**; volver a heredar; la general sigue editable sin `queue_id`). **Mutación atrapada:** leer la política general en el alta pone en rojo la comprobación.
- **Declarado:** la política **general** sigue editable por cualquier coordinación (afecta a toda cola que herede); un ticket **ya creado** conserva su `due_at` (sólo cambia con una nueva prioridad o una pausa), como siempre; el **horario hábil** (días y horas) sigue siendo **uno solo** del tenant.

### 9.5 MS.7.7 construido (2026-10-07): la prioridad por modelo de cola — la matriz de Mantenimiento

- **Qué es:** cada cola elige **cómo se sugiere la prioridad** por el VALOR `queues.priority_model` (nunca por su nombre): `impacto` (cuántas personas afecta × me impide trabajar — TI, sin cambio alguno) o `riesgo_operacion` (**¿hay riesgo para personas? × ¿detiene la operación?**):

  | | detiene la operación | no detiene |
  |---|---|---|
  | **riesgo: sí** | Urgente («Crítica») | Alta |
  | **riesgo: no** | Alta | Media |

  Sigue siendo **sugerida**: quien atiende la confirma y **la persona no la baja** (decisión M4). La mínima es `media`, no `baja`; la categoría pone su piso también aquí; y **el impacto ya no cuenta** en esa cola (esa pregunta no se hace).
- **⛔ El riesgo es obligatorio y nunca se adivina:** en una cola de riesgo, sin contestar «¿hay riesgo para personas?» (o con algo que no sea verdadero/falso) el alta es **400**. «Detiene la operación» es el `blocks_work` de siempre. En una cola de impacto la respuesta se ignora y se guarda **NULL** («no se preguntó»), nunca un `false` inventado (`requests.safety_risk boolean NULL`, migración `20261007260000`).
- **Quién lo elige:** `PUT config/queues/:id {priority_model}` — sólo la coordinación de esa cola; un valor que el código no sabe aplicar es 400. La pantalla de Configuración trae un selector «Prioridad sugerida por» en cada cola; el **catálogo** declara el modelo de cada cola para que el formulario sepa qué preguntar.
- **Formulario y ficha:** al elegir una categoría de una cola de riesgo, «Nueva solicitud» cambia sus preguntas (¿riesgo? obligatoria, ¿detiene la operación?) en lugar de «¿a cuántas personas afecta?», y no deja enviar sin contestar el riesgo; la ficha muestra lo que **sí** se preguntó.
- **Mantenimiento** pasa a `riesgo_operacion` con la migración `20261007260000` (sólo si nadie le había cambiado el modelo): el valor se declara **cuando el código ya lo aplica**, no antes (la siembra se negó a clamarlo).
- **Pruebas:** `service-desk` 195 (las 4 combinaciones exactas; **el modelo de impacto es idéntico a lo de siempre para toda combinación**; el riesgo ausente lanza; modelo desconocido cae a impacto) · view 170 (qué se pregunta según el modelo; sin contestar el riesgo no se envía; lo que viaja es lo que se preguntó) · E2E **515/0** (bloque 26: la cola nueva nace en impacto; otra coordinación → 403; modelo inventado → 400; las 4 combinaciones; riesgo guardado y devuelto; **impacto sin peso**; piso de categoría; riesgo ausente / «no» / nulo → 400 sin tickets a medias; la persona no baja la prioridad; volver a «impacto» restaura a TI) · **dos mutaciones atrapadas** (la matriz alterada → 2 rojas; ignorar el modelo en el alta → 11 rojas). El bloque 24 (camino real de Mantenimiento) **se actualizó**: ahora el alta exige el riesgo — y lo comprueba.
- **Declarado:** `safety_risk` es una columna propia, no un campo configurable por cola (eso es MS.7.4/7.8: el día que existan los campos por cola, éste puede pasar a ser uno de ellos); un ticket **ya creado** conserva su prioridad si luego se cambia el modelo de la cola; el nombre «Crítica» no se usa en pantalla (decisión de Sistemas: sigue «Urgente»).


### 9.6 MS.7.3 construido (2026-10-07): zonas — el lugar DENTRO de la ubicación

- **Qué es:** la ubicación dice **dónde** (una sucursal, las oficinas, el estacionamiento del CEDIS); la **zona** dice **en qué parte** (bodega, andén, oficina, baños, exterior). No es parte del código de ubicación: la misma zona se repite en todos los sitios, por eso es un **catálogo propio** (`servicedesk.zones`) y no un sufijo.
- **Base** (migración `20261007270000`, aditiva, idempotente, reversible): `zones` (código `^[a-z][a-z0-9_]{0,29}$`, nombre, orden, activa; RLS forzado; `SELECT/INSERT/UPDATE` sin `DELETE`: **apagar no borra**), `requests.zone_code` con **FK compuesta** al catálogo (no hay zonas inventadas; una zona en uso no cambia de código) y `queues.asks_zone` (nace `false`). Siembra las 5 zonas del plan y enciende `asks_zone` en Mantenimiento; TI no cambia.
- **La cola la pregunta por VALOR** (`asks_zone`, nunca por su nombre). Si la cola **no** la pregunta, la zona que llegue se **ignora** (queda NULL); si la pregunta, es **opcional** y, si llega, debe ser una zona **activa** del catálogo (si no, 400). Una zona en blanco = sin zona.
- **Quién administra:** el catálogo es del tenant (la misma «bodega» sirve a todas las colas), así que `POST config/zones` / `PUT config/zones/:id` los hace **quien coordina alguna cola** (o el god-mode); el código **no se cambia**; apagar quita la zona del formulario pero **los tickets viejos la conservan**. Qué colas la preguntan lo decide **la coordinación de cada cola** (`PUT config/queues/:id {asks_zone}`).
- **Pantallas:** «Nueva solicitud» ofrece «Zona (opcional)» sólo en las colas que la preguntan; la ficha muestra la zona; Configuración trae la tarjeta **Zonas** (lista con apagadas, alta con validación de código, apagar/encender) y el interruptor «Pregunta la zona» en cada cola.
- **Pruebas:** DB `test-newdb-zonas` 20 (RLS, siembra, CHECK de código, FK, runtime sin DELETE ni escritura en otro tenant, cada negativa con su control) · E2E bloque 27 (zona ignorada si la cola no la pregunta, guardada si sí, inexistente/apagada → 400, permisos de alta, código inmutable, ticket viejo conserva su zona apagada, TI intacta) — total E2E 542 · view 177. **Mutación:** quitar la condición `asks_zone` del backend pone en rojo 3 comprobaciones; hacer que el formulario ofrezca la zona siempre pone en rojo 2 specs.
- **Declarado:** la zona **no** enruta ni cambia la prioridad ni el SLA (es información para quien atiende); una zona **por ticket** (no varias); no hay zonas por sitio (todas las ubicaciones comparten el mismo catálogo).

### 9.7 MS.7.4 + MS.7.8 construidos (2026-10-07): campos propios por cola y su validación

- **Qué es:** cada cola declara qué **MÁS** pregunta al reportar —un **sí/no**, una **opción** de una lista, un **texto** o una **foto**— como una fila de configuración, no como un `if (cola === …)`. Lo contestado viaja en `extra` (`{ codigo: valor }`) y se guarda en `requests.extra`.
- **Base** (migración `20261007280000`, aditiva, idempotente, reversible): `servicedesk.queue_fields` (código, pregunta, tipo `boolean|select|text|photo`, requerido, opciones, orden, activo; RLS forzado; **sin DELETE**: apagar no borra; CHECK: un `select` lleva de 2 a 20 opciones y los demás tipos ninguna; código único **por cola**) y `requests.extra jsonb NOT NULL DEFAULT '{}'` con CHECK de que sea un **objeto**. **No siembra nada:** ni TI ni Mantenimiento traen campos (la foto sigue siendo un adjunto opcional, decisión de Sistemas).
- **Validador puro** (`domain/campos-extra.ts`, MS.7.8): ⛔ una clave que la cola **no declara** se **rechaza** (no se ignora —a diferencia de la zona—: un formulario desactualizado debe enterarse y la base no se llena de datos sin dueño); «requerido» exige una respuesta de verdad (**`false` es respuesta**, un texto en blanco no); el tipo se respeta (booleano de verdad, opción de la lista, texto ≤ 500); lo opcional sin contestar **no se guarda** (ni `null` ni «» inventados); la **foto no viaja en `extra`**: es un adjunto, y requerida ⇒ ≥ 1 archivo. Junta **todos** los problemas en un 400, no sólo el primero.
- **Alta** (`POST /requests`): valida `extra` contra los campos **activos** de la cola de la categoría; una cola sin campos ni `extra` guarda `{}` (TI no cambia). **Ficha:** `extra` llega **etiquetado** (`{code,label,type,value}`) con la pregunta tal como se llama, **también si el campo se apagó después** (apagar no reescribe el historial). **Catálogo:** `fields` (sólo activos, sólo de colas encendidas).
- **Quién:** `POST config/queues/:id/fields` y `PUT config/fields/:id` — sólo la **coordinación de ESA cola** (o el god-mode); la autorización del `PUT` se resuelve por **la cola del campo**, no por lo que diga el cuerpo. **El código y el tipo no cambian** (invalidarían lo ya guardado): se apaga uno y se crea otro. Las opciones de un `select` sí se editan.
- **Pantallas:** «Nueva solicitud» pinta los campos de la cola de la categoría (sí/no, lista, texto), marca los obligatorios y **no deja enviar** sin contestarlos (la foto obligatoria pide un archivo); cambiar de categoría descarta lo contestado de otra cola. La ficha lista las respuestas. Configuración trae, **por cola**, «Campos propios de esta cola» (lista con apagados, obligatoria, apagar/encender y alta; el código se **deriva de la pregunta**).
- **Pruebas:** `service-desk` 210 (el validador: clave desconocida, requerido, `false` vs «sin contestar», tipos, opciones, tope de texto, foto, definición) · DB `test-newdb-campos-por-cola` 29 (RLS, `extra` sólo objeto, CHECK de opciones por tipo, FK compuesta, unicidad por cola, runtime sin DELETE) · E2E bloque 28 (total **586**) · view 186. **Mutaciones atrapadas:** validar contra definiciones vacías pone en rojo 5 comprobaciones; ignorar lo obligatorio en el formulario pone en rojo su spec. **Visto en navegador:** alta del campo en Configuración, el formulario lo pide, bloquea el envío y la ficha muestra la respuesta.
- **Declarado:** la foto requerida con un adjunto **real** no se midió en este destino (sin bucket; la negativa «sin foto → 400» sí); el campo no tiene condiciones («mostrar sólo si…») ni tipos número/fecha; `safety_risk` sigue siendo columna propia; un ticket **ya creado** no se revalida si luego se vuelve obligatorio un campo; `is_test` del plan original no se construyó.

### 9.8 MS.7.5 construido (2026-10-07): la base de la pausa con motivo, el ruteo por ubicación y el traslado

- **Migración `20261007290000`** (aditiva, idempotente, reversible). Sólo AMPLÍA: cada CHECK nuevo acepta todo lo que ya existe.
  - `requests.pause_reason` — `proveedor | refaccion | aprobacion | solicitante | otro`. **La base exige que el motivo sólo exista mientras el ticket está en espera** (`requests_pause_reason_state_ck`), igual que ya exige `en_espera ⇔ reloj pausado`: un motivo huérfano de una pausa que terminó sería un dato que miente. Consecuencia para el código (MS.7.9): al reanudar hay que limpiar el motivo en la misma operación, o la base lo rechaza.
  - `routing_rules.warehouse_code` — la regla también puede dispararse por **ubicación**; el disparador pasa de «categoría o palabras» a «categoría, palabras **o** ubicación» (una regla sin ninguno sigue siendo un typo).
  - `request_messages.kind` admite `transfer` — el historial de traslados es un **mensaje de sistema** del hilo (de→a, quién, por qué), no una tabla nueva.
- **`down`** conserva lo ensanchado si ya hay datos que lo usan (una regla sólo por ubicación, un mensaje de traslado): no se tira un registro.
- **Prueba:** `test-newdb-pausa-ruteo-traslado` 29 (cada CHECK roto a propósito con su control; los 5 motivos; el motivo en un ticket que no está en espera; reanudar sin limpiarlo; regla vacía vs. sólo por ubicación; tipo de mensaje inventado; la nota interna sigue sin poder ser pública).

### 9.9 MS.7.9 construido (2026-10-07): motivo de pausa en «en espera»

- **Qué es:** poner un ticket en espera **exige el motivo** (`proveedor`, `refaccion`, `aprobacion`, `solicitante`, `otro`). Sin estado nuevo (M3): «esperando refacción» es `en_espera` + motivo, y `en_espera` ya pausaba el reloj del SLA.
- **⭐ Lo que cambia de verdad — qué espera termina con la respuesta de la persona.** Antes, cualquier comentario público de quien reportó reanudaba el ticket. Con un proveedor o una refacción de por medio eso era un error: **la persona preguntando «¿ya llegó?» reanudaba el reloj**. Ahora (`respuestaReanuda`, puro): sólo la espera al `solicitante` —o una anterior al motivo (`null`: el comportamiento de siempre, así que lo existente no cambia)— se reanuda con su respuesta; con cualquier otro motivo su comentario es un comentario y **el reloj sigue pausado** hasta que quien atiende lo levante. Un motivo desconocido tampoco reanuda (ante la duda el reloj sigue pausado, no corriendo).
- **Servidor:** `POST /requests/:id/status` con `en_espera` exige `pause_reason` (400 sin él o con uno inventado); con cualquier otro estado, un `pause_reason` es 400 (no se ignora). El motivo se guarda con la pausa, queda en el mensaje de estado del hilo (`meta.pause_reason`) y **se limpia en la misma operación al salir de «en espera»** (reanudar, resolver o cancelar) — la base lo exige (MS.7.5: un motivo huérfano sería un dato que miente). La ficha (`SdRequestRow.pause_reason`) lo devuelve.
- **Pantalla:** al «Poner en espera» la ficha pide **«¿Qué se espera?»** (obligatorio, no confirma sin elegir) y, mientras está en espera, muestra «En espera: Esperando al proveedor».
- **Pruebas:** `service-desk` 213 (`respuestaReanuda`) · E2E bloque 29 (total **600**: sin motivo/inventado/con otro estado → 400, el reloj no corre en pausa, su comentario NO reanuda con proveedor y SÍ con solicitante, quien atiende reanuda y el motivo se va, resolver y cancelar desde la espera lo limpian, en la base no queda ningún motivo fuera de la espera) · view 190. **Mutación atrapada:** quitar la condición `respuestaReanuda` pone en rojo 2 checks.
- **Declarado:** el auto-cierre a 3 días (`resuelto` → `cerrado`) no cambió (no pasa por la espera); la bandeja aún no filtra por motivo (MS.7.16); un ticket **ya en espera** antes de esta migración no trae motivo y sigue reanudándose con la respuesta de la persona.

### 9.10 MS.7.10 construido (2026-10-07): ruteo por ubicación y responsable por omisión

- **La ubicación es un FILTRO de la regla.** Una regla de asignación puede traer además una ubicación (`routing_rules.warehouse_code`, MS.7.5): si la trae, el ticket debe venir de ahí o la regla **no aplica** («Plomería en Oficinas → Pedro» no se dispara con una fuga en el CEDIS). Una regla con ubicación y **sin** categoría ni palabras se dispara por la ubicación sola («todo lo de Oficinas → Pedro»). Una regla sin categoría, palabras **ni** ubicación sigue siendo un typo (400).
- **Gana la más específica; a igualdad, la primera por orden.** Especificidad = cuántas CONDICIONES trae: el disparador (categoría o palabras, un solo «o») cuenta una vez y la ubicación otra. Así «categoría + ubicación» (2) le gana a «categoría» (1) **aunque vaya después en la lista**. ⭐ **Toda regla de antes (sin ubicación) vale 1 y conserva exactamente su orden de siempre**: nada de lo que ya funcionaba cambia de dueño (probado con las reglas reales de TI).
- **Responsable por omisión** (`queues.default_assignee_id`, existía desde MS.7.1 sin forma de editarse): si **ninguna regla aplica**, el ticket cae a esa persona; sin él queda «Sin asignar» como siempre. **Una regla que aplica le gana siempre.** El hilo guarda por qué le tocó (`reason`: `category`, `keyword`, `location` o `default`).
- **⛔ Nunca a quien no es miembro.** Se valida **al ponerlo** (`PUT config/queues/:id {default_assignee_id}`: debe ser un miembro activo de ESA cola con permiso de atender; sólo la coordinación de esa cola; `null` lo quita) **y al usarlo** (si ya no es miembro, el ticket queda sin asignar con una nota interna que lo dice, y quien reportó no la ve). Y **quitar a alguien de la cola limpia su cargo de responsable** (no queda un responsable fantasma).
- **Reglas de otras colas:** una regla sólo por ubicación hereda el filtro por cola de MS.7.6 (si su destino atiende otra cola, no dispara sobre ésta): el ruteo de Mantenimiento no toca a TI.
- **Pantalla:** el formulario de reglas trae «Ubicación (opcional)» (sucursales + Oficinas + Estacionamiento), la lista dice la ubicación de cada regla, y el panel «Quién atiende esta cola» trae **«Responsable por omisión»** (sólo miembros que pueden atender; de sólo lectura para quien no coordina esa cola).
- **Pruebas:** `service-desk` 222 (filtro, ubicación sola, más específica, orden de siempre, apagada) · E2E bloque 30 (total **629**: validaciones, ubicación sola, más específica aunque vaya después, responsable por omisión con sus cinco rechazos, regla le gana al responsable, no-miembro → sin asignar + nota interna invisible para quien reportó, quitar de la cola lo limpia, TI intacta) · view 200. **Mutaciones atrapadas:** quitar el filtro de ubicación pone en rojo 4 specs; no validar la membresía del responsable pone en rojo 2 checks.
- **Declarado:** una regla por ubicación no distingue «sin ubicación» de «cualquiera»: un ticket sin ubicación no dispara reglas que la exigen; el responsable por omisión no se rota ni se reparte (es una persona); la ubicación de las reglas es una por regla (no una lista).

### 9.11 MS.7.11 construido (2026-10-07): transferir un ticket a otra cola

- **Qué hace:** `POST /requests/:id/transfer { queue_id, category_id, reason }` MUEVE el mismo ticket (**mismo folio, hilo y adjuntos**; no clona): cambia cola y categoría, quita la asignación, recalcula los plazos con la política de la cola destino, deja un mensaje `transfer` en el hilo (de→a, quién, por qué) y **avisa a quien atiende la cola destino** (`transferido`; quien traslada no se avisa a sí mismo). Todo en UNA transacción: o se hace completo o no se hace.
- **Quién:** sólo la **coordinación del área de ORIGEN** (clave `SERVICIO_COORDINAR` ∩ coordinar esa cola; el god-mode puede). Quien reportó, un técnico y la coordinación de otra cola reciben 403/404. La coordinación del destino no puede «traer» un ticket que no es de su cola.
- **⛔ Lo que impide perder un ticket** (función pura `domain/traslado`): la cola destino debe tener **al menos una persona que pueda atenderla** (si no, 409: el ticket quedaría donde nadie lo ve); la categoría debe ser **de** la cola destino y estar activa; no a la misma cola; no a una apagada o inexistente; **no se traslada lo resuelto, cerrado o cancelado** (409: se reabre primero); y **hace falta decir por qué** (el motivo se lee en las dos áreas). Con cualquier rechazo el ticket queda exactamente como estaba.
- **Qué se conserva y qué se recalcula:** la **prioridad** que una persona ya confirmó **se conserva** — el modelo de la cola nueva pide datos que el ticket quizá no tiene (¿riesgo para personas?) y recalcularla sería inventarlos; *esto es una desviación de M6 («recalcula prioridad y SLA»): se recalculan los PLAZOS, no la prioridad*. Los marcadores de plazo vencido se reinician (un plazo nuevo es una medición nueva). La primera respuesta ya dada se conserva.
- **⭐ Un ticket en espera termina su espera al trasladarse.** La primera versión lo dejaba en espera y sin asignar, y el E2E lo destapó: no podía reanudarse (la base exige asignado en «en proceso»; salió un 500). Ahora el traslado **cierra la pausa** (se acredita el tiempo que ya estuvo en pausa, con el calendario, y los plazos se calculan sobre ese total), limpia el motivo y el ticket llega como `nuevo`; si lo esperado sigue pendiente, el destino lo vuelve a poner en espera con **su** motivo.
- **Lo que devuelve:** `SdTransferResult { id, folio, queue_id, queue_name, category_name, status }` — **no la ficha**: tras trasladar, quien coordina el origen deja de ver el ticket (ya es de otra cola) y devolver su ficha sería un 404 disfrazado de éxito. La pantalla debe cerrar la ficha y refrescar la lista (MS.7.16).
- **Pruebas:** `service-desk` 234 (`validarTraslado` con cada rechazo, `estadoTrasTraslado`, aviso `transferido`) · E2E bloque 31 (total **660**: 10 rechazos, el 409 de la cola vacía y que nada cambia, mismo folio, cola/categoría/asignación/plazos, hilo entero con nota interna oculta a quien reportó, aviso al destino y no a quien traslada, resuelto → 409, en espera → termina la espera y se puede tomar, iniciar y volver a pausar). **Mutación atrapada:** ignorar «nadie atiende el destino» pone en rojo 5 checks.
- **Declarado:** las respuestas de los campos propios del área de origen (MS.7.4) **se conservan en la base y en `meta.extra_origen` del mensaje de traslado**, pero la ficha del destino sólo muestra las de su propia cola; la zona se conserva aunque el destino no la pregunte; no hay «devolver» automático (se traslada de vuelta con otro traslado); la pantalla («Transferir a otra área») es de MS.7.16.
