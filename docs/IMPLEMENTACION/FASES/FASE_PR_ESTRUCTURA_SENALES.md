# Motor de Margen · Capas 1, 2 y 3 — **Estructura, Datos y Lógica**

> Método pedido por Edgar (2026-09-30): estructura → datos → lógica → visual, y **no se brinca
> de capa hasta terminar la anterior**.
>
> ⚠️ **Una advertencia que el repo ya pagó:** ADR-056 rechaza *"reordenar en capas"* como
> solución — *"MR.5 tenía capas limpias y publicaba 3.3 pp de margen falso"*. Las capas ordenan
> el trabajo; **no garantizan que el número sea cierto**. Por eso cada capa acá lleva su
> medición y su prueba negativa.

---

## 0 · ⭐ Qué significa "la capa completa"

| capa | cuándo está completa | cómo se verifica |
|---|---|---|
| **1 · Estructura** | el contrato de la señal vive en una **tabla**, no en este documento | el candado cruza lo declarado contra lo que existe |
| **2 · Datos** | ⭐⭐ **cero señales en estado `disponible`** | un `throw` en la migración |

⭐⭐ **La definición operativa de la capa 2**, y la razón de que sea ésa:

> Una señal `disponible` —la fuente **existe**, está **poblada** y **nadie la lee**— es el peor
> de los cuatro estados. No es un hueco visible: el motor decide sin ella **creyendo que no hay
> más**. Al cerrar la capa, cada fuente que existe o **se lee**, o **se midió y se cerró con su
> número escrito**.

**Estado al cerrar (batches 612-614, 2026-09-30):**

| estado | señales | qué significa |
|---|---|---|
| **cableada** | **28** | el motor la lee hoy |
| ⭐⭐ **disponible** | **0** | *la capa 2 está completa* |
| **refutada** | **2** | se midió y **no aporta** — cobertura 0 y peso 0 |
| ⛔ **no existe** | **16** | hay que construirla, **cada una con su motivo escrito** |
| | **46** | de las cuales **35** son núcleo del v1 |

---

## 1 · ⭐⭐ Cuatro coberturas ya publicadas estaban infladas

El registro nació con la cobertura **tecleada por familia**. Al medirla **por señal** —contra la
columna que cada una declara— cuatro de las dieciséis no daban:

| señal | decía | mide | por qué |
|---|--:|--:|---|
| **B6 rotación** | 100 % | **23.2 %** | ⛔ `unidades_30d` es NULL donde no hubo venta en 30 días: **tres de cada cuatro celdas** |
| **A3 antigüedad del costo** | 38.2 % | **17.7 %** | la familia del costo cubre 38.2 %, pero la **fecha** de la última compra —que *es* la señal— existe en menos de la mitad |
| **A9 días regalados** | 6.0 % | **1.1 %** | la cascada ve el 6 %, pero restar *pagado − pactado* exige las dos |
| **D2 dígito izquierdo** | 100 % | **90.5 %** | |

> ### ⭐ La regla que faltaba
> **La cobertura de una FAMILIA es la de su ancla; cada señal puede tener menos.** Declarar la
> de la familia para todas es prometer evidencia que esa señal no tiene — y como el **techo del
> peso** sale de ahí (`peso_max ≤ cobertura/100`), el error **no se queda en la documentación:
> llega al motor**. Con B6 al 100 %, la capa lógica podía pesar la rotación en **1.0** sobre un
> dato ausente en el 76.8 % de las celdas.

⭐⭐ **Por eso la migración ya no recibe la cobertura: la calcula** contra `v_price_signals`. Un
número tecleado envejece en silencio; uno derivado de la columna que la señal apunta no puede
mentir sin que la columna cambie. Y el candado lo **recalcula en cada corrida**.

---

## 2 · ⛔ A5 no se cableó — y la primera prueba fue circular

`v_supplier_cost_ladder` iba a traer *"la escalera del proveedor: comprar mejor habilita vender
mejor"*. **No existe tal escalera.**

⛔ **El primer intento de comprobarlo no probaba nada:** comparé `u1_cost` contra
`box_cost/units_per_box` y dio **100.00 % de identidad** — porque esa vista **define**
`units_per_box` como `box_cost/u1_cost`. *Verificar una vista contra sí misma la pone verde
siempre.*

La prueba buena cruza el costo **crudo** del proveedor (`kdpv_prov_prod.c8`/`c9`) contra un
**testigo independiente**: el factor de unidades **capturado en `kdii`**.

| resultado | SKUs | razón media |
|---|--:|--:|
| **= el factor EXACTO** → cero descuento por volumen | **6,394 (98.5 %)** | **0.99999** |
| "la caja trae descuento" | 96 | **0.072** — no es un 7 %, es una **escalera corrida** |
| al revés | 3 | mismo artefacto invertido |

Cablearla publicaría **una constante disfrazada de señal**. Pasa a `refutada`, con **cobertura 0
y peso 0** aunque su fuente tenga 9,651 filas: *lo que no aporta información no puede pesar, por
muchas filas que tenga.*

⭐ El candado **la re-mide en cada corrida**: si algún día el proveedor sí diera descuento por
volumen, se pone rojo en vez de dejar la señal cerrada para siempre por una medición de hoy.

**El estado nuevo:** `refutada` separa *"todavía no se construyó"* de *"se midió y no aporta"*.
Las dos vivían mezcladas, y mandan a la próxima persona a caminar caminos distintos. **F1**
(precio de competencia) ya decía *"REFUTADO con medición"* dentro de un motivo de `no_existe`:
el concepto existía y estaba en la gaveta equivocada.

---

## 3 · Las 12 señales que esta capa cableó

Ninguna fuente nueva: todas existían y nadie las leía.

| familia | cobertura | señales | fuente | ⚠️ |
|---|--:|---|---|---|
| **f5 inventario** | 34.0 % | E1 cobertura · E3 sobrestock · G2 clase ABC | `inventory_health` + `v_abc_class` | ⭐ el puente de llaves |
| **f6 demanda** | 61.3 % | B3 estacionalidad · B5 momentum | `demand_acceleration` | ⚠️ **grano SKU, no plaza** |
| **f7 historial** | 35.9 % | D5 frecuencia · D6 fatiga | `v_label_price_changes` | |
| **f8 escalera** | 100 % | D8 coherencia | `v_kepler_unit_ladder` | ⭐ **717 incoherentes** |
| **f9 merma** | 12.1 % | A10 roll-forward | `mv_erp_count_rollforward` | ⛔ hasta 6 periodos por celda |
| **f10 canasta** | 25.4 % | B10 arrastre | `product_affinity` | ⚠️ **sólo retail** |
| **f11 promoción** | 100 % | G5 regla vigente | `v_erp_discount_rules` | ⭐ catálogo |
| **f12 faltantes** | 22.2 % | E4 lo que el mostrador reportó | `floor_stockouts` | ⛔ captura |

### ⭐ El puente de llaves, en un solo lugar

`inventory_health` y `v_abc_class` viven en `(warehouse_id, product_id)`; las señales en
`(sucursal, sku)`. **`warehouses.kepler_code` es la única columna que los une**, y se verificó
**único**: 29,355 filas → 29,355 celdas, 0 SKUs ambiguos.

⛔ **La sucursal `00` de Kepler es OFICINAS** y no tiene almacén con `kepler_code`: sus 9,592
celdas quedan sin inventario **a propósito**, y lo dice su motivo — no por un join roto.

### ⭐⭐ Dos fuentes que parecen iguales y NO lo son

> **`v_erp_discount_rules` es un CATÁLOGO**: se lee entero, así que una celda sin regla **no es
> una ausencia** — es el hecho de que no hay promoción. Cobertura `completa` siempre.
>
> **`floor_stockouts` es una CAPTURA**: una celda sin reporte puede significar que no faltó
> nada, **o que en esa plaza nadie reporta**. Medido: **2 de 9 plazas**. Tratarlas igual
> publicaría *"aquí no falta nada"* sobre siete plazas donde nadie ha mirado.

### Dos trampas de forma que el gate atrapó

- ⛔ **El roll-forward multiplica filas**: una celda tiene hasta **6 periodos**, y el LEFT JOIN
  sin agregar llevaba la vista de **86,163 a 98,383 filas**. El gate exige el grano exacto.
- ⛔ **`no_recontado` se excluye**: son periodos **sin conteo final**, o sea mediciones que no
  ocurrieron. Sumarlas como si cuadraran es dibujar un cero. Y la vista distingue
  `contado_sin_recontar` de `sin_evidencia_de_conteo` — *una celda que se contó y no se recontó
  no es una celda que nunca se contó: la primera se cierra con un conteo, la segunda ni siquiera
  está en el programa.*

⚠️ **Corrección al registro:** el motivo de G5 decía *"4 mecanismos, 2 con umbral NO
verificado"*. Medido hoy: las **338** reglas son `descuento_cantidad` y las 338 traen
`umbral_verificado = true`. La advertencia describía otra ventana.

---

## 4 · ⛔⛔ Las 28 señales rompieron el plan del planner — y ahí está el hallazgo

El barrido completo de la vista quedó bien. Lo que se rompió es **lo único que una pantalla hace
de verdad**:

```
WHERE sucursal = '03' ORDER BY venta_30d DESC LIMIT 50

  · con 16 señales ..........   1,622 ms
  · con 28 señales ...... 118,754 ms      ⛔ 73×
  · materializada ...........       8 ms
```

⭐ **No es volumen: es el `LIMIT`.** Con 14 joins el planner cree que un plan de arranque rápido
le sale barato, elige bucles anidados sobre CTEs que no puede podar, y falla. Agregar señales
cruzó el punto donde esa apuesta deja de pagar — y **ninguna reescritura lo arregla de forma
estable**: la próxima señal lo vuelve a cruzar.

⚠️ **La primera medición de esto dio 56 s y estaba MAL.** Envolví el cuerpo de la vista en otro
`WITH`, que no es como el planner ve una vista. *Un arnés que no reproduce el entorno real mide
otra cosa.* El número bueno sale con el predicado aplicado al `SELECT` exterior.

### ⚠️ Esto contradice lo que yo mismo escribí tres horas antes

En `mv_price_waterfall_sku` dejé escrito: *"se materializa SOLO esta pieza; materializar la vista
entera congelaría también la psicología y el costo, que corren en milisegundos"*.

Era cierto **para el problema de entonces**, que era **costo**. Éste es otro: el plan se desarma
bajo un `LIMIT`, y contra eso la frescura de la psicología no compra nada — **una pantalla que
tarda dos minutos no publica un dato fresco, publica ninguno.**

⛔ **El precio se paga y se declara**: psicología y costo pasan a ser *de la última corrida*. Va
en `calculado_al`, que viaja con cada fila.

⭐ **La vista NO se retira**: se queda como la **definición** —es lo que el registro verifica
columna por columna— y la matvista es literalmente `SELECT * FROM` ella. Cero lógica duplicada.

---

## 5 · ⛔ Dos matvistas nacieron sin carril que las refrescara

`mv_price_waterfall_sku` se materializó el 2026-09-30 y **quedó fuera del array de refresco** —
el mismo defecto que el comentario de `mv_erp_margin_daily` documenta, repetido **tres párrafos
después de leerlo**.

Una matvista que nadie refresca **no se ve rota: se ve igual**, publicando el descuento por
cliente del día que se creó. Las dos entran ahora al nocturno con su umbral en `CRON_JOBS` — sin
umbral, `db-health` cae en `cfg ? classify : 'ok'` y una MV parada se ve **verde** (OBS.1).

⭐ Y `mv_price_signals` declara sus **dependencias**, que es lo que separa *ordenar* de
*depender* (ADR-056): lee tres matvistas, y si una no se refrescó, publicar señales igual
mezclaría una pierna de hoy con dos de ayer. **La mezcla no se ve — se ve completa.**

---

## 6 · El grano y las coberturas incomparables

⭐ **El grano canónico es `(sucursal, sku)`** — 86,163 celdas. Es donde vive la decisión de
precio: se fija un precio por producto y plaza, no por renglón de factura ni por peldaño.

| reducción | cómo | ⛔ qué se pierde, declarado |
|---|---|---|
| **peldaño → sku** | el **más vendido** en la ventana, no el base | el margen difiere hasta **8 pp**; se publica `peldano_mixto` y `u1_fuente_peldano` |
| **línea de factura → sku** | ponderada por importe | el descuento por cliente: se publica la **dispersión**, no sólo la media |

### ⛔⛔ Las coberturas son incomparables, y eso decide la arquitectura

```
psicología 100.0 %  ·  escalera 100 %  ·  promoción 100 %
meta 97.5 %  ·  demanda 61.3 %  ·  historial 35.9 %  ·  inventario 34.0 %
costo 38.2 %  ·  canasta 25.4 %  ·  faltantes 22.2 %  ·  merma 12.1 %
⛔ cliente 6.0 %
```

**La cascada sólo ve dos tipos de documento**: `UD0801` telemarketing ($10.96 M) y `UD1201`
crédito ($1.36 M) = **~33 % de la venta**. El mostrador —dos tercios— es **contado anónimo**: sin
cliente no hay fuga por cliente que medir. Es un límite de la fuente, no del diseño.

> ### ⭐ La consecuencia: **no hay un solo score**
> Una señal al **6 %** y una al **100 %** no se pueden sumar en un número. Un motor que
> promediara la fuga con la terminación estaría decidiendo el precio del **mostrador** con
> evidencia que **no lo incluye**, y el resultado se vería igual de confiable que cualquier otro.
>
> Por eso el motor publica **un veredicto por familia**, cada uno con su cobertura al lado, y
> **el peso de una señal nunca puede exceder su cobertura** — en un `CHECK`, no en un `const`.

⭐ El candado exige que las coberturas **DIFIERAN**: si dos familias dieran lo mismo, algún
`LEFT JOIN` se estaría comportando como `INNER`.

---

## 7 · Qué se aplicó y qué lo verifica

| batch | migración | qué |
|---|---|---|
| 611 | `20260930200000_price_signal_registry.js` | el registro ejecutable de las 46 |
| **612** | `20260930210000_price_signals_v3.js` | **las 12 señales nuevas** |
| **613** | `20260930210100_mv_price_signals.js` | **la matvista** — 118,754 → 8 ms |
| **614** | `20260930210200_price_signal_registry_capa2.js` | el estado `refutada` + la cobertura **medida** + ⭐ el gate de cero `disponible` |

**`database/tests/test-newdb-price-signals.js` — 37 ✓ / 0 ✗ / 1 no medido** contra prod.

⭐ Lo que hace y un documento no puede:
- **recalcula** las 27 coberturas desde la vista (la 28ª, E4, es la única excepción y va nombrada);
- **cruza las DOS implementaciones** —vista y matvista— en una plaza, porque verificar un objeto
  contra sí mismo pasa bugs en verde. Grano y veredictos **exactos**; los valores con la deriva
  por envejecimiento **medida y publicada** (0.0053 % en su primera corrida);
- **re-mide la refutación de A5** contra su testigo independiente;
- mide la consulta que corre **la pantalla**, no un barrido que nadie hace.

⚠️ **Lo que NO se pudo medir se declara:** las 8 pruebas negativas del registro (romper cada
`CHECK` a propósito) no corren contra prod porque la sesión es de **sólo lectura**. Contra prod
se verifica que los `CHECK` **existen y dicen lo que deben**, leyendo el catálogo; romperlos
corre contra un destino escribible. *Un gate sin prueba negativa es una intención — pero una
prueba que no se pudo correr se declara, no se pinta verde.*

---

## 8 · ⛔ A4 dejó de no existir — y la capa 2 tenía un hueco que se abrió solo

A4 —el **árbitro del costo** de ADR-059— estaba en `no_existe` con este motivo, escrito esa misma
mañana: *«`mv_erp_margin_daily` existe pero nunca se pobló (`relispopulated = false`)»*.

**Por la tarde ya era falso**: poblada, **889,806 filas**, 97.28 % de los renglones con costo. La
llenó el carril que `[PR.R1]` cableó. ⭐ Un markdown con esa frase adentro la seguiría diciendo
hoy; el registro la volvió a medir. Y el hueco no era menor: A4 cubre **22.9 % de las celdas pero
el 99.3 % de la venta**.

⭐⭐ **La regla de medición se mudó a la tabla.** `[PR.S1.2]` dejó la lista de «qué expresión mide
cada señal» *dentro de la migración* — una regla que vive en un archivo ya corrido es una regla
que la siguiente migración tiene que **copiar**, y una copia diverge. Ahora vive en
`cobertura_expr`, con un filtro conservador porque se arma SQL desde una columna.

> ### ⭐⭐ Y lo que A4 destapó cambia el diseño del motor
> Margen **realizado 14.83 %** contra meta de la ficha **11.30 %** — sobre 19,553 celdas y
> $25.6 M de venta. **La diferencia va al revés de lo que cualquiera supondría**, es sistemática
> (mediana **+6.14 pp**, 16,275 celdas contra 391) y se repite en **las 8 plazas**.
>
> ⛔ `m1_meta_margen` **no es una meta que alcanzar: es un piso que ya se supera.** Un motor que
> «cerrara la brecha contra la meta» propondría **bajar** precios.

⛔ Lo que **no** se publica: el costo por unidad del árbitro contra el de la ficha. Razón mediana
**3.2301** en 2,528 celdas y **0.6842** en 1,820 — eso es el **peldaño**, no una diferencia de
costo. El margen sí es comparable porque las dos piernas son dinero de los mismos renglones.

---

## 9 · Capa 3 · **Lógica** — y no es un optimizador

### ⛔⛔ Tres diseños de motor, medidos y refutados

| # | diseño | prometía | por qué cayó |
|---|---|--:|---|
| **1** | el sugerido del ERP (`v_price_suggestion`, escrito el 29-sep, nunca aplicado) | — | ⛔ **es idénticamente la deriva de costo**: `precio_sug/precio_actual = costo_hoy/costo_ficha`, el markup y el impuesto **se cancelan**. Verificado en **32,878 de 32,878 celdas (100.00 %)**. Dice «al día» sobre **$29.4 M** —78 % de la venta— y propone **bajar** en $3.76 M |
| **2** | grupo par por plaza (el mismo SKU rinde más en otra sucursal) | $4.45 M anual | ⛔ **el placebo lo mató**: agrupar las celdas **al azar** da una brecha **mayor** ($878,959 contra $365,802, razón **0.42×**). La «oportunidad» era el artefacto de medir distancia a un percentil alto dentro de cualquier grupo con dispersión |
| **3** | fuga de descuento entre clientes (spread 7.23 %) | ~$8 M | ⛔ **369 de 461 celdas (80 %)** muestran «más volumen = menor precio»: eso es **política de descuento**, no fuga. Quedan **13 invertidas por $125,802**, que son un error con monto cierto |

### ⭐⭐ Por eso no hay pesos inventados

El plan pedía «cada propuesta nombra las 3 señales que más pesaron» (R7). Ponderar 29 señales
exige 29 coeficientes que **nadie midió**, y ADR-021 documenta que el aprendizaje de pesos (L4)
nunca se construyó ni en Horus ni en Thot.

> **El aporte de cada señal se mide en PESOS, y el problema desaparece: las tres que más pesaron
> son las tres de mayor monto.** Un monto se mide; un peso se inventa.

⛔ Y lo que no se puede expresar en dinero **no es un aporte**: es un **bloqueo** o **contexto**.
No se cuela al número por la puerta de atrás.

### Lo que el triage publica

| acción | certeza | celdas | sin bloqueo | dinero 30 d |
|---|---|--:|--:|--:|
| `sin_accion_defendible` ⭐ | sin_evidencia | **64,086** (74.4 %) | 53,946 | — |
| `aterrizar_precio` | **aritmética** | 5,070 | 1,900 | **$71,719** |
| `subir_precio` | efecto_no_medido | 4,883 | — | $312,641 |
| `liberar_capital` | regla_de_operación | 9,160 | 6,469 | *saldo* $60.4 M |
| `revisar_costo` | aritmética | 2,230 | 1,436 | $50,169 |
| `corregir_escalera` | aritmética | 710 | 602 | $76,655 |
| ⛔ `precio_atipico` | fuera_de_alcance | 24 | — | — |

⭐ **El default es la mayoría y se publica como tal.** Un tablero donde todo es urgente no
prioriza nada.

---

## 10 · ⛔ Tres defectos que las compuertas dejaron pasar y los renglones no

Las seis compuertas de `[PR.L1]` salieron **en verde**. Después se miraron **doce renglones
reales** y aparecieron tres defectos que ninguna podía ver, porque las cifras estaban bien
formadas — sólo que en la unidad equivocada.

> ### ⭐ *Una compuerta verifica que el número EXISTA y sea coherente consigo mismo. Que MIDA lo que dice medir lo verifica alguien mirando renglones.*

**1 · Un SALDO en una columna de FLUJO.** `liberar_capital` publicaba el valor **anual** del
inventario mientras las otras acciones publican dinero de **30 días**: sumaba **$60,464,128**
contra $409,475 del aterrizaje y **se llevaba los doce primeros lugares de la cola**. Es ADR-055
otra vez — *la unidad de una columna no se hereda de su fuente*. Ahora va en
`capital_inmovilizado_mxn`, y `monto_en_juego_mxn` queda NULL **con su motivo**: sin tasa de
costo de capital (**D5**, abierta) no hay conversión.

**2 · Una razón que no es una tasa.** La merma entraba a R7 como `venta × (no_explicado/vendido)`.
Ese cociente **no es una tasa aplicable a la venta** — son unidades de periodos de conteo que no
coinciden con la ventana, con peldaños que pueden diferir. Su mediana es **−97.75 %**, y producía
aportes de **−$128,415 en una celda** que barrían con el desglose. ⚠️ **Yo mismo había escrito esa
advertencia en `[PR.S2.3]` y tres horas después la usé como si fuera una tasa.**

**3 · Un «aterrizaje» que duplicaba el precio.** El primer lugar de la cola era **TIEMPO AIRE a
$1.00 aterrizando en $1.99 — un +99 %**. Misma clase de defecto que el piso de $1 ya había
atajado una vez: **el piso estaba demasiado abajo**.

> ### ⭐⭐ La partición, con el umbral de percepción como criterio
> | | celdas | venta | alza mediana |
> |---|--:|--:|--:|
> | **bajo el umbral** — el cliente **no lo distingue** | **5,070** | **$14.2 M** | **+0.49 %** |
> | sobre el umbral, bajo la magnitud mediana real | 3,418 | $6.4 M | +1.92 % |
> | 3.82 %–20 % — eso es un **alza** | 1,465 | $2.4 M | +5.61 % |
> | ⛔ más de 20 % — no es un precio ordinario | 24 | $37 k | **+32.56 %** |
>
> ⚠️ **Corrige una cifra que yo publiqué:** el aterrizaje en `.99` no vale **$8.03 M anualizados**
> sino **$872,833** ($71,719/30 d; $21,140 en celdas sin bloqueo). El resto **no desaparece: se
> renombra** a `subir_precio` con certeza `efecto_no_medido`, que es lo que el A/B resuelve.
> *Lo que cambia no es el número: es de qué se le está llamando.*

⭐ Y los 24 atípicos no son un error del motor: son la evidencia de que falta **G4 (intocables)**,
declarada `no_existe` en el registro. *El motor se comporta bien con lo que sabe; el hueco tiene
nombre.*

---

## 11 · Qué se aplicó y qué lo verifica

| batch | migración | qué |
|---|---|---|
| 611 | `price_signal_registry` | el registro ejecutable de las 46 |
| 612 | `price_signals_v3` | las 12 señales nuevas |
| 613 | `mv_price_signals` | la matvista — 118,754 → 8 ms |
| 614 | `price_signal_registry_capa2` | `refutada` + cobertura medida + gate de cero `disponible` |
| **616** | `price_signals_v4_arbitro` | **A4, el árbitro del costo** |
| **617** | `price_signal_registry_a4` | `cobertura_expr`: la regla de medición en la tabla |
| **618** | `analytics_price_action` | **la capa 3** |
| **619** | `price_action_unidades` | saldo ≠ flujo · la merma fuera de R7 |
| **620** | `price_action_umbral` | el aterrizaje partido por el umbral de percepción |

**Candados contra prod:** `test-newdb-price-signals.js` **37 ✓ / 0 ✗ / 1 no medido** ·
`test-newdb-price-action.js` **16 ✓ / 0 ✗**.

⭐ El de la capa 3 vigila **las cuatro maneras en que este motor ya mintió**, y reverifica la
identidad del sugerido del ERP en cada corrida: si algún día dejara de cumplirse, la fórmula del
ERP cambió y hay que enterarse.

---

## 12 · Capa 4 · **Visual** — la pantalla, y lo que no puede ver

`/comercial/precios/motor`: el triage de las 86,163 celdas, las 29 señales cableadas en 13
familias, y **las 15 que faltan declaradas con su motivo** — el registro se publica en pantalla,
no se esconde.

### ⛔ El permiso se derivó, no se calcó

Lo obvio era reusar `COMMERCIAL_PRICING_VER`. Medido antes de hacerlo: lo tienen **3 usuarios
`customer_b2b` —clientes— y 35 de campo**. Un motor que publica costo, margen y capital
inmovilizado por SKU no entra por esa puerta. Nace `COMMERCIAL_MARGIN_ENGINE_VER` (batch 621),
repartido a **7 roles / 16 usuarios**, con un candado que **falla** si la clave aterriza en un rol
de cliente o de campo.

### ⚠️ "No me deja verlo" no era ni permiso ni código

El reporte de Edgar llegó mientras el despliegue corría: el de las 15:50 construyó `3d3ece7`, el
push aterrizó **15:53**, y el de `c1a83e8` terminó **16:06:04**. *Antes de buscar la causa en el
código, hay que medir qué bundle está sirviendo el servidor.*

---

## 13 · `[PR.X]` · El expediente del SKU — la ventana

> *«Al dar clic que se abra una ventana con la información clara y detallada. Una gráfica en la
> cual veamos cómo se relaciona su historial de costos con sus ventas y cómo han afectado. Y una
> línea de cómo podría afectar nuestro cambio de precio en ventas… precios de competencia…
> necesito que demos más herramientas al usuario.»* — Edgar

La pantalla deja de ser un **informe** y pasa a ser un **instrumento**.

### ⭐⭐ La elasticidad no se predice: se le da vuelta a la pregunta

La elasticidad medida es una región de **[−1.415, −0.045]** — un factor **31×** de ancho; por SKU
el error estándar es **0.94**. Publicar una curva con eso sería inventar.

`analytics.fn_umbral_equilibrio(precio_actual, costo, precio_nuevo)` responde la pregunta
**volteada**: *a este precio nuevo, tendrías que perder más del **X %** del volumen para quedar
peor que como estás.* Es **aritmética, no predicción**, y con eso la decisión ya no necesita la
elasticidad. Se prueba **aislada**, con 8 valores elegidos, sin datos ni ambiente — incluidos los
casos degenerados (precio nuevo ≤ costo → `NULL`, nunca un número).

### ⭐⭐ El placebo se disparó, y **ese es el entregable**

El event-study sobre cambios de precio pasados da efecto **−0.0125**… con un placebo de
**+0.2576**: **20× más grande que el efecto**. Y **empeora con mejores datos** (+0.36 restringido
a ventanas de 15+ días). La prueba decisiva: una **baja** de precio y un **alza** mueven el
volumen **en la misma dirección** (DiD −0.20 y −0.35). Ninguna curva de demanda hace eso — es
**reversión a la media**: los precios se tocan justo después de un pico de ventas.

⭐ Por eso la gráfica dibuja **la pre-tendencia al lado**: si no es plana, la gráfica **se
autodesmiente**, y eso es información, no un defecto. Es además el argumento para correr el
experimento A/B, que está construido y tiene **0 filas**.

### Los cuatro filtros de la bitácora de precios

Sin ellos `v_label_price_changes` no es un registro de decisiones:

| filtro | qué saca | cuánto |
|---|---|---|
| centinela `> $1` | la oscilación (`CJA 1,734.34 → 0.01 → 1,734.34` el mismo día) | 52,001 |
| neto del día | ida y vuelta que termina donde empezó | 15,401 |
| \|Δ\| ≥ 1 % | recosteo, no decisión de precio | 40,140 |
| dedup por unidad | el mismo cambio contado en `PAQ`, `CJA`, `PZA` y `KG` | — |

### ⛔ Competencia: cero fuentes, y se dice en pantalla

No existe ningún precio de competidor en ninguna base ni en el repo (F1 refutada: PROFECO cubre
**0 %** del catálogo). **El hueco se declara.** En su lugar va la **demanda perdida** —
$30.6M atribuibles— **con su vencimiento al lado**: `wincaja.v_lost_demand` se corta **exactamente**
en el cutover a Kepler de cada plaza (la sucursal 01 termina el 25-jun; su cutover fue el 27-jun).

⚠️ **Hallazgo operativo, más grande que la fase:** desde la migración **nadie registra venta
perdida**. `commercial.floor_stockouts` tiene **13 filas en 2 plazas**.

### Qué se aplicó

| batch | migración | qué |
|---|---|---|
| 632 | `analytics_sku_cost_sales_monthly` | la serie mensual de costo, precio y volumen |
| 633 | `analytics_sku_price_response` | eventos limpios + event-study **con su placebo en la misma fila** |
| 634 | `analytics_sku_tools` | `fn_umbral_equilibrio` + demanda perdida |
| 635 | `mv_sku_price_history` | matvistas: 3,166 → **3 ms** · 6,925 → **1 ms** |

**Candado:** `test-newdb-price-expediente.js` **19 ✓ / 0 ✗** contra prod, con la prueba negativa
de la dedup y la de la unidad sin línea base — la que infló **+4.67 pp** un DiD anterior.

⛔ **El simulador no escribe nada.** Calcula; la captura sigue siendo en Kepler (ADR-040).

---

## 14 · ⛔ El defecto de método de este incremento

Un comentario HTML con acentos graves **adentro** del `template:` lo terminó antes de tiempo y
rompió el build. Es la **novena** vez en este repo, y la primera que llega a un commit.

**El acento grave no es el defecto.** El defecto es que cambié el template **después** del último
build y commiteé sin volver a construir, habiendo corrido `check-primeng-api.js` —que lee el
archivo como texto y **no lo compila**— y dándolo por suficiente.

⭐⭐ Y la compuerta **ya existía**: `scripts/check-template-literals.js`, cableada en
`scripts/check-all.js`, cuyo caso #1 es exactamente este. Verificado con **prueba negativa** sobre
una copia rota a propósito (`❌ 1 componente(s) con el comentario roto`) y verde sobre los
archivos reales. *El gate no tenía hueco: no lo corrí.* Lo que corresponde antes de commitear es
`node scripts/check-all.js`, no una sub-compuerta suelta.

⚠️ **Lo que salvó a producción no fue mi disciplina**: el `auto-deploy` estaba **frenado** desde
las 18:15 por 4 migraciones ajenas sin aplicar, así que el commit roto nunca llegó a compilarse.

---

## 15 · `[PR.S3]` · H1 · Margen por canal — aplicarlo lo refutó

Al preguntar *«qué variables no estamos abarcando»*, el canal era la candidata obvia: 6 valores en
`sales_daily.channel`, costo poblado al **98-100 %** en los seis, y el **84.2 % de la venta** en
celdas (almacén, SKU) que venden por dos canales o más. Dimensión masiva, dato limpio, cero
fuentes nuevas. Se midió antes de construirla, y la medición la mató.

### ⛔⛔ El margen por canal no se puede leer — y no por culpa del canal

| canal | celdas con precio distinto entre almacenes | margen **congelado** |
|---|---:|---:|
| `tienda` | 1,800 | **100.0 %** |
| `mayoreo` | 204 | **100.0 %** |
| `credito` | 1,255 | **100.0 %** |
| `wincaja_ruta` | 27 | **0.0 %** |

En los tres canales de Kepler —el **84.8 % de la venta**— el **100.0 %** de las celdas donde el
precio difiere más de 5 % entre almacenes tiene spread de margen **menor a 0.01 pp**. El margen no
se mueve aunque el precio se mueva: está **congelado por construcción**, porque `sales_daily.cost`
del lado Kepler sale de `revenue / (1 + markup_pct)`.

⭐⭐ **El control negativo es la mitad que da validez a la medición.** `wincaja_ruta`, cuyo costo es
el `ValorCosto` real del POS, da **0.0 %** congelado. Sin ese contraste, el 100.0 % de Kepler se
podía leer como *«los precios están bien alineados»* en vez de *«el número no puede variar»*.

### ⛔ El espejismo que esto desarma

Antes de mirar el control, la dispersión de margen entre canales daba **0.59 pp** contra un placebo
de partición al azar de **0.15 pp** — 4× el ruido, con pinta de señal — y en dinero **$846,040 en
90 días** sobre 1,821 celdas: **2.7× la acción más grande que el motor publica hoy**. Ese dinero es
el **método de costeo**, no el canal. Publicarlo habría repetido lo de MR.5 al pie de la letra.

### Lo que sí quedó en pie, y por qué igual no es una acción

- El spread de **precio** por canal es real y **observado**: **86.2 %** de la venta se cobra distinto
  según el canal, mediana **8 %** en la banda principal. Pero **es la política del negocio**.
- La **inversión** (mayoreo más caro que tienda, mismo almacén, SKU y peldaño) es el único defecto
  inequívoco: **60 celdas, $11,574**. Demasiado chico para una acción propia.
- ⛔ Deuda de datos encontrada de paso: **158 celdas / $3.47 M** con spread de precio de mediana
  **847 %** — peldaño mezclado dentro de un mismo `unit_kind` (ADR-057). Se arregla en la unidad.

### ⭐ La lección, que vale más que la señal

**Agregar variables de MARGEN no sirve mientras el costo del 84.8 % de la venta sea algebraico.**
De las cuatro candidatas que se propusieron (canal, IEPS, canibalización, plazo), **tres dividen
margen** y las tres medirían la tabla de markup. La excepción es el **plazo**, que no toca el costo.

**Aplicada a prod 2026-10-01 (batch 648)**, identidad verificada, 0.1 s. Registro: **29 cableadas /
15 no_existe / 3 refutadas** (A5, F1, H1).

### Dos variables medidas que el registro todavía no tiene

- ⭐⭐ **Impuesto.** El **85.7 % de la venta** paga IEPS al 8 %, y **416 SKUs / $33.04 M (29.3 %)**
  tienen IEPS de compra distinto al de venta — 37 de ellos lo **pagan y no lo cobran**. Cero
  señales de impuesto en las 46.
- ⭐⭐ **Plazo y costo del dinero.** Plazo pactado promedio **5.2 días**, cartera **$67.58 M**,
  **90.7 % de los documentos vencidos**, y **890 clientes marcados «contado» con $37.31 M de
  saldo**. `dias_pago` viene **null**: nadie mide cuánto tardan de verdad.

---

## 16 · `[PR.S4]` · H2 · Prima por plazo — refutada por el **control de confusión**

Tras H1, el plazo era la única candidata que **no toca el costo**. Y arrancaba fuerte: cartera
**$67.58 M**, **90.7 %** de documentos vencidos, **890 clientes marcados «contado» con $37.31 M de
saldo**.

### La primera lectura parecía un hallazgo grande

Mismo SKU, misma unidad, 45 días:

| medición | promedio | mediana | p10 | p90 |
|---|---:|---:|---:|---:|
| **REAL** (crédito vs contado) | **−4.80 %** | −4.69 % | −8.16 | −0.94 |
| **PLACEBO** (mitad al azar) | +0.06 % | 0.00 % | −2.45 | +2.79 |

El placebo centrado en cero: no era ruido. El cliente a crédito pagaba **4.80 % menos** en el
**93.1 %** de los 608 SKU comparables. Leído así: se lo financia **y** se le descuenta.

### ⛔⛔ El control de volumen lo desarmó

La línea a crédito tiene **cantidad mediana 12.00** contra **2.00** la de contado — compran **6×
más por renglón**. Dentro de tramos de cantidad comparable:

| tramo | SKUs | dif. precio |
|---|---:|---:|
| 1 | 7 | −1.01 % |
| 2-3 | 21 | −2.44 % |
| 4-10 | 108 | **−0.00 %** |
| 11-30 | 61 | **+0.23 %** |
| 30+ | 34 | −0.46 % |

Ponderado por venta: **−0.14 %** sobre $3.56 M. **El −4.80 % era el descuento por volumen.** El
precio **sí** está bien puesto para el plazo pactado.

⭐ **Dos controles distintos en la misma sesión, y ninguno sustituye al otro.** A H1 la mató un
control **negativo** (un caso donde el efecto debía desaparecer, y desapareció). A H2 la mató un
control de **confusión** (una tercera variable que explica el efecto entero).

### Lo que queda, y es de cobranza, no de precio

Pactado **5.1 días** contra **21.2 reales** (4×), y las facturas marcadas **«0 contado» se cobran a
14.3 días** (mediana 11, p90 30). ⚠️ Medido sobre el **14.9 %** de las facturas (788 de 5,276 en 180
días), el único subconjunto con `dias_pago` poblado — **no se extrapola**.

### E5 · La ausencia que el registro nunca declaró

Convertir «16 días de financiamiento no cobrado» en pesos exige una **tasa de costo de capital**, y
⛔ **no existía en el registro, en ninguna familia**. La acción `liberar_capital` publica
**$60.46 M** de saldo que por eso no se puede ordenar contra los flujos. Ahora es **E5**, en
`inventario`, estado `no_existe`: es una **decisión de dirección financiera**, no un dato derivable.

**Aplicadas a prod 2026-10-01 (batch 652)**, identidad verificada. Registro: **29 cableadas /
16 no_existe / 4 refutadas**.

---

## 17 · `[PR.V2]` · El motor y los experimentos, bajo una sola entrada

Eran dos renglones hermanos del sidebar que responden la misma pregunta en dos tiempos: el motor
dice **qué precio conviene mover**, y el experimento es **lo único que puede convertir esa acción
de «efecto no medido» a medida**. Ahora son **Control de margen** — una entrada, con selector
segmentado estilo iOS.

- **Rutas:** `/comercial/precios/motor` y `/comercial/precios/experimentos`. Las dos viejas
  quedan como **redirect** (hay marcadores y enlaces en estos docs), mismo criterio que `[CAT.1]`.
- **Selector:** `PageTabsComponent` con `variant="liquid"` — **ya existía**, ya navega por ruta y
  ya filtra por permiso. No se construyó uno nuevo.

### ⚠️ Por qué la entrada NO puede tener un permiso único

Medido en prod antes de juntarlas: **5 roles ven las dos** (direccion, gerente_compras,
jefe_marketing, marketing, superadmin), pero **2 ven sólo el motor** (`compras`, `finanzas`) y
**1 sólo los experimentos** (`telemarketing`). Con un permiso único, alguien perdía la entrada
entera; y un `redirectTo` fijo a `motor` **rebotaba a `telemarketing`** contra su propio guard.
Por eso: `anyOf` en el sidebar, `anyPermissionGuard` en la ruta, y **`preciosHomeGuard`** eligiendo
la primera pestaña que esa persona sí puede abrir.

### ⭐ Dos cosas que el código existente enseñó, y una que rompí

- **No hay componente shell.** Almacén tiene uno porque monta la barra para ~19 páginas; acá son
  dos. Y un padre anidado **rompe el parser de `landing-guards.spec`**, que sólo lee rutas hijas
  a un nivel: los tres candidatos salían como «la ruta no existe». Almacén ya resolvía esto
  **no indentando** las hijas de su shell. Las rutas quedaron **planas, con el prefijo adentro**.
- **La compuerta atrapó el rebote antes de que existiera.** `landing-guards.spec` falló en el
  primer intento y por eso se midió el reparto de permisos.
- ⛔⛔ **Décima vez con el acento grave**, y esta vez en un comentario **CSS** dentro de
  `styles:` — escrito horas después de documentar el caso en §14. El gate lo marcó en el acto.

**Verificado:** `nx build view` · `landing-guards.spec` **24/24** · `nx test view` **1,380** ·
`contracts` **245** · lint 0 errores. **Validación visual pendiente.**

---

## 18 · `[PR.V3]` · El rediseño de la cola, en el código

El mockup se llevó a la pantalla real. Tres cambios, y el primero no es estético.

### 1 · El flujo y el saldo dejan de compartir escala

La pantalla publicaba **$60.46 M de saldo** y **$105 k de flujo** en la misma lista, con una sola
columna de barras — y la barra del número 575× más grande salía **vacía**. Ahora son tres bloques:
cuatro tarjetas de **flujo** que sí comparten escala, el **capital** aparte con borde punteado y
sin barra (diciendo que le falta la tasa **E5**), y una tira callada para lo que no tiene decisión.

### 2 · «Corregir la escaleraARITMÉTICA»

Los dos chips iban pegados **sin un solo espacio**: no era un descuido de CSS, eran dos `<span>`
hermanos sin regla que los separara. Ahora van en columna, y la tabla gana **costo** y **margen vs
meta**, que estaban en los datos y no en pantalla.

### 3 · La agrupación, y por qué NO se hizo en el servidor

Medido en la cola real: **19 % de repetición** en el top 100 (100 filas, 81 SKUs), y el grupo más
grande suma **$6,897**. ⛔ Eso **corrige el mockup**, que mostraba `10411` con 8 plazas y $54,780 —
esa cifra venía de otra foto, no del top de hoy. Con ese tamaño no se paga agrupar del lado del
servidor, así que se agrupa **lo que vino en la página** y la etiqueta lo dice: «la misma decisión
en N plazas **de esta lista**». Prometer «en N plazas» a secas sería un total falso: el servidor
manda el top por dinero y las plazas chicas del mismo SKU quedan fuera.

⭐ La lógica se extrajo a `agrupar-cola.ts` **como función pura y con 8 pruebas**, porque es lo
único del rediseño que puede estar mal en silencio: el conteo de plazas y la suma con NULLs. Una
de las pruebas vigila justo eso — **si ninguna fila del grupo tiene monto, el grupo vale `null` y
no cero** (ADR-056), y un NULL entre medibles no contamina la suma pero **sí sigue contando como
plaza**.

⚠️ La tabla quedó en **7 columnas contra el umbral de 8** de `check-dense-tables`: una columna más
y hay que darle salida en pantalla estrecha.

**Verificado:** `nx build view` · `nx test view` **1,387** (+8) · lint 0 errores · gate de
templates · `check-dense-tables` y `check-css-tokens` no señalan este archivo.
**Validación visual pendiente** — es lo único que no puedo hacer yo.

---

## 19 · `[PR.V4]` · El About — y el defecto que apareció al escribirlo

La pantalla habla con **siete verbos y cinco grados de certeza**, y ninguno es obvio. La leen siete
roles (compras, finanzas, marketing, dirección, gerente\_compras y dos más) y **ninguno es técnico**,
así que el tópico entero se redactó en **palabra llana**: nada de «veredicto», «coeficiente» ni
nombres de columna. Un barrido final sacó las tres «celdas» que se habían colado.

Vive en `context-help.dictionary.ts` — el patrón de la casa, que ya exige *«definiciones ancladas al
comportamiento real del sistema, no inventadas»*. Cada una salió de leer el `CASE` de
`analytics.v_price_action`, no de lo que la etiqueta sugiere.

### ⛔⛔ Lo que la pregunta «¿a qué te refieres con corregir escalera?» destapó

La **escalera** son los escalones de venta del mismo producto — pieza, paquete, caja — y la regla
es que la caja salga **más barata por pieza**. Si no, es un error de catálogo: se le cobra más a
quien compra más.

Pero la tolerancia es **0.01 %**, y para un producto de $15 eso es **centavo y medio**. Resultado,
medido sobre los 696 casos incoherentes:

| diferencia por pieza | casos | dinero en la cola |
|---|---:|---:|
| **≤ 1 centavo** (la menor: **$0.0006**) | **248** | **$76,610** |
| 2 a 10 centavos | 72 | — |
| 11 centavos a $1 | 27 | — |
| **más de $1** (hasta **$341.86**) | 349 | **$2,138** |

⭐⭐ **El 97 % del dinero que esta acción pone en la cola son diferencias que no se pueden
corregir**: los precios se guardan al centavo, así que una brecha de seis diezmilésimas de peso no
tiene arreglo posible. Y las 349 escaleras rotas de verdad quedan sepultadas con $2,138.

Dos causas se suman: la tolerancia es **relativa** donde el error de origen es **absoluto** (redondear
el precio de la caja al centavo), y `monto_en_juego` para esta acción es la **venta expuesta**, no la
ganancia — así que un producto que vende mucho con una brecha de un centésimo se ve enorme. Eso
explica por qué la captura original tenía la cola tomada por `10411` en cinco plazas.

⚠️ **No se corrigió**: el arreglo (exigir que la brecha supere un centavo por pieza) cambia lo que
la pantalla publica y no estaba autorizado. **El About lo dice tal como es hoy**, con el número
medido, en vez de definir el término por lo que debería hacer.

**Verificado:** `nx build view` · `nx test view` **1,387** · lint 0 errores · gate de templates.

---

## 20 · `[PR.V5]` · El término se explica DONDE se usa

El About de `[PR.V4]` definía los siete verbos — pero **detrás de un botón**. Quien lee
«Corregir la escalera» en la cola sigue sin saber qué es una escalera, y mandarlo a abrir un
cajón es pedirle un clic para entender la pantalla que ya está mirando.

Ahora cada verbo lleva **su glossá** impresa al lado:

| verbo | lo que ahora dice debajo |
|---|---|
| Corregir la escalera | la caja sale más cara por pieza que la suelta |
| Revisar el costo | el costo se movió y el precio sigue igual |
| Aterrizar el precio | falta muy poco para el siguiente precio redondo |
| Subir el precio | hay espacio hasta el siguiente precio redondo |
| Liberar capital | inventario parado que se mueve bajando el precio |
| Precio atípico | no es mercancía ordinaria: no se propone nada |
| Sin acción defendible | no hay con qué sostener una propuesta |

### ⭐ Y un hueco que apareció al hacerlo

**La ventana del expediente nunca decía qué hacer.** Mostraba producto, precio, costo, margen,
historia, simulador y plazas — pero no repetía la acción que hizo entrar a la persona. Alguien
abría un renglón que decía «Corregir la escalera» y adentro no había **ni una palabra** sobre qué
es una escalera ni qué hacer con ella. Ahora la propuesta va arriba de todo, con su glosa y su
grado de certeza.

### ⚠️ Lo que eso dejó, y se corrigió en el mismo paso

Agregar la glosa en los dos lugares dejó **dos copias del mismo mapa de etiquetas**, que se
desincronizan sin que nadie se entere. Vive en `precios-vocabulario.ts` y los dos componentes lo
leen de ahí — una sola voz, verificada con un grep que no devuelve nada fuera de ese archivo.

⛔⛔ **Undécima vez con el acento grave**, la segunda en esta sesión: el comentario HTML que
anuncia la propuesta lo escribí con `` `[PR.V5]` `` adentro del template. El gate lo marcó al
instante, pero **lo escribí igual, horas después de documentarlo dos veces**.

**Verificado:** `nx build view` · `nx test view` **1,387** · lint 0 errores · gate de templates.

---

## 21 · `[PR.V6]` · La pestaña de Experimentos no tenía nada que clickear

Reportado al abrirla como superadmin: *«¿aquí qué hago? no existe información o algo que pueda
clickear»*. El estado vacío decía **«Lo diseña quien tenga el permiso de gestión»** — a una
persona que **tenía** ese permiso. La pantalla nombraba una condición en vez de dar la acción.

### ⛔ Y no faltaba backend

| endpoint | existía | lo usaba la pantalla |
|---|---|---|
| `GET /estratos` | sí | sí |
| `GET /` listar | sí | sí |
| **`POST /` diseñar** | **sí** | ⛔ **no** |
| `GET /:id/captura` | sí | sí |
| `PATCH /units/:id/aplicada` | sí | sí |
| `GET /:id/resultados` | sí | sí |

El servicio del frontend **ya tenía los seis métodos**, incluido `disenar`. De los seis, era el
**único con cero llamadas**: todo el resto del flujo ya estaba cableado y aparecía en cuanto
existiera un experimento. Faltaba exactamente un botón.

### El diálogo, y por qué pide lo que pide

- **Terminación** (`.99` por default) — el servicio documenta que el alza implícita de aterrizar
  a `.99` vale **+$659,564/30 d**, así que esa es la que se prueba primero.
- **Semilla**, obligatoria y con su motivo impreso al lado: *sin ella la asignación no se puede
  reproducir, y un resultado que no se puede reproducir no es un resultado*.
- **Estratos**: los viables vienen marcados; los que **no alcanzan se muestran igual**, marcables
  a propósito, porque ocultarlos haría creer que el experimento cubre el catálogo entero — que es
  la misma regla que el backend ya aplica en `GET /estratos`.

⚠️ El botón se gatea con **la misma clave** que el `POST` exige
(`COMMERCIAL_PRICE_EXPERIMENT_GESTIONAR`): mostrar uno que el servidor va a rechazar es peor que
no mostrarlo.

### ⚠️ Lo que costó, y es evitable

Declaré un `sel` para los estratos marcados **y el componente ya tenía un `sel`** — el experimento
abierto. El build cayó con nueve errores en cascada. Revisar los nombres contra el archivo antes
de escribirlos son treinta segundos; renombrar después costó dos vueltas.

**Verificado:** `nx build view` · `nx test view` **1,387** · lint 0 errores · gate de templates ·
`<ng-template #footer>` y cero `pTemplate` (PrimeNG 22). **Validación visual pendiente.**

---

## 22 · `[PR.V7]` · El botón salía **sin texto**, y la compuerta que lo vigilaba estaba apagada

Reportado con una captura: dos píldoras naranjas vacías donde debían decir «Actualizar» y
«Diseñar experimento». En PrimeNG 22 la **directiva** `pButton` perdió `label` e `icon`, así que
`<button pButton label="X">` se pinta vacío. La forma que sí funciona es el **componente**
`<p-button label icon styleClass>`.

### ⛔⛔ Lo grave no fue el botón

`scripts/check-primeng-api.js` **ya tenía esta regla**, escrita el 2026-09-02 con su diagnóstico y
su arreglo. No la detectó. La causa, en una línea:

```js
if (/p-button/.test(tag)) continue; // <p-button pButton> es otro defecto, no éste
```

Dos defectos encimados: el regex de arriba sólo matchea `<button` y `<a`, así que **un
`<p-button>` nunca llegaba hasta ahí** y el salto no servía a su propósito; y ese mismo patrón
matchea **`class="p-button-sm"`**, que lleva casi todo botón de la app. **La regla se saltaba a sí
misma.**

| | antes | medido |
|---|---:|---:|
| lo que reportaba | **2** | |
| lo que había | | **32** en 16 archivos |

⭐ **Un `continue` dentro de una compuerta es una excepción, y una excepción sin prueba negativa
que la ejercite es un apagado silencioso.**

### Qué se hizo

- **10 botones convertidos** a `<p-button>` en Motor de margen y Experimentos — incluidos
  «Actualizar», «Reintentar», «Ya lo capturé» y «Ver todas las acciones», que llevaban tiempo
  saliendo sin texto.
- **El salto retirado**, con el motivo escrito en su lugar.
- **Techo = 22**, la deuda medida que queda en el resto de la app. No es una meta: es lo que hay,
  congelado para que la 23ª no entre. Antes el techo decía 3 y no enforzaba nada.
- ✅ **Prueba negativa:** con un botón roto a propósito la compuerta marca **23 contra 22**; al
  retirarlo vuelve a verde.

**Verificado:** `nx build view` · `nx test view` **1,387** · lint 0 errores.

---

## 23 · `[PR.V8]` · El diálogo decía el mismo número de dos maneras

Preguntado al verlo: *«¿esto qué es?»*. Tres defectos, y el del medio es el que importa.

| defecto | lo que mostraba | lo que muestra |
|---|---|---|
| clave interna en pantalla | `a_bajo_10` | **$1 - $10** — el mismo `rango()` que la tabla |
| ⛔ **el mismo número, dos veces distinto** | diálogo *«pide 291»* / tabla *«Necesita 582»* | **necesita 582** en los dos |
| no decía qué hace el botón | — | una línea arriba del formulario |

El segundo salía de que `nPorRama` es **por rama** y el experimento tiene dos — tratamiento y
control. La tabla ya imprimía `nPorRama * 2`; mi diálogo imprimía el crudo. **Dos cifras para la
misma cantidad, a quince centímetros una de otra**, y quien compara concluye que una de las dos
está mal.

⭐ Reusar un dato del backend no exime de reusar **la forma en que esa pantalla ya lo publica**.

**Verificado:** `nx build view` · `nx test view` **1,387** · lint 0 errores.

---

## 24 · `[PR.V9]` · Emojis en la interfaz, y una tabla sin una sola regla de estilo

Dos reportes sobre el expediente, los dos ciertos.

### 1 · «dices «subir precio» un porcentaje pero no dices si subir ese margen»

La tabla de plazas imprimía **el código interno** (`subir_precio`) pegado al porcentaje, y los
encabezados decían «MARGEN REAL QUÉ HACER» de corrido. Causa: **`.mx-tab` no tenía NI UNA regla
de estilo** — sin `padding`, celdas y encabezados se leen como una sola palabra. Es el mismo
defecto que «Corregir la escaleraARITMÉTICA», otra vez y en otra tabla.

| | antes | ahora |
|---|---|---|
| la acción | `subir_precio` | **Subir el precio**, con `etiquetaAccion()` |
| el encabezado | «Margen real» / «Qué hacer» | **«Margen que se cobró»** / **«Qué propone el motor»** |
| separación | ninguna | `.mx-tab` con sus reglas |

### 2 · ⛔ Emojis, con la regla escrita y sin nada que la vigilara

**10 emojis** en párrafos de la interfaz del expediente y de experimentos, escritos por quien
conocía la regla *«iconos, nunca emojis»*. Reemplazados por PrimeIcons con su rótulo.

⭐ **Y la compuerta no existía**, así que se construyó: `scripts/check-no-emoji-ui.js`, registrada
en `compuertas.js`. Mide **75** en texto visible de toda la app — techo en **75**, la deuda medida,
congelada para que la 76ª no entre. Prueba negativa: con uno de más marca **76 contra 75** y falla.

Qué mira y qué no: sólo lo que se **renderiza** (adentro de `template:`, salteando comentarios), y
**deja fuera a propósito** `✓ ✗ ✕`, que son marcas tipográficas y no pictogramas — meterlas
triplicaría el conteo con casos discutibles y volvería la compuerta ignorable.

Por qué no es estética: un emoji **lo pinta la fuente del sistema operativo**, así que el mismo
párrafo sale distinto en Windows, en Android y en el navegador del vendedor; no hereda el color
del texto; no se alinea a la rejilla; y un lector de pantalla lo lee con su nombre Unicode.

**Verificado:** `nx build view` · `nx test view` **1,387** · lint 0 errores · la compuerta nueva en
`check-all`.

---

## 25 · `[PR.M1]`+`[PR.M2]` · ISCAM: la posición de mercado entra al motor

La entrega mensual de **ISCAM** estaba en el disco y nadie la había mirado desde acá. Trae lo
que el registro declaraba inexistente, y algo que ni contemplaba.

### ⛔⛔ Primero, dos veces estuve por publicar lo contrario de la verdad

**(1)** Los dos **Cubos** parecen datos de competencia — tienen código de barras, precio y 668
marcas. No lo son: `Mayorista` tiene **un solo valor** y sus 11 «sucursales» son **las nuestras**.
Es nuestro propio dato devuelto con la taxonomía de ISCAM. La refutación de **F1 sigue en pie**.

**(2)** El mercado sí está, pero en el **SURF**: 1,500,880 registros con cuatro medidas — lo
nuestro y lo del mercado, actual y anterior. Y al leerlo, **mi primer parser se quedó con 9,772
de 1,500,880 registros (el 0.65 %)** porque descartaba el registro entero al ver un `<m/>` (medida
ausente); hay **1,491,108**. Publiqué un share de **5.79 %** donde el real es **3.80 %**, y un
mercado de $960.9M donde son **$1,464.8M**.

⭐⭐ **Lo único que lo delató fue contar los registros leídos contra el `recordCount` declarado.**
El subconjunto sobreviviente daba cifras perfectamente plausibles. Ese conteo es ahora un
**candado que aborta la carga** si falta un solo registro.

### El grano: dos cifras ciertas, y no son la misma

| universo | share |
|---|---:|
| **Mayoreo Puro** — nuestro canal | **5.36 %** |
| Mayoreo total | **3.80 %** |

La diferencia son **$426.8M de mercado medido en subcanales donde no vendemos nada**
(Autoservicios Propios del Mayoreo, Cash & Carry). Las dos son ciertas y responden preguntas
distintas; el candado exige que **sigan siendo distintas**, porque si se igualaran alguien aplanó
el subcanal.

### ⚠️ Y la advertencia viaja en una columna, no en un correo

A ISCAM se le trasladan **todas las salidas, traspasos entre sucursales incluidos** (deuda técnica
de Wincaja). Medido: la brecha contra `analytics.sales_daily` es de **$19.5M a $21.6M por mes**,
estable en cinco meses — el **22-29 %** de los traspasos del período. Si la distorsión fuera sólo
nuestra el share sería **~3.80 %** y no 5.36 %; si los demás mayoristas del panel cargan la misma
deuda, está bien. **Cuál de las dos es no se puede saber desde el archivo**, y por eso
`v_iscam_share` lo publica en `numerador_inflado_por_traspasos` con su motivo al lado.

### Lo que esto le da al motor

- **`C1 · Segmento / grupo par`** es **núcleo** y decía *«no existe segmento formal»*. Eso dejó de
  ser cierto: la taxonomía de seis niveles existe, se paga todos los meses y **cruza por código
  de barras** — 3,895 códigos que alcanzan **1,574 SKUs y $42.85M de venta 90 d**. Se corrigió el
  motivo; sigue en `no_existe` porque **falta cablearla**.
- **`H3` participación de mercado** y **`H4` terreno ganado o perdido**, que el registro no
  contemplaba. Lo que agregan: subir el precio con **16.12 %** de una categoría es fijar precio;
  con **2.04 %** es seguirlo. Y subir en **Frituras** — mercado **+19.1 %**, nosotros **−14.3 %**,
  **−3.11 pp** de share — es echarle nafta al fuego. Ataca de frente la certeza
  `efecto_no_medido`: no mide elasticidad, pero dice si ya veníamos perdiendo terreno.

### ⛔ Lo que NO se importó

`PcioDisp`. Parece un precio; su fórmula, leída del propio archivo, es **`Val / Vol / 24`** — un
divisor **fijo de 24 para todo el catálogo**. Es la trampa de la escalera de unidades otra vez.

### ⚠️ Y un candado que rompí sin notarlo

`test-newdb-price-signals.js` afirma un conteo **clavado** de señales. Estaba en **46** y la base
tenía **49**: agregué H1, H2 y E5 en tres commits y **nunca volví a correrlo**. Además violaba su
regla de que *una señal NO cableada no apunte a una columna* — H1 y H2 lo hacían. Las dos cosas
corregidas, y el conteo ahora lleva **escrito qué entró en cada salto**.

**Aplicado a prod (batches 660 y 661)** · julio-2026 cargado: **13,425 filas de mercado + 3,895
códigos** · candado `test-newdb-iscam-mercado.js` **14 ✓ / 0 ✗** contra prod.

---

## 26 · `[PR.M3]` · La competencia deja de ser un total: ISCAM baja a marca

`[PR.M1]` agregó por categoría **y tiró dos dimensiones que el archivo ya traía**: `Fabricante`
(8,247 en el diccionario) y `SubMarca` (35,164). Con eso "el mercado" era un número y la
competencia, invisible. El grano fino son **406,799 filas** contra 13,483.

### Lo que se midió antes de tocar nada

| hipótesis | veredicto |
|---|---|
| las 116 `ClaveINTEGRADOPadre` del diccionario están en los registros y el importador sumó al panel entero | ⛔ **REFUTADA** — hay **1 sola clave** en los 1,500,880 registros, la nuestra. El diccionario las arrastra del caché maestro del panel |
| el grano fino suma distinto al que publica prod | ⛔ **REFUTADA** — 13,483 claves, **0 fuera, peor diferencia 0.0000** |
| el CHECK `mercado >= nuestro` descarta ruido | ⛔ **REFUTADA** — descarta **evidencia**: 285 filas con **$9.51M de venta nuestra** |

⭐ El cruce contra lo publicado en prod: **13,387 idénticas**, 38 que difieren **en un centavo**
(orden de suma en coma flotante), 0 sólo en prod, y **58 que sólo existen en el grano nuevo** —
las que el CHECK borraba, todas `volumen` y en categorías que no vendemos.

### La foto, Región III · Mayoreo Puro · DULCES · valor · julio-2026

| veredicto | marcas | nuestro | competencia |
|---|--:|--:|--:|
| perdiendo | 440 | $28.79M | $539.35M |
| ganando | 360 | $17.41M | $277.60M |
| **ausentes** | **868** | **$0** | **$77.07M** |
| estable | 141 | $6.91M | $78.20M |
| sin_comparativo | 371 | $1.67M | $10.98M |
| sin_respaldo | 56 | $0.84M | **no medible** |

Fabricantes donde la competencia más creció en pesos: **EFFEM LUCAS** +$11.05M (nuestro share
3.00 %, −0.84 pp) · **MARCAS NESTLÉ** +$7.54M (1.12 %) · **DE LA ROSA** +$5.68M (9.49 %, −0.74 pp) ·
**BARCEL** +$4.87M (**−2.87 pp**) · **SABRITAS** +$4.24M (**−2.01 pp**) · **FRITOS TOTIS** (−1.11 pp).

⭐ Barcel, Sabritas y Totis son **Frituras** — la categoría que `H4` ya marcaba (mercado +19.1 %,
nosotros −14.3 %). Ahora se sabe **quién** se lo llevó.

### Los dos defectos que encontró el candado, en mi propio trabajo

1. ⛔ **`competencia` recortada a cero con `GREATEST`** rompía la identidad
   `nuestro + competencia = mercado` en **21 de 40 categorías** y publicaba "la competencia no
   vendió nada" sobre **$0.84M de venta nuestra**. Ahora es **NULL** donde los dos insumos se
   contradicen: lo que no se puede calcular se declara, no se dibuja como cero.
2. ⛔ **La bandera `mercado_menor_que_nuestro` contradecía a su propia fila** en **4,389 casos**:
   la calculaba en JS en coma flotante y la columna guarda `numeric(18,4)`; esas 4,389 tenían
   mercado **exactamente igual** a lo nuestro una vez redondeado. Pasó a **columna GENERADA**.
   ⚠️ **Mi cifra pública de "4,674 filas" estaba inflada por polvo de suma: son 285.**

---

## 27 · `[PR.M4]` · La competencia con NOMBRE: DENUE deja de servir sólo para prospectar

El módulo de prospección (ADR-025) cosecha INEGI con tres clases de **menudeo** — 461160
dulcerías, 461110 abarrotes, 462112 minisúper. Esos son **clientes posibles**. Las clases de
**mayoreo** nunca se pidieron, y ahí está la competencia.

| clase SCIAN | qué es | unidades |
|---|---|--:|
| **431180** | Comercio al por mayor de **dulces y materias primas para repostería** | **215** |
| 431110 | Comercio al por mayor de abarrotes | 842 |
| 431199 | Comercio al por mayor de otros alimentos | 99 |

Medido en vivo el 2026-10-01 sobre Michoacán + Guanajuato + Jalisco: **1,158 unidades, 2 nuestras
y 1,156 de competencia**. Por tamaño: **17 con 251+ personas**, 25 de 101-250, 33 de 51-100.

Con nombre: **MAYOREO DULCERO DE OCCIDENTE** (Zapopan) · **GRUPO DULCERO TARAHUMARA** (Guadalajara) ·
**ALCARUZZ** · **DISTRIBUIDORA REAL ALTEÑO** (Tepatitlán) · **DULCERÍA DE LOS ALTOS** (Ocotlán y
Tepatitlán) · **DISTRIBUIDORA DE DULCES DEL BAJÍO HERMANOS VÁZQUEZ** (8 sucursales en León e
Irapuato) · **DULCERÍA EL DESCONTÓN** (Morelia) · **SUCURSAL MADRAZO** (León).

⚠️ La clase 431180 **mezcla mayoristas con centros de distribución de fabricantes**: ahí salen
también DISTRIBUIDORA DE LA ROSA y FERRERO DE MÉXICO. Se declara, no se filtra a mano.

### Por qué una columna y no una tabla

Una unidad de DENUE es una unidad de DENUE: mismos 22 campos, misma llave, mismo upsert. Lo que
cambia no es la **forma** sino el **papel**, y eso es `prospect_stores.rol`
(`prospecto` | `competidor` | `propio`).

⛔ **Y el filtro por `rol` es requisito de corrección, no adorno:** `dedup()` **purga** todo lo
que caiga fuera de la geocerca de 100 km y corre en cron nocturno. Sin separar el rol, la primera
pasada habría borrado en silencio a todos los competidores de Guadalajara y León — justo los más
grandes — y el `whitespace_score` habría tratado a un mayorista rival como una tienda por abrir.

⭐ DENUE **nos ve a nosotros**: MEGA DULCES DE LOS ALTOS, Pino Suárez 259, La Piedad — la misma
dirección que `commercial.warehouses` guarda para 8ES. Esas unidades se marcan `propio` y no
cuentan para ninguno de los dos lados.

### Lo que esta fuente NO dice, y no se deduce

⛔ DENUE es un **censo**: qué existe, dónde, de qué tamaño por rango de personal, y cómo
contactarlo. **No dice cuánto vende, ni a qué precio, ni qué surte.**

⛔⛔ **Las dos fuentes no se pueden empatar.** ISCAM dice *cuánto* vende la competencia pero
**anonimiza** a sus 116 participantes; DENUE dice *quién* es pero no cuánto vende. No hay llave
entre ellas y **no se va a inventar una**. El hueco se declara.

⚠️ La cercanía se mide contra **nuestros clientes**, no contra nuestras sucursales:
`commercial.warehouses` tiene `latitude`/`longitude` **en NULL en las 22 filas**. Se usan los
**438 de 937 clientes** con coordenadas (46.7 %) más 1,604 PdV auditados — y por eso
`propios_1km`/`propios_5km` son un **piso**, no un conteo completo.

---

## 28 · Lo que sigue

- ⛔⛔ **La ventana no está en producción y no se puede validar todavía.** Prod corre
  `c1a83e8` (15:53): tiene la pantalla, **no** el expediente. El `auto-deploy` está **frenado
  desde las 18:15** por **4 migraciones ajenas sin aplicar** (`re30_supplier_credit_terms`,
  `re30_grant_compras_obligaciones`, `re31_goods_receipts_fecha_recepcion`,
  `re32_purchase_deliveries`, de Fase RE). En cuanto se apliquen, el despliegue arrastra esto solo
  — sin permisos nuevos pendientes, el de la capa 4 ya está repartido.
- **Validación visual de la ventana** — lo único que no puedo hacer yo, y donde aparecieron los
  tres defectos de la capa 3.
- ⚠️ **Ya está en `origin/main`**: otra sesión empujó `main` y se llevó estos commits con ella (índice de git compartido). No queda push pendiente de esta fase.
- **E5 · tasa de costo de capital** — sin ella el saldo inmovilizado no se puede ordenar contra
  los flujos. Bloquea priorizar `liberar_capital`.
  ⚠️ **Corrección:** esto decía **D5**, y `D5` es «Frecuencia de cambio» y está **cableada**.
  La tasa de capital no tenía clave en el registro; se le dio **E5** el 2026-10-01.
- **G4 · intocables y contratos** — los 24 precios atípicos esperan esa marca.
- **D2 · el piso de margen** — sin él el motor sólo puede subir.
- **El experimento A/B** — es lo único que puede convertir `subir_precio` de `efecto_no_medido` a
  medido. **$312,641/30 d** dependen de esa respuesta.

### Las 15 que faltan construir

| clave | señal | por qué no existe |
|---|---|---|
| **B1/B2** | elasticidad jerárquica | por SKU el error estándar es 0.94: sería ruido |
| **B7** | intermitencia | el CV **no discrimina** (89 % cae en clase Z) |
| **C1** | segmento / grupo par | no existe segmento formal |
| **G1** | rol del SKU | ⛔ `is_promo` **NO sirve**: marca artefactos de ≤$0.05 |
| **G4** | intocables y contratos | no existe ninguna marca de precio pactado |
| **A8/A11** | flete y rebate por SKU | ⛔ prorratear está **prohibido** (ADR-056) |
