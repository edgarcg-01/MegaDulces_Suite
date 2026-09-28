# Fase IC — Inventario Continuo (los tres ritmos)

> **Estado: 🔨 DISEÑADO (planeación) 2026-09-28 — ADR-079 propuesto.**
> **Pedido (Edgar, 2026-09-28):** mantener **tres** tipos de inventario — **completo** (trimestral, lo genera Kepler), **parcial** (mensual, nuestro) y **por productos top** (nuestro) — con interfaces para generarlos y **mostrar las diferencias**.
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
| `00` | **0** | **4,647** | 0 |
| `01` | 2,561 | 754 | 379 |
| `02` | 2,251 | 616 | 119 |
| `03` | 2,068 | 923 | 163 |
| `04` | 1,462 | 502 | 105 |
| `05` | 1,932 | 430 | 157 |
| `06` | 2,605 | 342 | 343 |
| `07` | 2,207 | 263 | 332 |
| `08` | 2,582 | 192 | 327 |

- ⛔ **La sucursal `00` no tiene ni una sola captura en toda la historia del ODS.** 4,647 SKUs con existencia jamás contados por esta vía.
- **4,022 SKUs con existencia** quedaron fuera en el resto (7% a 31% por sucursal).
- Los "contados sin existencia" son sobrantes puros: mercancía física que el teórico no conocía.

### 1.4 El descuadre de septiembre

| Sucursal | SKUs sobrante | SKUs faltante | $ sobrante | $ faltante |
|---|---:|---:|---:|---:|
| `01` | 1,221 | 1,296 | 4,294,155 | 1,248,543 |
| `02` | 422 | 722 | 384,974 | 195,770 |
| `03` | 475 | 885 | 746,382 | 315,781 |
| `04` | 264 | 346 | 116,053 | 64,541 |
| `05` | 382 | 480 | 304,223 | 142,337 |
| `06` | 591 | 601 | 803,936 | 334,665 |
| `07` | 2,539 | **0** | 2,723,195 | — |
| `08` | 2,908 | **0** | 16,084,195 | — |

- **Excluyendo `07`/`08`: sobrante $6.65M contra faltante $2.30M — neto +$4.35M de sobrante.** Un sobrante neto de esa magnitud dice que el teórico **subestima sistemáticamente**, o que la unidad no es la misma de los dos lados.
- En la `01`, 2,517 de 3,185 SKUs contados (**79%**) descuadraron.
- ⛔ **`07`/`08` (Morelia) no contaron: cargaron.** Faltante $0 y líneas de ajuste iguales a las líneas de captura — firma de carga inicial. **Deben excluirse de toda métrica de descuadre** o contaminan el promedio con $18.8M.

### 1.5 Sospecha de unidad — abierta, NO probada

Sobrante de la `01` por unidad declarada (`c11`):

| Unidad | Líneas | $ |
|---|---:|---:|
| `PZA` | 326 | **3,279,295** |
| `PAQ` | 804 | 877,377 |
| `500` / `KG` / `BTO` / `250` | 91 | 137,483 |

**76% del dinero en 29% de las líneas, concentrado en `PZA`.** Los SKUs grandes traen el empaque en el nombre (`BUBBULUBU ICE /20` con 7,613 PZA de sobrante; `TRIDENT VALUPACK /12` con 10,297).

⚠️ **Se intentó probar y no se pudo.** Reconstruir el teórico como `contado − ajuste` da **negativos** (el ajuste es mayor que lo contado), o sea que el ajuste no corresponde 1:1 con esa captura. **La hipótesis queda declarada, no confirmada.** Probarla es IC.1b, con el método de la casa: prestarle un precio a la cantidad y ver contra qué peldaño de la escalera se pega, no comparar nombres de columna.

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
| **Completo** | **Kepler** (no nosotros) | trimestral | catálogo con existencia de la sucursal | `N-A-30`/`N-D-30` del ODS — **ya existe, hoy invisible** |
| **Parcial** | nosotros | mensual | un tercio rotativo, cubre el trimestre | nuestro folio contra `v_erp_stock_truth` |
| **Top** | nosotros | mensual, encima del rotativo | score de 4 señales, con tope por almacén | nuestro folio contra `v_erp_stock_truth` |

**Cómo encajan:** el rotativo reparte **todo** el catálogo en 3 olas; el top se cuenta **además**, cada mes. Lo caro o riesgoso se cuenta 3 veces por trimestre, el resto 1 vez, y cuando llega el conteo de Kepler ya no hay sorpresas — que es exactamente el KPI de la fase (§5).

---

## 4. Sprints

Orden por valor entregado, no por dependencia técnica. **IC.0 entrega valor sin que nadie cuente nada.**

| Sprint | Entrega | Por qué |
|---|---|---|
| **IC.0** ⭐ | **Ver la diferencia que ya existe.** Vista `analytics.v_erp_physical_count_variance` (derive-no-copy sobre `kdm1`/`kdm2`) y página `/almacen/inventory/diferencias`: sobrante/faltante por sucursal × mes × SKU, con drill al SKU. **Marca `07`/`08` como carga inicial** para que no contaminen. **Prototipo ya corrido: 117 ms sobre todo el histórico.** | El descuadre de $6.65M del trimestral **no se ve en ninguna pantalla**. Cero conteo nuevo, valor el día 1 |
| **IC.0b** | **La cobertura, declarada.** En la misma pantalla: qué NO se contó y cuánto vale (los 4,647 de `00` más los 4,022 del resto) | Un conteo sin cobertura declarada se lee como "todo está bien". Regla de la casa: lo que no se midió se declara, nunca se dibuja como cero |
| **IC.1** | **El teórico correcto.** Mover el conteo de `commercial.stock` a `analytics.v_erp_stock_truth`; estampar en el item la unidad resuelta por `v_unit_truth` y el método; `NULL` con motivo cuando no se resuelve | 91% a 100%. Sin esto seguimos mandando gente al anaquel por diferencias falsas |
| **IC.1b** | **Probar (o descartar) la unidad.** Medir si el descuadre de §1.5 se explica por el factor de caja | $3.28M de sobrante en `PZA` lo exige. Si es unidad, no es merma y nadie debe investigarlo como robo |
| **IC.2** | **Permisos y segregación.** `CONTAR` al `almacenista`; quitar `RECONCILIAR` a `marketing`; **prueba negativa** (romper la compuerta a propósito y verificar el rojo) | Desbloquea a las 4 personas que cuentan. Un gate sin prueba negativa es una intención |
| **IC.3** | **Histórico de descuadre por SKU.** Vista derivada de los 4 trimestres de ajustes (2025-Q4 a 2026-Q3) por (sucursal, SKU): veces que descuadró, pesos, signo | Es la 4ª señal de D2 **y** la más preventiva: contar seguido lo que siempre falla |
| **IC.4** | **Score del top** (`analytics.v_count_priority_score`): las 4 señales de D2 normalizadas, con el peso de cada una **visible en pantalla** | Un score opaco no se audita. Que se vea por qué un SKU está en la lista |
| **IC.5** | **Plan rotativo del parcial.** Reparte el catálogo en 3 olas por almacén; `openCycleCount` ya acota el folio | Es D3. La mecánica ya existe: falta el reparto y que nadie quede sin tocar |
| **IC.6** | **Programa de inventario**: una pantalla con los tres ritmos — qué toca este mes, qué se contó, qué falta, cuándo cae el trimestral de Kepler | Hoy el trimestral es una fecha que alguien recuerda |
| **IC.7** | **Cerrar el ciclo a Kepler** (D1): el folio reconciliado emite el archivo en formato `N-A-45` más el acuse de quién lo capturó y cuándo | El `kepler-export` existe y nunca se usó. Sin acuse, el conteo muere en nuestra base |
| **IC.8** | **¿Sirvió?** Medir el descuadre del trimestral **antes contra después** de que el parcial corra un trimestre completo | La fase se mide sola. Si el descuadre de dic-2026 no baja contra sep-2026, el parcial no funciona y hay que decirlo |
| **IC.9** | **Enganche con Prevención.** Una diferencia confirmada abre expediente en `/almacen/prevencion` (PREV.1 ya construido, con 1 sola investigación en prod) | El módulo de investigación existe y está vacío porque nada lo alimenta |

**MVP = IC.0 + IC.0b + IC.1 + IC.2.** Con eso se ve el descuadre real, se cuenta contra la fuente buena, y las personas correctas pueden contar.

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
- **La sucursal `00`** — no se contará en este alcance; su hueco (4,647 SKUs) **se declara en pantalla** (IC.0b). Si entra o no es decisión de operación, no técnica.
- **Por qué el sobrante neto es +$4.35M** — no se sabe. IC.1b prueba la hipótesis de unidad; si la descarta, queda abierto con nombre y monto.

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

1. **`00`**: ¿es CEDIS u OFICINAS? `commercial.warehouses` la llama "CEDIS BPIRAPUATO", la memoria del proyecto dice OFICINAS. Cambia si sus 4,647 SKUs deben contarse.
2. **¿Quién captura el archivo en Kepler** (IC.7) y en qué ventana? Sin dueño, el ciclo no cierra.
3. **¿El parcial congela movimientos?** Hoy `openCycleCount` va con `freeze = false` por default — razonable para no parar el almacén, pero hay que confirmarlo.
4. **Morelia (`07`/`08`)**: ¿ya operan normal o siguen en carga? Define desde qué trimestre entran al KPI.
