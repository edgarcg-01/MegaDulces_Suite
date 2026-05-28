# 04 — Flujo end-to-end: Trade Marketing → Comercial → Logística → Comercial

> **Documento de revisión + plan de correcciones.**
> **Fecha**: 2026-05-27.
> **Origen**: Edgar describió el flujo de negocio esperado y pidió análisis detallado vs lo construido.
> **Objetivo**: cerrar los gaps que rompen el flujo end-to-end antes del arranque beta.

---

## 1. Flujo de negocio descrito por Edgar (autoritativo)

> *"En Trade Marketing se captura el exhibidor y se registra la tienda. Al registrarse la tienda la misma ya puede hacer pedidos, pedidos que se administran en Comercial. Comercial genera el pedido y se valida manual. Pedido que se envía a Embarques, en Embarques se genera lo necesario y se envía. Se entrega y se envía el estado a Comercial."*

### Flujo ideal canonizado

```
┌─────────────────────────────────────────────────────────────────┐
│  TRADE MARKETING                                                │
│  - Capturar exhibidor (visit + scoring)                         │
│  - Registrar tienda (public.stores)                             │
│        │                                                        │
│        ▼                                                        │
│  ✨ Tienda registrada ─── automáticamente habilitada para B2B   │
└─────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  COMERCIAL                                                      │
│  - Tienda toma pedido (Portal B2B) o vendedor toma (Vendor)     │
│        │                                                        │
│        ▼                                                        │
│  - Pedido entra como draft → admin valida MANUAL → confirmed    │
│  - Stock se reserva                                             │
│        │                                                        │
│        ▼                                                        │
│  - Pedido confirmed visible en cola de Logística                │
└─────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  LOGÍSTICA (Embarques)                                          │
│  - Logística toma pedido confirmed                              │
│  - Genera shipment + asigna vehículo + ruta                     │
│  - Crea delivery guides + recipients + chofer                   │
│  - Registra costos del viaje                                    │
│        │                                                        │
│  - depart → en_ruta                                             │
│  - deliver → entregado (recipients con foto + GPS)              │
│  - close → cerrado                                              │
└─────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  COMERCIAL recibe estado                                        │
│  - order.status → fulfilled (automático al cerrar última ship.) │
│  - Stock reservado → consumido (sale)                           │
│  - Pruebas de entrega visibles para revisión                    │
│  - Cliente notificado (futuro — Fase F WhatsApp)                │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Estado actual end-to-end — mapeo paso a paso

| Paso del flujo | Implementado | Cómo | Brecha |
|---|---|---|---|
| 1.1 Capturar exhibidor | ✅ | `/dashboard/captures` → `public.daily_captures` + scoring | — |
| 1.2 Registrar tienda | ✅ | `/dashboard/stores` → `public.stores` | — |
| 1.3 Tienda → puede pedir | ❌ | Tienda y customer son entidades separadas; vinculación manual | **GAP-2 + GAP-3** |
| 2.1 Cliente toma pedido | ✅ | `/portal/cart` (B2B) o `/vendor/take-order` (campo) o `/comercial/orders` (admin) | — |
| 2.2 Comercial valida manual | ✅ | Botón "Confirmar" en `/comercial/orders/:id` → `confirm` endpoint | — |
| 2.3 Stock reservado | ✅ | `OrdersService.confirm()` crea `stock_movements.type='reserve'` | — |
| 3.1 Pedido visible en Logística | ⚠️ | Solo via filtro manual `?status=confirmed` en pedidos | **GAP-5** |
| 3.2 Logística crea shipment | ✅ | Botón "Crear embarque" en order detail (J.4) | — |
| 3.3 Asignar vehículo + ruta | ✅ | Form de shipment + state machine | — |
| 3.4 Crear guías + recipients | ✅ | `/logistica/shipments/:id` → tab Guías | — |
| 3.5 Registrar costos | ✅ | `/logistica/shipments/:id` → tab Costos | — |
| 3.6 Depart / Deliver / Close | ✅ | Acciones inline + state machine con lock pesimista | — |
| 3.7 Recipients con foto+GPS | ✅ | Endpoint `markRecipientDelivered` con campos `proof_photo_url`, `gps_lat/lng` | UI captura foto no probada |
| 4.1 Estado vuelve a Comercial | ⚠️ | Hook close→fulfilled marca status pero NO consume stock | **GAP-1 (CRÍTICO)** |
| 4.2 Stock consumido (sale) | ❌ | Bug: el hook bypassea `OrdersService.fulfill()` | **GAP-1** |
| 4.3 Pruebas de entrega visibles en Comercial | ❌ | Order detail no muestra recipients ni fotos | **GAP-6** |
| 4.4 Cliente notificado | ❌ | Sin sistema de notificación | **GAP-7** (deferred Fase F) |

**Resumen visual:**

```
Trade Mkt → Tienda registrada    ❌ NO crea customer automático (GAP-2,3)
Tienda     → Hace pedido         ⚠️ Solo si admin la promovió a customer + creó user B2B
Comercial  → Recibe + valida     ✅ Funciona
Comercial  → Envía a embarques   ✅ Manual via botón en order detail
Logística  → Genera + envía      ✅ Funciona
Logística  → Entrega             ✅ Funciona
Estado     → Vuelve a Comercial  🔴 BUG: marca fulfilled pero NO consume stock (GAP-1)
```

---

## 3. GAPS críticos (bloqueantes para beta)

### 🔴 GAP-1 — Hook `close → fulfilled` no consume stock

**Severidad:** CRÍTICA — rompe invariante de inventario.

**Ubicación del bug:** [`apps/api/src/modules/logistics-shipments/logistics-shipments.service.ts:226-249`](apps/api/src/modules/logistics-shipments/logistics-shipments.service.ts#L226-L249).

**Código actual (incorrecto):**

```typescript
async close(id: string) {
  return this.transition(id, 'cerrado', async (trx, shipment) => {
    // ...
    if (shipment.order_id) {
      const open = await trx('logistics.shipments').where(...).first();
      if (!open) {
        await trx('commercial.orders')
          .where({ id: shipment.order_id })
          .whereIn('status', ['confirmed'])
          .update({ status: 'fulfilled', fulfilled_at: trx.fn.now(), updated_at: trx.fn.now() });
        // ❌ FALTA: consumir stock + registrar history + emitir alert WS
      }
    }
    return { closed_at: trx.fn.now() };
  });
}
```

**Lo que debería hacer (referencia: `OrdersService.fulfill()` en `commercial-orders.service.ts:334-385`):**

1. Cargar líneas del pedido.
2. Por cada línea, llamar `consumeStockInline(trx, warehouse_id, product_id, quantity, orderId)` — crea `stock_movements.type='sale'` + actualiza `stock`.
3. Actualizar `orders.status = 'fulfilled'` + `fulfilled_at` + `updated_by`.
4. Llamar `recordHistory(trx, orderId, 'confirmed', 'fulfilled', null)` — registra en `commercial.order_status_history`.
5. Emitir alerta WS `emitOrderFulfilled` con info del customer.

**Impactos del bug actual:**

- Stock reservado queda eternamente en estado `reserved` (nunca pasa a `sale`).
- Inventario disponible queda inflado para reads, sub-reportado para análisis.
- `analytics.mv_top_products_30d` cuenta mal (no detecta el "consumo real").
- `order_status_history` no registra la transición `confirmed → fulfilled` (audit trail roto).
- Customer B2B no recibe alert WS de su pedido entregado.
- Si se cancela el shipment post-fulfill, la lógica de liberar reservas tampoco se ejecuta (no aplica acá pero relacionado).

**Plan de fix (~3 horas):**

**Opción A — Llamar OrdersService.fulfill() desde el hook (recomendada):**

1. Crear módulo nuevo `apps/api/src/modules/commercial-logistics-bridge/commercial-logistics-bridge.module.ts` que importe ambos módulos.
2. Mover el hook de `ShipmentsService.close()` a un service `CommercialLogisticsBridgeService` que tenga inyectado tanto `OrdersService` como `ShipmentsService`.
3. `ShipmentsService.close()` deja de hacer el UPDATE manual; en su lugar emite un evento o llama directo al bridge.
4. El bridge dentro del mismo trx: llama `OrdersService.fulfill(orderId)` que hace todo correctamente.

**Opción B — Refactor en sitio (más simple pero acopla módulos):**

1. Inyectar `CommercialOrdersService` en `LogisticsShipmentsModule`.
2. En `close()`, reemplazar el UPDATE manual por: `await this.commercialOrders.fulfillInTransaction(trx, shipment.order_id)`.
3. Requiere agregar un método `fulfillInTransaction(trx, orderId)` en `OrdersService` que recibe el trx ya abierto (refactor de `fulfill()` para extraer la lógica reusable).

**Recomendación:** **Opción B** — más simple, mantiene `OrdersService` como single source of truth para fulfill. La circular dependency entre módulos se resuelve con `forwardRef()` si fuera necesaria (probable que no, porque commercial no importa logistics).

**Archivos a tocar:**

- `apps/api/src/modules/commercial-orders/commercial-orders.service.ts` — extraer `fulfillInTransaction(trx, orderId)` privado, hacer público.
- `apps/api/src/modules/commercial-orders/commercial-orders.module.ts` — exportar service (ya lo hace).
- `apps/api/src/modules/logistics-shipments/logistics-shipments.module.ts` — agregar `imports: [CommercialOrdersModule]`.
- `apps/api/src/modules/logistics-shipments/logistics-shipments.service.ts` — inyectar `CommercialOrdersService`, reemplazar UPDATE manual.

**Test plan:**

- Update `database/http-logistics-e2e-test.js`: después de `close`, verificar:
  - `GET /commercial/orders/:id` devuelve `status='fulfilled'`.
  - `GET /commercial/orders/:id/history` muestra la transición `confirmed → fulfilled`.
  - `GET /commercial/inventory/:warehouse_id/stock` muestra stock consumido (no solo reservado).

**Estimado:** 3 horas (refactor + tests).

---

### 🔴 GAP-2 — Tienda registrada NO se convierte automáticamente en cliente comercial

**Severidad:** CRÍTICA para que el flujo descrito sea cierto. Hoy la frase *"al registrarse la tienda la misma ya puede hacer pedidos"* es **falsa**.

**Estado actual:**

- `public.stores` (Trade Marketing) y `commercial.customers` (Comercial) son tablas separadas.
- FK opcional `commercial.customers.store_id` → `public.stores(tenant_id, id)`.
- Vinculación es 100% manual desde admin de customers.

**Opciones de fix:**

**Opción A — Botón explícito en stores detail (RECOMENDADA):**

UI: en `/dashboard/stores/:id` agregar botón "Promover a cliente comercial".

Modal:
- Sugiere code = `STR-{slug del nombre}`.
- Selector de price list (default = la del tenant).
- Crédito (default 0 — cash).
- Botón Crear.

Backend: `POST /commercial/customers/from-store` con body `{ store_id, code, name?, default_price_list_id?, credit_limit? }`.
- Valida que el store existe + pertenece al tenant.
- Valida que no haya ya un customer con `store_id = X` (idempotencia).
- Crea customer con `store_id` vinculado.
- Devuelve customer creado.

**Opción B — Checkbox al crear tienda:**

UI: en form de crear store, agregar `[ ] También crear cliente comercial para esta tienda`.

Si tildado: hace 2 INSERTs en el mismo trx.

**Opción C — Background job auto:**

Al crear store, encolar job que crea customer asíncrono. Descartada — implícito mal para audit.

**Recomendación:** **Opción A** — explícito, opt-in, controlable, audit trail claro.

**Archivos a tocar:**

- `apps/api/src/modules/commercial-customers/commercial-customers.service.ts` — método `createFromStore(dto)`.
- `apps/api/src/modules/commercial-customers/commercial-customers.controller.ts` — endpoint `POST /commercial/customers/from-store`.
- `apps/view/src/app/modules/dashboard/stores/stores.component.ts` — botón "Promover a cliente comercial" en store row o detail.
- `apps/view/src/app/modules/comercial/comercial.service.ts` — método `promoteStoreToCustomer()`.

**Test plan:**

- DB smoke test `test-store-to-customer.js`:
  - Crear store
  - Llamar `createFromStore` con su id
  - Verificar customer creado con `store_id` correcto
  - Re-llamar (debe rechazar con 409 idempotencia).

**Estimado:** 4 horas (backend + UI + tests).

---

### 🔴 GAP-3 — Customer comercial NO tiene auto-creación de user portal B2B

**Severidad:** CRÍTICA en combinación con GAP-2. Sin esto, aunque la tienda quede como customer, no puede entrar al portal `/portal` a tomar pedidos.

**Estado actual:** crear el `public.users` con `role_name='customer_b2b'` y `customer_id=X` se hace via seed o admin de usuarios.

**Plan de fix:**

UI: en `/comercial/customers/:id` agregar botón "Crear acceso B2B".

Modal:
- Username sugerido: `cliente_{customer.code lowercase}`.
- Password temporal generado (UUID corto o 8 chars random) — mostrar UNA SOLA VEZ con copy-to-clipboard.
- Email (opcional) — para envío de credenciales (futuro).
- Botón Crear.

Backend: `POST /commercial/customers/:id/portal-access` con body `{ username?, password? }`.

- Valida customer existe + pertenece al tenant.
- Valida no exista user con `customer_id = X` ya (idempotencia).
- Crea user con `role_name='customer_b2b'`, `customer_id=X`, hash del password.
- Devuelve `{ username, temporary_password }` — el password se DEVUELVE solo en el response, nunca persistido en plano.

**Archivos a tocar:**

- `apps/api/src/modules/commercial-customers/commercial-customers.service.ts` — método `createPortalAccess(customerId, dto)`.
- `apps/api/src/modules/commercial-customers/commercial-customers.controller.ts` — endpoint.
- `apps/view/src/app/modules/comercial/pages/comercial-customers.component.ts` (o un detail page nuevo) — botón + modal.

**Test plan:**

- HTTP test agregar a `http-logistics-e2e-test.js` (o crear `http-customer-portal-access-test.js`):
  - Crear customer.
  - POST create portal access.
  - Logout admin.
  - POST `/auth-mt/login` con el username + password devuelto.
  - Verificar JWT tiene `customer_id = X` y `role_name = customer_b2b`.

**Estimado:** 3 horas.

---

## 4. GAPS medianos (mejoran flow operativo, no bloquean)

### 🟡 GAP-4 — Validación manual y envío a embarques requieren 2 acciones humanas separadas

**Estado actual:** admin debe (1) confirmar pedido, después (2) entrar a Logística y crear embarque.

**Decisión arquitectónica pendiente:**

Opciones:
- **A.** Dejar como está (2 pasos) — pro: separa responsabilidades comercial vs logística (puede ser diferente persona).
- **B.** CTA combinado "Confirmar y mandar a embarques" cuando user tiene ambos permisos — pro: UX más rápido.
- **C.** Auto-crear shipment al confirmar — pro: 1 paso; contra: rompe principio de explicit + sorprende a usuarios sin perms logística.

**Recomendación:** **A** para beta, **B** si la operación lo pide después.

**Sin fix por ahora.** Documentar y esperar feedback operativo.

---

### 🟡 GAP-5 — Logística no ve cola de "pedidos confirmados esperando embarque"

**Estado actual:** `/logistica/shipments` muestra solo embarques YA creados. Para saber qué pedidos confirmed no tienen shipment, hay que ir a `/comercial/orders?status=confirmed` y revisar uno por uno.

**Plan de fix:**

Backend: endpoint nuevo `GET /logistics/shipments/pending-orders`.

Query:
```sql
SELECT o.id, o.code, o.created_at, o.total,
       c.name AS customer_name,
       (SELECT json_agg(json_build_object('id', s.id, 'folio', s.folio, 'status', s.status))
          FROM logistics.shipments s
          WHERE s.order_id = o.id AND s.deleted_at IS NULL) AS shipments
FROM commercial.orders o
LEFT JOIN commercial.customers c ON c.id = o.customer_id
WHERE o.status = 'confirmed'
  AND o.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM logistics.shipments s
    WHERE s.order_id = o.id
      AND s.deleted_at IS NULL
      AND s.status NOT IN ('cancelado')
  )
ORDER BY o.created_at ASC
```

Frontend: en `/logistica/shipments`, agregar tab "Pendientes de programar" arriba de la tabla actual. Cada fila tiene botón "Crear embarque" → mismo flow que J.4 (auto-abrir dialog pre-llenado).

**Archivos:**
- `apps/api/src/modules/logistics-shipments/logistics-shipments.service.ts` — método `listPendingOrders()`.
- `apps/api/src/modules/logistics-shipments/logistics-shipments.controller.ts` — endpoint.
- `apps/view/src/app/modules/logistica/logistica.service.ts` — wrapper.
- `apps/view/src/app/modules/logistica/pages/logistica-shipments.component.ts` — tabs (nuevo).

**Estimado:** 4 horas.

---

### 🟡 GAP-6 — Estado granular de entrega no viaja a Comercial

**Estado actual:** Comercial ve tabla de shipments con `status` (`cerrado` = entregado todo). NO ve:
- Qué destinatarios recibieron y cuáles fallaron.
- Foto de prueba de entrega.
- GPS de entrega.
- Cuántas cajas se entregaron vs cuántas se esperaban.

**Plan de fix:**

En `comercial-order-detail.component.ts`, expandir cada fila de shipment (`<p-table>` con `expanded` o `pTemplate="rowexpansion"`) para mostrar:
- Mini-tabla de guides con recipients.
- Para cada recipient: status, delivered_to, link a foto (open in lightbox), pin GPS (link a Google Maps con `?q=lat,lng`).

Data: `GET /logistics/guides?shipment_id=X` ya devuelve guides; expand cada guide a `GET /logistics/guides/:id` para sacar recipients.

Alternativa más simple: agregar un endpoint helper `GET /logistics/shipments/:id/recipients` que devuelve todos los recipients de un shipment con sus guides (1 sola query).

**Estimado:** 5 horas (UI + helper endpoint).

---

### 🟡 GAP-7 — Customer B2B no recibe notificación de cambios

**Estado actual:** cliente toma pedido → admin confirma → logística entrega → order fulfilled. Cliente NO recibe email/WhatsApp. Solo si entra a `/portal/orders` ve cambios.

**Decisión:** deferred a Fase F (WhatsApp Bot). En paralelo: podrían enviarse alerts WS al portal (cliente con `/portal` abierto recibe toast realtime — fácil, reusa `AlertsGateway`).

**Sin fix inmediato.** Documentar como deferred.

---

## 5. GAPS cosméticos

| ID | Descripción | Prioridad |
|---|---|---|
| GAP-8 | No hay "número de remisión" físico para imprimir al entregar pedido al cliente. La guía sí tiene `number`, pero el cliente recibe la guía, no el pedido. | Baja |
| GAP-9 | No hay vista "trazabilidad completa" en una sola pantalla: `pedido → confirmación → shipment(s) → entrega(s) → foto firma`. | Media (UX nice-to-have) |
| GAP-10 | `stores.activo` y `customers.active` son flags separados. Dar de baja una tienda no desactiva su customer. | Baja |

---

## 5b. GAPS nuevos identificados por Edgar 2026-05-27 (post-J.6)

### 🟡 GAP-11 — Tipo de entrega (ruta vs viaje largo) NO se especifica al crear pedido

**Contexto:** Edgar señaló que en la toma de pedido manual hay que elegir si el pedido va a ser enviado:
- **`route`** (por ruta) — entrega dentro de una ruta regular de reparto.
- **`long_trip`** (viaje largo) — viaje dedicado, foráneo, fuera de rutas habituales.

Esto afecta cómo logística arma el shipment (vehículo asignado, comisiones del chofer, costo del flete).

**Estado actual:**
- `commercial.orders` NO tiene columna `delivery_type`.
- Vendor toma pedido en `/vendor/take-order/:customerId` y NO se le pregunta esto.
- Logística decide implícitamente al asignar vehículo/ruta sin contexto del pedido.

**Plan de fix J.6.6:**

1. **Migración** `commercial.orders.delivery_type` VARCHAR(20) NOT NULL DEFAULT 'route' + CHECK IN ('route', 'long_trip').
2. **Backend** `CreateDraftDto` acepta `delivery_type?`. `OrdersService.createDraft()` valida y persiste.
3. **Backend** PATCH `/commercial/orders/:id` permite editar `delivery_type` mientras esté en `draft` (no después).
4. **Frontend vendor** `/vendor/take-order/:customerId` — toggle/select en el header del draft.
5. **Frontend order detail** mostrar badge con valor + button edit si está en draft.
6. **Portal B2B** se default a `route` automáticamente (el cliente B2B no debería decidir esto).

**Impacto en logística:** cuando el operador crea shipment para un order con `delivery_type='long_trip'`, la UI podría auto-marcar el shipment con `type='entrega'` Y sugerir un vehículo de mayor capacidad. Por ahora solo persistimos el dato; el comportamiento adicional viene en sprints futuros.

**Estimado:** 4 horas.

---

### 🟡 GAP-12 — Stock disponible NO visible al tomar pedido

**Contexto:** Edgar quiere que al tomar pedido el vendedor/admin vea claramente qué productos están en existencia y cuáles no, para no agregar líneas que después generen conflicto al confirmar (stock reservation falla).

**Estado actual:**
- Endpoint `GET /api/commercial/price-lists/:id/prices` devuelve `PriceRow[]` con `{ product_id, product_name, price, tax_rate, min_qty }` — SIN stock.
- Vendor/Portal catalog muestra todos los productos sin distinción de disponibilidad.
- Confirm del pedido falla si stock < quantity (correcto), pero el feedback es tardío.

**Plan de fix J.6.7:**

1. **Backend** extender endpoint `GET /api/commercial/price-lists/:id/prices?warehouse_id=X` que LEFT JOIN con `commercial.stock` para devolver `stock_available: number | null` por producto. Si `warehouse_id` no viene, devolver `null` para mantener compatibilidad.
2. **Frontend** `vendor.service.catalogForCustomer()` ahora pasa el warehouse default del tenant en el query.
3. **Frontend vendor catalog UI** badge "✅ En stock: N" verde, "⚠️ Stock bajo: N" amber si < min_qty, "❌ Sin stock" rojo si 0 o null.
4. **Frontend vendor add-line UI** — si `stock_available < quantity` pedida, mostrar warning antes de agregar (no bloquear — permitir backorder con badge).
5. **Decisión**: NO bloquear add-line si sin stock — solo advertir. Razón: el vendedor puede tomar el pedido sabiendo que se entrega cuando entre el reabasto.

**Estimado:** 5 horas.

---

### Sprint J.6.6 + J.6.7 — fixes flow toma de pedido ✅ código (2026-05-27)

| ID | Item | Estado |
|---|---|---|
| J.6.6a | Migración `20260527100006_orders_delivery_type.js` — `commercial.orders.delivery_type VARCHAR(20) NOT NULL DEFAULT 'route'` + CHECK constraint. Aplicada. | ✅ |
| J.6.6b | Backend: `CreateDraftDto.delivery_type?: 'route'\|'long_trip'` + `OrdersService.createDraft()` valida y persiste. Endpoint nuevo `PATCH /commercial/orders/:id` con `UpdateOrderDraftDto` (solo edita `delivery_type` + `notes` en draft). | ✅ |
| J.6.6c | Frontend vendor take-order: signal `deliveryType` + `p-selectButton` ("Por ruta" / "Viaje largo") en header del customer. `onDeliveryTypeChange()` hace PATCH inmediato si ya hay draft. `ensureDraftForCustomer()` pasa el valor en el POST inicial. Carga lee `delivery_type` del draft existente para sincronizar el toggle. | ✅ |
| J.6.7a | Backend: `GET /api/commercial/price-lists/:id/prices?warehouse_id=X` con LEFT JOIN a `commercial.stock` devuelve `stock_available = GREATEST(quantity - reserved, 0)` por producto. Sin `warehouse_id`, devuelve `null` para mantener compatibilidad. | ✅ |
| J.6.7b | Frontend: `PortalService.listPricesForList()` acepta `warehouseId?`. `VendorService.catalogForCustomer()` propaga el warehouse default. UI vendor take-order: badge `p-tag` por producto con severity `success`/`warn`/`danger` según `stock_available` vs `min_qty`. `addToCart()` advierte (no bloquea) si `qty > stock_available` permitiendo backorder. | ✅ |
| J.6.7c | Test smoke — **deferred** a próximo sprint cuando se valide flujo end-to-end con data real. La lógica está cubierta por verificación manual; un test E2E necesita stock conocido por producto en testdata. | ⏸️ |

**Decisiones de diseño:**

- **Default `route`** en migración: no afecta data existente, no requiere backfill.
- **PATCH solo en draft**: editar tipo de entrega post-confirm rompería supuestos de logística que ya estaría planificando.
- **Toggle sin "confirmar"**: `p-selectButton` con `[allowEmpty]="false"` + `onChange` → PATCH inmediato. UX más rápida que un dialog.
- **`stock_available` puede ser null**: explícito que el endpoint NO siempre incluye stock (sin `warehouse_id`). El UI solo muestra badge si `!= null`.
- **Backorder permitido**: el vendedor puede pedir más unidades que stock disponible (warning, no error). Al confirmar el pedido, si no alcanza el stock real, el reserve fallará y el confirm lanza 409 — feedback en el confirm, no en add-to-cart.
- **Portal B2B**: no recibe el toggle de delivery_type (default 'route'). B2B clients no necesitan decidir esto.
- **Order detail badge**: NO incluido en este sprint para acotar scope. Se agregará en J.7 junto con el polish de order detail.

**Pendientes deferred a sprints futuros:**

- Mostrar `delivery_type` en `/comercial/orders` list (filtro) y `/comercial/orders/:id` detail.
- Pre-fill automático del campo `shipment.type` en logística según `order.delivery_type` cuando se crea el embarque.
- Smoke test HTTP automatizado con data conocida.

**Archivos modificados:**

- `database/migrations-newdb/20260527100006_orders_delivery_type.js` (nuevo)
- `apps/api/src/modules/commercial-orders/commercial-orders.service.ts` — `DeliveryType`, `UpdateOrderDraftDto`, `updateDraft()` método nuevo, `createDraft()` valida+persiste
- `apps/api/src/modules/commercial-orders/commercial-orders.controller.ts` — `PATCH /:id`
- `apps/api/src/modules/commercial-pricing/commercial-pricing.service.ts` — `listPrices(priceListId, warehouseId?)` con JOIN a stock
- `apps/api/src/modules/commercial-pricing/commercial-pricing.controller.ts` — `@Query('warehouse_id')`
- `apps/view/src/app/modules/portal/portal.service.ts` — `PriceRow.stock_available?`, `listPricesForList(priceListId, warehouseId?)`
- `apps/view/src/app/modules/vendor/vendor.service.ts` — `catalogForCustomer(customerId, warehouseId?)`, `ensureDraftForCustomer()` acepta `deliveryType`, `updateDraftHeader()` nuevo
- `apps/view/src/app/modules/vendor/pages/vendor-take-order.component.ts` — selectButton + stock badges + warning add-line

---

## 6. Plan de ejecución

### Sprint J.6 — Fixes críticos pre-beta ✅ código (2026-05-27)

| ID | Item | Estado |
|---|---|---|
| J.6.1 | GAP-1: `OrdersService.fulfillInTransaction(trx, orderId)` público + idempotente. `LogisticsShipmentsModule` importa `CommercialOrdersModule`. `close()` reemplaza UPDATE pelado por llamada al service → ahora consume stock + history + alert correctamente. | ✅ |
| J.6.2 | GAP-2: `POST /commercial/customers/from-store` idempotente (devuelve customer existente si store_id ya vinculado). Botón "Promover a cliente B2B" en `/dashboard/stores` con confirm dialog. | ✅ |
| J.6.3a | Migración `20260527100005_users_customer_id_unique.js` — UNIQUE índex partial `(tenant_id, customer_id) WHERE customer_id IS NOT NULL`. Aplica + idempotente (chequea duplicados antes). | ✅ |
| J.6.3b | `POST /commercial/customers/:id/portal-access` — genera username default `cliente_{code}` + password 8 chars random URL-safe + bcrypt hash. Devuelve password una sola vez. Valida role `customer_b2b` existe. | ✅ |
| J.6.3c | Botón "Crear acceso B2B" en `/comercial/customers` (icon `pi pi-key`). Dialog que muestra username + password con copy-to-clipboard + banner amber "copialo ahora". | ✅ |
| J.6.4 | Smoke test `database/http-shipment-hook-fulfill-test.js` (15+ checks: order→confirm reserva, shipment+close consume stock, history confirmed→fulfilled, available disminuye). Agregado a `run-all-tests.js` como suite J.6.1. | ✅ |
| J.6.5 | Tracker actualizado a 100%, entry en `03_LOG_REVISIONES.md`, CLAUDE.md sincronizado | ✅ |

**Bug colateral resuelto:** `ai-product-picker.component.html` tenía `[class.bg-brand/5]` que rompía el parser Angular 18 (`/` interpretado como cierre de tag). Fix: convertido a `[ngClass]="{ 'bg-brand/5': ... }"` que sí lo soporta.

**Archivos modificados:**
- `apps/api/src/modules/commercial-orders/commercial-orders.service.ts` — extraído `fulfillInTransaction()`
- `apps/api/src/modules/commercial-orders/commercial-orders.controller.ts` — sin cambios
- `apps/api/src/modules/logistics-shipments/logistics-shipments.module.ts` — import CommercialOrdersModule
- `apps/api/src/modules/logistics-shipments/logistics-shipments.service.ts` — close() llama fulfillInTransaction
- `apps/api/src/modules/commercial-customers/commercial-customers.service.ts` — métodos `createFromStore` + `createPortalAccess`
- `apps/api/src/modules/commercial-customers/commercial-customers.controller.ts` — endpoints `from-store` + `:id/portal-access`
- `database/migrations-newdb/20260527100005_users_customer_id_unique.js` (nuevo)
- `database/http-shipment-hook-fulfill-test.js` (nuevo)
- `database/run-all-tests.js` — suite J.6.1 agregada
- `apps/view/src/app/modules/dashboard/stores/stores.component.{ts,html}` — botón promote + computed `canPromoteToCustomer` + método
- `apps/view/src/app/modules/comercial/comercial.service.ts` — wrapper `createPortalAccess`
- `apps/view/src/app/modules/comercial/pages/comercial-customers.component.ts` — botón + dialog acceso con copy-to-clipboard
- `apps/view/src/app/modules/dashboard/captures/ai-product-picker.component.html` — fix `[class.bg-brand/5]` → `[ngClass]`

---

### Sprint J.7 — Cierra el loop operativo (3-4 días)

**Objetivo:** UX completa del flujo end-to-end, cola de pedidos pendientes, trazabilidad visible.

| ID | Item | Estado |
|---|---|---|
| **J.7.1** | **GAP-5: tab "Pendientes de programar" en `/logistica/shipments` ✅ (2026-05-27)** — Backend `GET /logistics/shipments/pending-orders` con NOT EXISTS subquery. Frontend `p-tabs` con 2 tabs (Embarques / Pendientes), badge contador, FIFO por confirmed_at, columna `delivery_type` con badge, botón "Crear embarque" pre-llena form. Bonus: columna `Entrega` + badge en order detail header (J.7.1c). | ✅ |
| J.7.2 | GAP-6: expandir shipments en order detail con recipients + foto + GPS | ⬜ |
| J.7.3 | GAP-9: timeline de trazabilidad en order detail (pedido → confirm → shipments → entregas) | ⬜ |
| J.7.4 | UI/UX polish del flow completo (revisión visual end-to-end) | ⬜ |
| J.7.5 | Tests E2E del flow completo: crear store → promover → crear user B2B → login portal → crear pedido → admin confirma → logística crea shipment → entrega → verificar fulfilled + stock consumido | ⬜ |

**Estimado restante:** ~17 horas (2.5 días). J.7.1 cerrado en 2026-05-27.

**Archivos modificados J.7.1:**

- `apps/api/src/modules/logistics-shipments/logistics-shipments.service.ts` — método `pendingOrders()`
- `apps/api/src/modules/logistics-shipments/logistics-shipments.controller.ts` — endpoint `GET /pending-orders` (antes de `:id`)
- `apps/view/src/app/modules/logistica/logistica.service.ts` — interface `PendingOrder` + `listPendingOrders()`
- `apps/view/src/app/modules/logistica/pages/logistica-shipments.component.ts` — tabs + signals `pendingOrders`/`loadingPending` + `loadPending()` + `openCreateForOrder()` con pre-fill desde el order
- `apps/view/src/app/modules/comercial/pages/comercial-orders.component.ts` — columna `Entrega` con badge
- `apps/view/src/app/modules/comercial/pages/comercial-order-detail.component.ts` — badge `delivery_type` en hero
- `apps/view/src/app/modules/comercial/comercial.service.ts` — type `DeliveryType` + `Order.delivery_type` field

---

### Deferred a sprints futuros

- GAP-4 (combo "confirmar y mandar a embarques") — esperar feedback operativo después de beta.
- GAP-7 (notificaciones cliente B2B) — Fase F (WhatsApp Bot).
- GAP-8 (impresión remisión) — pedir si la operación lo necesita.
- GAP-10 (sync `active` stores↔customers) — agregar trigger DB o lifecycle hook cuando se observe el problema.

---

## 7. Decisiones pendientes para Edgar

Antes de arrancar J.6 necesito confirmar:

| Pregunta | Por qué importa | Opciones |
|---|---|---|
| **¿Opción A o B para refactor del hook (GAP-1)?** | Determina si hago un módulo bridge nuevo o acoplo logistics → commercial directo. | A: módulo bridge (más limpio, más código). **B: inyección directa (recomendada, simple).** |
| **¿Opción A o B para promover store→customer (GAP-2)?** | Define UX del registro de tiendas. | **A: botón explícito en stores detail (recomendada).** B: checkbox al crear store. |
| **Password temporal del user B2B (GAP-3): ¿generado automático o manual?** | Afecta seguridad y UX. | **Auto-generado (recomendada — 8 chars random)**, devuelto UNA VEZ, copy-to-clipboard. Manual: admin lo escribe. |
| **¿Empezar J.6 ahora o esperar validación visual del flow actual primero?** | Sin J.6 el inventario miente. Validación visual igual descubrirá GAP-1. | **Empezar J.6 ya (recomendada).** Validación visual mientras tanto puede revelar más bugs. |
| **¿J.7 después de J.6 o lanzar beta con solo J.6 cerrado?** | J.7 es UX, no inventario. Beta puede arrancar sin J.7 con riesgo aceptable. | A: J.6 + J.7 antes de beta (más prolijo). **B: J.6 y arrancar beta, J.7 en paralelo.** |

---

## 8. Riesgos y consideraciones

### Riesgo: data ya creada con stock inflado

Si **ya hay shipments cerrados** post-J.4 (el hook está activo desde 2026-05-27), el stock de esos pedidos quedó como `reserved` para siempre.

**Mitigación:** después del fix de GAP-1, correr migración one-off:
```sql
-- Para cada order fulfilled sin movement type='sale', generar el movement faltante
-- y descontar del stock.reserved + sumar al saldo "sold"
```

Esto requiere un script idempotente. **Hay que escribirlo y correr antes de beta**.

### Riesgo: customer creado desde store sin price list válido

Si el tenant no tiene un `price_lists.is_default = true`, el `createFromStore` debe fallar o asignar uno explícitamente.

**Mitigación:** validar en el endpoint que existe default price list, sino requerir `default_price_list_id` en el body.

### Riesgo: doble creación accidental de portal users

Si admin clickea "Crear acceso B2B" 2 veces, no debería crear 2 users.

**Mitigación:** unique constraint `(tenant_id, customer_id)` en `public.users` donde `customer_id IS NOT NULL`. Verificar si existe — si no, agregar migración.

---

## 9. Próximo paso accionable

1. Edgar revisa este doc y responde las 5 preguntas de Sección 7.
2. Si aprueba, arranco **J.6.1** (refactor hook) — el más bloqueante.
3. Voy ejecutando los items de J.6 secuencialmente, actualizando estado en `01_TRACKER_PROGRESO.md` después de cada uno.
4. Cierre de J.6 cuando los 5 items estén ✅. Entry en `03_LOG_REVISIONES.md`.
5. Decisión Edgar: arrancar beta con J.6 o continuar con J.7.

---

## Anexo: referencias del código actual

- Hook bug: [`logistics-shipments.service.ts:226-249`](apps/api/src/modules/logistics-shipments/logistics-shipments.service.ts#L226-L249)
- `OrdersService.fulfill()` correcto: [`commercial-orders.service.ts:334-385`](apps/api/src/modules/commercial-orders/commercial-orders.service.ts#L334-L385)
- FK store↔customer: [`20260526100001_commercial_customers_warehouses.js:62-67`](database/migrations-newdb/20260526100001_commercial_customers_warehouses.js#L62-L67)
- Composite FK shipment↔order: [`20260527100002_logistics_shipments.js:72-77`](database/migrations-newdb/20260527100002_logistics_shipments.js#L72-L77)
- Seed customer_b2b user: [`05_mega_dulces_demo_customer_user.js`](database/seeds-newdb/05_mega_dulces_demo_customer_user.js)
