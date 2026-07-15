# Fase Horus-IQ — Subir la inteligencia del Supervisor AI

> **Estado:** 🧪 HIQ.0 + HIQ.1 + HIQ.2 + HIQ.3a + HIQ.4 **VERIFICADOS EN RUNTIME 2026-07-15** (API viva). HIQ.3b (cross-foto, pHash) / HIQ.5 (push real) / HIQ.6 (partir frontend) pendientes.
>
> **Verificación runtime 2026-07-15:** smoke `http-horus-test.js` **140 OK / 3 FAIL** (los 3 son deuda previa de Horus 360, no de esta fase: `exec_level_score`/`by_concept`/`position_quality` sin poblar porque las capturas recientes son del flujo vendor con `skip_scoring` — drift de datos, no bug). `POST /compute` → 82 filas feature store + **baselines L1 DESPIERTOS: 178 computados, 142 con floor** (own_share 46/46, exec_level 40/40, foto 46/46) gracias al backfill HIQ.2. Umbrales adaptativos → `insufficient_sample` correcto (5 colaboradores < 8, defaults intactos). Briefing → `source: agent` narrando la comparación ("un hallazgo resuelto cierra el ciclo"); `team_score_delta` null HONESTO (capturas recientes sin score — aparece solo cuando vuelvan capturas puntuadas). **Chat en vivo OK**: pregunta abierta → 3 tools encadenadas en 2 iteraciones (`execution_360 → findings → diagnoses`), respuesta grounded que detectó 4/5 colaboradores inactivos y cuestionó el share 100% como dato a validar; 👍 registrado en `horus_chat_log`; tool de memoria `horus_briefing_history` citó el parte del día. **Solo falta validación visual de las 2 pantallas.**
>
> **HIQ.4 ✅ en código** — priorización por valor + anti-fatiga: `priorityOf = severidad × confianza × impacto × factor-valor(1.0–1.5)`. Valor de tienda = Σ `customer_360.monetary_90d` de sus clientes; colaborador = Σ del valor de las tiendas que capturó en 30d (safeQuery best-effort — **con la data local actual el factor queda neutro 1.0**; se activa solo cuando la venta por cliente madure, y despega con Fase VR que traerá venta real por tiendita). `value_90d` en el payload para explicabilidad. **Anti-fatiga**: no se re-propone acción familia coaching (`coaching`/`coaching_focus`) a un colaborador con `coaching_note` de hace <7 días; contador `fatigued` en el propose. Nota: OpportunityEngine no pasa por el filtro anti-fatiga (mejoras positivas) — evaluar si molesta en la práctica.
>
> **HIQ.1 ✅ en código** — Briefing 2.0 con memoria: `buildComparison()` determinista (nuevos/resueltos 24h, persistentes con días abiertos, delta del score del equipo vs hace 7d desde snapshots, titular del parte anterior, outcomes medidos de la semana) → el LLM narra "qué cambió / qué sigue igual / qué funcionó" (fallback determinista con las mismas frases). Cada parte se persiste en `commercial.briefing_history` (mig `20260715140000`, UPSERT por día) — memoria narrativa + tool `horus_briefing_history` (13ª tool del chat: "¿qué me dijiste ayer?"). Tablero: chips comparativos (+N nuevos / N resueltos / ▲▼ pts vs semana).
>
> **HIQ.3a ✅ en código** — presupuesto de visión por env: `HORUS_VISION_MAX_PER_RUN` (on-demand, default 12), `HORUS_VISION_NIGHT_BUDGET` (cron, default 20), `HORUS_VISION_CONCURRENCY` (default 4). Para cerrar el backlog: setear budget alto unos días y volver al default.
>
> **HIQ.0 ✅ en código** — "Pregúntale a Horus": réplica por dominio del loop ReAct de Thot (`libs/trade/.../horus-chat/`: `horus-semantic.ts` + `horus-tools.service.ts` con 12 tools read-only sobre los servicios existentes + `horus-chat.service.ts`), endpoints `POST /supervisor-ai/chat` + `/chat/feedback`, bitácora `commercial.horus_chat_log` (mig `20260715120000`, RLS, feedback 👍/👎), página `/dashboard/supervisor-ai/chat` (réplica UX del chat de Thot con votos) + botón ember en el tablero. Modelos: Haiku default + Sonnet think (`HORUS_CHAT_MODEL`/`HORUS_CHAT_THINK_MODEL`, fallback a los de Thot). Curaduría dinámica de few-shot (promover 👍) DIFERIDA — few-shot estático inicial.
>
> **HIQ.2 ✅ en código + backfill EJECUTADO local** — `database/scripts/horus-backfill-snapshots.js` reconstruyó 1,040 snapshots retroactivos (45 días, idempotente, no pisa los del cron): **82/82 sujetos cruzan el piso de 7 obs → L1 despierta en el próximo compute**. `AdaptiveThresholdsService` (mig `20260715130000`: `auto_tuned_at`+`manual_lock`): umbrales desde percentiles del tenant (p10 score / 1σ trend / p90 dominancia / p90 días) con gate ≥8 sujetos + clamps; wireado en cron + `/compute`. Verificado contra DB local: con muestra insuficiente mantiene defaults (no-op correcto).
>
> **Pendiente operacional:** reiniciar API → `POST /supervisor-ai/compute` (repuebla feature store + baselines con la historia backfilleada) → probar `/chat` en vivo (requiere `ANTHROPIC_API_KEY`) + validación visual de la página + aplicar migs `20260715120000/130000` y correr el backfill en prod.
> **Contexto:** Edgar percibe `/dashboard/supervisor-ai` como "un modelo poco inteligente". La auditoría 2026-07-15 confirma el porqué y este plan lo ataca portando los patrones que hacen inteligente a **Thot** (ADR-016/018/026) al dominio Trade.
> **No es un rewrite:** Horus cumple correctamente ADR-020 (motor decide / agente comunica / co-piloto). Lo que falta es la capa de inteligencia percibida y despertar el aprendizaje.

---

## 1. Diagnóstico: por qué Horus se siente tonto

### 1.1 Dónde está la inteligencia hoy (auditoría del código)

**El "modelo" no es un modelo.** Toda la decisión son reglas `if/else` con umbrales globales hardcodeados (`findings-engine.service.ts:63-73`: `score_min=25`, `drop=8`, `dominance=70%`, `days=14`; `fraud-engine.service.ts:25-33`: 300m/130km/h/15s; pesos de salud constantes en `scoring-engine.service.ts:27-30`). El LLM (Haiku) aparece en solo 3 lugares, **ninguno decisorio**, todos single-shot sin memoria: redactar el parte diario, redactar el "¿por qué?" de una acción, y etiquetar fotos.

### 1.2 Las 5 causas de la "poca inteligencia" percibida

1. **Sin conversación.** No existe "Pregúntale a Horus". El supervisor solo puede mirar la página; no puede preguntar "¿por qué bajó Ángel?", "¿quién no ha visitado La Piedad este mes?". Thot SÍ lo tiene (loop ReAct + 20 tools).
2. **Narrativa plana y sin memoria.** El briefing es una reescritura en prosa de bullets que el motor ya ordenó — no compara contra ayer, no cuenta la historia causal, no da seguimiento ("esto que te avisé el lunes sigue igual"). Los snapshots L0 existen pero nadie los usa para narrar.
3. **El aprendizaje está dormido.** L1 (baselines) exige 7 snapshots que aún no existen en prod; L2 (calibración) exige 8 juicios humanos por regla que nadie ha dado; L4 (pesos adaptativos) no existe. El sistema "que aprende" hoy no aprende nada — todo cae a defaults.
4. **Techo de datos.** `store_id` 33%, `route_id` 0%, 5 colaboradores, venta de campo demo-only → media docena de reglas viven gateadas/dormidas y Horus "no tiene nada que decir".
5. **Visión a cuentagotas.** 12 fotos por scan / 20 por noche; con ~400 fotos tarda semanas en cubrir y no razona entre fotos (evolución del anaquel de una tienda).

### 1.3 Qué hace inteligente a Thot (lo portable)

| Patrón Thot | Dónde vive | ¿Horus lo tiene? |
|---|---|---|
| **Loop ReAct tool-use** (multi-iteración, self-correction, MAX 6-12 iter) | `thot-chat.service.ts:105-203` | ❌ |
| **Capa semántica curada** (glosario + reglas duras "cero números del LLM" + formato) | `thot-semantic.ts` | ❌ |
| **Tool providers scoped por audiencia** (admin/portal/vendor, scope server-side del JWT) | `thot-tool-provider.ts` | ❌ |
| **Few-shot dorado con feedback 👍/👎** (promover respuestas buenas, retrieval pgvector) | `thot-examples.service.ts` | ❌ |
| **Modo Think** (Sonnet + extended thinking para preguntas duras) | `thot-chat.service.ts:205-219` | ❌ |
| Motor determinista explicable con `reason_label` | `thot.service.ts:177-186` | ✅ (breakdown de salud) |
| Calibración L2 + baselines L1 | `commercial-calibration.service.ts` | ✅ pero dormido |
| **Autonomía acotada con dial** (5 gates deterministas, ADR-023) | `autonomy.service.ts` | ❌ (todo pending_approval) |
| Conversión atribuida por reason (feedback que mide) | `feedback.service.ts:195-253` | Parcial (L3 colecta, no ajusta) |

---

## 2. Plan de sprints (orden = impacto percibido por esfuerzo)

### HIQ.0 — "Pregúntale a Horus" (el salto de inteligencia percibida)
Réplica del patrón ADR-026 sobre Trade (igual que Maat replicó a Thot — es la 3ª réplica, el patrón está probado):
- **Generalizar** el loop ReAct: extraer/duplicar `thot-chat.service.ts` con un `HorusToolProvider` (el loop ya es agnóstico — solo cambian provider + prompt + scope).
- **Tools** (~12, todas read-only sobre servicios existentes): `horus_execution_360` (por colaborador/tienda/zona), `horus_findings` (con filtros), `horus_colaborador_timeline` (capturas + score diario), `horus_tienda_detalle` (exhibiciones + share + última visita), `horus_fraud_evidence` (capture_id → detalle), `horus_vision_verdicts`, `horus_coaching_history`, `horus_compare` (colaborador vs equipo / tienda vs zona), `horus_resolve_entity` (ILIKE colaborador/tienda), `horus_flexible_aggregate` (whitelist métricas execution_360), `horus_baselines`, `horus_briefing_history`.
- Capa semántica propia (`horus-semantic.ts`): glosario Trade (score, nivel, exhibición, share, integridad), reglas duras heredadas (cero números del LLM, citar fuente), few-shot inicial curado a mano.
- Endpoint `POST /supervisor-ai/chat` gate `SUPERVISOR_AI_VER`; UI = panel chat en `/dashboard/supervisor-ai` (réplica del componente de Thot chat). Feedback 👍/👎 + cola de curaduría (reusar `thot_chat_log` patrón).
- Haiku default + modo Think (Sonnet) para "investiga a fondo a X".

### HIQ.1 — Briefing 2.0: memoria y narrativa causal
- El motor arma un **paquete comparativo determinista**: hoy vs ayer vs semana pasada (los snapshots L0 ya existen; solo falta leerlos), findings nuevos/persistentes/resueltos, acciones aprobadas y su outcome (L3 ya mide diff-in-diff).
- El LLM redacta con esa estructura: "qué cambió", "qué sigue igual desde hace N días" (seguimiento), "qué funcionó" (outcome de coaching aprobado). Fallback determinista se mantiene.
- Guardar cada briefing emitido (`briefing_history`) → tool del chat + continuidad narrativa día a día.

### HIQ.2 — Despertar el aprendizaje YA (backfill, no esperar calendario)
El desbloqueo más barato del plan:
- **Backfill de snapshots retroactivos** desde `daily_captures` histórico (hay 60+ días de capturas): generar `execution_360_snapshots` día por día hacia atrás → L1 (baselines/z-score) y L3 (diff-in-diff) despiertan HOY en vez de en 4 semanas.
- **Umbrales contextuales**: reemplazar constantes globales por percentiles del propio tenant (`low_score` = p10 con floor, `dominance` = p90) recomputados en el cron; `execution_thresholds` ya existe como override — poblarla desde la distribución real con floor/ceiling defendibles.
- L2: sembrar precisión inicial desde los confirm/dismiss YA registrados en `supervisor_findings` (hay historia de reviews que la calibración no está leyendo por el floor de 8 — evaluar bajar `MIN_REVIEWED` a 5 con confianza degradada).

### HIQ.3 — Visión 2.0
- Subir throughput con presupuesto explícito (env `HORUS_VISION_DAILY_BUDGET`, default 100 fotos/noche) hasta cerrar el backlog; luego incremental puro.
- **Razonamiento cross-foto**: nueva pasada que compara la serie de fotos de una MISMA tienda en el tiempo (evolución del anaquel: mejoró/empeoró tras un coaching) — input directo a L3.
- `fraud_recycled_photo` con pHash perceptual (hoy solo URL exacta).

### HIQ.4 — Priorización por valor + cadencia
- `priority` deja de ser `severidad × confianza × 1.3`: incorporar proxy de valor (venta de la tienda/zona desde `analytics.sales_daily` — data real que YA existe, no la venta de campo demo) → "atiende primero lo que cuesta dinero".
- **Cadencia anti-fatiga**: no reproponer coaching al mismo colaborador si tiene uno abierto <7 días; agrupar hallazgos del mismo sujeto en una sola acción (el diagnóstico ya bundlea — extender).

### HIQ.5 — Cerrar el loop al campo
- Push notification real al vendedor cuando se aprueba coaching/tarea (infra push del shell vendor ya existe; hoy `external_delivery='deferred'`).
- El ack/outcome del vendedor alimenta L3 (efectividad medible del coaching).

### HIQ.6 — Frontend: de tablero a copiloto
- Partir el monolito de 1181 líneas; estados de error visibles (hoy 16 fetches con `catchError` silencioso — una sección caída parece "sin datos").
- El chat HIQ.0 como elemento central; el resto de secciones se vuelven drill-down desde la conversación y el briefing.
- Leer `DESIGN.md` + tokens antes; dark mode verificado.

### Track paralelo (no código, gate de todo lo demás) — Calidad de datos
- `store_id` 33% → hook de asignación de tienda en captura (sin esto, fraude GPS y reglas por tienda siguen ciegos).
- Confirmar `ANTHROPIC_API_KEY` en Railway (sin ella Horus corre en modo "motor" puro — parte de la percepción actual).

---

## 3. Qué NO haremos (y por qué)

- **Fine-tuning / ML supervisado**: mismo criterio que ADR-028 (Maat) — no hay volumen ni labels; el patrón conocimiento curado + tools + calibración determinista rinde más.
- **LLM en la decisión**: ADR-020 se mantiene — el LLM narra/conversa/mira fotos; findings, prioridad y acciones siguen deterministas y auditables.
- **L4 pesos adaptativos**: sigue gateado por calendario/volumen (ship-collector-before-learner, ADR-021). El backfill HIQ.2 acelera el reloj, no lo salta.
- **Autonomía acotada (dial ADR-023)**: diferida a que L2/L3 tengan datos reales — el dial sin precisión medida es ruleta.

## 4. Decisiones abiertas para Edgar

1. ¿HIQ.0 chat comparte código con Thot (extraer loop a lib común, riesgo de acople) o **réplica por dominio** (patrón oficial del repo, recomendado)?
2. Presupuesto de visión (fotos/noche × costo Haiku) para HIQ.3.
3. Bajar `MIN_REVIEWED` de L2 a 5 con confianza degradada — trade-off ruido vs velocidad de aprendizaje.
4. Prioridad del track de datos (`store_id`) vs sprints de código — recomendado: en paralelo desde HIQ.0.
