# Fase RH — Recursos Humanos: migración de Mega Talento a la Suite

**Estado:** 🔨 PLANEADA 2026-10-06 · sin código · ADR-084 (propuesto) ·
absorbe `[CH.0.7]`–`[CH.0.10]` y desbloquea `[ID.16]`.

> **En una frase:** Mega Talento (reclutamiento con bot de WhatsApp + asistencia de 12 relojes
> ZKTeco + incidencias y cierre semanal para prenómina) deja de ser una app aparte en Railway y
> pasa a ser el espacio **Recursos Humanos** de la Suite: módulos en `apps/api`, páginas en
> `apps/view`, una sola identidad (`identity.users`), un solo lector de relojes y los datos en
> tablas canónicas con `tenant_id` + RLS. Se migra **por dominio**, con la app vieja viva hasta
> cada corte.

---

## 1. Qué se migra (medido 2026-10-06)

### 1.1 Las piezas

| Pieza | Hoy | Tamaño |
|---|---|---|
| **API** Mega Talento | Express 4 + `pg`, TypeScript, Railway | ~11k líneas, 18 routers, ~114 endpoints |
| **Front** Mega Talento | Angular 20 standalone, CSS a mano (sin PrimeNG), Railway | ~51k líneas, 46 componentes, 33 pantallas |
| **Portal de candidatos** | Mismo front, rutas públicas (`/unete`, `/empleos`, `/evaluacion/:id`, `/pedir-personal`…) | 9 rutas sin login |
| **BOT-RH** | Node/Express + WhatsApp Cloud API (Meta) + Anthropic + Groq Whisper, Railway | ~17.5k líneas + 5.6k de scripts |
| **Agente de checadas** | Servicio de Windows en **una laptop** del corporativo (lee los 12 relojes por TCP 4370 y empuja a la API) | ~2.3k líneas + SQLite local |
| **Base** | Postgres 18 en Railway, **compartida con otros 4 sistemas** (ver §2.3) | 196 MB |

### 1.2 Los datos de Mega Talento (esquema `public` de esa base)

| Tabla | Filas | Qué es |
|---|---:|---|
| `checadas` | 213,965 | Marcas de los relojes (152k de 2026; llega hasta hoy). 2,684 con fecha basura (año 2000) |
| `mensajes` | 99,325 | Mensajes del bot desde 2026-07-14 (1,348 teléfonos) |
| `ingesta_lotes` | 12,949 | Lotes crudos que mandó el agente |
| `asistencia_alertas` | 10,325 | Sugerencias del "agente de horarios" (todas en `sugerida_ia`) |
| `candidatos` | 1,512 | Candidatos (1,487 vivos), desde 2026-05-28 |
| `empleados` | 1,049 | Padrón de relojes: **484 activos**, 12 plazas, **41 departamentos en texto libre** |
| `candidatos_transiciones` / `_eventos` | 801 / 83 | Cambios de etapa y eventos de contacto |
| `padron_depurado` | 501 | Enrolamientos descartados a mano |
| `reloj_comandos` | 116 | Órdenes al reloj (borrar / renombrar / restaurar usuario) |
| `asistencia_incidencias` (+ bitácora) | 97 / 97 | Incidencias con flujo capturada → calificada → cerrada → auditada |
| `agrupaciones` · `reloj_codigo_map` · `puestos` | 48 · 41 · 25 | Caché de agrupación IA · traducción de códigos · **vacantes** (no puestos de organigrama) |
| `usuarios` | 13 | Cuentas de RH (roles `Administrador`/`admin`/`Promotoria`) |
| `relojes` / `relojes_estado` | 12 / 12 | Registro de relojes y su latido (los 12 en modo `agente`) |
| `horarios_sucursal` · `asistencia_config` | 8 · 2 | Horarios por plaza y umbrales del agente |

Otras 35 tablas de `public` están **vacías** (restos de Firebase y de otros sistemas) y **no se migran**.

### 1.3 Dominios y su destino en la Suite

| Dominio | Hoy (tablas principales) | Destino |
|---|---|---|
| Padrón de personas | `empleados` | `identity.users` (D1) |
| Relojes y checadas | `relojes`, `relojes_estado`, `checadas`, `reloj_codigo_map`, `ingesta_lotes`, `reloj_comandos`, `padron_depurado` | `hr.*` existente (Fase CH) + 1-2 tablas nuevas |
| Horarios y agente de alertas | `horarios_sucursal`, `horarios_confirmados`, `asistencia_config`, `asistencia_alertas`, `asistencia_revision`, `jefes_sucursal` | `hr.*` (tablas nuevas) + `@Cron` en el worker |
| Incidencias | `asistencia_incidencias` (+ bitácora) | `hr.attendance_incidents` (+ log) |
| Cierre semanal (prenómina) | `asistencia_cierres` (snapshot jsonb) | `hr.attendance_closures` |
| Reclutamiento | `candidatos`, `candidatos_eventos`, `candidatos_transiciones` | schema nuevo `talent.*` |
| Vacantes y requisiciones | `puestos` (vacantes), `requisiciones` | `talent.job_postings` (→ `identity.positions`), `talent.staffing_requests` |
| Permanencia y encuestas | `candidatos.portal_data`, `empleados.candidato_id` | **vista** sobre `talent` + `hr` (derive-no-copy) + `talent.onboarding_surveys` |
| Conversación del bot | `mensajes` | `whatsapp.*` (un solo libro de WhatsApp) |
| Usuarios de RH | `usuarios` | `identity.users` + permisos `HR_*` |

---

## 2. Hallazgos que cambian el plan

### 2.1 El "sistema del proveedor" de Mega Talento es la Fase CH de la propia Suite

El agente de Mega Talento, en modo `hr`, lee "la base del sistema del proveedor" (`hr.attendance_logs`,
`hr.attendance_devices`). Esas tablas son **exactamente** el esquema de la Fase CH
(`20260817220000_hr_attendance.js`, mismas columnas `punched_local`, `imported_at`,
`clock_drift_seconds`, `record_count`) en la base `hr` de `.245` (`database/knexfile-hr.js`). El
mismo día (2026-08-17) la Fase CH cargó **129,461** checadas y el agente midió **129,477** filas en
"el proveedor". Son el mismo dato, visto por dos equipos que no se sabían uno del otro.

**Consecuencia:** no hay "proveedor" que respetar. La asistencia de la Suite y la de Mega Talento se
unifican en `hr.*`, y la Fase RH continúa la Fase CH en lugar de abrir una paralela.

### 2.2 Se han escrito cuatro lectores para los mismos 12 relojes, y un ZKTeco acepta una sola sesión TCP

| Lector | Estado medido 2026-10-06 |
|---|---|
| Agente de Mega Talento, modo `relojes` (TCP directo) | **El único vivo.** Los 12 relojes con latido de minutos; 9,191 checadas en 14 días. Corre como servicio de Windows en **una laptop** (`LapSistemasA`) |
| `agente-checador` del repo del bot (julio, empujaba al bot) | Muerto: su última checada es del 2026-08-21 (142,148 filas con `origen` NULL) |
| Modo `hr` del agente de Mega Talento (leía la base `hr` de `.245`) | Apagado: el agente está configurado en `relojes` |
| `import-checadores.js` de la Fase CH | No agendado (`[CH.0.9]`), pero existe y se puede correr a mano |

Dos lectores al mismo reloj **se pisan la sesión y leen a medias** (el propio agente lo documenta).
Hoy hay uno solo de hecho; **tiene que quedar uno solo de derecho** (D3): los otros tres se retiran
del código, no sólo se dejan de correr. Y el que queda **no puede vivir en una laptop**: si se cierra o
sale de la red, la asistencia de toda la empresa se detiene sin que nadie lo note.

### 2.3 La base de Railway la comparten cinco sistemas

Además de Mega Talento (`public`), en la misma base viven `eajd` (MD Task, **con uso diario**),
`cotejo`, `esm` y `conta`. El usuario de conexión de Mega Talento es **superusuario de toda la base**.
Las migraciones de Mega Talento corren en cada despliegue, sin versionar, y **reescriben el CHECK de
roles de `public.usuarios`**, tabla que también usa otro sistema.

**Consecuencia:** la migración saca a Mega Talento de esa base, pero **no la apaga**: los otros cuatro
sistemas quedan fuera de alcance (§8). Al terminar se cambia la contraseña del superusuario y cada
sistema que quede recibe su propio rol.

### 2.4 Lo que sólo existe en una máquina

- La rama local de Mega Talento lleva **103 commits que no están en GitHub**.
- El bot **sí está respaldado**: su repo de verdad es la copia "mudanza" (con `.git`, `package.json` y
  `db/schema.sql`), al día con GitHub y sin cambios pendientes. Había una segunda copia sin esos
  archivos; su contenido es idéntico salvo los fines de línea.
- El **servicio de Windows del agente corre directo desde la carpeta de trabajo** del repo de Mega
  Talento, en una laptop: cambiar de rama ahí cambia el código que corre en producción en su
  siguiente reinicio.

Por eso `[RH.0.1]` (respaldo de Mega Talento) es lo primero, antes que cualquier otra cosa.

### 2.5 Seguridad en producción hoy

La API y el bot exponen hoy en producción:

- endpoints **sin autenticación** que devuelven o modifican datos personales de candidatos, o que
  mandan plantillas pagadas de WhatsApp a cualquier número;
- una administración de usuarios **sin revisión de rol** (cualquier sesión puede crear administradores);
- secretos que **fallan abiertos** cuando la variable está vacía, un secreto de JWT con valor por
  defecto y CORS abierto.

> ⚠️ Las rutas exactas **no se versionan aquí**: este repo es público y siguen abiertas. El detalle
> está en el inventario entregado al dueño de Mega Talento (2026-10-06).

La Suite resuelve todo esto al migrar (guardas globales, `@Public` explícito, tokens firmados,
Helmet, Throttler). Como la migración tarda semanas, `[RH.0.6]` propone cerrar lo más grave **en
Mega Talento ya** (decisión del dueño, D7).

### 2.6 La persona canónica ya está decidida: `identity.users`

`[OR.0]`/`[OR.1]` (2026-09-11): *"el usuario ES la persona, sin entidad aparte"*. `hr.employees` se
rechazó como raíz (592 filas con todo lo organizacional en NULL). Departamentos (`identity.departments`,
incluye `rh`), puestos (`identity.positions`, 43 del organigrama), cadena de mando y responsabilidades
cuelgan de `identity.users`. `password_hash` es nullable y `status='invited'` existe: **una persona sin
acceso ya es representable**. El padrón de Mega Talento entra ahí (D1), no a una tabla paralela.

### 2.7 Lo que la Suite ya tiene y se reusa (no se reescribe)

| Necesidad de Mega Talento | Ya existe en la Suite |
|---|---|
| Esquema de relojes, checadas y crosswalk HITL | `hr.*` (Fase CH) |
| Lector ZK con decodificación de `verify_mode` (huella/rostro) | `database/importers/checadores/zk-client.js` |
| LLM (dictamen, visión, extracción) | `AnthropicService` |
| Transcripción de notas de voz (Groq Whisper) | `speech-to-text.service.ts` |
| WhatsApp Cloud API (Meta) con webhook firmado | `libs/whatsapp` |
| Archivos privados (CV, INE) | `ObjectStorageService` (bucket privado, URL firmada) |
| Correo | `MAILER_PORT` |
| Página pública con token firmado | patrón `/captura/:token` |
| Ingesta máquina→API con llave | patrón `StoreIngestGuard` |
| Latido de crons con umbral | `latirCron()` + `CRON_JOBS` |

### 2.8 Choques de vocabulario a evitar

- **"Checador"** en la Suite es el **puesto de almacén** que chequea pedidos (Fase SU), no el reloj.
  En RH se dice **reloj** (`device`).
- **"Turno"** es turno de caja; **"incidencia"** ya existe en última milla e inventario → en RH van
  calificadas: `hr.attendance_incidents`.
- El código de fase **CH** está tomado; esta fase es **RH**. Nunca una tabla `tickets` (ADR-081).

---

## 3. Decisiones (ADR-084, propuesto)

| # | Decisión | Recomendación | Decide |
|---|---|---|---|
| **D1** | ¿Dónde vive cada empleado? | En **`identity.users`** (`kind='interno'`, `status='invited'` sin contraseña; `terminated` para bajas), con `department_code`, `position_code` y `warehouse_code`. Es la regla de `[OR.0]`. `/admin/users` gana un filtro "con acceso / sin acceso". | **Edgar** (cambia su modelo: de ~130 a ~600 personas) |
| **D2** | ¿Qué pasa con `hr.employees`? | Se **retira**: `hr.device_enrollments` apunta a `identity.users.id`. En prod está vacía, así que no hay nada que migrar. | Edgar |
| **D3** | ¿Quién lee los relojes? | **Uno solo:** el agente de Mega Talento (es el que está en producción y tiene cola local, lectura verificada, comandos y descubrimiento por serie), movido al monorepo y corriendo como carril del namespace `ingesta` en `md`. Le suma el decode de `verify_mode` del `zk-client` de CH. Empuja a `POST /api/hr/attendance/ingest` con llave (patrón `StoreIngestGuard`, falla cerrado). El poller de CH se retira. | Equipo |
| **D4** | ¿Cómo se pasan los datos históricos? | **Una carga única por corte**, verificada (conteos y sumas por reloj y día), en `database/scripts/` — **no es un importer**: no se agenda ni se repite. Es dato propio de RH (HITL y marcas de relojes propios); el ODS no lo tiene. | Edgar (excepción declarada a "CERO importers" sólo para el **carril vivo de relojes**, que no es derivable del ODS) |
| **D5** | ¿En qué orden? | **Asistencia primero** (ya tiene base en CH, no depende de WhatsApp y es la base de la nómina). **Reclutamiento + bot juntos después** (el bot escribe directo en `candidatos`; separarlos obliga a sincronizar dos bases). | Usuario |
| **D6** | ¿Dónde vive el portal de candidatos? | Rutas **públicas en `apps/view`** con token firmado (patrón `/captura/:token`), registradas en la tabla de superficies de `DESIGN.md`. **No** en `apps/portal` (es el portal B2B de clientes). El id del candidato deja de ser la contraseña. | Edgar (superficie nueva) |
| **D7** | ¿Se corrige ya la seguridad de Mega Talento? | **Sí, lo mínimo** (§2.5): cerrar los endpoints abiertos y quitar los "fail-open". Son cambios chicos en la API y el bot de Railway, no en el agente. | Usuario |
| **D8** | ¿Qué se queda en Railway? | Los esquemas `eajd`, `cotejo`, `esm`, `conta` (otros sistemas). Mega Talento se apaga allá al terminar `[RH.4]`. | Usuario |

---

## 4. Mapa de destino

### 4.1 Tablas

| Mega Talento | Suite | Nota |
|---|---|---|
| `empleados` | `identity.users` | D1. `departamento` (41 textos) → `department_code` y `puesto` → `position_code`: **mapeo validado por RH**, no adivinado. `sucursal_id` (slug) → `warehouse_code` (código Kepler; ojo con Morelia, que el lector de CH etiqueta con códigos Wincaja). |
| `relojes` + `relojes_estado` | `hr.attendance_devices` (+ columnas de estado y modo) | La serie es la identidad, no la IP. |
| `checadas` | `hr.attendance_logs` | Llave natural `(device, device_user_id, punched_at)`. Las 2,684 con fecha basura se cargan y una vista las excluye (append-only, nunca se borra). |
| `reloj_codigo_map`, `padron_depurado` | `hr.device_enrollments` (`match_status`: `confirmado` / `ignorado`) | El crosswalk de CH ya tiene el estado HITL; no hace falta una tabla aparte. |
| `ingesta_lotes`, `agente_corridas` | `hr.device_sync_runs` + `analytics.cron_runs` | Latido de entrega con umbral en `CRON_JOBS`. |
| `reloj_comandos` | `hr.device_commands` (nueva) | Borrar o renombrar en el reloj es irreversible: permiso propio y bitácora. |
| `horarios_sucursal`, `horarios_confirmados` | `hr.work_schedules` (nueva) | Hoy hay dos (uno sin DDL en el repo). |
| `asistencia_config`, `asistencia_alertas`, `asistencia_revision` | `hr.attendance_rules`, `hr.attendance_alerts`, `hr.attendance_reviews` (nuevas) | Dos mecanismos de justificación hoy (revisión e incidencia): se decide uno en `[RH.1.5]`. |
| `asistencia_incidencias` (+ bitácora) | `hr.attendance_incidents` (+ `_log`) | El flujo de 4 estados y la separación de funciones se conservan. |
| `asistencia_cierres` | `hr.attendance_closures` | Snapshot inmutable de la semana jueves→miércoles. |
| `jefes_sucursal` | responsabilidad en `identity.user_responsibilities` | El jefe ya es una persona con puesto; no hace falta una tabla de teléfonos. |
| `candidatos` (+ eventos, transiciones) | `talent.candidates` (+ `candidate_events`, `candidate_stage_transitions`) | `portal_data` (jsonb gigante) se parte en columnas y tablas donde haya consultas. |
| `candidatos.documentos` (rutas en disco) | `talent.candidate_documents` + bucket privado | Hoy son rutas absolutas en el disco de Railway. |
| `puestos` (vacantes) | `talent.job_postings` → `identity.positions` | Una vacante es una publicación de un puesto, no un puesto nuevo. |
| `requisiciones` | `talent.staffing_requests` | |
| `mensajes` | `whatsapp.messages` / `conversation_threads` | Un solo libro de WhatsApp. |
| `usuarios` | `identity.users` + roles con `HR_*` | Los hashes bcrypt se migran si el algoritmo coincide; si no, reseteo obligatorio. |
| Permanencia (derivada) | **vista** `talent.v_retention` | Hoy se calcula al vuelo; se queda derivada. |

### 4.2 Permisos (propuesta)

Prefijo `HR_` (ya existe `HR_ATTENDANCE_CHECAR`):

| Clave | Para qué |
|---|---|
| `HR_ATTENDANCE_VER` / `_GESTIONAR` | Ver checadas y asistencia; corregir el padrón de relojes |
| `HR_INCIDENTS_CAPTURAR` / `_CALIFICAR` / `_AUDITAR` | El flujo de 4 estados, con separación de funciones (quien captura no audita) |
| `HR_PERIOD_CLOSE` | Cerrar y reabrir la semana (con motivo) |
| `HR_DEVICES_GESTIONAR` | Comandos al reloj (borrar, renombrar). Fuera de los grupos "de paquete" |
| `HR_RECRUITING_VER` / `_GESTIONAR` | Candidatos, vacantes, requisiciones |

Cada clave con sus 6 puntos de contacto (enum, guard, ruta, `permission-meta` + `authz-tree`, front,
`suite-map`) y **una migración que la reparte** (lección LC.6.2: declarar no es entregar). El rol
`Promotoria` de Mega Talento (sólo ve promotoras) se resuelve con **alcance de datos** (ADR-050), no
con un permiso que oculte un menú.

### 4.3 Pantallas

Espacio **Recursos Humanos** del mapa de la suite (`planned` hasta `[RH.1.7]`) pasa a `active` con el
proyecto `rh` («Personal») en `/rh/*` — hecho el 2026-10-07 para las tres primeras filas, ver §5.3:

| Ruta | Viene de |
|---|---|
| `/rh/asistencia` | `horarios` (pestañas checadas, tolerancia, faltas, cruces) + `asistencia-resumen` |
| `/rh/incidencias` | `incidencias-bandeja` + cierres de semana |
| `/rh/relojes` | estado de relojes, padrón, papelera, comandos |
| `/rh/reclutamiento` | dashboard, etapas, historial, expediente, duplicados, papelera |
| `/rh/vacantes`, `/rh/requisiciones` | `vacantes`, `requisiciones` |
| `/rh/permanencia` | `permanencia` |
| Públicas `/empleo/*` | `/unete`, `/empleos`, `/evaluacion/:token`, `/evaluar-aptitudes/:token`, `/pedir-personal` |

Se reescriben con el sistema de diseño de la Suite (Operations: tabla densa + master-detail,
PrimeNG, tokens). **No se copian** los 18k de CSS a mano. Antes de portar, `[RH.0.5]` revisa con RH
qué pantallas se usan: lo que nadie usa se declara retirado, no se porta.

---

## 5. Sprints

> **Calendario acordado (opción rápida, 2026-10-06):** preparación hasta el 9-oct · corte de
> asistencia el **7-nov** · corte de reclutamiento + bot el **5-dic** · una semana en sólo lectura ·
> **Mega Talento apagado el 18-dic-2026**. Claude programa, prueba y documenta; David opera
> (aprueba, aplica migraciones en prod, corre los cortes); Edgar revisa; RH valida y prueba.
> Lo que lo hace posible: trasladar la lógica ya probada (horarios, conversación, solicitud, CV,
> dictamen) en vez de reescribirla, y dejar los extras del bot (destacados, riesgo, calibración,
> tableros de demanda) para después del apagado. Estimado grueso; se recalibra al cerrar RH.1.

### RH.0 — Preparación (≈1 semana, sin código de producto)

- [ ] **[RH.0.1]** Respaldo: subir a GitHub la rama de Mega Talento (103 commits). El bot ya está
  respaldado (repo al día con GitHub, verificado 2026-10-06). Sin esto no se migra.
- [ ] **[RH.0.2]** ADR-084 aprobado por Edgar (D1–D8).
- [ ] **[RH.0.3]** Un solo lector de relojes: medir desde `md` que los 12 relojes contestan en TCP 4370
  (hoy los lee una laptop); retirar del código los otros tres lectores (§2.2).
- [ ] **[RH.0.4]** Mapeos validados por RH: 41 departamentos → `identity.departments`; puestos de
  `empleados` → `identity.positions`; slugs de plaza → `warehouse_code`; 73 homónimos de `[CH.0.8]`.
- [ ] **[RH.0.5]** Inventario de uso con RH: qué pantallas y funciones del bot se usan cada semana.
- [ ] **[RH.0.6]** (D7) Cerrar lo más grave de §2.5 en Mega Talento en producción.

### RH.1 — Asistencia en la Suite (≈3–4 semanas)

- [ ] **[RH.1.1]** Migraciones: columnas nuevas en `hr.attendance_devices`, `hr.device_enrollments.user_id`,
  `hr.device_commands`, `hr.work_schedules`, `hr.attendance_rules/alerts/reviews`,
  `hr.attendance_incidents` (+ log), `hr.attendance_closures`. Idempotentes, RLS forzado, `app_runtime`.
- [ ] **[RH.1.2]** Lib `libs/hr` (o módulo en `apps/api`): ingesta (`/api/hr/attendance/ingest` con llave
  fail-closed), padrón, relojes, checadas, comandos. Permisos `HR_ATTENDANCE_*`, `HR_DEVICES_GESTIONAR` y su reparto.
- [ ] **[RH.1.3]** Agente al monorepo: código del agente de Mega Talento + `verify_mode`; contenedor en el
  namespace `ingesta` de `md`; latido en `cron_runs` + umbral en `CRON_JOBS`; prueba negativa (apagar un reloj y ver el rojo).
- [ ] **[RH.1.4]** Personas: carga única de `empleados` a `identity.users` (D1) con los mapeos de RH.0.4.
- [ ] **[RH.1.5]** 🧪 Horarios deducidos y agente de alertas como `@Cron` del worker (una sola implementación;
  hoy está duplicada en la API y en el bot). Decidir revisión vs incidencia. → En código 2026-10-07, ver §5.1.
- [ ] **[RH.1.6]** 🧪 Incidencias y cierre semanal jueves→miércoles. Permisos `HR_INCIDENTS_*`, `HR_PERIOD_CLOSE`.
  Son **6** estados, no 4 (rechazada y anulada son salidas del flujo). → En código 2026-10-07, ver §5.1.
- [ ] **[RH.1.7]** 🧪 Pantallas `/rh/asistencia`, `/rh/incidencias`, `/rh/relojes`; espacio RH `active`; reparto
  de permisos por rol. → En código 2026-10-07, ver §5.3.
- [ ] **[RH.1.8]** Corte de asistencia (§6): carga única verificada de checadas, incidencias y cierres; el
  agente apunta a la Suite; las pantallas de asistencia de Mega Talento quedan de sólo lectura 2 semanas.
- [ ] **[RH.1.9]** (opcional) Modo push ADMS para las plazas sin ruta (PH, Morelia Abastos): endpoint `/iclock`
  con parser de texto, autenticación por serie y tenant explícito. Se prueba en **un** reloj primero.

### RH.2 — Reclutamiento en la Suite (≈3 semanas, se construye sin cortar)

- [ ] **[RH.2.1]** Schema `talent.*` + bucket privado para documentos.
- [ ] **[RH.2.2]** API: candidatos, eventos, etapas, vacantes, requisiciones, no recontratables, papelera, permanencia (vista), encuestas.
- [ ] **[RH.2.3]** Pantallas `/rh/reclutamiento`, `/rh/vacantes`, `/rh/requisiciones`, `/rh/permanencia` (sólo las que pasaron RH.0.5).
- [ ] **[RH.2.4]** Portal público `/empleo/*` con token firmado (D6).

### RH.3 — Bot de reclutamiento en `libs/whatsapp` (≈4–5 semanas)

- [ ] **[RH.3.1]** El webhook de la Suite enruta por `phone_number_id`: el número de RH va al orquestador de reclutamiento
  (hoy enruta comercio y captura bancaria). Plantillas aprobadas del número de RH migran con él.
- [ ] **[RH.3.2]** Conversación (máquina de estados), solicitud de ~130 preguntas, CV en PDF, clasificación de documentos.
- [ ] **[RH.3.3]** Dictamen, aprobación por WhatsApp, avance de fases, MIDOT (modo manual), destacados y riesgo como `@Cron` con latido.
- [ ] **[RH.3.4]** Se retira Firestore (legado) y el panel HTML del bot (lo reemplazan las pantallas de RH.2).
- [ ] **[RH.3.5]** **Corte de reclutamiento** (RH.2 + RH.3 juntos, §6): carga única de candidatos, mensajes y documentos;
  el webhook de Meta apunta a la Suite.

### RH.4 — Retiro (≈1 semana)

- [ ] **[RH.4.1]** Apagar API, front y bot de Mega Talento en Railway; quitar el servicio de Windows del agente.
- [ ] **[RH.4.2]** Cambiar la contraseña del superusuario de Railway y dar a cada sistema restante su propio rol.
- [ ] **[RH.4.3]** Cerrar `[CH.0.7]`–`[CH.0.10]` y `[ID.16]`; tracker, log, CHANGELOG, CLAUDE.md.

### RH.5 — Nómina, sobres y entrega sin papel (después)

Diseño listo y aprobado en concepto (lienzo privado; **no se versiona** porque trae cifras reales de
nómina): confirmación con reloj, código del celular o firma con motivo; ventanilla con una pagadora;
comprobante sellado (NOM-151). Se construye sobre RH.1 cuando se decida.

---

### 5.1 `[RH.1.5]`/`[RH.1.6]` — lo que se trasladó y lo que se decidió (2026-10-07)

**Qué se trasladó.** La lógica de asistencia de Mega Talento (`api/src/agente-horarios/*`, `incidencias.ts`,
`cierres.ts`, commits de sep–oct 2026) vive en `libs/hr/src/lib/attendance/`. Lo que es **regla** se copió
textual (`logic/horario-deducido.ts`, `logic/reglas.ts`, `logic/tipos.ts`, `detalleDia`) para que se audite
con un diff; lo que mezclaba consulta y cálculo (`asistenciaPersonas`, `detectar`) se partió en una función
pura y una lectura (`attendance-reader.ts`), sin tocar el recorrido. Encima: el agente (`@Cron` cada 30 min
con candado por sitio y bitácora en `hr.attendance_agent_runs`, mig `20261007310000`), la cola de alertas,
los horarios (por sitio y por persona), las incidencias con su bitácora y el cierre de semana.
API en `/api/hr/attendance/*` (asistencia, checadas, horarios, agente, alertas, incidencias, cierres).

**Lo que se encontró al medir:**
- **La prueba del horario de Mega Talento está en ROJO desde el 18/08** (`tools/probar-horario.ts`: 6 fallas).
  Las seis se explican por dos cambios de regla de RH que nadie llevó a la prueba: la semana de nómina pasó
  de miércoles a **jueves** (18/08) y una ausencia puede ser **el descanso** de la semana (26/09). Aquí la
  prueba trae los números corregidos y cada uno dice por qué cambió.
- **La copia del bot se quedó con la regla vieja** (`BOT-RH/src/horario-deducido.js` corta en miércoles y no
  tiene descansos por semana): su panel da 146 min de retardo a una persona de Morelia donde el portal da 131. En la Suite
  queda **una sola** implementación, la vigente. El panel del bot se retira en `[RH.3.4]`.
- **El agente de producción nunca manda si una checada es entrada o salida** (la librería ZK no lo trae), y
  las reglas se calibraron así. El lector de la Fase CH sí decodificaba el estado del reloj: usarlo
  encendería las ramas "con tipo" de cuatro reglas sólo para la parte vieja de la historia. La lógica
  trabaja con `tipo` vacío; el dato queda guardado.

**Decisiones:**
- **Revisión vs incidencia → la incidencia es el único mecanismo.** La revisión de Mega Talento excusaba por
  coincidencia de palabras y se escribía **sin pasar por el candado de semana cerrada** (justificar con ella
  cambiaba el número de una semana ya pagada). En la Suite no se escribe; sus filas históricas se LEEN
  para que las semanas viejas den el mismo número.
- **El cierre toma la foto dentro de la misma transacción** que cambia los estados (allá iba afuera): la
  foto es exactamente lo que quedó cerrado.
- **Separación de funciones por clave**: `HR_INCIDENTS_CAPTURAR` / `_CALIFICAR` / `_AUDITAR`, y quien
  audita nunca es quien capturó o calificó (lógica + CHECK de la tabla). Allá eran el mismo rol admin.
- **El agente arranca apagado** (`ENABLE_HR_ATTENDANCE_AGENT`): hasta el corte la fuente viva es Mega
  Talento. Apagado tampoco late (un latido sin su fila en `CRON_JOBS` se pinta verde sin umbral). El
  encendido y las filas `hr_attendance_agent` / `hr_attendance_ingest` de `CRON_JOBS` van en el corte.
- **Aprobar alertas sigue siendo de una en una** aunque el aviso al jefe por WhatsApp todavía no exista.
- **Los horarios de sitio se desactivan, no se borran** (pueden estar referidos por el de una persona).

**Medido:** 86 pruebas puras + 2 contra Postgres (35 aserciones de punta a punta: lote → vista →
asistencia → agente → incidencias → cierre → reapertura, con la separación de funciones probada también
contra el CHECK y la bitácora probada como sólo-agregar con el rol `app_runtime`). Tiempos con un sitio
sintético del tamaño real (70 personas, ~29 mil checadas): asistencia de una semana **116 ms**, de tres
meses **259 ms**, agente de 45 días **96 ms** — debajo del criterio de 1 s. ⚠️ Es una base local con un
solo sitio; contra prod se vuelve a medir en el corte.

**Declarado, no construido aquí:** el aviso al jefe por WhatsApp y su respuesta con código (`[RH.3]`, con el
bot); presencia en vivo, "ubicación de mi equipo" y cruces entre plazas (son pantallas: `[RH.1.7]`); el
alcance de datos del rol Promotoría (ADR-050, con las pantallas); editar el padrón y su turno de sitio
(`[RH.1.4]`); repartir las claves `HR_*` (con las pantallas; mientras, `SIN_REPARTIR`). Las áreas de
`horarios_sucursal` no se trasladan: el horario por persona ya cubre ese caso.

### 5.1b `[RH.1.2]` (resto) — administrar los relojes, y cómo se corta el agente (2026-10-07)

`/api/hr/attendance/devices`: alta/edición/pausa por serie, semáforo, lotes guardados sin aplicar y su
reproceso, y las órdenes al reloj (renombrar, restaurar con el respaldo de un borrado, cancelar). El
borrado no se expone: Mega Talento lo retiró el 29/09 (RH da de baja, no borra). Clave
`HR_DEVICES_GESTIONAR`.

**Dos defectos de Mega Talento que aquí no pasan:** su orden llevaba el código del SITIO y el agente
busca a la persona en el reloj por ese código; en el reloj de comida de corporativo (que numera distinto)
un «renombrar» habría tocado a otra persona o a nadie. Aquí cada orden lleva el código **crudo de su
reloj**, y sólo va a los relojes donde la persona está enrolada.

⚠️ **Corrección:** en `[RH.1.2]` se dijo que, para el corte, al agente de la laptop sólo había que
cambiarle dirección y llave. **No era cierto**: tiene fijas sus rutas (`/checador/ingesta`, `/latido`,
`/relojes`, `/comandos`) y su encabezado (`X-Agente-Token`). Se agregó una **entrada compatible**
(`/api/hr/attendance/ingest/mt/checador/ingesta`, mismo servicio, acepta `X-Agente-Token`): ahora sí,
el corte del agente es sólo su `config.json` (`apiUrl` = `…/api/hr/attendance/ingest/mt`, `token` =
`HR_INGEST_KEY`), y no depende de mudarlo al servidor (`[RH.1.3]`).

### 5.2 Paridad contra Mega Talento con datos reales (2026-10-07)

Lo que prueba que el traslado da **el mismo número que RH ve hoy**, no sólo que pasa casos armados:

1. `database/scripts/rh/mt-exportar-asistencia.ts` corre **el código real de Mega Talento** sobre su base
   (sesión forzada a sólo lectura: la escritura se rechaza con `25006`) y guarda cada cálculo.
2. `database/scripts/rh/carga-unica-mega-talento.js` carga a `hr.*` la misma foto (corte por hora de
   recepción). Por omisión es ENSAYO: carga en una transacción, imprime el cuadre y la deshace.
3. `libs/hr/.../paridad-mega-talento.db.spec.ts` simula `[RH.1.4]` (una persona por ficha, con su
   estado y si es promotora), calcula con la Suite y compara campo por campo y día por día.

**Resultado:** 72 cálculos (12 sitios × 3 semanas de nómina × planta/promotoras), **1,464 personas,
5,464 días, 0 diferencias** y nadie de más ni de menos. La carga cuadra al registro: 214,792 checadas +
3 con fecha de reloj sin hora; 1,540 enrolamientos; 99 incidencias y su bitácora; 10,429 alertas. Tarda
25 s. El agente de alertas, sobre la ventana de la última corrida de Mega Talento: 4,296 alertas, 3
diferencias, las 3 explicadas (abajo).

**Lo que destapó** (la primera corrida salió ROJA: 37 personas en un solo lado):
- El padrón de la Suite tiene que ser lo **ligado a una persona**, no todo código enrolado: listaba 12
  códigos viejos sin ficha (uno sin checar desde 2025) que Mega Talento no muestra. Corregido.
- Una lápida de `padron_depurado` **no cuenta si la ficha está activa** (#172 de Morelia Abastos: alguien
  la reactivó sin quitar la lápida, y Mega Talento la mide). Corregido en la carga.
- **Defecto de Mega Talento, corregido aquí:** su huella de corrida no llevaba el día, así que un día que
  CIERRA sin datos nuevos no se vuelve a revisar. CEDIS #10 tuvo una sola marca el 06/10, se analizó
  antes de cerrar el día, el reloj se cayó y la «entrada sin salida» no apareció nunca.
- La cuenta «Admin» de PH (dada de baja y depurada) genera alertas en Mega Talento; aquí sus checadas
  se ignoran. Es ruido menos; se declara.
- El `tipo` de checada SÍ llegó: 10,220 checadas del 13/01 al 17/08/2026, ninguna después. Sin usarlo,
  la paridad da 0: la decisión de §5.1 se sostiene con el dato corregido.
- **La cola de alertas no la usa nadie**: 10,429 sugeridas y **cero decididas** en toda su historia.
  Antes de construir su pantalla (`[RH.1.7]`) hay que preguntarle a RH si la quiere.

⛔ **Abierto para el corte (`[RH.1.8]`):** prod ya tiene ~129 mil checadas de la Fase CH en los mismos
relojes. Las checadas sin reloj de Mega Talento salieron de esa fuente: cargarlas tal cual las
duplicaría en la vista (misma persona y minuto, dos relojes). La carga a prod tiene que reconocerlas.
En desarrollo no se ve: la base local no trae las de CH.

### 5.3 `[RH.1.7]` — las pantallas, el espacio y el reparto (2026-10-07)

**Lo que hay.** Tres pantallas Operations (tabla densa + ficha) en el proyecto `rh`, que se llama
**«Personal»** y no «Recursos Humanos» a propósito: así se llama el ESPACIO, y la migaja deduplica
etiquetas iguales — se perdería el enlace al inicio del proyecto.

| Ruta | Qué hace | Entra con |
|---|---|---|
| `/rh/asistencia` | Semana de nómina (jueves→miércoles, recortada a hoy) por sitio; planta o promotoras; ficha con días, comida, horas, bolsa restante y por qué revisar. Asignar o quitar el horario de una persona. «Capturar incidencia» lleva a Incidencias con persona, sitio y semana puestos. | `HR_ATTENDANCE_VER` o `_GESTIONAR` |
| `/rh/incidencias` | Por calificar / cuentan / rechazadas / anuladas / todas; capturar, calificar, rechazar, quitar, auditar, con su bitácora. Cierre de la semana para prenómina y reabrir con motivo. | cualquiera de VER, CAPTURAR, CALIFICAR, AUDITAR, PERIOD_CLOSE |
| `/rh/relojes` | Semáforo por **señal del lector** (no por última checada), lotes que llegaron sin aplicar y su reproceso, alta/edición/pausa, renombrar o volver a dar de alta a alguien en los relojes del sitio. | VER (consulta) o `HR_DEVICES_GESTIONAR` |

**Decisiones.**
- **Gestionar implica ver.** Siete lecturas de asistencia (`report`, `punches`, `schedules`, `agent/status`,
  `alerts`…) pasaron de exigir `HR_ATTENDANCE_VER` a aceptar `VER` **o** `GESTIONAR`. Sin eso, quien sólo
  tuviera GESTIONAR aterrizaba en una pantalla que le daba 403. Cada ruta pide lo mismo que su lectura.
- La pantalla sólo **ofrece** los botones que pueden servir; el servidor vuelve a decidir y su motivo se
  muestra tal cual (409 de semana cerrada incluido). Auditar no se ofrece sobre lo que no está cerrado.
- Lo que no hay se dice: «—» en vez de 0 minutos, «nunca» en un reloj que nunca habló, los cuatro colores
  del semáforo se cuentan aunque sean cero.

**El reparto** (mig `20261007330000`), derivado del flujo que **Mega Talento documenta en su código**
(«el encargado entrega, servicios al personal califica, contabilidad audita» — allá todos eran el mismo
administrador porque no había roles):

| Rol | Claves |
|---|---|
| `recursos_humanos` (`[IDG.8]`) | VER, GESTIONAR, CAPTURAR, CALIFICAR, PERIOD_CLOSE, DEVICES_GESTIONAR |
| `contabilidad` (4 personas en prod, medido el 06/10) | AUDITAR |

- ⚠️ **`recursos_humanos` no tiene a nadie** en la base local, y en prod `[IDG.8]` lo creó vacío (desde esta
  sesión no se alcanza `md` para medirlo). Mientras nadie de RH esté en ese rol, las pantallas sólo las abre
  un superadmin. La compuerta de reparto lo declara en `SIN_PERSONAS` y se pone roja cuando alguien entre,
  para sacarlo de la lista. **Lo hace un humano desde `/admin/personas`** (el puesto «Auxiliar de RR-HH» cae
  por defecto en `administracion`, que no es sólo RH: por eso no se repartió por ahí).
- ⛔ **El encargado de tienda no captura todavía.** La captura no está acotada por sitio: quien tiene
  CAPTURAR mete incidencias en cualquier plaza. Primero el alcance por sitio, después el reparto.
- La separación de funciones no depende del reparto: la hacen cumplir el servidor y un CHECK.
- Probada contra la base local dentro de una transacción revertida: otorga, es idempotente, **no pisa un
  `false` explícito** (lo declara) y `down` deja todo como estaba.

**Lo que NO se construyó (declarado).**
- La pantalla de la **cola de alertas**: 10,429 sugeridas y cero decididas en Mega Talento (§5.2). Se
  pregunta a RH antes de construirla.
- Presencia en vivo, «ubicación de mi equipo», cruces entre plazas, la papelera y el padrón de los relojes,
  la pestaña de checadas crudas. Antes de portar, `[RH.0.5]`: qué se usa de verdad.

**Pruebas.** 44 del front (cliente + 3 pantallas), con **prueba de mutación**: se rompieron a propósito tres
guardas de permiso y las tres pruebas negativas se pusieron rojas. Contratos 388 (mapa de la suite: el
espacio pasa a `active`, 16 puertas para el admin); «Mi trabajo» 97. ⚠️ **Validación visual pendiente**: en
esta sesión no se levanta el front (regla del repo); se valida en el despliegue.

**Migraciones renombradas.** Cuatro timestamps de esta fase ya los usaban migraciones de `main` del 7-oct
(knex desempata por alfabeto). Ninguna se había aplicado en ningún lado, así que se renombraron:
`120000→300000` (incidencias, en #281), `130000→310000` (agente), `140000→320000` (órdenes),
y el reparto nació en `330000`.

## 6. Cómo se hace cada corte

1. **Ventana corta fuera de horario.** La app vieja sigue viva hasta el corte.
2. **Carga única** con `database/scripts/rh-carga-<dominio>.js`: idempotente, contra destino seguro
   (`assert-safe-target`), y deja un **reporte de cuadre**: filas por tabla, checadas por reloj y día,
   incidencias por estado, candidatos por etapa. Si no cuadra, no hay corte.
3. **Se cambia el escritor:** el agente apunta a la Suite (asistencia) o el webhook de Meta apunta a la
   Suite (reclutamiento).
4. **La app vieja queda de sólo lectura 2 semanas** como vuelta atrás. Volver es re-apuntar el escritor
   (lo escrito en la Suite en ese lapso se re-carga a la vieja con el mismo script en sentido inverso).
5. Se apaga en `[RH.4]`.

---

## 7. Riesgos

| Riesgo | Mitigación |
|---|---|
| La asistencia de toda la empresa depende hoy de una laptop prendida | `[RH.1.3]` lleva el lector a `md`; mientras tanto, que esa laptop no se apague ni salga de la red |
| Dos lectores peleando un reloj durante la transición | `[RH.0.3]`: uno solo, siempre |
| ~500 personas sin acceso en `identity.users` ensucian `/admin/users` y pruebas de permisos | Filtro "con acceso / sin acceso" y `status='invited'` sin hash; se mide `test-newdb-permission-delivery` |
| Plantillas de WhatsApp: la Suite tiene pendiente la aprobación de Meta (OBS.5) | El número de RH ya tiene plantillas aprobadas; se migran con el número, no se piden nuevas |
| Datos personales (CV, INE) en disco de Railway con rutas absolutas | Se mueven al bucket privado en la carga de RH.3.5 |
| Regla de no levantar el backend en local | Verificación por CI + smokes contra destino seguro, como el resto de la Suite |
| El agente corre hoy en una PC de escritorio | `[RH.1.3]` lo lleva a `md`, que arranca sin sesión (lección de la Fase VL) |

## 8. Fuera de alcance

- Los esquemas `eajd` (MD Task), `cotejo`, `esm` y `conta` de la misma base de Railway.
- MIDOT por API (hoy no existe; sigue el flujo manual).
- La nómina (`RH.5`).

## 9. Preguntas abiertas

1. ¿Quién es el dueño funcional de RH en la Suite (quien valida mapeos y prueba cortes)?
2. ¿El número de WhatsApp de RH es distinto del comercial? (Se asume que sí.)
3. ¿Qué pantallas de Mega Talento se usan de verdad? (`[RH.0.5]`)
4. ¿Se conserva el historial completo de mensajes del bot (99k) o sólo el de candidatos vivos?
