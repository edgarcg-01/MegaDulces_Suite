# Fase IC — Inventario Continuo (los tres ritmos)

> **Estado: 🔨 DISEÑADO (planeación) 2026-09-28 — ADR-079 propuesto.**
> **Pedido (Edgar, 2026-09-28):** mantener **tres** tipos de inventario — **completo** (trimestral, lo genera Kepler), **parcial** (mensual, nuestro) y **por productos top** (nuestro) — con interfaces para generarlos y **mostrar las diferencias**.
> ✅ **El guard ya está en producción** (imagen `3892fdba2ab0`, 2026-09-28): verificado **dentro de `feeds-cron`** con el env real — los dos importers dan `⛔ SKIP (source_stale)`.
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

> ⭐ **ENMIENDA (IC.12, 2026-09-29): esta sección midió la unidad CORRECTA y sacó la conclusión equivocada para la otra.** Lo que se probó acá es la unidad de la **CANTIDAD** en una **carga inicial** de la `08` contra Wincaja, y esa conclusión **se sostiene**. Lo que nunca se probó es la unidad del **COSTO** en el documento de **AJUSTE**, que es otro documento, de otra población y de otra pregunta — y ahí la unidad **sí** es la explicación: 338 renglones valúan piezas a costo de caja. *Una medición sobre otro universo es otra afirmación* (la misma lección que CE.8). El párrafo de arriba no estaba mal; estaba respondiendo otra cosa.

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

### 1.11 Cómo está implementado hoy el CEDIS de Wincaja (investigado 2026-09-28)

**El pipeline, eslabón por eslabón:**

| # | Pieza | Dónde | Estado medido |
|---|---|---|---|
| 1 | `0 BPIRAPUATO MOV.MDB` | `Z:/Salidas/Bases/Actuales` (`\\192.168.0.245\D`) | ⚠️ `Z:` es unidad **mapeada por sesión** |
| 2 | Réplica cruda (Fase WR) `wincaja-inc` + `wincaja-hash` | **PM2 en `.249`**, Jet 32-bit → `:5433/wincaja` schema `w00` | ⏹️ **DETENIDOS 2026-09-22** |
| 3 | Ship a prod | schema `wincaja.*` (39 tablas) en `postgres_platform` | último import **2026-09-22 11:01** |
| 4 | `wincaja.v_stock` | vista; emite `warehouse_code = 'MD-00'` | 253 SKUs con existencia |
| 5 | `import-cedis-stock-wincaja.js` (RA-PRO.24) | **REPLACE** de `commercial.stock` del almacén `00` | última escritura **2026-09-22 11:05** |
| 6 | Consumidores | `v_erp_stock_on_hand`, `v_warehouse_box_factor` (unen por `wincaja_source_branch`), `/compras` (reorden, traspasos), `warehouse-order.contract.ts` (`CEDIS → ['00','MD-00']`) | vivos |

⛔ **El CEDIS es el ÚNICO carril que le quedaba a la réplica Wincaja**: `wincaja-replica-config.js` tiene `BRANCHES` con **una sola entrada**. Las demás (`30`, `32`, `50`, `10`) salieron al migrar a Kepler. ⭐ **Cuando el CEDIS se vaya, toda la infraestructura Wincaja queda sin propósito** — y con ella el último bloqueo de «todo en Linux» de la Fase VL.

⛔ **Y ya está congelado, desde antes del 30:** el último movimiento del CEDIS en la réplica es del **2026-09-18** — diez días. `ops/README.md` ya lo tenía medido (`[VL.14]`, *"Wincaja se apagó el 2026-09-19… el CEDIS paró el 09-18"*). ⚠️ Con dos causas posibles que **no distinguí**: que el CEDIS dejara de operar, o que la **copia del `.mdb`** a `Z:` parara. En cualquiera de las dos, **la existencia del CEDIS que la app publica hoy tiene 10 días de antigüedad y nadie lo declara** (`commercial.stock`: 248 SKUs / 188,347 unidades, escritas el 22-sep).

### 1.11b ⭐ La migración es una UNIFICACIÓN, no un almacén nuevo

La pregunta que yo había dejado abierta (*"¿con qué código entra el CEDIS?"*) **se responde sola al mirar qué hace hoy la `00` de Kepler**. En 30 días mueve:

| Doctype | Qué es | Docs |
|---|---|---:|
| `X-D-26` | Transferencia a proveedor | 1,928 |
| `U-A-5` | Cobro PUE | 1,736 |
| `U-D-13` | Factura Cred No Fiscal | 1,597 |
| `X-A-10` / `X-A-15` | Gastos / Solicitud de gasto | 1,136 / 1,123 |
| `X-A-35`→`40`→`37`→`20` | **la cadena de compra completa** | 406 / 493 / 497 / 492 |
| `U-D-40` / `U-D-41` | Pedido / **Embarque Telemarketing** | 229 / 220 |

**La `00` de Kepler no es un almacén muerto: es el centro administrativo del CEDIS** — compra para toda la red, paga proveedores, absorbe los gastos, cobra y factura mayoreo. Lo único que **no** tiene es el almacén **físico**: ni traspasos ni inventario físico, y su "existencia" es el acumulado sin salidas del bug `c4 = 0`.

⭐ **Entonces el 30 no nace un almacén: la sucursal `00` recupera su cuerpo.** No hay colisión de código — `wincaja.branches` ya declara `kepler_code = '00'` para `BPIRAPUATO`, o sea que el destino siempre fue ése. Lo que discrepa es `commercial.warehouses`, que tiene `kepler_code = NULL` porque hoy su existencia viene de Wincaja.

⛔⛔ **El riesgo concreto, y es el grande:** la existencia actual de Kepler `00` son **122,798,871 unidades en 4,652 SKUs** de basura acumulada. **Si la carga inicial del 30 se suma a ese saldo en vez de reemplazarlo, el CEDIS arranca su vida en Kepler con una existencia absurda** — y como es su primer inventario, no hay baseline contra el cual notarlo. Esto hay que verificarlo **el mismo día**.

### 1.11b-bis ⛔ Qué son de verdad los 122.8M — y por qué este caso no se parece a los anteriores

**Corrección a mi propia explicación:** dije que los 122.8M eran artefacto del bug `c4 = 0`. **No lo son.** Medido: `c4 = 0` en **las nueve** sucursales y no infla a ninguna otra. Lo que infla a la `00` es otra cosa:

| SKU | Qué es | Saldo |
|---|---|---:|
| `00001` | **VENTAS AL 0%** (pseudo-SKU contable) | **108,834,999** |
| `00022` | TIEMPO AIRE | 118,378 |
| resto (5,014 SKUs) | mercancía | **13,844,615** |

**Un solo pseudo-SKU contable aporta el 88.6%.** Descontando los tres, quedan 13.8M de unidades reales — que siguen siendo mucho: la `00` tiene **16.6M de entradas contra 2.8M de salidas (5.9:1)**, cuando una sucursal viva ronda **1.2:1**. Coherente con lo medido en §1.11b: la `00` **compra para toda la red** pero sus salidas hacia las sucursales no se registran como salidas de su almacén.

⛔ **Y acá está lo que hace única a esta migración:** `07` y `08` entraron a sucursales Kepler **vírgenes** — su primer documento es de **2 días antes** del cutover (09-05 y 09-18). El CEDIS entra a una sucursal que lleva años operando y arrastra **5,014 SKUs con 13.8M de unidades** que nunca se depuraron. **Ninguna de las cuatro migraciones anteriores sirve de ensayo para esto.**

### 1.11c Checklist del 30-sep (IC.CEDIS)

1. ✅ **HECHO — ya no hace falta acordarse.** `importers/lib/cedis-source-guard.js` (commit de esta fase) le pone dos puertas a los **dos** importers del CEDIS (RA-PRO.24 stock y RA-PRO.25 cadencia):
   - **A) cutover** — en cuanto `commercial.warehouses` del CEDIS declare `kepler_code`, los feeds se **apagan solos**. El paso 3 de esta lista es el interruptor.
   - **B) frescura** — si la fuente Wincaja tiene más de `CEDIS_SOURCE_MAX_AGE_DAYS` días (default 3), no publica (ADR-056).
   **Ya está activo hoy**: corrido contra prod, los dos importers dan `⛔ SKIP (source_stale)` — la fuente tiene 10 días. Smoke `test-newdb-cedis-source-guard.js` **8/0**, con las dos puertas rotas a propósito.
   ⚠️ **Por qué el feed se veía sano:** el MERGE es sin churn (UPSERT sólo-cambios) y el dato ya no cambia — `actual` y `nuevo` dan **248 SKUs / 188,347 pz idénticos**, así que `updated_at` no se movía desde el 22-sep. **Un feed que publica una foto congelada se ve exactamente igual que uno al día.**
2. ⛔ **PENDIENTE — el de mayor monto, y no lo puedo cerrar yo.** Verificar que la carga **reemplace** el saldo previo de Kepler `00` y no se **sume** a él. Es `N-A-30` = *entrada*, o sea que por construcción **suma a `c8`** (§1.11b-bis). No lo arreglamos desde acá: no escribimos al SoR (ADR-040). Lo que sí se puede es **medirlo el mismo día** y avisar.
3. ✅ **HECHO 2026-09-30 (mig `20260930140000`, prod batch 644).** `commercial.warehouses` code `00` → `kepler_code = '00'`, y de paso `wincaja.branches.00.kepler_cutover_date = 2026-09-30` porque **las dos tablas discrepaban** y el guard consulta las dos. Verificado en prod: el guard devuelve `ok:false · reason:'cutover_done'`.
   ⛔ **Y la puerta B ya no frenaba cuando se hizo.** Medido el mismo día: el último movimiento de Wincaja `00` pasó a ser del **28-sep (2 días, tope 3)** porque los carriles PM2 de la réplica, parados desde el 22-sep, se reiniciaron en esa sesión. **La única contención era circunstancial y se evaporó sola** — el paso 1 decía "ya está activo hoy" y para el 30-sep era falso. *Una compuerta que frena por accidente se lee igual que una que frena por diseño.*
   ⚠️ El rótulo `CEDIS BPIRAPUATO` → `CEDIS Irapuato` (nombraba el `.mdb`, no el almacén). Pero **`wincaja_source_branch` NO se tocó: es el puente al histórico**, y "borrar las referencias BIRAPUATO" habría roto justo los históricos que el pedido quería conservar.
4. ✅ **HECHO 2026-09-30 (mig `20260930150000`, prod batch 645).** `wincaja.branches` `00` → `status` de `live_on_wincaja` a `transition` — era la **única** fila que quedaba en `live_on_wincaja`, y tras el paso 3 la fila se contradecía a sí misma (viva en Wincaja *y* con fecha de corte a Kepler).
   No es cosmético: medido, el **único predicado vivo** en todo el repo es `existencia.service.ts:589`, que arma la píldora "Wincaja ⟨ramas⟩" de `/almacen/existencia` — y esa píldora **rotulaba un dato que la pantalla ni siquiera muestra** (`v_erp_stock_on_hand` trae sólo 01-08, todas `kepler_ods`; el CEDIS no está ahí). El `wincaja_existencias_entrega` de `db-health` ya estaba retirado el 09-19, y `movement-reconcile` sólo lo nombra en texto. Verificado en prod: `live_on_wincaja` → **0 ramas**, la píldora desaparece sola, y `v_branch_erp_cutover` sigue dando `00 → 00 / MD-00 / 2026-09-30`.
4-bis. ✅ **El sensor del CEDIS, cambiado de FUENTE y no de rótulo (`IC.CEDIS.2`).** `stock_cedis_00` iba a ponerse rojo el **02-oct ~12:07** y quedarse rojo para siempre diciendo *"el feed se cayó"*, cuando el feed lo retiramos nosotros (última escritura real: 29/09 12:07, 196 SKUs). **Retirado** con su motivo — y el mecanismo de `retiredOn` lo despierta solo el día que la tabla vuelva a recibir datos, o sea el día que se encienda `cedis:true`. Lo reemplaza **`cedis_kepler_saldo`**, que mide **la condición que destraba el hueco**: `kdil` de la `00` contra la captura `N-A-45` más reciente, con el umbral **1.5× copiado de la compuerta**, no inventado. Nace rojo (**35.82×**) y es correcto que nazca rojo. Los tres estados probados contra prod con el SQL **extraído del archivo**: `35.82x` → corregir en Kepler · `0.97x` (saldo escalado) → se puede encender · sin captura → **`NO MEDIDO`**, crítico, nunca verde.
5. ⛔ **NO unir el CEDIS por `warehouse_code`.** Medido: `v_branch_erp_cutover.warehouse_code` **mezcla dos convenciones** — sólo las 2 migraciones recientes (`30`→`08`, `32`→`07`) guardan el código Kepler; las **6** viejas guardan el nombre Wincaja (`MD-10`, `MD-42`, `MD-50`…) que **no existe** como `code` en `commercial.warehouses`. Resuelve **2 de 8**; `kepler_code` resuelve **8 de 8**. ⚠️ **Al CEDIS le toca la convención vieja**: su `warehouse_code` es `MD-00` y su almacén real es `code='00'` — el día que entre a la vista, un INNER JOIN por ahí da **cero en silencio**. Usar `kepler_code` o `wincaja_source_branch`. (Reportado por la sesión de [AUD-DAT.11]; clavado con aserción en el smoke.)
6. Las vistas que unen el CEDIS por `wincaja_source_branch` (`v_erp_stock_on_hand`, `v_warehouse_box_factor`, gate de unidad) pasan a resolverlo por `kepler_code`.
7. ✅ **La compuerta existe y está probada**: `node database/scripts/check-cedis-cutover.js` (sólo lee). Mide los 4 puntos de arriba y **entrega la lista accionable** (SKU, existencia, valor) de lo que no llegó. Ejercida contra la migración real de Morelia Abastos: reproduce las cifras a mano (583 SKUs / $274,036 / 1.6%). Corrida hoy contra el CEDIS dice **`NO MEDIDO`** — la carga aún no ocurrió, y eso **no es un visto bueno**: qué SKUs de Wincaja `00` no llegaron.
8. Retirar los carriles PM2 de Wincaja (ya detenidos) **y sus sondas** → desbloquea el cierre de `.249` (Fase VL).

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
| **IC.CEDIS** ⏰ | **El checklist de §1.11c, el 30-sep.** Sus dos renglones críticos no son la compuerta: son **apagar `import-cedis-stock-wincaja.js`** (hace REPLACE — si queda vivo **borra lo que Kepler cargue**) y **verificar que la carga REEMPLACE los 122.8M de unidades basura** de Kepler `00`, no que se sume. Más la compuerta de cobertura con la foto del 18-sep, y el re-mapeo (`kepler_code`, `wincaja.branches`, las vistas que unen por `wincaja_source_branch`). Los **1,345 SKUs / $516,521** de `06`/`07`/`08` se revisan igual, pero sin prisa | **La ventana se cierra**: una vez que el CEDIS opere en Kepler no se podrá distinguir lo que nunca cargó de lo que se vendió. Y el importer vivo es un **daño activo**, no un riesgo pasivo (§1.11) |
| **IC.0** ✅ | **HECHO 2026-09-28** (commit `d497d544`) — vista `analytics.v_erp_physical_count_variance` (312 ms / 33,232 filas, cuadra contra el ODS crudo al centavo: **$6,602,105.34**), `InventoryVarianceService` + 4 endpoints (gate `COMMERCIAL_INVENTORY_VER`, ya repartido a 10 roles / 29 usuarios), página `/almacen/inventory/diferencias` + tab. Smoke **10/0** en la regresión. **Ver la diferencia que ya existe.** Vista `analytics.v_erp_physical_count_variance` (derive-no-copy sobre `kdm1`/`kdm2`) y página `/almacen/inventory/diferencias`: sobrante/faltante por sucursal × mes × SKU, con drill al SKU. **Marca `07`/`08` como carga inicial** para que no contaminen. **Prototipo ya corrido: 117 ms sobre todo el histórico.** | El descuadre de $6.65M del trimestral **no se ve en ninguna pantalla**. Cero conteo nuevo, valor el día 1 |
| **IC.0b** ✅ | **HECHO** — `coverage()` mide contra `v_erp_stock_on_hand` y devuelve **NULL cuando no se puede medir**, no cero. Medido: el trimestral cubre entre **69.2% y 92.7%** según la sucursal, y declara el desfase contra la foto de hoy. **La cobertura, declarada.** En la misma pantalla: qué NO se contó y cuánto vale — los **4,022** SKUs del hueco real, **más el CEDIS entero** ($7.6M sin contar jamás), **más** la marca de que `07`/`08` fueron carga inicial y `00`-Kepler es oficinas | Un conteo sin cobertura declarada se lee como "todo está bien". Regla de la casa: lo que no se midió se declara, nunca se dibuja como cero |
| **IC.1** ✅ | **HECHO 2026-09-28** (commit `f33d55f7`) — `stock_source` gana el valor `erp` (preferencia erp > inventory > commercial, **aditivo**) y la unidad se estampa al sembrar (mig `20260928280000`, 3 columnas **nullable a propósito**). ⚠️ Se usa `v_erp_stock_on_hand` (296 ms) y **NO** `v_erp_stock_truth`: medido, hace **timeout** incluso acotada a un almacén — arbitra costo, y para contar hace falta la cantidad. ⚠️ **El beneficio medido es CHICO**: las dos fuentes difieren en **90 SKUs de 21,941 (0.4%)**, no en el ~9% histórico — el importer mejoró mucho. Se hizo igual (un conteo se juzga SKU por SKU) pero **no se promete lo que no se midió**. Smoke **6/0**. **El teórico correcto.** Mover el conteo de `commercial.stock` a `analytics.v_erp_stock_truth`, resolviendo el ERP con `v_branch_erp_cutover` (tras el 30-sep el CEDIS **ya es Kepler**; sólo las rutas Wincaja quedan del otro lado); estampar en el item la unidad resuelta por `v_unit_truth` y el método; `NULL` con motivo cuando no se resuelve. ⚠️ **`v_erp_stock_truth` hace timeout al agregarla entera** — acotar por almacén o materializar (medir antes de elegir) | 91% a 100%. Sin esto seguimos mandando gente al anaquel por diferencias falsas |
| **IC.1c** ⭐ | **El CEDIS, primer conteo físico de su historia** — ya sobre Kepler, después de la migración. 248 SKUs con existencia, $7.6M | Cabe en un día y prueba el circuito completo (contar → diferencia → export) con riesgo mínimo. **El mejor piloto de la fase**, y su primer completo de Kepler no llega hasta ~dic |
| **IC.1b** ✅ | **HECHO 2026-09-29 — resultado NEGATIVO, y vale.** Las **dos** hipótesis quedaron descartadas y se declaran para que nadie las reconstruya: la **unidad** (la conversión mide bien en las cargas, §1.5) y la **migración incompleta** de PH. Esta segunda parecía confirmada — 629 de 897 sobrantes (**79% del dinero, $3,357,408**) eran SKUs que Wincaja tenía — **hasta medir el placebo: el caso base de *todos* los contados es 71.3%, y los sobrantes dan 70.1%.** Están *menos* asociados que el promedio. ⚠️ Y el cruce por cantidad no sirve: la foto de Wincaja es de jun-2026 y el conteo de sep, con 3 meses de operación en medio. **El sobrante de $4.25M de PH sigue SIN EXPLICAR.** **Explicar el sobrante.** La unidad **ya casi queda descartada** (§1.5: la conversión mide bien). La hipótesis viva es §1.9b: **PH no tiene carga inicial de su almacén principal** — cruzar los SKUs que sobraron en sep contra los que Wincaja `10` tenía y Kepler nunca cargó | $4.25M en una sola sucursal, y **el sobrante va de 6.5% a 31% en TODAS**. Si es carga incompleta, no es merma y nadie debe investigarlo como robo |
| **IC.2** ✅ | **HECHO 2026-09-28** (commit `8bc363b4`, mig `20260928270000`) — `almacenista` gana **VER** (no tenía ni eso) y **CONTAR**, y **pierde SUPERVISAR**: `GET /counts/:id/items` devuelve el teórico y va con ese permiso, así que un contador que lo tenga **rompe el conteo ciego**. `marketing` pierde **RECONCILIAR**. Smoke **8/0** como **TRINQUETE** (5 roles ya combinaban CONTAR+SUPERVISAR: no exige arreglar el pasado, exige que no empeore). Declarado sin tocar: `encargado_tienda` (7 personas) puede **AJUSTAR sin CONTAR**. **Permisos y segregación.** `CONTAR` al `almacenista`; quitar `RECONCILIAR` a `marketing`; **prueba negativa** (romper la compuerta a propósito y verificar el rojo) | Desbloquea a las 4 personas que cuentan. Un gate sin prueba negativa es una intención |
| **IC.3** ✅ | **HECHO 2026-09-28** (commit `b5935891`) — `analytics.v_sku_count_variance_history` (934 ms, 18,327 filas). **El universo son las CAPTURAS, no los ajustes** (si no, *contado 8 veces y descuadró 1* se ve igual que *contado 1 vez y descuadró 1*), y la **tasa es NULL bajo 2 observaciones**: la 02 tiene 7 conteos pero la 01 y la 06 tienen **uno**, y publicar 1-de-1 como 100% haría que el top priorice los almacenes con menos historia. Medido: el SKU `17063` de la 02 descuadró **6 de 6 veces, $3,318,784**. Smoke **9/0**. ⭐ **Su candado cruzado destapó 2 bugs en IC.0** (ver §1.12). **Histórico de descuadre por SKU.** Vista derivada de los 4 trimestres de ajustes (2025-Q4 a 2026-Q3) por (sucursal, SKU): veces que descuadró, pesos, signo | Es la 4ª señal de D2 **y** la más preventiva: contar seguido lo que siempre falla |
| **IC.4** ✅ | **HECHO** (`57a59ede`) — `v_count_priority_score`. ⛔ La 4ª señal **no existe en medio catálogo**, así que los pesos se **renormalizan fila por fila**: contarla como cero hundiría a los almacenes sin historia, justo los que más falta les hace. Medido: con historia 0.578, sin historia 0.477 (brecha **0.10**). Percentil **dentro del almacén**, componentes expuestas, y `sin_datos` declarado (**9,858 SKUs del CEDIS**). Smoke **10/0**. **Score del top** (`analytics.v_count_priority_score`): las 4 señales de D2 normalizadas, con el peso de cada una **visible en pantalla** | Un score opaco no se audita. Que se vea por qué un SKU está en la lista |
| **IC.5** ✅ | **HECHO** (`8601f78a`) — ola = `abs(hashtext(sku)) % 3`, estable y pareja (peor desvío **3.6%**). ⛔ **El `abs()` decide si se cuenta el 45% del catálogo**: sin él salen 5 olas y 5,034 de 11,274 SKUs quedan en olas que nadie pide. La ola **no** sale del score (un SKU que cambia de percentil se saltaría el trimestre) ni del `product_id` (un re-alta lo movióa). Smoke **6/0**. **Plan rotativo del parcial.** Reparte el catálogo en 3 olas por almacén; `openCycleCount` ya acota el folio | Es D3. La mecánica ya existe: falta el reparto y que nadie quede sin tocar |
| **IC.6** ✅ | **HECHO** (`39c7dd62`) — pestaña **Programa** en la misma página, no una nueva. Declara en pantalla: plan truncado, cobertura de olas incompleta, KPI **sin base de comparación**, y los períodos con denominador imposible. **Programa de inventario**: una pantalla con los tres ritmos — qué toca este mes, qué se contó, qué falta, cuándo cae el trimestral de Kepler | Hoy el trimestral es una fecha que alguien recuerda |
| **IC.7** ✅ | **HECHO** (`7c70a92d`) — `commercial.inventory_kepler_exports`. ⛔ Sin acuse, **el conteo siguiente vuelve a encontrar la misma diferencia** y alguien va otra vez al anaquel por algo ya resuelto. `capturado_por` es obligatorio por CHECK: un acuse anónimo no deja a quién preguntarle. `sin_emitir` ≠ `capturado`. **Cerrar el ciclo a Kepler** (D1): el folio reconciliado emite el archivo en formato `N-A-45` más el acuse de quién lo capturó y cuándo | El `kepler-export` existe y nunca se usó. Sin acuse, el conteo muere en nuestra base |
| **IC.8** ✅ | **HECHO** (`7c70a92d`) — % de descuadre sobre lo **contado** por trimestre. ⚠️ La serie (115 → 62 → 44 → 26) **NO se publica como mejora**: los almacenes cambian en cada período → `comparable: false`. Y el **115% es imposible** (el descuadre no puede exceder lo contado) → `denominador_incompleto`, fuera de la tendencia. **¿Sirvió?** Medir el descuadre del trimestral **antes contra después** de que el parcial corra un trimestre completo | La fase se mide sola. Si el descuadre de dic-2026 no baja contra sep-2026, el parcial no funciona y hay que decirlo |
| **IC.9** ✅ | **HECHO** (`7c70a92d`) — `fromKeplerVariance`. Prevención tenía **1 investigación** porque sólo leía *nuestros* folios (6, todos cancelados). ⚠️ Con umbral obligatorio: septiembre tiene **7,301 SKUs descuadrados** y abrirlos todos vacía la bandeja de sentido; el recorte se declara. **Enganche con Prevención.** Una diferencia confirmada abre expediente en `/almacen/prevencion` (PREV.1 ya construido, con 1 sola investigación en prod) | El módulo de investigación existe y está vacío porque nada lo alimenta |

| **IC.3b** ✅ | **HECHO** (`3c34c0a0`) — la PANTALLA de la reincidencia. La vista de IC.3 llevaba en prod **sin un solo consumidor**: alimentaba el score por dentro y nada más. Lo que agrega no es mostrarla, son **dos ejes**, y los dos nacieron de un fallo medido en su propio smoke. **(1) `retencion` = |neto|/bruto** — ordenar por dinero MOVIDO pone primero al SKU `17063` de la `02`, que mueve **$3,318,784** y retiene **$558**: misma cantidad entrando y saliendo. La distribución es **bimodal** (1,171 SKUs bajo 0.2 mueven $6.9M y dejan $75k = 1.1%, contra 3,404 clavados en 1.0), así que los cortes 0.2/0.8 son **los bordes del valle**, no números elegidos. **(2) `concentracion` = mayor evento/|neto|** — con sólo retención encabezaba el `17237` de la `05`, que retiene **$1,261,372** de UN sobrante de **30,196 kg de rollo de plástico** contra 3.98 y 9.84 kg en los otros dos conteos: un error de dedo con retención perfecta. Medido: **3,098 de 4,666 SKUs (66%, $5.7M de $7.4M) tienen un evento que explica el 90%+ de su neto** — descuadrar seguido y perder seguido **son cosas distintas**. ⛔ Los **9,556** que no se pueden juzgar se declaran con su dinero y sus almacenes: son la `01` y la `06` **enteras**, un conteo cada una. ⚡ El join de las dos derivaciones del ODS en un solo plan tarda **83 s**; separadas y en paralelo, **926 ms**; el CTE **MATERIALIZED** con almacén, **653 ms**. Smoke **20/0** con prueba negativa (19/1 al invertir bindings) | Todo lo que la fase encontró cruzando trimestres salía de consultas a mano |

| **IC.12** 🧪 | **EN CÓDIGO** — `analytics.mv_erp_physical_count_variance`. Dos problemas de la misma pantalla, los dos medidos contra prod. **(a) EL DINERO:** el ajuste `N-A-30` declara la cantidad en **PIEZAS** y la valúa al **costo de la CAJA**; como `importe = cantidad × costo_unitario` se cumple en **7,301 de 7,301** renglones, el error entra entero al número publicado. Arbitrado contra la **captura del mismo día** (contemporánea) y corroborado por la ficha `kdii`: **338 renglones publican $6,845,043 donde al costo contado serían $487,714**. El `importe` **NO se corrige** (ADR-040): se declara `costo_veredicto` fila por fila y la banda en disputa va en pantalla, arriba del total que la contiene. **(b) EL TIEMPO:** la pestaña abría en **2.2 s** contra el gate de 1 s porque el plan re-derivaba el ODS **una vez por almacén** (`loops=8`) más un `LEFT JOIN catalog.products` de ~480 ms que `summary()` ni usa. Materializada (poblado 92 s, nocturno, umbral en `CRON_JOBS` como `analytics_refresh_count_variance`). De paso arregla por construcción el testigo de `detail()`, que filtraba por SUCURSAL y no por ALMACÉN — el día que la tienda `01` y la Ruta 28 cuenten juntas, el «se contó» de una sumaba el de la otra. 🚀 **APLICADA A PROD 2026-09-30 08:1x MX** (batch **599**, 64.0 s, identidad `7688376744939610156` verificada por el candado del script). Pre-vuelo por `pg_locks`/`pg_stat_activity` y no por `knex_migrations_lock.is_locked`, que ya mintió una vez (CE.8): sólo el shipper del CDC activo, 0 locks en espera. Candado `test-newdb-count-variance-rung.js` **22 ✓ / 0 ✗ / 1 no medido** contra el objeto real, y IC.0 18/0 · IC.3 9/0 · IC.10 17/0 sin regresión. La vista conserva `security_invoker` y su GRANT (ADR-057). **Medido después: `summary()` 2,020→41 ms · `detail()` 1,390→3 ms · `events()` 1,880→20 ms · concentración 2,260→67 ms.** ⚠️ **La pantalla todavía NO es rápida para nadie**: el API desplegado sigue leyendo la vista: el salto llega con el redeploy. El único `no medido` que queda es el latido, que lo escribe el nocturno una vez que el worker lleve el código. **Falta: `git push` + redeploy. Sin permisos nuevos → sin re-login.** |

**🚀 LAS 6 MIGRACIONES APLICADAS A PROD (2026-09-29 09:52 MX).** `public.knex_migrations` **895 → 901**, una por una con `apply-one-migration-prod.js` (candado de identidad `7688376744939610156` verificado en cada una; ninguna pasó de 0.1 s). Los **7 smokes contra prod: 70 aserciones, 0 fallas.** Metadata verificada en vivo: las 3 vistas con `security_invoker=true` y `SELECT` a `app_runtime`, las 3 columnas de IC.1 **nullable**, `inventory_kepler_exports` con RLS **forzado** y sus 2 CHECK.

⭐ **Y lo que desbloqueó el trámite fue medir dónde está prod, no pedir una credencial.** El diagnóstico previo —*«falta un rol con DDL»*— era correcto **desde esta máquina** (`edgar` no es superusuario, no tiene `CREATE` en ningún schema, y el único rol que puede asumir es `dev_ro`) y **llevaba a la conclusión equivocada**: prod dejó Railway el 2026-09-22 y vive en `md` (`192.168.0.222:5434`), donde el camino canónico es correr el aplicador **dentro de `prod-api`**, que ya tiene la URL buena. Ver [[feedback_measure_where_it_runs_today_not_where_code_lives]].

⛔ **Efecto colateral MEDIDO, no hipotético — y es el estado normal de este proyecto entre aplicar y pushear.** Prod tiene ahora 6 filas en `knex_migrations` cuyos archivos **no están en `origin/main`**. Reproducido a propósito en `prod-worker` (imagen limpia): `knex.migrate.list()` aborta con **`migration directory is corrupt`**. Qué se rompe y qué no, verificado:

| | |
| --- | --- |
| Arranque de la API | ✅ **no migra al bootstrap** — el único `migrate.latest` del repo es un *comentario* en `new-database.module.ts` |
| Compuerta del `auto-deploy` | ✅ lee `knex_migrations` por **SQL + awk**, no por knex, y frena por el caso **inverso** (archivo en HEAD sin aplicar) |
| La próxima sesión que aplique una migración desde el contenedor | ⛔ **choca con estos 6 archivos** y tiene que copiárselos — es lo que la cabecera del aplicador ya documenta |

Se cierra con el push. **Falta:** `git push` (⛔ requiere autorización — `main` local arrastra **21 commits de otras 5 fases** que no audité: UIM·VSO·MR·AUD·CS), **re-login** de `almacenista`/`marketing`, y validación visual. Sigue: **IC.CEDIS** (por calendario, el 30).

⚠️ **IC.2 ya está VIVO y no espera al código**: los permisos viven en la DB. La migración imprimió el estado final — `almacenista: ver=true contar=true supervisar=false reconciliar=false`. Riesgo nulo, medido: el módulo tenía 6 folios, todos `cancelled`.

**MVP original = IC.CEDIS + IC.0 + IC.0b + IC.1 + IC.2.** Con eso se protege la migración del CEDIS, se ve el descuadre real, se cuenta contra la fuente buena y las personas correctas pueden contar.

⚠️ **Requisito transversal de toda vista que toque `kdm2`:** el join lleva **`c1`** (el almacén), y el smoke lleva una aserción contra la duplicación — §1.9.

---

### 1.12 ⛔ Dos bugs que sólo apareció al cruzar dos implementaciones (2026-09-28)

IC.0 estaba commiteada, con su smoke en **10/0** y cuadrando contra el ODS crudo al centavo. El candado que compara su resultado con el de IC.3 encontró una divergencia de **$449,517**, y detrás había dos defectos reales:

1. ⛔ **Réplica cruzada.** `kepler_ods.kdm1` con `sucursal='03'` trae **220 cabeceras del almacén `02`** (nov-2025 a ene-2026) — el mismo fenómeno que `kdil` ya documenta. La vista las atribuía a **8ESQ siendo de La Piedad**. ⚠️ El filtro correcto **no** es `almacen = sucursal` a secas: eso borraría los **sub-almacenes legítimos**, y la única carga de Padre Hidalgo vive en el almacén `01-006` (la Ruta 28).
2. ⛔ **`max()` sobre folios.** El CTE agrupaba incluyendo el folio y la firma hacía `max(lineas)`. Hay eventos con **64 folios** del mismo doctype en la misma fecha, así que se comparaba el folio más grande de captura contra el más grande de entrada — no el total.

⭐ **La lección de método:** el smoke de IC.0 verificaba la vista **contra sí misma** (contra el ODS crudo con su propia lógica) y pasó los dos bugs. Lo que los encontró fue **comparar dos implementaciones independientes del mismo concepto**. Y la aserción que faltaba no era gratis: el bloque de cuadre filtra sep-2026 y la réplica es de nov-ene, así que **pasaba en verde sin ejercer el arreglo**.

⚠️ El candado cruzado también estaba **mal planteado**: exigía igualdad entre las dos vistas cuando miden universos distintos a propósito (IC.0 trae todo el descuadre; IC.3 sólo el de los SKUs que estuvieron en la captura). Ahora exige **dirección** — el historial es un subconjunto y nunca puede exceder — y que la brecha no crezca: hoy **0.87%**. Exigir Δ cero habría obligado a romper uno de los dos diseños para que el test pasara.

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
- ⭐ **Efecto colateral que no es de esta fase pero conviene cobrar:** el CEDIS era la **única** sucursal que le quedaba al carril de réplica Wincaja (§1.11). Al irse, la infraestructura Access (PM2 en `.249`, Jet 32-bit sobre `Z:`) queda sin propósito — lo que la Fase VL tenía anotado como su último bloqueo. **Retirar los carriles Y sus sondas** (una sonda huérfana deja un verde incondicional, o un rojo eterno).
- ~~**Por qué el sobrante neto es +$4.35M** — no se sabe.~~ ⭐ **RESPONDIDO (IC.12, 2026-09-29).** No era la unidad de la CANTIDAD: es la unidad del **COSTO**. El ajuste `N-A-30` trae `c11 = 'PZA'` y un `c12` que es el costo de la **CAJA**, y como `importe = c9 × c12` se cumple en **7,301 de 7,301** renglones, el factor de caja entra entero al dinero publicado. Arbitrado contra **dos testigos que coinciden al centavo** —la captura `N-A-45` del mismo día y la ficha `kdii` (`v_kepler_standard_cost`)—: `02135` ficha 5.20/62.39 factor 12, captura 5.20, **ajuste 62.39**; `88228` 10.53/105.28 factor 10, captura 10.53, **ajuste 105.28**. Y es **asimétrico**, que es lo que fabrica el neto: en sep-2026, con SKUs de factor > 1, **44 renglones de SOBRANTE** contra **1 de faltante**; sólo esos 44 publican $2,475,395 donde a costo de pieza serían $201,512. Sobre toda la historia, **338 renglones publican $6,845,043 contra $487,714**. **El importe NO se corrige** (es el que Kepler asentó, ADR-040): se DECLARA. ⚠️ Lo que sigue abierto es más chico y más preciso: los **491 renglones de sobrante ($2.11M)** cuyo costo no cae en ningún peldaño de la ficha, y **por qué el ajuste toma el peldaño de arriba** — eso es pregunta para quien opera Kepler, no para código. ⚠️ Y **el cutover sigue sin explicarlo**: `01` es outlier contra sucursales que migraron después y contra las que nunca migraron (§1.3c) — aunque ahora se sabe que **75% de su sobrante está en 85 SKUs** con el costo contradicho.

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
2. ~~¿Con qué código entra el CEDIS?~~ **Respondida por la medición (§1.11b): como `00`, la que ya existe.** No hay colisión — la `00` de Kepler ya es el centro administrativo del CEDIS (compra, paga, cobra, factura mayoreo) y lo único que le falta es el almacén físico. `wincaja.branches` ya declaraba `kepler_code='00'`. **Falta confirmarlo con quien ejecuta la migración**, no descubrirlo.
2b. ⏰ **¿La carga del 30 REEMPLAZA o SUMA** sobre los 122.8M de unidades basura de Kepler `00`? Es el riesgo de mayor monto y se verifica el mismo día.
2c. **¿El CEDIS dejó de operar el 18-sep, o sólo paró la copia del `.mdb`?** No lo distinguí (§1.11). Cambia si la foto del corte está completa.
3. **¿Quién captura el archivo en Kepler** (IC.7) y en qué ventana? Sin dueño, el ciclo no cierra.
4. **¿El parcial congela movimientos?** Hoy `openCycleCount` va con `freeze = false` por default — razonable para no parar el almacén, pero hay que confirmarlo.
5. **Morelia (`07`/`08`)**: migraron el 2026-09-08 y el 09-19 (§1.3c). ¿Desde qué trimestre entran al KPI — dic-2026 o mar-2027?
6. **El CEDIS tiene 253 SKUs con existencia de 15,559 en catálogo.** ¿Es real (almacén de flujo) o la réplica está incompleta? La carga del 30 lo responde sola.
7. **Los 1,345 SKUs / $516,521 que no llegaron en `06`/`07`/`08`** (§1.10): ¿hay una razón operativa (descontinuado, transferido antes del corte) o se quedaron en el camino? Es pregunta para almacén, no para código.
