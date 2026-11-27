# ICR · Anexo — El conteo trimestral: cómo funciona hoy, cómo debe funcionar, y el piloto de Yurécuaro

> **Qué es esto.** El acta de la conversación con Edgar del **2026-11-27**, en la que la fase ICR
> pasó de «inventario por recorrido» en abstracto a **un trimestral concreto, en una sucursal, con
> fecha**. Recoge lo que se midió, lo que se decidió, el protocolo acordado y lo que queda abierto.
>
> **Para quién.** Para la próxima sesión y para el dev que siga; §4 y §5 son además lo que la gente
> de Yurécuaro tiene que tener en la mano el día del conteo.
>
> **Lo medido** sale de pg-prod en **sólo lectura** (`system_identifier` 7688376744939610156) y del
> fuente, el 2026-11-27. Lo que no se pudo medir **se declara**.

---

## 1. El cambio de alcance, y lo que firmó Edgar

**Sólo trimestral.** Queda fuera el conteo cíclico entero: el programador de rotación, los ritmos,
el ABC como disparador y el modo «sin congelar» con ajuste relativo. Queda **una sola cosa**: cuatro
veces al año, en una sucursal, se cuenta todo contra Kepler y el resultado vuelve a Kepler.

| # | Lo que decidió Edgar el 2026-11-27 | Consecuencia |
|---|---|---|
| 1 | **Sólo el trimestral** | Se poda medio módulo; lo que queda se puede hacer bien |
| 2 | **Los anaqueles estarán rotulados** | El barrido por recorrido es posible. ⚠️ Hoy **no** lo están |
| 3 | ⭐ **Firma el ajuste a Kepler** | El lazo se cierra en el ERP, no en una copia. Ver §3.1 |
| 4 | **Se cierra la sucursal para contar** | Corte limpio: el folio va congelado y el ajuste es absoluto |
| 5 | **Escalonadas, empezando por Yurécuaro** | La más chica es el canario |
| 6 | **Cuentan oficinas y la propia sucursal** | La segregación de funciones es cumplible: hay quien no contó |
| 7 | ⛔ **El conteo se hace desde la Suite** | Reafirmado después de que Claude advirtiera el riesgo de la fecha |
| 8 | **Hay que mostrar qué rack se está contando** | §4 |
| 9 | **Protocolo ordenado, sin conteos duplicados** | §4 |
| 10 | **Prevenirnos de cada error que pueda pasar** | §5 |
| 11 | ⭐ **Producto ya contado en otro rack: se AVISA y se suma; no se niega** | §4.3 |
| 12 | ⭐⭐ **«No negarlo, sólo advertirlo»** — regla general | §4.4 |

**El próximo trimestral es el martes 1-dic-2026.** Desde que se decidió hay **un solo día hábil**
(lunes 30-nov).

---

## 2. Cómo funciona HOY el conteo, de punta a punta

Nadie lo tenía escrito completo. Es la base para discutir qué cambia.

### 2.1 La vida de un folio

**Abrir.** Se elige sucursal, tipo (total o cíclico), **si se congelan los movimientos**, **si se
exige doble conteo ciego** y un **umbral de tolerancia** en por ciento. Al abrir, el sistema crea un
renglón por producto con lo que el ERP dice que hay. **Esa cifra queda congelada en el renglón** y
no se vuelve a leer en todo el folio.

**Repartir.** Se asigna gente al folio como contador o supervisor, y opcionalmente **por pasillo**:
si todas las filas de asignación de una persona traen pasillo, queda acotada y el servidor le
rechaza lo que no es suyo. Si alguna no trae, cuenta todo.

**Contar.** Ciego de verdad: el servidor **nunca** devuelve el teórico, ni al registrar. Se escanea,
se captura cantidad, y se guarda en el turno que toca (1.º, 2.º o 3.er conteo). Desde `[IC.F24]`
además **se declara la unidad** y se guarda normalizada a la del teórico, con el testigo de la
conversión. ⭐ Si se escanea algo que **no está en el folio**, se da de alta solo con teórico 0: es
el sobrante.

**Calcular diferencias.** Sin doble conteo, el valor final es el primer conteo. Con doble conteo:
los dos iguales → ése es el valor; difieren → **tercer conteo**, que desempata coincidiendo con uno;
el tercero tampoco coincide → **discrepancia** al supervisor. Y encima el umbral: **aunque los dos
coincidan**, si la diferencia contra el teórico se pasa del por ciento, no se auto-resuelve.

**Resolver.** El supervisor fija la cantidad final y **le pone motivo**. Con umbral activo, una
diferencia material **sin motivo bloquea el cierre**.

**Reconciliar.** Es lo mejor construido del módulo. Para autorizar tienen que pasar todas:

- **ni un SKU sin contar** — *un no-contado NO se trata como cero*;
- ninguna discrepancia abierta, ningún renglón sin valor final, ninguna diferencia material sin motivo;
- si el folio dice «congelar» y **hubo movimientos** de esos productos desde que se abrió, **se niega**
  (el ajuste absoluto borraría esas ventas);
- **quien contó o resolvió no puede autorizar** — segregación de funciones, en código.

Y aplica el ajuste congelando el costo del momento para valuar la merma. Un producto **sin costo
conocido queda en nulo, no en cero**.

### 2.2 Dónde termina — y la aclaración

El ajuste se escribe en **`commercial.stock`** (o en `inventory.warehouse_stock`), tablas de la
Suite. **Kepler no se entera solo.**

⚠️ **Aclaración, porque en la conversación se dijo mal:** *sí existe* el camino de vuelta al ERP y
está construido — `GET /counts/:id/kepler-export` arma el archivo del ajuste en formato Kepler,
`POST .../ack` registra el **acuse** de que alguien ya lo capturó allá (con folio y persona) y
`GET .../status` dice si está emitido, capturado o sin emitir. **No escribe en el ERP**; el lazo lo
cierra una persona. Lo que es cierto es que **nunca se usó**: `inventory_kepler_exports` está vacía.

⛔ Y queda en pie la incoherencia de fondo: en modo `erp` el folio **compara contra el ODS** (Kepler)
y **corrige `commercial.stock`**. Compara contra un libro y corrige otro.

⭐⭐ **Peor: ese otro libro está muerto, y por decisión.** Medido el 2026-11-27: las 8 sucursales
tienen su última escritura en `commercial.stock` el **2026-11-25 a las 16:05:04.041** — **el mismo
milisegundo para todas**, o sea una última corrida. El motivo está en el código:
*«RETIRADO 2026-11-25 `[CANON.7.5]` (Edgar: "hay que matar ese importer")»*, y el commit se llama
**«la existencia es el ODS y punto»**. El CEDIS quedó parado desde el 16-oct y un almacén de Morelia
desde el 10-sep.

Así que la reconciliación **escribe su ajuste en una tabla que nadie va a volver a alimentar**. Las
484 diferencias contra el ODS en Yurécuaro no son un importer que falla: son **dos días de ventas
que esa tabla ya no ve**. ⚠️ Para el martes no bloquea nada —lo que cierra el ciclo es el archivo de
exportación con su acuse— pero quien compare la existencia de la Suite contra Kepler después del
conteo **no va a cuadrar, y no por el conteo**. Retirar las copias es trabajo posterior al piloto y
está encargado aparte.

---

## 2.3 ⭐⭐ Cómo registra Kepler un inventario físico — y cuándo fue el último

> Esto **no estaba documentado en ningún lado** y cambia el final del proceso. Lo contesta el
> catálogo de tipos de documento del propio ERP (`kepler_ods.kdmm`), no una suposición.

Kepler tiene una familia completa para esto, y las sucursales **la usan**:

| Documento | Cómo lo llama Kepler |
|---|---|
| **`N-A-45`** | **Captura inventario físico** |
| **`N-A-30`** | **Entrada Inventario físico** (los sobrantes) |
| **`N-D-30`** | **Salida inventario físico** (los faltantes) |
| `N-A-20` · `N-D-5` | «Entradas por ajuste» · «Salida por ajuste» — el ajuste chico del día a día, que se usa **todos los días** en todas las sucursales |

### El último inventario físico fue en septiembre, y fue escalonado

Medido sobre `kdm1`: **una sucursal por día**, exactamente el modelo que Edgar describió.

| Fecha | Sucursal |
|---|---|
| 10-sep | 05 Zamora Centro |
| 11-sep | 01 Padre Hidalgo |
| **17-sep** | **04 Yurécuaro** |
| 18-sep | 08 Morelia Abastos |
| 22-sep | 03 8 Esquinas |
| 23-sep | 02 La Piedad |
| 30-sep | 00 CEDIS |

### Y así se ve uno hecho: Yurécuaro, 17-sep-2026

| Documento | Folio | Renglones | Importe |
|---|---|---:|---:|
| `N-A-45` Captura inventario físico | 1/0000003 | **1,567** | $679,888.72 |
| `N-A-30` Entrada (sobrantes) | 1/0000004 | **264** | $116,053.19 |
| `N-D-30` Salida (faltantes) | 1/0000003 | **346** | $64,540.70 |

⭐ **Eso es la vara del martes**: la última vez se capturaron **1,567 artículos** y se ajustaron
**610** —264 sobrantes contra 346 faltantes—, con un neto de **+$51,512** a favor. Hoy Yurécuaro
tiene **2,024** artículos con existencia, así que la captura de septiembre cubrió el 77 % de lo que
hoy habría que contar; lo que falte explicar de esa diferencia **no se asume**, se pregunta.

### Lo que esto corrige del exportador

⛔ `keplerAdjustmentExport` rotula cada línea con `kepler_doc: 'InvIn' | 'InvOut'` y declara
`doc_type_hint: 'PhysInv (Physical inventory) / InvIn+InvOut'`. **Esos nombres no existen en
Kepler**: son inglés inventado. Los reales son `N-A-45`, `N-A-30` y `N-D-30`.

⛔ Además `kepler_branch` sale de un `^KEPLER-(\w+)$` sobre el código del almacén. El de Yurécuaro
es `04`, así que **saldría `null`**: el archivo no diría a qué sucursal de Kepler va.

⛔ Y lo que devuelve es **JSON**, no algo que alguien pueda capturar. Nadie captura JSON.

---

## 3. Lo medido el 2026-11-27

### 3.1 El módulo nunca se usó

| Folio | Tipo | Sucursal | Artículos | Con 1.er conteo | Con 2.º | Personas |
|---|---|---|---:|---:|---:|---:|
| INV-2026-00004 | full | La Piedad | 3,664 | **1** | 0 | 1 |
| INV-2026-00005 | full | La Piedad | 3,664 | **0** | 0 | 0 |
| INV-2026-00006 | full | La Piedad | 3,666 | **3** | 0 | 1 |
| INV-2026-00007 | full | Padre Hidalgo | 2,093 | **0** | 0 | 0 |
| INV-2026-00008 | full | La Piedad | 3,664 | **0** | 0 | 0 |
| INV-2026-00009 | full | Padre Hidalgo | 2,094 | **3** | 0 | 2 |
| INV-2026-00010 | full | Padre Hidalgo | 3,364 | **2** | 0 | 1 |

⭐ **Los siete son totales, y el máximo que alguien contó fue tres artículos de tres mil seiscientos.
Nunca hubo un segundo conteo. Nunca participaron más de dos personas.** Seis se abrieron en tres días
de junio y se cancelaron todos.

**No estamos arreglando un proceso que batalla: estamos diseñando uno que nunca corrió.** Nada de lo
construido está validado por el uso — ni el conteo ciego, ni el doble conteo, ni el reparto.

### 3.2 Yurécuaro, el piloto

| | |
|---|---:|
| Artículos con existencia en el ODS | **2,024** |
| Filas en el ODS (con y sin existencia) | 3,144 |
| Ubicaciones dadas de alta | **0** |
| Pasillos dados de alta | **0** |
| Artículos **con** código de barras | **1,828** (90 %) |
| Artículos **sin** código: hay que buscarlos por nombre | **196** (10 %) |

Es la más chica de las sucursales —Padre Hidalgo tiene 3,357— pero dos mil artículos no son pocos.

⛔ **Yurécuaro no tiene ni un pasillo ni una ubicación**, así que el reparto que ya existe **no se
puede usar ahí** hasta que alguien los dé de alta. Ver §6.

### 3.3 Los hallazgos nuevos

Van al doc del módulo como **F31–F35**; acá el resumen de por qué importan para el martes.

| # | Hallazgo | Por qué importa el martes |
|---|---|---|
| **F31** | **La pantalla del contador no menciona la palabra «pasillo» ni una vez.** Quien está acotado se entera **chocando**: escanea y el servidor lo rechaza | Nadie sabe dónde le toca |
| **F32** | **No hay orden de recorrido entre pasillos ni «terminé mi rack».** Hay posición en cuadrícula para dibujar un mapa, no un primero-segundo-tercero | Nadie puede pedir el siguiente, y al final no se distingue «no está» de «nadie llegó» |
| **F33** | **No hay deshacer.** Una captura sólo se pisa con otra, **en silencio**: 24 → 12 queda 12, sin aviso | Un dedazo se vuelve el inventario |
| **F34** | **La bitácora de escaneos existe y nadie la puede ver**: `inventory_count_scan_log` guarda quién y cuándo, pero **no hay endpoint ni pantalla**, y **no guarda ni la cantidad ni el rack** | El supervisor no puede auditar nada en vivo |
| **F35** | ⛔⛔ **El mismo producto en dos racks se pierde.** El renglón es uno por producto: el segundo que lo encuentra recibe *«ya tiene un primer conteo de otra persona»* y **esa mercancía no se cuenta** — sale como faltante | En una distribuidora de dulces, producto en anaquel **y** en bodega es lo normal |

Y dos que ya estaban escritos y se confirman: **F29** (el catálogo de ubicaciones es del piso de
venta; de bodega hay cero) y **F30** (el reparto por pasillo ya está construido entero, apuntando al
catálogo muerto de cuatro filas).

### 3.4 Lo que sí está bien, y conviene no romperlo

- El conteo **es ciego de verdad** (el servidor no devuelve el teórico ni al registrar).
- **Nadie pisa el conteo de otra persona** en el mismo turno.
- El **sobrante** se da de alta solo, con teórico 0.
- **Un no-contado nunca es cero**, con defensa en dos capas.
- **Segregación de funciones** en el desempate y en la autorización.
- El **costo se congela al reconciliar**, y sin costo conocido queda nulo, no cero.
- La **idempotencia** por `scan_uuid`: un mismo escaneo reenviado no duplica.
- ⭐ Existe **asignación masiva** de productos a pasillo por **marca**, clase ABC, rango de SKU o
  lista (`POST /inventory/aisles/assign`). Es lo que vuelve viable mapear Yurécuaro en un día: no
  hay que ubicar producto por producto.

---

## 4. El protocolo acordado

### 4.1 La regla madre

> **Un rack tiene un solo dueño a la vez.**

1. El contador entra al folio. El sistema le entrega **el siguiente rack libre en orden de
   recorrido** y **se lo bloquea**.
2. Cuenta todo lo que hay ahí.
3. Marca **«terminé este rack»**.
4. El sistema le entrega el siguiente libre.

**No hay duplicados por construcción**: tomar un rack es exclusivo. **No hay racks olvidados**: todos
están en la cola y el supervisor ve cuáles siguen libres. **Nadie pregunta qué sigue.** Y el que es
rápido toma más, así que la carga se empareja sola.

**Segunda vuelta:** cuando un rack termina la primera, entra a la cola de la segunda, y el sistema
**nunca** se lo da a quien lo contó la primera vez.

**El montón «sin rack» es un rack más**, el último de la cola, y alguien tiene que cerrarlo. Así nada
queda fuera.

### 4.2 Qué identifica a una captura

> **producto + rack + persona + vuelta**

| Caso | Qué hace |
|---|---|
| Mismo producto, **mismo rack, misma persona** | **Corrige**: *«ya habías contado 24 aquí, ¿lo cambias a 12?»* |
| Mismo producto, **otro rack** | **Suma**, con aviso |
| Mismo producto, **otra persona, mismo rack** | **Suma**, con aviso que dice quién |

Así la corrección propia sigue siendo corrección, y la mercancía partida entre anaquel y bodega no se
pierde (cierra **F35**).

### 4.3 Qué dice el aviso, exactamente

Al contador se le dice **dónde**, no **cuánto**:

> *Este producto ya se contó en el rack 3. ¿Agregas lo de aquí?*

⭐ **La cantidad ajena no se le muestra, a propósito:** el conteo es ciego, y decirle «ya hay 24» le
da un número al que anclarse. Saber que está en otro lado es lo que necesita.

**El supervisor sí ve todo**: cada captura con su rack, su persona, su hora y su cantidad. Esa
bitácora tiene un segundo uso: **dice dónde está realmente cada producto**, y eso alimenta el mapa de
ubicaciones para el trimestre siguiente.

### 4.4 «No negarlo, sólo advertirlo» — y la única excepción

Hoy hay tres bloqueos al contar. **Dos son de confusión y se vuelven aviso**: «no es de tu rack» y
«ya lo contó otro». Nunca se le niega a alguien contar lo que tiene enfrente.

⛔ **El tercero se queda como negación**, y hay que decidirlo (§7): **la misma persona no puede hacer
el primer y el segundo conteo del mismo producto.** Eso no previene una confusión — previene que el
doble conteo ciego sea teatro. Con una sola persona no hay dos testigos, hay uno escribiendo dos
veces.

⭐ La línea es ésa: **nunca se niega contar lo que tenés enfrente; sí se niega que una persona sea su
propio testigo.**

### 4.5 Lo que hay que cambiar por debajo

Hoy el renglón guarda **un número por producto**, y la bitácora de escaneos **no guarda ni la
cantidad ni el rack**.

Para que el protocolo funcione, **cada captura pasa a ser la unidad real**: se guarda con su cantidad
y su rack, y el conteo del producto es la **suma** de sus capturas. El renglón conserva su número para
comparar contra el teórico, pero pasa a ser **derivado**.

Es la decisión **D7** del plan, resuelta por el lado barato: **sin tabla nueva**, agregándole columnas
a `inventory_count_scan_log`.

⚠️ Eso **cambia cómo se forma un número** (regla 15): va con su medición antes/después. Hoy la
bitácora tiene 11 filas y los 7 folios viejos están cancelados, así que el antes/después es trivial —
pero se mide igual y se escribe.

### 4.6 Qué pasa cuando se acaban los racks

**Lo normal: la cola no se vacía de golpe.** Cuando se terminan los racks de primera vuelta, quien
termina **pasa automáticamente a la segunda** — los racks ya cerrados están esperando su segundo
conteo, y el sistema nunca le da a nadie uno que esa misma persona contó. Mientras queden racks sin
su segunda vuelta, hay trabajo.

**Cuando sí se vacía y alguien sigue contando**, el que quedó libre **puede unirse a ese rack**. Lo
que lo vuelve seguro es el aviso de §4.3: si escanea algo que el otro ya contó ahí, la pantalla se lo
dice en el momento.

⭐ **El traslape se anuncia solo.** Se reparten el rack físicamente —«vos las de arriba, yo las de
abajo»— y si por error se pisan, se enteran al instante y no al final. ⛔ Sin ese aviso esto sería
peligrosísimo: con suma, dos personas contando la misma repisa **duplican la mercancía**.

**Y el caso que va a pasar:** alguien se va, se le muere el teléfono, o le tocó un rack enorme y no
avanza. Su rack queda bloqueado a su nombre y nadie más lo puede tomar. Por eso el supervisor
necesita **liberar un rack**. Al liberarlo:

- **lo ya capturado se queda** — es mercancía contada de verdad;
- quien lo tome **ve lo que ya se contó en ese rack**, para **continuar**, no para recomenzar.

⭐ De ahí sale una simplificación: **el histórico es del RACK, no de la persona.** Casi siempre es lo
mismo, porque quien cuenta está solo; y cuando no lo está —relevo, o dos juntos— es la única forma de
que el que llega no vuelva a contar lo ya contado.

**El supervisor ve** qué rack tiene cada quién y **desde hace cuánto**. Eso le dice a quién ir a
ayudar y qué rack liberar, sin preguntarle a nadie.

---

## 5. Los errores previstos y qué los previene

✅ ya previsto · 🔨 por construir · ⛔ necesita decisión

### 5.0 Lo que se revisó y está LIMPIO

⭐ Va primero porque un riesgo descartado con una medición también es resultado, y porque evita que
la próxima sesión gaste el día en estos cuatro.

| Lo que se sospechaba | Lo medido el 2026-11-27 | Veredicto |
|---|---|---|
| El **catálogo duplicado** parte el folio en dos renglones por producto | De los 2,024 artículos de Yurécuaro: **0 SKUs repetidos, 0 sin SKU**, 5 con nombre repetido | **No aplica acá.** El problema general del catálogo (887 SKUs duplicados en la empresa) no cae en este universo |
| El **teórico está atrasado** y todas las diferencias salen mal | El feed de existencia de Kepler (`kepler_ods.kdil`) tiene **1 segundo** de antigüedad | **Falso.** El ODS es vivo |
| Dos capturas simultáneas del mismo renglón **se pisan** | `submitCount` toma el renglón con `FOR UPDATE` | **Falso.** No hay carrera |
| No se puede registrar **«aquí no hay nada»** | La validación admite `quantity >= 0` | **Falso.** El cero es capturable, que es lo que vuelve un hueco un faltante contado |
| Se pueden abrir **dos folios del mismo almacén** y pisarse | Hay **dos** guardas: una sola sesión viva por (almacén, ritmo), y además **ningún SKU puede estar en dos folios vivos** — con el motivo escrito en el código: *«el segundo ajuste pisaría al primero»* | **Falso.** Bien guardado, en dos capas |
| Alguien puede abrir el folio contra **la fuente equivocada** | La fuente **no se elige a mano**: el servicio prueba el ODS primero y sólo baja a las copias si el ODS no devuelve nada. Yurécuaro tiene 2,024 filas ahí | **Falso.** El folio del martes nace contra Kepler sí o sí |
| `public.products` es un **segundo catálogo** que diverge del del ODS | Es una **vista** sobre `catalog.products`: mismas 14,986 filas, **0 divergencia** | **Falso.** Es un alias, no un catálogo |

### 5.1 Los nueve patrones nuevos (2026-11-27)

> ⛔⛔ **E8 va primero porque es el único que, solo, impide que el martes ocurra.**

| # | Patrón | Lo medido | Qué lo previene | |
|---|---|---|---|:--:|
| **E8** | ⛔⛔ **Nadie en Yurécuaro puede contar.** Y no es que les falte la llave: a tres de ellos **está puesta en «no»**, explícitamente | Las **8** personas de la sucursal —4 cajeras, la encargada de tienda, el de etiquetas, un vendedor de ruta y el verificador— tienen **0** de las llaves de contar, supervisar y reconciliar. En toda la empresa pueden contar **24** (17 de oficina, 3 de Padre Hidalgo, 2 de la 06, 2 sueltas). Los únicos roles operativos con la llave son `almacenista` y `superadmin`. ⚠️ `almacenista` **puede contar pero no supervisar**: no ve el avance de nada | **Repartir las llaves el lunes**, y que cada persona **vuelva a entrar** después (los permisos viajan en la sesión: sin eso, el martes es 403). Es acción de Edgar, no de Claude: son personas y es producción | ⛔ |
| **E9** | ⛔ **Cuatro de cada diez códigos pueden no machear.** La resolución compara la cadena **tal cual**, sin normalizar | En el folio de Yurécuaro conviven **1,468 códigos de 13 dígitos y 786 de 12**, más 36 de 8 y 20 de 14. **117** de los de 12 ya empiezan con cero, y **16 códigos existen en las dos formas a la vez**. Un lector configurado para EAN-13 le pone un cero adelante a un UPC-A y deja de machear: hasta **786 productos, el 39 % del folio**. ⚠️ Y los 20 de 14 dígitos **empiezan con `0`**: son EAN-13 ya rellenados en nuestros propios datos | Probar el lector el lunes (**§6b, la hoja de ocho disparos**) y normalizar en el servidor: exacto primero, sin ceros a la izquierda después. **Control medido:** normalizar lleva los ambiguos de **7 a 9** sobre 2,313. ⛔ Los 9 ambiguos **se preguntan, no se adivinan** — hoy una CUCHARA y un TENEDOR comparten código | 🔨 |
| **E1** | ⛔ **El umbral de recuento nace en CERO**, así que la red de seguridad está **apagada por defecto**: ni el count-back («aunque los dos coincidan, si la diferencia es grande va a revisión») ni la exigencia de motivo en una diferencia material | `recount_threshold_pct` `notNullable().defaultTo(0)` (migración `20260618190000`), y los dos guards son `if (umbral > 0)` | **Fijarlo al abrir el folio.** Es lo más barato y lo que más protege | 🔨 |
| **E2** | ⛔ **Contar en cajas multiplica el error y el factor no se puede verificar.** Una caja mal convertida son 24 unidades de diferencia | **1,905 de 2,024** artículos de Yurécuaro tienen factor de caja. De los 133 con código de caja, **123 discrepan** del factor del ERP y **11 coinciden** | Que la pantalla **muestre la cuenta antes de aceptar** —«3 cajas × 24 = 72 paquetes»— y deje corregir el factor ahí | 🔨 |
| **E3** | ⛔ **La foto del teórico envejece.** El folio congela el teórico **al abrirse**; si se abre el día antes, cada diferencia carga un día de ventas | El ODS es vivo (1 s), así que el desfase lo introduce **el momento de abrir**, no la ingesta | **El folio se abre el martes**, con la sucursal ya cerrada. El lunes se preparan racks y mapeo, no el folio | ⛔ |
| **E4** | ⛔ **Lo capturado y no sincronizado se pierde callado.** Un reenvío no duplica (idempotencia por `scan_uuid`), pero una captura **nueva** que sube cuando el folio ya cambió de estado **se rechaza** y nadie se entera | El guard de estado corre después del de idempotencia: el replay pasa, la captura nueva no | Que la pantalla diga **cuántos escaneos faltan por subir**, y que nadie se vaya con la cola en rojo | 🔨 |
| **E5** | ⛔ **La mercancía que está pero no está ahí**: lo surtido y no facturado sigue contando como existencia en Kepler y está en el andén; igual lo apartado y las devoluciones sin procesar | No medido: depende del día. Se declara | Que **el andén sea un rack más** en la cola, con dueño. Y decir antes de empezar qué se cuenta y qué no | ⛔ |
| **E6** | ⛔ **El permiso nuevo no aplica hasta volver a entrar**: los permisos viajan en la sesión | Regla conocida del proyecto (el JWT trae los permisos) | Cada persona **entra y sale una vez el lunes**, con su cuenta y su dispositivo | 🔨 |
| **E7** | ⚠️ **Los 196 sin código se buscan por nombre**, y elegir el equivocado se ve igual que un conteo correcto | **196 de 2,024** (10 %) sin código de barras; 5 productos con nombre repetido | Que la búsqueda muestre **SKU y rack junto al nombre**, no sólo el nombre | 🔨 |

### 5.2 Antes de empezar

| Qué puede pasar | Qué lo previene | |
|---|---|:--:|
| Un rack existe y no está dado de alta: nadie lo cuenta y nadie lo nota | La cola de racks, y el montón «sin rack» que alguien tiene que cerrar | 🔨 |
| Productos mapeados al rack equivocado | **No bloquear**: el que está parado ahí manda, cuenta, y el sistema corrige el mapa | 🔨 |
| Hay movimientos durante el conteo | El folio se abre congelado y la reconciliación **se niega** si los hubo | ✅ |
| Alguien no puede entrar o le falta permiso | Se prueba **el lunes**, persona por persona | 🔨 |
| Dos personas con la misma cuenta | Rompe el doble conteo y la segregación. Cada quien la suya, verificado el lunes | 🔨 |

### 5.3 Contando

| Qué puede pasar | Qué lo previene | |
|---|---|:--:|
| Dos personas cuentan el mismo rack | La toma exclusiva | 🔨 |
| Dos personas se unen al mismo rack y **se pisan** | El aviso de §4.3 lo anuncia en el momento | 🔨 |
| Alguien se va, o se le muere el teléfono, con un rack tomado | El supervisor **libera** el rack; lo capturado se queda y quien lo toma **ve qué falta** | 🔨 |
| Capturás encima de tu propio conteo sin querer | Avisar y pedir confirmación. Hoy lo pisa en silencio (**F33**) | 🔨 |
| Otro captura algo que vos ya contaste | Se avisa y **se suma**, ya no se rechaza (**F35**) | 🔨 |
| Escaneás el producto de al lado | Doble conteo ciego + umbral: dos personas tendrían que errar igual | ✅ |
| Contás en cajas y el sistema entiende piezas | La unidad se declara y queda el testigo (`[IC.F24]`); falta que la pantalla la diga **en grande** | ✅ / 🔨 |
| Se cae el internet | Hay cola local con `scan_uuid` idempotente. ⚠️ **Nunca se probó con varias personas** | ✅ / 🔨 |
| Se muere el teléfono con escaneos sin subir | Que la pantalla diga **cuántos faltan por sincronizar** | 🔨 |
| Aparece algo que el ERP no tenía | Se da de alta solo, con teórico cero | ✅ |
| Alguien captura un número absurdo | El umbral lo manda a revisión aunque los dos coincidan | ✅ |
| El mismo escaneo se reenvía (doble toque, reintento) | Idempotencia por `scan_uuid`: no suma ni pisa | ✅ |

### 5.4 Al cerrar

| Qué puede pasar | Qué lo previene | |
|---|---|:--:|
| No se alcanza a contar todo y el folio no cierra | Los racks cerrados dicen «aquí ya barrimos»: lo no contado en un rack cerrado es **faltante**, no olvido | 🔨 |
| Quien contó quiere autorizar | Bloqueado en código. ⚠️ Hay que **designar desde el lunes** quién autoriza, y que esa persona **no cuente** | ✅ / ⛔ |
| El ajuste se queda en la Suite | Exportar + **acuse** de captura en Kepler. Sin acuse, el trimestre que viene reaparece la misma diferencia | ✅ |
| Se reconcilia dos veces | Bloqueado | ✅ |

---

## 6. Lo que NO llega al martes, dicho antes

Con **un solo día hábil**, y porque el martes la sucursal está cerrada y un fallo cuesta el día
entero:

- **El ajuste escrito por la Suite directo en Kepler.** La firma está dada, pero escribir en el ERP
  tiene su propio carril (documento, canario, verificación): es de semanas. **Para el martes el lazo
  se cierra con el archivo de exportación y su acuse**, que ya existe.
- **La regla de cierre por rack** (que lo no contado en un rack cerrado valga como faltante). Lo que
  sí puede estar es el **«terminé mi rack» informativo**, para que el supervisor vea el avance.
- **Las ubicaciones físicas de Yurécuaro.** Los rótulos no están puestos y no hay ni una ubicación
  capturada. El martes se trabaja con **racks** (pasillos), no con ubicaciones finas.

⛔ **Y el prerrequisito que no es de Claude:** alguien de Yurécuaro tiene que dar de alta sus racks y
**repartir los productos entre ellos** con la pantalla de pasillos (por marca es el camino realista).
Sin eso, nada del protocolo tiene dónde pararse.

---

## 6b. La lista de verificación del LUNES 30-nov

> Una hoja. Si algo de acá queda en rojo el lunes a las seis de la tarde, **se dice** — no se
> descubre el martes con la sucursal cerrada.

### De la sucursal (Yurécuaro)

- [ ] **Los racks dados de alta**, con su nombre tal como la gente los llama, en
      `/almacen/inventory/aisles`.
- [ ] **Los racks en orden de recorrido**: el número que dice cuál se camina primero.
- [ ] **Los productos repartidos entre racks**, con la asignación masiva **por marca** (y por rango
      de SKU o clase ABC donde ayude). No hace falta producto por producto.
- [ ] **El andén decidido**: ¿lo surtido y no facturado se cuenta? Si sí, es un rack más (E5).
- [ ] **Los rótulos puestos**, si alcanzan. No es bloqueante para el martes —se trabaja por rack, no
      por ubicación fina— pero es lo que hace barato el trimestre siguiente.

### De las personas

- [ ] **Cada quien con SU cuenta.** Dos personas con la misma rompen el doble conteo y la
      segregación de funciones.
- [ ] **Cada quien entró y salió una vez**, desde el dispositivo que va a usar (E6: el permiso nuevo
      no aplica hasta volver a entrar).
- [ ] **Designado quién autoriza** la reconciliación — de oficinas — y **esa persona no cuenta**.
- [ ] Sabido **cuánta gente** va, para repartir racks.

### De los dispositivos

- [ ] Cargados, y con el escáner probado contra un producto real — **la hoja de abajo**.
- [ ] **Probado el modo sin internet con varias personas a la vez.** Nunca se hizo.
- [ ] **Cada dispositivo abre el folio CON red** antes de empezar: si llega sin conexión, no se
      descarga el catálogo y ese teléfono no puede resolver ningún código.

### ⭐ La prueba del escáner — ocho disparos, con productos reales de Yurécuaro

> ⛔ **Esto no se puede medir desde la base: hay que apretar el gatillo.** Lo que decide el día no
> es qué código tenemos guardado, sino **qué cadena escupe el lector**. Son cinco minutos y evita
> descubrir el martes que el 39 % del folio «no existe».
>
> Para cada disparo se anota **exactamente** lo que aparece en el campo, dígito por dígito, y si el
> producto se reconoció.

| # | Qué probar | Código guardado | Producto | Qué se espera, y qué significa si falla |
|---|---|---|---|---|
| 1 | **UPC-A de 12** ⬅ el crítico | `719886052026` | PELON PELO RICO TAM BLS 12P (caja) | Si el lector devuelve **13 dígitos con un `0` adelante**, no va a machear. Son **786 productos, el 39 % del folio** |
| 2 | **UPC-A de 12**, segunda prueba | `719886211713` | PELON PELO RICO TAM BLS 12P (pieza) | Mismo SKU que el 1 pero en otra unidad: confirma que el lector no mezcla |
| 3 | **EAN-13** | `7622210529688` | HALLS TUBO XTRA STRONG LYPTUS (pieza) | Tiene que salir idéntico. Es el caso sano |
| 4 | **EAN-13 de caja** | `7622210426987` | HALLS TUBO XTRA STRONG LYPTUS (caja) | Al escanear la caja, ¿la pantalla ofrece contar en cajas? |
| 5 | **EAN-8** | `80050315` | KINDER BARRITA / 18 | ¿El lector lo alarga a 13? Son 36 códigos |
| 6 | **Catorce dígitos** | `07503057269015` | LEVI CHAROLA 855/50 (caja) | ⚠️ Empieza con `0`: **es un EAN-13 rellenado a 14**. La prueba de que el relleno ya pasó en nuestros propios datos |
| 7 | ⛔ **Código ambiguo** | `0001002010103` | **CUCHARA GRANDE BIO** *y* **TENEDOR MEDIANO**, los dos de Reyher | Hoy el sistema elige uno **al azar**. Tiene que preguntar, no adivinar. Hay 7 así en el folio |
| 8 | **Sin código: búsqueda por nombre** | — | `AGUINALDO ESPECIAL / MEGA DULCES` (432 unidades) | Son **196 productos (10 %)**, casi todos de marca propia. ¿Se encuentran escribiendo? ¿Y sin red? |

**Los otros dos códigos ambiguos que conviene conocer**, porque son productos que se parecen y están
juntos en el anaquel: `018804060113` (JARRITOS GUMMIES **y** JARRITOS SOUR GUMMIES, Canel's) y
`4500000500112` (ALTOS BAJA CORTADA **y** ALTOS ROLLO BAJA).

⭐ **Si el disparo 1 devuelve el cero de adelante**, el arreglo del servidor —probar el código tal
cual y después sin ceros a la izquierda— deja de ser conveniente y pasa a ser **obligatorio antes
del martes**. Ya está encargado, y su control negativo está medido: normalizar lleva los códigos
ambiguos de **7 a 9** sobre 2,313, o sea dos más.

### Del sistema (Claude)

- [ ] El contador **ve su rack** y su lista llega filtrada a lo suyo (**F31**).
- [ ] El rechazo *«no es de tu rack»* se vuelve **aviso** (decisión de Edgar: no negar, advertir).
- [ ] **La bitácora visible**: cada captura con su persona, su hora, su cantidad y su rack (**F34**).
- [ ] La recaptura propia **avisa antes de pisar** (**F33**).
- [ ] La pantalla dice **cuántos escaneos faltan por subir** (**E4**).
- [ ] Al contar en cajas, la pantalla **muestra la cuenta** antes de aceptar (**E2**).

### El martes, antes de empezar

- [ ] **La sucursal cerrada** y sin movimientos.
- [ ] **El folio se abre ese día**, no antes (**E3**).
- [ ] **El umbral de tolerancia puesto** al abrir — no viene puesto (**E1**).
- [ ] **Doble conteo ciego** encendido o apagado, decidido a conciencia (A5).

---

## 7. Lo que queda abierto

| # | Pregunta | Recomendación | Quién firma |
|---|---|---|---|
| **A1** | ¿Se conserva la negación de que **una misma persona haga el 1.er y el 2.º conteo** del mismo producto? | **Sí.** Es lo único que hace real al doble conteo ciego | Edgar |
| **A2** | ¿Cuántos racks tiene Yurécuaro y **cuánta gente** cuenta? | Define cuántos racks por persona y si el día alcanza | Edgar |
| **A3** | **Quién autoriza** la reconciliación, y que no cuente | De oficinas, designado desde el lunes. ⭐ Medido: reconciliar lo pueden **12 personas**, todas de oficina o compras, así que la segregación se cumple sola | Edgar |
| **A6** | ⛔⛔ **A quién se le reparte la llave de contar** (E8). Hoy **nadie en Yurécuaro la tiene**, y a tres les está puesta en «no» | Claude prepara el diff exacto de llaves por persona en cuanto Edgar diga quiénes cuentan. **Sin esto el martes no ocurre** | Edgar |
| **A4** | **Quién mapea** los productos a los racks de Yurécuaro | Alguien de la sucursal, el lunes, por marca | Edgar |
| **A5** | ¿El trimestral corre con **doble conteo ciego**? Duplica el trabajo (2,024 → 4,048 capturas) | **Sí** en el piloto: es lo que protege del escaneo equivocado, que es invisible | Edgar |

---

## 8. Bitácora

| Fecha | Qué pasó |
|---|---|
| 2026-11-27 | Conversación con Edgar. Se acota la fase **sólo al trimestral**, se fija el piloto (**Yurécuaro, martes 1-dic**) y se acuerda el protocolo de toma de rack. Se mide que **el módulo nunca se usó** (máximo 3 artículos contados de 3,666) y aparecen **F31–F35**. Edgar firma el ajuste a Kepler, el cierre de la sucursal para contar, y la regla **«no negarlo, sólo advertirlo»**. Quedan abiertas A1–A5. |
| 2026-11-27 | Edgar resuelve el fin de cola (§4.6): se pasa solo a la segunda vuelta, el libre **puede unirse** al rack ocupado porque el aviso anuncia el traslape, y el supervisor puede **liberar** un rack. De ahí sale que **el histórico es del rack, no de la persona**. |
| 2026-11-27 | Siguen los patrones. **E8**: medido con las tres vías del permiso, **nadie en Yurécuaro puede contar** — es el único hallazgo que, solo, impide el martes. **E9**: la resolución del código de barras no normaliza y conviven dos formatos (1,468 de 13 dígitos contra 786 de 12), así que hasta el 39 % del folio podría no machear; se agrega la **hoja de ocho disparos** (§6b) porque eso sólo se mide apretando el gatillo. Y se descubre que `commercial.stock` **está muerta por decisión** (`[CANON.7.5]`, 2026-11-25): la reconciliación escribe en una tabla que ya nadie alimenta. Cuatro riesgos más descartados con medición (§5.0). |
| 2026-11-27 | Edgar pide buscar más patrones de error. Se agregan **E1–E7** (§5.1) y, antes, los **cuatro riesgos descartados con medición** (§5.0): el catálogo duplicado no toca a Yurécuaro, el ODS no está atrasado, no hay carrera entre capturas y el cero sí es capturable. El más grave de los nuevos: **el umbral de recuento nace en cero**, o sea que la red de seguridad está apagada salvo que se encienda al abrir el folio. Se agrega la **lista de verificación del lunes** (§6b). |
