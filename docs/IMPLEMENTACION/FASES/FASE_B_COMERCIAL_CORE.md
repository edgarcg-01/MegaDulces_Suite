# Fase B — Core Comercial (built from scratch)

**Duración estimada:** 4-5 semanas (1 dev).
**Objetivo:** dar a la plataforma capacidad de tomar y procesar pedidos B2B reales, gestionar inventario y precios, y cobrar — todo on-platform, sin depender de un ERP externo.

> **Pivot 2026-05-26**: Kepler ERP **no existe**. El core comercial se construye directamente sobre el schema `commercial.*` en `postgres_platform`. Si en el futuro aparece un ERP externo (Kepler, Odoo, SAP, etc.), se integra mediante `postgres_fdw` o sync nocturno hacia estas mismas tablas. Doc original deferred en [`FASE_B_INTEGRACION_KEPLER.md`](FASE_B_INTEGRACION_KEPLER.md).

---

## Pre-requisitos

- ✅ Fase A.0-multitenant completa: DB nueva con tenant_id + RLS operativa.
- ✅ Fase A.0bis completa: hardening backend + Zod schemas listos.
- ✅ ADR-010 documentado (multi-tenancy shared DB + tenant_id + RLS).

---

## Decisiones tomadas en B.0

### Modelo de pago (beta)
- **Solo efectivo**. CHECK constraint en `orders.payment_method` y `payments.payment_method` que rechaza cualquier valor que no sea `'cash'`.
- Cuando se agreguen otros métodos (transferencia, tarjeta) se hace `DROP CONSTRAINT` + recreación, o se reemplaza por tabla catalogable `commercial.payment_methods`.

### Aislamiento multi-tenant
- Cada tabla de `commercial.*` tiene `tenant_id UUID NOT NULL` + composite FK `(tenant_id, parent_id)` → `parent_table(tenant_id, id)` para que sea **imposible** cruzar referencias entre tenants a nivel DB.
- RLS forzado con policy `tenant_isolation USING (tenant_id = public.current_tenant_id())`.
- Grants a `app_runtime` (NOSUPERUSER, no bypassea RLS).

### Cliente B2B vs Store (PdV)
- `commercial.customers` es la entidad legal/comercial que **compra**.
- `public.stores` es el PdV evaluado por trade marketing (visitas, scoring).
- Para tiendas que son ambas cosas, `customers.store_id` apunta opcionalmente al store equivalente.

### Snapshot de precios en pedidos
- `order_lines.unit_price`, `tax_rate`, `discount_percent` se guardan al momento del pedido — no se rehidratan desde `product_prices`. Esto garantiza que el total del pedido es estable aunque la lista de precios cambie después.

### Inventario: stock + stock_movements
- `stock` mantiene el saldo actual por `(warehouse, product)` (UNIQUE).
- `stock_movements` es bitácora append-only. Tipos: `in`, `out`, `adjust`, `reserve`, `release`, `sale`.
- Por ahora la sincronización stock ↔ movements la hace el **servicio** (visible y debugeable). Si surge corrupción por concurrencia, agregar trigger.

---

## Sprints

### Sprint B.0 — Schema comercial base ✅ (2026-05-26)

| ID | Item | Estado |
|---|---|---|
| B.0.1 | Migración `commercial.customers` + `warehouses` | ✅ |
| B.0.2 | Migración `commercial.price_lists` + `product_prices` | ✅ |
| B.0.3 | Migración `commercial.stock` + `stock_movements` | ✅ |
| B.0.4 | Migración `commercial.orders` + `order_lines` + `payments` (cash-only) | ✅ |
| B.0.5 | Seed baseline Mega Dulces (warehouse + price_list + customer demo) | ✅ |
| B.0.6 | Smoke test RLS schema `commercial.*` | ✅ |

**Tablas creadas (9):**
- `commercial.customers`
- `commercial.warehouses`
- `commercial.price_lists`
- `commercial.product_prices`
- `commercial.stock`
- `commercial.stock_movements`
- `commercial.orders`
- `commercial.order_lines`
- `commercial.payments`

**Archivos:**
- `database/migrations-newdb/20260526100001_commercial_customers_warehouses.js`
- `database/migrations-newdb/20260526100002_commercial_pricing.js`
- `database/migrations-newdb/20260526100003_commercial_inventory.js`
- `database/migrations-newdb/20260526100004_commercial_orders_payments.js`
- `database/seeds-newdb/04_mega_dulces_commercial_baseline.js`

---

### Sprint B.1 — Módulos NestJS comerciales (~2 sem)

> **Objetivo:** CRUD operativo para customers, warehouses, pricing, inventory.

- [ ] **[B.1.1]** Módulo `commercial-customers` (`apps/api/src/modules/commercial-customers/`)
  - Controller `/api/commercial/customers` con paginación + filtros + soft delete.
  - Service que respeta tenant context vía AsyncLocalStorage.
  - DTOs con Zod o class-validator.

- [ ] **[B.1.2]** Módulo `commercial-warehouses` (mismo patrón).

- [ ] **[B.1.3]** Módulo `commercial-pricing`
  - CRUD `price_lists`.
  - CRUD `product_prices` (con upsert masivo).
  - Endpoint `GET /api/commercial/products/:id/price?customer_id=X` que resuelve precio según lista del cliente.

- [ ] **[B.1.4]** Módulo `commercial-inventory`
  - `GET /api/commercial/stock?warehouse_id=&product_id=` (con filtros).
  - `POST /api/commercial/stock/adjust` (movement_type='adjust').
  - `POST /api/commercial/stock/movements` (entradas/salidas manuales).

- [ ] **[B.1.5]** Extender enum `Permission` con nuevos permisos:
  - `COMMERCIAL_CUSTOMERS_VER` / `_GESTIONAR`
  - `COMMERCIAL_PRICING_VER` / `_GESTIONAR`
  - `COMMERCIAL_INVENTORY_VER` / `_AJUSTAR`
  - `COMMERCIAL_ORDERS_CREAR` / `_VER` / `_CONFIRMAR` / `_CANCELAR`
  - `COMMERCIAL_PAYMENTS_REGISTRAR`

- [ ] **[B.1.6]** Schemas Zod para JSONB en `apps/api/src/shared/schemas/`: `billing_address`, `shipping_address`.

---

### Sprint B.2 — Pedidos + flujo cash (~2 sem)

> **Objetivo:** flujo end-to-end "tomar pedido → confirmar → entregar → cobrar".

- [ ] **[B.2.1]** Servicio `OrdersService` con state machine:
  ```
  draft → confirmed → fulfilled
                    → cancelled
  draft → cancelled (sin reserva)
  ```

- [ ] **[B.2.2]** Reserva de stock al `confirm`:
  - Inserta `stock_movements` tipo `reserve` con `reference_type='order'`, `reference_id=order.id`.
  - Aumenta `stock.reserved_quantity`.
  - Rechaza si `stock.quantity - stock.reserved_quantity < quantity_pedida`.

- [ ] **[B.2.3]** Consumo al `fulfill`:
  - Movement tipo `sale`.
  - Reduce `stock.quantity` y `stock.reserved_quantity`.

- [ ] **[B.2.4]** Liberación al `cancel` (si estaba `confirmed`):
  - Movement tipo `release`.
  - Reduce `stock.reserved_quantity` (no toca `quantity`).

- [ ] **[B.2.5]** Servicio `PaymentsService`:
  - `POST /api/commercial/orders/:id/payments` con `amount`.
  - Inserta `commercial.payments`.
  - Actualiza `orders.paid_amount` += amount y `balance_due` = total - paid_amount.
  - CHECK ya garantiza `payment_method = 'cash'` en beta.

- [ ] **[B.2.6]** Generador secuencial `code` para orders: `PD-{year}-{NNNNN}` con `nextval` o tabla counter por tenant.

- [ ] **[B.2.7]** Tests integración end-to-end:
  - Crear customer → crear order draft → agregar lines → confirm → fulfill → payment → verificar balance_due=0.
  - Verificar que stock se actualiza correctamente en cada paso.
  - Verificar que RLS bloquea cross-tenant.

---

### Sprint B.3 — Importer + checkpoint (~3 días)

- [ ] **[B.3.1]** Importer CLI `database/importers/commercial_seed.js`:
  - Lee JSON / CSV con clientes, productos, precios reales.
  - Idempotente (upsert por `code`).
  - Validación con Zod antes de insertar.

- [ ] **[B.3.2]** Carga inicial real de Mega Dulces (cuando Edgar tenga los archivos).

- [ ] **[B.3.3]** Entry de cierre en `03_LOG_REVISIONES.md`.

---

## Lo que NO entra en Fase B

- **Facturación CFDI / SAT**: requiere integración con PAC (Quadrum, Edicom, etc.). Difer a Fase G o sprint dedicado.
- **Múltiples métodos de pago** (transferencia, tarjeta, cheque): beta es cash only. Se expande post-beta.
- **Promociones / descuentos por volumen / combos**: se manejan a nivel `discount_percent` por línea por ahora. Catálogo de promos dedicado en Fase G.
- **Backorders / split shipments**: pedido se rechaza si no hay stock. No soportamos entregas parciales en B.
- **Portal B2B web**: eso es Fase D.
- **App de vendedor móvil**: también Fase D.

---

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Concurrencia en `stock`: dos pedidos simultáneos pasan check de stock pero uno deja negativo | Lock pesimista con `SELECT ... FOR UPDATE` en el row de `stock` durante la reserva. Si crece la carga, mover a optimistic con `version` column. |
| Pedidos huérfanos en `draft` indefinidos | Cron nocturno que cancela drafts > 7 días sin actividad (registrado en log_revisiones cuando se agregue). |
| Importer carga data corrupta | Zod valida cada row antes de insert. Dry-run mode obligatorio antes de aplicar. |
| Cambio futuro de payment_method enum | CHECK constraint con `DROP + ADD` sigue funcionando. Alternativa: reemplazar CHECK por FK a `commercial.payment_methods` catalogable. |

---

## Después de Fase B

- **Fase C — Sales Intelligence ampliado**: análisis cruzado de visitas + pedidos para detectar oportunidades de venta.
- **Fase D — Catálogo + Portal B2B + Pedidos**: app de vendedor + portal web donde el cliente arma su propio pedido.
