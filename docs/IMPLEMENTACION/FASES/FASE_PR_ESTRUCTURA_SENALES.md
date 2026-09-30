# Motor de Margen · Capa 1 — **Estructura**

> Definición de la forma antes de escribir una línea de datos. Método pedido por Edgar
> (2026-09-30): estructura → datos → lógica → visual.
>
> ⚠️ **Una advertencia que el repo ya pagó:** ADR-056 rechaza *"reordenar en capas"* como
> solución — *"MR.5 tenía capas limpias y publicaba 3.3 pp de margen falso"*. Las capas ordenan
> el trabajo; **no garantizan que el número sea cierto**. Por eso cada capa acá lleva su
> medición y su prueba negativa.

---

## 0 · ⭐ La capa 1 es una TABLA, no este documento

`analytics.price_signal_registry` (batch 611) declara las **46** señales con su familia, unidad,
dirección, fuente exacta, estado y **cobertura medida con su fecha**.

**Existe como tabla y no como markdown por una razón medida:** un documento **no avisa cuando
deja de ser cierto**. La Fase CDRP lo pagó — una medición que sostenía una decisión vivía en un
`COMMENT ON TABLE` de prod y **envejeció en tres días** sin que nada se pusiera rojo.

⭐ El candado **cruza lo declarado contra lo que existe**: una señal que dice `cableada` y cuya
columna no está en `v_price_signals` pone la migración en rojo. Eso un documento no lo puede hacer.

> ### ⭐⭐ La regla de oro, en un CHECK
> ```
> peso_max ≤ cobertura_pct / 100
> ```
> El peso de una señal **nunca puede exceder su cobertura**. Sin esto el motor promediaría la
> fuga —**6 %** de las celdas, 33 % de la venta— con la terminación —**100 %**— y estaría
> decidiendo el precio del mostrador, dos tercios de la venta, con evidencia que **no lo
> incluye**. No se puede sostener en un `const`: vive en la tabla.

⛔ **Corrección de conteo.** El plan decía **41 señales**. Son **46**: 11 costo + 10 demanda +
6 cliente + 8 psicología + 4 inventario + 2 competencia + 5 estrategia. Sumé mal, y el candado del
registro lo verifica — es exactamente lo que un documento no hace.

### El estado real, medido

| estado | señales | qué significa |
|---|---|---|
| **cableada** | **16** | está en `v_price_signals` y el motor la puede leer hoy |
| **disponible** | **13** | la fuente existe y está poblada, pero nadie la lee |
| ⛔ **no existe** | **17** | hay que construirla o capturarla — **cada una con su motivo escrito** |
| | **46** | de las cuales **35** son núcleo del v1 |

⚠️ **Corrijo una afirmación mía**: dije que el motor pasó "de 14 a 34 señales". Son **16
cableadas** — las otras columnas de la vista son derivadas y veredictos, no señales distintas. El
registro convirtió una cifra vaga en una auditable, que es para lo que existe.

---

## 1 · El objeto central: la **señal**

Todo el motor se apoya en una sola idea: **una señal es un número con su procedencia y su
cobertura**. No un número suelto.

```
señal = (qué mide · valor · de dónde salió · para cuántos aplica · cuándo se midió)
```

⛔ **Por qué no alcanza el número solo.** Una señal al 30 % de cobertura no puede pesar lo mismo
que una al 95 %, y hoy nada en el repo lo impide: el motor las sumaría como iguales. Es el mismo
defecto que la Fase VP midió — *frescura en 4 de 171 endpoints, cobertura en 1 pantalla*.

### El contrato de una señal

| campo | por qué |
|---|---|
| `clave` | `A1`…`G5` — estable, citable en una discusión |
| `valor` | **NULL cuando no se puede medir**, jamás 0 |
| `motivo` | por qué es NULL. Sin él, la ausencia es muda |
| `fuente` | la vista o tabla exacta, no "el ERP" |
| `cobertura_pct` | sobre el universo de esa señal |
| `medido_al` | la señal caduca; el consumidor decide si le sirve |

---

## 2 · El grano — y el choque que hay que resolver

Las cuatro fuentes **no comparten grano**, y ése es el problema de estructura que esta capa
existe para resolver:

| fuente | grano | filas |
|---|---|---|
| `v_price_psychology` | **(sucursal, sku)** | 86,163 |
| `v_kepler_standard_cost` | **(sucursal, sku)** | 86,638 |
| `v_kepler_margin_target` | (sucursal, sku, **peldaño**) | 259,914 |
| `v_price_waterfall` | **línea de factura** | ~6,700 / 7 d |

### La decisión

⭐ **El grano canónico es `(sucursal, sku)`.** Es donde vive la decisión de precio: se fija un
precio por producto y plaza, no por renglón de factura ni por peldaño.

Las otras dos se **reducen** a ese grano, y cada reducción tiene su regla explícita:

| fuente | cómo se reduce | ⛔ qué se pierde, declarado |
|---|---|---|
| **peldaño** → sku | el peldaño **más vendido** en la ventana, no el base | el margen difiere hasta **8 pp** entre peldaños; se publica `peldano_mixto` cuando la venta está repartida |
| **línea de factura** → sku | agregación **ponderada por importe** | el descuento por cliente: se publica la **dispersión**, no sólo la media |

⛔ **Y lo que NO se hace: promediar el peldaño.** Un margen de 22 % (pieza) con uno de 13.79 %
(caja) no promedia a 17.9 % — son dos negocios distintos. Se elige el que manda por venta y se
declara cuando la elección es dudosa.

---

## 3 · ⛔⛔ Las coberturas son **incomparables**, y eso decide la estructura entera

Medido el 2026-09-30 sobre los **86,163** pares (sucursal, sku) con precio:

| familia | fuente | cobertura |
|---|---|---|
| **Psicología** | `v_price_psychology` | **100.0 %** — 86,163 |
| **Meta y unidad** | `v_kepler_margin_target` | **97.5 %** — 83,976 |
| **Costo de reposición** | `v_kepler_standard_cost` | **38.2 %** — 32,877 |
| ⛔ **Cliente y descuento** | `v_price_waterfall` | **6.0 %** — 5,151 |

**La cascada sólo ve dos tipos de documento**: `UD0801` telemarketing ($10.96 M) y `UD1201`
crédito ($1.36 M). Son **$12.3 M de los ~$37.8 M** de venta en 30 días = **~33 %**. El mostrador
—dos tercios de la venta— es **contado anónimo**: no tiene cliente, y sin cliente no hay fuga
por cliente que medir. Es un límite de la fuente, no del diseño.

> ### ⭐ La consecuencia estructural: **no hay un solo score**
> Una señal al **6 %** y una al **100 %** no se pueden sumar en un número. Un motor que
> promediara la fuga con la terminación estaría decidiendo el precio del **mostrador** —dos
> tercios de la venta— con evidencia que **no lo incluye**, y el resultado se vería igual de
> confiable que cualquier otro.
>
> Por eso el motor publica **un veredicto por familia**, cada uno con su cobertura al lado, y
> **el peso de una señal nunca puede exceder su cobertura**. Lo que no se puede juzgar con la
> evidencia disponible se declara `sin_evidencia`, no se promedia hacia el medio.

⛔ **Y la trampa concreta que esto evita:** el descuento por vendedor (spread 1.41 % → 4.17 %)
es un hallazgo real **sobre el 33 % de la venta**. Presentarlo como "la fuga de la empresa"
sería extrapolar de telemarketing y crédito al mostrador, que opera distinto por construcción.

---

## 4 · Las cuatro capas

| capa | qué entrega | cómo se prueba |
|---|---|---|
| **1 · Estructura** *(este documento)* | el contrato de la señal y el grano canónico | que las reducciones estén escritas y sean reproducibles |
| **2 · Datos** | `analytics.v_price_signals` — una fila por (sucursal, sku), una columna por señal + su cobertura | ⛔ ninguna señal publicada sin cobertura · ninguna ausencia muda |
| **3 · Lógica** | el servicio que pondera y explica | ⭐ **cada propuesta nombra las 3 señales que más pesaron** |
| **4 · Visual** | la pantalla | contra el contrato de diseño medido |

---

## 5 · Las señales que esta tanda cablea

Sólo las que **ya existen en prod**. Nada construido nuevo.

### Ya cableadas — 14

Psicología (9) desde `v_price_psychology` · meta y unidad (5) desde `v_kepler_margin_target`.

### Se cablean ahora — ~20

| # | señal | fuente | ⚠️ |
|---|---|---|---|
| A1 | costo de reposición | `v_kepler_standard_cost` | por peldaño ya resuelto |
| A2 | costo estándar de la ficha | idem | |
| A3 | último costo **+ antigüedad** | idem | la antigüedad es la señal, no el costo |
| A4 | COGS del kardex | `mv_erp_margin_daily` | ⛔ **la matvista está VACÍA** |
| A6 | tendencia del costo | derivable de `v_label_price_changes` | |
| C2 | descuento realizado | `v_price_waterfall` | cobertura parcial |
| C3 | concentración en pocos clientes | idem | idem |
| C4 | descuento por vendedor | idem | idem |
| A9 | días de pago vs pactados | idem | idem |
| B3 | estacionalidad | `demand_acceleration` | grano SKU, no plaza |
| B6 | rotación | `inventory_health` | |
| G2 | clase ABC | `v_abc_class` | |
| G5 | promoción vigente | `v_erp_discount_rules` | 2 de 4 mecanismos **sin umbral verificado** |
| E1 | cobertura de inventario | `inventory_health` | |

⛔ **A4 no se va a poder cablear**: `mv_erp_margin_daily` existe pero nunca se pobló
(`relispopulated = false`). Se declara como señal ausente con su motivo, **no se omite**: una
señal que falta y no se nombra se lee como una señal que no hace falta.

---

## 6 · Lo que esta capa NO decide

- **Los pesos.** Nacen en tabla, no en `const` — el L4 de ADR-021 nunca se construyó en Horus ni
  en Thot, y este motor no repite eso.
- **El umbral de cada señal.** Va en `analytics.kpi_thresholds`, que ya existe (ADR-076).
- **Qué hacer con la señal.** Eso es la capa lógica.
