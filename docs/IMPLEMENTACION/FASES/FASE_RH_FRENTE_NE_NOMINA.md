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
| NE.0.2 | **Acceso de sólo lectura a ContPAQi Nóminas**, acotado a las columnas no sensibles | ✅ 2026-11-23 — **ya existía** | las dos vistas de `contpaqi_ods` (287,994 filas, sólo hashes) las lee `app_runtime`; `contpaqi_nom` sigue cerrado (§10) |
| NE.0.3 | **De dónde sale el importe que se dispersa por banco**: cerrar la hipótesis de que es el neto oficial del periodo, persona por persona, una semana real | ⬜ | el archivo de dispersión de esa semana contra el neto de ContPAQi |
| NE.0.4 | **Llave de persona**: `hr.employees` poblada con `employee_code` propio + RFC/CURP/NSS, y ligada a `identity.users` y a la ficha del reloj | ⬜ ⚠️ espera a `[RH.1.4]` | el empate por nombre (73.7 %) como punto de partida; se cierra cuando no queda nadie sin llave |
| NE.0.5 | **Los que no se pudieron ligar**: 25.1 % sin ningún candidato (de ellos, 2 de cada 3 sí traen RFC) y 3 que ligan con un usuario **inactivo**. Uno por uno: alta pendiente, persona que no checa, o registro muerto | 🔨 lista lista | lista nominal en el anexo privado, para RH |
| NE.0.6 | **Partir el centro en dos**: sitio físico y área. Mapeo propuesto y medido: 17 de 34 centros caen en un sitio del reloj; los otros 17 (72 personas) son áreas, no lugares | 🔨 propuesta lista | `hr.attendance_sites` (12 sitios, ya con su almacén del ERP) + el área de `identity.users` |
| NE.0.7 | **Conservar la serie desde 2011** al apagar el Access: 159,068 recibos en 819 semanas, como snapshot **congelado** con su suma de control por semana. ⛔ NO puede ser una vista `derive-no-copy` — la serie no está en Kepler ni en Postgres (§9) | 🔨 diseño medido | las 819 semanas contra el Access vivo, y `contpaqi_ods` como testigo independiente del 74.8 % |

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

### 8.3 Los que no tienen área son los PROMOTORES — pero casi ninguno cobra en la nómina

⚠️ **Corregido el mismo día, antes de escribir nada en prod.** La primera lectura decía que una
regla *`is_promoter` ⇒ `promotoria_marca`* cerraba el hueco más grande. **Falso**, y por dos razones
distintas que sólo aparecen al contar bien:

| regla candidata | usuarios que tocaría | **de esos, ACTIVOS** |
|---|---:|---:|
| `is_promoter` del perfil del reloj | 117 | **0** |
| `role_name = 'promotor'` | 79 | **79** |
| ambas a la vez | — | **0** |

⛔ **Son conjuntos DISJUNTOS.** Los 117 del reloj son todos usuarios muertos; la regla que toca
gente viva es la del **rol**, no la de la bandera.

⭐ **El control de la regla del rol sale limpio:** de todos los usuarios sin área sólo hay tres
grupos — `sin_acceso` (982, **0 activos**), `promotor` (79, **todos activos**) y `servicio` (1).
Barre exactamente a los promotores y a nadie más.

⛔⛔ **Pero la regla NO se puede aplicar, por dos cosas medidas:**

1. **No hay testigo de cuál es su área.** Nadie con rol `promotor` tiene departamento, y
   `promotoria_marca` **no lo tiene NADIE** (alta del 2026-10-12, cero usuarios). El único indicio
   en los datos apunta al revés: el rol hermano `promotor_ruta` está mapeado a **`ruta_directa`**
   (16 activos) y **`ruta_vecinal`** (1), no a `promotoria_marca`.
2. **Casi no son gente de la nómina.** De los **79 promotores activos, sólo 2 aparecen** en la
   semana de nómina, los dos en el centro `Promotoras`. El resto cobra fuera de la nómina semanal,
   igual que las vecinales.

→ **Consecuencia para este frente:** el hueco de área de los promotores es un problema de calidad de
datos de la Suite, **no un bloqueo de `[NE.0.6]`**. Sobre el universo que importa —las 254 personas
de la nómina— el faltante de área es de **2 personas**, no de 27.

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

### 8.7 Lo que todavía falta, sobre el universo que importa

| qué falta | centros / personas | de quién depende |
|---|---|---|
| **sitio sin derivar** (nadie de ahí checa) | Direccion (3) · RD Zamora (1) · Morelia TLMK (1) · Promotoria Morelia (1) | RH |
| **consenso de sitio flojo** | PHidalgo Staff (67 %) · Compras (50 %) | RH |
| **área sin ninguna fuente** | **2 personas** | RH |
| **confirmar el área propuesta** de los centros con sufijo (TLMK · RD · Staff) | — | RH |

⛔ **Ya NO está en esta lista** la «regla del promotor»: medido, tocaría a 79 usuarios activos de los
cuales **sólo 2 están en la nómina**, y no hay testigo de cuál es su área (§8.3). Es deuda de
calidad de datos de la Suite, con dueño distinto.

⚠️ **NO MEDIDO:** si los 50 sin candidato en la Suite cambiarían alguna mayoría de centro; si los
106 inactivos ligados deberían reactivarse o migrar a `hr.employees` (hoy en 0 filas); cuál es el
área real de los 79 promotores.

---

## 9. `[NE.0.7]` La serie desde 2011 — qué se conserva, y lo que la medición cambió del plan

**Medido el 2026-11-23**, sólo lectura sobre el `.mdb` vivo y sobre prod (`system_identifier`
verificado). Las cifras de dinero van al **anexo privado**: este documento es público.

### 9.1 ⛔ La línea del tracker estaba mal: esto no puede ser una vista `derive-no-copy`

`derive-no-copy` es una **vista sobre `kepler_ods`**. Esta serie no está en Kepler ni en Postgres:
vive en un `.mdb` de un servidor que se va a apagar. **No hay de qué derivar.** La regla 1 contempla
el caso —tabla real **sólo** para datos propios o **snapshots**—, y un sistema que se retira es
exactamente eso. Tampoco choca con «ningún cron, ningún importer»: **corre una vez, a mano, y la
tabla queda congelada**; ningún proceso la vuelve a escribir.

### 9.2 Lo que hay

**159,068 recibos, 819 semanas, del 2011-02-11 al 2026-11-13.**

- **721 de las 819 semanas caen en viernes** (92 en sábado, 6 en otros días)
- mediana de **223 recibos por semana** (mínimo 5, máximo 317)
- **ninguna fila borrada**: `Eliminado` está en cero en los 159,068
- el `ID` del sistema viejo es **único** en los 159,068 → es la llave del recibo

### 9.3 ⭐ El histórico está CONGELADO — lo que hace legítima una sola pasada

| | |
|---|---|
| años con **cero** filas tocadas más de 60 días después de su semana | **14 de 16** |
| peor retraso en esos 14 años | 7 a 30 días |
| excepciones | **2015** (331 filas, 322 de ellas más de un año después) y **2020** (6 filas) |

337 de 159,068 filas (**0.21 %**) se tocaron tarde. Por eso el snapshot se puede sacar de una sola
pasada — y por eso igual lleva **su suma de control por semana**: es lo que permite probar, años
después, que la tabla congelada sigue diciendo lo que decía el Access.

### 9.4 ⚠️ Pero la serie NO es pareja: lo citable sin asterisco empieza en 2016

La llave *(semana, almacén, persona)* debería ser única y **se repite en 887 combinaciones**:

| era | llaves repetidas | recibos afectados |
|---|---:|---:|
| 2012 | 567 | **1,699 — el 42 % del año** |
| 2015 | 161 | 322 |
| 2011 | 90 | 180 |
| las 241 sin fecha | 41 | 230 |
| 2019 · 2020 · 2021 · 2023 | 28 en total | 56 |
| ⭐ **2016 · 2017 · 2018 · 2022 · 2024 · 2025 · 2026** | **0** | **0** |

⭐ Y las 322 de 2015 son **exactamente las mismas** que se tocaron más de un año después: 2015 se
volvió a capturar en diciembre de 2016. → **Se conserva todo**, pero la serie que se cita sin nota
arranca en **2016**.

### 9.5 Las 241 filas sin fecha son recibos reales, no basura

Están **pagadas y finalizadas**, y su fecha se recupera de `FinalizadaFecha`. ⛔ Un
`WHERE FechaRealNomina IS NOT NULL` las tiraría en silencio, y lo que se llevaría no es poca cosa
(monto en el anexo). La tabla las conserva con una bandera que declara que la fecha **se recuperó**.

### 9.6 ⭐⭐ Tres cuartas partes de la serie YA tienen testigo en producción

`contpaqi_ods.v_nomina_pago_periodo` ya existe en prod: **287,994 filas, del 2016-12-31 al
2026-11-18**, todas con `curp_hash` y **semanales** (276,158 pagadas en viernes). Misma cadencia que
el Access.

| tramo de la serie del Access | recibos | |
|---|---:|---|
| 2011-02 → 2016-12, más las 241 sin fecha | **40,071 (25.2 %)** | existe **sólo** en el Access |
| 2017 → 2026 | **118,997 (74.8 %)** | tiene un **testigo independiente** en prod |

⚠️ **El testigo lo es de la PERSONA y la SEMANA, no del importe:** los universos no coinciden
(ContPAQi cubre más gente y más conceptos que la nómina operativa semanal). La relación entre los
dos importes ya está medida y es otra —el sistema viejo trabaja en **bruto** y el banco dispersa el
**neto** de ContPAQi—; eso es `[NE.0.3]`, no esto.

⛔ **Consecuencia de diseño (regla 2 — no copiar lo que ya existe):** el **puesto** no se guarda
aquí. El recibo del Access no lo trae —`Puesto` vacío en **158,887 de 159,068 (99.9 %)**— y
`v_nomina_pago_periodo` sí trae `position` y `department`. El puesto histórico se **lee de ahí**.

### 9.7 La forma de la tabla

Una fila por recibo, en `hr.*`:

- **llave**: el `ID` del sistema viejo (único en los 159,068), con su origen declarado
- **la semana**, con bandera de si la fecha se recuperó de `FinalizadaFecha` (§9.5)
- **la persona** (`Numero`, lleno en el 100 %) y el **centro tal como se escribió** (`Almacen` 100 %;
  `Sucursal` falta en 177 — 0.11 %), más el **sitio y el área** que resuelve
  [`centro.ts`](../../../libs/hr/src/lib/nomina/centro.ts) en columnas aparte: el texto original no
  se pisa, y cada mitad llega con su procedencia
- **el dinero en centavos enteros** y el **sobre al billete**, denominación por denominación
- ⭐ **el renglón original completo como `jsonb`**: son 105 columnas, 35 de ellas vacías en la
  muestra, y varias cambian de tipo entre tablas hermanas (`DiasATrabajar` es texto en una y número
  en la otra). Lo medido va tipado; **lo demás se guarda crudo**, para que nadie tenga que volver a
  un `.mdb` apagado por una columna que no previmos
- una tabla hermana con **la suma de control por semana** (recibos y totales): es lo que hace
  verificable el congelamiento

**Peso:** del orden de 300 MB en crudo. En una base de 54 GB cuya tabla más grande pasa de 5 GB, no
es un problema de espacio.

### 9.8 El gate y su prueba negativa

- **Gate:** las **819 semanas** cuadran, recibo por recibo y peso por peso, contra el Access vivo —
  **cero diferencias**— y las 118,997 del tramo 2017→2026 encuentran a su persona en
  `contpaqi_ods` por `curp_hash`, con el faltante **declarado**, no rellenado.
- **Prueba negativa** (regla 12): alterar la suma de control de una semana sobre una copia y
  verificar que el gate se pone **rojo**. Sin ese rojo visto, el gate es una intención.

### 9.9 Lo que falta decidir

| decisión | de quién |
|---|---|
| **cuándo** corre la única pasada — es una escritura pesada, va fuera de horario hábil (regla 9) | Edgar |
| si 2011-2015 entra con su nota o queda fuera de lo citable (§9.4) | Edgar |
| **quién puede leer la serie**: trae el sueldo de cada persona con su nombre, 16 años hacia atrás | Edgar / RH |
| qué pasa con el **resto del `.mdb`** al apagarlo: 43 tablas —compras, gastos, ventas diarias, conciliación—, de las que este frente toca 6 | Edgar |

⚠️ **NO MEDIDO:** si `0 T Colaboradores` guarda algo histórico que el recibo no traiga (hoy parece
sólo el estado actual de cada persona); si las 1,336 marcas de `ID` que faltan en la secuencia son
bajas del sistema viejo o nunca existieron; cuánto del resto del `.mdb` tiene dueño en la Suite.

---

## 10. `[NE.0.2]` Ya no está bloqueado: la superficie segura de ContPAQi existe y la API la lee

**Medido el 2026-11-23** en pg-prod (`system_identifier` verificado), al diseñar `[NE.0.7]`.

El item estaba anotado como **⚠️ bloqueado**, esperando a que alguien con `postgres` corriera el
script de grants. **Ya se corrió**, y nadie lo anotó:

| | |
|---|---|
| `contpaqi_ods.v_nomina_pago_periodo` | **287,994 filas**, 2016-12-31 → 2026-11-18, semanal |
| `contpaqi_ods.v_nomina_empleado` | 1,736 personas |
| lo que exponen | `curp_hash` y `rfc_hash` —**md5, nunca la CURP ni el RFC en claro**—, periodo, días pagados, percepciones, deducciones, neto, `department` y `position` |
| quién puede leerlas | **`app_runtime` (la API), `dev_ro` y las cuentas personales** |
| `contpaqi_nom` (el schema crudo) | **sigue cerrado**: ni la API ni los devs tienen `USAGE` |

⛔ **Cómo se midió, porque el método importa:** `information_schema.role_table_grants` **no dice
quién puede leer** — ahí sólo aparecía `dev_ro`, y de ahí salió una primera lectura equivocada. Lo
que responde la pregunta es **`has_table_privilege('app_runtime', …, 'SELECT')`**, que resuelve
herencia y `PUBLIC`. El control negativo lo confirma: la misma consulta sobre la tabla **cruda**
`contpaqi_nom.add_nomina` devuelve «permission denied for schema» — la consulta sí distingue, y el
candado del schema sensible sigue puesto.

⚠️ **Y lo aplicado no era el archivo del repo.** Al comparar la vista desplegada contra
[`ops/prod/grants/ne02_contpaqi_nom_lectura_minima.sql`](../../../ops/prod/grants/ne02_contpaqi_nom_lectura_minima.sql):

| | en el repo | en producción |
|---|---:|---:|
| columnas de `v_nomina_pago_periodo` | 7 | **14** |
| llave de empate en esa vista | **ninguna** | `curp_hash` |
| desglose del CFDI (percepciones, otros pagos, deducciones) | el archivo prometía **no** exponerlo | **sí se expone** |
| los dos `COMMENT ON VIEW` | sí | **no llegaron** |
| `v_nomina_empleado` | 8 columnas | **idéntica** |

Dos consecuencias, las dos medidas:

1. ⛔ **El archivo ya no se podía volver a correr**: `CREATE OR REPLACE VIEW` no puede quitarle
   columnas a una vista existente, así que la versión de 7 columnas habría fallado contra prod.
2. ⭐ **Quien lo aplicó lo mejoró**: le puso la llave que faltaba, y la puso **por CURP** —que es la
   correcta: por RFC empatan 0 de 229, por CURP 217 de 238— no por el `rfc` de ContPAQi, que no es
   el RFC.

→ El archivo quedó **reescrito para decir exactamente lo que corre en prod**, con el aviso de que el
desglose del CFDI sí se expone. Un archivo de ops que describe algo distinto de lo que hay es peor
que no tenerlo: el que lo lea va a creerle.

→ **Qué destraba:** `[NE.0.3]` (de dónde sale el importe que se dispersa por banco) se puede medir
**y además llevar a producto**, porque la vista la lee la propia API. Lo que sigue necesitando
autorización es cualquier columna **fuera** de esas dos vistas.

---

## 11. `[NE.0.12]` El cálculo en sombra — y por qué la tesis del frente cambió

> Medido el **2026-11-24**: 8 semanas de nómina (25-sep a 13-nov), el Access vivo en sólo lectura y
> `pg-prod` en sólo lectura (`system_identifier` verificado). 2,222 recibos de 9 semanas, 38,527
> checadas de 353 personas, y la lógica de producción corrida tal cual sobre esos datos.
> ⛔ **Las cifras de dinero de esta sección viven en el anexo privado.** Acá van coberturas,
> porcentajes y separaciones, que es lo que hace auditable el avance.

### 11.0 ⭐⭐ La tesis que traía este frente era equivocada

Veníamos de «la Suite tendrá que calcular la nómina contra `/rh/asistencia`, y para eso hay que
cargar los horarios de toda la gente». **Las dos mitades resultaron falsas:**

1. **La Suite ya calcula.** `libs/hr/src/lib/attendance/logic/horario-deducido.ts` es lógica pura y
   completa: deduce el horario de cada quien desde sus propias checadas, distingue fijo de
   rotativo, resuelve el día de descanso, y mide el retardo con una bolsa semanal de tolerancia.
2. **No hay que cargar horarios.** La deducción los saca sola, y **mejor que a mano**.

Lo que falta no es dato, ni cálculo, ni pantalla: es **el acto de cerrar la semana** (§11.6).

### 11.1 El control que decidió todo: la deducción contra los horarios que RH sí cargó

`hr.person_schedules` tiene horario cargado a mano para **33** de las personas con checadas. Correr
`deducirHorario()` sobre esas mismas 33, a ciegas:

| | |
|---|---:|
| horarios reproducidos **exactos** (error 0 min) | **33 / 33** |
| mediana del error · peor error · sesgo | **0 · 0 · 0 min** |
| tipo que deduce | 31 fijo · 2 rotativo |
| personas con horario deducible, en total | **270 de 353** |

⭐ Un estimador propio, escrito antes de encontrar el módulo, llegaba a 27/33 exactos y 33/33 dentro
de 15 min. **El de producción gana.** Queda retirado: era un primitivo inventado (ADR-056).

### 11.2 La estructura del recibo, cerrada

La identidad cuadra en **los 2,222 recibos, peor diferencia 0.00**:

```
    PagoBanco + EfectivoAPagar  =  SueldoARecibir + TotalExtras
```

- `Despensa`, `Puntualidad`, `Asistencia` son **booleanos**; el monto vive en `…Total`. Contar la
  bandera da «todos cobran todo» y es falso de origen.
- Puntualidad y asistencia valen **exactamente 10 % del sueldo del propio recibo**, en los 2,020
  recibos con sueldo. **El 20 % del sueldo está condicionado en el papel.**
- La semana del recibo del viernes F es **sáb(F−6) … vie(F)**, probado contra el reloj sobre las 23
  personas con recibos parciales: **97.3 %** de acierto, contra 85.7 % de «pago vencido».
- Columnas muertas, para no confundirse: `HorasTrabajadas` = 0 en los 2,222 · `DiasATrabajar` sólo
  en 7.8 % · `SueldoBonus`, `Pagare`, `Alimentacion`, `Hospedaje`, `DescontarTotal` = 0 en todos.

### 11.3 La puntualidad SÍ se castiga; la asistencia NUNCA

El bono no se quita bajando el 10 %: se quita con un `CantidadDeMenos` cuyo **motivo está escrito a
mano**, y dice `PUNTUALIDAD`. **52 veces en 9 semanas, 26 personas.**

⛔ **Ningún motivo de descuento menciona una falta** — ni «falta», ni «inasistencia», ni «ausencia»
— en los 2,222 recibos. El bono de asistencia se paga íntegro siempre. **Es sueldo con otro
nombre, y condicionarlo es decisión de Dirección, no una mejora técnica.**

### 11.4 ⛔⛔ El primer resultado era falso y lo tumbó su control negativo

Un primer cálculo propio dio un número grande de «bono en riesgo». El control negativo lo mató:

| el reloj ve falta o retardo en… | |
|---|---:|
| las persona-semana que RH **castigó** | 60.6 % |
| las que RH **no** castigó | 62.1 % |
| **separación** | **−1.5 pp** |

Cero poder discriminante: ese instrumento no separaba a nadie. **El número se retiró.** Ver
`feedback_amount_match_needs_placebo_control` — un cruce sin su placebo no significa nada.

Dos defectos propios aparecieron al auditarlo, y los dos valen como trampa documentada:

- ⛔ **`hr.attendance_days` está granulada por dispositivo, no por persona.** La misma gente checa
  en varios relojes: 1,203 de 10,199 pares (persona, fecha) venían duplicados, y `first_punch_at`
  de una fila cualquiera es la entrada *en ese reloj*. Con el duplicado, el 100 % de los días salía
  «tarde» con mediana +159 min; agregando por persona, la mediana cae a **0 min**.
- ⛔ **`check_ins`/`check_outs` valen 0 en el 100 % de las filas** porque `attendance_logs.punch_type`
  viene NULL en las 38,527 checadas: el reloj no marca entrada vs salida. Un filtro sobre esas
  columnas devuelve **cero siempre** — parece un hecho y es un defecto de columna.

### 11.5 ⭐⭐ La lógica de producción SÍ reproduce el juicio de RH

Mismo cruce, con `analizarPersona()` de producción, sobre 1,066 persona-semana comparables:

| señal del sistema | castigados por RH | no castigados | separación |
|---|---:|---:|---:|
| ≥ 1 retardo | **100.0 %** | 40.9 % | **+59.1 pp** |
| ≥ 2 retardos | 90.9 % | 23.0 % | **+67.9 pp** |
| ≥ 3 retardos | 69.7 % | 15.1 % | +54.6 pp |
| ≥ 1 falta | ~~0 %~~ **12.1 %** | ~~0 %~~ **12.5 %** | **−0.4 pp** |

⭐ **Los 33 castigos caen dentro, sin una sola excepción**: el sistema nunca ve limpio a alguien a
quien RH castigó.

⛔ **La fila de faltas está corregida (ver §11.13):** el «0 % en los dos lados» que decía antes era un
**defecto mío**, no un hecho — le pasaba a la lógica sólo los días **con** checada, y sin los días
vacíos nunca hay faltas ni descansos. Con los días completos **sí hay faltas**, pero la conclusión
no cambia y ahora está bien medida: **la falta no separa nada (−0.4 pp)**. RH castiga por **retardo**,
no por faltar.

⚠️ **La regla se aplica 1 de cada 8 veces.** Las persona-semana que cumplen «≥2 retardos» son 268;
RH castigó 33. Eso es un problema de **equidad**, no de dinero.

⚠️ Alinear la bolsa semanal a la semana de pago (sábado) da **peor** (90.9 % contra 100 %): la
convención interna de **jueves→miércoles** se queda hasta que alguien decida lo contrario.

### 11.6 ⛔⛔ El cuello: `hr.attendance_closures` tiene CERO filas, desde siempre

`attendance_rules.config.soloDiasCerrados` está en `true`: **sin cierre, ninguna regla dispara**. Y
nadie ha cerrado una sola semana desde que existe la tabla.

**Nada se lo impide** — se revisaron las tres condiciones del endpoint, una por una:

| condición que bloquea el cierre | estado medido |
|---|---|
| incidencias en `capturada` sin calificar (no se puede saltar) | **0** — las 305 están calificadas |
| gente sin identificar que checó esa semana (409, forzable con motivo) | 22 códigos en 56 días = **0.8 %** de las checadas |
| la semana debe haber terminado | se cumple |

La pantalla **sí se usa**: 15 personas distintas en 60 días, entre ellas RH, Contabilidad y
Dirección; `closures` se consultó decenas de veces en la última semana. Entran, califican
incidencias con disciplina, y no dan el último paso.

⚠️ **Dos cosas sí están mal y son baratas de arreglar:**

- `HR_PERIOD_CLOSE` lo tienen **2 personas activas** para 9 sucursales. El rol
  `reclutamiento_asistencia` tiene el permiso y **cero** usuarios. → **regla 20**.
- El cierre corre **jueves→miércoles** y el recibo paga **sáb→vie**: no son la misma semana. Para
  que la prenómina alimente al recibo tienen que serlo, o hay que declarar el desfase.

### 11.7 El puente prenómina → recibo

La foto del cierre ya trae lo que el recibo captura a mano: `horasTrabajadas`, `faltas`,
`faltasJustificadas`, `retardoRealMin`, `horasExtraGanadasMin`, y —cumpliendo ADR-056— `usable`,
`bloqueadoPor` y `diasNoMedibles`.

| campo del recibo | hoy | cobertura del reloj |
|---|---|---:|
| `HorasTrabajadas` | **0 en los 2,222** | 52 % |
| `DiasATrabajar` | vacío en 92 % | 52 % |
| `HorasExtras` | a mano | 79 % |
| `CantidadDeMenos` motivo `PUNTUALIDAD` | a mano | 66 % |

⭐ **Control exacto de la unidad**: algunos recibos escriben el número de horas en el motivo
(«26 HORAS», «25 HRS»). Contra el reloj: **3 de 3 dentro de 10 %, 2 de 3 dentro de 5 %** — pero
**sólo si las horas se cuentan BRUTAS**, de la primera a la última marca, sin descontar comida.
Descontarla daba 5 h de menos por semana. ⚠️ **Muestra de 3**: alcanza para fijar la unidad, no
para dar el puente por probado.

### 11.8 Lo que NO se pudo medir — se declara, no se rellena

- **49 de 259** personas de la nómina no ligan con ningún usuario de la Suite (el puente sigue
  siendo el nombre escrito; ver §8). La gente **por horas** es justo la que menos liga.
- **83 de 353** personas no tienen horario deducible (checan una sola vez al día, o muy poco).
- El puente de horas está medido sobre **3 casos**.

⛔⛔ **Corregido el mismo día:** acá decía que «vacaciones, incapacidad y permiso no se registran en
ningún lado» y **es falso** — ver §11.12. Se registran, y en la Suite, no en el Access.

### 11.9 ⭐⭐ No hay nada que resolver: 78 de 88 semanas se cierran HOY

Simuladas en sólo lectura las **tres** condiciones del endpoint, para las 8 semanas de cierre
anteriores a la actual × los 11 sitios activos (medido 2026-11-24):

| | semanas-sitio |
|---|---:|
| **se cierran ya, sin tocar nada** | **78** |
| se cierran escribiendo el motivo (1 a 3 códigos sin identificar) | 10 |
| **bloqueadas de verdad** | **0** |

Las 10 que piden motivo son **casi todas la última semana**: gente recién enrolada que todavía no
se liga a un usuario. Resolver esos enrolamientos en `/rh/asistencia` —entre 1 y 3 por sitio—
deja las **88 en verde**.

⭐ **Esto cambia la forma de D3**: no hace falta preguntar «¿por qué no cierran?» en abstracto.
La pregunta es más corta y más útil: *acá están 78 semanas que se cierran con un clic — ¿qué hace
falta para cerrarlas?* Lo que se aprenda de esa respuesta es lo que de verdad falta.

### 11.10 Lo que falta decidir

| | decisión | de quién |
|---|---|---|
| **D1** | ¿La puntualidad se vuelve condicional **pareja**? Hoy la regla se aplica 1 de cada 8 veces | Dirección |
| **D2** | ¿La asistencia sigue siendo incondicional? (nunca se ha descontado) | Dirección |
| **D3** | **78 semanas-sitio se cierran hoy con un clic (§11.9): ¿qué hace falta para cerrarlas?** No hay obstáculo técnico | RH |
| **D4** | ¿El cierre se alinea a la semana de pago (sáb→vie) o el recibo al cierre (jue→mié)? | RH + Contabilidad |
| **D5** | ¿Se reparte `HR_PERIOD_CLOSE` a más gente, o se cierra centralizado? | RH |

### 11.11 Lo que sigue, en orden

1. **D3 antes que nada**: sin cierre, nada de lo demás cuenta. Es una pregunta, no código.
2. Repartir el permiso (D5) — **regla 20**.
3. Resolver el desfase de semana (D4) y recién entonces escribir el puente prenómina → recibo.
4. Registrar vacaciones / incapacidad / permiso: sin eso, toda ausencia justificada es una falta.
5. ⛔ **No** construir cálculo nuevo ni cargar horarios a mano.

### 11.12 ⛔⛔ Corrección: las ausencias SÍ se registran — y mi cálculo las ignoraba

§11.8 decía que vacaciones, incapacidad y permiso «no se registran en ningún lado». **Es falso en
las dos mitades**, y las dos importan:

- ⛔ **El Access NO las tiene.** `0 T Colaboradores Vaciones` devuelve **cero filas** para todo
  2026: esa tabla está muerta.
- ⭐⭐ **La Suite SÍ.** En la ventana medida, `hr.attendance_incidents` tiene **304 incidencias
  calificadas**, las 304 con su persona resuelta:

| tipo | incidencias | días |
|---|---:|---:|
| `horario_distinto` | 144 | 144 |
| `vacaciones` | 72 | 172 |
| `otros` | 25 | 97 |
| `horas_extra` | 24 | 25 |
| `descanso` | 23 | 24 |
| `permiso_con_goce` · `permiso_sin_goce` | 7 · 3 | 8 · 5 |
| `incapacidad` | 3 | 10 |
| `falta_injustificada` | **1** | 1 |

⭐ **En esto la Suite ya sabe MÁS que el Access**, y es el primer lugar del frente donde pasa. Y una
sola falta injustificada en dos meses, capturada por RH, concuerda con que el reloj no vea faltas.

**Mi corrida de §11.5 ignoró estas incidencias**, y eso **sobreestimaba el retardo**: los 144 días
con `horario_distinto` los juzgué contra el turno normal. Repetida como la hace la pantalla
—alimentando `horarioDelDia`, `laboralPorFecha` y los justificantes—:

| señal | sin incidencias (mal) | **con incidencias** |
|---|---:|---:|
| ≥1 retardo: castigados vs no | 100 % vs 40.9 % → +59.1 pp | **100 % vs 37.4 % → +62.6 pp** |
| ≥2 retardos: castigados vs no | 90.9 % vs 23.0 % → +67.9 pp | 87.9 % vs 21.4 % → +66.5 pp |
| persona-semana con ≥2 retardos | 268 | **250** (18 eran falsos) |

⭐ **La separación MEJORA y la sensibilidad se mantiene en 100 %.** Lo que RH captura a mano no es
burocracia: es el insumo que limpia el cálculo. Y refuerza §11.6 — el módulo se está operando con
disciplina; lo único que no se hace es cerrar.

→ **Baja el riesgo del frente:** el supuesto que estaba marcado como el más frágil no existe. Queda
uno menor y acotado: estas incidencias **sólo cubren a quien está enrolado en un reloj**, así que
para las 49 personas sin puente la ausencia justificada sigue sin verse.

### 11.13 El cruce de una semana real, y el tercer cero que era un defecto

#### ⛔ El defecto: sin los días vacíos no hay faltas

A `analizarPersona()` le estaba pasando **sólo los días con checada**. Los días sin marca no existían
para el cálculo, así que **nunca podía haber una falta ni un descanso**. De ahí el «0 % en los dos
lados» de §11.5. Pasándole el periodo completo —cada día entre la primera y la última checada de la
persona, con `marcas: []` donde no hubo—:

| | sin los días vacíos (mal) | **con el periodo completo** |
|---|---:|---:|
| persona-semana con ≥1 falta | 0 | **158** |
| ≥1 falta: castigados vs no castigados | 0 % vs 0 % | **12.1 % vs 12.5 % → −0.4 pp** |
| faltas que las incidencias justifican | — | **130 de 288 (45 %)** |

⭐ **La conclusión de §11.5 no cambia, y ahora está bien medida:** la falta **no separa nada**. Sí
hay faltas —158 persona-semana— y **ninguna tiene consecuencia en el recibo**. RH castiga por
**retardo**, no por faltar. El retardo sigue en **100 % vs 37.3 % (+62.7 pp)**.

⚠️ **Tercera vez en este frente que un cero perfecto resultó un defecto del instrumento** y no un
hecho del negocio (las otras dos, en §11.4). La regla práctica: **un cero redondo se audita antes de
publicarse**, siempre.

#### La prenómina de una semana real

Semana de nómina **sáb 07-nov → vie 13-nov**, la última completa, contra sus 254 recibos:

| | |
|---|---:|
| recibos de la semana | 254 |
| sin puente a un usuario de la Suite | 47 |
| con puente pero sin checadas esa semana | 55 |
| **con prenómina calculable** | **152 = 59.8 %** |

De esas 152: **147** tienen horario deducido (se les puede medir retardo), **114** con horario
marcado *confiable*, 114 fijos y 33 rotativos. La prenómina de la semana diría **648 días a tiempo ·
148 con retardo · 22 faltas · 167 descansos · 31 días con una sola marca** (a esos no se les puede
medir la jornada) y una mediana de **51.9 horas brutas** por persona.

Contra el recibo de esa misma semana: **38 personas con ≥2 retardos según el sistema**, y el recibo
le castigó la puntualidad a **8** — de las cuales 5 están entre esas 38. El **17 %** de los recibos
lleva algún ajuste a mano.

⛔ **El techo de hoy es el puente, no el cálculo**: 4 de cada 10 recibos no se pueden respaldar
porque la persona no liga con un usuario (47) o no checa (55). Por sucursal va de **88 %** (CEDIS) a
**13 %** (Logística) — las áreas cuya gente no usa reloj por su función quedan fuera, y eso **no es
una falla**: es que a esa gente no se le mide así.

#### Las 26 incidencias de tipo «otros» (el hueco que quedaba declarado)

Leídas una por una, **no son un cajón de sastre: son tipos que faltan o que no se usaron**:

| qué son | casos | ya existe su tipo |
|---|---:|---|
| **bajas** (una persona que dejó de trabajar) | 4 · **60 de los 97 días** | ⛔ no, y **no debería ser una incidencia de asistencia** |
| **comisión**: fue a otra sucursal, apoyo, capacitación, ruta | **9** | ⛔ **no existe — es el tipo que falta** |
| castigo / amonestación | 3 | sí (`amonestacion`) |
| permiso | 3 | sí (`permiso_con_goce` / `_sin_goce`) |
| descanso | 2 | sí (`descanso`) |
| falta injustificada | 1 | sí (`falta_injustificada`) |
| incapacidad y marca faltante | 2 | sí |

⭐ **Dos cosas concretas que arreglar:** un tipo **«comisión / trabajó en otra sede»** (9 de 26 casos,
y hoy se ven como ausencia), y sacar las **bajas** de aquí — una baja es un cambio de estado de la
persona, no una incidencia de un día.

⭐ **Y un control que salió redondo**, cruzando cada incidencia contra si la persona checó esos días:
`horario_distinto` **144 de 144 checó todos los días** (es un ajuste, no una ausencia) ·
`permiso_con_goce` 7/7, `permiso_sin_goce` 3/3 e `incapacidad` 3/3 **nunca checaron** ·
`vacaciones` 68 de 72. **Cada tipo se comporta como su nombre dice.**

⚠️ **NO MEDIDO:** `horas_extra` tiene **19 de 24** incidencias en días en que la persona **no checó**.
O se capturan con otra fecha, o son de gente que no usa reloj. Hay que entenderlo antes de usar
`horasExtraGanadasMin` para alimentar el recibo.

---

### 11.14 Los dos huecos que quedaban declarados

Al cerrar `[NE.0.12c]` quedaron dos cosas dichas como **NO MEDIDO**. Las dos se contestaron, y una
de ellas destapó un defecto de este mismo frente.

#### A. Qué son esas `horas_extra` sin checada — **contestado, y la primera respuesta era equivocada**

> ⛔⛔ **Corrección del 2026-11-24 (`[NE.0.14]`), el mismo día.** Este apartado afirmaba que
> `horas_extra` «carga dos cosas» y que las de ocho horas eran **un día trabajado mal etiquetado**.
> **Es falso.** `horas_extra` no significa «ganó horas extra»: es **«Uso de horas extra»** (código
> `HE`) — la persona **gasta** horas que tenía a favor en su banco
> ([`incidencias.ts`](../../../libs/hr/src/lib/attendance/logic/incidencias.ts)). Lo que se **gana**
> no sale de esta casilla: se **deduce del reloj**, quedándose después de la hora de salida, en
> bloques de 30 min ([`banco-horas-extra.ts`](../../../libs/hr/src/lib/attendance/logic/banco-horas-extra.ts)).
> Por eso `horasExtraGanadasMin` **nunca se alimentó de acá**, y la consecuencia que se escribió
> —«no puede alimentar el recibo»— se cae junto con su premisa.
>
> ⭐ El código ya lo decía, y no se leyó: *«El uso sale de las incidencias, no de los días armados:
> quien usó horas un día que no checó también las gastó.»*
>
> **Los hechos medidos no cambian; cambia lo que significan — y confirman el diseño en vez de
> contradecirlo.** Las dos tablas de abajo quedan como se midieron.

La pregunta era: `horas_extra` tenía 19 de 24 incidencias en días sin checada. Tres hipótesis se
podían separar con datos, y se separaron (los 25 días del rango, con control negativo sobre **todos**
los demás tipos):

| hipótesis | qué predecía | medido |
|---|---|---:|
| H1 la fecha es la de **captura**, no la del día trabajado | `created_at` ≈ `date_from` | **1 de 25** |
| H2 es gente **sin reloj** | 0 checadas en todo el periodo | **0 de 25** |
| ⭐ H3 **checó la semana, pero ese día no** | checadas alrededor, ninguna ese día | **20 de 25** |

Nadie de estos 25 días es de alguien que no checa: **los 25 tienen checadas en la ventana de ±6 días**
(entre 116 y 264 checadas cada persona en el periodo). Son empleados presentes, de los que falta
**un día**.

⭐ **Y el tamaño parte la tabla en dos, sin una sola excepción:**

| minutos de la incidencia | días | checó ese día |
|---|---:|---:|
| **≥ 300 min** (5 h o más: una **jornada**) | 12 | **0 — ninguno** |
| ≤ 180 min | 13 | 5 |

Los valores que existen son 30 · 120 · 180 · 300 · 330 · 480 · 510, todos múltiplos del bloque de
30 min con que se acredita el banco.

⭐ **Leído con la regla de dominio en la mano, el corte se explica solo y es el esperado: quien
gasta una jornada entera de su saldo se toma el día —y por eso no checa—; quien gasta un rato llega
tarde o se va temprano —y por eso sí checa—.** El corte en 300 minutos no es un defecto de captura:
es la diferencia entre tomarse el día y tomarse un rato.

**Lo que sí quedó en pie, y es real** (medido en prod, sólo lectura, 2026-11-24):

| hallazgo | medido |
|---|---|
| el universo | 25 usos de 12 personas, del 24-sep —el día en que arranca el banco— al 2-nov |
| ⛔ **ninguno lleva motivo ni quién autorizó** | **0 de 25**. El formulario no los pide para este tipo, mientras que `horario_distinto` y `visita_fuera` **sí exigen los dos**. Un movimiento que baja un saldo se captura sin decir por qué ni con permiso de quién |
| ⛔ **el pago de horas extra nunca se usó** | **0 registros** desde que existe el tipo (`[RH.6.7]`, 6-nov) |

⚠️ **NO MEDIDO, y es la única pregunta que queda viva:** si alguien **gastó más de lo que tenía**.
Es lo único que distingue un uso legítimo de usar la casilla para tapar un día. No hace falta
arqueología: el banco ya se muestra por persona con su saldo en `/rh/asistencia` — **si alguno de
esos 12 aparece en negativo, hay que mirarlo**. Es una pregunta para RH con instrumento, no un
hallazgo.

⭐⭐ **La lección vale más que el hallazgo: el nombre de una columna no es su significado.** La
medición estaba bien —25 filas, con control negativo sobre todos los demás tipos—; lo que estaba mal
fue **interpretarla antes de leer la regla de dominio**, que vivía a dos archivos de distancia. Una
casilla con valores de dos órdenes de magnitud *puede* estar cargando dos conceptos, o puede ser
exactamente lo que dice su etiqueta.

#### B. Por qué el puente es un empate por nombre — **contestado, y es un defecto nuestro**

El techo de §11.13 era el puente: 59.8 % de los recibos respaldables, porque la única forma de ligar
a una persona entre el sistema de nómina y la Suite es **el nombre escrito**. La pregunta era si
existe una llave dura. Se buscaron las tres candidatas:

| candidata | resultado |
|---|---|
| el número del **reloj** (`device_user_id`) | ⛔ no. De 385 números de reloj, 7 coinciden con un número de nómina — y el control negativo dice que **al azar acertaría el 6.5 %**: 7 de 385 es **1.8 %, por debajo del azar**. Sobre los ya puenteados por nombre: **0 de 210** coinciden |
| `person_code` del reloj | ⛔ no: 38 valores distintos, **0** coinciden |
| **CURP** (la llave que sí funcionó contra ContPAQi) | el padrón de nómina la trae; ⛔ **la Suite no guarda CURP en ningún lado** (`hr.*` ni `identity.*`) |

⭐ Así que el empate por nombre no es pereza: **hoy es lo único que hay**, y liga **210 de 259
(81.1 %)** del padrón de nómina. Por eso `matched_by` existe.

⛔ **Pero `hr.person_aliases` —la tabla que creamos ayer en `[NE.0.4]` justo para registrar esto— no
puede recibir ni una sola fila.** Su `employee_id` es NOT NULL contra `hr.employees`, y
`hr.employees` tiene **0 filas y `n_tup_ins = 0`: cero inserciones en toda su vida** (existe desde
el 2026-08-17). Su único camino de carga es `database/importers/checadores/link-employees.js`, **un
importer** — lo que la regla 1 prohíbe. No está esperando turno: no se va a llenar nunca.

⭐ **El padrón sí existe, en otro lado.** `[RH.1.4]` ✅ (aplicada en prod el 11-nov) cargó **1,038
personas a `identity.users`** y sus **1,087 fichas de plaza a `hr.person_site_profiles`**. El padrón
de personas de esta suite es `identity.users`, y la tabla `hr.employees` quedó vestigial.

⚠️ **El cero está AUDITADO, no supuesto** (la regla de §11.13, aplicada a sí misma): leyendo con un
rol **sin `bypassrls`**, las tablas vecinas del mismo schema y con la misma RLS forzada sí se
cuentan —`hr.device_enrollments` 2,180 · `hr.person_site_profiles` 1,087 · `identity.users` 1,267—,
y `n_tup_ins` lo cuenta el planificador, no la política: no hay filas escondidas detrás de un RLS.

→ **Corrección: migración `20261124120236_ne013_alias_apunta_al_padron_que_existe.js`.** La columna
pasa a `user_id` y el FK va por **`(tenant_id, user_id)`** contra `identity.users` —el único
compuesto existe, y así un alias no puede nombrar a alguien de otro tenant—. ⛔ `hr.employees`
**no se borra** (regla 5): retirarla es una decisión aparte. Lo demás de la tabla queda intacto.

⭐ **Medida contra un Postgres de verdad** (2026-11-24): `database/tests/test-newdb-ne013-alias-user-id.js`,
**28 ✔ · 0 ✖** en **PostgreSQL 18.4**; prod corre **18.6** (`system_identifier` verificado), misma
versión mayor. El ensayo aplica primero la migración de ayer, después ésta, y comprueba:

| qué | cómo |
|---|---|
| las posconditions | leídas **del catálogo** (`pg_constraint`, `pg_indexes`, `pg_policy`, `has_table_privilege`), no del texto de `pg_get_constraintdef` |
| que lo demás **no** se tocó | los 4 CHECKs, el único por `(system, external_code)`, la RLS forzada, la política de tenant y los permisos de `app_runtime` |
| ⭐ la negativa que el ensayo en seco **no podía dar** | un alias que nombra a una persona de **otro tenant** es rechazado (`23503`) |
| las otras negativas | un empate por nombre sin nota es rechazado (`23514`); `up` y `down` **paran** si la tabla trae filas; el guardia de destino **se niega** si lo apuntan a algo que parece prod |

⚠️ **Dos cosas que el rojo enseñó, y las dos eran el instrumento, no la migración:** la primera
versión comparaba el **texto** del constraint, que omite el esquema cuando la tabla está en el
`search_path` —habría dicho lo mismo apuntando a otra tabla llamada `users`—; la segunda comparaba
un arreglo que Postgres devuelve como texto crudo. *Todo instrumento arranca con un control cuya
respuesta ya se conoce*, y acá el control positivo fue el que avisó.

⛔ **El `npm run dev:up` de esta máquina no sirve**: Docker no arranca porque WSL2 no puede
(`HCS_E_HYPERV_NOT_INSTALLED` — la virtualización está apagada, y encenderla pide BIOS y reinicio).
Y aunque arrancara, su Postgres pide el puerto **5432, ocupado por el PostgreSQL 18 instalado en la
laptop**. El ensayo se hizo con un clúster desechable levantado con `initdb`/`pg_ctl` en otro
puerto: receta en el encabezado del test, 20 segundos y sin Docker.

⛔ **Una trampa de esa receta, pisada acá:** el scratchpad es por sesión, **el puerto no**. La
primera corrida eligió un puerto que ya tenía el clúster desechable de **otra sesión de Claude en
esta misma máquina**; `pg_ctl` falló *y* `psql` conectó igual, así que el ensayo corrió —verde— en
una base ajena. Se repitió sobre un clúster propio, confirmando antes que
`current_setting('data_directory')` cayera en esta sesión. **Si `pg_ctl` no arranca pero `psql`
contesta en ese puerto, el que contesta es de otro.**

**Falta** aplicarla en prod (una por una, `apply-one-migration-prod.js`), después de empujar.

#### Lo que esto cambia en el frente

El techo de 59.8 % **no se mueve con esta migración**: el puente sigue siendo por nombre, porque no
hay llave dura que comprar. Lo que cambia es que ese empate **se va a poder registrar y auditar** en
vez de vivir en un script de una sesión — que era el punto entero de `[NE.0.4]`.
