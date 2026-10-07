# Fase TOT — Thot Toma Pedidos (order-taking conversacional)

> **Estado:** 🔨 EN CURSO 2026-07-24. **TOT.1 (vendedor) en código** — el chat de Thot del vendedor ya arma, ajusta y confirma pedidos conversando; build api verde. Portal + tabla de plantillas = siguientes.
>
> **Tesis (hereda ADR-016/018/026):** el motor decide el dinero, el LLM comunica. Thot **arma un borrador** conversando (todas las escrituras pasan por `CommercialOrdersService`, que pone precio/stock/mínimos); el humano **confirma** (HITL); el LLM **nunca inventa** precios ni cantidades.

---

## 1. Arquitectura (money-safe)

El chat de Thot gana *write tools* que envuelven el `CommercialOrdersService` determinista. El LLM traduce lenguaje natural ("mándame 5 cajas de payaso y 2 bubaloo") a llamadas de herramienta; el servicio resuelve precio (lista del cliente), stock (almacén de surtido) y mínimos; los **errores del servicio** (mínimo, sin precio, sin stock) se devuelven **por renglón** al LLM para que **ajuste con el usuario**. El borrador = `commercial.orders(status='draft')` (mismo modelo cart=draft que ya usan vendor/portal), find-or-create por `(customer_id, vendedor)`.

**Scope server-side (nunca del LLM):** el `customer_id` se valida contra la cartera del vendedor (`guarded()`); el vendedor sale del JWT. Portal (siguiente) derivará el customer del JWT.

---

## 2. Sprints

Estados: ⬜ TODO · 🔨 EN CÓDIGO · 🧪 PROBADO · 🚀 STAGING · ✅ PROD

- 🔨 **TOT.1 — Vendedor toma pedidos** — EN CÓDIGO 2026-07-24
  `VendorThotToolsService` + `CommercialOrdersService` (import de `CommercialOrdersModule` en el módulo de intelligence). 6 tools nuevas:
  - `thot_order_usual(customer_id)` — "lo de siempre" (vía `frequentProducts()`).
  - `thot_order_add(customer_id, items[{query,quantity}])` — ensureDraft + resuelve producto (SKU/nombre, pide desambiguar si ambiguo) + `addLine` c/u; devuelve `added` / `failed[reason]` + carrito.
  - `thot_order_set_qty(customer_id, query, quantity)` — cantidad exacta (`updateLine`/`addLine`/`removeLine` si 0).
  - `thot_order_remove(customer_id, query)` — `removeLine`.
  - `thot_order_review(customer_id)` — lee el borrador (renglones + total).
  - `thot_order_confirm(customer_id)` — `place()` (draft→confirmed idempotente) **sólo con "sí" explícito**; devuelve folio + total.
  System prompt del vendedor extendido con las reglas de toma de pedido (HITL, cero números inventados, leer antes de confirmar). Build api verde.
  *Pendiente:* validación en vivo (requiere redeploy + `ANTHROPIC_API_KEY`) + probar con cliente real de cartera.

- 🔨 **TOT.2 — Portal B2B toma pedidos** — EN CÓDIGO 2026-07-24
  Mismas 5 tools en `PortalThotToolsService` scoped al `customer_id` del JWT (sin arg, sin `guarded` — es su propio pedido). Confirmar usa `confirm()` (draft→**pending_approval**, lo aprueba el vendedor — flujo B2B existente). "Lo de siempre" reusa `thot_my_last_order`/`thot_my_usual_products` ya existentes. System prompt del portal actualizado (la regla vieja "no podés crear pedidos" se reemplazó por las reglas HITL). Build api verde.

- 🔨 **TOT-C — Asistente conversacional de COMPRAS (requisiciones a proveedor)** — EN CÓDIGO 2026-07-24
  Aplica el mismo patrón al lado de PROCURA (/compras/pedido), envolviendo el motor RA (no Thot-ventas). `ComprasToolsService` (nuevo provider `ThotToolProvider`, profile `compras`) reusa el loop `ThotChatService.ask`. 5 tools: `compras_resolve_supplier`, `compras_worklist` ("¿qué toca?"), `compras_suggested_order` (sugerido en CAJAS por proveedor×almacén, base cadence), `compras_create_requisition` (items[{sku,cajas}] → `createRequisition` → **pending_approval**), `compras_pending_requisitions`. El motor pone cantidades/costo; el LLM no inventa; la requisición queda pendiente de aprobación (HITL). Endpoint `POST /commercial/intelligence/compras/thot/chat` (gate `COMPRAS_GESTIONAR`). Frontend: página `/compras/asistente` (chat compacto Operations) + nav "Asistente (Thot)". Module: intelligence importa `CommercialReplenishmentModule`. Builds api+view verdes.
  *Pendiente:* redeploy + `ANTHROPIC_API_KEY` + prueba en vivo (resolver proveedor → sugerido → ajustar → crear requisición → folio).

- ⬜ **TOT.3 — "Guardar para próximos" explícito (plantillas)**
  Hoy "lo de siempre" se computa on-the-fly (`frequentProducts()`) — suficiente para el MVP. Nice-to-have: tabla `commercial.customer_order_templates` (customer_id + label + items jsonb) para plantillas nombradas ("mi pedido de fin de semana"), tool `thot_order_save_template` / `thot_order_load_template`.

- ⬜ **TOT.4 — Sincronía con el carrito visual**
  Que la UI del chat (o del take-order) refleje el borrador que Thot construye en vivo (el borrador ya persiste en DB; sólo falta que la pantalla lo lea/refresque).

- ⬜ **TOT.5 — Autoventa / entrega inmediata por voz**
  Extender a `deliverNow()` (autoventa) para rutas que cobran al momento, con arqueo. Gated.

---

## 3. Guardrails
- El LLM **NUNCA** pasa `customer_id`/`warehouse_id`/precio — el scope y el precio son server-side.
- `thot_order_confirm` sólo tras `thot_order_review` + confirmación explícita del usuario (regla dura en el prompt).
- Los errores del servicio (mínimo de compra, sin stock, sin precio) se muestran tal cual; el LLM no reintenta solo.
- Todo bajo RLS (`TenantKnexService`) y permisos (`COMMERCIAL_ORDERS_CREAR` gatea el chat del vendedor).

---

## 4. Pendiente prod
- Redeploy api (+ `ANTHROPIC_API_KEY` en Railway para el chat en vivo) + re-login.
- Probar el flujo completo con un cliente real de cartera (armar → ajustar → confirmar → folio).
