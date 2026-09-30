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

## 12 · Lo que sigue

- **Capa 4 · Visual** — la pantalla del triage y el desglose por SKU.
- ⛔ **Nada de esto es visible todavía**: el bundle desplegado es del 29-sep. Falta **redeploy de
  `api` + `view`** (sin permisos nuevos → sin re-login).
- ⛔ **`git push` sin autorizar**: `main` local arrastra commits de otras fases.
- **D5 · tasa de costo de capital** — sin ella el saldo inmovilizado no se puede ordenar contra
  los flujos. Bloquea priorizar `liberar_capital`.
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
