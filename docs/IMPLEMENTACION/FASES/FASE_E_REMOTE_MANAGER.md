# Fase E — Remote Manager (Televenta)

**Duración estimada MVP:** 3-4 días (1 dev).
**Objetivo:** dar a operadores de call center un workflow para llamar a clientes priorizados, ver su contexto comercial completo, tomar pedidos en su nombre y registrar resultado de cada llamada.

> **Decisión de scope 2026-05-27 (Edgar)**: MVP delgado.
> - **Solo workflow** (sin telefonía Twilio/Vonage). El operador usa su teléfono físico.
> - **Pool compartido autoservicio**: el operador entra, ve cola priorizada, toma un lead, lo trabaja, lo cierra. Sin asignación automática ni cartera fija.
> - **MVP no incluye dashboard de métricas** (E.2 del stub original). Las stats se construyen sobre `call_logs` cuando se necesite.
> - **Cartera scoped**: el operador ve solo SUS reservas activas + el pool sin reservar.

---

## Pre-requisitos

- ✅ Fase B cerrada (orders + customers operativos).
- ✅ Fase D.4 cerrada (`commercial.recommended_baskets` con categoría `inactive` que usaremos para priorizar).
- ✅ Socket.IO `/alerts` namespace funcionando (para notifs realtime opcionales).

---

## Decisiones técnicas

### Schema

Schema `commercial.*` extendido con 2 tablas nuevas:

#### `commercial.lead_reservations`
Quien tomó qué cliente del pool y por cuánto tiempo (TTL).
- `(tenant_id, id)` composite FK.
- `customer_id` UUID FK a `commercial.customers(tenant_id, id)`.
- `reserved_by_user_id` UUID FK a `public.users(tenant_id, id)`.
- `reserved_at` TIMESTAMPTZ NOT NULL DEFAULT NOW().
- `expires_at` TIMESTAMPTZ NOT NULL (default `NOW() + interval '30 minutes'`).
- `released_at` TIMESTAMPTZ NULL (NULL = activa).
- `released_reason` TEXT NULL (`completed`/`released_manual`/`expired`).
- Constraint: UNIQUE PARTIAL `(tenant_id, customer_id) WHERE released_at IS NULL` — solo una reserva activa por cliente.
- RLS forzado.

#### `commercial.call_logs`
Registro de cada llamada (resultado).
- `(tenant_id, id)` composite FK.
- `customer_id`, `user_id` (operador), `called_at`, `outcome` enum, `notes` TEXT.
- `outcome` valores: `sale`, `no_sale`, `callback_scheduled`, `no_answer`, `wrong_contact`, `other`.
- `next_action_at` TIMESTAMPTZ NULL (cuando outcome=`callback_scheduled`).
- `order_id` UUID NULL FK a `commercial.orders(tenant_id, id)` — link al pedido si outcome=`sale`.
- `duration_minutes` SMALLINT NULL.
- RLS forzado.

### Cola priorizada (algoritmo simple)

`GET /commercial/televenta/queue` devuelve customers ordenados por:
1. Status `inactive_critical` (sin pedido en >60 días).
2. VIP sin pedido en >30 días (top 20% por revenue 6m).
3. Customers en `recommended_baskets.category_counts.inactive > 0`.
4. Customers nuevos sin orders aún.
5. El resto, ordenados por `last_contact_at DESC NULLS FIRST`.

Excluye los que ya tienen reserva activa de OTRO operador.

### Permisos + rol nuevo

- `COMMERCIAL_TELEVENTA_OPERATE` — operar la cola (reserve/release/log).
- `COMMERCIAL_TELEVENTA_VER` — solo lectura (supervisor).
- Rol `tele_operator` agregado a `role_permissions` con permisos:
  - `COMMERCIAL_TELEVENTA_OPERATE`
  - `COMMERCIAL_ORDERS_CREAR` (puede tomar pedidos)
  - `COMMERCIAL_CUSTOMERS_VER`
  - `COMMERCIAL_PRICING_VER`
  - `COMMERCIAL_INVENTORY_VER`
  - `COMMERCIAL_RECOMMENDATIONS_VER`

### Frontend

Nuevo proyecto `/televenta` (no en `/dashboard` ni `/comercial`) listado en `/projects` cuando el user tiene `COMMERCIAL_TELEVENTA_OPERATE`.

Páginas:
- `/televenta` — cola priorizada + reservas activas del operador + botón "Tomar siguiente".
- `/televenta/lead/:customer_id` — snapshot del cliente: perfil + últimos 5 pedidos + recomendaciones + historial de llamadas + 2 botones: "Tomar pedido" y "Registrar resultado de la llamada".
- `/televenta/lead/:customer_id/take-order` — flujo de toma de pedido (reusa lógica de vendor-take-order si fuera posible).

---

## Sprints

### Sprint E.0 — Schema + permisos + rol ⬜

| ID | Item | Estado |
|---|---|---|
| E.0.1 | Migración `commercial_televenta_schema`: tablas `lead_reservations` + `call_logs` con composite FK, RLS, grants `app_runtime`, índices, partial unique constraint en reservations activas. | ⬜ |
| E.0.2 | Permisos `COMMERCIAL_TELEVENTA_OPERATE` + `COMMERCIAL_TELEVENTA_VER` en `permissions.ts` (back+front). | ⬜ |
| E.0.3 | Seed `commercial_roles_televenta`: agregar rol `tele_operator` en `role_permissions` con permisos definidos. | ⬜ |
| E.0.4 | Smoke RLS: 2 tenants, reserva de uno no visible para el otro. | ⬜ |

### Sprint E.1 — Backend `commercial-televenta` ⬜

| ID | Item | Estado |
|---|---|---|
| E.1.1 | `CommercialTeleventaService` con: `getQueue()` (algoritmo priorizado, excluye reservas ajenas), `reserveLead(customer_id, user_id, ttl=30m)`, `releaseLead(reservation_id, reason)`, `getCustomerSnapshot(customer_id)`, `logCall(payload)`, `getMyReservations(user_id)`, `getCustomerCallHistory(customer_id)`. | ⬜ |
| E.1.2 | `CommercialTeleventaController` endpoints: `GET /queue`, `GET /my-reservations`, `POST /leads/:customer_id/reserve`, `POST /leads/:reservation_id/release`, `GET /customers/:id/snapshot`, `GET /customers/:id/calls`, `POST /calls`. Guards: `RequireAuthGuard + RolesGuard + RequirePermissions`. | ⬜ |
| E.1.3 | `TeleventaCronService` con `@Cron('*/5 * * * *')`: libera reservas con `expires_at < NOW() AND released_at IS NULL` (sets released_reason='expired'). | ⬜ |
| E.1.4 | Wirear `CommercialTeleventaModule` en AppModule dentro del toggle `ENABLE_MULTITENANT`. | ⬜ |
| E.1.5 | HTTP smoke `database/http-televenta-test.js`: login tele_operator → queue → reserve → snapshot → log call (sale + order) → release → verify state. | ⬜ |

### Sprint E.2 — Frontend `/televenta` ⬜

| ID | Item | Estado |
|---|---|---|
| E.2.1 | Permission enum frontend sync (COMMERCIAL_TELEVENTA_*). Card "Televenta" en `/projects` landing visible cuando perms. | ⬜ |
| E.2.2 | `TeleventaShellComponent` standalone con header + nav (Cola, Mis activos, Logout). | ⬜ |
| E.2.3 | `TeleventaQueueComponent` (`/televenta`): tabla cola priorizada + tag de razón (inactivo/VIP/nuevo) + botón "Tomar". Sección "Mis reservas activas" con TTL restante. | ⬜ |
| E.2.4 | `TeleventaLeadDetailComponent` (`/televenta/lead/:id`): snapshot del cliente (info contacto + últimos pedidos + recomendaciones + llamadas previas). Botones "Tomar pedido" y "Registrar llamada" (modal con outcome + notes + next_action). | ⬜ |
| E.2.5 | `TeleventaTakeOrderComponent` (`/televenta/lead/:id/take-order`): reusa lógica del vendor-take-order con catalog del customer. Al confirmar order, opcionalmente registra call_log con outcome=sale + order_id linkeado. | ⬜ |
| E.2.6 | `televentaGuard` enforce rol con permiso `COMMERCIAL_TELEVENTA_OPERATE`. Lazy-loaded en `app.routes.ts`. | ⬜ |
| E.2.7 | `nx build view` OK. | ⬜ |

### Sprint E.3 — Verificación + cierre ⬜

| ID | Item | Estado |
|---|---|---|
| E.3.1 | Agregar `http-televenta-test.js` a `database/run-all-tests.js`. | ⬜ |
| E.3.2 | Validación visual manual (Edgar): login `tele_operator` → cola → tomar lead → snapshot → tomar pedido → registrar resultado. | ⬜ |
| E.3.3 | Entry de cierre en `03_LOG_REVISIONES.md` con métricas y aprendizajes. | ⬜ |

---

## Deferred post-MVP

- **E.4 — Métricas + dashboard productividad**: calls/día por operador, conversion rate, AOV, ticket promedio. Reusa data en `call_logs`.
- **E.5 — Telefonía integrada (Twilio Voice)**: click-to-call + grabación + callbar. Requiere ADR-013 nuevo + cuenta Twilio.
- **E.6 — Asignación inteligente**: round-robin automática o ML-driven (best-fit operador↔cliente).
- **E.7 — Handoff WhatsApp**: cuando Fase F esté online, botón "enviar promo por WhatsApp" desde el snapshot del cliente.
- **E.8 — Recordatorios callback**: cron diario que notifica al operador (via Socket.IO `/alerts`) sus callbacks programados del día.

---

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Reservas zombie (operador cierra browser sin release) | Cron @5min limpia expired. TTL 30 min suficiente para una llamada normal. |
| Dos operadores compiten por mismo lead | UNIQUE PARTIAL constraint en DB previene race; backend retorna 409 en el segundo. |
| Operador genera pedido pero no registra call_log | `take-order` confirm puede auto-loguear con outcome=sale + order_id. Aceptable que algunos calls queden sin log si el operador descarta. |
| Cola vacía (raro) | UI muestra empty state "Todos los clientes están al día — chequeá callbacks programados". |
| Cliente bloqueado por crédito intenta pedido | OrdersService ya valida `credit_limit` y rebota — el operador ve el error y registra llamada con outcome=no_sale + notes. |

## E.9 — el tablero ve la facturación del canal, y el módulo se llama Telemarketing (2026-09-07)

Disparador: *"hay que cambiar /televenta/dashboard para que ahí también se vean las facturas, y ordenemos este módulo para telemarketing"*.

### Lo que la auditoría encontró antes de tocar nada

Medido en prod:

- **`commercial.call_logs` está VACÍA: 0 llamadas.** Todo el tablero (llamadas, minutos, conversión, top operadores, outcomes 7d) publicaba **ceros**. El módulo nunca se usó.
- **La cola de leads apunta al universo equivocado:** sale de `commercial.customers`, que son 412 clientes con código `V-…` captados por vendedores en campo. **0 de 412 empatan** con los clientes que telemarketing factura de verdad (206 códigos del ERP).
- **La operación real existe y sólo vive en el ERP:** 4 operadores (30003 Daniel Francisco Franco, 10002 Sergio Mendoza, 10001 Cinthia del Valle, 30004 José Ramón Rodríguez), **732 facturas y $8,243,050 en 30 días**, con **$2,340,863 vencidos por cobrar**.
- **No hay puente operador↔usuario:** `identity.users` no tiene `vendedor_code` (sólo `route_id`), así que la factura se atribuye por el vendedor del ERP y **no** se puede cruzar con quien registre la llamada.
- **El rol en prod ya se llama `telemarketing`** (no `televenta`) y los 3 roles con acceso al módulo (direccion, superadmin, telemarketing) **ya tienen `COMMERCIAL_SALES_DOCS_VER`**: el enlace a facturación funciona sin repartir permisos nuevos.

### Qué se hizo

- **Facturación real en el tablero** (`billing` en `GET /commercial/televenta/dashboard`): hoy / mes / 30 días, cobrado, **vencido por cobrar**, desglose **por operador** del ERP y las **últimas 8 facturas** con su estado de cobro. Sale de `analytics.erp_sales_invoices` — la misma vista en vivo que consume `/comercial/documentos`, sin copiar nada.
- **Va primero en la pantalla**, antes de la actividad: es lo que existe todos los días.
- **La actividad se declara**: si `call_logs` no tiene registros, el tablero dice *"no hay llamadas capturadas en este módulo"* en vez de pintar 0% de conversión como si fuera un resultado (ADR-056). La facturación no depende de esa captura y se dice.
- **Nombre unificado a Telemarketing** en lo visible: encabezado, marca del shell, nav ("Dashboard" → "Resumen", + "Facturación"), labels de los dos permisos y su categoría, nodo de `authz-tree`, preset de rol, selector de proyectos. **La ruta `/televenta` se queda** (enlaces guardados y el guard) y los nombres de clase/archivo también: renombrarlos es churn sin nada visible.
- El enlace a Facturación va **gateado por `COMMERCIAL_SALES_DOCS_VER`**: un enlace que lleva a un rechazo del guard es peor que no mostrarlo.
- ⚠️ Cada consulta del bloque va con su selección **materializada antes de ordenar/recortar**: sobre esta vista un `ORDER BY … LIMIT` directo dispara el nested loop de AX.9 (23,856 ms vs 970 ms).

Smoke `test-newdb-telemarketing-billing.js` **9/9 contra prod** (incluye que la facturación cuadre al peso con `/comercial/documentos` y la prueba negativa del puente inexistente). Builds api y view verdes. El bloque responde en **1,096 ms**.

### Lo que sigue abierto (decisión de Edgar, 2026-09-07)

- ⬜ **E.10 — re-apuntar la cola al ERP.** Hoy prioriza 412 clientes de campo que no son de telemarketing; debería trabajar los 206 reales, ordenados por su historial de facturación (última factura, saldo, días sin comprar). Es el trabajo que hace que el módulo sirva para operar, no sólo para mirar. Se pospuso a propósito para entregar la facturación primero.
- ⬜ **E.11 — puente operador↔usuario.** Sin un `vendedor_code` en `identity.users` no hay forma de medir a un operador de punta a punta (sus llamadas y sus facturas). Mientras no exista, el tablero muestra dos atribuciones distintas y lo dice.
- ⬜ Los bloques de actividad siguen en el tablero aunque publiquen ceros: se declaran, no se retiran. Si la captura no arranca, conviene quitarlos.
