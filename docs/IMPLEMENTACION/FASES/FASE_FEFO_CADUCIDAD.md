# Fase P2 — Caducidad / lote / FEFO

> **Estado: 🟢 P2.0–P2.2 COMPLETA + P2.3 en código — 2026-06-18.** `commercial.stock_lots` + **trigger del invariante** con FEFO-decrement **no-vencido-primero** + **captura lote/caducidad** en recepción + endpoints `GET .../lots` y `GET .../expiring` + **cron de alerta `expiring_lots`** + **aviso `sold_expired`** (warn, NO bloquea) + **dashboard "Por vencer"** (`/comercial/inventory/expiring`) + **trazabilidad por lote** (`commercial.stock_lot_movements` + `GET .../lot-movements`). **Verificado LIVE:** smoke I.5 26/26 + alerts WS 25/25 + trigger expired-last (script FEFO + J.6.1 19/0). Decisión en [ADR-022](../02_DECISIONES_ARQUITECTURA.md). Pendiente: QA visual de P2.2c + 1 reinicio para verde live de P2.3. **Siguiente: P2.4** (conteo físico por lote).

Digitaliza el control de **caducidad** para Mega Dulces (distribuidora de dulces): no vender producto vencido, rotar por **FEFO** (First Expired First Out) y medir/alertar la merma por vencimiento. Reduce merma 30–50% (benchmark industria).

## Modelo (ADR-022, resumen)

**Sub-ledger de lotes aditivo.** Nueva tabla `commercial.stock_lots` que descompone el total de `commercial.stock` por lote+caducidad. `commercial.stock` **sigue siendo el total autoritativo**:

```
INVARIANTE:  SUM(stock_lots.quantity) por (tenant, warehouse, product) == stock.quantity
             SUM(stock_lots.reserved_quantity) ...               == stock.reserved_quantity
```

Así el order flow / conteo físico / portal **no se reescriben**; FEFO se capa encima. FEFO se aplica en el **consumo** (fulfill decrementa el lote que vence primero).

## Gate

1. **¿El ERP/sync provee `lote` + `fecha_caducidad`?** → **RESUELTO 2026-06-18: NO.** Introspección de `inventory.*`/`catalog.*`/`commercial.*` no halló columnas de lote/caducidad (solo `lead_reservations.expires_at`, irrelevante). La data sincronizada del ERP **no trae caducidad** → **P2.1 = captura en recepción** (`recordMovement('in')` con `lot_code`+`expiry_date`). Sync desde las tablas batch crudas de Kepler (kdXX) = refinamiento futuro si se confirma que las tienen.
2. **(abierto) ¿Qué productos caducan?** ¿Todos, o un subset? El lote `NA` (sin caducidad) cubre no-perecederos / sin dato.
3. **Requisito regulatorio MX** (etiquetado/trazabilidad de alimentos): ¿basta caducidad, o se necesita lote para trazabilidad de retiro? (Define si el lote es obligatorio u opcional.)

## Esquema propuesto (`commercial.stock_lots`)

```
id              uuid pk
tenant_id       uuid notNull            -- RLS forzado, FK identity.tenants
warehouse_id    uuid notNull            -- FK compuesta (tenant_id, warehouse_id)
product_id      uuid notNull            -- FK compuesta (tenant_id, product_id)
lot_code        varchar(60) notNull     -- 'NA' para productos sin lote
expiry_date     date                    -- null = no caduca / desconocida
quantity        decimal(14,3) notNull default 0   CHECK >= 0
reserved_quantity decimal(14,3) notNull default 0 CHECK >= 0, CHECK quantity >= reserved
received_at     timestamp
created_at / updated_at / updated_by
UNIQUE (tenant_id, warehouse_id, product_id, lot_code, expiry_date)
INDEX (tenant_id, warehouse_id, product_id, expiry_date)  -- FEFO: ORDER BY expiry_date ASC NULLS LAST
```

(El movimiento por lote se registra reutilizando `commercial.stock_movements` + un `lot_code`/`expiry_date` opcional, o un sub-ledger por lote — decisión de P2.1.)

## Fases

| Fase | Tema | Entrega |
|---|---|---|
| **P2.0** ✅ | Schema `stock_lots` + backfill | ✅ 2026-06-18 (mig `20260618200000`): tabla aditiva (RLS forzado, FKs compuestas a tablas reales, unique `NULLS NOT DISTINCT`, índice FEFO), backfill de 1 lote `NA` por fila de `stock` (32835), invariante verificado local (0 desbalances). Falta el helper que mantenga el invariante en escrituras → P2.1. |
| **P2.1a** ✅ | Trigger del invariante stock↔stock_lots | ✅ 2026-06-18 (mig `20260618210000`): trigger `AFTER UPDATE OF quantity ON commercial.stock` mantiene `SUM(lotes.quantity)=stock.quantity` para **todos** los writers (cero cambios al order flow). NA balancea; baja que excede el buffer NA → decremento **FEFO** de lotes reales (caducidad ASC) — esto **ya cubre el grueso de P2.3**. Verificado: lógica (rollback) + **J.6.1 order flow 19/0** + inventario 22/0. Reserved por lote diferido (P2.3). |
| **P2.1b** ✅ código | Captura lote/caducidad en recepción + lectura de lotes | ✅ 2026-06-18: `recordMovement('in')` acepta `lot_code`+`expiry_date` → upsert del lote real **antes** del update de stock (el trigger mantiene NA). Nuevo `GET /commercial/inventory/stock/:wh/:product/lots` (gate VER, orden FEFO). Build api verde + check en smoke I.5. ⏳ **requiere reinicio de API** para probar live (es código de API). Habilita P2.2 (alertas) y P2.5 (mostrar caducidad). |
| **P2.2a** ✅ código | Endpoint de lotes por vencer | ✅ 2026-06-18: `GET /commercial/inventory/expiring?days=30&warehouse_id=` (gate VER) — lotes con caducidad ≤ hoy+days y stock>0 (incluye vencidos, `days_to_expiry` puede ser ≤0), con producto/almacén/`value_at_cost`, orden caducidad ASC. Build verde + checks en smoke I.5 (ventana 90 incluye / 30 excluye). ⏳ requiere reinicio para probar live. |
| **P2.2b** ✅ código | Cron de alerta de lotes por vencer | ✅ 2026-06-18: scan #3 en `AlertsScannerService` (lotes con `expiry_date <= hoy+30d` y qty>0, **incluye vencidos**) → `emitExpiringLots` (severity `critical` si `<=7d` o vencido, si no `warn`). Reusa el patrón `low_stock` (RLS por `SET LOCAL`, cooldown 1h, gateado por `ENABLE_COMMERCIAL_ALERTS`; `scan-now` lo dispara manual). Tipo `expiring_lots` + umbrales `EXPIRING_LOTS_DAYS=30/CRITICAL_DAYS=7`. Build verde + check WS en smoke alerts (almacén dedicado + lote a +3d → alerta `critical`). ⏳ requiere reinicio para probar live. |
| **P2.2c** ✅ código | Dashboard "Por vencer" | ✅ 2026-06-18: página `/comercial/inventory/expiring` (gate VER, tab "Por vencer" en el strip de inventario) — consume `GET /expiring`, KPIs (valor en riesgo al costo / lotes / ya vencidos), tabla con tag de días (vencido `danger` / ≤7d `danger` / ≤15d `warn`), filtro de ventana (7/15/30/60/90d) + almacén. Build view verde. ⏳ verificación visual manual (no automatizable desde CLI). |
| **P2.2d** ✅ código | Vencidos: no despachar primero + aviso (warn-only) | **Decisión 2026-06-18: warn, NO block** (no se toca el camino de reserva/dinero). Dos partes: (1) **trigger expired-last** (mig `20260618220000`): el decremento FEFO ahora consume **no-vencidos primero** (`ORDER BY (expired) ASC, expiry ASC`), vencidos solo como último recurso → la venta normal ya no despacha vencido. Invariante intacto. **Verificado** (`database/scripts/verify-fefo-expired-last.js` PASS + J.6.1 19/0). (2) **aviso `sold_expired`**: `consume()` devuelve `expiredConsumed` (=`qty - bueno_no_vencido`); `OrdersService.fulfill` emite alerta WS `warn` cuando un despacho tocó lote vencido. Build verde + check WS en smoke alerts. ⏳ la parte (2) requiere reinicio para probar live. |
| **P2.3** ✅ código | Trazabilidad del lote consumido | ✅ 2026-06-18: el decremento FEFO ya lo hace el trigger; acá `consume()` hace **diff before/after** de `stock_lots` (observa, no re-simula) y registra en `commercial.stock_lot_movements` (mig `20260618230000`, RLS forzado, append-only) **qué lote(s) salieron de cada venta** + la ref del pedido. `GET /commercial/inventory/lot-movements?lot_code=&reference_id=&product_id=&warehouse_id=` (gate AJUSTAR) → recall "¿qué pedidos consumieron el lote X?" y "¿de qué lotes salió el pedido Y?". Build api verde + check en smoke alerts (pedido con lote vencido → lot-movement qty 5). ⏳ requiere reinicio. Deferred: trazar ajustes/reconcile a nivel lote (hoy solo ventas). |
| **P2.4** | Conteo físico por lote | Extender Fase I: snapshot/conteo por lote; regla de reconciliación del invariante. |
| **P2.5** | FEFO en vendedor/portal | Mostrar caducidad / próximos a vencer al armar pedido; opcional impedir vender casi-vencido. |

**Orden de valor real:** P2.0 ✅ → P2.1a ✅ (trigger; FEFO-decrement) → P2.1b ✅ captura → P2.2a ✅ `/expiring` → P2.2b ✅ alerta "por vencer" → P2.2d ✅ no-despachar-vencido-primero + aviso `sold_expired` (warn) → P2.2c ✅ dashboard "Por vencer" → P2.3 ✅ trazabilidad del lote consumido → **P2.4 conteo por lote** ← siguiente → P2.5 vendedor/portal.

**P2.2 = 🟢 COMPLETA** (alertas + gate warn + dashboard; falta solo QA visual de P2.2c). **P2.3 ✅ código** (lot-movements ledger; ⏳ reinicio para verde live).

## Riesgos / decisiones abiertas

- **Doble escritura `stock`↔`stock_lots`:** todo path que mueva stock debe tocar ambos en la misma trx (mismo riesgo que hoy `stock`↔ledger). Mitigar con un helper único; nunca escribir uno sin el otro. Considerar un trigger DB que valide el invariante al cerrar la trx (defense-in-depth).
- **Lote `NA`:** productos sin lote/caducidad viven en un lote sintético para sostener el invariante; FEFO los trata como "sin preferencia".
- **Reconciliación de conteo (Fase I) vs lotes:** hasta P2.4, un ajuste por conteo mueve el total; hay que decidir a qué lote se imputa (propuesta: al que vence primero, o exigir desglose por lote).
- **Reserva por lote:** fase 1 reserva contra el total (no por lote). Si dos pedidos compiten por el último lote bueno, la asignación se decide al consumir (fulfill), no al reservar. Evaluar si se necesita reserva-por-lote (cuando la caducidad importe en la promesa de entrega).
- **Mundo `inventory.warehouse_stock` (Kepler SKU):** FEFO es un concern de `commercial.stock`. Si el conteo físico de un almacén usa el mundo `inventory`, los lotes ahí son fase posterior.

## Relacionado
- [ADR-022](../02_DECISIONES_ARQUITECTURA.md) (decisión).
- [FASE_I_INVENTARIO.md](FASE_I_INVENTARIO.md) (conteo físico; §Roadmap P2 listaba FEFO como #1).
- ERP: [[reference_erp_kepler_schema]], `productos_activos`.
