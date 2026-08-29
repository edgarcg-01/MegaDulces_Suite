# MR.0 — Diccionario del margen

> **Estado:** 🧪 REDACTADO, **sin firmar** — 2026-08-29 · contrato de la Fase MR ([`FASE_MR`](FASE_MR_MOTOR_RENTABILIDAD.md)) · **ADR-051**
> **Qué es:** la definición única de cada componente del margen. El código lo implementa, **no lo define**.
> **Qué NO es:** documentación de la pantalla. Si el código y este documento discrepan, **el documento manda** y el código es el bug.
> **Evidencia:** todas las cifras salen de prod (`trolley`), ventana de 365 días, medidas el 2026-08-29.

---

## 0. Por qué existe y por qué llega tarde

El plan de fase abre diciendo que esto es el **primer** entregable y que la pantalla es el sexto.
Salió al revés: la pantalla se construyó primero y las ambigüedades se automatizaron. La
auditoría del 2026-08-29 encontró siete, y **cinco eran ambigüedades de definición**, no
errores de programación: qué costo usar, sobre qué denominador, con qué unidad, contra qué
objetivo, y qué hacer cuando una fuente está vacía.

Este documento cierra esas cinco. Las que quedan abiertas están en §6, con dueño.

**Falta la firma de Compras, Comercial, Marketing y Finanzas.** Hasta entonces es una
propuesta bien fundamentada, no un contrato.

---

## 1. La cascada canónica

Tres márgenes, tres dueños. Se publican por separado **a propósito**: si se publica uno solo,
se mezclan fenómenos de áreas distintas y nadie responde por la desviación.

| | Margen | Dueño | Prod 365d |
|---|---|---|---|
| 1 | **Comercial bruto** — lo que deja el producto antes de negociar | Comercial + Compras | **12.04%** |
| 2 | **Negociado** — más lo que el proveedor devuelve | Compras | **15.87%** |
| 3 | **Integral** — menos lo que devolvemos al cliente y lo que cuesta entregar | Dirección | **15.86%** ⚠️ incompleto |

```
  Venta con costo                                    $641,267,610
− Costo de lo vendido                                $564,084,850
──────────────────────────────────────────────────────────────────
= MARGEN COMERCIAL BRUTO                    12.04%    $77,182,760   → Comercial + Compras

+ Descuento comercial del proveedor                   $10,984,068   → Compras
+ Apoyo de marca / promocional                         $1,156,013   → Compras + Marketing
+ Pronto pago (nota de crédito)                          $757,175   → Compras + Finanzas
+ Bonificación / saldo a favor                           $123,655   → Compras
+ Descuento tomado al pagar (c84)                     $13,965,449   → Compras + Finanzas
   ↳ efecto en margen del periodo          +3.84 pp
──────────────────────────────────────────────────────────────────
= MARGEN NEGOCIADO                          15.87%                  → Compras

− Descuento otorgado al cliente             −0.01 pp       $71,924  → Comercial
− Promociones absorbidas por Mega Dulces         —      SIN FUENTE  → Marketing
− Costo logístico atribuible                     —      SIN FUENTE  → Logística
──────────────────────────────────────────────────────────────────
= MARGEN INTEGRAL (incompleto)              15.86%                  → Dirección

+ Descuento habitual que no se cobró        +0.48 pp    $3,380,032  → Compras
──────────────────────────────────────────────────────────────────
= TECHO CON LO MEDIBLE                      16.34%
  Sin fuente todavía, vs objetivo 15%       −1.34 pp                → Dirección
```

**El puente es aditivo por construcción** y el smoke lo verifica: la suma cierra contra el
objetivo en `15.0000`. Cinco números que no cierran son peor que ninguno.

> **Lectura de negocio que esto cambia.** La brecha que originó la fase (11.5% → 15%) es la del
> margen **bruto**. Contando lo que los proveedores ya devuelven, **el objetivo se cumple**. El
> problema real no es "no llegamos al 15%", es "llegamos gracias a las palancas y el bruto sigue
> en 12%". Requiere confirmación de Compras antes de darse por bueno.

---

## 2. Ficha por componente

### 2.1 Base — lo que se vende y lo que cuesta

| | **Venta** |
|---|---|
| Fórmula | `SUM(revenue)` en la ventana |
| Fuente | `analytics.sales_daily.revenue` ← `mart.ventas_enriched.importe` (Kepler) / `wincaja.v_sales_daily.importe` |
| Unidad | pesos, sin IVA |
| Nivel | producto × almacén × canal × día |
| Responsable | Comercial |
| Estado | ✅ vivo |

| | **Venta con costo** ⭐ |
|---|---|
| Fórmula | `SUM(revenue) FILTER (WHERE cost IS NOT NULL)` |
| Por qué existe | Es **el denominador de todos los márgenes**. Usar la venta total metería en el promedio renglones que no se pueden juzgar. |
| Cobertura prod | 99.9% de la venta |
| Estado | ✅ vivo |

| | **Costo de lo vendido (COGS)** ⭐ |
|---|---|
| Fórmula | `SUM(cost)` |
| Fuente | `analytics.sales_daily.cost` — **el costo que registró el punto de venta en la transacción** |
| **Regla dura** | **NUNCA `catalog.products.cost_base × unidades`.** `cost_base` es costo de catálogo y viene **por CAJA** en buena parte del catálogo, mientras las unidades vienen **por PIEZA**. |
| Evidencia | Con la fórmula vieja, 57 SKUs metían **$3,565,336 de COGS falso (10.0% del total)** sobre $386k de venta, y el margen publicado era 14.62% contra 11.32% real (30d). |
| Por qué el fact resuelve la unidad | Precio y costo salen de la **misma transacción**, en la **misma unidad en que se cobró**. No hay nada que normalizar. |
| Estado | ✅ vivo |

### 2.2 Palancas del proveedor — suman al negociado

Las cinco se leen **por `categoria`, no por doctype**. Sumar por doctype metería
`factura_duplicada` ($6.7M de error de captura) dentro del margen negociado.

| Componente | Fuente | Responsable | Prod 365d |
|---|---|---|---|
| Descuento comercial del proveedor | `erp_purchase_adjustments.categoria='descuento_comercial'` | Compras | $10,984,068 |
| Apoyo de marca / promocional | `…='apoyo_marca'` | Compras + Marketing | $1,156,013 |
| Pronto pago (nota de crédito) | `…='pronto_pago'` | Compras + Finanzas | $757,175 |
| Bonificación / saldo a favor | `…='saldo_favor'` | Compras | $123,655 |
| Descuento tomado al pagar | `erp_supplier_payments.descuento` (`c84`) | Compras + Finanzas | $13,965,449 |

| | **Conversión a margen** ⭐ (la regla que más se malinterpreta) |
|---|---|
| Problema | El descuento se gana sobre lo que se **COMPRA**; el margen se mide sobre lo que se **VENDE**. Sumar el monto crudo como puntos de venta da un número imposible (se midió: bruto 20.5% → "negociado" 32.4%). |
| Fórmula | `tasa = descuento / compras` · `efecto_en_margen = COGS × tasa` |
| Se lee | Sólo entra a margen **la parte de esa compra que ya se vendió**. |
| Base de compras | `erp_goods_receipts.monto`, excluyendo `dup_of_folio` (copias CEDIS). Prod 365d: **$618,176,406** |
| Estado | ✅ vivo |

| | ⚠️ **Riesgo de doble conteo** |
|---|---|
| Qué | El pronto pago llega por **dos canales**: nota de crédito (X-D-55) y `c84` al pagar. Si un proveedor usa los dos, parte puede ser el mismo dinero contado dos veces. |
| Acotación | El mínimo de ambos canales por proveedor = el máximo que podría duplicarse. |
| Prod 365d | **$656,757** en 17 proveedores = **2.4%** de lo negociado (≈0.09 pp). Acota el número, no lo invalida. |
| Se declara en pantalla | Sí, con enlace a `/compras/descuentos`. |

### 2.3 Restas — llevan al integral

| | **Descuento otorgado al cliente** |
|---|---|
| Fórmula | `SUM(descuento)` sobre facturas no canceladas |
| Fuente | `analytics.erp_sales_invoices.descuento` (encabezado) |
| **Sin doble conteo** | El fact registra `importe` **por línea** y este descuento es de **encabezado** → no estaba dentro del margen. Verificado en `import-sales-fact.js`. |
| Relación de totales | `total = subtotal + ieps − descuento` (cuadra exacto en prod) |
| ⚠️ Cobertura | **Sólo la venta facturada.** Prod 365d: $71,924 en 213 facturas sobre $21.2M facturados — contra $641M de sell-out. No cubre mostrador. |
| Atribución a SKU | ❌ No se reparte. Es de documento. |
| Responsable | Comercial · Signo `−` · Estado 🟡 **parcial** |

| | **Promociones absorbidas por Mega Dulces** |
|---|---|
| Fuente | `commercial.promotions` — **0 filas en prod** |
| Estado | ❌ **SIN FUENTE.** Se declara visiblemente ausente en la pantalla. |
| Qué haría falta | Capturar las promociones propias con su costo absorbido. Decisión de Marketing. |

| | **Costo logístico atribuible** |
|---|---|
| Fuente | `logistics.shipment_expenses` — **0 filas en prod** |
| Estado | ❌ **SIN FUENTE.** Declarado ausente. |
| Qué haría falta | Decidir el criterio de reparto del costo de entrega a producto o pedido. Decisión de Logística + Dirección. |

> **Regla dura:** un margen integral que omite un componente **en silencio** es peor que uno
> incompleto y honesto. Mientras falten estas dos, la pantalla lo rotula "incompleto" y las lista.

### 2.4 Recuperable — el renglón accionable

| | **Descuento habitual que no se cobró** ⭐ |
|---|---|
| Fórmula | por proveedor: `max(0, compras × tasa_habitual − cobrado)`, luego `COGS × (faltante / compras)` |
| Fuente de la tasa | `commercial.supplier_discount_policy.expected_discount_rate` |
| **⚠️ La tasa es una FRACCIÓN** | `0.0741` significa **7.41%**, no 0.0741%. Los 147 registros están entre 0.0019 y 0.0741. Dividirla entre 100 daba un esperado 100× menor y el panel **nunca podía marcar un faltante**. |
| **⚠️ La base son COMPRAS, no COGS** | El descuento se gana sobre lo que se compra. En 365d: $618M de compras contra $564M de COGS — no son intercambiables. |
| Comprobación de escala | HERSHEY: 7.20% habitual contra **7.21%** real. |
| **`source = 'observed'`** | La tasa es la que ese proveedor **viene dando**, NO un contrato firmado. Se lee *"está dando menos de lo que suele dar"*, no *"incumple lo pactado"*. **La diferencia importa antes de sentarse a reclamar.** |
| Prod 365d | **93 de 147 proveedores por debajo · $3,380,032** — MONDELEZ $991,321 (7.41% habitual vs 4.87% real) |
| Responsable | Compras · Signo `+` (recuperable) · Estado ✅ vivo |

### 2.5 Medidas de apoyo — no son márgenes

| | **Margen por unidad** |
|---|---|
| Fórmula | `precio_u = SUM(revenue_costed)/SUM(units_costed)` · `costo_u = SUM(cost)/SUM(units_costed)` · `margen_u = precio_u − costo_u` |
| **Mismo denominador** | Los dos lados van sobre `units_costed`, así el % unitario **coincide exacto** con el % de la fila. Verificado: 4,922 productos, 0 discrepancias. Dos porcentajes distintos en el mismo renglón matan la confianza en la tabla. |
| Unidad | Se rotula sólo con `sales_daily.unit_kind`: `weight` → "por kilo", `piece` → "por unidad vendida". **`catalog.products.unit_sale` NO se usa**: dice `PZA` donde Kepler dice `PAQ` en 5,906 de 8,708 productos. |
| Equivalencia por caja | `analytics.v_product_box_factor` (resolvedor canónico), **sólo** si `box_factor > 1` y no está marcado dudoso. En granel `c84` son kilos por bulto. |
| Nivel | **Sólo producto.** En agregados es `null`: promediar el precio de un paquete con el de un kilo no significa nada. |
| Estado | ✅ vivo |

| | **Inventario valuado y GMROI** |
|---|---|
| Fórmula | `SUM(quantity × cost_base)` · `GMROI = margen anualizado / inventario` |
| Fuente | `commercial.stock` × `catalog.products.cost_base` — regla canónica del proyecto para valuación/ABC/capital parado |
| Prod 365d | **$59,095,184 = 38 días de COGS.** Sano. |
| ⚠️ Calidad del costo | Se **contrasta** `cost_base` contra el costo del PdV: fuera de `[1/1.5, 1.5]×` el SKU se marca y **su GMROI se suprime**. Prod: **564 de 6,972 SKUs (8.1%), $11,423,059 de capital = 19.3%** valuado con un costo que el PdV contradice. |
| Grano | Se une **al mismo grano que la venta**. Unir el stock de red a un grano de sucursal lo multiplicaría (medido: $603M en vez de $57M, **10.6×**). Por canal **no existe** → `n/a`, nunca `$0`. |
| Estado | ✅ vivo, con calidad declarada |

| | **Promoción vigente al cliente** |
|---|---|
| Fuente | `analytics.erp_promotions.benefit` (`kdpv_descuxq`) |
| ⚠️ Estado | 🟡 **Unidad SIN CONFIRMAR.** Sólo toma los valores **2, 3, 4 y 5**. Se publica en crudo, **no como porcentaje**, y **no se resta del margen**. |
| Qué haría falta | Confirmar con quien captura `kdpv_descuxq` qué significa el campo. Decisión de Comercial. |

---

## 3. Reglas duras

1. **El costo sale del fact, nunca del catálogo.** `cost_base` sólo valúa inventario.
2. **El denominador de todo margen es la venta CON costo.** Lo que no trae costo se reporta como cobertura, no se diluye en el promedio.
3. **Un descuento de proveedor nunca se suma como puntos de venta.** Se convierte con `COGS × (descuento/compras)`.
4. **La unidad no se nombra más fino de lo que el dato permite.** `unit_kind` sí; `unit_sale` no.
5. **El factor de caja se lee de `v_product_box_factor`.** Nunca se deriva.
6. **Fuente vacía ≠ resultado en cero.** Si una fuente no tiene filas, se declara; no se dibuja un $0.
7. **Lo que no tiene unidad confirmada no se publica con unidad.**
8. **Toda medida se une al grano de su dimensión.** Cruzar granos multiplica en silencio.
9. **Los agregados devuelven `null` donde la medida no aplica**, no un cero.

---

## 4. Atribución — qué se puede repartir a SKU y qué no

La parte difícil del plan (§3.2) sigue siendo la misma: **una nota de crédito llega por
documento, no por SKU.**

| Componente | ¿Atribuible a SKU hoy? |
|---|---|
| Venta, costo, margen bruto, margen por unidad | ✅ Sí — el fact es por producto |
| Las 5 palancas del proveedor | ❌ **No.** Sólo existen a nivel proveedor y total |
| Descuento al cliente | ❌ No — es de encabezado de factura |
| Inventario, GMROI | ✅ Sí (producto × almacén) |

**Consecuencia:** el **margen negociado no existe por SKU**, y la pantalla no lo finge. Repartirlo
exige elegir un criterio (proporcional a compra del periodo · al SKU declarado en la nota · a la
línea original) y **ninguno está decidido**. Es la decisión §6.2.

---

## 5. Periodicidad y frescura

- El motor es **ventana móvil en vivo** (30 / 90 / 365 días), no mes cerrado.
- La venta y el costo llegan hasta `data_as_of` (máximo `sale_date` del fact); compras, pagos y promociones se leen hasta **hoy**. La pantalla muestra `data_as_of` para que la diferencia no sea invisible.
- ⚠️ `analytics.sales_daily` arranca el **2025-10-03**: la ventana de "12 meses" todavía no cubre 12 meses completos.

---

## 6. Decisiones que siguen abiertas

Las seis del plan (§10), con lo que la implementación ya resolvió:

| # | Decisión | Estado | Dueño |
|---|---|---|---|
| 1 | `cost_base` neto o bruto | 🟡 **Ya no bloquea el margen** (sale del fact). Sigue abierta para **valuación de inventario**: 8.1% de los SKUs tienen un costo que el PdV contradice | Compras |
| 2 | Criterio de atribución de X-D-55 y `c84` a SKU | 🔴 **Abierta.** Sin ella no hay margen negociado por producto (§4) | Compras |
| 3 | Origen del margen objetivo | 🔴 **Abierta.** Hoy es una constante editable en pantalla, default 15%. ¿Global, por proveedor, por categoría? ¿Quién lo captura y con qué vigencia? | Dirección |
| 4 | Alcance de "apoyo de Trade Marketing" | 🔴 **Abierta.** No entra a la cascada | Marketing |
| 5 | Costo logístico en v1 | ✅ **Resuelta: NO entra**, se declara ausente hasta tener fuente | Logística |
| 6 | Periodicidad | ✅ **Resuelta: ventana móvil en vivo**, no mes cerrado (§5) | Dirección |

Nuevas, salidas de la implementación:

| # | Decisión | Dueño |
|---|---|---|
| 7 | ¿Qué significa `erp_promotions.benefit` (2/3/4/5)? Sin esto no se puede restar del margen | Comercial |
| 8 | ¿Se acepta la tasa **observada** como referencia para reclamar a proveedores, o hay que capturar la pactada real? | Compras |
| 9 | ¿Se corrige el `cost_base` de los 564 SKUs en conflicto, o se acepta valuar 19.3% del capital con un costo no verificado? | Compras |
| 10 | El margen negociado ya supera el objetivo a 365d. **¿El objetivo del 15% es sobre el bruto o sobre el negociado?** Cambia si la fase está cerrada o no | Dirección |

> La **#10 es la más importante**: define contra qué se mide la empresa.

---

## 7. Firma

| Área | Responsable de | Firma |
|---|---|---|
| Compras | Palancas, tasa de referencia, costo de catálogo | ⬜ |
| Comercial | Venta, descuento al cliente, promoción vigente | ⬜ |
| Marketing | Apoyo de marca, promociones absorbidas | ⬜ |
| Finanzas | Descuento al pagar, pronto pago | ⬜ |
| Dirección | Objetivo, margen integral, residuo | ⬜ |

---

## Referencias

- [`FASE_MR_MOTOR_RENTABILIDAD.md`](FASE_MR_MOTOR_RENTABILIDAD.md) — plan de fase, §8.1 estado real
- **ADR-051** en [`02_DECISIONES_ARQUITECTURA.md`](../02_DECISIONES_ARQUITECTURA.md) — el costo sale del PdV
- Implementación: `libs/commercial/src/lib/commercial-profitability/` · pantalla `/comercial/rentabilidad`
- Smoke: `database/tests/http-profitability-test.js`
