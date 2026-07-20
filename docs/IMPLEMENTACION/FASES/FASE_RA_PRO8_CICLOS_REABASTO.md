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
| RA-PRO.8.3 | Motor: `sugerido` con horizonte=cadencia+lead+colchón; spokes sugieren **traspaso** no compra | ⬜ |
| RA-PRO.8.4 | Detector cadencia-vs-demanda → hallazgo "mal abasto" en `/compras/hallazgos` | ⬜ |
| RA-PRO.8.5 | Worklist "Qué toca hoy" por territorio (analista), filtrando canal ACTIVO | ⬜ |

**Corrida inicial:** 1,950 pares (1,615 compra + 335 traspaso), 1,790 con cadencia. 273 proveedores. Topología `02/03/04→01`, `05→MD-50` fijada en `warehouses.source_warehouse_id`.

## Decisiones / notas

- **Aplicado directo a Railway vía `up()`** (no `migrate:latest` — hay backlog de migraciones de otras fases pendientes de prod). El deploy formal lo registrará idempotente.
- **Al fijar `source_warehouse_id`**, el próximo `import-network-reorder` (DRP, RA-PRO.6) recalculará PH/Canindo por **demanda dependiente** de sus spokes — es el comportamiento correcto, pero cambia los números de reorden de PH.
- **cadence_source='manual'** protege del job las filas que la coordinadora/analistas ajusten (bandeja HITL, pendiente).
- **Territorios** (para el worklist): coordinadora general = CEDIS+PH(+02/03/04) ; analista Morelia = MD-30+MD-32 ; analista Zamora = MD-50+05.
- Data-quality pendiente: proveedor "Las Delicias" **duplicado** (2 IDs); mojibake `Ñ→�` en nombres de proveedor.
