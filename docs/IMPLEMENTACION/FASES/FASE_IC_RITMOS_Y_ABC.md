# Fase IC (continuación) — Los tres ritmos de conteo y el desglose del ABC

> **Estado:** 🔨 DISEÑADO (planeación) · 2026-10-06 · sin código.
> **Hermano de** [`FASE_IC_INVENTARIO_CONTINUO.md`](FASE_IC_INVENTARIO_CONTINUO.md) (IC.0–IC.13),
> que es donde vive el detalle de lo ya construido. Este documento es **el plan de lo que falta**.
> **ADR propuesto:** ADR-082.

---

## 0. El pedido, y la primera cosa que hay que decir

Lo pedido (2026-10-06):

1. Un **inventario diario** de los productos *top* de cada sucursal.
2. Un **inventario mensual** de los productos con **mayor diferencia**, para encontrar la causa.
3. El **registro trimestral de Kepler** — *"ya lo tenemos"*.
4. Desglosar el **ABC**: *por qué* un producto es A, B o C; y **uno parametrizado por ventas y otro
   por costo del producto**.

⭐ **Lo primero que hay que decir es que esto ya se pidió, ya se construyó, y nunca arrancó.** La
Fase IC se llama, literalmente, **«Inventario Continuo (3 ritmos)»** y nació del mismo pedido: un
completo trimestral, un parcial mensual y uno por productos top. Los tres motores están escritos,
probados y en producción desde el 29-sep. **Y la foto de hoy, medida contra prod, es la misma que
hace una semana: 6 folios, los 6 `cancelled`, cero reconciliados.**

Entonces este plan **no es «construir tres ritmos»**. Es: *los tres motores existen y el ciclo no
cerró ni una vez — acá está por qué, y qué lo destraba.* Si se construyen tres pantallas nuevas
encima de un ciclo que no cierra, en un mes vamos a estar midiendo lo mismo.

---

## 1. Mapa 1:1 — lo que pediste contra lo que ya existe

| Lo que pediste | Qué existe hoy | Qué le falta |
|---|---|---|
| **Diario · productos top por sucursal** | `analytics.v_count_priority_score` (IC.4): 4 señales — `s_abc`, `s_venta`, `s_parado`, `s_descuadre` — con `senales_usadas` y `score_salvedad`. **Es exactamente el motor que esto necesita.** | No hay cadencia diaria (hoy A=30 · B=90 · C=365), tarda **10.6 s**, y no hay quien abra el folio |
| **Mensual · mayor diferencia** | `analytics.v_sku_count_variance_history` (IC.3): `veces_descuadro`, `tasa_descuadre`, `pesos_abs/neto`, `retencion` y **`patron`** (sobra / merma / se_compensa / mixto / sin_dinero) | No hay un folio que se siembre *desde* esta vista; el `patron` no llega a ninguna bandeja de causa |
| **Trimestral · Kepler** | `analytics.mv_erp_physical_count_variance` + `/almacen/inventory/diferencias` (IC.0/IC.12). **Correcto: ya lo tenemos.** | Nada de fondo. Pendiente sólo el redeploy que ya está en cola |
| **ABC desglosado** | `commercial.abc_classification` con `annual_value`, `value_share`, `costo_source`, `clase_motivo`; definición en `analytics.v_abc_class` | El «por qué» que guarda hoy responde *otra* pregunta; falta el rango, el aporte individual y la distancia al corte |
| **ABC por ventas / por costo** | Hoy hay **uno solo**: `annual_value = ADU × 365 × costo_unitario` | ⛔ Las dos parametrizaciones literales **coinciden en 98.85%** — ver §4 |

**Conclusión del mapa: de las cuatro cosas, tres ya tienen el motor construido.** Lo que falta es
el *ritmo* (que el folio se abra, se cuente y se cierre) y el *desglose* del ABC.

---

## 2. El estado medido (prod, 2026-10-06)

### 2.1 El ciclo nunca cerró

```
folio             alm  estado      SKUs   contados   último conteo real
INV-2026-00009    01   cancelled   2094   3          2026-07-22
INV-2026-00008    02   cancelled   3664   0          —
INV-2026-00007    01   cancelled   2093   0          —
INV-2026-00006    02   cancelled   3666   3          2026-06-19
INV-2026-00005    02   cancelled   3664   0          —
INV-2026-00004    02   cancelled   3664   1          2026-06-17
```

**18,845 renglones abiertos, 7 contados (0.04%).** Ninguno posterior a junio-2026. Y ninguno usó
`stock_source='erp'`: **el teórico del ODS de IC.1 todavía no se ejerció ni una vez en producción.**

La causa ya está diagnosticada en el código, en `[CNT.1]`: el *coverage guard* de `reconcile()`
exige que **no quede un solo SKU sin contar** —y está bien, *un no-contado no es un cero*—, pero un
folio total de 3,664 SKUs exige contar los 3,664. **Operativamente eso no pasa en una tienda.** La
respuesta de diseño fue el folio cíclico de 50… que hasta `[IC.13]` (hoy) **no tenía UI**.

### 2.2 El reloj de la cadencia nunca arrancó

`cycleDue()` decide qué está vencido así:

```sql
last_counted_at = MAX(c.reconciled_at) WHERE c.status = 'reconciled'
vencido = (last_counted_at IS NULL OR last_counted_at + cadence_days <= now())
```

Con **cero folios reconciliados**, `last_counted_at` es `NULL` para todos los SKUs del sistema →
**todo está vencido, siempre.** La cadencia A=30 / B=90 / C=365 **no ha discriminado una sola vez**,
y no puede hasta que exista el primer folio reconciliado. Es circular, y es el bloqueo #1.

### 2.3 Tres ritmos no caben: hay un folio vivo por almacén

```sql
CREATE UNIQUE INDEX commercial_inv_counts_one_open_per_wh
  ON commercial.inventory_counts (tenant_id, warehouse_id)
  WHERE status IN ('open','counting','review','ready_to_reconcile');
```

**Un folio diario en la sucursal 01 bloquea el mensual de esa misma sucursal, y viceversa.** El
trimestral no choca porque lo genera Kepler y no pasa por esta tabla — pero los dos que pedís sí
chocan entre sí. Esto es un bloqueo **estructural**: no se resuelve con pantallas.

### 2.4 Cobertura real: no son 28 almacenes, son 9 (y para el mensual, 6)

| Motor | Almacenes cubiertos | Lo que queda afuera |
|---|---|---|
| ABC / priority score (`inventory_health`) | **9**: 00 CEDIS, 01–08 | las **19 `RUTA-*`** y `MD-32` — sin demanda, sin clase, sin score |
| Historial de descuadre (`v_sku_count_variance_history`) | **6**: 01–06 | **07 y 08 (Morelia) no tienen historia** de conteo físico, ni el CEDIS |
| 4ª señal del score (descuadre) | **4**: 02, 03, 04, 05 | en 00, 01, 06, 07, 08 el score sale con **3 señales de 4** (`senales_usadas = 3.00`) |

⚠️ **«Cada sucursal» no puede significar 28 almacenes.** Significa 9 para el diario y 6 para el
mensual, y eso **se declara en pantalla**, no se disimula con una lista más corta.

⚠️ `analytics.sales_daily` arranca en fechas distintas por sucursal: **07 desde el 08-sep y 08 desde
el 19-sep**. Una ventana de 90 días divide 28 y 17 días de historia entre 90 → su ADU sale
subdeclarada ~3-5×, y por lo tanto su ABC también. Ya está documentado y sigue vigente.

⚠️ **Defecto encontrado de paso:** `RUTA-22` tiene `sale_date` máximo **2026-12-06**, dos meses en el
futuro. No es de esta fase, pero contamina cualquier ventana móvil que la incluya.

### 2.5 El rendimiento no alcanza

| Objeto | Hoy | Gate |
|---|---|---|
| `analytics.v_count_priority_score` | **10,618 ms** | 500 ms |
| `analytics.v_sku_count_variance_history` | 1,615 ms | 500 ms |
| `analytics.v_erp_unit_cost` | 14,973 ms | 500 ms |

El motor del ritmo diario tarda **diez segundos y medio**. Si el cron lo corre para 9 almacenes
todas las mañanas, son ~95 s de trabajo; si además una pantalla lo lee, no abre. Hay que
materializarlo, igual que se hizo con `mv_erp_physical_count_variance` en IC.12.

---

## 3. Los cinco bloqueos, en orden de qué frena a qué

| # | Bloqueo | Consecuencia si no se resuelve | Lo destraba |
|---|---|---|---|
| **1** | **Nadie ha cerrado un folio** | La cadencia no arranca, el IRA no tiene base, el historial propio no existe | IC.14 — un folio chico, real, cerrado de punta a punta |
| **2** | **Un folio vivo por almacén** | El diario y el mensual **no pueden coexistir** | IC.15 — la llave pasa a `(almacén, ritmo)` + un SKU en un solo folio vivo |
| **3** | **El reloj cuelga de `reconciled_at`** | Todo «vencido» para siempre; la priorización no ordena nada | IC.16 — el reloj por ritmo, con arranque declarado |
| **4** | **El motor diario tarda 10.6 s** | El cron no escala y la pantalla no abre | IC.17 — materializar el score |
| **5** | **El ABC responde una sola pregunta** | $20.85 M de capital en clase C, mirado una vez al año | IC.19/IC.20 — el desglose y el eje de capital |

⭐ **La ruta crítica es 1 → 2 → 3.** Los otros dos son paralelizables. Y el #1 **no es un sprint de
código**: es acompañar a una persona en una sucursal hasta que un folio de 50 SKUs llegue a
`reconciled`. Sin eso, lo demás se construye a ciegas.

---

## 4. El ABC: lo que mide hoy, y la parametrización que hay que elegir

### 4.1 Qué mide hoy, exactamente

```
annual_value = avg_daily_units × 365 × costo_unitario
```

Pareto **por almacén**: A hasta el 80% del valor acumulado · B 80–95% · C el resto. O sea: **valor
de consumo anualizado, valuado a costo.** No es «ventas» ni «costo» — es el **movimiento de dinero**.

Foto vigente en prod: **A 5,051 SKUs / $219.6 M · B 6,946 / $41.1 M · C 17,953 / $13.7 M.**

### 4.2 El «por qué» que ya guarda, y el que falta

`clase_motivo` existe y tiene tres valores: `pareto`, `sin_demanda`, `sin_costo`. Pero eso responde
**«por qué tiene clase»**, no **«por qué es A y no B»**. Para esa pregunta las piezas ya están
calculadas dentro de `v_abc_class` y **se tiran**:

| Dato | ¿Existe? | ¿Se guarda? |
|---|---|---|
| `avg_daily_units` (el lado demanda) | sí | **sí** |
| `costo_unitario` + `costo_source` + `tiene_testigo` | sí | `costo_source` sí · **`tiene_testigo` NO** |
| `annual_value` (el producto de los dos) | sí | sí |
| `value_share` **acumulado** | sí | sí |
| **aporte individual** (`annual_value / total_almacén`) | se puede | **no** |
| **rango dentro del almacén** (`#12 de 4,494`) | se calcula en la ventana | **no** |
| **distancia al corte** («le faltan $4,200 para ser B») | se puede | **no** |

Con esas tres columnas, la pantalla puede decir la frase completa:
> *«Es **A** porque mueve **$412,900 al año** — ADU 31.2 piezas × $36.25 de costo —, es el **#12 de
> 4,494** en Padre Hidalgo y acumula hasta el **7.4%** del valor. Le sobran $380 mil sobre el corte
> de B. El costo viene de `kepler_kdik` **con testigo de compra**.»*

Eso es el desglose, y **no necesita una fuente nueva**: necesita no tirar lo que ya se calcula.

### 4.3 ⛔ «Uno por ventas y otro por costo» — lo medí, y es un placebo

Clasifiqué la sucursal 01 por **ingreso** (revenue 90 d) y por **COGS** (cost 90 d), Pareto idéntico:

| | costo A | costo B | costo C |
|---|---|---|---|
| **ventas A** | 797 | 8 | 2 |
| **ventas B** | 6 | 1,061 | 20 |
| **ventas C** | 0 | 11 | 2,182 |

**4,040 de 4,087 SKUs (98.85%) caen en la misma clase.** Sólo 47 se mueven.

Y hay una razón de fondo por la que esto no va a mejorar: en la mitad Kepler del fact,
`sales_daily.cost` se deriva como `revenue / (1 + markup_pct)` — **es álgebra sobre el propio
ingreso** (ADR-051, enmienda del 31-ago). Ordenar por costo es, en buena parte del catálogo,
ordenar por ingreso con otro nombre. Las dos pantallas serían la misma pantalla, y las 47
diferencias que aparecen **podrían ser artefacto del método, no del negocio**.

> **Entregar esas dos vistas sería entregar un placebo.** No se construye así.

### 4.4 ⭐ El segundo eje que SÍ es distinto: capital parado

La pregunta que el ABC de consumo **no puede responder** es *¿dónde está el dinero quieto?*. Mismo
Pareto, otra métrica: `existencia × costo_unitario`. Medido en la sucursal 01:

| | capital A | capital B | capital C |
|---|---|---|---|
| **consumo A** | 287 | 179 | 144 |
| **consumo B** | 129 | 292 | 499 |
| **consumo C** | **98** | **344** | 1,248 |

**Coinciden sólo el 56.7%. Difieren el 43.3%** — contra el 1.15% del eje anterior. Y el punto ciego
tiene nombre y monto: **442 SKUs que son clase C por consumo guardan $2.54 M de capital** en una
sola sucursal. Los peores son **estacionales**:

```
28116  DELI BOTA NAVIDEÑA (110G)      clase C   valor consumo $0      6,760 pz   $121,680 parados
62137  SURTI BOTA NAVIDEÑA 110GR      clase C   valor consumo $0      4,950 pz   $ 80,438
70108  LA ROSA BOTA CHICA 119GR       clase C   valor consumo $0      3,900 pz   $ 54,873
17592  ALTOS NAVIDEÑA BAJA NATURAL    clase C   valor consumo $0      2,000 pz   $ 46,560
```

Botas navideñas en octubre: **cero consumo en la ventana de 90 días** → `annual_value = 0` → clase C
→ **cadencia 365 días**. El inventario de temporada, justo antes de la temporada, es lo que menos se
cuenta.

⭐⭐ **Y la cifra que ordena toda esta fase:**

| clase | SKUs | capital en existencia | cadencia |
|---|---:|---:|---:|
| A | 5,051 | $31,790,302 | 30 días |
| B | 6,946 | $11,305,379 | 90 días |
| **C** | **17,953** | **$20,853,794** | **365 días** |

**El 32.6% del capital está en la clase que se mira una vez al año.** Eso no es un defecto del
Pareto —hace bien su trabajo, que es ordenar por movimiento— es que **falta el otro eje**.

**Recomendación:** las dos parametrizaciones son **consumo** (la de hoy, que manda en el reabasto y
no se toca) y **capital parado** (nueva, que manda en el conteo). No ventas-vs-costo.

---

## 5. Plan de implementación

### Ruta crítica (lo que no se puede paralelizar)

```
IC.14  cerrar UN folio real  ──►  IC.15  tres ritmos coexisten  ──►  IC.16  el reloj por ritmo
   │                                                                      │
   └── (sin esto, IC.16 no tiene de dónde leer)                           └──► IC.18  el diario
```

---

### `[IC.14]` — El primer folio cerrado · ⛔ **ruta crítica, y no es código**

**Qué:** acompañar a una persona en **una** sucursal hasta que un folio cíclico de ~50 SKUs llegue a
`reconciled`. Clase A, sin congelar el almacén (ya es el default de `openCycleCount`).

**Por qué va primero:** desbloquea el reloj de la cadencia (§2.2), estrena el teórico del ODS de
IC.1 que nunca corrió, produce el primer dato de **productividad real** (SKUs por hora por persona)
—hoy no existe, y sin él cualquier «50 SKUs diarios» es un número inventado— y valida el export a
Kepler + su acuse (IC.7), que tampoco se ejerció nunca.

**Lo que puede salir mal y hay que mirar:** que `resolveProduct` no encuentre los códigos del piso
(el catálogo de conteo sale de `inventory.products` y el producto puede llegar con `product_id`
nulo); que el doble conteo ciego duplique el trabajo sin que nadie lo haya pedido; y que el guard de
varianza sin motivo frene el cierre si el folio se abrió con umbral.

**Aceptación:** un folio `reconciled`, el archivo de Kepler emitido **y acusado**, y la cifra de
SKUs/hora anotada. **Sin esto, lo de abajo se construye a ciegas.**

---

### `[IC.15]` — Tres ritmos en el mismo almacén · ⛔ ruta crítica

**El problema:** la llave de hoy es *un folio vivo por almacén*. Los ritmos diario y mensual chocan.

**El cambio:**

1. `commercial.inventory_counts` gana **`ritmo`** (`diario` | `mensual` | `total`), `NOT NULL`
   con `CHECK`, y el índice parcial pasa a `(tenant_id, warehouse_id, ritmo)`.
2. ⭐ **La llave real que falta: un SKU no puede estar en dos folios vivos a la vez.** Sin esto, el
   diario y el mensual pueden contar el mismo producto y el segundo en reconciliar pisa al primero
   — un ajuste de stock calculado contra un teórico que ya cambió. Se resuelve en el sembrado
   (`openCycleCount` excluye los `product_id` que ya estén en un folio vivo del almacén) **y** con
   un índice único parcial que lo haga imposible, no sólo improbable.
3. El folio `total` conserva el comportamiento de hoy: **uno solo, y mientras viva, los otros dos no
   se abren en ese almacén** (contar todo y contar una parte al mismo tiempo no tiene sentido).

**Candado:** prueba negativa obligatoria — dos folios del mismo ritmo en el mismo almacén deben
fallar; dos de ritmos distintos deben pasar; y el mismo SKU en dos folios vivos debe fallar **en la
base**, no sólo en el servicio.

---

### `[IC.16]` — El reloj, por ritmo y con arranque declarado · ⛔ ruta crítica

**El problema:** `last_counted_at = MAX(reconciled_at)` y no hay reconciliados → todo vencido.

**El cambio:** `last_counted_at` pasa a ser **por (almacén, producto, ritmo)**, y lo escribe el
cierre del folio. Mientras no haya historia, el estado **no es «vencido»: es `nunca_contado`**, que
es otra cosa y se muestra distinto (ADR-056: las dos ausencias no son la misma). Un SKU
`nunca_contado` entra a la cola por **prioridad**, no por vencimiento.

**Cadencias nuevas:** `diario` no tiene cadencia por SKU — tiene **cupo diario por sucursal**
(ver IC.18). `mensual` y `total` conservan la suya.

---

### `[IC.17]` — Materializar el motor diario · paralelizable

`analytics.mv_count_priority_score`, mismo patrón que IC.12: refresco nocturno, `UNIQUE` para
`REFRESH CONCURRENTLY`, umbral registrado en `CRON_JOBS`, `security_invoker` y `GRANT` re-aplicados.
**Aceptación: de 10,618 ms a <500 ms, con los mismos valores fila por fila** (candado de paridad
vista-vs-matvista, como el del sell-out en VP.1).

⚠️ Y de paso **declarar `senales_usadas`**: en 5 de los 9 almacenes el score se arma con 3 señales de
4. Un score de 3 señales y uno de 4 **no son comparables entre sí**, y hoy se publican en la misma
columna sin decirlo.

---

### `[IC.18]` — El ritmo diario · *productos top por sucursal*

**Motor:** `mv_count_priority_score`, que ya existe. **No se inventa una fórmula nueva.**

- Cron matutino por sucursal → folio `ritmo='diario'` con los **top N** por `score`, excluyendo lo
  que ya esté en un folio vivo (IC.15) y lo contado en los últimos *k* días (IC.16).
- **N arranca en 25 y se calibra con la productividad real de IC.14.** Sale a pantalla como
  parámetro por sucursal, no como constante en el código.
- ⛔ **Nunca congela el almacén.** Un conteo diario que para la operación no se hace dos veces.
- **Auto-cancelación al cierre del día:** un folio diario que no se cerró **se cancela solo** y sus
  SKUs vuelven a la cola de mañana. Sin esto, el primer día que alguien no termine, la sucursal
  queda bloqueada — y ésa es exactamente la historia de los 6 folios de §2.1.

**Lo que la pantalla tiene que decir:** cuántas señales sostienen cada fila, y que **el ritmo diario
sólo existe en 9 almacenes**.

---

### `[IC.19]` — El ritmo mensual · *mayor diferencia, y su causa*

**Motor:** `v_sku_count_variance_history`, que ya existe, ordenado por `pesos_abs` con `retencion` y
`patron` al lado.

⭐ **Lo que vuelve útil este ritmo no es contar otra vez: es el `patron`**, que ya está calculado y
hoy no llega a ninguna bandeja. Medido en prod:

| patrón | SKUs | $ abs | qué sugiere |
|---|---:|---:|---|
| `sobra` | 4,237 | $11,329,123 | ⚠️ contaminado por el costo de caja que IC.12 declaró |
| `se_compensa` | 1,175 | $6,913,145 | ⭐ **uno sube y otro baja: error de captura entre SKUs** |
| `mixto` | 1,755 | $3,891,382 | sin patrón estable |
| `merma` | 5,003 | $3,336,805 | pérdida sostenida |
| `sin_dinero` | 6,157 | $0 | descuadre sin valuación |

**`se_compensa` es la pista de causa raíz que pediste**, y está concentrada: **541 SKUs en la
sucursal 02 por $6.29 M**, contra $343 mil en la 03 y $173 mil en la 05. Un folio mensual que
**cuente los pares que se compensan juntos** es lo que separa «error de captura» de «merma real» —
hoy los dos se cuentan como descuadre.

- Cron mensual → folio `ritmo='mensual'` con el top por `pesos_abs`.
- Al resolver, el `reason_code` es **obligatorio** (el guard de varianza sin motivo ya existe: acá
  se enciende a propósito), y alimenta el *shrinkage por causa* del IRA (IC.8).
- **Sólo 6 almacenes (01–06).** 07, 08 y el CEDIS no tienen historia: se declaran, no se omiten.

---

### `[IC.20]` — El desglose del ABC

`analytics.v_abc_class` y `commercial.abc_classification` ganan: `rango_almacen`,
`skus_en_almacen`, `aporte_individual`, `distancia_al_corte` y `tiene_testigo` (que hoy se calcula
y se tira). La pantalla `/almacen/inventory/abc` pasa a explicar la clase fila por fila con la frase
de §4.2.

⚠️ **No se toca la definición del Pareto.** Vive en `v_abc_class` y es la que consume el reabasto
(`import-computed-reorder.js`: A=0.98 · B=0.95 · C=0.90). Tocarla acá movería el nivel de servicio
de toda la red sin que nadie lo pidiera.

⚠️ Y hay un hallazgo ya declarado en el código que esta pantalla **tiene que mostrar, no esconder**:
hay filas con demanda cero rotuladas `pareto`. Decir *«es C por su lugar en el Pareto»* sobre una
fila sin valor que ordenar es una explicación falsa.

---

### `[IC.21]` — El segundo eje: capital parado

`analytics.v_abc_capital` — mismo Pareto, métrica `existencia × costo_unitario`, **al lado** de la
de consumo, nunca en su lugar. Pantalla con la matriz cruzada de §4.4 y el foco en el cuadrante
**consumo C × capital A**: 98 SKUs / $1.63 M sólo en la 01.

**Y ahí es donde se conecta con los ritmos:** un SKU `consumo C` pero `capital A` **entra al ritmo
mensual aunque su cadencia diga 365 días**. Es el aporte concreto de este eje — si no cambia a quién
se cuenta, es una pantalla bonita.

⚠️ El costo unitario tiene cobertura desigual: `tiene_testigo` va de **2,855 (sucursal 04) a 4,718
(CEDIS)** sobre 9,215 filas con costo. El eje de capital **declara su cobertura** o repite el error
que la Fase MR ya pagó.

---

### `[IC.22]` — Que los tres ritmos se vean en un solo lugar

Una sola pantalla con los tres: qué toca hoy, qué toca este mes, cuándo fue el último trimestral de
Kepler, y **qué pasó con lo de ayer**. Reusa la lista de folios de `[IC.13]` (que ya trae avance,
última actividad y el chip de congelado) con un filtro por `ritmo`.

---

## 6. Lo que NO se construye, y por qué

| Lo descartado | Motivo |
|---|---|
| **ABC por ventas y ABC por costo como dos vistas** | Coinciden en **98.85%** (§4.3), y el costo de la mitad Kepler se deriva del ingreso. Serían dos pantallas de lo mismo |
| **Ritmo diario en los 28 almacenes** | `inventory_health` cubre 9. Las 19 `RUTA-*` no tienen demanda ni clase: un folio diario ahí no podría priorizar nada |
| **Tocar la fórmula del Pareto** | Fija el nivel de servicio de todo el reabasto. Fuera de alcance de una fase de conteo |
| **Escribir el ajuste en Kepler** | ADR-040. Sale el archivo, alguien lo captura, y el acuse de IC.7 lo cierra |
| **Arreglar el `sale_date` futuro de RUTA-22** | Defecto real, de otro dominio. Se reporta, no se toca acá |

---

## 7. Decisiones — resueltas el 2026-10-06, y las que siguen abiertas

### Resueltas (Edgar, 2026-10-06)

1. ✅ **El segundo eje es CAPITAL PARADO, no COGS.** Confirmado. `[IC.21]` se construye sobre
   `existencia × costo_unitario` (§4.4) y la parametrización literal «por ventas / por costo»
   **no se construye**: coinciden en 98.85% (§4.3).
2. ✅ **El encargado de sucursal asigna quién cuenta.** De ahí sale todo el modelo de permisos de
   `[IC.23]` — ver abajo.
3. ✅ **El acceso del piso de tienda queda resuelto** por `[IC.23]`, antes de `[IC.18]` como el
   plan exigía.

### `[IC.23]` — Lo que esa decisión obligó a construir · 🧪 EN CÓDIGO

**La pregunta real no era «¿le damos acceso?» sino «¿qué facultad es ésta?».**

`SUPERVISAR` abre `GET :id/items`, que devuelve `expected_qty` **fila por fila** — el teórico. Es
la misma puerta que `[IC.2]` le quitó al `almacenista` para no romper el conteo ciego. Dársela al
encargado lo pondría a saber el número antes que quien cuenta.

La facultad correcta es `ASIGNAR`: **armar el equipo y mirar el avance, sin ver contra qué se
cuenta.** Pero al ir a usarla aparecieron **tres gates mal partidos**, latentes porque hoy **nadie
tiene `ASIGNAR` sin `SUPERVISAR`** (medido: los 5 roles que la tienen, tienen las dos):

| Endpoint | Antes | Ahora | Por qué |
|---|---|---|---|
| `GET :id/assignments` | SUPERVISAR | **+ASIGNAR** | podía **escribir** la lista de asignados y no leerla |
| `GET :id/progress` | SUPERVISAR | **+ASIGNAR** | quien arma el equipo tiene que saber si alguien contó |
| `GET counts/:id/aisle-teams` | SUPERVISAR | **+ASIGNAR** | podía auto-generar un tablero **que no podía mirar** |
| `GET :id/items` | SUPERVISAR | ⛔ **sin cambio** | **es el teórico.** Lo que hace que las otras tres se puedan abrir |

Es el mismo patrón que `WMS-REC.9` corrigió en el Andén: *el gate estaba mal partido y le negaba el
trabajo a quien lo hace*. Se verificó que `getProgress` **sólo devuelve agregados** antes de
abrirlo — el teórico por SKU no sale por ahí.

⛔ **Y el callejón sin salida que la medición evitó.** El primer diseño mandaba al encargado a la
pantalla de **Equipos** (`:id/teams`, que ya era `ASIGNAR`). Medido: `generateTeams` **exige
pasillos activos**, y en prod **sólo Padre Hidalgo tiene pasillos (4); los otros 8 almacenes tienen
CERO**. Seis de los siete encargados habrían llegado a un *«No hay pasillos activos en este
almacén»*. La asignación vive ahora en un **diálogo de la lista de folios**, que no necesita
pasillos y funciona en los 9 almacenes.

**Migración** `20261006200000`: `encargado_tienda` gana `COMMERCIAL_INVENTORY_ASIGNAR`.
⚠️ **El patrón de siempre habría sido un no-op**: las migraciones de permisos sólo agregan donde la
clave falta (`-> 'KEY' IS NULL`), y acá la clave ya venía en **`false` explícito** — residuo de
guardar el mapa completo desde `/admin/roles`, la misma causa de `[LC.6.2]`. Se escribe `true`
sin condicionar a `IS NULL`, acotado a un rol nombrado. Pre-vuelo read-only contra prod: toca
**1 fila**, con prueba negativa (sobre un rol que ya lo tiene: **0 filas**) y verificación de que
`jsonb_set` **no toca ninguna otra clave**.

**Alcance: 7 personas, 6 sucursales** — claudia_pimentel (02), cynthia_lopez (01), luis_vazquez
(06), monica_mejia (01), rosaura_casias (07), tania_sanchez (05), veronica_magana (03).

### Abiertas

1. ⛔ **04 (Yurécuaro) y 08 (Morelia Abastos) no tienen encargado de tienda.** Ahí el ritmo diario
   no va a tener quién asigne. Es un hueco de **puesto**, no de código: no se tapa repartiendo el
   permiso a otro rol «parecido».
2. ⛔ **`ASIGNAR` no lleva alcance por sucursal.** Inventario no está migrado a `ScopeService`
   (`[ID.2]`), así que un encargado puede asignar en el folio de otra plaza. Los 7 **sí** tienen
   `warehouse_code`, o sea que el dato para acotarlo existe — falta la migración del dominio. No se
   simula un alcance que la capa de datos no aplica.
3. ⛔ **Abrir un folio sigue atado a ver el teórico.** `POST /open` y `/open-cycle` exigen
   `SUPERVISAR`, así que hasta que exista el cron de `[IC.18]` el folio diario lo tiene que abrir
   alguien de compras. Partir «abrir» de «ver el teórico» es una decisión de diseño de `[IC.18]`.
4. **¿A qué hora cuenta la tienda?** De eso sale el cupo diario (N=25 es propuesta, no medición).
5. **¿El diario usa doble conteo ciego?** Hoy es el default. En 25 SKUs diarios duplica el trabajo;
   recomiendo apagarlo para `diario` y dejarlo en `mensual` y `total`.
6. **El CEDIS no tiene clase A ni B** (no vende, distribuye). Su ritmo diario necesita otro criterio
   —probablemente capital parado, §4.4— o queda fuera.
7. ⚠️ **5 de 6 `almacenista` no tienen almacén asignado.** No frena el conteo (cuentan el folio al
   que se los asigna), pero sí frena cualquier alcance por sucursal del lado de quien cuenta.

---

## 8. Cómo se sabe que funcionó

No «las pantallas están arriba», sino:

| Métrica | Hoy | Meta |
|---|---:|---|
| Folios **reconciliados** | **0** | ≥1 (IC.14) · luego ≥20/mes |
| SKUs contados / SKUs abiertos | **0.04%** | >90% en el ritmo diario |
| Capital bajo cadencia anual | **$20.85 M (32.6%)** | <15%, moviendo capital-A a ritmo mensual |
| `v_count_priority_score` | 10,618 ms | <500 ms |
| Almacenes con 4 señales | 4 de 9 | declarado en pantalla en los 9 |
| `se_compensa` resuelto con causa | **0 de 1,175** | la 02 primero ($6.29 M) |

⚠️ **La primera fila es la única que importa.** Las otras cinco se pueden conseguir sin que nadie
cuente nada.

---

## Apéndice — de dónde sale cada cifra de este documento

Todo lo numérico se midió contra **prod** (`pg-prod`, `md:5434`) en modo lectura el 2026-10-06:
`commercial.inventory_counts` + `_items` (§2.1) · `cycleDue()` en
`inventory-abc.service.ts` (§2.2) · `pg_indexes` (§2.3) · `analytics.inventory_health`,
`v_sku_count_variance_history`, `v_count_priority_score` (§2.4) · `EXPLAIN ANALYZE` y corridas
cronometradas (§2.5) · `commercial.abc_classification` + `analytics.v_abc_class` (§4.1/4.2) ·
Pareto recalculado sobre `analytics.sales_daily` 90 d (§4.3) · Pareto sobre
`v_erp_stock_on_hand × v_erp_unit_cost` (§4.4).

⚠️ **Lo no medido, declarado:** la **productividad de conteo** (SKUs/hora/persona) no existe en
ningún lado porque nunca se cerró un folio. Todo número de cupo diario en este plan es una
**propuesta**, no una medición — y por eso IC.14 va primero.
