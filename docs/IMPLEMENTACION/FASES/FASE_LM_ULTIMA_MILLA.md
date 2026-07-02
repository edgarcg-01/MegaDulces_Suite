# FASE LM — Última Milla (Entrega a Domicilio Local en moto)

> Estado: **🔨 DISEÑADO (planeación)** — 2026-07-02. Sin código aún.
> Propone **ADR-027**. Orquesta `commercial.*` + `logistics.*` + un **PaymentsService** nuevo.
> Origen: SOP "Servicio de Entrega a Domicilio Local — Mega Dulces de los Altos".

---

## 0. TL;DR

El SOP describe una operación **distinta** al vendedor de ruta (preventa/autoventa) que ya
modela la app: es **última milla a domicilio desde sucursal** — el cliente pide por
teléfono/WhatsApp/redes, un repartidor en moto lleva el pedido a su casa, cobra y liquida.

**La buena noticia:** la capa de entrega ya existe casi completa en `logistics.*`
(`shipments` + `delivery_guides` + `guide_recipients` con POD, GPS vivo, ETA, checklists, fotos,
costos, ROI). El pedido, stock y folios ya existen en `commercial.orders`. **No se construye de
cero: se orquesta.**

**Los 4 gaps reales (en orden de valor destrabado):**
1. **PaymentsService + liquidación de efectivo** — el lado del dinero. Hoy `commercial.payments`
   es una tabla vacía nunca usada; `PaymentsService` no existe. Sin esto no hay cobro ni cierre.
2. **Intake a domicilio** — pedido con **dirección ad-hoc** y **cliente casual** (nombre, tel,
   dirección, referencias). Hoy el pedido se ata a un `customer` de cartera con ubicación fija.
3. **Incidencias ricas** — no-localizado (protocolo 10 min), dirección incorrecta, rechazo,
   faltante. Hoy `guide_recipients.status` tiene solo 4 estados planos.
4. **Moto como vehículo + regla de overflow a CEDIS** — capacidad de moto y escalamiento.

Además, dos requisitos de cuadre/evidencia que refuerzan el cierre: **arqueo de efectivo por
denominación** (billetes/monedas) en la liquidación, y **firma del cliente obligatoria** en el POD.

---

## 1. Objetivo y alcance

Digitalizar el SOP de entrega a domicilio local: recepción → preparación → asignación →
entrega → cobro → evidencia → liquidación → KPIs, con control de efectivo por repartidor y
trazabilidad completa.

**Dentro de alcance (beta):**
- Intake manual de pedido a domicilio (captura por cajero/vendedor desde tel/WhatsApp).
- Cliente casual + dirección de entrega por pedido.
- Surtido/verificación (reusa checklist).
- Asignación a repartidor en moto + registro salida/regreso.
- Cobro efectivo/transferencia/anticipado (**PaymentsService nuevo**).
- Evidencia de entrega (foto/firma/confirmación).
- Incidencias tipificadas con protocolos.
- Liquidación diaria del repartidor + cuadre de efectivo.
- KPIs de última milla + modelo financiero (ROI 2-3% de facturación).

**Fuera de alcance (diferido):**
- Bot WhatsApp conversacional para intake automático → **Fase F** (el intake es manual mientras tanto).
- Wallet/pagos digitales integrados y **procesamiento real de tarjeta (terminal/pasarela)** → **Fase H**.
  En LM la tarjeta es solo un método de captura (registrar voucher), el cobro lo hace una terminal externa.
- Optimización multi-repartidor / balanceo automático de carga (el solver NN+2-opt existente basta).
- Carta Porte (innecesaria para traslado local urbano).

---

## 2. ADR-027 (propuesto) — Última milla = orquestación, no módulo nuevo

**Contexto:** el SOP toca 3 dominios (pedido, entrega, dinero). Dos ya existen maduros.

**Decisión:**
- El **pedido** a domicilio ES un `commercial.orders` con `delivery_type = 'home_delivery'`
  (nuevo valor del enum, hoy `'route' | 'long_trip'`). Reusa state machine, stock atómico,
  folios `PD-YYYY-NNNNN`, promos, totales.
- La **entrega** ES un `logistics.delivery_guides` + `guide_recipients` (1 parada = 1 domicilio).
  Reusa asignación de chofer, POD (`proof_photo_url`, `delivered_to`, `gps_lat/lng`), GPS vivo,
  ETA, fotos, checklist. La moto es un `logistics.vehicles` con capacidad chica.
- El **dinero** es lo único genuinamente nuevo: `PaymentsService` sobre la tabla existente
  `commercial.payments` (extendida) + una tabla de **corte/liquidación** por repartidor-día.
- El puente pedido↔entrega ya existe (hook J.10 `orders → shipments`); se extiende para el caso
  de moto individual.

**Invariante heredada (ADR-016/020):** el motor/estado decide; el LLM (OCR de tickets, sugerencias)
nunca toca el camino del dinero. El cobro y la liquidación son actos humanos registrados.

**Consecuencia:** el trabajo se concentra en Payments + intake + incidencias, no en reconstruir
logística. Riesgo bajo, reuso alto.

---

## 3. Mapeo SOP → sistema (qué existe / qué falta)

| §SOP | Necesidad | Dónde vive hoy | Gap |
|---|---|---|---|
| §5 Recepción | Pedido con nombre/tel/dirección/referencias | `commercial.orders` atado a `customer` de cartera | **Dirección ad-hoc + cliente casual** |
| §5.1 Canales | Tel / WhatsApp / redes | Televenta (tel), Fase F (WA diferida) | Intake manual (pantalla nueva) |
| §5.3 Confirmación | Productos/cantidades/total/ETA | `place`/`confirm` + ETA logística | ✅ reuso |
| §6 Surtido/empaque/verificación | Checklist ☐ | `logistics.shipment_checklists` (templates salida/llegada) | Adaptar template "surtido moto" |
| §6.1 Revisar fechas | FEFO | `stock_lots` + `consume()` FEFO | ✅ reuso |
| §7 Asignación repartidor | Chofer + salida | `delivery_guides.driver_id` + `vehicle_usage_logs` check-in | ✅ reuso (falta UI moto) |
| §7.2 Registro salida | Hora salida, repartidor, folio | `shipments.departure_at` + `vehicle_usage_logs.check_in_at` | ✅ reuso |
| §8 Entrega | Confirmar cliente + pedido | `guide_recipients.deliver` | ✅ reuso |
| §8.2 Cobro | Efectivo/transferencia/anticipado | — (`commercial.payments` vacía) | **PaymentsService** |
| §9 Evidencia | Foto/firma/WhatsApp | `guide_recipients.proof_photo_url` + `shipment_photos` | Firma digital (opcional) |
| §10 Incidencias | No-loc/dir-incorrecta/rechazo/faltante | `guide_recipients.status` (4 estados planos) | **Outcomes tipificados + protocolo** |
| §11 Regreso | Efectivo + comprobantes + evidencia + reporte | `vehicle_usage_logs` check-out | **Cierre de efectivo** |
| §12 Liquidación | Total entregado, efectivo, diferencias | `logistics.liquidations` (comisiones, NO cash) | **Corte de caja del repartidor** |
| §13 KPIs | Tiempo, % éxito, % incidencias, dif. efectivo | `logistics-analytics` + `commercial-analytics` | Métricas última milla |
| §14 Seguridad | Casco/licencia/moto/batería | `drivers` (federal_license, etc.) | Checklist pre-turno moto |
| §15 Documentos | Bitácoras | Tablas de audit existentes | Reportes/vistas |
| Anexo | Modelo financiero, ROI 2-3% | `config_finance` + `logistics-analytics/roi` | Reglas de costo por entrega moto |

---

## 4. Modelo de datos

### 4.1 Reuso directo (sin migración)
- `commercial.orders` / `order_lines` — pedido + líneas + totales + promos.
- `commercial.stock` / `stock_movements` / `stock_lots` — reserva/consumo FEFO.
- `commercial.order_sequences` — folios `PD-YYYY-NNNNN`.
- `logistics.vehicles` — la moto (registrar 1 fila, `capacity_boxes`/`capacity_kg` chicos).
- `logistics.drivers` — el repartidor (`federal_license`, `phone`, `user_id` → login + GPS).
- `logistics.delivery_guides` + `guide_recipients` — la entrega + parada.
- `logistics.vehicle_usage_logs` — check-in/out de la moto (odómetro, hora salida/regreso).
- `logistics.shipment_photos` — fotos POD (`category='delivery'`).
- `logistics.shipment_checklists` — verificación de surtido/pre-turno.
- `public.route_location_pings` — GPS vivo del repartidor (ya lo emite la app).
- `logistics.config_finance` — costo/km, viáticos, tarifas.

### 4.2 Extensiones a tablas existentes (migraciones idempotentes)

**M1 — `commercial.orders` acepta domicilio:**
```sql
-- delivery_type: agregar 'home_delivery' al CHECK
ALTER TABLE commercial.orders DROP CONSTRAINT <check_delivery_type>;
ALTER TABLE commercial.orders ADD CONSTRAINT chk_orders_delivery_type
  CHECK (delivery_type IN ('route','long_trip','home_delivery'));

-- Dirección de entrega ad-hoc (independiente del customer.shipping_address)
ALTER TABLE commercial.orders ADD COLUMN IF NOT EXISTS delivery_address JSONB;
-- { recipient_name, phone, street, references, lat, lng }
ALTER TABLE commercial.orders ADD COLUMN IF NOT EXISTS delivery_channel VARCHAR(20);
-- 'phone' | 'whatsapp' | 'social' | 'walk_in'
ALTER TABLE commercial.orders ADD COLUMN IF NOT EXISTS received_at TIMESTAMP; -- §5.2 hora de recepción
ALTER TABLE commercial.orders ADD COLUMN IF NOT EXISTS promised_eta_min SMALLINT; -- §5.3 tiempo estimado
```

**M2 — `commercial.customers` cliente casual:**
```sql
ALTER TABLE commercial.customers ADD COLUMN IF NOT EXISTS is_casual BOOLEAN NOT NULL DEFAULT false;
-- cliente casual = alta rápida sin RFC/cartera, solo nombre + tel; opt-in a cartera después
```
*(alternativa: reusar el flujo de alta rápida ya existente `POST /commercial/vendor-routes/customers`
marcando `is_casual=true`; decide LM.1.)*

**M3 — `commercial.payments` a multi-método (drop cash-only):**
```sql
ALTER TABLE commercial.payments DROP CONSTRAINT <check_payment_method>;
ALTER TABLE commercial.payments ADD CONSTRAINT chk_payments_method
  CHECK (payment_method IN ('cash','transfer','card','prepaid'));
  -- 'card' = SOLO registro/captura (se pagó con tarjeta en terminal externa).
  --  NO hay pasarela ni terminal integrada: se guarda el hecho + referencia/voucher.
ALTER TABLE commercial.payments ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'received';
  -- 'received' | 'verified' | 'reversed'  (transfer requiere verificación de comprobante)
ALTER TABLE commercial.payments ADD COLUMN IF NOT EXISTS change_given DECIMAL(14,2); -- §8.2 cambio
ALTER TABLE commercial.payments ADD COLUMN IF NOT EXISTS cash_received DECIMAL(14,2); -- efectivo recibido
ALTER TABLE commercial.payments ADD COLUMN IF NOT EXISTS proof_url TEXT;    -- comprobante transferencia / foto de voucher tarjeta
ALTER TABLE commercial.payments ADD COLUMN IF NOT EXISTS liquidation_id UUID; -- FK al corte
-- 'reference' (ya existe) guarda folio de transferencia o nº de autorización/voucher de tarjeta.
-- Igual quitar cash-only del CHECK de orders.payment_method (M1 bis)
```

**M4 — Incidencias tipificadas en la parada:**
```sql
-- guide_recipients.status ya tiene 'no_entregado' y 'rechazado'; agregamos el DETALLE:
ALTER TABLE logistics.guide_recipients ADD COLUMN IF NOT EXISTS incident_type VARCHAR(30);
  -- 'not_located' | 'wrong_address' | 'customer_rejected' | 'missing_product' | 'other'
ALTER TABLE logistics.guide_recipients ADD COLUMN IF NOT EXISTS incident_notes TEXT;
ALTER TABLE logistics.guide_recipients ADD COLUMN IF NOT EXISTS attempted_at TIMESTAMP; -- §10 protocolo
ALTER TABLE logistics.guide_recipients ADD COLUMN IF NOT EXISTS delivered_signature_url TEXT; -- §9 firma
```
*(Patrón replicado del CHECK de 6 outcomes de `commercial.call_logs`.)*

### 4.3 Tabla nueva — corte/liquidación de efectivo por repartidor-día

**M5 — `commercial.rider_liquidations`** (§11–12). Distinta de `logistics.liquidations`
(esa es nómina/comisiones; esta es **cuadre de caja**):
```sql
CREATE TABLE commercial.rider_liquidations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  rider_user_id UUID NOT NULL,       -- repartidor
  branch_store_id UUID,              -- sucursal
  business_date DATE NOT NULL,
  folio VARCHAR(40),                 -- LIQ-YYYY-NNNNN (patrón order_sequences)
  deliveries_count INTEGER NOT NULL DEFAULT 0,
  cash_expected DECIMAL(14,2) NOT NULL DEFAULT 0,   -- suma cobros efectivo esperados
  cash_counted DECIMAL(14,2),                       -- efectivo entregado al encargado
  cash_breakdown JSONB,                             -- ARQUEO por denominación (§12): {"1000":n,"500":n,...}
  cash_difference DECIMAL(14,2),                    -- counted - expected (meta: 0)
  transfer_total DECIMAL(14,2) NOT NULL DEFAULT 0,
  card_total DECIMAL(14,2) NOT NULL DEFAULT 0,       -- tarjeta (solo registro, terminal externa)
  incidents_count INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'open',       -- 'open'|'closed'|'reconciled'
  closed_by UUID, closed_at TIMESTAMP,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMP,
  UNIQUE (tenant_id, rider_user_id, business_date) WHERE deleted_at IS NULL,
  FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, rider_user_id) REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
);
-- RLS forzado tenant_isolation + grants app_runtime (patrón estándar del proyecto).
```
`commercial.payments.liquidation_id` (M3) apunta aquí → cada pago se agrupa al corte del día.

---

## 5. Diseño detallado de los gaps

### 5.1 PaymentsService (el destrabador — hacer PRIMERO)

**Ubicación:** `libs/commercial/src/lib/commercial-payments/` (módulo nuevo, patrón idéntico a
`commercial-route-control`).

**Responsabilidad:** registrar cobros contra un `order`, dentro de la misma transacción que el
`fulfill`, y agruparlos al corte del repartidor.

**Métodos:**
```ts
// Registra un pago (parcial o total) sobre una orden.
recordPayment(dto: {
  order_id: string;
  method: 'cash' | 'transfer' | 'card' | 'prepaid';
  amount: number;
  cash_received?: number;   // para calcular change_given (solo cash)
  reference?: string;       // folio transferencia | nº autorización/voucher tarjeta
  proof_url?: string;       // comprobante transferencia | foto voucher tarjeta
}): Promise<Payment>
// - Lock FOR UPDATE sobre la orden (anti doble-cobro, patrón OrderStockService).
// - Inserta commercial.payments.
// - Actualiza orders.paid_amount += amount, balance_due = total - paid_amount.
// - transfer → status='received' (pendiente verificación); prepaid → valida orden liquidada.
// - card → SOLO registro (terminal externa cobró): status='received', se guarda referencia/voucher.
//   NO se llama a ninguna pasarela ni se valida contra el banco.
// - Idempotente por (order_id, reference) para reintento offline del repartidor.

verifyTransfer(paymentId): Promise<Payment>   // encargado confirma comprobante → status='verified'
reversePayment(paymentId, reason): Promise<Payment> // solo encargado, audita
listByOrder(orderId): Promise<Payment[]>
```

**Hook con fulfill:** al entregar (`guide_recipients.deliver` o `orders.fulfill`), si el pedido no
es prepago, se exige `recordPayment` en la misma acción del repartidor. Se agrega método
combinado `deliverAndCollect(recipientId, paymentDto)` que en una trx: consume stock (fulfill) +
registra pago + marca parada entregada + POD. Idempotente.

**Cash-only removal:** M3 quita el CHECK `payment_method IN ('cash')` de `payments` **y** de
`orders`. Esto cierra el "PaymentsService deferred post-beta" que arrastra el proyecto desde Fase B.

**Permisos nuevos:** `COMMERCIAL_PAYMENTS_REGISTRAR` (ya existe en enum, sin uso),
`COMMERCIAL_PAYMENTS_VERIFICAR`, `COMMERCIAL_PAYMENTS_REVERSAR`.

### 5.2 Intake a domicilio (cliente casual + dirección ad-hoc)

**Flujo del cajero (pantalla nueva `/comercial/domicilio` o dentro de televenta):**
1. Buscar cliente por teléfono → si no existe, **alta casual** (nombre + tel, `is_casual=true`).
2. Capturar dirección de entrega → `orders.delivery_address` JSONB (street, references, lat/lng
   por geocoding Mapbox si hay dirección; ya hay `MapboxService`).
3. Armar líneas (reusa catálogo + precios + promos vía `place`).
4. Confirmar: productos, cantidades, total, **ETA prometido** (`promised_eta_min`, del solver ETA
   o default config `minutos_por_parada`). Registrar `received_at` y `delivery_channel`.
5. `place()` → orden `confirmed`, stock reservado.

**Decisión pendiente (LM.1):** ¿reusar el alta rápida `POST /vendor-routes/customers` o endpoint
propio de intake? Recomiendo endpoint propio `POST /commercial/home-delivery/orders` que hace
todo el intake atómico (customer casual + order + address + líneas) para no acoplar a vendor.

### 5.3 Incidencias tipificadas (§10)

Replica el patrón `call_logs` (6 outcomes con CHECK). En la parada (`guide_recipients`):
- `incident_type` ∈ {not_located, wrong_address, customer_rejected, missing_product, other}.
- Cada tipo dispara su **protocolo** en la UI del repartidor:
  - `not_located` → botón "Llamé, esperé 10 min" + timer `attempted_at`, luego "Reportar a sucursal".
  - `wrong_address` → capturar ubicación correcta (re-geocode) + notificar retraso.
  - `customer_rejected` → motivo obligatorio → mercancía regresa (reversa de stock al cerrar guía).
  - `missing_product` → marcar líneas faltantes → programa complemento/reembolso (autoriza encargado).
- Métrica `incidents_count` alimenta KPI §13 (≤2%).

### 5.3-bis Evidencia de entrega — firma del cliente (§9)

Toda parada entregada exige **al menos una** evidencia; la **firma del cliente es obligatoria**
salvo excepción justificada (contra-entrega en ausencia):

- **Firma** — canvas táctil en la app del repartidor → PNG → sube a Cloudinary →
  `guide_recipients.delivered_signature_url` (columna ya prevista en M4). Se captura junto con
  `delivered_to` (nombre de quien recibe).
- **Foto POD** — `guide_recipients.proof_photo_url` + `shipment_photos(category='delivery')`.
- **Confirmación WhatsApp** — fallback si no hay firma/foto (registra referencia en notas).
- `deliverAndCollect` valida en backend que exista firma **o** foto **o** confirmación antes de
  cerrar la parada como `entregado` (regla dura, no solo UI). Excepción explícita se marca con
  `incident_notes` + autorización.

### 5.4 Moto + overflow a CEDIS (§3 nota)

- La moto se registra como `logistics.vehicles` con `capacity_boxes`/`capacity_kg` reales.
- Al armar la guía, si `SUM(boxes) > capacity_boxes` OR `SUM(kg) > capacity_kg` → **regla de
  escalamiento**: la guía se marca `requires_cedis = true` (columna nueva o flag en notes) y se
  rutea por el flujo de embarque de camión (J.12) en vez de moto. Es un `IF` en el builder de guía.
- MVP: validación simple + aviso al encargado; no auto-split de pedido.

### 5.5 Liquidación diaria del repartidor (§11–12)

- Al abrir turno: `rider_liquidations` (status `open`) para (rider, hoy).
- Cada `deliverAndCollect` con efectivo suma a `cash_expected` y linkea el `payment.liquidation_id`.
- Al regresar: repartidor entrega efectivo → encargado hace **arqueo por denominación**
  (billetes y monedas) → sistema captura `cash_breakdown` JSONB, deriva `cash_counted` de la suma
  y calcula `cash_difference`. Diferencia ≠ 0 se documenta (§12) obligatoriamente.
- **Arqueo (`cash_breakdown`):** conteo por denominación MXN, ej.
  `{"1000":2,"500":5,"200":10,"100":8,"50":4,"20":6,"10":3,"5":2,"2":1,"1":4,"0.5":2}`.
  Invariante: `SUM(denominación × conteo) = cash_counted`. La UI valida el cuadre en vivo y
  bloquea el cierre si no coincide con lo capturado. Sirve de comprobante auditable del corte.
- Reusa el patrón visual de `route-tickets` / `close-route` del vendor (ya existe la pantalla base).
- Reporte de cierre = corte del día por sucursal (total entregado, efectivo, arqueo, diferencias, incidencias).

### 5.6 KPIs y modelo financiero (§13 + Anexo)

Vista/endpoint `GET /commercial/home-delivery/kpis`:
- **Tiempo promedio de entrega**: `AVG(delivered_at - departure_at)` (meta ≤1h). Ya hay timestamps.
- **% entregas exitosas**: `entregado / total paradas` (meta ≥98%).
- **% incidencias**: `incidents_count / total` (meta ≤2%).
- **Diferencias de efectivo**: `SUM(ABS(cash_difference))` (meta 0).
- **Satisfacción**: requiere captura (encuesta post-entrega) — **diferido**, no hay fuente.

**Modelo financiero (Anexo):** reusa `logistics-analytics/roi` + `config_finance`:
- Costo por entrega = (sueldo base repartidor + $3/pedido incentivo + combustible + mantenimiento
  + depreciación + seguros) prorrateado. Parámetros en `config_finance` (nuevas keys:
  `moto_incentivo_por_pedido=3`, `moto_depreciacion_anual`, `moto_seguro_anual`, etc.).
- **Indicador clave:** costo total / facturación entregada, meta **2-3%** (5% tolerado primeros 6 meses).
- Revisión mensual: endpoint de reporte con entregas, costo/entrega, combustible, productividad.

---

## 6. Roles y permisos

**Rol nuevo `repartidor`** (patrón `tele_operator` de Fase E):
- Login a app (variante de la vendor app o pantalla `/repartidor`).
- Permisos: `LOGISTICS_SHIPMENTS_VER` (sus guías vía `my-driver`), `LOGISTICS_GUIDES_GESTIONAR`
  (marcar entrega/incidencia), `COMMERCIAL_PAYMENTS_REGISTRAR` (cobrar), `ROUTE_TICKET_CAPTURE`
  (opcional, tickets), **sin** acceso a trade/admin/cartera completa.
- Vinculado vía `logistics.drivers.user_id`.

**Rol `encargado_sucursal`:** `COMMERCIAL_PAYMENTS_VERIFICAR/REVERSAR`, cerrar
`rider_liquidations`, autorizar cancelaciones/devoluciones/complementos.

Backfill de permisos con migración (KEY IS NULL) + **re-login obligatorio** (permiso vive en JWT) —
lección ya documentada del proyecto.

---

## 7. Frontend

**Reusar la app de vendedor** (`apps/vendor`) — ya es mobile-first, offline (Dexie), GPS, foto,
Capacitor Android. Agregar rol/rutas de repartidor:
- **Mis entregas de hoy** (`my-driver` shipments/guides) — cola priorizada por ETA.
- **Detalle de parada** — cliente, dirección, mapa, botón navegar, líneas del pedido.
- **Entregar** — confirmar cliente → cobrar (efectivo con calculadora de cambio / transferencia con
  foto comprobante / **tarjeta = solo capturar voucher/autorización, sin terminal integrada** /
  prepago) → foto POD / firma → `deliverAndCollect`. **Offline-first** (reusa
  `OfflineOrderService`/`OfflineSyncService`: encola cobro+POD, replay idempotente al reconectar).
- **Incidencia** — sheet con los 5 tipos + protocolo.
- **Cierre de turno** — resumen del día + entregar efectivo (adapta `vendor-close-route`).

**Pantalla de intake** (`apps/view` → `/comercial/domicilio`, rol cajero): captura del pedido a
domicilio. Patrón Operations (p-table/p-dialog). Reusa componentes de order/customer ya rotos en
`modules/comercial/components/` (CV sprint).

**Panel encargado** (`apps/view`): cola de entregas en vivo (mapa reusa `commercial-map`/live-map),
verificación de transferencias, cierre de liquidaciones, KPIs.

---

## 8. Sprints

| Sprint | Contenido | Entregable | Depende |
|---|---|---|---|
| **LM.0** 🧪 | Migraciones M1–M5 + roles `repartidor`/`encargado_sucursal` + permisos + seed | ✅ EN CÓDIGO (build api verde 2026-07-02). 6 migraciones `20260702180000`–`185000`, 3 permisos nuevos (enum BE+FE+ability+seed), 2 roles. **Falta: aplicar migrate:new + smoke.** Seed moto/repartidor demo → LM.3. | — |
| **LM.1** 🧪 | **PaymentsService** (recordPayment/verify/reverse/deliverAndCollect/listByOrder) | ✅ EN CÓDIGO (build api verde 2026-07-02). Módulo `libs/commercial/commercial-payments/`: cobro con lock FOR UPDATE + update atómico de paid_amount/balance_due, idempotencia por (order_id, reference), cambio calculado en cash, `deliverAndCollect` = fulfillInTransaction + pago en 1 trx. Endpoints REST + permisos. **Falta: smoke HTTP** (requiere migrate:new de LM.0). | LM.0 |
| **LM.2** 🧪 | Intake a domicilio (cliente casual + dirección + `place`) | ✅ EN CÓDIGO (build api verde 2026-07-02). Módulo `commercial-home-delivery/`: `POST /commercial/home-delivery/orders` orquesta resolver cliente (cartera o casual dedupeado por teléfono) + warehouse default + `createDraft(home_delivery)` + `replaceLines` + `place`. OrdersService extendido (`delivery_address`/`channel`/`promised_eta_min`/`received_at`), CustomersService (`is_casual`). Geocoding diferido a LM.3 (coords opcionales del UI). | LM.0 |
| **LM.3** 🧪 | Asignación repartidor + guía moto + overflow CEDIS | ✅ EN CÓDIGO (build api verde 2026-07-02). Módulo `logistics-home-dispatch/`: `POST /logistics/home-dispatch/orders/:orderId` crea embarque+guía(rider)+destinatario desde `orders.delivery_address` (coords si vienen), calcula unidades vs `vehicle.capacity_boxes` → `requires_cedis` + nota de aviso (MVP no auto-splitea), anti doble-despacho. **Check-in/salida + retorno reusan endpoints existentes** (`/fleet/usage/check-in`, `/shipments/:id/depart`). | LM.1, LM.2 |
| **LM.4** 🧪 | Incidencias tipificadas + firma + reversa de stock en rechazo | ✅ EN CÓDIGO (build api verde 2026-07-02). `recordDeliveryOutcome(recipientId, dto)` en home-delivery: `POST /commercial/home-delivery/recipients/:id/outcome`. `delivered` → evidencia dura (firma\|foto\|WhatsApp) + `deliverAndCollect` (fulfill+cobro) + POD/firma en la parada. Incidencias (`not_located`/`wrong_address`/`customer_rejected`/`missing_product`/`other`) marcan la parada; **rechazo → cancela el pedido = libera reserva de stock**. | LM.3 |
| **LM.5** 🧪 | Liquidación diaria + arqueo + cierre por sucursal | ✅ EN CÓDIGO (build api verde 2026-07-02). Módulo `commercial-rider-liquidation/`: `open`/`preview`/`close`/`list`. El corte se **computa desde `commercial.payments`** (received_by=repartidor+día → cash/card/transfer + deliveries + incidencias). `close` captura **arqueo por denominación** (`cash_breakdown` MXN), deriva `cash_counted`, calcula `cash_difference`, estampa los pagos con `liquidation_id`. Folio `LIQ-YYYY-NNNNN`. | LM.1, LM.3 |
| **LM.6.1** 🧪 | Frontend repartidor — entregas + cobrar + incidencia (**online-first**) | ✅ EN CÓDIGO (builds api+vendor verdes 2026-07-02). Backend `GET /logistics/home-dispatch/my-deliveries` (paradas del repartidor por `drivers.user_id`). App: `vendor-deliveries.component` (lista de paradas + dialog Entregar [método/monto/cambio/ref + evidencia obligatoria] / Incidencia [5 tipos + motivo]) → `recordDeliveryOutcome`. Ruta `/vendor/deliveries` + nav "Entregas". **Shell consciente del rol**: `isRider` (capacidad: reparte guías y NO toma pedidos, o `role_name='repartidor'`) oculta lo del vendedor (Mi ruta/Carga/Cierre/Thot/buscar cliente/Mi día), marca "Repartidor", y redirige su home a Entregas. Firma canvas real + **offline Dexie → LM.6.2**. | LM.1–LM.5 |
| **LM.7** | Frontend intake (cajero) + panel encargado (cola vivo, verificación, KPIs) | Back-office | LM.1–LM.5 |
| **LM.8** | KPIs última milla + modelo financiero (ROI 2-3%) + reportes/bitácoras | §13 + Anexo | LM.5 |
| **LM.9** | Regression suite + docs de cierre (`03_LOG_REVISIONES.md`) | Fase cerrada beta | todos |

**Ruta crítica de valor:** LM.0 → LM.1 (PaymentsService) es lo que más destraba — además cierra la
deuda "payments deferred" de toda la plataforma. Se puede shippear LM.1 solo y ya habilita cobro
en pedidos normales del comercial, no solo domicilio.

---

## 9. Riesgos y decisiones abiertas

1. **Quitar cash-only** — ✅ **RESUELTO 2026-07-02: cambio GLOBAL.** Se acepta habilitar
   `cash/transfer/card/prepaid` en toda la plataforma (cierra la deuda "payments deferred" de
   Fase B). Migración drop+recreate del CHECK en `orders` y `payments`, idempotente.
   Sucursal ✅ **RESUELTO: `store_id` dentro del tenant Mega Dulces** (arquitectura actual);
   el corte de caja se agrupa por `branch_store_id`.
2. **Cliente casual vs cartera** — ¿los casuales ensucian analytics/Thot? Recomiendo `is_casual`
   flag + excluirlos de MVs de cartera. Decidir en LM.2.
3. **Firma digital** (§9) — obligatoria por SOP. Canvas táctil en la app + arqueo por denominación
   suman scope al frontend del repartidor (LM.6); ambos son cuadre/evidencia con validación dura en
   backend, no solo UI.
4. **Satisfacción del cliente** (§13 meta ≥95%) — no hay fuente de datos; diferido hasta encuesta
   post-entrega (podría ser WhatsApp, Fase F).
5. **Multi-sucursal** — el SOP aplica "todas las sucursales". El schema ya es multi-tenant pero
   sucursal = `store_id`; confirmar si cada sucursal es tenant o store dentro del tenant Mega Dulces
   (hoy: store dentro del tenant). El corte de caja es por `branch_store_id`.
6. **Offline del cobro** — cobrar efectivo offline y sincronizar tiene riesgo de descuadre si el
   pedido cambió. Idempotencia por `(order_id, reference)` + reconciliación en el cierre.

---

## 10. Qué NO reconstruir (reuso confirmado en código)

- State machine de órdenes, stock atómico FEFO, folios → `commercial-orders`.
- Guía multi-parada, POD, GPS vivo, ETA, checklists, fotos, costos, ROI → `logistics.*`.
- OCR de tickets (Claude Haiku vision) → `LlmExtractorService` / `route-tickets`.
- Patrón outcomes con CHECK → `commercial.call_logs` (televenta).
- Patrón liquidación/cierre visual → `vendor-close-route` / `route-tickets`.
- App mobile offline (Dexie, GPS, foto, Capacitor) → `apps/vendor`.
- Mapas/geocoding/optimize → `MapboxService` + solver NN+2-opt logística.

---

*Referencias de código clave:*
- `libs/commercial/src/lib/commercial-orders/commercial-orders.service.ts` (state machine, `place`, `fulfill`, `deliverNow`, `nextCode`)
- `libs/commercial/src/lib/commercial-orders/order-stock.service.ts` (`reserve`/`consume`/`release`, FOR UPDATE)
- `database/migrations-newdb/20260526100004_commercial_orders_payments.js` (tabla `payments` vacía, cash-only CHECK)
- `libs/logistics/src/lib/logistics-shipments/logistics-shipments.service.ts` (`my-driver`, `live`, ETA)
- `libs/logistics/src/lib/logistics-guides/logistics-guides.service.ts` (`guide_recipients`, POD)
- `libs/commercial/src/lib/commercial-televenta/` (patrón `call_logs` 6 outcomes, `lead_reservations`)
- `libs/commercial/src/lib/commercial-route-control/` (patrón OCR + liquidación visual)
- `libs/platform-core/src/lib/constants/permissions.ts` (enum permisos)
