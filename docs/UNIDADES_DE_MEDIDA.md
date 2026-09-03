# Unidades de medida — investigación

> **Fecha:** 2026-08-29 · **Medido contra prod** (`trolley`), ventana de 365 días.
> **Por qué existe:** en una sola sesión de trabajo sobre `/comercial/rentabilidad`, la unidad
> de medida causó **tres** bugs distintos (costo por caja contra piezas · inventario de red
> contra sucursal · caja impresa sobre producto a granel). No es mala suerte: es un problema
> estructural que nadie había medido completo.
> **Regla que sale de acá:** ver §7. Complementa [`GOTCHAS.md`](GOTCHAS.md) y el
> [diccionario del margen](IMPLEMENTACION/FASES/FASE_MR_DICCIONARIO_MARGEN.md).

---

## 1. El tamaño del problema

**31 tablas** cargan una columna de unidad o de factor. **Ocho fuentes distintas** reclaman
saber en cuántas piezas viene una caja del mismo producto:

| Fuente | Productos | ¿Se puede verificar contra Kepler? |
|---|---|---|
| `catalog.products.factor_sale` | 8,519 | — |
| `commercial.product_label_prices.box_size` (etiquetera) | 7,846 | ❌ |
| `commercial.product_unit_overrides.box_factor` (manual) | 295 | ✅ parcial |
| `analytics.wincaja_product_box_factor.factor_venta` | 185 | — |
| `commercial.supplier_item_aliases.box_factor` | 0 | — |
| `kepler_ods.kdii.c84` | 2,419 | ✅ (es el ancla) |
| `catalog.product_barcodes.factor` | — | — |
| `analytics.v_product_box_factor` (**resolvedor canónico**) | 8,903 | resuelve entre las anteriores |

---

## 2. El catálogo y el ERP no se ponen de acuerdo — 73.6%

De 8,873 productos comparables entre `catalog.products.unit_sale` y `kepler_ods.kdii.c11`
(la unidad base real del ERP):

| | |
|---|---|
| Coinciden | **2,340** (26.4%) |
| **Discrepan** | **6,533 (73.6%)** |

La forma del desacuerdo:

| Catálogo dice | Kepler dice | SKUs |
|---|---|---|
| PZA | **PAQ** | **5,868** |
| PZA | PZA | 1,822 ✅ |
| PAQ | PAQ | 506 ✅ |
| (null) | PAQ | 177 |
| PZA | **KG** | **143** ← dice pieza y se vende por peso |
| PZA | `500` | 54 ← la "unidad" es un número |

Visto de frente, están **invertidos**:

| | PZA | PAQ |
|---|---|---|
| `catalog.products.unit_sale` | **9,096** | 507 |
| `kepler_ods.kdii.c11` | 1,999 | **7,132** |

**Consecuencia:** `unit_sale` no sirve para rotular nada. Ya estaba anotado en memoria con
5,906 casos; medido completo son 6,533.

---

## 3. El vocabulario está sucio en las dos puntas

`kdii.c11` (unidad base declarada en el ERP): `PAQ` 7,132 · `PZA` 1,999 · `KG` 232 · **`500` 75 ·
`250` 34** · `CJA` 23 · `SER` 14 · `CUB` 6 · `BTO` 6 · `400` 6 · `IND` 1 · `2KG` 1.

Valores como `500`, `250`, `400`, `2KG` **no son unidades: son cantidades** capturadas en el
campo de unidad. Son pocos SKUs, pero cualquier lógica que haga `switch` sobre la unidad
tiene que tratarlos como desconocidos, no ignorarlos.

---

## 4. ⭐ El resolvedor canónico devuelve dos unidades en la misma columna

`analytics.v_product_box_factor` se creó justamente para que cada reporte no inventara su
propia precedencia. Resuelve con `override > c84 > etiquetera > factor_sale > 1`.

**El problema: no todas esas fuentes cuentan lo mismo.**

Contra el ancla de Kepler (`c84` = piezas/caja, `c81` = piezas/paquete), sobre los SKUs donde
hay con qué comparar:

| Fuente | Comparables | = `c84` (piezas/caja) | = paquetes/caja | Veredicto |
|---|---|---|---|---|
| `kepler_c84` | 359 | **359 (100%)** | 0 | ✅ piezas |
| `override` | 193 | **193 (100%)** | 0 | ✅ piezas (corregido a mano) |
| `etiquetera` | 532 | **532 (100%)** | 0 | ✅ piezas |
| `factor_sale` (sin sesgo, sin override) | 336 | 168 (50%) | 128 (38%) | ⚠️ **AMBIGUO por SKU** |

Y donde existen **ambos** `override` y `factor_sale` (199 casos):

| | |
|---|---|
| `override / factor_sale = c81` exacto | **197 de 199 (99%)** |
| `override > factor_sale` | 197 |
| Razón promedio | 10.2 |

Los casos hablan solos:

| SKU | nombre | `override` | `factor_sale` | razón | `c81` | `c84` |
|---|---|---|---|---|---|---|
| 95784 | ENCENDEDOR GALAXY MAX **/ 25** | 1000 | 40 | **25** | 25 | 1000 |
| 02693 | CLORETS 5S TIPO AMERICANO **/20** | 960 | 48 | **20** | 20 | 960 |
| 88031 | CH WRIGLEY DOUBLEMINT **/20** | 800 | 40 | **20** | 20 | 800 |
| 08057 | NESTLE CARLOS V SUIZO **16P** | 448 | 28 | **16** | 16 | 448 |

**Lectura:** tres de las cuatro fuentes cuentan **piezas por caja** y son consistentes.
`factor_sale` **no tiene una unidad**: la mitad cuenta piezas, un tercio cuenta paquetes, y nada
los distingue. Medido sin sesgo (excluyendo los SKUs que ya tienen override, que son
precisamente donde alguien detectó el problema y lo corrigió).

Los 199 casos con `override` muestran el patrón que llevó a la corrección manual —
`override / factor_sale = c81` exacto en 197 — pero **no se puede generalizar a una conversión**:
de los 905 SKUs que hoy resuelven por `factor_sale`, **815 ni siquiera existen en Kepler** y sólo
58 tienen `c81`. No se puede convertir: sólo se puede declarar.

Dicho de otro modo: **esos 199 `override` existen porque alguien detectó que `factor_sale`
contaba en otra unidad y lo corrigió a mano.** El resolvedor los apila en una sola columna
`box_factor` cuyo significado depende de qué fuente ganó.

> Es el mismo patrón de `cost_base` — un número correcto en una unidad que el consumidor no
> conoce — **dentro de la herramienta construida para evitarlo.**

---

## 5. El 40% de la venta resuelve su caja sin ancla

| Fuente que gana | SKUs | Con `c84` para contrastar | Venta 365d |
|---|---|---|---|
| `kepler_c84` | 2,046 | **2,046 (100%)** | $286,014,927 |
| `etiquetera` | 5,690 | **0** | $243,707,081 |
| `factor_sale` | 905 | **0** | $12,140,071 |
| `override` | 262 | 213 | $61,444,471 |

La precedencia cae a etiquetera o `factor_sale` **precisamente cuando Kepler no declara caja**
(`c84` existe sólo en 2,419 de ~9,500 SKUs = 25%). Por construcción, esos casos **no tienen
contra qué verificarse**: son $255.8M de venta (40%) donde el factor de caja es una afirmación
sin testigo.

No es que esté mal — es que **no hay forma de saberlo**, y el resolvedor no lo distingue.

Dato bueno: `c84` es **estable entre sucursales** — de 2,419 SKUs, sólo **3 (0.12%)** tienen
valores distintos entre ramas. Cuando existe, se le puede creer.

---

## 6. La prueba del dinero: en qué unidad está el fact

El precio es el único signal que no depende de cómo se llame la unidad. Comparando el precio
realmente cobrado (`revenue/units` de `sales_daily`) contra la escalera `c90`/`c91`/`c92`:

| Razón `precio_real / c90` | SKUs | Venta | % venta |
|---|---|---|---|
| < 0.5× | 90 | $5.8M | 0.9% |
| **0.5–2× (misma unidad que la base)** | **6,395** | **$544.5M** | **85.6%** |
| 2–20× | 406 | $85.5M | 13.5% |
| > 20× | 6 | $35k | 0.0% |

**Conclusión: `analytics.sales_daily.units` está en la unidad BASE del ERP para el 85.6% de la
venta.** Eso valida la decisión de MR.5.9 de derivar el margen unitario del fact.

⚠️ **El 13.5% NO se puede concluir que sea un problema de unidad.** `c90` sólo coincide con lo
cobrado en ~58% de los casos (ver [[reference_kepler_price_model]]): es respaldo, no verdad. La
razón observada tampoco coincide con `c81` (KINDER DELICE razón 3.3 contra `c81`=10; CLORETS 4.7
contra 20), así que la explicación más probable es **precio de lista desactualizado**, no unidad
equivocada. **No usar esta prueba para "corregir" unidades.**

---

## 7. Reglas que salen de esto

1. **`catalog.products.unit_sale` no rotula nada.** Discrepa con el ERP en 73.6%. Para decir en qué unidad está un número, usar `analytics.sales_daily.unit_kind` (`piece` / `weight`) y no ir más fino.
2. **`v_product_box_factor.box_factor` sigue siendo el resolvedor canónico**, pero **su unidad depende de `source`**: `kepler_c84` y `override` son piezas/caja; `factor_sale` es paquetes/caja; la etiquetera no se puede verificar. **Leer siempre `source` junto al factor.**
3. **Nunca publicar una equivalencia por caja sobre producto de peso.** En granel `c84` son kilos por bulto e `is_master_suspect` **no los marca** (§8).
4. **Un factor sin ancla no es un factor verificado.** Si `source ≠ kepler_c84`, el número es una afirmación sin testigo: se puede usar, no se puede garantizar.
5. **El precio es el árbitro de la unidad, no el nombre del campo** — pero sólo cuando el precio de referencia es confiable. `c90` no lo es.
6. **Tratar `500`, `250`, `400`, `2KG`, `IND` como unidad desconocida**, no como texto válido.
7. **Al cruzar dos tablas, verificar que ambas cuenten la misma cosa antes de multiplicar.** Los tres bugs de esta sesión fueron multiplicaciones entre columnas de universos distintos.
8. **La unidad de una columna NO se hereda de su fuente.** Cada tabla derivada puede normalizar una columna y no la otra, y el nombre no avisa (`replenishment_plan.stock_pz` dice "pz" y trae paquetes). Probar la unidad **en la tabla que el consumidor lee de verdad**, no en el crudo. Cuando dos fuentes disputan la unidad, llevar **el cálculo** al peldaño más grande (la caja) — es el único que los dos ERPs declaran. Ver §8ter.
9. **Antes de creerle a un comentario sobre el peldaño de un costo, medirlo contra la escalera del ERP.** Si las razones se agrupan en **tasas de impuesto** (1.00 / 1.08 / 1.16 / 1.24) el costo está en el peldaño base; si se agrupan en **factores de empaque** está en el bulto. Un factor de unidad no vale 1.08. Ver §8quater — cuatro archivos del repo lo declaraban distinto y siete multiplicaciones dependían de la respuesta.
10. **Resolver el peldaño del costo no resuelve el de la cantidad.** Son dos auditorías: el costo se arbitra con la escalera del ERP; la cantidad, con **lo que se pagó** (`real_buy_cost` en Kepler, `costo_promedio` en Wincaja) — `display_bf == caja_cost / pagado`. Ver §8quater consecuencia 4.

---

## 8. Defectos concretos, accionables

| # | Defecto | Tamaño | Dueño |
|---|---|---|---|
| 1 | **`is_master_suspect` no marca granel**: 201 SKUs de peso con `box_factor > 1` y **cero** marcas — 130 vía `kepler_c84`, encabezados por las bolsas ALTOS 1KG (factor 20) | **$49.3M de venta** | Datos / Compras |
| 2 | `unit_sale` discrepa con `c11` | 6,533 SKUs (73.6%) | Datos |
| 3 | El factor de caja no dice en qué unidad está | 8,903 SKUs | Datos |
| 4 | Factores imposibles: `99997 ETIQUETAS` = **16,500**; `45205 RAQUETA` = 1,200 | 2 SKUs > 1,000 | Datos |
| 5 | 143 SKUs marcados `PZA` en catálogo que Kepler vende por `KG` | 143 | Datos |
| 6 | `analytics.sales_daily.units_base` está **100% en NULL** — columna muerta que aparenta ser la normalización | toda la tabla | Plataforma |
| 7 | Unidades que son cantidades (`500`, `250`, `400`, `2KG`) | ~120 SKUs | Datos |

### Estado tras [UM.1] (migración `20260829190000`)

| # | Estado |
|---|---|
| 1 | ✅ **Resuelto en la vista** — `is_master_suspect` ahora marca granel (145 SKUs, $45.7M) |
| 3 | ✅ **Resuelto** — nueva columna `factor_unit` (`pieces` / `ambiguous` / `n/a`) |
| 4 | ✅ **Resuelto** — factores >1000 marcados sospechosos (2 SKUs) |
| 2, 5, 7 | 🟡 **Mitigado** — la vista expone `unit_base` (la unidad REAL del ERP, con la basura anulada) para que nadie tenga que leer `unit_sale`. El dato del catálogo sigue mal: repuntarlo desde `kdii.c11` es un backfill aparte |
| 6 | ⬜ Abierto — `sales_daily.units_base` sigue 100% en NULL |

**Bonus encontrado al migrar:** `is_master_suspect` devolvía **NULL** (no `false`) para todo
producto sin `c84`, que es la mayoría. Un `WHERE NOT is_master_suspect` los descartaba en
silencio y un `WHERE is_master_suspect` tampoco los traía: caían en el limbo de la lógica de
tres valores. Ahora es un booleano de verdad (`COALESCE(..., FALSE)`).

**Impacto medido en prod:** 1,020 SKUs pasan a marcados (11.5% de los 8,903 con factor) —
145 granel ($45.7M) · 873 `factor_sale` ($8.4M) · 2 imposibles. `box_factor` y `source` **no
cambian**: cero impacto para quien ya los lee. Los dos dependientes de la vista
(`analytics.erp_sales_invoice_lines` — la que imprime la equivalencia en el **documento que se
le entrega al cliente** — y `analytics.v_sales_demand_truth`) heredan la corrección.

---

## 8bis. El rótulo esconde la mezcla *dentro de sí mismo* (RR-PROMO.1, 2026-09-02)

Medido sobre la venta de ruta (ago-2026) al normalizar el incentivo de `/comercial/ventas-por-ruta`.
Agrupar por rótulo **subestima** el problema: de los 709 SKUs que aparecen con más de una
etiqueta, 688 ($2.96M, 94.9%) tienen el mismo precio unitario entre etiquetas — o sea la
cantidad ya era homogénea y sólo el rótulo mentía. Parecía un problema chico.

No lo es, porque **un mismo rótulo trae los dos peldaños**:

| SKU | rótulo | líneas | precio | qué es |
|---|---|---|---|---|
| 70031 | `PZA` | 361 | $6.12 | pieza |
| 70031 | `PZA` | **45** | **$90.96** | **paquete de 16** |
| 70031 | `PAQ` | 4 | $101.11 | paquete de 16 |

Efecto real sobre la cantidad, con el peldaño resuelto por precio:

| | |
|---|---|
| Suma cruda de `qty` | 223,394 |
| Cantidad real (peldaño resuelto) | **243,626** |
| Subconteo | **9.1%** |
| SKUs con error > 5% | **140 · $1,110,809 · 19.0% de la venta de ruta** |
| Peores | `97245` 42% · `97244` 43% · `88045` **84%** |

**El resolvedor: `analytics.v_product_unit_ladder`** (mig `20260902180000`) — vista
`derive-no-copy` **sólo sobre `kepler_ods.kdii`**, una fila por SKU con los rótulos
(`c11`/`c80`/`c83`), los factores en unidades **base** (`c81`/`c84`) y los precios de cada
peldaño (`c90`/`c91`/`c92`), más `unit_base` (basura anulada), `unit_base_raw` e `is_weight`.

**Cómo se usa:** el peldaño de una línea se identifica por su **precio realmente cobrado**,
eligiendo el más cercano en log-espacio y **sólo dentro de la banda 0.5×–2×** (la misma de §6).
Funciona porque los peldaños distan ≥ el factor (≥2×), mucho más que cualquier descuento.
Fuera de banda **no se adivina**: la línea se declara sin resolver y no se suma (medido:
0.17% de las líneas / 0.11% del importe). Cobertura de la escalera de precio: **100.0%** de la
venta de ruta.

⚠️ **`c84` cuenta unidades BASE, no piezas.** Para `97192` la base es `PAQ`, así que `c84 = 24`
son *paquetes* por caja (idéntico en las 7 sucursales). Cualquier cifra normalizada tiene que
viajar con su rótulo; llamarle "piezas" es el error que esta vista existe para evitar.

**Por qué NO se reusó `v_product_box_factor` acá:** resuelve el factor de **caja**, no el
peldaño de una línea de venta, y de sus cuatro fuentes de precedencia sólo `c84` sale del ODS
— `analytics.product_box_factor` es tabla (`relkind='r'`) alimentada por `import-box-factor.js`,
más `catalog.products.factor_sale` y la etiquetera. Incumple la regla principal del proyecto
(cero importers · del ODS · una tabla principal · documentada y verificada). Los dos conviven
por ahora; unificarlos es trabajo aparte y arrastra dos vistas dependientes.

Candados: `database/tests/test-newdb-route-promo-units.js` (en la regresión).

---

## 8ter. Wincaja contra Kepler: la unidad no se hereda entre capas (ADR-055, 2026-09-03)

Los dos ERPs guardan la existencia en unidades distintas — Kepler en su unidad **base**, Wincaja
en su **unidad de venta**, que en multipack es el **paquete**. La capa cruda es auto-consistente
(existencia y venta de Wincaja vienen las dos en paquetes), **pero la derivada no**:

| columna | unidad en MD-30 / MD-32 / 00 |
|---|---|
| `wincaja.v_sales_daily.qty` · `analytics.sales_daily.units` | paquetes |
| `analytics.inventory_health` · `commercial.reorder_policy` | paquetes |
| `analytics.v_erp_stock_on_hand.qty_stock_units` | paquetes (crudo, a propósito) |
| **`analytics.product_demand.daily_pieces`** | ⚠️ **unidad BASE** — normaliza |
| **`analytics.replenishment_plan.stock_pz`** | paquetes (**el nombre miente**) |

`replenishment_plan` restaba demanda-en-base menos existencia-en-paquetes. Medido: **159 de 166**
multipack de MD-30 con venta traen la demanda convertida (razón ≈ `f2`, $1.79M de venta 30 d).
Efecto en `/compras/pedido`: **$866,805 de sobre-pedido** y **$2.68M de inventario que la pantalla
no mostraba**. Sólo **355 SKUs** (sucursal 30) son multipack de verdad — no es el catálogo entero.

**El resolvedor: `analytics.v_warehouse_box_factor`** (mig `20260902220000`) — vista con una fila por
(tenant, almacén, producto) cuyo `box_factor` son las **unidades nativas de ESE almacén por caja**.
Kepler resuelve por `v_product_box_factor`; Wincaja por `wincaja.articulos.factor_venta`, que está
definido como *"cuántas de MIS unidades de venta hacen una caja"* — sirve venda piezas o paquetes,
sin clasificar el SKU. ⚠️ `source_dataset='actual'` es obligatorio (la tabla guarda también
`'concentrada'`; sin el filtro el `SUM` duplica).

**Por qué se le puede creer a `factor_venta`** — tres testigos, y el tercero es el que decide:
1. **Dinero crudo:** precio realmente cobrado (`wincaja.v_sales_daily`) × `factor_venta` cae a ±11%
   del precio de caja del ODS (`p3`). `42029` $115.54×14=$1,617 vs $1,701.
2. **La escalera del ODS:** `fv = f3/f2` en 355 SKUs (venden paquete) y `fv = f3` en 1,818 (venden
   la base). Las dos formas son coherentes con la definición.
3. **Concordancia donde NO debe haber diferencia:** en las 5,475 filas de los casos "sin escalera" y
   "misma unidad", `factor_venta` y `box_factor` dan el mismo valuado con Δ < 0.1% ($9,573 y −$140).
   Divergen sólo en los 348 multipack (+$2.63M). *Dos fuentes independientes que coinciden donde
   deben y difieren donde debe: eso es lo que autoriza a usar una.*

⛔ **Es un divisor de PRESENTACIÓN; el dato base no se convierte.** Se intentó (mig
`20260902200000`, revertida el mismo día): `inventory_health`/`reorder_policy` salen de
`sales_daily`, que está en la unidad nativa, así que convertir sólo la existencia la dejó `f2` veces
más grande que sus propios umbrales → cobertura de 534–900 días y el motor dejó de pedir.

**Regla nueva (§7.8):** la unidad de una columna **no se hereda de su fuente**. Cada tabla derivada
puede normalizar una columna y no la otra, y el nombre no avisa. Probar la unidad **en la tabla que
el consumidor lee**, con el precio realizado contra `v_product_unit_ladder.p1/p2/p3`. Y cuando dos
fuentes disputan la unidad, llevar **el cálculo** al peldaño más grande (la caja) es más seguro que
convertir un lado: es la única unidad que los dos ERPs declaran.

Candado: `database/tests/test-newdb-warehouse-box-factor.js` (29 aserciones, en la regresión).

---

## 8quater. ¿En qué peldaño está `cost_with_tax`? (U.0, 2026-09-03)

Cuatro archivos del repo lo declaraban distinto, y **siete multiplicaciones cantidad × costo dependían
de la respuesta**:

| archivo | decía |
|---|---|
| `commercial-replenishment.service.ts` | *"costo vivo **por PIEZA** desde `kdik.c16`"* |
| `replenishment-scanner.service.ts` | *"`cost_with_tax` (**por PIEZA**)"* |
| `import-demand-clean.js` | *"`cost_with_tax` es costo **por CAJA** (bruto)"* |
| `import-sales-units-base.js` | usaba `cost_with_tax / √factor_sale` — el punto medio geométrico, **porque no sabía cuál era** |

### La respuesta: peldaño BASE, bruto de impuesto

Medido contra la escalera de costo del ERP (`analytics.v_supplier_cost_ladder`), la razón
`cost_with_tax / u1_cost` **se agrupa en múltiplos de impuesto exactos a cuatro decimales**, no en
factores de unidad:

| razón | SKUs | qué es | venta 90d |
|---|---|---|---|
| **1.0000** | 960 | exento | $9,568,411 |
| **1.0800** | 1,886 | IVA 8% (frontera/alimentos) | **$69,310,729** |
| **1.1600** | 1,507 | IVA 16% | $8,835,516 |
| **1.2400** | 1,987 | IVA 16% + IEPS 8% | $29,843,306 |
| 1.1264 · 1.0416 | 1,091 | otras combinaciones de tasa | $10,864,860 |
| **3.4720** | **110** | ⚠ **sospechoso de PELDAÑO, no de impuesto** | $493,475 |
| 0.9341 | 370 | ⚠ `cwt` **por debajo** del costo suelto de la escalera | $1,985,754 |

La razón contra `box_cost` es **0.058**. Conclusión:

> **`cost_with_tax` = `u1_cost × (1 + impuesto)`.** Está en el peldaño **base/suelto**, bruto de
> impuesto. `commercial-replenishment` y `replenishment-scanner` tenían razón; `import-demand-clean`
> estaba equivocado.

**Por qué este testigo cierra el caso:** un factor de unidad no vale 1.08. Que las medianas caigan
en las tasas fiscales de México **exactas a cuatro decimales** —y que la razón contra el bulto sea
0.058— no admite la lectura de "es costo de caja". Es el mismo criterio de §7.5 (el precio es el
árbitro), aplicado al costo.

### Consecuencias registradas

1. **`import-demand-clean.js` divide el piso de costo por `fs` sobre una premisa falsa.** Con `cwt` ya
   en peldaño base, `cwt/fs` deja el piso `fs` veces más bajo → `min(rev/u)` gana más seguido →
   `piece_price` puede quedarse en un precio sub-unidad → **`daily_pieces` sale inflado**, que es justo
   lo que el piso existe para evitar. **No se corrigió**: `daily_pieces` es el numerador de todo
   `/compras/pedido` y su peldaño ya flota con el mix de precios de la red. Estabilizarlo es
   **MR.7.1 (persistir el peldaño)**.
2. **`import-sales-units-base.js` queda marcado como código muerto**: su `√factor_sale` promediaba
   una ambigüedad que ya no existe, y su columna destino (`sales_daily.units_base`) está 100% en NULL
   (defecto #6 de §8, abierto).
3. **110 SKUs con razón 3.47 y 370 con razón 0.93 sí son sospechosos de peldaño** — no de impuesto.
   Van a la bandeja de `peldano_cruzado`, no al `COALESCE` de `costUnit()`.
4. **Esto resuelve el peldaño del COSTO, no el de la CANTIDAD que lo multiplica.** Sigue sin declarar
   en 47 sitios; es lo que audita `analytics.v_unit_rung_audit`.

---

## 9. Lo que NO se investigó

- **Unidad de los SKUs sólo-Wincaja**: 4,925 artículos de la sucursal 30 no existen en la escalera del ODS, así que su `factor_venta` no tiene contra qué contrastarse (mismo problema del §5: factor sin ancla).
- **Unidades de compra** (`unit_purchase` / `factor_purchase` / `erp_purchase_doc_lines.unidades_por_caja`): la línea de OC tiene su propia regla ([[reference_kepler_oc_line_units]]) y no entró en esta pasada.
- **`catalog.product_barcodes.factor`**: un SKU tiene N códigos de barras, uno por unidad. No se contrastó contra la escalera.

---

## Referencias

- [`GOTCHAS.md`](GOTCHAS.md) · [diccionario del margen](IMPLEMENTACION/FASES/FASE_MR_DICCIONARIO_MARGEN.md) · **ADR-051**
- `analytics.v_product_box_factor` (mig `20260804160000`, RA-PRO.38) — el resolvedor
- `kepler_ods.kdii` — `c11`/`c80`+`c81`/`c83`+`c84` (escalera) · `c90`/`c91`/`c92` (precios)
- `services/feeds-ingest/unit-normalization.js` — `toCanonicalPriced`, la normalización money-anchored de la venta
