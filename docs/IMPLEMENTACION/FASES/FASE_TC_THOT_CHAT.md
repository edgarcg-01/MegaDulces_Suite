# Fase TC — Thot Chat (analítica conversacional sobre ventas)

> Cara conversacional de Thot: un chat que responde preguntas complejas sobre **toda la data de ventas** (Kepler real + pedidos B2B + inventario + clientes + promos), orquestando los métodos deterministas que ya existen vía **tool-use** de Claude. Hereda ADR-016/018: *el motor decide y calcula, el agente comunica, el LLM fuera del camino del dinero*.

**ADR:** ADR-026 (ver `02_DECISIONES_ARQUITECTURA.md`).
**Arranque:** 2026-06-30.

---

## Decisión arquitectónica (validada contra industria)

Investigación de cómo lo hacen Uber (QueryGPT), LinkedIn (SQL Bot), Snowflake (Cortex Analyst), Databricks (Genie) y las guías de Anthropic. **Convergencia de todos:**

1. **Capa semántica curada** entre el LLM y los datos — nadie le da el schema crudo (provoca alucinaciones). Definiciones de negocio + sinónimos + ejemplos verificados.
2. **RAG sobre metadata/ejemplos, jamás sobre las filas de hechos.** Embeddings no suman ni agregan; los números salen de consultas estructuradas.
3. **Evals/benchmark** como ciudadano de primera clase.

**Nuestra forma:** tools deterministas (columna vertebral, RLS forzado) + RAG solo para resolución de entidades + escape hatch `flexible_aggregate` (sin SQL libre). NO se "vuelve la DB un RAG".

```
Números/agregaciones → TOOLS deterministas (TenantKnexService, RLS)   ← columna vertebral
Entidades difusas     → resolve_entity (catálogo/clientes ILIKE)      ← RAG ligero
Long-tail flexible    → flexible_aggregate (whitelist, sin SQL libre) ← escape hatch
LLM                   → orquesta tools + narra + cita fuente/período  ← NUNCA calcula
```

**Frontera de seguridad:** el LLM solo ve la salida JSON de métodos ya filtrados por `current_tenant_id()`. Cero SQL generado por el modelo. Read-only en v1; las acciones que mueven dinero siguen en el co-piloto con aprobación.

---

## Sprints

| Sprint | Tema | Estado |
|---|---|---|
| **TC.0** | Tool registry + capa semántica (glosario ES) + `resolve_entity` + `flexible_aggregate` | 🔨 EN CÓDIGO (build api verde) |
| **TC.1** | `ThotChatService` (agent loop tool-use + self-correction) | 🔨 EN CÓDIGO (build api verde) |
| **TC.2** | Endpoint `POST /commercial/intelligence/thot/chat` + permiso + persistencia (`commercial.thot_chat_log`) | 🔨 EN CÓDIGO (migración sin aplicar) |
| **TC.3** | Frontend chat UI `/comercial/thot-chat` (Operations) + render estructurado + tab "Pregúntale a Thot" | 🔨 EN CÓDIGO (build view verde) |
| Evals | `database/tests/http-thot-chat-test.js` (golden-questions, ruteo de tools) | 🔨 EN CÓDIGO (pendiente correr live) |
| **TC-S** | Hardening + refactor a perfiles (ToolProvider/ThotScope); admin `/thot/chat` rechaza `customer_b2b`/`vendedor` | 🔨 EN CÓDIGO (build api verde) |
| **TC-P** | Portal B2B: `PortalThotToolsService` scoped a `customer_id` (sin márgenes/terceros, surtido PH) + `/portal/thot/chat` + UI Storefront `/portal/assistant` | 🔨 EN CÓDIGO (build portal verde) |
| **TC-V** | Vendedor: `VendorThotToolsService` scoped a cartera (stock PH, márgenes OK) + `/vendor/thot/chat` + UI mobile + voz `/vendor/assistant` | 🔨 EN CÓDIGO (build vendor verde) |
| **TC-E** | Banco 50 preguntas + red-team de fuga por perfil (`http-thot-chat-*.js`) | 🔨 EN CÓDIGO (pendiente correr live) |
| **TC.4a** | Ejemplos verificados (few-shot) — `thot_chat_examples` + semillas + injection por solape | 🔨 EN CÓDIGO (build verde) |
| **TC.5a** | Feedback loop 👍/👎 (`thot_chat_log` +feedback/+promoted) + cola de candidatos + pantalla de curaduría `/comercial/thot-curation` + thumbs en portal/vendor | 🔨 EN CÓDIGO (build verde) |
| **TC.4b** | Retrieval por embeddings (Voyage + pgvector dedicado de prod, `VECTOR_DATABASE_URL`) + endpoint/botón Reindexar. Degrada a solape si no hay vector DB | 🔨 EN CÓDIGO (build verde) |
| TC.6 | Text-to-SQL controlado completo + streaming SSE | ⬜ diferido |

**Nota TC.4b:** existe DB vector dedicada en prod (pgvector 0.8.2, ya con `product_embeddings` de Fase K). `thot_example_embeddings` (denormalizada, HNSW cosine) se crea sola (`ensureSchema`) al reindexar. Pendiente prod: `VECTOR_DATABASE_URL` + `VOYAGE_API_KEY` en la API + correr "Reindexar" una vez.

**"Entrenamiento" de Thot (TC.4a/5a):** NO se fine-tunea el modelo ni se hornean cifras. Se aprende del USO: biblioteca de ejemplos dorados (pregunta→tools→respuesta) inyectados como few-shot; loop usar→👍→promover (cola de curaduría)→few-shot. Determinista y auditable (ADR-021). Mejoras de comportamiento sobre la marcha: regla "investigá antes de preguntar" + `share_pct` determinista (el LLM no calcula %). Validado en PROD: red-team 31/31 (portal/vendor/admin); gate admin por `COMMERCIAL_CUSTOMERS_GESTIONAR` (no por nombre de rol). Pendiente prod: aplicar migraciones `thot_chat_examples` y `thot_chat_log_feedback`.

**Pendientes operacionales (prod):** (1) aplicar migración `20260630200000_thot_chat_log` en Railway; (2) `ANTHROPIC_API_KEY` en el entorno; (3) correr `http-thot-chat-test.js` (50 preguntas) + `http-thot-chat-scoped-test.js` (red-team) con la API arriba; (4) opcional `THOT_CHAT_MODEL` (Sonnet) y `THOT_FULFILLMENT_WAREHOUSE` (default `MD-10`). Re-login NO requerido.

---

## TC-S/P/V — Perfiles scoped (Portal + Vendor)

**Principio:** el loop se reusa; cambian **tool-provider + prompt + scope** por audiencia. El **scope se deriva del JWT en el controller y se impone server-side** — el LLM jamás elige cliente/almacén fuera de alcance.

| Perfil | Endpoint | Scope | Ve | NUNCA ve |
|---|---|---|---|---|
| admin | `/thot/chat` | tenant completo | todo | — (rechaza customer_b2b/vendedor) |
| portal | `/portal/thot/chat` | `customer_id` del JWT | solo lo suyo, surtido PH | otros clientes, márgenes, analítica global |
| vendor | `/vendor/thot/chat` | cartera (rutas asignadas) | sus clientes, stock PH, márgenes | clientes fuera de su cartera |

**Hallazgo de seguridad (cerrado en TC-S):** `customer_b2b` y `vendedor` tienen `COMMERCIAL_ORDERS_VER` → con el gate original podían pegarle al chat admin y ver TODO el tenant. Fix: deny explícito por rol en el endpoint admin + endpoints scoped propios.

**Surtido PH:** `PH_FULFILLMENT_WAREHOUSE` (`MD-10`, env `THOT_FULFILLMENT_WAREHOUSE`). Disponibilidad/stock de portal y vendor sale de ese almacén (alineado con `import-ph-stock-live.js`).

**Frontends:** Portal = Storefront (Fraunces) en `/portal/assistant`. Vendor = mobile-first + **voz Web Speech es-MX** en `/vendor/assistant`.

**Nota:** el build de `apps/view` quedó rojo por WIP de otro thread (`ThotAiInputComponent`), ajeno a esta fase; api/portal/vendor compilan verde.

---

## TC.0 — Tool registry + capa semántica

`libs/commercial/src/lib/commercial-intelligence/thot-chat/`

- **`thot-semantic.ts`** — glosario de negocio ES (venta=revenue, caja, rotación, PdV, stock muerto, días de cobertura, ABC…) + reglas duras del system prompt. Es lo que hace al chat preciso con términos de dominio.
- **`thot-tools.service.ts`** — `ThotToolsService`: `definitions()` (schema Anthropic, namespacing `thot_*`) + `execute(name, input)` (RLS vía `tk.run`/tenant explícito). ~20 tools envolviendo `CommercialAnalyticsService` + `ThotService` + `resolve_entity` + `flexible_aggregate` + `list_warehouses`.

Tools: get_sales_overview · sales_timeseries · top_products · top_customers · erp_customers · customer_products · sales_by_brand · margin_by_category · product_ranking · sales_by_zone · inventory_health · dead_stock · low_stock · out_of_stock_bestsellers · active_promotions · inactive_customers · thot_suggest · resolve_entity · flexible_aggregate · list_warehouses.

**Fuente de los números:** las tools `*_erp` / historical / sales_daily / product_sales_stats reflejan **venta real Kepler**; las basadas en `commercial.orders` (overview, top_customers, inactive) reflejan el **pipeline B2B de la app** (chico en beta). Las descripciones lo dejan explícito para que el modelo elija bien.
