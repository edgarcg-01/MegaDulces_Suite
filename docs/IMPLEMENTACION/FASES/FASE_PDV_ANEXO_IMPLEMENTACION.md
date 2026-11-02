# Anexo PDV — Plan de implementación: base de datos → lógica → API → pantalla

> Anexo de [`FASE_PDV_PUNTO_DE_VENTA.md`](FASE_PDV_PUNTO_DE_VENTA.md) · 2026-10-31 · pedido de Edgar: *«generar un
> plan de implementación del sistema, desde BD, lógica a visual»*.
> **Refina el §9 de la fase sin cambiarle los números**: cada pieza lleva su `PDV.x`. La pantalla que se construye
> es la del prototipo 2 (`pdv-suite.html`, archivo local de Edgar) y su porqué está en
> [`FASE_PDV_ANEXO_CAJERO.md`](FASE_PDV_ANEXO_CAJERO.md).
> **Estado:** ⬜. La fase no se abre sin D0 (Dirección) y D1 (cómo llega el ticket a Kepler) firmadas y sin cupo
> libre (§6 y §10 de la fase). Lo que sí puede avanzar hoy está en §6 de este anexo.

---

## 0. La arquitectura en un párrafo

**La caja es offline-first.** El ticket nace en el dispositivo como una **serie de eventos con UUID**: escaneo, cantidad, quitar, pago, impresión.
- Los eventos se guardan primero en la base local (Dexie) y una cola los manda al servidor.
- El servidor los recibe **idempotente** (el mismo lote dos veces deja un ticket) y **rearma el ticket con el mismo motor** que usó la caja. Si su total no da lo mismo, no corrige lo cobrado: **marca la diferencia**.
- Después, el ticket va a Kepler según D1, y un conciliador lo compara contra el ODS al centavo, **por evento** (no hay corrida nocturna).
- Nada se borra: corregir es un evento nuevo.

```
caja (Dexie: catálogo · tickets · eventos · cola)
   │  POST /pos/sync (lote de eventos, idempotente por UUID)
   ▼
API (mismo motor de precio y de ticket que la caja) ──► commercial.pos_*  (tablas propias, append-only)
   │  envío según D1                                      ▲
   ▼                                                      │ conciliador por evento (ticket a ticket, al centavo)
Kepler (U-D-10 Ticket Contado Caja N) ──► réplica ──► kepler_ods ──► analytics.erp_sale_tickets
```

## 0b. Lo que ya existe y se reusa (verificado en el repo el 2026-10-31)

| Pieza existente | Dónde | Para qué en la caja |
|---|---|---|
| `QuotePricingService` (ya replica la precedencia de precios de Kepler) | `libs/commercial/src/lib/commercial-quotes/quote-pricing.service.ts` | Base del **motor único** (PDV.11). Se extrae a funciones puras |
| `commercial.pos_line_voids` (0 filas) + su servicio | `libs/commercial/src/lib/commercial-pos-voids/pos-line-voids.service.ts` | Bitácora de eventos (PDV.13), decisión **D-I1** |
| Arqueo ciego de tienda (`/tienda/arqueo`, `STORE_ARQUEO_CAPTURAR`) | `libs/reconciliation/src/lib/store-arqueo.controller.ts` (`store/arqueo`) | **F7 Mi arqueo** y el corte ciego (PDV.14). No se hace otro conteo |
| Conteo ciego por denominación | `blind_counts`, usado por `libs/finance/src/lib/cortes-sucursales/` y `caja/cash-cut.engine.ts` | El cierre del turno se liga a la misma tabla |
| Verificador de precios (`/tienda/verificador`, `STORE_PRICE_CHECK_VER`, fase VAC) | `libs/contracts/src/authz/authz-tree.ts` | **F6 Verificar precio**. En la caja lee el **catálogo local**, para que funcione sin red |
| Ticket de 80 mm | `apps/view/src/app/modules/comercial/ticket-venta.ts` (+2 specs) | Impresión del ticket (PDV.31) |
| Base local Dexie y cola | `apps/view/src/app/core/services/offline-database.service.ts` (igual en `apps/vendor`) | Patrón de la base local de la caja (PDV.30) |
| Claves `STORE_*` y el árbol de autorización | `libs/contracts/src/authz/` | Claves nuevas `STORE_POS_*` (PDV.26) |

---

## 1. C0 · Base de datos

### 1a. Lectura: vistas `derive-no-copy` sobre `kepler_ods`, sin tablas nuevas

| Item | Objeto | Contenido | Prueba que cierra |
|---|---|---|---|
| PDV.1 | `analytics.erp_sale_tickets` (**se extiende**) | Hora `c62`, usuario `c67`, apertura `c80`, formas de pago `c83`–`c88`, recibido y cambio `c97` | Σ formas de pago = `c16` (hoy 25,582 de 25,582) |
| PDV.2 | `analytics.erp_sale_ticket_lines` (**se extiende**) | Presentación capturada `c55` y asentada `c11`, lista `c66`, IVA `c17`, IEPS `c18` | Σ renglones = `c16` al centavo en los 90,428 |
| PDV.3 | `commercial.v_pos_catalog` (**vista nueva**) | Por almacén × producto × presentación: código de barras, factor, precio de lista, escalera (`kdpv_prod_util`), promociones vigentes, impuestos y versión | 200 códigos del anaquel de Yurécuaro dan el precio que cobra Kepler |
| PDV.5 | `commercial.v_pos_drawer_limits` (**vista nueva**) | Fondo, aviso y máximo de `kdpv_folio_caja` (`c43`–`c49`) | Los límites de Yurécuaro: $10,000 de aviso y $15,000 de máximo |

### 1b. Escritura: tablas propias (con `tenant_id` UUID NOT NULL, campos de auditoría y RLS)

| Tabla | Una fila es… | Columnas clave | Reglas en la base |
|---|---|---|---|
| `commercial.pos_registers` | Una caja física | `branch_id`, `warehouse_code`, `number` (8), `kepler_series` (la caja de U-D-10), `device_id` | Única (tenant, sucursal, número) |
| `commercial.pos_sessions` | Un turno (cajera + gaveta) | `register_id`, `cashier_user_id`, `opened_at`, `opening_float`, `opening_counted_by`, `warn_limit`, `max_limit`, `status` (open · closing · closed), `closed_at`, `blind_count_id` | Una sola sesión abierta por caja (índice parcial) |
| `commercial.pos_tickets` | Un ticket | `id` (UUID del dispositivo), `session_id`, `local_folio` (C8-000148), `status` (open · paid · cancelled · suspended), `customer_id` (nulo en el 99.2 %), `total`, `iva`, `ieps`, `savings`, `first_scan_at`, `paid_at`, `server_total`, `diff_cents`, `kepler_status` (pending · sent · confirmed · diff), `kepler_folio` | Única (`register_id`, `local_folio`). El total del servidor se guarda aparte y **no se sobrescribe** el de la caja |
| `commercial.pos_ticket_lines` | Un renglón | `ticket_id`, `seq`, `sku`, `presentation`, `qty` numeric(12,3), `unit_price`, `list_price`, `tier_min`, `iva`, `ieps`, `amount`, `void_event_id` | Lo quitado no se borra: lleva `void_event_id` |
| Bitácora de eventos (**D-I1**) | Un hecho en la caja | `id` UUID, `ticket_id`, `session_id`, `kind` (scan · qty · unit · void_line · quick_fix · cancel · tender · print · reprint · drawer_open · drop · park · resume · price_check), `payload` jsonb, `actor_user_id`, `approver_user_id`, `reason_code`, `device_ts`, `server_ts` | **Append-only**: un trigger rechaza UPDATE y DELETE (prueba negativa obligatoria) |
| `commercial.pos_tenders` | Un pago | `ticket_id`, `kind` (cash · card · transfer), `received`, `applied`, `change`, `reference`, `auth_code` | Σ `applied` = total del ticket pagado (CHECK diferido o prueba) |
| `commercial.pos_drops` | Un retiro de efectivo | `session_id`, `folio` (R8-0003), `denominations` jsonb, `amount`, `received_by`, `receiver_count`, `diff` | Lo cuentan dos personas; la diferencia queda a nombre de ambas |
| `commercial.pos_approvals` | Una autorización | `action`, `ticket_id`/`line_id`, `requested_by`, `approver_user_id`, `channel` (caja · celular), `reason_code`, `status`, `expires_at` | `approver_user_id <> requested_by` (CHECK) |

**Reglas de las migraciones:**
- Se **generan** con `node scripts/nueva-migracion.js` y son idempotentes (`hasTable`/`hasColumn`).
- En prod se aplican **una por una** con `apply-one-migration-prod.js`, fuera de horario hábil.
- Antes de agregar un `NOT NULL`, se recorren todos los caminos que insertan en esa tabla.

### 1c. Base local de la caja (Dexie, versionada)

| Store | Contenido |
|---|---|
| `catalog` | La instantánea de `v_pos_catalog` del almacén más sus cambios por versión. **F6 lee de aquí** |
| `session` | El turno abierto con sus límites |
| `tickets`, `lines` | El ticket en curso y los suspendidos. Sobreviven a una recarga (F5) |
| `events` | Todo lo que pasó, con UUID y `device_ts` |
| `outbox` | Los lotes por enviar. El encabezado dice «N por enviar a Kepler» |

---

## 2. C1 · Lógica: funciones puras en `libs/commercial/src/lib/pos/`, las mismas en la caja y en el servidor

| Item | Módulo | Qué hace | Cómo se prueba |
|---|---|---|---|
| PDV.11 | `pricing/` | `price(sku, presentación, cantidad, almacén, fecha, promociones)` → unitario, lista, escalón y siguiente escalón (para «lleva 1 más»). Sale de `QuotePricingService` y cierra `[VAC.L2]` | **El gemelo**: reproducir los 90,428 tickets con ≥ 99.5 % al centavo, y clasificar el resto |
| PDV.12 | `taxes/` | IVA e IEPS **incluidos** en el precio: la base derivada y el redondeo de Kepler | IVA e IEPS de los 90,428 al centavo |
| PDV.13 | `ticket/reducer.ts` | `(estado, evento) → estado`: venta → cobro → cobrado, más cancelado y suspendido. El servidor rearma el ticket aplicando sus eventos | Re-aplicar los eventos del prototipo da el mismo total. Un evento fuera de orden se rechaza |
| — | `command/parse.ts` | La gramática de la línea de comandos: `código`, `5*código`, `peso*código`, letras = búsqueda, `importe + F12` | Casos del prototipo como pruebas: `33061 F12` se rechaza por el límite de cambio; `1.884*17083` agrega kilos |
| PDV.15 | `policy/` | Cada acción → **permitido · pide autorización · negado**. Corrección inmediata dentro de 15 s, límite de cambio de $1,000 y nadie se autoriza a sí mismo | Una prueba por regla, más su prueba negativa |
| PDV.14 | `drawer/` | El efectivo de la gaveta, derivado de los eventos (fondo + efectivo − cambio − retiros). Aviso y máximo, y retiro obligatorio | Contra `c49` de Kepler en los turnos de octubre |
| PDV.16 | `folio/` | Serie por caja asignada en el dispositivo; dos cajas sin red no repiten folio | Prueba de concurrencia con dos dispositivos simulados |
| PDV.17 | `offline-matrix.ts` | Qué se puede hacer sin red, **como dato**, no como `if` disperso | Cada operación bloqueada tiene su prueba |

**Regla de la capa:** nada de esto toca la base ni el DOM. Así el **mismo código** corre en la caja sin red y en el servidor que verifica.

---

## 3. C2 · API (módulo `pos` en `libs/commercial`, prefijo `/pos`)

| Item | Endpoint | Escribe | Prueba antes de prod |
|---|---|---|---|
| PDV.20 | `GET /pos/catalog?warehouse=&since_version=` | no | < 500 ms con el catálogo completo de Yurécuaro |
| PDV.21 | `POST /pos/sessions` · `POST /pos/sessions/:id/drops` · `POST /pos/sessions/:id/close` (este liga el conteo de `store/arqueo`) | sí | En el CI contra Postgres real, con el payload de apertura, retiro y corte del prototipo |
| PDV.22 | `POST /pos/sync`: lote de eventos y tickets, idempotente por UUID | sí | El mismo lote dos veces deja un ticket. Un total distinto se guarda en `diff_cents`, no se corrige |
| PDV.23 | `POST /pos/approvals` · `POST /pos/approvals/:id/decide` + aviso al celular por el WebSocket `/store` | sí | Vencida, de otra sucursal o autoaprobada → rechazada |
| PDV.24 | Envío a Kepler (según D1) + conciliador contra el ODS, por evento | sí (Kepler) | En el entorno que fije D1. Nunca desde una laptop apuntando a prod |
| PDV.25 | `GET /pos/tickets/:id` · `POST /pos/tickets/:id/reprint` · cancelación | sí | Toda reimpresión dice «COPIA» y queda en la bitácora |
| PDV.26 | Claves `STORE_POS_VENDER`, `STORE_POS_AUTORIZAR`, `STORE_POS_RETIRAR` y `STORE_POS_SUPERVISAR` en `libs/contracts`, **repartidas en prod** a cajero, auxiliar y encargado | sí (permisos) | Verificado leyendo prod con `permissions -> 'KEY'`, no por presencia de clave |

⛔ Cada endpoint que escribe queda como 🧪 sólo cuando una prueba lo ejerció **contra una base real con el payload de la pantalla** (regla 13). Tocar decoradores de Nest obliga a probar `design:paramtypes`.

---

## 4. C3 · Pantalla (el prototipo 2, hecho con el sistema «Mercado»)

| Item | Pieza | Sale del prototipo |
|---|---|---|
| PDV.30 | **La caja, instalable** y en modo quiosco, con base local y cola (**D-I2**: ruta o app) | — |
| PDV.31 | `CommandLineComponent` (línea única con foco bloqueado y modo visible) · `TicketListComponent` (renglón seleccionado, destello, tachados) · `StatePanelComponent` (venta · cobro · cambio · autorización · verificador · arqueo) · `KeyLegendComponent` (teclas del momento) | Las cuatro zonas del prototipo |
| PDV.31 | Servicios: `KeyboardService` (un solo `keydown`, escáner por velocidad, mapa de teclas de Kepler), `SoundService` (tono y zumbido), `PrintService` (`ticket-venta.ts`) | La lógica del prototipo, ahora con pruebas |
| PDV.32 | Autorización en el panel (motivo 1–4 + PIN) y en el celular (`/tienda/aprobar`, móvil) | Panel «Pide supervisor» |
| PDV.33 | Apertura (fondo por denominación), retiro obligatorio **dentro** de la venta, corte ciego (reusa el arqueo) y **pantalla del cliente** (segunda ventana sincronizada por `BroadcastChannel`) | F7 y `#cliente` del prototipo |
| PDV.34 | Hardware según el censo (PDV.6): impresora de 80 mm, cajón, lector con sufijo Enter, báscula | — |
| PDV.35 | `/tienda/cajas`: supervisión por excepción (en `apps/view`, con menú y permiso) | Tablero del lienzo |

**Antes y después de cada pantalla:** la skill `diseno` (las 5 preguntas ya están contestadas en el anexo del cajero, §10), `npm run check:pantalla -- <módulo>` sin fallas nuevas, y prueba con cajeras reales. Lo que no se pudo ver se declara «sin validación visual».

---

## 5. Orden, compuertas y tiempos

| Semana | Capa | Compuerta para subir |
|---|---|---|
| 1–2 | **C0**: vistas PDV.1–3 y PDV.5, tablas 1b, censo PDV.6, cortes de red PDV.7, cronómetro PDV.8 | **G0**: las sumas cuadran al centavo, las tablas rechazan borrar eventos (prueba negativa vista en rojo) y el censo está completo |
| 3–5 | **C1**: motor, impuestos, reducer, gramática, políticas, gaveta, folio y matriz | **G1**: el gemelo da ≥ 99.5 % sobre los 90,428 y todas las políticas tienen prueba negativa |
| 6–7 | **C2**: catálogo, sync, sesiones, autorizaciones, envío y conciliador, claves | **G2**: cada escritura ejercida en el CI con su payload; idempotencia probada; permisos repartidos en prod |
| 8–11 | **C3**: caja, autorizaciones, apertura/retiro/corte, pantalla del cliente, hardware, `/tienda/cajas` | **G3**: `check:pantalla` sin fallas nuevas y sesión con cajeras (cinco tareas, errores contados) |
| 12–13 | **Piloto** PDV.50: una caja de Yurécuaro con serie nueva en Kepler y la caja de Kepler de respaldo | Las tres métricas antes y después con la misma consulta (PDV.51) |

**El camino crítico es D1.** Sin saber cómo llega el ticket a Kepler, el envío (PDV.24) no tiene contra qué probarse. Lo demás puede construirse, pero no salir a la tienda.

## 6. Lo que puede empezar HOY sin abrir la fase

1. **El gemelo + el motor único como `[VAC.L2]`**: PDV.4 + PDV.11 + PDV.12. Sólo lee prod, no escribe nada, y cierra una deuda existente (cuatro resolvedores de precio que no coinciden). Es la pieza con más dinero y menos riesgo.
2. **Las vistas de lectura** PDV.1–3 y PDV.5. Sirven también al verificador y a `/tienda/live`.
3. **El censo de cajas** (PDV.6) y **el cronómetro** (PDV.8). No son código, los hacen los encargados, y sin ellos no hay línea base.

## 7. Decisiones de implementación (las tomo yo; se firman al abrir la fase)

| # | Decisión | Recomendación | Por qué |
|---|---|---|---|
| **D-I1** | Bitácora de eventos: ¿se extiende `commercial.pos_line_voids` o se crea otra tabla? | **Extenderla** (columnas `kind`, `payload`, `session_id`) y nombrarla con la vista `commercial.v_pos_events`, si su esquema admite eventos sin renglón. Si sus `NOT NULL` no lo permiten, tabla nueva y `pos_line_voids` congelada (no se borra: regla 5) | ADR-056: no se inventa otra bandeja. Hoy tiene 0 filas, así que extenderla no rompe a nadie. **Se verifica en C0** leyendo su esquema |
| **D-I2** | ¿App nueva `apps/caja` (como dice §9) o ruta `/caja` dentro de `apps/view`? | **Ruta `/caja` en `apps/view`** con diseño de quiosco y su propio servicio Dexie. App separada sólo si el bundle o el modo sin red lo exigen (medido en C3) | Una app nueva es otro despliegue en k3s, otro NodePort y otro carril de entrega. `apps/view` ya tiene Dexie y el ticket de 80 mm |
| **D-I3** | Impresión y cajón | **V1**: impresión del navegador en modo quiosco y cajón con la opción «abrir al imprimir» del driver. **V2**: QZ Tray (ESC/POS) si el censo lo pide | El navegador no puede mandar el pulso del cajón. El driver sí, sin código. La pantalla dice «enviado a la impresora», no «impreso» |
| **D-I4** | La terminal bancaria | V1 sin integrar (se captura la referencia). La integración (Mercado Pago, Clip, NetPay) va **después del piloto** | Quita la doble captura, pero exige contrato con el proveedor. Ver el anexo del cajero, §9 |

## 8. NO MEDIDO (se mide en C0 o en el piloto)

- Segundos por ticket con Kepler (PDV.8)
- Hardware de las 37 cajas (PDV.6)
- Cortes de red por sucursal (PDV.7)
- Productos con código de barras por presentación (PDV.3)
- Si el esquema de `pos_line_voids` admite eventos sin renglón (D-I1)
- Tamaño del bundle de la ruta `/caja` (D-I2)
