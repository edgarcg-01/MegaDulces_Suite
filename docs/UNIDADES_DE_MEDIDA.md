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
| `commercial.product_label_prices.box_size` (etiquetera) | 7,846 | ~~❌~~ → **✅ SÍ** (§8sexies) |
| `commercial.product_unit_overrides.box_factor` (manual) | 295 | ✅ parcial — **y es la que más falla** (§8sexies) |
| `analytics.wincaja_product_box_factor.factor_venta` | 185 | — |
| `commercial.supplier_item_aliases.box_factor` | 0 | — |
| `kepler_ods.kdii.c84` | 2,419 | ✅ (es el ancla) |
| `catalog.product_barcodes.factor` | — | — |
| `analytics.v_product_box_factor` (resolvedor de factor) | 8,903 | resuelve entre las anteriores |
| **`analytics.v_unit_truth`** (**el resolvedor, con veredicto y método**) | 100,908 celdas | **declara si se puede o no** (§8sexies) |

> ⚠️ **La columna de la derecha estaba mal en dos filas y se corrigió el 2026-09-07.** La
> etiquetera **sí** tiene un testigo independiente (lo que se le pagó al proveedor) y coincide con
> él en **99.84%**; el override manual es la peor de todas, con 22% de contradicción. Ver §8sexies.

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
(`c84` existe sólo en 2,419 de ~9,500 SKUs = 25%).

> ⛔ **ESTE PÁRRAFO ESTABA MAL Y SE CORRIGIÓ EL 2026-09-07.** Decía: *"esos casos **no tienen
> contra qué verificarse**: son $255.8M de venta (40%) donde el factor de caja es una afirmación
> sin testigo. No es que esté mal — es que **no hay forma de saberlo**"*.
>
> **Sí había forma, y nadie la había buscado.** El segundo testigo es
> `analytics.v_supplier_cost_ladder.units_per_box` = `box_cost / u1_cost`, derivado de
> `kepler_ods.kdpv_prov_prod` — **lo que se le pagó al proveedor**. No toca la etiquetera ni el
> catálogo, así que no es circular. Contrastadas, **la etiquetera coincide con lo pagado en 5,569
> de 5,578 SKUs (99.84%, razón mediana 1.00)**. La cobertura verificable de la venta pasa de 44.8%
> a **93.1%**. Ver §8sexies.
>
> La lección de método, que es más valiosa que el dato: **"no se puede verificar" era una
> conclusión sobre las fuentes que ya estábamos mirando, escrita como si fuera una propiedad del
> problema.** Antes de declarar algo inverificable hay que preguntarse qué OTRA cosa dejó rastro —
> acá, el dinero que salió por esa mercancía.

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
11. **Una cantidad con precio se puede convertir; una cantidad pelona, no.** La venta se normaliza sola porque el ingreso delata la unidad ($371.86 no puede ser un paquete de $45.42); la existencia es un conteo sin nada que la delate. Para auditar una cantidad hay que **prestarle un precio**. Corolario incómodo: **la venta no está verificada, está sin árbitro** — no tiene con qué probarse, y por eso nunca se marca. Ver §8quinquies.
12. **Retener el número que se ve no basta: el mismo error también BORRA renglones.** Con el divisor inflado la sucursal se lee abastecida, el déficit da 0 y la fila nunca entra al plan — no hay cifra que marcar. Hay que contar las ausencias aparte (window ANTES del filtro) y declararlas. Medido: 19 traspasos invisibles contra 156 marcados.
13. **Si un dato derivado alimenta pantallas, la copia al fact necesita candado propio.** El veredicto vive en una vista auditable de 8-25 s y se copia al fact para que los lectores no paguen. Si el importer deja de copiarla, **todo pasa a "medible" y la mentira vuelve en silencio**: un no-op se lee igual que "no hay nada marcado". El test exige que el fact tenga veredictos y coincida con la vista.
14. **⭐ "No se puede verificar" casi nunca es una propiedad del problema: es una conclusión sobre las fuentes que ya estabas mirando.** Antes de declarar algo inverificable, preguntá qué OTRA cosa dejó rastro. La etiquetera estuvo cuatro meses marcada con ❌ y su testigo era el dinero que salió por esa mercancía (`v_supplier_cost_ladder.units_per_box`): coincide en 99.84%. Ver §8sexies.
15. **⭐ No elijas entre dos testigos: ORDENALOS, y declará dónde no llega ninguno.** El precio de caja es inmune a la unidad del numerador y cubre 87.8% de la venta; el divisor verificado cubre otra parte; el resto **se declara NULL con motivo**. Un solo divisor no puede ganar: en 296 SKUs ($78.3M) ninguno acierta contra el árbitro de dinero, porque el numerador mismo mezcla peldaños. Ver `analytics.v_unit_truth.metodo_cajas`.
16. **⭐ "No hay factor de caja" y "no sé convertir a cajas" son cosas distintas.** Confundirlas cambia una cifra buena por un hueco: tratar `no_aplica` como ignorancia tiraba el total del sell-out **−33.6%**, y el 95% de esa caída eran productos cuya unidad de venta ES la más grande (una cubeta de 20 kg, una caja de botanas). El error simétrico es igual de caro que el original.
17. **⭐ Cuando un `CASE` mezcla dos preguntas, la precedencia le miente a una de las dos** — y le miente al caso más común o más caro. Pasó **tres veces** en una sola fase: `nunca_entro` marcaba 1,913 celdas sanas, el factor 1 archivaba $5.1M como "nada que verificar", y el `motivo` de cobertura etiquetaba $300.6M de sucursales sanas como "ERP mixto". Si un `WHEN` parece una tautología inofensiva, medilo antes de creerle.
18. **Una fila AUSENTE se lee peor que una fila mala.** En un LEFT JOIN llega NULL y un `COALESCE(medible, true)` la cuenta como sana. Por eso la cobertura necesita su propia vista que enumere lo que NO está (`v_unit_truth_coverage`): 13 almacenes con el 9.4% de la venta no tenían fila y el candado reportaba 98.2% de cobertura.

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

## 8quinquies. Por qué la VENTA sí se convierte a cajas y la EXISTENCIA no (U.2b, 2026-09-03)

La pregunta salió del piso: *"si podemos sacar la venta en cajas, ¿cómo es posible que no saquemos
la existencia? ¿qué cambia?"*. Es la pregunta correcta y la respuesta desarma la intuición.

**No cambia el divisor: cambia la unidad del numerador.** `99089 SALSA VALENTINA SOBRE 10G /900`
en los 9 almacenes usa el mismo divisor `9.00`. Funciona en los 7 de Kepler y falla sólo en MD-30.

| | de dónde sale | ¿trae su unidad pegada? |
|---|---|---|
| **Venta** | `analytics.product_demand.daily_pieces` = **ingreso ÷ precio unitario mínimo de la red** | **Sí.** El dinero la delata |
| **Existencia** | `replenishment_plan.stock_pz`, **crudo de cada ERP** | **No.** Es un conteo pelón |

La prueba, mismo SKU y mismos 30 días: las sucursales Kepler venden a **$45.42/unidad** (el paquete)
y MD-30 a **$371.86/unidad** (la caja) — 8.19×. El importer divide el ingreso de MD-30
($3,347) entre el precio mínimo de la red ($45.42) → 73.7 paquetes → ÷9 = **8.2 cajas**, y MD-30
vendió 9. Da bien **porque un renglón de $371.86 no puede ser un paquete de $45**.

La existencia no tiene esa suerte: `stock_pz = 12` y nada en ese 12 dice si son sobres, paquetes o
cajas. Por eso hay que **prestarle un precio** — y eso es exactamente lo que hace el detector: le
pega el **costo que se pagó** por esa unidad. `display_bf == caja_cost / pagado`.

> ⚠️ **Que la venta se convierta NO quiere decir que esté verificada.** No tiene árbitro
> independiente: nadie persiste el peldaño realmente cobrado, así que su unidad flota con el mix de
> precios de la red y **nunca se marca**. Ausencia de bandera no es certificado — es que no hay con
> qué probarla. Eso es **MR.7.1**, no esto.

### Triage de los 552 marcados (insumo de U.3)

| | celdas | SKUs | valor del árbitro |
|---|---|---|---|
| **lo pagado ES el costo de la caja** → divisor = 1, sin discusión | **93** | 49 | $657,237 |
| divisor entero limpio | 183 | 90 | $1,159,393 |
| desviación chica | 103 | 36 | $466,741 |
| **pide criterio humano** | 265 | 157 | $1,475,813 |

Un tercio es mecánico. El resto **no**, y por eso U.3 es bandeja y no script: en `57009` el divisor
1 era el correcto y "corregir parejo" proponía **$2.59 M** de compra contra $132 k/mes de venta.

---

## 8sexies. El resolvedor con VEREDICTO y MÉTODO (U.4–U.7, 2026-09-07 · ADR-057)

Nace de *"las capas lógicas están fallando demasiado; necesito una verdad absoluta en unidades de
venta"*. Lo primero que salió al medir fue el tamaño del desorden: **27 archivos** leen
`catalog.products.factor_sale` (la única fuente probada **sin** unidad), **17** leen
`product_label_prices.box_size`, y **UNO** lee la escalera anclada al ERP. La unidad no se resolvía
una vez: se re-derivaba en cada piso, con una precedencia propia.

### El testigo que faltaba: lo que se PAGÓ

`analytics.v_supplier_cost_ladder.units_per_box` = `box_cost / u1_cost`, sobre
`kepler_ods.kdpv_prov_prod`. Es independiente de la etiquetera y del catálogo — es dinero contra
etiqueta. Contrastando cada fuente contra él:

| fuente | SKUs | con testigo | coincide | **contradice** | venta que contradice |
|---|---|---|---|---|---|
| **etiquetera** | 5,679 | 5,578 | **5,569 (99.84%)** | 9 | $104,507 |
| `kepler_c84` | 2,084 | 2,083 | 2,082 | 1 | $49,870 |
| `default` | 2,266 | 846 | 846 | 0 | — |
| `factor_sale` | 905 | 148 | 118 | 30 | $614,807 |
| **`override` (manual)** | 278 | 277 | 215 | **62 (22%)** | **$6,174,488** |

⚠️ **Se da vuelta la sospecha: la fuente peor es la corrección MANUAL.** Y la forma delata el
patrón — `70006`, `70043`, `20555` y `70140` traen `override = 1` contra 18, 12, 18 y 18 pagados.
Son los de granel, y `20555 CAR SURTIDO 18KG` es el SKU que destapó la auditoría de peldaño (U.1).
Van a bandeja (`disputa_granel`), **no se corrigen parejo**: en granel el 1 puede ser deliberado
(el stock va en kilos) y corregir parejo es lo que propuso $2.59M de compra en `57009`.

### `analytics.v_unit_truth` — grano (tenant, almacén, producto)

No reimplementa la precedencia: la **lee** de `v_warehouse_box_factor` (ADR-055) y
`v_product_box_factor` (UM.1). `box_factor` es idéntico al que ya se publica — **100,908 filas,
0 discrepancias** — y eso es lo que autoriza a migrarle consumidores sin revalidar cada pantalla.

**Eje 1 · `veredicto`** sobre `base_per_box` (propiedad del EMPAQUE, no del almacén):
`verificado` (93.1% de la venta) › `no_aplica` › `sin_testigo` › `en_disputa` › `disputa_granel`.

**Eje 2 · `veredicto_nativo`** audita ADR-055: `base_per_box / box_factor` debe dar 1 (el almacén
vende la base) o `f2` (vende paquete). **24,795 celdas dan 1 y 1,085 dan `f2` exacto (mediana
10.000) = 99.5%.** Las 128 restantes (**45 SKUs**) traen `factor_venta = f2` en vez de `f3/f2` → el
divisor les queda **4–40× chico**. Ése es el defecto vivo de ADR-055 y ahora tiene nombre
(`no_explicado`).

⛔ **No confundir los ejes.** Comparar el divisor NATIVO de Wincaja contra `units_per_box` (que
cuenta base) marca los 355 multipack legítimos como falsos positivos: la primera versión del
chequeo hizo eso y daba 16,897 celdas "mal".

### `metodo_cajas` — ordenar los testigos, no elegir uno

Migrar los consumidores al divisor **no los dejaba bien**, y se probó con dinero antes de tocarlos.
`cajas = revenue ÷ cja_price` no depende de ningún divisor, así que sirve de árbitro. Sobre los 570
SKUs donde las fórmulas privadas y el resolvedor discrepan: `factor_sale` sobra **3.286×**, el
resolvedor falta **0.369×**, y en **296 SKUs ($78.3M) no acierta NINGUNO**.

La razón: ahí el numerador **no tiene unidad**. `42029` en el almacén `01` promedia $71.07/unidad —
ni la pieza de $12.46 (almacenes `02`/`03`) ni el paquete de $115.25 (MD-30). El mismo almacén
mezcla los dos peldaños.

⭐ **Pero medido sobre toda la población y no el subconjunto adversarial, el resolvedor es bueno
donde dice serlo:** con `medible = true` el divisor verificado y el dinero coinciden con razón
mediana **0.997**, 38,713 de 40,853 celdas dentro de ±25%, **$547,152,677**. La bandera separa
bien, así que no hay que elegir entre los testigos — hay que **ordenarlos**:

| método | qué hace | venta |
|---|---|---|
| `dinero` | ingreso ÷ precio de caja — **inmune a la unidad del numerador** | 87.8% |
| `peso` | granel: la cantidad ya está en kilos | 2.8% |
| `divisor` | ÷ `box_factor`, **sólo con el factor verificado** | 1.1% |
| `unidad_es_caja` | no hay paquete ni caja en la escalera y ningún testigo dice que la haya → cajas = unidades | — |
| `sin_metodo` | **NULL con motivo. No se dibuja.** | 3.1% |

**91.7% de la venta con cifra de cajas defendible**; el 8.4% restante declarado.

### Los dos errores propios que la medición atrapó, y valen como patrón

1. **El factor 1 archivado como "nada que verificar".** `base_per_box <= 1 → no_aplica` cortaba
   ANTES de mirar al testigo, así que **13 SKUs / $5,135,134** que declaran "no hay caja" contra
   DOS testigos coincidiendo en 18/12/5/10/20/24/25/27/40 quedaban invisibles.
2. **`no_aplica` tratado como ignorancia.** Mandarlo a `sin_metodo` tiraba el total del sell-out de
   **602,049 a 399,494 cajas (−33.6%)**. Verificado contra la escalera: 240 de 278 SKUs cobran
   dentro de banda de `p1` y **no tienen `f2` ni `f3`** — `57009 COBERTURA 20K LUSSEL CUBETA` a
   $1,453.25 contra $1,500.08; `87234 BOT SABRISURTIDO / 35` con **`unit_base = CJA`**. Para esos,
   `cajas = unidades` es la respuesta CORRECTA.

> ⭐ **El patrón, que apareció TRES veces en esta fase** (`nunca_entro` en el dictamen de
> existencia, el factor 1, y el `motivo` de la vista de cobertura): **cuando un CASE mezcla dos
> preguntas, la precedencia siempre le miente a una de las dos** — y le miente justo al caso más
> común o más caro. La condición que "parece una tautología inofensiva" es la que hay que medir.
>
> ⭐ Y el corolario del punto 2: **"no hay factor de caja" y "no sé convertir a cajas" son cosas
> distintas.** Confundirlas es el error simétrico del que persigue esta fase: cambia una cifra
> buena por un hueco.

### Cobertura: lo que falta se declara

`v_unit_truth` sólo arma filas para almacenes con `kepler_code` o `wincaja_source_branch`. Los 13
`RUTA-*` no traían ninguno → **$60,148,173 (9.4%) sin fila**. Y una fila ausente se lee **peor** que
una mala: en un LEFT JOIN llega NULL y un `COALESCE(medible, true)` la cuenta como medible — el
candado de U.4 reportaba 98.2% por eso, agrupando sólo por producto.

No faltaba el dato, faltaba el **mapeo**: `wincaja.articulos` tiene las 13 sucursales de ruta con
~15,330 artículos cada una. Se mapearon **7**; las 6 de La Piedad **no**, porque cambiaron de ERP
(Wincaja hasta 2026-06-26, Kepler desde 2026-06-29) y **su divisor depende de la fecha**. El precio
realizado lo confirma: las 6 son 87–95% peldaño BASE, las 7 de Wincaja traen 19–31% en PAQUETE.
Cobertura final **94.8%**, y el 5.2% declarado en `analytics.v_unit_truth_coverage`.

Efecto colateral medido antes de aplicar: aparecen **+$233,726** de inventario (7,528 unidades en
7 camionetas que dejaron de vender entre el 1-jun y el 12-ago). No es ruido — es un hallazgo para
Almacén.

### El peldaño cobrado, persistido (U.5)

`import-sales-fact.js:150` ya identificaba el peldaño por precio y lo **tiraba**:
`if (!conv.ok) unconv++` mandaba el veredicto a un `console.log`. Tres columnas aditivas en
`analytics.sales_daily`: `rung_factor`, `rung_mixed`, `units_unresolved`.

⚠️ Precisión medida: la mezcla de peldaños vive **ENTRE CELDAS** (mismo SKU en dos almacenes: 311
SKUs / $17.4M = 12.8% de la venta 90d), **no dentro de una fila** — el dry-run sobre 695,127 filas
de origen dio cero mezcladas. `rung_mixed` nace como **candado**, no como hallazgo. Y a grano SKU
sin almacén el no-base baja de 7.2% a 0.7%: **el grano grueso lo escondía 8×**.

⚠️ **`unit-normalization.js:60-61` sigue con el defecto declarado y NO corregido**: `packF` y `boxF`
caen los DOS a `factor_sale`. Cuando colapsan al mismo número, `pickPriceTier` elige entre dos
factores idénticos. Cambiarlo mueve `sales_daily.units` en silencio para miles de SKUs, así que va
aparte, con baseline propio.

### Reglas de operación que salieron

- **Después de CADA `CREATE OR REPLACE VIEW` sobre una vista con RLS, re-aplicar
  `security_invoker` y el `GRANT` — no se heredan.** Una migración de U.7 lo perdió y la vista dejó
  de filtrar por tenant; lo vio **sólo** la aserción de metadata del candado, porque la vista
  seguía devolviendo datos correctos y ninguna prueba funcional lo notaba.
- **`CREATE INDEX CONCURRENTLY` es una trampa en esta base.** Espera a TODAS las transacciones más
  viejas, incluso ajenas: había una consulta de analítica de **1h54m** corriendo, el build se sentó
  575 s en `Lock/virtualxid` y encoló detrás dos `ANALYZE` del propio importer. El remedio de no
  bloquear al importer terminó bloqueándolo. Sin `CONCURRENTLY` entró al instante.

**Candado:** `database/tests/test-newdb-unit-truth.js` (40 aserciones, en la regresión).

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
