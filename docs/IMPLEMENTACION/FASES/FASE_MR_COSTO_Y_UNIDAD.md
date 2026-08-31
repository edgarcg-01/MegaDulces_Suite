# Fase MR — Los dos defectos de raíz: el costo y la unidad

> **Estado:** 🔨 diagnóstico cerrado, corrección sin empezar · **2026-08-31**
> Disparador: Edgar — *"tenemos dos problemas claros que necesitan un análisis. 1. no estamos
> midiendo la unidad de medida (pieza, paq, caja, bulto, kg), así que no podemos saber el margen.
> 2. el margen de ganancia en venta es erróneo."*
>
> Complementa [`FASE_MR_MOTOR_RENTABILIDAD.md`](FASE_MR_MOTOR_RENTABILIDAD.md) (el plan) y
> [`FASE_MR_DICCIONARIO_MARGEN.md`](FASE_MR_DICCIONARIO_MARGEN.md) (MR.0, sin firma).
> Todas las cifras medidas contra **producción**, ventana de 30 días, tenant `mega_dulces`.

---

## 0. La conclusión, primero

Los dos problemas son reales, y **no son paralelos: el de la unidad es requisito del de costo.**

1. **El costo.** `analytics.sales_daily.cost` tiene **dos escritores con métodos incompatibles** y
   nada en la tabla dice cuál escribió cada fila. La mitad Kepler (50.8% de la venta) no lleva un
   costo: lleva un **markup de catálogo despejado de la venta**, así que su margen es álgebra y **no
   puede reaccionar al precio**.
2. **La unidad.** El ETL deduce el peldaño cobrado (por el precio, porque el rótulo del ERP no
   sirve), lo usa para convertir y **no lo persiste**. Aguas abajo una caja de 180 piezas y una pieza
   son la misma fila.
3. **La dependencia.** Todo costo real del ERP está expresado **por unidad de un peldaño**. Para
   costear una venta hay que saber en qué peldaño se cobró — exactamente lo que se descarta. El
   markup actual es el único método **inmune** al problema de unidad porque es adimensional: por eso
   se ve sano y por eso es ciego.

**ADR-051 quedó mal redactado** y se corrige en este ciclo: decía que el costo del fact es "el que
registró el punto de venta". Eso vale sólo para la mitad Wincaja.

---

## 1. Defecto 2 — el costo

### 1.1 Los dos escritores

| | A · canales Kepler | B · canales Wincaja |
|---|---|---|
| Cadena | `md.kdpv_prod_util.c6` → `catalog.products.markup_pct` → `cost = revenue/(1+m)` | `detalles.ValorCosto` → `wincaja.v_sales_daily.costo` |
| Código | `import-sales-fact.js:167` | `services/feeds-ingest/sales-daily-projection.js:69` |
| Qué es | markup % configurado en Kepler, `avg(c6)` por SKU, **de una sola sucursal** (md_03) | el costo que registró la caja en la transacción |
| Venta 30 d | **$20,869,996 (50.8%)** | **$20,094,782 (48.9%)** |
| Canales | `tienda` $16,065,076 · `credito` $4,514,808 | `wincaja_mostrador` $12,585,937 · `wincaja_credito` $5,942,787 · `wincaja_preventa` $1,225,227 · `wincaja_ruta` $728,960 |
| Margen | 10.38% | 12.14% |

`markup_pct`: 9,045 de 14,780 productos (61.2%), promedio 13.47%, rango −0.38% a 129.51%,
1,834 valores distintos.

### 1.2 Por qué el método A no mide nada

Si `cost = revenue/(1+m)`, entonces `margen% = m/(1+m/100)` — función **exclusivamente** del markup.
La venta se cancela. Un descuento baja venta y costo en la misma proporción.

**Prueba directa:** 3,269 SKUs vendidos en ≥2 almacenes de régimen estándar. Razón de precio
promedio 1.054, y **51 SKUs con precios >20% distintos entre almacenes**. Spread de margen:
**0.0000 pp en los 3,269**, hasta el cuarto decimal.

### 1.3 Cuánto se desvía

| Prueba | SKUs | Venta | Estándar | Real | Error |
|---|---|---|---|---|---|
| Predicho vs. real sobre venta de costo real | 3,841 | $20,384,894 | 10.11% | 12.13% | **+2.02 pp** |
| Mismos SKUs en ambos regímenes (controla mezcla) | 3,239 | $19,155,749 | 10.25% | 12.12% | **+1.87 pp** |

El estándar **subdeclara**: $411,220 de margen real no reportado en 30 días (~$5.0 M/año en esa
mitad). Dispersión sobre 2,685 SKUs con >$500: p05 −0.7 · p25 +1.1 · **mediana +2.2** · p75 +3.4 ·
p95 +5.7. Sólo 1,130 (42%) dentro de ±2 pp, 7 fuera de ±10 pp → **sesgo sistemático Y dispersión: no
se corrige con un factor.**

### 1.4 El artefacto en pantalla

Las **once** ubicaciones 100%-estándar caben en **0.67 pp** (9.98%–10.65%). Las de costo real se
abren de verdad: Morelia Madero 14.98%, Rutas 501–505 15.89–16.42%, Morelia Abastos 11.63%,
Canindo (41.5% mixto) 11.16%.

> El «spread por sucursal» que MR.5.10 publicó como hallazgo (Madero 14.96% vs 8ESQ 10.16%) es
> **artefacto del método de costo**, no desempeño. Igual Ruta 21–28 (~10.1%) contra Ruta 501–505
> (~16.2%).

---

## 2. Defecto 1 — la unidad

### 2.1 Lo que el fact guarda

`units` (cantidad) + `unit_kind` ∈ {`piece` 202,311 · `weight` 12,826}. **No hay columna que diga si
la línea se cobró en pieza, paquete, caja, bulto o kilo.**

`units_base` existe pero es un **experimento retirado**, no una dependencia rota: 509,373 de
4,416,568 filas (11.5%), último valor **26-jul**. Significaba CAJAS (RA-PRO.14) e
`import-inventory-health` **la abandonó a propósito** — normalizar a cajas rompía la consistencia
contra stock y costo, que no se convertían. Su importer `import-sales-units-base.js` es código
muerto.

### 2.2 En qué unidad está realmente la venta

Contraste del precio implícito (`revenue/units`) contra la escalera de
`commercial.product_label_prices`: la razón contra `piece_price` debe caer en 1, `pack_size` o
`box_size`.

| Unidad inferida | Celdas | Venta 30 d | % | Estándar | Real |
|---|---|---|---|---|---|
| Pieza | 12,669 | $37,554,632 | 91.4% | 98.2% | 84.5% |
| Paquete | 512 | $1,975,140 | 4.8% | 0.1% | 9.5% |
| Caja | 82 | $277,519 | 0.7% | — | 1.4% |
| **No identificable** | 227 | $1,115,526 | **2.7%** | 1.7% | 3.8% |
| Sin precio de referencia | 236 | $171,090 | 0.4% | — | 0.8% |

**91.4% cae en pieza.** Pero 5.5% ($2.25 M) se cuenta en paquetes o cajas y se publica como
«unidades», y **3.1% ($1.29 M/30 d ≈ $15.6 M al año) no se ubica en ningún escalón.** La escalera
tampoco ayuda: sólo **385 de 8,986** productos traen `pack_size`.

### 2.3 El mismo producto en dos unidades

De 3,296 SKUs vendidos en ambos regímenes, **257 (7.8%) implican unidad distinta según el canal**, y
mueven **$6,187,224** en 30 días (15.1% de la venta). Para ellos sumar `units` entre canales suma
peras con cajas de peras.

### 2.4 Los cuatro modos de falla

| SKU | Escalera | Implícito | Razón | Lectura |
|---|---|---|---|---|
| `97245` MR BEAST MILK FEASTABLES 60GR (y `97244`) | pza $19.99 · paq 10 · caja 180 | $134.78 | **6.74** | peldaño que **no existe** en la escalera (~$465 k entre los dos) |
| `88045` BARCEL TAKIS FUEGO MINI 25P | pza $8.21 · paq 25 · caja 75 | $138.79 | **16.90** | cae **entre** escalones ($59,679) |
| `57009` COBERTURA 20K LUSSEL CUBETA | pza $1,500.08 | $73.27 | **0.05** | se cobra **por kilo**, el catálogo la tiene por cubeta ($91 k) |
| `18022` CAJETA ENVINADA 25KGS CABADAS | pza $54.57 | $102.49 | **1.88** | confusión peso-vs-pieza ($31,669) |

**Los cuatro tienen `unit_sale = 'PZA'`.** Coherente con UM.0: `unit_sale` discrepa con `kdii.c11` en
**73.6%** del catálogo.

---

## 3. El costo real por línea SÍ existe en Kepler

Barrido ciego de las 57 columnas sin descifrar de `kdm2` en líneas de venta. Tres se paran en el
costo del producto: mediana `c62/kdik.c16` = **1.0000**, `c63` = 0.9930, `c50` = 0.9896
(referencia: `precio/c16` = 1.2231).

**Cobertura** (fecha propia de la línea `c32`, 60 d):

| Doctype | Líneas | Importe | Con costo |
|---|---|---|---|
| `U-D-10` ticket de mostrador | 485,552 | $32,764,135 | **99.1%** |
| `U-D-6` | 449,749 | $25,746,551 | **99.1%** |
| `U-D-5` | 14,079 | $2,316,257 | 99.3% |
| `U-D-12` | 5,323 | $1,051,656 | 99.0% |
| `U-D-8` factura | 12,156 | $11,464,987 | 1.2% |

⚠️ **Pero no se puede adoptar hoy:** el costo viene en un **peldaño** que no siempre es la unidad de
la línea. `1 − SUM(c62·cant)/SUM(importe)` da **−261.79%** en `U-D-10`; **7.4% de las líneas dan
costo > venta** y el p99 de costo/venta es **15.2** (≈ un factor de caja; el mediano es 12). `c63` no
revienta (21.88% / 14.88%) pero queda ~10 pp arriba del ~11.5% que reporta el negocio. Es la
*escalera corrida* de [[reference_kepler_supplier_cost_unit_ladder]].

**`kdik.c16` tampoco sirve para costear venta** (cobertura 97.6%): agregado 9.40%, mediana por celda
21.89%, y por sucursal de **−6.21% (Zamora) a +19.10% (Canindo)**.

⚠️ **`kdmm` no expone `U-D` en el ODS** (0 filas con `c2='U' AND c3='D'`), así que ni el decode de la
Fase AX (`U-D-8`/`U-D-12`) ni `U-D-10` se validan contra el catálogo desde ahí. Y AX cubre sólo
$12.5 M de los ~$58.5 M/60 d de venta real.

---

## 4. Procedencia: la regla de "nada de copias" predice el daño

Clasificando las 22 relaciones del margen por naturaleza real (`relkind` + marca de feed + columnas
de auditoría):

| Clase | Relaciones | Datos rotos |
|---|---|---|
| **Primaria** | `kepler_ods.kdm2 · kdm1 · kdii · kdik · kdpv_prov_prod · kdpv_prod_util` | **0** |
| **Vista derivada** | `v_product_box_factor · v_supplier_cost_ladder · wincaja.v_sales_daily · erp_sales_invoices · erp_sales_invoice_lines · erp_goods_receipts · erp_supplier_payments · erp_promotions` | **0** |
| SoR de la app | `catalog.products · catalog.suppliers · commercial.stock · commercial.supplier_discount_policy` | mixto |
| **Copia materializada** | `analytics.sales_daily` (4,435,201) · `commercial.product_label_prices` (8,924) · `analytics.erp_purchase_adjustments` (1,354) · `analytics.product_sales_stats` (12,803) | **todos** |

Los cinco datos averiados —costo por markup, `units_base`, `unit_sale`, `factor_purchase`, el rótulo
`kdm2.c11`— son **copias**. Todo lo sano es la primaria o una vista sobre ella.

⚠️ `catalog.products` sale como SoR de la app (tiene `created_by`/`updated_by`) pero es **híbrida**:
sus columnas derivadas del ERP (`markup_pct`, `cost_base`, `unit_sale`, `factor_sale`,
`factor_purchase`) las escriben importers. Esas columnas son copias, y son las averiadas.
`factor_purchase` está en **0 de 11,185**: columna muerta.

**La distinción a conservar:** materializar por costo es legítimo (GOTCHAS §19: una vista sobre
`stock_movements` costó 517×; `sales_daily` es una **proyección indexada**). El pecado no es
materializar: es **materializar un valor inventado**. El costo por markup no es copia de ningún costo
del ERP — no existe en ninguna fuente, y por eso ninguna verificación contra el origen podía
atraparlo. Regla en GOTCHAS §32.

---

## 5. Qué se retira y qué sobrevive

**Se retira:**

- El «spread por sucursal» de MR.5.10 (§1.4) — artefacto de método.
- La validación de MR.5.9 «4,922 productos, 0 discrepancias» entre el % unitario y el % de la fila:
  **tautológica** en el lado estándar, los dos son el mismo cociente por construcción.
- «$X por unidad» para el 8.6% de la venta que no es pieza confirmada (+15.1% con unidad
  inconsistente entre canales).
- El 11.32% como *medición*: es mezcla 50/50 de dos métodos. Que coincida con el ~11.5% del negocio
  no lo valida — la mitad sale del mismo markup de Kepler que el negocio ya usa.

**Sobrevive:**

- **La venta en pesos.** Limpia de los dos defectos. La única cifra publicable sin reservas.
- Comparaciones **dentro del mismo método**: `wincaja_ruta` 16.15% vs `wincaja_credito` 9.89% son
  6.3 pp legítimos.
- **La dirección del fix de MR.5**: `markup_pct` es adimensional, así que `revenue/(1+m)` no puede
  descuadrar unidades, mientras `cost_base × units` multiplicaba costo-por-caja por
  unidades-por-pieza. El fix sigue siendo mejora; lo que estaba mal era el *por qué*.
- **MR.6 y las 5 palancas**: operan sobre notas de crédito y compras, no sobre el costo del fact.

**Estimación, no medición:** con todo a costo real el margen rondaría **12.1%** (no 11.32%) y la
brecha al 15% sería ≈2.9 pp en vez de 3.7. La prueba de mismos-SKUs controla mezcla de producto, no
de cliente ni de canal.

---

## 6. Sprints

| Item | Qué | Estado |
|---|---|---|
| **MR.7.1** | **Persistir el peldaño cobrado** en `sales_daily`: `units_base` con semántica declarada, el escalón (pieza/paq/caja/kg) y el factor usado. El ETL ya lo deduce y lo tira. **Ruta crítica: bloquea MR.7.2.** | ⬜ |
| **MR.7.2** | **Costear con el peldaño correcto**: leer `kdm2.c62`/`c63` y casarlo con `analytics.v_supplier_cost_ladder` (factor real = `c4/c8`). Aceptación: **cero líneas con costo > venta** (hoy 7.4%) y agregado dentro de 1 pp del ~12% de Wincaja. | ⬜ |
| **MR.7.3** | **Declarar el método por celda** y bloquear cortes mixtos: si dos celdas no vienen del mismo método, la pantalla no las pone lado a lado ni calcula la diferencia. Suprimir `$/unidad` donde la unidad no sea pieza confirmada (mismo criterio que UM.1 aplicó al granel). Se puede hacer ya, sin migraciones. | ⬜ |
| **MR.7.4** | Retirar de la pantalla y de los docs las afirmaciones de §5. | 🔨 en este ciclo |
| **MR.7.5** | Limpieza: borrar `import-sales-units-base.js` (código muerto) y decidir `factor_purchase`. | ⬜ |

**Decisión abierta que sigue arriba de todo:** MR.0 #10 — *el objetivo del 15%, ¿contra el margen
bruto o contra el negociado?* Con el margen real en ~12.1% y el negociado en 15.87%, de eso depende
si la fase está cerrada.

---

## 7. Cómo reproducir

Los scripts de medición son read-only contra prod (`FLEET_DB_URL`). Las consultas están en el
historial de la sesión; las cuatro que sostienen el diagnóstico:

1. **Split de método** — clasificar cada fila con `abs(margen_pct − m/(1+m/100)) < 0.01` ⇒ estándar.
2. **Ceguera al precio** — por (producto, almacén) en canales estándar, `max(precio_u)/min(precio_u)`
   contra `max(margen) − min(margen)`.
3. **Unidad** — `(revenue/units) / piece_price` contra 1 / `pack_size` / `box_size`.
4. **Costo de línea** — filtrar `kdm2` por `c2='U' AND c3='D'` **sin unir a `kdm1`** (la línea lleva
   el doctype) y usar `c32` como fecha: unir por folio filtrando fecha en una sola punta duplica
   (GOTCHAS §31).
