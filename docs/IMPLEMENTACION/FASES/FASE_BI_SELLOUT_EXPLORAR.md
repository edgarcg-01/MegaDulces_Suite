# Fase BI — Sell-Out "Explorar" (poder BI sin salir a PowerBI)

> Propuesta 2026-09-07 · hereda [`FASE_RS`](../01_TRACKER_PROGRESO.md) (sell-out), [`FASE_AX`](FASE_AX_ANEXO_VENTA.md)
> (drill a factura) y [`FASE_VP`](FASE_VP_VERDAD_Y_PROCEDENCIA.md) (ADR-056: el número declara con qué se calculó).
>
> **Estado: BI.0 ✅ (prod+.245, `17b7e07a`) · BI.3 (`961c95db`) · BI.5 (`7475fc7a`) · BI.2 (`1185f573`) · BI.6 (`b75d411d`) · BI.4 (`75606743`) · BI.1 🔨 EN CÓDIGO (Δ MoM + sparkline en KPI) — todo 🔨 sin desplegar. BI.9 (`42da8333`, objetivos: migs en .245, PENDIENTE prod) · BI.7 🔨 EN CÓDIGO (enlace a Facturación TM — el drill in-page completo es fase diferida, ver abajo) · BI.8 (pivote) ⬜.**
>
> **BI.7 — hallazgo de perf (medido en prod, read-only):** un drill in-page a factura sobre las vistas
> vivas `analytics.erp_sales_invoices`/`_lines` es **inviable interactivo** — 20 s sin marca y **>120 s con
> filtro de marca** (el filtro de fecha no empuja a índice sobre `kepler_ods.kdm1` → seq-scan del histórico;
> el `statement_timeout` de 45 s lo abortaría → 500). Extender la vista a mostrador (U/D/10, 160k docs) además
> **arriesga degradar la pantalla Facturación TM en producción** (el filtro `doc_tipo` no empuja al `DISTINCT ON`).
> Por eso BI.7 v1 = **enlace** a la pantalla ya optimizada (Facturación TM, ~1 s, materialized-CTE), gateado por
> `COMMERCIAL_SALES_DOCS_VER`. **Diferido a fase propia:** materializar un índice de documentos por fecha/marca +
> expandir cobertura a mostrador/Wincaja con su decode de IVA. No se hizo el hack de la vista lenta.
> Pendiente prod: redeploy view/api (Edgar) + re-login + `ANTHROPIC_API_KEY` en Railway (BI.5 degrada limpio sin ella).
> BI.3 verificado (read-only): invariante Σcontrib==Δtotal exacto (ago vs jul 2026, −$1,058,992). BI.5 tools verificadas
> (total agosto $53,838,718 == universo del reporte; cero números del LLM). Builds view+api verdes.
> **Deuda declarada (ADR-056):** el loop ReAct de BI.5 es un 3er calco (thot/maat/sellout) → extraer motor genérico = BI.5.1.
>
> Decisión del usuario (2026-09-07): **el reporte actual se mantiene intacto** (formato original), y el poder BI vive
> en un **submódulo hermano** (pestaña + URL propias) que consume el mismo backend. Las **4 capacidades base** +
> el **valor diferencial** (dinamismo + practicidad) van en ese submódulo.

---

## 0. Nomenclatura (formalizada 2026-09-07)

**Fase `BI` — "Análisis (Sell-Out BI)"** · tickets `feat([BI.N]): descripción`.

| Capa | Elemento | Nombre canónico |
|---|---|---|
| Usuario | Pestaña (label) | **Análisis** |
| Usuario | Ruta | `/comercial/analisis` |
| Usuario | Icono | `pi pi-chart-bar` |
| Frontend | Componente | `comercial-analisis.component.ts` → `ComercialAnalisisComponent` |
| Frontend | Registro de tab | entrada en `REPORTS_TABS` (`reports-tabs.ts`) |
| Authz | Permiso propio | `COMMERCIAL_SELLOUT_ANALYSIS_VER` (anclado a los roles con `COMMERCIAL_SELLOUT_VER`) |
| Backend | Reusa | `ComercialService.sellOut()` / `SellOutReport` + `planSellOutSources` (sin fuente nueva) |

**Features y sus nombres** (descriptivos en español; el chat NO es una persona nueva):

| Cód | Feature (UI) | Endpoint / método | Nombre interno |
|---|---|---|---|
| D1 | **Cross-filter** | frontend sobre `SellOutReport` | — |
| D2 | **En vivo** (sin botón Generar) | frontend (debounce) | — |
| D3 | **Drill libre** (breadcrumb) | frontend + BI.7 celda→documento | — |
| P1 | **Explica el cambio** | `GET …/sell-out/explain` → `explainChange()` | `delta_bridge` (puente de contribución) |
| — | Comparación en el tiempo | campo `compare` en `SellOutQuery` | — |
| P2 | **Pregúntale al Sell-Out** | `POST …/sell-out/ask` (reusa chat ReAct) | tool `sellout_query` |
| P3 | **Radar** (anomalías) | `GET …/sell-out/anomalies` + `@Cron` | `analytics.sellout_findings` |

> Regla de permiso (receta de 6 touch-points): enum backend + `authz-tree` + migración que **reparte** la clave a los
> roles con `COMMERCIAL_SELLOUT_VER` + gate en el controller + registro del tab + guard de ruta. Un módulo no está
> entregado hasta que el permiso está **repartido en prod**, no sólo declarado en el enum (lección LC.6.2).

---

## 1. Por qué — el diagnóstico

`/comercial/sell-out` **no es débil en datos**. Es una matriz pivote muy completa (empresa × sucursal·canal·fuente,
neto/bruto, promos como dimensión, concentrar-por, 4 KPIs, XLSX/PDF). La gente exporta a PowerBI porque es
**una tabla que se lee, no un tablero con el que se piensa**. Cinco huecos, medidos contra el código:

| # | Lo que PowerBI da y aquí falta | Evidencia |
|---|---|---|
| 1. **Visual** | Cero gráficas. Todo son números en celdas. Sin tendencia, Pareto, treemap, heatmap. | La matriz HTML nativa (`so-matrix`) es el único órgano; los KPIs son texto plano. |
| 2. **Comparación en el tiempo** | No hay MoM / YoY / vs anterior / Δ%. "Mes en columnas" apila meses pero **no calcula la variación**. | `SellOutReport` no trae período previo; `sellOut()` no invoca `expenseRange()`. |
| 3. **Drill / cross-filter** | La celda no baja a la factura/línea. Solo hay drill fila-empresa → productos. | `sellOut`/`sellOutByVendor` devuelven agregados **sin folio ni id de documento**. |
| 4. **Auto-servicio de pivote** | Dimensiones clavadas (empresa en filas, sucursal·canal en columnas). No se arrastra marca→filas o vendedor→columnas. | `group_by`/`view`/`concentrar` son ejes fijos, no un pivote libre. |
| 5. **Ranking / contribución** | No hay Top-N ni ABC/Pareto sobre el revenue de sell-out (solo `share_pct` por fila). | 327 empresas planas; el 80/20 se calcula en Excel. |

**La causa de fondo no es la UI: falta la capa semántica encima del dato.** Y ahí está la jugada — el dato duro
ya está bien y **verificado a la factura** (`v_sellout_daily` con dedup horneado + `mv_sellout_monthly`). Eso es
justo lo que un PowerBI casero **no** tiene: cada quien re-pivota un export crudo sin el dedup ni el neto-de-descuento,
y por eso "los números cambian". **La verdad absoluta ya peleada es la ventaja competitiva vs PowerBI.** Lo que falta
es la capa de arriba, y montarla in-house garantiza que **el tablero y el reporte siempre cuadren entre sí y con la
factura** (ADR-056).

---

## 2. Tesis

**El reporte actual se mantiene intacto. El BI vive en un submódulo hermano.** Nueva pestaña en `REPORTS_TABS`
(`reports-tabs.ts`) + ruta propia (p.ej. `/comercial/explorar`) + componente nuevo que consume el **mismo backend
`ComercialService.sellOut()` / `SellOutReport`** y el mismo resolvedor de fuente (`planSellOutSources`). Como ambas
pantallas derivan de las mismas filas verificadas, **cuadran por construcción** — el submódulo es otra forma de
interrogar la misma verdad, no una segunda fuente.

Por qué submódulo hermano y no un modo dentro del reporte:
- **Riesgo cero al reporte que ya se usa** — no se toca `comercial-sell-out.component.ts` (formato original preservado).
- **Layout libre para explorar** — el submódulo no está atado a la matriz densa; puede componer cascada + cascada de
  causa raíz + chat + KPIs sin pelear con la tabla.
- **URL propia = compartible** (DESIGN.md `:588` empuja "URL como fuente de verdad" en Operations).

Fundamento medido (investigación 2026-09-07, 4 exploraciones):
- **El 70% del costo de un BI es el modelo de datos correcto, y ya existe.** `v_sellout_daily` (grano día,
  `business_date`) + `mv_sellout_monthly` (grano mes, `year_month`), ambos con `monto` (bruto) **y `monto_neto`**
  (migración `20260905120000` es la forma vigente). El submódulo no crea fuente nueva: reusa estos.
- **Precedente de tab hermano ya existe:** `REPORTS_TABS` (`reports-tabs.ts:4`) ya lista Sell-Out / Salidas / Ventas
  por ruta / Documentos como páginas hermanas ruteadas — agregar "Explorar" es una entrada más (`label`/`route`/`icon
  pi-*`/`permission`) + ruta en `app.routes.ts`.
- **Las gráficas ya están instaladas y permitidas:** `chart.js@4.5.1` + PrimeNG `<p-chart>`; sparkline/mini-bars/
  ring-gauge SVG (0 KB) en `shared/components/charts/`. DESIGN.md permite gráficas en Operations ("el color codifica
  dato, no decora").

---

## 3. Lo que YA existe para reusar (no reinventar)

| Primitivo | Ubicación | Uso en Explorar |
|---|---|---|
| **Universo sell-out unificado** | `v_sellout_daily` + `mv_sellout_monthly` (mig `20260905120000`) | Fuente única. Dimensiones: `warehouse_code`, `branch_name`, `source_branch`, `channel {mostrador,ruta,credito,preventa}`, `source {kepler,wincaja}`, `vendor_code/name`, `product_id/sku/nombre`, `brand_id/nombre/code`, `is_promo`, `unit_kind`, `factor_sale`, `box_size`. Medidas: `units`, `monto`, `monto_neto`. |
| **Resolvedor de fuente** | `commercial-analytics.service.ts:3212` `planSellOutSources` | Mes cerrado → rollup (sub-seg); borde/mes en curso → vista diaria. Ya combinado en `fetchSelloutRows`. |
| **Fórmula Pareto/ABC (window fn)** | `inventory-abc.service.ts:53-67` | Reusar la matemática (`SUM() OVER ... ROWS UNBOUNDED PRECEDING`, cortes A<80% / B<95% / C). **Hoy corre sobre costo de inventario por almacén → construir la variante sobre revenue de sell-out.** |
| **Comparación de período previo** | `commercial-analytics.service.ts:1919` `expenseRange()` + delta % SAL.6 `:3925` | Rango previo equivalente + `delta_pct` + `has_trend` (medí vs no-medí). Copiar para MoM. |
| **YoY / momentum precomputado** | `mv_product_momentum` (r30 vs r90) · `analytics.demand_acceleration` (YoY 60d Welch-Z) | Fuentes ya calculadas a nivel SKU si se quiere aceleración/estacional. |
| **MetricCard** | `shared/components/metric-card/` | Variantes `sparkline/gauge/bars/progress/ember`, `delta` con dirección, `progress`/`gauge` **contra un `goal`**. La UI de "% vs objetivo" ya existe; falta el dato. |
| **Charts base SVG (0 KB)** | `shared/components/charts/{sparkline,mini-bars,ring-gauge}` | Micro-viz por SKU/canal. DESIGN.md exige SVG para sparklines, no Chart.js. |
| **Chart grande** | `<p-chart>` + `egresos-chart-opts.ts` + `chart-theme.ts` (`getChartTokens()`, paleta `--chart-1..8`) | Tendencia/Pareto en barras, theme-aware, sin morado. Copiar de `comercial-egresos.component.ts:185`. |
| **Drill a factura (parcial)** | `commercial-sales-documents.service.ts:168` `detail(folio)` + vistas `analytics.erp_sales_invoices(_lines)` | Cabecera + renglones + anexo PDF por folio. **Solo cubre U/D/8 (telemarketing) y U/D/12 (crédito).** |
| **Drill panel** | `side-peek.component.ts` + `entity-inspector` + Command Center como plantilla de layout | Panel lateral para el drill de celda. |

---

## 3bis. El valor diferencial: dinamismo + practicidad (más allá de la gráfica)

> Reencuadre 2026-09-07 (usuario): *"el valor agregado de PowerBI es su dinamismo en las consultas, su
> practicidad para encontrar información; falta más valor que una simple gráfica."*

**PowerBI no gana por la gráfica: gana porque cada clic es una pregunta y el tablero responde al instante.**
La gráfica es soporte visual, no el fin. El fin es una pantalla que se **interroga**, no que se configura. Y aquí
tenemos dos activos que un PowerBI casero no tiene: **el dato verificado a la factura** y la **infra de chat tool-use**
(Maat/Thot, cero números del LLM). Eso habilita features que PowerBI no iguala en confianza.

### Dinamismo — que reacciona, no que se genera
- **D1. Cross-filter total.** Clic en cualquier barra/celda/rebanada del Pareto → **todo el tablero se refiltra**. Cada
  visual es también slicer. Puro frontend: el `SellOutReport` ya está en cliente. Es la firma de PowerBI.
- **D2. Sin botón "Generar".** El tablero responde mientras el usuario piensa (rollup sub-seg + debounce). El "Generar"
  es fricción de reporte, no de exploración.
- **D3. Drill-anywhere con breadcrumb.** Ruta de exploración libre: empresa → marcas → sucursales → vendedores →
  documento, y **regreso** por breadcrumb. No jerarquía fija.

### Practicidad — encontrar información sin saber la pregunta de antemano
- **P1. "Explica el cambio" (causa raíz determinista) — el diferencial más fuerte.** Ante `monto ▼ -8%`, el tablero
  **descompone quién lo movió**: contribución al delta por marca/sucursal/vendedor/canal (`De la Rosa −$1.2M ·
  Padre Hidalgo −$800k · +Bimbo $400k`). Equivalente al "Explain the increase" de PowerBI **pero sobre dato verificado
  a factura** (PowerBI lo hace con heurística sobre un modelo casero). Determinista, auditable. En el ADN del repo
  (Maat causa-raíz, [`FASE_MR`](FASE_MR_MOTOR_RENTABILIDAD.md) `margin_gap_bridge`). Motor: `expenseRange()` para el
  período espejo + descomposición de contribución al delta por dimensión sobre `mv_sellout_monthly`/`v_sellout_daily`.
- **P2. Pregúntale en lenguaje natural.** *"¿por qué bajó Padre Hidalgo en agosto?"*, *"top 5 marcas que cayeron vs
  julio"*, *"cuánto vendió telemarketing esta semana"* → responde con **números del modelo, no alucinados**. Reusa el
  patrón de chat ReAct tool-use de Maat (`/finanzas/maat`) y Thot: **el LLM elige la herramienta, los números salen de
  `v_sellout_daily`** (ADR-016: LLM fuera del camino del dinero). Es la pieza que hace que **dejen de exportar**.
- **P3. Anomalías proactivas.** El tablero surface "qué se movió raro" **sin que se pregunte** ("Zamora −40% vs su
  promedio", "marca nueva ya top-10"). Patrón `findings` ya presente en 8 fases (`finance.findings`,
  `replenishment_findings`, Horus). Fuente: comparación contra baseline propio (`mv_product_momentum`,
  `demand_acceleration` ya calculados).

**Tesis en una frase:** un PowerBI casero re-pivota un export crudo y **alucina o descuadra**; este tablero **cuadra a
la factura, explica el cambio solo y responde en español** — porque el dato ya está peleado y la infra de agente ya
existe. Las gráficas (§4.2) son el soporte visual de todo esto, no el valor en sí.

---

## 4. Las 4 capacidades base — diseño

### 4.1 Comparación en el tiempo (MoM / YoY / vs anterior)

**Feasibility: alta y barata.** Comparar dos `year_month` (MoM) o `2025-09` vs `2026-09` (YoY) es un scan por rango
sobre `mv_sellout_monthly` (índices `ux_`, `(tenant,year_month)`, covering con `units/monto/monto_neto`) → casi
index-only. Si la comparación toca el **mes en curso**, ese mes se lee del borde diario (`v_sellout_daily`, pocos días)
— el patrón ya lo hace `fetchSelloutRows`. No se escanea el año diario completo.

**Diseño:**
- `SellOutQuery` gana `compare?: 'none'|'prev_period'|'yoy'`. El backend resuelve el rango espejo con `expenseRange()`
  (mismo largo, período anterior) o −12 meses (YoY), corre el mismo pivote, y adjunta a cada `SellOutCell` un
  `{ monto_prev, monto_neto_prev, delta_pct }` (patrón SAL.6, con `has_trend` para distinguir "0 real" de "sin dato").
- Frontend: `MetricCard` con `delta` en los KPIs; en la matriz, columna/celda con `▲ +3.2%` (flecha+signo+número,
  nunca solo color — DESIGN.md `:468`). Un `<app-sparkline>` de N meses por fila (dato ya en cliente si se pide serie).

**Hueco declarado (ADR-056):** **vs objetivo / cumplimiento de cuota NO tiene fuente.** No existe tabla de metas
(`grep target|budget|objetivo|meta|cuota` en `database/` → cero). `MetricCard.goal` está listo pero sin alimentador.
Solo "vs período anterior" es posible hoy. Ver §5.

### 4.2 Gráficas + Pareto/ABC

**Todo alimentado por el `SellOutReport` ya en cliente** (sin fetch nuevo para lo agregado). Envolver el bloque en
`@defer` (DESIGN.md `:677`). Widgets:

- **Tendencia** (`<p-chart type="line/bar">`): monto/cajas por mes del rango, opcional overlay del período previo.
- **Pareto / ABC de contribución** (`<p-chart type="bar">` con eje acumulado + `chartjs-plugin-annotation` para la
  línea 80%): quién hace el 80% — por empresa, marca, vendedor o sucursal. Backend nuevo: variante de la window fn de
  `inventory-abc.service.ts` sobre `SUM(monto_neto)` del universo sell-out (no sobre costo de inventario). Reusa la
  matemática, cambia la fuente/métrica.
- **Treemap / heatmap de contribución**: **no existe componente** — construir. Heatmap = grid con tinte `--chart-*`
  determinista + leyenda, nunca color como único portador (DESIGN.md Q.6 `:830`). Treemap = dependencia nueva o SVG
  propio; candidato a diferir si el Pareto ya cubre la lectura 80/20.
- **Sparkline por fila** (`<app-sparkline>`, SVG 0 KB) para micro-tendencia inline en la matriz.

**Reglas DESIGN.md (Operations):** paleta `--chart-1..8` sin morado, ejes desde `--text-muted`/`--border-color` vía
`getChartTokens()`, `tabular-nums`, iconos `pi pi-*` (nunca emojis), deltas multimodales, interacción < 200 ms.

### 4.3 Drill a documento (clic en celda → factura/línea)

**El drill a factura hoy existe pero es parcial** — hallazgo clave de la investigación:

- **Existe:** `commercial-sales-documents.service.detail(folio)` → cabecera + renglones + anexo PDF, sobre las vistas
  vivas `erp_sales_invoices(_lines)` (frescura CDC ~seg).
- **Cobertura:** esas vistas cubren **solo `U/D/8` (telemarketing) y `U/D/12` (crédito)**. El sell-out además incluye
  **mostrador Kepler (U/D/10), Wincaja y rutas**, que **no tienen vista de documento**. Un drill genérico fallaría en
  esos canales.
- **Falta la pieza intermedia:** un endpoint `celda → documentos` que, dado `{ warehouse_id/sucursal, from, to, sku,
  channel?, vendor? }`, joinee `erp_sales_invoices ⋈ erp_sales_invoice_lines` por `folio_digital` y liste los folios/
  renglones detrás del agregado; luego encadena a `detail(folio)`. Plantilla de arquitectura: el drill de egresos
  (`expenseDocument()` `controller:426`), que también va agregado→documento.

**Diseño escalonado (honesto sobre cobertura):**
1. **Drill donde SÍ hay documento** (telemarketing/crédito): celda → `side-peek` con lista de folios → `detail(folio)`
   → anexo PDF. Cierra el círculo con la verdad a la factura que ya validamos.
2. **Canales sin vista de documento** (mostrador/wincaja/rutas): el drill baja hasta **línea diaria de
   `v_sellout_daily`** (producto × día × sucursal), y **declara** que el documento fuente no está modelado para ese
   canal (no se dibuja un folio inexistente). Ampliar cobertura de vistas de documento a U/D/10 y Wincaja es fase aparte.

### 4.4 Pivote libre (arrastrar dimensiones)

Todas las dimensiones ya están en el universo (§3). Dos caminos:

- **A (rápido, recomendado para v1):** exponer los ejes ya soportados como **selectores de dimensión** en filas/columnas
  (empresa | marca | vendedor | canal | sucursal | producto) reusando `group_by`/`concentrar`, sin motor de pivote
  nuevo. Cubre el 90% del "quiero verlo por marca en filas".
- **B (pivote real drag&drop):** un motor de pivote cliente sobre las filas crudas del `SellOutReport` (o un endpoint
  `raw` que devuelva el grano fino). Mayor esfuerzo; se justifica solo si A no alcanza. Diferible.

---

## 5. Huecos a declarar (ADR-056: lo que no tiene fuente NO se dibuja)

1. **Objetivos / presupuesto / cuotas — NO existe fuente.** Bloquea toda vista "vs meta / % cumplimiento". Dependencia
   nueva: tabla `commercial.sales_targets` (grano vendedor/sucursal/canal/producto × período) + captura/import. Hasta
   entonces, solo "vs período anterior".
2. **Margen / costo — fuera del universo sell-out.** Solo venta (bruta y neta). Pivotar rentabilidad exige el costo del
   PdV (ver [`FASE_MR`](FASE_MR_MOTOR_RENTABILIDAD.md)); no mezclar aquí.
3. **Dimensión cliente ausente.** El grano llega a vendedor/canal/almacén, no a `customer_id`. No hay drill a punto de
   venta desde sell-out.
4. **Cobertura de documento parcial** (§4.3): solo telemarketing/crédito son drilleables a factura.
5. **Cajas no materializadas.** Se recalculan money-anchored (ADR-055); un pivote libre de cajas paga ese cálculo.
6. **Sin grano semana/trimestre materializado** (solo día y mes); series semanales se derivan de `business_date`.
7. **Rutas solo desde 2026-07-01** (arranque de la fuente, no bug) → series históricas de canal `ruta` vacías antes.

---

## 6. Quick wins (aditivos, sin arquitectura nueva)

- **Export en neto:** hoy el exporter (`sell-out-export.service.ts:52`) lee **solo `.monto` bruto**; `monto_neto` nunca
  se usa. Además, en el path no-plaza de `sellOut()` el `cell.monto_neto` **no se acumula** (solo plaza y by-vendor lo
  suman). Fix: (a) sumar `monto_neto` en el pivote no-plaza, (b) agregar medida `'neto'` en `subs()`. La plomería
  `measure` ya existe end-to-end.
- **Verificar divergencia working-copy vs desplegado** del toggle "BASE DEL MONTO" (el screenshot lo muestra; el archivo
  en disco no tiene `mo()`) antes de tocar el componente.

---

## 7. Fases sugeridas

El orden prioriza el **valor diferencial** (§3bis) por encima de la gráfica. La gráfica sola no cierra el gap; el
dinamismo (reacciona) y la practicidad (responde) sí.

| Fase | Alcance | Valor | Depende |
|---|---|---|---|
| **BI.0** | Submódulo hermano: entrada en `REPORTS_TABS` + ruta `/comercial/explorar` + componente que consume `ComercialService.sellOut()`/`SellOutReport` (reporte original **sin tocar**). Diccionario (dimensiones/medidas/comparaciones + huecos firmados §5). Fix export en neto (§6). | base | — |
| **BI.1** | Comparación en el tiempo: `compare` en `SellOutQuery`, delta en KPIs+celdas, sparkline por fila. | practicidad | BI.0 |
| **BI.2** | **Dinamismo D1–D3:** cross-filter total, sin botón "Generar" (debounce sobre rollup sub-seg), drill-anywhere con breadcrumb. Puro frontend sobre `report()`. | **dinamismo** | BI.0 |
| **BI.3** | **P1 "Explica el cambio":** descomposición de contribución al delta por dimensión (motor determinista) + panel de causa raíz. | **diferencial ⭐** | BI.1 |
| **BI.4** | Gráficas de soporte: tendencia (`<p-chart>`), sparkline inline, Pareto/ABC (window fn reusada sobre revenue), heatmap. | soporte visual | BI.2 |
| **BI.5** | **P2 Pregúntale en lenguaje natural:** tool sell-out sobre `v_sellout_daily` + chat ReAct (reusa infra Maat/Thot, cero números del LLM). | **diferencial ⭐** | BI.1 |
| **BI.6** | **P3 Anomalías proactivas:** detector sobre baseline (`mv_product_momentum`/`demand_acceleration`) → bandeja de hallazgos en el tablero. | practicidad | BI.1 |
| **BI.7** | Drill de celda a documento: endpoint `celda→documentos` + `side-peek`; escalonado por cobertura (§4.3). | practicidad | BI.2 |
| **BI.8** | Pivote libre camino A (selectores de dimensión fila/columna). | dinamismo | BI.0 |
| **BI.9** *(diferible)* | Tabla `sales_targets` + "vs objetivo" (MetricCard `goal` listo). Treemap. Pivote drag&drop (B). Vistas guardadas/bookmarks. | espera fuente | BI.1 |

**MVP del valor = BI.0 + BI.1 + BI.2 + BI.3.** Con eso el tablero ya **reacciona** (cross-filter, sin Generar) y ya
**explica el cambio solo** — que es lo que hace exportar innecesario. BI.5 (lenguaje natural) es el segundo golpe de
valor. Las gráficas (BI.4) van después: son soporte, no el fin. BI.9 espera la fuente de objetivos.

---

## 8. Decisiones abiertas

- ¿Objetivos/cuotas entran (crear `sales_targets` + captura) o el BI arranca solo con "vs período anterior"?
- Drill de celda: ¿se amplía la cobertura de vistas de documento a mostrador/Wincaja, o v1 drillea a factura solo
  telemarketing/crédito y a línea-diaria el resto?
- Pivote: ¿alcanza camino A (selectores) para v1 o se quiere drag&drop real (B) desde el inicio?
- Treemap: ¿se construye o el Pareto cubre la lectura 80/20?
