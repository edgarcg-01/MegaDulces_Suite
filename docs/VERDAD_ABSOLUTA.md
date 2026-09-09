# La verdad absoluta — qué la arbitra, cuánto se sostiene, y qué se declara

> **Fuente principal de razón del sistema.** Pedido de Edgar (2026-09-08): *"necesitamos verdad
> absoluta de existencia, ventas y unidades"* · *"solo hay que enfocarnos en kepler"* ·
> *"documentemos la verdad absoluta hasta ahora, será nuestra fuente principal de razón"*.
>
> **Medido contra PROD** (Railway, tenant `mega_dulces`) el **2026-09-09 16:05 UTC**, salvo lo que
> se atribuye explícitamente a otra medición. ADR-059.

---

## 0. Qué es este documento, y qué NO es

Este repo ya tiene [`REGISTRO_CANONICO_COMPLETO.md`](REGISTRO_CANONICO_COMPLETO.md), que contesta
**"¿de dónde sale este dato?"**. Éste contesta la otra pregunta, que no estaba escrita en ningún
lado:

> **¿Con qué se comprueba que el dato está bien, y cuánto de él aguanta esa comprobación?**

Son preguntas distintas y hacen falta las dos. Una fuente única que nadie contrasta sigue siendo
una fuente única equivocada. Este documento no repite el linaje: **enlaza** al registro y agrega el
**árbitro**, el **veredicto** y el **hueco declarado**.

⛔ **No es un reporte.** Cada cifra de acá tiene un candado que la vuelve a medir. Si una cifra y su
candado divergen, **gana el candado** y este documento está viejo.

---

## 1. Las cinco reglas

Estas cinco salieron de errores que ya se pagaron. No son estilo.

### R1 — Cada ERP se juzga con SU propia evidencia

Kepler contra Kepler, Wincaja contra Wincaja. Juzgar el costo de Wincaja contra
`v_supplier_cost_ladder` (que deriva de `kepler_ods.kdpv_prov_prod`) produjo una medición que hubo
que descartar entera. Un ERP no es el árbitro de otro.

### R2 — El DINERO arbitra la CANTIDAD, y el costo arbitra mejor que el precio

Una cantidad sola no se puede auditar: no se sabe en qué unidad está. Préstale un precio y el
dinero delata el peldaño. Y entre los dos precios posibles, **el costo gana por razón estructural**:
el precio tiene niveles, descuentos y promociones; el costo no. Medido: el precio contradice **9×
más** renglones que el costo (59,612 contra 9,102), y ese exceso es descuento, no unidad. Por eso el
precio **se conserva pero no vota**.

### R3 — El costo tiene que venir del MISMO ERP y del MISMO ALMACÉN que la cantidad

Un costo por PRODUCTO no puede valuar una cantidad por ALMACÉN sin declarar en qué unidad está.
Es la regla que destapó los $5.59M de sobrevaluación del inventario (§3.1). Corolario: la unidad de
una columna **no se hereda de su fuente** — se prueba en la tabla que el consumidor lee (ADR-055).

### R4 — Lo que no se puede medir se DECLARA; nunca se dibuja como cero ni como relleno

`sin_testigo` viaja con **NULL**, jamás con `0` — un `0` se lee "no cuesta nada". Y las **ausencias
distintas llevan etiquetas distintas**: que falte el testigo del ERP no es lo mismo que falte el
costo del catálogo. Una fila ausente en un `LEFT JOIN` llega NULL y se lee como sana (ADR-056).

### R5 — Un árbitro que nunca contradice es un espejo

Todo veredicto tiene que poder salir en contra, y hay que **probarlo** contra un conjunto que otro
testigo ya juzgó mal. Es la regla que mató un testigo propio antes de shipearlo (§6.1).

---

## 2. El estado, en una tabla

| dimensión | qué la arbitra | resultado | ¿verdad absoluta? |
|---|---|---|---|
| **Existencia · cantidad** | identidad `entradas − salidas = qty`, del propio `kdil` | **cero sin explicar** en las 6 sucursales | ✅ **sí** |
| **Existencia · valor** | `kdik.c16` — costo de Kepler por sucursal × SKU | 72.4% confirmado · brecha enumerada | ✅ **sí, con residuo enumerado** |
| **Ventas · dinero** | `c62 = u1_cost × c58` + paridad contra el renglón crudo | cobertura **98.20%** del dinero de Kepler | ✅ **sí** |
| **Unidades · ticket** | el renglón declara y el costo confirma | **95.75%** confirmado | ✅ **sí** |
| **Unidades · `U-D-8`** | — | **no arbitrable** (límite de la fuente) | ⛔ **declarada, no arbitrada** |
| **Wincaja (las tres)** | tiene árbitro propio, sin cablear | fuera de alcance por decisión | ⬜ **no empezado** |

---

## 3. Existencia

### 3.1 La cantidad ya era verdad — y dos sospechas mías eran falsas

`analytics.v_erp_stock_on_hand` es la fuente. **Acierta 100.0% contra el POS en vivo** sobre 22,090
SKUs, mientras la tabla `commercial.stock` acierta 91.0% (15,324 unidades de error) — *medido en la
migración `20260902170000`, no en esta sesión*. Por eso **la vista manda y el fact sólo enriquece**;
`commercial.stock` no se joinea ni para el apartado.

La identidad interna cierra **sin residuo**:

```
22,426 filas · identidad directa 92.22% · negativos recortados 1,748 · SIN EXPLICAR 0
```

El 7.78% que no cuadra directo son **exactamente** los saldos negativos que la vista recorta a cero
por diseño (`GREATEST(..., 0)`), y el dictamen ya los objeta como `negativo_menor`.

Dos cosas que parecían bugs y **no lo eran** (verificadas antes de "arreglarlas"):

- **`baseline = 0` para Kepler es correcto.** `kdil.c4` (el inicial) es **0 en el 100%** de las
  22,473 filas. No falta el inicial: no existe.
- **La sucursal `00` de Kepler ya está excluida.** Deriva **122,096,465** unidades fantasma —dos
  órdenes de magnitud sobre cualquier otra— y el filtro `w.kepler_code <> '00'` de la vista la deja
  fuera desde antes. Ojo: la Kepler `00` es **OFICINAS**; el CEDIS real es `BPIRAPUATO` y viene de
  Wincaja.

### 3.2 El valor NO era verdad: $5.59M de sobrevaluación, en dos causas separables ⭐

Se valuaba con `COALESCE(cost_with_tax, cost_base)` de `catalog.products` — un costo por PRODUCTO,
global, en la unidad que el catálogo tenga. Kepler trae **su** costo unitario por **sucursal × SKU**
(`kdik.c16`), al mismo grano que la cantidad, y nadie lo usaba para esto.

```
mediana  cost_base     / kdik.c16 = 1.0000    pega ±2% en 72.46%
mediana  cost_with_tax / kdik.c16 = 1.0800    pega ±2% en 19.71%
```

O sea **`cost_base` ES el costo de Kepler**, y la pantalla publicaba **con impuesto**. Y con la
mediana en 1.0000 exacto el agregado difería 13%: la discrepancia está **concentrada**, no repartida.

| veredicto | filas | publicado | arbitrado | brecha |
|---|---|---|---|---|
| **confirmado** | 11,882 | $30,762,104 | $28,011,539 | **$2,750,565** ← el impuesto (×1.098) |
| `precio_movido` | 4,230 | $8,707,755 | $7,909,300 | $798,455 |
| **`contradicho_por_factor`** | **273** | $2,668,541 | $648,018 | **$2,020,523** ← el factor de caja |
| `sin_testigo` | 26 | $16,316 | **NULL** | — |
| **TOTAL** | **16,411** | **$42,154,716** | **$36,568,857** | **$5,585,859 (13.25%)** |

Las razones de esas 273 filas son **16.2 · 21.6 · 20.0 · 14.0 · 32.0 · 31.4 · 10.8 · 3.3** —
factores de caja, no diferencias de precio. Y los nombres cierran el caso: `ROLLO GUAYABA CHICO
GRANEL` · `CHOC HERSHEY BARRA GRANEL 14KG` · `TURIN CONF SEMIAMARGO 16KG` · `ALTEÑO CAR SURTIDO
GRANEL / 5KG`. **`cost_base` viene por bulto; `c16` por pieza o kilo.** Es ADR-051 y ADR-055
medidos, por primera vez, sobre la valuación del inventario y con el propio costo de Kepler como
árbitro.

**Efecto en la cifra publicada** (consulta real del service, prod):
`kepler_ods` **$39,980,353 → $35,510,326** (−11.2%) · `wincaja` sin cambio ·
**TOTAL $66,625,522 → $62,155,495 (−6.71%)**.

---

## 4. Ventas y unidades

### 4.1 Kepler nunca pierde la unidad — el renglón la declara

Ésta es la observación de la que sale todo lo demás: **Kepler no *resuelve* la unidad, nunca la
*pierde*.** Cada renglón de `kepler_ods.kdm2` carga su escalera completa:

| columna | qué es |
|---|---|
| `c11` / `c9` / `c12` | la unidad **base**, cuántas, y su precio |
| `c55` / `c56` / `c57` / `c58` | la unidad que el cliente **compró** (siempre la mayor), cuántas, su precio, y **el factor** |
| `c62` / `c63` | el **costo** del renglón |

Y el renglón cuadra consigo mismo: **`c9 = c56 × c58` en 709,805 de 709,864 = 99.99%**. Estábamos
leyendo la mitad del renglón. ⚠️ El repo **ya había decodificado** `c55/c56/c57/c58` para COMPRAS
(RA-PRO.43) y nunca lo llevó a ventas — el patrón que ADR-056 describe: un primitivo bien hecho para
un dominio, jamás generalizado.

### 4.2 El árbitro: `c62 = u1_cost × c58`

El costo del renglón es lo que Kepler pagó por **una** unidad base, por el factor que el renglón
declara. Se sostiene en **98.39%** de 691,746 renglones, con **mediana exactamente 1.0000**, y
parejo entre sucursales (98.23%–99.00%).

| certeza | renglones | % | importe |
|---|---|---|---|
| **confirmado** | 679,744 | **95.75%** | $45,564,138 |
| `sin_costo` | 21,109 | 2.97% | $15,314,120 |
| **`contradicho`** | 9,011 | 1.27% | $2,167,414 |
| `sin_factor` | 60 | 0.01% | $262,427 |

### 4.3 El precio se conserva pero NO vota

Un diseño anterior puso los tres testigos a votar y fabricó **$19.5M de conflicto falso**. Medido:
el precio contradice en **59,612** renglones contra **9,102** del costo, y en `U-D-8` era "certero"
en apenas 0.6%. Un testigo que se equivoca en más de la mitad de un doctype entero no es testigo:
es ruido con voto.

### 4.4 El universo de venta: `U-D` 8 / 10 / 12

| doctype | qué es (catálogo `kdmm`) | entra |
|---|---|---|
| `U-D-10` | Ticket Contado Caja | ✅ |
| `U-D-8` | **Factura Telemarketing** (= mayoreo) | ✅ |
| `U-D-12` | Factura Cont No Fiscal | ✅ |
| `U-D-6` | Factura global | ⛔ **re-factura los tickets en 93.1%** de los pares (SKU, día) |
| `U-D-13` | Factura Cred No Fiscal | ⛔ es el **traspaso** al CEDIS |
| `U-D-40` / `U-D-41` | Pedido / Embarque | ⛔ no son venta |

⚠️ **El corte tiene que ser el MISMO en el fact y en el sell-out** (`mart.ventas` y
`analytics.mv_kepler_sales_daily`). Cuando divergieron, las dos superficies se contradecían entre sí
por **$16,071,965 / 90 d**.

### 4.5 Paridad: cobertura **98.20%** del dinero que Kepler entrega

```
universo completo (8/10/12)      cantidad 98.01%   importe 99.74%   cobertura 98.20%
mostrador (tienda vs 10+CONTADO) cantidad 98.06%   importe 99.75%   delta $680,308
mayoreo nuestro vs U-D-8 de Kepler                                  99.19%
```

⚠️ **El total puede cuadrar con el dinero en el canal equivocado.** Fue el riesgo concreto: el 100%
de `U-D-8` caía en `credito` (la rama `TI%`→mayoreo **nunca se dispara**), lo que habría inflado el
crédito publicado de $6.5M a $20.8M — **3.2×**. Un total correcto pagado con otro número falso no es
paridad. Por eso `mart.ventas` lleva `doctype` y el canal lo usa.

---

## 5. Los resolvedores canónicos — qué leer para qué

⛔ **No re-derivar ninguno.** Un primitivo con dos implementaciones es un primitivo que va a
divergir.

| necesitás | leé | nunca |
|---|---|---|
| existencia por almacén × producto | `analytics.v_erp_stock_on_hand` | `commercial.stock` (acierta 91%) |
| **costo unitario de Kepler** | `analytics.v_kepler_unit_cost` | `kdik` a mano (arrastra réplica) |
| veredicto del valor del inventario | `analytics.v_erp_stock_truth` | — |
| unidad/peldaño del renglón de venta | `analytics.v_erp_sales_line_units` | inferirlo del rótulo |
| factor de caja por producto | `analytics.v_product_box_factor` | `kdii.c84` crudo |
| factor de caja por almacén × producto | `analytics.v_warehouse_box_factor` | un factor por producto |
| la unidad resuelta, con testigo | `analytics.v_unit_truth` (+ `_coverage`) | — |
| sell-out Kepler a grano día | `analytics.mv_kepler_sales_daily` | `analytics.sales_daily` para sell-out |
| costo pagado al proveedor | `analytics.v_supplier_cost_ladder` | un peldaño fijo de la escalera |

Y para **de dónde sale** cada dato: [`REGISTRO_CANONICO_COMPLETO.md`](REGISTRO_CANONICO_COMPLETO.md).

---

## 6. Las trampas que ya cobraron

Todas vividas. El número entre paréntesis es lo que costaron.

1. ⛔ **`?` dentro de un `knex.raw`** → knex lo toma como binding. El repo tenía anotado que da
   `42P18`; **la variante peor no falla**: guardó `'^-$1[0-9]+(\.[0-9]+)$2…'`, no matcheó nada, y la
   vista devolvió `sin_testigo` en **16,453 filas** — que se lee igual que *"Kepler no tiene costo"*.
2. ⛔ **ANTI-RÉPLICA.** `kdm2` arrastra renglones de otras sucursales (la 03 trae 112,377 de la 02,
   $7.5M) y **`kdik` también: 3,667 de 31,084 filas** traen el costo de OTRA sucursal (**$864,270**
   de deriva en el valor arbitrado). Filtro: `sucursal = btrim(c1)`. ⚠️ Pero en `kdm2` el filtro
   plano tira los **sub-almacenes de ruta** (`01-00N`): usar `= sucursal OR LIKE sucursal||'-%'`.
3. ⛔ **Comparar dos poblaciones.** Al abrir el corte de doctypes, el candado seguía midiendo contra
   `U-D-10` solo → miles de celdas "que publicamos y Kepler no tiene", que Kepler sí tiene en otro
   doctype. **Si un lado cambia de universo, el otro también.**
4. ⛔ **Afirmar sobre el TEXTO del SQL.** Un candado exigía que la definición mencionara
   `kepler_ods.kdik`; al extraer el primitivo la vista dejó de nombrarlo y el candado se puso rojo
   solo. Preguntar al **grafo de dependencias** (`pg_rewrite` + `pg_depend`), que sobrevive a que
   alguien meta otra vista en medio.
5. ⛔ **Fijar una cifra VIVA al entero.** `confirmado === 11917` falló con 11,918: no era el código
   —con las dos definiciones lado a lado hay **cero filas con veredicto distinto**— era el shipper
   del ODS refrescando. Los pisos de datos vivos van con **banda**.
6. ⛔ **`source = 'kepler_ods'`, no `'kepler'`** (eso es `unit_source`). Filtrar por el valor
   equivocado devuelve **cero filas en silencio**.
7. ⛔ **Un candado que re-deriva por bloque se va a `statement timeout`.** Materializar **una vez**
   a temporal: 22,426 filas en 0.8 s contra seis derivaciones que no terminaban.
8. ⛔ **Correr un importer A MANO con su tarea programada viva** = te lo matan a los **13 min**
   (`kill-stale-feeds.ps1`), y el síntoma es un `FATAL 57P01` que parece de Railway. Backfill en
   **escalera** (30 → 90 → 180 → 260 d). Detalle en [`GOTCHAS.md` §38](GOTCHAS.md).
9. ⛔ **Backticks en un comentario SQL** dentro de un template literal rompen el build sin decir
   dónde. **Cinco veces** en este proyecto.
10. ⚠️ **`.env` no apunta a prod.** `DATABASE_URL_NEW` es `platform_test`; **prod es `FLEET_DB_URL`**
    (Railway). Una medición contra el destino equivocado no es una medición.

---

## 7. Los huecos declarados, con nombre y monto

Ninguno está escondido, y cada uno tiene un candado que se pone rojo si se vuelve un cero silencioso.

| hueco | tamaño | por qué |
|---|---|---|
| **`U-D-8` sin árbitro** | **$15.3M / 90 d** (`sin_costo`) | Kepler **no escribe** `c62` ni `c63` ahí: vacíos en el **98.81%** de sus renglones, contra 99.99% en el ticket. **No es hueco nuestro** — sus 1,965 SKUs sí tienen escalera pagada |
| **`contradicho`** en ventas | 9,011 renglones / $2.17M | el costo contradice el factor declarado. Conjunto finito, enumerado |
| **`contradicho_por_factor`** en existencia | 273 filas / $2.02M | `cost_base` por bulto contra `c16` por pieza |
| celdas que Kepler tiene y el fact no | 5,178 celdas / **$1,225,253** | el SKU **sí** existe en el catálogo; la fila no llega (**K.4**) |
| `units` que todavía transformamos | 5,835 celdas / **$1,851,531** | 3,948 ÷2 (500 g→kg) · 1,135 ×12 · 747 ×2 (**K.5**) |
| `sin_testigo` en existencia | 26 filas / $16,316 | Kepler no da costo; `valor_arbitrado` va **NULL** |
| **Wincaja** | **37.6%** de la venta de los últimos 30 d | fuera de alcance por decisión (§8) |

---

## 8. Wincaja: tiene árbitro propio, y está sin cablear

Fuera de alcance por decisión explícita de Edgar. Lo que **sí** quedó medido, para cuando se abra:

- ✅ **Su identidad de existencia cuadra al 100.00% en las 21 sucursales**, error mediano 0.0000
  (`existencia_inicial + entrada − salida = existencia`).
- ✅ **Su renglón de venta trae costo**: `valor_costo` poblado en **99.98%** de 827,906 renglones.
- ✅ **Su unidad es consistente por artículo**: el costo unitario implícito es estable (max/min ≤
  1.02) en **10,780 de 14,209** pares (75.87%), mediana del spread **1.0001**, y sólo **6 pares**
  muestran la firma de mezcla de peldaño.
- ⛔ **NO declara el peldaño por renglón**: `cantidad_auxiliar` sirve en **3 filas de 9,962,920**.
  Su unidad vive en `articulos.unidad_venta` / `factor_venta`, por ARTÍCULO. ⚠️ Y
  `detalles.unidad_venta` es un **flag 0/1**, no una unidad (~17× de error si se usa como tal).
- ⛔ **`costo_promedio` NO sirve de árbitro histórico**: es el costo de HOY y Wincaja re-expresa el
  costo de ventas pasadas. Medido: valuando con él da **4.6× el árbitro**; el catálogo da **97.1%**.
  El árbitro correcto es el **costo unitario implícito en sus propias ventas**.

⚠️ Y su cantidad **no cuadra con la nuestra** en 4,044 de 30,202 filas (13.4%): 736,811 unidades
nuestras contra 895,329 suyas. Sin diagnosticar.

---

## 9. Hipótesis refutadas — no las reconstruyas

Cada una se probó y **se cayó**. Están acá para que nadie pague el mismo camino.

### 9.1 ⛔ `c12` (precio base) contra `kdik.c16` como testigo de `U-D-8`

Sobre `U-D-8` se veía **perfecto**: 99.85% con testigo, mediana 1.1945, **98.90%** dentro de una
banda de margen 1.0–3.0, **cero** renglones con la firma del peldaño equivocado. Y no vale nada.
Calibrado contra el único conjunto con veredicto independiente (7 d, prod):

```
U-D-10  confirmado    n=60,107   mediana 1.3001   en banda 99.32%   firmas 0 (0.00%)
U-D-10  contradicho   n=    94   mediana 1.2114   en banda 97.87%   firmas 0 (0.00%)
```

En los 94 renglones donde el costo dice que el factor **está contradicho**, el test dice "todo bien"
con la misma fuerza que en los 60,107 confirmados. **No discrimina — es un espejo** (R5). Si se
repropone: la prueba va sobre el `contradicho` de `U-D-10` y tiene que salir **distinta** del
`confirmado`.

### 9.2 ⛔ `caja_sin_capturar` en Wincaja (1,286 SKUs)

Construida sobre `unidad_compra` (94.53% constante `CJA`) y `factor_compra` (1 en 15,535 de 15,535
= 100%) — campos que Wincaja **no mantiene**. Y el dinero la refutó: esos artículos se cobran como
CAJA en 95.1% (mediana 1.132), idéntico al grupo etiquetado `CJA`. **Se le creyó a una ETIQUETA por
encima del DINERO.** Retractada.

### 9.3 ⛔ `precios.margen_utilidad` como auditor interno de Wincaja

Es un **porcentaje sobre costo** (el primer test comparó una fracción contra un porcentaje — el
mismo error de unidad que la fase persigue) y **no discrimina**: 41.8% en los sanos contra 51.9% en
los defectuosos, invertido.

### 9.4 ⛔ `kdik.c5` como existencia de Kepler

`c8/c5 = c16` cuadra aritméticamente, pero `c5` **no es el stock actual**: la mediana de nuestra
cantidad sobre `c5` va de 0.06 a 0.67 según sucursal, con 6–16% idénticas.

### 9.5 ⛔ "`kdik.c16` viene sucio"

Está limpio: en el ODS es `double precision` y las 31,084 filas son numéricas. Lo que parecía basura
(`4.1667e-06`) es notación científica válida — el `[^0-9.-]` con el que se midió le quitaba la `e`.
El guard correcto es de **valor** (`c16 = c16` descarta NaN, las cotas los infinitos), no de texto.

---

## 10. Cómo se verifica

| candado | qué protege | estado |
|---|---|---|
| `test-newdb-stock-truth.js` | existencia: identidad, testigo, veredicto, anti-réplica | **21/21** |
| `test-newdb-sales-line-units.js` | el renglón: invariantes, árbitro, "el precio no vota" | **38/38** |
| `test-newdb-kepler-parity.js` | lo que entregamos == lo que entrega Kepler | **8/8** |
| `test-newdb-fact-vs-kepler.js` | existencia y venta por sucursal, medianas por SKU | **21/21** |
| `test-newdb-existencia.js` | la pantalla: orden, fuente, totales | **23/23** |
| `test-newdb-unit-truth.js` | el resolvedor de unidad y su cobertura | **40/40** |
| `verify-no-transfer-leak.js` | que el traspaso no se cuele a la venta | verde |

Todos registrados en `database/run-all-tests.js`. **Se corren contra `FLEET_DB_URL`**, no contra el
`DATABASE_URL_NEW` del `.env`.

---

## 11. Lo que este documento no cubre

- **Wincaja** (§8) — 37.6% de la venta de los últimos 30 días.
- **El margen.** `analytics.sales_daily.cost` tiene dos escritores y en la mitad Kepler es
  `revenue/(1+markup)`, álgebra ciega al precio. Ver ADR-051 y
  [`FASE_MR_COSTO_Y_UNIDAD`](IMPLEMENTACION/FASES/FASE_MR_COSTO_Y_UNIDAD.md).
- **La frescura.** Que un número sea correcto no dice que sea de hoy. Ver ADR-056 y
  [`FASE_VP`](IMPLEMENTACION/FASES/FASE_VP_VERDAD_Y_PROCEDENCIA.md).
- **`celdas_sin_costo_erp` todavía no se MUESTRA** en la pantalla de existencia. El backend la
  devuelve; declararla en el response **no** es declararla al usuario.

---

### Lecturas obligadas antes de multiplicar dos columnas

[`UNIDADES_DE_MEDIDA.md`](UNIDADES_DE_MEDIDA.md) · [`ERP_KEPLER.md`](ERP_KEPLER.md) ·
[`GOTCHAS.md`](GOTCHAS.md) · [`REGISTRO_CANONICO_COMPLETO.md`](REGISTRO_CANONICO_COMPLETO.md)
