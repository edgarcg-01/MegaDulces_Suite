# Fase RA — Benchmark: cómo hacen el reabastecimiento las grandes empresas y cómo profesionalizamos el nuestro

> Investigación 2026-07-09. Contrasta nuestro Compras/Reabastecimiento (RA.0–RA.14) contra el estándar profesional de la industria (SAP IBP, Blue Yonder, RELEX, Netstock, GAINSystems) y propone un roadmap de mejora aterrizado a nuestra realidad: datos Kepler, 1 dev, plataforma multi-tenant.

---

## TL;DR

Lo que tenemos hoy es un **punto de reorden estático con un flujo de requisición** — el nivel de arranque, correcto pero básico. Las empresas grandes operan sobre **4 pilares**: (1) segmentación ABC-XYZ, (2) pronóstico de demanda, (3) política de inventario por nivel de servicio (safety stock científico + multi-echelon), (4) ejecución con scorecard de proveedor que **realimenta** el modelo. Nuestro mayor salto a "profesional" —**safety stock por nivel de servicio + matriz ABC-XYZ**— se puede hacer **con los datos que ya tenemos** (ventas diarias), sin depender de write-back a Kepler ni de backfill multi-año.

Dato duro de nuestra realidad (verificado vivo, suc 03): la cadena OC→vale→orden de entrada se captura **el mismo día casi 1:1**; de 1294 OCs solo **7 están realmente abiertas**. Conclusión: el valor NO está en el flujo de botones (fill rate y "en tránsito" son señales casi vacías), sino en **la decisión: qué comprar y cuánto**.

---

## 1. El estándar profesional (los 4 pilares)

### Pilar 1 — Segmentación: qué política aplicar a cada SKU
No se trata igual a todos los productos. La matriz **ABC × XYZ** cruza:
- **ABC** = impacto económico (A = ~80% del valor, C = cola larga barata).
- **XYZ** = variabilidad de la demanda (X = estable/predecible, Y = variación moderada, Z = errática/intermitente).

Cada una de las 9 celdas recibe una política distinta: **AX** (caro + predecible) = control estricto, revisión frecuente, buffer justo; **CZ** (barato + errático) = revisión periódica o bajo pedido, mínimo esfuerzo. Se complementa con **FSN** (fast/slow/non-moving). *El error clásico es aplicar la misma fórmula a todo el catálogo.*

### Pilar 2 — Pronóstico de demanda: cuánto se va a vender
- **Demanda estable (X):** suavizamiento exponencial / Holt-Winters con **estacionalidad** — crítico en dulces (Día de Muertos, Navidad, San Valentín, regreso a clases).
- **Demanda intermitente (Z, cola larga):** **Croston / SBA / TSB**. El promedio simple sobre-stockea productos que se venden esporádicamente.
- **Frontera (grandes):** modelos **probabilísticos** — Blue Yonder entrega un *rango* de escenarios, no un solo número, para dimensionar el riesgo; *demand sensing* con señales externas (clima, promos, calendario).

### Pilar 3 — Política de inventario: cuándo y cuánto pedir
- **Punto de reorden:** `ROP = demanda_diaria × lead_time + safety_stock`.
- **Safety stock científico:** `SS = Z(nivel_servicio) × σ_demanda_durante_lead_time`. Combina la variabilidad de la **demanda** y del **lead time**. No es un número fijo: un servicio del 95% pide más buffer que 90%; farma pide más que retail.
- **Cantidad económica (EOQ):** balancea costo de ordenar vs costo de mantener — pero en la práctica **dominan las restricciones reales**: MOQ del proveedor, empaque por caja, tarima, lote de producción.
- **Multi-echelon / DRP:** CEDIS y sucursales **no se planean aisladas**. Se optimiza *dónde* colocar el buffer en la red (MEIO): el CEDIS se surte del proveedor, las sucursales del CEDIS. Planear el nodo suelto genera exceso en unos y quiebre en otros.

### Pilar 4 — Ejecución + medición de proveedor (cerrar el loop)
- **PO automation:** el sistema *genera* la orden sugerida, un humano aprueba (HITL), se envía al proveedor, se recibe.
- **Vendor scorecard:** OTIF (On-Time-In-Full, objetivo 95%+), **fill rate**, **lead time real y su variabilidad**, varianza de precio. Publicar la metodología al proveedor genera confianza.
- **Lo que lo hace profesional:** el scorecard **realimenta** el safety stock (proveedor errático → más buffer) y la selección de proveedor. El loop se cierra.

**Software de referencia:** suites integradas (SAP IBP sobre HANA, Blue Yonder con *Knowledge Graph* + agentes IA, o9); especialistas de forecasting (RELEX, Slim4, Logility); mid-market accesible (Netstock, StockIQ, GAINSystems). Todos comparten los 4 pilares; se diferencian en el motor de IA y el time-to-value.

---

## 2. Gap analysis honesto — nuestro estado vs el estándar

| Capacidad | Estándar profesional | Lo que tenemos (RA.0–14) | Gap |
|---|---|---|---|
| **Segmentación** | ABC × XYZ + FSN, política por celda | ABC por valor de consumo (Fase ABC) | **Falta XYZ (variabilidad) y la matriz que asigna política** |
| **Pronóstico** | Holt-Winters estacional + Croston intermitentes + probabilístico | `avg_daily_units` (promedio simple 90d) | Falta estacionalidad y Croston; no modela intermitentes |
| **Punto de reorden** | ROP = demanda × LT + SS | reorder de Kepler (estático) o computed | Base OK, pero LT es default (no real) |
| **Safety stock** | `Z(servicio) × σ` (científico, por servicio) | implícito en el "objetivo" (máximo/reorden) | **No hay nivel de servicio ni σ — es el gap más valioso** |
| **Lead time** | medido por proveedor + variabilidad | no existe en Kepler → default configurable | Kepler no lo captura; hay que medirlo/capturarlo |
| **EOQ / MOQ** | EOQ + MOQ + case pack | MOQ manual en cajas (RA.13a) | Falta EOQ; MOQ ya se captura |
| **Multi-echelon** | DRP CEDIS→sucursal (MEIO) | RA.11 clasifica origen prov/sucursal | Clasifica, **no optimiza la red** |
| **Ejecución/HITL** | PO sugerida → aprobar → enviar → recibir | requisición HITL + estados (RA.7/14) | OK, pero los estados son manuales, no leídos de Kepler |
| **Scorecard proveedor** | OTIF, fill rate, LT variability → realimenta | — | **No existe** |
| **Loop de aprendizaje** | el desempeño ajusta el modelo | — | No se cierra el loop |

**Veredicto:** tenemos bien puestos los cimientos (Pilar 3 básico + Pilar 4 flujo). Nos falta lo que separa "básico" de "profesional": **segmentación real (P1), pronóstico adecuado (P2), safety stock por servicio (P3) y scorecard que realimente (P4)**.

---

## 3. Roadmap de mejora — priorizado por (valor ÷ esfuerzo), aterrizado a 1 dev + datos Kepler

### 🟢 Quick wins — alto valor, datos que YA tenemos

**RA-PRO.1 — Safety stock por nivel de servicio. ✅ HECHO (2026-07-09).** Reemplaza el "objetivo" estático por `safety = ceil(Z(servicio) × σ_demanda × √LT)` y `reorder = ceil(avg×LT) + safety`. σ se computa en `import-inventory-health.js` (varianza poblacional 90d incluyendo días cero) → `analytics.inventory_health.stddev_daily_units`. `import-computed-reorder.js` deriva Z del nivel de servicio (inversa normal Acklam) por clase ABC (A=0.98, B=0.95, C=0.90; override env `RA_SERVICE_A/B/C`), con piso de `RA_SAFETY_FLOOR_DAYS` (2d) para A/B cuando σ=0. Persistido en `commercial.reorder_policy` (service_level/safety_stock/policy_method='service_level'). Smoke `test-newdb-ra-service-level.js` 18/18.

**RA-PRO.2 — Matriz ABC-XYZ. ✅ HECHO (2026-07-09).** Eje **XYZ** por coeficiente de variación `CV=σ/μ` (X≤0.5 · Y≤1.0 · Z>1.0) en `analytics.inventory_health.xyz_class` + snapshot en `reorder_policy`. Superficie en `/compras` (Existencia Crítica): columna "Clase" (ABC·XYZ, Z resaltado como riesgo de pronóstico), columna "Colchón" (safety stock + % nivel de servicio, tooltip con la fórmula), filtros ABC y XYZ. El ABC ya lo calcula la Fase ABC (`commercial.abc_classification`). **Nota operacional:** los números reales se pueblan por el nightly del runner (`sales-fact → inventory-health → computed-reorder`, ya wireado); local solo probado con smoke sintético (la venta diaria vive en Kepler).

**RA-PRO.3 — Lead time por proveedor. ✅ HECHO (2026-07-09) — como CAPTURA MANUAL.** Investigación concluyente: Kepler **no codifica lead time real**. Medido en vivo (suc 03, 365d, cadena OC `X-A-35` → orden de entrada `X-A-40`): **73% de las OC tienen la entrada el mismo día (mediana 0) y el promedio es negativo (−7.6d)** — hay entradas fechadas antes que su OC → las fechas son artefacto de captura, no del tiempo físico de entrega. Por eso el LT se **captura manual** (como el MOQ). Nueva página **`/compras/proveedores`**: tabla editable de lead time (días) + mínimo en cajas por proveedor, alimenta directamente `avg×lead` (reorder) y `√lead` (safety). Backend `listSuppliers` + `setSupplierLeadTime`. Sin migración (columnas `lead_time_days`/`min_order_boxes` ya existían). **Diferido:** variabilidad del lead time (σ_LT) para el safety stock — Kepler no da la señal; requeriría capturar recepciones reales.

### 🟡 Medio — más motor, más valor

**RA-PRO.4 — Croston para demanda intermitente.** Aplicar Croston/TSB a los SKU clase Z (cola larga de dulces), que hoy el promedio simple sobre-stockea.

**RA-PRO.5 — Vendor scorecard.** OTIF, lead time real + variabilidad y varianza de precio sobre los documentos Kepler → tablero de proveedor. *(Fill rate se difiere: es ~100% artificial hoy — ver §hallazgo.)* El scorecard alimenta de vuelta el safety stock de RA-PRO.1 = cierra el loop (Pilar 4).

### 🔴 Grande — estructural, dependencias

**RA-PRO.6 — DRP / multi-echelon CEDIS→sucursal. ✅ HECHO (2026-07-09).** Topología `commercial.warehouses.source_warehouse_id` (mig `20260709190000`): NULL = CEDIS (compra a proveedores), set = sucursal (traspaso desde ese CEDIS). El importer `import-network-reorder.js` planea el CEDIS sobre **demanda dependiente** (antes tenía 0 política): `media_red = Σ avg(sucursal) + avg(propio)` y **`σ_red = √(Σ σ(sucursal)² + σ(propio)²)`** (risk pooling — las varianzas suman, el CV agregado baja), luego `safety = ceil(Z(0.98)×σ_red×√lead)`. Página **`/compras/red`** para configurar qué CEDIS surte cada sucursal + KPIs (CEDIS / sucursales / sin origen). Backend `networkTopology` + `setWarehouseSource`. Wireado en el nightly tras `import-computed-reorder`. Smoke `test-newdb-ra-network.js` 7/7 (media Σ=7, σ=√25=5, guard self-source). **Diferido (RA-PRO.6.2):** vista de distribución por producto (matriz CEDIS+sucursales con traspasos sugeridos) y optimización de asignación cuando el CEDIS no alcanza para toda la red.

**RA-PRO.7 — Pronóstico estacional (Holt-Winters).** Bloqueado por backfill multi-año (RA.10.0): prod tiene ~7 meses de historia; la estacionalidad de dulces necesita ≥2 años. Gate por calendario/datos, no por código.

**RA-PRO.8 — Write-back a Kepler (opcional).** Que la requisición aprobada *genere* la OC (`X-A-35`) nativa en Kepler, en vez de doble captura. Convierte el flujo RA.14 de ceremonial a real. Fuera de scope por ADR-016 (no escribimos al ERP) hasta decisión explícita.

---

## 4. Recomendación de arranque

Empezar por **RA-PRO.1 (safety stock por servicio) + RA-PRO.2 (ABC-XYZ)**. Juntos entregan el mayor salto de calidad con datos que ya poseemos, sin write-back ni backfill, y dejan la base para el pronóstico y el scorecard. El flujo de botones (RA.14) se replantea o se difiere: su versión profesional es **leer el estado real desde los documentos Kepler**, no un clic manual.

---

## Fuentes

- [Netstock — The definitive guide to inventory ordering](https://www.netstock.com/blog/the-definitive-guide-to-inventory-ordering/)
- [Farseer — Inventory Replenishment Plan: EOQ, Safety Stock, Reorder Points](https://www.farseer.com/blog/inventory-replenishment/)
- [EazyStock — ABC XYZ inventory analysis](https://www.eazystock.com/blog/abc-xyz-inventory-analysis-and-why-it-adds-value/)
- [Umbrex — Inventory Segmentation (ABC/XYZ/FSN) Framework](https://umbrex.com/resources/frameworks/supply-chain-frameworks/inventory-segmentation-abc-xyz-fsn/)
- [IJERT — Croston Forecasting + Safety Stock for Intermittent Demand](https://www.ijert.org/a-hybrid-inventory-planning-framework-using-croston-forecasting-and-safety-stock-optimization-for-intermittent-automotive-spare-parts-demand-ijertv15is070024)
- [Viewpoint Analysis — Demand Planning Software Options 2026](https://www.viewpointanalysis.com/post/demand-planning-software-options-2026)
- [RELEX Solutions — Supply Chain & Retail Planning](https://www.relexsolutions.com/)
- [LeanLinking — Supplier Performance Scorecard: OTIF & PPM](https://leanlinking.com/guides/supplier-performance-scorecard/)
- [ISM — Supplier Performance Measurement KPIs](https://www.ism.ws/supply-chain/supplier-performance-measurement-kpis/)
