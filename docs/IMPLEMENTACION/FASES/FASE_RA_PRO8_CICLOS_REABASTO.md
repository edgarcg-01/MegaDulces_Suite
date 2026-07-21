# Fase RA-PRO.8 — Ciclos de Reabasto (cadencia por proveedor/línea)

> ADR-030 (Reabastecimiento). Complemento del punto de reorden: **cuándo** y **cada cuánto** se reabastece, no solo cuánto. Origen: plática con Edgar 2026-07-17→20 sobre "ciclos de compra por día de proveedor". Detalle de dominio en memoria `reference_kepler_supply_network_topology`.

## Problema

El motor (Existencia Crítica) modela el **lead time** pero no el **período de revisión** (cada cuánto se compra). El equipo de compras usa "días de cobertura" (safe rate 8→1 días) para puentear hasta la próxima visita del proveedor. Sin ese ciclo, el `sugerido` no coincide con lo que compran a mano (ver análisis del pedido Las Delicias: 693 cajas / $500k, diferencias por método + existencia + SKUs que no tocaban).

## Modelo (validado con datos, 2026-07-20)

**Topología de red (2-3 escalones):**
- **Puntos de compra directa** (raíces): `00` CEDIS, `01` PH (hub Bajío), `MD-30` Morelia Abastos, `MD-50` Canindo.
- **Spokes por traspaso ~3d**: `02`,`03`,`04` ← PH ; `05` ← Canindo. `MD-32` Madero = híbrido (Abastos para las líneas que concentra, directo el resto).
- **El canal se decide por (almacén × proveedor)**, no por almacén ("cuando el proveedor es Morelia Abastos = traspaso"). Un hub actúa como "proveedor" de sus spokes.

**Cadencia (derivada del histórico `analytics.stock_movements`):**
- Compra = `genero='X' AND doc_type='40'` (Orden de entrada X-A-40) + `doc_code='WIN_C'` (Wincaja). Per (punto-compra × proveedor).
- Traspaso = `doc_type='50' AND doc_code='TrsfRcv'` (Recepción U-A-50). Per almacén (todos los proveedores en el mismo camión ~3d).
- Cadencia = mediana del gap entre días de entrega. Clasificación de canal con **ventana reciente (120d)** para no contaminar con historial pre-switch (La Piedad cambió compra→traspaso abr-2026).
- Bandas: ≤7d rápida · 7-14d promedio · >14d "mal abasto" (informativa; el detector real cruza con **rotación** — un proveedor chico/trimestral a 40d es normal).
- Disparo del pedido = al RECIBIR el anterior se revisa existencia y se corta el siguiente. Horizonte a cubrir = `cadencia(R) + lead_time + colchón`.

## Estado

| Sprint | Qué | Estado |
|---|---|---|
| RA-PRO.8.1 | Mig `commercial.replenishment_channel` (almacén×proveedor: via/source_wh/cadence/next_due/band, RLS) | ✅ PROD 2026-07-20 |
| RA-PRO.8.2 | Job `import-replenishment-cadence.js` (deriva canal+cadencia, topología, UPSERT idempotente) | ✅ PROD 2026-07-20 |
| RA-PRO.8.3 | Motor: `worklist()` + `GET /commercial/replenishment/worklist` — sugerido con horizonte=cadencia+lead(traspaso=1d)+colchón, agregado por (almacén×proveedor), solo canal activo | ✅ código+build 2026-07-20 |
| RA-PRO.8.4 | Detector `cadencia_lenta` en scanner (mig CHECK kind) — SKU que ROTA (avg≥2/d por velocidad, NO ABC-valor) + `avg×cadencia > reorden` + cadencia>21d → hallazgo | ✅ código+build 2026-07-20 |
| RA-PRO.8.5 | Página `/compras/que-toca` "Qué toca hoy" (KPIs vencido/hoy/próx7 + tabla + presets territorio + canal compra/traspaso) + nav | ✅ código+build 2026-07-20 |

**Corrida inicial:** 1,950 pares (1,615 compra + 335 traspaso), 1,790 con cadencia. 273 proveedores. Topología `02/03/04→01`, `05→MD-50` fijada en `warehouses.source_warehouse_id`.

**Validado en runtime (queries directas a prod):** worklist 1,196 canales activos (631 vencidos, 96 hoy, 221 próx7) con sugerido agregado; detector 303 hallazgos (9 crítica / 55 alta / 239 media). Builds `nx build api` + `nx build view` verdes.

**Lección de calibración:** el gate de "rota" NO puede ser ABC-por-valor — el dulce es casi todo clase C aunque venda mucho (velocidad alta, valor unitario bajo). Se usa `avg_daily_units` (velocidad). Mismo error a evitar en cualquier detector de rotación sobre este catálogo.

**Pendiente:** redeploy api+view a Railway (el código está listo; datos ya en prod). El scanner nocturno poblará `cadencia_lenta` (o `POST /scan-now` tras deploy). Nota: los "vencidos" del worklist se inflan si los feeds de movimientos no están al día (next_due se calcula del último recibo); con feeds diarios se autocorrige.

## Decisiones / notas

- **Aplicado directo a Railway vía `up()`** (no `migrate:latest` — hay backlog de migraciones de otras fases pendientes de prod). El deploy formal lo registrará idempotente.
- **Al fijar `source_warehouse_id`**, el próximo `import-network-reorder` (DRP, RA-PRO.6) recalculará PH/Canindo por **demanda dependiente** de sus spokes — es el comportamiento correcto, pero cambia los números de reorden de PH.
- **cadence_source='manual'** protege del job las filas que la coordinadora/analistas ajusten (bandeja HITL, pendiente).
- **Territorios** (para el worklist): coordinadora general = CEDIS+PH(+02/03/04) ; analista Morelia = MD-30+MD-32 ; analista Zamora = MD-50+05.
- **Consolidación de proveedores duplicados ✅ EJECUTADA en Railway 2026-07-20** (`suppliers-normalize --aggressive`): 1219→**959 activos**, 323 soft-deleted, **0 grupos duplicados restantes**, cadencia re-derivada post-fusión (1920 canales). Integridad verificada: 0 productos/canales/requisiciones huérfanos bajo proveedor borrado. GONAC 2→1 (106 prod, 9 canales). El script ahora copia también los params RA-PRO.10 (cadence_override/colchón/min$) al canónico.
- **Data-quality (causa raíz de duplicados) — DIAGNOSTICADO:** el truncamiento viene de **Kepler `kdxd.c3` = char(30)** (121 proveedores con nombre de exactamente 30 chars; ej. GONAC `…SA DE C` vs `…SA DE CV`). Nuestra columna es `varchar(120)` y el importer copia sin cortar → no se arregla en origen (ERP legacy). Mitigación: la clave agresiva `bkey` reagrupa truncado+completo. Pendiente: mojibake `Ñ→�` en nombres (ej. Zermeño).
- **Importer endurecido (`import-kepler-suppliers.js`) ✅ 2026-07-20:** (1) el re-enlace de `products.supplier_id` ahora filtra `s.deleted_at IS NULL` → **nunca re-engancha a un proveedor fusionado** (antes cada import deshacía parte del merge: re-linkeaba por código, incl. soft-deleted); (2) al final agrupa proveedores activos por `bkey` y **avisa si Kepler creó nuevos duplicados** → correr `suppliers-normalize`. Patrón operativo: **import → si avisa, normalize**.

## RA-PRO.9 — Cockpit de compra (unificación con Existencia Crítica) ✅ código+build 2026-07-20

Existencia Crítica y Qué Toca son **dos lentes del mismo motor** (mismo `reorder_policy`+`stock`+`inventory_health`), distinto grano: Crítica = producto×almacén (por alarma de stock); Qué Toca = almacén×proveedor (por calendario). Unificación:

- **Motor unificado**: nueva base de objetivo `target_basis='cadence'` en `criticalStock` — nivel = `demanda × (cadencia + lead_efectivo) + colchón` (traspaso lead=1d), con fallback a `max` si no hay canal. Las bases min/reorden/máx intactas. `criticalStock` ahora expone `replenish_via / cadence_days / next_due_date / cadence_band / source_warehouse_code`.
- **Qué Toca = cockpit master-detail**: cada renglón (almacén×proveedor) se expande a sus SKUs (= `criticalStock` filtrado, base cadence → **los totales casan exacto**: verificado 01 $55.7k / MD-30 $212.4k / MD-50 $79.2k contra el master), editables → **Crear requisición** (compra) o **Crear traspaso** (`source_type=branch`, hub como origen).
- **Existencia Crítica**: gana el objetivo "Ciclo (cadencia)" en el selector, columna **Ciclo** (canal + cadencia + próximo) y cross-link "Qué toca hoy". Sigue siendo la vista de salud/auditoría (todos los buckets, huérfanos, muerto).
- **Regla de diseño**: no se fusionan en una sola tabla — sobrestock/muerto/huérfanos viven solo a nivel SKU y se perderían. Cockpit para *pedir*, auditoría para *vigilar*.
- Builds `nx build api` + `nx build view` verdes. **Pendiente: mismo redeploy** (api+view). Nota: la requisición se crea con `target_basis='max'` (el CHECK de `purchase_requisitions` no incluye 'cadence'; el snapshot por línea lleva los números reales).

## RA-PRO.10 — Parámetros de pedido por proveedor (ciclo manual + mínimo de compra) ✅ código+build 2026-07-20

Origen: análisis del pedido de GRUPO LEVI (Excel con fechas reales de pedido). La cadencia derivada de recibos (~5d) subestima el ciclo real de PEDIDO (~14d) por entregas partidas → se permite override manual + mínimo de compra.

- **Mig** `20260720140000` (prod): `catalog.suppliers += cadence_days_override, colchon_days, min_order_amount` (min_order_boxes ya existía).
- **Input** en `/compras/proveedores`: columnas editables Lead, **Cadencia (override)**, **Colchón (días)**, **Mín cajas**, **Mín $**. Endpoint `POST /suppliers/:id/order-params`.
- **Motor**: con `cadence_days_override`, horizonte = `demanda × (cadencia + colchón)` (solo canales de COMPRA; el traspaso mantiene su ciclo). Aplica en `criticalStock` (base cadence) y `worklist`.
- **Mínimo de compra** (decisión del usuario): **por proveedor (total)** + **sube al mínimo** repartiendo el faltante en los SKUs que más rotan (avg_daily). `GET /suppliers/:id/order` = pedido CONSOLIDADO (todos sus almacenes de compra) evaluado contra el mínimo. Botón "Ver pedido" → diálogo con sugerido→pedido (padded), líneas por almacén.
- **Bug de data-quality corregido**: `factor_purchase` está **roto en todo el catálogo** (8088 productos, 0 con valor>1). El box factor real vive en **`factor_sale`** → el motor usa `COALESCE(NULLIF(factor_sale,0), NULLIF(factor_purchase,0), 1)` para cajas. Sin esto las cajas salían infladas 10-40x (piezas como cajas). Ver `reference_box_factor_factor_sale`.

**Validado (Levi, cadencia 14+7):** motor = 738 cja / $86,758 (dentro del rango histórico real de sus pedidos $48k-$111k; su pedido reciente fue 446 cja / $60,894). El horizonte 21d da un pedido un poco mayor al reciente pero normal. Mínimo probado: con $80k no sube (ya arriba); con mínimo mayor reparte el faltante.

**Pendiente:** redeploy api+view. Diferido: sanear `factor_purchase` global; `supplierOrder` incluye todos los almacenes de compra (incl. CEDIS si tiene canal) — revisar doble-conteo si el CEDIS pasa a DRP.
