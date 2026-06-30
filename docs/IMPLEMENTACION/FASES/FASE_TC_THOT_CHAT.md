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
| TC.4 | Ejemplos verificados con retrieval (few-shot) | ⬜ diferido |
| TC.5 | Telemetría tokens/tools + feedback 👍👎 | ⬜ diferido |
| TC.6 | Text-to-SQL controlado completo + streaming SSE | ⬜ diferido |

**Pendientes operacionales (prod):** (1) aplicar migración `20260630200000_thot_chat_log` en Railway; (2) `ANTHROPIC_API_KEY` en el entorno (ya usada por otros módulos AI); (3) correr `http-thot-chat-test.js` con la API arriba y ver verde; (4) opcional `THOT_CHAT_MODEL` para usar Sonnet en orquestación compleja. Re-login NO requerido (reusa permiso `COMMERCIAL_ORDERS_VER`).

---

## TC.0 — Tool registry + capa semántica

`libs/commercial/src/lib/commercial-intelligence/thot-chat/`

- **`thot-semantic.ts`** — glosario de negocio ES (venta=revenue, caja, rotación, PdV, stock muerto, días de cobertura, ABC…) + reglas duras del system prompt. Es lo que hace al chat preciso con términos de dominio.
- **`thot-tools.service.ts`** — `ThotToolsService`: `definitions()` (schema Anthropic, namespacing `thot_*`) + `execute(name, input)` (RLS vía `tk.run`/tenant explícito). ~20 tools envolviendo `CommercialAnalyticsService` + `ThotService` + `resolve_entity` + `flexible_aggregate` + `list_warehouses`.

Tools: get_sales_overview · sales_timeseries · top_products · top_customers · erp_customers · customer_products · sales_by_brand · margin_by_category · product_ranking · sales_by_zone · inventory_health · dead_stock · low_stock · out_of_stock_bestsellers · active_promotions · inactive_customers · thot_suggest · resolve_entity · flexible_aggregate · list_warehouses.

**Fuente de los números:** las tools `*_erp` / historical / sales_daily / product_sales_stats reflejan **venta real Kepler**; las basadas en `commercial.orders` (overview, top_customers, inactive) reflejan el **pipeline B2B de la app** (chico en beta). Las descripciones lo dejan explícito para que el modelo elija bien.
