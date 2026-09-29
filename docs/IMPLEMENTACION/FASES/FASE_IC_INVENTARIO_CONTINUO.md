# Fase IC — Inventario Continuo (los tres ritmos)

> **Estado: 🔨 DISEÑADO (planeación) 2026-09-28 — ADR-079 propuesto.**
> **Pedido (Edgar, 2026-09-28):** mantener **tres** tipos de inventario — **completo** (trimestral, lo genera Kepler), **parcial** (mensual, nuestro) y **por productos top** (nuestro) — con interfaces para generarlos y **mostrar las diferencias**.
> ⏰ **URGENTE por calendario:** el **CEDIS migra a Kepler el 30-sep-2026**. El sprint **IC.CEDIS** se corre ese día o el 1-oct — después la ventana se cierra (§1.10).
> **Tesis:** el conteo ya está construido y **nunca se usó**; el trimestral de Kepler ya se hace y **no se ve en ninguna pantalla**. Esta fase no construye un módulo de inventario: **conecta el que existe al proceso real** y hace visible el descuadre que hoy nadie mira.

---

## 1. Lo medido (2026-09-28, contra prod — sólo lecturas)

### 1.1 Lo que existe en código y no se usa

Las fases **I** (conteo físico), **ABC** (cíclico), **OFF** (offline) y **PREV** (prevención) están completas: ~40 endpoints, 8 páginas, conteo ciego, doble conteo, pasillos/equipos, IRA, investigación, monitoreo.

| Evidencia en prod | Valor |
|---|---|
| Folios de conteo | **6** — todos `type='full'`, todos `status='cancelled'`, jun-2026 |
| Folios reconciliados | **0** |
| Items sembrados | 18,845 |
| `abc_classification` | **39,258** filas, 9 almacenes, recalculada hoy (el cron sí corre) |
| Investigaciones PREV | 1 (`monitoring`) |

**Diagnóstico: la interfaz existe, el proceso no pasa por ahí.** Antes de construir una pantalla más hay que quitar lo que impide usar las que hay (§1.6, §1.7).

### 1.2 Cómo hace Kepler el trimestral — decodificado, no supuesto

| Doctype | `kdmm.c5` | Papel |
|---|---|---|
| `N-A-45-1` | Captura inventario físico | **el conteo** (cantidad contada) |
| `N-A-30-1` | Entrada Inventario físico | ajuste **sobrante** |
| `N-D-30-1` | Salida inventario físico | ajuste **faltante** |
| `N-A-20-1` / `N-D-5-2` | Entradas/Salida por ajuste | ajuste general (otro motivo) |

**Línea (`kdm2`), verificada al centavo:** `c8`=SKU · `c9`=cantidad contada · `c10`=descripción · `c11`=**unidad declarada** · `c12`=costo unitario · `c13`=importe. Comprobado `c13 = c9 × c12` en las 3 filas de control (2×23.28=46.56 · 2×79.56=159.12 · 82.96×39.4569=3273.34).

⚠️ **La captura NO trae el teórico ni la diferencia.** La diferencia sólo existe como los documentos de ajuste `N-A-30`/`N-D-30`. Cualquier pantalla de diferencias se arma desde ahí, no desde la captura.

**Cadencia real (confirma la premisa del pedido):** nov-2025 · mar-2026 · jun-2026 · sep-2026 ≈ trimestral. En sep-2026: 1 captura por sucursal, de 1,567 a 3,185 líneas cada una.

### 1.3 El "completo" no es completo

Cobertura del trimestral de sep-2026 contra los SKUs con existencia > 0 en el ODS (`kdil`):

| Sucursal | Contados con existencia | **Con existencia, NO contados** | Contados sin existencia |
|---|---:|---:|---:|
| `00` (⚠️ ver §1.3b) | **0** | 4,647 | 0 |
| `01` | 2,561 | 754 | 379 |
| `02` | 2,251 | 616 | 119 |
| `03` | 2,068 | 923 | 163 |
| `04` | 1,462 | 502 | 105 |
| `05` | 1,932 | 430 | 157 |
| `06` | 2,605 | 342 | 343 |
| `07` | 2,207 | 263 | 332 |
| `08` | 2,582 | 192 | 327 |

- **4,022 SKUs con existencia** quedaron fuera en el resto (7% a 31% por sucursal). **Ése es el hueco real de cobertura.**
- Los "contados sin existencia" son sobrantes puros: mercancía física que el teórico no conocía.

### 1.3b ⚠️ Corrección: la `00` de Kepler es OFICINAS, y el CEDIS no está en Kepler

Aclarado por Edgar (2026-09-28) y confirmado contra la plataforma, que **ya lo tenía bien**: `commercial.warehouses` code `00` trae `kepler_code = NULL` y `wincaja_source_branch = '00'`.

- **`kepler_ods` sucursal `00` = OFICINAS.** Su "existencia" son **122,798,871 unidades en 4,652 SKUs** (26,397 por SKU en promedio): no es un almacén físico, es un artefacto del bug conocido `c4 = 0` (la fórmula degenera en *entradas − salidas acumuladas desde siempre*). ⛔ **No se cuenta y no entra a ninguna métrica.** Mi primera lectura la trató como hueco de cobertura: era un error.
- ⛔ **El CEDIS es Wincaja (`MD-00`) y NUNCA ha tenido un inventario físico.** No está en Kepler, y en Wincaja **no existe el conteo masivo**: los movimientos tipo `I`/`X`/`M` del CEDIS traen **1 a 4 líneas**, y **el ajuste más grande de toda la historia de Wincaja, en cualquier sucursal, tiene 40 líneas**. Son correcciones puntuales, no conteos.
  - Tamaño: **253 SKUs con existencia, $7.6M** (`wincaja.v_stock.valor_inventario`; 15,559 en catálogo). Es un almacén de flujo, no de guarda — pero es $7.6M que **nadie ha contado nunca**.
  - ⭐ **Consecuencia para el plan: para el CEDIS, nuestro parcial/top no es un refuerzo del trimestral — es la ÚNICA vía posible.** Kepler no va a contarlo nunca porque no lo conoce.

### 1.3c El cutover Wincaja→Kepler, con fecha

`analytics.v_branch_erp_cutover` (resolvedor que **ya existe** — usarlo, no reescribirlo) fecha la migración de cada sucursal:

| Sucursal | Cutover a Kepler | Su "conteo" de sep-2026 |
|---|---|---|
| `07` Morelia Madero | **2026-09-08** | 2026-09-07 — el día ANTES |
| `08` Morelia Abastos | **2026-09-19** | 2026-09-18 — el día ANTES |
| `01` Padre Hidalgo | 2026-06-27 | primer trimestral post-migración |
| `06` Canindo | 2026-08-15 | primer trimestral post-migración |
| `02` La Piedad | 2025-10-10 | ya estabilizada |
| `03` · `04` · `05` | siempre Kepler | — |

⭐ **`07`/`08` quedan explicadas con fecha, no por inferencia**: contaron el día antes de migrar porque eso es una **carga inicial**, no un inventario.

⚠️ **Lo que NO se sostiene:** la tentación es culpar al cutover del descuadre. Normalizado por SKU contado, `01` da **$1,348/SKU** contra $273 de `06` (que migró **después**) y $334 de `03` (que nunca migró). **`01` es un outlier por sí misma**, no por haber migrado. Su explicación sigue abierta.

### 1.4 El descuadre — **cifras corregidas** (ver §1.9)

⚠️ Una primera versión de este análisis unía `kdm1`⋈`kdm2` **sin `c1`** y fusionaba documentos de distintos almacenes. Las cifras de abajo usan la clave completa.

**Conteos trimestrales reales de sep-2026** (ya sin cargas iniciales):

| Sucursal | Fecha | $ contado | SKUs sobr. | $ sobrante | SKUs falt. | $ faltante | Sobrante / contado |
|---|---|---:|---:|---:|---:|---:|---:|
| `06` | 09-04 | 12,459,361 | 591 | 803,936 | 601 | 334,665 | 6.5% |
| `05` | 09-10 | 1,995,104 | 382 | 304,223 | 480 | 142,337 | 15.2% |
| **`01`** | 09-11 | 13,690,687 | 897 | **4,246,558** | 1,296 | 1,248,543 | **31.0%** |
| `04` | 09-17 | 679,889 | 264 | 116,053 | 346 | 64,541 | 17.1% |
| `03` | 09-22 | 3,705,934 | 474 | 746,361 | 826 | 271,436 | 20.1% |
| `02` | 09-23 | 1,584,286 | 422 | 384,974 | 722 | 195,770 | 24.3% |
| **Total** | | **34,115,261** | 3,030 | **6,602,105** | 4,271 | **2,257,292** | **19.4%** |

- **Neto +$4.34M de sobrante** sobre $34.1M contados. El teórico **subestima de forma sistemática**.
- ⚠️ **Lo importante no es que `01` sea outlier: es que NINGUNA sucursal está sana.** El sobrante va de **6.5% a 31%** del valor contado. Es un problema del sistema, no de una plaza. (`01` sigue siendo el peor y pide explicación propia.)
- ⛔ **Las cargas iniciales NO son descuadre** y se excluyen: `06` 08-14 ($11.93M), `07` 09-07 ($2.72M), `08` 09-18 ($16.08M) y la ruta `01-006` 06-26 ($47.6k). Firma inequívoca: **faltante $0 y captura == entrada, línea por línea**.

### 1.5 La sospecha de unidad se **debilita** al medirla

La primera lectura veía el sobrante de `01` concentrado en `PZA` (76% del dinero en 29% de las líneas) y sospechaba conversión mal aplicada. **La medición apunta al revés:**

Carga inicial de `08` contra la existencia congelada de Wincaja `30`, por SKU:

| SKU | Unidad | Kepler cargó | Wincaja tenía | Razón |
|---|---|---:|---:|---:|
| `88022`, `28102`, `20021`, `20005`, `70056`… (11 de 12 top) | `PAQ` | — | — | **0.988 – 1.017 ≈ 1** |
| `02202` | `PZA` | 9,192 | 768 | **11.97 ≈ 12** |

**La conversión funciona**: 1:1 donde la unidad coincide, y por el factor exacto donde el multipack se expande a piezas. ⚠️ Es una muestra de 12 SKUs top por valor, no el universo — pero **invierte la carga de la prueba**: la unidad ya no es la explicación por defecto del sobrante, y IC.1b tiene que buscar en otro lado.

⚠️ Y el atajo que había usado antes (reconstruir el teórico como `contado − ajuste`) **no sirve**: da negativos. La explicación de `01` sigue **abierta** — ver §1.9b.

### 1.9 ⛔ La lección: la clave de un documento Kepler incluye el ALMACÉN

Al listar los documentos de la `01` aparecieron **dos cabeceras con el mismo folio `0000001`**, una con `c1 = '01-006'` (la Ruta 28) y otra con `c1 = '01'` (la sucursal). Un join por `sucursal + c2..c6` **las fusiona y duplica las líneas**.

**La clave correcta es `sucursal + c1 + c2 + c3 + c4 + c5 + c6`.** Es la misma familia de trampa que ya cobró en `XA2001` y en `kdm5` (*el folio no es único*), con un eje más: **tampoco es único entre almacenes de la misma sucursal**.

Efecto medido del error: el sobrante de `01` pasó de **1,221 SKUs / $4,294,155** a **897 SKUs / $4,246,558**. En pesos movió poco (1.1%); **en conteo de SKUs, 27%**. Cualquier vista de esta fase que toque `kdm2` debe llevar `c1` en el join, y el smoke debe tener una aserción contra la duplicación.

### 1.9b Padre Hidalgo: no hubo carga inicial de su almacén principal

`01` migró de Wincaja `10` a Kepler el **2026-06-27**, pero el único documento de carga de esos días es el de la **ruta `01-006`** ($47.5k). **El almacén `01` no tiene carga inicial registrada** — a diferencia de `06`, `07` y `08`, que la tienen el día antes de su cutover.

⭐ **Hipótesis que esto abre** (contrastable, sprint IC.1b): si el inventario de PH entró a Kepler incompleto o no entró por documento, el teórico arrancó por debajo de la realidad física, y el conteo de septiembre lo encontró como **sobrante**. Eso explicaría el 31% sin recurrir a la unidad. **Se prueba** cruzando los SKUs que sobraron en septiembre contra los que Wincaja `10` tenía y Kepler nunca cargó.

### 1.6 Los permisos están al revés

| Rol | `CONTAR` | `SUPERVISAR` | `RECONCILIAR` | Usuarios |
|---|---|---|---|---:|
| **`almacenista`** | **false** | true | false | **4** |
| `compras` | true | true | true | 2 |
| `marketing` | true | true | **true** | 2 |
| `gerente_compras` | true | true | true | 1 |
| `supervisor` | true | true | true | 1 |
| `superadmin` | true | true | true | 8 |

- ⛔ **Quien cuenta físicamente no puede contar.** Causa material de que el módulo nunca se haya usado.
- ⛔ **`marketing` puede `RECONCILIAR`** — autorizar el ajuste de saldo mueve dinero de inventario. Falla de segregación.

### 1.7 El teórico sale de la fuente peor

El conteo compara contra `commercial.stock`. Medido contra el POS en vivo: **`kepler_ods.kdil` acierta 100%, `commercial.stock` 91%** (15,324 unidades de error, con valores fantasma que no se corrigen nunca). Ya existen los resolvedores canónicos `analytics.v_erp_stock_truth`, `v_unit_truth`, `v_warehouse_box_factor`.

**Contar contra la fuente al 91% fabrica diferencias que no existen** — y en inventario, una diferencia falsa cuesta el tiempo de alguien yendo al anaquel.

---

### 1.10 ⏰ El CEDIS migra a Kepler el **30-sep-2026** — y sólo hay una oportunidad

Edgar, 2026-09-28: *"CEDIS cambia el 31 o 30 a Kepler, hay que darle seguimiento a Kepler únicamente"*.

Consecuencias inmediatas:

1. ⭐ **El camino Wincaja para el CEDIS ya no se construye.** El teórico del CEDIS sale de Kepler como el de todos. Se tacha de §3 y de IC.1.
2. ⛔ **El CEDIS va a tener su carga inicial en dos días — y es el único inventario que ha tenido en su historia.** Lo que cargue ese día se vuelve su teórico de partida, sin baseline previo contra el cual reclamar después.
3. **Las tres migraciones anteriores dicen qué esperar**, y son tranquilizadoras en una cosa y preocupantes en otra.

**Lo tranquilizador — la carga cuadra consigo misma.** En `06`, `07` y `08` la captura (`N-A-45`) y la entrada (`N-A-30`) coinciden **línea por línea y peso por peso**, y la unidad se convierte bien (§1.5). El mecanismo de carga funciona.

**Lo preocupante — la carga deja SKUs fuera**, de forma consistente:

| Kepler ← Wincaja | Fecha | Cargados | **No cargados** | $ no cargado | % del valor |
|---|---|---:|---:|---:|---:|
| `06` ← `50` | 2026-08-14 | 2,786 | **327** | 116,718 | 0.9% |
| `07` ← `32` | 2026-09-07 | 2,388 | **435** | 125,767 | 4.3% |
| `08` ← `30` | 2026-09-18 | 2,781 | **583** | 274,036 | 1.6% |

Son SKUs **con existencia en Wincaja y presentes en el catálogo de Kepler** (los no-cargables por catálogo se excluyeron: eran 9 en `08`). Total de las tres: **1,345 SKUs, $516,521**.

⚠️ **Honestidad sobre qué significa:** "no cargado" no prueba pérdida. Puede haber razones legítimas que no medí — SKU descontinuado, saldo residual que se decidió no migrar, mercancía transferida antes del corte. **Lo que sí está medido es que no llegaron a Kepler**, y que nadie lo revisó.

**El CEDIS en riesgo:** 248 SKUs cargables con **$7,609,177**. A la tasa de las tres migraciones anteriores (0.9%–4.3%), quedarían fuera **$68k–$327k**.

⭐ **Por eso el sprint IC.CEDIS es lo primero, y se hace el 30-sep o el 1-oct, no después.** Es una consulta que corre en segundos y cuya ventana se cierra: una vez que el CEDIS opere en Kepler y se mueva, ya no se puede distinguir lo que nunca cargó de lo que se vendió.

---

## 2. Decisiones (Edgar, 2026-09-28)

| # | Decisión | Consecuencia |
|---|---|---|
| **D1** | El ajuste de nuestros conteos **no se escribe en Kepler**: se genera el archivo en su formato y alguien lo captura | Hereda ADR-040 (*integrar, no escribir al SoR*). Ya existe `GET .../kepler-export` (formato InvIn/InvOut/PhysInv) **sin un solo uso** |
| **D2** | "Top" = **score de 4 señales**: clase A (ABC) + venta reciente + valor de inventario parado + **descuadre histórico** | Las 3 primeras ya se derivan; la 4ª hay que construirla (IC.3) |
| **D3** | El parcial mensual es **rotativo**: cada mes un tercio del catálogo, de modo que el trimestre quede cubierto al llegar el conteo de Kepler | Reusa `cycleDue()` y `openCycleCount()`, que ya existen y ya acotan el folio |
| **D4** | Cuenta el **almacenista con celular**, arreglando el permiso | Desbloquea a las 4 personas que hoy no pueden |

---

## 3. Los tres ritmos

| Ritmo | Quién | Cadencia | Alcance | Fuente de la diferencia |
|---|---|---|---|---|
| **Completo** | **Kepler** (no nosotros) | trimestral | catálogo con existencia de la sucursal — **sólo las 8 de Kepler** | `N-A-30`/`N-D-30` del ODS — **ya existe, hoy invisible** |
| **Parcial** | nosotros | mensual | un tercio rotativo, cubre el trimestre | nuestro folio contra `v_erp_stock_truth` |
| **Top** | nosotros | mensual, encima del rotativo | score de 4 señales, con tope por almacén | nuestro folio contra `v_erp_stock_truth` |

**Cómo encajan:** el rotativo reparte **todo** el catálogo en 3 olas; el top se cuenta **además**, cada mes. Lo caro o riesgoso se cuenta 3 veces por trimestre, el resto 1 vez, y cuando llega el conteo de Kepler ya no hay sorpresas — que es exactamente el KPI de la fase (§5).

⭐ **El CEDIS entra a Kepler el 30-sep-2026** (§1.10) y desde entonces es **un almacén Kepler más**: mismo teórico (`v_erp_stock_truth`), mismo export (D1), mismo ritmo completo trimestral. **Seguimiento a Kepler únicamente** — el camino Wincaja se descarta.

⚠️ Con dos salvedades que duran un trimestre: **(1)** su primer completo de Kepler no llegará hasta ~dic-2026, así que **hasta entonces el parcial y el top son su único inventario**; y **(2)** su teórico de partida es lo que cargue el 30 — por eso IC.CEDIS se corre ese día y no después.

---

## 4. Sprints

Orden por valor entregado, no por dependencia técnica. **IC.0 entrega valor sin que nadie cuente nada.**

| Sprint | Entrega | Por qué |
|---|---|---|
| **IC.CEDIS** ⏰ | **Compuerta de migración — se corre el 30-sep o el 1-oct, no después.** Comparar la existencia congelada de Wincaja `00` contra el `N-A-45` de carga del CEDIS y **listar SKU por SKU lo que no llegó**, con su valor. Entregable: la lista en manos de almacén, no un reporte. Se aplica igual a los **1,345 SKUs / $516,521** que ya quedaron fuera en `06`/`07`/`08` — esa revisión no tiene prisa, la del CEDIS sí | **La ventana se cierra**: una vez que el CEDIS opere en Kepler, no se podrá distinguir lo que nunca cargó de lo que se vendió. Es una consulta de segundos contra $7.6M que nunca se ha verificado (§1.10) |
| **IC.0** ⭐ | **Ver la diferencia que ya existe.** Vista `analytics.v_erp_physical_count_variance` (derive-no-copy sobre `kdm1`/`kdm2`) y página `/almacen/inventory/diferencias`: sobrante/faltante por sucursal × mes × SKU, con drill al SKU. **Marca `07`/`08` como carga inicial** para que no contaminen. **Prototipo ya corrido: 117 ms sobre todo el histórico.** | El descuadre de $6.65M del trimestral **no se ve en ninguna pantalla**. Cero conteo nuevo, valor el día 1 |
| **IC.0b** | **La cobertura, declarada.** En la misma pantalla: qué NO se contó y cuánto vale — los **4,022** SKUs del hueco real, **más el CEDIS entero** ($7.6M sin contar jamás), **más** la marca de que `07`/`08` fueron carga inicial y `00`-Kepler es oficinas | Un conteo sin cobertura declarada se lee como "todo está bien". Regla de la casa: lo que no se midió se declara, nunca se dibuja como cero |
| **IC.1** | **El teórico correcto.** Mover el conteo de `commercial.stock` a `analytics.v_erp_stock_truth`, resolviendo el ERP con `v_branch_erp_cutover` (tras el 30-sep el CEDIS **ya es Kepler**; sólo las rutas Wincaja quedan del otro lado); estampar en el item la unidad resuelta por `v_unit_truth` y el método; `NULL` con motivo cuando no se resuelve. ⚠️ **`v_erp_stock_truth` hace timeout al agregarla entera** — acotar por almacén o materializar (medir antes de elegir) | 91% a 100%. Sin esto seguimos mandando gente al anaquel por diferencias falsas |
| **IC.1c** ⭐ | **El CEDIS, primer conteo físico de su historia** — ya sobre Kepler, después de la migración. 248 SKUs con existencia, $7.6M | Cabe en un día y prueba el circuito completo (contar → diferencia → export) con riesgo mínimo. **El mejor piloto de la fase**, y su primer completo de Kepler no llega hasta ~dic |
| **IC.1b** | **Explicar el sobrante.** La unidad **ya casi queda descartada** (§1.5: la conversión mide bien). La hipótesis viva es §1.9b: **PH no tiene carga inicial de su almacén principal** — cruzar los SKUs que sobraron en sep contra los que Wincaja `10` tenía y Kepler nunca cargó | $4.25M en una sola sucursal, y **el sobrante va de 6.5% a 31% en TODAS**. Si es carga incompleta, no es merma y nadie debe investigarlo como robo |
| **IC.2** | **Permisos y segregación.** `CONTAR` al `almacenista`; quitar `RECONCILIAR` a `marketing`; **prueba negativa** (romper la compuerta a propósito y verificar el rojo) | Desbloquea a las 4 personas que cuentan. Un gate sin prueba negativa es una intención |
| **IC.3** | **Histórico de descuadre por SKU.** Vista derivada de los 4 trimestres de ajustes (2025-Q4 a 2026-Q3) por (sucursal, SKU): veces que descuadró, pesos, signo | Es la 4ª señal de D2 **y** la más preventiva: contar seguido lo que siempre falla |
| **IC.4** | **Score del top** (`analytics.v_count_priority_score`): las 4 señales de D2 normalizadas, con el peso de cada una **visible en pantalla** | Un score opaco no se audita. Que se vea por qué un SKU está en la lista |
| **IC.5** | **Plan rotativo del parcial.** Reparte el catálogo en 3 olas por almacén; `openCycleCount` ya acota el folio | Es D3. La mecánica ya existe: falta el reparto y que nadie quede sin tocar |
| **IC.6** | **Programa de inventario**: una pantalla con los tres ritmos — qué toca este mes, qué se contó, qué falta, cuándo cae el trimestral de Kepler | Hoy el trimestral es una fecha que alguien recuerda |
| **IC.7** | **Cerrar el ciclo a Kepler** (D1): el folio reconciliado emite el archivo en formato `N-A-45` más el acuse de quién lo capturó y cuándo | El `kepler-export` existe y nunca se usó. Sin acuse, el conteo muere en nuestra base |
| **IC.8** | **¿Sirvió?** Medir el descuadre del trimestral **antes contra después** de que el parcial corra un trimestre completo | La fase se mide sola. Si el descuadre de dic-2026 no baja contra sep-2026, el parcial no funciona y hay que decirlo |
| **IC.9** | **Enganche con Prevención.** Una diferencia confirmada abre expediente en `/almacen/prevencion` (PREV.1 ya construido, con 1 sola investigación en prod) | El módulo de investigación existe y está vacío porque nada lo alimenta |

**MVP = IC.CEDIS (ya, por calendario) + IC.0 + IC.0b + IC.1 + IC.2.** Con eso se protege la migración del CEDIS, se ve el descuadre real, se cuenta contra la fuente buena y las personas correctas pueden contar.

⚠️ **Requisito transversal de toda vista que toque `kdm2`:** el join lleva **`c1`** (el almacén), y el smoke lleva una aserción contra la duplicación — §1.9.

---

## 5. El KPI de la fase

**Descuadre del trimestral de Kepler, en pesos y en % de SKUs, excluyendo cargas iniciales.**

Línea base medida (sep-2026, sucursales `01` a `06`): **$6.65M sobrante / $2.30M faltante**, hasta 79% de SKUs con diferencia en la `01`.

Si el parcial rotativo y el top hacen su trabajo, el trimestral de dic-2026 debe traer **menos** descuadre. Es la única prueba de que la fase sirvió, y no depende de ninguna opinión.

---

## 6. Lo que se declara (no se construye, con motivo)

- **Escritura directa en Kepler** — descartada por D1. Se reevalúa sólo si el acuse de IC.7 demuestra que la recaptura manual es el cuello de botella.
- **Pasillos y equipos de conteo** — el módulo existe (Fase PA) pero los pasillos **no están dados de alta** y el ERP no los trae (`location = Z000` en los 11,109 productos). Es alta manual: fuera del MVP, disponible cuando alguien la capture.
- **Conteo offline (Fase OFF)** — existe a medias; se activa cuando el conteo con celular tenga uso real y la señal del almacén lo exija. Encenderlo antes es optimizar algo que nadie usa.
- **La `00` de Kepler (oficinas)** — **no se cuenta**: sus 122.8M de unidades son un artefacto del bug `c4 = 0`, no mercancía (§1.3b). Se excluye de toda métrica, no se declara como hueco.
- **El camino Wincaja para el CEDIS** — **descartado** por decisión de Edgar: migra a Kepler el 30-sep y se le da seguimiento a Kepler únicamente (§1.10). Las **rutas** (`RUTA-*`) siguen en Wincaja y quedan fuera de esta fase.
- **Por qué el sobrante neto es +$4.35M** — no se sabe. IC.1b prueba la hipótesis de unidad; si la descarta, queda abierto con nombre y monto. ⚠️ Y **el cutover no lo explica**: `01` es outlier contra sucursales que migraron después y contra las que nunca migraron (§1.3c).

---

## 7. ADR-079 (propuesto)

> **El inventario tiene tres ritmos y una sola definición de diferencia: el físico contra `v_erp_stock_truth`, en la unidad que `v_unit_truth` resuelve, y lo que no se contó se declara.**
>
> El completo trimestral lo sigue haciendo Kepler y nosotros lo **leemos** del ODS (derive-no-copy, cero importers); el parcial rotativo y el top los generamos nosotros y **no escribimos al SoR** (hereda ADR-040): emitimos el archivo y guardamos el acuse. Un conteo sin cobertura declarada no está cerrado, y una carga inicial nunca cuenta como descuadre.
>
> **Se rechaza:** construir un módulo de inventario nuevo (el que hay está completo y sin uso — el problema es de permisos, de fuente y de visibilidad); contar contra `commercial.stock` (91% contra 100% del ODS); y tratar el sobrante de Morelia como diferencia (es carga inicial: $18.8M que contaminarían todo promedio).
>
> Hereda ADR-040 (integrar, no escribir), ADR-056 (lo que no se mide se declara), ADR-055/ADR-057 (la unidad se resuelve una vez, con testigo) y ADR-059 (cada número se arbitra).

---

## 8. Preguntas abiertas para operación

1. ~~¿La `00` es CEDIS u OFICINAS?~~ **Resuelto (Edgar, 2026-09-28):** la `00` de Kepler es **oficinas**; el CEDIS es **Wincaja `0 BPIRAPUATO`** (`MD-00`). Ver §1.3b — cambió el alcance de la fase.
2. ⏰ **¿Con qué código de sucursal entra el CEDIS a Kepler?** La `00` de Kepler **ya está ocupada por oficinas** (§1.3b). Si el CEDIS entra como `00` hay colisión; si entra con otro código hay que mapear `warehouses.kepler_code`. **Se sabe el 30** — y IC.CEDIS no corre sin esa respuesta.
3. **¿Quién captura el archivo en Kepler** (IC.7) y en qué ventana? Sin dueño, el ciclo no cierra.
4. **¿El parcial congela movimientos?** Hoy `openCycleCount` va con `freeze = false` por default — razonable para no parar el almacén, pero hay que confirmarlo.
5. **Morelia (`07`/`08`)**: migraron el 2026-09-08 y el 09-19 (§1.3c). ¿Desde qué trimestre entran al KPI — dic-2026 o mar-2027?
6. **El CEDIS tiene 253 SKUs con existencia de 15,559 en catálogo.** ¿Es real (almacén de flujo) o la réplica está incompleta? La carga del 30 lo responde sola.
7. **Los 1,345 SKUs / $516,521 que no llegaron en `06`/`07`/`08`** (§1.10): ¿hay una razón operativa (descontinuado, transferido antes del corte) o se quedaron en el camino? Es pregunta para almacén, no para código.
