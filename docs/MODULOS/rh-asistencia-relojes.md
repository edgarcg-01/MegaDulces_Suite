# Recursos Humanos › Asistencia — relojes y personas

## RH.18.1 · La incidencia se levanta desde el día · RH.18.2 · Por qué un campo está bloqueado (2026-11-23)

**El problema.** RH extrañaba de Mega Talento tres cosas (lo dijeron a David, 2026-11-23): levantar la incidencia
**desde el día** del calendario, más variedad de tipos a la mano, y poder cambiar todo de una persona. En la Suite,
«+ Incidencia» en el renglón de un día **cerraba la ficha** y abría otro panel, que arrancaba en «Vacaciones» y pedía el
número de la persona; la hora de «Horario distinto» se tecleaba entera; en «solo esta persona» no había botón por día.
Y en la ficha, a quien tiene acceso a la Suite le **desaparecían** departamento, puesto y sucursal sin decir por qué.

**La solución.**

| Item | Antes | Ahora |
|---|---|---|
| `RH.18.1` | Ficha → se cierra → panel de Incidencias → elegir tipo (empieza en Vacaciones) → teclear número y horas | «+ Incidencia» abre el formulario **debajo de ese día**, en la misma ficha: su nombre (no su número), ese día, y arriba «Para este día» con el tipo más probable ya elegido (falta → permiso; llegó tarde → horario distinto; se pasó de la comida → comida distinta; día que no ha llegado → vacaciones). «Horario distinto» llega con la entrada, salida y comida que **checó**, para corregir en vez de teclear. También en «solo esta persona». Guardar dice si ya cuenta y recalcula la semana |
| `RH.18.2` | Con acceso: los tres campos no aparecían | «Tiene acceso a la Suite: su departamento, puesto y sucursal deciden lo que ve, por eso los cambia Sistemas en Administración › Personas», con liga a Personas sólo para quien la puede abrir (`USUARIOS_VER`) |

| `RH.18.3` | El tipo más probable ya venía elegido; los nombres de Mega Talento no aparecían | RH contestó la D1 (2026-11-23): «Tráfico» → Horario distinto (o Otros) · «Cita médica» → Incapacidad · «Personal» → Permiso sin goce · «No registrada» (vino y no checó) → Otros; «según el caso cambia, pero ésas son las más frecuentes»; y el tipo **no** debe venir elegido: «prefieren elegirlo ellas». Ahora: **nada viene elegido** (tampoco en el panel, que arrancaba en Vacaciones) y Guardar espera al tipo; «Para este día» ordena con esas respuestas (no vino → Permiso sin goce, Incapacidad, Otros; llegó tarde → Horario distinto, Otros; una sola checada → Otros); cada tipo muestra su nombre de Mega Talento («Incapacidad · cita médica») y la lista se filtra tecleando, así que escribir «tráfico» encuentra Horario distinto |

⚠️ **Para confirmar con RH:** «Cita médica → Incapacidad» venía con la nota «sólo con incapacidad del IMSS». Una cita sin
papel del IMSS capturada como incapacidad puede no cuadrar en nómina: por eso Incapacidad se **sugiere**, no se elige, y los
permisos siguen a la vista. «Tráfico» lo contestaron «a o d» (la «d» era «otro», sin decir cuál): se sugieren Horario
distinto y Otros.

**Cómo se implementó.** La captura vivía dentro del panel de Incidencias; salió a `incidencia-captura.ts` (el formulario,
lo que se manda y qué se propone por día) y a la pieza `app-rh-captura-incidencia`, que usan **el panel y la ficha**: una
sola regla de qué pide cada tipo, no dos copias (ADR-056). El renglón del día (`app-rh-persona-dias`) abre debajo lo que
le ponga quien lo usa. Sin cambios en la API, en la base ni en permisos: el mismo `POST` de captura y la misma
calificación (lo capturado cuenta cuando lo califica otra persona).

**Por qué así.**
- **Proponer no es decidir.** El tipo de arriba es un orden de opciones; los 19 siguen a un clic y el servidor valida igual.
  El orden sale de lo que contestó RH (D1, `RH.18.3`) y se afina en una sola función (`sugerenciasDelDia`).
- **No adivinar.** Con una sola checada no se sabe si fue entrada o salida: «Horario distinto» llega vacío. Y un tipo que
  el catálogo no trae no se elige.
- **Dar la razón, no sólo el bloqueo.** El servidor ya rechazaba el cambio con esa frase (D2 de Edgar); ahora la pantalla
  la dice antes de que alguien lo intente.
- **E3 (alta automática)** no entra: espera la D3 de Edgar.

**Cómo se probó.** Vista RH **330/330** (`incidencia-captura.spec.ts` 8 nuevas; la ficha: captura debajo del día, cerrar con
el mismo día, guardar y recalcular, «solo esta persona», el aviso de bloqueo con y sin `USUARIOS_VER` y sin acceso). Panel
de Incidencias 21/21 sin tocar sus pruebas (la extracción no cambió lo que manda). Mutantes: con una sola checada
adivinar la hora → rojo; volver a irse al panel → 3 rojos; la liga sin permiso → rojo. `tsc` y `ngc` 0 errores en RH.
`check:pantalla -- rh`: 0 fallas nuevas por este cambio; el formulario de captura queda con Q.1/§2/§9 como deuda
declarada (es un formulario: no abre con cifras, no carga datos ni tiene dato que envejezca). **Sin validación visual**
(ni en escritorio ni a 390 px: el formulario dentro del renglón apilado del celular está sin ver). Falta probarlo con RH.

## RH.17.1 · El nombre del checador llega al momento · RH.17.2 · Horario distinto con el horario del día (2026-11-19)

**El problema.** En `/rh/asistencia`, quien no está ligado a una persona de la Suite salía como «Empleado 109». El
aviso de cada checada trae el número y no el nombre; la lista de usuarios del reloj sólo viajaba con la lectura
completa, y desde `RH.1.3` los relojes que avisan ya no la hacen cada hora: sólo al arrancar el lector. Medido el
19-nov: 11 personas sin nombre, y la última lista de 9 de los 12 relojes era del 12-nov. Aparte, «Horario distinto»
era de un día y con su porqué, pero sólo guardaba la entrada: un día de 8:00 a 14:00 se medía contra la salida de su
horario de siempre y salía con 4 h de salida temprana.

### Solución

- **Nombres:** el lector manda la lista de usuarios en cuanto alguien se da de alta o de baja en el reloj, o checa un
  número que no venía en la última lista. Lee sólo la lista (no el registro de checadas) y, si no la puede mandar,
  reintenta a los 5 minutos. La Suite ya cambiaba «Empleado N» por el nombre real.
- **Horario del día:** «Horario distinto» suma **salida y comida opcionales**. Con la salida, ese día se mide de la
  entrada a la salida capturadas: retardo, salida temprana, horas esperadas y horas extra. Sin la salida, igual que
  antes. El horario de siempre de la persona (botón «Horario») no cambia.

### Cómo se implementó

- Lector (`database/importers/checadores/agente/reloj.js`): dos disparadores en el vigía de cada 30 s (cambió el
  número de usuarios del reloj, o checó un número desconocido) y la lectura de la lista con el candado del reloj,
  igual que los comandos de renombrar.
- Base: `hr.attendance_incidents.end_minutes` y `break_minutes` (migración `20261119093204`, nullable, con CHECK).
  La API las usa sólo si ya existen: antes de aplicar la migración la asistencia no se cae y una salida se rechaza
  diciendo por qué.
- Cálculo (`asistencia-persona.ts`): el día con salida capturada usa esa entrada, salida y comida. Si ese día también
  hay «Comida distinta», manda ésa.
- Pantalla (`rh-incidencias`): «Salió a las» y «Comida ese día» en el formulario de Horario distinto, y en la ficha.
- Pruebas del lector con el reloj simulado, del cálculo, de la pantalla y de la captura contra una base real con el
  mismo cuerpo que manda la pantalla, antes y después de la migración. Cada una se rompió a propósito una vez.

### Por qué así

Un tipo de incidencia nuevo para «el horario de un día» habría dejado a RH escogiendo entre dos casi iguales; ampliar
el que ya existe conserva el porqué y quién autorizó, que ya se pedían. Y la lista de usuarios se lee sola, y no el
registro completo, porque cuesta decenas de KB contra los ~2 MB del registro, así que se puede pedir en el momento.

## RH.15 · El registro de la jornada como lo pide la ley (2026-11-17)

> **Recorte del 2026-11-23 (David: «¿realmente son necesarias las 8 migraciones?»).** Quedan **2**, fusionadas porque
> ninguna estaba aplicada en prod: `20261117103955` (checadas como evidencia + desfase del reloj, RH.15.1 + RH.15.4) y
> `20261117105402` (firma de la semana en papel y por QR, RH.15.5 + RH.15.11). **Salieron del código**, y viven sólo en el
> respaldo: el aviso de privacidad (RH.15.6: ya existe un registro de avisos en Mesa de Servicio, `servicedesk.privacy_*`;
> cuando Legal entregue el texto se EXTIENDE ése), el expediente de la persona (RH.16.1: nadie lo priorizó; lo pide
> `[MDT.5.8]` cuando el PM lo abra), la carta poder y los sobres (RH.16.2/16.3: pospuestos, el modelo no coincide con cómo
> se entregan de verdad, ver plan RH §8 P1). Ninguna de las 8 sirve al foco actual de RH (horarios e incidencias).

**El problema.** La reforma a la LFT (DOF 1-may-2026) obliga a registrar electrónicamente la jornada de cada persona,
con hora de inicio y fin, y a entregarla a la autoridad (art. 132 fr. XXXIV; reglas de la STPS desde el 1-ene-2027).
Ese registro sólo hace **prueba plena si se acredita que lo acordaron** la persona y el patrón. Además, la ley pide
conservar los controles de asistencia (art. 804-III: el último año y uno más después de la baja; si no se exhiben,
art. 805 presume lo que dice el trabajador), y la huella o el rostro son **datos sensibles** (Ley de datos personales
2025: consentimiento expreso). Auditado en el código: las checadas se podían editar y borrar, el PDF «para firmar» no
se guardaba, el lector perdía checadas si la llave fallaba, una falla del reloj salía como «Falta», la Suite no
conocía los límites de jornada de la reforma y no había aviso de privacidad ni seguimiento de huellas de bajas.

**La solución, item por item:**

| Item | Qué pide la ley | Qué se hizo |
|---|---|---|
| `RH.15.1` | Un registro confiable | Las checadas son **evidencia**: un disparador rechaza cambiar reloj, código, hora, método o tipo; borrar exige `SET LOCAL hr.borrado_checadas = '<motivo>'` y deja copia en `hr.attendance_log_deletions`; la app perdió DELETE y un reloj con checadas ya no se borra (RESTRICT) |
| `RH.15.2` | No inventar faltas | «**Sin dato**» en vez de «Falta» cuando nadie de la plaza checó y al menos dos personas salían con falta (reloj caído o día no laborable). Con una sola persona sigue siendo falta. Se re-etiqueta después del cálculo: la regla sigue en paridad con Mega Talento |
| `RH.15.3` | No perder checadas | El lector ya no da por enviado un lote que la Suite rechazó por la llave (401/403): se queda en la cola y se reintenta |
| `RH.15.4` | Inicio y fin exactos | Cada checada guarda el **desfase de su reloj** al entregarla; lo de más de un día en el futuro se rechaza (reloj con la fecha mal puesta), unos minutos adelante no |
| `RH.15.5` | Prueba plena (acuerdo) | **Firma de la semana**: una hoja por departamento, firmada por las personas y su jefe de área, se sube en el panel de cierre y queda ligada a la versión cerrada; si la semana se reabre y cambia, hay que volver a firmar |
| `RH.15.9` | Entregarlo a la autoridad | «**Registro para la autoridad**» en la ficha: CSV de las checadas tal como las entregó el reloj (hasta 400 días) con su huella sha256 |
| `RH.15.10` | Jornada 48→40 h y horas extra 9→12 | Cada semana se mide contra la **ley del año**; lo que pasa de la jornada es irregularidad, y si pasa del tope de horas extra (se pagan al triple) es alta |
| `RH.15.6` | Consentimiento por la huella | ⏸️ **Fuera del código desde el 2026-11-23** (respaldo en `Documents\respaldos-git\2026-11-23\antes-de-recortar-a-2-migraciones\`). Era: registro del **aviso de privacidad firmado** por persona (el texto lo da Legal) |
| `RH.15.7` | Suprimir lo que ya no se necesita | Lista de **huellas de personas dadas de baja** que el reloj sigue teniendo; a los 7 días, «por quitar». No se borra nada desde aquí |
| `RH.15.8` | Conservar 1 año después de la baja | Hasta cuándo se conservan las checadas de cada baja. Nada se borra solo |
| `RH.15.0` | El registro de **cada** trabajador | Personas activas que no checaron en una semana (no vinieron, o trabajan sin registrar) |
| `RH.15.11` | Prueba plena (acuerdo), desde el celular | **QR personal** por persona (un uso, 72 h): lo escanea, ve SU semana cerrada y firma con el dedo; **la firma es la autorización** y cuenta en ese momento. RH la puede **anular con motivo** (no se borra). Se guarda en el **PDF del departamento** (todas las firmas, con trazo, hora e IP) y en el **expediente de la persona** (Asistencia › persona › «Firmas de su asistencia», con comprobante de la versión exacta que firmó). La hoja en papel queda como respaldo. La base guarda la **huella** del token, no el token |
| `RH.16.1` | Un solo expediente por persona | ⏸️ **Fuera del código desde el 2026-11-23** (respaldo en `Documents\respaldos-git\2026-11-23\antes-de-recortar-a-2-migraciones\`). Era: **expediente de la persona** (su usuario de la Suite, no la plaza): el **contrato** y los 12 casilleros de Reclutamiento, aunque nunca haya pasado por Reclutamiento («Subir archivo» en su ficha de Asistencia), más sus **semanas firmadas de todas sus plazas**. Al pasar a «Contratado», RH dice **quién es en la Suite** y los documentos de la candidatura se **ven** en el expediente (no se copian). Quién ve: **RH** (llaves de Reclutamiento) todo; **su jefe**, sólo si es de su gente por el organigrama, y sin subir ni retirar |
| `RH.16.2` | Pago directo o con carta poder (LFT art. 100) | ⏸️ **Fuera del código desde el 2026-11-23** (respaldo en `Documents\respaldos-git\2026-11-23\antes-de-recortar-a-2-migraciones\`). Era: **carta poder para cobro** en el expediente: a quién autoriza la persona a recoger su sobre, **dos testigos distintos**, la carta firmada y desde cuándo vale. **Una vigente por persona**; se **revoca con motivo** (no se borra). Sin carta vigente, «recoge su sobre en persona». Es la regla que usará la entrega del sábado: el representante sólo recoge los sobres de quien le dio carta poder |
| `RH.16.3` | El efectivo del sábado se entrega por departamento y nadie sabía, después, quién recogió el sobre de quién ni si le llegó | ⏸️ **Fuera del código desde el 2026-11-23** (respaldo en `Documents\respaldos-git\2026-11-23\antes-de-recortar-a-2-migraciones\`). Era: **sobres de efectivo** (`/rh/sobres`, clave nueva `HR_PAY_ENVELOPES_GESTIONAR`, para quien escojan de Finanzas): **armar** el monto de cada persona sobre la semana cerrada (en la fila o pegando desde Excel; corregir pide motivo y queda el historial) y **entregar**: se elige quién viene a recoger (la lista dice cuántos sobres le tocan), la pantalla muestra **sólo nombres, nunca montos**, y firma **una vez por todos**. El sobre ajeno sólo sale con **carta poder vigente a su nombre**; si uno no le toca, no sale ninguno. Cada dueño ve su sobre **con monto**, quién lo recogió y cuándo, y contesta «Sí lo recibí» / «No me llegó» (con nota a RH): en **«Mi sobre»** (menú de usuario) y en la página de su QR, aunque ya haya firmado su semana. Quien recoge el suyo ya firmó de recibido. **No toca Caja General** |

**Cómo se implementó.** 2 migraciones (`20261117103955` candado + desfase, `20261117105402` firmas en papel y por QR;
antes eran 5, fusionadas el 2026-11-23), tres controladores **nuevos** (firmas, registro, cumplimiento) en vez de parámetros nuevos en el de
asistencia (#414), sin permisos nuevos (firmas con `HR_PERIOD_CLOSE`), y en la
pantalla: el bloque de firmas debajo del cierre, el registro en la ficha y el cumplimiento en el panel de Relojes.

**Por qué así.**
- **Re-etiquetar en vez de cambiar la regla de faltas**: la regla da 0 diferencias contra Mega Talento; «Sin dato» se
  agrega después y se puede quitar sin tocarla.
- **La firma va ligada al cierre**: se firma lo que quedó cerrado; firmar algo que todavía cambia no prueba nada.
- **Huellas y conservación sólo se AVISAN**: borrar una huella es una orden a un equipo de producción y el plazo exacto
  lo confirma el abogado.
- **La ingesta tolera que falte la columna del desfase**: un INSERT que nombra una columna inexistente pararía los 12 relojes.
- **Firma del celular (`RH.15.11`): la firma es la autorización** (decisión de desarrollo con RH, 2026-11-17). Primero se
  construyó con número de reloj (5 intentos) y confirmación del jefe con su trazo; se quitaron los dos para que firmar sea
  abrir, leer y firmar. ⚠️ **Riesgo declarado:** el QR es la única llave: quien lo tenga ve la semana de esa persona y
  puede firmar por ella. Lo acotan: 144 bits al azar, un solo uso, 72 h, se revoca al generar otro, entrega en mano, IP +
  navegador + hora de cada firma, la frase «si no eres Fulano, no firmes» y **anular con motivo**. Falta que Legal diga
  si así alcanza como «acuerdo»; si no, se regresa el número de reloj (nunca llegó a `main`: hay que volver a escribirlo).
- **Expediente (`RH.16.1`, fuera del código desde el 2026-11-23), por qué era así:** la persona ya es la llave de la asistencia (cada número de reloj se liga a su
  usuario; el «alta» crea uno sin acceso), así que no hace falta otra identidad. Los documentos de la persona usan la MISMA
  forma y reglas que los del candidato (`talent/logic/expediente.ts`), y el expediente lee los de la candidatura por la
  liga `hired_user_id` (regla 2: derivar, no copiar). El jefe sale de la cadena de mando de puestos
  (`platform-core/org/cadena-de-mando.ts`, primitivo común): **falla cerrado**, un organigrama incompleto lo deja sin ver,
  nunca de más. Sin permiso nuevo (decisión de desarrollo, se puede separar después). ⚠️ Son INE, CURP, NSS y cuenta
  bancaria: bucket privado y URL de 10 minutos. Lo que dijo RH sin medir (todos ligados, todos con jefe) queda por medir.
- **El PDF se arma con lo guardado** (la foto del cierre + el trazo + la huella de la versión): se vuelve a generar igual
  cuando se necesite, en vez de guardar un PDF que podría no cuadrar con la base.
  El token lleva el tenant (no es secreto) y 144 bits al azar: la página pública no necesita saltarse RLS.
  Página pública `/mi-semana/:token` (en `RUTAS_PUBLICAS`); API `/hr/attendance/firma/:token` con límite de peticiones.
- **El tope de 2 MB del JSON**: la hoja escaneada (hasta 10 MB) daba 413; `main.ts` les da 16 MB sólo a esas rutas.

**Lo que falta, y de quién es.** El texto y la versión del aviso de privacidad (Legal) · el plazo exacto de
conservación (abogado) · quitar huellas del reloj (Sistemas / líder técnico) · el formato oficial del registro (STPS, se espera
en diciembre) · el «banco de horas extra», que la LFT no contempla (abogado) · la cobertura real necesita la nómina · si la firma
del celular, sin número de reloj ni jefe, basta como «acuerdo» del 132-XXXIV (Legal) · si una carta poder firmada UNA vez vale para todas las semanas (Legal, `RH.16.2`) · el monto del sobre se CAPTURA en la Suite (`RH.16.3`, dato propio): confirmar con Edgar que reemplaza al archivo de RH y no se lleva doble · si el efectivo sale de Caja General, ese asiento es de Edgar · repartir `HR_PAY_ENVELOPES_GESTIONAR` a quien escojan de Finanzas (Edgar, regla 20) · medir en prod cuántos están ligados y tienen jefe (`RH.16.1`, sin medir) · ligar ContPAQi ↔ persona (Edgar abre `contpaqi_nom`) · revisar la página pública
antes de prod (líder técnico) · `APP_PUBLIC_URL` en prod, o las ligas toman el origen de quien las genera.

**Cómo se probó, después del recorte (2026-11-23).** `tsc` de api y view, y `ngc` de view: 0 errores. libs/hr asistencia
316/326 contra el Postgres local (stack de desarrollo, transacciones que se deshacen): las 11 de RH.15 en verde (firma
digital, firmas en papel, cumplimiento, registro, ingesta); las 9 rojas son de la base local, que se quedó en la migración
del 2026-09-08 (le faltan `identity.users.status` y `hr.device_enrollments.user_id`) y no tocan RH.15: **NO MEDIDAS**.
Talent 257, authz 79, vista RH 319: en verde. La migración de checadas fusionada, 11/11 en una transacción que se deshace,
con su NEGATIVA (con el `down`, cambiar la hora de una checada vuelve a pasar). `test-newdb-rh15-checadas-inborrables.js`:
NO MEDIDO en local (pide `hr.attendance_sites`, que la base local no tiene). `check:pantalla -- rh`: 29 fallas «nuevas»
contra la línea del 2026-10-19, ninguna por el recorte (fallan igual pantallas idénticas a `main`). **Sin validación visual.**

**Cómo se probó (2026-11-17, antes del recorte).** libs/hr completo contra Postgres local **542/542**; vista RH **264/264**; `test-newdb-rh15-checadas-inborrables.js`
**10/10** con su prueba negativa. Pruebas negativas también en el lector (sin el arreglo, 3 rojos), «Sin dato» (con una
persona sigue siendo falta) y el CSV (una hora tocada cambia la huella). `ngc` 0 errores; firmas y cumplimiento
cumplen las 10 reglas de pantalla. **Sin validación visual** hasta que se vea en local con el stack arriba.

## RH.13.8 · El horario ya no se encima sobre las checadas (2026-11-17)

**El problema.** En la tabla semanal de `/rh/asistencia`, a quien tiene varios horarios (mañana, tarde) y sábado, el
texto de la columna Horario se salía de su celda y quedaba **encima de las checadas del jueves y el viernes**: no se
leían ni el horario ni las checadas. Se vio en producción con una captura. Medido en Chrome con el CSS de la tabla:
`10:00–19:00 / 07:30–16:00 / 12:30–21:00 · sáb 07:30–16:00` en una columna de 118 px se salía **208 px**; el control
(un solo horario, `08:00–17:00`) cabía.

**La causa.** La celda tenía `white-space: nowrap` (no puede partirse) y `max-width: 6rem` (no puede crecer). El texto
no tenía a dónde ir y se desbordaba sobre las columnas de los días.

**La solución.** Un turno por renglón y el sábado aparte, cada uno sin partirse: `horarioRenglones()` en
`reporte-formato.ts` corta en « / » y « · », y la celda pinta un bloque por renglón. La fila con varios horarios crece
de alto (40 → 73 px) en vez de taparle el dato a la de al lado; las de un solo horario y las deducidas quedan igual.
El PDF y el Excel no cambian (usan `horarioDe`).

**Cómo se probó.** El mismo instrumento antes y después (la tabla con el CSS real, en Chrome): 208 px → 0 a 1300, 1100 y
900 px; a 700 la columna ya se ocultaba y el horario baja bajo el nombre. `rh-reporte-semanal.component.spec.ts` monta la
tabla y exige un renglón por turno (prueba negativa: con la celda vieja, en rojo); `reporte-formato.spec.ts` cubre la
partición (sábado sin horas, rotativo, deducido, vacío). Módulo RH 249/249; `ngc` 0 errores (con su control: un método
inexistente en la plantilla sí lo marca). **Sin validación visual en producción** hasta el despliegue.

## RH.13.5 · Asistencia en una sola pantalla · RH.6.6 Visita fuera · RH.6.7 Pago de horas extras · RH.13.7 (2026-11-13)

### Problema

- **Seis páginas para una tarea.** Para revisar la semana de una plaza había que pasar por Checadas, Tolerancia,
  Faltas, Incidencias y Relojes, cada una con su menú y su filtro. En la auditoría del 11 de noviembre, a 1440×900 la
  primera persona aparecía al 76 % del alto de la pantalla y sólo se veían 3 de 7 personas.
- **Las tablas costaban leerlas**: sin rejilla, con columnas que no cabían en una laptop y nada pensado para teléfono.
- **Faltaban dos incidencias de Mega Talento**: Visita fuera y Pago de horas extras.
- **«Corporativo Comida»** seguía como plaza activa aunque su reloj ya estaba unido a Corporativo.

### Solución

- **Una pantalla:** Checadas, con Tolerancia y Faltas como modos, e Incidencias y Relojes en un panel. Las ligas viejas
  siguen funcionando y llevan ahí; quien no ve Asistencia (Contabilidad con Incidencias) conserva su página.
- **Más fácil de leer:** tablas con cuadros, buscador de todas las plazas arriba, calendario para elegir la semana,
  «PDF para firmar» como única exportación, la franja de relojes sólo para quien los administra, y en teléfono una
  vista con lo esencial. La primera persona sube al 49 % del alto, se ven las 7 y cada fila baja de 61 a 44 px.
- **Visita fuera:** justifica el día y suma el lapso de la visita a sus horas, sin tocar su saldo de horas extra.
- **Pago de horas extras:** descuenta del saldo lo que se le pagó; la pestaña Horas extra suma la columna «Pagadas».
- **Corporativo Comida** queda desactivada (no se borra).

### Cómo se implementó

- Las rutas viejas pasan por una guarda que lleva a la pantalla única con lo que traían en la URL; el menú deja de
  repetir Incidencias y Relojes a quien ya los ve dentro de Asistencia.
- La tabla se compacta por el ancho de su contenedor, no de la ventana: el menú lateral abierto o cerrado cambia el
  espacio real.
- Las dos incidencias nuevas no necesitan migración: el tipo es texto y las columnas que usan ya existían. Aun así,
  una prueba contra la base las captura con el mismo cuerpo que manda la pantalla y comprueba que el servidor rechaza
  un pago en dos días o una visita sin quién autorizó.
- La migración de Corporativo Comida sólo desactiva la plaza, deja una marca para poder revertir sólo lo suyo, y se
  niega si hay un reloj activo ahí.

### Por qué así

RH revisa la semana de una plaza de corrido; partirla en seis páginas la obligaba a armarla en la cabeza. Las dos
incidencias nuevas siguen las reglas de Mega Talento para que la paridad con el sistema anterior siga en cero
diferencias.

### Pendiente

- Confirmar con RH que no extrañan el Excel y que no necesitan ver los minutos de desayuno y comida cuando no se pasan.
- `[RH.13.4]`: «Sin dato» en vez de «Falta» día por día cuando el reloj no entregó (más importante ahora que la franja
  de relojes es sólo para administradores).
- `[RH.14.1]`: que la baja en RH quite el acceso a la Suite. Es una decisión de accesos y la toma Edgar.

## RH.13.1 · Un reloj caído ya no sale verde · RH.13.2 · Incidencias con nombre (2026-11-12)

### Problema

- **El reloj.** Si el lector no alcanza a un reloj (sin red, apagado, IP cambiada), sigue avisando cada pocos minutos
  «estoy vivo, pero falló esto». La Suite contaba ese aviso como señal del reloj y lo pintaba **verde**. En la auditoría
  del 11 de noviembre, el reloj de una sucursal no entregaba desde las 11:40 y a las 16:10 seguía en verde, mientras el
  reporte del día le marcaba 23 faltas a su gente. Como el semáforo decía «al día», tampoco salía el aviso de que un día
  sin dato no es una falta.
- **Las incidencias.** La lista y la ficha mostraban sólo el número de la persona («#101»). Para saber de quién era una
  falta antes de calificarla, RH tenía que ir a otra pantalla.

### Solución

- Con error del lector, lo que cuenta es la **última lectura buena** del reloj. Un reloj que no entrega nunca sale verde:
  amarillo mientras la última lectura tenga menos de 2 h, rojo después. La franja dice «última lectura hace 4 h 30 m»
  junto al error que reportó el lector, en vez de «hace 2 min».
- Cada incidencia trae el **nombre de la persona en esa plaza**, junto a su número, en la lista y en la ficha.

### Cómo se implementó

- `semaforoReloj` (`libs/hr/.../logic/relojes.ts`) recibe el error y los segundos desde `last_sync_at`, que sólo se
  actualiza cuando la lectura sale bien. `GET /hr/attendance/devices/status` agrega `ultimaLectura` y
  `segundosSinLectura`. Sin migración: la columna ya existía.
- El nombre sale con la misma regla del directorio de personas: manda el código ligado a una persona de la Suite, si no,
  el nombre con el que está en el reloj; si no hay ninguno, se muestra sólo el número. La bitácora de cada incidencia
  sigue guardando la fila de la tabla, sin el nombre derivado.
- Pruebas de la regla, del texto y de la pantalla, y contra la base el caso exacto de la auditoría (lector vivo, reloj
  caído 4 h 30 m). Cada una se comprobó rompiendo el código a propósito: con la regla vieja, la prueba contra la base
  devuelve «verde», igual que producción.

### Por qué así

La regla de Mega Talento es que la pantalla nunca parezca al día cuando no lo está. Un aviso con error prueba que el
**lector** vive, no que el **reloj** entregue. El nombre viene del servidor porque es la misma regla que ya usan el
directorio y el padrón: calcularlo en la pantalla daría dos respuestas para la misma persona.

### Pendiente

- `[RH.13.4]`: que el reporte diga «Sin dato» en vez de «Falta», día por día, cuando el reloj no entregó. Toca el cálculo
  que hoy da 0 diferencias contra Mega Talento y se mide antes de cambiarlo.

## RH.1.12 · Ligar los códigos de reloj a sus personas (2026-10-15)

### Problema

Un reloj checador sólo sabe «el número 214 de Zamora checó»; quién es el 214 lo decide la Suite. Hasta hoy ese enlace
sólo lo hacía la carga única de Mega Talento: en la Suite no había dónde hacerlo. En Mega Talento entran de 3 a 11
personas nuevas por semana. Después del corte, cada una habría aparecido como «Empleado 214»: sin faltas, sin sección y
fuera del reporte de RH, sin que nadie pudiera arreglarlo.

### Solución

- En **Relojes** hay una sección nueva, «Códigos sin persona», con cada número que checa y no tiene dueño: de qué plaza
  y reloj es, el nombre que trae el reloj y cuándo checó por última vez.
- Para cada uno, la Suite **sugiere** a quién podría pertenecer: el mismo número ya ligado en otro reloj de la plaza, o
  una persona con el mismo nombre. RH confirma con un clic; **nunca se liga solo**.
- Si no aparece entre las sugerencias, se puede **buscar** a la persona por nombre o **darla de alta** (sin contraseña ni
  acceso a la Suite) con su sección del reporte.
- Si ese número ya era de otra persona, la Suite lo dice y pide confirmar antes de cambiarlo.

### Cómo se implementó

- El motor que decide quién es quién se pasó de la carga a `libs/hr/.../logic/personas.ts`, para que la bandeja proponga
  con las mismas reglas. La carga conserva su copia porque corre dentro del servidor, donde no está `libs/`; una prueba
  exige que las dos decidan igual.
- `HrAttendanceEnrollmentsService` y la ruta `/api/hr/attendance/enrollments/*`: listar, buscar, ligar (en todos los
  relojes de la plaza), desligar con motivo y dar de alta. Cada cambio queda en la bitácora de personas
  (`identity.user_events`) con quién lo hizo.
- Usa el permiso de administrar relojes, que RH ya tiene: no hubo que repartir uno nuevo ni crear migraciones.
- Pruebas de las reglas, de la bandeja completa contra la base (hasta comprobar que la asistencia ya reconoce a la persona
  con su sección) y de la pantalla, comprobadas rompiendo el código a propósito (siete veces).

### Por qué así

Un enlace equivocado le pasa las faltas de una persona a otra, y eso termina en la nómina: por eso la Suite sólo sugiere
y una persona confirma. Como la asistencia se calcula al momento de consultarla, ligar a alguien días después recupera
todo lo que ya checó. Por eso el corte no tiene que esperar a esto, aunque debe estar listo en su primera semana.
