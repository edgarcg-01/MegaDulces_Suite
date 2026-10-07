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
| **MS.7.3** | `zones`, `requests.zone_code`, `EC` en el contrato. | 11 ubicaciones y las zonas, sin tocar `STORE_BRANCHES`. |
| **MS.7.4** | `queue_fields`, `requests.extra`, `requests.is_test`. | Los tickets existentes quedan con `extra = {}` y `is_test = false`. |
| **MS.7.5** | `pause_reason`, `routing_rules.warehouse_code`, `kind='transfer'`. | CHECKs nuevos aceptan todo lo existente. |

### Capa 2 — Lógica (`libs/service-desk`, con pruebas)

| Sprint | Qué | Pruebas que no pueden faltar |
|---|---|---|
| **MS.7.6 ⚠️** | **Acceso por cola.** `ActorCtx` trae las colas del actor (`todas` para god-mode); `puedeVer`, `inbox`, `stats`, `reports`, `agents.listIn(cola)`, take/assign (el destino debe ser miembro) y los avisos filtran por cola. El solicitante **siempre** ve lo suyo. **Se diseña ya con el hueco de la confidencialidad de RH:** una función única `accesoATicket` que devuelve `completo \| basico \| ninguno` (ver [`FASE_RH_MESA_DE_SERVICIO`](FASE_RH_MESA_DE_SERVICIO.md)). | Un técnico de MTO **no ve** un ticket de TI (404 en la ficha, ausente en inbox/stats/reporte, sin avisos); TI sigue idéntico; el solicitante ve el suyo; **mutación**: abrir `puedeVer` debe poner rojas varias comprobaciones. |
| **MS.7.7** | Prioridad por modelo de cola (`riesgo_operacion`) + SLA con *fallback* cola→general. | La matriz completa (4 combinaciones), el *max* con la prioridad de la categoría, y que TI siga calculando con `impacto`. |
| **MS.7.8** | Campos extra y **foto (opcional por ahora)**: validador puro (requeridos, tipos, opciones) leído de `queue_fields`. La capacidad de exigir foto (`required`) queda construida, pero **Mantenimiento no la activa** (decisión de Sistemas: adjuntos como están hoy, sin almacenamiento obligatorio). | Falta un campo requerido → 400; una cola que SÍ exige foto sin foto → 400 (probado con una cola de prueba, no con la real); Mantenimiento acepta el ticket sin foto; TI sin campos → igual que hoy. |
| **MS.7.9** | Motivo de pausa en `en_espera` (pausa el SLA); auto-cierre a 3 días ya existente, probado también por cola. | Pausar con motivo, reanudar, el reloj no corre en pausa. |
| **MS.7.10** | Ruteo por ubicación + responsable por omisión; el destino debe ser **miembro** de la cola del ticket. | Gana la regla más específica y primera por orden; sin regla → default o «sin asignar»; no se asigna a no-miembros. |
| **MS.7.11** | `transferir` (M6). | Mismo folio/hilo/adjuntos; la categoría debe ser de la cola destino; recalcula SLA; mensaje de sistema; sólo coordina el origen; no se pierde el ticket en una cola que nadie atiende (la destino debe tener al menos un miembro activo). |
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

