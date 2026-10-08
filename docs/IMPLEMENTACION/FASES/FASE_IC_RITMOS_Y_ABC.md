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
| **Diario · productos top por sucursal** | ⛔ **Esta fila decía que `v_count_priority_score` (IC.4) «es exactamente el motor que esto necesita». Medido el 2026-10-07, es falso** (ver `[IC.17]`): cubre el **5.5% del COGS con 4× el esfuerzo**, porque suma `s_venta` y `s_parado`, que se oponen. El motor del diario es **`analytics.sales_daily`**, el hecho de venta | Cadencia diaria (hoy A=30 · B=90 · C=365), el filtro de velocidad por `v_unit_truth`, el cupo en piezas, y quien abra el folio |
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
| **4** | ⛔ **El motor diario era el equivocado** (el score mezcla dos ritmos opuestos: cubre 5.5% del COGS con 4× el esfuerzo) | El diario contaría pilas que no se mueven | IC.18 — el motor pasa a `sales_daily`. El score queda **sólo** para el mensual, y ahí se materializa (IC.17 re-alcanzado) |
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

De dónde sale cada ingrediente, leído de `pg_get_viewdef` el 2026-10-07 (no de memoria):

| Ingrediente | Fuente real | Estado medido |
|---|---|---|
| `avg_daily_units` | `analytics.inventory_health` | ventana **90 días fijos** — ver §4.5 |
| `costo_unitario` | `analytics.v_erp_unit_cost` | **29,138 de 30,059 (96.9%) de `kepler_kdik` con `tiene_testigo`** |
| corte | Pareto por almacén | `(cum_value − annual_value) / total < 0.80` → A |

⚠️ **Corrección a una afirmación previa de esta misma fase:** el costo del ABC **no sale de
`catalog.products.cost_base`**. Sale de `v_erp_unit_cost`, que ya viene arbitrado según ADR-059.
Sólo 917 filas caen a `catalogo_neto` sin testigo (9 de ellas clase A) y 4 a
`catalogo_columnas_invertidas`. **El problema del `57009` es el peldaño** (`kdik.c16` viene en un
peldaño fijo que no siempre es el base — hallazgo de `[CE.8]`), no el catálogo.

Y el `clase_motivo` vivo, medido sobre los 30,059 pares: `pareto` 29,693 · `sin_demanda` 366 (**los
366 son del CEDIS**) · `sin_costo` **cero**. La cobertura de costo está sana; el defecto está en el
otro factor.

### 4.1b El eje XYZ ya existe — y hoy no discrimina

`inventory_health.xyz_class` (de `RA-PRO.2`) clasifica por variabilidad de la demanda (CV = σ/μ).
Medido en Padre Hidalgo:

| | X (estable) | Y (variable) | Z (errática) |
|---|---:|---:|---:|
| A | **12** | 158 | **536** |
| B | 0 | 17 | 1,158 |
| C | 0 | 0 | 2,142 |

**536 de 706 clase A son Z.** Con esa distribución XYZ no separa nada: sólo está diciendo que la
demanda de dulcería es errática, que ya se sabía. **No se usa como criterio de conteo** — se declara
acá para que nadie lo vuelva a proponer sin medirlo.

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

### 4.5 ⛔ La ventana de 90 días fijos rompe la clase en Morelia

`v_abc_class` divide siempre entre 90 días. Medido contra el COGS real de `analytics.sales_daily`
(últimos 30 días), el flujo que el ABC implica (`Σ annual_value / 365`) contra el que de verdad
ocurre:

| | 01 | 02 | 03 | 04 | 05 | 06 | **07** | **08** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| ABC ÷ COGS real | 0.64 | 0.95 | 0.90 | 0.93 | 1.20 | 0.61 | **0.30** | **0.22** |
| días reales con datos | 2,265 | 9,776 | 270 | 278 | 9,776 | 9,776 | **29** | **18** |

La causa está medida: `sales_daily` arranca el **8-sep en `07`** y el **19-sep en `08`**. Repartir 18
días de venta entre 90 subdeclara 5×. **La clase ABC de Morelia Madero y Morelia Abastos está mal
calculada por construcción**, y de ahí salen el 0.30 y el 0.22.

⛔ **El 0.61–0.64 de Padre Hidalgo y Canindo NO queda explicado** por la ventana: tienen años de
datos. Se declara sin causa establecida; no se inventa una.

**Arreglo:** dividir entre los **días reales con datos** del almacén, no entre 90, y **publicar
`window_days_efectivo`** al lado de la clase. Un almacén con 18 días de historia no produce la
misma clase que uno con 9,776, y eso tiene que decirlo la columna, no adivinarlo quien la lee.

### 4.6 ⭐ El ritmo decide el eje — y los dos ritmos PARTEN el catálogo

Con el diario corriendo todos los días y un mensual encima, la pregunta deja de ser *«¿cuál es el
mejor selector?»* y pasa a ser *«¿cómo se reparten el trabajo sin repetirlo?»*.

**Primero, un miedo que la medición descartó.** Se asumía que una lista diaria por flujo sería
siempre la misma y el mes entero se gastaría en 25 productos. Medido en PH, falso: el top-25 por
COGS **del día** repite sólo **9 a 15 de 25** semana contra semana (11 semanas, jul–sep), y acumula
**251 SKUs distintos en 30 días** (434 en 60, 510 en 84). **La cola rota sola; no hace falta
inventar rotación artificial.**

⚠️ Pero eso sólo vale si el selector es **lo que se movió ayer**, no el promedio de 30 días — ése da
una lista casi congelada. Y el de ayer es además el correcto por otra razón: **es donde la pista
está fresca**. Una diferencia de hoy se rastrea contra los tickets y las entradas de hoy; una de
hace 90 días no se rastrea contra nada. ⭐ **El producto del ritmo diario es la rastreabilidad, no
la detección.**

**La partición, medida en PH (3,238 SKUs con existencia):**

| | SKUs | piezas | capital | % del capital |
|---|---:|---:|---:|---:|
| Lo toca el **diario** (top-25 del día, 30 d) | 251 | 202,198 | $4,945,566 | **33.5%** |
| Queda para el **mensual** | **2,987** | 468,702 | **$9,800,638** | **66.5%** |

El diario se come un tercio del capital con el 8% de los productos. **Los otros dos tercios no los
ve nunca** — y ése es el trabajo del mensual, que por lo tanto **no se define por un ranking propio
sino por el complemento**.

| | Diario | Mensual |
|---|---|---|
| **Pregunta** | ¿cuadra lo que se movió? | ¿dónde se acumuló la diferencia? |
| **Selector** | COGS **de ayer**, descendente | el **complemento**: lo que el diario no tocó en *k* días |
| **Eje ABC** | **consumo** (§4.1, el que ya existe) | **capital parado** (§4.4, el eje nuevo) |
| **Desempate** | — | historial de descuadre (`[IC.3]`) |
| **Cupo** | presupuesto de **piezas** | presupuesto de **piezas** |
| **Entrega** | rastreabilidad | cobertura + dinero dormido |

⭐ **El diario no necesita la letra A/B/C**: `annual_value = flujo_diario × 365`, así que ordenar la
clase A por `annual_value` **es** ordenar por flujo. La letra sirve donde sí hay que elegir montón:
el mensual.

**La aritmética que hay que aceptar, no tapar.** Lo que el diario no toca son 2,987 SKUs:

| SKUs por sesión mensual | meses para una vuelta completa |
|---:|---:|
| 300 | **9** |
| 450 | 6 |
| 900 | 3 |

Con un cupo razonable **el mensual no da una vuelta al año**. No es un defecto del diseño: es el
tamaño real del problema. Quien cierra la cobertura es el trimestral de Kepler — que §2 ya midió que
**deja fuera 4,022 SKUs con existencia** (cobertura 69–93%). Ese hueco se **declara en la pantalla**.

⚠️ **El cupo de ambos ritmos sale de un dato que no existe: piezas por hora por persona.** Lo mide
`[IC.14]`. Hasta entonces el diseño queda parametrizado, no clavado — y «25 diarios» es, literal,
una propuesta y no una medición.

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

### `[IC.17]` — ⛔ RE-ALCANCE: el score **no** se materializa para el diario · paralelizable

> **Este sprint decía: «materializar `v_count_priority_score` porque es el motor del ritmo diario».
> La medición del 2026-10-07 lo tumbó.** El score no es el motor del diario (ver `[IC.18]`), así
> que materializarlo no desbloquea nada de la ruta crítica.

**Lo medido** (prod, 2026-10-07), top-25 de cada selector en Padre Hidalgo, contra el COGS real:

| Selector (top-25) | % del COGS diario | Piezas a contar | Mediana días de cobertura |
|---|---:|---:|---:|
| `v_count_priority_score` | **5.5%** | **94,739** | **93** |
| Clase A por `annual_value` | 32.3% | 23,758 | 19 |
| Flujo + rota ≤30 d | 31.1% | 9,660 | 13 |

**Cuatro veces el esfuerzo por una sexta parte del dinero.** Y la mediana de 93 días dice lo
esencial: **contar mañana un SKU con 93 días de cobertura es contar la misma pila.** En el CEDIS es
peor — los 25 del score tienen **cero venta** y 365 días de cobertura.

⭐ **La causa de fondo: el score suma dos ritmos que se oponen.** `s_venta` premia lo que rota;
`s_parado` premia lo que NO rota. Medido, sus top-25 comparten **0 a 5 de 25** en los 9 almacenes, y
la suma produce una lista que no es ninguna de las dos (`score ∩ venta` 3–12, `score ∩ parado` 1–8).
**Para el diario `s_parado` tiene que pesar cero** — es la señal del mensual.

Y el traslape contra lo que de verdad mueve el dinero confirma el veredicto:

| | 01 | 02 | 03 | 04 | 05 | 06 | 07 | 08 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| hecho ∩ clase A | 13 | 19 | 21 | 19 | 20 | 16 | 23 | 17 |
| **hecho ∩ score** | **4** | **3** | **4** | **6** | **2** | **3** | **8** | **8** |

**Qué queda de este sprint:** el score **se conserva como insumo del mensual** (donde `s_parado` sí
corresponde) y ahí sí se materializa, con el mismo patrón de IC.12 — refresco nocturno, `UNIQUE`
para `REFRESH CONCURRENTLY`, umbral en `CRON_JOBS`, `security_invoker` y `GRANT` re-aplicados.
Aceptación: de **7.9–9.3 s** (re-medido 2026-10-07) a <500 ms, con paridad fila por fila.

⚠️ Y **declarar `senales_usadas`**, que es peor de lo que decía esta fase: medido sobre los 30,059
pares, **sólo 8,722 (29%) tienen las 4 señales**; 19,033 vienen `sin_historia_de_conteo` y 2,852
`sin_datos`. Un score de 3 señales y uno de 4 **no son comparables**, y hoy comparten columna sin
decirlo.

---

### `[IC.18]` — El ritmo diario · *productos top por sucursal*

> ⛔ **Corregido el 2026-10-07.** Este sprint decía *«Motor: `mv_count_priority_score`, que ya
> existe. No se inventa una fórmula nueva.»* La medición lo desmintió (ver `[IC.17]`): el score
> cubre el 5.5% del COGS con 4× el esfuerzo. **El motor cambia.**

**Motor:** `analytics.sales_daily`, el **hecho de venta**. El folio de hoy se siembra con lo que se
vendió **ayer**, ordenado por `cost` descendente. No es una fórmula nueva: es el fact que ya manda
en el margen (ADR-051) y en la verdad absoluta (ADR-059).

**Por qué el hecho y no el catálogo:**

- Es **pesos**, así que es inmune a la unidad — el problema que infló al `57009` a $42,536/día
  cuando lo real son $4,594 (18.5× por el peldaño cubeta-vs-kilo).
- Es el **grano correcto**: producto × almacén × día.
- Es una **tabla con índices**, no una vista de 8 segundos.
- Y **rota sola**: 9–15 de 25 repiten semana contra semana, 251 SKUs distintos en 30 días (§4.6).

**Criterio completo:**

1. `cost` de ayer, descendente.
2. Filtro de velocidad: **días de cobertura ≤ 30**. Un SKU con 93 días de cobertura no cambia de un
   día a otro; contarlo a diario es recontar la misma pila. ⚠️ Este filtro **tiene que pasar por
   `analytics.v_unit_truth`** (ADR-057): existencia en cubetas sobre venta en kilos da una cobertura
   falsa.
3. Excluir lo que ya esté en un folio vivo (IC.15) y lo contado en los últimos *k* días (IC.16).
4. **Corte por presupuesto de PIEZAS, no por número de SKUs.**

⭐ **El cupo se mide en piezas.** «25 diarios» es la unidad equivocada: el top-25 de PH son **~18,400
piezas**; quitando los de cobertura >30 días quedan **18 SKUs / ~8,400 piezas / ~$38,000 de COGS**,
con mejor rendimiento por pieza ($4.55 contra $2.80). El presupuesto sale de la productividad real
de `[IC.14]`, y hasta entonces **el parámetro se declara sin medir**.

**Cuánto alcanza** (% del COGS diario real, medido): top-25 cubre **14–28%** según almacén; top-100
cubre **32–54%**. Entre **120 y 233 SKUs** son la mitad del dinero que se mueve cada día.

- ⛔ **Nunca congela el almacén.** Un conteo diario que para la operación no se hace dos veces.
- **Auto-cancelación al cierre del día:** un folio diario que no se cerró **se cancela solo** y sus
  SKUs vuelven a la cola de mañana. Sin esto, el primer día que alguien no termine, la sucursal
  queda bloqueada — y ésa es exactamente la historia de los 6 folios de §2.1.

**Lo que la pantalla tiene que decir:** el presupuesto de piezas y cuánto se consumió, que **el
ritmo diario sólo existe en 9 almacenes**, y el hueco de **venta sin costo** — 1–2% de los
renglones, $681/día en PH: no se puede rankear por dinero lo que no tiene costo, así que **se
declara, no se asume cero**.

---

### `[IC.19]` — El ritmo mensual · *mayor diferencia, y su causa*

> ⭐ **Re-definido el 2026-10-07.** Con el diario corriendo todos los días, el mensual **deja de
> tener un ranking propio y pasa a definirse por el COMPLEMENTO**: su universo es lo que el diario
> no alcanza. Medido en PH: el diario toca 251 SKUs (33.5% del capital); al mensual le quedan
> **2,987 SKUs, 468,702 piezas y $9,800,638 — el 66.5% del capital** (§4.6).

**Universo:** lo que el ritmo diario **no tocó** en los últimos *k* días.
**Orden:** `capital parado` (eje de `[IC.21]`) × evidencia de descuadre (`v_sku_count_variance_history`,
por `pesos_abs`, con `retencion` y `patron` al lado).
**Cupo:** presupuesto de piezas, igual que el diario.

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

#### ⭐ En Padre Hidalgo el dinero está en el SOBRANTE, no en la merma

Evidencia disponible para ordenar el mensual, medida sólo sobre PH el 2026-10-07:

| patrón | SKUs | descuadre histórico |
|---|---:|---:|
| **`sobra`** | 897 | **$4,246,558** |
| `merma` | 1,296 | $1,248,543 |
| `sin_dinero` | 668 | $0 |

**El sobrante carga 3.4× el dinero de la merma.** El reflejo es diseñar el inventario para cazar
robo; acá lo que hay es **producto que está y el sistema no sabe**. Enlaza con los $4.25 M de
sobrante de PH que §6 arrastra sin explicar — y es **el mensual, no el diario**, el que lo va a
encontrar, porque el sobrante se acumula justo donde nadie mira.

#### La aritmética del ciclo, que se acepta y no se tapa

Lo que el diario no toca son 2,987 SKUs. Con **una** sesión mensual:

| SKUs por sesión | meses para una vuelta completa |
|---:|---:|
| 300 | **9** |
| 450 | 6 |
| 900 | 3 |

⛔ **Con un cupo razonable el mensual no da una vuelta al año.** No es un defecto del diseño: es el
tamaño del problema. Quien cierra la cobertura es el trimestral de Kepler, que §2 midió que **deja
fuera 4,022 SKUs con existencia** (cobertura 69–93%). Ese hueco **se declara en la pantalla**.

- Cron mensual → folio `ritmo='mensual'` sobre el complemento del diario.
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

### `[IC.21]` — El segundo eje: capital parado · 🧪 EN CÓDIGO (2026-10-07)

`analytics.v_abc_capital` — mismo Pareto, métrica `existencia × costo_unitario`, **al lado** de la
de consumo, nunca en su lugar. Migración `20261007131819_v_abc_capital.js`.

**Y ahí es donde se conecta con los ritmos:** un SKU `consumo C` pero `capital A` **entra al ritmo
mensual aunque su cadencia diga 365 días**. Es el aporte concreto de este eje — si no cambia a quién
se cuenta, es una pantalla bonita. Medido en PH con la vista ya escrita: **108 SKUs** en ese
cuadrante.

**Medido al construirla (prod, 2026-10-07, lectura pura):**

| | |
|---|---|
| Reparto | A 5,598 (80.0%) · B 5,876 (15.0%) · C 10,087 (5.0%) |
| Capital total | **$64,497,408** en 9 almacenes · 21,561 filas |
| Cobertura de costo | **21,562 de 21,562** — no hay hueco `sin_costo` hoy |
| Veredicto del costo | `confirmado` 16,461 ($48.6 M) · `precio_movido` 4,617 ($13.2 M) · `contradicho_por_factor` **453 ($2.7 M)** · `sin_testigo` 31 |
| Acuerdo con el eje de consumo | **55.6%** — confirma el 56.7% de §4.4: no es un espejo |

⭐ **Este eje es estructuralmente más confiable que el de flujo**, y vale decir por qué: la
existencia y el costo salen **los dos de Kepler** (`unit_source='kepler'` y `erp='kepler'` en
21,562 de 21,562), o sea de la misma ficha y el mismo peldaño, así que el producto es
**conmensurable**. El eje de flujo no tiene esa propiedad — ahí `avg_daily_units` viene del peldaño
*vendido* y el costo de la ficha, que es lo que infló al `57009` 9.3×.

⛔ **La regla que esta vista NO hereda de su hermana.** `v_abc_class` hace
`COALESCE(costo_unitario, 0)`: un costo desconocido se vuelve valor 0 y el SKU **cae a C en
silencio**. Para el capital sería peor — una tarima de 5,000 piezas publicada como $0. Acá el
capital sin costo es **NULL**, la clase es **NULL** y `clase_motivo` dice `sin_costo` (ADR-056).

⚠️ **Y como hoy no hay ninguna fila sin costo, ese camino nunca se ejerce solo.** El candado
`test-newdb-abc-capital.js` **inyecta una fila sintética** de 5,000 piezas sin costo sobre el SELECT
de la migración (leído del archivo, no copiado). **Mutado a rojo**: reintroduciendo el `COALESCE`
pasa de **15 ✓ / 0 ✗** a **13 ✓ / 2 ✗**, con `capital = 0.00` y `clase = C` — exit 1 contra exit 0.

⭐ El candado también vigila que este eje **contradiga** al de consumo (coincidencia <90%): *un
árbitro que nunca contradice es un espejo* (ADR-059). Es el modo de falla que esta fase ya pagó una
vez con el placebo de §4.3.

⚠️ **453 filas ($2,725,042) traen `costo_veredicto = 'contradicho_por_factor'`.** Se publican **con
su veredicto al lado**, no se esconden ni se corrigen: el costo se arregla en Kepler (ADR-040).

⚠️ **La vista publica de más que su hermana**: `rango_almacen`, `skus_en_almacen` y
`aporte_individual` — las tres piezas que `[IC.20]` pide y que `v_abc_class` calcula y tira. Acá
nacen publicadas, así que IC.20 se reduce a hacer lo mismo del lado de consumo.

#### `[IC.21.1]` — 🚀 EN PROD (batch 793) · y el incidente que lo hizo falta

**Aplicada a prod el 2026-10-07.** Pero el camino dejó dos lecciones que valen más que la vista.

**(1) ⛔ Una guarda de migración no puede costar lo que cuesta la pantalla.** La migración original
barría la vista entera (9 almacenes) **dentro de su transacción, con el candado global de
migraciones tomado**. Afuera eso son 2 s; adentro, con un backfill del ODS escribiendo en paralelo,
fueron **8 minutos** — la transacción larga ve un snapshot viejo y recorre las versiones nuevas.
Peor: el `kubectl exec` se desconectó, la salida se perdió y el harness reportó **exit 0** mientras
el proceso seguía vivo sosteniendo el candado. El segundo intento murió con `lock timeout` y knex
invitó a `migrate:unlock` — ⛔ **hacerlo habría abortado una migración ajena**; `pg_locks` mostró
que el pid era **el mío**. *Al candado de migraciones se le pregunta por `pg_locks`, no por su
propia columna* (`is_locked` leía **0** todo el tiempo).

**(2) ⭐⭐ Corregir una migración editándola sólo sirve si todavía no se aplicó.** A las 15:36 se
aplicó a prod la versión que leía `v_erp_unit_cost` (la **vista**); a las 15:43 el PR #302 corrigió
ese mismo archivo para leer `mv_erp_unit_cost` (la **matvista**) — pero **editó una migración ya
aplicada**, y knex no vuelve a correr un archivo cuyo nombre ya está en `knex_migrations`. El repo
quedó correcto y **prod se quedaba con la definición lenta, para siempre**, sin que ninguna prueba
lo notara: cada lado se ve sano por separado. Por eso existe la migración nueva
`20261007190932_v_abc_capital_matvista.js`, con guarda **acotada a un almacén** (el delator «un
Pareto siempre produce B» vale igual por almacén) y las aserciones de población completa en el
candado, que corre **fuera** de todo candado.

**Medido después de aplicar:** la vista entera **2,900 → 572 ms**; un almacén **1,946 → 677 ms**;
la migración corrió en **1.0 s** contra los 8 minutos. Candado contra prod: **18 ✓ / 0 ✗ / 0 no
medidos** — `security_invoker` y el `GRANT` verificados en vivo, y la coincidencia con el eje de
consumo en **53.1%**, o sea que contradice y no es un espejo.

⚠️ **Rendimiento, declarado:** ~572 ms sigue **por encima del gate de 500 ms** de una interfaz.
Alcanza de sobra para el cron mensual de `[IC.19]`, que es quien consume este eje; **una pantalla
necesita foto**, y ésa es pieza aparte — no se declara hecha acá. Para referencia, la hermana
`v_abc_class` tampoco pasa el gate (1,424 ms) y nadie lo nota porque la app lee
`commercial.abc_classification` en **13 ms**.

**(3) ⭐ Y un defecto del propio candado, que pasaba en verde por la razón equivocada.** La prueba
negativa sustituía las fuentes **nombrándolas a mano**; cuando el costo cambió a la matvista, el
reemplazo dejó de encontrarlas, el SELECT quedó unido contra la fuente **real** y las cuatro filas
sintéticas volvieron `sin_costo`. Eso puso en verde **tres de las cuatro** aserciones negativas
afirmando «capital NULL» y «clase NULL» sobre filas que llegaban NULL **por el motivo contrario al
que se probaba**. Sólo la de `CARO` se puso roja y lo delató. Ahora las fuentes se **derivan del
propio SQL**, con un control de arnés que falla ruidosamente si queda una referencia a `analytics.`.

---

### `[IC.22]` — Que los tres ritmos se vean en un solo lugar

Una sola pantalla con los tres: qué toca hoy, qué toca este mes, cuándo fue el último trimestral de
Kepler, y **qué pasó con lo de ayer**. Reusa la lista de folios de `[IC.13]` (que ya trae avance,
última actividad y el chip de congelado) con un filtro por `ritmo`.

#### `[IC.22.1]` — El área Conteo, en orden de proceso · 🧪 EN CÓDIGO (2026-10-07)

Primer paso, y **no requiere ninguna pantalla nueva**: la barra del área ya tenía las piezas, pero
en un orden que no era ninguna secuencia — `Folios · Cíclico (ABC) · Pasillos · Exactitud ·
Diferencias` mezclaba el trabajo de hoy, la configuración del almacén y el resultado del trimestre.

Cada posición se decidió **mirando qué pregunta contesta la pantalla**, verificada contra su
componente en `app.routes.ts`, no contra su nombre:

| # | Pantalla | Qué contesta | Por qué ahí |
|---|---|---|---|
| 1 | **Programa** (`inventory/abc`) | ¿qué toca contar? | Es la **agenda** — la ruta es «clasificación ABC + agenda», no un reporte. Abre el ciclo |
| 2 | **Folios** | ¿qué se cuenta y quién? | Abrir, asignar, seguir |
| — | *(Contar)* | el acto de contar | Vive en `focusEntries`: si fuera tab, al entrar desaparecería la barra |
| 3 | **Diferencias** | ¿qué salió descuadrado? | El trimestral de Kepler, tercero de los tres ritmos |
| 4 | **Exactitud (IRA)** | ¿estamos mejorando? | El resultado va después de lo que lo produce |
| 5 | **Pasillos** | cómo está organizado el almacén | ⛔ **No es un paso del ciclo: es configuración** (editor 2D + mapeo SKU→pasillo) |

⚠️ **`Cíclico (ABC)` pasa a llamarse `Programa`**: la etiqueta vieja nombraba el **método** (Pareto
ABC) y no la pregunta. **La ruta no cambia** — los deep-links siguen vivos, y el candado lo verifica.

⛔ **El hallazgo que obligó a separar dos conceptos.** `almacenLandingCandidates` lee **el mismo
array** para decidir dónde aterriza el item del sidebar, o sea que **reordenar la barra mueve el
punto de entrada de gente real**. Medido contra prod: poner *Programa* primero movía a **5 roles /
15 personas** (superadmin, compras, gerente_compras, marketing, supervisor) de *Folios* a *Programa*.

Y hoy eso sería **peor que antes**, por una razón que esta misma fase midió: **el reloj de la
cadencia nunca arrancó** (§2.2 — `last_counted_at` cuelga de `MAX(reconciled_at)` y no hay un solo
folio reconciliado), así que *Programa* publica el catálogo entero como vencido. Aterrizar a alguien
en una pantalla que grita «39,480 pendientes» no es un punto de entrada: es ruido con permiso.

**Solución: `AlmacenArea.landing`** — el **orden de lectura** (el proceso) y el **punto de entrada**
(qué querés ver al llegar) son preguntas distintas, y forzarlas a coincidir degrada una de las dos.
⭐ **Con condición de retiro escrita:** cuando `[IC.16]` ponga el reloj por ritmo, *Programa* deja de
mentir y **esa lista se borra** — el aterrizaje vuelve al default y pasa a coincidir con el inicio
del proceso. El cambio es borrarla, no agregar otra cosa.

**Candado** (`almacen-tabs.spec.ts`, 17 ✓ en total): la aserción que de verdad protege esto no es
«el orden es el que quiero» sino **«el aterrizaje de NADIE cambió»**, probada contra las **16
combinaciones** posibles de los 4 permisos —no contra los 11 roles de hoy, para que un rol nuevo no
pueda romperla en silencio— más un **control de arnés** que exige que los dos órdenes SÍ se
distingan (si no, esa prueba pasaría por vacía). **Mutado a rojo**: quitando el desvío, **8 de 16
combinaciones** se mueven y la suite falla. `nx test view` completo: **2,066 ✓ / 0 ✗**.

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

**Segunda ronda, 2026-10-07** (misma conexión, lectura pura), que es la que corrige `[IC.17]`,
`[IC.18]` y `[IC.19]`:

| Afirmación | Cómo se midió |
|---|---|
| Definición real del ABC (§4.1) | `pg_get_viewdef('analytics.v_abc_class')` |
| Costo `kepler_kdik` con testigo 96.9% | `v_abc_class` agrupada por `costo_source`/`tiene_testigo` (59 s) |
| Matriz ABC × XYZ (§4.1b) | `abc_classification` ⋈ `inventory_health.xyz_class`, PH |
| ABC ÷ COGS real por almacén (§4.5) | `Σ annual_value/365` contra `Σ sales_daily.cost / 30` |
| Arranque de `sales_daily` por almacén (§4.5) | `MIN(sale_date)` por `warehouse_id` |
| Traslape de señales y selectores (§4.6, IC.17) | top-25 de cada criterio, 9 almacenes |
| Rotación semanal 9–15 de 25 (§4.6) | top-25 por `cost` por semana, 11 semanas jul–sep, PH |
| 251 vs 2,987 SKUs y el 33.5%/66.5% (§4.6) | top-25 **del día** acumulado 30 d contra `inventory_health` |
| Cobertura 14–28% / 32–54% (IC.18) | `row_number()` sobre `sales_daily.cost` 30 d por almacén |
| `sobra` $4.25 M vs `merma` $1.25 M (IC.19) | `v_sku_count_variance_history` agrupada por `patron`, PH |

⚠️ **Lo no medido, declarado:**

- La **productividad de conteo** (piezas/hora/persona) no existe en ningún lado porque nunca se
  cerró un folio. Todo número de cupo en este plan es una **propuesta**, no una medición — y por eso
  IC.14 va primero.
- **El 0.61–0.64 de PH y Canindo** en §4.5 no tiene causa establecida. Se declara así.
- **Venta sin costo**: 1–2% de los renglones de `sales_daily` ($681/día en PH). No se puede rankear
  por dinero lo que no tiene costo.
- **Los días de cobertura mezclan unidades** en los casos tipo `57009` (existencia en cubetas, venta
  en kilos). El filtro de velocidad de IC.18 **tiene que pasar por `analytics.v_unit_truth`**.

⛔ **Una hipótesis propia que la medición refutó, anotada para que nadie la reconstruya:** supuse
que los SKUs con la unidad rota secuestraban la cabeza del ranking por `annual_value`. Medido, son
**1 a 4 de cada top-25** contra 7–25 por almacén — hay sobrerrepresentación de ~2×, **no secuestro**.
El caso `57009` es real y es grave, pero es individual, no sistémico.
