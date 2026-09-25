# Fase IG — Ingresos contables

> Plan de implementación. Estado: **🔨 DISEÑADO (planeación) 2026-09-25**. Sin código.
> Hermana de **GX** (egresos contables, `/finanzas/egresos`). Todo lo medido acá salió de consultas
> de **solo lectura contra prod** el 2026-09-25.

---

## 0. El pedido, y dónde choca con el dato

El pedido fue *"una interfaz igual pero para los ingresos"*. La interfaz sí se reusa casi entera.
**Las dimensiones no**, y el filtro que las hace correctas es justo el que en Egresos no existe.

### Lo primero que se midió: qué pasa si se copia el WHERE

| qué se contaría | agosto 2026 |
|---|---:|
| balanza familia 4, **todas** las sucursales ← el espejo literal | **$94,061,828.00** |
| sólo CEDIS (`sucursal='00'`) | $61,903,631.74 |
| **sólo CEDIS + sólo `UD1301`** ← la regla canónica | **$55,940,323.96** |
| `mv_sales_blended` (hecho de venta, testigo independiente) | $54,265,356.22 |

**Un espejo ingenuo publicaría +69 %.** No por un bug: porque el modelo contable del ingreso es
distinto al del gasto y ya está decodificado y verificado en
[`KEPLER_CONTABILIDAD_MODELO.md` §Familia 4](../KEPLER_CONTABILIDAD_MODELO.md).

### Las tres reglas duras (ya verificadas, no se re-discuten)

1. **Sólo CEDIS (`c14='00'`).** La venta se contabiliza **centralizada** en CEDIS con todas las
   plazas en el concepto `c6`. Las DBs de sucursal **replican** esas mismas ventas: sumar las 6
   duplica ~$62M. La cobranza `UA0501` sólo cuadra con CEDIS.
2. **Sólo el documento `UD1301`** («Factura Cred No Fiscal», confirmado contra `kdmm`). Los otros
   doctypes en 401 (`UD1201` notas ~$10M, `0000`, `XA1001` bajas) **no son venta**.
3. **El canal se clasifica por `c6`, NUNCA por el nombre de la subcuenta.** Medido: `401-003` es
   *«VENTAS VECINAL»* en unas sucursales y *«VENTAS MAYOREO»* en otras; `401-002` —que concentra
   todo el detalle 2026— se llama *«VENTA FLETES A TERCEROS»* y **no es fletes**. Los nombres
   mienten; el canal vive en `c6` (`P.V.` mostrador · `TLMKT` telemarketing · `R.D.`/`RUTA` ruta ·
   `R.V.` reparto vecinal).

> ⚠️ **Registro de una hipótesis REFUTADA, para que nadie la reconstruya.** Al ver que la
> contraparte (`c6`) del renglón más grande son *«P.V. Morelia Abastos»*, *«TLMKT Canindo»*, etc.,
> la lectura obvia es «el CEDIS le factura a sus propias sucursales» y hay que excluirlo como
> traspaso interno — el equivalente al *Fix#B* de Egresos. **Es falso.** Esos nombres son la
> **plaza donde ocurrió la venta al público**, no un cliente interno. Excluirlos borraría la venta
> real. El doble conteo no viene del concepto: viene de **leer las 6 DBs de sucursal**.

### Por qué las dimensiones de Egresos casi no miden acá

| dimensión en `/finanzas/egresos` | del lado del ingreso |
|---|---|
| `sucursal` | **un solo valor** (`00`) — es el filtro, no una dimensión |
| `cuenta` / `cuenta_mayor` | **6 cuentas**, con nombres que mienten (regla 3) |
| `beneficiario` | acá `c6` no es contraparte: es **canal + plaza** |
| `area` / `dpto` / `concepto` | vienen del ciclo de solicitud de gasto → **vacías** |
| `doc_tipo` | sólo uno cuenta (`UD1301`); el resto se excluye |
| `mes` | ✅ igual |

Lo que sí discrimina: **canal → plaza → documento → cliente → vendedor**.

---

## 1. Tesis

> **Se reusa la interfaz y el motor; se cambian las dimensiones. Y no se construye ni un feed:
> todo el dato ya existe, ya corre y ya late — sólo que ninguna pantalla lo consume.**

Hereda ADR-056 (el número declara con qué se calculó), ADR-059 (se arbitra, y lo que no se puede
arbitrar se declara) y la ⭐ regla del proyecto (cero importers nuevos).

---

## 2. Inventario: lo que YA existe y no se vuelve a construir

| activo | qué es | estado medido |
|---|---|---|
| `analytics.sales_by_channel_monthly` | venta contable reclasificada por **canal × plaza × mes** | **vivo y huérfano**: 782 filas, 2025-07→2026-09, 6 canales, 291 plazas, $495.5M. Latido `feed_nightly/import-sales-by-channel.js` **verde hoy 03:35**. ⛔ **cero consumidores en `libs/` y `apps/`** |
| `analytics.erp_sales_invoices` | **VISTA viva** sobre `kepler_ods` (Fase AX) | trae cliente, RFC, vendedor, canal, total, IEPS, descuento, **saldo, cobrado, estatus_cobro**, vencimiento, días de crédito |
| `analytics.erp_sales_invoice_lines` | renglones de la factura | el drill al producto, sin importer |
| `analytics.erp_collections` | **VISTA** de cobranza `UA0501` (Fase CC) | la tercera pata del cuadre. Agosto: $43,930,836.96 |
| `analytics.ledger_monthly` | balanza fam 1-9 | el **árbitro contable** del número publicado |
| `analytics.mv_sales_blended` | hecho de venta consolidado | el **árbitro independiente** (otro camino, otra fuente) |
| `expense-coverage.ts` | cobertura + comparativo, lógica pura | **`[GX.19]`, recién construido y probado** — se reusa **verbatim**, no se copia |
| `stepAt()` en `platform-core` | edad de un paso desde `cron_run_log` | **`[GX.19]`** — sirve igual para `import-sales-by-channel.js` |
| `FreshnessPillComponent`, `MetricStripComponent`, `SegmentedComponent`, `LoadStateComponent`, `egresChartOptions` | organismos de la pantalla de Egresos | se reusan tal cual |

**Nada de esto exige un feed nuevo.** Lo único que falta es la capa de lectura y la pantalla.

---

## 3. Lo que se DECLARA y no se dibuja (ADR-056)

Cuatro huecos medidos. Ninguno se esconde ni se rellena con ceros.

1. **2025 no es comparable.** Fue presupuesto: no hay `UD1301`. El selector puede ofrecer esos
   meses, pero la pantalla declara que ese tramo no es venta real.
2. **Reclasificación interna de $54.67M** (`'VENTAS ABRIL 26'`, vive en `kdc22603`, neto $0). Si
   entra sin declararse, marzo aparece ~1.8× de lo que fue.
3. **El bucket `otro` son 260 de las 291 plazas y $35.8M/2026** — crédito individual sin prefijo de
   canal. Es residuo del clasificador, no una plaza. Se muestra agrupado y **etiquetado como
   residuo**, nunca desglosado como si fueran 260 puntos de venta.
4. **La deriva de universo es idéntica a la de Egresos** — medido: 1 sucursal hasta nov-2025,
   luego 2·3·4·5·5·5·6·6·7·9. El mismo `expense-coverage.ts` la resuelve.

### ⛔ Y el que bloquea el «Resultado»

**No hay costo de ventas real desde mayo-2026.** El sistema es de inventario periódico
(`Costo = 509 inicial + 511 compras + 514 + 517 − 512 − 513 − 516 final`) y **el cierre se cortó en
abril**. Medido en CEDIS:

| mes 2026 | inv. inicial (509) | inv. final (516) | compras (511) |
|---|---:|---:|---:|
| ene–abr | ✅ | ✅ | ✅ |
| **may–sep** | **—** | **—** | ✅ |

Consecuencia directa: `ingresos − egresos` para agosto daría **$55.9M − $61.6M = −$5.7M**, o sea
una pérdida que **no existe** — porque $55.4M de esos «egresos» son **compras**, no costo de lo
vendido. Dibujar ese número sería exactamente lo que esta arquitectura existe para impedir.

---

## 4. Sprints

### `[IG.0]` — Fijar el contrato del dato (sin UI) ⬜

Ruta crítica. Nada se construye encima hasta que esto cierre.

- `[IG.0.1]` Vista `analytics.v_income_entries` **derive-no-copy** sobre `kepler_ods.kdc2YYMM`, con
  las tres reglas duras adentro y la clasificación de canal **leída de `sales_by_channel_monthly`**
  (no re-implementada: la función `classify()` del importer es la fuente y se mueve a un módulo
  puro compartido, o la vista se apoya en la tabla ya clasificada).
  ⚠️ **Decisión abierta (D1):** vista sobre el ODS *(fresca al minuto, pero expuesta a
  `AUD-ODS-01`)* **o** leer `sales_by_channel_monthly` *(nocturna, pero ya validada y sin el
  hueco)*. Recomendación: **la tabla para los agregados, la vista para el drill** — y declarar las
  dos frescuras por separado, que es lo que `composeFreshness` ya hace.
- `[IG.0.2]` **Candado de paridad** `test-newdb-income-parity.js`: el número de la vista contra
  `ledger_monthly` (árbitro contable) y contra `mv_sales_blended` (árbitro independiente), con
  **tercer estado**: lo que no se pueda medir reporta `NO MEDIDO`, no ✔. Tolerancia declarada, no
  inventada: hoy A vs D difieren **0.14 %** y A vs B **3.0 %**.
- `[IG.0.3]` Prueba negativa: quitar el filtro `sucursal='00'` y verificar que el candado se pone
  **rojo** (tiene que saltar el +69 %). Un gate sin prueba negativa es una intención.

### `[IG.1]` — Backend: el reporte ⬜

- `[IG.1.1]` `GET /analytics/income` — mismo motor que `expenses()`: `group_by` =
  `canal | plaza | cliente | vendedor | mes`, filtros `from/to`, `canal`, `plaza`, `cliente`,
  `min/max importe`, `compare`.
- `[IG.1.2]` `GET /analytics/income/tree` — **canal → plaza → documento**.
- `[IG.1.3]` `freshness` (con `stepAt` sobre `feed_nightly/import-sales-by-channel.js` + la tabla)
  y `coverage` (**reusando `computeExpenseCoverage`**, que ya es genérico: recibe
  `{mes, sucursal, total}` y acá recibe `{mes, plaza, total}`).
  ⚠️ Si se reusa, se **renombra el módulo** a `period-coverage.ts` — el nombre `expense-*` sería
  mentira en cuanto lo use un segundo dominio.
- `[IG.1.4]` Permiso. **No se inventa uno**: `FINANCE_INCOME_VER`, repartido calcando a
  `FINANCE_EXPENSES_VER` desde el estado vivo. ⚠️ Lección `[LC.6.2]`: **un módulo no está entregado
  hasta que su permiso está REPARTIDO en prod**, no sólo declarado en el enum.

### `[IG.2]` — Frontend: la pantalla ⬜

`/finanzas/ingresos`, tab hermano de Egresos en `finanzas-tabs.ts`.

- Árbol canal→plaza→documento · tabla dinámica · tendencia · píldora de frescura · banda de
  cobertura · exportar CSV. Todo reusando los organismos de `[GX.19]`.
- KPIs: **facturado** · **cobrado** · **por cobrar** · ticket promedio · nº de documentos.
  Los tres primeros salen de `erp_sales_invoices` sin ningún cálculo nuevo.

### `[IG.3]` — El cuadre de fuentes (el organismo que hoy no existe en ninguna pantalla) ⬜

Una pestaña que responde *«¿este número es confiable?»* poniendo las cuatro fuentes juntas, que es
lo que ADR-059 pide y hoy sólo se puede hacer preguntándole a Maat. Medido, agosto 2026:

| fuente | agosto 2026 | Δ vs contable |
|---|---:|---:|
| **A · contable** (401 CEDIS UD1301) | $55,940,323.96 | — |
| **D · por canal** (`sales_by_channel_monthly`) | $55,863,192.60 | **−0.14 %** |
| **B · hecho de venta** (`mv_sales_blended`) | $54,265,356.22 | −3.0 % |
| **C · cobranza** (`erp_collections`) | $43,930,836.96 | −21.5 % ← **no es discrepancia**: es DSO + mezcla de crédito |

Valor: A y D cuadran al 0.14 % (se validan mutuamente), B confirma por un camino completamente
distinto, y C **no debe compararse de frente** — la pantalla tiene que decirlo, o alguien va a leer
«faltan $12M de cobranza».

### `[IG.4]` — Drill al documento ⬜

Reusar `analytics.erp_sales_invoices` / `_lines`. **Antes de construir**: `/comercial/documentos`
(Fase AX) ya lee esas vistas. Si cubre el caso, esto es un **enlace**, no una pantalla.
⚠️ Verificar primero; duplicar la superficie de lectura sobre el mismo documento es deuda.

### `[IG.5]` — Resultado (ingresos − egresos) ⚠️ ACOTADO ⬜

No se entrega un número falso. Tres piezas, en orden de honestidad:

- `[IG.5.1]` **Resultado contable ene–abr 2026**, donde el costo de ventas existe. Se entrega
  completo y cuadrado contra la balanza.
- `[IG.5.2]` **May–sep: se DECLARA el hueco** con su dueño. La banda dice *«sin costo de ventas
  desde mayo-2026: el cierre de inventario no se ha hecho»* y **no publica utilidad**.
- `[IG.5.3]` *(opcional, si Dirección lo pide)* **Resultado operativo** con el COGS del hecho de
  venta (`analytics.sales_daily.cost`) en vez del contable. ⚠️ Rotulado como **operativo, no
  contable**, y con la salvedad de la **enmienda de ADR-051**: la mitad Kepler de ese costo es
  `revenue/(1+markup)`, álgebra ciega al precio que subdeclara ~2.02 pp.

### `[IG.6]` — Cierre ⬜

Regresión, tracker, log, CHANGELOG, y la validación visual que a `[GX.19]` le quedó pendiente —
las dos pantallas juntas, en el navegador.

---

## 5. Orden sugerido y por qué

`IG.0` → `IG.1` → `IG.2` → `IG.3` → `IG.4` → `IG.5`.

`IG.0` es ruta crítica: sin el candado de paridad, cualquier cosa construida encima puede publicar
el +69 % y nadie se entera. `IG.3` va **antes** del drill porque es lo que más valor agrega por
línea de código: el dato ya está, sólo hay que ponerlo lado a lado.

---

## 6. Decisiones abiertas

| # | decisión | recomendación |
|---|---|---|
| **D1** | Origen de los agregados: vista sobre el ODS (fresca, expuesta a `AUD-ODS-01`) vs `sales_by_channel_monthly` (nocturna, validada) | **La tabla para agregados, la vista para el drill**, declarando las dos frescuras |
| **D2** | ¿`/comercial/documentos` ya cubre el drill de `IG.4`? | Medirlo antes de escribir una línea |
| **D3** | ¿El «Resultado» filtra `sucursal='00'` también del lado del **gasto**? | Sí, o no cuadra — pero cambia el total que hoy publica `/finanzas/egresos`, así que **es decisión de Dirección**, no técnica |
| **D4** | ¿Quién retoma el cierre de inventario? | Sin eso `IG.5` queda acotado a ene–abr **para siempre** |

---

## 7. Riesgos

- **El más caro**: que alguien "simplifique" quitando el filtro de CEDIS o el de `UD1301` porque
  «faltan ventas». Por eso el candado de `[IG.0.2]` y su prueba negativa van **primero**.
- `AUD-ODS-01` (hueco de `kdc2` en el ODS) pega también acá si se elige la vista en D1.
- Reusar `expense-coverage.ts` sin renombrarlo deja un módulo llamado `expense-*` sirviendo a dos
  dominios: deuda de nombre que envejece mal.
