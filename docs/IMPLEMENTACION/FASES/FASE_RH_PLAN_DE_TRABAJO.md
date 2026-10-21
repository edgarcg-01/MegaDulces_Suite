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

---

## 1. Calendario

| Hito | Fecha | Estado |
|---|---|---|
| Preparación (RH.0) | hasta 9-oct | ⚠️ atrasada: faltan RH.0.2, RH.0.4, RH.0.5 y desplegar RH.0.6 |
| **Corte de asistencia** (RH.1.8) | **7-nov** (viernes) | En riesgo por RH.1.4 (personas) |
| Corte de reclutamiento + bot (RH.3.5) | 5-dic | Sin empezar (RH.2 y RH.3) |
| Mega Talento en sólo lectura | 5-dic → 18-dic | — |
| **Apagado de Mega Talento** (RH.4) | **18-dic** | — |

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
| [RH.3.5] **Corte** | Reclutamiento + bot juntos: carga única de candidatos, mensajes y documentos (al bucket privado); el webhook de Meta apunta a la Suite | **5-dic** |
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
| `8dd5521` | 13-oct | Incidencia «Descanso» (DSC), vacaciones respetan el descanso, «HE usó / HE saldo» en tabla, PDF y Excel, elegir semana | 🧪 [RH.1.15] (21-oct) · la lista de 52 semanas no: la Suite ya elige semana con flechas y atajos |
| `8396d3c` | 15-oct | Marca de en medio sin pareja = la que deja los descansos más cortos (no la última) · hasta 4 horarios por persona (`horarios_confirmados.horarios`) | 🧪 [RH.1.15] (21-oct) · mig `20261021090942` (`hr.person_schedules.shifts`) · paridad real NO MEDIDA |
| `31bc956`, `2b6d3b4` | 19-oct | Salud del bot (bandeja de atorados) · docs | ⬜ no es asistencia: va con el bot (`[RH.3.*]`) |

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
