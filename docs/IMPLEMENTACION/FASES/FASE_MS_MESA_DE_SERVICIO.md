# Fase MS — Mesa de Servicio (tickets de servicio)

> **Tesis (ADR-081):** la Mesa de Servicio no es una app nueva ni una bandeja más: es **la puerta única
> por la que cualquier persona de la empresa reporta un problema o pide algo**, y el **ticket ES la
> tarea** de quien lo atiende. Cada solicitud nace con folio, prioridad, SLA y un dueño; vive en el
> mismo contrato de tarea que ya alimenta "Mi trabajo"; y deja el escenario listo para **unificar la
> Bitácora de Sistemas** (hoy Google Sheet + Apps Script) con la Suite, de modo que cada ticket
> genere su tarea en la Bitácora/task sin doble captura.
>
> Se construye **por capas** (base de datos → lógica → visual) y entra por **una cola, la de TI**,
> con el modelo preparado para sumar Mantenimiento y otras áreas sin rediseñar.

Estado: **📋 DISEÑADO 2026-10-01 — sin código.** Plan para presentar a Edgar. Nada de esto está
en `main`; lo único tocado hoy es documentación (esta fase, ADR-081, tracker, `CLAUDE.md`).
**Tablas y accesos que se solicitan, con su propósito:**
[`FASE_MS_SOLICITUD_TABLAS_Y_ACCESOS.md`](FASE_MS_SOLICITUD_TABLAS_Y_ACCESOS.md) — pendiente de aprobación de Edgar.

---

## 0. Decisiones tomadas (2026-10-01)

| # | Tema | Decisión |
|---|---|---|
| D1 | Alcance | **Cola de TI** primero. Modelo multi-cola desde el día uno (`queues`) para sumar áreas después. |
| D2 | Prioridades | **Baja · Media · Alta · Urgente** (cuatro, como la Bitácora). |
| D3 | Quién reporta | Permiso nuevo **`SERVICIO_REPORTAR`**, repartido a todos los roles con personas. |
| D4 | Aviso | **Por número (WhatsApp) y por correo**. Exige datos de contacto por usuario (§Capa 1). |
| D5 | SLA | Los números propuestos en §2.3. Primero **miden**; el escalamiento se enciende tras calibrar. |
| D6 | Bitácora | Se prepara el escenario para **unificar Bitácora y task**: cada ticket genera su tarea. §5. |
| D7 | Nombres de sucursal | Los de la Suite, resueltos **del catálogo**, nunca escritos a mano. Ver pendiente P1. |

## 1. Lo medido antes de diseñar

- **No existe nada de tickets de soporte en la Suite.** Todo lo que dice "ticket" es de venta/caja
  (`FASE_TK_TICKETS_VENTA`, `commercial.route_tickets`, `live-tickets`). Por eso: sigla **MS**,
  schema **`servicedesk`**, URLs **`/service-desk/*`**, y **nunca** una tabla llamada `tickets`.
- **El hueco ya está reservado**: el espacio 9 "Sistemas, Servicios y Mantenimiento" (P-10). ⚠️ **Dato
  al 2026-10-01 de la tarde:** la Fase **DEV** (PR #205, "Desarrolladores › Proyectos") ya lo pasó a
  `active` con su primer módulo. Esta fase **no lo activa: le suma una entrada** (`servicio`), junto a
  `desarrolladores`. La descripción del espacio ya declara "solicitudes y continuidad sin módulo".
- **El molde existe**: `finance.recon_tasks` + `recon_task_messages` (asignación, estados, vence,
  nota de cierre, hilo). Falta prioridad, SLA, categoría y adjuntos. Su defecto, que NO se hereda:
  `assigned_by` y `resolved_by` son TEXT y no se unen al padrón.
- **El contrato de tarea tiene gate**: `database/tests/test-newdb-task-contract.js` descubre toda
  tabla con `assigned_(to|by|at)` y **falla si no está declarada** en `FUENTES_TAREA`/`ADAPTADORES`
  (`libs/contracts/src/work/task.contract.ts`, hoy 4 fuentes). Es lo deseable: el ticket aparece en
  "A tu nombre" sin trabajo extra de pantalla.
- **La infraestructura está**: adjuntos (`ObjectStorageService.putFile`), cron con latido
  (`CRON_JOBS`), correo (`MAILER_PORT`), WhatsApp (`WHATSAPP_PORT`), campana por WebSocket,
  `GET /users/me/context` (precarga solicitante/puesto/departamento/sucursal).
- **Lo que NO está** (y esta fase lo construye o lo declara):
  - `identity.users` **no tiene `email` ni `phone`** (el teléfono normalizado `mx_normalize_phone`
    existe pero sólo para clientes).
  - El WebSocket `/alerts` emite a **todo el tenant**, no por usuario.
  - Los adjuntos **no validan tipo ni tamaño en el servidor** (sólo el límite de body).
  - `GET /users` exige `USUARIOS_VER`: un agente de TI no podría listar personas para asignar.
- **Entorno**: prod corre en el servidor `md` desde el 2026-09-22 (no Railway). Las migraciones se
  aplican **una por una** con `apply-one-migration-prod.js`. Ver `CLAUDE.md` §Datos del entorno.

## 2. Modelo de dominio

### 2.1 Estados y su correspondencia

| Ticket | Contrato de tarea | Etapa de la Bitácora |
|---|---|---|
| `nuevo` | `pending` | Solicitud |
| `asignado` | `pending` | Asignada |
| `en_proceso` | `in_progress` | En proceso |
| `en_espera` (pausa el SLA) | `pending` | En proceso (con pausa) |
| `resuelto` | `done` | Implementada |
| `cerrado` | `done` | Cerrada |
| `cancelado` | `cancelled` | — |
| `programado` *(reservado, MS.8)* | `pending` | Programada |

`resuelto` lo confirma el solicitante (`cerrado`/`confirmado`), o se cierra solo a los **3 días**
sin respuesta (`close_reason='auto'`). Un solicitante puede **reabrir** (cuenta `reopened_count`).

### 2.2 Prioridad: sugerida, no autodeclarada

`Urgente` no se autodeclara: para que todos reporten **sin que todo llegue urgente**, el sistema
**sugiere** y quien atiende **confirma**.

- El solicitante marca **impacto** (`yo` · `varios` · `sucursal` · `red`) y **"me bloquea el trabajo"**.
- `priority_suggested = max(prioridad por defecto de la categoría, matriz impacto × bloqueo)`.
  `Urgente` sólo se sugiere con *bloquea + sucursal/red*.
- El solicitante **no puede fijar** `Urgente` ni `Alta`; el agente/coordinador cambia `priority`
  (queda en el hilo como evento `priority`).

### 2.3 SLA (números propuestos — parametrizados en `sla_policies`, no en código)

| Prioridad | 1ª respuesta | Resolución | Reloj |
|---|---|---|---|
| **Urgente** | 30 min | 4 h | calendario (corrido) |
| **Alta** | 2 h | 1 día hábil (8 h) | hábil |
| **Media** | 4 h | 3 días hábiles | hábil |
| **Baja** | 1 día hábil | 7 días hábiles | hábil |

- Horario hábil: **L–S 08:00–19:00 (America/Mexico_City)**, el mismo que ya usa `receipt-sla.service`.
- `en_espera` **pausa** el reloj (`paused_at` + minutos acumulados).
- Aviso al **80 %** del plazo de resolución (al asignado) y al **vencer** (al coordinador, **en
  resumen**, con silencio de 12 h — regla de la casa: "una campana con ruido se apaga").
- ⚠️ **Calibración, no dogma.** `cash-count-sla` se retiró (SM.34, 2026-09-10) por estar mal
  calibrado. Por eso `settings.escalation_enabled` arranca **apagado**: durante ~30 días el sistema
  **mide y marca** (`sla_*_breached_at`) sin escalar; con datos reales se ajusta y se enciende.

### 2.4 Folio

`SRV-YYYY-NNNNN` (p. ej. `SRV-2026-00001`), UPSERT atómico en `request_sequences`, `UNIQUE
(tenant_id, folio)`. **No** se usa `MD-`: ya lo usan los pedidos de la tienda (`MD-2026-00012`).

### 2.5 Categorías de arranque (cola TI, tomadas de la Bitácora de Sistemas)

Soporte a sucursal · Base de datos · ERP Kepler · Elaboración de gastos Kepler · Cámaras / CCTV ·
Redes / Infraestructura · Inventario · Respaldos · Reportes / Power BI · Capacitación · CEDIS · Otro.
Cada una con prioridad por defecto y `requires_branch`. Editables desde Configuración (no deploy).

---

## 3. CAPA 1 — Base de datos

Schema **`servicedesk`**. Toda tabla: `tenant_id uuid NOT NULL`, audit completo (`created_by/at`,
`updated_by/at`, `deleted_at`), `UNIQUE (tenant_id, id)`, FKs compuestas `(tenant_id, x_id)`, RLS
**ENABLE + FORCE** con policy `tenant_isolation`, y grants a `app_runtime` **incluido
`GRANT USAGE ON SCHEMA`** (sin él el API tira 42501 — pasó con `budget`, mig 20260917150000).

| Tabla | Qué guarda |
|---|---|
| `queues` | Colas de atención. `code` (`ti`), `department_code`, `responsibility_key`. Hoy una fila. |
| `categories` | Por cola: `default_priority`, `requires_branch`, `active`, orden. |
| `sla_policies` | Por prioridad: `first_response_minutes`, `resolution_minutes`, `clock` (`business`/`calendar`). |
| `settings` | Por tenant: horario hábil, `auto_close_days=3`, `escalate_at_pct=80`, `escalation_enabled=false`, tope de adjunto. |
| `requests` | **El ticket.** Folio, cola, categoría, título, descripción, `priority`, `priority_suggested`, `impact`, `blocks_work`, `status`, solicitante (**uuid** + snapshot de nombre/departamento/puesto), `warehouse_code`, `channel`, `assigned_to/by` (**uuid**) y `assigned_at`, `due_at`, `first_response_due_at`, `first_responded_at`, `resolved_*`, `closed_*`, `close_reason`, `paused_at`, `paused_minutes`, `sla_first_breached_at`, `sla_resolution_breached_at`, `escalated_at`, `reopened_count`, `external_refs jsonb`. |
| `request_messages` | Hilo: `kind` (`comment`/`status`/`assignment`/`priority`/`system`/`internal_note`), `visibility` (`public`/`internal`), `body`, `meta`. FK compuesta con `ON DELETE CASCADE`. |
| `request_attachments` | `storage_key`, `file_name`, `content_type`, `size_bytes`, `uploaded_by`. **Tabla, no jsonb**, para validar y firmar la URL en cada lectura. |
| `request_sequences` | Contador por año (folio atómico). |
| `work_log` | Tiempo trabajado por ticket (`minutes`, `started_at`, `ended_at`, `source` = `suite`/`bitacora`). **Es la paridad con la Bitácora** (su KPI central es el tiempo). |
| `notification_prefs` | Por usuario: correo sí/no, WhatsApp sí/no, **`whatsapp_opt_in_at`** (consentimiento explícito). |
| `notification_log` | Cada aviso: evento, canal, destinatario, `status`, `error`, `dedup_key`, `sent_at`. Mide **entrega**, no intención (ADR-053). |

**Fuera del schema nuevo:**
- `ALTER TABLE identity.users ADD email text NULL, phone text NULL` (teléfono normalizado con
  `public.mx_normalize_phone`). **`SET LOCAL lock_timeout='3s'`** y guard `hasColumn` — un
  `ADD COLUMN` en una tabla caliente ya encoló 11 sesiones (GOTCHAS §38).
- **Membresía de cola**: preferir `identity.user_responsibilities` (claves `servicedesk.ti.atender`
  y `servicedesk.ti.coordinar`) antes que una tabla `agents` nueva — evita una segunda fuente
  (regla "una sola tabla principal"). **Se verifica en MS.1.0**; si no alcanza, se declara.

**Permisos (6 puntos de GOTCHAS §4):**
- `SERVICIO_REPORTAR` — reportar y ver/comentar **lo propio** (self-scoped: el id sale del JWT).
- `SERVICIO_ATENDER` — bandeja, tomar, nota interna, cambiar estado, resolver, registrar tiempo.
- `SERVICIO_COORDINAR` — asignar/reasignar, cambiar prioridad, reportes, administrar catálogos/SLA.
- Reparto por **migración derivada del estado vivo** (molde `20260918170000_grant_caja_general_…`),
  `permissions -> 'KEY' IS NULL` (nunca `?`). `REPORTAR` a todo rol con personas activas, excluyendo
  `retirado_*` y cuentas `kind:'servicio'`. **Declarar un permiso no es entregarlo** (lección LC.6.2):
  `test-newdb-permission-delivery.js` lo exige.
- Hay que **re-loguear** (el permiso viaja en el JWT).

**Contrato de tarea:** `servicedesk.requests` se declara en `FUENTES_TAREA` + `ADAPTADORES`
(`pending/in_progress/done/cancelled`; `no_responde` honesto) y en `me-tasks.ts`. Mejora sobre
`recon_tasks`: `assigned_by` es **uuid**, se une al padrón.

**Puerta de salida de la capa:** smoke `test-newdb-service-desk.js` con pruebas **negativas**
(CHECK de estado/prioridad, folio sin colisión en paralelo, aislamiento de tenant, FK compuesta,
`internal_note` sin acceso desde la vista del solicitante a nivel de consulta), registrado en
`run-all-tests.js`; `check:migrations` y `check:mig-colisiones` en verde; migraciones aplicadas
**local**, nunca a prod en esta capa.

---

## 4. CAPA 2 — Lógica

**Dónde vive:** lib nueva **`libs/service-desk`** (`scope:service-desk`). Es un dominio propio, con
fronteras por puertos, y el modelo ya es multi-cola. Costo: registrar en `eslint.config.js`,
`tsconfig.base.json` **y** `tsconfig.ts7.json` (`check:ts7paths`), vitest y `AppModule` (dentro de
`multitenantModules`). *Alternativa:* un módulo dentro de una lib existente (más barato, menos
aislamiento). **Recomiendo lib nueva — decisión de Edgar (P3).**

**API `/service-desk/*`** (English snake_case, `RolesGuard` + `@RequirePermissions`, todo en `tk.run()`):

| Grupo | Endpoints |
|---|---|
| Solicitante (`REPORTAR`, self-scoped) | `POST requests` · `GET requests/mine` · `GET requests/:id` (sólo propio) · `POST requests/:id/messages` · `POST requests/:id/confirm` · `POST requests/:id/reopen` · `POST uploads` · `GET catalog` |
| Atención (`ATENDER`) | `GET inbox` (filtros) · `POST :id/take` · `/status` · `/internal-note` · `/time` · `GET agents/assignable` (selector **sin** `USUARIOS_VER`) |
| Coordinación (`COORDINAR`) | `POST :id/assign` · `/priority` · `GET stats` · CRUD `categories`/`queues`/`sla-policies`/`settings` |

**Servicios:** `RequestsService` (máquina de estados, folio, prioridad sugerida) · `MessagesService`
(filtra `visibility` en el servicio: **una nota interna jamás llega al solicitante**) ·
`AttachmentsService` · `SlaService` (cálculo de minutos hábiles con pausa — **funciones puras con
spec**) · `SlaScannerService` · `AutoCloseService` · `NotificationService` · `AssignmentService`.

- **Adjuntos:** `ObjectStorageService.putFile(..., 'servicedesk/<tenantId>/requests')`, subida
  base64 como los demás módulos, **validación de tipo (imagen/PDF por firma) y tamaño en el
  servidor**, línea propia `json({limit:'16mb'})` en `main.ts`, `signFiles` en lectura.
- **SLA:** `@Cron` cada 10 min con `timeZone:'America/Mexico_City'`, single-flight, barre tenants
  activos, aviso **fuera** de la transacción y best-effort. **Latido** a `analytics.cron_runs`
  (`service_desk_sla`) **y entrada en `CRON_JOBS`**: sin umbral registrado `db-health` lo marca
  `unknown`. El latido mide qué cambió, no que el proceso corre.
- **Notificaciones:** `SERVICE_DESK_NOTIFIER_PORT` (en `libs/contracts/src/ports/`) + binding en
  `apps/api/src/composition/` (patrón `recon-notifier`). Tres adaptadores detrás del puerto:
  campana (WebSocket), correo (`MAILER_PORT`) y WhatsApp (`WHATSAPP_PORT`, **plantilla**).
  Requiere un **room por usuario** en `/alerts` (`emitToUser`, precedente `/store`).

| Evento | Destinatario | Canal |
|---|---|---|
| Ticket creado | Solicitante | Correo (confirmación con folio) |
| Ticket `Urgente`/`Alta` nuevo | Agentes de la cola | Campana + WhatsApp + correo, inmediato |
| Ticket `Media`/`Baja` nuevo | Agentes | Campana + **resumen** diario por correo |
| Asignado / comentario del solicitante | Asignado | Campana + correo |
| `en_espera` / `resuelto` / comentario del agente | Solicitante | Correo + WhatsApp |
| 80 % del plazo / vencido | Asignado / coordinadores (resumen) | Campana + correo |

- ⛔ **El worker NO tiene WebSocket** (medido: `main.ts` arranca el worker con
  `createApplicationContext`, sin HTTP/WS; `AlertsGateway.emitToTenant` hace `if (!this.server)
  return`; en prod `ENABLE_WORKER_QUEUE=true`, o sea que **los crons corren sólo en el worker**).
  Un `emit` de campana lanzado desde el SLA, el auto-cierre o el resumen **se pierde en silencio**
  (ADR-080 "Declarado, no resuelto"). Diseño para no depender de eso:
  - Lo originado por **una persona** (crear, asignar, comentar) pasa por el API → campana en vivo.
  - Lo originado por **un cron** (80 % del plazo, vencido, auto-cierre, resumen) sale por
    **correo y WhatsApp** (funcionan en el worker) y deja además una fila `channel='app'` en
    `notification_log`; la campana la recoge en su siguiente poll (`core/utils/poll-visible`).
  - No se instala `@socket.io/redis-emitter` por esta fase: es una decisión de infraestructura
    de ADR-080, no de la Mesa de Servicio.
- **Un aviso que falla nunca tumba la creación del ticket**, pero el fallo **se registra** en
  `notification_log` y la pantalla lo muestra ("aviso no enviado"): lo que no se pudo medir se
  **declara**, no se dibuja como entregado (ADR-056).
- **Anti-spam:** `dedup_key` por evento+ticket+destinatario, resumen en vez de una fila por aviso.
- **Contratos HTTP** en `libs/contracts/src/http/service-desk.contract.ts` (compartidos con la
  vista; el endpoint de `stats` declara `freshness`, gate `check:provenance`).
- **Puente con la Bitácora**: `BITACORA_PORT` con `NullBitacoraAdapter` por defecto. Ver §5.

**Puerta de salida de la capa:** `nx build api` + `check:boot` (el API **arranca**) + spec del
cálculo SLA + **verificación HTTP end-to-end**: el solicitante **no ve** tickets ajenos ni notas
internas; 403 sin permiso; un **segundo tenant** no ve nada; flujo completo
crear→asignar→resolver→confirmar→cierre; el aviso fallido queda registrado. Los endpoints de
escritura self-scoped se declaran en `PERMITIDAS` de `test-authz-route-coverage.js` con motivo.

---

## 5. Unificación Bitácora ↔ task (escenario preparado, no ejecutado)

**Hecho verificado:** la Bitácora (Apps Script + Google Sheet `Resumen_Semanal`, hoja `Bitacora`)
ya modela casi lo mismo que un ticket: `folio`, `etapa`, `prioridad`, `fechaLimite`, `solicitante`,
`medioSolicitud` (incluye el valor **`Ticket`**), `problema`, `proximaAccion`, `historial`,
`asignadoA`, `minutes`/`tiempoHist`. Las etapas vigentes son Solicitud · Programada · Asignada ·
En proceso · Implementada · Cerrada, y sus prioridades Baja/Media/Alta/Urgente **coinciden con D2**.

**Estrategia en tres pasos — sólo el primero entra al MVP:**

1. **Preparado (MS.1–MS.2):** el ticket **es** la tarea en la Suite (`assigned_*` declarado en el
   contrato de tarea → "A tu nombre"). `work_log` captura el **tiempo** que hoy sólo vive en la
   Bitácora. `external_refs jsonb` guarda `bitacora_id`/`bitacora_folio`. `BITACORA_PORT` define
   `onTicketAssigned/onStatusChanged/onTimeLogged`; adaptador por defecto = **no-op**.
2. **Puente (MS.8):** `AppsScriptBridgeAdapter` — POST saliente al `doPost` del Apps Script con
   clave secreta (patrón que Inventario de Equipos ya usa), creando la fila con
   `medioSolicitud:'Ticket'` y el folio `SRV-…`. ⛔ **Sólo con el checkpoint y la confirmación de
   Felipe**: el `Code_FINAL.gs` local **no contiene** ese `doPost`, así que hay que ver el script
   vivo antes. Reglas del propio ONBOARDING: nunca pegar sobre `Código.gs`, publicar "Nueva
   versión", validar con `node --check` y `checkUI()`.
3. **Unificación (post-MVP, decisión de Edgar/Felipe):** la Suite pasa a ser el sistema de registro
   de la bitácora de Sistemas (pantalla "Mi bitácora" con tiempo y etapas) y la Hoja queda como
   archivo/alimentador de Power BI. **No incluye** los módulos de Contabilidad 1/2 (pólizas y
   cheques), que son otro dominio.

⚠️ **Supuesto a confirmar (P2):** interpreto "cada ticket genera su tarea en la Bitácora/task"
como *(a)* tarea en la Suite = la propia fila del ticket y *(b)* tarea en la Bitácora = el puente
del paso 2. Si Edgar quería otra cosa, se ajusta antes de MS.2.8.

---

## 6. CAPA 3 — Visual

Módulo `apps/view/src/app/modules/servicio/`, superficie **Operations** (tabla densa + side-peek,
sin Fraunces ni ilustraciones). Reglas de `DESIGN.md`: tokens (cero hex crudo), matriz completa de
estados (vacío ≠ error), light/dark/móvil, paginación del servidor 25–50, UI optimista y botón
deshabilitado al primer clic, `p-tag` mapeado a tokens ok/warn/bad. Componentes compartidos:
`MetricStrip`, `PageTabs`, `SidePeek`, `LoadState`, `FreshnessPill`, `ContextHelp`, `doc-viewer`,
`camera-shot`, `MeContextService`.

| Pantalla | Ruta | Para quién | Contenido |
|---|---|---|---|
| **Nueva solicitud** | `/servicio/nueva` | todos (`REPORTAR`) | Formulario corto. Precarga solicitante/puesto/departamento/sucursal (`me/context`, sucursal editable). Cola, categoría con búsqueda, título, descripción, **impacto** y **"me bloquea"**, adjuntos y cámara. Al enviar: folio + qué canal recibirá el aviso. |
| **Mis solicitudes** | `/servicio/mis-solicitudes` | todos | Tabla + side-peek con hilo (sin notas internas), **confirmar resuelto** / **reabrir**, comentar. |
| **Bandeja de atención** | `/servicio/atencion` | `ATENDER` | `MetricStrip` (abiertas · sin asignar · por vencer · vencidas · mediana de resolución) · pestañas **Sin asignar / Mías / En espera / Todas** · filtros (prioridad, sucursal, categoría) · columna **semáforo SLA** · side-peek 520 px con hilo, **nota interna**, tomar/asignar/prioridad/estado, **registrar tiempo**, adjuntos. |
| **Reportes** | `/servicio/reportes` | `COORDINAR` | Cumplimiento de SLA y tiempos de 1ª respuesta/resolución por prioridad, por categoría y por sucursal, recurrentes. `FreshnessPill`. |
| **Configuración** | `/servicio/configuracion` | `COORDINAR` | Categorías, SLA, horario, membresía de cola. |
| **Mis datos de contacto** | diálogo | todos | Correo, teléfono y **opt-in explícito de WhatsApp**. Se ofrece al primer reporte si faltan. Los mismos campos entran al alta de usuario en Admin. |

**Prioridad visual:** Baja (neutro) · Media (info) · Alta (warn) · Urgente (bad), con **tokens**, no
con los hex de la Bitácora. Los nombres de sucursal salen de `branchName()` / el catálogo.

**Integración con la Suite:**
- **Mi trabajo:** tarjeta "Solicitudes a tu nombre" (`FUENTES_VISIBLES`) y bandeja "Sin asignar"
  (`BANDEJAS` con `umbral_dias` y `responsabilidad`, que sólo ve quien responde de la cola).
- **Mapa de la suite:** el espacio 9 **ya está `active`** (Fase DEV); se le agrega la entrada `servicio`
  junto a `desarrolladores` y se actualiza la descripción ("solicitudes" deja de ser "sin módulo").
  Los specs de `suite-map` ya asumen 2 espacios `planned`; se revisan los que cuentan entradas del 9.
- **Layout:** entrada en `PROJECT_KEY`/`LayoutProject` y su grupo de navegación; sin eso el sidebar
  cae al de Trade Marketing. Fila nueva en la tabla de superficies de `DESIGN.md`.

> ⚠️ **Consecuencia no obvia de "todos reportan".** La landing `/projects` auto-entra cuando una
> persona tiene **un solo destino**. Si `SERVICIO_REPORTAR` hiciera visible el espacio 9 para todos,
> **cajeras, almacenistas y demás roles de un destino perderían la auto-entrada** y verían un
> mosaico. Diseño para evitarlo: `SERVICIO_REPORTAR` vive en un módulo **sin `route`** del árbol
> (concedible y visible en `/admin/roles`, pero no aterriza), y el reporte se alcanza por un
> **botón "Reportar un problema"** en el header del layout, no como destino del mapa. El espacio 9
> sólo aparece para quien tiene `ATENDER`/`COORDINAR`. **Se valida con `validateSuiteMap` antes de
> construir.**

**Alcance real por superficie (declarado, no prometido):**

| Quién | Entra por | Fase |
|---|---|---|
| Usuarios de `apps/view` (oficina, gerencias) | botón del header + Mi trabajo | **MVP** |
| Cajeras / tienda (`/tienda`), tele-operadores (`/telemarketing`) | el botón del header del layout (ya lo montan; medido en navegador) | MS.3.7 |
| Vendedores y repartidores (`apps/vendor`, **sin `/projects`**) | pantalla nueva en `apps/vendor` | MS.5 |
| Sin cuenta | enlace público con token (patrón `captura/:token`) | MS.5, no comprometido |

**Puerta de salida de la capa:** `nx build view`, `check:templates` (un acento grave en un
comentario de `template:` rompe el build), `check:tokens`, `check:tables`,
`check-signal-reactivity`, `check-primeng-api`, `landing-guards.spec.ts`, y **validación visual
manual** (light, dark y móvil) — el único paso que no se automatiza.

---

## 7. Sprints

**MS.0 — Preparación** ✅ 2026-10-01: copia local al día (`main` = `ece8269f1`, rama
`docs/ms-mesa-de-servicio`), `CLAUDE.md` corregido (prod on-prem), esta fase, ADR-081, tracker.

**Capa 1 — Base de datos** · 🧪 **construida y probada en local 2026-10-02** (ver §11)
- ✅ **MS.1.0** Verificaciones previas. **Hecho lo que se podía leer desde desarrollo:** `user_responsibilities`
  alcanza para la membresía, y los timestamps no colisionan en git. **NO MEDIDO (sin acceso a prod):**
  `SMTP_*` en prod, destino del bucket de adjuntos y último timestamp de `knex_migrations` de prod.
- 🧪 **MS.1.1** Schema + catálogos (`queues`, `categories`, `sla_policies`, `settings`) + seeds de TI. Mig `20261002100000`.
- 🧪 **MS.1.2** `requests`, `request_sequences`, `request_messages`, `request_attachments`, `work_log`. Mig `20261002110000`.
- 🧪 **MS.1.3** `notification_prefs`, `notification_log` y `identity.users.email/phone`. Mig `20261002120000`.
- 🧪 **MS.1.4** Permisos (`REPORTAR/ATENDER/COORDINAR`) en enum, metadata, árbol y mapa de la suite + reparto
  derivado. Mig `20261002130000`. **La clave de responsabilidad se movió a MS.3.6** (ver §11).
- 🧪 **MS.1.5** Contrato de tarea: `servicedesk.requests` declarada en `FUENTES_TAREA`/`ADAPTADORES`. La entrada
  visible en `me-tasks.ts` se hizo en MS.3.6 (con su ruta).
- 🧪 **MS.1.6** Smoke DB-direct `test-newdb-service-desk.js`: **130 ✓ / 0 ✗**, registrado en `run-all-tests.js`.

**Capa 2 — Lógica**
- ⬜ **MS.2.1** Scaffold `libs/service-desk` + registros (eslint, tsconfig×2, vitest, `AppModule`).
- ⬜ **MS.2.2** Contratos HTTP y puertos en `libs/contracts`.
- ⬜ **MS.2.3** `RequestsService` + máquina de estados + `MessagesService`.
- ⬜ **MS.2.4** Adjuntos (validación de servidor, límite en `main.ts`, URLs firmadas).
- ⬜ **MS.2.5** SLA (funciones puras + spec), scanner con latido y `CRON_JOBS`, auto-cierre.
- ⬜ **MS.2.6** Notificaciones: puerto, binding, room por usuario en `/alerts`, anti-spam, log, y
  **canal `app` por poll para lo que nace en el worker** (que no tiene WebSocket).
- ⬜ **MS.2.7** Asignación, selector de agentes sin `USUARIOS_VER`, endpoints de configuración.
- ⬜ **MS.2.8** `BITACORA_PORT` + `NullBitacoraAdapter` + `work_log` endpoints.
- ⬜ **MS.2.9** Verificación HTTP end-to-end + `build` + `check:boot`.

**Capa 3 — Visual**
- ⬜ **MS.3.1** Módulo, rutas (`/servicio/atencion`, `/servicio/reportes`), guards, nav, `PROJECT_KEY`, **mover `servicio` de `SUITE_UNCLASSIFIED` al espacio 9 (ya activo por DEV)**, landing, specs (`suite-map` 14→15), `DESIGN.md`. **Todo junto**: nunca una entrada en el mapa sin su pantalla.
- ⬜ **MS.3.2** Nueva solicitud + datos de contacto (+ campos en Admin usuarios).
- ⬜ **MS.3.3** Mis solicitudes + side-peek con hilo.
- ⬜ **MS.3.4** Bandeja de atención.
- 🧪 **MS.3.5** Reportes + Configuración. Ambos hechos: `/servicio/reportes` (en vivo, sin ranking de personas, sin semáforo, sin ceros dibujados). Ver tracker.
- 🧪 **MS.3.10** Asignación automática por persona (categoría o palabra clave; gana la primera por orden; nunca a quien no puede atender; la asigna el sistema y NO cuenta como primera respuesta). Ver tracker.
- 🧪 **MS.3.6** Integración con Mi trabajo. «A tu nombre» hecho (5ª fuente de `me-tasks.ts`, enlaza a `/servicio/bandeja?scope=mine`; el ticket `en_espera` cuenta pero no vence). La clave `servicio.atender` y su bandeja se hicieron en **MS.3.8** (plazo de 60 min hábiles, ajustable; la clave no se repartió a nadie).
- ✅ **MS.3.7** Botón en los shells de tienda y telemarketing. **Ya existía** (montan el mismo `LayoutComponent`; verificado en navegador). Candado `servicio/entradas.spec.ts`.
- ⬜ **MS.3.9** Validación visual light/dark/móvil.

**MS.4 — Cierre y despliegue:** tracker, CHANGELOG, log de revisiones, ADR-081 → aceptado; en
prod, **una migración a la vez** (`apply-one-migration-prod.js`), re-login, `SMTP_*`, plantilla de
Meta.

**MVP = MS.1 completo + MS.2.1–2.7 y 2.9 + MS.3.1–3.4 y 3.9.**

**Post-MVP (declarado, no construido):** MS.5 alcance de campo (vendor, enlace público) ·
MS.6 auto-asignación balanceada (patrón `assignPending` de `recon_tasks`) · MS.7 más colas
(Mantenimiento) · MS.8 puente Bitácora real y unificación · MS.9 vínculo con inventario de equipos
(`asset_id`).

---

## 8. Riesgos y trampas heredadas

- **Migraciones:** timestamp `202610…` **único** (con ~10 sesiones concurrentes ya hubo
  duplicados); jamás editar una aplicada; `SET LOCAL lock_timeout` en DDL de tablas calientes;
  `GRANT USAGE ON SCHEMA`; en prod, una por una, **nunca `migrate:latest`**.
- **Los crons corren sólo en el worker y el worker no emite por WebSocket** (ver §4): la prueba de
  MS.2.9 debe cubrir un aviso de SLA **originado en el worker**, no sólo uno originado en el API.
- **Siempre `TenantKnexService.run()`** (RLS forzado); lo cross-tenant y los crons con
  `KNEX_NEW_DB_ADMIN`.
- **Tipado:** `lint:boundary` exige return types explícitos en `*.controller.ts`/`*.service.ts`.
- **Un gate sin prueba negativa es una intención:** cada compuerta nueva se rompe a propósito una vez.
- **Cuentas compartidas** (checador, etiquetera, verificador): no tienen una persona detrás.
  Decisión por defecto: **no** reciben `SERVICIO_REPORTAR`.
- **Privacidad:** una nota interna filtrada al solicitante es el fallo más caro de esta fase; se
  filtra en el servicio y se cubre con una prueba HTTP dedicada.

## 9. Pendientes por decidir / confirmar

| # | Qué | Por qué importa |
|---|---|---|
| **P1** ✅ | **Nombre de la sucursal 06 — resuelto 2026-10-01:** se toma **tal cual está en el catálogo** (`Canindo`, `La Piedad Abastos`). El módulo no escribe nombres a mano. | Si algún día se quiere «Canindo Abastos», es un cambio del catálogo (`branches.ts`, `store-branches.ts`, `commercial.warehouses.name`) y el módulo lo hereda solo. |
| **P2** | Confirmar la interpretación de "tarea en la Bitácora/task" (§5). | Define qué construye MS.2.8 / MS.8. |
| **P3** | Lib nueva `libs/service-desk` vs módulo dentro de una lib existente. | Costo de arranque vs aislamiento. |
| **P4** ✅ | **Personas de la cola — resuelto 2026-10-01:** Jorge Rubio (Sistemas), Edgar (Desarrollo) y Frank (Dirección General). **Falta definir el rol de cada uno** (quién atiende, quién coordina); se propone en MS.1.4 contra el padrón real. | Alimenta responsabilidades y el reparto de permisos. Frank está en otro departamento que los otros dos: la membresía por puesto no basta, requiere excepción por persona (`user_responsibilities`, con nota obligatoria). |
| **P5** ⏸️ | **Dependencias externas — decisión 2026-10-01: «solo construye».** SMTP en prod, plantilla de Meta y bucket NO se gestionan en esta entrega: la Mesa de Servicio se **construye** y el despliegue/avisos reales se resuelven **cuando se unifique con task**. | El código de avisos se escribe detrás del puerto y se prueba con adaptadores simulados; `MS.4` (despliegue) queda diferido. |
| **P6** | ¿El reloj de `Urgente` es calendario (24/7), como propongo? | Cambia cuándo se marca un incumplimiento. |

## 10. Declarado, no construido

- Código de cualquier capa (sólo diseño).
- Telemetría de uso previa: no se midió cuántos reportes reales hay hoy. La Bitácora tiene ~515
  filas pero mezcla tareas propias con solicitudes; **no se importa su histórico**.
- Auto-asignación, enlace público, app de vendedor, más colas y la unificación completa.
- Los números del SLA son una **propuesta sin calibrar**.

---

## 11. Capa 1 — lo construido, y lo que cambió respecto a lo aprobado en el PR #204

Estado: **🧪 construida y probada en LOCAL (2026-10-02). Nada aplicado a prod.** Cuatro migraciones, tres
permisos y un smoke de 130 aserciones. La solicitud aprobada decía *qué* se pedía; al construirlo
hubo que decidir detalles que la solicitud no fijaba y **dos cosas que se apartan de ella**. Se dicen
aquí, no en la revisión del PR.

### Lo que se apartó de la solicitud (decisión a confirmar por Edgar)

| # | Solicitud (PR #204) | Lo construido | Por qué |
|---|---|---|---|
| 1 | **2 claves** de responsabilidad en `identity.responsibilities` (`servicio.atender` y `servicio.coordinar`) | **Ninguna en la capa 1.** Se crea **una** (`servicio.atender`) en **MS.3.6**, con su bandeja. `servicio.coordinar` se retira: coordinar es un *permiso*, no una cola de la que alguien responda | `test-newdb-me-context.js` exige que **toda** clave del catálogo tenga una cola declarada en `me-work.ts` con su ruta (y cuenta el catálogo: `=== 18`). Crearlas ahora, sin la bandeja ni la pantalla, rompe una prueba existente. `queues.responsibility_key` existe y nace NULL |
| 2 | 2 columnas nuevas en `identity.users` | Esas 2 columnas **más 2 CHECK de formato** (`users_email_fmt_ck`, `users_phone_fmt_ck`) | El teléfono debe ser el canónico `52XXXXXXXXXX` que ya produce `mx_normalize_phone`; sin el CHECK cualquiera guardaría uno sin normalizar y el aviso por WhatsApp fallaría en silencio. Se agregaron **con** `lock_timeout` y guarda de columna |

### Detalles que la solicitud no fijaba (y quedaron así)

- **`ATENDER` y `COORDINAR` se reparten SÓLO a `superadmin` y `sistemas`.** La asignación por persona
  (Jorge, Edgar, Frank) espera a que Edgar confirme el **rol real** de cada uno (P4); se hará por
  `identity.user_permissions`, con nota, desde `/admin/usuarios`. En mi base local **no existe** el rol
  `sistemas` (prod sí), y la migración lo imprime en vez de callarlo.
- **`SERVICIO_REPORTAR` se reparte a todo rol salvo** `retirado_*`, `customer_b2b`, `servicio` y tres cuentas
  compartidas de dispositivo (`checador_kiosco`, `verificador_precios`, `etiquetas_tienda`).
- **`notification_log` es insert-only con tres estados** (`sent`/`failed`/`skipped`), sin `queued`: se inserta
  una sola vez con el resultado final. La anti-repetición es un índice único **sólo sobre lo `sent`**, para
  que un intento fallido se pueda reintentar.
- **Un «día hábil» se siembra como 480 minutos** (8 h de trabajo), no como la ventana entera de 11 h.
- **Invariantes que la base hace cumplir** y que la solicitud no listaba: la máquina de estados completa
  (asignado ⇒ asignado, en_espera ⇔ reloj pausado, resuelto ⇒ hora, cerrado/cancelado ⇒ motivo), el formato
  del folio, y «una nota interna jamás es pública».
- **`SERVICIO_REPORTAR` vive en un módulo SIN ruta del árbol** (precedente: WhatsApp), y la categoría
  `Mesa de Servicio` se declaró en `PERMISSION_CATEGORY_ORDER` (sin eso los 3 permisos no se renderizan en
  `/admin/roles`: el mismo defecto de AU.6).
- **El proyecto `servicio` entra al árbol SIN RUTAS y a `SUITE_UNCLASSIFIED` (como WhatsApp), no al espacio 9.**
  Mi primer intento lo puso en el espacio 9 con sus rutas, y las pruebas de la web lo rechazaron
  (`landing-guards.spec`: «cada proyecto con entrada primaria necesita su landing»). Pensándolo, además era
  un defecto de fondo: con la entrada en el mapa antes que su pantalla, un superadmin vería una **puerta que
  no lleva a ningún lado** y el auto-deploy de `main` la mandaría a prod. Las rutas
  (`/servicio/atencion`, `/servicio/reportes`), el paso al espacio 9 y el landing llegan **juntos con las
  pantallas, en MS.3.1**. Mientras tanto las 3 claves ya se reparten y se ven en `/admin/roles`.

### Una compuerta existente que hubo que mejorar

`test-newdb-task-contract.js` elegía **el primer CHECK que menciona la columna de estado** como si fuera el
vocabulario. Una tabla con máquina de estados tiene varios CHECK que nombran `status`, y tomaba uno de 2
valores. Ahora elige el que **más valores distintos** enumera; con un solo CHECK (las otras cuatro fuentes) el
resultado es idéntico. No se tocó ninguna otra aserción.

### Lo que NO se pudo medir, y se dice

- **`test-newdb-permission-delivery.js` mide el padrón de PROD** (por SSL). Corrió contra la base local
  con un precargado temporal: confirma que las 3 claves no aparecen en ningún problema, pero sus otros
  rojos son artefactos de una base casi vacía. **Sin medir contra prod.**
- **`check:mig-colisiones`** pide leer el ledger de prod: sólo corrió su variante `--solo-git` (✓ sin colisión).
- **`SMTP_*`, bucket y `knex_migrations` de prod:** sin acceso desde desarrollo (MS.1.0).
- **Dos rojos preexistentes en `main`, ajenos a esta fase:** `commercial.picking_waves` (tiene `assigned_to`
  y nunca se declaró en el contrato de tarea desde el 17-sep) y «0 asignaciones nominales» (exige datos).

### Cómo se probó (y por qué la base local es de mentira)

La base de desarrollo `192.168.0.245` ya no existe, y `migrate:new` **no levanta una base vacía** (GOTCHAS §75).
Se armó un Postgres desechable en Docker (`127.0.0.1:5442`) completando lo que prod tiene por historia: las
235 tablas de `kepler_ods` (vacías, desde el snapshot de esquema de prod), una vista materializada que en
prod es tabla, dos extensiones en el schema equivocado, el tenant, roles, zonas y un usuario. **Se saltaron ~80
migraciones** que asertan sobre datos reales del ERP o sobre personas concretas de prod. **Esa base NO es
prod:** valida la estructura y las invariantes de `servicedesk`, no el comportamiento con datos reales.
