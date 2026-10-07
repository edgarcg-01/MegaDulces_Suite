# Fase VR — Venta en Ruta (autoventa offline-first)

> **Estado:** 🔨 DISEÑADO (planeación) 2026-07-13. Sin código aún.
> **ADR propuesto:** ADR-032 — *El dispositivo es la fuente de verdad de la venta en ruta: el servidor acepta y concilia, nunca rechaza* (pendiente de aceptación de Edgar).
> **Objetivo:** que el vendedor de ruta pueda **vender en el momento** (autoventa: entrega + cobro inmediato) desde lap o móvil, **100% sin internet**, con manejo transaccional riguroso y conciliación al cierre del día.
> **Contexto estratégico:** este módulo es el camino para retirar los Keplers locales de las ~35 camionetas route-push (hoy solo 2 dadas de alta y ambas caídas). La camioneta pasa de "Kepler local + push cada 15 min" a "apps/vendor offline + sync".

---

## 1. Diagnóstico (auditoría 2026-07-13)

### 1.1 Lo que YA existe y se reusa

| Pieza | Estado | Referencia |
|---|---|---|
| App vendedor PWA/Capacitor (móvil **y** lap — es web responsive) | ✅ | `apps/vendor` |
| Cola offline Dexie v8 + motor de sync (visitas, clientes, tickets, pedidos preventa) | ✅ | `offline-sync.service.ts`, `offline-database.service.ts` |
| `PedidoPendiente` con replay create→lines→place y `serverOrderId` persistido | ✅ (solo preventa) | `offline-order.service.ts` |
| Orders con trx por operación (`tk.run`), locks por fila de stock (`FOR UPDATE`), state machine draft→confirmed→fulfilled | ✅ | `commercial-orders.service.ts`, `order-stock.service.ts` |
| `deliverNow` (confirm+fulfill en 1 trx) y `deliverAndCollect` (fulfill+pago en 1 trx) | ✅ | `commercial-orders.service.ts:883`, `commercial-payments.service.ts:160` |
| Payments multi-método (cash/transfer/card/prepaid) con `cash_received`/`change_given`, lock de orden, dedupe por `(order_id, reference)` | ✅ (Fase LM) | `20260702181000_lm_payments_multi_method.js` |
| Warehouse `kind='truck'` por vendedor + stock-in de carga vía ticket OCR | ✅ | `20260603200000_warehouses_truck_kind.js`, `commercial-route-control.service.ts:383-434` |
| Corte de caja con **arqueo ciego por denominación** + reconciliación del encargado | ✅ (LM.5/LM.11) | `commercial-rider-liquidation.service.ts` |
| Motor de cuadre 3 planos (inventario/caja/cruce) + bandeja HITL | ✅ (Fase SM) | `libs/reconciliation` |
| Patrón de idempotencia por `client_uuid` + `ON CONFLICT DO NOTHING` | ✅ (pings GPS, scan log) | `reports.service.ts:2328-2362`, `inventory-count.service.ts:511-524` |

### 1.2 Brechas críticas (por qué HOY no se puede vender en el momento offline)

**Frontend (`apps/vendor`):**
1. El modo `instante` (autoventa) está **hardcodeado a `futuro`** — UI muerta que lo anticipa (`vendor-take-order.component.ts:738`; `deliverNow()` existe en `vendor.service.ts:612` pero nadie lo llama).
2. **Cero cobro**: ni método de pago, ni efectivo recibido, ni cambio, ni offline ni online en take-order.
3. **Sin idempotency key al servidor**: el `id` local del pedido NO viaja en el `POST /orders` (`offline-sync.service.ts:1144-1152`). Un timeout tras escritura del server = **pedido duplicado** al reintento. (Las visitas SÍ mandan `sync_uuid`; los pedidos no.)
4. **`place` no es idempotente desde el cliente**: respuesta perdida → reintento choca 4xx de transición → pedido "muerto" aunque ya está colocado (`offline-sync.service.ts:1170-1185`).
5. El replay de pedidos **no distingue error transitorio vs permanente ni maneja 401** (a diferencia de visitas): un deploy o sesión vencida quema los 5 intentos y mata la venta en silencio.
6. **Cliente creado offline no se remapea en el pedido**: el replay manda el UUID local inexistente → 4xx → muerto (`sincronizarClientesPendientes` asigna serverId pero nadie actualiza `PedidoPendiente.customerId`).
7. **Sin folio offline**: el vendedor/cliente no ven folio hasta sincronizar; `serverCode` llega a Dexie pero nunca se surfacea.
8. **Precio/stock cacheados sin TTL** (`cachedAt` se escribe y jamás se lee) y **el server recalcula el precio al sync** (el cliente solo manda `{product_id, quantity}`) → lo cobrado en la calle puede diferir de lo facturado → descuadre de arqueo garantizado.
9. JWT restaurado de localStorage **sin verificar `exp`**; sin refresh → días sin red = replay con token vencido → 401 → muerto.
10. Badge de pendientes cuenta también los muertos; no hay estado `syncing`; fecha de entrega default puede quedar en el pasado tras días offline.

**Backend (`libs/commercial`):**
11. **No existe endpoint atómico** "crear pedido con líneas + entregar + cobrar" — hoy son 3-4 requests no transaccionales entre sí.
12. **Ningún endpoint de orders acepta idempotency key**; doble POST = doble draft + doble folio.
13. La autoventa **descuenta del CEDIS, no del camión** (docstring de `deliverNow` lo reconoce). `carga_load_items` es checklist auditable, NO stock. No hay traspaso CEDIS↔camión.
14. **Validaciones síncronas rechazan replays legítimos** de mercancía ya entregada físicamente: stock insuficiente (409), producto despublicado (409 o peor, `replaceLines` lo OMITE en silencio), cliente/almacén desactivado, MOQ, inventario congelado (`assertNotFrozen` bloquea TODO el warehouse durante un conteo).
15. Sin `FOR UPDATE` sobre la fila de `orders` en confirm/place/fulfill/deliverNow (solo en addLine/replaceLines/payments) → dos transiciones concurrentes pueden doble-reservar.
16. Folio `PD-` se genera al **draft** (server-side) — no reservable por device.
17. Dedupe de payments es a nivel app (SELECT-then-INSERT); `recordKeplerPayment` sin lock → race real. Falta unique constraint en DB.
18. **No hay ciclo cerrado carga→venta→retorno** con cuadre de unidades del camión, ni comprobante impreso/digital para el cliente en el momento.

---

## 2. Decisión de diseño central (ADR-032 propuesto)

**En autoventa, el evento ya ocurrió**: la mercancía se entregó y el efectivo se cobró en la calle. Por lo tanto:

> **El dispositivo es la fuente de verdad del hecho de venta. El servidor ACEPTA el replay siempre (idempotente), registra exactamente lo que el device reporta (precio cobrado incluido), y las divergencias se marcan como discrepancias para conciliación humana — nunca se rechaza ni se recalcula.**

Esto invierte la semántica actual (server valida y rechaza) **solo para el canal `route_sale`**. La preventa (place) conserva su semántica actual. Es el mismo principio de los POS offline reales y del propio Kepler de camioneta. Consistente con ADR-016 (el motor decide, el humano concilia) y con la lección SM (73% de arqueos "exactos" = arqueo no ciego → la verdad se construye con cuadre, no con rechazos).

**Invariantes transaccionales del canal route_sale:**
- **I1 — Exactly-once:** `UNIQUE (tenant_id, client_uuid)` en orders + endpoint `ON CONFLICT` devuelve la orden existente. N reintentos = 1 venta.
- **I2 — Un request, una trx:** la venta completa (orden fulfilled + líneas + consumo de stock del camión + pago) entra en **un solo POST** que corre en **una sola transacción** `tk.run`. Nunca estados a medias en server.
- **I3 — El dinero manda:** `total grabado = Σ(qty × unit_price cobrado en device) = efectivo recibido − cambio`. El server NUNCA recalcula precio en este canal; si el precio device ≠ precio vigente, guarda ambos y marca `price_variance`.
- **I4 — Todo movimiento del camión queda en `stock_movements`;** stock del camión puede quedar negativo (venta legítima de carga no registrada) pero SIEMPRE flaggeado como discrepancia.
- **I5 — Identidad de cuadre diario:** `carga + retorno_previo − ventas(SKU) = retorno esperado` vs conteo físico; `efectivo esperado (payments) vs arqueo ciego` — ambos planos cierran en la liquidación.

---

## 3. Arquitectura de la solución

### 3.1 Flujo objetivo del día

```
MAÑANA (con red, en CEDIS/sucursal)
 1. Login → refresh proactivo de JWT (exp 7d rol vendedor)
 2. Descarga de "paquete de ruta": cartera del día + catálogo/precios +
    stock del camión + secuencia de folios local → Dexie (con TTL visible)
 3. Carga del camión: traspaso formal CEDIS→TRUCK-<user> (nuevo endpoint
    transfer, atómico) — el ticket OCR de carga se reconcilia contra esto

EN RUTA (sin red)
 4. Check-in cliente (cola existente)
 5. VENTA EN EL MOMENTO: picker de productos validado DURO contra el
    ledger local del camión → cobro (efectivo recibido/cambio, o
    transfer/card con referencia) → folio local VR-<device>-<seq> →
    comprobante en pantalla (+ WhatsApp diferido, + impresora BT fase 2)
 6. El ledger local del camión se decrementa al confirmar cada venta
 7. Todo queda en Dexie como `ventaRuta` (payload 100% autónomo)

AL RECUPERAR RED (automático)
 8. Replay: 1 request por venta → POST /commercial/orders/route-sale
    (idempotente por client_uuid; acepta siempre; flaggea divergencias)
 9. Folio server PD- se enlaza al folio local; se notifica al vendedor

TARDE (cierre, con red)
10. Retorno: conteo físico del camión → traspaso TRUCK→CEDIS del retorno
11. Liquidación: arqueo CIEGO por denominación (reusar rider_liquidations
    generalizado) + cuadre de unidades (I5) → bandeja de discrepancias
    para el encargado (reusar libs/reconciliation)
```

### 3.2 Nuevo endpoint atómico: `POST /commercial/orders/route-sale`

Payload (todo lo necesario, autocontenido):

```jsonc
{
  "client_uuid": "…",              // idempotency key (UUID device) — I1
  "local_folio": "VR-A3F2-00041",  // folio device, único por (tenant, local_folio)
  "customer_id": "… | null",
  "customer_client_uuid": "… | null", // si el cliente se creó offline (server resuelve)
  "warehouse_id": "TRUCK-<user>",  // camión del vendedor
  "sold_at": "2026-07-13T11:42:03-06:00", // hora device
  "device_clock_skew_ms": 1234,    // medido contra server time en el último contacto
  "lines": [
    { "product_id": "…", "quantity": 6,
      "unit_price": 12.50,         // PRECIO COBRADO (snapshot device) — I3
      "tax_rate": 0.16 }
  ],
  "payment": {
    "method": "cash|transfer|card",
    "amount": 87.00,
    "cash_received": 100.00, "change_given": 13.00,
    "reference": null            // dedupe secundario de payments
  },
  "gps": { "lat": 0, "lng": 0 }   // opcional
}
```

Semántica server (una sola trx `tk.run`, orden lockeada `FOR UPDATE` desde el insert):
1. `INSERT orders … ON CONFLICT (tenant_id, client_uuid) DO NOTHING`; si conflicto → `SELECT` y **devolver la orden existente con 200** (replay-safe).
2. Resolver `customer_client_uuid` → customer real; si no existe aún, **aceptar** con `customer_pending=true` (discrepancia, no rechazo).
3. Insertar líneas con `unit_price` del device. Si producto despublicado/sin precio vigente/MOQ violado → **aceptar** + flag (`line_flags`), jamás omitir en silencio (fix del bug de `replaceLines`).
4. `stock.consume` contra el warehouse camión con `allow_negative=true` (solo camiones): si `quantity < qty`, consumir igual y crear discrepancia `venta_sin_carga` — I4. `assertNotFrozen` NO aplica a warehouses `kind='truck'` salvo conteo del propio camión.
5. Orden nace directamente `fulfilled` (`source='route_sale'`, `fulfilled_at=sold_at` corregido por skew, `synced_at=now()`).
6. `insertPayment` en la misma trx (patrón `deliverAndCollect`), con `received_by = vendedor`.
7. Comparar `unit_price` device vs precio vigente → si difiere, `price_variance_total` + discrepancia informativa.
8. Devolver `{ id, code (PD-…), local_folio, flags[] }`.

**Nada en este endpoint puede devolver 409 de negocio.** Solo 400 por payload malformado (bug del cliente, no reintentar) y 5xx transitorios (reintentar).

### 3.3 Migración de schema (VR.0)

Sobre `database/migrations-newdb/` (idempotentes, como siempre):

- `commercial.orders`:
  - `client_uuid uuid NULL` + `UNIQUE (tenant_id, client_uuid)` parcial (WHERE client_uuid IS NOT NULL)
  - `local_folio varchar(30) NULL` + `UNIQUE (tenant_id, local_folio)` parcial
  - `source varchar(20)` (`'route_sale'|'preventa'|'portal'|…`), `sold_at timestamptz NULL`
  - `price_variance_total numeric NULL`, `flags jsonb NULL`
- `commercial.order_lines`: `line_flags jsonb NULL` (producto_inactivo, moq, sin_precio_vigente, price_variance)
- `commercial.stock`: `allow_negative boolean NOT NULL DEFAULT false` (denormalizado; true para filas de warehouses truck) + reemplazar CHECK `quantity >= 0` por `quantity >= 0 OR allow_negative` (⚠️ tocar CHECK, no borrar columna — pedir OK de Edgar antes de aplicar a prod)
- `commercial.stock_movements`: agregar `'transfer'` al CHECK de `movement_type`
- `commercial.payments`: **UNIQUE parcial en DB** `(tenant_id, order_id, reference)` y `(tenant_id, kepler_folio, reference)` (cierra el race de `recordKeplerPayment`)
- Nueva `commercial.route_sale_discrepancies` (o reusar `reconciliation.discrepancies` con `dedup_key` — **preferido: reusar SM**, cero tabla nueva)

### 3.4 Stock del camión: ciclo cerrado (VR.4)

- **Traspaso formal** `POST /commercial/inventory/transfer` — una trx: `out` en origen + `in` en destino, ambos movements con el mismo `transfer_group_id`, locks en las dos filas de stock (orden determinista por UUID para evitar deadlock).
- **Carga (mañana):** UI de carga confirma contra pedido de carga o libre → transfer CEDIS→TRUCK. El ticket OCR de carga existente pasa a ser **verificación** contra el transfer (no la fuente del stock-in).
- **Retorno (tarde):** conteo físico del camión en la app (reusar patrón conteo ciego de Fase I/ABC) → transfer TRUCK→CEDIS por lo contado → el residual vs `carga − ventas` es la merma de ruta (regla P1 de SM aplicada al camión).
- **Ledger local (device):** Dexie guarda `truckStock` (snapshot al cargar + decrementos por venta local). Es la validación DURA de la UI de venta; el server es quien registra la verdad contable.

### 3.5 Cola offline v2 (`ventaRuta` en Dexie) (VR.2)

Nueva store `ventasRuta` (no reusar `pedidosPendientes` — semántica distinta):
- Payload completo del endpoint (§3.2), `status: 'ready'|'syncing'|'synced'|'dead'`, `attempts`, `lastError`, `serverCode`.
- **Folio local:** contador por device persistido en Dexie (`VR-<deviceId4>-<seq5>`); `deviceId` = UUID v4 generado una vez y persistido. Sin rangos server: el folio local es definitivo para el comprobante del cliente; el PD- server es el contable.
- **Replay:** 1 request, idempotente. Clasificación de errores: `{0,408,429,5xx}` transitorio (no quema intento), `401` → `sessionExpired$` + pausa de cola (NO quema), `400` → dead con `lastError` visible. Backoff exponencial + jitter.
- **Orden de replay:** clientes offline primero (ya existe), luego ventas por `sold_at`; el remapeo cliente→serverId ahora también actualiza `ventasRuta.customer_id` (fix gap 6) — y de todos modos el server acepta `customer_client_uuid` como red de seguridad.
- **Surfacear folio:** al sync exitoso, toast/updates en "Mi día" con `local_folio → PD-…`; badge separa `ready` de `dead`.
- Retro-fix de los mismos gaps en la cola de **preventa** existente (client_uuid en POST /orders, place idempotente, transient/401): el backend agrega `client_uuid` opcional a `POST /commercial/orders` genérico.

### 3.6 UI de venta en el momento (VR.3)

- `take-order` recupera el modo `instante` real (el toggle ya está diseñado en el docstring): flujo = líneas (validación dura vs `truckStock` local) → **pantalla de cobro** (total grande, teclado de efectivo recibido, cambio calculado, métodos transfer/card con referencia) → confirmar → **comprobante** (folio local, líneas, total, pagado/cambio, QR opcional con el client_uuid) → botón WhatsApp (se difiere si no hay red, ya existe patrón).
- Reusar el order-pad y pedido por voz (Sprint VQ) tal cual — solo cambia el submit.
- **Lap:** `apps/vendor` es PWA responsive; VR.3 incluye pase de QA de layout ≥1024px (tabla de líneas en vez de cards, atajos de teclado para el picker). No se construye app aparte.
- Design: leer `DESIGN.md` + `tokens.css` antes (Operations mode; verificación dark mode obligatoria).

### 3.7 Sesión y tiempo (VR.6)

- **JWT:** verificar `exp` al restaurar sesión; refresh proactivo (sliding) en cada ventana de conectividad; exp del rol vendedor a 7 días (decisión de seguridad — confirmar con Edgar). La cola NUNCA mata ventas por 401: pausa y pide re-login preservando todo.
- **Reloj:** en cada contacto con red, guardar `server_time − device_time` (skew). `sold_at` viaja crudo + skew; el server corrige. Fecha default de preventa se calcula al confirmar, no al abrir pantalla (fix gap fecha en pasado).

### 3.8 Cierre del día (VR.5)

- **Generalizar `rider_liquidations` → liquidación de vendedor de ruta** (mismas columnas; `rider_user_id` ya es genérico user): corte por (vendedor, día) computado desde `commercial.payments WHERE received_by=vendedor` — funciona sin cambios porque route-sale inserta payments.
- **Arqueo ciego obligatorio** (lección SM: 73% de arqueos no-ciegos cuadran "exacto").
- **Cuadre de unidades:** job/regla nueva en `libs/reconciliation`: por camión+día, `Σ transfers in + retorno_previo − Σ ventas = retorno esperado` vs conteo físico → discrepancia `merma_ruta` con foco por $ (reusar `focos`).
- Los flags acumulados del día (`venta_sin_carga`, `price_variance`, `customer_pending`, `line_flags`) aparecen en la misma bandeja del encargado.

---

## 4. Plan de sprints

| Sprint | Alcance | Entregable verificable |
|---|---|---|
| **VR.0** | Migración schema (§3.3) + seeds permisos (`ROUTE_SALE_USE`) | Migs aplican en local newdb; regression verde |
| **VR.1** | Backend: `POST /orders/route-sale` atómico idempotente + `FOR UPDATE` en transiciones de orders + `POST /inventory/transfer` + unique payments | Smoke HTTP: replay ×5 del mismo client_uuid = 1 orden; venta con stock 0 = orden ok + discrepancia; transfer atómico |
| **VR.2** | Cola offline v2 `ventasRuta` + folio local + clasificación de errores + retro-fix cola preventa | Smoke device: matar app entre pasos, doble sync, 401, 3 días offline — cero duplicados/muertos falsos |
| **VR.3** | UI modo instante + cobro + comprobante + ledger local camión + QA lap | Venta E2E offline en Chrome DevTools mobile + desktop |
| **VR.4** | Ciclo camión: carga como transfer + retorno con conteo + integración ticket OCR | Cuadre `carga − ventas = retorno` reproducible en smoke |
| **VR.5** | Liquidación vendedor (arqueo ciego) + regla cuadre unidades en reconciliation + bandeja flags | Corte E2E con diferencia sembrada detectada |
| **VR.6** | JWT sliding + exp check + clock skew | Replay con token renovado tras 5 días simulados |
| **VR.7** | Hardening: suite de caos del replay (timeout tras escritura, N devices mismo SKU, inventario congelado en CEDIS) + entrada en `run-all-tests.js` | Regression completa verde |
| **VR.8** *(diferido)* | Impresora térmica BT (ESC/POS 58mm, plugin Capacitor), PDF ticket, piloto en 1-2 camionetas en paralelo con Kepler | Piloto en campo |

**Ruta crítica:** VR.0 → VR.1 → VR.2 → VR.3 (con eso ya se vende offline). VR.4/VR.5 cierran el control; sin ellos NO salir a piloto (dinero sin cuadre = riesgo).

---

## 5. Riesgos y decisiones abiertas para Edgar

1. **ADR-032 (aceptar+conciliar vs validar+rechazar)** — es LA decisión. Sin ella no hay autoventa offline honesta.
2. **CHECK de `commercial.stock`** se modifica (no se borra columna) para permitir negativos en camiones — requiere tu OK explícito por regla de proyecto.
3. **Exp del JWT vendedor a 7 días** — trade-off seguridad vs operación sin red.
4. **Folio ante el cliente = folio local `VR-…`** (el PD- es interno/contable). ¿Aceptable fiscalmente/operativamente? (Kepler hoy da folio local de la camioneta, así que es equivalente.)
5. **Piloto**: qué 1-2 camionetas, y si corre en paralelo con Kepler local (recomendado: sí, 2-4 semanas, comparando `mart.ventas ruta_NN` vs `orders source='route_sale'`).
6. Impresora térmica: ¿requisito de arranque o fase 2? (plan asume fase 2; el comprobante v1 es pantalla + WhatsApp diferido).
