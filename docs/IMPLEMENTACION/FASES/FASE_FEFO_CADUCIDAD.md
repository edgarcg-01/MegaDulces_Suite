# Fase P2 — Caducidad / lote / FEFO

> **Estado: 🔨 P2.0 + P2.1a + P2.1b + P2.2a EN CÓDIGO — 2026-06-18.** `commercial.stock_lots` + **trigger del invariante** con FEFO-decrement (verificado vs order flow J.6.1 19/0) + **captura lote/caducidad** en recepción + endpoints `GET .../lots` y `GET .../expiring`. Decisión en [ADR-022](../02_DECISIONES_ARQUITECTURA.md). **P2.1b/P2.2a son código de API ⏳ pendientes de probar live (reinicio).** Siguiente: **P2.2b** (cron de alerta + dashboard "Por vencer" + gate de vencidos).

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
| **P2.2b** ⬜ | Cron de alerta + dashboard "Por vencer" + gate | Cron estilo low-stock que emite alerta de próximos-a-vencer (reusar `AlertsService`); página/sección "Por vencer"; gate opcional para que FEFO NO venda lotes ya vencidos (saltarlos en el decremento) y/o bloquear venta de vencidos. |
| **P2.3** | **FEFO en el consumo** | `OrderStockService.consume` decrementa lotes por `expiry_date` ASC (vence primero). Registra qué lote(s) consumió. |
| **P2.4** | Conteo físico por lote | Extender Fase I: snapshot/conteo por lote; regla de reconciliación del invariante. |
| **P2.5** | FEFO en vendedor/portal | Mostrar caducidad / próximos a vencer al armar pedido; opcional impedir vender casi-vencido. |

**Orden de valor real:** P2.0 ✅ → P2.1a ✅ (trigger; ya da el FEFO-decrement) → **P2.1b captura** ← siguiente, desbloquea todo (sin lotes reales con fecha no hay nada que alertar/rotar) → P2.2 alertas "por vencer" → P2.3 (registrar el lote consumido en el ledger; el decremento FEFO ya lo hace el trigger) → P2.4 conteo por lote → P2.5 vendedor/portal.

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
