# Medición RA — ¿el comprador mejora el sugerido? y ¿nuestra requisición es la de Kepler? (2026-10-23)

> **Para quién:** el equipo que trabaja el motor de reabastecimiento (`/compras/pedido`,
> `/compras/requisiciones`) y el PM. Dos preguntas que deciden si el motor sirve y si lo que publicamos
> es verdad. Son mediciones **previas a cualquier cambio al motor** (brief de Edgar, 2026-10-23).
>
> **Dónde se corre (sólo lectura contra prod, todo termina en `ROLLBACK`):**
> `node database/scripts/medir-ra-sugerido-vs-salida-posterior.js` y
> `node database/scripts/medir-ra-requisicion-vs-kepler.js [compras|traspasos|todo]`.
> Base: `railway` en `md`, `system_identifier 7688376744939610156`. ODS fresco a hoy en las 8
> sucursales (última venta 2026-10-23); el CEDIS `00` **no vende** (última U-D-12: 27-sep) pero
> **embarca** (U-D-41: 152 documentos en 7 días).

---

## 0. Resumen en diez líneas

1. **El comprador casi siempre sube el sugerido, y casi siempre tiene razón en la dirección**: de 1,008
   renglones de compra, **499 mejor (49.5 %) · 199 peor (19.7 %) · 91 igual (9.0 %) · 219 sin medir
   (21.7 %)**, juzgados con la salida real posterior leída del ODS, no con la demanda que usó el motor.
2. **Pero «mejor» no es «suficiente»:** la cobertura mediana que dejaba el sugerido era **1.6 días**; la
   que deja lo pedido, **10.2 días**; el objetivo (lead + cadencia) era **19**. En 631 de 710 renglones
   medibles (**88.9 %**) el sugerido se agotaba antes del siguiente pedido.
3. **La mitad del pedido (522 renglones, 51.8 %) nació con sugerido 0** y aun así el comprador lo pidió:
   325 de esos renglones resultaron «mejor». El motor no está **mal calibrado**: en la mitad de los
   renglones **no opinó**.
4. **Y no se puede reconstruir por qué**: la línea guarda `min_stock`, `reorder_point` y `max_stock`
   **en 0 en los 1,008 renglones**, y el plan (`analytics.replenishment_plan`) no tiene historia
   (`computed_at` = hoy). **Deuda con nombre: la requisición no guarda la base del sugerido.**
5. Donde sí empeora, cuesta: en los 199 renglones «peor» se pidieron **$2,946,807** por encima del
   sugerido (al costo por caja de la Suite); 107 renglones quedaron con más de 45 días de cobertura
   (**$2,285,097** por encima del sugerido).
6. **Compras contra Kepler:** de 202 requisiciones de proveedor, **125 tienen un documento del mismo
   proveedor en los 15 días siguientes** (placebo: 78); **45 con el mismo conjunto de SKUs** (placebo: 5);
   **16 con el mismo importe** (placebo: **0**). El cruce no es casualidad.
7. Sobre los **43 pares idénticos en lista (399 renglones): importe al centavo 392 (98.2 %)**; cantidad y
   costo cuadran **con la escalera `c58`** en 376 y 375, y con el factor de caja de la Suite en 394.
   **7 renglones difieren y tienen causa**: 3 cantidad movida por el comprador, 4 costo movido.
8. **El total del encabezado NO es comparable:** `kdm1.c16` trae IVA (tasa por renglón en `kdm2.c17`,
   mezcla de 0 y 16 %); nuestro `total_cost` es neto. 39 de 43 suman igual por renglón; sólo 12 cuadran
   en `c16`. Compararlos sin esto es comparar neto contra bruto.
9. **Traspasos contra Kepler: NO son el mismo documento.** De 3,254 renglones de requisición de
   sucursal, **386 (11.9 %)** existen en un pedido U-D-40 origen→destino con la misma cantidad; placebo
   **93 (2.9 %)**. Señal neta ≈ 9 puntos: **9 de cada 10 renglones de traspaso de la Suite no llegan
   tal cual a Kepler**. 602 de 661 se quedan en `approved` para siempre.
10. **Lo que la Suite publica y Kepler no tiene** (Existencia al armar, Reorden, Sugerido, Pedir en
    cajas, Unidades, Costo estimado neto, Recibido, lote) **es derivado nuestro** y se declara así
    (§3). No hay campo que se presente como dato del ERP sin serlo, **pero el «Costo unit.» está en
    otra unidad que el de Kepler** (caja contra PAQ/PZA/KG) y eso hay que decirlo en pantalla.

---

## 1. Medición 1 — ¿el comprador mejora, repite o empeora el sugerido?

### 1.1 Universo y árbitro

| | |
|---|---|
| Renglones | **1,008** de **101 requisiciones de compra** (`approved`/`ordered`/`received`) creadas del 2026-09-24 al 2026-10-08, en almacenes con código Kepler |
| Por qué esa ventana | Para que cada renglón tenga **al menos 14 días de salida posterior** observable (el ODS llega a ayer) |
| Árbitro | **Lo que salió** de ese SKU × sucursal después del pedido, leído del ODS: sucursal → venta `U-D` 8/10/12 no cancelada, sin la refactura vecinal (VERDAD_ABSOLUTA §4.4); **CEDIS `00` → embarques `U-D-41`** a sucursales |
| Unidad | Unidad **base** de Kepler (`kdm2.c9`). Las cajas de la requisición se llevan a base con `analytics.v_warehouse_box_factor`; su `base_label` coincide con la unidad de venta de Kepler en **20,461 de 20,492** pares sucursal × SKU (99.8 %) |
| Prueba de unidad | 3 de 3 renglones de hoy: `on_hand × factor` = `v_erp_stock_on_hand.qty_stock_units`. Los snapshots diarios (`analytics.stock_snapshots`) **no sirven de árbitro**: cubren 142 de 1,008 renglones (sólo pares con existencia) — declarado, no usado |
| Horizonte H | `lead_days` del plan (912 de 1,008 lo tienen) + `cadence_days` del canal (946); defaults 7 + 14. Mediana **19 días** |
| Cobertura | `(existencia al armar + pedido) ÷ salida diaria posterior`, con la salida observada hasta ayer (promedio 17 días) extrapolada a H |
| Veredicto | distancia de la cobertura al intervalo **[H, 45 días]** (el tope de `RA.45D`). **mejor** si lo pedido queda más cerca que el sugerido; **peor** si más lejos; **normal** si igual o sin cambio; **sin medir** si la ventana es < 7 días o no hubo existencia ni salida (agotado no observable) |
| Trampa evitada | Se juzga con la salida **posterior** al pedido, nunca con la demanda que usó el motor |

⚠️ **Lo que el árbitro no ve:** tránsito ni otras entradas (misma política que `RA.TR`), y la salida
del CEDIS es lo que **pudo** embarcar: si estaba agotado, la demanda queda subestimada (por eso
`OH = 0 y V = 0` → sin medir). El mismo SKU se vuelve a pedir dentro de H en sólo **28 renglones
(2.8 %)**: acumular esos pedidos cambia 4 veredictos de 1,008.

### 1.2 Resultado

| veredicto | renglones | % | $ pedido en esos renglones | $ sumado al sugerido |
|---|---:|---:|---:|---:|
| **mejor** | **499** | 49.5 | 3,621,627 | 3,288,714 |
| **peor** | **199** | 19.7 | 3,112,770 | **2,946,807** |
| normal | 91 | 9.0 | 473,722 | 35,781 |
| sin medir | 219 | 21.7 | 2,474,010 | 1,432,736 |

Por dirección de la corrección:

| el comprador… | renglones | mejor | peor | normal | sin medir | cobertura con S | cobertura con F |
|---|---:|---:|---:|---:|---:|---:|---:|
| **subió** | 828 | 492 | 158 | 5 | 173 | 2.4 d | 11.8 d (peor: 40.5 → 181.6) |
| **bajó** | 59 | 7 | 41 | — | 11 | 7.9 d | 5.4 d |
| dejó igual | 121 | — | — | 86 | 35 | 39.5 d | 39.5 d |

⭐ **Subir casi siempre acierta en la dirección (492 contra 158); bajar casi siempre falla (7 contra
41)** — cuando el comprador recorta, recorta algo que ya era corto.

### 1.3 El sugerido en sí, juzgado solo

| sugerido (S) | lo pedido (F) corto | F en rango | F largo (> 45 d) | total |
|---|---:|---:|---:|---:|
| **S corto (se agotaba antes de H)** | **527** | 66 | 38 | **631 (88.9 %)** |
| S en rango | 1 | 31 | 19 | 51 |
| S largo | — | 1 | 27 | 28 |
| sin medir | | | | 298 |

Cobertura mediana: **S 1.6 días · F 10.2 días · objetivo 19 días.** El comprador corrige hacia donde
hay que corregir y se queda corto: 527 renglones siguen cortos después de su corrección.

### 1.4 La mitad del pedido no tuvo sugerido

| sugerido = 0 | renglones | mejor | peor | normal | sin medir | $ pedido |
|---|---:|---:|---:|---:|---:|---:|
| **sí (522, 51.8 %)** | 522 | **325** | 100 | 5 | 92 | 5,905,054 |
| no | 486 | 174 | 99 | 86 | 127 | 3,777,076 |

**Por qué el motor dijo 0 no se puede reconstruir hoy.** Los 1,008 renglones guardan `min_stock`,
`reorder_point` y `max_stock` **en 0** (`target_basis = 'max'` en todos): la pantalla manda el sugerido
ya redondeado y topado (`seed`) pero **no la base** (demanda diaria, horizonte, tope, existencia que
vio). Y el plan no guarda historia: `analytics.replenishment_plan.computed_at` es de hoy para las
1,727 filas del CEDIS. El CEDIS además tiene `daily_pieces = 0` en todas y la demanda vive en
`eff_daily` (1,608 con valor): **no es que no haya demanda, es que la columna que la lleva es otra**.

### 1.5 Por sucursal, comprador y proveedor

| sucursal | renglones | mejor | peor | normal | sin medir | $ de más en «peor» |
|---|---:|---:|---:|---:|---:|---:|
| CEDIS | 864 | 461 | 151 | 40 | 212 | 2,609,584 |
| Morelia Abastos | 71 | 32 | 27 | 8 | 4 | 212,923 |
| Padre Hidalgo | 36 | 5 | 19 | 9 | 3 | 109,411 |
| Morelia Madero | 14 | 1 | 1 | 12 | — | 10,636 |
| Canindo | 7 | — | 1 | 6 | — | 4,254 |
| 8 Esquinas · La Piedad · Yurécuaro · Zamora | 16 | — | — | 16 | — | — |

| comprador (puesto) | renglones | mejor | peor | normal | sin medir | $ de más en «peor» |
|---|---:|---:|---:|---:|---:|---:|
| Yajaira González (gerente de compras) | 671 | 385 | 117 | 57 | 112 | 2,055,559 |
| Luis Francisco López (dirección) | 170 | 4 | 59 | 19 | 88 | 690,772 |
| Mario Ventura (auxiliar de compras) | 97 | 78 | 2 | — | 17 | 110,435 |
| Aide Piceno (compras, Morelia Abastos) | 35 | 20 | 12 | 1 | 2 | 48,858 |
| Janette García (auxiliar de compras) | 22 | 12 | 9 | 1 | — | 41,184 |
| Super Root | 13 | — | — | 13 | — | — |

| proveedor | renglones | mejor | peor | normal | sin medir | $ de más en «peor» |
|---|---:|---:|---:|---:|---:|---:|
| Mondelez | 142 | 3 | **58** | 17 | 64 | **690,772** |
| Pepsico | 85 | 55 | 14 | — | 16 | 27,597 |
| Reyher | 61 | 23 | 19 | 18 | 1 | 875 |
| Representaciones HC | 52 | 23 | 2 | — | 27 | 753 |
| Eloro | 49 | 4 | 32 | 1 | 12 | 71,067 |
| Dulcera de Abastos | 46 | 43 | 1 | 2 | — | 3,011 |
| Paletas Alma | 39 | 39 | — | — | — | — |
| Baltazar Zúñiga | 36 | 9 | 13 | 13 | 1 | 36,318 |
| Mil Envases | 34 | 29 | 3 | 1 | 1 | 2,718 |
| Grupo Levi | 32 | 1 | — | — | 31 | — |

⚠️ Una cifra por persona **no es un juicio de la persona**: Luis Francisco pide Mondelez (58 de sus 59
«peor» son de ese proveedor, pedidos a plazo largo que el árbitro de 19 días castiga) y 88 de sus 170
renglones no se pudieron medir. Es un dato para **calibrar el horizonte por proveedor**, no un ranking.

### 1.6 Lo que esta medición deja

- **Un lazo que no existía:** por primera vez un veredicto por renglón contra la salida posterior.
  El script lo reproduce para cualquier ventana de creación.
- **Dos deudas con nombre** (ADR-056): (a) **la requisición no guarda la base del sugerido**
  (`[RA-MED.3]`); (b) **el plan no tiene historia** — sin las dos, el motor no se puede calibrar.
- **Una regla que ya se puede escribir:** el horizonte de juicio tiene que ser **por proveedor**
  (Mondelez no se pide cada 19 días).

---

## 2. Medición 2 — ¿nuestra requisición es idéntica a la de Kepler?

### 2.1 Compras: requisición de proveedor contra `X-A-30` / `X-A-35`

Universo: **202 requisiciones** de proveedor (`approved` 78 · `ordered` 102 · `received` 22), 120 días,
todas con sucursal Kepler y código de proveedor. Documentos candidatos: 274. Ventana real
`[f, f+15]`; **placebo** `[f−30, f−15]`.

| prueba | real | placebo |
|---|---:|---:|
| hay documento del mismo proveedor y sucursal | **125** (61.9 %) | 78 |
| …con el **mismo conjunto de SKUs** | **45** | 5 |
| …con el **mismo importe** (±0.5 %) | **16** | **0** |
| …mismo conjunto **y** mismo importe | **11** | **0** |
| …≥ 70 % de los SKUs | 62 | 25 |
| **sin ningún documento del proveedor** | **77** (38.1 %): 43 `approved`, 29 `ordered`, 5 `received` | |

Tomando el mejor candidato real por requisición (127): conjunto igual **43**, la requisición cabe
dentro de un documento mayor 13, parcial 68, ningún SKU en común 1. ⭐ **17 de los 43 pares idénticos
están `approved` en la Suite**: se tecleó en Kepler sin marcarla «ordenada» — el estado de la Suite no
describe lo que pasó.

**Columna por columna, sobre los 43 pares (399 renglones, todos presentes en Kepler):**

| columna | cuadra | detalle |
|---|---:|---|
| Fecha | 40 / 43 mismo día, 42 / 43 a ≤ 3 días | |
| Conjunto de SKUs | 43 / 43 | por construcción del par |
| **Importe del renglón** (`c13`) | **392 / 399 (98.2 %)** | al centavo |
| Cantidad tal cual | 19 / 399 | Kepler **nunca** escribe `CJA`: PAQ 595+7,508 · PZA 506+3,764 · KG · SER |
| Cantidad **con `c58`** (`cajas × c58 = c9`) | **376 / 399 (94.2 %)** | `cajas = c56` en 376 |
| Cantidad con el **factor de caja de la Suite** | **394 / 399 (98.7 %)** | `c58 = factor Suite` en 377 |
| Costo unitario con `c58` (`costo_caja ÷ c58 = c12`) | 375 / 399 | `costo_caja = c57` en 375 |
| **Total del encabezado** (`c16`) | **12 / 43** | ⛔ ver abajo |

**Los 7 renglones que no cuadran, con causa:**

| requisición | SKU | Suite | Kepler | causa |
|---|---|---|---|---|
| RQ-2026-00350 | 51019 | 71 cj · $20,235 | 300 PAQ (`c58` 15 → 20 cj) · $5,700 | cantidad movida |
| RQ-2026-00580 | 59349 | 720 cj · $133,942 | 8,640 PZA (`c58` 15 → 576 cj) · $107,153 | cantidad movida |
| RQ-2026-00825 | 83842 | 140 · $2,016 | 100 PZA · $1,440 | cantidad movida |
| RQ-2026-00707 | 33020 · 33021 | $758.62 / cj | `c57` $777.78 | costo movido (+2.5 %) |
| RQ-2026-00707 | 59402 | $888.89 / cj | `c57` $694.44 | costo movido (−21.9 %) |
| RQ-2026-00707 | 03070 | $972.22 / cj | `c57` $833.33 | costo movido (−14.3 %) |

⛔ **El total del documento no es comparable con el nuestro.** `kdm1.c16` incluye IVA y la tasa va por
renglón en `kdm2.c17` (0 ó 16): en los 43 pares, la **suma de renglones** iguala nuestro `total_cost`
en 39, `c16` iguala esa suma en 12, iguala `suma × 1.16` en 5 y queda **entre las dos en 26** (razón
promedio 1.0618). El cruce del 2026-10-16 (6 de 6 en total) cayó en pares sin IVA. **Regla: el importe
se compara por renglón; el encabezado sólo neto contra neto.**

**Veredicto:** cuando una requisición de compra llega a Kepler como documento, **es la misma en
proveedor, fecha, lista, importe por renglón y costo por caja**; la cantidad y el costo unitario sólo
difieren de **unidad** (caja contra la presentación `c55/c58`), y los 7 renglones distintos son
cambios del comprador, no datos inventados. Lo que no cuadra es la **cobertura**: 77 de 202 no tienen
documento y el estado de la Suite no lo sabe.

### 2.2 Traspasos: requisición de sucursal contra `U-D-40`

Universo: **661 requisiciones** de sucursal (`approved` 602 · `ordered` 59), 120 días, 4 orígenes → 8
destinos, **3,254 renglones**. En Kepler el pedido de una sucursal a su matriz es un `U-D-40` del
**origen** con cliente `TI…` del destino (`c27 = 'SUCURSAL'`; `TI` de `analytics.v_erp_branch_catalog`,
9 de 9 consistentes). Ventana real `[f, f+7]`; placebo `[f−21, f−14]`.

| por documento | real | placebo |
|---|---:|---:|
| hay un pedido origen→destino en la ventana | 657 | 587 — **la ventana no discrimina** (cadencia 1.7 días) |
| mismo conjunto de SKUs | **14** | 3 |
| la requisición cabe en un pedido | 105 | 34 |
| ≥ 70 % de los SKUs | 124 | 44 |
| mismo importe (±0.5 %) | 25 | 7 |
| `c24` con el folio `RQ-…` de la Suite | **0** | 0 |

| por renglón (3,254) | real | placebo | señal neta |
|---|---:|---:|---:|
| el SKU está en algún pedido de la ventana | 695 (21.4 %) | 407 (12.5 %) | 8.9 pp |
| …**con la misma cantidad base** | **386 (11.9 %)** | 93 (2.9 %) | **9.0 pp** |
| …con las mismas cajas (`c56`) | 391 (12.0 %) | 92 (2.8 %) | 9.2 pp |

**Veredicto:** el traspaso de la Suite **no es** el pedido de Kepler. Nueve de cada diez renglones no
llegan tal cual; 602 de 661 se quedan en `approved`. No hay dato inventado —la requisición de traspaso
es un documento **nuestro** que nadie transcribe— pero cualquier pantalla que lo presente como «lo que
se pidió a la matriz» miente. Mientras el empuje `[KR]` de traspasos siga sin plantilla
(`kepler-requisition-sink.adapter.ts`: «la del traspaso no tiene default»), es un borrador.

---

## 3. Lo que la Suite publica y Kepler no tiene — declarado como derivado nuestro

| campo (pantalla de requisición) | origen | ¿existe en el documento de Kepler? |
|---|---|---|
| Existencia | `v_erp_stock_on_hand` al armar, en cajas | no (es un censo nuestro del momento) |
| Reorden | `reorder_point` de la línea | **no, y hoy llega en 0 siempre** — pintarlo es pintar un cero falso |
| Sugerido | motor (`seed`, redondeado y topado a 45 d) | no |
| Pedir | capturado por el comprador, **en cajas** | sí: `c9` en la presentación `c55` con factor `c58` (nunca `CJA`) |
| Costo unit. | costo **por caja** de la Suite | sí, **por caja en `c57`**; `c12` es por unidad base |
| Importe | `cajas × costo_caja`, neto | sí: `c13`, al centavo (392 / 399) |
| Unidades (encabezado) | suma de cajas | no (Kepler suma en unidad base) |
| Costo estimado (encabezado) | suma neta de renglones | **no comparable** con `c16` (trae IVA) |
| Recibido | `received_qty` nuestro | en Kepler es otro documento (`X-A-20`) |
| Lote, origen de la requisición, estado | nuestros | no |

Ninguno se presenta hoy como dato del ERP. Dos sí hay que corregir en pantalla: **«Reorden» es un
cero que no se midió** (debe declararse o quitarse) y **«Costo unit.» debe decir «por caja»**.

---

## 4. Lo que NO se midió (y se declara)

- **Si la mercancía llegó.** El veredicto compara contra la salida; no verifica la recepción
  (`X-A-20`) ni descuenta tránsito. Con 22 `received` de 202 no hay universo para medirlo.
- **Las 77 compras sin documento** en 15 días: no se buscó fuera de la ventana ni en otra sucursal.
- **La causa de los 602 traspasos `approved`:** si la sucursal lo pide por otro canal o si nadie lo
  procesa. Es una pregunta para Compras, no para el ODS.
- **Un control placebo para la Medición 1.** El placebo natural (juzgar con la demanda previa) es
  justamente la trampa que se evitó; no hay un control equivalente para el veredicto por renglón.

## 5. Siguientes pasos propuestos (no se abren sin autorización)

| id | capa | qué | por qué |
|---|---|---|---|
| `[RA-MED.3]` | C0 | La línea de requisición guarda **la base del sugerido**: demanda diaria, horizonte, tope, existencia y tránsito que vio, versión del plan | sin eso el motor no se calibra (§1.4) |
| `[RA-MED.4]` | C1 | Horizonte de juicio **por proveedor** (lead + cadencia reales del canal) y veredicto posterior como columna de `/compras/flujo` | §1.5: Mondelez no se mide con 19 días |
| `[RA-MED.5]` | C3 | «Reorden» deja de pintar 0; «Costo unit.» dice «por caja»; el estado `approved` avisa «ya existe en Kepler» cuando el cruce lo encuentra | §2.1 y §3 |
| `[RA-MED.6]` | C0 | Elegir plantilla `U-D-40` y encender el empuje de traspasos, o retirar la requisición de traspaso como «pedido a la matriz» | §2.2: 9 de 10 no llegan |
