# Fase MR — Motor de Rentabilidad (cascada de margen)

> **Estado:** 🔨 DISEÑADO (planeación) — 2026-08-21 · **ADR-048** propuesto
> **Tesis:** no es un reporte de margen. Es el **lenguaje económico común** de Mega Dulces:
> un sistema que explica *de dónde viene* el margen, *dónde se pierde* y *qué puede hacer cada área* para recuperarlo.
> **Meta de negocio:** margen actual ~**11.5%** → objetivo **15.0%**. Brecha **−3.5 pp**.

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
| **MR.0** | **Diccionario del margen firmado** — ficha por componente (§3.2) + regla de atribución + decisión neto/bruto (§2.2). **Sin código.** | — |
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
