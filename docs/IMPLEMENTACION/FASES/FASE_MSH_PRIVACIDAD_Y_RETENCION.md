# Fase MSH — Plan de aviso de privacidad y retención de datos de la cola de RH

> **Estado:** 📋 PLAN (2026-10-10). **PRV.2 (consentimiento en el formulario) construido el 2026-10-12** — ver §6.1; el resto, sin código. Es la condición «Legal» de [`FASE_MSH`](FASE_MSH_MESA_DE_SERVICIO_HUMANOS.md) §7 (*«que quien lleve lo legal/privacidad revise el aviso de privacidad y la retención antes de abrir RH»*).
> **Para quién:** (1) quien lleve lo legal/privacidad de Mega Dulces —que es quien **decide**—, (2) Sistemas, que lo implementa, (3) RH (Lesly Berber y Tania Solorio), que lo opera, y (4) Edgar, que revisa.
> ⚠️ **Esto NO es asesoría legal.** Lo escribió un asistente de desarrollo a partir de lo que **el sistema hace hoy** y de lo que la normativa mexicana suele exigir. Cada cita legal y cada plazo marcado **«a validar»** lo tiene que confirmar un abogado antes de usarse. Lo que sí es firme: **qué datos guarda la cola y cómo los protege hoy** (§2, medido sobre el código).

---

## 0. Resumen en 30 segundos

- La cola de RH va a guardar **datos personales laborales y, casi seguro, datos sensibles** (salud en incapacidades; discriminación, acoso o conflicto laboral en quejas; afiliación sindical). Los sensibles exigen **consentimiento expreso** y un aviso de privacidad que los nombre.
- **Hoy no existe nada de eso en la Mesa**: ni aviso de privacidad (sólo hay un aviso de *confidencialidad* en el formulario), ni registro de aceptación, ni plazo de conservación, ni procedimiento para que alguien ejerza sus derechos sobre lo que escribió. Todo lo guardado se **conserva sin límite**.
- El plan son **7 pasos (PRV.0–PRV.6)**; **4 son condición para abrir RH** (PRV.0–PRV.3). Los otros 3 (retención automática, derechos ARCO por sistema, protocolo de incidentes) pueden ir después, **siempre que** el procedimiento manual esté escrito antes de abrir.
- **Lo primero que se necesita de legal** son 6 decisiones (§8): quién es el responsable legal, el texto del aviso, qué es dato sensible aquí, el consentimiento, los plazos de conservación y quién atiende los derechos.

---

## 1. Marco normativo (a validar por el abogado)

| Norma | Por qué aplica a la cola de RH | Qué hay que confirmar |
|---|---|---|
| **LFPDPPP** (Ley Federal de Protección de Datos Personales en Posesión de los Particulares). Mega Dulces es **responsable** de los datos de sus trabajadores. | Aviso de privacidad, consentimiento (expreso para datos sensibles), derechos **ARCO**, medidas de seguridad, notificación de vulneraciones. | Que se aplique el **texto vigente**: el 20-mar-2025 se publicó una ley nueva y la autoridad pasó del INAI a la **Secretaría Anticorrupción y Buen Gobierno**. Confirmar vigencia, reglamento aplicable y si cambian los elementos del aviso. |
| **Ley Federal del Trabajo** | Obligación de conservar ciertos documentos de la relación laboral (art. 804 y siguientes) y plazos de prescripción de acciones (arts. 516–519). | Cuáles de los documentos que pasan por la Mesa caen en esa obligación, y que **el expediente de RH —no el ticket— es el documento de respaldo**. |
| **NOM-035-STPS-2018** (factores de riesgo psicosocial) y las reformas de 2019 sobre violencia laboral | La categoría «Conflicto laboral» es, en la práctica, el **mecanismo de quejas** que la norma pide, con **confidencialidad**. | Si el procedimiento de quejas de la empresa ya nombra a este canal; los plazos de atención y de conservación del expediente de una queja. |
| **Código Fiscal de la Federación** (art. 30, 5 años) | Algunos adjuntos (constancias, comprobantes de pago) pueden tener efecto fiscal. | Si lo adjuntado en la Mesa es copia o es el original. |

---

## 2. Qué guarda la cola de RH hoy (medido sobre el código, no supuesto)

Todo lo que se escribe en un ticket queda en la base de producción (`pg-prod`, servidor `md` de la empresa) y los archivos en un bucket privado (S3).

| Dato | Dónde | Quién lo ve (con MSH.1–3) | Cuánto se conserva hoy |
|---|---|---|---|
| Identidad de quien reporta (usuario, nombre, sucursal, puesto) | `servicedesk.requests` (+ `identity.users`) | El solicitante y la coordinación de RH. El administrador **no** (vista limitada: sólo folio, área, estado y fechas). | Sin límite |
| **Título y descripción** (texto libre) | `requests.title`, `description` | Ídem | Sin límite |
| **Hilo de mensajes y notas internas** (texto libre) | `request_messages` | Ídem (las notas internas, sólo RH) | Sin límite |
| **Adjuntos** (fotos y PDF: incapacidades, constancias, evidencia) | Bucket privado; URL de **60 s** en confidenciales | Ídem | Sin límite |
| Historial de estados, asignaciones y tiempos | `request_messages` (eventos), `work_log` | Ídem | Sin límite |
| **Avisos** (campana, correo, WhatsApp) | `notification_log.payload` | Destinatarios: el solicitante y RH. **Texto neutro** («Solicitud confidencial»): no lleva título ni texto. | Sin límite |
| Contacto para avisos (correo, celular) | `notification_prefs` | La propia persona | Mientras exista la cuenta |
| Respaldos de la base | Servidor de respaldos (`DailyBackup`) | Sistemas (administración de la base) | **No medido** (ver §6.4) |

**Lo que la protección técnica ya hace** (insumo para el apartado de medidas de seguridad): aislamiento por empresa con RLS forzado; la marca de confidencial la fija la base y no se puede quitar; el administrador de la Mesa no ve el contenido (la API no lo envía); sólo la coordinación de RH administra a sus miembros; avisos neutros; URL de adjunto de 60 s; la Bitácora no recibe tickets confidenciales; reportes sólo con un mínimo de casos; una compuerta de CI impide leer los tickets por un camino nuevo sin revisión.

**Lo que NO cubre (límites a declarar al abogado):**
- Un **superusuario de la base** (Sistemas) puede leer los datos: la confidencialidad es de aplicación, **no cifrado de contenido**.
- No se midió el **cifrado en reposo** del disco del servidor ni de los respaldos, ni quién tiene acceso al bucket.
- Los **respaldos** conservan lo borrado hasta que ellos mismos se rotan.
- No hay **registro de quién consultó** un ticket confidencial (sólo quién lo modificó).

---

## 3. Qué datos son sensibles aquí

El aviso y el consentimiento dependen de esto. **Propuesta de clasificación (a validar):**

| Categoría de RH | Datos probables | ¿Sensibles? |
|---|---|---|
| Incapacidades | Diagnóstico, folio IMSS, días | **Sí — salud** |
| Conflicto laboral (acoso, discriminación) | Hechos, nombres de terceros, orientación, origen, creencias, afiliación sindical | **Sí, probable** |
| Altas y bajas, datos personales y expediente | CURP, RFC, NSS, domicilio, cuentas; a veces discapacidad | Personales (algunos sensibles) |
| Nómina, prestaciones y préstamos | Importes, descuentos, embargos | Patrimoniales/financieros |
| Vacaciones, constancias, credenciales, capacitación | Fechas, puesto | Personales no sensibles |

**Consecuencia de diseño:** como el sistema **no puede saber** lo que la persona escribe en texto libre, **toda la cola se trata como si pudiera contener datos sensibles** (aviso único y consentimiento único para la cola), en lugar de intentar clasificar tickets.

---

## 4. Decisiones de diseño propuestas

1. **Un solo aviso de privacidad para la cola de RH**, con tres formas: **integral** (documento completo, publicado), **simplificado** (el texto corto que se ve en el formulario) y **corto** (una línea con enlace, en el aviso de confidencialidad que ya existe).
2. **Consentimiento expreso por escrito** para datos sensibles: una **casilla en el formulario de la cola de RH** («He leído el aviso de privacidad y consiento el tratamiento de mis datos, incluidos los sensibles que escriba»), que **no se pre-marca** y **bloquea el envío**. Se guarda **quién, cuándo y qué versión** del aviso.
3. **Las finalidades se separan**: *primarias* (atender la solicitud, cumplir obligaciones laborales y de seguridad social, dar seguimiento a quejas) y *secundarias* (estadísticas agregadas con el mínimo de casos). Las secundarias **no condicionan** el servicio.
4. **No hay transferencias** de lo que se escribe en la cola: la empresa lo procesa en infraestructura propia. Los canales de aviso (correo, WhatsApp) llevan **texto neutro**, así que no sacan datos personales del contenido. Confirmar con el abogado si el proveedor de correo y de WhatsApp cuentan como **encargados** y si el bucket (S3) también.
5. **Retención por tipo de dato, no «para siempre»**, con **anonimización** (no borrado de la fila) al vencer, para no perder las estadísticas ni romper el mínimo de casos.
6. **Bloqueo por proceso en curso** (*legal hold*): un ticket ligado a una queja o litigio **no se purga** aunque venza su plazo.
7. **Derechos ARCO** atendidos **por RH** (no por Sistemas), usando el propio canal confidencial (la categoría «Datos personales y expediente» ya existe).

---

## 5. Retención — propuesta de plazos (TODOS «a validar»)

El ticket es un **canal**, no el expediente. La propuesta parte de esa idea: lo que obliga la ley a conservar vive en el **expediente de RH**; el ticket se conserva lo **mínimo necesario** para atender, defenderse y rendir cuentas.

| Tipo | Plazo propuesto (desde el cierre) | Fundamento a validar | Al vencer |
|---|---|---|---|
| Solicitudes administrativas (vacaciones, constancias, credenciales, capacitación, nómina, prestaciones) | **2 años** | Prescripción laboral (arts. 516–519 LFT) y utilidad operativa | Anonimizar contenido; borrar adjuntos |
| Incapacidades y adjuntos de salud | **1 año**, y sólo si el original está en el expediente de RH | Minimización de datos sensibles | Borrar adjuntos; anonimizar |
| Conflicto laboral / acoso / discriminación | **5 años** | Posibles acciones laborales, civiles o penales posteriores; NOM-035 | Revisión manual de RH + legal antes de anonimizar |
| Registro de eventos sin contenido (folio, fechas, estados, categoría) | **5 años** | Rendición de cuentas y estadística | Se conserva |
| `notification_log` (avisos) | **90 días** | Sólo diagnóstico técnico; ya es neutro | Borrar |
| Aceptaciones del aviso (quién/cuándo/versión) | **Mientras dure la relación + 5 años** | Prueba del consentimiento | Se conserva |
| Respaldos | **Rotación de N días** (a definir; ver §6.4) | Seguridad | Se sobrescriben |

**Reglas de la purga (para cuando se programe):**
1. Primero un **ensayo sin borrar** que reporta cuántos tickets alcanzaría, por categoría y plazo, y **se autoriza** antes de activar el borrado real.
2. **Anonimizar** = reemplazar título, descripción y mensajes por «[eliminado por política de retención]» y borrar adjuntos del bucket; se conservan folio, cola, categoría, estado y fechas.
3. **Nunca** un ticket con *legal hold*, ni uno con estado abierto.
4. Cada corrida deja **latido** y un registro de cuántos tickets tocó (el repo exige que un proceso nocturno declare su entrega).
5. La purga es **configuración por cola** (`retención`, en meses, por tipo), no lógica por nombre de cola.

---

## 6. Plan de implementación

| Paso | Qué | Dueño | Entregable | ¿Condición para abrir RH? |
|---|---|---|---|---|
| **PRV.0** | **Decisiones legales**: responsable, finalidades, sensibles, consentimiento, plazos (§8) | Legal + RH | Documento firmado con las 6 decisiones | ✅ Sí |
| **PRV.1** | **Aviso integral** redactado y publicado en una URL estable; **simplificado** para el formulario | Legal (texto) + Sistemas (publicar) | Aviso v1 con número de versión | ✅ Sí |
| **PRV.2** ✅ | **Consentimiento en el formulario**: casilla obligatoria sólo en colas con aviso, tabla de aceptaciones (`user`, `versión`, `fecha`, `ticket`) | Sistemas | Migración aditiva + pantalla + pruebas (negativa: sin casilla no se envía). **Construido 2026-10-12** | ✅ Sí |
| **PRV.3** | **Procedimiento manual**: derechos ARCO, retención manual y qué hacer ante una vulneración (§7, §6.5), con **responsable designado** de datos personales | Legal + RH | Procedimiento de 2 páginas + responsable nombrado | ✅ Sí |
| **PRV.4** | **Retención automática**: configuración por cola, ensayo, anonimización, *legal hold*, latido | Sistemas | Proceso nocturno + umbral en el tablero + pruebas | ❌ Puede ir después (con la purga manual vigente) |
| **PRV.5** | **Atención ARCO por sistema**: exportar «todo lo mío» a la persona, y el flujo de rectificación/cancelación con las excepciones por retención | Sistemas + RH | Pantalla o reporte para RH | ❌ Después |
| **PRV.6** | **Seguridad pendiente**: cifrado en reposo, rotación de respaldos, registro de consultas de tickets confidenciales, revisión trimestral de quién es miembro de RH | Sistemas | Informe medido + mejoras | ❌ Después (declarar el riesgo al abogado desde PRV.0) |

**Orden y tiempos sugeridos** (sujetos a la agenda de legal): PRV.0 y PRV.1 en paralelo; PRV.2 y PRV.3 en cuanto haya texto; PRV.4–PRV.6 en las semanas siguientes a abrir. **Abrir RH requiere PRV.0–PRV.3 más lo que ya pide `FASE_MSH` §7** (usuarios de Lesly y Tania, validación de RH, pantalla vista en navegador, matriz de 20 casos).

### 6.1 Detalle técnico de PRV.2 (consentimiento)
- Migración aditiva e idempotente: `servicedesk.privacy_notices` (versión, URL, fecha de vigencia, `tenant_id`) y `servicedesk.privacy_acceptances` (usuario, versión, ticket opcional, fecha), ambas con RLS forzado y auditoría; y `queues.privacy_notice_id` (nulo = la cola no exige aviso, TI y Mantenimiento no cambian).
- El servidor **rechaza** la creación de un ticket en una cola con aviso si no llega la aceptación de la versión vigente (la regla va en el servicio, no sólo en la pantalla).
- Una persona que ya aceptó la versión vigente **no la vuelve a aceptar** en cada ticket; si cambia la versión, vuelve a aceptar.

**Lo que quedó construido (2026-10-12)** — con una diferencia respecto del diseño de arriba, y dos cosas declaradas:
- **Dónde vive el aviso:** `servicedesk.privacy_notices` (por **código y versión**; estados `borrador → vigente → retirado`; una sola vigente por código) y `servicedesk.privacy_acceptances` (una fila por versión y persona). La cola apunta por **código** (`queues.privacy_notice_code`), no por una versión concreta: al publicar la v2 la cola la exige sola.
- **Reglas del servidor** (`domain/privacidad.ts`, función pura con spec): sin versión vigente publicada no se crea nada (*fail-closed*); aceptar una versión vieja no vale; quien ya aceptó la vigente no vuelve a marcar; **a nombre de otra persona la casilla de quien atiende NO consiente por ella** (la titular debe haber aceptado ya).
- **La evidencia no se reescribe:** el texto de un aviso publicado no se edita (trigger), el estado sólo avanza, y las aceptaciones no se modifican ni se borran desde la API (`app_runtime` sólo tiene INSERT y SELECT; un trigger rechaza el UPDATE).
- **Sin cambios para TI ni Mantenimiento:** ninguna cola exige aviso hasta que MSH.4 le ponga el código a la de RH.
- ⚠️ **Texto provisional:** el contenido de los avisos lo publica PRV.1 (legal). Esta migración **no siembra ningún aviso**: sin uno vigente, la cola de RH **no puede** crear tickets.
- ⚠️ **Declarado, no construido:** (a) no hay pantalla de administración de avisos (se publican por SQL o por la siembra de MSH.4); (b) a nombre de otra persona sólo se puede levantar si ella ya aceptó — una persona que llama por teléfono a RH sin haber aceptado nunca queda sin canal: **pregunta abierta para legal** (¿consentimiento presencial registrado por RH?).

### 6.2 Detalle técnico de PRV.4 (retención)
- `queues.retention_policy` (JSON por categoría: meses y acción) y `requests.legal_hold` (con motivo y quién lo puso).
- Proceso nocturno registrado en `CRON_JOBS` con latido y umbral; ensayo (`dry_run`) como modo por defecto hasta que RH y legal autoricen el borrado real.
- Prueba negativa obligatoria: un ticket abierto, uno con *legal hold* y uno dentro de plazo **no** se tocan.

### 6.3 Derechos ARCO (resumen del procedimiento manual de PRV.3)
1. La persona pide acceso, rectificación, cancelación u oposición **por la categoría «Datos personales y expediente»** (o por el medio que fije el aviso).
2. La responsable de datos personales **responde dentro del plazo legal** (a validar) y deja constancia en el propio ticket.
3. **Cancelación:** se bloquea mientras haya obligación legal o un proceso en curso; se explica por qué (y se anonimiza lo que sí se pueda).
4. La respuesta de acceso **sólo incluye lo de la persona**, nunca datos de terceros mencionados en una queja.

### 6.4 Respaldos
Lo borrado o anonimizado **sigue en los respaldos** hasta que éstos se rotan. Hay que **declararlo en el aviso** («los datos pueden permanecer en respaldos hasta N días») y **medir la rotación real** de los respaldos (no se midió) antes de comprometer un número.

### 6.5 Vulneración de seguridad
Procedimiento mínimo a definir en PRV.3: quién decide que hubo vulneración, plazo para **avisar a las personas afectadas** y a la autoridad si la ley lo exige (a validar), y qué se registra. Insumo técnico ya existente: la bitácora de cambios de miembros y el historial del ticket.

---

## 7. Borradores de texto (para que legal los corrija — **no usar tal cual**)

> **Marcas `[…]` = dato que falta.** Nada de esto está aprobado.

**Aviso simplificado (se muestra en el formulario de RH):**
> **Aviso de privacidad — Recursos Humanos.** **[Razón social de Mega Dulces]**, con domicilio en **[domicilio]**, usará los datos que escribas en esta solicitud —incluidos los **sensibles** (por ejemplo salud, o hechos de una queja)— para **atender tu solicitud, dar seguimiento a quejas y cumplir obligaciones laborales y de seguridad social**. Sólo los verán tú y el equipo de RH. **No los transferimos** a terceros salvo obligación legal. Conservaremos tus datos **[plazo según categoría]**. Puedes ejercer tus derechos de **acceso, rectificación, cancelación y oposición** en **[medio]**. Aviso integral: **[URL]**.
> ☐ **He leído el aviso de privacidad y consiento el tratamiento de mis datos personales, incluidos los sensibles que escriba.**

**Elementos mínimos del aviso integral** (el abogado confirma la lista): identidad y domicilio del responsable; datos que se recaban (y cuáles son sensibles); finalidades primarias y secundarias, con el medio para **negar las secundarias**; transferencias y encargados; medios para ejercer ARCO y para **revocar el consentimiento**; cómo se avisa de cambios al aviso; plazo de conservación y mención de respaldos; datos de contacto de la **persona o departamento de datos personales**.

**Respuesta tipo a una solicitud de cancelación con retención vigente:**
> Recibimos tu solicitud el **[fecha]**. Por **[obligación legal / proceso en curso]** debemos conservar **[qué datos]** hasta **[fecha]**. Mientras tanto **solo el equipo de RH tendrá acceso** y no se usarán para otra finalidad. Al vencer el plazo, se eliminarán o anonimizarán. Puedes **[inconformarte ante …]**.

---

## 8. Lo que se necesita de legal (las 6 decisiones de PRV.0)

1. **Responsable:** ¿qué **razón social** es la responsable del tratamiento de los datos de los trabajadores (Mega Dulces es un grupo)? ¿Domicilio y **persona o departamento de datos personales**?
2. **Aviso existente:** ¿hay ya un aviso de privacidad para trabajadores? Si sí, ¿cubre la Mesa de Servicio de RH, o se actualiza el vigente en lugar de crear uno nuevo?
3. **Sensibles:** ¿se confirma la clasificación de §3? ¿Basta **una casilla** como consentimiento expreso por escrito, o se exige firma autógrafa o algo más?
4. **Finalidades secundarias:** ¿las estadísticas agregadas con mínimo de 5 casos son una finalidad secundaria con derecho a oponerse, o quedan dentro de las primarias?
5. **Plazos de §5:** ¿se aceptan, se ajustan o se reemplazan? En particular **conflicto laboral/acoso (5 años)** y **incapacidades (1 año)**; y qué hacer con adjuntos que son **copia** del expediente.
6. **ARCO:** ¿plazo y medio oficial de respuesta? ¿**Quién** responde (se propone RH, con legal de respaldo)? ¿Cómo se atiende un acceso a un ticket donde hay datos de terceros?

**Preguntas de apoyo:** ¿Los proveedores de correo, WhatsApp y almacenamiento son **encargados** (con contrato)? ¿Hace falta **evaluación de impacto** por tratar datos sensibles a escala? ¿Quién avisa a las personas si hay una vulneración y en qué plazo?

---

## 9. Riesgos y cosas a vigilar

| Riesgo | Mitigación |
|---|---|
| Abrir RH **sin** aviso ni consentimiento y que el ticket de una queja se use en un conflicto | PRV.0–PRV.3 son condición para abrir; la cola nace apagada |
| La retención se decide **sin** medir y se borra algo que había que conservar | Ensayo obligatorio antes de borrar; revisión manual de la categoría de acoso |
| Los **respaldos** contradicen el aviso («borrado») | Declararlo en el aviso y medir la rotación |
| Sólo **dos personas** (Lesly y Tania) concentran todo el acceso | Revisión trimestral de miembros; designar suplente con la misma restricción; registro de consultas (PRV.6) |
| Un superusuario de la base puede leer todo | Declararlo; evaluar cifrado de contenido o separación de funciones (PRV.6) |
| El texto libre contiene datos de **terceros** (el acusado, un testigo) | El aviso lo menciona; el acceso ARCO excluye datos de terceros |
| El **dictado por voz** manda el audio a un proveedor externo (Groq) | Desde `[MS.DICTADO]` (2026-10-14) **no se ofrece en áreas confidenciales** y el servidor lo rechaza (403). Antes de habilitarlo en RH, legal debe decidir si el proveedor puede ser encargado del tratamiento y si el aviso lo declara (transferencia fuera del país) |

---

## 10. Qué NO cubre este plan

- La **redacción definitiva** del aviso integral y de los contratos con proveedores (es trabajo de legal).
- Los datos de **candidatos** (reclutamiento de Mega Talento, Fase RH): es otro tratamiento, con otro aviso.
- Los datos de **clientes y proveedores** de la Suite.
- Una **evaluación de impacto** formal (se pregunta en §8, no se hace aquí).
