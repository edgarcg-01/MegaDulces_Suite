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
- **El hueco ya está reservado**: el espacio 9 "Sistemas, Servicios y Mantenimiento" está `planned`
  y sin entradas (`libs/contracts/src/authz/suite-map.ts:457`, P-10).
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
- **Mapa de la suite:** espacio 9 pasa a `active`; hay que actualizar `suite-map.spec.ts` (:70-73 y
  :215) y `suite-map.parity.spec.ts`, que asumen 3 espacios `planned`.
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
| Cajeras / tienda (`/tienda`), tele-operadores (`/telemarketing`) | botón propio en su shell | MS.3.7 |
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

**Capa 1 — Base de datos**
- ⬜ **MS.1.0** Verificaciones previas, sólo lectura: ¿alcanza `user_responsibilities` para la
  membresía?; `MAILER_PORT.isConfigured()` y `SMTP_*` **en prod**; destino real del bucket de
  adjuntos (el README de prod lo lista "sin portar"); último timestamp en `public.knex_migrations`
  de prod.
- ⬜ **MS.1.1** Schema + catálogos (`queues`, `categories`, `sla_policies`, `settings`) + seeds de TI.
- ⬜ **MS.1.2** `requests`, `request_sequences`, `request_messages`, `request_attachments`, `work_log`.
- ⬜ **MS.1.3** `notification_prefs`, `notification_log` y `identity.users.email/phone`.
- ⬜ **MS.1.4** Permisos (`REPORTAR/ATENDER/COORDINAR`) + reparto derivado + responsabilidades.
- ⬜ **MS.1.5** Contrato de tarea (`FUENTES_TAREA`/`ADAPTADORES`/`me-tasks.ts`).
- ⬜ **MS.1.6** Smoke DB-direct con negativas + registro en `run-all-tests.js`.

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
- ⬜ **MS.3.1** Módulo, rutas, guards, nav, `PROJECT_KEY`, espacio 9 activo, specs, `DESIGN.md`.
- ⬜ **MS.3.2** Nueva solicitud + datos de contacto (+ campos en Admin usuarios).
- ⬜ **MS.3.3** Mis solicitudes + side-peek con hilo.
- ⬜ **MS.3.4** Bandeja de atención.
- ⬜ **MS.3.5** Reportes + Configuración.
- ⬜ **MS.3.6** Integración con Mi trabajo.
- ⬜ **MS.3.7** Botón en los shells de tienda y telemarketing.
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
| **P1** | **Nombre de la sucursal 06.** El catálogo (`branches.ts`, `store-branches.ts`) dice **"Canindo"**; "**Canindo Abastos**" sólo existe como nombre de cuenta (`TLMKT Canindo Abastos`) y en un importer. "La Piedad Abastos" (02) sí coincide. | Renombrar es un cambio del **catálogo** (y de `commercial.warehouses.name`), fuera de esta fase. El módulo ya resuelve el nombre del catálogo, así que se corrige en un solo lugar. |
| **P2** | Confirmar la interpretación de "tarea en la Bitácora/task" (§5). | Define qué construye MS.2.8 / MS.8. |
| **P3** | Lib nueva `libs/service-desk` vs módulo dentro de una lib existente. | Costo de arranque vs aislamiento. |
| **P4** | ¿Quién es coordinador de TI y quiénes son agentes? | Alimenta responsabilidades y el reparto de permisos. |
| **P5** | **Dependencias externas:** `SMTP_*` configurado en prod (hoy sin confirmar; el correo queda **apagado** sin eso) · **plantilla de utilidad aprobada por Meta** para WhatsApp (OBS.5 ya figura ⚠️ BLOCKED por lo mismo) · bucket de adjuntos en prod. | Sin esto, "avisa por número y correo" no sale a producción aunque el código esté listo. |
| **P6** | ¿El reloj de `Urgente` es calendario (24/7), como propongo? | Cambia cuándo se marca un incumplimiento. |

## 10. Declarado, no construido

- Código de cualquier capa (sólo diseño).
- Telemetría de uso previa: no se midió cuántos reportes reales hay hoy. La Bitácora tiene ~515
  filas pero mezcla tareas propias con solicitudes; **no se importa su histórico**.
- Auto-asignación, enlace público, app de vendedor, más colas y la unificación completa.
- Los números del SLA son una **propuesta sin calibrar**.
