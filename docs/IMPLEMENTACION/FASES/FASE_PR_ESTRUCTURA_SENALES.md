# Motor de Margen · Capas 1 y 2 — **Estructura y Datos**

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

## 8 · Lo que sigue

- **Capa 3 · Lógica** — el servicio que pondera respetando el techo de cobertura y, por R7, hace
  que **cada propuesta nombre las 3 señales que más pesaron**.
- **Capa 4 · Visual** — la pantalla.
- ⛔ **Nada de esto es visible todavía**: el bundle desplegado es del 29-sep 18:36/18:37. Falta
  **redeploy de `api` + `view`** (sin permisos nuevos → sin re-login).
- ⛔ **`git push` sin autorizar**: `main` local arrastra commits de otras fases.

### Las 16 que faltan construir

Cada una con su motivo en el registro. Las de mayor valor:

| clave | señal | por qué no existe |
|---|---|---|
| **A4** | COGS del kardex | `mv_erp_margin_daily` existe y **nunca se pobló** |
| **B1/B2** | elasticidad jerárquica | por SKU el error estándar es 0.94: sería ruido |
| **B7** | intermitencia | el CV **no discrimina** (89 % cae en clase Z) |
| **C1** | segmento / grupo par | no existe segmento formal |
| **G1** | rol del SKU | ⛔ `is_promo` **NO sirve**: marca artefactos de ≤$0.05 |
| **G4** | intocables y contratos | no existe ninguna marca de precio pactado |
| **A8/A11** | flete y rebate por SKU | ⛔ prorratear está **prohibido** (ADR-056) |
