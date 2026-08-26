# Tracker de Progreso

> Kanban con estado granular por item: **código → probado → staging → prod**. Cada ítem tiene código `[Fase.Sprint.N]`. **Mantener actualizado SIEMPRE** — es la fuente de verdad de qué está hecho, qué está probado y qué falta.

**Última actualización:** 2026-08-22 (Fase AX — anexo de venta imprimible, MVP en código)

---

## 📊 Estado global de fases

| Fase | Estado | Sprint actual | % completado |
|---|---|---|---|
| A — Fundaciones | 🟡 En progreso | A.-1 ✅ → próximo: **A.0-multitenant** | 8% |
| B — Core Comercial | 🟢 **CERRADA formalmente (beta)** | B.0+B.1+B.2+B.3 ✅ — cierre verificado 2026-06-02 con regression 19/19 verde tras ADR-013 (`pending_approval` state) + fix ability.factory (28 mappings COMMERCIAL/LOGISTICS) | 100% (PaymentsService deferred post-beta) |
| C — Sales Intelligence | 🟢 **CERRADA formalmente (beta)** | C.0+C.1+C.3 MVP+C.4+C.5 ✅ — cierre verificado 2026-06-02 | 100% (C.0bis exhibition normalization + C.3.8-9 mapa/drill-down deferred) |
| D — Catálogo + B2B Portal | 🟢 **CERRADA formalmente (beta)** | D.0+D.1+D.2+D.3+D.4+D.5 ✅ — cierre verificado 2026-06-02 | 100% (D.2.3 offline sync queue + D.3.1 app separada deferred post-beta) |
| **E — Remote Manager (televenta)** | 🟢 **CERRADA formalmente (beta)** | E.0+E.1+E.2 ✅ — cierre verificado 2026-06-02 con regression 19/19. Schema (lead_reservations + call_logs + rol tele_operator) + backend 7 endpoints + cron @5min + frontend `/televenta/*`. Validación visual pendiente (E.3.2). | 100% beta-ready |
| **F — Comercio Conversacional (WhatsApp)** | 🧪 **F.0–F.3 EN CÓDIGO 2026-07-24 (builds api+view verdes, 4 commits) — camino comercial CERRADO** | Cliente pide por WhatsApp con chat conversacional → **bot arma / humano confirma** → cae en la cadena de Reparto YA construida. **F.0** `libs/whatsapp` (puerto + simulador + Meta Cloud adapter HMAC + cola BullMQ degradable + estado `whatsapp.conversation_threads`/`messages` RLS + permisos `WHATSAPP_BOT_*`). **F.1** webhook `@Public()` (verify + HMAC + dedup) + ingesta a cola con scope CLS sintético + `/sim`. **F.2** `ConversationOrchestratorService` (Claude Haiku tool-use, 7 tools; precio del motor NO del LLM, ADR-016; degrada a handoff sin API key) vía `COMMERCE_CONVERSATION_PORT` (frontera limpia). **F.3** bandeja `/reparto/pedidos-whatsapp` (confirmar → `createIntake` → `/reparto/asignar` → COD → liquidación; avisa al cliente por WA). Smoke `http-whatsapp-webhook-test.js` en runner. **F.4 (handoff explícito + panel de conversaciones) DIFERIDO — nice-to-have; el camino comercial está cerrado.** **Pendiente operacional (Edgar): `migrate:new` + smoke + validación en vivo/visual con `ANTHROPIC_API_KEY`; para prod real: app Meta + número + `WHATSAPP_*` env + `REDIS_URL`.** Plan en [`FASE_F`](FASES/FASE_F_WHATSAPP_BOT.md). | ~80% (F.0–F.3 en código; F.4 diferido; falta migrate+validación) |
| G — Growth | ⏸️ Bloqueada por D | — | 0% |
| H — Fintech | ⏸️ Bloqueada por D | — | 0% |
| I — ML + WS scaling | ⏸️ Bloqueada por H | — | 0% |
| **J — Logística** | 🟢 **CERRADA (beta scope) + J.10 ✅ 2026-06-02** | J.0+J.1+J.2+J.4+J.5+J.6+J.6.6/J.6.7+J.7+J.8+J.9.1-4+**J.10** ✅ — J.3 driver mobile + J.9.5-11 UI items deferred | 100% beta-ready. **J.10**: endpoint `GET /commercial/orders/:id/shipments` (reusa `COMMERCIAL_ORDERS_VER`, customer_b2b ve tracking de SUS orders), sección "Rastreo" en portal-order-detail con cards por shipment, smoke E2E nuevo en runner (20/20 verde). Cancel shipment NO revierte stock (documentado en código). |
| **K — AI product match (captures)** | 🟢 **CERRADA (beta)** | K.0+K.1+K.2+K.3 ✅ — smoke 29/29 + 2 migraciones compatibility shim (activo virtual + zones.is_system + daily_captures.captured_by_username) | 100% beta-ready |
| **K-debt — Refactor legacy services** | 🟢 **CERRADA 2026-05-27** | Refactor de `catalogs.service.ts` + `daily-assignments.service.ts` + `stores.service.ts`: writes a columna GENERATED `activo` reemplazados por `deleted_at` (NOW/null). Soft-delete + reactivate ahora idiomáticos. Shims `activo` (GENERATED) + `captured_by_username` + `zones.is_system` reclasificados como **columnas canónicas**, no debt (helper de lectura + snapshot denormalizado + flag system-zone). Build OK + regression 19/19 verde. | 100% |
| **WMS-REC — Estación de recepción (lote por renglón)** | 🧪 **[WMS-REC.4] EN CÓDIGO + SMOKE HTTP 37/37 · 2026-08-25** | ADR-044 (escrito ahora: existía el hueco entre 043 y 045). Cose Pieza 1 (Vale vivo) con Pieza 2 (auditor de caducidad), que vivían como pantallas separadas. **Un SKU se desglosa en N lotes**, cada uno con su código y caducidad, ligados al renglón por FK (antes la liga era `source_ref`, un string libre). **Bug bloqueante corregido y reproducido en runtime:** `evaluate()` leía `products.category` — columna que **no existe** (`42703`) → **500 en toda captura**: la ruta principal de la Pieza 2 nunca funcionó. La taxonomía real es `department` (Kepler `kdie`), y hay que leerla de `catalog.products`, NO de la vista compat `public.products` (es un `SELECT *` **congelado al crearse** que no expone columnas agregadas después). **No lo vio el smoke previo porque reimplementa `computeVerdict` en JS e inserta filas con knex** — 17/17 verde con la ruta caída; de ahí la regla nueva del ADR: la estación se prueba por HTTP. **Aceptación parcial**: veredicto **por lote** (verde/amarillo entran, rojo queda retenido sin escribir stock) + `close()` **409 con retenidos** + `authorize`/`reject` con **claim atómico** (antes dos supervisores concurrentes duplicaban stock). Cuadre derivado por renglón `declared/held/undeclared` → **indicador nuevo: piezas recibidas sin trazabilidad de caducidad**. Mig `20260825120000` aditiva+idempotente. Frontend: columna Declarado con "faltan N", banner de retenidos y side-peek con mini-form repetible (foto→OCR→confirmar) + normalización `MM/AAAA` → último día del mes. Smoke `http-receiving-lot-line-test` **37/37** (idempotente, 2 corridas) en `run-all-tests` (90 suites); dominio verde: auditor 17/17 · sesión 18/18 · bin 18/18 · conteo 13/13. **Pendiente prod: mig a Railway + redeploy api+view.** Diferido: cajas/piezas en el renglón, put-away embebido, reconciliación automática vs `analytics.erp_goods_receipts`. Plan en [`FASE_WMS_ESTACION_RECEPCION`](FASES/FASE_WMS_ESTACION_RECEPCION.md). | 100% del alcance de la rebanada (falta aplicar mig + validación visual) |
| **AX — Anexo de venta imprimible** | 🧪 **MVP EN CÓDIGO 2026-08-22 (builds api+view verdes)** | ADR-049. El documento que se entrega al cliente, **derivado del ODS** (vistas en vivo, cero tablas/importers). **AX.0** `analytics.erp_sales_invoices`/`_lines` sobre `kepler_ods` (migs 20260822140000/140100) + índices de expresión `CONCURRENTLY` (sin ellos el lookup medía 17.1 s) + smoke anclado en la factura 06 UD0801-0000087. **AX.1** `commercial-sales-documents`: list+KPIs+`applySmartSearch`+detalle (deriva precio con descuento por unidad, precio por caja y equivalencias; descuento por renglón por **mayor residuo** para que la columna cuadre). **AX.2/AX.3** `/comercial/documentos` en la familia de reportes de Venta: tabla densa + MetricStrip + side-peek; imprimir vía **blob** (el endpoint exige JWT) → iframe → `print()` con caída a pestaña nueva. **AX.4** PDF con puppeteer directo + **pagaré como anexo** del mismo documento (6 requisitos LGTOC 170, moratorio 3% mensual, plaza Santa Ana Pacueco C.P. 36910 validada vs SAT, 3 CLABEs con dígito verificador OK). Logo 400px → PDF 563→166 KB (−70%). **Decode corregido:** `kdud.c16`=días de crédito, `c15`=límite (`c14`=zona), `kdm1.c12`=vendedor; `c18` NO sirve de vencimiento. U/D/13 excluido (100% servicio). **Pendiente prod: 2 migraciones + smoke + redeploy.** Diferidos AX.5 (impresión WS), AX.6 (IA), AX.7 (control de pagarés). Plan en [`FASE_AX`](FASES/FASE_AX_ANEXO_VENTA.md). | 100% MVP (falta aplicar migs + validación visual) |
| **CM — Mapa Comercial (Trade)** | 🧪 **EN CÓDIGO + VERIFICADO POR QUERIES 2026-06-13** | CM.0 validación datos + CM.1 backend (`commercial-map`: 2 endpoints sobre `daily_captures.exhibiciones` JSONB, coord híbrida `COALESCE(stores.lat, captura.gps)`, split propio/competencia por `perteneceMegaDulces`) + CM.2 frontend (`/dashboard/commercial-map`, Leaflet, master-detail, marcadores por presencia) + CM.3 wiring (permiso `COMMERCIAL_MAP_VER` BE+FE+ability.factory+AppSubject, ruta, nav Trade, seed roles, backfill `20260613100000`) + CM.4 smoke `http-commercial-map-test.js` en runner. **`nx build api`+`view` verde**; queries del servicio replicadas read-only OK (36 ubicables, own:10/comp:24). **Pendiente:** correr regression con API arriba + validación visual + re-login/migrate en entornos sembrados. **Deferred:** Opción B (marcas competidoras + captura), clustering. | 100% beta (código + verificación por queries; smoke HTTP y visual pendientes de API arriba) |
| **M — Motor de Inteligencia Comercial + Agente AI** | 🟡 **EN PROGRESO 2026-06-10** | Respuesta a comparativa vs yom.ai. ADR-016: el motor decide / el agente comunica / LLM fuera del dinero. **Rebanada vertical V1 "Reorden inteligente"**: **M.0+M.1+M.2+M.3+M.4 en código 🧪 build verde** — lib `commercial-intelligence` (2 migs RLS: `customer_360` + `commerce_signals`). **M.0/M.1**: `Customer360Service` (batch RFM/cadencia/stage + cron 2 AM MX) + `DecisionEngineService` (NBA due-for-reorder + canasta). **M.2**: `CommerceAgentService` (mensaje reorden Claude/fallback). **M.3**: vendor home banner+chip "por reordenar hoy" (NBA∩cartera) + portal home tarjeta "tu pedido habitual". **M.4**: `FeedbackService` (commerce_signals append-only + conversión derivada por join) + hooks de impresión. Endpoints `/commercial/intelligence/*`. Revisión adversarial 9/9 OK. **Migraciones aplicadas + smoke E2E 32/32 VERDE + happy-path E2E verificado** (2026-06-10, Docker localhost:5433). 2 fixes runtime: FK→`identity.tenants` (public.tenants es vista post-reorg) + cadencia por días-distintos. **Happy-path probado** vía `seed-nba-demo.js`: cliente con pedidos espaciados → `due_for_reorder` + mensaje Claude real (solo productos del motor, invariante ADR-016 OK) + NBA list 1 due. **M.4.4 widget Command Center** ✅ + **M.5.3 cierre formal** (entry en 03_LOG + smoke en run-all-tests). **Regression: 25/25 VERDE** — se hardenearon los 11 smokes pre-existentes que estaban rojos por drift de testdata (bulk import ~2944 customers + catálogo real): lookup por `?search`/token cliente, filtrar `price=null` de `/prices`, productos dinámicos, MV vs live por contención, ruta real por zona del usuario. Cero bugs de producto. Pendiente: reload API (cadencia) + push (M.3.1/2). **Piloto Trade-captura (MT.1-3)** 🧪: fix bug frecuentes + offline. Plan en [`FASE_M`](FASES/FASE_M_MOTOR_INTELIGENCIA.md). | ~25% (V1 núcleo en código) |
| **Horus — Supervisor AI de ejecución (Trade)** | 🧪 **EN CÓDIGO + smoke VERDE 0 FAIL (visión+fraude+salud REALES) — parte diario+co-piloto (.0-.4) + v2 mejoras/ejecutor/visión/fraude/motor/venta/featurestore (H2.5-.6 + H2.2 + H2.4 + H2.3 + H2.7 + H2.1) 2026-06-17 · 🚀 PUSHED a main (6568d44 + hotfix 25P02 d964470) → Railway. Auditoría de oportunidades (8 lentes) → Batch 1 (hardening: approveAction SAVEPOINT + snapshot t0 + idempotencia migraciones) + Batch 2 (#1 loop al campo: field endpoints self-scoped + inbox vendedor + dismiss propaga) EN CÓDIGO commit local, push 1+2 pendiente** | Supervisor de ventas aumentado por AI para Trade (auditoría de ruta). ADR-020: motor decide / agente comunica / **co-piloto** (acción → `pending_approval` → humano aprueba). Motor hermano de Thot, separado (vive en `libs/trade`, no toca `commercial-intelligence`). Alcance = 3 capacidades: parte diario, auditoría visual de fotos (Claude vision), detección de fraude. Feature store `trade.execution_360` (collaborator/route/store). Reusa infra AI Fase K (Haiku+visión, throttling). Plan + schema + 8 sprints en [`FASE_HORUS`](FASES/FASE_HORUS_SUPERVISOR_AI.md). **Horus.0 EN CÓDIGO 🧪 — build api verde (2026-06-16)**: feature store `commercial.execution_360` + `execution_thresholds` (mig `20260616140000`, RLS+hardenRls), permiso `SUPERVISOR_AI_VER/APROBAR` (enums platform-core+view, ability, seed-newdb, backfill `20260616150000`), módulo `libs/trade/supervisor-ai` (`Execution360Service` computa+UPSERT señales directas de daily_captures —visitas/score/trend/share propio-vs-competencia/cobertura-foto/días-sin-visita— por colaborador y tienda ×7/30d vía KNEX_CONNECTION+tenant explícito; `ExecutionRefreshService` @Cron 02:30 MX + on-demand; endpoints `GET /supervisor-ai/execution-360` + `POST /supervisor-ai/compute`). Decisión clave: misma DB física `localhost:5433` (superuser bypassa RLS) → patrón CommercialMap. **Horus.1 EN CÓDIGO 🧪 — build verde (2026-06-16)**: auditoría de datos reales (`database/scripts/horus-data-audit.js`: 136 caps/30d, score mediana 38%/p25 27, store_id 29%, competencia 63% de exhibiciones con **0% sin clasificar**, foto 49%) → umbrales recalibrados con datos reales; `commercial.supervisor_findings` (mig `20260616160000`, `dedup_key` idempotente, respeta `dismissed`/`confirmed`, auto-resuelve lo que ya no aplica) + `FindingsEngineService` con 4 reglas defendibles (`score_drop`/`low_score`/`competitor_dominance`/`store_at_risk`, guard `min_obs=3`; **NO** emite foto/cobertura/idle por ruido basal o datos ausentes) + endpoints `GET /supervisor-ai/findings` + `POST /supervisor-ai/findings/:id/review` (perm `SUPERVISOR_AI_APROBAR`) + hook en el refresh. **Verificado en runtime — smoke `database/tests/http-horus-test.js` 22/22 verde (2026-06-16, API :3334)**: compute=78 rows feature store + 31 findings; idempotencia del dismiss confirmada (no reaparece tras recompute, respeta decisión humana). **A calibrar con negocio**: los 31 findings son TODOS `store_at_risk` (31 de 34 tiendas con store_id) → `days_no_visit_max=14` resulta muy laxo sobre captura de tienda esporádica; subir umbral o exigir tienda "monitoreada". **Para prod**: aplicar migs 140000/150000/160000 + re-login de supervisores (permiso vive en el JWT; `role_permissions` no se re-siembra solo → el backfill 150000 lo inyecta) + confirmar que `DATABASE_URL` de prod bypassa RLS (el cron escribe sin `SET app.tenant_id`). **Horus.2 EN CÓDIGO 🧪 (build verde)**: `SupervisorAgentService` redacta el parte diario (titular + resumen + ranking de atención) con Claude Haiku sobre los findings, con **fallback determinista sin LLM** (el parte funciona aunque Claude falle/no haya API key — el motor es la fuente de verdad). Replica el patrón de `LlmExtractorService` (mismo model/tool_use) sin acoplar platform-core. Endpoint `GET /supervisor-ai/briefing`. **Bonus (incidente roles 2026-06-16)**: arreglado bug pre-existente de aislamiento en `PermissionsCacheService`/`RolesGuard` — cacheaban y consultaban `role_permissions` por `role_name` SIN `tenant_id` (`.first()` no-determinista → cross-tenant leak); ahora key+query por `${tenant_id}:${role_name}`. Lo detonó mi backfill `150000` (UPDATE sin filtrar tenant tocó la fila superadmin del tenant de test `ws_iso_test` → superoot 403). Sin pérdida de datos. **Pendiente WRITE path** (`catalogs.service` update sin tenant). **Pendiente: reiniciar API → activar Horus.2 + fix guard → smoke (debe dar 27/27)**. **Horus.3 EN CÓDIGO 🧪 (build view verde)**: pantalla `/dashboard/supervisor-ai` (componente standalone) — parte diario (titular/resumen/ranking de atención + badge IA-vs-motor), bandeja de hallazgos con acciones descartar/confirmar (botones ghost), tabla de colaboradores 30d (visitas/score/tendencia ▲▼), botón Recalcular; servicio Angular `supervisor-ai.service.ts`; wiring ruta lazy + nav item Trade ("Supervisor IA", `pi-sparkles`) + `permission.guard` subjectMap. **Rebanada del PARTE DIARIO (.0→.3) COMPLETA en código — builds api+view verdes.** Pendiente: reiniciar API → smoke .2 (briefing, 27/27) + validación visual de la pantalla (re-login para el permiso en el JWT). **Horus.4 EN CÓDIGO 🧪 (builds api+view verdes) — CO-PILOTO**: `commercial.supervisor_actions` (mig `20260616170000`, dedup, hardenRls) + `SupervisorActionsService` propone 1 acción por finding abierto (`coaching` para colaborador, `visit` para tienda) en `pending_approval`; el supervisor aprueba/rechaza (perm `SUPERVISOR_AI_APROBAR`). **Ejecutor v1 INTERNO + reversible** (registra la decisión en `result` + confirma el finding asociado); efecto externo (push de coaching / reasignación en daily_assignments) **DIFERIDO y documentado** en `result.external_delivery='deferred'` — nada laboral se dispara a un canal inexistente. Endpoints `GET /actions` + `POST /actions/:id/approve|reject`, hook en el refresh, sección "Acciones sugeridas" (Aprobar/Rechazar) en la pantalla. Smoke extendido con `propose→approve→finding confirmed`. **PLAN v2 (2026-06-17, feedback "no cumple ni el 1%")**: roadmap de 8 rebanadas para 3× conocimiento + 100% Trade + motor de mejoras (Feature Store v2, visión de fotos, motor multi-señal, fraude, **Improvement Engine**, **ejecutor real**, venta↔ejecución, feedback). La numeración v2 (H2.x) supersede a la vieja (vieja .5 visión → H2.2, etc). **Arrancado por "valor visible": H2.5 + H2.6 EN CÓDIGO 🧪 (builds api+view verdes, 2026-06-17)**. H2.5 = `OpportunityEngineService` (motor de MEJORAS, no solo problemas): `coaching_focus` (diagnostica la debilidad concreta — foto / nivel Bajo-Crítico vía `nivelEjecucion` / score), `recover_shelf` (competencia domina → sugiere producto propio CONCRETO vía whitespace de la ruta, best-effort con nombre de `catalog.products`), `reprioritize_route` (≥2 tiendas sin visita → plan de mañana), `replicate_best` (mejor ejecutor, positivo). Acciones `kind='opportunity'` en el mismo buzón co-piloto (dedup namespace `opp:*`, expira separado de findings). H2.6 = **ejecutor REAL**: aprobar deja de ser no-op → crea `commercial.coaching_notes` (visible al colaborador) o `commercial.supervisor_tasks` (tarea para mañana, auto-asignada al último captor de la tienda/ruta), reversible; push externo sigue diferido. Migs `20260617100000` (kind/rationale + widen `action_type`) `/110000` (coaching_notes) `/120000` (supervisor_tasks), endpoints `/opportunities` `/tasks` `/coaching-notes`, pantalla con sección "Mejoras sugeridas" (con rationale) + panel "Hecho por Horus". **Migraciones aplicadas + smoke `http-horus-test.js` 48/48 VERDE (2026-06-17)**: mejoras generadas con shape correcto, aprobar crea `coaching_note`/`supervisor_task` PERSISTIDA en DB, separación finding/opportunity (`/actions?kind=`) OK. Pendiente: validación visual de la pantalla. **H2.2 VISIÓN EN CÓDIGO 🧪 (builds api+view verdes, 2026-06-17) — el salto de inteligencia**: `commercial.capture_vision` (mig `20260617140000`, hardenRls, dedup por `photo_key`) + `PhotoAuditService` (Claude Haiku MIRA cada foto de Cloudinary: fetch→base64→tool `audit_exhibition_photo` → `{is_shelf, own/competitor_visible, shelf_quality, out_of_stock, photo_quality}`; **incremental + acotado** MAX_PER_RUN=12, concurrencia 4; **sin ANTHROPIC_API_KEY = no-op graciosa**). Cruce **declarado-vs-observado** → `mismatch` (declaró propio pero la foto solo muestra competencia = semilla de fraude). `generateVisionFindings` emite `vision_stockout`/`vision_mismatch`/`vision_invalid` (source='vision', agrega por tienda/colaborador, respeta humano, auto-resuelve) → el co-piloto les arma acción (ACTION_FOR: stockout→visit, mismatch/invalid→flag_recapture→tarea recapture). Endpoints `POST /vision/scan` (+ regenera findings/acciones), `GET /vision`, `GET /vision/coverage`; cron nocturno escanea lote de 20. Pantalla: panel "Auditoría visual" (cobertura + fotos flageadas con thumbnail + banderas). Smoke sección 13. **Migración aplicada + smoke `http-horus-test.js` 56/56 VERDE (2026-06-17) con VISIÓN REAL**: `ANTHROPIC_API_KEY` presente → Claude analizó fotos reales de Cloudinary, `commercial.capture_vision` quedó poblada con veredictos estructurados (corrieron los asserts condicionales de DB). Pendiente: validación visual de la pantalla. **H2.4 FRAUDE EN CÓDIGO 🧪 (builds api+view verdes, 2026-06-17) — 3ª capacidad**: mig `20260617150000` (amplía CHECK de `source` a incluir `'fraud'`) + `FraudEngineService` — reglas DETERMINISTAS de física/tiempo sobre `daily_captures` (GPS validado + hora_inicio/fin siempre presentes): `fraud_gps_mismatch` (captura >300m de su tienda, haversine), `fraud_impossible_speed` (>130 km/h entre capturas consecutivas del mismo vendedor), `fraud_fast_visit` (duración < 15s×exhibición), `fraud_overlap` (intervalos de captura solapados), `fraud_recycled_photo` (misma fotoUrl en ≥2 capturas). Agregados por colaborador, `source='fraud'`, idempotentes, auto-resuelven; `capture_id` como evidencia. **GUARDARRAÍL ADR-020: detecta pero NO acusa — los hallazgos de fraude NO están en ACTION_FOR (cero acción automática), van a la bandeja para que el supervisor confirme/descarte.** En `/compute` + `POST /fraud/scan` + cron. Frontend: labels + badge "integridad" rojo en la bandeja. Smoke sección 14. **Migración aplicada + smoke `http-horus-test.js` 61/61 VERDE (2026-06-17): el motor DETECTÓ fraude en data real (hallazgos `fraud_*` bien formados, aparecen en la bandeja) y el guardarraíl se verificó (0 acciones de co-piloto nacidas de fraude). Foto reciclada por pHash de Cloudinary diferido (hoy usa fotoUrl exacta).** **H2.3 MOTOR MULTI-SEÑAL EN CÓDIGO 🧪 (builds api+view verdes, 2026-06-17)**: mig `20260617160000` (execution_360 += `exec_score` 0-100 + `exec_score_breakdown` JSONB) + `ScoringEngineService` — score de ejecución EXPLICABLE por sujeto, estilo Thot: señales normalizadas a [0,1] con pesos (colaborador: calidad 0.40 / tendencia / foto / share propio / **integridad-de-fraude** 0.15; tienda: share 0.45 / calidad / frescura), **renormaliza sobre señales presentes** y si confianza < 0.4 → score null (no inventa salud sin datos). Multi-señal real: cruza execution_360 con `supervisor_findings source='fraud'` para el factor integridad. Breakdown ordenado peor→mejor = "qué resta". Complementa (no reemplaza) las reglas. En `/compute` (último) + cron. Frontend: columna **Salud** (badge verde/ámbar/rojo) + "↓ señal más débil" + orden peor-primero en la tabla de colaboradores. Smoke sección 15. **Migración aplicada + smoke VERDE 0 FAIL (2026-06-17): 5/5 colaboradores con `exec_score` explicable (ej. angel_vazquez salud≈50, "más resta = share propio"); breakdown suma≈score + orden peor→mejor verificados.** (El total de checks bajó a 55 vs 61 porque corridas previas del smoke consumieron las mejoras pending —dedup respeta lo accionado—; 0 FAIL.) **H2.7 VENTA↔EJECUCIÓN EN CÓDIGO 🧪 (builds api+view verdes, 2026-06-17) — con análisis crítico de datos**: audit read-only (`database/scripts/horus-sales-audit.js`) reveló que la venta de campo es **demo-only** (route_tickets: 4 ventas de un solo día 2026-06-03, 1 vendedor; vendor_sale_lines: 2 tiendas, 1 vendedor). Por eso H2.7 NO inventa un motor de findings sobre ruido: `SalesExecutionService` da una **vista read-only** (`GET /sales-execution`) que cruza exec_score con venta (route_tickets por vendor_user_id + vendor_sale_lines por tienda) y doble como **diagnóstico de cobertura** ("1/5 vendedores, 2/34 tiendas registran venta" → el insight real hoy = impulsar el cierre de ruta). El finding `sales_execution_gap` ("ejecuta bien pero 0 venta") está **GATEADO** por `MIN_VENDORS_WITH_SALES=4` → DORMIDO hasta que la venta madure (auto-resuelve mientras). Sin migración (reusa tablas + source='engine'). En `/compute` + cron + panel "Venta vs ejecución" con cuadrantes. Smoke sección 16. **Verificado: smoke 60/60 VERDE (2026-06-17) — `/sales-execution` 200, cobertura refleja venta demo-only, gate deja el gap DORMIDO (0 `sales_execution_gap` abiertos).** **H2.1 FEATURE STORE v2 EN CÓDIGO 🧪 (builds api+view verdes, 2026-06-17) — con audit previo**: `database/scripts/horus-features-audit.js` (read-only) midió cobertura → **nivelEjecucion 94%, hora_fin 100% (mediana 8.8min), productos 99%** = sólidos; **route_id 0%, daily_assignments.date inexistente, scoring_pesos inaccesible** = diferidos. Mig `20260617170000` (execution_360 += `exec_level_score` 0-100 + `avg_visit_min` + `avg_skus`). `Execution360Service` ahora explota el JSONB: normaliza la **rúbrica MIXTA** de nivel (alto/excelente=1 · medio/estandar=0.6 · bajo/basico=0.3 · crítico=0.1 — el audit reveló que conviven dos rúbricas, mi isLowLevel previo se perdía "basico"), duración real de visita y surtido por exhibición. **`ScoringEngineService` incorpora `exec_level` al score de salud** (colaborador: quality .32/exec_level .18/trend .13/photo .12/own .12/integrity .13; tienda: own .38/quality .25/exec_level .17/freshness .20) — como renormaliza, la salud se vuelve más fina sin reescribir. Frontend: columnas Nivel + Min/vis en la tabla. Smoke sección 17. **Pendiente: `migrate:new` (`20260617170000`) + restart → smoke (~62).** **Diferido H2.1b** (data viable pero no prioritario): roll-ups por zona (users.zona_id 93%) / supervisor (74%); position-quality y coverage esperan que scoring_pesos/daily_assignments sean accesibles. Próximo v2: H2.8 (feedback+Ask-Horus). **Quedan los 2 cross-cutting de alto valor: el colaborador VE sus tareas/coaching (hoy invisibles al campo) + deploy a prod (todo local).** Cross-cutting alto valor: el colaborador VE sus tareas/coaching (hoy invisibles al campo) + deploy a prod. **Batch 2 ✅ EN CÓDIGO (commit local 532499f)**: loop al campo (`/supervisor-ai/field/*` self-scoped + inbox vendedor + dismiss propaga). **Track Aprendizaje (Horus.L, ADR-021) ARRANCADO 2026-06-17**: que Horus aprenda Trade — taxonomía L0(memoria ✅)→L1(baselines)→L2(auto-calibración)→L3(efectividad diff-in-diff)→L4(pesos adaptativos)→L5/L6(diferidos por muro de datos). **L2 ✅ EN CÓDIGO (build api verde)**: mig `20260617190000` `commercial.execution_rule_stats` + `RuleCalibrationService` (precision = confirmed/(confirmed+dismissed); floor=8; <0.20 suprime, 0.20–0.40 capa severidad; `manual_override`=pin humano) + read-back en FindingsEngine (salta/capa reglas ruidosas) + cron + endpoints `/supervisor-ai/learning/{rules,recompute,rules/:t/override}` + smoke sección 20. Principio ADR-021: el motor aprende (determinista/auditable/overridable), el LLM fuera del lazo; ship-collector-before-learner (gate por calendario). **L2 ✅ VERIFICADO (smoke §20, 84 OK/0 FAIL).** **L1 ✅ EN CÓDIGO + VERIFICADO (smoke §21, 91 OK/0 FAIL)**: mig `20260617200000` `commercial.execution_baselines` (long/métrica) + `BaselineLearnerService` (mean/stddev rodante desde snapshots) + regla `self_anomaly` (z-score vs la propia historia: capta 90→75, ignora "siempre bajo"; pasa por calibración L2) + `GET /learning/baselines`; §21 prueba el disparo con histórico sintético + cleanup. **L7 ✅ EN CÓDIGO (build view verde)**: panel "Lo que Horus aprendió" en `/dashboard/supervisor-ai` (scorecard de reglas con Silenciar/Reactivar + "lo normal" por colaborador). Commits locales: ce9c61a (L2), 9d7bc0e (L1), +L7. **Aprendizaje L2+L1+L7 ✅ EN PROD** (main 915e9a9). **Track Horus 360 (conocimiento total de Trade) ARRANCADO 2026-06-18**: que Horus explote TODA la señal usable de cada módulo. Paso 0 audit (`horus-jsonb-audit.js`): conceptoId/ubicacionId **93%** (GO), productosMarcados 99%, **ventaAdicional 0% → K2 MUERTO** (no se codea sobre $0; va a Eje B). **K1 ✅ EN CÓDIGO (builds api+view verdes)**: mig `20260618100000` `execution_360 += by_concept/by_location` + `Execution360Service` agrega por concepto/ubicación (resuelve nombres vía `catalogs` con SAVEPOINT anti-25P02) + regla `weak_concept` (peor concepto vs propio nivel −25 → coaching concreto; pasa por calibración L2) + FE labels/evidencia + smoke §22 (prueba sintética del disparo + cleanup). **K4 ✅ EN CÓDIGO (builds verdes)**: mig `20260618110000` `execution_360 += planogram_present/planogram_total` + `Execution360Service` mide adherencia al planograma (`productosMarcados ∩ trade.planogram_skus`, safeQuery anti-25P02) + regla `planogram_gap` PEER-RELATIVA entre tiendas (conservadora, pasa por L2; caveat store_id 33%, dormida si parejo) + FE + smoke §23 (prueba el disparo con pares sintéticos + cleanup). Audit K4: orden_exhibicion 100%, PIDs mapean (304/631). **K6 ✅ EN CÓDIGO (builds verdes)**: mig `20260618120000` amplía CHECK `execution_360.subject_type` a `zone`/`supervisor`; `Execution360Service` sube cada captura a la zona+supervisor del colaborador (users.zona_id 89%/supervisor_id 71%, reusa fan/buildRow, org sin by_concept/planograma); reglas `low_score`/`score_drop` ampliadas a org ("zona Norte cayó"/"equipo de X bajo"); FE tag zona/equipo; smoke §24 (roll-ups reales + low_score sobre zona sintética + cleanup). **K3 ✅ EN CÓDIGO (builds verdes)**: audit `catalogs.puntuacion` (niveles Alto1.0/Medio0.70/Bajo0.40/Crítico0.20, ubicaciones Caja100…Detrás10, conceptos 0.5-2.0 = rúbrica oficial). Mig `20260618130000` `execution_360 += position_quality` (promedio del peso oficial de ubicación por exhibición → desbloquea position-quality que H2.1 difirió). Regla `weak_position` (colaborador/tienda position_quality<35; umbral absoluto; pasa por L2). FE label/evidencia. Smoke §25. Diferido K3.2 (niveles oficiales en exec_level, ripple amplio). **K5 ✅ EN CÓDIGO (builds verdes, SIN migración)**: `idle_min_avg` ya existía → solo se POBLA. `Execution360Service.computeIdleByUser` (inline, misma def que ReportsService: gap entre capturas mismo colaborador/día, conservador sin coords); post-pass asigna a colaborador-30d; merge += idle_min_avg. Regla `idle_anomaly` (idle>90min, pasa por L2). FE label/evidencia. Smoke §26. **Pendiente: migrate:new (`100000`+`110000`+`120000`+`130000`, K5 sin migración) + restart → smoke 1-26; luego K7/K3.2/K5b + Eje B.** **5 sprints Horus 360 apilados sin smoke de runtime (deuda de verificación flaggeada).** **Sprint Horus.ACT ARRANCADO 2026-07-21 (acciones de campo accionables): ACT.1 `missed_visit` (no visitó al cliente) + ACT.4 entrega híbrida ✅ EN CÓDIGO — builds api+view verdes + smoke DB `smoke-horus-missed-visit.js` 5/5.** `MissedVisitEngineService` cruza cartera planeada del día (`daily_assignments`×`customers.sales_route`/`visit_days`, inline de vendor-cartera.sql) vs `vendor_visits` de hoy → finding `missed_visit` source='plan', cron propio **21:00 MX** (no el refresh 02:30, evita falso positivo), vive 1 día (dedup con fecha), guard hora<18. **Canal híbrido** (decisión Edgar): vendedor recibe incidencia AUTO (`coaching_notes` category='incident' + nudge WS `horus:nudge`, idempotente por finding_id); supervisor APRUEBA `notify_missed_visit` → `emitSupervisorIncident` (`horus:incident` room global) + confirma finding. Mig `20260721120000` amplía CHECKs (`supervisor_findings.source+='plan'`, `supervisor_actions.action_type+='notify_missed_visit'`); `category='incident'` sin migración (columna sin CHECK). Endpoint manual `POST /supervisor-ai/missed-visits/scan?force=true`. FE: labels/evidencia/íconos. **ACT.2 reorden real + ACT.3 alta oportunidad DENUE ✅ EN CÓDIGO (builds verdes, smoke Horus.ACT 8/8, registrado en run-all-tests grupo needsApi:false).** ACT.2: `OpportunityEngineService` calcula orden **NN-Haversine** (`nnOrder`) de los clientes de la ruta y adjunta `proposed_order`/`sales_route` al payload de `reprioritize_route`; el ejecutor escribe `commercial.customers.visit_sequence` (reversible, `previous_order` en result), rama antes de TASK_TYPE, degrada a tarea si <3 clientes geo. ACT.3: `add_opportunity_store` (subject 'prospect', top-3 `prospect_stores` candidate whitespace≥60 + ruta sugerida por cercanía); aprobar crea `commercial.customers` pedible (code P-…, price list default) + prospecto `status='converted'`. Mig `20260721130000` amplía CHECK `action_type+='add_opportunity_store'` (aplicada local Batch 192). **MAPA "Rutas reconvertidas" ✅ EN CÓDIGO**: endpoint read-only `GET /supervisor-ai/route-optimization[?sales_route=]` + página `/dashboard/supervisor-ai/route-optimization` (reusa MapComponent Leaflet: línea gris=hoy / línea verde numerada=óptima NN / pines ámbar=tiendas de oportunidad + KPIs km actual-vs-óptimo + mejora% + toggles + lista "antes #N"). Botón "Rutas reconvertidas" en el header de Horus. **ACT.5 balanceo de carga ✅ EN CÓDIGO (builds verdes, smoke 10/10)**: `RouteBalanceService` nivela el tiempo por persona (=su ruta) moviendo clientes-frontera de la ruta más cargada a una liviana (tiempo híbrido: min-visita observados de vendor_visits + traslado NN-Haversine/18kmh; greedy hasta desbalance ≤15min). Endpoints `GET /supervisor-ai/route-balance` (simula), `POST /route-balance/apply` (APROBAR, escribe sales_route + `previous_state` en `commercial.route_rebalance_log`), `POST /route-balance/undo`. Mig `20260721140000` (log RLS). Página `/dashboard/supervisor-ai/route-balance` (KPIs ruta-más-larga hoy vs nivelada + mejora% + σ + barras antes→después + lista movimientos + Aplicar/Revertir con confirm). Botón "Balanceo de carga" en header Horus. Fix build: método controller renombrado `routeBalanceSim` (colisión con propiedad). **Pendiente prod: migrate:new (`20260721120000`+`130000`+`140000`) Railway + restart (cron 21:00) + re-login + verificación en vivo endpoints route-optimization/route-balance + validación visual.** Plan en [`FASE_HORUS`](FASES/FASE_HORUS_SUPERVISOR_AI.md). | ~84% (aprendizaje en prod + Horus 360 K1+K4+K6+K3+K5 en código; falta migrate+smoke + K7 + Eje B datos) |
| **LM — Última Milla (entrega a domicilio local en moto)** | 🧪 **LM.0–LM.5 backend + LM.6.1 frontend repartidor + LM-K.0 schema Kepler EN CÓDIGO — builds api+vendor verdes 2026-07-02/03** (SOP completo: intake→despacho→entrega/cobro/incidencia→liquidación con arqueo + app repartidor online-first). **Track LM-K (entrega desde folio Kepler)**: LM-K.0 ✅ schema — `guide_recipients` ref Kepler (folio/serie/warehouse + items_snapshot + collect_on_delivery), `payments` order_id/customer_id nullable + ref Kepler + CHECK (order o folio), allowlist `logistics.home_delivery_warehouses` (piloto: PH `01`/La Piedad `02`/8 Esq `03`), permiso `LOGISTICS_HOME_DISPATCH` + 3 roles nuevos (jefe_de_tienda/auxiliar_de_tienda/gerente_de_zona) + backfill. Repartidor separado del vendedor (RiderService propio). LM-K.1 ✅ `GET /store/live/ticket-lookup`. LM-K.2 ✅ despacho REUBICADO fuera de logística → `commercial-home-delivery` (`HomeDispatchService`: dispatch-from-kepler + dispatch order + my-deliveries; se borró `logistics-home-dispatch`). LM-K.3 ✅ cobro COD ligado a folio. LM-K.4 ✅ frontend tienda (`/comercial/domicilio`: folio→ticket→domicilio→asignar repartidor+moto, nav "A domicilio"). **Track LM-K COMPLETO en código (builds verdes).** Smoke `database/tests/http-home-delivery-test.js` escrito + registrado en run-all-tests (ingest ticket→lookup→dispatch→my-deliveries→outcome COD→arqueo; siembra fixtures vía HTTP; el ticket necesita STORE_INGEST_KEY). **LM.7 ✅ panel encargado** (`/comercial/cortes`: corte + arqueo por denominación con diferencia en vivo + lista del día). Pendiente operacional: migrate:new + re-login + **correr el smoke con API arriba**. **Módulo REPARTO ✅ (2026-07-03, build view verde):** las pantallas de tienda salieron del shell `comercial` a un **módulo propio** `apps/view/modules/reparto/` con shell + nav + `repartoGuard` (gate `LOGISTICS_HOME_DISPATCH`). Rutas `/reparto/asignar` (captura folio→despacho) y `/reparto/cortes` (arqueo). Tarjeta "Reparto" en el landing `/projects`. Aquí entra el personal de tienda. **LM.7.1 ✅ verificación de transferencias** (`GET /commercial/payments/pending-verification` + botón Verificar en el panel del encargado). **🧪 VERIFICADO EN RUNTIME 2026-07-03: smoke `http-home-delivery-test.js` 17/20 OK** (migraciones LM-K aplicadas). Flujo del dinero validado E2E: allowlist + lookup + dispatch (+409 anti-doble) + outcome/cobro (cambio $49.5) + arqueo (dif $0). **3 bugs reales encontrados+arreglados**: (1) migraciones LM-K sin aplicar → aplicadas; (2) `SET LOCAL app.tenant_id=?` con bind param (Postgres lo rechaza) → `set_config()`; (3) `my-deliveries` `.first()` sobre drivers → `whereIn` todos los del user. Los 3 FAIL restantes (my-deliveries) los cubre el fix #3, **pendiente 1 reinicio API para confirmar 20/20**. **LM.8 ✅ KPIs última milla** (`/commercial/home-delivery/kpis` + widget en panel encargado: éxito%/incidencias%/tiempo/dif.efectivo con metas §13). Diferido: LM.6.2 (offline+firma), ROI 2-3% (reusa logistics-analytics), reconciliar COD→Kepler, crear usuarios de los 3 roles de tienda. Offline Dexie (LM.6.2), intake cajero/panel encargado (LM.7) pendientes. (decisiones resueltas: cash-only GLOBAL + sucursal=`store_id`). **LM.1 = PaymentsService** (`libs/commercial/commercial-payments/`): recordPayment/verifyTransfer/reversePayment/listByOrder + `deliverAndCollect` (fulfill+cobro atómico), lock FOR UPDATE, idempotencia por (order_id,reference), update paid_amount/balance_due, endpoints REST + permisos. Cierra la deuda "payments deferred" de Fase B. ADR-027 propuesto. Digitaliza el SOP de entrega a domicilio de Mega Dulces. **Tesis: orquestación, no módulo nuevo** — el pedido = `commercial.orders (delivery_type='home_delivery')`, la entrega = `logistics.delivery_guides`+`guide_recipients` (ya trae POD/GPS-vivo/ETA/checklists/fotos/costos/ROI), la moto = `logistics.vehicles`. **4 gaps reales**: (1) **PaymentsService** sobre `commercial.payments` (hoy vacía, cash-only) multi-método + hook `deliverAndCollect` — cierra la deuda "payments deferred" de Fase B, shippeable solo; (2) intake a domicilio (cliente casual `is_casual` + `orders.delivery_address` JSONB + canal + ETA); (3) incidencias tipificadas (patrón 6-outcomes de `call_logs`: not_located 10min/wrong_address/rejected→reversa stock/missing_product); (4) moto + overflow a CEDIS. Más: **arqueo por denominación** (`rider_liquidations.cash_breakdown`) + **firma de cliente obligatoria** en POD (validación dura). Rol `repartidor`. Frontend reusa `apps/vendor` offline-first + intake cajero + panel encargado. **10 sprints (LM.0–LM.9)**, ruta crítica LM.0→LM.1. Plan en [`FASE_LM`](FASES/FASE_LM_ULTIMA_MILLA.md). **Sin código aún.** Decisiones abiertas: quitar cash-only global (era restricción beta) + sucursal = `store_id` (no tenant). | 0% (diseñado) |

| **VR — Venta en Ruta (autoventa offline-first)** | 🔨 **DISEÑADO 2026-07-13** | **ADR-032 propuesto**: en autoventa el evento ya ocurrió (mercancía entregada + cash cobrado) → el device es la fuente de verdad; el server **acepta el replay siempre** (idempotente por `client_uuid`), respeta el precio cobrado, y las divergencias van a conciliación (reusa `libs/reconciliation`) — nunca rechaza ni recalcula. Auditoría 2026-07-13 encontró **18 gaps** (FASE_VR §1.2): sin idempotency key en orders (timeout = pedido duplicado), `place` no idempotente desde cliente, replay sin transient/401 (mata ventas en silencio), cliente offline sin remapear, precio recalculado al sync (descuadre de arqueo), autoventa descuenta CEDIS no camión, sin folio offline, JWT sin check `exp`. Diseño: endpoint atómico `POST /commercial/orders/route-sale` (1 request = 1 trx: orden fulfilled + líneas precio device + consume stock camión `allow_negative` flaggeado + payment), folio local `VR-<device>-<seq>`, transfer formal CEDIS↔camión + ledger local Dexie, liquidación con **arqueo ciego** (reusa `rider_liquidations`) + cuadre `carga − ventas = retorno` (regla P1 SM). 9 sprints VR.0–VR.8; ruta crítica VR.0→VR.3; **VR.4/VR.5 obligatorios antes de piloto**. Estratégico: camino para retirar los Kepler locales de ~35 camionetas route-push. Plan en [`FASE_VR`](FASES/FASE_VR_VENTA_EN_RUTA.md). **Sin código aún.** Decisiones abiertas (Edgar): ADR-032, CHECK stock negativos truck, JWT 7d, folio local ante cliente, piloto paralelo con Kepler. | 0% (diseñado) |

| **JK — Jenkins CI/CD on-prem** | 🔨 **SCAFFOLD EN CÓDIGO 2026-07-24 (sin runtime aún)** | ADR-034 (propuesto). Host = **`.249`** (esta máquina: corre los feeds hoy + Docker + pgvector-md 5433 + stack de pruebas + Watchtower), NO `.245` (consolidación Kepler, intacto). Saca 2 cargas de prod: (1) feeds del Windows Task Scheduler mudo → jobs Jenkins con logs/historial/reintento; (2) build de Angular que hoy corre EN Railway → build local en `.249` → push **Docker Hub `edgarcg01/trade-marketing`** → Watchtower prueba en `.249` → `railway redeploy` a prod (Railway deja de compilar). **JK.0** Jenkins LTS Docker (Docker Desktop, ports+socket, DBs por IP LAN). **JK.1** `Jenkinsfile.feeds` (modo+APPLY dry-run default, captura logs). **JK.2** `Jenkinsfile.deploy` buildx amd64 → Docker Hub tags sha+latest. **JK.3** `railway redeploy` (source=Docker Image, `migrate.sh` se conserva). Nota: feeds SÍ necesitan runner on-prem; build podría ir en GH Actions (existe `.github/workflows/ci.yml`, solo gate) — Jenkins por decisión explícita. "Binario de importers" NO reduce egress → JK.4 opcional. Pendiente: `up -d` en `.249` + credenciales + config Railway + rollout dry-run→apply. Plan en [`FASE_JK`](FASES/FASE_JK_JENKINS_CICD.md). | 0% (scaffold; falta runtime) |

| **INFRA — Endurecimiento infra + worker-tier** | 🔨 **ARRANCADA 2026-08-12 (ADR-043)** | Activar/separar, no re-arquitecturar: monolito modular + worker-tier + broker, todo por toggle default OFF. Diagnóstico: 1 proceso NestJS carga REST+6 WS+~40 `@Cron`+IA+MV → OOM/ECONNRESET, clavado a 1 instancia (crons se duplicarían con N), IA en request-path sin límite de concurrencia, `nightly`=tren de ~55 importers en serie; + secretos en `.env` (creds expuestos sin rotar), observabilidad=solo Sentry, media Cloudinary con egress caro. **Top-5 en orden**: INFRA.1 secretos→bóveda (Infisical/Doppler, **PAUSA cuenta**) + rotación · INFRA.2 observabilidad (nestjs-pino JSON + OpenTelemetry + Grafana/Loki/Prometheus en `.249` o cloud) · INFRA.3 **worker-tier con `pg-boss`** (cola sobre el propio Postgres, cero Redis; proceso `WORKER=true` mismo código Nx + toggle `ENABLE_WORKER_QUEUE`; migra 1 cron pesado de prueba → resto por dominio) · INFRA.4 media→Cloudflare R2 (`@aws-sdk/client-s3` ya instalado, **PAUSA cuenta**) · INFRA.5 CI extendido (`nx affected`+regression en el gate). Anti-scope: NO microservicios por dominio / K8s / Kafka / Terraform / cambio de motor DB; Express→Fastify diferido. Complementa ADR-035 (`feeds-ingest`). **INFRA.1 🧪** (auditoría secretos + fix drift `.env.example` + scaffold Infisical `.249` + runbook sync→Railway; PAUSA: `up -d`+rotar). **INFRA.2 🧪** (pino logs JSON toggle `LOG_JSON` + OTel `apps/api/src/otel.ts` import-first inerte + stack LGTM `.249` `ops/observability/grafana-stack.yml`; build api verde; PAUSA: `up -d`+Cloudflare Tunnel `:4318`+envs). **INFRA.3 🧪** (worker-tier: `QueueService` pg-boss v12 toggle `ENABLE_WORKER_QUEUE` + `shouldRunInProcessCron()` + `bootstrapWorker()` `WORKER=true` + 1er cron migrado `EmbeddingSync` + `railway.worker.json`; build verde; PAUSA: 2º servicio Railway + verificación runtime). **INFRA.4 ✅** (`ObjectStorageService` ya usa el **bucket propio de Railway** —Tigris S3-compatible, no R2—; sin pausa). **INFRA.5 ✅** (`ci.yml` job `verify` nx affected lint/test + `engines.node` pineado). **Todo por toggle default OFF → prod intacto hasta que Edgar los prenda.** Plan en [`FASE_INFRA`](FASES/FASE_INFRA_WORKER_TIER.md). | ~55% (código de los 5 sprints; falta runtime/cuentas de Edgar) |

| **CA — CEDIS (Kepler Access 97) → ODS** | 🔨 **DISEÑADO 2026-08-18** | **ADR-045 propuesto**. Trae el CEDIS (sucursal `00`, almacén central mayorista) al pipeline `kepler_ods.*` como 7ª fuente. **Hallazgo:** las 6 sucursales 01-06 corren Kepler/Postgres (ya replicadas al día), pero el **CEDIS corre sobre Microsoft Access 97 `.mdb`** (fuera del pipeline) y el `192.168.9.95:5432/md_00` Postgres que hoy leen finanzas/compras/cobranza **es data de PRUEBA, no el CEDIS vivo**. Ensamblar piezas probadas: lectura = patrón **Wincaja** (Jet 4.0 **32-bit** `Mode=Read` sobre copia-sombra; ACE rechaza Access 97), CDC = **dos carriles** de `replicate-ods-live` (watermark de negocio para movimientos `kdm1/kdm2/kdij/kdue/kdpord` + **hash-delta md5-en-JS** para catálogos/existencias `kdil/kdii/kdik/…`), ship = mismo sink `raw-upsert`→`kepler_ods sucursal='00'` (destino SIN cambios), estado CDC (watermark+shadow) en Postgres porque el `.mdb` es read-only. **7 sprints**: CA.0 descubrimiento `.mdb` (⛔ ruta crítica: ruta+copia-sombra+esquema+PK+col-watermark) → CA.1 adapter → CA.2 incremental → CA.3 hash-delta (existencias ⭐) → CA.4 orquestador+tarea → CA.5 cutover+monitoreo (source db-health propio; el CEDIS no vende a público) → CA.6 migrar consumidores del `md_00`-prueba (mayor valor de fondo). MVP=CA.0–5. Decisiones abiertas: ruta/copia-sombra del `.mdb`, cadencia ~1-5min, alcance CA.6. Plan en [`FASE_CA`](FASES/FASE_CA_CEDIS_ACCESS_ODS.md). **Sin código aún.** | 0% (diseñado) |

| **WR — Réplica cruda Wincaja (Access 97 → Postgres, continua)** | 🔨 **DISEÑADO 2026-08-18** | Decisión Edgar: **réplica cruda local completa + continua (~1-5 min)** — el equivalente de `kepler_md_XX` para Wincaja (espejo Postgres crudo de TODAS las tablas de cada `.mdb`: 30/32/CEDIS-00/rutas; Canindo 50 ya migró a Kepler). **Ya existe** bronze `wincaja.*` parcial (21 tablas, full-daily Jet ~26min) + live-extract (tickets 5min); WR agrega la capa cruda continua que a Kepler le da la replicación lógica. Access no habla replicación lógica → **CDC Jet 32-bit + hash-delta** (mismo adapter que Fase CA: reader Jet `Mode=Read` sobre copia-sombra + watermark para movimientos + hash-delta md5-en-JS para catálogos + estado schema `ods`). **7 sprints**: WR.0 descubrimiento (⛔ `.mdb`/copia-sombra/esquema/PK/col-watermark) → WR.1 adapter lectura+esquema → WR.2 destino+DDL espejo → WR.3 CDC dos carriles → WR.4 orquestador `replicate-wincaja-live.js`+tarea `WincajaLiveLoop` → WR.5 verificación+monitoreo → WR.6 re-apuntar bronze a la réplica (deja de depender de Jet). MVP=WR.0–5. Comparte adapter con Fase CA (Access→Postgres una sola vez). Decisiones abiertas: topología destino (DB vs schema/sucursal), datasets (Concentradas continuo vs histórico one-shot), rutas, copia-sombra de 00/rutas. Plan en [`FASE_WR`](FASES/FASE_WR_WINCAJA_REPLICA.md). **Sin código aún.** | 0% (diseñado) |

Leyenda fase:
- 🔴 No iniciada · 🟡 En progreso · 🔵 En revisión · 🟢 Completada · ⏸️ Bloqueada

---

## 🚦 Estado por item (granular)

Cada item del tracker tiene un estado compuesto que indica EXACTAMENTE en qué punto del pipeline está:

| Símbolo | Significado |
|---|---|
| ⬜ | TODO — no iniciado |
| 🔨 | EN CÓDIGO — implementación en curso |
| 🧪 | PROBADO — código + tests pasando local |
| 🚀 | STAGING — deployado en staging, smoke test ok |
| ✅ | PROD — en producción, observado sin issues 24h+ |
| ⚠️ | BLOCKED — bloqueado por algo externo (lista la razón) |
| ❌ | REVERTED — se intentó y se hizo rollback (registrar en `03_LOG_REVISIONES.md`) |

**Regla:** ningún item llega a ✅ sin haber pasado por 🧪 → 🚀.

**Convención**: cada item tiene la línea:
```
- [ ] **[A.X.N]** ⬜ Descripción del item
```
Y se actualiza el símbolo al avanzar:
```
- [x] **[A.X.N]** ✅ Descripción (cerrado 2026-06-01)
```

---

## 🎯 EN PROGRESO

> Items que un dev está trabajando AHORA. Idealmente 1-3 a la vez. Más que eso = pérdida de foco.

_(vacío — iniciar con Fase A)_

---

## 👀 EN REVISIÓN

> Items terminados pero pendientes de validación (tests, code review, deploy a staging, validación funcional).

_(vacío)_

---

## ✅ HECHO

> Items completados y deployados a producción. Mantener para historial. Limpiar cada cierre de fase moviendo a `03_LOG_REVISIONES.md`.

_(vacío)_

---

## 📋 BACKLOG — Fase A: Fundaciones

> Empezar por aquí. Cada ítem es un commit-able task.

### Sprint A.-1 — Auditoría profunda de la base existente ✅

> **Estado: COMPLETADO 2026-05-26.** Findings consolidados en `AUDITORIA_BASE_INICIAL.md`.
> 60 issues encontrados: 19 críticos, 25 importantes, 16 nice-to-have.

- [x] **[A.-1.1]** ✅ Auditoría schema DB → 14 findings (6 críticos) — cerrado 2026-05-26
- [x] **[A.-1.2]** ✅ Auditoría backend NestJS → 13 findings (4 críticos) — cerrado 2026-05-26
- [x] **[A.-1.3]** ✅ Auditoría frontend Angular → 15 findings (4 críticos) — cerrado 2026-05-26
- [x] **[A.-1.4]** ✅ Auditoría config/seguridad → 18 findings (5 críticos) — cerrado 2026-05-26
- [x] **[A.-1.5]** ✅ Documento consolidado: `AUDITORIA_BASE_INICIAL.md` — cerrado 2026-05-26

---

### Sprint A.0-multitenant — Nueva DB Postgres con multi-tenancy (~3-4 sem) 🔥

> **PRIORIDAD ALTA** (decisión 2026-05-26, ADR-010). Aplicar correcciones del audit sobre schema limpio nuevo. Mega Dulces = primer tenant. Detalle completo en `FASES/FASE_A0_MULTITENANT_NEW_DB.md`.

#### A.0mt.1 — Aprovisionamiento + schema base (5 días)
- [x] **[A.0mt.1.1]** ✅ DB `postgres_platform` creada local en `192.168.0.245:5432` con Postgres 18.4 (2026-05-26). **Migración a Railway pendiente** — se hará en cutover Sprint A.0mt.5.
- [x] **[A.0mt.1.2]** ✅ Variables `DATABASE_URL_NEW` + `NEW_DB_*` agregadas a `.env` local + `.env.example` template (2026-05-26).
- [x] **[A.0mt.1.3]** ✅ `database/knexfile-newdb.js` creado con segunda conexión + dotenv loading explícito + directorios `migrations-newdb/` + `seeds-newdb/` (2026-05-26).
- [x] **[A.0mt.1.4]** ✅ Migración `20260526000001_init_tenants_and_extensions.js` aplicada en local: tabla `tenants` + extensión `pgcrypto` + función `current_tenant_id()`. Seed `01_first_tenant_mega_dulces.js` insertó tenant `mega_dulces` (`00000000-0000-0000-0000-00000000d01c`) (2026-05-26).
- [x] **[A.0mt.1.5]** ✅ Helper `setTenantContext` + `runWithTenant` + `TenantKnexService` creados en `apps/api/src/shared/database/tenant-knex.service.ts` + módulo `NewDatabaseModule` (sin wirear al AppModule todavía — esperará al cutover) (2026-05-26).
- [x] **[A.0mt.1.6]** ✅ Test end-to-end `database/test-newdb-tenant-context.js`: 8/8 pass — incluye aislamiento entre tx concurrentes con tenants distintos, no-leak post-commit, validación regex anti-injection (2026-05-26).

#### A.0mt.2 — Schema completo + RLS (1-1.5 sem)
- [x] **[A.0mt.2.1]** ✅ Diseño detallado: inventario 19 tablas. `captures` excluida (deprecated), `routes` no se crea (queda como `catalogs` EAV). Renombrados: scoring_pesos → scoring_weights, rubrica_* → rubric_*, combinaciones_validas → valid_exhibition_combinations. Brands/products ya estaban en inglés en legacy (2026-05-26).
- [x] **[A.0mt.2.2]** ✅ Migración `20260526000002_core_identity.js`: tablas `zones`, `role_permissions`, `users`, `catalogs` con `tenant_id` + audit completo + composite FKs (tenant_id, id) + 22 índices + RLS policy `tenant_isolation` con USING + WITH CHECK (2026-05-26).
- [x] **[A.0mt.2.X]** ✅ BONUS — Migración `20260526000003_create_app_runtime_role.js`: crea rol `app_runtime` NOSUPERUSER NOBYPASSRLS con grants CRUD. Necesario porque `postgres` superuser bypassea RLS. Validado: con app_runtime el SELECT/INSERT cross-tenant FALLA como debe (2026-05-26).
- [x] **[A.0mt.2.3]** ✅ Migración `20260526000004_product_catalog.js`: `brands` + `products` con composite FK (tenant_id, brand_id) + RLS + grants (2026-05-26).
- [x] **[A.0mt.2.4]** ✅ Migración `20260526000005_field_operations.js`: `stores`, `daily_assignments` (con CHECK day_of_week 1-7), `visits` (sin captured_by_username), `exhibitions` (pertenece_mega_dulces → is_own_brand), `exhibition_photos` (con cloudinary_public_id) + RLS (2026-05-26).
- [x] **[A.0mt.2.6]** ✅ Migración `20260526000006_scoring.js`: `scoring_config`, `scoring_config_versions`, `scoring_weights`, `rubric_criteria`, `rubric_levels`, `valid_exhibition_combinations` + alter stores con `exhibiciones_esperadas` + RLS (2026-05-26).
- [x] **[A.0mt.2.5]** ✅ Migración `20260526000007_captures.js`: `daily_captures` con composite FK a stores y scoring_config_versions, sin denormalizaciones legacy + RLS (2026-05-26).
- [x] **[A.0mt.2.9]** ✅ Seeds: `02_mega_dulces_initial_roles.js` (5 roles canónicos: superadmin/admin/supervisor/jefe_marketing/colaborador con permisos completos), `03_mega_dulces_superoot_user.js` (usuario superoot con bcrypt hash de password 'superoot') (2026-05-26).
- [x] **[A.0mt.2.10]** ✅ Test `database/test-newdb-rls-isolation.js`: **16/16 pass**. Suite cubre 7 escenarios — cada tenant ve solo sus zones/roles/users, sin contexto no ve nada, INSERT/UPDATE cross-tenant rechazados, FK cross-tenant rechazada (2026-05-26).

#### A.0mt.3 — Integración NestJS (1 sem) ✅
- [x] **[A.0mt.3.1]** ✅ `TenantContextInterceptor` (`shared/tenant/tenant-context.interceptor.ts`) extrae tenant_id del JWT y abre AsyncLocalStorage. No wireado al AppModule (cutover) (2026-05-26).
- [x] **[A.0mt.3.2]** ✅ `TenantContextService` con `AsyncLocalStorage` nativo (`tenant-context.service.ts`). Propaga {tenantId, userId, username, roleName} via promesas async (2026-05-26).
- [x] **[A.0mt.3.3]** ✅ `TenantKnexService.run()` overload — lee tenant del ALS automáticamente o lo recibe explícito (2026-05-26).
- [x] **[A.0mt.3.4-5]** ✅ `AuthMtService` + controller (`modules/auth-mt/`) — login con `tenant_slug` requerido, JWT con `tenant_id`. Convive con auth legacy (2026-05-26).
- [x] **[A.0mt.3.6]** ✅ `TenantsAdminController` (`modules/tenants-admin/`) — POST/GET/DELETE `/admin/tenants` (2026-05-26).
- [x] **[A.0mt.3.7]** ✅ Test `database/test-newdb-auth-multitenant.js`: **12/12 pass**. Cubre login válido, mismo username en distintos tenants, cross-tenant fails, tenant inactivo, concurrencia real con clientes pg separados (2026-05-26).

#### A.0mt.4 — Migración data legacy → nueva DB ✅
- [x] **[A.0mt.4.1]** ✅ Script `database/migrate-legacy-to-newdb.js` con dry-run + flag `--only=<tabla>` (2026-05-26).
- [x] **[A.0mt.4.2-7]** ✅ 11 tablas migradas en orden topológico de dependencias. Normalización roles (`Jefe_M`→`jefe_marketing`). JSONB con `JSON.stringify()`. Hierarchical insert para catalogs self-FK (2026-05-26).
- [x] **[A.0mt.4.8]** ✅ **1804/1830 rows migrados (98.6%)**. Match perfecto: zones, catalogs, users, brands, products (1225), stores, scoring_*. Faltantes son data sucia legacy: 24 daily_assignments con route_id huérfano, 3 daily_captures con user_id huérfano (2026-05-26).
- [x] **[A.0mt.4.9]** ✅ Reporte en `03_LOG_REVISIONES.md`. Visits/exhibitions/photos NO migrados porque están vacíos en legacy (data vive en daily_captures.exhibiciones JSONB).

#### A.0mt.5 — Cutover (kit listo 🚀, ejecución Railway pendiente)
- [x] **[A.0mt.5.1]** ✅ Runbook completo y **actualizado 2026-05-26** en `docs/IMPLEMENTACION/RUNBOOKS/CUTOVER_NEW_DB.md` con 5 fases + plan de rollback + checklist pre-flight + comandos exactos.
- [x] **[A.0mt.5.2]** ✅ Smoke test API local con `ENABLE_MULTITENANT=true`: `POST /api/auth-mt/login` devuelve JWT con tenant_id correcto. AppModule wirea condicionalmente los módulos multi-tenant sin romper legacy (2026-05-26).
- [x] **[A.0mt.5.2b]** 🚀 **Cutover kit scripts generados** (2026-05-26):
  - `database/cutover-preflight.js` — 8 categorías de validación (env/conectividad/schema/RLS forced/tenant seed/RLS isolation/conteos legacy↔new/migraciones).
  - `database/cutover-smoke-test.js` — auth-mt + commercial + analytics + portal + isolation + latencia.
  - `database/cutover-rollback-check.js` — valida legacy responde post-revert si falla cutover.
  - `docs/IMPLEMENTACION/RUNBOOKS/VALIDACION_VISUAL_PORTAL_VENDOR.md` — checklist 50+ items para validación manual de portal+vendor.
- [ ] **[A.0mt.5.3]** ⏸️ Snapshot final DB legacy — acción manual Railway al cutover
- [ ] **[A.0mt.5.4]** ⏸️ Sync delta — `node database/migrate-legacy-to-newdb.js` justo antes del cutover (idempotente)
- [ ] **[A.0mt.5.5]** ⏸️ Switch `DATABASE_URL` en Railway — acción manual; validar con `cutover-smoke-test.js`
- [ ] **[A.0mt.5.6]** ⏸️ Monitoreo 24h post-cutover — acción manual (Railway logs + Sentry si aplica)
- [ ] **[A.0mt.5.7]** ⏸️ DB legacy → `default_transaction_read_only=true` por 30 días — acción manual

#### Checkpoint A.0-multitenant
- [ ] **[A.0mt.6.1]** ⬜ Toda data Mega Dulces en nueva DB con `tenant_id` poblado
- [ ] **[A.0mt.6.2]** ⬜ API en prod opera contra nueva DB
- [ ] **[A.0mt.6.3]** ⬜ Tests aislamiento pasan en CI
- [ ] **[A.0mt.6.4]** ⬜ ADR-010 actualizado con realidad final
- [ ] **[A.0mt.6.5]** ⬜ Entry cierre en `03_LOG_REVISIONES.md`

**Total Sprint A.0-multitenant: 3-4 sem.** Resuelve automáticamente findings 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.10, 1.11, 1.13 del audit. El resto (backend/frontend/config) se aborda en A.0bis con la nueva DB ya operando.

---

### Sprint A.0bis — Plan correctivo (~5-7 sem)

> **Objetivo:** arreglar los 19 críticos del audit en orden de prioridad. **Ningún feature nuevo hasta cerrar este sprint.**

#### Bloque 1 — Seguridad inmediata (1 sem) ⚠️
- [ ] **[A.0bis.1]** ⚠️ BLOCKED por usuario [Finding 4.1] CORS — **diferido por decisión 2026-05-26**
- [ ] **[A.0bis.2]** ⚠️ BLOCKED por usuario [Finding 4.2] JWT secret fallback — **diferido por decisión 2026-05-26**
- [ ] **[A.0bis.3]** ⚠️ BLOCKED por usuario [Finding 4.3] credenciales `.env` — **diferido por decisión 2026-05-26**
- [x] **[A.0bis.4]** ✅ [Finding 4.5] `npm audit fix` aplicado (sin --force). 68 vulns restantes requieren upgrade major Angular 19 — deferred a sprint dedicado (2026-05-26).
- [x] **[A.0bis.5]** ✅ [Finding 4.4] 8 `console.*` en `visitas-sync.*` reemplazados por NestJS `Logger`. Boot logs en main.ts/database.module.ts permanecen como `console` (apropiado para boot phase) (2026-05-26).
- [x] **[A.0bis.6]** ✅ [Finding 2.3] `catch (e) {}` silencioso en `tasks.service.ts:71` reemplazado por `logger.warn` + `continue` para skip de captura corrupta sin abortar el cron (2026-05-26).

#### Bloque 2 — Cleanup técnico ✅
- [x] **[A.0bis.7]** ✅ [Finding 2.4] **70 archivos `.js` + `.js.map` + `.d.ts` borrados** de `apps/api/src`. `.gitignore` actualizado con `apps/api/src/**/*.js` (2026-05-26).
- [x] **[A.0bis.8]** ✅ [Finding 4.11] Borrados `api-stderr.log`, `api-stdout.log`, `build-error.log` de raíz (2026-05-26).
- [x] **[A.0bis.9]** ✅ [Finding 4.13] `.env.cloudinary` eliminado (las vars ya estaban duplicadas en `.env`) + `.env.cloudinary` + `.env.production` + `.env.staging` agregados a `.gitignore` (2026-05-26).
- [x] **[A.0bis.10]** ✅ [Finding 1.2] Roles snake_case — resuelto por construcción en nueva DB.

#### Bloque 3 — Schema fundamentos ✅ — ABSORBIDO POR A.0-multitenant
- [x] **[A.0bis.11]** ✅ [Finding 1.3] Audit fields a `captures` — resuelto por construcción en nueva DB.
- [x] **[A.0bis.12]** ✅ [Finding 1.4] Audit fields a `visits` — resuelto por construcción en nueva DB.
- [x] **[A.0bis.13]** ✅ [Finding 1.5] Índices en FKs — resuelto por construcción en nueva DB.
- [x] **[A.0bis.14]** ✅ [Finding 1.6] Schemas Zod en `apps/api/src/shared/schemas/jsonb-schemas.ts`: `PermissionsJsonbSchema`, `ExhibicionesJsonbSchema`, `StatsJsonbSchema`, `ScoringConfigJsonbSchema`, `TenantMetadataSchema` + helper `validateJsonb()`. Listos para integrar en serializers cuando se necesite validación stricta (2026-05-26).

#### Bloque 4 — Hardening backend ✅
- [x] **[A.0bis.15]** ✅ [Finding 4.6] **Helmet activado** en `main.ts` con `contentSecurityPolicy: false` (Swagger compat) + `crossOriginEmbedderPolicy: false` (2026-05-26).
- [x] **[A.0bis.16]** ✅ [Finding 4.7] **`@nestjs/throttler` configurado** global en `app.module.ts` con 3 tiers: short (10/s), medium (60/10s), long (200/min). `ThrottlerGuard` como `APP_GUARD` (2026-05-26).
- [x] **[A.0bis.17]** ✅ [Finding 4.8] Body parser limits bajados de 50mb → **2mb global**. Uploads multipart (daily-captures) usan `AnyFilesInterceptor` que no pasa por este middleware (2026-05-26).
- [ ] **[A.0bis.18]** ⏸️ [Finding 4.9] User non-root Dockerfile — **DEFERRED**: requiere refactor de nginx pidfile/logs paths + chown de directorios. Trabajo de 2-3h que se hará en sprint de hardening Railway al cutover.
- [x] **[A.0bis.19]** ✅ [Finding 4.10] **Headers de seguridad en `nginx.conf`**: X-Frame-Options DENY, X-Content-Type-Options nosniff, X-XSS-Protection, Referrer-Policy, Permissions-Policy, HSTS 1año, server_tokens off (2026-05-26).

#### Bloque 5 — Refactor god services ⏸️ DEFERRED (2-3 sem)
- [ ] **[A.0bis.20]** ⏸️ [Finding 2.1a] Dividir `reports.service.ts` (1399 LOC) en `ReportsDataCalculator` + `MetricsAggregator` + `ScopeResolver`. **Sprint dedicado post-cutover Railway.**
- [ ] **[A.0bis.21]** ⏸️ [Finding 2.1b] Dividir `catalogs.service.ts` (788 LOC).
- [ ] **[A.0bis.22]** ⏸️ [Finding 3.1] Dividir `reports.component.ts` (3047 LOC).
- [ ] **[A.0bis.23]** ⏸️ [Finding 3.2] Dividir `daily-capture.service.ts` (806 LOC) front.

#### Checkpoint A.0bis
- [ ] **[A.0bis.24]** Validar todos los críticos resueltos en staging
- [ ] **[A.0bis.25]** Audit de seguimiento (`AUDITORIA_BASE_POST_FIX.md`) — opcional
- [ ] **[A.0bis.26]** Entry de cierre en `03_LOG_REVISIONES.md`

**Total Sprint A.0bis: 5-7 semanas para 1 dev.**

> Una vez cerrado este sprint, los items A.0 originales (limpieza inmediata) están YA absorbidos. Pasar directo a Sprint A.1 (Observabilidad).

---

### Sprint A.0 — Limpieza inmediata (~3 días)
- [ ] **[A.0.1]** Borrar archivos `.js` duplicados al lado de `.ts` en `apps/api/src/**`
- [ ] **[A.0.2]** Agregar `**/*.js` al `.gitignore` de `apps/api/`
- [ ] **[A.0.3]** Documentar versión de Node, npm, Nx en `README.md`
- [ ] **[A.0.4]** Iniciar trámite de WhatsApp Business verification con BSP (360dialog/Wati)

### Sprint A.1 — Observabilidad (~1 sem)
- [ ] **[A.1.1]** Crear cuenta Sentry, capturar DSN
- [ ] **[A.1.2]** Instalar `@sentry/nestjs` + configurar en `main.ts`
- [ ] **[A.1.3]** Instalar `@sentry/angular` + configurar en `apps/view`
- [ ] **[A.1.4]** Validar que un throw deliberado aparece en Sentry
- [ ] **[A.1.5]** Reemplazar `console.log` por `Logger` de NestJS donde aún no se usa
- [ ] **[A.1.6]** Instalar `pino` + `nestjs-pino` con formato JSON estructurado
- [ ] **[A.1.7]** Logs en producción a STDOUT en JSON (Railway los captura)

### Sprint A.2 — Staging + CI (~1 sem)
- [ ] **[A.2.1]** Crear branch `staging` en GitHub
- [ ] **[A.2.2]** Crear servicio staging en Railway desde branch `staging`
- [ ] **[A.2.3]** Variables de entorno separadas para staging (DB, Cloudinary, etc.)
- [ ] **[A.2.4]** Crear `.github/workflows/ci.yml` con: lint + typecheck + test + build
- [ ] **[A.2.5]** Configurar branch protection en `main`: PRs requeridos, CI verde
- [ ] **[A.2.6]** Workflow staging → manual promote a main

### Sprint A.3 — Tests base (~1 sem)
- [ ] **[A.3.1]** Setup Jest para `apps/api` (probablemente ya configurado por Nx — validar)
- [ ] **[A.3.2]** Escribir tests para `permissions-cache.service` (cache hit/miss/invalidation)
- [ ] **[A.3.3]** Escribir tests para `roles.guard` (allow/deny por permiso)
- [ ] **[A.3.4]** Escribir tests para `scoring-v2.service` (cálculo de score)
- [ ] **[A.3.5]** Setup Cypress (e2e) para `apps/view` con 1 test smoke (login)

### Sprint A.4 — Redis + BullMQ (~1 sem)
- [ ] **[A.4.1]** Agregar servicio Redis en Railway
- [ ] **[A.4.2]** Instalar `@nestjs/bullmq` + dependencias
- [ ] **[A.4.3]** Crear `apps/api/src/shared/queue/queue.module.ts` global
- [ ] **[A.4.4]** Primera queue: `emails` con worker (aunque no envíe nada aún, validar flow)
- [ ] **[A.4.5]** Health check de conexión Redis al boot del API

### Sprint A.5 — Tipos compartidos (~3 días)
- [ ] **[A.5.1]** Crear `libs/shared-domain-types` con `nx g @nx/js:library`
- [ ] **[A.5.2]** Mover interfaces compartidas (User, Permission, Visit, etc.) a la lib
- [ ] **[A.5.3]** Actualizar imports en `apps/api` y `apps/view` para usar la lib
- [ ] **[A.5.4]** Validar que el build sigue verde tras la refactorización

### Sprint A.6 — Multi-tenancy decisión (~3 días)
- [ ] **[A.6.1]** Decisión documentada en ADR-001: ¿multi-tenant o single-tenant?
- [ ] **[A.6.2]** Si multi-tenant: planear migración de tablas (no ejecutar todavía)

### Sprint A.7 — Cleanup y verificación final (~3 días)
- [ ] **[A.7.1]** Smoke test completo de la app en staging
- [ ] **[A.7.2]** Comprobar que Sentry reporta errores reales
- [ ] **[A.7.3]** Comprobar que CI bloquea PR con tests rotos
- [ ] **[A.7.4]** Documentar setup completo en `README.md`
- [ ] **[A.7.5]** Checkpoint Fase A → cerrar en `03_LOG_REVISIONES.md`

**Total Sprint A: ~5-7 semanas para 1 dev.**

---

## 📋 BACKLOG — Fase B: Core Comercial (construido desde cero)

> **Pivot 2026-05-26:** Kepler ERP no existe. Construimos el core comercial directamente sobre `commercial.*`. Cuando aparezca un ERP externo se integra via FDW o sync nocturno hacia estas mismas tablas. Detalles en `FASES/FASE_B_COMERCIAL_CORE.md`. Kepler doc original deferred.

### Sprint B.0 — Schema comercial base ✅ (2026-05-26)
- [x] **[B.0.1]** ✅ Migración `commercial.customers` + `commercial.warehouses` con composite FKs + RLS forzado (2026-05-26).
- [x] **[B.0.2]** ✅ Migración `commercial.price_lists` + `commercial.product_prices` (FK cross-schema a `public.products`, tax_rate por producto) (2026-05-26).
- [x] **[B.0.3]** ✅ Migración `commercial.stock` + `commercial.stock_movements` (UNIQUE wh+product, bitácora append-only, CHECK constraints) (2026-05-26).
- [x] **[B.0.4]** ✅ Migración `commercial.orders` + `order_lines` + `payments` con CHECK `payment_method='cash'` (beta only). FK cross-schema a `public.users` + `public.products` (2026-05-26).
- [x] **[B.0.5]** ✅ Seed baseline Mega Dulces: warehouse `MD-CENTRAL` (default), price_list `BASE-MXN` (default), customer `DEMO-001` (2026-05-26).
- [x] **[B.0.6]** ✅ Smoke test RLS en schema `commercial.*`: 0 rows sin contexto / 1 row con tenant ctx / 0 rows con fake tenant (2026-05-26).

### Sprint B.1 — Módulos NestJS comerciales ✅ (2026-05-26)
- [x] **[B.1.1]** ✅ Módulo `commercial-customers` con CRUD completo (create, list paginado + search, get, patch, soft-delete). Validaciones: code regex, RFC MX regex, UUIDs, Zod address (2026-05-26).
- [x] **[B.1.2]** ✅ Módulo `commercial-warehouses` con CRUD + flag `is_default` exclusivo (auto-clearing) + protección al borrar único default (2026-05-26).
- [x] **[B.1.3]** ✅ Módulo `commercial-pricing`: CRUD `price_lists` + bulk upsert `product_prices` (hasta 1000 items) + endpoint `GET /api/commercial/products/:id/price?customer_id=X` con fallback customer→tenant default (2026-05-26).
- [x] **[B.1.4]** ✅ Módulo `commercial-inventory`: stock read (paginado + per-product), movement con lock pesimista `FOR UPDATE` (anti-race en reservas), state-machine de tipos (in/out/adjust/reserve/release/sale), ajuste a saldo absoluto, bitácora paginada con filtros (2026-05-26).
- [x] **[B.1.5]** ✅ Permissions enum extendido con 14 permisos comerciales (customers/warehouses/pricing/inventory/orders/payments). Seed roles actualizado: superadmin/admin todo, supervisor lectura+confirmar/cancelar, jefe_marketing solo lectura, colaborador toma pedidos + cobros (2026-05-26).
- [x] **[B.1.6]** ✅ Zod `AddressJsonbSchema` agregado (calle, número ext/int, colonia, CP MX 5 dígitos, lat/lng opcionales) en `jsonb-schemas.ts`. Helper `validateJsonb()` reutilizado (2026-05-26).
- [x] **[B.1.7]** ✅ `TenantKnexService` registrado como provider exportado por `NewDatabaseModule` (antes solo era clase sin DI). Todos los services comerciales lo inyectan (2026-05-26).
- [x] **[B.1.8]** ✅ 4 módulos wireados en `AppModule` dentro del toggle `ENABLE_MULTITENANT=true`. Build pasa (warnings preexistentes de `export interface` no afectan runtime). Smoke test end-to-end OK (2026-05-26).

### Sprint B.2 — Módulo de pedidos ✅ (2026-05-26) — sin payments en beta
> **Scope reducido 2026-05-26**: PaymentsService deferred. Beta = se toma pedido, se confirma, se entrega, pero el cobro NO se registra en sistema (la tabla `commercial.payments` queda lista para cuando se active).

- [x] **[B.2.1]** ✅ `CommercialOrdersService` con state machine: `draft → confirmed → fulfilled` / `draft|confirmed → cancelled`. Validaciones de transición con `ConflictException` en transitions inválidos (2026-05-26).
- [x] **[B.2.2]** ✅ Reserva de stock inline al confirmar (`SELECT ... FOR UPDATE` + `reserve` movement). Consumo al fulfill (`sale` movement decrementa `quantity` y `reserved_quantity` atómicamente). Operan en la **misma trx** del confirm/fulfill para mantener atomicidad (2026-05-26).
- [x] **[B.2.3]** ✅ Liberación de reservas al cancel desde confirmed (`release` movement). Cancel desde draft no requiere liberación (no había reserva). Cancel desde fulfilled rechazado (requiere flujo de devolución, fuera de scope) (2026-05-26).
- [x] **[B.2.4]** ✅ `commercial.order_sequences (tenant_id, year)` con `current_value`, UPSERT atómico via `ON CONFLICT DO UPDATE` Postgres. Genera `PD-{year}-{NNNNN}` zero-padded. RLS forzado (2026-05-26).
- [x] **[B.2.5]** ✅ `addLine` resuelve precio via `pricing.resolvePriceForCustomer()` (con fallback customer→tenant default). Snapshot `unit_price`/`tax_rate`/`discount_percent`. Cálculo `line_subtotal = qty * unit_price * (1 - discount)`, `line_tax`, `line_total`. Recálculo de `orders.subtotal/tax_total/total/balance_due` tras cada cambio de línea (2026-05-26).
- [x] **[B.2.6]** ✅ Smoke test end-to-end `database/test-newdb-orders-flow.js`: setup stock 200 → create draft PD-2026-00001 → add line (qty 10) → confirm (reserve 10) → fulfill (sale 10) → stock final 190. Movements verificados: `reserve:10 → sale:10` (2026-05-26).
- [x] **[B.2.7]** ✅ Módulo `commercial-orders` wireado en AppModule. Build OK. Endpoints: `POST /api/commercial/orders`, `POST/:id/lines`, `PATCH/:id/lines/:line_id`, `DELETE/:id/lines/:line_id`, `POST/:id/confirm`, `POST/:id/fulfill`, `POST/:id/cancel`, `GET/:id`, `GET /` (paginado + filtros) (2026-05-26).
- [ ] **[B.2.8]** ⏸️ DEFERRED **post-beta**: `PaymentsService` cash + actualización `paid_amount`/`balance_due` real. Tabla `commercial.payments` queda en DB esperando.

### Sprint B.3 — Importer y checkpoint
- [x] **[B.3.1]** ✅ CLI `database/importers/commercial_import.js` con 6 types (customers, brands, products, prices, warehouses, stock) + dry-run + idempotente. Lookup por nombre natural (brand_nombre/product_nombre) en vez de UUIDs. Examples JSON + README en `database/importers/` (2026-05-26).
- [x] **[B.3.2]** ✅ Carga de **test data** (beta sin data real todavía): 5 brands + 25 products + 25 prices + 20 customers + 25 stock entries en `database/importers/testdata/*.json`. 100 rows upserted en 6 corridas del CLI. Smoke test E2E: pedido PD-2026-00002 con 4 líneas → total $3,971.84 → stock decrementado correctamente en las 4 (2026-05-26). **Cuando Edgar tenga data real**, reemplazar los archivos en `testdata/` por los reales y re-correr el importer (idempotente).
- [x] **[B.3.3]** ✅ Entry de cierre en `03_LOG_REVISIONES.md` (2026-05-26).

**Total Sprint B: ~4-5 semanas.**

---

## 📋 BACKLOG — Fase C: Sales Intelligence ampliado

> Detalles en `FASES/FASE_C_SALES_INTELLIGENCE.md`.

### Sprint C.0 — Analytics core comercial ✅ (2026-05-26)
> **Pivot 2026-05-26**: El plan original (`exhibition_products` normalization) requiere flujo de capturas activo y data real de exhibiciones. Para arrancar Fase C con valor inmediato, sprint C.0 redefinido como **analytics core sobre commercial.*** (data que YA tenemos). El modelo exhibition_products se hace cuando haya volumen de exhibiciones (sprint C.0bis futuro).

- [x] **[C.0.1]** ✅ Módulo `commercial-analytics` con 7 endpoints:
  - `GET /api/commercial/analytics/overview?from=&to=` — revenue gross/net/tax, pedidos por estado, units, AOV, clientes únicos.
  - `GET /api/commercial/analytics/top-customers?limit=` — ranking por revenue + orders_count + last_order_at.
  - `GET /api/commercial/analytics/top-products?limit=&orderBy=units|revenue` — ranking SKU.
  - `GET /api/commercial/analytics/inactive-customers?days=N` — customers activos sin pedido en N días.
  - `GET /api/commercial/analytics/sales-by-brand` — revenue + units + share % por brand.
  - `GET /api/commercial/analytics/low-stock?threshold=N&warehouse_id=` — productos bajo umbral disponible.
  - `GET /api/commercial/analytics/daily-series` — series diarias para gráficos (TZ MX).
- [x] **[C.0.2]** ✅ Queries usan solo pedidos `status='fulfilled'` para revenue real. Considera RLS automáticamente. Pipeline (confirmed) y draft separados en overview.
- [x] **[C.0.3]** ✅ Validación de date range con `BadRequestException` (400) cuando ISO inválido. Limits clampeados (`limit` máx 100, `days` máx 365, `threshold` >= 0).
- [x] **[C.0.4]** ✅ HTTP smoke test `database/http-analytics-test.js`: 23/23 pasaron. Validado contra testdata real: revenue $4,244.32 / 3 pedidos / Top Dulces Típicos 39% share / 5 productos low-stock detectados.

### Sprint C.1 — Capa analítica (materialized views) ✅ (2026-05-26)
> **Pivot vs plan original**: las tablas `daily_mix_depth_by_store` y `weekly_top_underperformers` requieren exhibition data — diferidas a C.0bis. Sprint C.1 reorientado a **materialized views comerciales** que dan valor con la data que tenemos. BullMQ no necesario por ahora (cron de @nestjs/schedule cada 15 min es suficiente para volumen actual).

- [x] **[C.1.1]** ✅ Schema `analytics.*` creado con grants para `app_runtime` (migración `100006`). RLS no soportado en MVs directamente → service filtra `tenant_id` explícitamente. Defense in depth: app_runtime solo tiene SELECT, refresh corre como postgres (2026-05-26).
- [x] **[C.1.2]** ✅ 3 MVs creadas con UNIQUE indexes para REFRESH CONCURRENTLY:
  - `mv_sales_overview_30d` — KPIs rolling 30d por tenant (revenue/orders/units/customers).
  - `mv_top_customers_30d` — top 50 customers por revenue con `rank` pre-calculado.
  - `mv_top_products_30d` — top 50 productos con `rank_by_units` y `rank_by_revenue` (window functions).
- [x] **[C.1.3]** ✅ `AnalyticsRefreshService` con `@Cron('0 */15 * * * *')` (cada 15 min) + método manual `refreshAll()`. Usa `KNEX_NEW_DB_ADMIN` (postgres user) porque `REFRESH MATERIALIZED VIEW` es owner-only. Flag `isRefreshing` previene corridas overlapping (2026-05-26).
- [x] **[C.1.4]** ✅ Endpoint `POST /api/commercial/analytics/refresh` (admin manual). Devuelve `{refreshed_at, results: [{mv, ok, ms}]}`.
- [x] **[C.1.5]** ✅ Refactor `CommercialAnalyticsService`: `overview`/`top-customers`/`top-products` leen de MVs por default. Query param `?live=true` o `?from=/?to=` fuerza on-the-fly aggregation. Otros endpoints (inactive-customers/sales-by-brand/low-stock/daily-series) siguen on-the-fly (no se benefician de materialización) (2026-05-26).
- [x] **[C.1.6]** ✅ Provider `KNEX_NEW_DB_ADMIN` en `NewDatabaseModule` con pool min:0 max:2 (solo para mantenimiento, no high-traffic).
- [x] **[C.1.7]** ✅ HTTP smoke `database/http-analytics-mv-test.js`: 21/21 pasaron. Validado: source=mv default, source=live con override, MV y live coinciden en revenue/customer_id, refresh manual 85ms total, refreshed_at avanza, tenant 2 nuevo NO ve data en MVs (filter explícito funciona) (2026-05-26).

### Sprint C.2 — Endpoints Command Center (~1 sem)
- [ ] **[C.2.1]** `GET /command-center/mix-depth`
- [ ] **[C.2.2]** `GET /command-center/underperformers`
- [ ] **[C.2.3]** `GET /command-center/heatmap` (zonas con score actual)

### Sprint C.3 — Frontend Command Center (MVP) 🟡 (parcial 2026-05-26)
> **Scope reducido para MVP**: skip mapa Leaflet + drill-down detallado. Foco en dashboards comerciales consumiendo los 10 endpoints C.0+C.1.

- [x] **[C.3.1]** ✅ Módulo `apps/view/src/app/modules/dashboard/command-center/` standalone component con PrimeNG: Card, Table, Skeleton, Tag, ProgressBar (2026-05-26).
- [x] **[C.3.2]** ✅ `CommandCenterService` Angular consumiendo 7 endpoints analytics: overview, top-customers, top-products, sales-by-brand, low-stock, inactive-customers, refresh (2026-05-26).
- [x] **[C.3.3]** ✅ 6 widgets en grid responsive:
  - 4 KPI cards (revenue gross, pedidos fulfilled, pipeline, clientes únicos).
  - Top customers table (#rank, nombre, pedidos, revenue).
  - Top products table (#rank, producto, units, revenue).
  - Sales by brand (progress bars con share%).
  - Low stock alerts (avail con color severity).
  - Inactive customers (días sin compra).
- [x] **[C.3.4]** ✅ Botón "Refresh MVs" dispara `POST /commercial/analytics/refresh` + recarga widgets. Toast de éxito con elapsed ms (2026-05-26).
- [x] **[C.3.5]** ✅ Ruta `/dashboard/command-center` con `permissionGuard(COMMERCIAL_ORDERS_VER)` + nav item con icono `pi pi-compass` (2026-05-26).
- [x] **[C.3.6]** ✅ Permission enum frontend extendido con 14 permisos commercial (sync con backend) (2026-05-26).
- [x] **[C.3.7]** ✅ `nx build view` pasa (chunk-CWBIR6O5.js generado, lazy-loaded). 11 warnings preexistentes NG8107 (optional chain `?.`) sin impacto runtime (2026-05-26).
- [ ] **[C.3.8]** ⬜ DEFERRED: Mapa Leaflet con tiendas heatmapped — requiere data de stores con lat/lng + agregación por zona.
- [ ] **[C.3.9]** ⬜ DEFERRED: Drill-down zona → ruta → tienda → última visita — requiere cruce visitas+pedidos.
- [ ] **[C.3.10]** ⬜ TODO: verificación visual manual en browser (no automatizable desde CLI).

### Sprint C.4 — Alertas WS realtime ✅ (2026-05-26)
- [x] **[C.4.1]** ✅ `AlertsGateway` con namespace `/alerts` (path `/reports/socket.io`). JWT auth en handshake (auth.token preferido, fallback header Authorization Bearer, fallback query token). Cliente sin auth o JWT inválido → emite `auth_error` + `disconnect(true)`. Cada socket válido se une a room `tenant:<tenant_id>` automáticamente (2026-05-26).
- [x] **[C.4.2]** ✅ `AlertsService` con 6 builder methods tipados: `emitLargeOrder`, `emitOrderConfirmed`, `emitOrderFulfilled`, `emitLowStock`, `emitVipInactive`, `emitTest`. Cada uno construye payload `{type, severity, title, message, data, emitted_at}` consistente y emite via `server.to(room).emit('alert', ...)` (2026-05-26).
- [x] **[C.4.3]** ✅ `AlertsScannerService` con `@Cron('0 */5 * * * *')` cada 5 min. Itera tenants activos, setea contexto, escanea: (a) `low_stock_critical` cuando `available < 50`; (b) `vip_inactive` cuando credit_limit >= $15k sin pedido en 14d. Cooldown in-memory 1h por (tenant, alert_key) anti-spam. Flag `isRunning` evita overlapping (2026-05-26).
- [x] **[C.4.4]** ✅ Hook `OrdersService.confirm()`: emite `order_confirmed` + chequea `large_order` (>$3k). `OrdersService.fulfill()`: emite `order_fulfilled`. Customer name resuelto desde DB para payload self-contained (2026-05-26).
- [x] **[C.4.5]** ✅ `AlertsController` con `POST /commercial/alerts/test` (trigger manual al tenant del JWT), `POST /commercial/alerts/scan-now` (admin: dispara scanner + reset cooldown), `GET /commercial/alerts/stats` (sockets conectados por tenant) (2026-05-26).
- [x] **[C.4.6]** ✅ Frontend `AlertsSocketService` (`apps/view/.../command-center/`): socket.io-client connect on-demand con JWT del AuthService, listener `alert` event, expone `connected` signal + `alert$` Subject. Connect en `ngOnInit`, disconnect en `ngOnDestroy` (2026-05-26).
- [x] **[C.4.7]** ✅ Command Center extendido: tag "● realtime" / "○ offline" en header. Toast por alert recibida con severity mapping (info/warn/critical → info/warn/error). Feed visual con últimas 20 alerts, severity tag, title, message, hora HH:MM:SS (2026-05-26).
- [x] **[C.4.8]** ✅ Builds limpios api + view. Bundle WS client incluido en chunk lazy-loaded del command-center (2026-05-26).
- [x] **[C.4.9]** ✅ Smoke E2E 18/18: 2 tenants WS connect + aislamiento (tenant 2 NO recibe alert disparada en tenant 1), JWT inválido rechazado con auth_error + disconnect, order_confirmed + large_order emitidos al confirmar pedido $4.5k, order_fulfilled emitido al fulfill, scanner manual emitió 6 alerts low_stock, stats devuelve total_sockets correcto (2026-05-26).

### Sprint C.5 — Checkpoint Fase C ✅ (2026-05-26)
- [x] **[C.5.1]** ✅ Regression suite `database/run-all-tests.js` ejecutada: **10/10 suites verde** (A.0mt.1 + A.0mt.2 + A.0mt.3 + B.2 + B.3.2 + B.1 HTTP + B isolation + C.0 + C.1 + C.4) — total ~9.3s. Tests idempotentes (HTTP customer code timestamp-based + MV pre-refresh + stock replenish en alerts test) (2026-05-26).
- [x] **[C.5.2]** ✅ Entry de cierre en `03_LOG_REVISIONES.md` con resumen completo de Fase C (2026-05-26).
- [ ] **[C.5.3]** ⬜ Validación visual manual del Command Center con alerts realtime en browser — requiere Edgar abrir http://localhost:4200.

**Total Sprint C: ~3 sesiones (en lugar de 6-8 semanas estimadas originales).** Pivot redujo scope: skip exhibition_products (C.0bis cuando haya data), Leaflet map (C.3.8 deferred), drill-down (C.3.9 deferred). Lo cumplido cubre lo crítico: analytics core + MVs cacheadas + frontend dashboard + alerts realtime.

---

## 📋 BACKLOG — Fase D: Catálogo + Pedidos + Portal B2B

> Detalle en `FASES/FASE_D_CATALOGO_PORTAL_B2B.md`.

### Sprint D.0 — Dominio comercial ✅ ABSORBIDO por Fase B (2026-05-26)
> Todas las tablas planeadas para D.0 (`products`, `price_lists`, `customers`) ya existen desde Fase B (`commercial.*` schema + 9 tablas). Sync Kepler no aplica (no existe). Endpoints CRUD admin ya operativos. Rol `customer_b2b` agregado en D.1.

- [x] **[D.0.1]** ✅ Tablas: ya existen en `commercial.*` (Fase B.0).
- [x] **[D.0.2]** ✅ N/A — Kepler no existe (pivot 2026-05-26).
- [x] **[D.0.3]** ✅ Endpoints CRUD admin: ya operativos (commercial-customers/warehouses/pricing/inventory/orders).
- [x] **[D.0.4]** ✅ Rol `customer_b2b` agregado en seed `02_mega_dulces_initial_roles.js` (ver D.1.2).

### Sprint D.1 — Pedidos B2B + audit trail ✅ (2026-05-26)
> Scope MVP: el "carrito" persistente ES `orders.status='draft'` (ya implementado en B.2 con state machine). Lo que faltaba: linkear users con customers para portal, audit trail completo, endpoints customer-scoped.

- [x] **[D.1.1]** ✅ Migración `20260526100007_users_customer_link_and_order_history.js`:
  - `ALTER public.users ADD customer_id UUID NULL` + composite FK `(tenant_id, customer_id)` → `commercial.customers`. Partial index on `customer_id IS NOT NULL`.
  - `CREATE commercial.order_status_history (tenant_id, order_id, from_status, to_status, changed_by, changed_by_username snapshot, reason, snapshot JSONB, changed_at)` + RLS forzado + CHECK constraints sobre statuses válidos (2026-05-26).
- [x] **[D.1.2]** ✅ Rol `customer_b2b` en seed `02_mega_dulces_initial_roles.js`: perms scoped (CUSTOMERS_VER + PRICING_VER + INVENTORY_VER + ORDERS_VER/CREAR/CANCELAR). NO ve trade marketing data ni admin (2026-05-26).
- [x] **[D.1.3]** ✅ Seed `05_mega_dulces_demo_customer_user.js`: crea customer `TST-PORTAL-001` + user `cliente_demo` / `cliente_demo` con `customer_id` linkeado y `role_name='customer_b2b'`. Idempotente (2026-05-26).
- [x] **[D.1.4]** ✅ `OrdersService.recordHistory()` privado: inserta en `order_status_history` con snapshot de totals/balance. Llamado en createDraft (null→draft), confirm (draft→confirmed), fulfill (confirmed→fulfilled), cancel (*→cancelled con reason) (2026-05-26).
- [x] **[D.1.5]** ✅ Endpoints:
  - `GET /api/commercial/orders/my` — scope automático al customer del JWT (rechaza si user sin customer_id linkeado).
  - `GET /api/commercial/orders/:id/history` — devuelve audit trail ordenado cronológicamente con changed_by_username + reason + snapshot (2026-05-26).
- [x] **[D.1.6]** ✅ Reserva de stock ya implementada en B.2 (`FOR UPDATE` + state machine + movements).
- [ ] **[D.1.7]** ⬜ DEFERRED: resolución de conflictos en sync offline — requiere D.2 (app mobile) primero.
- [x] **[D.1.8]** ✅ HTTP smoke `database/http-portal-b2b-test.js` — 20/20: login cliente_demo + role customer_b2b en JWT, GET /my devuelve 0 inicial, admin ve TODOS, cliente crea draft + addLine + confirm + fulfill, GET /my devuelve 1, GET /history devuelve 3 transitions exactas (null→draft / draft→confirmed / confirmed→fulfilled), changed_by_username poblado, scope /my correctamente filtrado (2026-05-26).

### Sprint D.2 — App de vendedor (modo pedido) ✅ MVP (2026-05-26)
> Scope reducido: extender `apps/view` con rutas `/vendor/*` mobile-first (ADR-005 aceptado). Sin app RN separada. Carrito offline real (Dexie sync queue) deferred — esta sesión solo flujo online. Búsqueda client-side por catálogo pequeño.

- [x] **[D.2.1]** ✅ **ADR-005 aceptado**: extender `apps/view` (Capacitor + Angular + Dexie ya configurados). No app RN. Documentado en `02_DECISIONES_ARQUITECTURA.md` con razonamiento + reversibilidad (2026-05-26).
- [x] **[D.2.2]** ✅ Módulo `vendor/` con 3 páginas standalone:
  - **VendorCustomersComponent** (`/vendor/customers`): lista de cards tappables con search debounced 250ms. Muestra nombre, código, teléfono, crédito.
  - **VendorTakeOrderComponent** (`/vendor/take-order/:id`): flujo combinado — header con customer, banner sticky del carrito (productos + units + total + scroll-to-cart), input search client-side, lista de productos con InputNumber + botón "+" para agregar, sección carrito al fondo con líneas editables + totales + acciones (cancelar / confirmar con dialog).
  - **VendorTodayComponent** (`/vendor/today`): "mi día" con 3 KPI cards (pedidos / revenue / entregados) + lista de pedidos tomados hoy (2026-05-26).
- [ ] **[D.2.3]** ⏸️ DEFERRED post-beta: carrito offline real con Dexie sync queue. Por ahora todas las operaciones requieren conexión. Cache de lectura puede agregarse después extendiendo `offline-database.service.ts` existente.
- [x] **[D.2.4]** ✅ Catálogo + búsqueda implementado con `computed()` signal y filter case-insensitive sobre `product_name`. Productos con SU precio via `VendorService.catalogForCustomer()` (mira `default_price_list_id` o tenant default) (2026-05-26).
- [x] **[D.2.5]** ✅ **VendorShellComponent** mobile-first: header sticky compacto + bottom nav nativo-style (Clientes / Mi día). Toast top-center. Max-width 800px, padding adaptable (2026-05-26).
- [x] **[D.2.6]** ✅ **VendorService**: wrapper completo (listCustomers con search, getCustomer, catalogForCustomer, draftForCustomer, ensureDraftForCustomer, addLine/update/remove/confirm/cancel, myOrdersToday, defaultWarehouseId). Reusa PortalService para overlaps (2026-05-26).
- [x] **[D.2.7]** ✅ **vendorGuard**: requiere auth + role distinto de `customer_b2b`. Permite colaborador/supervisor/admin/superadmin (2026-05-26).
- [x] **[D.2.8]** ✅ Rutas `/vendor/*` lazy-loaded. Nav item "Modo Vendedor" en admin layout (pi-briefcase, gateado por COMMERCIAL_ORDERS_CREAR) (2026-05-26).
- [x] **[D.2.9]** ✅ `nx build view` OK. Chunks lazy-loaded del vendor module (2026-05-26).
- [ ] **[D.2.10]** ⬜ TODO: verificación visual manual en dispositivo mobile o Chrome DevTools mobile emulation.

### Sprint D.3 — Portal web B2B ✅ MVP (2026-05-26)
> **Scope decision**: en vez de `apps/b2b-portal` separado (que duplica deploy + build + dependencies), agregar **rutas `/portal/*`** dentro de `apps/view` con shell propio sin sidebar. Más simple para MVP. Refactor a app separada queda para post-beta si justifica.

- [ ] **[D.3.1]** ⏸️ DEFERRED post-beta: app Angular separada `apps/b2b-portal`. MVP usa rutas `/portal/*` en `apps/view`.
- [x] **[D.3.2]** ✅ `PortalLoginComponent` en `/portal/login`: form con tenant_slug + username + password. Llama `AuthService.loginMt()` (nuevo método agregado, POST a `/api/auth-mt/login`). Tras éxito valida `role_name === 'customer_b2b'` (rechaza otros roles con logout automático), navega a `/portal/catalog`. Mensajes de error en español (2026-05-26).
- [x] **[D.3.3]** ✅ Catálogo + carrito + checkout:
  - **`PortalCatalogComponent`** (`/portal/catalog`): tabla de productos con SU precio (resuelve `default_price_list_id` del customer, fallback a la default del tenant), input numérico por producto, botón "Agregar al carrito". Validación de cantidad mínima del precio.
  - **`PortalCartComponent`** (`/portal/cart`): muestra draft activo (= carrito) con líneas editables (qty up/down + remove), totales sumados (subtotal/IVA/total), botón "Confirmar pedido" con confirmDialog → llama `POST /orders/:id/confirm`. Tras confirm, navega a `/portal/orders/:id`. Botón "Vaciar carrito" cancela el draft.
  - **`PortalService`**: helper `ensureDraft(customerId, warehouseId)` que reusa el draft activo o crea uno nuevo (atómico desde el flujo del cliente — sin necesidad de endpoint backend nuevo) (2026-05-26).
- [x] **[D.3.4]** ✅ Historial:
  - **`PortalOrdersComponent`** (`/portal/orders`): tabla con SUS pedidos (status tag + fecha + totales + link al detalle). Empty state con icono.
  - **`PortalOrderDetailComponent`** (`/portal/orders/:id`): grid 2 columnas — izquierda líneas del pedido con totales (subtotal/IVA/total + balance_due en naranja si pendiente), derecha **timeline visual del historial** (dots de colores por estado: warn/info/success/danger, transición from→to, changed_by_username, reason). Llama 2 endpoints en paralelo via `forkJoin` (2026-05-26).
- [x] **[D.3.5]** ✅ `PortalShellComponent` standalone con header propio: brand + nav (Catálogo / Carrito / Mis pedidos) + username + logout. Sin sidebar admin. CSS minimalista. Layout responsive (2026-05-26).
- [x] **[D.3.6]** ✅ `customerB2bGuard` (`apps/view/.../portal/portal.guard.ts`): si no autenticado → `/portal/login`; si autenticado pero role distinto → `/dashboard`. Aplicado a `/portal/*` (excepto login que es pública) (2026-05-26).
- [x] **[D.3.7]** ✅ `AuthService.loginMt(payload)` agregado: POST a `/auth-mt/login` con tenant_slug, reusa `setSession()` privado para escribir cookie + signal + cargar permisos. Coexiste con `login()` legacy (2026-05-26).
- [x] **[D.3.8]** ✅ Routes `/portal/*` lazy-loaded via `loadComponent` en `app.routes.ts`. 5 componentes en chunks separados. `nx build view` OK — bundles generados (chunk-ETPZCSPF, IP33G25Q, PEDKQFVF, QSDLT3YY) (2026-05-26).
- [ ] **[D.3.9]** ⬜ TODO: verificación visual manual del flujo completo en browser (no automatizable desde CLI).

### Sprint D.4 — Canasta estratégica v1 ✅ (2026-05-26)
- [x] **[D.4.1]** ✅ Tabla `commercial.recommended_baskets` (1 row por customer, items JSONB, category_counts JSONB, computed_at). UNIQUE (tenant_id, customer_id) para UPSERT. RLS forzado. FK composite a `commercial.customers` con CASCADE. Migración `100008` (2026-05-26).
- [x] **[D.4.2]** ✅ Las **4 categorías** implementadas como heurísticas en `RecommendationsService.computeForCustomer()`:
  - **base** — top 5 productos del customer últimos 90 días (units desc).
  - **focus** — top 5 productos del tenant últimos 30 días que el customer NO compra.
  - **exploration** — hasta 5 SKUs de las brands que ya compra, ordenados por puntuación.
  - **innovation** — hasta 3 productos creados en los últimos 30 días.
  - Cada item con `score 0..1`, `reason` humano-legible, `sample_price` (de la price-list del customer o default del tenant) (2026-05-26).
- [x] **[D.4.3]** ✅ Endpoints REST:
  - `GET /api/commercial/recommendations/my` — canasta del customer del JWT (Portal B2B). Recomputa si stale (>24h).
  - `GET /api/commercial/recommendations/:customer_id` — admin lookup directo. Mismo lazy-refresh.
  - `POST /api/commercial/recommendations/:customer_id/compute` — fuerza recómputo + UPSERT.
  - `POST /api/commercial/recommendations/refresh-all` — trigger manual del cron nightly (todos los customers de todos los tenants) (2026-05-26).
- [x] **[D.4.4]** ✅ `RecommendationsRefreshService` con `@Cron('0 0 9 * * *')` (9 AM UTC = 3 AM MX). Itera tenants activos + customers activos. Helper privado `computeWithTenantContext()` abre scope CLS para invocar el service fuera de un request handler. Flag `isRunning` previene overlapping (2026-05-26).
- [x] **[D.4.5]** ✅ Frontend portal: nueva página `/portal/recommendations` con `PortalRecommendationsComponent`. Header con título + total + fecha. 4 secciones por categoría con icon (star/bullseye/compass/sparkles) + descripción + tag severity. Grid de cards por item con brand, score%, nombre, reason, precio, botón "Ver" (navega al catalog). Empty state si total=0. Lazy-loaded en `app.routes.ts`. Nav item "Sugeridos" en `PortalShellComponent` (2026-05-26).
- [x] **[D.4.6]** ✅ HTTP smoke `database/http-recommendations-test.js` — 21/21: POST /compute genera 12 items (1 base + 5 focus + 3 exploration + 3 innovation) para `TST-PORTAL-001`. Item structure correcta (product_id + name + category válida + score 0..1 + reason + sample_price). GET /my devuelve los mismos. GET /:customer_id desde admin idem. Refresh-all procesó 28 customers en 776ms sin errores (2026-05-26).

### Sprint D.5 — Checkpoint Fase D ✅ (2026-05-26)
- [x] **[D.5.1]** ✅ Regression suite extendida `database/run-all-tests.js` con 12 suites (+ D.1 portal + D.4 recommendations). **12/12 verde** en ~10.6s. Fixes idempotencia: D.1 ahora tolera state previo (baseline count + assert delta), B.3.2 requirió re-import de testdata (legacy migration había uppercased brand names) (2026-05-26).
- [x] **[D.5.2]** ✅ Entry de cierre en `03_LOG_REVISIONES.md` con arquitectura completa de Fase D + acumulado de tests (2026-05-26).
- [ ] **[D.5.3]** ⬜ Validación visual manual del portal + vendor en browser/DevTools mobile (Edgar).

**Total Sprint D: ~6 sesiones (vs 16-20 semanas estimadas originales).** Pivots clave:
- D.0 absorbido por Fase B.
- D.1 simplificado: sin tabla `carts` separada (draft = cart) — solo link users↔customers + audit history.
- D.2 ADR-005: extender `apps/view` (no app RN). Offline sync queue deferred.
- D.3 rutas `/portal/*` en apps/view (no app Angular separada).
- D.4 heurística sin ML (suficiente para beta).

---

## 📋 BACKLOG — Fase K: AI product match en captures (pgvector + Voyage + Haiku)

> Decisión 2026-05-27 (Edgar): MVP **solo captures** paso 5 del wizard. Plan completo en [`FASES/FASE_K_AI_PRODUCT_MATCH.md`](FASES/FASE_K_AI_PRODUCT_MATCH.md). ADRs: [ADR-011](02_DECISIONES_ARQUITECTURA.md#adr-011--provider-de-embeddings-voyage-ai-voyage-3) + [ADR-012](02_DECISIONES_ARQUITECTURA.md#adr-012--pgvector-en-db-legacy-portar-con-la-tabla-cuando-se-migre-a-multi-tenant).

### Sprint K.0 — Schema + extensión + backfill ✅ (2026-05-27)

- [x] **[K.0.0]** ✅ Docker `pgvector-md` (pgvector/pgvector:pg18) en `localhost:5433` + restore completo del `postgres_platform` remoto (73 brands · 1278 products · 2 tenants) + rol `app_runtime` recreado + `.env` cutoveado.
- [x] **[K.0.1]** ✅ Migración `database/migrations-newdb/20260527120000_enable_pgvector_and_products_embedding.js`: `CREATE EXTENSION vector` 0.8.2 + 3 columnas en `products` + HNSW index parcial. Idempotente.
- [x] **[K.0.2]** ✅ Script `database/scripts/backfill-product-embeddings.js`: batches 100, retry exp en 429/5xx, flags `--force` `--limit` `--dry-run`. Idempotente.
- [x] **[K.0.3]** ✅ Vars en `.env` + `.env.example`. No `env.schema.ts` (el repo no usa schema centralizado; validación inline en K.1).
- [x] **[K.0.4]** ✅ Backfill **1278/1278 ok** en 9.8s (~$0.02 USD). Smoke pgvector con 5 queries reales.

### Sprint K.1 — Backend module `ai-product-matcher` ✅ (2026-05-27)

- [x] **[K.1.1]** ✅ `EmbeddingsService` (`apps/api/src/shared/ai/embeddings.service.ts`) — wrapper Voyage REST con retry exp en 429/5xx, timeout 10s, validate API key al boot.
- [x] **[K.1.2]** ✅ `LlmExtractorService` (`apps/api/src/shared/ai/llm-extractor.service.ts`) — Anthropic Messages API direct + Haiku 4.5 con tool_use. Fallback heurístico si LLM falla.
- [x] **[K.1.3]** ✅ `AiProductMatcherService.match(rawText)`: sanity check → LLM extract → Voyage embed batch → KNN top-3 paralelo. Threshold **0.40** (recalibrado en smoke K.1.7).
- [x] **[K.1.4]** ✅ `AiProductMatcherController`: `POST /api/ai/products/match-ai`. `RequireAuthGuard + RolesGuard + RequirePermissions(VISITAS_REGISTRAR)` + `@Throttle({ long: { ttl: 60_000, limit: 10 } })`.
- [x] **[K.1.5]** ✅ Hook en `planograms.service.ts`: método privado `embedProduct(id)` síncrono. Llamado en `addProduct` (siempre) y `updateProduct` (cuando cambia `nombre`/`brand_id`). Try/catch silencioso.
- [x] **[K.1.6]** ⏭️ Tests unit/integration skipped — el repo no tiene infra de mocks fetch. Cobertura cubierta por smoke HTTP K.1.7.
- [x] **[K.1.7]** ✅ HTTP smoke `database/http-ai-match-test.js`: **29/29 OK** 2026-05-27. Fixes durante smoke: (a) endpoint a `ai/products/match-ai` (path `planograms/products` chocaba), (b) threshold `0.50 → 0.40`, (c) `@Throttle` key `default → long`.

### Sprint K.2 — Frontend modal en captures wizard ✅ (2026-05-27)

- [x] **[K.2.1]** ✅ `AiProductMatcherService` frontend en `apps/view/.../captures/ai-product-matcher.service.ts` — wrapper HTTP tipado, `Observable<MatchResponse>`.
- [x] **[K.2.2]** ✅ `<app-ai-product-picker>` standalone con states signal-based (idle/loading/preview/error). Textarea max 5000 chars con contador.
- [x] **[K.2.3]** ✅ Preview UI: 3 KPI cards + items con severity colors (verde autoConfirm, amarillo ≥0.30, rojo <0.30). Alternativas top-2 clickeables. Detección dedupe contra ya seleccionados.
- [x] **[K.2.4]** ✅ Integración en `captures.component.ts` step 5: import standalone, signal `showAiPicker` + getter/setter `showAiPickerModel` para `<p-dialog>`, handlers + botón gradient sunset.
- [x] **[K.2.5]** ✅ Network guard: signal `isOnline` + listeners online/offline (cleanup en ngOnDestroy). Botón `*ngIf="isOnline()"`. Search clásico intacto.
- [x] **[K.2.6]** ✅ `nx build view` OK (warnings preexistentes, nada de Fase K).

### Sprint K.3 — Verificación + cierre ✅ (2026-05-27)

- [x] **[K.3.1]** ✅ HTTP smoke ejecutado: 29/29 OK + agregado a `database/run-all-tests.js`.
- [x] **[K.3.2]** ✅ E2E manual visual confirmado por Edgar ("ya jala con madre").
- [x] **[K.3.3]** ✅ Entry de cierre en `03_LOG_REVISIONES.md` con arquitectura completa, lessons learned y deuda técnica documentada (refactor services legacy hacia schema multi-tenant).
- [x] **[K.3.4]** ✅ Memorias guardadas con learnings clave (Docker pgvector, threshold Voyage, schema mismatch patterns).

### Compatibility shim (post K.1, descubierto durante visual validation)

> Schema multi-tenant nuevo en `postgres_platform` tenía mismatches con código legacy. 2 migraciones aplicadas para desbloquear sin refactor profundo. **Deben sincronizarse a `.245` para mantener paridad Docker ↔ remote**.

- [x] **[K-shim-1]** ✅ Migración `20260527130000_add_activo_virtual_to_multitenant_tables.js`: agrega columna virtual `activo BOOLEAN GENERATED ALWAYS AS (deleted_at IS NULL) STORED` a 12 tablas (catalogs, daily_assignments, daily_captures, exhibition_photos, exhibitions, role_permissions, rubric_levels, scoring_config, scoring_config_versions, scoring_weights, visits, zones). Read-only, autosync con `deleted_at`.
- [x] **[K-shim-2]** ✅ Migración `20260527140000_add_legacy_columns_zones_daily_captures.js`: agrega `zones.is_system BOOLEAN DEFAULT false` + `daily_captures.captured_by_username VARCHAR` con backfill 398/401 rows desde JOIN con users.

### Integridad embedding ↔ SQL (sprint K-sync) ✅ 2026-05-27

> Pregunta de Edgar 2026-05-27: "Si agregamos un producto en SQL se agrega en vectorial?". Decisión: **eventually-consistent** con trigger SQL + cron scanner. Hook en `updateBrand` marca stale los products afectados. Script manual para sincronizar Docker ← .245.

- [x] **[K-sync-1]** ✅ Migración `20260527150000_products_embedding_staleness_trigger.js`: función `products_mark_embedding_stale()` + trigger BEFORE INSERT/UPDATE. Al INSERT setea embedding_updated_at=NULL. Al UPDATE de `nombre` o `brand_id` marca stale (preserva `embedding` viejo para degradación elegante). Smoke OK: UPDATE de campo no-text NO dispara stale; UPDATE de nombre SÍ.
- [x] **[K-sync-2]** ✅ Hook en `planograms.service.ts.updateBrand`: si cambia `brand.nombre`, hace `UPDATE products SET embedding_updated_at=NULL, embedding_source_text=NULL WHERE brand_id=:id`. El cron los recoge.
- [x] **[K-sync-3]** ✅ `EmbeddingSyncService` (`apps/api/src/modules/ai-product-matcher/embedding-sync.service.ts`) con `@Cron('0 */15 * * * *')` (cada 15 min). Detecta `activo=true AND (embedding IS NULL OR embedding_updated_at IS NULL)`, batches de 50, llama Voyage `voyage-3` `input_type=document`, persiste. Lock `isRunning` previene overlap. No-op si falta `VOYAGE_API_KEY`. Endpoint manual `POST /api/ai/products/sync-now` (perm PLANOGRAMAS_GESTIONAR).
- [x] **[K-sync-4]** ✅ Script `database/scripts/sync-from-remote.js`: dump del .245 + recrea Docker + restore + role app_runtime + knex migrate:latest + backfill. Flags `--skip-backfill` y `--remote URL`. Workflow documentado en sección "Sincronía Docker↔.245" de [`FASE_K_AI_PRODUCT_MATCH.md`](FASES/FASE_K_AI_PRODUCT_MATCH.md).
- [x] **[K-sync-5]** ✅ Build api OK + smoke E2E: 5 products marcados stale → scanner los detectó → Voyage embed → persisted → verified. Pendientes globales = 0 post-smoke.

### Deferred post-MVP

- **[K.4]** Bulk import admin (pegar lista de SKUs nuevos en admin-catalogs/planograma).
- **[K.5]** Mismo motor en portal B2B + módulo vendedor.
- **[K.6]** Telemetry persistido `ai_match_telemetry` para tuning de threshold.
- **[K.7]** AI vision: foto del exhibidor → identifica productos sin texto.
- **[K-debt]** Sprint formal de refactor services legacy → schema multi-tenant (CatalogsService, ReportsService, VisitsService usan queries hardcoded para schema viejo).

### Deferred post-MVP

- **[K.4]** Bulk import admin (pegar lista de SKUs nuevos en admin-catalogs/planograma).
- **[K.5]** Mismo motor en portal B2B + módulo vendedor.
- **[K.6]** Telemetry persistido `ai_match_telemetry` para tuning de threshold.
- **[K.7]** AI vision: foto del exhibidor → identifica productos sin texto.

---

## 📋 SPRINT — Vendor Capture Offline-First ✅ (2026-06-08)

> Hardening de `/dashboard/vendor-capture` (módulo "fuente de verdad" del vendedor de campo según memoria 2026-06-04). Stack offline Dexie + sync queue ya estaba maduro pero el componente hacía POSTs directos sin fallback. Opción A del análisis devex aplicada.

- [x] **[VC.1]** ✅ Dexie schema v4: nueva interface `PendingVendorSale` + campo `pendingSale?` en `VisitaPendiente`. Migración no destructiva (mismas tablas, campo libre sin index). Visitas v3 siguen funcionando (2026-06-08).
- [x] **[VC.2]** ✅ `OfflineSyncService.guardarVisitaOffline` acepta `datosVisita.pendingSale` y lo persiste tras crear la visita (2026-06-08).
- [x] **[VC.3]** ✅ `analizarTicketDiferidoSiAplica` refactor: retorna `{ exhibiciones, ocrItems, ticketMeta }` (antes solo `exhibiciones[]`). `ocrItems` alimenta construcción de líneas en `postPendingSale` cuando `deferredFromTicket` (2026-06-08).
- [x] **[VC.4]** ✅ `postPendingSale(visita, response, ocrItems, ticketMeta)`: corre tras POST exitoso de `/daily-captures`. Auto-construye `lines` desde OCR si `deferredFromTicket && lines vacío` (filter `sku` + `confidence != no_match`). Persiste `daily_capture_id` + lines resueltas ANTES del POST a `/commercial/vendor-sales`. Si POST de venta falla → estado queda recuperable (2026-06-08).
- [x] **[VC.5]** ✅ `sincronizarVentasHuerfanas()` corre tras `sincronizarVisitas()`. Procesa visitas con `pendingSale.daily_capture_id != null` (visita ya en server, venta pendiente). Best-effort, no afecta contadores (2026-06-08).
- [x] **[VC.6]** ✅ `vendor-capture.onTicket()` offline-first: si `!navigator.onLine` o POST a `/ai/ticket/extract` falla transient (`[0, 408, 500, 502, 503, 504, 522, 524]`), guarda Blob crudo en `ticketBlob` + marca `ticketOcrDeferred(true)`. Banner amber visible en UI (2026-06-08).
- [x] **[VC.7]** ✅ `vendor-capture.save()` con 3 paths: (1) online happy igual que antes, (2) offline puro vía `guardarVisitaOffline` con `pendingSale` + `ticketBlob`, (3) online → catchError transient → fallback offline reusando `syncUuid` (dedup server-side garantizado) (2026-06-08).
- [x] **[VC.8]** ✅ Botón Save habilitado con `confirmedCount() === 0 && ticketOcrDeferred()` — el escenario "vendedor sin red toma foto de ticket" ya no queda bloqueado por UI (2026-06-08).
- [x] **[VC.9]** ✅ `nx build view` OK (solo warnings CommonJS preexistentes ajenos) (2026-06-08).
- [ ] **[VC.10]** ⬜ TODO: verificación visual con DevTools offline mode (no automatizable desde CLI). Suite regression `database/run-all-tests.js` debería seguir 20/20 (cero cambios backend).

---

## Fase SM — Supervisor de Movimientos (Cuadre) — ADR-029

Plan: [`FASES/FASE_SM_SUPERVISOR_MOVIMIENTOS.md`](FASES/FASE_SM_SUPERVISOR_MOVIMIENTOS.md). Motor de reconciliación caja/inventario/cruce; bandeja HITL; L2. Reusa Maat.2.

- [x] **[SM.0]** ✅ Schema `reconciliation.*` (mig `20260707170000`) + lib `libs/reconciliation` (scope:reconciliation, boundary eslint + tsconfig path) + perms `RECONCILIATION_VER/_GESTIONAR` (enum back+front + meta + seed + backfill `20260707190000`). Build api+view OK (2026-07-07).
- [x] **[SM.1]** 🔨 Feed caja `import-cash-cuts.js` (kdpv_folio_caja → `analytics.cash_cuts`, mig `20260707180000`) — dry-run verificado LAN (2163 cortes, 164 con |diff|≥$50, $334,974). Detector P2 (`caja_descuadre` + `cajero_faltante_recurrente`) + bandeja `ReconciliationFindingsService` (L2 + causa) + controller `/reconciliation/*`. **Falta verificación E2E: aplicar migs + importer `--apply` + scan** (deploy) (2026-07-07).
- [x] **[SM.2]** 🔨 Feed kardex `import-kardex.js` (kdij género N → `analytics.stock_ledger`, mig `20260707200000`, clasificado merma/traspaso/ajuste/inv_fisico vía c6 grupo) — dry-run LAN: 12,034 movs, 1,130 mermas $3.85M. Detector P1 `merma_inventario` (SKU×suc×mes ≥umbral). Bandeja ya filtra plano inventario. **Falta E2E (aplicar mig + importer --apply + scan) + detector completitud Σ=Δ (diferido, existencia buggy)** (2026-07-07).
- [~] **[SM.3]** ⏸️ DIFERIDO (2026-07-07) — Cruces venta↔inventario↔caja. **Verificado que NO hay señal limpia**: en Kepler venta/inventario/caja se calculan juntos y consistentes → los cruces son tautológicos. El descuento-por-línea no existe (importe = qty×precio por construcción; descuentos van como promos/docs aparte, no override de línea). Se reabre solo si aparece una fuente INDEPENDIENTE (ej. POS externo) o se modela promos vs cobrado. El valor real vive en SM.1 (caja) + SM.2 (inventario), que sí tienen señal independiente.
- [x] **[SM.4]** 🔨 Frontend `/almacen/cuadre` — `CuadreService` + `AlmacenCuadreComponent` (KPIs + filtros plano/estado + tabla densa triage confirmar/descartar + causa + evidencia + salud de reglas). Ruta gateada `RECONCILIATION_VER` + tab "Cuadre". Build view OK. Falta verificación visual (2026-07-07).
- [x] **[SM.5]** 🔨 `ReconciliationScannerService` @Cron 3:15 AM MX (scanAll por tenant, scope CLS) + notifica críticos nuevos vía `FINANCE_NOTIFIER_PORT` (@Optional). L2 ya en `ReconciliationFindingsService`. Build OK (2026-07-07).
- [x] **[SM.6]** 🔨 Consola completa `/almacen/cuadre` con 4 tabs: Resumen (KPIs + top cajeros con barras + por sucursal) · Cortes de caja (tabla cruda filtrable) · Movimientos (stock_ledger por clase) · Descuadres (bandeja HITL). `ReconciliationQueryService` + endpoints `/reconciliation/{overview,cash-cuts,movements}`. Builds OK. **PROD: data cargada** (cash_cuts 2165, stock_ledger 12,025). Resumen/Cortes/Movimientos muestran data sin scan; Descuadres requiere scan. Falta deploy código + re-login + scan (2026-07-07).
- [x] **[DM.12]** 🔨 **Cuadre de traspasos en `/almacen/movimientos`** (pestaña dedicada + reporte PDF) — 2026-08-05. Contracara del `transfersCheck` físico: la balanza Kepler **mayor 515 «Ajuste traspasos internos»** (515-001 entrada / 515-002 salida) debe netear ≈$0; Δ≠0 = traspaso sin cuadrar. **Backend** (`commercial-movements`, `RequireAnyPermission COMMERCIAL_MOVEMENTS_VER|RECONCILIATION_VER`): `GET transfers-ledger` (contable por mes+sucursal desde `analytics.ledger_monthly`), `GET transfers-matrix` (físico origen→destino desde `stock_movements`, mismo pareo LATERAL que `transfers-check` agregado por par), `GET transfers-cuadre.pdf` (reporte mensual, puppeteer + estilo DESIGN.md). **Frontend**: `p-tabs` (Diario | Cuadre de traspasos) con rango propio (vista de red); informe con 4 desgloses (subcuenta 515-001/002 · serie mensual+tendencia con Δ/%/acumulado · por sucursal · matriz origen→destino · drill a folio sin cuadrar que abre el documento) + botón **Reporte PDF**. Commits `a86d3519` (panel inicial) → `0a5aa518` (pestaña+informe) → `2e99d80f` (PDF) → `dff04003` (detalle por póliza). **Detalle por póliza** (`GET transfers-ledger-detail` sobre `analytics.gl_poliza_lines`, ADR-041): **pareo tolerante ±2% + ventana ±1 mes** (origen/destino registran el traspaso con costo ligeramente distinto → el match exacto perdía la contraparte). 3 baldes: exacto · con diferencia de costo (muestra el par entrada_ref↔salida_ref + Δ = dónde está la contraparte) · **sin rastro** (accionable, con `referencia`/localizador Kepler ej. "TRAS DE CEDIS A ZAMORA T-7904"). Sección UI (2 tablas) + sección 4 del PDF. **Verificado mayo-2026: de 634 falsos "sin contraparte" (match exacto) a 115 reales (85 ent/30 sal); 602 pares eran diferencia de costo (Δ $269k).** Commit `d3fd3915`. Builds api+view verdes. **Verificado contable vs DB**: Δ acumulado ene–jul 2026 = **+$11.63M**, cuadre perfecto ene–feb, divergencia jun–jul. **Local no trae traspasos físicos** en `stock_movements` (feed acotado) → matriz/folios con empty-state honesto; se llenan en prod. **Pendiente**: deploy api+view + re-login + verificación visual (pestaña + PDF renderizado en prod).

---

## 📋 BACKLOG — Fase F: Comercio Conversacional por WhatsApp

> ADR-006 (Meta Cloud API) · ADR-007 (Claude Haiku) · ADR-034 (arquitectura). Plan completo en [`FASES/FASE_F_WHATSAPP_BOT.md`](FASES/FASE_F_WHATSAPP_BOT.md).

### Sprint F.0 — Fundación (`libs/whatsapp` + cola + estado) ✅ EN CÓDIGO (2026-07-24, build api verde)

- [x] **[F.0.1]** ✅ Lib `libs/whatsapp` + registro Nx (`@megadulces/whatsapp` en tsconfig.base). Fix `.gitignore` `WhatsApp*/` → `/WhatsApp*/` (capturaba la lib por FS case-insensitive de Windows).
- [x] **[F.0.2]** ✅ `WhatsAppPort` (interface + token DI) + `SimulatorWhatsAppAdapter` (dev, buffer outbox) + `MetaCloudWhatsAppAdapter` (Graph v21 + HMAC) + selección por `WHATSAPP_PROVIDER` (default `simulator`).
- [x] **[F.0.3]** ✅ Cola `WhatsAppQueueService` — BullMQ (`whatsapp-in`/`whatsapp-out`, attempts 5 + backoff exp, jobId idempotente) si hay `REDIS_URL`; degrada in-process si no (patrón `CacheModule`). `bullmq@5.81.1` instalado; import diferido (no penaliza boot sin Redis).
- [x] **[F.0.4]** ✅ Migración `20260724140000` — `whatsapp.conversation_threads` (1 hilo abierto/número por índice parcial) + `whatsapp.messages` (dedup por índice parcial `wa_message_id`), RLS forzado + grants app_runtime. `ConversationThreadService` (getOrCreate/update/logMessage, RLS vía `TenantKnexService.run`).
- [x] **[F.0.5]** ✅ Permisos `WHATSAPP_BOT_VER`/`GESTIONAR` (enum BE+FE + ability.factory subject `whatsapp` + AppSubject + backfill ← `REPARTO_DESPACHAR`, customer_b2b nunca).
- [x] **[F.0.6]** ✅ Wiring en AppModule bajo `ENABLE_MULTITENANT`. **Build api VERDE.** Pendiente operacional: `migrate:new` + correr smoke con API arriba.

### Sprint F.1 — Canal Meta (webhook + emisor) 🧪 EN CÓDIGO (2026-07-24, build api verde)

- [x] **[F.1.1]** ✅ `MetaCloudWhatsAppAdapter` (envío texto/interactive a Graph v21 + validación HMAC `X-Hub-Signature-256` con `WHATSAPP_APP_SECRET`, timing-safe; degrada no-op sin credenciales).
- [x] **[F.1.2]** ✅ `WhatsAppWebhookController` `@Public()`: `GET /webhooks/whatsapp` (handshake verify) + `POST` (parse inbound → dedup por `wa_message_id` → hilo → log → encola; 200 rápido). `WhatsAppIngestService` resuelve tenant + scope CLS sintético (`tenantCtx.run`) + workers in/out (F.1 = responder placeholder, F.2 lo reemplaza). Raw body para HMAC capturado en main.ts (`verify` → `req.rawBody`).
- [x] **[F.1.3]** ✅ Config env (`WHATSAPP_PROVIDER`/`_PHONE_NUMBER_ID`/`_ACCESS_TOKEN`/`_VERIFY_TOKEN`/`_APP_SECRET`/`_TENANT_ID`) + `POST /webhooks/whatsapp/sim` (solo `provider=simulator`). Smoke `http-whatsapp-webhook-test.js` escrito + registrado en `run-all-tests.js` (needsApi). **Pendiente: correr con API arriba.**

### Sprint F.2 — Orquestador conversacional 🧪 EN CÓDIGO (2026-07-24, build api verde)

- [x] **[F.2.1]** ✅ `ConversationOrchestratorService` — loop tool-use Claude Haiku (mismo endpoint/model que `LlmExtractorService`), máx 6 iteraciones. **Degrada honesto a handoff** sin `ANTHROPIC_API_KEY` o sin puerto de catálogo (nunca inventa pedido). Puerto `COMMERCE_CONVERSATION_PORT` (contracts) + binding `CommerceConversationBindingModule` → `CommercialCatalogSearchService` (frontera limpia: whatsapp no importa commercial). Reemplaza el placeholder del worker `in`.
- [x] **[F.2.2]** ✅ 7 tools: `buscar_producto` (catalog-search, precio del motor), `agregar_al_carrito` (precio del hit, NO del LLM — invariante ADR-016), `quitar_del_carrito`, `ver_carrito`, `capturar_domicilio` (texto; geocoding vive en `/reparto/asignar`), `confirmar_pedido` (marca `review`, NO crea orden ni cobra), `handoff_humano`.
- [x] **[F.2.3]** ✅ Estado + carrito persistidos en `conversation_threads` al cierre del turno; historial (últimos 8 msgs) como contexto. **Build api VERDE.** Pendiente: validación en vivo con `ANTHROPIC_API_KEY` + catálogo (calidad conversacional no es automatizable). **F.3 = crear la orden `pending_approval` desde el hilo `review` + bandeja.**

### Sprint F.3 — Pedido → bandeja de revisión 🧪 EN CÓDIGO (2026-07-24, builds api+view verdes)

- [x] **[F.3.1]** ✅ Decisión: el bot NO crea la orden — el hilo en `review` ES el estado pendiente; la **aprobación humana es la confirmación** (más simple que `pending_approval` intermedio). Puerto `COMMERCE_CONVERSATION_PORT.createHomeDeliveryOrder` → `CommercialHomeDeliveryService.createIntake` (cliente casual + domicilio + líneas, canal whatsapp, confirmado + stock reservado).
- [x] **[F.3.2]** ✅ Backend `WhatsAppOrdersService` + `WhatsAppOrdersController` (`/whatsapp/orders`): `GET` bandeja (hilos `review` con carrito/domicilio/total, perm `WHATSAPP_BOT_VER`), `POST :id/confirm` (crea orden → avisa al cliente por WA → cierra hilo, perm `WHATSAPP_BOT_GESTIONAR`), `POST :id/reject` (cierra + avisa). Frontend `/reparto/pedidos-whatsapp` (master-detail Operations: lista + detalle con productos/domicilio/total + Confirmar/Rechazar) + nav "Pedidos WhatsApp" en el shell de Reparto. Confirmado → cae en `/reparto/asignar`. **Builds api+view VERDES.** Pendiente: validación visual + E2E en vivo.

### Sprint F.4 — Handoff + panel de conversaciones ⏸️ DIFERIDO (nice-to-have)

> El camino comercial (pedir → reparto → cobro) quedó cerrado con F.0–F.3. El bot ya deriva a `handoff` cuando no entiende (tool `handoff_humano` + degradación sin API key). F.4 agrega la vista para retomar esos hilos + métricas, pero no bloquea la operación.

- [ ] **[F.4.1]** Vista para retomar hilos en `handoff` (responder manual desde el panel) + palabra clave de escalamiento.
- [ ] **[F.4.2]** Dashboard de conversaciones (admin) + métricas (autocompletado%, tiempo, costo/conv, tasa handoff).
- [ ] **[F.4.3]** Checkpoint final de fase.

### Sprint F.5 — Existencia + unidades (pieza/paquete) en el bot 🧪 EN CÓDIGO (2026-07-24, builds api+view verdes)

> Pedido por Edgar. Decisión de autonomía: **humano sigue confirmando** (sin cambio); F.5 solo hace que el bot no prometa agotados y hable en pieza/paquete/caja.

- [x] **[F.5.1]** ✅ `COMMERCE_CONVERSATION_PORT.searchProducts` devuelve `stock_pieces` (quantity−reserved del almacén default) + `pieces_per_package` (factor_sale). Enriquecido en el binding adapter (LATERAL sobre `commercial.stock`), sin tocar el `search()` compartido.
- [x] **[F.5.2]** ✅ Orquestador: `buscar_producto` expone disponible/agotado/empaque; `agregar_al_carrito` con `unidad=pieza|paquete` (→ piezas canónicas) + **valida stock** (rechaza si excede); prompt anti-agotado + empaque. Carrito/bandeja muestran "2 paq × 40 (80 pzas)".
- [x] **[F.5.3]** ✅ **VALIDADO EN RUNTIME (2026-07-24, simulador + Claude real):** "2 cajas de vero pica fresa" → 48 piezas (factor 24, precio del motor $3,388.99); pedir 999999 cajas → **rechazo por stock** con carrito intacto (48) + respuesta con gracia del bot. **Bug encontrado+arreglado:** el simulador reiniciaba el contador de `message_id` en cada restart → colisión con el índice único → los `out` no se registraban; fix `sim-out-<ts>-<n>`. Además cola in-process vuelve a AWAIT + ack rápido a Meta en el webhook controller. Commits `a5b5b586`+`e9e9a0d5`.

### Sprint F.6 — "Surtir" (autonomía) ⏸️ DESCARTADO por decisión (2026-07-24)

> Edgar eligió **humano confirma**. No se sube la autonomía del bot: "surtir" = el flujo F.3 (bandeja) + validación de stock de F.5. Si en el futuro se quiere bot-cierra-solo, reabrir aquí.

### Sprint F.7 — Promos con imágenes 🧪 EN CÓDIGO (2026-07-24, build api verde)

- [x] **[F.7.1]** ✅ `WhatsAppPort += sendImage/sendTemplate`; adapter Meta (payloads Graph v21: `type:image` link+caption, `type:template` con header de imagen + body params) + simulador (outbox). Cola de salida soporta kinds `image`/`template`; worker `out` despacha por tipo.
- [x] **[F.7.3]** ✅ `WhatsAppPromoService` + `WhatsAppPromoController` (`/whatsapp/promos`, `WHATSAPP_BOT_GESTIONAR`): `POST /image` (imagen libre — solo ventana 24h) y `POST /template` (plantilla aprobada — inicia fuera de ventana). getOrCreate hilo → encola out → log. **VALIDADO EN RUNTIME (2026-07-24): POST /image 201 + `out type=image` logueado.**
- [ ] **[F.7.2]** ⏳ **Trámite de Edgar (fuera de código):** crear + aprobar en Meta los templates de marketing (~1-2 días). ⚠️ Sin template aprobado, las promos fuera de ventana 24h fallan. El código ya los envía por nombre.

### Sprint F.8 — Envíos masivos de promos (broadcast) ✅ VALIDADO RUNTIME (2026-07-24, simulador; migración Batch 208)

> **Validado E2E:** opt-in 2 teléfonos → campaña (plantilla+imagen) congela 2 destinatarios → send → fan-out `done` **2/2 enviados 0 fallidos** con ids únicos. Opt-out "BAJA" → `opted_out` + acuse del bot antes del orquestador.

> Decisión Edgar: **aún no hay opt-in** → F.8 arranca capturando consentimiento.

- [x] **[F.8.1]** ✅ `whatsapp.marketing_optin` (RLS) + `WhatsAppOptinService` (opt-in/out por teléfono). **Opt-out "BAJA"/"STOP" en el ingest ANTES del orquestador** (regla dura Meta) + acuse. Opt-in manual/import por endpoint. **Opt-in conversacional del bot DIFERIDO** (necesita threading del phone al orquestador).
- [x] **[F.8.2]** ✅ `WhatsAppCampaignService`: crea campaña (plantilla+imagen) congelando destinatarios opted-in; `send()` fan-out en segundo plano por `sendTemplate` con **rate-limit** (`WHATSAPP_BROADCAST_DELAY_MS`, default 350ms) + tracking por destinatario. (BullMQ opt-in con `WHATSAPP_USE_BULLMQ=true` para durabilidad/tier a escala; MVP usa fan-out detached in-process.)
- [x] **[F.8.3]** ✅ Tracking `campaign_recipients` (pending/sent/failed) + contadores en `campaigns` + `WhatsAppBroadcastController` (`/whatsapp/campaigns` CRUD+send+status, `/whatsapp/optin` stats/manual). **Panel de campañas frontend + costo por conversación DIFERIDOS.** Runtime pendiente de restart de nx serve.

---

## Fase CH — Checadores / Control de asistencia

### Sprint CH.0 — Base de datos de checadores ✅ VALIDADO RUNTIME (2026-08-17, migración Batch 255, local)

> **Contexto:** 10 relojes ZKTeco en la red sin ningún sistema que los lea. No exponen API → se implementó su protocolo binario nativo (TCP 4370). Identidad por **serie**, no por IP.

- [x] **[CH.0.1]** ✅ Descubrimiento de la flota. 7 equipos por barrido TCP 4370 + **3 más que nadie tenía inventariados** (`42.37`, `50.12`, `54.10`) al barrer también **UDP 4370** y mapear los gateways reales de la WAN (subredes existentes: `0, 11, 13, 30, 32, 40, 42, 44, 50, 54`). Escáner validado contra equipos conocidos antes de creer los negativos. **2 declarados no existen en la red**: `192.168.10.2` (subred inexistente, túnel muerto en `172.16.1.2`) y `192.168.30.253` (subred viva, 39 hosts, **cero ZK** en los 254 IPs por TCP+UDP+banner HTTP → apagado o IP cambiada).
- [x] **[CH.0.2]** ✅ `zk-client.js`: protocolo ZK nativo sin dependencias (comm key ofuscada, `OPTIONS_RRQ`, `DATA_WRRQ`+`READ_BUFFER` para datasets grandes). Decode verificado en vivo: usuario = 72 bytes, checada = 40 bytes, `verify_mode` 1=huella/15=rostro, `punch_type` 0=entrada/1=salida/4-5=extra. Los 10 equipos aceptan **comm key 0**.
- [x] **[CH.0.3]** ✅ Schema `hr.*` (mig `20260817220000`, RLS forzado + grants `app_runtime`): `attendance_devices` · `employees` · `device_enrollments` · `attendance_logs` · `device_sync_runs` + vista `attendance_days`. Doble cara del tiempo: `punched_local` (hora de pared del reloj) + `punched_at` (canónico vía `AT TIME ZONE`, DST-safe).
- [x] **[CH.0.4]** ✅ `import-checadores.js` idempotente = carga inicial **y** poller. Llave natural `(device, user_id, punched_at)`, **NO** el `uid` del equipo (índice de ring buffer que se reinicia al purgar → colisionaría con el histórico). Verificado: releer 23,657 checadas inserta 0. Un reloj caído no tumba la corrida (`unreachable` en `device_sync_runs`).
- [x] **[CH.0.5]** ✅ Carga: **129,461 checadas / 452 enrolamientos / 10 equipos**, histórico desde **2023-09-14** (`.0.153`). 696 checadas quedan sin persona a propósito = `user_id` borrados del reloj (ex-empleados cuyos marcajes siguen en el buffer).
- [x] **[CH.0.6]** ✅ `link-employees.js` — crosswalk conservador (sobre-fusionar corrompe asistencia; sub-fusionar solo duplica ficha). Nunca fusiona dos enrolamientos del **mismo** reloj (dos "Clau" en `.0.80` son dos personas). Fusiona solo el par `.0.80`/`.0.81` con la regla verificada `id_80 = id_81 + 100` **y** nombre concordante → 35 pares. 417 personas. Los **73 homónimos entre sucursales quedan separados y listados** para revisión humana.
- [ ] **[CH.0.7]** ⬜ Cargar `label` / `site_code` de los 10 equipos — el reloj no sabe dónde está; es la dimensión principal y no se puede deducir. **Bloquea el reporte por sucursal.**
- [ ] **[CH.0.8]** ⬜ Revisar los 73 grupos de homónimos y confirmar/fusionar (`match_status='confirmado'`).
- [ ] **[CH.0.9]** ⬜ Agendar el poller (Task Scheduler `.249`, patrón `run-prod-feeds`) + aplicar mig a Railway.
- [ ] **[CH.0.10]** ⬜ Módulo/UI de asistencia + permisos dedicados (recipe 6 touch-points).

> **Deriva de reloj detectada** (para alertar): hasta **−145 s** en `40.12`, −99 s en `.0.81`, +34 s en `50.12`. Se guarda en `clock_drift_seconds` por corrida.

---

## COMM — Transportes de comunicación (auditoría ADR-045) — ✅ CERRADO 2026-08-18

Catálogo de transportes NestJS↔Angular auditado y cerrado en **ADR-045**. Cuatro huecos que se leían como pendientes:

- [x] **[COMM.1]** ✅ SSE del chat de Maat endurecido — keepalive `: ping` 15s + cancelación real (`shouldStop` corta el loop de tools cuando el cliente se va) + `finally` idempotente. Documentado por qué **no** se usa `@Sse()` (registra GET; el payload lleva historia + imagen base64 y `EventSource` no manda `Authorization`). Cerrado 2026-08-18.
- [x] **[COMM.2]** ✅ `EventEmitterModule` retirado — estaba cargado con 0 emisores / 0 `@OnEvent`. La convención cross-dominio (puertos tipados en `libs/contracts/src/ports/*`) quedó escrita en `AppModule`. Dep `@nestjs/event-emitter` fuera. Cerrado 2026-08-18.
- [x] **[COMM.3]** ✅ Codegen OpenAPI reparado como **snapshot de contrato** — `scripts/generate-openapi.js` baja `/api/docs-json` y diffea operaciones vs snapshot previo (verificado contra la API viva: 45 paths / 61 ops). Fuera `generate:client`, `api:gen`, `openapi-config.json` y `@openapitools/openapi-generator-cli`. Cerrado 2026-08-18.
- [x] **[COMM.4]** ✅ GraphQL / gRPC / microservicios Nest / `LISTEN-NOTIFY` documentados como **no-van** con compuerta explícita de reapertura (ADR-045). Cerrado 2026-08-18.

Sin migraciones, sin cambios de contrato de endpoints, sin cambios de frontend. Build `api` verde.

### COMM.5 — P0 de Finanzas: motores largos fuera del request — ✅ CERRADO 2026-08-18

Techo real: `location /api/` de nginx no define `proxy_read_timeout` → **60 s**. Ocho endpoints síncronos podían pasarse y devolver **504 con el trabajo a medias**.

- [x] **[COMM.5.1]** ✅ `FinanceJobsService` + `GET /finance/jobs[/:id]` + `BancosGateway.emitJob` (evento WS `finance_job`: `running` → `done`/`error` con el mismo objeto que devolvía el HTTP). Registro en memoria (últimos 50, scoped por tenant).
- [x] **[COMM.5.2]** ✅ 8 endpoints a **202 + job_id**: bank `import` / `match` / `findings/sync` / `reclassify` / `sheet-sync/run` · maat `findings/scan` / `findings/graph-sync` / `discovery/run` / `skeptic/run`. Todos conservan `?sync=true` (o `sync: true` en el body) para CLI y smokes.
- [x] **[COMM.5.3]** ✅ Frontend: `/finanzas/bancos` y `/finanzas/hallazgos` reaccionan al WS (`onJob`) + `FinanceJobsClient` sondea `GET /finance/jobs/:id` como respaldo si el WS no conectó (el primer aviso gana, dedupe por `job_id`). Refcount de conexión en `BancosSocketService` (ahora lo usan dos páginas).
- [x] **[COMM.5.4]** ✅ Chat de Maat: **deadline de 45 s** en el camino síncrono (fallback del SSE, 12 iteraciones × Claude con `deep_search`) — cierra honesto en vez de que el proxy tire 504. Sin cola: es respuesta interactiva, no job.
- [x] **[COMM.5.5]** ✅ Smoke `http-finance-jobs-test.js` en la regresión (202 + WS running→done + `GET /jobs/:id` + `?sync=true` idéntico al WS + 404). `http-maat-chat-test.js` ajustado a `?sync=true`.
- [ ] **[COMM.5.6]** ⬜ Mover el trabajo a `pg-boss` + persistir el registro. Gate: worker-tier desplegado (`WORKER=true`) + `REDIS_URL` (para que el emit del worker llegue a los sockets del API) + archivo del import en S3 (25 mb no van en una fila de cola).

Verificación: **smoke HTTP 26/26 verde en vivo 2026-08-18** (202 real · `running`→`done` por WS con el MatchResult: 520 de 1918 retiros, 27%, 831 ms · `?sync=true` idéntico inline · scan de Maat 33 reglas cerrando por WS en 4.5 s · 404 del job inexistente). Builds api+view verdes con exit code real; contexto de tenant (AsyncLocalStorage) probado que sobrevive al detach.

- [x] **[COMM.5.7]** ✅ Bug que cachó el smoke: `GET /finance/jobs` devolvía `[{}]` (`[...map.values()]` → `[].concat(iter)` en el bundle). Al revisar el bundle salieron **2 más vivos en Maat** con daño silencioso de datos: `maat-entity` (título de `entidad_duplicada` con `undefined`) y `maat-tools` (comparación por mes con una fila basura). Los 3 con `Array.from`, verificados en `dist`. Quedan **41 ocurrencias medidas en el bundle** (commercial/trade/logistics/fiscal/whatsapp/platform-core) → barrido aparte.

### COMM.6 — P1: simetría de tiempo real en Finanzas — ✅ CERRADO 2026-08-18

- [x] **[COMM.6.1]** ✅ `CobranzaGateway` (namespace `/cobranza`, evento `collection_deposit_changed`) calcando `PagosComprobantesGateway`: JWT en handshake, room `tenant:<id>`, `auth_error` + disconnect. El service emite en las **6 mutaciones** (attach/validate/reject/confirmBank/linkBankToCobro/unlinkBank), **siempre después del commit** (`.then()` sobre `tk.run`) para que el reload no lea una fila que aún no existe.
- [x] **[COMM.6.2]** ✅ Frontend: `CobranzaSocketService` + la página avisa por toast **solo si el cambio fue de otro**, refresca con debounce 400 ms la vista **activa** (cobros / abonos-sin-cobro) y recarga el diálogo abierto si es el cobro que cambió. Chip "En vivo".
- [x] **[COMM.6.3]** ✅ Smoke `http-cobranza-ws-test.js` en la regresión (handshake · `auth_error` con token inválido · attach/validate/reject emitiendo con sucursal/folio/monto/actor · aislamiento entre tenants · borra su propia evidencia).
- [x] **[COMM.6.4]** ❌ **OCR a job: DESCARTADO con evidencia** (no era un problema). La auditoría + verificación a mano mostró que `LlmExtractorService` acota cada llamada vision a **30 s** (`llm-extractor.service.ts:432,671`) → nunca alcanza los 60 s del proxy; y `/ocr` es *preview puro* cuyo `next()` prefillea el formulario y encadena el match ficha-first. El 202 rompía eso a cambio de nada. Regla derivada: **a job solo lo que tiene efecto persistente**; lo efímero se acota con deadline.
- [ ] **[COMM.6.5]** ⬜ **P2-perf** (aparecieron en la auditoría, NO son de transporte sino costo de query): N+1 en `collection-deposits.service.ts:364` (`bankMatch` por cada depósito dentro del loop de `detail()`) y el `EXISTS` correlacionado de `GET /finance/collections/bank/unmatched`.

Builds api+view verdes con exit code real; `CobranzaGateway` presente en el bundle. **Smoke pendiente de correr hasta el próximo restart de la API.**

### COMM.7 — Revisión adversarial de P0/P1: bugs propios + causa raíz — ✅ CERRADO 2026-08-18

Tres lentes (UX / correctitud / completitud) sobre el código ya landeado. Encontraron **5 defectos reales en mi propia implementación** y 2 bugs vivos fuera del alcance:

- [x] **[COMM.7.1]** ✅ `FinanceJobsClient.watch()` **completaba sin emitir** si los 36 sondeos veían `running` → spinner eterno en el caso lento que el patrón venía a cubrir. Ahora emite evento sintético `error`; primer sondeo a 1.5 s (rescata la carrera "job termina antes de que llegue el 202").
- [x] **[COMM.7.2]** ✅ El desalojo del registro (`KEEP=50`) borraba por orden de inserción **sin mirar el estado** → podía tirar un job **en curso** (dueño sin resultado + sonda 404). Ahora salta los `running`.
- [x] **[COMM.7.3]** ✅ **Fuga por WS**: el gateway sólo validaba el JWT, así que **cualquier usuario autenticado del tenant** (vendedor, repartidor) escuchaba `finance_job`/`bancos_changed` con el `result` adentro. Ahora exige el permiso de lectura de la pantalla — replicando el **god-mode de `RolesGuard`** (`isPlatformAdminRole`), sin lo cual el superusuario quedaba fuera de su propio tablero. Aplicado a `/bancos` y `/cobranza`. **Los gateways de `/pagos-comprobantes` y `/goods-receipts` tienen el mismo hueco** (preexistente, no tocado).
- [x] **[COMM.7.4]** ✅ `@SkipTenantTx()` en los 9 endpoints que delegan: el interceptor abre una trx legacy alrededor del handler y la commitea al devolver el 202. Además libera esa conexión durante el trabajo.
- [x] **[COMM.7.5]** ✅ **Causa raíz**: `location /api/` en `nginx.conf` no tenía timeouts → 60 s por default. Ahora `proxy_read_timeout` / `proxy_send_timeout` / `client_body_timeout` en **300 s**. Cubre de golpe todo lo que nadie delegó, incluido el tiempo de **recepción** del cuerpo (que ningún job arregla).
- [x] **[COMM.7.6]** ✅ `/api/finance/bank-captures` era el único módulo de evidencia **sin override de body** → **413** en cualquier foto de celular. Una línea en `main.ts`.
- [x] **[COMM.7.7]** ✅ `recon-tasks/:id/messages` llamaba a `chat.ask` **sin `deadlineMs`** mientras el chat lo acota a 45 s por el proxy. Paridad restaurada.
- [x] **[COMM.7.8]** ✅ Delegado lo que quedaba inline con la misma carga: `maat/learning` `train|score|run` (1 upsert por hallazgo + 2 UPDATE por hallazgo abierto, sin límite, en una sola trx) y `contabilidad/polizas/scan` (el **mismo** `detector.scanAll` que en hallazgos ya iba por job; reusa el `name` `maat-scan`). Los dos con `?sync=true`.
- [x] **[COMM.7.9]** ✅ El smoke suma el chequeo negativo del gate: un usuario `customer_b2b` recibe `auth_error: forbidden` en el canal de Finanzas.

**DI que el build NO atrapa**: `PolizasController` pedía `FinanceJobsService` y `FinanceMaatModule` no re-exporta ese módulo → habría fallado **al arrancar**, no al compilar. Se agregó `FinanceJobsModule` a `FinancePolizasModule`.

Builds api+view verdes con exit code real. **Smokes pendientes de correr hasta el próximo restart de la API.**

### COMM.8 — Barrido del spread de iterador + cierre de la fuga WS — ✅ CERRADO 2026-08-18

- [x] **[COMM.8.1]** ✅ **53 sitios en 35 archivos** pasados a `Array.from(...)`: 12 commercial · 6 logistics · 6 trade · 5 fiscal · 2 finance · 2 api · platform-core · whatsapp. **Verificado en `dist/apps/api/main.js`: cero ofensores reales.**
- [x] **[COMM.8.2]** ✅ Lección del método (quedó en la memoria): el 1er escáner usaba un regex que **excluye corchetes dentro de la expresión** → se saltó todos los `[...new Set(x || [])]`, el patrón más común. La 2ª pasada parsea con balanceo. Y **dos casos eran multi-línea** (`logistics-cartaporte`: `driverIds`, `orderIds`), invisibles para cualquier escáner por línea — **los dos bindeados a `whereIn`**, o sea el patrón exacto del `22P02`. Contar en el **bundle** es lo único que cierra el ciclo.
- [x] **[COMM.8.3]** ✅ Fuga WS cerrada en los 2 gateways que faltaban: `/pagos-comprobantes` (`FINANCE_PAYMENTS_VER`) y `/goods-receipts` (`COMPRAS_ENTRADAS_VER`), con el god-mode de `RolesGuard`. Los 4 gateways de evidencia quedan parejos.

Nota: `COMPRAS_VER` **no existe** en el enum (son `COMPRAS_PEDIDO_*`, `COMPRAS_RED_*`, `COMPRAS_REQUISICIONES_*`, `COMPRAS_ORDENES_*`, `COMPRAS_ENTRADAS_*`) — el typecheck lo atrapó.

Builds api verde con exit code real; typecheck limpio. **Sin migraciones.** Los smokes HTTP no ejercitan el bundle: la verificación de este barrido es el grep del `dist` + el próximo restart.

---

## ER — "Todo es clickeable" (resolvedor de refs + panel de ficha) — 2026-08-20

Ámbito pedido por Edgar: `/compras/entradas` y `/compras/compras-360`.

| Item | Estado | Detalle |
|---|---|---|
| ER.0 Esquema de refs | ✅ | `entity-ref.types.ts`: `makeRef`/`parseRef`, 6 tipos, partes URL-encodeadas. `doc_prefix` va en el ref de `ent` y `pay` aunque hoy entradas sean 100% XA2001 — **verificado: 196 pagos comparten (sucursal, folio) entre doctypes**. |
| ER.1 Resolvedor | ✅ | `EntityRefService` + `GET /entity-ref/:ref` (ruta neutral). Fechas con `to_char` (las columnas `date` volvían como `Date` y se corrían un día en MX). `analytics.*` sin RLS → tenant explícito. |
| ER.2 Permisos por entidad | ✅ | `@RequireAnyPermission` de entrada + chequeo **por tipo** adentro: `pay`→`FINANCE_PAYMENTS_VER`, `adj`→`COMPRAS_DESCUENTOS_VER`. Las relaciones que el rol no puede abrir **se filtran** y se avisa en `notes` — nunca un enlace que revienta en 403. |
| ER.3 Panel inspector | ✅ | `<app-entity-inspector>` sobre el side-peek canónico: pila de navegación + `?ref=` en la URL. z-index 1200 para abrirse desde un diálogo sin apilar modales (seguro acá: adentro no hay overlays de PrimeNG). |
| ER.4 Cableado Compras 360 | ✅ | Proveedor (tabla + detalle), tipo de ajuste, "Abrir ficha de la entrada". |
| ER.5 Cableado Entradas | ✅ | Proveedor (lista + detalle), folio de entrada, cada renglón, cada SKU, gemelos CEDIS, folio de ajuste. |
| ER.6 Smoke | ✅ | `test-newdb-entity-ref.js` 16/16, agregado a la regression. Codec real vía ts-node (`skipProject` + `moduleResolution:'node'` + `ignoreDeprecations`, si no el tsconfig del monorepo tira TS5011/TS5107). |
| ER.7 OC y vale con ficha | ✅ 2026-08-20 | Desbloqueado: la data SÍ estaba en Kepler, faltaba traerla. Mig `20260820140000` (`erp_purchase_docs` + `_lines`, una tabla para X-A-35 y X-A-37 — mismo shape) + `import-purchase-docs.js` (7 sucursales, 21,344 docs / 185,746 líneas) + handler `erp-purchase-docs`. Ref `pdoc`. Cobertura 11,405/11,405 vales y 8,950/8,950 OCs. **9,273 pares (sucursal, folio) se comparten entre OC y vale → `doctype` en el ref era obligatorio.** Bonus: avance de surtido (pedido vs recibido, sobre importes). |
| ER.8 Liga pago→entrada | ⬜ | RE.8. Sin liga estructural en Kepler; hoy "pagos candidatos" ±30 días marcados como estimados. |
| ER.9 Crosswalk proveedor | ⬜ | `catalog.suppliers.code` (inventario) vs `proveedor_code` (contabilidad): **0 de 328 empatan**. Sin esto la ficha no puede mostrar lead time ni mínimo de pedido. |

**1 migración** (`20260820140000`, solo local — la cola de knex está trabada por una migración ajena pendiente que pide `kepler_ods.kdm1`, vacío en local; la mía es idempotente por `hasTable` y se registra sola cuando la cola se destrabe). Builds api + view verdes. Smoke 22/22. **Verificación visual pendiente** (no automatizable desde CLI).

| ER.7b Espejo → vista en vivo | ✅ 2026-08-20 | Mig `20260820200000`: `erp_purchase_docs` (+`_lines`) pasa de tabla copiada a **vista sobre `kepler_ods`**, como recepciones. Medido: la copia se quedó atrás por 12 docs ($1.05M) en 2 horas. Proyección validada contra Kepler real: **0 diferencias en 15,379 filas**. No-op sin ODS (no traba la cola). Importer + handler se auto-retiran ante una vista. |
| ER.7c Guard anti-42P01 | ✅ 2026-08-20 | `to_regclass` en los 3 puntos que tocan el espejo: sin él, una tabla ausente tiraba 500 y se llevaba la ficha ENTERA de la entrada. Pasó en prod. |

**Pendiente prod (BLOQUEADO):** ninguna de las 2 migs corrió en Railway aunque el código sí está desplegado → **`migrate:latest` no está completando en el deploy**. Hasta resolver eso, ninguna migración nueva aplica. Con la vista ya no hace falta importer ni agendarlo.

Decisión abierta que quedó tomada por defecto: el resolvedor vive en `libs/commercial` pero con **ruta neutral** `/entity-ref` y sin dependencias de compras — mover el archivo a `shared` cuando Finanzas lo consuma es un `git mv`, no un rediseño.

---

## FASE UN — Normalización de usuarios, departamentos y puestos

Fuente de verdad organizacional: **ORGANIGRAMA 2026** (5 sitios, 120 plazas). Regla dura del sprint: **cero cambio de privilegios** — `database/scripts/snapshot-user-privileges.js` compara el set efectivo por usuario antes/después y debe salir vacío.

- [x] **[UN.0]** ✅ 2026-08-20 — Diagnóstico. `identity.users` (57 usuarios / 8 roles en uso) + `identity.role_permissions` (30 roles, **22 sin ningún usuario**). Dos taxonomías conviviendo (legacy funcional vs presets por área 2026-07-11), ninguna alineada al organigrama. 8 padrones de personas sin identidad común (`hr.employees` 417, `analytics.pos_cashiers` 723, `wincaja.cajeros` 302, `wincaja.vendedores` 140, `logistics.drivers`, `erp.staff`, `analytics.vendor_identity`). Enum `Permission` copiado 5 veces (160/160/60/54/**36 stale en `libs/shared-auth`**); 8 permisos en código que ningún rol tiene.
- [x] **[UN.1]** ✅ 2026-08-20 — Ejes DEPARTAMENTO y PUESTO (mig `20260820200000`). `identity.departments` (13) + `identity.positions` (43 puestos canónicos, `org_labels` guarda las **61 variantes literales** del PDF) + `users.department_code`/`position_code` con FK composite. Codes en texto y no JOIN en la vista `public.users`: auth-mt la lee en el login sin contexto de tenant.
- [x] **[UN.2]** ✅ 2026-08-20 — Asignación de los 57 (mig `20260820201000`). Cajas 28 (por sucursal Kepler 01-05), Ruta Directa 23 (19 vendedor_ruta + 3 supervisor_rd + 1 vendedor_ruta), Sistemas 2, Administración 1, Externo 2. `colaborador → ruta_directa/vendedor_ruta` confirmado por Edgar. `repartidor_smoke` sin asignar (cuenta de smoke, no persona).
- [x] **[UN.3]** ✅ 2026-08-20 — Higiene (mig `20260820202000`). **Bug real arreglado**: `auth-mt` busca `username.toLowerCase()` contra comparación case-sensitive → el usuario `Superuser` (superadmin, dueño) **nunca pudo entrar** (`last_login_at` NULL desde abril). Bajado a `superuser`. Mojibake Latin-1→UTF-8 corregido en 5 nombres (regla que respeta los Title Case legítimos).
- [x] **[UN.3.1]** ✅ 2026-08-20 — `test-newdb-rls-isolation` estaba **rojo desde julio** (cleanup borraba 1 rol de tenant B pero los seeds "para cada tenant activo" le dejan 14+). Cleanup ahora descubre el grafo de FK a `tenants` y barre en pasadas. 16/16 verde.

- [x] **[UN.4]** ✅ 2026-08-20 — Revocados los 25 permisos de Finanzas/Fiscal de los roles operativos (mig `20260820203000`, autorizado por Edgar). Causa raíz: cadena de backfills anclados que arranca en `20260706170000` (`FINANCE_EXPENSES_VER ← COMMERCIAL_ANALYTICS_VER`, un permiso benigno que todos los roles tenían); de ahí cada módulo nuevo se ancló al anterior y la fuga se propagó a 25 permisos.
  - **Pierden los 25**: `colaborador`, `vendedor`, `repartidor`, `supervisor_ventas`, `jefe_marketing`, `encargado_sucursal`, `supervisor`, `tele_operator` → **25 usuarios reales**.
  - **Conservan**: dominio de Finanzas (`finanzas`, `contabilidad`, `tesoreria`, `credito_cobranza`) + administración total (`superadmin`, `admin`, `sistemas`).
  - `prevencion_auditoria` pierde solo los 2 de escritura (`FISCAL_CONTAB_GESTIONAR`, `FISCAL_MATERIALIDAD_GESTIONAR`) y conserva sus 13 de lectura — alinea con el diseño de su propio preset ("un auditor no opera lo que audita").
  - Se ponen en `false`, **NO se borra la key**: los backfills son idempotentes vía `permissions -> 'KEY' IS NULL`, así que borrarla dejaría que el próximo backfill anclado la re-otorgue. `false` explícito corta la cadena de anclas de forma permanente.
  - Verificado: **25 usuarios perdieron exactamente los 25 esperados, 34 sin cambio, 0 ganaron nada**. Grants efectivos totales 1775 → 1150.
  - Impacto revisado antes de aplicar: los endpoints afectados fuera de `libs/finance`/`libs/fiscal` son de **timbrado CFDI** (`orders/:id/facturar`, `global-invoice`, `retry-invoices`, `invoice-reconciliation`) y de **gastos** (`analytics/expenses/*`) — nada de un flujo de campo. `apps/vendor` y `apps/portal` no referencian ningún `FINANCE_*`/`FISCAL_*`.
  - **Requiere RE-LOGIN** de los 25 (los permisos viajan en el JWT). Si alguien de ruta estaba timbrando pedidos, ahora recibe 403 y necesita permiso explícito.
- [x] **[UN.6b]** ✅ 2026-08-20 — UI de `/admin/usuarios` sobre los ejes reales. El aside de departamentos **derivaba el departamento del `role_name`** con la tabla hardcodeada `LEGACY_ROLE_AREA` de `role-presets.ts`, y salía mal: `colaborador → 'mercadotecnia'` (son de ruta) metía a los 19 en Mercadotecnia, y `cajera` no estaba mapeada así que las 28 cajeras caían en "Otros / heredados". Ahora lee `users.department_code`.
  - Backend: `department_code`/`position_code` en los DTO de create/update, en el select de `findAll`/`findOne` (con join a los catálogos para traer el nombre), y 2 endpoints nuevos `GET /users/departments` + `GET /users/positions` (gateados `USUARIOS_VER`, registrados antes de `:id`).
  - Validación previa a escribir (`assertOrgCodes`): un code inexistente daba **500** por violación de FK compuesta; ahora es **400** con el motivo. Verificado.
  - Frontend: catálogos desde API (el aside ya no depende de constantes), selects de Departamento y Puesto en el diálogo, columna "Puesto · Rol · Zona" en la tabla, `DEPT_ICON` local (la taxonomía vive en DB, la presentación en el front). Al crear desde un departamento, precarga ese departamento.
  - Builds `api` + `view` OK. Verificado contra API viva: agrupa 28 Cajas / 23 Ruta Directa / 2 Sistemas / 2 Externo / 1 Administración / 1 sin depto.

- [x] **[UN.6c]** ✅ 2026-08-20 — **Fuga cross-tenant en todo `UsersService`** (encontrada al verificar los endpoints nuevos contra la API viva). `KNEX_CONNECTION` conecta como **superusuario de Postgres, que bypassea RLS incluso con FORCE ROW LEVEL SECURITY** → este service dependía de un `WHERE tenant_id` explícito que casi nunca estaba. Evidencia: `GET /users` devolvía **59 usuarios** (incluía `isouser` y `wsisouser` de otros tenants) y `GET /users/roles` **47 filas para 30 roles**.
  - Alcance: 15 queries en `resolveZonaId`, `assertCanAssignRole`, `assertNotLastSuperadmin` (×2), `create`, `update` (×3), `remove` (×2), `findAll`, `findOne`, `findSupervisors`, `findSellers`, `findBySupervisor`, `getZones`, `getRoles`.
  - Las dos peores no eran de lectura: **`assertNotLastSuperadmin` contaba superadmins de todos los tenants** (un tenant vecino te habilitaba a degradar al último superadmin del tuyo), y **`update`/`remove` operaban por UUID sin verificar tenant**.
  - Fix: helper `private get tenantId()` + filtro explícito en las 15. Verificado: `/users` 57, `departments` 13, `positions` 43, `roles` 30, `zones` 8, `supervisors` 3 — cero duplicados cross-tenant.

- [x] **[UN.6d]** ✅ 2026-08-20 — **Departamento obligatorio al crear** usuario, y tiene que ser uno EXISTENTE. Sin esto las cuentas nuevas nacían en el cajón "Sin departamento" y el padrón se volvía a desordenar solo.
  - `CreateUserDto.department_code` pasa de opcional a requerido. Los 3 decoradores (`IsString`/`IsNotEmpty`/`MaxLength`) comparten el MISMO mensaje: `ValidationPipe` devuelve un array con todos los que fallan y con mensajes distintos el toast mostraba el menos útil ("department_code must be a string").
  - La existencia la valida `assertOrgCodes` contra `identity.departments` del tenant → **400** con el motivo, no 500 por la FK.
  - Frontend: `Validators.required` en el form SOLO al crear (en edición se limpia, si no bloquearía guardar cualquier cambio de las cuentas heredadas sin departamento), marca `*` en el label, mensaje de error propio, placeholder "Elige el departamento" y sin botón de limpiar al crear. Helper `apiError()` toma el primer mensaje cuando el API devuelve array.
  - Verificado contra API viva: ausente→400, vacío→400, inexistente→400 ("El departamento \"no_existe\" no existe."), válido→201. Usuario de prueba limpiado. Builds api+view OK.
  - Nadie más crea usuarios: `POST /users` solo lo consume el admin (verificado — las otras referencias a `/users` son GET, y ningún test crea usuarios por HTTP).

- [x] **[UN.6e]** ✅ 2026-08-20 — UI lista para que **Edgar capture las asignaciones** (él las decide, la UI solo tiene que no estorbar).
  - **Contador accionable "N sin puesto"** en el encabezado, junto al de alertas de acceso: filtra a lo que falta capturar del organigrama. `externo` (portal B2B) se excluye del conteo — un cliente no tiene puesto del organigrama, y contarlo dejaba un pendiente que nunca baja a cero.
  - El aside suma `N sin puesto` por departamento, así el pendiente se ve sin entrar.
  - **Buscar el puesto como está escrito en el PDF**: `filterBy="name,orgText"` alcanza las `org_labels` (31 de 43 puestos traen variantes), así tecleando «ENC. DE SUCURSAL» o «ENCARGADO PADRE HIDALGO» cae en `Encargado de sucursal`. El valor cerrado del select sigue mostrando el nombre corto; las variantes del puesto elegido se confirman en el hint de abajo. Se descartó un `ng-template #item` dentro del `p-select` a propósito: no era verificable desde CLI y un template que no renderiza dejaba el dropdown en blanco.
  - El buscador ahora también matchea por puesto y departamento.
  - `clearFilters()` limpia los 4 filtros (buscador + departamento + 2 toggles) y los vacíos de la tabla explican cuál filtro está activo. Antes el botón limpiaba solo uno y la tabla quedaba vacía sin motivo.
  - Corregido el subtítulo de la página, que seguía diciendo "El departamento sale del rol, no se captura aparte" — justo lo contrario de como funciona ahora.
  - Verificado contra API viva: 57 cuentas / 13 departamentos / **2 sin puesto** = `repartidor_smoke` (cuenta de smoke) y `cristian.lopez` (pendiente de decisión). Builds OK.
  - Gotcha resuelto: un field initializer con `toSignal(this.userForm...)` tira **TS2729** porque el form se arma en el constructor; el signal se alimenta desde la suscripción a `valueChanges` que ya vivía ahí.

- [x] **[UN.10]** ✅ 2026-08-21 — Acceso a **captura de gasto** para el listado de Edgar (Excel "LISTADO DE USUARIOS DE GASTOS", 58 nombres).
  - **Hallazgo clave: alcanza `FINANCE_EXPENSES_CAPTURAR` solo.** La pantalla `/finanzas/capturar-gasto` usa 5 endpoints (`/gastos`, `/upload`, `/validate-photo`, `POST /`, `/mine`) y los 5 aceptan `RequireAnyPermission(CAPTURAR, VER)`. NO llama `/gastos-list`, `/status-by-solicitud` ni `/proofs/departamentos`, que son los que exigen `VER`. Otorgar `FINANCE_EXPENSES_VER` habría deshecho parte de la revocación de `[UN.4]` en 80 personas.
  - Mig `20260821120000`: otorga `CAPTURAR` a los **18 roles** de los 31 usuarios confirmados → 80 de 112 en prod (31 del listado + 49 compañeros de rol; inevitable con 1 usuario = 1 rol). Incluye control que verifica que NO se tocó `VER`.
  - Mig `20260821130000`: rol **`captura_gastos`** ("Solicitudes de gasto y comprobación") con **un solo permiso**, JSONB sparse como `cajera`. `down()` se niega si algún usuario lo tiene (FK RESTRICT).
  - Script `create-expense-capture-users.js`: da de alta las 10 cuentas que no existían, **contraseña aleatoria distinta por persona** (no se agranda la deuda de los 10 que comparten hash), credenciales a CSV fuera del repo. `department_code` NULL a propósito → caen en "Sin departamento" para que Edgar asigne. Validado en local: 10 usuarios, 10 hashes distintos, `bcrypt.compare` OK.
  - **Cruce del Excel: solo 31 de 58 casaron.** CSV de revisión en `Downloads/REVISAR-usuarios-gastos.csv` (4 ambiguos, 14 sin coincidencia con sugerencias, 12 sin usuario).
  - **Duplicados descubiertos: 9 personas con 2 cuentas** (una nombrada + una con código de POS). En las 9 la de POS **nunca se logueó**. Regla de Edgar: gana la nombrada. Esto además explica el `superadmin` raro — `01jzico` es la cuenta muerta de Ivette Cruz, que ya tiene `ivette_cruz`.
  - **5 falsos positivos de deduplicación** (apellidos repetidos = personas distintas): Ivonne≠Ivette Cruz Oceguera, Guillermo≠Luis Francisco López Gutiérrez, Diana Isabel≠José Ramón Rodríguez, Juan Jesús≠Miriam Jazmín Carrillo Contreras, Beatriz Adriana≠María del Pilar Nava Tafoya. **Ojo con esto en `[UN.8]`**: el apellido solo no identifica a nadie en esta empresa.
  - **PROD: solo `20260820200000` (batch 200) y `20260820202000` (batch 201) aplicadas.** Las de este item quedaron pendientes — mis escrituras a prod las bloquea el classifier de forma intermitente; Edgar corre el comando.

- [x] **[UN.10.1]** ✅ 2026-08-21 — Cierre del listado de gastos: **22 altas** con rol `captura_gastos` + 2 roles extra.
  - Segundo lote de 12 altas, verificadas inexistentes **por NOMBRE DE PILA** contra prod (no por apellido): los candidatos que sugería el matcher eran homónimos de apellido — Vázquez pero Ángel, Hernández pero Guillermo, Berber pero María Dolores, Galván pero Cynthia, Tafoya pero Beatriz/Pilar. Ninguno de los 12 existía.
  - Mig `20260821140000`: `coordinadora_marketing` + `gestor_tesoreria`. Dos del listado SÍ existían pero bajo otro nombre y su rol no había entrado: `FERNANDA PATLAN`→`fer_zambrano` ("FERNANDA ZAMBRANO"; en POS figura como *Fernanda Guadalupe Patlán Zambrano*, el sistema guardó solo el 2º apellido) y `MARIPAZ GUTIERREZ`→`maria_gutierrez` ("María de la **Paz** Gutiérrez Guzmán"). Migración aparte y no editando `20260821120000`, que ya corrió en local.
  - Cobertura: **57 de 58**. Solo queda `JUAN TLMK CANINDO` — hay 4 Juan en prod (`jlh_lopez`, `juan_lopez`, `juan_elizarraras`, `jesus_carrillo`) y no se puede desambiguar sin Edgar.
  - Validado en local: 22 usuarios `captura_gastos`, **22 hashes distintos**, los 22 con `department_code` NULL para que Edgar asigne.

- [x] **[UN.11]** ✅ 2026-08-21 — **El sidebar de Compras, Finanzas y Reparto no filtraba por permiso.** Reportado por Edgar: dar `COMPRAS_ENTRADAS_VER` a un `auxiliar_sucursal` "le daba acceso a todo el módulo". Los permisos del rol estaban CORRECTOS (solo `ENTRADAS_VER` + `ENTRADAS_GESTIONAR`); el bug era de UI. `navGroups` pasaba `mapGroups(..., false)` y `navItems` devolvía `flatOf(...)` sin `.filter(hasPermFor)` en esas 3 superficies. El comentario que lo justificaba decía "acceso ya gateado por el route-guard" — y ahí el error: el guard bloquea la NAVEGACIÓN, no oculta el LINK, así que se veían las 12 vistas y al hacer clic rebotaba. Las otras 6 superficies sí filtraban. Verificado que los 12 items de compras / 13 de finanzas / 4 de reparto declaran permiso y que `hasPermFor` respeta `manage all`.
  - **Hallazgo aparte, NO es UI:** `encargado_sucursal` (6 usuarios en prod) tiene **los 21 permisos de Compras**, incluidos `PEDIDO_GESTIONAR`, `PROVEEDORES_GESTIONAR`, `RED_GESTIONAR`, `CATEGORIAS_GESTIONAR`. Origen: `20260811120000_compras_submodule_perms_split.js` ancló todos los `*_VER` a `COMPRAS_VER` y todos los `*_GESTIONAR` a `COMPRAS_GESTIONAR` — mismo patrón que la fuga de Finanzas de `[UN.4]`. Pendiente de decisión de Edgar qué le deja.

- [x] **[UN.12]** ✅ 2026-08-21 — Zona **`NACIONAL` → `OFICINAS`** (mig `20260821150000`). No era una zona de venta: **0 tiendas** y los **22 usuarios** que cuelgan de ella son corporativo (3 superadmin + admin, compras, finanzas, contabilidad, presupuestos, prevención, almacén, marketing, etiquetas). Venía de las zonas semilla de 2026-04 y se usaba como cajón de "los que no son de ruta", así que la etiqueta mentía en cada filtro donde aparecía. Es **solo la etiqueta**: `users.zona_id` y `stores.zona_id` apuntan por UUID, no se movió ninguna relación ni se reasignó a nadie; tampoco toca permisos, así que **no requiere re-login**. Idempotente por tenant, y no fusiona si el tenant ya tuviera `OFICINAS` (lo rechazaría `zones_tenant_name_unique`). Seeds legacy alineados para que un reseed no reintroduzca el nombre viejo. Verificado: privilegios idénticos al baseline (81 usuarios).

- [x] **[UN.13]** ✅ 2026-08-25 — **`/comercial/documentos` no tenía permiso propio** (reportado por Edgar: "no aparece en permisos de rol"). La página nació reusando `COMMERCIAL_ORDERS_VER`, el permiso de **Pedidos** → no había casilla en `/admin/roles`, no se podía dar Documentos sin dar Pedidos ni quitarlo sin quitarlos. Nuevo `COMMERCIAL_SALES_DOCS_VER`, mismo criterio que el split de reportes de Fase AZ. **13 touch-points:** enum backend + frontend, `ability.types` + `ability.factory` (2 mapas), los 4 endpoints de `commercial/sales-documents`, `permission-meta`, `authz-tree` (nodo "Documentos de venta"), route guard, sidebar, tab strip de Reportes, preset `analytics`, tile del proyecto Comercial y landing de `/comercial`. Backfill `← ORDERS_VER` (mig `20260825120000`, 50 filas de rol / 27 usuarios) → nadie pierde acceso.
  - **Hallazgo aparte:** el backfill **excluye los roles del Portal B2B**. `customer_b2b` tiene `ORDERS_VER` porque lo necesita para `GET /commercial/orders/my`, y ahí el servicio le fuerza `customer_id` al del JWT; **`sales-documents` NO hace ese scoping** (filtra sólo por `tenant_id`), así que copiarle la clave le habría abierto las facturas de TODOS los clientes de la tenant — nombre, RFC y monto. El split fue el momento de no arrastrarlo.
  - **Orden de despliegue:** migración **primero**, redeploy después (al revés, quien tenga Pedidos se queda sin la página) + **re-login**.

### Fase ID — Identidad, Accesos y Alcance de Datos (ADR-050) · plan en [`FASE_ID`](FASES/FASE_ID_IDENTIDAD_ACCESOS_ALCANCE.md)

- [x] **[ID.0]** ✅ 2026-08-26 — **Arnés de no-regresión del alcance**: `database/scripts/snapshot-user-scope.js`. Hermano del snapshot de privilegios: ese prueba qué acciones, este sobre qué filas. En vez de comparar configuración (columnas viejas vs tablas nuevas, incomparables) calcula el **conjunto efectivo visible por dimensión** con las reglas viejas (`--mode legacy`) o las nuevas (`--mode scopes`) — eso sí es comparable y el diff debe ser vacío. El universo va **sin `.catch(() => [])` a propósito**: un universo vacío haría que `all` valga lo mismo que `none` y el diff pasaría en verde tapando una regresión. **Foto de prod (117 usuarios):** ven TODAS las sucursales **83/117** · TODAS las zonas 49/117 · TODAS las rutas 117/117 · TODAS las marcas 117/117 · TODAS las áreas de gasto 10/117 · TODOS los clientes 114/117.
  - El arnés **cazó un error mío**: la regla vieja de `customer` que había escrito era más laxa que la real. Un rol de portal sin `customer_id` linkeado NO ve todos los clientes, ve **ninguno** (`resolveCustomerIdFromCtx` → null → página vacía).

- [x] **[ID.1]** ✅ 2026-08-26 — **Schema del alcance** (mig `20260826120000`): `identity.scope_dimensions` (6) + `role_scopes` (default por rol) + `user_scopes` (override por usuario), `mode ∈ {none,own,listed,all}` + `mode_write` aparte desde el día 1. RLS habilitado **y forzado** + policy + trigger + grants. `values` es `text[]` y no `uuid[]` porque las dimensiones no comparten tipo de llave (`warehouse` es code `'03'`, el resto uuid).
  - **Gotcha Postgres que cazó el smoke:** el CHECK contra `listed` sin valores usaba `array_length(values, 1) > 0`, pero para un array **vacío** `array_length` devuelve NULL, `NULL > 0` es NULL, y un CHECK solo rechaza cuando da FALSE → `values = '{}'` se colaba. Corregido a `cardinality(values) > 0`.
  - Dos hallazgos de paso: **`public.users` le faltaba `warehouse_id`** — la vista que lee el login se agregó antes que la columna y nunca se actualizó. Y `commercial.warehouses.kind` **ya existía** con vocabulario `central | truck`, así que no se inventó uno nuevo: la dimensión filtra por **código de 2 dígitos**, que es lo que `users.warehouse_code` puede contener y lo que Kepler usa como sucursal (`central` incluiría `MD-30`/`MD-32`, que no tienen código Kepler).

- [x] **[ID.2]** ✅ 2026-08-26 — **`ScopeService`** en `libs/platform-core/src/lib/scope/`: el único lugar donde se resuelve y se aplica el alcance. Resolución `user_scopes → role_scopes → none` con cache TTL 30s espejando `PermissionsCacheService`; `applyTo` / `canRead` / `canWrite` / `assertCanWrite` / `intersect` / `describe`. God-mode para `superadmin`/`admin` igual que `manage:all` (sin eso, un superadmin con `zona_id` heredado quedaba filtrado a esa zona — bug ya vivido en `commercial-map`). `KNEX_CONNECTION` es superuser y **bypassa RLS**, así que toda query lleva `tenant_id` explícito. Endpoints `GET /users/me/scope` (sin `@RequirePermissions`: pedir un permiso para saber qué podés ver es circular) y `GET /users/:id/scope` para el panel "Acceso efectivo", declarados **antes** de `:id`.
  - **Gotcha TS:** `new Map(rows.map(r => [r.dimension, r]))` infiere `(ScopeDimension | ScopeRuleRow)[][]` y `.get()` devuelve `{}` → 8 errores de compilación. Anotación de tupla explícita.

- [x] **[ID.3]** ✅ 2026-08-26 — **Materialización sin regresión** (mig `20260826121000`), el paso que evita el apagón. `role_scopes`: `warehouse`/`zone` = `own` — acá **sí cambia la política, para las altas NUEVAS**, que hoy nacen viendo la red completa (pasó con las 22 de `[UN.10.1]`). `user_scopes`: `all` **explícito** para los que hoy no tienen sucursal/zona, así nadie pierde acceso **y el privilegio deja de ser invisible** — queda contable, listable y recortable uno por uno. Ése es el entregable real: convertir un default silencioso en una lista de pendientes. Local: 276 `role_scopes` + 102 `user_scopes`. **Verificado: diff `legacy → scopes` VACÍO** (81 usuarios) + smoke `test-newdb-identity-scopes` **26/26**, ya en la suite de regresión.

- [x] **[ID.4]** ✅ 2026-08-26 — **Primer dominio migrado**: `/tienda/analisis-semanal` (`store-analytics.controller` + `weekly-analytics.service`). Se fue el fail-OPEN `const effective = user?.warehouse_code || warehouseCode || undefined` — que forzaba la sucursal al que la tenía y **respetaba el query param al que no**. Ahora `ScopeService.intersect()` recorta lo pedido a lo permitido, y el servicio acepta `warehouse_codes[]` (`= ANY(?)`) en vez de un solo código: **"la suya + la 03" por fin se puede expresar**. Recorte silencioso y no 403 — el endpoint alimenta un tablero de varios widgets y un 403 rompe la pantalla entera. Build api OK.
  - Verificado que las 3 suites DB-direct que fallan en local (`B.2 orders`, `I.1 inventario`, `CC ext pagos`) **fallan igual con las migraciones ID rolleadas para atrás** → preexistentes (data local stale). Las otras 39 fallas de la corrida son las HTTP E2E sin API arriba.

- [x] **[ID.5]** ✅ 2026-08-26 — **Contrato canónico de params + capa de alias**. `libs/platform-core/.../scope-params.ts` (puro: nombre canónico por dimensión — `warehouse_codes`/`zone_ids`/`route_ids`… — + los alias medidos) y `ScopeService.readParam()`, que lee, normaliza y recorta en un solo paso. Los 16 nombres viejos siguen funcionando y se avisa la deprecación **una vez por alias**, no por request (un tablero de 8 widgets no debe escribir 8 líneas).
  - **La trampa no era el nombre, era la llave.** El mismo dominio usa las dos: verificado en `commercial-analytics.service`, `@Query('warehouse_id')` va a `s.warehouse_id` (**UUID**) y `@Query('warehouses')` a `commercial.warehouses.code` (**código `'03'`**). Por eso esto NO mapea alias→alias: normaliza a la **llave canónica de la dimensión** (`ref_key`), aceptando uuid, código o etiqueta y traduciendo contra la tabla de referencia. Lo que no existe se descarta **y se loguea** — dejarlo pasar lo volvería un `IN (...)` que no matchea y el filtro se leería como "sin resultados" en vez de "escribiste mal el parámetro".
  - Smoke `test-newdb-scope-params` **35/35**, cargando el `.ts` REAL vía ts-node (patrón `entity-ref`). Cubre las 3 formas de mandar lista (CSV / repetido / único), trim+dedupe **sin `[...new Set()]`** (webpack lo baja a `[Set]` → 22P02) y, sobre todo, **`null` ≠ `[]`**: "no pidió nada" vs "pidió lista vacía" es de lo que depende que `all` no se convierta en `none`.

- [x] **[ID.3-fix]** ✅ 2026-08-26 — **Corrección de una aserción mal planteada del smoke de `[ID.1-3]`.** Afirmaba que *"todo usuario sin sucursal tiene un `all` explícito"*, y eso **no es un invariante**: es una foto del padrón que existía cuando corrió `[ID.3]`. Un usuario que llega después —alta nueva, restore, sync desde otro ambiente con `created_at` viejo— cae al default del rol (`own`), y sin sucursal asignada eso significa "no ve nada": **el fail-closed funcionando, no una regresión**. Ahora se afirma lo que sí es invariante (que lo materializado es coherente y que nadie con sucursal recibió un `all` de regalo) y los usuarios sin cobertura se **reportan como pendientes de asignar**. Quien vigila que nadie pierda acceso es `snapshot-user-scope.js`, no este test.
  - Lo destapó el espejo `.245` al recibir las **22 cuentas `captura_gastos`** después de la materialización: hoy salen en el reporte como *"22 sin `warehouse_code` y sin regla → caen al default"*. En prod esas cuentas todavía no existen (el `create-expense-capture-users.js --apply` sigue pendiente allá); **cuando se creen van a nacer fail-closed**, que es lo correcto, pero hay que asignarles sucursal o no verán las superficies migradas.
- [ ] **[ID.6]** ⬜ `<md-scope-picker>` compartido + `ScopeStore` (hoy **56 archivos** del front tocan `warehouse_code` y no hay componente común).
- [ ] **[ID.7]** ⬜ DTO único de usuario (`UserWriteDto` base; muere `zona` como entrada duplicada de `zone_id`; validar contra catálogo y no con regex).
- [ ] **[ID.8]** ⬜ Ciclo de vida: `status` + `activo` GENERATED + `must_change_password` + `identity.user_events`. Cierra `[UN.7]`.
- [ ] **[ID.9]** ⬜ Pantalla nueva de `/admin/usuarios`: master-detail 4 pestañas + panel **"Acceso efectivo"** + acciones masivas.
- [ ] **[ID.10]** ⬜ "Ver como" (impersonación read-only auditada).
- [ ] **[ID.11]** ⬜ `identity.people`: crosswalk de los 5 padrones (`[UN.8]`).
- [ ] **[ID.12]** ⬜ Enum `Permission` a fuente única (`[UN.6]`) + archivar roles sin usuarios (`[UN.5]`) + tirar `meta_puntos`.

- [ ] **[UN.5]** ⬜ Archivar los 22 roles sin usuarios. Necesita fix de código: `catalogs.service.ts` lista roles **sin filtrar `deleted_at`**, así que el soft-delete solo no los oculta.
- [ ] **[UN.6]** ⬜ Colapsar el enum `Permission` a fuente única (borrar el de `shared-auth`, generar portal/vendor desde `platform-core`).
- [ ] **[UN.7]** ⬜ Reset de contraseña de los **11 usuarios que comparten el mismo hash bcrypt**. No hay flujo de cambio obligatorio.
- [ ] **[UN.8]** ⬜ `identity.people` + crosswalk de los 8 padrones (dedup validable contra las 120 plazas del organigrama).
- [ ] **[UN.9]** ⬜ Casing de `nombre` (UPPER vs Title Case), backfill `warehouse_id` (bloqueado por `commercial.warehouses.kepler_code` vacío), purga de 3 tenants de prueba.

**Hallazgos que necesitan a Edgar:** (1) el organigrama describe 5 sitios pero Kepler opera 7 — Yurécuaro `04` y Zamora Centro `05` tienen 7 cajeras y no aparecen; Morelia Abastos y Madero suman 55 plazas y 0 usuarios. (2) Morelia Abastos declara 40 pero suma 42: `CAJA GENERAL (1)` dibujado **detrás** de `AUX. DE RR-HH (1)`, y `CHECADOR (1)` + `CHECADORES (2)` duplicados. (3) `cristian.lopez` es rol `jefe_marketing` pero el organigrama solo tiene `AUX. DE MKT (1)` → quedó sin puesto.

---

## 📋 BACKLOG — Fases G, H, I

_(Items detallados se agregan al iniciar cada fase. Plan macro está en cada `FASES/FASE_X_*.md`)_

---

## 📝 Convenciones

- **Códigos** `[A.0.1]` = Fase A, Sprint 0, Item 1.
- **Commits** referencian el código: `feat([A.1.2]): integrate Sentry SDK in NestJS`.
- **Cerrar item**: marcar checkbox + agregar fecha de cierre en comentario.
- **Bloqueado**: agregar `🚫 BLOQUEADO: <razón>` en el item.
- **Si descubrís un item nuevo durante una fase**: agregarlo al sprint con el siguiente número correlativo.
