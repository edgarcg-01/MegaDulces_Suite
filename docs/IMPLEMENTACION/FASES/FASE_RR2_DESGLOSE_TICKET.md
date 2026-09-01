# Fase RR.2 — Desglose por ticket, unidad de venta y margen en `/ventas-por-ruta`

> **Estado:** 🧪 EN CÓDIGO (beta local) · 2026-08-31 · RR2.0 + RR2.2 + RR2.3 + RR2.4 + RR2.6 ✅ · RR2.1 y RR2.5 diferidos (ver §4)
> **Pendiente prod:** 1 migración a Railway + backfill de los importers + redeploy api/view. Ver §6.
> **Antecede:** RR (Ventas por Ruta) — ver [`project_fase_rr_ventas_por_ruta`] en la memoria y los feeds `import-wincaja-routes-monthly` / `import-route-push-*` / `import-kepler-vecinal-routes`.
> **Objetivo:** que el side-peek de una ruta explique **el ticket** (qué se vendió, **en qué unidad**, a qué precio, con qué margen, a qué hora, cómo se pagó) en vez de sólo importes agregados.

---

## 1. Cómo funciona hoy

| Capa | Archivo | Qué hace |
|---|---|---|
| UI | [`comercial-ventas-por-ruta.component.ts`](../../../apps/view/src/app/modules/comercial/pages/comercial-ventas-por-ruta.component.ts) | Matriz sucursal×ruta × mes + KPIs + filtros de vista client-side. Click en la ruta abre `app-side-peek` con 4 pestañas: Productos (top 50) · Por día · Clientes (top 50) · **Tickets (últimos 100)**. |
| API | `GET /commercial/analytics/sales-by-route[.xlsx]`, `/routes`, `/products`, `/clients`, `/detail` — [`commercial-analytics.controller.ts:781-900`](../../../libs/commercial/src/lib/commercial-analytics/commercial-analytics.controller.ts) | |
| Servicio | `salesByRoute()` + `salesByRouteDetail()` — [`commercial-analytics.service.ts:3818-4038`](../../../libs/commercial/src/lib/commercial-analytics/commercial-analytics.service.ts) | **Path A** (default): matriz pre-agregada de `analytics.sales_by_route_monthly` (`route_code LIKE 'WIN-%'`). **Path B** (filtro sku/cliente): re-agrega desde la tabla-hecho. El detalle sale 100% de `analytics.v_route_sales_lines`. |
| Vista unificada | `analytics.v_route_sales_lines` (migs `20260727130000` → `20260728120000`) | **UNION ALL de 3 tramos**, proyectada a **10 columnas**: `tenant_id, source_branch, sale_channel, business_date, sku, qty, importe, consecutivo, doc_ref, cliente`. |

**El cuello de botella es esa proyección de 10 columnas.** La riqueza existe abajo y se descarta ahí:

```
wincaja.detalles_mov_almacen   →  wincaja.v_sales_lines  →  analytics.v_route_sales_lines
 (18 cols: costo, iva, ieps,       (19 cols: + costo,        (10 cols — se pierde costo,
  desc1/2, tipo_precio,             vendedor, caja, cajero)    iva, hora, vendedor, cajero)
  unidad_venta, cant_auxiliar)
```

### Los 3 tramos de la unión (verificado en prod, 2026)

| # | Tramo | Rutas | Ventana | Fuente física |
|---|---|---|---|---|
| 1 | Venta a bordo Wincaja | `21,22,23,26,27,28` (suc 10) · `321,322` (32) · `501–505` (50) | ene → jun/ago según ruta | `wincaja.*` (bronze del `.mdb` por ruta) |
| 2 | Push de camionetas | `21–28` desde ~2026-06-29 | jul → hoy | `.249:5433/kepler_consolidado` → `mart.ventas` (cada camioneta corre su Kepler local y empuja cada 15 min) |
| 3 | Rutas vecinales Kepler | `1V001, 1V002` (suc 01) · `1V003` (02) · `1V004` (04) | abr/jun → hoy | `md.kdm1/kdm2` doctype **U/D/10**, ruta en `c12` — hoy vía importer batch a `analytics.route_push_lines` |

---

## 2. De dónde sale cada dato (matriz verificada, no supuesta)

Sondas read-only contra prod (`trolley`) y contra el runner `.249`. **Ninguna columna se usa sin haberla contrastado.**

| Dato que aporta valor | Tramo 1 · Wincaja | Tramo 2 · Push | Tramo 3 · ODS Kepler |
|---|---|---|---|
| **Unidad de venta por LÍNEA** | ❌ no existe (ver §3.1) | ✅ `mart.ventas.unidad` | ✅ `kdm2.c11` |
| **Unidad de venta por SKU** | ✅ `wincaja.articulos.unidad_venta` — PZA 4,725 sk / KGS 74 / CJA 27 | (idem catálogo) | ✅ `kdii.c11` |
| Factor de caja (equivalencia) | `analytics.v_product_box_factor` (por `product_id`) · respaldo `articulos.factor_venta` | idem | idem + `kdii.c84` |
| Precio unitario | derivable `importe/qty` | ✅ `precio_neto` | ✅ `kdm2.c12` |
| **Costo → margen** | ✅ `valor_costo` (**extendido**, ver §3.2) → margen 13–16% por ruta | ❌ no viaja en el push | ❌ (habría que traer `kdik.c16`) |
| IVA / IEPS por línea | ✅ `iva` (30% de líneas ≠ 0), `ieps` | ❌ | doc-level `kdm1.c15` |
| Descuento por línea | ✅ `descuento1/2` (sólo ~0.9% de líneas) | ❌ | doc-level `kdm1.c13/c19` |
| **Hora del ticket** | ✅ `maestro.hora` (serial Access `1899-12-30T08:01:46` → `HH:MM` parseable) | ❌ | ❌ |
| Vendedor / cajero / caja | ✅ `vendedor`, `cajero`, `caja` | ❌ | ✅ `c12` + `kduv.c3` |
| Cliente | ✅ `tercero` ⋈ `wincaja.clientes` | ✅ `erp_customer_ref` (en `mart.ventas` viaja mal-nombrado como `forma_pago`) | ✅ `c10` ⋈ `kdud` |
| **Forma de pago** | ✅ `wincaja.pagos_dia` — cobertura **100%** (ver §3.3) | ✅ `ventas_enriched.channel` | `kdud.c16` = días de crédito |
| Ticket vs Factura | ✅ prefijo de `documento`: **T** 141,437 docs / **F** 692 | folio pelón | ✅ `doc_prefix` |
| Nº de líneas / SKUs por ticket | ✅ | ✅ | ✅ |

---

## 3. Hallazgos que cambian el diseño

### 3.1 ⛔ `detalles_mov_almacen.unidad_venta` (0/1) **NO es la unidad de venta**

Está poblada al 100% en las 986k líneas de ruta, con dos valores: `0` (950,773 líneas) y `1` (35,542). La tentación es leerla como peldaño de la escalera de unidades. **Se probó y no lo es:**

- 602 SKUs se vendieron con **ambos** códigos. La razón `precio_unitario(0) / precio_unitario(1)` se pega a **1.00 en 562/602 (93%)**, mediana 1.00.
- Contra `articulos.factor_venta` (promedio 17.6): la razón coincide con `fv` en **0 casos** y con `1/fv` en **0 casos**.

→ **Conclusión:** es un flag interno de Wincaja; ambos códigos operan sobre la **misma** unidad. Usarlo como unidad habría fabricado un error de ~17× — exactamente el bug de CANON.0.1. **El rótulo de unidad del tramo Wincaja se lee de `wincaja.articulos.unidad_venta`** (PZA/KGS/CJA/SER), que sí tiene varianza real y **lo dice la fuente**.

También descartados por vacíos: `cantidad_auxiliar` = 0 en 986k/986k · `tipo_precio` = `'1'` constante (dato en sí: la ruta vende siempre a un solo nivel de precio).

### 3.2 `valor_costo` y `valor_venta` son montos **extendidos** de la línea, no unitarios

`sum(valor_costo)` directo da margen **13.0–16.1%** por ruta (creíble para distribución). Multiplicarlo por `cantidad_regular` da margen **−93% a −1,234%** (absurdo). Verificado también en la muestra: qty 3 · `valor_venta` 89.80 = 3 × 29.93.
→ Margen = `1 − Σvalor_costo / Σvalor_venta`. Coincide con la regla del repo: **el costo es el del PdV**, nunca `cost_base × units`.

### 3.3 `pagos_dia` se une por `documento`, **no** por `consecutivo`

`pagos_dia.folio` empata con `maestro.documento` en **59,262/59,262** filas y con `consecutivo` en **0**. Cobertura de tickets del año: **100%** en las 13 rutas.
Composición real: prácticamente todo **Efectivo** (`forma_pago='1'`), con 4 excepciones (Vales interno, 1 Cheque). ⚠️ **Los códigos de forma de pago difieren por sucursal** (en suc 10: `3`=Crédito, `5`=Tarjeta; en la ruta 21: `3`=Tarjeta, `4`=Crédito) → resolver siempre por `(source_branch, forma_pago)` contra `wincaja.formas_pago`, nunca por código pelado.
`cobranza` y `propina` vienen en 0 → no aportan.

### 3.4 El tramo 3 puede salir del ODS **en vivo** (y así gana unidad por línea)

`kepler_ods.kdm1/kdm2` ya tiene U/D/10 con `c12 = 1V001/1V002/1V003/1V004/3V001` y fecha máxima **2026-08-31** en suc 01/03/05/06. `kdm2.c11` trae la unidad por línea (censo: PAQ 2.37M · PZA 1.09M · KG 186k · 500 · 250 · CJA · CUB · 400 · 2KG · BTO).
→ Se puede reemplazar el tramo importer-batch por una **vista derivada del ODS** (regla del repo: todo lo derivable sale del ODS; frescura ~seg en vez de nightly). El decode de unidades ya está resuelto y probado en la **Fase AX** (`kdm2.c11` passthrough, cero unidades inventadas; `c84` sólo si la línea se vendió en la unidad del catálogo y el bulto difiere) → **se reusa, no se reinventa**.

### 3.5 Huecos de cobertura detectados (no son parte del pedido, pero hay que decirlos)

- **`3V001`** (suc 05, $1.04M, 571 tickets, al día) existe en el ODS y **no aparece** en `/ventas-por-ruta`.
- Rutas `501–505` y `321/322` están **congeladas** (última venta 2026-08-10/11 y 2026-06-01/30): el `.mdb` dejó de llegar. Es el patrón ya documentado (feed vivo ≠ proceso vivo).
- Hay **fechas futuras corruptas** en el bronze (ruta 22 con `2026-12-06`, suc 00/02 en `kdm1` con dic-2026). El código ya se protege con `business_date <= CURRENT_DATE`; mantener ese guardrail en todo lo nuevo.

### 3.6 Regla de honestidad para la UI

El costo, la hora, el IVA y el descuento **sólo existen en el tramo Wincaja**. Un ticket de julio de la ruta 23 no tiene margen porque el push no lo trae.
→ Cada línea/ticket lleva su `source` (`wincaja` | `push` | `ods`) y la UI **declara "sin dato en la fuente"** en vez de dibujar $0 o 0%. Un margen agregado que mezcle tramos sería falso; se calcula sólo sobre la porción con costo y se rotula con su cobertura ("margen sobre 62% de la venta del periodo").

---

## 4. Plan de implementación

MVP = **RR2.0 → RR2.4**. Ruta crítica: RR2.0 (todo lo demás cuelga del contrato de la línea).

| Item | Qué | Entregable |
|---|---|---|
| **RR2.0** ✅ | **Ampliar el contrato de la línea.** Mig [`20260831120000_rr2_route_line_enrichment.js`](../../../database/migrations-newdb/20260831120000_rr2_route_line_enrichment.js). Se partió por riesgo: a `wincaja.v_sales_lines` sólo se le **appendearon columnas passthrough** de tablas que ya tenía joineadas (`product_id`, `iva`, `ieps`, `descuento1/2`, `hora_raw`) — cero joins nuevos, WHERE intacto, `CREATE OR REPLACE` (no DROP: `v_sales_daily` depende de ella) ⇒ sell-out/Thot/RA/Command Center no se mueven. Todo el enriquecimiento con joins vive en `analytics.v_route_sales_lines` (30 columnas, `security_invoker=true`, 3 tramos, `source` por línea). | 1 mig + smoke 28/28 estructural + invariante medida en prod (§5) |
| **RR2.1** ⏸️ | **Diferido — dejó de ser ruta crítica.** Su motivo era darle unidad por línea a las rutas vecinales; RR2.2 ya lo consigue leyendo `d.c11` en el importer. Lo que queda es una mejora de **frescura** (vista en vivo sobre el ODS en vez de importer nightly) + destapar `3V001`, no del desglose. | — |
| **RR2.2** ✅ | **Enriquecer el push.** Mismas 2 columnas en `analytics.route_push_lines` (`unidad`, `precio_unitario`), llenadas por los **dos** importers: `import-route-push-lines.js` (ahora lee `mart.ventas_enriched` — mismo universo verificado: 53,429 líneas / 1,761 folios / $5,660,101.61 — para tomar `unidad`, `precio_neto` y el cliente REAL de `erp_customer_ref`, retirando el parche que lo sacaba de la columna mal-nombrada `forma_pago`) y `import-kepler-vecinal-routes.js` (`d.c11` / `d.c12`). | 2 importers |
| **RR2.3** ✅ | **Endpoints.** `GET …/sales-by-route/tickets` (paginado server-side; `route` **obligatoria**: medido en prod, 1 ruta × 1 mes = 1.9 s vs barrido anual de todas = 110 s) + `GET …/sales-by-route/ticket?key=…`. Los filtros de LÍNEA (sku/unidad) eligen **qué tickets salen** pero los totales del ticket siguen completos — un total recortado al filtro sería una cifra falsa. `salesByRouteDetail` además devuelve ahora `units_mix` y `margin`. | 2 endpoints + tipos + controller |
| **RR2.4** ✅ | **UI.** Pestaña **Tickets** = tabla paginada lazy (orden server-side por fecha/importe/líneas/margen, búsqueda folio/cliente, filtros de unidad y tipo) con drill master-detail al ticket: renglones con unidad, precio unitario, equivalencia en cajas, importe y margen; cabecera con hora, cliente, forma de pago, vendedor. Nueva pestaña **Unidades**. KPI **Margen** con su cobertura. | componente + service |
| **RR2.5** ⏸️ | Diferido: XLSX a nivel ticket y línea (hoy exporta la matriz). | — |
| **RR2.6** ✅ | Smoke [`test-newdb-route-ticket-detail.js`](../../../database/tests/test-newdb-route-ticket-detail.js) registrado en `run-all-tests.js`, con los 4 candados de §3 + el de regresión de `v_sales_lines`. | 28/28 local |
| RR2.7 ⏸️ | Diferido: costo del tramo push (traer `kdik.c16` por sucursal); reponer la frescura de `501–505`/`321/322`; destapar `3V001`; conciliar ticket-de-ruta ↔ corte de vendedor (ya existe `RouteClosureRecon`). | |

### Riesgos

1. **Recrear `wincaja.v_sales_lines`** la consumen sell-out, Thot, Command Center y RA (demanda). Toda columna nueva es **aditiva** y el `WHERE` no cambia; el smoke debe verificar que los totales por sucursal/mes **no se mueven ni un centavo** antes y después.
2. **Costo del joins de `pagos_dia`**: 1 fila por ticket, join por `(source_branch, documento)` — hay índice `ix_wcj_pagos_folio`. Medir el patrón real (no `count(*)`); si la vista pasa de ~1 s, pasar a fn/matview híbrido.
3. **Rutas de la unión con llaves distintas** (`consecutivo` en Wincaja vs `folio` en el push): la clave del drill al ticket debe ser `(source, source_branch, business_date, doc_key)`, no `consecutivo` a secas.

---

## 5. Verificación

**Sondas** (read-only contra `FLEET_DB_URL` = prod y `.249:5433/kepler_consolidado`): población y valores distintos de `unidad_venta`/`tipo_precio`/`cantidad_auxiliar`; razón de precio 0-vs-1 contra `factor_venta`; unidad real por SKU en `articulos`; prefijo T/F; cobertura y llave de `pagos_dia`; catálogo `formas_pago` por sucursal; margen directo vs ×qty; columnas y censo de unidades de `mart.ventas`/`ventas_enriched`/`route_sales_stg`; U/D/10 + `kdm2.c11` en `kepler_ods`; semántica de `v_product_box_factor` (`unit_base` = la unidad que cuenta el factor); frescura por ruta y sucursal.

**Invariante (lo que más importa): el enriquecimiento no movió un centavo.** Se corrió el cuerpo del `SELECT` nuevo como consulta ad-hoc contra prod y se comparó con la vista viva, por ruta, año en curso:

| Ruta | Δ líneas | Δ importe |
|---|---|---|
| 321, 322, 501, 502, 503, 504, 505 | **0** | **$0.00** |
| 21, 22, 23, 26, 27, 28 | −8,361 / −7,840 / −10,168 / −8,771 / −8,130 / −6,997 | −914,233.61 / −835,828.83 / −1,069,642.48 / −855,986.35 / −997,447.58 / −658,548.32 |

Las rutas puras dan delta exacto 0. En 21–28 el delta **es exactamente** el tramo push (ruta 21: $914,233.61 vs los $914,234 de `route_push_lines`), que el `SELECT` de comparación no incluía y la vista nueva sí conserva en su tramo 2 → invariante cumplida en los 13.

**Cobertura del enriquecimiento** (tramo Wincaja, 357,602 líneas del año): unidad 100% · hora 100% · tipo T/F 100% · forma de pago 100% · costo 100% · margen 14.4%. **Mezcla por unidad:** PZA 97.7% · KGS 2.1% (granel) · CJA 0.2%. **Sin duplicación:** 357,602 = 357,602.

**Rendimiento** (patrón real, no barrido): 1 ruta × 1 mes = 1.9 s (base 0.66 s) · 1 ruta × año = 11.2 s. El costo está localizado: el LATERAL de `articulos` pasa de 0.95 s a 9.3 s porque el `articulo` es la **4ª** columna del pkey y Postgres hace skip-scan (`EXPLAIN`: 51 *index searches*, 1.55 ms por lookup). El índice `ix_wcj_art_sku (tenant_id, articulo)` de la migración lo colapsa a 1 búsqueda; **prod aún no lo tiene**, así que los tiempos de arriba son el peor caso.

**Smoke** `test-newdb-route-ticket-detail.js`: **28/28** en local (estructura + regresión de `v_sales_lines`). Los 4 candados de data hacen skip local por falta de ventas de ruta en la DB de dev; su lógica quedó verificada por las sondas de arriba y correrá en prod al aplicar la migración.

**Typecheck:** `apps/api` limpio (los 3 errores que salen son del entorno: `@aws-sdk/*` no instalado). ⚠️ **`apps/view` NO se pudo compilar**: este `node_modules` está incompleto (`@angular/*` y `@babel/*` ausentes, sin `node_modules/.bin`), así que `nx build view` y `tsc` sobre la app fallan antes de mirar el código. **El frontend queda sin verificación de build.**

---

## 6. Pendiente para prod

1. **La migración NO se aplica a mano.** Railway corre `sh ./migrate.sh` como `preDeployCommand` (ver `railway.api.json`), así que `20260831120000_rr2_route_line_enrichment` (2 columnas aditivas + 1 índice + 2 vistas) entra sola en el **próximo deploy del api**, junto con las demás pendientes. No es destructiva; el `down` deja las columnas de `v_sales_lines` (quitarlas exigiría `DROP CASCADE` de `v_sales_daily`).
2. **Backfill de los importers** — los dos son incrementales, así que sin ventana forzada la `unidad`/`precio_unitario` sólo llega a los días nuevos:
   - `node database/importers/kepler/import-route-push-lines.js --days 400 --apply`
   - `node database/importers/kepler/import-kepler-vecinal-routes.js --apply` (arranca en el cutover de cada rama)
   Ambos corren desde la LAN (leen `.249`).
3. Redeploy api + view.
4. Correr `test-newdb-route-ticket-detail.js` contra prod: ahí sí muerden los 4 candados de data.
5. Verificación visual del panel (no automatizable desde CLI) — y build del frontend en una máquina con `node_modules` completo.

---

## 7. Plan de mejora — RR3 "todo clickeable" + promedios por renglón

> Pedido: que **todo** sea navegable y que aparezca un **promedio por línea (cantidad de productos)**.
> Estado: ⬜ propuesto, sin código.

### 7.1 Lo que hoy se puede clickear (y lo que no)

| Superficie | Hoy | Debería llevar a |
|---|---|---|
| Matriz · fila de ruta | ✅ abre el desglose | (igual) |
| Matriz · **celda de mes** | ❌ muerta | tickets de esa ruta **en ese mes** |
| Matriz · fila TOTAL | ❌ | — (no aporta) |
| Tab **Productos** · renglón | ❌ | tickets que llevaron ese SKU |
| Tab **Unidades** · renglón | ❌ | tickets con renglones en esa unidad |
| Tab **Por día** · renglón | ❌ | tickets de ese día |
| Tab **Clientes** · renglón | ❌ | tickets de ese cliente |
| Tab **Tickets** · fila | ✅ abre el ticket | (igual) |
| Ticket · renglón (SKU) | ❌ | ficha del producto en esa ruta |
| Ticket · cliente | ❌ | ficha del cliente en esa ruta |

**La buena noticia: casi todo es frontend.** `GET …/sales-by-route/tickets` ya acepta `sku`, `client`, `unit`, `from`, `to`, `doc_type`, `payment_method`, `q`, orden y paginación. Los cuatro drills nuevos de tabs son **wiring**, no backend.

### 7.2 Medición del patrón real (prod, ruta 27, 2026)

Cada celda que se vuelve link es una consulta nueva, así que se midió antes de prometer:

| Drill | Tiempo |
|---|---|
| tickets · ruta + **mes** | **1.19 s** ✅ |
| tickets · ruta + año + **SKU** | **1.01 s** ✅ |
| tickets · ruta + año + **cliente** | **0.23 s** ✅ |
| tickets · ruta + año + **unidad** | 2.20 s ⚠️ |
| detalle de un ticket | 0.17 s ✅ |
| tickets · ruta + **año sin filtro** | **6.44 s** ❌ |
| detalle de ruta · año completo | **7.11 s** ❌ |

**Diagnóstico:** todo lo *filtrado* es rápido; lo único lento es el default que **no** filtra. Hacer la página navegable no la hace más lenta — al contrario, cada click reduce el conjunto. El problema es el punto de partida.

### 7.3 Sprints

| Item | Qué | Por qué |
|---|---|---|
| **RR3.0** ⬜ | **El scope por defecto deja de ser el año.** El desglose y los tickets abren en el **mes visible** (o el último mes con venta si no hay rango elegido), con un "ver año completo" explícito. | Ataca los dos únicos números rojos de 7.2 de un golpe: 7.11 s → ~1.2 s. Es prerrequisito de todo lo demás. |
| **RR3.1** ⬜ | **El filtro es el estado.** Barra de chips removibles arriba del panel (`Ruta 27 · Ago · SKU 17089 · KG`) que refleja el drill acumulado; cada tab lee de ahí. Click en un renglón = agregar faceta, no navegar a otra pantalla. | Sin esto "todo clickeable" se vuelve un laberinto: el usuario no sabe qué está viendo ni cómo volver. |
| **RR3.2** ⬜ | **Los 4 drills de tabs** (Productos/Unidades/Por día/Clientes → Tickets). Sólo frontend: agregan faceta y saltan a la tab Tickets. | Es el 80% del pedido y no necesita backend. |
| **RR3.3** ⬜ | **Promedios por renglón** (ver 7.4). | El pedido explícito. |
| **RR3.4** ⬜ | **Ficha de producto en la ruta** (click en el SKU de un ticket): serie mensual, clientes que lo compran, unidad en que se vende, precio promedio y dispersión. Endpoint nuevo. | Cierra el ciclo producto→cliente sin salir del panel. |
| **RR3.5** ⬜ | **Ficha de cliente en la ruta** (click en el cliente): frecuencia de visita, ticket promedio, canasta, última compra. Endpoint nuevo. | Idem, y alimenta a Thot. |
| **RR3.6** ⬜ | **`KGS` vs `KG`**: Wincaja y Kepler escriben el mismo kilo distinto y hoy salen como dos renglones en Unidades. Decidir: mostrar juntos con el rótulo original en el tooltip, o dejarlos separados. **Requiere tu decisión** — unificar es reescribir el rótulo de la fuente, que es justo lo que la regla prohíbe. | Es el único artefacto visible que quedó del multi-fuente. |
| **RR3.7** ⏸️ | Drill desde la matriz **sin ruta** (ej. "todos los tickets de agosto de todas las rutas"). Hoy `route` es obligatoria a propósito. Requiere endpoint nuevo + matview, porque es justo el patrón de 110 s. | Diferido salvo que lo pidas: caro y de valor dudoso. |

MVP = **RR3.0 → RR3.3**.

### 7.4 Los promedios (medidos en prod, ruta 27 · 2026)

"Promedio por línea (cantidad de productos)" admite dos lecturas y **son preguntas de negocio distintas**; propongo mostrar las dos porque juntas cuentan la historia:

| Métrica | Valor | Qué contesta |
|---|---|---|
| **unidades / renglón** | **3.54** | Cuánto se lleva el cliente **de cada producto** que compra (profundidad) |
| **renglones / ticket** | **6.14** | Cuántos productos **distintos** entra a la visita (surtido) |
| ticket promedio | $715.85 | (ya existe) |

Dónde van:
- **KPI del desglose de ruta**: las dos, junto a Ticket promedio.
- **Columna en la tabla de Tickets**: `unid/ren` por ticket — deja ver de un vistazo el ticket de "muchos productos poquitos" contra el de "un producto en volumen".
- **Columna en la tab Productos**: unidades/renglón **de ese SKU** — dice si se vende de a uno o de a bulto, y es la señal directa para el tamaño de empaque sugerido.
- Todas salen de `sum(qty)` y `count(*)` que las consultas **ya traen**: cero costo adicional.
