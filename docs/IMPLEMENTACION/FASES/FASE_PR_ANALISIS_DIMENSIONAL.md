# Fase PR — Análisis dimensional profundo del negocio

> **Qué es esto.** El análisis completo que sostiene el Motor de Precios: qué dimensiones existen,
> qué miden de verdad, dónde se contradicen entre sí, cuánto cuesta operar y cómo respira el año.
> **Todo medido el 2026-09-29** contra prod, sobre **4,635,571 filas** extraídas una sola vez.
>
> **Corrige tres cifras que yo mismo publiqué antes** (§7). Ninguna era mentira deliberada: las
> tres venían de mirar un agregado en vez de una distribución.

**Método:** extracción única por `COPY` → Parquet (522 MB CSV → **31.6 MB**, 48 s) → análisis en
Polars sin volver a tocar prod. El join que a Postgres le dio **timeout** (96,911 líneas de
recepción × 12,829 cabeceras) en Polars tardó **0.041 s**.

---

## 1. Las dimensiones del proyecto

### 1.1 El hecho central

| | |
|---|---|
| Filas | **4,635,571** |
| Periodo | 2025-01-01 → 2026-09-29 (**637 días**, 92 semanas) |
| Venta | **$1,076,046,683** |
| Costo | $944,988,369 |
| **Margen bruto** | **$131,058,314 · 12.18 %** |
| Grano | producto × almacén × canal × día × unidad — **único, verificado** |
| Memoria | 497 MB en Arrow |

### 1.2 Cardinalidad de cada eje

| Eje | Valores | Nota |
|---|---|---|
| Producto | **8,741** | de 14,866 en catálogo (11,278 vivos) |
| Almacén | **21** | ⛔ 8 tiendas + 13 rutas: **dos universos** |
| Canal | **10** | ⛔ en realidad **5** (ver 1.3) |
| Día | 637 | |
| Unidad de venta | 2 | `piece` / `weight` — **no sumables** |
| Marca | 564 | |
| Categoría | 346 | ⚠️ contaminada con nombres de proveedor |
| Proveedor | 376 | |
| Rotación | 4 | alta / media / baja / null |
| ⛔ Departamento | **1** | dimensión muerta |
| ⛔ Línea de producto | **1** | dimensión muerta |

### 1.3 ⭐ El canal mezclaba ERP con negocio — eran 5, no 10

`wincaja_credito` y `credito` son **el mismo canal de negocio en dos ERP**. Normalizado:

| Canal | Venta | % | Margen |
|---|---|---|---|
| **tienda** | $606.2 M | 56.34 % | **12.94 %** |
| **crédito** | $322.0 M | 29.92 % | ⛔ **9.93 %** |
| **ruta** | $92.8 M | 8.63 % | **14.94 %** |
| preventa | $31.9 M | 2.96 % | 13.57 % |
| mayoreo | $23.1 M | 2.15 % | 10.48 % |

⛔ **Crédito es el 30 % de la venta con el margen más bajo** — y encima carga un costo financiero
que **no está calculado en ningún lado** (no existe tasa de costo de capital en el repo).
Sin normalizar, el motor habría fijado precio para diez canales que son cinco.

### 1.4 El cubo es esparso

`8,741 × 21 × 10 × 637 = 1,169,283,570` celdas posibles · **4,635,571 con dato** ⇒ **densidad 0.3964 %**.
⛔ Cualquier promedio sobre el cartesiano está mal por construcción.

### 1.5 ⛔ Dos columnas que parecen métricas y no son aditivas

- **`units`**: `piece` da $34.32/unidad, `weight` da $52.37/unidad. Sumarlas mezcla piezas con kilos.
- **`tickets`**: un ticket con 5 productos aparece en 5 filas. Sumarlo entre productos **sobrecuenta**.
  Medido en Morelia Abastos: 5,215 "tickets"/día. **El ticket promedio real NO se puede sacar de
  este hecho** — hace falta el grano de ticket. Cualquier ticket promedio calculado así está
  **subestimado**.

### 1.6 Calidad del enlace catálogo ↔ venta

| | |
|---|---|
| Productos con venta que no existen en catálogo | **0** ✅ |
| Marcados como borrados pero vendiendo | 4 |
| **Sin categoría** | **1,687 SKUs · $18,935,463 (1.8 %)** |
| Sin proveedor | 882 SKUs · $6,313,092 (0.6 %) |

### 1.7 La unidad (ADR-057)

| Veredicto | Filas | % |
|---|---|---|
| verificado | 128,688 | **71.32 %** |
| no_aplica | 36,384 | 20.16 % |
| **sin_testigo** | 13,728 | **7.61 %** |
| **en_disputa** | 1,632 | 0.90 % |
| disputa_granel | 16 | 0.01 % |

Método: **dinero 70.7 %** · unidad_es_caja 19.22 % · **sin_metodo 6.57 %** · divisor 2.23 % · peso 1.29 %.
**17,568** filas sospechosas de master (pallet/granel) · 3,760 por peso.

### 1.8 Concentración — el Pareto, medido

| Cobertura | SKUs | % del catálogo vendido |
|---|---|---|
| **50 % de la venta** | **280** | 3.2 % |
| **80 % de la venta** | **1,150** | 13.2 % |
| 90 % | 2,010 | 23.0 % |
| 95 % | 2,895 | 33.1 % |

⭐ **280 SKUs mueven la mitad del negocio.** Ése es el tamaño real de la cola del motor.

---

## 2. ⭐⭐ El hallazgo mayor: dos tercios de la caída del margen NO son reales

El margen publicado cae de **12.58 % a 10.96 %** entre ene-2025 y sep-2026 (**−1.62 pp**).
Descompuesto por ERP:

| | Primer mes | Último mes | Cambio |
|---|---|---|---|
| **Wincaja** (medición real) | 12.59 % | 12.00 % | **−0.59 pp** |
| **Kepler** (álgebra) | 10.80 % | 10.68 % | −0.12 pp |
| **Total publicado** | 12.58 % | **10.96 %** | **−1.62 pp** |

| Descomposición de la caída | |
|---|---|
| Por **mezcla de ERP** (la migración) | **−1.04 pp · 64 %** |
| Por margen **real** | −0.58 pp · 36 % |

⛔ **Kepler subdeclara el margen 1.67 pp de forma estructural.** Y la migración avanza rápido:

| Mes | % de la venta en Kepler |
|---|---|
| 2025-01 … 2025-09 | 0 % |
| 2026-01 | 12.7 % |
| 2026-06 | 19.5 % |
| 2026-07 | 43.1 % |
| 2026-08 | 54.1 % |
| **2026-09** | ⛔ **79.1 %** |

**La prueba de que el costo de Kepler es álgebra y no medición** — spread del margen del **mismo
SKU** entre almacenes:

| ERP | SKUs en ≥2 almacenes | Spread mediano | p90 |
|---|---|---|---|
| **Kepler** | 5,089 | **0.0034 pp** | 0.0124 pp |
| **Wincaja** | 7,203 | **5.4770 pp** | 8.9174 pp |

Un costo derivado del precio es **ciego al precio**: no puede dar spread. Confirma ADR-051
enmendado, ahora con una medición independiente sobre el hecho mezclado.

> ### ⛔ Consecuencia para el motor de precios
> A este ritmo, **antes de que el motor entre en producción casi toda la venta tendrá un costo que
> no puede arbitrar el precio.** El trabajo de costo (`[MR.8.2]`, `c62 × c56`) **no es una etapa
> previa: es la condición de existencia**, y se vuelve más urgente cada mes.

---

## 3. Los costos operativos — y por qué la balanza no sirve por mes

### 3.1 ⛔ El margen mensual de la balanza es un artefacto

| Fuente | Desviación del ratio costo/ingreso |
|---|---|
| `analytics.ledger_monthly` | **17.24 pp** |
| Hecho de venta | **0.44 pp** |

El margen bruto contable mensual va de **−28.72 % (jun-2025) a +39.56 % (may-2025)**.
La causa está identificada: las cuentas **`509` (+$986.3 M)** y **`516` (−$987.3 M)** son un par
contra que casi se cancela (neto −$1.0 M) pero **con desviación mensual de $27.3 M cada una**.
El COGS contable **no está devengado al mes de la venta**.

⛔ **El neto cambia de signo según la ventana que elijas:**

| Ventana | Bruto | Gasto | **Neto** |
|---|---|---|---|
| 21 meses | 8.63 % | 9.14 % | **−0.99 %** |
| Últimos 12 | 11.18 % | 8.01 % | **+2.44 %** |
| 2025 completo | −0.28 % | 9.74 % | **−10.08 %** |
| 2026 ene-sep | 19.14 % | 8.44 % | **+9.71 %** |

**Publicar un margen neto sin declarar su ventana es publicar la mitad del dato.**

### 3.2 ⛔ Los dos universos no son el mismo

| | |
|---|---|
| Ingreso de la balanza (familia 4) | **$1,405,541,178** |
| Venta del hecho (`mv_sales_blended`) | **$1,076,046,683** |
| **Razón** | **1.306** — brecha **$329,494,495** |

### 3.3 ⭐ El piso operativo corregido

El gasto de operación (familia 6 + 7) son **$135,267,605** en 21 meses. Su porcentaje **depende del
denominador**:

| Denominador | Piso |
|---|---|
| Ingreso de la balanza | **9.62 %** ← cota inferior |
| Venta del hecho (lo que mide el motor) | **12.57 %** ← cota superior |

⛔ **El plan traía `P3 = 8.37 %`. Ninguna de las dos cotas lo respalda.** El rango defendible es
**9.62 % – 12.57 %**.

### 3.4 ⭐⭐ El resultado: la empresa opera en el punto de equilibrio

| | |
|---|---|
| Margen bruto del hecho | **12.18 %** ($131,058,314) |
| − costo de operar, cota inferior (9.62 %) | **neto +2.56 %** → **+$27,500,866** |
| − costo de operar, cota superior (12.57 %) | **neto −0.39 %** → **−$4,209,290** |

⭐ **El neto real está entre −$4.2 M y +$27.5 M sobre 21 meses.** En el escenario pesimista,
la operación **no cubre su costo**.

⭐ **+1 punto de margen bruto = $10,760,467.** En el escenario optimista es el 39 % de toda la
utilidad; en el pesimista **es la diferencia entre perder y ganar**.

### 3.5 Dónde está el gasto

98.76 % cae en la sucursal **`00`** → la contabilidad no segmenta.
⛔ **Prorratear para inventar un neto por SKU está prohibido** (ADR-056).

Las cuentas mayores más grandes (⚠️ `cuenta_mayor_nombre` está **NULL en las 12** — no sabemos cómo
se llaman):

| Cuenta | Monto | % de la venta |
|---|---|---|
| **601** | $68.97 M | **4.91 %** |
| 602 | $19.90 M | 1.42 % |
| 603 | $16.29 M | 1.16 % |
| 611 | $11.39 M | 0.81 % |

### 3.6 Lo único atribuible: ruta × día

`analytics.route_cost_snapshot` — 2,446 filas, 2026-01-02 → 2026-09-01, 13 rutas.
Gasto detallado: **$848,610.04**, **99 % combustible** (776 de 782 filas). Casetas y viáticos viven
en `logistics.shipment_expenses`, que está **vacía**.

> ### ⛔ Pero las dos fuentes de ruta se contradicen
>
> | | Snapshot | Hecho de venta | Brecha |
> |---|---|---|---|
> | Margen (mediana de 13 rutas) | **22.7 %** | **14.0 %** | **+8.24 pp** |
> | Venta (razón snapshot/hecho) | — | — | **1.126** (hasta **1.696** en RUTA-505) |
>
> No coinciden **ni en la venta ni en el margen**. Antes de usar cualquiera para decidir precio hay
> que establecer cuál arbitra.

---

## 4. Comparativas

### 4.1 Año contra año (ene–sep, comparable)

| | 2025 | 2026 | |
|---|---|---|---|
| Venta | $422.3 M | $467.5 M | |
| **Venta diaria** | $1,546,822 | **$1,718,673** | **+11.1 %** |
| Margen | 12.56 % | 11.84 % | **−0.72 pp** |

⚠️ El total no es comparable (19 → 21 almacenes). La **venta diaria por almacén** sí:

| Crecen | | Caen | |
|---|---|---|---|
| RUTA-21 | **+28.0 %** | **03 8ESQ** | ⛔ **−30.9 %** |
| RUTA-23 | +20.5 % | RUTA-321 | −13.4 % |
| RUTA-28 | +19.3 % | RUTA-322 | −11.1 % |
| RUTA-22 | +18.2 % | **01 Padre Hidalgo** | −5.3 % |
| 07 Morelia Madero | +12.4 % | **06 Canindo** | −5.0 % |
| | | **08 Morelia Abastos** | −3.0 % |

⭐ **Patrón claro: las rutas crecen a doble dígito, las tiendas grandes se contraen.**
Y 8ESQ pierde casi un tercio — eso merece explicación aparte.

### 4.2 Margen por almacén, normalizado por mezcla de canal

| Almacén | Venta | Margen crudo | Normalizado | **Efecto mezcla** |
|---|---|---|---|---|
| 08 Morelia Abastos | $357.4 M | 11.49 % | 11.45 % | −0.04 |
| 01 Padre Hidalgo | $231.6 M | 12.70 % | 13.24 % | +0.54 |
| 06 Canindo | $221.1 M | 11.18 % | 11.51 % | +0.33 |
| 07 Morelia Madero | $56.9 M | **15.05 %** | 15.35 % | +0.30 |
| 03 8ESQ | $41.8 M | **10.57 %** | 10.58 % | +0.01 |
| **RUTA-27** | $11.1 M | **14.45 %** | **11.25 %** | ⛔ **−3.20** |
| RUTA-26 | $9.9 M | 14.00 % | 11.19 % | ⛔ **−2.81** |
| RUTA-21 | $10.3 M | 13.81 % | 11.12 % | ⛔ **−2.69** |

⭐ **El margen alto de las rutas es mezcla, no desempeño de precio.** Normalizado, están al nivel
de las tiendas.

### 4.3 ⭐ A13 resuelto — la pregunta que daba timeout a los 120 s

| | |
|---|---|
| Desviación **intra**-categoría (mediana) | **1.61 pp** |
| Rango p90−p10 intra-categoría | 3.02 pp |
| Desviación **entre** categorías | **1.95 pp** |
| **Razón intra/entre** | ⭐ **0.83×** |

✅ **Una meta de margen por categoría SÍ es defendible**: la variación entre categorías es mayor que
la de adentro. El plan de 142 metas por categoría sobrevive.

⚠️ Con **10 excepciones medidas** donde una meta única hace daño:
`PRODUCTOS CON BAJA ROTACION` (sd **9.4 pp**), `DART DE MEXICO` (7.3), `MARCAS EXTRAORDINARIAS`
(7.3), `FRUTYFRESK` (6.4), `MEGA DULCES DE LOS ALTOS` (6.3), `PIÑATAS` (5.5).

### 4.4 La exposición bajo el piso

| Umbral | Pares (SKU, almacén) | % | Venta | % |
|---|---|---|---|---|
| Bajo costo (0 %) | 179 | 0.3 % | $84,507 | 0.0 % |
| **Piso inferior (9.62 %)** | 7,289 | 10.6 % | **$98,118,515** | 9.1 % |
| `thin` actual (10 %) | 11,812 | 17.2 % | $221,559,875 | 20.6 % |
| ⛔ **Piso superior (12.57 %)** | **23,105** | **33.6 %** | ⛔ **$570,633,530** | ⛔ **53.0 %** |
| Objetivo 15 % | 41,255 | 60.0 % | $933,299,669 | 86.7 % |

⭐ **Cerrar la brecha hasta el piso en los 23,105 pares vale $9,849,949 = 0.92 pp de margen** —
casi el punto entero que separa perder de ganar.

Los 12 SKU que más dinero tienen bajo el piso (valen **$1,397,036** solos):

| SKU | Nombre | Venta | Margen | Plazas |
|---|---|---|---|---|
| 70001 | LA ROSA MAZAPAN /30 | $9.06 M | 10.15 % | 9 |
| 70056 | LA ROSA MAZAPAN GIGANTE 50G | $8.46 M | 10.22 % | 9 |
| 70068 | LA ROSA JAPONES TUBO 60G 12P | $6.49 M | 10.13 % | 8 |
| 42029 | KINDER DELICE 10P 39G | $5.84 M | 11.05 % | 4 |
| 70079 | PAL JUMBO CEREZA /50 LA ROSA | $5.67 M | 9.90 % | 9 |
| **20021** | **CANELS 4S BOLSA 1Kg** | $5.40 M | ⛔ **7.27 %** | 7 |
| 63018 | BIMBO BOCADIN BOLSA /50P | $5.00 M | 8.48 % | 10 |
| 20005 | CANELS 4S SURTIDO DISPLAY 60P | $4.54 M | 8.58 % | 13 |

⭐ **La Rosa aparece 6 veces.** Es el proveedor #1 ($160.3 M, 11.32 % de margen) y concentra la
brecha. Eso es una conversación de compras, no de precios.

---

## 5. Estacionalidad

### 5.1 Día de la semana — el patrón más fuerte que existe

| Día | Venta/día | Índice |
|---|---|---|
| **Martes** | $2,015 K | **+19.3 %** |
| **Jueves** | $1,968 K | **+16.5 %** |
| Sábado | $1,853 K | +9.7 % |
| Lunes | $1,851 K | +9.6 % |
| Miércoles | $1,735 K | +2.7 % |
| Viernes | $1,693 K | +0.2 % |
| **Domingo** | $710 K | ⛔ **−58.0 %** |

### 5.2 ⛔ El efecto quincena **no existe** — refutado con medición

| Tramo | Índice |
|---|---|
| Arranque de mes (1–5) | **−2.2 %** |
| Post-quincena (15–20) | +1.0 % |
| "Valle" (8–13) | **+2.8 %** |

**Amplitud: −1.8 %.** El supuesto "valle" es el tramo **más alto** del mes.
⭐ **Para un mayorista de dulce la quincena no manda** — manda el día de la semana. Cualquier regla
de precio o de abasto que asuma efecto quincenal está calibrando sobre ruido.

### 5.3 Mes del año

| Mes | Índice | | Mes | Índice |
|---|---|---|---|---|
| **dic** | ⭐ **+43.3 %** | | jul | −4.4 % |
| nov | +6.1 % | | ene | −4.5 % |
| oct | +1.1 % | | ago | −5.4 % |
| feb | +0.1 % | | sep | −5.4 % |
| abr | −3.9 % | | mar | −8.4 % |
| | | | jun | −8.4 % |
| | | | **may** | **−10.4 %** |

⚠️ **oct–dic sólo tienen 2025** (menos almacenes) → su índice **no es limpio**. Diciembre es real
y enorme, pero su magnitud exacta necesita el cierre de 2026.

### 5.4 ⭐ La semana tiene forma distinta por canal

Índice sobre el propio promedio de cada canal (100 = su media):

| Canal | lun | mar | mié | jue | vie | sáb | dom |
|---|---|---|---|---|---|---|---|
| **mayoreo** | 93 | **154** | 72 | **149** | ⛔ **60** | 72 | — |
| **crédito** | 110 | **145** | 110 | **148** | 89 | 91 | ⛔ 6 |
| ruta | 120 | 127 | 117 | 113 | 116 | 91 | 16 |
| preventa | 105 | 110 | 112 | 119 | 118 | 112 | 23 |
| **tienda** | 105 | 101 | 96 | 98 | 104 | **122** | 74 |

⭐ **Mayoreo y crédito se concentran martes y jueves** (y mayoreo casi no vende viernes).
**Tienda es el único que sube el sábado.** Un modelo de demanda con un solo efecto de día de la
semana está promediando cinco formas distintas.

### 5.5 ¿El margen es estacional?

Por día: entre 11.85 % (jueves) y 13.19 % (domingo) — **1.34 pp**, y el domingo es alto porque cae
el canal de crédito, que es el de menor margen. **No es estacionalidad de precio: es mezcla.**

Por mes: amplitud **1.70 pp** — pero ya vimos (§2) que **64 % de eso es la migración de ERP**.

---

## 6. Qué cambia esto en el Motor de Precios

| # | Hallazgo | Consecuencia |
|---|---|---|
| 1 | El costo de Kepler no arbitra, y ya es el **79.1 %** de la venta | `[MR.8.2]` deja de ser etapa previa: es **condición de existencia** |
| 2 | Piso operativo **9.62–12.57 %**, no 8.37 % | `P3` se corrige; **53 % de la venta queda bajo el piso** |
| 3 | La empresa está en **punto de equilibrio** | +1 pp = $10.76 M = la diferencia entre perder y ganar |
| 4 | Intra/entre categoría = **0.83×** | ✅ la meta por categoría **sí** sirve (142 filas), con 10 excepciones |
| 5 | El canal eran **5**, no 10 | El motor fija precio sobre el eje correcto |
| 6 | **Crédito**: 30 % de la venta, margen 9.93 %, sin costo financiero calculado | El canal con más volumen y menos margen es el que peor se entiende |
| 7 | **280 SKUs = 50 %** de la venta | La cola cabe; el top-848 del plan es holgado |
| 8 | **La quincena no existe**; el día de la semana sí, y **cambia por canal** | Los efectos fijos del modelo van por canal×día, no globales |
| 9 | `units` y `tickets` **no son aditivos** | Toda métrica derivada de ellos necesita su guarda |
| 10 | Las rutas crecen +20 %, las tiendas caen | La mezcla se mueve hacia el canal de mayor margen aparente… que normalizado no lo es |

---

## 7. ⛔ Correcciones a lo que yo mismo publiqué antes

| Dije | Es | Por qué me equivoqué |
|---|---|---|
| "Margen neto **1.28 %**" | **Entre −0.39 % y +2.56 %**, y el dato contable **cambia de signo** según la ventana (−10.08 % en 2025, +9.71 % en 2026) | Tomé una ventana de 12 meses sin verificar que el COGS contable estuviera devengado. **No lo está**: el par de cuentas 509/516 oscila $27 M al mes |
| "Piso operativo **8.37 %**" | **9.62 % – 12.57 %** | Dividí el gasto entre el ingreso **de la balanza**, pero el motor mide sobre el **hecho de venta**, que es **30.6 % más chico** |
| "+1 pp ≈ **+78 %** de utilidad neta" | **+1 pp = $10,760,467**, que es 0.4× la utilidad optimista y **más que toda** la pesimista | El "+78 %" salía de dividir entre un neto que ahora sé que no era confiable |

⭐ **Lo que las tres tienen en común:** salieron de un **agregado**. Las tres se cayeron al mirar la
**distribución** — la balanza mes a mes, el margen por ERP, el ratio entre universos.
Es exactamente lo que este análisis vino a hacer.

---

## 8. Huecos declarados (ADR-056)

| Hueco | Estado |
|---|---|
| Ticket promedio real | 🟥 no calculable sin grano de ticket |
| Margen neto por SKU / canal / cliente | 🟥 98.76 % del gasto en sucursal `00` |
| Costo financiero del crédito | 🟥 no existe tasa en el repo — y crédito es el 30 % de la venta |
| Depreciación y seguro de flota | 🟥 `vehicles` guarda el número de póliza, no la prima |
| Nombres de las cuentas de gasto | 🟥 `cuenta_mayor_nombre` NULL en las 12 mayores |
| Casetas y viáticos | 🟥 `logistics.shipment_expenses` vacía |
| Cuál fuente arbitra el margen de ruta | 🟠 snapshot y hecho difieren 8.24 pp y 12.6 % en venta |
| Índice estacional de oct–dic | 🟠 sólo 2025, con menos almacenes |
| Por qué 8ESQ cae **−30.9 %** | 🟠 sin explicación |

---

## 9. Los dos gates del motor, corridos (2026-09-29)

### 9.1 ✅ `PR-6` — el costo SÍ empuja el precio. **El instrumento pasa.**

El intento previo medía **coincidencia de fechas** y dio azar (44.1 % contra placebo 43.4 %).
Rehecho por **magnitud acumulada**, en diferencias logarítmicas, con llave
`(sucursal, sku, unidad)` — el costo por PAQ contra el precio por PAQ, **conmensurable por
construcción**: **19,719 series**, **8,300 pares** con las dos piernas.

| Especificación | n | β | F |
|---|---|---|---|
| Crudo | 8,300 | **+0.2353** | ⭐ **125.0** |
| Winsorizado p1–p99 | 7,984 | +0.4012 | **137.0** |
| Régimen normal (\|Δln\|<0.5) | 6,806 | +0.1942 | **128.9** |
| **Placebo × 5** | 8,300 | **+0.0060** | ⛔ **0.2** |

✅ **F > 10 en las tres. Placebo limpio (separación de 600×). Gate C pasado.**

**Perfil del rezago:** 0–7 d F=41.2 · **0–15 d F=69.7** (pico) · 0–30 d F=27.4 · 0–90 d F=12.5 ·
0–180 d F=0.0. **El precio responde en quince días**, no en lote trimestral.

> ### ⭐⭐ El hallazgo de negocio
> **Absorbemos el 76 % del shock de costo en el margen.** Un +10 % de costo del proveedor mueve
> nuestro precio sólo **+2.35 %**. Con margen bruto de 12.18 % y neto en equilibrio, **ése es el
> mecanismo por el que el margen se erosiona.**

⚠️ **R² = 0.015–0.019**: el costo explica poco de la varianza del precio — lo esperable si el
precio es una decisión humana. Para un instrumento lo que importa es la F, y sobra.

⚠️ **Dos limpiezas que hicieron falta, y son lección de método:**
1. La bitácora trae **13 % de cambios sub-centavo** (63,828 de 491,608).
2. ⛔ **Sumar los cambios log acumula deriva falsa**: el p25 del acumulado daba **−2.603 (−92 %)**.
   Se mide por **extremos** (primer precio → último), no por suma.

### 9.2 ⛔ La palanca elegida está **refutada**: el markup no mueve el precio

| Prueba | Resultado |
|---|---|
| Precio = `cost_base × (1+markup)` a ±1 % | ⛔ **1.50 %** |
| … a ±5 % | ⛔ **9.10 %** |
| … a ±10 % | 36.60 % |
| Regresión razón real ~ teórica (vs `cost_base`) | β=+0.63 · **R²=0.0223** |
| Contra el **costo pagado**, unidad casada | β=+1.56 · R²=0.0999 · ±5 %: **21.61 %** |

⛔ **El `markup_pct` del catálogo explica entre el 2 % y el 10 % del precio publicado.**
La decisión de recomendar markup (una acción que Kepler propagaría a 9 plazas y 3 peldaños)
**no se sostiene**. Consecuencias: el motor recomienda **precio explícito**, la coherencia de
presentaciones y de canales vuelve a ser problema del motor, y el tope de **106 SKU/día**
vuelve a morder.

### 9.3 ✅ De paso: el margen real, con la unidad probada

Casando costo pagado y precio **de la misma unidad** (PAQ→`pack_price`, PZA→`piece_price`,
CJA→`box_price`), sobre **4,789 pares**:

| | |
|---|---|
| Razón precio/costo **real** | **1.2589** |
| Razón que declara `markup_pct` | 1.1280 |

⭐ **El markup declarado subdeclara el real en ~13 pp** (12.80 % contra 25.89 %).
Confirma y corrige el sondeo previo de 1.2307, que se había hecho **sin probar la unidad**.

---

## 10. E3 — la elasticidad, estimada (2026-09-29)

**Panel:** 3,859,034 filas (`piece`, sucursales 01-08 donde existe el instrumento) →
**187,973 celdas semanales · 8,674 entidades (sku × almacén) · 92 semanas**.
Efectos fijos a dos vías, errores estándar agrupados por entidad, instrumento = costo del
proveedor propagado a la semana.

⚠️ Tras los efectos fijos sobrevive el **14.1 %** de la varianza de `ln p` y el **21.2 %** de
`ln c`. Hay con qué identificar, pero poco.

### 10.1 β es estable; la F no

| Mín. semanas | Celdas | Entidades | F | β 2SLS | SE |
|---|---|---|---|---|---|
| **10** | 187,973 | 8,674 | **14.2** | **−0.7384** | 0.2574 |
| 15 | 152,418 | 5,729 | 13.1 | −0.6854 | 0.2641 |
| 20 | 124,881 | 4,067 | 10.5 | −0.8200 | 0.2772 |
| 30 | 71,981 | 1,890 | 5.4 | −0.8766 | 0.3504 |
| 40 | 30,077 | 666 | 2.2 | −0.7041 | 0.5187 |

⭐ β se mueve entre **−0.69 y −0.88** en todas. Robusto.

### 10.2 ⛔ `F ≈ 10-14` no alcanza — manda Anderson-Rubin

La regla `F > 10` es de Staiger-Stock (1997). **Lee-McCrary-Moreira-Porter (2022)**: con `F = 10`
el test t al 5 % rechaza al **~30 %**; para inferencia t válida hacen falta **F > 104.7**.

> ### ✅ Región Anderson-Rubin al 95 %: **[−1.415, −0.045]** — acotada y **excluye el cero**

### 10.3 ⛔ Por categoría NO se identifica

| | |
|---|---|
| Categorías con variación suficiente en el instrumento | 65 |
| Con **β positiva** (curva de demanda al revés) | ⛔ **22 de 65** |
| Con F>10, β negativa, \|β\|<4 y significativa | ⛔ **2** |

⚠️ Auditoría de las raras: `INTER CANDY` (F=28,335) **es legítima** — `sd(z)=0.21`,
`corr(z,x)=0.895`, entidad mayor 7 % de las filas. La artefactual era `DISTRIBUIDORA GARMIN`
(β=+7.07) con `sd(z)=0.021` y `corr=0.083`: **F inflada por dividir entre casi cero.**
El freno de varianza mínima la sacó.

### 10.4 ⭐⭐ La incertidumbre no cambia la decisión

`Δmargen/margen = (Δp/p)·(1/m) − (Δp/p)·|ε|`, con `m = 12.18 %`:

| Elasticidad | Δ margen bruto | Δ margen $ | Δ volumen |
|---|---|---|---|
| −0.045 (extremo AR) | **+8.17 %** | **+$10,701,491** | −0.04 % |
| −0.7384 (punto 2SLS) | +7.47 % | +$9,792,732 | −0.74 % |
| −1.415 (extremo AR) | **+6.80 %** | **+$8,905,992** | −1.42 % |
| ⭐ **−8.21** | **0.00 %** | **$0** | −8.21 % |

> **En toda la región Anderson-Rubin, +1 % de precio mejora el margen bruto entre +6.80 % y
> +8.17 % — entre $8.9 M y $10.7 M.** La elasticidad de equilibrio es **−8.21** y lo medido llega
> a −1.415: está **5.8 veces lejos**.
>
> ⭐⭐ **No hace falta acertar la elasticidad para decidir.** Ése es el entregable de E3.

### 10.5 ⛔ Lo que NO dice

- **Sin respuesta de la competencia**: mide *nuestra* demanda, no el equilibrio de mercado.
- **Corto plazo** (semanal); la pérdida de cliente al mayoreo tiene horizonte más largo.
- **Sin elasticidad cruzada**: el volumen que se va a un sustituto no se ve.
- El panel son **8,674 de 41,858 entidades (20.7 %)**.
- `−0.74` **no es "la" elasticidad**: es el centro de un rango ancho.

---

## 11. Gate B y el veredicto sobre la exclusión (2026-09-29)

**Diseño:** 10,887 shocks de costo (5 %–172 %), **4,949 limpios** (sin otro shock a ±8 semanas).
Ventana −8…+8, base `t = −1`, shocks al alza **menos** los a la baja, efectos fijos de evento y de
semana calendario, EE agrupados por evento. **1,098 eventos · 16,336 celdas.**

### 11.1 ✅ Pasa en lo que prueba: la CANTIDAD

Coeficientes previos (t = −8…−2): +0.014 · +0.020 · −0.000 · +0.005 · +0.023 · +0.048 · +0.065.
**Todos con t < 1.80. Wald conjunto 5.60 con 7 gl (crítico 14.07) → no se rechaza.**

⚠️ **Con poca potencia:** SE ~0.04 sobre coeficientes de ~0.05. *No rechazar* ≠ *probar que no hay*.

### 11.2 ⛔ Pero el PRECIO sí se mueve antes

| t | −8 | −7 | −6 | −5 | −4 | −3 | −2 |
|---|---|---|---|---|---|---|---|
| coef | −0.031 | −0.033 | −0.025 | −0.024 | −0.026 | −0.018 | −0.010 |
| t | −2.25 | −2.66 | −2.26 | −2.41 | **−2.75** | −2.22 | −2.21 |

Los 7 son **individualmente significativos** (el Wald conjunto 11.40 no llega a 14.07 porque están
correlacionados: es una tendencia suave). El precio ya venía subiendo ~3 % en las 8 semanas previas.

⭐ **Lectura más probable, benigna:** la fecha de **recepción** es un proxy **rezagado** de cuándo
el proveedor cambió el precio. Nos avisan, subimos, y el costo nuevo llega con la siguiente entrega.
Es artefacto de medición del instrumento — la exclusión se juzga sobre la *cantidad*, y ahí no hay
pre-tendencia.

### 11.3 ⭐ La respuesta posterior del precio es nítida

`t=0` **+1.61 %** → meseta **+1.7 % a +2.2 %** hasta `t=+8`, con **t entre 4.45 y 7.34**.

### 11.4 ⭐⭐ El control que más vale: dos métodos independientes coinciden

| Método | Traspaso |
|---|---|
| Estudio de evento (+2.00 % / shock mediano +10.00 %) | **0.2099** |
| Meseta `t=+1..+3` (+2.13 % / +10.00 %) | 0.2235 |
| **`PR-6`, regresión de magnitudes acumuladas** | **0.2353** |
| **Diferencia** | ⭐ **0.025** |

**Dos caminos sin nada en común dan el mismo número.**

### 11.5 ⛔⛔ Leave-one-out del proveedor: `NO MEDIDO`

Para atacar la exclusión de frente se instrumentó con el shock **promedio del proveedor en sus
otros SKUs**: si el costo sube porque subió la demanda de *este* SKU, el LOO no lo recoge.

| | |
|---|---|
| F de 1ª etapa | 16.51 |
| **β** | **−0.0080** |
| **IC 95 %** | ⛔ **[−1.941, +1.925]** |

⛔ **El script imprimió `✅ sobrevive` mirando sólo la F, y está mal.** Ese intervalo contiene el
cero, el −0.74 y el +1.9: **no confirma ni refuta**. El panel LOO son **5,151 celdas contra
187,973 = 2.7 %**. Y `corr(shock propio, shock LOO) = 0.3677`: la mayor parte de la variación que
identifica es **específica del SKU**, justo la que puede traer demanda adentro.

> ### Veredicto de identificación
> | Condición | Estado |
> |---|---|
> | **Relevancia** | ✅ fuerte, confirmada dos veces por métodos distintos |
> | **Sin pre-tendencia en la cantidad** | ✅ pasa ⚠️ con poca potencia |
> | **Exclusión** | ⛔ **`NO MEDIDO`** — sigue siendo supuesto |
>
> No invalida el entregable de §10.4 (la decisión es la misma en toda la región AR, y eso
> descansa en la magnitud, que es robusta). Pero **el coeficiente −0.74 no se publica como causal
> sin esta salvedad al lado**.

---

## 12. ⭐⭐ El árbitro de costo, verificado contra prod SIN aplicar nada (2026-09-29)

Sonda **read-only** que replica el cuerpo de `[MR.8.2]` (`20260929120000_mv_erp_margin_daily.js`,
nunca aplicada) con el mapa de rutas en línea, sobre **14 días**.

### 12.1 Cobertura

| | |
|---|---|
| Celdas | **102,069** · 228,919 líneas |
| **Líneas con costo `c62`** | **223,119 = 97.47 %** |
| Líneas con costo > venta | **94 = 0.041 %** (baseline previo: 7.4 %) |
| Venta | $21.10 M · **margen arbitrado 14.94 %** |
| Tiempo | **5.5 s** |

### 12.2 ⭐⭐ ANTI-ESPEJO — el árbitro **sí arbitra**

Un costo derivado del precio por álgebra **no puede** tener spread de margen entre plazas del
mismo SKU: es `m/(1+m)`, función sólo del markup.

| Fuente | SKUs | Spread medio | Mediano | p90 | **SKUs con spread CERO** |
|---|---|---|---|---|---|
| ⭐ **Árbitro `c62 × c56`** | 130 | **3.2082 pp** | **2.9570** | 5.5735 | ⭐ **0** |
| ⛔ Publicado (`mv_sales_blended`) | 242 | 0.3756 pp | **0.2367** | — | ⛔ **15** |

**12.5× más discriminante, y cero SKUs planos contra quince.**

### 12.3 ⭐ CONTRADICE — y el publicado es PLANO entre plazas

| Almacén | Arbitrado | Publicado | Brecha |
|---|---|---|---|
| 08 Morelia Abastos | 13.83 % | 10.77 % | +3.05 |
| 01 Padre Hidalgo | 15.25 % | 10.76 % | +4.49 |
| 06 Canindo | 14.25 % | 10.85 % | +3.39 |
| 03 8ESQ | **16.32 %** | 10.59 % | **+5.73** |
| 07 Morelia Madero | 15.43 % | 10.62 % | +4.82 |
| RUTA-28 | 16.40 % | 10.42 % | **+5.99** |
| **Rango** | **13.83 – 16.84 %** | **10.42 – 11.26 %** | **+2.82 a +5.99** |

⭐⭐ **El publicado varía 0.84 pp entre plazas; el árbitro varía 3.01 pp.** Ésa es la firma:
el álgebra no puede distinguir una plaza de otra, el árbitro sí.

### 12.4 ⛔ El control que faltaba: ¿son el mismo universo?

La venta publicada es **1.0814×** la bruta del ERP — o sea **no son el mismo universo**, y
comparar 14.94 % contra 10.79 % entre universos distintos **no sería una afirmación de negocio**.
Se cruzó celda a celda (almacén × producto × día):

| | |
|---|---|
| Celdas del árbitro | 95,076 |
| Celdas del publicado | 96,489 |
| ⭐ **Comunes** | **90,328 (95.0 %)** |
| Venta del árbitro (bruta) | $23.005 M |
| **Venta publicada EN LAS COMUNES** | ⭐ **$22.982 M** — cuadra al **0.1 %** |

> ### ⭐⭐ Sobre las 88,942 celdas comunes con costo:
> | Margen arbitrado | Margen publicado | **Brecha** |
> |---|---|---|
> | **14.95 %** | **10.70 %** | ⭐ **+4.26 pp** |
>
> **Con el universo controlado la brecha se sostiene — y crece.** Reproduce lo que la propia
> migración midió en su gate (+4.16 pp).

### 12.5 Lo demás

- **Cero almacenes** con venta agregada bajo costo.
- Un solo SKU×sucursal bajo costo sobre $3,000: `99033 * CLAMATO 2.54 LT` en la 01,
  **−15.23 %** de margen ($3,889 de venta contra $4,482 de costo, 13 líneas).
- ⛔ La consulta de "qué celdas ve el publicado y el árbitro no" **no se pudo correr**
  (`NOT EXISTS` sobre 96k celdas agotó el tiempo). **`NO MEDIDO`.**

### 12.6 ⛔ Lo que esto abre, y NO se resuelve acá

Ahora hay **tres mediciones del margen bruto que no coinciden**, y la diferencia llega a **6.3 pp**:

| Fuente | Margen bruto |
|---|---|
| `analytics.ledger_monthly` (la balanza) | **8.63 %** |
| `analytics.mv_sales_blended` (el hecho publicado) | **12.18 %** |
| ⭐ **Árbitro `c62 × c56`** (la línea del ERP) | **~14.95 %** |

⭐ **El patrón es consistente: cuanto más cerca de la línea de la transacción, más alto el margen.**
⛔ **Cuál manda para el P&L de la empresa NO está resuelto** y no se decide con esta sonda.
Se DECLARA. Lo único probado acá es que **el árbitro discrimina y el álgebra no**, y que el
publicado **subdeclara 4.26 pp donde Kepler es la fuente** — que hoy es el **79.1 %** de la venta.

---

## 13. ⛔⛔ D12 — de dónde sale la brecha de 6.3 pp, y lo que apareció al buscarla

### 13.1 La cascada, descompuesta

| Paso | Margen | Δ |
|---|---|---|
| ① `ledger_monthly`, toda la familia 5 | **8.63 %** | — |
| ② `ledger_monthly`, sólo la cuenta 511 (mercancía) | 10.79 % | **+2.16** |
| ③ `mv_sales_blended` (el hecho publicado) | 12.18 % | **+1.39** |
| ④ Árbitro `c62 × c56` (la línea del ERP) | **14.95 %** | **+2.77** |

| Componente | pp | % de la brecha |
|---|---|---|
| Ajustes contables fuera de 511 | +2.16 | **34.1 %** |
| Universo (balanza vs hecho) | +1.39 | 22.0 % |
| **Método de costo** (álgebra vs línea) | +2.77 | **43.8 %** |

### 13.2 El componente contable: los traspasos internos no netean

| Cuenta | Nombre | Monto |
|---|---|---|
| 515-001 | TRASPASO ENTRADA | **+$293.31 M** |
| 515-002 | TRASPASO SALIDA | **−$328.32 M** |
| 515-001 / 515 / 515-002 | (sin nombre y ajustes) | +$66.75 M |
| | ⛔ **NETO en el costo de ventas** | ⛔ **+$31,734,793** (2.26 % del ingreso) |

En una balanza **consolidada** un traspaso entre sucursales propias debe netear a cero.
Entrada y salida declaradas difieren en **$35,013,815**.

### 13.3 ⭐⭐ Y buscando el componente «universo» apareció esto

`401-002 VENTA FLETES A TERCEROS` = **$534,809,684 = 38.05 %** del ingreso de la balanza,
casi todo en la sucursal **`00`** (Oficinas). **No es un negocio de fletes.**

| Mes | Mercancía | Flete | **TOTAL** | % flete | **Hecho de venta (ERP)** | hecho/merc |
|---|---|---|---|---|---|---|
| 2025-10 | $58.2 M | $7.6 M | $65.8 M | 11.6 % | $54.3 M | **0.93** |
| 2025-11 | $58.0 M | $8.1 M | $66.1 M | 12.2 % | $55.1 M | **0.95** |
| **2026-01** | ⛔ **$8.4 M** | ⛔ **$57.2 M** | $65.7 M | ⛔ **87.1 %** | $53.2 M | ⛔ **6.30** |
| **2026-02** | $7.9 M | $51.3 M | $59.3 M | 86.6 % | $48.2 M | **6.07** |
| ⭐ **2026-03** | **$62.0 M** | **$0.2 M** | $62.2 M | ⭐ **0.3 %** | $51.0 M | ⭐ **0.82** |
| 2026-04 | $8.3 M | $56.7 M | $65.1 M | 87.2 % | $53.6 M | **6.44** |
| 2026-07 | $22.8 M | $57.6 M | $80.4 M | 71.6 % | $54.7 M | 2.39 |
| 2026-08 | $34.9 M | $56.5 M | $91.4 M | 61.8 % | $54.3 M | 1.56 |
| 2026-09 | $53.1 M | $42.2 M | $95.3 M | 44.3 % | $50.6 M | **0.95** |

> ### ⭐⭐ Las tres pruebas que lo cierran
> 1. **El TOTAL apenas se mueve** (media $59.0 M en 2025 → $71.7 M en 2026, +21.6 %) mientras la
>    composición se da vuelta: **% flete de 12.3 % a 66.8 %**. El dinero no cambió de negocio,
>    cambió de **cuenta**.
> 2. ⭐ **El control independiente: el hecho de venta del ERP no se movió.** Sigue en $48–55 M
>    todos los meses. La razón `hecho/mercancía-contable` pasa de **0.86–0.99** en 2025 a
>    **6.30–6.44** en 2026, y **vuelve a 0.95 en septiembre**.
> 3. ⭐ **2026-03 es la excepción** (0.3 % de flete, razón 0.82): **ese mes se registró bien.**
>    Un cambio de modelo de negocio no se apaga un mes y se vuelve a prender.
>
> **Exceso sobre la tasa del régimen 2025 (12.27 %): ⛔ $352,070,966 = 54.5 % del ingreso de 2026.**

⛔ **Es un hallazgo de CONTABILIDAD, no del motor de precios** — pero explica por qué la balanza
no cuadra con el hecho de venta y por qué su margen mensual es inservible.
**Necesita que Contabilidad lo explique antes de que nadie lo llame error.**

### 13.4 ⛔ La consecuencia: `P3` no es determinable hoy

El piso operativo cambia según el denominador, y ninguno es defendible mientras la
clasificación esté rota:

| Denominador | Piso |
|---|---|
| Ingreso total de la balanza | 9.62 % |
| Venta del hecho | 12.57 % |
| Ingreso «de mercancía» de la balanza | **15.53 %** |

⛔ **Tercera corrección del mismo número, y es la honesta:** el plan trajo **8.37 %**, lo corregí a
**9.62–12.57 %**, y ahora resulta que **ninguna es defendible**. `P3` queda **`NO DETERMINABLE`**
hasta que la clasificación se arregle. **Es decisión contable, no cálculo.**

### 13.5 Lo que sí queda firme

- ✅ El **árbitro de costo** discrimina y el álgebra no (§12) — **43.8 % de la brecha, y es la
  parte que el motor de precios puede arreglar solo**.
- ✅ El **hecho de venta del ERP es estable** y sirvió de control independiente para detectar
  la reclasificación. Es la fuente más confiable de las tres.
- ⛔ `ledger_monthly` **no se usa para margen** hasta que 13.3 se resuelva.
