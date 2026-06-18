# Fase P2 — Caducidad / lote / FEFO

> **Estado: 🔵 DISEÑO (planeación) — 2026-06-18.** Sin código aún. Decisión arquitectónica en [ADR-022](../02_DECISIONES_ARQUITECTURA.md). Requiere aprobación del modelo + resolver el gate del ERP antes de arrancar P2.0.

Digitaliza el control de **caducidad** para Mega Dulces (distribuidora de dulces): no vender producto vencido, rotar por **FEFO** (First Expired First Out) y medir/alertar la merma por vencimiento. Reduce merma 30–50% (benchmark industria).

## Modelo (ADR-022, resumen)

**Sub-ledger de lotes aditivo.** Nueva tabla `commercial.stock_lots` que descompone el total de `commercial.stock` por lote+caducidad. `commercial.stock` **sigue siendo el total autoritativo**:

```
INVARIANTE:  SUM(stock_lots.quantity) por (tenant, warehouse, product) == stock.quantity
             SUM(stock_lots.reserved_quantity) ...               == stock.reserved_quantity
```

Así el order flow / conteo físico / portal **no se reescriben**; FEFO se capa encima. FEFO se aplica en el **consumo** (fulfill decrementa el lote que vence primero).

## Gate (resolver antes de P2.0)

1. **¿El ERP Kepler / `productos_activos` provee `lote` + `fecha_caducidad`?**
   - **Sí** → los lotes se **sincronizan** (extender el importer ERP→stock para poblar `stock_lots`).
   - **No** → los lotes se **capturan** en recepción (`recordMovement('in')` con `lot_code`+`expiry_date`).
   - Acción: inspeccionar el esquema del ERP (kdXX / `productos_activos`) buscando columnas de lote/caducidad. Ver [[reference_erp_kepler_schema]] y `productos_activos`.
2. **¿Qué productos caducan?** ¿Todos, o un subset? Define el lote `default/NA` para no-perecederos.
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
| **P2.0** | Schema `stock_lots` + helper que mantiene el invariante | Migración aditiva; al crearse, backfill 1 lote `NA` por cada fila de `stock` (quantity actual) para arrancar consistente. |
| **P2.1** | Captura del lote en recepción / sync ERP | `recordMovement('in')` acepta `lot_code`+`expiry_date`; mantiene `stock`↔`stock_lots` en la misma trx. Importer ERP si aplica (gate). |
| **P2.2** | **Alertas + gate de caducidad** (valor inmediato) | Cron de próximos-a-vencer + dashboard "Por vencer"; gate opcional para bloquear consumo/venta de lotes vencidos (configurable por tenant). |
| **P2.3** | **FEFO en el consumo** | `OrderStockService.consume` decrementa lotes por `expiry_date` ASC (vence primero). Registra qué lote(s) consumió. |
| **P2.4** | Conteo físico por lote | Extender Fase I: snapshot/conteo por lote; regla de reconciliación del invariante. |
| **P2.5** | FEFO en vendedor/portal | Mostrar caducidad / próximos a vencer al armar pedido; opcional impedir vender casi-vencido. |

**Orden de valor:** P2.0 → P2.2 (alertas, el "no vender vencido" rápido) → P2.3 (FEFO real) → P2.1 completo (sync ERP) → P2.4/P2.5.

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
