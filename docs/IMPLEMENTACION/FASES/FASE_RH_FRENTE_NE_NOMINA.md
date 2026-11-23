# Fase RH · frente NE — La nómina sale del Access

> **Frente de la fase RH**, no una fase nueva. El tablero tiene 9 fases 🔨 contra un cupo de 4
> (medido 2026-11-23 con `node .claude/skills/pm/tablero.js`), y la nómina **es** RH: comparte el
> padrón, el reloj y el schema `hr.*` con [`FASE_RH_PLAN_DE_TRABAJO.md`](FASE_RH_PLAN_DE_TRABAJO.md).
> Por eso cuelga de RH y **no agrega fila al roadmap**.
>
> ⛔⛔ **Este repositorio es PÚBLICO.** La línea es clara: **nunca** importes de dinero, sueldos,
> nombres de personas, cuentas bancarias ni rutas de servidores. Conteos de cobertura y porcentajes
> sí, porque son los que hacen auditable el avance. El levantamiento completo, con las cifras de
> dinero y el mapa de las fuentes, vive en el **anexo privado** (`ANEXO_NE_LEVANTAMIENTO`, fuera del
> repo).

```
OBJETIVO: que la nómina deje de calcularse y entregarse en un Access de un servidor
          compartido, sin perder lo que ese sistema sí hace bien.
MÉTRICA:  personas de la nómina semanal ligables a un usuario de la Suite, sin ambigüedad
          HOY (2026-11-23, medido): 73.7 % ligables · 1.2 % liga con usuario inactivo
                                     25.1 % sin ningún candidato · 0 % ambiguo
          META: 100 % con llave propia (no por nombre) para el cierre de C0
CAPA TOPE: C0 (no se sube de capa hasta que el padrón tenga llave)
ÁREA:      RH
DUEÑO:     <por asignar — PM>
ESTADO:    ⬜
```

---

## 1. Qué problema resuelve

**El sistema de nómina ya existe y lleva 15 años funcionando.** No hay que construirlo: hay que
mudarlo. Medido el 2026-11-20 y el 2026-11-23 (detalle y cifras en el anexo privado):

1. **La nómina se calcula en un `.mdb` de Access de 285 MB** en un recurso compartido, que tres áreas
   abren a la vez. Serie continua desde 2011. Es el único módulo de esa base que sigue vivo: gastos,
   compras y ventas diarias dejaron de escribirse entre febrero y julio de 2026.
2. ⛔ **Las dos mitades del pago no comparten número.** El Access guarda un importe de banco **fijo
   por persona** (columna del catálogo, no se recalcula por semana) y entrega en efectivo «lo que
   falta»; lo que el banco dispersa de verdad es otra cifra, que varía cada semana. Se verificó con
   dos sucursales: **la cantidad de personas coincide exactamente, el importe no**. La diferencia
   entre ambas es dinero que sale —o deja de salir— en efectivo y **hoy nadie la cuadra**.
3. **La dispersión bancaria es un archivo de texto de ancho fijo**, uno por sucursal, armado cada
   semana y dejado en la raíz de una unidad compartida con nombres, cuentas e importes en claro.
4. **Nadie registra que la persona recibió su dinero.** El sobre se arma hasta el billete y cuadra,
   pero no hay acuse en ningún sistema. En el libro de efectivo de la Suite, la firma está llena en
   **1 de 76** renglones.
5. **La asistencia y la nómina nunca se tocan.** ⚠️ *Corregido el 2026-11-23: una versión anterior
   de este documento decía que los días y las horas se teclean recibo por recibo. **Es falso** y se
   midió: en la última semana cerrada, `HorasTrabajadas` vale 0 en **los 254 recibos** y los días
   están vacíos en 235. El sistema no usa días ni horas.* Lo que sí pasa: **82.7 % de los recibos
   son el catálogo tal cual**, sin un solo ajuste; sólo el 17.3 % lleva algo a mano (una cantidad
   de más, una de menos, horas extra). Y el **bono de asistencia lo cobran 154 de 155** personas que
   sí usan el reloj —o sea, en los hechos no es variable, es parte del sueldo—, mientras la Suite
   guarda **246,664 checadas** y resuelve la persona en el **99.8 %**. Cruzando ambos por primera
   vez aparecen **6 casos** que cobraron el bono con tres días de checada o menos. El hallazgo no son
   los 6: es que **nadie lo mira nunca**, porque los dos sistemas no se conocen.
6. **Una sola cuenta de usuario cierra todas las nóminas** desde septiembre de 2026.
7. **El respaldo es manual**: 36 copias desde 2016, pero la última dentro de la carpeta de respaldos
   es de **marzo de 2025**. No hay tarea programada. El riesgo no es que falte respaldo: es que la
   periodicidad depende de que alguien se acuerde.

**El cuello, medido:** el padrón de la nómina y el padrón de la Suite **no comparten llave**. La
Suite identifica a la persona por `(sitio, código del reloj)`; el Access, por un número propio de 4
dígitos. Hoy sólo se pueden unir **por el nombre escrito**, y así se liga el **73.7 %** sin
ambigüedad. `hr.employees` está **en 0 filas**, y ninguna tabla de `hr.*` ni de `identity.*` guarda
RFC, CURP ni NSS: ese dato sólo existe fuera de la Suite.

⚠️ **Corrección de la primera medición (mismo día).** El primer empate dio 69.9 % contando como
acierto a quien coincidía con **más de un** usuario. Un nombre que empata con varios **no es un
empate**. Resuelto el duplicado, el número real es **73.7 % ligable y 0 % ambiguo**: más alto y, esta
vez, sostenible. La ambigüedad no eran homónimos — eran **registros de usuario duplicados e
inactivos**: hay 158 nombres repetidos entre los usuarios con ficha de reloj y **ninguno** tiene dos
registros activos, así que basta preferir el activo.

**Dos hallazgos más de C0, del mismo corte:**

- **El centro del Access mezcla dos cosas distintas**: dónde trabaja la persona y a qué área
  pertenece. De los 34 centros con nómina, **17 corresponden a un sitio físico** del reloj (a veces
  varios al mismo: la sucursal, su área de telemarketing, su ruta directa y su staff) y **17 no son
  lugares sino áreas** (Finanzas, Sistemas, Contabilidad, Dirección, RRHH, Compras, Mantenimiento,
  Logística, promotoría y rutas), con 72 personas. La Suite ya separa las dos cosas —sitio del reloj
  por un lado, área por otro—, así que al migrar **esa columna se parte en dos**; no se copia.
- **Tres personas cobran en la nómina y su usuario de la Suite está inactivo.** No es ambigüedad:
  es una contradicción entre dos registros que hay que resolver a mano.

---

## 2. Qué NO incluye

- **No calcula impuestos ni timbra.** ContPAQi Nóminas es el sistema de registro fiscal (ADR-040,
  integrar y no construir). Este frente **no** lo reemplaza ni lo duplica.
- **No cambia cómo se le paga a nadie.** Qué parte va por banco y qué parte en efectivo es una
  decisión de Dirección; acá sólo se registra, se cuadra y se acusa lo que ya se decidió.
- **No migra el resto del Access.** Gastos, compras y ventas diarias ya están muertos ahí; se
  apagarán con la base, sin trabajo de migración.
- **No es un importer** (regla 1). El padrón no se copia: se le pone llave y se deriva.
- **No abre pantalla** hasta que C0 esté verificado.

---

## 3. Las capas

> ⭐⭐ **El orden del trabajo, los catorce patrones de diseño que no se repiten y los gates de cada
> etapa viven en [`FASE_RH_FRENTE_NE_DISENO.md`](FASE_RH_FRENTE_NE_DISENO.md).** Esta tabla es el
> detalle por item; ese documento es el porqué y el orden. Las tres reglas que mandan sobre todo lo
> demás: **nada se apaga hasta que su reemplazo corrió en paralelo y coincidió** · **no se migra lo
> que no se usa** · **no se reproduce el cálculo, se reproduce el registro**.

### C0 · Dato — la llave de la persona

⛔ **Nada de este frente sube de capa hasta que C0 cierre.** Sin llave, cualquier cálculo de nómina
estaría uniendo personas por su nombre escrito.

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| NE.0.1 | **Medir el padrón de la nómina**: universo, cobertura de RFC/CURP/NSS, y cuántos ya tienen ficha de reloj en la Suite | ✅ 2026-11-23 | Access ↔ `hr.device_enrollments` ↔ `identity.users`; cifras en el anexo privado |
| NE.0.2 | **Acceso de sólo lectura a ContPAQi Nóminas** (`contpaqi_nom`), acotado a las columnas no sensibles | ⬜ ⚠️ bloqueado | — |
| NE.0.3 | **De dónde sale el importe que se dispersa por banco**: cerrar la hipótesis de que es el neto oficial del periodo, persona por persona, una semana real | ⬜ | el archivo de dispersión de esa semana contra el neto de ContPAQi |
| NE.0.4 | **Llave de persona**: `hr.employees` poblada con `employee_code` propio + RFC/CURP/NSS, y ligada a `identity.users` y a la ficha del reloj | ⬜ ⚠️ espera a `[RH.1.4]` | el empate por nombre (73.7 %) como punto de partida; se cierra cuando no queda nadie sin llave |
| NE.0.5 | **Los que no se pudieron ligar**: 25.1 % sin ningún candidato (de ellos, 2 de cada 3 sí traen RFC) y 3 que ligan con un usuario **inactivo**. Uno por uno: alta pendiente, persona que no checa, o registro muerto | 🔨 lista lista | lista nominal en el anexo privado, para RH |
| NE.0.6 | **Partir el centro en dos**: sitio físico y área. Mapeo propuesto y medido: 17 de 34 centros caen en un sitio del reloj; los otros 17 (72 personas) son áreas, no lugares | 🔨 propuesta lista | `hr.attendance_sites` (12 sitios, ya con su almacén del ERP) + el área de `identity.users` |
| NE.0.7 | Vista `derive-no-copy` del histórico de la nómina del Access, **sólo lectura**, para no perder la serie desde 2011 al apagar la base | ⬜ | totales por semana contra el Access vivo |

### C1 · Dominio

| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| NE.1.1 | La aritmética del recibo como regla en `libs/`: lo que recibe la persona = lo que va por banco + lo que va en efectivo, con sus ajustes y su motivo | ⬜ | contra una semana real del Access, recibo por recibo, 0 diferencias |
| NE.1.2 | **El cuadre que hoy no existe**: lo que el Access supone que va por banco contra lo que el banco dispersó, por persona y semana; la diferencia se nombra, no se absorbe | ⬜ | una semana real; toda diferencia declarada, ninguna redondeada |
| NE.1.3 | El sobre al billete (denominaciones) como regla, con su cuadre contra lo exigible | ⬜ | contra las semanas ya armadas en el Access |
| NE.1.4 | **El cruce que hoy no existe: nómina contra reloj.** No es «derivar los días» —el Access no los usa—: es que por primera vez alguien compare lo que se pagó con lo que el reloj registró, y que las excepciones tengan dueño y respuesta | ⬜ | medido una vez (semana 46): 6 de 155 cobraron el bono de asistencia con ≤3 días de checada. ⛔ Quien no checa (Dirección, rutas, promotoría) queda fuera del universo, no «en falta» |

### C2 · API

| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| NE.2.1 | Consultar la nómina de una semana y su cuadre | ⬜ | no | |
| NE.2.2 | **Acuse de recibo**: registrar que la persona recibió su efectivo | ⬜ | **sí** | ⛔ obligatoria, con el payload de la pantalla |
| NE.2.3 | Generar el archivo de dispersión bancaria desde la Suite | ⬜ | no (produce archivo) | el archivo generado contra el de esa semana, byte a byte |

### C3 · UI

| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| NE.3.1 | Armado y entrega de la nómina en efectivo, con acuse | ⬜ | |
| NE.3.2 | El cuadre de la semana: banco, efectivo y la diferencia con nombre | ⬜ | |

⛔ Cargar la skill `diseno` **antes** de tocar el primer archivo. Permiso propio + entrada de sidebar. <500 ms.
⛔ **Antes del primer item C3:** sección «Observaciones de diseño UI — revisión del plan».
⛔ Esta pantalla muestra sueldos: su permiso se reparte **nominalmente**, no por puesto, y el cuadre
no se publica en ninguna pantalla general.

---

## 4. Decisiones (→ ADR)

| # | Decisión | ADR | Fecha |
|---|---|---|---|
| D1 | **Acceso a ContPAQi Nóminas**: qué rol y qué columnas. Sin esto, NE.0.3 no se puede medir y todo C1 queda sobre una hipótesis | — | ⬜ PM |
| D2 | **Cuál es la llave de la persona** en la Suite: `employee_code` propio, el código de ContPAQi, o el número del Access | — | ⬜ |
| D3 | **Calcular o sólo entregar.** **Recomendación reforzada por la medición: sólo entregar y acusar.** El Access casi no calcula — **82.7 % de los recibos son el catálogo tal cual**, sin un solo ajuste, y no usa días ni horas. Lo que de verdad hace es *registrar un pago y repartirlo en banco y efectivo*. Reproducir eso es chico; reproducir un motor de nómina es otra cosa, y ya existe en ContPAQi | — | ⬜ PM |
| D4 | **Qué es un acuse** aceptable para Dirección: firma en pantalla, huella del mismo reloj, o testigo | — | ⬜ PM |
| D5 | **Qué pasa con el archivo de dispersión** expuesto en la unidad compartida (decisión de hoy, independiente del proyecto) | — | ⬜ |
| D6 | **Qué es ContPAQi Nóminas respecto del Access**: quién manda cuando no coinciden | — | ⬜ |

---

## 5. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| ⚠️ **C0 entero** | PM | `contpaqi_nom` cerrado por permisos | D1: un GRANT de sólo lectura acotado |
| ⚠️ Sin llave de persona | RH | Dos padrones sin campo común | NE.0.4 + D2 |
| Padrón sucio | RH | Registros activos de gente que ya salió; centros escritos de varias formas | NE.0.5, NE.0.6 |
| `hr.employees` en 0 filas | RH (fase RH) | La carga de personas quedó 🧪 | Depende de la fase RH, **no de este frente** |
| El `.mdb` se corrompe antes de migrar | Sistemas | Base compartida, respaldo sin periodicidad | Respaldo programado mientras dure la migración |

---

## 6. Definición de Terminado

- [ ] 1. Métrica de la cabecera **remedida**, antes/después publicado
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA** (ADR-056)
- [ ] 3. Todo endpoint que escribe **ejercido contra base real** con el payload de la pantalla
- [ ] 4. Toda compuerta nueva **rota a propósito una vez**, rojo verificado
- [ ] 5. Todo primitivo genérico en `libs/` compartido **o** deuda con nombre en el tracker
- [ ] 6. Tracker + `03_LOG_REVISIONES.md` + roadmap de `CLAUDE.md` al día
- [ ] 7. **En prod**, o escrito por qué no y qué falta
- [ ] 8. **El Access de nómina apagado**, su histórico legible desde la Suite y su respaldo final guardado

---

## 7. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-20 | Levantamiento: se encontró que el sistema ya existe en Access y que las dos mitades del pago no comparten número. Documento **sacado del repo** por ser público | Claude |
| 2026-11-23 | Medido el padrón: universo de la nómina semanal, cobertura de RFC/CURP/NSS, y confirmado que los dos padrones **no comparten llave**. Frente abierto como parte de RH (cupo: 9 🔨 contra 4) | Claude |
| 2026-11-23 | Empate rehecho y **métrica corregida de 69.9 % a 73.7 %**: el primer número contaba como acierto a quien coincidía con más de un usuario. La ambigüedad eran registros duplicados e inactivos, no homónimos; preferir el activo la lleva a 0 %. Quedan **65 sin candidato** y **3 con usuario inactivo** como lista de trabajo de RH | Claude |
| 2026-11-23 | Medido el catálogo de centros: **17 de 34 son sitios físicos, 17 son áreas**. Conclusión de diseño: la columna se parte en dos al migrar, no se copia | Claude |
| 2026-11-23 | ⚠️ **Corregida una afirmación falsa de este documento**: no es cierto que los días y las horas se tecleen recibo por recibo — `HorasTrabajadas` vale 0 en los 254 recibos de la semana y los días están vacíos en 235. Medido en su lugar: **82.7 % de los recibos son el catálogo tal cual** y el bono de asistencia lo cobran **154 de 155**. Refuerza D3: lo que el Access hace es registrar y repartir un pago, no calcularlo | Claude |

---

## 8. `[NE.0.6]` El centro partido en dos — lo que RH tiene que confirmar

**Medido el 2026-11-23** (sólo lectura). Universo: la última semana cerrada, **254 personas en 34
centros**; 204 (80.3 %) ligan con un usuario de la Suite.

⛔ **No se crea ningún catálogo nuevo:** la Suite ya tiene los dos ejes —`hr.attendance_sites` (12
sitios) e `identity.departments` (22 áreas)— y el texto `Sucursal` del sistema viejo resultó ser
**sitio × área pegados**.

### 8.1 El sitio SE DERIVA; el área NO

⭐ **Sitio:** mirando dónde checa de verdad la gente de cada centro, **30 de 34 centros** resuelven
su sitio, casi todos con **100 % de consenso**, cubriendo **248 de 254 personas**. Eso es una
medición contra un hecho independiente, no una opinión.

⛔ **Área:** el campo `department_code` de la Suite y el sufijo del nombre del centro coinciden en
**21 de 28** casos comparables (**75 %**, contra **4.8 %** que daría el azar entre las 21 áreas en
uso). Miden lo mismo —por eso coinciden tanto— **pero se contradicen en 1 de cada 4**, así que
ninguno de los dos manda solo. ⚠️ `department_code` está lleno en **204 de 284 usuarios activos
(71.8 %)**, no en el 16 % que sugiere el padrón completo (ése arrastra 983 registros muertos).

### 8.2 ⛔⛔ La mitad de los «enlaces» eran a usuarios MUERTOS

Al mirar de cerca a la gente sin área apareció lo que la tapaba: de las **204 personas ligadas a un
usuario de la Suite, 106 (52 %) ligan con un usuario INACTIVO** — los 106 con `role_name =
`sin_acceso`` y **ninguno** con área. No son usuarios de la Suite: son fichas que sólo cargan a una
persona.

⭐ **De los 98 que ligan con un usuario ACTIVO, 96 (98 %) SÍ tienen área.** El campo nunca estuvo
vacío: lo que contaba mal era mezclar registros vivos con muertos — el mismo defecto que
`[NE.0.10]` ya había medido en el padrón del sistema viejo («activo» no significa nada).

### 8.3 ⭐⭐ Los que no tienen área son los PROMOTORES, y la Suite ya tiene su área

| señal | medido |
|---|---:|
| usuarios activos sin `department_code` | **80** |
| de esos, con `role_name = 'promotor'` | **79** |
| perfiles del reloj con `is_promoter = true` | **117** |
| de esos 117, cuántos tienen `department_code` | **0** |

El departamento **`promotoria_marca` ya existe** en `identity.departments` (alta del 2026-10-12) y
**nunca se le asignó a nadie**. ⭐ Una sola regla —*`is_promoter` ⇒ `promotoria_marca`*— cierra el
hueco más grande, y no es una suposición: es el único grupo del padrón con **cero** áreas asignadas
y con una bandera propia que lo identifica.

### 8.4 El puente que faltaba entre los tres registros

`hr.person_site_profiles` (1,087 filas) guarda `site_code` + `person_code` + **`report_section`**, y
se liga con el usuario por **`hr.device_enrollments.device_user_id = person_site_profiles.person_code`**
→ **1,049 usuarios**. ⚠️ La columna `device_enrollments.person_code` **no sirve** para esto: está
llena en 38 de 1,267.

Con ese puente, la cobertura del área sobre las 204 ligadas:

| fuente | cubre |
|---|---:|
| `identity.users.department_code` | 96 |
| `report_section` del reloj | 162 |
| ⭐ **una u otra** | **202 (99.0 %)** |
| sin ninguna | 2 |

### 8.5 ⚠️ Pero ninguna de las cuatro fuentes manda: se contradicen entre sí

| fuente del área | concuerda con `department_code` | azar |
|---|---:|---:|
| el sufijo del **nombre del centro** | 21 de 28 (**75.0 %**) | 4.8 % |
| el **`report_section`** del reloj | 17 de 28 (**60.7 %**) | 4.7 % |
| el **`role_name`** del usuario | 53 de 116 (**45.7 %**) | — |

Las tres miden lo mismo —por eso le ganan tanto al azar— **y las tres discrepan**. Ejemplos medidos:
el reloj dice `FINANZAS` donde la Suite dice `credito_cobranza`, `tesoreria`, `prevencion_auditoria`
y `cajas`; el rol dice `cajero` donde la Suite dice `tienda`.

⛔ Y **`report_section` arrastra el mismo defecto que estamos arreglando**: mezcla sitio y área en un
solo texto (`CEDIS`, `YURECUARO`, `SUC.PADRE HIDALGO` son **lugares**; `MERCADOTECNIA`, `COMPRAS`,
`TELEMARKETING` son **áreas**). No se puede adoptar tal cual: hay que partirlo, igual que al de
nómina.

→ **Conclusión que no cambia:** el área se **decide**, no se deriva. Lo que sí cambió es que ahora
hay una regla que resuelve el bloque más grande sin preguntar, y la lista de lo que queda es corta.

### 8.6 Decisiones ya tomadas

| qué | quién y cuándo | dónde vive |
|---|---|---|
| `Morelia Vecinal` es **ruta vecinal** (no `ruta_directa`, como decía la Suite en 3 personas) | **Edgar, 2026-11-23** | `AREAS_CONFIRMADAS` en `centro.ts` |
| `Marcadotecnia` y `Mercadotecnia` son **el mismo centro** | **Edgar, 2026-11-23** | `ALIAS_DECLARADOS` en `centro.ts` |

### 8.7 Lo que todavía falta

| qué falta | centros / personas |
|---|---|
| **sitio sin derivar** (nadie de ahí checa) | Direccion (3) · RD Zamora (1) · Morelia TLMK (1) · Promotoria Morelia (1) |
| **consenso de sitio flojo** | PHidalgo Staff (67 %) · Compras (50 %) |
| **área sin ninguna fuente** | 2 personas |
| **aplicar la regla del promotor** en prod | 117 perfiles |

⚠️ **NO MEDIDO:** si los 50 sin candidato en la Suite cambiarían alguna mayoría de centro; si los
106 inactivos deberían reactivarse o migrar a `hr.employees` (hoy en 0 filas).
