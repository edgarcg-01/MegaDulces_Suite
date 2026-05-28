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
