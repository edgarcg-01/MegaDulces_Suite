# Fase Horus — Supervisor AI de Ejecución en Campo (Trade)

**ADR base:** [ADR-020](../02_DECISIONES_ARQUITECTURA.md#adr-020--horus-supervisor-ai-de-ejecución-en-campo-trade)

**Duración estimada:** rebanada vertical "parte diario" en 1-2 sprints; las 3 capacidades (parte / visión / fraude) por rebanadas sucesivas.

**Objetivo:** un **supervisor de ventas aumentado por AI** para el proyecto Trade (auditoría de ejecución en PdV). El motor calcula cobertura, calidad de ejecución, anomalías y prioridad de atención de forma determinista; el agente (Claude Haiku 4.5) redacta el diagnóstico, el coaching y conversa; la visión (Claude vision) audita el 100% de las fotos. El AI **prepara acciones** (reasignar ruta, abrir alerta, enviar coaching, marcar para revisión) que el supervisor humano **aprueba con un clic** — nunca ejecuta solo lo laboralmente sensible.

> **Decisión 2026-06-16 (Edgar):** (1) nivel de autonomía = **co-piloto** — el AI recomienda *y* prepara la acción concreta, el humano aprueba; (2) alcance = **las 3 capacidades** (parte diario, auditoría visual de fotos, detección de fraude/anomalías); (3) entregable de planeación = este doc + ADR-020.

---

## La idea unificadora

> **Dónde mirar hoy, por qué, y qué hacer al respecto — sin que el supervisor tenga que escanear 200 capturas a mano.**

Un supervisor humano no escala tres cosas: revisar el 100% de las fotos, correlacionar el GPS de toda la flotilla, y dar coaching consistente y diario a cada colaborador. Horus automatiza exactamente esas tres, deja la decisión en el humano, y traduce números a lenguaje de supervisor.

No es un feature: es **feature store + motor de decisión + agente + co-piloto de acciones + loop de feedback**, replicando el patrón que [Thot](FASE_THOT_MOTOR.md) estableció para Comercial.

---

## Relación con Thot (y por qué van separados)

El proyecto ya decidió (FASE_M línea 217, ADR-016) **no construir un motor compartido** todavía: "más capturado" (presencia/auditoría, Trade) ≠ "más pedido" (compromiso económico, Comercial) — unidades distintas, y acoplar el ranker de captura con el camino-de-dinero es acoplamiento prematuro.

| | **Thot** (Comercial) | **Horus** (Trade) |
|---|---|---|
| Unidad de análisis | `customer_id` (qué pedir) | `collaborator` / `route` / `store` (cómo se ejecuta) |
| Pregunta | "la oferta correcta al cliente correcto" | "dónde mirar hoy y qué hacer" |
| Fuente | `commercial.orders` | `daily_captures`, `daily_assignments`, `route_location_pings` |
| Vive en | `libs/commercial/.../commercial-intelligence` | `libs/trade/.../supervisor-ai` |

**Comparten solo las primitivas AI** de `platform-core` (`LlmExtractorService`, `EmbeddingsService`, throttling). Horus **no importa** `commercial-intelligence`. Núcleo compartido = patrón replicado, no lib única (se extrae solo cuando haya 3er consumidor).

---

## Pre-requisitos (qué ya existe y se reusa)

- ✅ `daily_captures` con `exhibiciones` JSONB (concepto, ubicación, nivel, productos, `fotoUrl`, `perteneceMegaDulces`), `score_final_pct`, `hora_inicio/fin`, `lat/lng`, `route_id`, `store_id` — [daily-captures.service.ts](../../../libs/trade/src/lib/daily-captures/daily-captures.service.ts).
- ✅ scoring-v2 versionado → `score_final_pct` confiable — [scoring-v2.service.ts](../../../libs/trade/src/lib/scoring/scoring-v2.service.ts).
- ✅ `daily_assignments` (ruta esperada por user × día) → base de cobertura.
- ✅ `route_location_pings` (GPS breadcrumbs) + `getIdleSummary` / `getRouteTrack` — [reports.service.ts](../../../libs/trade/src/lib/reports/reports.service.ts).
- ✅ **LLM**: [LlmExtractorService](../../../libs/platform-core/src/lib/ai/llm-extractor.service.ts) → Claude Haiku 4.5 vía fetch + tool_use; ya hace **visión** (`extractFromTicketImage`) → reusable para auditar fotos.
- ✅ **Embeddings/pgvector**: [EmbeddingsService](../../../libs/platform-core/src/lib/ai/embeddings.service.ts) → Voyage-3 (texto; **no sirve para fotos recicladas** → ver Horus.6).
- ✅ `AlertsScannerService` (cron @5min) — patrón de orquestación a copiar.
- ✅ TenantContext/RLS + `TenantKnexService.run()` — obligatorio en todo handler; cron con scope sintético (patrón Customer360Refresh).
- 🟡 `store_id` poblado solo ~9% (memoria) → cobertura poco confiable hasta reforzar captura de tienda.
- 🟡 GPS parcial (tracking web foreground; nativo diferido).

---

## Arquitectura — 5 capas

```
┌─────────────────────────────────────────────────────────────────┐
│ CAPA 3 — CANALES   pantalla /dashboard/supervisor-ai · push      │  entrega
├─────────────────────────────────────────────────────────────────┤
│ CAPA 2 — AGENTE    Claude Haiku: parte diario, coaching, /ask    │  comunica
│                    Claude Vision: audita fotos de exhibición     │
├─────────────────────────────────────────────────────────────────┤
│ CAPA 1 — MOTOR     cobertura · calidad/score · idle · anomalías  │  DECIDE
│         (DECIDE)   share propio vs competencia · priorización    │  (determinista)
│                    + CO-PILOTO: prepara acción → pending_approval│
├─────────────────────────────────────────────────────────────────┤
│ CAPA 0 — EXECUTION trade.execution_360 (collaborator/route/store)│  feature store
│         FEATURE     cobertura · score+trend · idle · share · ... │  nocturno + on-demand
├─────────────────────────────────────────────────────────────────┤
│ CAPA 4 — FEEDBACK  supervisor confirma/descarta finding →        │  APRENDE
│                    recalibra umbrales (trade.execution_thresholds)│
└─────────────────────────────────────────────────────────────────┘
        ↑ todo dentro de TenantContext/RLS (TenantKnexService.run)
```

### Invariantes (heredadas de ADR-016)
1. **El motor decide, el agente comunica.** El agente llama al motor como tools; nunca inventa cobertura ni scores.
2. **El LLM nunca toca el camino crítico.** Sancionar, reasignar, acusar de fraude = acción humana. El AI deja la acción en `pending_approval`; el supervisor aprueba/rechaza. (Reusa el patrón de estado `pending_approval` de ADR-013.)
3. **Visión y fraude producen *findings* revisables, no veredictos.** Una foto marcada "reciclada" abre un finding, no una sanción.

### Tool-belt del agente (Capa 2)
`get_execution_360`(subject) · `list_findings`(filtros) · `get_coverage`(route) · `get_collaborator_scorecard`(user) · `get_store_competitive`(store) · `propose_action`(type, payload) — todos scoped por tenant vía `TenantKnexService.run()`.

---

## Inventario de señales (qué prometer en V1)

| Señal | Fuente | Estado | Usar en |
|---|---|---|---|
| Calidad / score + tendencia | `score_final_pct` + scoring-v2 | 🟢 fuerte | V1 |
| Tiempos / idle | `hora_inicio/fin`, `getIdleSummary` | 🟢 fuerte | V1 |
| Cobertura fotográfica | `exhibiciones[].fotoUrl` | 🟢 fuerte | V1/V2 |
| Cobertura visitado vs asignado | `store_id` × `daily_assignments` | 🟡 `store_id` ~9% | V1 (parcial) |
| Share propio vs competencia | `exhibiciones[].perteneceMegaDulces` | 🟡 muchos `null` | V1 |
| GPS↔tienda, breadcrumbs | `route_location_pings` × `stores.lat/lng` | 🟡 parcial | V3 |
| Foto reciclada | pHash (Cloudinary), **no Voyage** | ⬜ por construir | V3 |

V1 se para en lo 🟢; lo 🟡 se trata como "mejora a medida que la data crece" (igual que Thot dejó estacionalidad dormida).

---

## Schema propuesto (`trade.*`, RLS forzado, FK compuesta `(tenant_id, id)`)

**`trade.execution_360`** — feature store (PK `tenant_id, subject_type, subject_id, window`):
`subject_type` ∈ {collaborator, route, store}, `window` ∈ {7d, 30d}; `coverage_pct`, `visits_planned/done`, `avg_score`, `score_trend`, `idle_min_avg`, `own_share_pct`, `competitor_share_pct`, `days_since_last_visit`, `photo_coverage_pct`, `anomaly_count`, `computed_at`.

**`trade.supervisor_findings`** — la evidencia detectada:
`finding_type` (low_coverage / score_drop / idle_anomaly / gps_mismatch / impossible_time / photo_mismatch / recycled_photo / competitor_gain / store_at_risk), `severity` (info/warn/critical), `subject_type/id`, `capture_id?`, `score`, `evidence` JSONB (datos deterministas, **no texto LLM**), `explanation` (redacción del agente, opcional), `source` (engine/vision/embedding), `status` (open/reviewed/dismissed/confirmed), `reviewed_by/at`.

**`trade.supervisor_actions`** — el co-piloto:
`finding_id?`, `action_type` (reassign_route / open_alert / send_coaching / flag_for_review / request_recapture), `payload` JSONB, `proposed_by='horus'`, `status` (pending_approval/approved/rejected/executed/expired), `approved_by/at`, `executed_at`, `result` JSONB.

**`trade.execution_thresholds`** — umbrales configurables por tenant (capa 4): coverage_min, score_drop_pct, idle_max_min, gps_mismatch_m, photo_sim_threshold…

---

## Endpoints (`/api/trade/supervisor`, permiso base `SUPERVISOR_AI_VER`)

- `POST /compute` — recomputa `execution_360` (cron + on-demand, scope tenant).
- `GET /briefing?date=` — parte diario: findings priorizados + texto del agente + ranking de atención.
- `GET /findings?subject=&status=&type=` — bandeja de hallazgos.
- `POST /findings/:id/review` `{status: confirmed|dismissed}` — **feedback loop**.
- `POST /audit-photos` `{capture_id?|date}` — dispara visión (Horus.5).
- `GET /actions?status=pending_approval` — bandeja de acciones.
- `POST /actions/:id/approve` (`SUPERVISOR_AI_APROBAR`) → ejecuta el `action_type`.
- `POST /actions/:id/reject`.
- `POST /ask` `{question}` — agente conversacional (deferred, Horus.7).

Throttle AI (`@Throttle`): `/audit-photos` y `/ask` en tier acotado (10/min) como los demás endpoints AI.

---

## Sprints

### Horus.0 — Execution Feature Store ⬜
Tabla `trade.execution_360` + `ExecutionRefreshService` (cron nocturno + on-demand por tenant, `TenantKnexService.run`, scope sintético). Computa cobertura/score/idle/share desde `daily_captures` + `daily_assignments` reusando agregaciones de `ReportsService`. **Base de todo.**

### Horus.1 — Motor de findings determinista ⬜
`ExecutionEngineService`: reglas explicables sobre `execution_360` → `supervisor_findings` (low_coverage, score_drop, idle_anomaly, competitor_gain, store_at_risk). Umbrales desde `execution_thresholds`. Cero LLM.

### Horus.2 — Agente: parte diario ⬜
`SupervisorAgentService`: una llamada Haiku con los findings agregados → redacta el parte + ranking de atención. El texto va a `findings.explanation` / respuesta de `/briefing`. **= capacidad "parte diario".**

### Horus.3 — Pantalla `/dashboard/supervisor-ai` ⬜
Componente standalone: parte del día, bandeja de findings (filtros), drill-down por colaborador/ruta/tienda (reusar [SidePeek + Customer360Panel](../../../apps/view/src/app/shared/components/)). Permiso + nav item. Sync permission enum FE↔BE + mapping `ability.factory` (evitar 403).

### Horus.4 — Co-piloto: acciones con aprobación ⬜
`trade.supervisor_actions` + `propose_action` (el motor sugiere) + `approve/reject` + ejecutores: `reassign_route` (escribe `daily_assignments`), `open_alert` (reusa `AlertsService`), `send_coaching` (push/notif), `flag_for_review`. **= nivel "co-piloto".**

### Horus.5 — Visión: auditoría de fotos ⬜
`PhotoAuditService`: por `fotoUrl`, llama Claude vision (reusa `extractFromTicketImage`) con tool `audit_exhibition_photo` → `{matches_concept, well_executed 0..1, out_of_stock, looks_recycled, notes}` → findings. **= capacidad "auditoría visual".** Encuadre de costo: priorizar exhibiciones propias / muestreo / solo capturas que el motor marcó sospechosas.

### Horus.6 — Fraude / anomalías ⬜
Determinista: `gps_mismatch` (ping/captura vs `stores.lat/lng` > umbral), `impossible_time` (duración mínima por N exhibiciones / capturas solapadas del mismo user), `recycled_photo` (**pHash de Cloudinary**, no Voyage). Siempre humano en el lazo. **= capacidad "detección de fraude".**

### Horus.7 — Feedback loop + agente conversacional ⬜ (parcial deferred)
`review` de findings (confirmed/dismissed) recalibra `execution_thresholds`. `/ask` conversacional (RAG sobre el feature store) — deferred si el tiempo aprieta.

---

## Secuencia de construcción recomendada

`Horus.0 → .1 → .2 → .3` da el **parte diario funcionando end-to-end con pantalla** (máximo valor, solo datos 🟢). Luego `.4` (co-piloto), `.5` (visión), `.6` (fraude), `.7` (feedback). Cada paso es una rebanada que aporta valor sola.

---

## Riesgos / decisiones a vigilar

- **Calidad de datos:** la cobertura no es confiable hasta subir `store_id` del ~9% — reforzar la captura de tienda (GPS/manual) es prerequisito real de la métrica estrella.
- **Laboral:** todo finding de fraude → `pending_approval`, jamás auto-acción. Acusar a un colaborador es acto humano.
- **Costo LLM:** parte diario = 1 llamada/día (barato). Visión = 1/foto (la cara) → encuadrar con muestreo/priorización. Estimar fotos/día reales de Mega Dulces antes de Horus.5.
- **Foto reciclada ≠ Voyage:** Voyage-3 es texto. Usar pHash (Cloudinary lo expone) o comparación perceptual; no embeddings de texto.
- **Fronteras:** no importar `commercial-intelligence`. Horus vive en `libs/trade`.
- **RLS:** `TenantKnexService.run()` en cada handler; MVs/feature store con filtro `tenant_id` explícito (RLS no aplica a MV).

## Deferred (post primera pasada)
- `/ask` agente conversacional con RAG.
- Propensión/scoring per-tienda (necesita volumen).
- Embeddings de imagen propios (si pHash resulta insuficiente).

---

## Horus v2 — expansión "supervisor de verdad" (2026-06-17)

Tras feedback de Edgar ("no cumple ni el 1% — más inteligencia, 100% acceso a Trade, triplicar conocimiento, opciones de mejora") se rediseña Horus de **detector de umbrales** a **supervisor**. Diagnóstico: el v1 aplasta una visita riquísima (posición en anaquel con pesos Caja=100…, nivel de ejecución, productos exactos, **la foto**, GPS, duración, venta) a ~7 métricas; ignora la foto (**59.7%** de exhibiciones la tienen), GPS, timing, cobertura planeada y venta; y aprobar una acción no hacía nada (`external_delivery:'deferred'`).

Auditoría de datos (read-only, 2026-06-17): 121 caps/30d (407/60d), **5 colaboradores**, score mediana 38.9% (p25 25.9), `score_final_pct` **46%** poblado, `store_id` **33%**, exhibiciones 35% propio / 65% competencia (**0% sin clasificar**), foto 60%.

### Arquitectura objetivo (7 capas, patrón Thot)
`L0 Feature Store v2 (100% Trade, ~25+ señales) → L1 Visión (Claude mira la foto → veredictos estructurados) → L2 motor multi-señal → L3 findings + fraude → L4 Improvement Engine → L5 ejecutor real → L6 feedback loop + Ask-Horus`. Invariante intacto (ADR-016/020): la visión LLM extrae hechos, **el motor determinista decide**, co-piloto `pending_approval`.

### Sprints v2 (renumeran la lista vieja)
| v2 | Qué | Estado |
|---|---|---|
| H2.0 | Housekeeping: aplicar mig `170000` pendiente | en handoff |
| H2.1 | **Feature Store v2** (data-backed: nivel/duración/surtido ✅; posición/cobertura/roll-ups diferidos por datos) | 🟡 PARCIAL EN CÓDIGO 2026-06-17 |
| H2.2 | **Visión de fotos** → `commercial.capture_vision` (share observado, planograma, stockout, foto válida) | ✅ EN CÓDIGO 2026-06-17 |
| H2.3 | **Motor multi-señal** (score de ejecución 0-100 explicable; complementa las reglas) | ✅ EN CÓDIGO 2026-06-17 |
| H2.4 | **Findings v2 + Fraude** (declarado≠observado, GPS, velocidad imposible, foto duplicada) | ✅ EN CÓDIGO 2026-06-17 |
| **H2.5** | **Improvement Engine** — `OpportunityEngineService` (coaching_focus / recover_shelf / reprioritize_route / replicate_best) | ✅ EN CÓDIGO 2026-06-17 |
| **H2.6** | **Ejecutor real** — aprobar crea `coaching_notes` / `supervisor_tasks` (in-app, reversible) | ✅ EN CÓDIGO 2026-06-17 |
| H2.7 | **Venta↔ejecución** (correlación con route_tickets/vendor_sale_lines, read-only) | ✅ EN CÓDIGO 2026-06-17 |
| H2.8 | **Feedback loop + Ask-Horus** (atribución hallazgo→resultado, auto-tune; Q&A read-only) | ⬜ (= vieja Horus.7) |

Diferido honesto: ML real (5 colaboradores = poco volumen, Thot tampoco lo hizo aún); entrega externa WhatsApp/push (infra Fase F). Único costo nuevo: visión Claude (~407 fotos/60d, Haiku barato, incremental).

### H2.5 + H2.6 — entregado (arranque por "valor visible")
- **Migraciones** `20260617100000` (supervisor_actions += `kind`/`rationale`, `action_type` ampliado a 10 tipos) · `110000` (`commercial.coaching_notes`) · `120000` (`commercial.supervisor_tasks`). hardenRls en las nuevas.
- **`OpportunityEngineService`**: lee execution_360 + detalle crudo 60d; 4 reglas de mejora (coaching_focus diagnostica la debilidad concreta; recover_shelf elige producto propio por whitespace de ruta, nombre best-effort de `catalog.products`; reprioritize_route plan de ≥2 tiendas; replicate_best). UPSERT `kind='opportunity'` (dedup `opp:*`), expira separado de findings. Hook en refresh + `/compute`.
- **Ejecutor real** en `SupervisorActionsService.approveAction`: familia coaching→`coaching_notes`, familia campo→`supervisor_tasks` (due=mañana MX, asignado al último captor), `set_target`→`users.meta_puntos`. `result` con ids del artefacto + `reversible:true`; push externo sigue diferido.
- **Endpoints**: `GET /supervisor-ai/opportunities`, `/actions?kind=`, `/tasks`, `/coaching-notes`.
- **Pantalla**: sección "Mejoras sugeridas" (con el porqué) + panel "Hecho por Horus" (tareas + coaching creados).
- **Builds api+view verdes + smoke `http-horus-test.js` 48/48 VERDE** (2026-06-17, secciones 11-12 incluidas): tras `migrate:new` + restart, las mejoras se generan, aprobar crea la nota/tarea persistida en DB y la separación finding/opportunity (`/actions?kind=`) se verifica. Pendiente: validación visual de la pantalla.

### H2.2 — entregado (el salto de inteligencia: Horus mira las fotos)
- **Migración** `20260617140000` (`commercial.capture_vision`, hardenRls, dedup por `photo_key` = fotoPublicId || capture_id:idx → incremental).
- **`PhotoAuditService`** (`libs/trade/.../photo-audit.service.ts`): por cada foto de exhibición (Cloudinary, `daily_captures.exhibiciones[].fotoUrl`, ~60% cobertura) hace fetch→base64→Claude Haiku con tool `audit_exhibition_photo` → veredicto estructurado `{is_shelf, own_brand_visible, competitor_visible, shelf_quality 0..1, out_of_stock, photo_quality}`. **Acotado por costo**: incremental (salta lo analizado), `MAX_PER_RUN=12`, concurrencia 4, tope de bytes; **sin `ANTHROPIC_API_KEY` → no-op graciosa (retryable)**. Replica el patrón de llamada de `SupervisorAgentService` (self-contained, sin acoplar platform-core).
- **Cruce declarado-vs-observado** → `mismatch=true` (gating duro: es anaquel legible + declaró propio + solo se ve competencia) = semilla de fraude para H2.4.
- **`generateVisionFindings`** (source='vision'): agrega por tienda (`vision_stockout`) y colaborador (`vision_mismatch`, `vision_invalid`), respeta decisiones humanas, auto-resuelve. El co-piloto les arma acción (ACTION_FOR: stockout→visit, mismatch/invalid→flag_recapture).
- **Endpoints** `POST /vision/scan` (escanea + regenera findings/acciones), `GET /vision` (veredictos, flagged primero), `GET /vision/coverage`. Hook en el cron nocturno (lote de 20).
- **Pantalla**: panel "Auditoría visual" (cobertura analizadas/total + banderas + fotos flageadas con thumbnail) + botón "Escanear fotos".
- **Builds api+view verdes + smoke `http-horus-test.js` 56/56 VERDE con VISIÓN REAL** (2026-06-17): `ANTHROPIC_API_KEY` presente → Claude analizó fotos reales de Cloudinary y `commercial.capture_vision` quedó poblada con veredictos (corrieron los asserts condicionales de DB de la sección 13). Pendiente: validación visual de la pantalla.

### H2.4 — entregado (3ª capacidad: fraude / integridad)
- **Migración** `20260617150000` (amplía el CHECK de `supervisor_findings.source` para admitir `'fraud'`). Sin tabla nueva — el fraude reusa la infra de findings.
- **`FraudEngineService`** (`libs/trade/.../fraud-engine.service.ts`): reglas DETERMINISTAS (física + tiempo, cero LLM) sobre `daily_captures` (GPS validado + hora_inicio/fin siempre presentes): `fraud_gps_mismatch` (haversine captura↔tienda > 300 m), `fraud_impossible_speed` (> 130 km/h entre capturas consecutivas del mismo vendedor, con `min_move` anti-jitter), `fraud_fast_visit` (duración < 15 s × exhibición), `fraud_overlap` (intervalos de captura solapados), `fraud_recycled_photo` (misma `fotoUrl` en ≥2 capturas). Agregados por colaborador, `source='fraud'`, idempotentes + auto-resuelven; `capture_id` como evidencia.
- **GUARDARRAÍL ADR-020**: detecta pero NO acusa. Los `fraud_*` **no están en ACTION_FOR** → cero acción de co-piloto automática; van a la bandeja para que el SUPERVISOR confirme/descarte (acusar a un colaborador es acto humano).
- En `POST /supervisor-ai/compute` + `POST /supervisor-ai/fraud/scan` + cron nocturno. Frontend: labels + badge "integridad" (rojo) en la bandeja de hallazgos.
- **Builds api+view verdes + smoke `http-horus-test.js` 61/61 VERDE** (2026-06-17): el motor **detectó fraude en data real** (hallazgos `fraud_*` bien formados, presentes en la bandeja) y el guardarraíl se verificó (0 acciones de co-piloto nacidas de un finding de fraude). Diferido: foto reciclada por **pHash de Cloudinary** (hoy detecta reuso de `fotoUrl` exacta, no re-fotografiado).

### H2.3 — entregado (motor multi-señal: salud de ejecución explicable)
- **Migración** `20260617160000` (`execution_360` += `exec_score` 0-100 + `exec_score_breakdown` JSONB).
- **`ScoringEngineService`** (`libs/trade/.../scoring-engine.service.ts`): score de ejecución por sujeto al estilo Thot. Señales normalizadas a [0,1] con pesos — colaborador: calidad 0.40 · tendencia 0.15 · foto 0.15 · share propio 0.15 · **integridad** 0.15 (cruza `supervisor_findings source='fraud'`); tienda: share 0.45 · calidad 0.30 · frescura 0.25. **Robusto a datos faltantes**: excluye señales nulas y renormaliza; si la confianza (peso presente) < 0.4 → `exec_score` null (no inventa salud sin datos). `exec_score_breakdown` = contribución por señal ordenada peor→mejor ("qué resta") → explicable, cero LLM.
- **Complementa, no reemplaza** las reglas/findings (la salud es holística; los findings son problemas puntuales accionables). Corre **último** en `/compute` + cron (usa findings + fraude ya computados).
- Frontend: columna **Salud** (badge verde/ámbar/rojo) + "↓ señal más débil" + orden peor-primero en la tabla de colaboradores.
- **Builds api+view verdes + smoke VERDE 0 FAIL** (2026-06-17): 5/5 colaboradores con `exec_score` explicable (ej. `angel_vazquez` salud≈50, "más resta = share propio"), breakdown suma ≈ score y orden peor→mejor verificados. Es la base de ML futuro: features + pesos explícitos.

### H2.7 — entregado (venta↔ejecución, con análisis crítico de datos)
- **Audit primero** (`database/scripts/horus-sales-audit.js`, read-only): la venta de campo es **demo-only** — `route_tickets` = 4 ventas de un solo día (2026-06-03), 1 vendedor; `vendor_sale_lines` = 2 tiendas, 1 vendedor, 3 productos. Enlace: 1/5 captores con venta, 2/34 tiendas. **Conclusión: no hay con qué correlacionar de forma defendible** → no se inventa un motor de findings sobre ruido (anti-patrón "diseñar sobre data que no existe").
- **`SalesExecutionService`** (read-only, sin importar Thot): `getCorrelation` cruza `exec_score` con venta (`route_tickets` por `vendor_user_id` + `vendor_sale_lines` por tienda) y clasifica en cuadrantes (ejecuta_y_vende / **ejecuta_sin_venta** = el gap / vende_sin_ejecutar / ambos_bajos). Doble como **diagnóstico de cobertura** ("N/M vendedores y tiendas registran venta") — el insight accionable hoy es impulsar el registro de venta en campo.
- **`sales_execution_gap`** ("ejecuta bien pero 0 venta") **GATEADO** por `MIN_VENDORS_WITH_SALES=4`: dormido hasta que la venta madure (auto-resuelve mientras). Sin migración (reusa tablas + `source='engine'`).
- Endpoint `GET /supervisor-ai/sales-execution`; gap en `/compute` + cron; panel "Venta vs ejecución" (cobertura + cuadrantes). **Smoke 60/60 VERDE** (2026-06-17): `/sales-execution` 200, cobertura refleja la venta demo-only, y el gate deja el gap **dormido** (0 `sales_execution_gap` abiertos) — verificado que NO se inventan hallazgos sobre ruido.

### H2.1 — entregado parcial (Feature Store v2, data-backed)
- **Audit primero** (`database/scripts/horus-features-audit.js`, read-only, 30d): **nivelEjecucion 94% · hora_fin 100% (mediana 8.8 min) · productos 99%** → señales sólidas. **route_id 0% en capturas · daily_assignments sin columna `date` usable · scoring_pesos inaccesible por la conexión** → diferidos (no se diseña sobre data ausente). El audit también reveló una **rúbrica de nivel MIXTA** (conviven alto/medio/bajo/crítico con excelente/estandar/basico).
- **Migración** `20260617170000` (`execution_360` += `exec_level_score` 0-100, `avg_visit_min`, `avg_skus`).
- **`Execution360Service`** explota el JSONB: normaliza la rúbrica mixta a peso 0..1 (alto/excelente=1 · medio/estandar=0.6 · bajo/basico=0.3 · crítico=0.1), duración real de visita (hora_fin−hora_inicio) y surtido (productos/exhibición).
- **`ScoringEngineService`** incorpora `exec_level` al score de salud (rebalance — colaborador: quality .32 / exec_level .18 / trend .13 / photo .12 / own .12 / integrity .13; tienda: own .38 / quality .25 / exec_level .17 / freshness .20). Como renormaliza sobre señales presentes, la salud se vuelve más fina sin reescribir el motor.
- Frontend: columnas **Nivel** + **Min/vis** en la tabla de colaboradores. Smoke sección 17. Pendiente: `migrate:new` (`20260617170000`) + restart → smoke.
- **Diferido H2.1b**: roll-ups por zona (`users.zona_id` 93%) / supervisor (74%) — viables, no prioritarios; position-quality y coverage esperan que `scoring_pesos` / `daily_assignments` sean accesibles.

---

## Backlog priorizado — auditoría de oportunidades (2026-06-17)

Workflow multi-agente (8 lentes + síntesis + crítico adversarial, 43 oportunidades crudas). Orden de ejecución acordado:

**Batch 1 — correctitud + no-perder-historia + seguridad de deploy** 🔨 EN CÓDIGO 2026-06-17:
- **#2 Blindar `approveAction`**: helper `safeQuery` (SAVEPOINT) en los reads best-effort (último-captor + set_target SELECT/UPDATE) → no envenenan la trx del request (clase 25P02). La atomicidad de las 3 escrituras ya la da el rollback del interceptor. *Crítico: el 25P02 solo afecta requests (botones), NO el cron (pooled).*
- **Snapshot t0** (urgente): mig `20260617180000` `commercial.execution_360_snapshots` (append-only, 1 row/sujeto/ventana/día, idempotente) + `Execution360Service.snapshotForTenant` corriendo último en /compute + cron. `execution_360` es UPSERT in-place → sin snapshot, cada día de histórico se pierde irrecuperable.
- **#8 Migración-en-boot**: auditadas las 12 migraciones Horus = idempotentes (hasTable/hasColumn/IF EXISTS) + transaccionales (rollback atómico). Gate post-deploy: `horus-prod-verify.js`.

**Batch 2 — #1 cerrar el loop al campo** 🔨 EN CÓDIGO 2026-06-17 (builds api+vendor verdes): `SupervisorFieldController` (`/supervisor-ai/field/my-tasks` + `/my-coaching` + `tasks/:id/ack` + `coaching/:id/ack`) **solo `RequireAuthGuard`, self-scoped por JWT.sub+tenant** → sin permiso de dominio/backfill/re-login, y sirve a CUALQUIER captor (no solo vendedores → cierra ese caveat). Métodos `myTasks/myCoaching/ackTask/ackCoaching` en `SupervisorActionsService` (acuse = pending→done / open→acknowledged). Frontend: `VendorService` + grupo "De tu supervisor · IA" en `vendor-notifications.component` (apps/vendor) con acuse optimista. **Bug del crítico arreglado**: `reviewFinding(dismissed)` ahora soft-borra los artefactos enlazados (coaching_notes por finding_id, supervisor_tasks por action_id) → no quedan huérfanos vivos en el campo. *Honestidad: coaching siempre enlaza (collaborator_id); tasks solo las que tienen assigned_to_user (limitado por store_id 33% — mejora con Batch 3).* Smoke sección 19 (endpoints + propagación dismiss verificada por DB).

**Batch 3 — palanca de datos + red de costo**: #4 finding `capture_quality` (store_id por colaborador, Horus mejora su insumo) · #5 backfill store_id por GPS (⚠️ hereda riesgo incidente RVDAM01: match en mercados densos) · #6 telemetría de tokens/costo + `@Throttle` en /vision/scan + tope diario.

**Batch 4 — más señal + adaptativo**: #9 planogram declarado-vs-observado (la mejor de visión; share-of-shelf NO, sin ground-truth) · feedback loop H2.8 (auto-tune de umbrales) **solo después** de que el supervisor adopte el hábito de revisar (depende del Batch 2).

**NO vale la pena hoy (muro de datos):** cobertura planeado-vs-hecho (sin `daily_assignments.date`), fraude por traza GPS como regla (2/5 trackean), atribución como *prueba* de eficacia (ruidosa, 5 colaboradores), cadencia predictiva por tienda (store_id 33%), WhatsApp/push (Fase F sin decidir), mapa Leaflet de jornada (cobertura GPS fina).

---

## Track Aprendizaje (Horus.L) — que Horus aprenda Trade (2026-06-17, ADR-021)

Expande el viejo "H2.8 feedback loop" a un subsistema completo. **Principio:** el motor aprende (determinista/estadístico, auditable, overridable); el LLM sigue fuera del lazo. **Idea-espina:** la mayoría del aprendizaje está gateada por **calendario**, no por código → enviar colectores baratos ya (arrancar el reloj), prender cada learner cuando su data madura.

**Las 3 señales ya se recolectan** (verificado en schema): `supervisor_findings.status` (juicio del supervisor), `coaching_notes.acknowledged_at`/`supervisor_tasks.status` (acuse del campo), `execution_360_snapshots` (histórico diario, Batch 1). Faltaba el lazo que las realimente.

| Sprint | Aprende | Data / gate | Estado |
|---|---|---|---|
| **L0** Memoria | Substrato histórico (snapshots append-only) | — | ✅ (Batch 1; arranca al pushear a prod) |
| **L2** Auto-calibración | Precisión de cada regla (confirmed/dismissed) → suprime/capa las ruidosas | `findings.status`; produce al revisar | ✅ **EN CÓDIGO 2026-06-17 — smoke §20 verde (84 OK)** |
| **L1** Baselines | Lo "normal" por sujeto (z-score vs su propia historia) | snapshots ≥7 días | ✅ **EN CÓDIGO 2026-06-17 — smoke §21 verde (91 OK)** |
| **L7** Panel "Lo que aprendió" | Visibilidad + override humano | — | ✅ **EN CÓDIGO 2026-06-17 — build view verde** |
| **L3** Efectividad | ¿la acción movió el resultado? pre/post + **diff-in-diff** | snapshots+acciones ≥3–4 sem | ⬜ gated (siguiente) |
| **L4** Pesos adaptativos | Ajuste de WEIGHTS por tenant (modo sombra hasta ventas reales) | ~8–12 sem + ventas | 🔒 gated |
| **L5/L6** Predictivo/relacional | Pronóstico + patrones entre sujetos | store_id ≫33%, route_id ≫0%, venta real | 🚫 diferido |

### L2 — Auto-calibración de reglas ✅ EN CÓDIGO 2026-06-17 (el primer "aprende" real)
- **Mig `20260617190000`** `commercial.execution_rule_stats` (1 row/(tenant,finding_type,source); precision, reviewed_total, floor_met, auto_suppressed, severity_cap, **manual_override** = pin humano, weight). Patrón Horus (idempotente, RLS forzado, FK identity.tenants, grant app_runtime).
- **`RuleCalibrationService`**: agrega `supervisor_findings.status` → `precision = confirmed/(confirmed+dismissed)`. Con `reviewed_total ≥ 8` (floor): precision `< 0.20` → **suprime**, `0.20–0.40` → **capa severidad a warn**. Recomputa cada corrida (reversible); `manual_override` NO va en el merge (se conserva).
- **Read-back en `FindingsEngine`**: `getCalibration()` → el `add()` salta las suprimidas y capa las medio-ruidosas. Cableado en el cron (antes de `generateForTenant`) y en `/compute`.
- **Endpoints**: `GET /supervisor-ai/learning/rules` (scorecard, con `effective_suppressed`), `POST /supervisor-ai/learning/recompute`, `POST /supervisor-ai/learning/rules/:findingType/override` `{override: enabled|suppressed|null}` (SUPERVISOR_AI_APROBAR).
- **Caveat auto-bloqueo**: regla suprimida deja de emitir → no genera juicios → precisión congelada; salida = override humano (`enabled`). Diseño aceptado (ADR-021).
- Smoke **sección 20** (recompute + scorecard + dismiss→scorecard + override suprime en el motor + recompute conserva pin + cleanup). Build api verde. **Verificado: smoke 84 OK / 0 FAIL.**

### L1 — Baselines por sujeto ✅ EN CÓDIGO 2026-06-17 (smoke §21 verde, 91 OK)
- **Mig `20260617200000`** `commercial.execution_baselines` (long por métrica: avg_score/exec_score/exec_level_score/own_share/photo_coverage; mean/stddev/n_obs/min/max/floor_met; patrón Horus).
- **`BaselineLearnerService`**: 1 agregación SQL (count/avg/stddev_samp/min/max por métrica, ventana 60d) → unpivot a long. `floor_met = n_obs ≥ 7` snapshots. Recomputa cada corrida.
- **Read-back `self_anomaly` en `FindingsEngine`**: z-score sobre avg_score 30d contra la PROPIA historia; emite si `caída ≥ max(2·stddev, 8)` pts (sev por z/magnitud). Capta el 90→75 (invisible al umbral global) e ignora al "siempre bajo". **Pasa por la calibración L2** (las dos capas componen).
- Cableado en cron y `/compute` (antes de findings) + `GET /supervisor-ai/learning/baselines`.
- Smoke **sección 21** verifica el aprendizaje REAL: inyecta histórico sintético (8 días ~85) + estado actual 30 → el z-score dispara `self_anomaly` con evidencia explicable → **cleanup completo**. Gate honesto: en data real activa por sujeto al cruzar 7 snapshots.

### L7 — Panel "Lo que Horus aprendió" ✅ EN CÓDIGO 2026-06-17 (build view verde)
- Sección en `/dashboard/supervisor-ai`: **scorecard de reglas** (precisión, juicios, estado activa/aprendiendo/auto-suprimida/capada/manual) con botón **Silenciar/Reactivar** (override humano, `SUPERVISOR_AI_APROBAR`) + **"lo normal" por colaborador** (score normal ≈ mean ± stddev, solo floor_met; "aprendiendo" si falta historia). Hace visible y auditable el aprendizaje (invariante co-piloto). Sin migración (consume `/learning/rules` + `/learning/baselines`).

### Próximo (Aprendizaje): L3 (efectividad, diff-in-diff) cuando acumulen ~3–4 sem de snapshots. L4/L5/L6 gated por calendario/datos.

---

## Track Horus 360 — conocimiento total de Trade (2026-06-18)

Objetivo: que Horus explote TODA la señal usable de cada módulo de Trade. **Dos techos:** (1) **extracción** — lo que el código saca de los datos que existen (~código, de ~55-60% a ~85-90%); (2) **datos** — lo que los datos contienen (Eje B: generación + adopción). Regla dura: **no construir extractor sobre campo en ~0%**. Cada regla nueva entra a la **calibración L2** → expansión segura.

### Paso 0 — audit de población (`horus-jsonb-audit.js`, read-only, 2026-06-18)
117 exhibiciones/30d. **conceptoId 93.2%** (5 tipos), **ubicacionId 93.2%** (6), productosMarcados 99.1%, puntuacionCalculada 92.3%, rangoCompra 66.7%, nivelEjecucionId 78.6%. **`ventaAdicional` > 0 = 0.0% (suma $0)** → el wizard tiene el campo pero NADIE lo llena. Planograma: 852 SKUs, **0 categorías** pobladas.

### Decisiones del audit
- **K1 (concepto+ubicación) = GO** (93% poblado).
- **K2 (venta-por-exhibidor) = MUERTO**: `ventaAdicional` siempre $0 → NO se codea extractor (sería inventar señal); se mueve al **Eje B** (que el dato se capture). *El audit evitó trabajo inútil — exactamente la regla "no diseñar sobre datos que no existen".*
- **K4 reshape**: sin categorías → adherencia por SKU (`productosMarcados` ∩ planograma 852, ambos UUID de producto).

### K1 — Desglose por concepto + ubicación ✅ EN CÓDIGO 2026-06-18 (builds api+view verdes)
- **Mig `20260618100000`** `execution_360 += by_concept/by_location` (JSONB, ventana 30d, `{catalogId: {label, n, level_avg, own_share_pct, photo_pct}}`).
- **`Execution360Service`**: acumula por `conceptoId`/`ubicacionId` por exhibición (30d), resuelve nombres vía `catalogs.value` (lookup con **SAVEPOINT** — `catalogs` puede no resolver en prod y corre primero en /compute → anti-25P02).
- **Regla `weak_concept` en FindingsEngine**: el peor concepto del sujeto con `n≥3` y `level_avg ≤ overall−25` → coaching concreto ("flojeás la cabecera"). Pasa por calibración L2.
- FE: labels + evidencia (`weak_concept`, `self_anomaly`) + tipos `by_concept`/`by_location`.
- Smoke **sección 22**: desglose real poblado + prueba sintética de `weak_concept` (concepto a 20 vs nivel 70 → dispara) + cleanup. **Pendiente: migrate:new (`20260618100000`) + restart → smoke 1-22.**

### K4 — Planograma declarado-vs-observado ✅ EN CÓDIGO 2026-06-18 (builds api+view verdes)
- **Paso 0 audit**: `orden_exhibicion` 100% poblado, `productosMarcados`↔`planogram_skus.product_id` mapean (304/631 marcados ∈ planograma), pero solo 304/852 SKUs se exhiben alguna vez y el grano (tienda) está capado a store_id 33% → **target absoluto NO aplica** (planograma tenant-wide).
- **Mig `20260618110000`** `execution_360 += planogram_present/planogram_total` (30d). present = SKUs del planograma exhibidos (`productosMarcados ∩ trade.planogram_skus`); total = planograma activo (852). Es CONOCIMIENTO para ambos sujetos.
- `Execution360Service` carga el set del planograma (safeQuery, schema `trade` explícito, anti-25P02) + acumula SKUs marcados distintos por sujeto (30d).
- **Regla `planogram_gap` PEER-RELATIVA** (tienda 30d): exhibe < 50% de la **mediana de sus pares** (guard mediana≥4, visits≥3) → conservador, alta precisión. Pasa por calibración L2. **CAVEAT (logueado): solo tiendas con store_id ~33%; dormido si todas las tiendas están parejas-bajo** (honesto, como sales_execution_gap) — su valor pleno llega con D1.
- FE: label + evidencia `planogram_gap`. Smoke **sección 23** (feature real + prueba del disparo inyectando pares altos que dominan la mediana + tienda baja + cleanup). **Pendiente: migrate:new (`20260618110000`) + restart → smoke 1-23.**

### K6 — Roll-ups por zona + supervisor ✅ EN CÓDIGO 2026-06-18 (builds api+view verdes)
- Audit: `users.zona_id` 89% + `users.supervisor_id` 71% + `zones.name` → diagnóstico a nivel ORG (qué zona/equipo ejecuta peor), no solo el individuo.
- **Mig `20260618120000`** amplía el CHECK `execution_360.subject_type` a `zone`/`supervisor` (findings/snapshots/baselines no tienen CHECK → sin cambio). DTO del filtro ampliado.
- `Execution360Service` carga `users`(zona/supervisor/nombre)+`zones`(name) y, por cada captura, **sube la misma señal a la zona y al supervisor del colaborador** (reusa SubjectAgg/fan/buildRow). Org NO lleva by_concept/planograma (detalle por-sujeto) vía flag `withDetail=false`.
- **Reglas `low_score`/`score_drop` ampliadas** a `zone`/`supervisor` ("la zona Norte cayó" / "el equipo del supervisor X está bajo"). Mismo umbral; el label denormalizado distingue. Pasa por calibración L2.
- FE: tag `zona`/`equipo` en la bandeja de hallazgos. Smoke **sección 24** (roll-ups org reales + prueba de low_score sobre una zona sintética + cleanup). **Pendiente: migrate:new (`20260618120000`) + restart → smoke 1-24.**

### K3 — Catálogo + pesos oficiales (calidad de posición) ✅ EN CÓDIGO 2026-06-18 (builds verdes)
- Audit `catalogs.puntuacion`: **niveles** Alto 1.0/Medio 0.70/Bajo 0.40/Crítico 0.20 (mi heurística estaba desviada), **ubicaciones** Caja 100…Detrás 10, **conceptos** 0.5-2.0. Es la rúbrica OFICIAL del negocio.
- **Mig `20260618130000`** `execution_360 += position_quality` (0-100). `Execution360Service` carga `catalogs.puntuacion` de ubicaciones (junto con los nombres K1) y promedia el peso oficial de la ubicación por exhibición → **desbloquea la "position-quality" que H2.1 había diferido** ("scoring_pesos inaccesible" → los pesos viven en catalogs).
- **Regla `weak_position`** (colaborador/tienda 30d, position_quality < 35, visits≥3): exhibe en posiciones débiles (anaquel/detrás) según la rúbrica oficial. Umbral absoluto (posiciones objetivamente rankeadas). Pasa por calibración L2.
- FE: label + evidencia `weak_position`. Smoke **sección 25** (feature real + prueba del disparo + cleanup). **Diferido K3.2**: usar los niveles oficiales (catalog) en vez del heurístico LEVEL_WEIGHT (refina exec_level, ripple amplio → tras verificar). **Pendiente: migrate:new (`20260618130000`) + restart → smoke 1-25.**

### K5 — Tiempo muerto (idle) ✅ EN CÓDIGO 2026-06-18 (builds verdes, SIN migración)
- `idle_min_avg` ya existía como columna null (slot de H2.1) → **K5 solo la POBLA** (sin migración). `Execution360Service.computeIdleByUser` (static, inline) = misma definición que `ReportsService.computeIdleSegments`: gap = hora_inicio[i+1]−hora_fin[i] entre capturas del mismo colaborador y día; gaps<5min ruido; conservador (sin coords → idle=gap, no descuenta traslado). Se agrega `dc.id`+`day` (MX) a la query de capturas; post-pass asigna `idle_min_avg` a las filas colaborador-30d; `idle_min_avg` añadido al merge UPSERT.
- **Regla `idle_anomaly`** (colaborador 30d, idle_min_avg > 90min, visits≥3): gap promedio entre visitas muy alto. Umbral generoso (idle conservador). Pasa por calibración L2.
- FE: label + evidencia `idle_anomaly`. Smoke **sección 26** (idle computado sin crashear + prueba del disparo con idle sintético + cleanup). **Honesto**: idle solo se mide en colaboradores con multi-captura/día (puede ser null si la data es esparsa). **Pendiente: restart (sin migración nueva) + smoke 1-26.**

### Pendientes Horus 360
- **K7** check-in×captura · **K3.2** niveles oficiales (refina exec_level) · **K5b** traza GPS (route_location_pings, ~2/5 trackean).
- **Eje B (datos)**: D1 store_id en captura (33%→alto) · D2 daily_assignments.date · **D3 ventaAdicional** (rescata K2) · D4 route_id.

---

## Sprint Horus.ACT — acciones de campo accionables (2026-07-21)

Extiende el repertorio del co-piloto con 4 capacidades pedidas por Edgar: (1) detectar que **no se visitó a un cliente** planeado, (2) **reordenar rutas**, (3) **agregar tiendas de oportunidad** desde INEGI/DENUE, (4) **mandar incidencias/mensajes** al campo/web. Las 4 caben sobre los rieles existentes (findings → acciones `pending_approval` → aprobar → ejecutor → nudge → aprendizaje). Se arrancó por **ACT.1 + ACT.4** (valor inmediato, bajo riesgo).

**Decisiones (Edgar, 2026-07-21):**
- Incidencia de visita faltante = **híbrido**: nudge automático al vendedor (app) + aprobación del supervisor para la versión formal (web).
- Reorden de ruta = **nearest-neighbor Haversine** (MVP sin token Mapbox).
- Alta de oportunidad = **crear cliente pedible + convertir prospecto**.

### ACT.1 — Finding `missed_visit` ✅ EN CÓDIGO (builds api+view verdes, smoke DB 5/5)
- `MissedVisitEngineService` (`libs/trade/.../supervisor-ai/missed-visit-engine.service.ts`): por cada vendedor con ruta asignada HOY (ISODOW MX), cruza la **cartera planeada del día** (fragmento inline de `vendor-cartera.sql` — `daily_assignments` × `customers.sales_route`/`visit_days`) contra `commercial.vendor_visits` de hoy. El delta = clientes no visitados → finding `missed_visit` por colaborador, `source='plan'`, severidad por fracción faltante, `evidence={planned,visited,missed,missed_customers[],date}`.
- **Cron propio** `@Cron('0 0 3 * * *')` = **21:00 MX** (fin de jornada), NO el refresh de 02:30 (a esa hora "hoy" ya cambió → falso positivo masivo). Guard `hora<18 → skip` salvo `?force=true` para el endpoint manual `POST /supervisor-ai/missed-visits/scan`.
- Vive 1 día: resuelve los `missed_visit` de días previos (dedup lleva la fecha MX). `source='plan'` propio para que el resolve del motor de findings (`source='engine'`) no lo pise.
- Mig `20260721120000` amplía el CHECK `supervisor_findings.source += 'plan'`.

### ACT.4 — Entrega de incidencia (canal híbrido) ✅ EN CÓDIGO
- **Vendedor (automático)**: al emitir el finding, el motor crea `commercial.coaching_notes(category='incident')` (durable, visible en `/supervisor-ai/field/my-coaching`) + `EventsService.emitFieldNudge(kind:'incident')` (`horus:nudge` en vivo). Idempotente por `finding_id`. `category='incident'` entra **sin migración** (la columna no tiene CHECK).
- **Supervisor (aprobación)**: el co-piloto propone `notify_missed_visit` (`ACTION_FOR['missed_visit']`, dedup con fecha → una acción por jornada). Aprobar ejecuta `EventsService.emitSupervisorIncident` (`horus:incident` a la room global del tenant) + confirma el finding (flujo genérico). Mig `20260721120000` amplía el CHECK `supervisor_actions.action_type += 'notify_missed_visit'`.
- Si el supervisor **descarta** el finding, el cascade de `reviewFinding` soft-borra la incidencia del vendedor (propaga la decisión humana al campo).
- FE: `FINDING_LABELS['missed_visit']`, `evidenceText`, `actionLabel`/`actionPi` para `notify_missed_visit`.

**Pendiente prod:** `migrate:new` (`20260721120000`) en Railway + reinicio API (activa el cron 21:00) + registrar el smoke en `run-all-tests`.

### ACT.2 — Reorden real de ruta ✅ EN CÓDIGO (builds verdes, smoke 8/8)
- `OpportunityEngineService` enriquece la oportunidad `reprioritize_route`: calcula el orden **nearest-neighbor Haversine** (`nnOrder`) sobre los clientes de la ruta (`commercial.customers.sales_route` = `catalogs.value`) con coords, y adjunta `payload.proposed_order`/`current_order`/`sales_route`. Sin ≥3 clientes geolocalizados no adjunta orden (degrada).
- Ejecutor (`executeAction`): al aprobar `reprioritize_route` con `proposed_order`, escribe `commercial.customers.visit_sequence` (1..N) en ese orden; **reversible** — guarda `previous_order` en `result`. Sin `proposed_order` cae a la tarea de repriorización (comportamiento previo). La rama va ANTES del bloque `TASK_TYPE`.
- Sin migración (reusa `visit_sequence` + `reprioritize_route` ya en el CHECK).

### ACT.3 — Alta de tienda de oportunidad (INEGI/DENUE) ✅ EN CÓDIGO (builds verdes, smoke 8/8)
- `OpportunityEngineService` genera `add_opportunity_store` (kind='opportunity', subject_type='prospect') desde `commercial.prospect_stores` (status='candidate', `whitespace_score≥60`, top 3), con `suggested_sales_route` = ruta del cliente propio geolocalizado más cercano. Degrada con gracia si DENUE no está (safeQuery).
- Ejecutor: al aprobar crea `commercial.customers` (code `P-…`, price list default, geo, `sales_route` sugerida = **pedible**) + marca el prospecto `status='converted'` (`matched_customer_id`). NO reversible (alta comercial real). Gateado por `SUPERVISOR_AI_APROBAR`.
- Mig `20260721130000` amplía el CHECK `supervisor_actions.action_type += 'add_opportunity_store'`.
- FE: `actionLabel`/`actionPi` para `add_opportunity_store`.

**Smoke `smoke-horus-missed-visit.js` (registrado en `run-all-tests`, grupo needsApi:false) 8/8:** CHECKs (`source=plan`, `notify_missed_visit`, `add_opportunity_store`, `category=incident`), query de cartera planeada, reorden `visit_sequence` round-trip (ruta real), alta cliente + markConverted. **Pendiente prod: migrate:new (`20260721120000`+`20260721130000`) + restart.**

### Mapa "Rutas reconvertidas" (visual ACT.2+ACT.3) ✅ EN CÓDIGO (builds verdes)
- Backend read-only en `OpportunityEngineService`: `listRouteOptimizations` (rutas con km actual vs óptimo + mejora% + `has_action`) y `routeOptimizationDetail(salesRoute)` (orden actual por `visit_sequence`, orden propuesto NN, tiendas de oportunidad candidate a ≤3 km de la ruta, métricas km). Endpoint `GET /supervisor-ai/route-optimization[?sales_route=]`.
- Frontend `route-optimization.component.ts` (`/dashboard/supervisor-ai/route-optimization`, gate `SUPERVISOR_AI_VER`): reusa el `MapComponent` compartido (Leaflet). **Línea gris = cómo se recorre hoy**, **línea verde numerada = cómo debería** (orden NN), **pines ámbar = tiendas de oportunidad**. Selector de ruta, KPIs (km hoy/óptimo/mejora%/paradas·oportunidades), leyenda con toggles de capa, lista "orden propuesto" con badge "antes #N". Botón "Rutas reconvertidas" en el header de la pantalla principal de Horus.
- **Pendiente: verificación en vivo del endpoint con API arriba** (build no lo prueba) + validación visual.
