# FASE RH — La Mesa de Servicio de Recursos Humanos (cola confidencial)

> **Estado:** 📋 DISEÑADO (planeación) 2026-10-06 — sin código. Segunda cola de la Mesa después de Mantenimiento ([`FASE_MS7_MANTENIMIENTO`](FASE_MS7_MANTENIMIENTO.md)); hereda de ADR-081 y del diseño de MS.7. **ADR por asignar** (la numeración 082 y 083 ya está ocupada).
> **Origen:** `PLAN_MESA_SERVICIO_RH.md` + `PROMPT_CLAUDE_CODE_RH.md` (Sistemas), contrastados con el código real. Este documento reemplaza a ambos como fuente: trae el plan ajustado, la matriz de **20 casos** y el prompt maestro corregido (Apéndice).
> **Para quién:** Sistemas (dueño de la Mesa), RH (Lesly Berber y Tania Solorio), Edgar (revisión) y el dev que lo construya.

---

## 1. Qué se quiere (decisiones ya tomadas por Sistemas)

| # | Tema | Decisión |
|---|---|---|
| 1 | Confidencialidad | Se define **al levantar el ticket**: todo ticket que se levante a RH **nace confidencial**. |
| 2 | Marca | Una marca de confidencial **a nivel de cola** habilita el flujo confidencial. |
| 3 | Prioridad | RH **no tiene prioridad, ni semáforo, ni «urgente»**; no se hacen las dos preguntas de impacto. |
| 4 | Coordinación | **Lesly Berber y Tania Solorio** (rol coordinador). Por ahora no hay técnicos. |
| 5 | Administrador | **No ve** los tickets confidenciales de RH. Sólo información básica (que existe el registro y si se resolvió). |
| 6 | Transferencia | Un ticket confidencial se transfiere **sólo entre responsables del área** (ver R3). |
| 7 | Reportes | Sólo agregados, con un **mínimo de casos**. |
| 8 | Alcance v1 | La receta ya establecida para agregar un área + la verificación cruzada. |
| 9 | Fuera de v1 | Tickets padre-hijo (altas de empleado), campos extra, SLA calibrado, ruteo por ubicación y definir «urgente» en RH. |

---

## 2. Lo medido antes de ajustar el plan

**Veredicto: se puede construir**, con una dependencia que el plan daba por cumplida y siete fugas que no cubría.

### 2.1 El prerrequisito no está cumplido
El plan decía «MS.7 (PR #269) se cierra hoy; RH no arranca hasta que esté mergeado y sus migraciones aplicadas». **El PR #269 está mergeado, pero es sólo el documento del plan.** En el código **no existe** `queue_members`, el acceso por cola, transferir entre colas ni la pantalla de miembros; `puedeVer` sigue siendo `esAgente || solicitante` (`requests.service.ts`). RH necesita esas piezas, así que el orden real es:

`MS.7.1` miembros por cola → `MS.7.6` acceso por cola → `MS.7.11` transferir → `MS.7.13` avisos por cola → `MS.7.17` configuración de colas → `MS.7.18` Mi trabajo y reportes → **RH**.

**Compuerta de entrada de RH.1:** `MS.7.1` y `MS.7.6` mergeados y verificados. Y `MS.7.6` se diseña **ya con el hueco para la confidencialidad** (una función única `accesoATicket` que devuelve `completo | basico | ninguno`): reescribir `puedeVer` dos veces sería peor que una.

### 2.2 Lo que el plan no cubría (con evidencia)

| # | Hallazgo | Evidencia en el código | Qué se hace |
|---|---|---|---|
| H1 | **El administrador puede agregarse a sí mismo** como coordinador de RH y verlo todo. | Los miembros se editan desde Configuración / `/admin/personas`. | Sólo un **coordinador de esa cola** administra sus miembros; el cambio queda visible para RH. |
| H2 | **No hay un solo punto de control.** | **9 archivos** leen `servicedesk.requests`: `requests`, `sla`, `reports`, `notifications`, `agents` (service-desk) y `me-work.ts`, `me-tasks.ts` (`libs/trade`, que miden «por asignar» y «a tu cargo» **sin mirar cola ni confidencialidad**), más `request-state.ts` y `task.contract.ts` (declaraciones). | Un helper único de visibilidad **más un candado estático**: si un archivo fuera de una lista blanca lee la tabla, el build falla (patrón de los `check:*`). Es la forma real de cumplir «se aplica en API y en base de datos». |
| H3 | **El título se copia fuera del ticket.** | `notification_log.payload` guarda el `title` y la campana lo lee de ahí; el correo va como `[folio] título`; el aviso de `sla.service` también. | El texto neutro se aplica **al escribir**, no al mostrar. |
| H4 | **Adjuntos por URL prefirmada.** | `detail()` firma la URL con **600 s** de vida (`attachments.service.ts`). La matriz sólo puede garantizar el acceso **al emitirla**; una URL reenviada vale 10 minutos. | Vida corta en confidenciales (propuesta 60 s) y declararlo como límite. |
| H5 | **«Sin prioridad» no es sólo configuración.** | `requests.priority` es `NOT NULL` con CHECK; el barredor de SLA marca falla «sin política para <prioridad>»; la bandeja ordena por prioridad; `SdPriority` viaja tipada por toda la API y la pantalla. | La base conserva un valor **neutro interno que nunca se publica**; la cola declara `uses_priority=false` y `sla_enabled=false` → la API manda `priority: null`, no hay plazo, el barredor la salta, la pantalla no pinta chip. Evita volver nulable la columna y tocar los 11 sitios. |
| H6 | **La marca no es inmutable por sí sola.** | `app_runtime` tiene `UPDATE` sobre `requests`. | **Trigger** que rechace cambiar `confidential` (y sacar el ticket a una cola no confidencial). Una regla de código no basta. |
| H7 | **Quien levanta ≠ el solicitante.** | La Mesa deja levantar un ticket **a nombre de otra persona**: un agente de TI podría mandarlo a RH. | Lo ven sólo el solicitante y los miembros de RH; levantar a nombre de otro hacia una cola confidencial sólo lo hacen miembros de esa cola. |
| H8 | **Reportes y KPIs.** | `reports.service` cubre todas las colas con SQL directo; `stats` también. | Excluir lo confidencial del global; el de RH va aparte, con mínimo de casos y revisión de **supresión complementaria** (que no se deduzca restando totales). |
| H9 | **Bitácora de Sistemas.** | El puerto hoy no hace nada, pero la unificación está preparada. | El puerto filtra confidenciales, con test. |

### 2.3 RLS por ticket en la base: **no ahora**
Hoy la base sólo fija el tenant por sesión (`app.tenant_id`). Agregar el actor tocaría `TenantKnexService`, **compartido por todo el repo**. Además el cron de SLA, los avisos y «Mi trabajo» corren **sin actor** y verían 0 filas de RH: se leería «estoy al día», un valor por defecto disfrazado (ADR-056). Alternativa: trigger de inmutabilidad + candado estático + (si hace falta después) separar el texto sensible a una tabla propia con RLS por pertenencia.
**Límite declarado:** quien tenga acceso directo a la base como superusuario puede leer y editar. Esto protege de la aplicación, no del administrador de base de datos.

---

## 3. Decisiones de diseño

### 3.1 Propuestas (no resueltas: confirmar con Sistemas/RH antes del sprint que las usa)

| # | Duda | Propuesta |
|---|---|---|
| **R1** (A) | ¿Dónde vive la marca? | `queues.confidential`; al crear el ticket **se copia y ya no cambia** (trigger). El ticket **no puede** declararse confidencial ni no confidencial por el cliente: la base lo fija desde la cola. |
| **R2** (B) | ¿Qué es «información básica» del administrador? | Folio, cola, fecha de alta, estado y fecha de resolución. **Sin** título, descripción, hilo, adjuntos, ni nombre del solicitante, **ni conteos por categoría**. La **API** tampoco envía los campos ocultos (no basta esconderlos en pantalla). |
| **R3** (C, D) ⚠️ | ¿Qué significa «sólo entre responsables» y qué pasa al salir de RH? | **Un ticket de RH NO se puede transferir a una cola no confidencial** (si no, los miembros de TI verían un ticket de RH). Entre Lesly y Tania se usa **reasignar**, no transferir. Hacia otra cola confidencial: sólo un coordinador, y sólo hacia un coordinador de la cola destino. Es la decisión de fondo del plan: pide confirmación expresa. |
| **R4** (E) | Mínimo de casos en reportes. | `queues.report_min_cases`, configurable; propuesta inicial **5**. Bajo el mínimo se muestra «—». |
| **R5** (F) | SLA sin prioridad. | v1 **sin SLA en RH**: se declara «—», nunca 0. El SLA calibrado queda para después. |
| **R6** (G) | Responsable por omisión. | Ninguno (son dos coordinadoras): el ticket queda «Sin asignar» y lo ven ambas. |
| **R7** (H) | Categorías. | Nómina, vacaciones, incapacidades, altas y bajas, constancias, credenciales, capacitación, conflicto laboral. **Faltan validar con RH.** La ubicación es opcional. |
| **R8** | **¿Cómo llega un ticket a RH?** (las decisiones 1 y 2 del plan dicen «redirige la solicitud a RH»). | La persona **elige explícitamente el área RH** al levantar el ticket (con el aviso «esta solicitud será confidencial»). **Sin** un botón de «reporte confidencial» dentro de otra cola. |
| **R9** | ¿Quién ve un ticket levantado a nombre de otra persona? | Sólo el solicitante y los miembros de RH (H7). |

### 3.2 Reglas que se heredan de la Mesa
Folio único `SRV-AAAA-NNNNN`; mismos estados para todas las áreas más motivo de pausa; quién atiende qué área vive en `queue_members` (coordinador/técnico) y las claves `SERVICIO_*` siguen siendo capacidades; todo es **configuración, nunca lógica por nombre de cola**; no hay permisos nuevos.

---

## 4. Modelo de datos (RH.1, todo aditivo e idempotente)

| Objeto | Cambio |
|---|---|
| `servicedesk.queues` | `+ confidential boolean NOT NULL DEFAULT false`, `+ uses_priority boolean NOT NULL DEFAULT true`, `+ sla_enabled boolean NOT NULL DEFAULT true`, `+ report_min_cases integer NOT NULL DEFAULT 5` (CHECK ≥ 1). TI y Mantenimiento quedan idénticos. |
| `servicedesk.requests` | `+ confidential boolean NOT NULL DEFAULT false`. **Trigger `BEFORE INSERT`**: fija `confidential` desde la cola (no se puede falsificar). **Trigger `BEFORE UPDATE`**: rechaza cambiar `confidential`, y rechaza mover un ticket confidencial a una cola no confidencial. |
| `notification_log` | Sin esquema nuevo: en confidenciales el `payload` se **escribe** neutro (H3). |
| Contrato (`libs/contracts`) | `SdRequestRow.priority: SdPriority \| null`, `confidential: boolean`, y un DTO `SdRequestBasic` (la vista del administrador). El cambio de tipo de `priority` toca pantallas de TI y Mantenimiento: lleva regresión. |

**Sin permisos nuevos** → sin re-login.

---

## 5. Plan por sprints (BD → lógica → pantalla)

Una rama y un PR por sprint. Migraciones aditivas, idempotentes y reversibles, **nunca contra producción**. Orden: base, lógica con pruebas, pantalla.

| Sprint | Contenido | Se cierra cuando |
|---|---|---|
| **RH.0** Reconocimiento | **Hecho como análisis (§2).** Queda: confirmar en el código del momento que `MS.7.1` y `MS.7.6` están mergeados y que `accesoATicket` existe. | Compuerta de entrada verificada y R1–R9 respondidas. |
| **RH.1** Base de datos | Columnas de cola, `requests.confidential` y sus **dos triggers**. Pruebas de subida y reversa en copia. | Un ticket no puede cambiar su marca ni salir a una cola no confidencial, ni por SQL con `app_runtime`. |
| **RH.2** Lógica y pruebas | `accesoATicket` completo (incluye `basico` para el administrador); `queue_members` de una cola confidencial sólo los edita su coordinador (H1); **candado estático** de lecturas (H2); `me-work`/`me-tasks` acotados por cola (H2); avisos neutros **al escribir** (H3); URL prefirmada corta (H4); modelo sin prioridad y barredor que salta la cola (H5); levantar a nombre de otro (H7); transferencia (R3); reportes con mínimo y supresión complementaria (H8); filtro del puerto de Bitácora (H9). | Cada regla probada **rompiéndola a propósito**. TI y Mantenimiento sin regresión. |
| **RH.3** Pantalla | Aviso «esta solicitud será confidencial» al elegir RH; formulario sin preguntas de prioridad; **sin semáforo ni chip** en listados y fichas de RH; vista limitada del administrador; bandera y mínimo de casos en `/servicio/configuracion`. Todo en español. | E2E pasando. |
| **RH.4** Siembra y verificación cruzada | La cola RH **sólo con configuración** (cola confidencial, sin prioridad ni SLA, categorías validadas, Lesly Berber y Tania Solorio coordinadoras). Se corre la **matriz de 20 casos**. | Matriz en verde, caso por caso; los fallos se reportan, no se maquillan. |

**Regla de entrada de RH.4:** nunca se siembra la cola antes de que el acceso por cola y la confidencialidad pasen sus pruebas.
**Fuera de v1:** tickets padre-hijo (altas de empleado), campos extra, SLA calibrado, ruteo por ubicación y definir «urgente» en RH.

---

## 6. Matriz de verificación cruzada (20 casos)

Todas deben **fallar al intentar ver o filtrar** el ticket confidencial, salvo las del solicitante y las de RH.

| # | Quién | Intenta | Resultado esperado |
|---|---|---|---|
| 1 | Agente de TI | Abrir el ticket por URL directa | Denegado |
| 2 | Coordinador de Mantenimiento | Verlo en bandeja, búsqueda y «Mi trabajo» | No aparece |
| 3 | Administrador | Abrir el detalle | Sólo campos básicos, y la **API** tampoco envía los ocultos |
| 4 | Otro solicitante | Abrirlo | Denegado |
| 5 | El solicitante | Abrir su ticket | Lo ve completo |
| 6 | Lesly y Tania | Ver tickets de RH | Ven todos los de RH, ninguno de TI ni Mantenimiento |
| 7 | Cualquiera | Descargar un adjunto sin acceso al ticket | Denegado al emitir la URL (la ya emitida vence ver #19) |
| 8 | Sistema | Avisos por correo, WhatsApp y campana | Texto neutro; destinatarios sólo solicitante y miembros de RH |
| 9 | Sistema | Reportes con pocos casos | «—» bajo el mínimo; no se deduce restando totales |
| 10 | Agente no coordinador | Transferir el ticket | Denegado |
| 11 | Coordinador de RH | Transferir a una cola **no confidencial** | Denegado (R3). A otra confidencial sólo hacia un coordinador de esa cola |
| 12 | Cualquiera | Quitar la marca a un ticket ya creado | Imposible, ni por API ni por SQL con `app_runtime` ni cambiando la cola |
| 13 | Sistema | Pruebas existentes de TI y Mantenimiento | Siguen pasando |
| **14** | Agente de TI | «Mi trabajo» (por asignar / a tu cargo) | Los conteos **no incluyen** tickets de RH |
| **15** | Cualquiera | Leer la campana y `notification_log` | Sin título del ticket confidencial |
| **16** | Administrador | Agregarse como miembro o coordinador de RH | Denegado; sólo un coordinador de RH administra sus miembros |
| **17** | Sistema | Barredor de SLA sobre RH | Sin avisos y **sin «falla: sin política»** |
| **18** | Agente de TI | Levantar un ticket a nombre de otra persona hacia RH | Denegado; sólo miembros de RH |
| **19** | Cualquiera con una URL de adjunto reenviada | Abrirla pasada su vida corta | Expirada |
| **20** | Sistema | Puerto de Bitácora | No recibe eventos de tickets confidenciales |

Más una **prueba de build**: el candado estático falla si un archivo nuevo, fuera de la lista blanca, lee `servicedesk.requests`.

---

## 7. Riesgos y límites declarados

| Riesgo | Tratamiento |
|---|---|
| Fuga por canales secundarios (avisos, adjuntos, búsqueda, «Mi trabajo», reportes, Bitácora) | Cubiertos en H2–H9 y en la matriz. |
| Confidencialidad sólo en la interfaz | Se prueba en API y base (trigger + candado). |
| Reportes que identifican a una persona por celdas pequeñas | Mínimo de casos y supresión complementaria. |
| Superusuario de base de datos | **Límite conocido**, no se resuelve en v1 (§2.3). |
| URL prefirmada reenviada | Vida corta; límite declarado. |
| Datos personales sensibles | Que quien lleve lo legal/privacidad revise el **aviso de privacidad y la retención** antes de abrir RH. |
| Migraciones manuales, una por una | Checklist de orden en cada PR. |

---

## 8. Preguntas abiertas

1. **R3:** ¿confirman que un ticket de RH **no** sale a una cola no confidencial? (Es la decisión de fondo.)
2. **R8:** ¿la persona elige RH explícitamente, o debe existir otra puerta («reporte confidencial» desde cualquier lado)?
3. **R2/R4:** ¿«información básica» y el mínimo de 5 casos, tal cual?
4. **R7:** categorías a validar con RH.
5. **Alta de usuarios:** confirmar en producción que Lesly Berber y Tania Solorio tienen usuario y las capacidades `SERVICIO_ATENDER` y `SERVICIO_COORDINAR` (esta máquina no tiene sus fichas).
6. **Legal:** aviso de privacidad y retención.

---

## Apéndice — Prompt maestro corregido para Claude Code

**Cómo usarlo:** abre Claude Code en la raíz del repo en **modo plan**; **no copies ningún `CLAUDE.md`** (el repo ya tiene el suyo); pega el bloque. Ejecuta **un sprint a la vez** con los prompts de seguimiento. **Cambios respecto al original:** el prerrequisito se verifica **en el código** (no por el número de PR), ya no pide redescubrir lo medido (§2), trae las propuestas R1–R9 para que sólo pregunte lo que sigue abierto y añade el candado estático y los 20 casos.

```
Rol: eres el ingeniero y program manager de la extensión de la Mesa de Servicio a Recursos Humanos (RH) en el repo de la Suite de Mega Dulces.

# Lee primero (y respétalo, no sobrescribas nada)
- CLAUDE.md del repo.
- docs/IMPLEMENTACION/FASES/FASE_RH_MESA_DE_SERVICIO.md  (ESTE es el plan: hallazgos H1–H9, propuestas R1–R9, sprints y la matriz de 20 casos).
- docs/IMPLEMENTACION/FASES/FASE_MS7_MANTENIMIENTO.md  (el diseño multi-área del que RH depende).

# Compuerta de entrada (verifícala EN EL CÓDIGO, no por número de PR)
Comprueba que existen y están mergeados: la tabla servicedesk.queue_members, el acceso por cola en libs/service-desk (reemplazo de puedeVer) y una función de acceso por ticket. El PR #269 es SOLO el documento del plan: no cuenta. Si falta algo, DETENTE y dime exactamente qué falta. Nunca se siembra la cola RH antes de que el acceso por cola y la confidencialidad pasen sus pruebas.

# Contexto ya establecido
- Stack: NestJS 11 + Knex + PostgreSQL con RLS forzado por tenant_id (libs/service-desk, schema servicedesk.*), Angular 18 + PrimeNG (apps/view/src/app/modules/servicio), contratos en libs/contracts, vitest y E2E en database/tests/http-service-desk-test.js.
- Folio único SRV; mismos estados para todas las áreas más motivo de pausa; quién atiende qué área vive en queue_members (coordinador/tecnico); las claves SERVICIO_* son capacidades; NO hay permisos nuevos; agregar un área es CONFIGURACIÓN, nunca lógica por nombre de cola.

# Decisiones tomadas por Sistemas (no las cuestiones)
1) Todo ticket levantado a RH nace confidencial. 2) La marca vive a nivel de cola. 3) RH no tiene prioridad, semáforo ni "urgente"; no se hacen las dos preguntas de impacto. 4) Coordinan Lesly Berber y Tania Solorio (rol coordinador), sin técnicos por ahora. 5) El administrador NO ve los tickets confidenciales de RH, sólo información básica. 6) Los reportes de RH son sólo agregados con mínimo de casos. 7) Fuera de v1: padre-hijo, campos extra, SLA calibrado, ruteo por ubicación, definir "urgente".

# Hallazgos ya medidos (úsalos, no los redescubras; verifica sólo que sigan vigentes)
H1 el administrador puede agregarse como miembro de RH; H2 hay 9 archivos que leen servicedesk.requests, incluidos me-work.ts y me-tasks.ts (libs/trade); H3 el título se copia a notification_log.payload, al correo y al aviso de SLA; H4 las URLs de adjunto duran 600 s; H5 requests.priority es NOT NULL con CHECK y el barredor de SLA falla sin política; H6 app_runtime puede hacer UPDATE sobre requests; H7 se puede levantar a nombre de otra persona; H8 los reportes y stats cubren todas las colas; H9 el puerto de Bitácora no filtra. No se usa RLS por ticket (ver §2.3 del plan).

# Propuestas a confirmar conmigo (pregúntamelas; no las des por hechas)
R1 la marca la fija la base desde la cola y es inmutable (trigger). R2 "información básica" = folio, cola, fecha de alta, estado y fecha de resolución, sin título, descripción, hilo, adjuntos, solicitante ni conteos por categoría, y la API tampoco envía lo oculto. R3 un ticket de RH NO se transfiere a una cola no confidencial; entre las dos coordinadoras se reasigna. R4 mínimo de casos configurable por cola, inicial 5, bajo el mínimo "—". R5 RH sin SLA en v1, se declara "—", nunca 0. R6 sin responsable por omisión: "Sin asignar" visible a ambas. R7 categorías: nómina, vacaciones, incapacidades, altas y bajas, constancias, credenciales, capacitación, conflicto laboral (falta validarlas con RH); ubicación opcional. R8 la persona elige RH explícitamente al levantar el ticket, sin botón de "reporte confidencial" en otras colas. R9 un ticket levantado a nombre de otra persona lo ven sólo el solicitante y los miembros de RH.

# Reglas que no se negocian
- Una rama y un PR por sprint. Migraciones aditivas, idempotentes y reversibles; nunca contra producción; en prod se aplican una por una con apply-one-migration-prod.js, nunca migrate:latest.
- Tablas nuevas con tenant_id y RLS forzado. Orden: base de datos, luego lógica con pruebas, al final la pantalla.
- Cada regla de acceso, prioridad o SLA se prueba rompiéndola a propósito una vez y viendo el rojo.
- Lo que no se pudo medir se declara ("—"), no se dibuja como 0.
- La confidencialidad se aplica en la API y en la base (trigger + candado estático), no sólo en la interfaz. Los avisos neutros se escriben neutros, no se enmascaran al mostrar.
- Interfaz y mensajes en español. No inventes reglas de negocio: ante una duda, pregunta.

# Qué hacer ahora (Sprint RH.0, SOLO LECTURA: no modifiques archivos)
1. Ejecuta la compuerta de entrada y dime el resultado.
2. Verifica que H1–H9 siguen vigentes en el código de hoy y corrige lo que haya cambiado (con rutas de archivo).
3. Revisa cómo MS.7.6 implementó el acceso por ticket y qué falta para que devuelva completo | basico | ninguno.
4. Entrégame: (a) hallazgos nuevos o cambios respecto a H1–H9, (b) el diseño detallado de RH.1–RH.4 con archivos a tocar, (c) la lista blanca inicial del candado estático de lecturas de servicedesk.requests, (d) las preguntas R1–R9 que sigan abiertas y cualquier otra que encuentres.
5. Termina y espera mi aprobación. No avances a RH.1.
```

### Prompts de seguimiento (uno por sprint, tras aprobar RH.0)

**RH.1 — Base de datos**
```
Ejecuta el Sprint RH.1 del plan aprobado. Rama nueva. Sólo base de datos: columnas confidential / uses_priority / sla_enabled / report_min_cases en queues, requests.confidential y los DOS triggers (BEFORE INSERT fija desde la cola; BEFORE UPDATE rechaza cambiar la marca y sacar un confidencial a una cola no confidencial). Migraciones aditivas, idempotentes y reversibles; tenant_id y RLS en lo nuevo. Pruébalas en una copia, con subida y reversa, y demuestra con app_runtime que NO se puede quitar la marca por SQL. No toques lógica ni pantalla. Resume cómo aplicarlas una por una.
```

**RH.2 — Lógica y pruebas**
```
Ejecuta el Sprint RH.2. Rama nueva. En libs/service-desk (y los puntos de libs/trade que lean servicedesk.requests): acceso por ticket completo|basico|ninguno con vista básica del administrador (la API no envía campos ocultos); edición de miembros de una cola confidencial sólo por su coordinador; candado estático de lecturas con lista blanca; me-work y me-tasks acotados por cola; avisos neutros escritos neutros (correo, WhatsApp, campana, notification_log, aviso de SLA); URL de adjunto de vida corta en confidenciales; modelo sin prioridad (priority null en la API, barredor de SLA que salta la cola); levantar a nombre de otro hacia cola confidencial; transferencia según R3; reportes con mínimo de casos y supresión complementaria; filtro del puerto de Bitácora. Escribe las pruebas de los casos 1–20 de la matriz y rompe cada regla a propósito una vez. Corre vitest y el E2E: TI y Mantenimiento no deben tener regresiones.
```

**RH.3 — Pantalla**
```
Ejecuta el Sprint RH.3. Rama nueva. En Angular: aviso "esta solicitud será confidencial" al elegir RH, formulario sin preguntas de prioridad, sin semáforo ni chip de prioridad en ningún listado ni ficha de RH, vista limitada del administrador, y la bandera de confidencial y el mínimo de casos en /servicio/configuracion. Todo en español. Corre el E2E y revisa en navegador.
```

**RH.4 — Siembra y verificación cruzada**
```
Ejecuta el Sprint RH.4. Rama nueva. Primero confirma que el acceso por cola y la confidencialidad pasan sus pruebas. Después crea la cola RH SOLO con configuración (sin lógica por nombre): cola confidencial, sin prioridad ni SLA, categorías validadas con RH, Lesly Berber y Tania Solorio como coordinadoras. Corre la matriz de 20 casos de FASE_RH_MESA_DE_SERVICIO.md y entrégame el resultado caso por caso. Los fallos se reportan, no se maquillan.
```
