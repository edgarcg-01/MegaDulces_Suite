# Fase K — AI product match en captures (pgvector + Voyage + Haiku)

**Duración estimada:** 1-2 sesiones (1 dev) para el MVP solo captures.
**Objetivo:** que el colaborador en PdV pueda pegar una lista libre de productos en el wizard de captura (paso 5) y el sistema identifique semánticamente cuáles del catálogo TM corresponden, dejándolos pre-marcados para confirmación.

> **Decisión 2026-05-27 (Edgar):** scope MVP **solo captures** (paso 5 del wizard). NO incluir admin bulk-import, portal B2B, ni vendedor en esta fase. Generalizar después si el MVP valida.

---

## Pre-requisitos

- ✅ Catálogo TM (`brands` + `products`) existente en DB legacy con ≥100 productos activos.
- ✅ Acceso a Anthropic API (clave existente o nueva — Haiku 4.5).
- ⬜ Cuenta Voyage AI + API key (`VOYAGE_API_KEY`). **Pendiente Edgar**: crear cuenta en https://www.voyageai.com y generar key.
- ✅ Postgres legacy soporta `CREATE EXTENSION vector` (Railway lo permite; local 18.4 también).

---

## Decisiones técnicas (ADRs)

- **ADR-011** — Provider de embeddings: Voyage AI `voyage-3` (1024 dims, multilingual).
- **ADR-012** — pgvector va en DB legacy; cuando se migre TM a multi-tenant la columna `embedding` viaja con la tabla.

---

## Arquitectura

```
[Captures wizard paso 5]
        │
        ├─ botón "Agregar con AI" → abre AiProductPickerModal
        │
        ▼
[<app-ai-product-picker>]
   - textarea libre + placeholder ejemplo
   - botón "Reconocer" → POST /api/planograms/products/match-ai
   - preview con auto-confirmados (verde), ambiguos (amarillo dropdown), no encontrados (rojo)
   - botón "Aplicar selección" → emite array de pids
        │
        ▼
[captures.component] productosMarcados += ids confirmados → cierra modal
```

```
[POST /api/planograms/products/match-ai]
        │
        ├─ Step 1: Haiku 4.5 (tool_use structured output)
        │     prompt: "Extrae cada producto como item separado. Normaliza."
        │     output: [{ raw, normalized }, ...]
        │
        ├─ Step 2: Voyage voyage-3 embed batch (N items)
        │     output: [number[1024], ...]
        │
        ├─ Step 3: pgvector KNN top-3 por item
        │     SELECT id, brand_id, nombre, 1 - (embedding <=> $1) AS score
        │     FROM products WHERE activo = true
        │     ORDER BY embedding <=> $1 LIMIT 3
        │
        └─ Step 4: shape response
              { items: [{ raw, normalized,
                suggested: { product_id, score, autoConfirm: score > 0.80 },
                alternatives: [{ product_id, score }, ...]
              }, ...] }
```

---

## Sprints

### Sprint K.0 — Schema + extensión + backfill ✅ (2026-05-27)

> Habilitar pgvector, agregar columna `embedding` a `products`, calcular embeddings iniciales del catálogo entero.

| ID | Item | Estado |
|---|---|---|
| K.0.0 | Docker container `pgvector-md` (pgvector/pgvector:pg18) en `localhost:5433`, restore completo del `postgres_platform` de `192.168.0.245`. Rol `app_runtime` recreado con grants en public/commercial/analytics/logistics. `.env` cutoveado al container. La instancia remota queda intacta como referencia (`DATABASE_URL_REMOTE_SNAPSHOT`). | ✅ |
| K.0.1 | Migración `database/migrations-newdb/20260527120000_enable_pgvector_and_products_embedding.js` aplicada: `CREATE EXTENSION vector` (0.8.2) + 3 columnas en `products` (`embedding vector(1024)`, `embedding_source_text TEXT`, `embedding_updated_at TIMESTAMPTZ`) + HNSW index parcial `WHERE activo=true AND embedding IS NOT NULL`. Idempotente. | ✅ |
| K.0.2 | `database/scripts/backfill-product-embeddings.js` — Node standalone: lee products activos sin embedding, batches de 100, Voyage `voyage-3` (input_type=document), persiste `embedding`/`embedding_source_text`/`embedding_updated_at`. Flags: `--force`, `--limit N`, `--dry-run`. Idempotente. Retry exponencial en 429/5xx. | ✅ |
| K.0.3 | Vars en `.env` + `.env.example`: `VOYAGE_API_KEY`, `VOYAGE_EMBED_MODEL=voyage-3`, `ANTHROPIC_API_KEY`, `AI_PRODUCT_MATCH_MAX_ITEMS=50`. No se creó `env.schema.ts` (el repo no usa schema centralizado; validación inline en K.1). | ✅ |
| K.0.4 | Backfill ejecutado: **1278/1278 products embedded** (100%). Smoke pgvector OK con 5 queries (mazapan rosa → LA ROSA MAZAPAN 0.49; paleta payaso → PALETA PAYASO 20PZ 0.48; pulparindo → PULPARINDO 20PZ 0.39). Threshold del plan original (0.80) **recalibrado a 0.50** — scores típicos de voyage-3 sobre nombres de SKU en español MX están en 0.35-0.55. | ✅ |

**Salida:** catálogo entero (1278 SKUs) embedded en DB Docker local. Index HNSW operativo. Voyage costo backfill ≈ $0.02 USD.

**Observaciones encontradas:**
- Catálogo tiene **duplicados con casing distinto** (ej. `PALETA PAYASO 20PZ` vs `Paleta Payaso 20pz`). No es bug de Fase K. K.2 debe dedupe en UI o filtrar al mostrar matches.
- Voyage **free tier = 3 RPM / 10k TPM** hasta agregar payment method. Resuelto agregando tarjeta — backfill completo de 800 rows restantes en 9.8s.
- Mismatch de versión `pg_dump` 17 vs server 18 al hacer dump remoto. Solucionado usando `pg_dump.exe` nativo Windows 18 en lugar del del container.

---

### Sprint K.1 — Backend module `ai-product-matcher` ✅ (2026-05-27)

| ID | Item | Estado |
|---|---|---|
| K.1.1 | `EmbeddingsService` (`apps/api/src/shared/ai/embeddings.service.ts`): wrapper Voyage REST (fetch directo, sin SDK extra). `embedSingle` + `embedBatch`. Retry exp en 429/5xx (3 intentos). Timeout 10s. Logger NestJS. Validación de API key en `onModuleInit` con warning (no throw) — el módulo puede arrancar sin la key. | ✅ |
| K.1.2 | `LlmExtractorService` (`apps/api/src/shared/ai/llm-extractor.service.ts`): Anthropic Messages API direct + Claude Haiku 4.5 con `tool_use` schema (`extract_products`) estricto. Sanitiza output. Timeout 15s. Fallback heurístico al `split` por `,;/|\n` + ` y ` si LLM falla o no hay key. | ✅ |
| K.1.3 | `AiProductMatcherService.match(rawText)`: sanity check (5000 chars, MAX_ITEMS=50) → LLM extract → Voyage embed batch (`input_type=query`) → KNN top-3 paralelo via `Promise.all`. Score = `1 - (embedding <=> $vec)`. Threshold **0.50** (recalibrado en K.0, no 0.80 del plan original). | ✅ |
| K.1.4 | `AiProductMatcherController`: `POST /api/planograms/products/match-ai`. Guards: `RequireAuthGuard + RolesGuard` + `@RequirePermissions(VISITAS_REGISTRAR)`. `@Throttle({ default: { ttl: 60_000, limit: 10 } })`. `ValidationPipe + whitelist`. Status 200. | ✅ |
| K.1.5 | Hook en `planograms.service.ts`: método privado `embedProduct(id)` síncrono. Llamado tras `addProduct` (siempre) y `updateProduct` (solo si cambia `nombre` o `brand_id`). Try/catch silencioso — falla NO bloquea operación admin, el row queda sin embedding y backfill script lo recoge. | ✅ |
| K.1.6 | Tests unit/integration ⏭️ **skipped**: el repo no tiene infra de tests para servicios externos (no hay mocks de fetch en el setup actual de Jest). Verificación cubierta por smoke HTTP K.1.7 y smoke pgvector ya verde en K.0. | ⏭️ |
| K.1.7 | HTTP smoke `database/http-ai-match-test.js`: **29/29 OK** ejecutado 2026-05-27. Fixes durante smoke: (a) endpoint a `ai/products/match-ai` (conflicto path con PlanogramsProductsController), (b) threshold 0.50 → 0.40 (scores reales más bajos), (c) `@Throttle` key `default` → `long`. Items con match exacto pueden tener score 0.38 (penalización por longitud); el wizard permite confirmar manual sin perder UX. | ✅ |

**Salida:** endpoint operativo, hookeado. Build `nx build api` OK con warnings preexistentes (no de Fase K).

**Archivos:**
- `apps/api/src/shared/ai/embeddings.service.ts`
- `apps/api/src/shared/ai/llm-extractor.service.ts`
- `apps/api/src/modules/ai-product-matcher/ai-product-matcher.module.ts`
- `apps/api/src/modules/ai-product-matcher/ai-product-matcher.service.ts`
- `apps/api/src/modules/ai-product-matcher/ai-product-matcher.controller.ts`
- `apps/api/src/modules/ai-product-matcher/dto/match-ai.dto.ts`
- `database/http-ai-match-test.js`
- Modificados: `apps/api/src/app.module.ts`, `apps/api/src/modules/planograms/planograms.module.ts`, `apps/api/src/modules/planograms/planograms.service.ts`

---

### Sprint K.2 — Frontend modal en captures wizard ✅ (2026-05-27)

| ID | Item | Estado |
|---|---|---|
| K.2.1 | `AiProductMatcherService` (frontend) en `apps/view/.../captures/ai-product-matcher.service.ts` — wrapper HTTP tipado, devuelve `Observable<MatchResponse>`. | ✅ |
| K.2.2 | `<app-ai-product-picker>` standalone: inputs `[catalog]` + `[currentSelected]`, outputs `(applied)` `(cancelled)`. Estados signal-based (`idle`/`loading`/`preview`/`error`). Textarea max 5000 chars con contador, ejemplo placeholder MX. Botones Reconocer / Cancelar / Otra lista / Agregar N. | ✅ |
| K.2.3 | Preview UI: 3 KPI cards (confirmados/revisar/no encontrados). Cada item con `raw` (gris) + sugerido (nombre + brand + score%). Severity colors: verde ≥0.50 (autoConfirm), amarillo 0.35-0.50 (revisar), rojo <0.35 (no match). Alternativas top-2 clickeables que cambian el `selectedProductId`. Tag con score%. Detección "ya en la lista" para evitar duplicados. | ✅ |
| K.2.4 | Integración en `captures.component.ts` step 5: import del componente, signal `showAiPicker` + getter/setter adaptador para `[(visible)]` de `<p-dialog>`, handlers `openAiPicker/onAiPickerApplied/onAiPickerCancelled` con merge dedupe contra `productosMarcados`. Botón "Agregar varios con AI" gradient sunset arriba del search clásico. | ✅ |
| K.2.5 | Network guard: signal `isOnline` con listeners `online`/`offline` agregados en `ngOnInit` y removidos en `ngOnDestroy`. Botón AI `*ngIf="isOnline()"`. Tap offline → toast warning. Search clásico intacto. | ✅ |
| K.2.6 | `nx build view` OK — warnings preexistentes (canvg/jspdf), nada de Fase K. | ✅ |

**Archivos:**
- `apps/view/src/app/modules/dashboard/captures/ai-product-matcher.service.ts`
- `apps/view/src/app/modules/dashboard/captures/ai-product-picker.component.ts`
- `apps/view/src/app/modules/dashboard/captures/ai-product-picker.component.html`
- Modificados: `captures.component.ts`, `captures.component.html`

---

### Sprint K-sync — Integridad embedding ↔ SQL ✅ (2026-05-27)

> Pregunta de Edgar: "¿cómo se mantiene integridad entre la tabla SQL y la vectorial?". Decisión: eventually-consistent vía trigger + cron scanner. Si Voyage cae, los embeddings quedan stale (con valor viejo) hasta que el scanner los refresca. **Cero impacto en operaciones admin**.

**Garantías ofrecidas:**

| Escenario | Comportamiento |
|---|---|
| Crear product via API admin | Hook síncrono embed inmediato; si Voyage falla, queda stale, cron lo recoge en ≤15 min |
| Editar `products.nombre` o `products.brand_id` (via SQL directo o API) | Trigger marca stale automáticamente. Embedding viejo se preserva para degradación elegante. Cron refresca |
| Editar `brands.nombre` (via API) | Hook explícito marca stale TODOS los products del brand. Cron refresca |
| Insert SQL directo (scripts/importers) | Trigger marca stale. Cron refresca |
| Soft-delete (`deleted_at` set / `activo=false`) | Index HNSW parcial los ignora trivialmente. Embedding queda. Si se reactiva, vuelve a aparecer |
| Voyage API temporal down | Cron log warning, reintenta próximo tick. Operaciones admin no se bloquean |

**Sincronía Docker ← .245 (manual):**

```
node database/scripts/sync-from-remote.js                # full sync (dump + restore + migrate + backfill)
node database/scripts/sync-from-remote.js --skip-backfill # solo dump + restore + migrate
node database/scripts/sync-from-remote.js --remote URL    # override
```

Requiere: Docker Desktop running + `pg_dump.exe` en `C:\Program Files\PostgreSQL\18\bin\` + `DATABASE_URL_REMOTE_SNAPSHOT` en `.env`.

**Componentes:**

| ID | Item | Estado |
|---|---|---|
| K-sync-1 | Migración `20260527150000_products_embedding_staleness_trigger.js`: función + trigger BEFORE INSERT/UPDATE. | ✅ |
| K-sync-2 | Hook en `planograms.service.ts.updateBrand`: si cambia `brand.nombre`, marca stale products del brand. | ✅ |
| K-sync-3 | `EmbeddingSyncService` con `@Cron('0 */15 * * * *')` + endpoint manual `POST /api/ai/products/sync-now`. Batches 50, lock anti-overlap. | ✅ |
| K-sync-4 | Script `database/scripts/sync-from-remote.js`: workflow completo Docker ← .245. | ✅ |
| K-sync-5 | Build api OK + smoke E2E (5 products stale → scanner → embed → verified). | ✅ |

---

### Sprint K.3 — Verificación + cierre

| ID | Item | Estado |
|---|---|---|
| K.3.1 | HTTP smoke regresión: agregar `http-ai-match-test.js` a `database/run-all-tests.js`. Verificar `N suites verde`. | ⬜ |
| K.3.2 | Verificación E2E manual: levantar `nx serve api` + `nx serve view`, login con user de captures, abrir wizard, paso 5, probar 3 listas reales (1 con typos, 1 con abreviaciones, 1 con SKUs ambiguos). | ⬜ |
| K.3.3 | Entry de cierre en `03_LOG_REVISIONES.md`: arquitectura final + decisiones + lessons learned + métricas (latencia P50/P95 del endpoint, match accuracy estimada con muestra). | ⬜ |
| K.3.4 | Actualizar memory feedback si surge algo no obvio (ej: threshold óptimo cambió, alguna lib raruna, etc.). | ⬜ |

---

## Riesgos identificados

| Riesgo | Mitigación |
|---|---|
| Offline-first (captures funciona offline con Dexie) — AI search requiere red | Ocultar botón "Agregar con AI" cuando offline. Search clásico siempre disponible. |
| Productos nuevos sin embedding | Hook síncrono en `planograms.addProduct` evita rezago. Logger warning si query encuentra null embeddings. |
| Costo runaway (alguien pega un libro) | MAX_ITEMS=50, length=5000 chars, throttler 10 req/min. Telemetry de calls/día. |
| Voyage API caída | Try/catch → degradación silenciosa al search clásico. Toast informativo. |
| Match ambiguo (varias variantes del mismo producto) | UI muestra top-3 alternativas; usuario elige. No auto-confirma. |
| Catálogo migra a multi-tenant después → ¿qué pasa con `embedding`? | Por ADR-012 la columna viaja con la tabla. Script de copia incluye `embedding` + recrea HNSW del lado destino. |

---

## Deferidos post-MVP

- **K.4 (deferred)** Bulk import en admin-catalogs / admin-planograma (pegar lista para crear productos nuevos en batch).
- **K.5 (deferred)** Mismo motor en portal B2B (cliente arma pedido pegando texto) y en módulo vendedor (`vendor-take-order`).
- **K.6 (deferred)** Telemetry persistido en tabla `ai_match_telemetry` (texto, items, hits, misses, autoConfirm rate) para tuning de threshold.
- **K.7 (deferred)** Foto del exhibidor → AI vision (Claude vision) → identifica productos en la foto sin que el usuario los escriba.

---

## Archivos esperados a tocar/crear

### Nuevos
- `database/migrations/20260527XXXXXX_enable_pgvector_and_products_embedding.js`
- `database/scripts/backfill-product-embeddings.js`
- `apps/api/src/shared/ai/embeddings.service.ts`
- `apps/api/src/shared/ai/llm-extractor.service.ts`
- `apps/api/src/modules/ai-product-matcher/ai-product-matcher.module.ts`
- `apps/api/src/modules/ai-product-matcher/ai-product-matcher.service.ts`
- `apps/api/src/modules/ai-product-matcher/ai-product-matcher.controller.ts`
- `apps/api/src/modules/ai-product-matcher/dto/match-ai.dto.ts`
- `apps/view/src/app/modules/dashboard/captures/ai-product-matcher.service.ts`
- `apps/view/src/app/modules/dashboard/captures/ai-product-picker.component.ts`
- `apps/view/src/app/modules/dashboard/captures/ai-product-picker.component.html`
- `database/http-ai-match-test.js`

### Modificados
- `apps/api/src/app.module.ts` — registrar `AiProductMatcherModule`.
- `apps/api/src/env/env.schema.ts` — agregar vars.
- `.env.example` — documentar vars.
- `apps/api/src/modules/planograms/planograms.service.ts` — hook re-embed en add/updateProduct.
- `apps/view/src/app/modules/dashboard/captures/captures.component.ts` — botón + integración modal.
- `apps/view/src/app/modules/dashboard/captures/captures.component.html` — slot del botón.
- `database/run-all-tests.js` — agregar suite K.

---

## Costo operativo estimado

| Concepto | Cálculo | Total mensual |
|---|---|---|
| Backfill inicial 1k SKUs | 1k × $0.00002 | ~$0.02 (one-shot) |
| Re-embed productos nuevos (10/mes) | 10 × $0.00002 | ~$0.0002 |
| Queries online captures (estimado 100/día) | 100/día × 30 × ($0.0001 Voyage + $0.0001 Haiku) | ~$0.60/mes |
| **Total mensual estimado** | | **~$1 USD** |

Para 10 tenants: ~$10/mes. Despreciable.
