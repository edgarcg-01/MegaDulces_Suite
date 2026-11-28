# `[ICR.K]` Anexo — La anatomía medida del inventario físico en Kepler

> **Qué contesta este documento:** cómo registra Kepler un inventario físico, columna por columna,
> para que la Suite pueda **escribir el ajuste directo en el ERP** en vez de emitir un archivo que
> alguien captura a mano. Decisión de Edgar (PM) del **2026-11-27**: *«nosotros vamos a escribir
> en Kepler lo necesario»*.
>
> ⛔⛔ **Nada de acá se ejerció contra Kepler.** Todo se midió **leyendo** `kepler_ods` en prod
> (`system_identifier` 7688376744939610156) el **2026-11-27**. El código que escribe existe y
> **nunca corrió**. Encenderlo lo autoriza Edgar; ver §8.
>
> Hermano de [`FASE_ICR_ANEXO_CONTEO_TRIMESTRAL_2026-11-27.md`](FASE_ICR_ANEXO_CONTEO_TRIMESTRAL_2026-11-27.md) §2.3,
> que planteó la pregunta. Acá está la respuesta medida.

**Universo:** los **312 `N-A-45`**, **249 `N-A-30`** y **227 `N-D-30`** de las nueve sucursales
(19-nov-2025 → 30-sep-2026), más las **1,522 `N-A-44`** de pre-captura. Documento de referencia:
**Yurécuaro (04), 17-sep-2026**.

---

## 1. ⭐⭐ Cuál documento mueve la existencia — y es el que decide todo lo demás

**La entrada y la salida. El acta NO.** Tres testigos independientes, y ninguno es una suposición.

### 1.1 El kardex (`kdij`), que es el hecho

Acotado a lo que el ODS realmente replica de cada plaza —`kdij` **arranca en fecha distinta por
sucursal**: `00` 2024-08-09 · `03` 2025-01-01 · `02` 29-ene · `04` 18-feb · `05` 17-mar · `01`
27-jun · `06` 14-ago · `07` 07-sep · `08` 18-sep— y a los documentos vivos (`c43='N'`):

| documento | docs en la ventana | con filas de kardex |
|---|---:|---:|
| **`N-A-45`** Captura inventario físico | 123 | **0** |
| **`N-A-30`** Entrada Inventario físico | 108 | **108** (`c30='E'`) |
| **`N-D-30`** Salida inventario físico | 94 | **94** (`c30='S'`) |

Ni una excepción en 325 documentos. Y es **1 renglón ↔ 1 fila de kardex**: en Yurécuaro, 264 y
346 filas contra 264 y 346 renglones, **misma cantidad y misma unidad en las 610** (cero
diferencias). En el conjunto, el kardex iguala al número de renglones distintos en **102 de 108**
entradas y **88 de 94** salidas; los 12 restantes tienen kardex parcial, por el borde de la
ventana de réplica.

> ⚠️ **Un susto que resultó ser del ODS, no de Kepler.** El `N-A-30` folio 1 de Padre Hidalgo
> parecía tener 1,221 renglones contra 897 filas de kardex. No falta kardex: **sobran renglones
> en la copia del ODS** — esos 1,221 son sólo **897 números de renglón distintos**, o sea 324
> filas duplicadas en la réplica. Contra renglones distintos, 897 = 897. Por eso todo conteo de
> renglones de `kdm2` en este documento va con `count(DISTINCT c7)`.

### 1.2 El catálogo (`kdmm.c8`), la bandera «afecta inventario» del propio ERP

`N-A-45` = `'N'` · `N-A-30` = `'S'` · `N-D-30` = `'S'`. La bandera se comporta en el resto del
catálogo: la traen `U-D-10` (venta POS), `U-A-50` (recepción), `U-D-41` (embarque), `N-A-6` y
`N-D-6` (traspaso); no la trae `U-D-40` (pedido), que efectivamente no mueve nada.

### 1.3 La contabilidad (`kdmm.c19`/`c20`)

| documento | cargo | abono |
|---|---|---|
| `N-A-45` | *(vacío)* | *(vacío)* |
| `N-A-30` | `114-001` | `114-006` |
| `N-D-30` | `114-006` | `114-001` |

**El acta no tiene cuentas.** No mueve inventario ni dinero: es el registro de lo que se contó.

### 1.4 Y la aritmética cierra

264 + 346 = **610** SKUs ajustados de **1,567** contados; los otros **957 cuadraron** y no
generaron nada. Ningún SKU está en la entrada y en la salida a la vez (**0 de 610**), y los 610
están en el acta (264/264 y 346/346). El 17-sep en Yurécuaro **ningún otro documento de la familia
tocó el kardex**: el día tuvo 397 filas de `U-D-10`, 346 de `N-D-30`, 264 de `N-A-30`, 22 de
`U-A-21`, 5 de `U-A-50`, 2 de `X-A-40` y **una sola** de `N-A-20` y de `N-D-5` (el ajuste chico de
todos los días).

### 1.5 ⛔⛔ La cantidad del movimiento es la DIFERENCIA, no lo contado

**114 de los 610 movimientos son MAYORES que la cantidad contada del mismo SKU** — imposible si
fuera un absoluto (51 entradas y 63 salidas). Y 25 coinciden con lo contado, que es lo que pasa
cuando una de las dos puntas es cero.

⇒ **La Suite no puede mandar la diferencia hecha.** La calcula el adapter contra la existencia del
propio Kepler, dentro de la transacción que escribe: `kdil.c4 + c8 − c9`, piso en 0 (la fórmula de
`analytics.v_erp_stock_on_hand`). Usar el libro de la Suite ajustaría el ERP contra otro libro —
`commercial.stock` está muerta por decisión (`[CANON.7.5]`) y `[CANON.7.4d]` midió **31 % de
celdas discrepantes, $22.1 M**.

---

## 2. ⭐⭐ Cómo se ligan los tres: por `c11`, no por `c36`…`c39`

La entrada y la salida llevan **el folio del acta en `kdm1.c11`**, y también por renglón en
`kdm2.c28`. **No hay liga `c36`/`c37`/`c38`/`c39`** como en la OC — esta familia liga por
referencia, y hay que saberlo porque buscarla donde no está lleva a concluir que no existe.

| | `c11` es un folio de 7 dígitos | resuelve a un acta de la misma sucursal | …el mismo día |
|---|---:|---:|---:|
| `N-A-30` | 243 de 249 | 250 de 256 | 243 |
| `N-D-30` | 221 de 227 | 227 de 233 | 221 |

**Comparten serie (1) pero no folio.** En Yurécuaro el acta es la **3**, la entrada la **4** y la
salida la **3**: cada tipo tiene su propio contador. Los nueve inventarios de septiembre:

| fecha | suc | acta | entrada | salida |
|---|---|---|---|---|
| 04-sep | 06 | 2 | 2 | 1 |
| 07-sep | 07 | 1 | 1 | — |
| 10-sep | 05 Zamora | 6 | 4 | 3 |
| 11-sep | 01 Padre Hidalgo | 1 | 1 | 1 |
| **17-sep** | **04 Yurécuaro** | **3** | **4** | **3** |
| 18-sep | 08 Morelia Abastos | 1 | 1 | — |
| 22-sep | 03 8 Esquinas | 4 | 3 | 3 |
| 23-sep | 02 La Piedad | 217 | 157 | 145 |
| 30-sep | 00 CEDIS | 1 | 1 | — |

⭐ **Dos cosas que esta tabla agrega a lo que se sabía:** fueron **nueve** plazas, no siete (06 y
07 también contaron), y **tres cerraron sin salida** (00, 07 y 08) — un inventario sin faltantes
es un resultado legítimo y el carril tiene que soportarlo.

### 2.1 La pre-captura `N-A-44`, que no estaba en el mapa

Existe un cuarto documento: **`N-A-44` «Pre Captura Inv Fis»**, 1,522 en total, `kdmm.c8='N'` (no
mueve nada). Es la **hoja de conteo**: Yurécuaro acumuló 111 (folios 1…111, de marzo al 17-sep) y
su acta las resume. El acta guarda la última en `c81` (`'0000111'`) y la lista en `c82`
(`'|0000067|0000068|…'`) — ⚠️ **truncada a 60 caracteres**, así que `c82` **no sirve** para
reconstruir qué hojas entraron. La Suite **no necesita escribir `N-A-44`**: su equivalente es la
captura por rack, que ya vive del lado de la Suite.

---

## 3. ⛔⛔ Qué significa `c11` acá — la trampa del carril, medida

`c11` es la columna que ya mordió dos veces: en `X-A-30` es referencia libre y en `U-D-40` es el
**estado del flujo**. Acá es **una tercera cosa, y distinta entre el acta y sus movimientos**:

| | qué es `c11` | medido |
|---|---|---|
| `N-A-45` **acta** | **la ZONA que se contó** | 192 de 312 llenos, y **cero** folios: `T02` (41), `T05` (32), `T03` (30), `T01` (27), `T04` (17), `B01`…`B06`, `RESTOS`, `RESTOS2`, `PROMO`, `GLOBO`, y nombres: `VIVI 01`, `CLAU 02`, `CLAU 3` |
| `N-A-30` / `N-D-30` | **el FOLIO DEL ACTA** | 243/249 y 221/227 son un folio de 7 dígitos |

⇒ **La marca de la Suite va a `c24` en los tres.** En los movimientos `c11` está ocupado por la
liga —pisarlo deja el ajuste huérfano del conteo que lo explica— y en el acta `c11` **ya tiene
dueño**: es la etiqueta con la que La Piedad (02) y 8 Esquinas (03) organizan sus conteos
parciales. Esas dos plazas no hacen un inventario trimestral, **cuentan por zona todo el año**:
217 y 79 actas, contra 1 a 6 en las otras siete.

`c24` es texto libre de verdad en los tres, igual que en `U-D-40`: 33 actas, 17 entradas y 22
salidas lo traen, con `MATA`, `PIMENTEL`, `AJUSTE INV`, `CAPTURA VIVI`, `SEGUNDO TRIMESTRE
16/06/2026` y *«SE REALIZA MOV. POR ERROR AL MOMENTO DE SU SALIDA PATY PROMO»*.

> ⭐ **Por qué la marca no es decorativa:** el 2026-10-13 hubo que limpiar documentos de prueba del
> ERP y lo único que permitió distinguirlos de los que captura la gente fue la marca de la Suite.
> Acá la marca es el folio del conteo (`INV-2026-00007`), que además liga el documento del ERP con
> lo que la gente ve en la pantalla.

---

## 4. La anatomía del encabezado (`kdm1`), columna por columna

Columnas pobladas en el documento de Yurécuaro, y su cobertura en todo el universo.

| col | acta `N-A-45` | entrada `N-A-30` | salida `N-D-30` | qué es |
|---|---|---|---|---|
| `c1` | `04` | `04` | `04` | sucursal |
| `c2`·`c3`·`c4` | `N`·`A`·`45` | `N`·`A`·`30` | `N`·`D`·`30` | la coordenada |
| `c5` | `1` | `1` | `1` | **serie — siempre 1** (2,310 de 2,310 documentos de la familia) |
| `c6` | `0000003` | `0000004` | `0000003` | folio, 7 dígitos, **contador propio por tipo** |
| `c7` | `PESOS` | `PESOS` | `PESOS` | moneda |
| `c9`·`c68` | 2026-09-17 | 2026-09-17 | 2026-09-17 | fecha del documento |
| `c11` | *(zona)* | `0000003` | `0000003` | ⛔ **§3** |
| `c14` | `108782.20` | `0.00` | `0.00` | **IVA** = 16 % del importe contado |
| `c16`·`c42` | `0.00` | `116053.19` | `64540.70` | total; **el acta va en cero** (271 de 312) |
| `c24` | *(libre)* | *(libre)* | *(libre)* | ⭐ **aquí va la marca de la Suite** |
| `c31` | `Cap` | `Ent` | `Sal` | etiqueta corta (312/312, 249/249, 227/227) |
| `c43` | `N` | `N` | `N` | ⭐ **vivo / cancelado** — §5 |
| `c63` | `NA4501-` | *(vacío)* | *(vacío)* | prefijo: el acta lo trae 312/312; los movimientos lo traen **vacío** en 243/249 y 221/227 |
| `c67` | `00` | `00` | `00` | quién capturó (`MD`, `VIVIANA`, `00`…) → la Suite escribe `SUITE` |
| `c69` | `18:13` | `18:15` | `18:15` | hora de captura, `HH:MM` |
| `c81`·`c82` | `0000111` / lista | — | — | las `N-A-44` que resume (§2.1) |

⭐ **El IVA se verifica solo:** `679,888.72 × 0.16 = 108,782.1952 → 108,782.20`, que es el `c14` del
acta **al centavo**. Y la tasa no se inventa: la declara `kdmm.c16` (`16` para `N-A-45`, `0` para
los otros dos).

### El renglón (`kdm2`)

| col | qué es | medido |
|---|---|---|
| `c7` | número de renglón | 1…N |
| `c8` | SKU | 1 renglón por SKU (1,567 renglones / 1,567 SKUs) |
| `c9` | cantidad | **lo contado** en el acta · **la diferencia** en los movimientos |
| `c10` | descripción | — |
| `c11` | **unidad** (≠ `kdm1.c11`) | la base de la ficha: `= kdii.c11` en **1,549 de 1,567 (98.9 %)** |
| `c12` | costo unitario | ⚠️ fuente **NO confirmada** — §6 |
| `c13` | importe | **`round(c9 × c12, 2)` en 1,567 de 1,567 (100 %)** |
| `c17` | tasa de IVA | `16` en el acta, `0` en los movimientos |
| `c24` | repite la cantidad | = `c9` |
| `c28` | **folio del acta** | vacío en el acta ⛔ (en `U-D-40` esta columna es el *estado* del renglón) |
| `c32` | fecha | = la del encabezado |

---

## 5. ⭐ `c43` es el estado vivo/cancelado, y se midió

`c43='C'` = **cancelado**: 50 actas y 3 entradas. **Las 53 tienen cero filas de kardex y `c16`=0**,
sin una sola excepción. Las 246 entradas y 227 salidas con `c43='N'` tienen todas `c16 > 0`.

⇒ El adapter **fuerza `c43='N'`**. Si la plantilla fuera un documento cancelado, el clon nacería
cancelado y **no movería nada, en silencio** — que es la peor forma de fallar.

---

## 6. ⭐ La lista `limpiar` está VACÍA en los tres, y es una medición

En `U-D-40` la lista eran los responsables de surtir/checar/embarcar (`c100`/`c102`/`c103`), que
el 90-91 % de los procesados traía y el 0 % de los nuevos. Acá se buscó lo mismo: las **245 actas
ya procesadas** (las que tienen un movimiento apuntándolas) contra las **67 que no**, las 201
columnas de `kdm1`. **No hay ninguna columna que marque «ya se procesó».**

Lo que parecía serlo y no lo es:

- **Las 67 «sin procesar» son borradores vacíos.** 49 no tienen un solo renglón; las 18 que sí,
  promedian 9 renglones contra 250 de las procesadas.
- **`c14` (lleno en 244/245 contra 18/67) sigue a los RENGLONES, no al proceso**: es el IVA del
  importe contado, así que un acta vacía lo tiene en cero por aritmética.
- **`c18`, `c41`, `c91`, `c101`, `c188`, `c191`, `c195`, `c197`** aparecen en 5 de 245 con el valor
  `1800-01-01T00:00:00`. Es **otro centinela de vacío** —el habitual es `1800-01-01T06:36:36`— y
  sólo en las plazas cuyo Kepler se actualizó a partir del 04-sep-2026 (00, 02, 03, 06, 07). Es
  una diferencia de **versión del ERP**, no una huella de proceso.

⇒ **La huella del proceso no vive en el acta: vive en sus hijos.** Lo que dice que un acta ya se
procesó es que existe una entrada o una salida con su folio en `c11`. **Clonar es seguro** en los
tres tipos.

---

## 6b. ⛔ Lo que quedó NO MEDIDO: de dónde sale el costo del renglón

`kdm2.c12` es el costo unitario con el que Kepler valúa el renglón. El candidato documentado es
**`kdik.c16`** (costo unitario neto, peldaño base, promedio móvil por sucursal). Contrastado
contra el acta de Yurécuaro: **coincide en 933 de 1,567 (59.5 %)**.

**El control que explicaría la brecha FALLA.** Si la diferencia fuera deriva del promedio móvil
después del conteo, los 634 que difieren deberían concentrar las entradas posteriores al 17-sep.
No lo hacen:

| grupo | SKUs | con entrada posterior al conteo |
|---|---:|---:|
| costo **igual** hoy | 933 | 278 (**29.8 %**) |
| costo **distinto** hoy | 634 | 236 (**37.2 %**) |

Casi la misma tasa, y **398 SKUs sin ninguna entrada posterior siguen difiriendo**.

⇒ **`kdik.c16` NO está confirmado como la fuente de `kdm2.c12`.** El adapter lo usa porque es un
número del propio ERP para esa sucursal —no uno inventado por la Suite— y **devuelve
`costo_no_confirmado: true` en todas sus respuestas**, con el costo de cada renglón, para que se
pueda revisar antes de encender nada. ⛔ **Cerrar esto es requisito para escribir la entrada y la
salida**, que sí postean a contabilidad (`114-001`/`114-006`). El acta no postea nada.

---

## 7. El folio: cómo se reserva, y los tres contadores que FALTAN

El folio sale del contador de Kepler (`md.sqliov`), con `reservarFolioKepler` de
`@megadulces/platform-core` **tal cual**: su llave es `KF` + género + naturaleza + tipo(2) +
serie(2) + `.` + sucursal, que da `KFNA4501.04`, `KFNA3001.04`, `KFND3001.04`.

⭐ **Y el propio ERP lo confirma:** `kdmm.c17` de estos tipos dice literalmente `KFNA4501`,
`KFNA3001` y `KFND3001`. No hay que deducir la llave: el catálogo la declara.

Estado de los 36 contadores de la familia (9 sucursales × 4 tipos), medido:

| estado | cuántos | cuáles |
|---|---:|---|
| **ok** (`c4` = `MAX+1`) | 26 | — |
| **atrasado** (`c4` ≤ `MAX`) | 4 | **todos en la 03**: `KFNA3001.03` dice 3 contra 74 · `KFNA4501.03` dice 4 contra 75 · `KFND3001.03` dice 3 contra 71 · `KFNA4401.03` dice 164 contra 225 |
| ⛔ **falta la fila** | 3 | **`KFND3001.00`, `KFND3001.07`, `KFND3001.08`** |

- Los **atrasados no son un problema**: `decidirFolio` usa `greatest(contador, MAX+1)` justo para
  esto, y lo registra en la bitácora (`VENÍA ATRASADO`).
- ⛔⛔ **Los tres que faltan sí lo son**, y son exactamente las tres plazas que **nunca** han
  capturado un `N-D-30` (00 CEDIS, 07, 08). `reservarFolioKepler` **falla cerrado** sin la fila —
  no inventa un folio—, así que **la Suite no puede escribir la salida en esas tres sucursales**.

---

## 8. Qué falta para encender, y qué autoriza Edgar

| # | qué | quién |
|---|---|---|
| 1 | **Cerrar el costo (§6b).** Es lo único que bloquea por correcto, no por configuración | medición |
| 2 | Elegir el documento **plantilla** de cada tipo en cada servidor (`KEPLER_INV_{ACTA,ENTRADA,SALIDA}_TEMPLATE_FOLIO_NN`). Hay candidato vivo con renglones para acta y entrada en los 9 servidores; ⛔ **para la salida NO lo hay en 00, 07 y 08** | Sistemas |
| 3 | **Crear `KFND3001.00/.07/.08` en `md.sqliov`**, o aceptar que esas tres plazas no escriban salida hasta que una persona capture la primera a mano | Sistemas |
| 4 | `GRANT` en los nueve servidores: `SELECT` en `kdm1`, `kdm2`, `kdil`, `kdii`, `kdik`; `INSERT` en `kdm1`/`kdm2`; `SELECT, UPDATE(c4)` en `sqliov` | Sistemas |
| 5 | Fila en `commercial.kepler_push_switch` con `tipo='inventario_fisico'`, **apagada**, tope 1 | migración |
| 6 | **Ensayo** (`BEGIN` … `ROLLBACK`) desde `md` contra cada servidor: ejerce todo el SQL real sin dejar nada | **Edgar autoriza** |
| 7 | **Canario**: una sucursal, un ajuste, verlo en pantalla, contar las filas de `kdij` | **Edgar autoriza** |

⛔⛔ **Ninguno de los pasos 6 y 7 se corre sin que Edgar lo diga**, y se corren desde `md`: Kepler
vivo sólo acepta escrituras desde ahí, y un documento de prueba en el ERP de una sucursal es un
documento real que alguien tiene que ir a borrar.

---

## 9. Dónde vive el código

| archivo | qué es |
|---|---|
| [`libs/contracts/src/ports/kepler-inventory-adjustment-sink.port.ts`](../../../libs/contracts/src/ports/kepler-inventory-adjustment-sink.port.ts) | el puerto: recibe **lo contado**, nunca la diferencia |
| [`libs/commercial/src/lib/commercial-inventory/kepler-inventario-doctipo.ts`](../../../libs/commercial/src/lib/commercial-inventory/kepler-inventario-doctipo.ts) | **el spec de los tres doctipos**, cada campo con su cifra |
| [`libs/commercial/src/lib/commercial-inventory/kepler-inventario-sink.adapter.ts`](../../../libs/commercial/src/lib/commercial-inventory/kepler-inventario-sink.adapter.ts) | el adapter: clona, reserva folio, escribe los tres en una transacción |
| [`…/kepler-inventario-doctipo.spec.ts`](../../../libs/commercial/src/lib/commercial-inventory/kepler-inventario-doctipo.spec.ts) | 27 pruebas, con el rojo a propósito de cada candado |

### Cómo se engancha (no construido acá — lo coordina el PM)

El punto es `reconcile(countId)` de `inventory-count.service.ts`, después de que el folio cierra.
Lo que el service le pasa al sink es `{ sku, nombre, contado }` por ítem **contado** (`final_qty`,
en unidad base) — ⛔ **nunca `variance`**, que está calculado contra el libro de la Suite. Y antes
de llamar tiene que mirar si el folio ya tiene guardada su coordenada de Kepler: el sink **no es
idempotente**, y acá llamarlo dos veces no duplica, **ajusta dos veces en sentidos opuestos**.

---

## 10. Bitácora

| fecha | qué |
|---|---|
| 2026-11-27 | Documento inicial. Medido en prod, sólo lectura. Spec, puerto, adapter y 27 pruebas escritos; **cero escrituras a Kepler**. |
