# Modelo de precios de Kepler — qué campo usar según su función

> Investigación 2026-08-24/25 sobre `kepler_ods` (prod), la pantalla **Productos POS** de Kepler
> (`pv_cat_prod_pos.kpl`) y el catálogo de documentos `kdmm`. Todo lo que sigue está **medido**.
> Disparador: el SKU `90042` se publicaba a $8.48 cuando el punto de venta cobra $27.96.

---

## 1. La regla

**Manda lo que el punto de venta COBRA, no la configuración.** La configuración de Kepler
(`kdii.c90`) coincide exacto con lo cobrado sólo en ~58% de los casos, y en **982 de 4,712 SKUs con
volumen (21%) se aparta más de 25%** — en ambas direcciones. No es una fuente de precio confiable por
sí sola; es una captura manual que se desactualiza y que a veces está mal hecha.

| Fuente | Función real | Rol |
|---|---|---|
| `kdm2.c12` en documentos de venta | **el precio que la caja cobró** | **fuente primaria** |
| `kdpv_prod_util` | escalera de volumen (sucursal × presentación × tier) | precio por cantidad |
| `kdii.c90/c91/c92` | PV capturado por unidad | **respaldo**, sólo sin ventas |
| `kdpv_bitacora_precios` | bitácora de cambios del PV | trazabilidad de quién/cuándo |
| `kdik.c16` | costo | validación de margen |

---

## 2. Cómo se captura un precio en Kepler (la pantalla)

`Almacenes → Catálogos → Productos POS` (`pv_cat_prod_pos.kpl`). El bloque **"Estructura de Unidades
para POS"** es el origen de todo, con tres renglones:

| Renglón | Unidad | Factor | Costo | %Margen | PV | → columna en `kdii` |
|---|---|---|---|---|---|---|
| **Base** | Paquete | 1 | 11.66 | 27.45 | **15.25** | **`c90`** (unidad en `c11`) |
| **Unidad Dos** | Paquete | 1 | 139.92 | 27.45 | **172.42** | **`c91`** (unidad `c80`, factor `c81`) |
| **Unidad Tres** | Caja | 4 | 1,259.30 | 13.80 | **1,836.06** | **`c92`** (unidad `c83`, factor `c84`) |

*(valores reales del SKU `06087`)*

Notas que trae la propia pantalla, y que son reglas del sistema:

- *"Las Unidades se deben capturar en orden Ascendente en Factor"*
- ***"La facturación es siempre sobre la unidad Base"*** → el precio a publicar es el de la unidad base
- *"Los inventarios están en la unidad Base"*

**Impuestos** (bloque *Control interno*): **`kdii.c18` = IVA · `kdii.c19` = IEPS**, verificado contra
la pantalla (06087 → `0 / −8`). La semántica la dicta la nota del formulario:

> *"Si los impuestos son Positivos el precio de venta NO los incluye. Si los impuestos son Negativos
> el precio de Venta SÍ los incluye."*

Y hay un campo **"Motivo Cambio Precio en Bitacora"**: cada cambio de PV queda en
`kdpv_bitacora_precios` con su motivo.

### El decode de `c90/c91/c92`, medido

La documentación previa decía `c90`=pieza, `c91`=paquete, `c92`=caja. **Es falso.** Son los tres
*slots* de la escalera de unidades, y qué unidad cae en cada uno cambia por producto y por sucursal.
`c90` es el PV de la **unidad base** (`c11`): verificado en **18,444 de 18,967 casos (97.2%)** contra
la bitácora.

| unidad | filas | `==c90` | `==c91` | `==c92` |
|---|---|---|---|---|
| PZA | 8,930 | **8,515** | 3,194 | 1,288 |
| PAQ | 27,177 | **24,228** | 10,359 | 436 |
| CJA | 30,979 | 262 | **18,035** | 12,048 |

`PAQ` casa con `c90` en 89% de los casos porque **en dulcería la unidad base suele ser el paquete, no
la pieza**. Leer `c90` como "precio de pieza" es el error de raíz.

---

## 3. `kdmm` — el catálogo de documentos (imprescindible)

`kepler_ods.kdmm` = *"Definición de documentos"*: **170 tipos** por sucursal. `c1`=género,
`c2`=naturaleza, `c3`=tipo, **`c5`=nombre**. Sin esto, filtrar por `(c2,c3,c4)` es adivinar — y
adivinar cuesta: leer el género `X` como venta devuelve el **costo** disfrazado de precio.

**Venta a cliente — género `U`, naturaleza `D`:**

| doc | nombre |
|---|---|
| `U-D-10` | **Ticket Contado Caja** ← el ticket del PdV |
| `U-D-9` | Ticket Crédito |
| `U-D-5` / `U-D-3` | Factura TK Contado / Crédito |
| `U-D-6` / `U-D-7` | Factura global / Factura Global Con |
| `U-D-8` | Factura Telemarketing |
| `U-D-12` / `U-D-13` | Factura Contado / Crédito No Fiscal |
| `U-D-45` | Remisión |

**NO son venta:**

- `U-A-*` — cobros (`U-A-5` Cobro PUE), notas de crédito, devoluciones, **`U-A-50` Recepción Traspaso**
- género **`N`** — inventario y traspasos: `N-D-6` Salida Traspaso Sucursal, `N-D-25`, `N-A-6`, `N-A-25`
- género **`X`** — **compras**: `X-A-35` Orden de compra, `X-A-37` Vale de entrada, `X-A-20` Aplica
  Orden Entrada. Su `c12` es el precio al proveedor.

> ⚠️ `U-D-6` y `U-D-13` **son ventas** ("Factura global" y "Factura Cred No Fiscal"), no traspasos.
> Confundirlos con traspasos y a la vez incluir el género `X` fue lo que produjo mediciones falsas en
> esta misma investigación.

---

## 4. El precio del PdV es firme — pero sólo abajo del primer escalón

Moda de `kdm2.c12` en documentos de venta, unidad base, sucursales retail, 90 días, ≥5 líneas:

| Banda | SKUs | Dispersión mediana (IQR/moda) | Firmes (IQR ≤2%) |
|---|---|---|---|
| **qty 1-2** (abajo del 1er escalón) | 4,264 | **0.0%** | **78%** |
| sólo ticket de caja `U-D-10`, qty 1-2 | 2,500 | **0.0%** | **86%** |
| qty ≥ 3 | 4,409 | 9.9% | 33% |

La dispersión de ~10% en `qty ≥ 3` **es la escalera de volumen**, no ruido: los tiers de
`kdpv_prod_util` arrancan en `qty 3`. Por eso el precio de lista se toma con **`qty < 3`**, donde el
número es único.

**Cobertura:** 1,519,632 líneas de venta en 90 días. De los 9,265 productos con precio publicado,
**~59% tiene ≥5 líneas** de venta; **~39% no vende nada** en la ventana y depende del respaldo.

---

## 5. `kdpv_prod_util` — la escalera del PdV

`c1`=SKU · `c2`=presentación · **`c3`=tier** · `c4`=mínimo · `c5`=máximo · **`c6`=%margen** ·
**`c7`=precio**. Ejemplo real (`90042`, sucursal 01):

| present | tier | qty | %margen | precio |
|---|---|---|---|---|
| PAQ | 1 | 3–5 | 20.25 | $27.27 |
| PAQ | 2 | 6–9 | 17.20 | $26.58 |
| PAQ | 3 | 10–∞ | 14.10 | $25.88 |
| CJA | 1..3 | 3–∞ | 13.10→12.10 | $1,231.25 → $1,220.37 |

**Ningún tier cubre `qty 1-2`** — ese precio sólo existe en `kdii`. Las listas `P1`–`P4`/`MAYOREO` de
la plataforma son una copia manual de esta escalera, congelada desde el 16-ago.

---

## 6. Qué usar, según para qué

| Necesito… | Fuente | Cómo |
|---|---|---|
| **Precio de lista** | `kdm2.c12` | moda en docs `U-D-*` de venta, unidad base, `qty<3`, retail, 90d, ≥5 líneas |
| Precio por cantidad | `kdpv_prod_util` | el más barato con `c4 <= qty`, por sucursal y presentación |
| Precio cuando no hay ventas | `kdii.c90` | mediana de retail para la unidad base (`c11`) — **validado**, ver §7 |
| Qué unidad se cobra | `kdii.c11` | y su PV está en `c90` (97.2%) |
| Impuestos | `kdii.c18` / `c19` | positivo = NO incluido en el PV · negativo = SÍ incluido |
| Costo | `kdik.c16` | ojo: con frecuencia viene en unidad de CAJA, no de la base |

**Lo que no se debe hacer:** colapsar las 7 sucursales en un número con una **moda**. Kepler tiene un
PV por sucursal, y aplastarlo obliga a desempatar; cuando la captura mala está en más sucursales que
la buena, la moda elige la mala con la confianza máxima (`90042`: $8.48 en 4 sucursales contra $27.96
en 2 — y el PdV cobra $27.96).

---

## 7. Validaciones del respaldo

Sólo aplican al PV configurado (lo cobrado **no** se valida: es la verdad). En cascada; lo rechazado
conserva su precio anterior y se reporta — **se arregla EN Kepler, la plataforma no lo corrige**:

1. `<= $0.05` → marcador de promo, no precio público.
2. `> 3 × costo` → precio de CAJA colado en el slot de la unidad base. El p99 real de precio/costo es
   **2.03×**. **La escalera no perdona este caso**: para esos SKUs también trae el valor de caja y
   confirmaría el error.
3. **Escalón**: si `kdpv_prod_util` confirma el PV (`pv >= 0.9 × tope`), manda **sobre el costo** —
   está en la misma unidad que el precio, mientras `cost_base` suele venir en caja. Si existe escalera
   y el PV queda debajo, se rechaza: un precio de lista no puede ser menor que su precio por volumen.
4. `< costo` → se vendería perdiendo.

La asimetría de (2) vs (4) es a propósito: un precio que parece *muy bajo* suele ser
costo-en-caja contra precio-en-pieza (falso positivo, la escalera lo disculpa); uno *muy alto* es un
precio de caja mal ubicado (positivo verdadero).

---

## 8. Errores de captura reales (no son plantillas)

Hay **219 tripletas `(c90,c91,c92)` idénticas compartidas por 4+ SKUs sin relación**, que tocan 1,667
productos. La primera lectura fue que eran valores de relleno; **la pantalla del POS demostró que no**:
`$15.25 / $172.42 / $1,836.06` es la captura real de `06087`, renglón por renglón.

Lo que sí son: **capturas equivocadas repetidas**. En `06087` el renglón *Base* y *Unidad Dos* son
ambos "Paquete", y los costos ($11.66 vs $139.92, razón 12×) no cuadran con los factores declarados
(1 y 1). El producto queda con un PV de $15.25 mientras el PdV cobra $325.59.

Se detectan igual (tripleta compartida por ≥4 SKUs) pero el diagnóstico es distinto: **hay que
recapturar la estructura de unidades en Kepler**, no reemplazar un placeholder.

---

## 9. Trampa: `md_03` no es la sucursal 03

En `localhost:5433` conviven dos bases que parecen la sucursal 03. **Sólo una está viva:**

| base | `md.kdm1` | último movimiento | qué es |
|---|---|---|---|
| **`kepler_pilot`** | 213,765 | **hoy** | **la sucursal 03 VIVA** (réplica lógica) |
| `md_03` | 162,782 | 2026-06-15 | restore de `BACKUP.sql`, congelado — se usó para descifrar el esquema |

El CDC lo tiene bien: [`ods-cdc-wal.js:40`](../../database/importers/kepler/ods-cdc-wal.js) mapea
`'03' → kepler_pilot`. **`kepler_ods` está fiel al origen en las 7 sucursales.** Comparar contra
`md_03` produce 2,444 "diferencias" que son dos meses de cambios que el dump nunca vio.

---

## 10. Implementación

- **Cómputo único**: `salePriceCtes` en
  [`services/feeds-ingest/ods-derived.js`](../../services/feeds-ingest/ods-derived.js). Deja un
  `evaluado` con el precio, su `fuente` (`pos` | `config`) y el motivo de rechazo.
- **Al momento (hop-2)**: `normalizeSalePrice` registrado en `ODS_NORMALIZERS` para **`kdm2`** (una
  venta nueva es un precio nuevo), `kdii` y `kdpv_prod_util`. **Sin cron** — regla
  `feedback_ods_derived_realtime_no_batch_lag`.
- **Auditoría / reconciliación manual**:
  [`audit-sale-prices.js`](../../database/importers/kepler/audit-sale-prices.js) (`--apply` para
  reconciliar, `--rechazados` para la lista completa).
- **Índices creados en prod** para que el hop-2 no escanee tablas completas:
  `ix_kdm2_sku_venta` (parcial `c2='U' AND c3='D'`, 200 MB) e `ix_kdpv_bitacora_sku_lookup`.
- **Ojo con `work_mem`**: 512 MB truena Railway por memoria compartida (`/dev/shm`). Usar 128 MB y
  `max_parallel_workers_per_gather = 0`.

### Deuda conocida

- **`MAYOREO` tiene `min_qty = 1`** y precio idéntico a `P4` (el escalón más profundo), y
  `resolvePriceForQty` toma el más barato de **todas** las listas sin mirar la del cliente → el
  descuento de mayoreo aplica desde una pieza. Ver [`03_LOG_REVISIONES.md`](03_LOG_REVISIONES.md).
- `resolvePriceForQty` no respeta `price_lists.active` ni la vigencia: apagar una lista no la saca del
  cobro; sólo el `deleted_at` de sus filas.
- **70068** ($56.05 cfg → $57.45 cobrado, 6,240 líneas) y **17083** ($62.99 → $66.25, 5,475 líneas)
  cobran consistentemente 2.5–5% arriba del PV y del escalón. Sin explicar.

---

## 11. Verificado con

Consultas sobre `kepler_ods` en prod y las réplicas locales `:5433`, 2026-08-24/25. Relacionados:
[`ERP_KEPLER_SCHEMA.md`](ERP_KEPLER_SCHEMA.md), [`KEPLER_CATALOGO_TABLAS.md`](KEPLER_CATALOGO_TABLAS.md),
[`FASE_RA`](FASES/FASE_RA_REABASTECIMIENTO.md).
