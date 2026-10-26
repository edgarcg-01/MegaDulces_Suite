# Fase MR — Motor de Rentabilidad (cascada de margen)

> **Estado:** 🧪 PROBADO (local) — pantalla MR.5 en código y corregida 2026-08-29 · **ADR-051** aceptado
> **Tesis:** no es un reporte de margen. Es el **lenguaje económico común** de Mega Dulces:
> un sistema que explica *de dónde viene* el margen, *dónde se pierde* y *qué puede hacer cada área* para recuperarlo.
> **Meta de negocio:** margen actual ~**11.5%** → objetivo **15.0%**. Brecha **−3.5 pp**.
>
> **MR.0 (diccionario del margen):** redactado y **sin firmar** — [`FASE_MR_DICCIONARIO_MARGEN.md`](FASE_MR_DICCIONARIO_MARGEN.md).
>
> ⚠️ El ADR de esta fase era **ADR-048**, número ya ocupado por CxC (Cartera de clientes). Corregido a **ADR-051**.

---

## 0. Por qué esto no arranca programando la pantalla

Si se construye el tablero antes de cerrar las definiciones, se automatizan ambigüedades y
corregirlas después cuesta caro. El primer entregable de esta fase **no es UI**: es el
**diccionario corporativo del margen** (§2), firmado por Compras, Marketing, Comercial y Finanzas.

La pantalla es MR.5. Antes hay cuatro sprints de definición y feature store.

---

## 1. Lo que ya existe (verificado contra prod, 2026-08-21)

No partimos de cero. La mayoría de los componentes de la cascada ya tienen fuente viva:

| Componente de la cascada | Fuente real | Filas en prod | Estado |
|---|---|---|---|
| Precio de venta | `commercial.product_prices` | 44,943 | ✅ vivo (feed `repoint-catalog-prices` ← `kdii.c90`) |
| Costo de adquisición | `catalog.products.cost_base` | 14,726 | ⚠️ ambigüedad neto/bruto sin resolver |
| Descuentos comerciales del proveedor | `analytics.erp_purchase_adjustments` (X-D-55 / X-D-40) | 1,381 | ✅ vivo |
| Descuento financiero al pagar | `analytics.erp_supplier_payments.descuento` (`c84`) | 4,366 pagos | ✅ vivo |
| Política de descuento esperada | `commercial.supplier_discount_policy` | 147 proveedores | ✅ captura manual |
| Apoyos promocionales del proveedor | `analytics.erp_promotions` | 794 | ⚠️ sin atribución a SKU/periodo |
| Promociones propias | `commercial.promotions` | **0** | ❌ vacía |
| Descuento otorgado al cliente | `commercial.order_lines.discount_amount` | **18** | ❌ la venta no pasa por aquí |
| Costo logístico atribuible | `logistics.shipment_expenses` | **0** | ❌ vacía |
| Recepciones / fill rate | `analytics.erp_goods_receipts` | 14,348 | ✅ vivo |
| Inventario | `commercial.stock` | 52,519 | ✅ vivo |
| Rotación / demanda | `analytics.product_sales_stats` | 8,624 | ✅ vivo |
| Política de reorden / cadencia | `commercial.reorder_policy` | 35,651 | ✅ vivo (Fase RA) |
| Venta real por producto | `analytics.product_sales_monthly`, `v_sales_demand_truth` | — | ✅ vivo (Fase RS/VG) |

**Traducción:** el 70% de la cascada ya tiene dato. Lo que falta no es capacidad de cálculo,
es **atribución** — quién se lleva cada peso de descuento, a qué SKU y a qué periodo.

---

## 2. Los tres huecos que definen el alcance real

Estos salieron de medir, no de suponer. Cambian el plan y hay que decidirlos antes de MR.2.

### 2.1 La venta NO pasa por la plataforma

`commercial.order_lines` tiene **18 filas**. La venta real de Mega Dulces vive en Kepler y
Wincaja, y llega vía sell-out (`analytics.product_sales_monthly`, `sales_by_channel_monthly`,
`v_sales_demand_truth`).

**Consecuencia:** el *descuento otorgado al cliente* no se puede leer del pedido —
hay que derivarlo comparando **precio de lista vs precio efectivamente facturado** en el
sell-out. Es un componente calculado, no capturado, y su exactitud depende de que el
sell-out traiga el precio de línea. **Verificar antes de MR.2.**

### 2.2 El costo `cost_base` no tiene definición cerrada

Existe ambigüedad documentada entre costo **neto** y **bruto** (con/sin descuento de
proveedor ya aplicado). Si el motor resta descuentos de proveedor sobre un `cost_base`
que ya los trae, **los cuenta dos veces** y el margen negociado sale inflado.

**Es la decisión #1 del diccionario.** Sin ella, los tres márgenes son ruido.

### 2.3 La unidad de medida es el riesgo #1 (ya demostrado con datos)

Comprobado esta semana en `/comercial/pricing`: el diagnóstico "bajo costo" marcaba
`CH ORBIT 4S HIERBABUENA / 40` con **costo $67.07 vs precio $2.11** y 16,032 u/30d. No es
una pérdida — es **costo por caja contra precio por pieza**.

La unidad operativa de venta es `kepler_ods.kdii.c11`, y la equivalencia entre
presentaciones vive en la escalera `c11` / `c80`+`c81` / `c83`+`c84` (decodificada
2026-08-21, cubre 93.5% de los combos SKU×presentación). Además
`catalog.products.unit_sale` **miente**: dice `PZA` donde Kepler dice `PAQ` en
**5,906 de 8,708** productos.

**Regla dura para el motor:** todo componente de la cascada se normaliza a la unidad
`c11` antes de sumar. Un motor de rentabilidad que mezcle unidades produce números
convincentes y falsos — que es peor que no tener el tablero.

---

## 3. El diccionario del margen (entregable MR.0)

Cada componente necesita **fórmula, fuente, responsable, periodicidad y nivel** cerrados
y firmados. Este es el contrato; el código lo implementa, no lo define.

### 3.1 La cascada

```
  Precio de venta                          (unidad c11, sell-out real)
− Costo de adquisición                     (cost_base normalizado, definición §2.2)
─────────────────────────────────────────
= MARGEN COMERCIAL BRUTO                   → responsable: Comercial + Compras

+ Descuentos comerciales del proveedor     (X-D-55 comercial)
+ Bonificaciones / mercancía sin cargo     (X-D-55 con motivo de bonificación)
+ Descuentos financieros atribuibles       (c84 al pagar · supplier_discount_policy)
+ Apoyos promocionales atribuibles         (erp_promotions con atribución)
+ Apoyos de Trade Marketing atribuibles    (libs/trade — por definir)
─────────────────────────────────────────
= MARGEN NEGOCIADO                         → responsable: Compras

− Descuentos otorgados al cliente          (derivado: lista vs facturado)
− Promociones absorbidas por Mega Dulces   (commercial.promotions — hoy vacía)
− Costos logísticos atribuibles            (cuando corresponda; hoy sin fuente)
─────────────────────────────────────────
= CONTRIBUCIÓN ECONÓMICA REAL              → responsable: Dirección / Finanzas
= MARGEN INTEGRAL
```

**Por qué tres márgenes y no uno:** si se publica un solo "margen", se mezclan fenómenos
de dueños distintos y nadie responde por la desviación. Cada margen tiene un responsable
único y palancas propias.

### 3.2 Ficha por componente (plantilla a llenar en MR.0)

| Campo | Contenido |
|---|---|
| Nombre | nombre corporativo único |
| Fórmula | expresión exacta, con unidad |
| Fuente | tabla/columna en `kepler_ods.*` o `analytics.*` |
| Nivel | SKU · marca · categoría · proveedor |
| Periodicidad | diario / mensual |
| Atribución | cómo se reparte a SKU cuando la fuente es a nivel documento |
| Responsable | área dueña de la palanca |
| Signo | suma o resta en la cascada |
| Estado | vivo / parcial / sin fuente |

**Regla de atribución (la parte difícil):** una nota de crédito X-D-55 llega por documento,
no por SKU. Hay que decidir el criterio de reparto — proporcional a compra del periodo,
al SKU declarado en la nota, o a la línea original. Sin criterio explícito, el margen por
SKU es una opinión.

---

## 4. Descomposición de brecha (el corazón del motor)

No basta con reportar 11.5% vs 15.0%. El motor debe **descomponer los 3.5 pp**:

```
Proveedor X · margen actual 11.5% · meta 15.0% · brecha −3.5 pp

  +1.0 pp   negociación de compra       → Compras
  +0.7 pp   bonificación                → Compras
  +0.5 pp   apoyo promocional           → Compras + Marketing
  +0.6 pp   ajuste de precio / mix      → Comercial
  +0.7 pp   sin resolver                → Dirección
```

Cada renglón debe ser **accionable y navegable**: clic lleva a la lista de SKUs/documentos
que lo componen, con el filtro puesto. Un renglón que no se puede abrir es un número de
adorno.

**Cómo se calcula cada palanca** (a cerrar en MR.0): benchmark contra el mejor trimestre
del propio proveedor, contra la política capturada en `supplier_discount_policy`, o contra
un objetivo fijado por Compras. **Recomendación: la política capturada**, porque es lo
único auditable y ya tiene 147 proveedores cargados.

---

## 5. Margen × rotación × capital

Maximizar margen porcentual aislado destruye capital. Un SKU al 20% que no rota inmoviliza
inventario; uno al 10% que rota rápido genera contribución anual superior.

El motor debe exponer, en el mismo nivel:

- **Contribución anual** = margen $ × rotación
- **GMROI** = margen $ / inventario promedio $
- **Días de inventario** y **capital comprometido $**
- **Fill rate** (Fase RA.14) y **cadencia de compra** (`reorder_policy`)
- **Días de crédito** del proveedor (financiamiento — `c30` condición de pago, Fase RE)

Esto conecta con el objetivo ya documentado de Compras: inventarios balanceados al mejor
costo y más vueltas de inventario. La segmentación **ABC-XYZ** de RA-PRO.2 ya está calculada
y sirve de eje.

---

## 6. Modelo de datos propuesto

**Un feature store, no consultas ad-hoc.** El cálculo de la cascada es caro y multi-fuente;
recalcularlo por request no escala y produce números distintos según quién pregunte.

```
analytics.margin_components     (tenant, periodo, sku, componente, monto, unidad, fuente, atribucion)
                                 ↑ grano mínimo: un renglón por componente por SKU por mes
analytics.margin_rollup         (tenant, periodo, nivel, entidad_id, los 3 margenes + brecha)
                                 ↑ pre-agregado proveedor / marca / categoria / sku
commercial.margin_targets       (tenant, nivel, entidad_id, margen_objetivo, vigencia, capturado_por)
                                 ↑ la meta es dato capturado, no constante en el codigo
analytics.margin_gap_bridge     (tenant, periodo, entidad_id, palanca, puntos, responsable)
                                 ↑ la descomposicion de §4, persistida y auditable
```

Todas con `tenant_id` + RLS forzado + audit fields, según la convención del proyecto.
`margin_components` es **aditiva y reversible**: se recalcula por periodo sin borrar histórico.

**Principio heredado (ADR-016):** el motor decide, el agente comunica, el LLM fuera del
camino del dinero. Ningún número de esta cascada lo produce un modelo — todos son
deterministas y trazables a su documento origen.

---

## 7. La pantalla (MR.5)

**Unidad principal:** `Proveedor → Marca → Categoría → SKU`, navegable en ambos sentidos.

Surface **Operations** (`DESIGN.md`): tabla densa + master-detail, sin ilustraciones,
`tabular-nums` obligatorio, cifras en Geist Mono.

**Answer-first** (DESIGN §15): arriba la brecha y su descomposición; el grid crudo al
drill-down. La pregunta que la pantalla contesta al abrirla no es "cuánto margen tengo"
sino **"dónde están mis 3.5 puntos"**.

Columnas por nivel: venta $, costo $, margen bruto %/$, descuentos proveedor,
bonificaciones, apoyo promocional, trade marketing, descuento al cliente, margen integral
%/$, margen objetivo, brecha vs objetivo, inventario $/días, rotación, fill rate, cadencia,
días de crédito.

**Cada celda de descuento o apoyo es navegable a sus documentos** (el resolvedor
`entity-ref` ya existe y hace exactamente eso: `ent:`, `lin:`, `adj:`, `pay:`, `prov:`, `sku:`).

**Simuladores** (MR.7, el salto de descriptivo a decisión):

- *Compras negociando:* "con estas condiciones, ¿qué margen me deja este proveedor y cuánto me falta?"
- *Marketing diseñando promo:* "si descuento este SKU, ¿qué pasa con el margen y cuánto tendría que aportar el proveedor para protegerlo?"
- *Comercial moviendo precio:* "¿esto crea volumen rentable o solo vende más con menos contribución?"

---

## 8. Sprints

| Sprint | Entregable | Depende de |
|---|---|---|
| **MR.0** | 🧪 **REDACTADO, sin firmar** — [`FASE_MR_DICCIONARIO_MARGEN.md`](FASE_MR_DICCIONARIO_MARGEN.md): ficha por componente (§3.2), reglas duras, atribución y las **10 decisiones abiertas** con dueño. **Sin código.** | — |
| **MR.1** | Normalización de unidad: todo a `c11` vía la escalera `kdii`. Vista canónica `analytics.v_product_unit_ladder`. | MR.0 |
| **MR.2** | Venta y descuento al cliente desde sell-out (§2.1). Verificar que el sell-out trae precio de línea. | MR.1 |
| **MR.3** | `analytics.margin_components` + motor de atribución de X-D-55 / `c84` / `erp_promotions` a SKU. | MR.0, MR.2 |
| **MR.4** | `margin_rollup` + `margin_targets` + los tres márgenes por los 4 niveles. | MR.3 |
| **MR.5** | Pantalla `/comercial/rentabilidad` — jerarquía, drill-down, navegación a documentos. | MR.4 |
| **MR.6** | `margin_gap_bridge`: descomposición de la brecha por palanca y responsable. | MR.4 |
| **MR.7** | Simuladores (negociación, promo, precio). | MR.6 |
| **MR.8** | Margen × rotación × capital: GMROI, contribución anual, cruce ABC-XYZ. | MR.4 |
| **MR.9** | Detectores → bandeja de hallazgos (patrón Maat/RA): SKU bajo objetivo con rotación alta, proveedor sin apoyo cobrado, descuento pactado no aplicado. | MR.6 |

**MVP = MR.0 → MR.5.** MR.6 es lo que convierte el tablero en herramienta de decisión;
no debería quedar fuera del primer release aunque llegue una semana después.

---

## 8.1 Estado real y corrección (2026-08-29)

**La pantalla MR.5 se construyó sin MR.0–MR.4.** El resultado fue exactamente lo que
§2 y §9 predijeron: se automatizaron las ambigüedades. Auditoría contra
`platform_test` y corrección aplicada — detalle y decisión en **ADR-051**.

| # | Hallazgo | Estado |
|---|---|---|
| 1 | **El costo mezclaba unidades.** `cost_base × units` con `cost_base` por CAJA. **En prod: 57 SKUs metían $3,565,336 de COGS falso (10.0% del total) sobre $386k de venta, y la pantalla publicaba 14.62% contra 11.32% del fact — 3.30 pp, el 94% de la brecha.** El negocio reporta ~11.5%: el fact coincide, la pantalla decía que la brecha estaba casi cerrada. | ✅ Costo y venta salen de `analytics.sales_daily`; margen estable 10.32/10.29/10.33% a 30/90/365 d en local |
| 2 | **Cascada de "Margen negociado" en ceros.** `erp_purchase_adjustments` = 0 filas **en local**: las 4 palancas por categoría no se medían, pero se dibujaban como $0. | ✅ `levers_source_empty` + aviso explícito. **Prod verificado: 1,403 ajustes** (descuento_comercial $10.98M · apoyo_marca $1.16M · pronto_pago $757k · saldo_favor $124k) **y 147 políticas** — allá la cascada sí opera |
| 3 | **El KPI de capital no cuadraba con la tabla** ($23M de diferencia invisible). El "$375M / 666 días" que apareció en la auditoría era de `platform_test`: **en prod el inventario está sano** ($59.1M = 38 días de COGS). | ✅ Cuadre `total = in_scope + stock muerto` + `cost_quality`. ⚠️ Lo que sí persiste en prod es la calidad del costo: **564 de 6,972 SKUs (8.1%) valúan $11.4M = 19.3% del capital** con un costo que el PdV contradice |
| 4 | **El panel de cobertura decía 100% siempre** (4,117/4,117 por construcción). | ✅ Cobertura real (99.88%, 4,009/4,082) + canales + `data_as_of` |
| 5 | **`promo_pct` publicado como "−4.0%"** cuando `benefit` sólo toma 2/3/4/5 y la unidad no está confirmada. | ✅ Viaja crudo como `promo_benefit`, rotulado "unidad sin confirmar" |
| 6 | **Ventanas desalineadas**: el fact iba 2 días atrás y compras/pagos usaban `CURRENT_DATE`, sin decirlo. | ✅ `data_as_of` en pantalla |
| 7 | **Bandas clavadas en 10/15/25** con objetivo editable. | ✅ Derivadas de `target` desde un solo origen (TS + `CASE` SQL) |
| 8 | **ADR-048 duplicado** con CxC; sin entrada en el tracker. | ✅ ADR-051 + tracker |

**Sigue abierto:** MR.0 (diccionario firmado) y MR.6 (`margin_gap_bridge`) no existen.
La descomposición de la brecha de §4 —lo que convierte el tablero en herramienta de
decisión— sigue sin construirse. Y la decisión §10.1 (`cost_base` neto o bruto) dejó de
bloquear el margen, pero **sigue bloqueando la valuación de inventario**.

---

## 8.2 El margen contra el costo estándar (MR.9, 2026-10-13)

**Pedido:** «una verdad sobre la rentabilidad de cada producto: el costo estándar contra el precio de venta».

**El costo, por tipo de venta:**

| Venta | Costo | Por qué |
|---|---|---|
| Mostrador (`U-D-10`/`U-D-12`) y rutas | `kdm2.c62 × c56`: el estándar que Kepler **congela** en el renglón | Ya lo resuelve el árbitro `mv_erp_margin_daily` ([MR.8.2]) |
| Mayoreo (`U-D-8`) | `kdii.c77 × c58 × c56`: el estándar de la **ficha de hoy**, misma sucursal | `c62` viene vacío en ~99 % (límite de la fuente) |

La venta va **sin IVA/IEPS** (por renglón, `c17`/`c18`). El margen es `1 − costo / venta neta`.

**Por qué la ficha sirve para el mayoreo** (prod, renglones que traen los dos costos): la diferencia en
pesos contra el costo congelado es +0.10 % (0–30 d), +0.01 % (30–60 d) y −0.45 % (60–90 d). Más atrás no
hay testigo: el mayoreo anterior a junio-2026 no trae ni un `c62`, así que se publica con
`metodo_costo = 'ficha_actual'` y no se presenta como el costo del ticket.

**Objetos:** `analytics.mv_erp_margin_ficha_daily` + `analytics.v_margin_standard_daily` (mig
`20261013234951`), candado `test-newdb-margin-standard.js`.

**Resultado, 12-sep → 12-oct-2026 (Kepler, sin Wincaja):**

| | Venta neta | Margen contra estándar |
|---|---:|---:|
| Mostrador | $33,187,998 | **15.03 %** |
| Mayoreo | $10,937,509 | **10.07 %** |
| **Total** | **$44,125,507** | **13.80 %** |
| Lo que publica la pantalla hoy (`venta/(1+markup)`) sobre las mismas ventas | | 10.78 % |

⚠️ **El costo estándar no es lo pagado.** La Fase CE midió el mismo día 16.46 % contra estándar y 12.12 %
contra lo pagado: el estándar es el que **fija el precio**, y cuando se queda atrás del costo de reposición
el margen se ve mejor de lo que es. La pantalla tiene que poner esa alerta al lado
(`v_kepler_standard_cost.veredicto = 'estandar_bajo'`).

---

## 9. Riesgos

| Riesgo | Mitigación |
|---|---|
| Doble conteo de descuentos (§2.2) | Decisión neto/bruto en MR.0, antes de una línea de código |
| Mezcla de unidades (§2.3) | MR.1 bloquea todo lo demás; ningún componente entra sin unidad `c11` |
| Atribución de notas de crédito a SKU | Criterio explícito y versionado en el diccionario; el rollup expone qué % del monto es atribuido vs prorrateado |
| Componentes sin fuente (promos propias, logística) | Se declaran **visiblemente ausentes** en la pantalla. Un margen integral que omite un componente en silencio es peor que uno incompleto y honesto |
| El tablero se vuelve BI descriptivo | MR.6 y MR.7 no son opcionales: la brecha descompuesta y los simuladores son el producto |

---

## 10. Decisiones abiertas (para MR.0)

1. **`cost_base` es neto o bruto** — bloquea todo el margen negociado.
2. **Criterio de atribución** de X-D-55 y `c84` a SKU: proporcional a compra, SKU declarado, o línea original.
3. **Origen del margen objetivo**: ¿15% global, por proveedor, por categoría? ¿Quién lo captura y con qué vigencia?
4. **Alcance de "apoyo de Trade Marketing"**: qué se reconoce como aporte económico atribuible.
5. **Costo logístico**: ¿entra en la v1 (hoy sin fuente) o se declara ausente hasta tener dato?
6. **Periodicidad**: mensual cerrado, o mensual + parcial del mes en curso.

---

## Referencias

- Levantamiento de Compras: margen 11.5% → objetivo 15%, sin visualización integral en el momento de decidir.
- [`FASE_RA_REABASTECIMIENTO.md`](FASE_RA_REABASTECIMIENTO.md) — reorden, fill rate, ABC-XYZ, cadencia.
- [`FASE_RE_RECEPCION_MERCANCIA.md`](FASE_RE_RECEPCION_MERCANCIA.md) — X-D-55 / X-D-40 / `c84`, condición de pago.
- [`FASE_CXP`](../01_TRACKER_PROGRESO.md) — landed cost por proveedor (`supplier_discount_policy`).
- [`DESIGN.md`](../../../DESIGN.md) — surface Operations, §15 comprensión del dato.
- ADR-016 — el motor decide, el agente comunica, el LLM fuera del camino del dinero.

---

## Observaciones de diseño UI — revisión del plan (2026-10-26)

> **Con qué se miró: el plan, no la pantalla** (nivel C). Nada visual se da por medido; lo que
> sólo se comprueba con la pantalla viva va como criterio a verificar. La ley es
> [`ESTANDAR_DE_INTERFACES.md`](../../ESTANDAR_DE_INTERFACES.md) (§ = sus secciones) y su
> implementación [`DESIGN.md`](../../../DESIGN.md). Severidad: 🔴 la pantalla afirmaría algo falso,
> escondería lo que importa o perdería trabajo — **bloquea pasar C3 a 🚀** · 🟠 se resuelve dentro
> de la fase · 🟡 mejora; si no entra, queda como deuda con nombre. La pantalla existe
> (`/comercial/rentabilidad`, MR.5, 🧪 local desde el 29-ago): cada observación es un criterio a
> verificar en ella, no un defecto medido. Se leyeron también, en lo que toca pantalla,
> [`FASE_MR_DICCIONARIO_MARGEN`](FASE_MR_DICCIONARIO_MARGEN.md) y
> [`FASE_MR_COSTO_Y_UNIDAD`](FASE_MR_COSTO_Y_UNIDAD.md).

**La pregunta que contesta (prueba de la frase, §4.0b):** *«¿Dónde se pierden los puntos de margen que
me separan del objetivo, y quién responde por cada uno?»* — una pregunta: la descomposición y su dueño
son la misma respuesta. Pero §5 y §7 le cuelgan capital, rotación, fill rate, cadencia y días de
crédito, que contestan otra —*«¿qué inventario no rinde el capital que inmoviliza?»*—: conflación,
se parte (MR.UI.10). Y hoy la pregunta **no tiene respuesta**: MR.6 no existe y el objetivo no está
definido (MR.UI.2).

**Jerarquía propuesta (§3.7 · DESIGN §Q.5):** primario = **margen bruto y margen negociado contra el
objetivo**, cada uno con su método y su universo · secundario = la brecha descompuesta por palanca y
responsable, navegable a sus documentos · terciario = los renglones proveedor → marca → categoría → SKU.

| # | Sev | Observación (desde la silla de quien la usa) y costo | Ley | Criterio de aceptación |
|---|---|---|---|---|
| MR.UI.1 | 🔴 | **Un solo margen hecho con dos métodos que no se pueden comparar.** La mitad Kepler de la venta (50.8 %) no lleva costo: lleva `revenue/(1+markup)`, un margen que es álgebra y no reacciona al precio (0.0000 pp de diferencia entre almacenes en 3,269 SKUs); la mitad Wincaja (48.9 %) lleva el costo de la caja (31-ago). Por eso el «spread por sucursal» que MR.5.10 publicó como hallazgo (Madero 14.96 % contra 8ESQ 10.16 %) es **artefacto del método**: se premia o se regaña a una sucursal por cómo se calculó su costo. MR.7.3 (método por celda) sigue ⬜. | §1.6 · §1.5 · ADR-059 | Cada margen lleva su método visible como `p-tag` con texto («costo de caja» / «markup de catálogo» / «costo estándar»). Dos celdas de método distinto no van lado a lado ni se restan: «No comparable: métodos distintos». Sin spread por sucursal hasta MR.7.2. |
| MR.UI.2 | 🔴 | **La cifra primaria de la pantalla depende de dos decisiones sin firmar.** «Dónde están mis 3.5 puntos» cambia según la **#10** (¿el 15 % es sobre el bruto o sobre el negociado?) y la **#3** (origen del objetivo, que hoy es **una constante editable en pantalla, default 15 %**, de la que se derivan las bandas de color). Con el bruto en 12.04 % faltan 2.96 pp; con el negociado en 15.87 % el objetivo **ya se cumple** (365 d, 29-ago). Quien teclee otro objetivo repinta las bandas. Y el diccionario MR.0 no tiene ninguna de sus cinco firmas. | §1.6 · §1.3 · §3.2 · DESIGN §Q.1 | Arriba, los dos márgenes contra el objetivo, cada uno con su brecha: «Bruto 12.04 % · faltan 2.96 pp» / «Negociado 15.87 % · arriba 0.87 pp», y la línea «Objetivo 15 % sin firmar: falta definir si aplica al bruto o al negociado (Dirección, decisión #10)». El objetivo es un dato capturado (`commercial.margin_targets`, con quién y cuándo), no un campo de la pantalla; ninguna banda verde mientras #10 no esté firmada. |
| MR.UI.3 | 🔴 | **«Unidades» y «$ por unidad» suman piezas con cajas.** El fact no guarda en qué peldaño se cobró cada línea (MR.7.1 ⬜): **5.5 % de la venta ($2.25M en 30 d)** está en paquetes o cajas y se publica como «unidades»; **3.1 % ($1.29M en 30 d, ≈$15.6M al año)** no cae en ningún escalón; y **257 SKUs (7.8 %) se cobran en unidad distinta según el canal**, $6,187,224 en 30 d (31-ago): sumar sus unidades entre canales suma piezas con cajas. El rótulo «por unidad vendida» es honesto con la palabra y falso con el número. | §1.1 · §4.5 · diccionario regla 7 | `$/unidad` y «unidades» sólo donde el peldaño es pieza confirmada; en el resto la celda dice «—» con `app-context-help` («unidad de cobro no identificada»). En agregados de varios canales, unidades sólo si el peldaño coincide; si no, «no sumable». Arriba: «N SKUs con unidad sin confirmar · $X de venta». |
| MR.UI.4 | 🔴 | **El capital y los días de inventario se publican como medición y son un piso.** El plan afirma «en prod el inventario está sano ($59.1M = 38 días de COGS)» (§8.1) y su propio diccionario dice lo contrario: cuenta 9 de 20 almacenes, las 11 rutas venden $4.2M en 30 d (10 %) con cero inventario y el CEDIS tiene 149 SKUs contra 7,790 con venta. Además valúa `cantidad × cost_base`, la multiplicación que ADR-051 retiró del COGS porque `cost_base` viene por caja en buena parte del catálogo; mezcla piezas (Kepler) con paquetes (MD-30/MD-32: **$16.3M = 28 %** del valuado); y **$11.4M (19.3 %)** llevan un costo que el PdV contradice. | §1.6 · §1.3 · diccionario reglas 1 y 10 | El KPI dice «Inventario contado: $59.1M en 9 de 20 almacenes (faltan rutas y CEDIS)» y los días «≥ 38 d (piso)», nunca «38 días». Las tres reservas (unidad Wincaja, costo contradicho, cobertura) van bajo el KPI con su monto. Sin la palabra «sano» y sin verde. |
| MR.UI.5 | 🔴 | **«Descuento otorgado al cliente −0.01 pp» se lee como «casi no damos descuento», y sólo se midió en la venta facturada.** Son $71,924 en 213 facturas sobre **$21.2M facturados, contra $641M de sell-out** (3.3 %). En el resto —mostrador y rutas— no se midió nada, y la derivación lista contra facturado de §2.1 (MR.2) no existe. Es un casi-cero que significa «no lo sé». | §1.3 · §1.6 | La fila dice «−0.01 pp sobre la venta facturada ($21.2M de $641M); mostrador y rutas sin medir», y el margen integral lista esta razón junto a promociones y logística en su marca de «incompleto». |
| MR.UI.6 | 🔴 | **§7 pide columnas en niveles donde el dato no existe.** Por cada nivel (proveedor → marca → categoría → SKU) pide descuentos del proveedor, bonificaciones, apoyo promocional, trade marketing y margen integral; pero el diccionario establece que **las 5 palancas no se reparten a SKU** (decisión #2 abierta) y que trade marketing **no entra a la cascada** (decisión #4). Debajo de proveedor, esas celdas sólo pueden salir en cero (falso) o prorrateadas (una opinión). También pide **fill rate**, que en RA es ~100 % artificial (captura de golpe; RA.15.1 marca recibido = pendiente, ver RA.UI.4). | §1.3 · §1.1 · diccionario regla 9 | Debajo de proveedor, palancas y margen negociado/integral dicen «n/a: se cobra por proveedor, sin reparto (decisión #2)», nunca $0 ni un prorrateo. Trade marketing, «sin fuente (decisión #4)». Fill rate fuera de la pantalla hasta que RA publique uno medido. |
| MR.UI.7 | 🔴 | **Cuatro márgenes del mismo mes, dos con la misma etiqueta.** MR.9 publica **13.80 % contra costo estándar** (Kepler sin Wincaja, 12-sep → 12-oct; mostrador 15.03 %, mayoreo 10.07 %); la Fase CE midió **16.46 % contra estándar** y **12.12 % contra lo pagado**; y la pantalla publica hoy **10.78 %** sobre las mismas ventas. El «Total 13.80 %» deja fuera a Wincaja, que era ~49 % de la venta (31-ago), y el mayoreo se costea con la **ficha de hoy** (`ficha_actual`), no con el ticket. | §1.5 · §1.6 · ADR-059 | Un solo resolvedor (`v_margin_standard_daily`) para MR y CE, con el universo escrito junto a la cifra: «Kepler · sin Wincaja · 12-sep → 12-oct · venta sin IVA». El mayoreo con `ficha_actual` lleva su marca. La alerta `estandar_bajo` («el estándar está abajo del costo de reposición: el margen se ve mejor de lo que es») va junto al número, no en otra pestaña. |
| MR.UI.8 | 🟠 | **La base de impuesto de las palancas no está declarada.** Las palancas pasan a margen con `tasa = descuento / compras` sobre **$618,176,406 de compras** (`erp_goods_receipts.monto`), y el diccionario no dice si ese monto lleva IVA; la venta y el COGS van sin IVA. En Kepler el total del documento de compra (`c16`) trae IVA (FASE_RE; medición de RA del 23-oct). Si la base lo lleva, cada tasa sale ~14 % más chica y el «+3.84 pp» se subdeclara. | §1.6 · §4.5 | Cada monto de la cascada declara su base en el encabezado («sin IVA»). La base de compras se verifica contra un documento de Kepler antes de publicar los pp; si no se puede, la columna dice «base de impuesto sin verificar». |
| MR.UI.9 | 🟠 | **El puente cierra «por construcción» porque su último renglón absorbe la diferencia.** «Sin fuente todavía, vs objetivo 15 % −1.34 pp → Dirección» hace que la suma dé 15.0000 siempre: un renglón que siempre cuadra **esconde cualquier error de los de arriba** y, con responsable asignado, parece una palanca más. Aquí además es negativo: lo medible ya pasa el objetivo, y el texto dice «sin fuente». | §1.1 · §3.2 | El último renglón se llama «Diferencia contra el objetivo (no es una palanca)», va en estilo neutro, separado y sin responsable, y explica su signo en llano: «lo medido ya supera el objetivo por 1.34 pp». El smoke que verifica el cierre compara contra la suma de palancas medidas, no contra un residuo. |
| MR.UI.10 | 🟠 | **19 columnas por nivel contestan dos preguntas, y la segunda ya la contesta otra fase con otro universo.** §7 junta la cascada (venta, costo, tres márgenes, palancas, objetivo, brecha) con capital y abasto (inventario $/días, rotación, fill rate, cadencia, días de crédito). El inventario se valúa aquí en **$59.1M** (29-ago), en Sobrante de RA en **$62,981,663** (9-oct) y en el plan de RA en **$55.6M** (31-ago): tres cifras del mismo inventario sin que ninguna diga su base. | §4.0 A · §4.1 · §1.5 | La pantalla de margen se queda con la cascada; capital y rotación van a una segunda sección (`app-page-tabs`) o enlazan a Sobrante de RA con el mismo resolvedor de valuación. Ninguna tira de más de 6 cifras sin separador. Si dos pantallas valúan inventario, dicen su base (`cost_base` / costo de Kepler) y su fecha. |
| MR.UI.11 | 🟠 | **`promo_benefit` (2, 3, 4 o 5) viaja crudo, rotulado «unidad sin confirmar», en una tabla de porcentajes.** Un «3» junto a columnas de pp se lee como 3 %. La regla 7 del diccionario dice que lo que no tiene unidad confirmada no se publica con unidad; ponerlo entre porcentajes le presta una. | §1.1 · diccionario regla 7 · decisión #7 | Fuera de la rejilla. En el detalle del SKU, como texto: «Kepler marca una promoción tipo 3 (significado sin confirmar, decisión #7)». |
| MR.UI.12 | 🟡 | **Las palancas mezclan dos ventanas sin decirlo.** Venta y costo llegan hasta `data_as_of`; compras, pagos y promociones, hasta hoy (diccionario §5). La pantalla muestra `data_as_of`, pero no que las palancas van hasta otra fecha, y la tasa combina las dos. | §1.6 · §3.6 | Encabezado: «Venta y costo al [data_as_of] · descuentos y compras al [hoy]», con `app-freshness-pill` por fuente; la tasa se calcula sobre la misma ventana o lo dice. |
| MR.UI.13 | 🟡 | **Lo que se decidió retirar de la pantalla sigue «en este ciclo» desde el 31-ago.** MR.7.4 (quitar el spread por sucursal, el «4,922 productos, 0 discrepancias» tautológico, el «$X por unidad» del 8.6 % que no es pieza y el 11.32 % como medición) está 🔨 hace 56 días, con la pantalla en 🧪 local y la fase ⚠️ en el roadmap. | §1.1 · método de trabajo | Antes de pasar C3 a 🚀, revisión en nivel A con `auditoria-diseno` que compruebe que las cuatro afirmaciones ya no están en pantalla, en claro, oscuro y `forced-colors`. |

**Lo que esta revisión no cubre:** los simuladores (MR.7 de §8), que aún no tienen diseño —cuando lo
tengan, una cifra hipotética no puede verse igual que una medida—; contraste, densidad y teclado reales
(nivel A); y la colisión de numeración del plan (MR.7 y MR.9 nombran cosas distintas en §8 y en los
documentos de apoyo), que no es de pantalla pero confunde al citar estos criterios.
