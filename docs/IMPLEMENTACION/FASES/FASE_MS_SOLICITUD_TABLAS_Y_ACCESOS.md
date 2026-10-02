# Fase MS — Solicitud de tablas y accesos

> **Para qué es este documento.** Pide aprobación de **todo lo que la Mesa de Servicio va a crear o
> tocar en la base de datos y en los permisos**, y para qué lo usa cada cosa, **antes** de escribir
> una sola migración. Se aprueba (o se corrige) aquí; después se construye.
>
> Plan completo en [`FASE_MS_MESA_DE_SERVICIO.md`](FASE_MS_MESA_DE_SERVICIO.md) · decisión en
> ADR-081. Este documento no cambia el plan: lo baja a tabla, columna y permiso.

Estado: **📋 SOLICITADO 2026-10-01 — aprobado por Edgar al mergear el PR #204.** Construido en la capa 1
(2026-10-02).

> ⚠️ **Actualización 2026-10-02 — dos cosas se apartaron de esta solicitud al construirla:** (1) en vez de **2**
> claves de responsabilidad se crea **1** (`servicio.atender`), en MS.3.6 y no en la capa 1; y (2) `identity.users`
> gana, además de las 2 columnas, **2 CHECK de formato**. Detalle y motivos en
> [`FASE_MS_MESA_DE_SERVICIO.md` §11](FASE_MS_MESA_DE_SERVICIO.md). El resto de la solicitud se construyó tal cual.

---

## 1. Resumen en una pantalla

| Qué | Cantidad | Riesgo |
|---|---|---|
| **Tablas nuevas** (schema nuevo `servicedesk`) | 11 | Bajo. Schema propio, no toca nada existente. |
| **Columnas nuevas en tablas existentes** | 2 (`identity.users.email`, `identity.users.phone`) | Medio. Tabla caliente: se hace con `lock_timeout`. |
| **Filas nuevas en catálogos existentes** | 2 (`identity.responsibilities`) | Bajo. |
| **Permisos nuevos** | 3 (`SERVICIO_REPORTAR`, `SERVICIO_ATENDER`, `SERVICIO_COORDINAR`) | Medio. Se reparten a roles; hay que re-loguear. |
| **Roles de base de datos nuevos** | 0 | — |
| **Escrituras en Kepler / `kepler_ods` / tablas ajenas** | 0 | — |
| **Variables de entorno / servicios externos** | 0 en esta entrega (se difiere, ver §6) | — |

Todo es **aditivo**. Nada se borra, renombra ni cambia de tipo.

---

## 2. Tablas nuevas — schema `servicedesk`

**Reglas comunes de todas** (las del proyecto, no inventadas): `id uuid` PK, `tenant_id uuid NOT NULL`,
campos de auditoría (`created_at/by`, `updated_at/by`, `deleted_at/by`), `UNIQUE (tenant_id, id)`,
llaves foráneas compuestas `(tenant_id, x_id)`, **RLS activado y forzado** con la política
`tenant_isolation`, y `GRANT USAGE ON SCHEMA servicedesk TO app_runtime` (sin eso el API falla con
42501; ya pasó con `budget`). Borrado lógico con `deleted_at`.

| # | Tabla | Para qué la usa la Mesa de Servicio | Columnas clave |
|---|---|---|---|
| 1 | `queues` | Las **colas de atención**. Hoy una sola, **TI**. Es lo que permite sumar Mantenimiento u otra área después con una fila y sin rediseñar. | `code`, `name`, `department_code`, `responsibility_key`, `active`, `sort_order` |
| 2 | `categories` | Las **categorías** que elige quien reporta (Soporte a sucursal, Kepler, Redes, CCTV…). Cada una trae su prioridad por defecto y si exige indicar sucursal. Se editan desde pantalla, sin deploy. | `queue_id`, `code`, `name`, `default_priority`, `requires_branch`, `active` |
| 3 | `sla_policies` | Los **plazos por prioridad** (primera respuesta y resolución, reloj corrido u hábil). Están en tabla para poder **calibrarlos** sin tocar código. | `priority`, `first_response_minutes`, `resolution_minutes`, `clock` |
| 4 | `settings` | **Una fila por tenant**: horario hábil, zona horaria, días para el auto-cierre, % de aviso, si el escalamiento está encendido y el tope de adjuntos. | `business_days`, `business_start/end`, `tz`, `auto_close_days`, `escalate_at_pct`, `escalation_enabled`, `max_attachment_mb` |
| 5 | `request_sequences` | El **contador del folio** `SRV-AAAA-NNNNN`, con UPSERT atómico para que dos tickets simultáneos no repitan folio. | `year`, `last_value` |
| 6 | **`requests`** | **El ticket.** Es la tabla central: quién reporta, qué, con qué prioridad, en qué estado, quién lo atiende y cuándo vence. Además **es la tarea** de quien lo atiende (se declara en el contrato de tarea y aparece en "A tu nombre" de Mi trabajo). | `folio`, `queue_id`, `category_id`, `title`, `description`, `priority`, `priority_suggested`, `impact`, `blocks_work`, `status`, `requester_id` (uuid) + snapshot de nombre/departamento/puesto, `warehouse_code`, `channel`, `assigned_to/by/at` (uuid), `due_at`, `first_response_due_at`, `first_responded_at`, `resolved_*`, `closed_*`, `paused_at`, `paused_minutes`, `sla_*_breached_at`, `reopened_count`, `external_refs` (jsonb) |
| 7 | `request_messages` | El **hilo** del ticket: comentarios, cambios de estado/asignación/prioridad y **notas internas** que el solicitante nunca ve. | `request_id`, `kind`, `visibility` (`public`/`internal`), `author_id`, `body`, `meta` |
| 8 | `request_attachments` | **Fotos y PDF** del ticket. Es tabla y no un campo jsonb para poder **validar tipo y tamaño** y firmar la URL en cada lectura. El archivo vive en el bucket; aquí solo su llave. | `request_id`, `message_id`, `storage_key`, `file_name`, `content_type`, `size_bytes` |
| 9 | `work_log` | El **tiempo trabajado** por ticket. Hoy ese dato solo vive en la Bitácora de Sistemas; esto prepara la unificación con ella. | `request_id`, `user_id`, `minutes`, `started_at`, `ended_at`, `source` |
| 10 | `notification_prefs` | Por usuario: **si quiere correo y/o WhatsApp**, y **cuándo aceptó WhatsApp** (consentimiento explícito, requisito del canal). | `user_id`, `email_enabled`, `whatsapp_enabled`, `whatsapp_opt_in_at` |
| 11 | `notification_log` | **Cada aviso enviado**: evento, canal, destinatario, resultado y error. Permite que la pantalla diga "aviso no enviado" en vez de fingir que llegó, y evita avisos repetidos (`dedup_key`). | `request_id`, `event`, `channel`, `recipient_id`, `status`, `error`, `dedup_key`, `sent_at` |

**Restricciones de integridad (todas con `CHECK`):** `status` ∈ {nuevo, asignado, en_proceso, en_espera,
resuelto, cerrado, cancelado} · `priority` ∈ {baja, media, alta, urgente} · `impact` ∈ {yo, varios,
sucursal, red} · `visibility` ∈ {public, internal} · `clock` ∈ {business, calendar} ·
`UNIQUE (tenant_id, folio)`.

---

## 3. Cambios sobre tablas existentes

| Dónde | Cambio | Para qué | Cuidado |
|---|---|---|---|
| `identity.users` | `ADD email text NULL`, `ADD phone text NULL` | Hoy **no existe** forma de avisar a una persona por correo ni por WhatsApp. El teléfono se normaliza con `public.mx_normalize_phone` (ya existe, hoy solo para clientes). Ambas columnas son opcionales. | Tabla caliente: `SET LOCAL lock_timeout='3s'` y guarda `hasColumn` (un `ADD COLUMN` ya encoló 11 sesiones, GOTCHAS §38). Al **revertir**, quitar columnas exige tu confirmación expresa (regla del proyecto). |
| `identity.responsibilities` (catálogo del producto) | `INSERT` de 2 claves: `servicio.atender` y `servicio.coordinar` | Es la forma ya existente de decir **quién responde de una cola**. Evita crear una tabla `agents` nueva (una segunda fuente de verdad). | `libs/trade/src/lib/users/me-work.ts` tiene `ResponsabilidadKey` como unión cerrada: se agregan las 2 claves ahí. |
| `identity.role_permissions` (jsonb) | Reparto de los 3 permisos nuevos (ver §4) | Entregar el permiso a quien corresponde. **Declarar un permiso no es entregarlo.** | Con `permissions -> 'KEY' IS NULL` (nunca el operador `?`) y apuntando por `id` de fila. |
| `analytics.cron_runs` | Una fila nueva de latido: `job_key='service_desk_sla'` (datos, no estructura) | Que `db-health` vea si el revisor de plazos corre y entrega. | Se registra también en `CRON_JOBS`; sin umbral registrado el tablero lo marca `unknown`. |

**Código (no es base de datos, pero también se toca):** `libs/contracts` (3 permisos en el enum,
`permission-meta`, `authz-tree`, `suite-map` con una entrada nueva en el espacio 9, que ya activó la
Fase DEV, y el contrato de tarea) y los
tests que dependen de eso.

---

## 4. Accesos

### 4.1 Permisos de la aplicación

| Permiso | Qué permite | A quién (propuesta) |
|---|---|---|
| `SERVICIO_REPORTAR` | Reportar un problema, y ver/comentar **solo lo propio** (el id sale del JWT, nunca del cuerpo). | **Todos** los roles con personas activas, derivado del estado vivo. Excluye roles `retirado_*` y cuentas `kind:'servicio'`. **No** se da a cuentas compartidas (checador, etiquetera, verificador): no hay una persona detrás. |
| `SERVICIO_ATENDER` | Ver la bandeja de la cola, tomar tickets, nota interna, cambiar estado, resolver, registrar tiempo. | **Jorge Rubio** (Sistemas) y **Edgar** (Desarrollo). |
| `SERVICIO_COORDINAR` | Asignar/reasignar, cambiar prioridad, ver reportes, administrar categorías, plazos y colas. | **Edgar** (Desarrollo) y **Frank** (Dirección General). |

⚠️ **Por confirmar:** qué rol real tiene cada una de las 3 personas hoy. El reparto se hace **por
rol**, no por nombre, y Frank pertenece a otro departamento que Jorge y Edgar: su responsabilidad se
da como **excepción por persona** (`identity.user_responsibilities`, con nota obligatoria y
vigencia). Se verifica contra el padrón real en MS.1.4 y se confirma contigo antes de aplicar.

`SERVICIO_REPORTAR` **no es un destino del mapa de la suite**: vive en un módulo sin ruta del árbol de
permisos y se alcanza con un botón "Reportar un problema" en el header. Así no rompe la entrada
directa a `/projects` de los roles con un solo destino (cajeras, almacenistas). El espacio 9 solo
aparece para quien tiene `ATENDER` o `COORDINAR`.

### 4.2 Base de datos (mínimo privilegio)

- **Roles nuevos: ninguno.** Se usa `app_runtime` (el que respeta RLS) y la conexión administrativa que
  ya existe para los crons (`KNEX_NEW_DB_ADMIN`).
- **`app_runtime`** recibe `USAGE` sobre el schema `servicedesk` y permisos **por tabla**, no el
  `DEFAULT PRIVILEGES` genérico:

| Tablas | SELECT | INSERT | UPDATE | DELETE |
|---|:-:|:-:|:-:|:-:|
| `queues`, `categories`, `sla_policies`, `settings` | ✓ | ✓ | ✓ | ✓ |
| `requests`, `request_sequences` | ✓ | ✓ | ✓ | — |
| `request_messages`, `request_attachments`, `work_log`, `notification_log` | ✓ | ✓ | — | — |
| `notification_prefs` | ✓ | ✓ | ✓ | ✓ |

  El hilo, los adjuntos, el tiempo y el log de avisos **no se editan ni se borran**: son registro.
- **Lectura sobre tablas existentes (solo `SELECT`)**, que se verifica en MS.1.0 que `app_runtime` ya
  tenga: `identity.users`, `identity.positions`, `identity.departments`,
  `identity.position_responsibilities`, `identity.user_responsibilities` y `commercial.warehouses`
  (nombre de sucursal, que sale del catálogo y no se escribe a mano).
- **Producción:** las migraciones **no** las aplica el despliegue. Se aplican **una por una** con
  `apply-one-migration-prod.js`, como indica el runbook. Nunca `migrate:latest`.

### 4.3 Almacenamiento y red

- **Adjuntos:** un prefijo nuevo, `servicedesk/<tenantId>/requests`, **dentro del bucket que ya existe**.
  Sin bucket nuevo. El servidor valida tipo (imagen o PDF, por firma) y tamaño, y firma la URL en cada
  lectura.
- **Avisos en tiempo real:** un canal por usuario en el WebSocket `/alerts` que ya existe.
- **Sin puertos, usuarios ni servicios nuevos** en `md`.

---

## 5. Lo que NO se toca

- **Kepler, `kepler_ods.*` y cualquier réplica del ERP.** La Mesa de Servicio no lee ni escribe ahí.
- **Ninguna tabla de otro dominio**, salvo las cuatro filas de §3.
- **El `Código.gs` de producción de la Bitácora.** La unificación se **prepara** (`work_log`, un puerto
  sin efecto); el puente real es posterior y exige el checkpoint y la confirmación de Felipe.
- **El verificador de precios y `catalogo-kp`.**
- **El Postgres nativo de esta máquina** y cualquier base compartida.

## 6. Diferido a propósito (decisión P5: "solo construir")

No se solicita ahora, y se resuelve **cuando se unifique con task**: correo SMTP configurado en prod,
plantilla de WhatsApp aprobada por Meta, y el destino final del bucket de adjuntos. El código de avisos
se escribe detrás de un puerto y se prueba con adaptadores simulados, así que **nada de esto bloquea
construir**; sí bloquea que los avisos reales salgan a producción.

## 7. Reversa

Todo es aditivo. Si hubiera que deshacerlo: `DROP SCHEMA servicedesk` (schema nuevo, sin dependencias
externas), quitar las 2 filas de `identity.responsibilities` y las 3 claves de `role_permissions`.
**Quitar las columnas `email`/`phone` de `identity.users` solo con tu confirmación expresa.**

## 8. Qué se le pide a Edgar

Marcar cada punto como **aprobado** o **cambiar**:

- [ ] Las **11 tablas** de §2, con sus columnas y restricciones.
- [ ] Agregar **`email` y `phone`** a `identity.users` (§3).
- [ ] Las **2 claves de responsabilidad** y no una tabla `agents` aparte (§3).
- [ ] Los **3 permisos** y su reparto propuesto (§4.1), incluida la excepción por persona para Frank.
- [ ] Los **grants por tabla** sin `DELETE` en las tablas de registro (§4.2).
- [ ] Que `SERVICIO_REPORTAR` **no** sea un destino del mapa (§4.1).
- [ ] Qué **rol real** tiene hoy cada una de las tres personas (§4.1).
