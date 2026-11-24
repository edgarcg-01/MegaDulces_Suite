# Fase RH — Plan de trabajo (desde el inicio hasta el apagado de Mega Talento)

> **Qué es esto.** La bitácora y el plan de la migración de Mega Talento a la Suite en un solo lugar:
> qué se hizo desde que arrancó (6-oct-2026), dónde estamos hoy (12-oct) y qué falta, en orden, hasta
> apagar Mega Talento el 18-dic. El diseño y las decisiones viven en
> [`FASE_RH_MIGRACION_MEGA_TALENTO.md`](FASE_RH_MIGRACION_MEGA_TALENTO.md) (ADR-084); el estado por item,
> en el [tracker](../01_TRACKER_PROGRESO.md). Este archivo **no los reemplaza**: los ordena en el tiempo.
>
> **Quién hace qué.** Claude programa, prueba y documenta · David opera (aprueba, aplica migraciones en
> prod, corre los cortes, despliega Mega Talento) · Edgar revisa y aprueba (ADR, merges) · RH valida
> mapeos y prueba.
>
> ⭐ **Frente NE — la nómina sale del Access** (abierto 2026-11-23):
> [`FASE_RH_FRENTE_NE_NOMINA.md`](FASE_RH_FRENTE_NE_NOMINA.md). Cuelga de esta fase porque comparte
> el padrón, el reloj y `hr.*`. Lo que RH le debe: **`hr.employees` sigue en 0 filas** — sin la carga
> de personas (`[RH.1.4]`, 🧪) el frente no puede ponerle llave a nadie.

---

## 1. Calendario

| Hito | Fecha | Estado |
|---|---|---|
| Preparación (RH.0) | hasta 9-oct | ⚠️ atrasada: faltan RH.0.2, RH.0.4, RH.0.5 y desplegar RH.0.6 |
| **Corte de asistencia** (RH.1.8) | ~~7-nov~~ **11-nov** («ya», Edgar; en horario hábil con su autorización) | 🔨 **Historial cargado en prod** (13:59: 12 plazas, 238,884 checadas, 1,065 personas ligadas; bitácora en [`RH_CORTE_ASISTENCIA.md`](../RUNBOOKS/RH_CORTE_ASISTENCIA.md)). ⏳ **Falta David**: el lector de `LapSistemasA` a la Suite (`reenviar "2026-11-11 12:59"`). Hasta entonces lo nuevo sigue llegando sólo a Mega Talento |
| Corte de reclutamiento + bot (RH.3.5) | **10-nov** (Edgar lo adelantó del 5-dic) | ✅ **Hecho**: bitácora en [`RH_CORTE_RECLUTAMIENTO.md`](../RUNBOOKS/RH_CORTE_RECLUTAMIENTO.md). 11-nov: segunda pasada (lo que RH hizo en Mega Talento después del corte) y **rol `reclutamiento_asistencia` a Lesly y Tania** ([RH.2.6]). Falta portar lo automático del bot viejo ([RH.3.6]) |
| Mega Talento en sólo lectura | 10-nov → 24-nov | 2 semanas como vuelta atrás |
| **Apagado de Mega Talento** (RH.4) | **24-nov** | — |

---

## 2. Lo que ya se hizo (6-oct → 12-oct)

| Fecha | Qué | Dónde |
|---|---|---|
| 06-oct | Inventario de Mega Talento medido (piezas, 49 tablas, 4 sistemas que comparten la base) y plan + ADR-084 propuesto | PR #274 |
| 06-oct | **[RH.0.1]** Respaldo: la rama `horarios-incidencias` (103 commits fuera de GitHub) subida al repo privado | repo de Mega Talento |
| 07-oct | **[RH.0.6]** Cierre de los endpoints abiertos de Mega Talento y del bot — código listo, **sin desplegar** | rama `fix/cerrar-accesos` (repos privados) |
| 07-oct | **[RH.0.4]** Propuesta de mapeos para RH (sitios → almacén, 40 departamentos → 21, puesto por defecto) — **sin validar** | doc compartido «Mapeos para RH» |
| 08-oct | **[RH.1.1]** Capa de datos `hr.*` (sitios, relojes, órdenes, lotes, horarios, alertas, incidencias, cierres) | PR #281 → `main` |
| 08-oct | **[RH.1.2]** Entrada de checadas con llave + administración de relojes + entrada compatible con el agente de Mega Talento | PR #283 → `main` |
| 08-oct | **[RH.1.5]/[RH.1.6]/[RH.1.7]** Lógica de asistencia, incidencias (6 estados), cierre jueves→miércoles, pantallas `/rh/*`, reparto de permisos | PR #286 → `main` |
| 07/08-oct | **[RH.1.8]** Carga única con cuadre al registro + paridad con datos reales (**1,464 personas, 5,464 días, 0 diferencias**) + pre-vuelo + runbook del corte | PR #286 → `main` |
| 08-oct | **[RH.1.7c]/[RH.1.5b]/[RH.1.5c]** Asistencia con la forma de Horarios de Mega Talento; desayuno y promotoría corregidos como en Mega Talento | PR #330 → `main` |
| 12-oct | **[RH.1.10]** en código: horas extra ganadas, banco con ajustes, desayuno/comida distintos, cambio de descanso; pestaña Horas extra. Paridad con datos reales contra Mega Talento `1a28f6e`: **0 diferencias** | rama `feat/rh-1-10-horas-extra` |
| 12-oct | **[RH.1.3]** en código: el lector de relojes en `database/importers/checadores/agente/` + `ops/k3s/29-hr-relojes.deployment.yaml` (nace apagado); retirado `import-checadores.js` (RH.0.3) | rama `feat/rh-1-3-lector-relojes` |
| 12-oct | **[RH.1.6b]** en código: el cierre de semana se frena con gente sin identificar y sólo pasa con motivo anotado | PR #366 |
| 12-oct | Este plan + **[RH.1.4]** en código: guion de carga de personas, mapeos versionados, migración `20261012094356`, pruebas (14 puras + 2 contra Postgres, `libs/hr` 148 verdes). **Falta correrlo con datos reales** | rama `feat/rh-1-4-personas` |

**Nada de esto está aplicado en producción.** El código está en `main`; las migraciones de RH no.

---

## 3. Hallazgos del 12-oct que cambian el plan

1. **Mega Talento siguió cambiando su lógica después del port.** Después de la paridad entraron dos
   commits: `ee4ff38` (08-oct: banco de horas extra, desayuno y comida distintos por día, cambio de día
   de descanso, «un día con incidencia se mide aunque no haya checado») y `1a28f6e` (12-oct: horas
   extra en la tabla semanal, PDF y Excel). **Nada de eso está en la Suite**, y el último trae una tabla
   nueva (`horas_extra_ajustes`). La paridad de 0 diferencias vale para lo que existía el 8-oct, no para
   hoy. → item nuevo **[RH.1.10]**.
   - **Propuesta:** desde el 12-oct, todo cambio de lógica de asistencia en Mega Talento se anota en
     §6 de este archivo para portarlo, y del **31-oct al corte** se congela (sólo correcciones). Si no,
     el blanco se mueve cada semana.
2. **Una baja sin contraseña no cabe en `identity.users`.** La regla de la base
   (`users_hash_solo_falta_si_corresponde`, `[ID.31]`) sólo deja faltar la contraseña a `invited` y a
   `servicio`. Mega Talento tiene ~560 fichas inactivas que la asistencia necesita como personas (sin
   ellas no se sabe que alguien está dado de baja). → la migración de `[RH.1.4]` agrega `terminated` a
   esa regla. Es seguro: el login ya filtra `activo = true` y corta antes de comparar con un hash nulo.
3. **No hay rol para «persona sin acceso».** `role_name` es obligatorio. Darle a ~500 personas un rol de
   verdad (cajero, almacenista) haría que el día que se active su cuenta entren con permisos que nadie
   decidió. → rol nuevo **`sin_acceso`** con el mapa de permisos vacío. **Decisión a confirmar con Edgar**
   (es parte de D1).
4. **Mega Talento no guarda CURP, RFC ni NSS.** Una ficha es `(sitio, código del reloj)`. Unir dos
   fichas de la misma persona en dos plazas sólo se puede por nombre, y hay 73 homónimos medidos en
   `[CH.0.8]`. → la carga **no adivina**: una persona por ficha, y las posibles repetidas salen en una
   lista para que RH las una.
5. **La propuesta de mapeos mandaba a las promotoras a «Tienda», y eso rompía la asistencia.** La Suite
   reconoce a la promotora de marca por la palabra «promotor» en su departamento (`esDeptoDePromotoria`,
   `[RH.1.5c]`) y la deja fuera de la medición de piso. En «Tienda», las 101 promotoras habrían salido
   con falta todos los días. → departamento nuevo **`promotoria_marca`** en la migración de RH.1.4. Si RH
   contesta que son de la marca (externas), cambia `kind`, no el departamento.
6. ~~La validación de RH sigue en blanco~~ → **no hacía falta** (revisado a fondo el 12-oct): Mega Talento ya
   trae las plazas, la sección del reporte de RH de cada ficha (es su «departamento»: se guarda tal cual) y quién
   es la misma persona en varias plazas. Lo que sí estaba mal era la carga: traducía las secciones a los
   departamentos de la Suite (el reporte dejaba de ser el de RH), inventaba puestos y duplicaba al personal que
   rota. Corregido en `[RH.1.4b]`; el departamento `promotoria_marca` del punto 5 queda sin uso.

---

## 4. Lo que falta, en orden

### 4.1 Antes del corte de asistencia (7-nov) — ruta crítica

| # | Item | Qué | Quién | Depende de | Fecha objetivo |
|---|---|---|---|---|---|
| 1 | **[RH.1.4]** | Personas: carga de `empleados` → `identity.users` + liga de los enrolamientos. **Lo que frena el corte.** Detalle en §5. 🧪 Código y pruebas listos el 12-oct; falta el ensayo con datos reales (necesita la URL de Mega Talento) | Claude + David | — | ensayo 14-oct |
| 2 | [RH.0.4] | ~~RH valida los mapeos~~ ✅ 12-oct: no hace falta, Mega Talento lo trae todo (`[RH.1.4b]`, carga corregida y paridad con la sección de RH) | Claude | — | ✅ 12-oct |
| 3 | [RH.0.2] | Edgar aprueba ADR-084 + el rol `sin_acceso` + la regla de bajas | Edgar | — | 17-oct |
| 4 | [RH.1.6b] | Nadie a prenómina sin identificar (el cierre se niega con gente sin ligar, salvo motivo). 🧪 En código el 12-oct (PR #366) | Claude | RH.1.4 | ✅ 12-oct |
| 5 | [RH.1.10] | Portar horas extra, desayuno/comida distintos y cambio de descanso de Mega Talento + re-correr la paridad. 🧪 En código el 12-oct: paridad 0 diferencias con datos reales | Claude | — | ✅ 12-oct |
| 6 | [RH.0.3]/[RH.1.3] | Un solo lector de relojes, en `md` (hoy es una laptop). 🧪 12-oct: el lector está en el monorepo con su manifiesto (nace apagado, `preparado-externo`) y se retiró `import-checadores.js`. **Falta: medir desde `md` (`ops/rh/medir-relojes.sh`) y crear el secreto `hr-relojes-env`.** Si un reloj no contesta desde `md`, el corte usa la opción A (la laptop apunta a la Suite) | David | — | 31-oct |
| 7 | Migraciones a prod | Una por una, en el orden del pre-vuelo: base de CH `20260817220000` primero, luego la cadena de RH (incluida la de RH.1.4) | David | 3 | el día del merge |
| 8 | Ocupar `recursos_humanos` | Darle el rol a las coordinadoras de RH desde `/admin/personas` (hoy tiene 0 personas) | David | 7 | 31-oct |
| 9 | Validación visual | Las pantallas `/rh/*` con datos reales, con RH | RH + Claude | 7, 8 | 3-nov |
| 10 | [RH.0.6] | Desplegar el cierre de accesos de Mega Talento (API+front, luego bot) | David | — | antes del corte |
| 11 | [RH.0.5] | RH dice qué pantallas usa (incluida la cola de alertas: 10,429 sugeridas, 0 decididas) | RH | — | 24-oct |
| 12 | **[RH.1.8] Corte** | Pre-vuelo en verde → carga única `--aplicar` → agente a la Suite → Mega Talento asistencia en sólo lectura 2 semanas | David + Claude | todo lo anterior | **7-nov** |

Al encender, en el mismo cambio: `ENABLE_HR_ATTENDANCE_AGENT=true` + filas `hr_attendance_agent` y
`hr_attendance_ingest` en `CRON_JOBS` (sin ellas el latido no tiene umbral y se ve verde sin medir).

### 4.2 Después del corte de asistencia

| Item | Qué | Fecha objetivo |
|---|---|---|
| [RH.1.3] (si no entró) | Agente de relojes en `md`, latido + prueba negativa (apagar un reloj y ver el rojo) | 14-nov |
| [RH.1.9] (opcional) | Modo push ADMS para PH y Morelia Abastos | — |
| [RH.2.1]–[RH.2.4] | Reclutamiento: `talent.*`, API, pantallas, portal público `/empleo/*` con token firmado | 27-oct → 21-nov (se construye sin cortar; puede arrancar antes si RH.1 se adelanta) |
| [RH.3.1]–[RH.3.4] | Bot en `libs/whatsapp`: ruteo por número, conversación, solicitud, CV, dictamen; se retira Firestore y el panel del bot | → 28-nov |
| [RH.3.5] **Corte** | Reclutamiento + bot juntos: carga única de candidatos, mensajes y documentos (al bucket privado); el webhook de Meta apunta a la Suite. **9-nov: la carga de candidatos, vacantes, etapas y eventos ya existe** (`[RH.2.5]`, `carga-reclutamiento-mega-talento.js`); **y la del bot también** (`--con-bot`, `[RH.3.5a]`: 220,897 mensajes y 2,715 conversaciones, ensayadas con datos reales); **y la de los archivos** (`carga-archivos-mega-talento.js`, `[RH.3.5b]`: 5,773 archivos, 1.5 GB, ensayados bajándolos). Orden del corte: reclutamiento + bot → archivos → webhook de Meta a la Suite → apagar Railway. Falta: el webhook, medir el espacio del bucket de prod y que David saque 438 documentos que sólo están en el disco del bot | **10-nov** (runbook [`RH_CORTE_RECLUTAMIENTO.md`](../RUNBOOKS/RH_CORTE_RECLUTAMIENTO.md)) |
| [RH.4.1]–[RH.4.3] | Apagar API, front y bot en Railway; quitar el servicio de Windows; rotar la contraseña de la base compartida y dar un rol propio a cada sistema que queda; cerrar `[CH.0.7]`–`[CH.0.10]` y `[ID.16]` | **18-dic** |
| RH.5 | Nómina, sobres y entrega sin papel | después del apagado |

---

## 5. [RH.1.4] — Personas, en detalle

**Qué resuelve.** Hoy, después de la carga, hay 991 enrolamientos activos y **ninguno ligado a una
persona**: el pre-vuelo bloquea. Sin personas no hay faltas de quien no checó, ni planta/promotoras, ni
bajas. La paridad de 0 diferencias se midió simulando justo esto (una persona por ficha); ahora se hace
de verdad.

**Cómo** (carga única, no importer — D4):

1. **Migración** (generada con `scripts/nueva-migracion.js`):
   - la regla de contraseña acepta `status = 'terminated'` además de `invited` y `servicio`;
   - rol `sin_acceso` con permisos `{}` y alcance `none` (el login lo rechaza igual: no tiene contraseña);
   - departamento `promotoria_marca` (ver §3, punto 5).
2. **Mapeos versionados** en `database/scripts/rh/mapeo-personas-mega-talento.json`: sitio → almacén,
   departamento de Mega Talento → `department_code`, puesto por defecto por departamento. Cada entrada
   dice si está `validado` por RH o sólo `propuesto`. Sin nombres de personas (el repo es público).
3. **Guion** `database/scripts/rh/carga-personas-mega-talento.js` (ensayo por omisión, `--aplicar` para
   escribir, misma identidad de clúster y verificación que la carga de checadas):
   - lee `empleados` de Mega Talento en sólo lectura;
   - por cada ficha `(sitio, código)`: si su enrolamiento ya tiene persona, la reusa (idempotente); si
     no, busca una cuenta de la Suite con el **mismo nombre completo y el mismo almacén**; si hay
     exactamente una, la liga; si hay más de una, **no crea ni liga** y la manda a la lista de RH;
     si no hay ninguna, crea la persona (`kind='interno'`, `invited` si está activa, `terminated` si
     no —`activo` lo deriva el trigger de `status`—, sin contraseña, rol `sin_acceso`, departamento y
     puesto del mapeo; la promotora de marca siempre a `promotoria_marca`);
   - liga `hr.device_enrollments.user_id` de todos los relojes donde esa ficha está enrolada;
   - deja un **cuadre**: creadas, reusadas, ligadas a una cuenta existente, ambiguas, sin mapeo de
     departamento, posibles repetidas entre plazas (mismo nombre en dos sitios) y enrolamientos que
     siguen sin persona.
4. **Pre-vuelo**: la migración nueva entra a la cadena; el chequeo de padrón ya existe.
5. **Pruebas**: unitarias de las reglas (sin base) + contra Postgres local en una transacción que se
   deshace, con **prueba negativa** (sin la migración, una baja sin contraseña falla; con dos cuentas
   del mismo nombre, no se liga a ninguna).

**Lo que no hace:** unir fichas por nombre entre plazas, inventar puestos para quien no tiene
departamento, ni dar acceso a nadie. Lo que no se puede decidir con evidencia va a la lista de RH.

**Ensayo con datos reales (12-oct, base local, Mega Talento en sólo lectura, todo deshecho al final):**

| Cuadre | Cifra |
|---|---:|
| Fichas de Mega Talento | 1,057 |
| Personas creadas | 1,038 (470 activas como `invited`, 568 bajas como `terminated`) |
| Ligadas a una cuenta de la Suite que ya existía | 16 (corporativo y 8 Esquinas) |
| Por decidir (RH) | 3 (2 con dos cuentas del mismo nombre, 1 con nombre corto) |
| Promotoras de marca → `promotoria_marca` | 115 |
| Sin departamento en Mega Talento | 672 (activas + bajas; el doc de mapeos contó 164 activas) |
| Departamento sin mapeo | 1 («ZONA TEMPORAL») — «RECURSOS HUMANOS» se agregó a `rh` tras la primera corrida |
| Posibles repetidas entre plazas (mismo nombre, dos sitios) | 21 |
| Enrolamientos activos ligados | **988 de 1,004** (antes: 0) → el pre-vuelo pasa de BLOQUEA a AVISO |
| Sitios con almacén del mapeo | 11 (`reloj-196` sin almacén: duda abierta) |

⚠️ Las cuentas de la Suite de la base local son una copia; en prod el número de «ligadas a una cuenta
existente» puede variar un poco. El informe con nombres (las listas para RH) queda fuera del repo.

---

## 6. Cambios de Mega Talento después del port (para portar)

| Commit | Fecha | Qué | Portado |
|---|---|---|---|
| `091ea65`, `14c2b60` | 08-oct | Desayuno con una sola pausa = comida; la alerta junta repetidas | ✅ [RH.1.5b] |
| `3938723` | 08-oct | «PROMOTORIA MEGA DULCES» es piso; cambiar de departamento se refleja | ✅ [RH.1.5c] (lo de la ficha va con RH.1.4) |
| `64ae212` | 08-oct | Nadie a prenómina sin identificar · alta con el siguiente número libre | ✅ [RH.1.6b] el cierre (12-oct) · ⬜ el alta (va con la pantalla de personas) |
| `ee4ff38` | 08-oct | Banco de horas extra, desayuno/comida distintos, cambio de día de descanso, día con incidencia se mide sin checadas | ✅ [RH.1.10] (12-oct) |
| `1a28f6e` | 12-oct | Horas extra en la tabla semanal, PDF y Excel | ✅ [RH.1.10] (12-oct) |
| `8dd5521` | 13-oct | Semana fiscal elegible, incidencia Descanso, vacaciones respetan el descanso, HE usadas y saldo en tabla/PDF/Excel | 🧪 [RH.6.2] [RH.6.4] (09-nov) |
| `8396d3c` | 15-oct | Varios horarios por persona; la checada sin pareja ya no inventa comidas de horas | 🧪 [RH.6.1] [RH.6.3] (09-nov) |
| `31bc956` | 19-oct | Salud del bot con la bandeja de atorados | ⬜ [RH.12] |
| `331dccf` | 22-oct | Amonestación en todas las listas de incidencias | ✅ [RH.6.5] (ya lo hacía la Suite) |

## 6b. Inventario completo contra Mega Talento (2026-11-09)

El repo de Mega Talento (`IngeDavid2209/mega-talento-90`) se hizo público y se comparó pantalla por pantalla
contra `/rh/*`. **Ya portado:** checadas y reporte semanal, tolerancia, faltas, horas extra, incidencias y cierre,
relojes, candidatos (incl. no recontratables, spam, papelera), vacantes, revisiones (duplicados y reingresos),
`/empleo`, evaluaciones por liga y el bot. **Falta**, en este orden (lo que mueve prenómina primero):

| Bloque | Items | Pantallas de Mega Talento |
|---|---|---|
| Asistencia posterior al port | [RH.6] 🧪 | ver §6 |
| Personal | [RH.7] ⬜ | empleados (alta/baja), papelera de empleados, promotoras, cruces de plaza, ubicación de mi equipo, agente de horarios |
| Reclutamiento — tableros | [RH.8] ⬜ | dashboard/etapa, concentrado, kpi, novedades, destacados, en riesgo, contactados, historial, status-proceso |
| Reclutamiento — evaluación | [RH.9] ⬜ | guía y resultados de evaluación, análisis del bot, cv-armados |
| Retención | [RH.10] ⬜ | permanencia, encuestas de onboarding |
| Requisiciones | [RH.11] ⬜ | requisiciones, `/pedir-personal` (re-medir uso: el 6-oct tenían 0 filas) |
| Bot | [RH.12] ⬜ | salud del bot |
| **Bot — lo que manda solo** (añadido 11-nov: el inventario de pantallas no lo vio) | [RH.3.6] ⬜ | invitación y recordatorios de la prueba psicométrica (663 mensajes / 14 candidatos en 30 días), dictamen al reclutador (707), expediente completo (181), retomar postulación (40), invitación al proceso por plantilla (18) |
| No se porta | — | usuarios y login (los reemplaza la identidad de la Suite) |

Para revisarlo: `git log --since=<último port> -- api/src/agente-horarios api/src/cierres.ts api/src/checador.ts api/src/incidencias.ts`
en el repo de Mega Talento.

---

## 7. Riesgos vivos

| Riesgo | Qué hacer |
|---|---|
| RH no valida los mapeos a tiempo | La carga corre con la propuesta y marca cada persona como «no validado»; el corte puede ir con eso si RH lo acepta por escrito |
| Mega Talento sigue cambiando la lógica | Congelar del 31-oct al corte; anotar cada cambio en §6 |
| La asistencia depende de una laptop prendida (`LapSistemasA`) | Que no se apague ni salga de la red hasta RH.1.3 |
| Mergear la cadena frena todos los despliegues hasta aplicar sus migraciones | Aplicarlas el mismo día del merge |
| El rol `recursos_humanos` sin personas | Nadie de RH ve las pantallas hasta ocuparlo |
| La URL de la base compartida de Railway circuló con superusuario | Rotarla en RH.4.2 |

---

## 8. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-24 | **Sin franja de relojes → `[RH.18.14]`.** Sin la franja de relojes en Asistencia (David, 2026-11-24: «quita esto»). El chip «Sin señal» lo dice y abre Relojes, donde está el detalle de cada equipo; el componente de la franja sigue vivo dentro del panel de Relojes. Se fue también la entrada `franja` del marco (8 páginas dejaban de pasarla). ⚠️ Lo que se pierde: a quien administra relojes, la franja le avisaba de un reloj con la hora corrida aunque estuviera al día; el chip sólo mide la señal, así que eso ahora se ve abriendo Relojes. Vista RH 326/326. | Claude (sesión de David) |
| 2026-11-24 | **Sin «Capturar incidencia» en la cabecera → `[RH.18.13]`.** Sin «Capturar incidencia» en la cabecera de Asistencia (David, 2026-11-24: «si ya capturas desde la tabla, ¿no está de más?»). Se captura en la celda del día de la tabla (persona y día puestos, con «Hasta» para varios días); lo que la tabla no alcanza —un día de otra semana, el celular (la tabla muestra sólo totales), quien no ve Asistencia— sigue en el panel de Incidencias, que trae su propio botón. El botón naranja sólo aparece cuando hay un paso que dar: «Cerrar semana». «Incidencias» se queda: es la bandeja (calificar, ver, cerrar). Páginas RH 120/120, mutante en rojo. Sin commit. | Claude (sesión de David) |
| 2026-11-24 | **La ficha corta → `[RH.18.12]`.** La ficha queda corta (David, 2026-11-24: «esto quítalo»): salen el registro para la autoridad, el PDF para firmar y «Firmas de su asistencia»; se queda «Ver solo a esta persona», que ya traía el registro y el PDF y ahora también sus firmas (antes sólo existían en la ficha; las firmas por semana siguen en el panel de Incidencias). Vista de la página 48/48, mutante en rojo. Sin commit. | Claude (sesión de David) |
| 2026-11-24 | **La cabecera más simple → `[RH.18.11]`** y **la ficha sin la semana día por día → `[RH.18.10]`.** La cabecera de Asistencia, más simple (David, 2026-11-24: «lo quiero más simple»; eligió el tablero 3 de la maqueta). De 7 franjas antes de la tabla a 3: (1) un renglón con Asistencia, la plaza, la semana (‹ › y calendario) y «Hoy» como botón de texto que prende y apaga el día de hoy, el chip del reloj (abre Relojes), y a la derecha buscar, Incidencias, el paso que toca y «⋯» con Relojes y Actualizar; (2) las pestañas; (3) Semana · Faltas · Tolerancia con «3 personas · se puede cerrar desde el jue 26 nov · 4 nombres por confirmar Corregir» y, a la derecha, «Filtros» (globo con Personas y Planta/Promotoras, con el número de filtros puestos), Horario y PDF para firmar. Se van «Esta semana» y «Semana pasada» (lo hacen las flechas) y «rebasada» del modo Tolerancia. Se quedan como estaban: el aviso de la semana que terminó sin cerrar (no se esconde en una línea gris), la franja de relojes para quien los administra cuando un reloj falla, y el calendario. Vista RH 326/326, dos mutantes en rojo. Sin commit. | Claude (sesión de David) |
| 2026-11-23 | **`[RH.14.2]` y `uso-mega-talento.js` NO se corren** (decisión de David): no se cambia prod con prisa ni se toca lo que ya funciona. Se consideraron y descartaron: correrlo él en `md` (cambia el pod de la API y ~300 nombres con fecha encima), correrlo desde la laptop (sacaría de `md` la conexión de Mega Talento) y pedir que la base se borre más tarde o un `pg_dump` privado. Consecuencia si la base se borra el 24-nov: los 292 nombres cortos se completan a mano con `[RH.14.4]` y la evidencia de uso del §6c se pierde (se decidirá preguntando a RH). Los guiones quedan en `main` | David |
| 2026-11-23 | **La captura en un solo lugar → `[RH.18.9]`.** La incidencia se levanta en UN solo lugar: la celda del día en la tabla de la semana (David, 2026-11-23: «ya tenemos lo de las incidencias en otro lado»). Salen de la ficha y de «solo esta persona» la columna «+ Incidencia» y el botón «Capturar incidencia»; la tabla de días se queda (desayuno, comida, vs. horario, registro para la autoridad). Se quitó el código que sólo servía a esa captura. El «Capturar incidencia» del encabezado de Asistencia (el panel, para cualquier persona o varios días) se queda. ⚠️ En celular la tabla muestra sólo totales: desde el teléfono ya no se captura. Vista RH 325/325. | Claude (sesión de David) |
| 2026-11-23 | **La semana en rejilla y la captura pulida → `[RH.18.5]`–`[RH.18.8]`.** Horario oculto con «Mostrar horario»; «todo en uno» en la captura; la tabla en rejilla con la incidencia como bloque por grupo, las por calificar punteadas, la falta como bloque, totales por día y destello al guardar; el aviso del reloj sin franja roja y los rojos apagados. Lo de las pruebas y lo no medido, en el tracker. | Claude (sesión de David) |
| 2026-11-23 | **«Muy tedioso, mucho clic» → `[RH.18.4]`.** RH dijo que levantar una incidencia era «muy tedioso, mucho clic» (2026-11-23). Ahora, en la tabla de la semana, tocar la celda del día abre la captura en un globo sobre esa celda (persona y día puestos), sin salir de la tabla; el nombre, la clave y el horario siguen abriendo la ficha, y sin permiso de capturar la celda hace lo de siempre. Y la propuesta A en toda captura con día: botones con el nombre que usan (Personal · Cita médica · No registrada · Tráfico) y «Otro tipo…» para los 19; «Tráfico» trae «Tráfico» de motivo y «quién lo autorizó» recuerda el último (sólo en ese navegador). «Personal» desde la tabla: 3 clics (celda, botón, Guardar), antes ≈7 en producción. Vista RH 323/323, mutantes en rojo. Sin commit. **Siguiente palanca si sigue lento:** captura por lote (varias personas o días), según qué levantan más y cuántas al día. | Claude (sesión de David) |
| 2026-11-23 | **D1 contestada por RH → `[RH.18.3]`.** RH contestó la D1 (2026-11-23): «Tráfico» → Horario distinto (o Otros) · «Cita médica» → Incapacidad · «Personal» → Permiso sin goce · «No registrada» (vino y no checó) → Otros; «según el caso cambia, pero ésas son las más frecuentes»; y el tipo no debe venir elegido: «prefieren elegirlo ellas». La captura ya no preelige el tipo (tampoco el panel), Guardar espera al tipo, el orden por día usa esas respuestas y cada tipo muestra su nombre de Mega Talento (se encuentra tecleándolo). Vista RH 315/315, mutantes en rojo. **Por confirmar con RH:** «cita médica» sin papel del IMSS (¿permiso en vez de incapacidad?) y la «d» de tráfico. Sin commit. | Claude (sesión de David) |
| 2026-11-23 | **E1 y E2: lo que RH extrañaba de Mega Talento en incidencias (`[RH.18.1]`, `[RH.18.2]`).** E1: «+ Incidencia» abre la captura debajo del día, en la misma ficha (antes la cerraba y abría el panel en «Vacaciones» pidiendo el número), con el tipo más probable del día ya elegido y «Horario distinto» propuesto con lo que checó; también en «solo esta persona». La captura salió del panel a una sola pieza que usan los dos. E2: con acceso a la Suite, la ficha dice que departamento, puesto y sucursal los cambia Sistemas en Administración › Personas (antes desaparecían). Sin cambios de API, base ni permisos. Vista RH 330/330, mutantes en rojo, `check:pantalla` sin fallas nuevas. **Pendiente:** probarlo con RH (D2 de David: «lo vamos a probar, tú, ellas y yo»), D1 de RH (nombres de Mega Talento ↔ tipos), validación visual, commit. E3 (alta automática) espera la D3 de Edgar. | Claude (sesión de David) |
| 2026-11-23 | **RH.15/RH.16 recortados a lo necesario: de 8 migraciones a 2** (David: «¿realmente son necesarias?»). Ninguna estaba en prod ni en la base local, así que se fusionaron: `20261117103955` = checadas como evidencia + desfase (RH.15.1 + RH.15.4) y `20261117105402` = firma de la semana en papel y por QR (RH.15.5 + RH.15.11). **Salieron del código** (sólo en el respaldo `Documents/respaldos-git/2026-11-23/antes-de-recortar-a-2-migraciones/`): aviso de privacidad RH.15.6 (duplicaba `servicedesk.privacy_*`, que ya está en prod; cuando Legal entregue el texto se extiende ése), expediente RH.16.1 (sin fila ni tarjeta; lo pide `[MDT.5.8]`), carta poder y sobres RH.16.2/16.3 (pospuestos, P1). Las firmas por QR siguen visibles en la ficha de la persona. Ninguna de las 8 servía al foco de RH (horarios e incidencias). Verificado: `tsc` api/view y `ngc` 0 errores; RH.15 11/11 contra el Postgres local; migración de checadas 11/11 con su negativa; vista RH 319, talent 257, authz 79 en verde. NO MEDIDO: 9 pruebas contra base ajenas a RH.15 (la base local está en la migración del 2026-09-08) y `test-newdb-rh15-checadas-inborrables.js` (pide `hr.attendance_sites`). Commits locales `c5264774e` (datos y API) y `6341c6339` (pantallas), sin push; fila `[RH.15]` en el tracker. Sin validación visual. | Claude (sesión de David) |
| 2026-11-20 | **Antes del borrado del 24-nov (app y base de Mega Talento, sin respaldo).** (1) `[RH.14.2]`: medido en prod (sólo lectura, 22:01Z) → **0** eventos `nombre_desde_mega_talento`: nunca se ha corrido; quedan 292 activos sin acceso con nombre corto, 10 con acceso y 510 bajas. Al guion se le agregó un **informe aparte** (nunca escribe) con el nombre de Mega Talento de las bajas y de quien tiene acceso; `--aplicar` no cambia. Controles 14/14, 3 mutantes en rojo. (2) Guion nuevo `database/scripts/rh/uso-mega-talento.js`: **sólo conteos** por tabla y columna (filas, con dato, última fecha, 30/90 días, valores de catálogo) para decidir qué del §6c se porta; no puede medir pantallas abiertas ni descargas. Controles 8/8, mutante en rojo, corrido contra base local. (3) El buscador de candidatos sin commit del repo de Mega Talento quedó respaldado fuera del repo. (4) `[RH.17.6]` el bot ya no promete escribirle al candidato (§6c B2). **Nada corrido en Mega Talento ni en prod; sin PR** (David: primero en local) | David + Claude |
| 2026-11-19 | `[RH.17.1]` «Hoy» de Reclutamiento, en **PR #561** (CI corriendo al abrirlo). Pestaña `/rh/reclutamiento/hoy`, a la que lleva el menú: 4 pendientes con verbo y la tarjeta uno por uno. Nace de la auditoría en prod del 18-nov (1,952 postulados en la entrada, «Atrasado» en 85/100, 0 rechazados, ~6 clics por llamada) y de un prototipo navegable que RH validó «tal cual». Medido el 19-nov 00:37 (prod, sólo lectura): 56 nuevos · **846 activos fuera de su meta** · 1,039 apartados (+30 días) → cuota de 20 por pendiente. Pruebas: regla 14 y servicio contra base local (las dos con negativa en rojo) · pantalla 11 · regresión 327 + 254 + 265 · `ngc`/`tsc --noEmit` 0 · `check:pantalla` 0 · `pre-push` 27 compuertas. NO MEDIDO: carga en prod, celular, oscuro, rol sólo-VER. Falta: CI, aceptación del PM, despliegue y prueba en prod con RH | RH (validó el prototipo) + Claude |

### `[RH.17.1]` — las capas

| Capa | Qué | Estado | Verificado contra / Prueba |
|---|---|---|---|
| C0 Dato | Lee `talent.candidates`, `candidate_events`, `candidate_stage_transitions` (sin tablas ni migraciones nuevas) | sin cambio | Universo = el de «Postulados» (`SQL_ES_POSTULACION`) |
| C1 Dominio | `libs/hr/src/lib/talent/logic/hoy.ts`: un candidato, un pendiente; >30 días sin movimiento = apartado; cuota 20 | 🧪 | `logic/hoy.spec.ts` 14/14, rota a propósito → 3 rojas |
| C2 API | `GET /hr/talent/today` (`HrTalentHoyService`), sólo lectura, VER o GESTIONAR | 🧪 | `talent-hoy.service.db.spec.ts` contra Postgres local con rollback; rota a propósito → rojo. RLS no ejercida (corre como `postgres`) |
| C3 Interfaz | `rh-reclutamiento-hoy.component.ts` + `hoy-formato.ts`; menú con `tabs` (`reclutamiento-tabs.ts`) | 🧪 | `hoy-formato.spec.ts` 11/11 · `ngc` 0 · `check:pantalla` 0 fallas. Sin validación visual en prod |
| C4 Plataforma | Sin migración ni variable nueva | ⬜ | Pendiente: CI, merge, despliegue, `/api/health` |

### Decisiones y bloqueos abiertos (`[RH.17]`)

| # | Qué | Dueño | Qué lo destraba |
|---|---|---|---|
| D1 | ¿La cuota de 20 por pendiente es la correcta? | RH | Que la usen una semana con la cuota y digan |
| D2 | «Nuevo» = postulado en las últimas 48 h sin contacto de RH | RH | Confirmarlo o pedir otra ventana |
| B1 | `[RH.17.2]` (ficha pulida) toca la ficha que otra sesión tiene con cambios sin commitear | quien tenga esos cambios | Que aterricen en `main` |
| B2 | `[RH.17.4]` (estados de vacantes) necesita una migración en `talent.job_postings` | PM | Autorizarla |

| Fecha | Item | Qué | Evidencia | Estado |
|---|---|---|---|---|
| 19-nov | **[RH.17.1]** | **El nombre del checador llega en cuanto cambia.** En `/rh/asistencia` salía «Empleado 109» para quien no está ligado a la Suite: el aviso de cada checada trae el número y no el nombre, y la lista de usuarios sólo viajaba con la lectura completa, que desde `[RH.1.3]` los relojes que avisan ya no hacen cada hora (sólo al arrancar el agente). Ahora el vigía (cada 30 s) lee **sólo la lista** y la manda cuando (a) cambia el número de usuarios del reloj o (b) checa un número que no venía en la última lista; si falla, reintenta a los 5 min. La API ya cambiaba «Empleado N» por el nombre real: no se toca | Medido en prod (sólo lectura, 19-nov 08:52): 11 personas que checaron en 14 días sin nombre; la última lista de 9 de 12 relojes es del 12-nov y coincide al minuto con su `last_backfill_at`. Prueba `libs/hr/.../agente-usuarios-al-momento.spec.ts` (7) con el `RelojJob` real; rota a propósito en los dos sentidos (disparador apagado: 5 rojas; siempre encendido: el control rojo). Lector completo: 47/47 | 🧪 — falta desplegar el lector (`desplegar-ingesta.sh`, con el commit que sirva la API) y medir en prod que los «Empleado N» con checadas recientes bajan a 0 |
| 19-nov | **[RH.17.2]** | **«Horario distinto» con el horario completo de UN día.** La incidencia ya era de un día, con porqué y quién autorizó, pero sólo guardaba la ENTRADA: un día de 8:00 a 14:00 se medía contra la salida de su horario permanente (4 h de «salida temprana»). Ahora lleva **salida y comida opcionales**: con salida, ese día se mide de la entrada a la salida capturadas (retardo, salida temprana, jornada esperada y horas extra contra lo mismo); sin salida, igual que antes. El horario permanente (`hr.person_schedules`, botón «Horario») no cambia. Migración `20261119093204` (dos columnas nullable con CHECK); la API las usa sólo si existen: antes de la migración nada se cae y una salida se rechaza diciendo por qué. Si además hay «Comida distinta» ese día, manda ésa | Prod (sólo lectura, 19-nov): HD sep 66 · oct 79 · nov 1; ninguna nota menciona la salida (el pedido es de RH, no de un patrón). Pruebas: lógica 13 casos (`horario-distinto-del-dia.spec.ts`, rota a propósito: 6 rojas), pantalla 21/21 (+3; rota: 1 roja), **contra base real** `horario-distinto-del-dia.db.spec.ts` con el cuerpo de la pantalla, antes y después de la migración (rota: 1 roja). ⚠️ Corregido en el camino: quedarse 1 h después de la salida de ese día SÍ gana 1 h extra (la regla de siempre) | 🧪 — falta aplicar la migración en prod (Edgar/PM, una por una) y desplegar |
