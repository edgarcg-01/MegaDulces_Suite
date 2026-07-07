# FASE MAAT — AI de Finanzas: conocimiento + chat + detección de patrones

> **Estado:** 🔨 EN CURSO — MAAT.0 ✅ 2026-07-06 · **ADR:** ADR-028 (aceptado)
> **Hermanos:** Thot (comercial, ADR-018) · Horus (trade, ADR-020/021). Maat = diosa egipcia de la **verdad y la balanza** (el corazón se pesa contra su pluma) — contabilidad es literalmente eso.
> **Pedido original (Edgar):** "crear una AI entrenada con toda la información de finanzas para que aprenda todo lo que hay, que tenga un chat, y vaya aprendiendo cómo funciona para encontrar patrones buenos y malos".

---

## 0. Tesis: qué significa "entrenada" aquí (y qué NO)

**NO vamos a fine-tunear un LLM con la contabilidad.** Razones duras:

| Fine-tuning | Nuestro enfoque |
|---|---|
| Caro y lento (re-entrenar cada mes al cambiar la data) | La data vive en Postgres; el modelo la consulta **en vivo** |
| Alucina cifras (el peor pecado posible en finanzas) | **Cero números del LLM**: todo número sale de una tool SQL determinista |
| Inauditable ("¿de dónde sacó ese $14M?") | Cada respuesta trae las tool calls que la produjeron (log completo) |
| Congela el conocimiento al día del training | El conocimiento es una tabla editable + memorias que crecen |

En su lugar, "entrenamiento" = **cuatro mecanismos reales y auditables** (mismo credo que ADR-016/021: *el motor decide, el agente comunica, el LLM fuera del camino del dinero*):

1. **Conocimiento curado** — el modelo contable Kepler ya descifrado ([`KEPLER_CONTABILIDAD_MODELO.md`](../KEPLER_CONTABILIDAD_MODELO.md): 7 familias, ciclos, cutover presupuesto→factura, 10 anomalías) se convierte en la base de conocimiento del agente (system prompt + tabla `finance.knowledge`).
2. **Acceso total vía tools** — el chat consulta TODA la información financiera en vivo (balanza completa, egresos, proveedores, documentos, líneas de producto, hallazgos, ventas para P&L) mediante tools parametrizadas read-only. Patrón **Thot Chat (ADR-026)**, ya validado en producción — no RAG, no SQL libre.
3. **Motor de patrones determinista que SÍ aprende** — detectores estadísticos (baselines por cuenta×sucursal×mes, precio por proveedor×SKU, DPO, Benford, duplicados…) que producen **hallazgos** con evidencia reproducible. Port de la taxonomía de aprendizaje de **Horus (ADR-021)**: L0 memoria → L1 baselines → L2 auto-calibración por feedback.
4. **Feedback loop** — Finanzas marca cada hallazgo (útil / falso / ya corregido) y cada respuesta del chat (👍/👎). Eso recalcula la precisión por regla y **suprime automáticamente las reglas ruidosas** (Horus L2). El chat guarda hechos validados como memorias L0 ("XD5501 es el bug de IVA conocido, ya reportado a Kepler").

**Los patrones "malos" y "buenos"** que pide Edgar son las dos clases del motor:
- **Riesgo/error** (malos): anomalías de gasto, duplicados, fraude-screening, IVA mal capitalizado, cadenas de aprovisionamiento rotas, deterioro de DPO.
- **Oportunidad** (buenos): spread de precio entre proveedores del mismo SKU, ahorro potencial, proveedores con mejor comportamiento, estacionalidad aprovechable.

---

## 1. Qué información "sabe" Maat (inventario + gaps)

### Ya existe (Fase GX, verificado en prod 2026-07-06)

| Fuente | Contenido | Volumen |
|---|---|---|
| `analytics.expense_entries` | Pólizas de egreso (511 compras + 6xx gastos) por sucursal, cuenta, beneficiario, área, doc | ~12 meses, 6 sucursales |
| `analytics.expense_documents` | Cabecera del documento fuente (proveedor, RFC, concepto, IVA, usuario) | 13,854 docs |
| `analytics.expense_document_lines` | Líneas de producto de compras (SKU, cantidad, costo unitario) | 76,006 líneas |
| `analytics.ap_provider` | Auxiliar 201: compra/pagos/saldo/DPO por proveedor | 729 proveedores |
| `analytics.expense_findings` | Hallazgos v1: `iva_bug` ($996,877/449 docs), `prov_203` ($14.07M), `anticipo_107` ($11.44M) | 2,034 filas |
| `mart.ventas` / `analytics.sales_daily` | Venta real de la red (feeds Kepler existentes) | vivo |
| [`KEPLER_CONTABILIDAD_MODELO.md`](../KEPLER_CONTABILIDAD_MODELO.md) | El "libro de texto": modelo contable descifrado, ciclos, anomalías | doc |

### Gaps a cerrar (feeds nuevos)

| Gap | Qué falta | Sprint |
|---|---|---|
| **Balanza completa** | Hoy solo alimentamos familias 5/6 (egresos). Para "toda la información" faltan: 1 Activo (bancos 102, clientes 107, IVA 118/122), 2 Pasivo (201/203), 4 Ingresos, 7 Impuestos. Solución: feed **agregado mensual** `analytics.ledger_monthly` (cuenta × sucursal × mes × cargos/abonos) — la balanza de comprobación. Liviano (miles de filas, no millones) y suficiente para P&L + análisis de saldos. | MAAT.1 |
| **Cadena de aprovisionamiento** | Lineage kdm1 **YA DESCIFRADO** (2026-07-06): c39 es un puntero enlazado factura→pago→recepción→orden, correlacionable por beneficiario+total. Absorbe GX.4.3b. Habilita el detector `cadena_incompleta` (factura sin recepción = red flag clásico de auditoría). | MAAT.1 |
| **Pagos con fecha** | Para DPO real (hoy aproximado saldo/compra) se necesita el detalle de pagos XA4001 con fechas. Mismo feed de la cadena lo trae. | MAAT.1 |

---

## 2. Arquitectura (5 capas, espejo de ADR-016)

```
┌─────────────────────────────────────────────────────────────────┐
│  5. FEEDBACK / APRENDIZAJE                                       │
│     finding_feedback + chat 👍👎 → precisión por regla →          │
│     auto-supresión (L2) · memorias validadas (L0) ·               │
│     baselines nocturnos (L1)                                      │
├─────────────────────────────────────────────────────────────────┤
│  4. AGENTE (chat "Pregúntale a Maat")                            │
│     Claude tool-use + streaming SSE · system prompt = modelo     │
│     contable + memorias · NUNCA calcula, siempre llama tools     │
├─────────────────────────────────────────────────────────────────┤
│  3. MOTOR DE PATRONES (determinista, cron nocturno)              │
│     ~14 detectores → finance.findings con evidencia reproducible │
│     y dedup_key · clases: riesgo | error_captura | oportunidad   │
├─────────────────────────────────────────────────────────────────┤
│  2. CONOCIMIENTO                                                 │
│     finance.knowledge (definiciones, hechos, issues conocidos)   │
│     seed desde KEPLER_CONTABILIDAD_MODELO.md · crece por chat    │
├─────────────────────────────────────────────────────────────────┤
│  1. DATOS (feeds deterministas, ya existentes + 2 nuevos)        │
│     expense_* · ap_provider · ledger_monthly · doc_chain ·        │
│     sales_daily (P&L)                                            │
└─────────────────────────────────────────────────────────────────┘
```

**Dónde vive:** nueva lib Nx **`libs/finance`** (cierra el pendiente de la memoria del proyecto "lo contable nuevo va aquí"). Frontera limpia: NO importa de `libs/commercial`; tiene su propio query-service read-only sobre `analytics.*`/`finance.*` (duplicación mínima y consciente, igual que Horus vs Thot). Endpoints bajo `/finance/maat/*`.

---

## 3. Schema propuesto (`finance.*`)

Todas con `tenant_id UUID NOT NULL` + audit fields + RLS forzado + grants `app_runtime` (convención A.0mt).

```sql
-- Base de conocimiento (lo que Maat "sabe" además de la data)
finance.knowledge (
  id uuid PK, tenant_id,
  kind text CHECK (kind IN ('definicion','hecho','regla_negocio','issue_conocido')),
  title text, body text,               -- markdown corto
  source text CHECK (source IN ('seed','chat','finanzas')),
  status text DEFAULT 'active',        -- active | retired
  created_by text, created_at, updated_at
)

-- Baselines estadísticos (L1) — recalculados por cron nocturno
finance.baselines (
  tenant_id, scope text,               -- cuenta_suc_mes | proveedor_sku | proveedor_dpo | benford_cuenta
  key jsonb,                           -- {cuenta:'601', sucursal:'03'} / {proveedor:..., sku:...}
  stats jsonb,                         -- {mean, stddev, p50, p95, n, months, updated}
  computed_at, PK (tenant_id, scope, key)
)

-- Hallazgos v2 (unifica y supersede analytics.expense_findings)
finance.findings (
  id uuid PK, tenant_id,
  rule_key text REFERENCES finance.rule_registry,
  clase text CHECK (clase IN ('riesgo','error_captura','oportunidad')),
  severity text CHECK (severity IN ('info','warn','critical')),
  status text DEFAULT 'nuevo',         -- nuevo | en_revision | confirmado | descartado | corregido
  score numeric,                       -- 0..1 confianza del detector
  titulo text, resumen text,
  entity jsonb,                        -- {cuenta, proveedor, sucursal, doc_tipo, doc_folio, sku}
  periodo text,                        -- 'YYYY-MM'
  importe numeric,                     -- $ en juego
  evidencia jsonb,                     -- params + sample de filas → 100% reproducible
  dedup_key text UNIQUE,               -- rule_key + entity canónica + periodo (re-runs idempotentes)
  first_seen, last_seen, created_at, updated_at
)

finance.finding_feedback (
  id uuid PK, tenant_id, finding_id FK,
  verdict text CHECK (verdict IN ('util','falso','duplicado','ya_corregido')),
  nota text, created_by text, created_at
)

-- Registry de reglas con aprendizaje L2 (port exacto del patrón Horus)
finance.rule_registry (
  rule_key text PK, tenant_id,
  nombre text, descripcion text, clase text,
  params jsonb,                        -- umbrales editables sin deploy
  enabled boolean DEFAULT true,
  pinned boolean DEFAULT false,        -- pin humano: nunca auto-suprimir
  precision_score numeric,             -- confirmados / (confirmados + falsos)
  findings_total int, findings_confirmados int, findings_falsos int,
  suppressed_auto boolean DEFAULT false,
  updated_at
)

-- Audit del chat (cada conversación es auditable)
finance.chat_sessions (id, tenant_id, user_id, username, started_at, last_at, turns int)
finance.chat_messages (id, session_id, role, content text, tool_calls jsonb, tokens_in, tokens_out, feedback text NULL, created_at)
```

**Feeds nuevos (en `analytics.*`, siguen siendo data):**

```sql
analytics.ledger_monthly (      -- balanza de comprobación completa
  tenant_id, sucursal, cuenta, cuenta_nombre, cuenta_mayor, familia,
  anio_mes text, cargos numeric, abonos numeric, neto numeric, movs int,
  computed_at, PK (tenant_id, sucursal, cuenta, anio_mes)
)

analytics.expense_doc_chain (   -- cadena orden→recepción→factura→pago (GX.4.3b absorbido)
  tenant_id, sucursal, factura_folio,          -- ancla = XA2001
  orden_folio, orden_fecha, recepcion_folio, recepcion_fecha,
  factura_fecha, pago_folio, pago_fecha,
  beneficiario, total numeric,
  lead_days int,                -- orden→factura
  pago_days int,                -- factura→pago (DPO real por documento)
  match_confidence text,        -- 'exact' (puntero c39) | 'inferred' (benef+total+fecha)
  computed_at, PK (tenant_id, sucursal, factura_folio)
)
```

---

## 4. Motor de patrones — catálogo v1 (~14 detectores)

Cada detector corre en cron nocturno (3 AM MX, patrón `AnalyticsRefreshService`), lee baselines, escribe `finance.findings` con `dedup_key` (idempotente). **Sin LLM en este camino** — puro SQL/estadística.

| # | rule_key | Clase | Lógica | Severidad |
|---|---|---|---|---|
| 1 | `gasto_atipico_zscore` | riesgo | \|z\| ≥ 3 del gasto mensual vs baseline 12m de (cuenta×sucursal) | warn/critical por magnitud |
| 2 | `salto_precio_sku` | riesgo | costo unitario > p95 histórico de (proveedor×SKU) +X% | warn |
| 3 | `posible_duplicado` | riesgo | mismo proveedor + importe ±0.5% + ventana 5 días + folios distintos | critical |
| 4 | `factura_redonda` | riesgo | concentración anómala de importes redondos por proveedor (screening de fraude clásico) | info |
| 5 | `benford_desvio` | riesgo | chi² del primer dígito por (cuenta×trimestre) fuera de banda — screening, NO prueba | info |
| 6 | `proveedor_nuevo_grande` | riesgo | proveedor sin historial que entra directo al decil alto de compra mensual | warn |
| 7 | `dpo_deterioro` | riesgo | saldo/compra creciendo 3+ meses seguidos, o DPO > umbral configurable | warn |
| 8 | `cadena_incompleta` | riesgo | factura XA2001 sin recepción XA3701 correlacionada (pagar sin recibir = red flag de auditoría) | critical |
| 9 | `iva_capitalizado` | error_captura | port del `iva_bug` actual (XD5501/122 huérfano) al registry | warn |
| 10 | `anticipo_stale` | error_captura | anticipos 107 sin aplicar > 60 días (port `anticipo_107`) | warn |
| 11 | `prov_203_orfano` | error_captura | port `prov_203` | warn |
| 12 | `captura_incompleta` | error_captura | % de egresos sin beneficiario/área por sucursal×mes sobre umbral | info |
| 13 | `spread_proveedor_sku` | **oportunidad** | mismo SKU comprado a 2+ proveedores con >X% de diferencia de precio → ahorro potencial $ (cuantificado) | info |
| 14 | `estacionalidad_rota` | riesgo/oportunidad | mes vs mismo mes del año previo fuera de banda (gasto O ingreso, con la balanza) | info |

Umbrales en `rule_registry.params` (editables desde el chat por Finanzas con `pending_approval`-style, o directo en DB) — cambiar un umbral NO requiere deploy.

---

## 5. El chat — "Pregúntale a Maat"

**Patrón Thot Chat (ADR-026)**, ya probado: endpoint NestJS que orquesta Claude con tool-use en loop, streaming SSE al frontend.

- **Endpoint:** `POST /finance/maat/chat` (SSE) + `GET /finance/maat/sessions/:id`.
- **Modelo:** `claude-sonnet-5` para el chat (calidad de razonamiento con tools); `claude-haiku-4-5` para tareas baratas (clasificar feedback, titular sesiones). Config por env.
- **System prompt:** modelo contable Kepler condensado (familias, ciclos, cutover dic-2025, los 3 bugs conocidos) + memorias `finance.knowledge` activas + fecha/tenant + reglas duras ("nunca inventes un número; si una tool no lo devuelve, di que no lo tienes").
- **Tools (read-only, parametrizadas — NO SQL libre):**

| Tool | Devuelve |
|---|---|
| `get_balanza(from_mes, to_mes, familia?, cuenta?, sucursal?)` | balanza / saldos por cuenta |
| `get_pnl(mes)` | estado de resultados: ingresos (fam 4) − costo (5) − gastos (6) por sucursal |
| `get_egresos(from, to, group_by, filtros…)` | wrapper del motor GX existente |
| `get_proveedor_360(nombre)` | resumen 201 + top SKUs + cadena/DPO |
| `get_documento(sucursal, tipo, folio)` | cabecera + posturas + líneas + cadena |
| `get_findings(status?, rule?, clase?, periodo?)` | bandeja de hallazgos |
| `get_baseline(scope, key)` | qué es "normal" para X |
| `search_knowledge(q)` / `save_knowledge(kind, title, body)` | leer/escribir memoria (write con atribución de usuario) |
| `compare_periodos(a, b, dimension)` | diffs mes-a-mes / año-a-año |

- **Guardrails:** tenant fijo del JWT (`TenantKnexService.run()` — lección E), máx 12 tool calls/turno, timeout por tool, permiso `FINANCE_AI_CHAT`, log completo de cada tool call en `chat_messages.tool_calls`, throttle tier `long`.
- **Aprendizaje conversacional:** cuando Finanzas valida un hecho en el chat ("sí, ese proveedor es intercompañía"), Maat ofrece guardarlo (`save_knowledge`) → entra al system prompt de futuras sesiones. Así "va aprendiendo cómo funciona".

**Frontend:** página `/finanzas/maat` (patrón UI de Thot Chat ya existente: burbujas + tool-chips + streaming). Más: botón contextual **"Pregúntale a Maat"** en `/finanzas/egresos` y `/finanzas/egresos/detalle` que abre el chat con el contexto del filtro actual pre-cargado ("estoy viendo cuenta 601 × DE LA ROSA × mayo").

---

## 6. Aprendizaje (port de ADR-021, ship-collector-before-learner)

| Nivel | Qué | Cuándo |
|---|---|---|
| **L0 memoria** | `finance.knowledge` crece con hechos validados por Finanzas vía chat. Inyectado a cada sesión. | MAAT.3 |
| **L1 baselines** | Cron nocturno recalcula `finance.baselines` (media/σ/p95 por cuenta×suc×mes, proveedor×SKU, DPO). Los detectores consumen esto — "lo normal" se aprende de la historia, no se hardcodea. | MAAT.4 |
| **L2 auto-calibración** | `precision_score` por regla desde feedback → si precision < 0.3 con n ≥ 10, `suppressed_auto = true` (deja de generar ruido). `pinned` humano la protege. | MAAT.5 |
| **Colector primero** | Los botones de feedback (hallazgos + chat) shipean en MAAT.2/3 aunque el learner llegue en MAAT.5 — la data de entrenamiento se acumula desde el día 1. | MAAT.2 |
| L3+ (efectividad diff-in-diff, pesos adaptativos) | Diferido — igual que Horus, gate por calendario/volumen de feedback. | post-beta |

### 6.1 ¿Esto es deep learning / machine learning? (pregunta de Edgar 2026-07-06)

Sí, ambos — cada técnica donde gana:

| Cerebro | Técnica | Nota |
|---|---|---|
| Chat/razonamiento | **Deep learning** (Claude Sonnet 5, pre-entrenado) | No lo entrenamos: lo usamos. Upgrade de modelo = 1 env var; un fine-tune propio se congela. |
| Motor de patrones | **ML estadístico** (baselines μ/σ/p95, Benford, estacionalidad) | Aprende "lo normal" de la historia propia; recalcula nocturno. |
| Calibración | **Online learning** (precisión por regla desde feedback) | Auto-supresión de reglas ruidosas; medible y reversible. |
| MAAT.4-5+ | **Isolation Forest** (no supervisado) y luego **XGBoost** sobre etiquetas de feedback | Gate = volumen de etiquetas (~cientos), no código. Ship-collector-before-learner. |

**Por qué NO red neuronal propia sobre la contabilidad:** 13,854 docs / 12 meses = overfit garantizado (DL necesita millones de ejemplos); en data tabular gradient boosting > NN (resultado estándar); y finanzas exige explicabilidad — "4σ sobre su promedio 12m, aquí las filas" es accionable, "la red dice 0.87" no. Es la misma arquitectura de los sistemas antifraude bancarios reales: reglas + baselines + modelo sobre feedback + humano en el loop.

---

## 7. Sprints

| Sprint | Entregable | Criterio de cierre |
|---|---|---|
| **MAAT.0 — Fundación** ✅ 2026-07-06 | ADR-028 aceptado · lib `libs/finance` (module + knowledge service/controller + boundaries eslint `scope:finance`) · migración `20260706190000` schema `finance.*` (7 tablas RLS forzado) + `20260706191000` backfill `FINANCE_AI_CHAT`/`FINANCE_FINDINGS_GESTIONAR` (15 roles local; heredan FINANCE_EXPENSES_VER) · seed `database/scripts/seed-maat-knowledge.js` → **27 entries** (7 def + 7 hechos + 7 issues + 6 reglas) · endpoints `GET/POST /finance/maat/knowledge` + `/stats` | ✅ migración local Batch 139 · RLS smoke 0/27/0 · lint + builds api/view verdes · **pendiente aplicar a prod + re-login** |
| **MAAT.1 — Data completa** ✅ 2026-07-07 | Migración `20260707100000` (`ledger_monthly` + `expense_doc_chain`, Batch 140 local) · importer `import-ledger-chain.js` (un sweep por sucursal: balanza 19 meses fam 1-9 + cadena por lineage c39 con validación benef+total y fallback inferido ±10d) · **fix crítico descubierto**: las DBs arrastran réplicas de otras sucursales (DB03 tenía las filas '02' de dic/ene 100% duplicadas + 1,975 docs kdm1 ajenos) → filtro `c14`/`c1` = sucursal propia · backend `expenseDocument` devuelve `chain` (timeline del detalle despierta) · **fix tools MAAT.3**: tenant_id explícito en todas las queries `analytics.*` (sin RLS) · +3 tools: `maat_balanza`, `maat_pnl`, `maat_cadena` | ✅ 2,286 filas balanza + 9,800 cadenas. **Cuadre 7 familias vs análisis contable** (fam4 $729.6M~$726M, fam5 $1,473M~$1,467M) y la balanza **reproduce sola el bug de partida doble** (−$972k ene-may → jun corrige). Cadena BOTANAS 0000754 = folios exactos verificados a mano. Cobertura: sucursales 91.5% exact; CEDIS 57% (partial = arranque ene-feb 2026, señal real del detector). Smoke **19/19** (Maat contesta ingresos mar-2026 $61.8M y advierte caveats sola). **Cron nightly pendiente** (correr `--months 2` diario). |
| **MAAT.2 — Motor v1 + bandeja** ✅ 2026-07-07 | `MaatDetectorService` con **10 detectores** en 3 clases (riesgo: cadena_incompleta, posible_duplicado, gasto_atipico z-score, salto_precio_sku, dpo_largo, proveedor_nuevo_grande · error_captura: iva_capitalizado, prov_203_orfano, anticipo_stale = ports de expense_findings v1 · oportunidad: spread_proveedor_sku) → `finance.findings` UPSERT idempotente por dedup_key. `ensureRules` = catálogo code-driven que PRESERVA calibración humana (params/pinned/precision). `MaatScannerService` @Cron nocturno (3 AM MX) por tenant + `POST /findings/scan` manual. `MaatFindingsService`: bandeja (list/stats/rules) + triage (status) + **feedback L2** (util/falso → recalcula `precision_score`; precisión<0.3 con ≥10 veredictos → `suppressed_auto`, salvo `pinned`). `maat_hallazgos` del chat ahora lee `finance.findings`. Frontend `/finanzas/hallazgos` (Operations): KPIs + filtros clase/status + tabla densa con severidad, evidencia expandible, confirmar/descartar, link a la póliza + panel de salud de reglas con pin. | ✅ smoke **36/36**: scan → **103 hallazgos** (cadena_incompleta agregada, ej. "48 facturas sin recepción de BOLSAS DE LOS ALTOS $5.5M" critical), 10 reglas/3 clases, feedback confirma→precisión→sale de pendientes. Detectores sobre feeds prod-only (docs/lines/ap) corren y dan 0 local (verificables en prod). |
| **MAAT.3 — Chat** ✅ 2026-07-06 (adelantado a pedido de Edgar; tools sobre data existente, sin esperar MAAT.1) | Backend `libs/finance`: `MaatToolsService` (7 tools: egresos/serie/proveedor/documento/hallazgos/conocimiento/guardar) + `MaatChatService` (loop tool-use port de Thot Chat, Haiku default + Sonnet think, deep search, Claude vision) + `POST /finance/maat/chat` + `/chat/feedback` (throttle long 15/min) + audit completo `chat_sessions/messages` (tool_calls + tokens). System prompt inyecta las **27 entries de conocimiento** en vivo. Frontend: `/finanzas/maat` **réplica fiel del diseño /thot-chat** (thread tc-*, bloques de datos con tablas/KPIs/mini-barras, markdown seguro, composer `ThotAiInputComponent` reusado con think/deep/imagen/voz) + **👍/👎 por respuesta** (colector L2) + tab/nav/authz-tree. | ✅ smoke E2E **17/17** (`database/tests/http-maat-chat-test.js`): LLM real 2 turnos con tools, misma sesión, feedback persistido, audit en DB; ante dato ausente responde "no lo tengo" (0 inventos). Golden-questions formales quedan para el cierre de fase. **Prod requiere `ANTHROPIC_API_KEY` en Railway.** |
| **MAAT.3.1 — Maat navegable/proactiva/visual/confiable** ✅ 2026-07-07 | **Navegable**: tool `maat_buscar_documentos` (busca pólizas sin folio, por proveedor/período/monto) + `ui_url` (deep-link) en docs → chat renderiza links internos SPA (event-delegation, sin recargar) + botón "Ver póliza →" por fila; el detalle de egresos abre el diálogo por `?doc_sucursal/doc_tipo/doc_folio`. **Proactiva**: `MaatBriefingService` + `GET /briefing` (empty-state con tarjetas: gasto 30d Δ%, hallazgos, sin-recepción, saldo top) + tool `maat_alertas` (detector-lite: duplicados/salto precio/DPO/sin-recepción — adelanto MAAT.2) + follow-up chips (marcador `[[SEGUIR]]` extraído en el service). **Visual**: gráficas de tendencia (Chart.js) para series mensuales + export CSV/Excel por bloque. **Confiable**: few-shot en el prompt + regla de verificabilidad + catálogo sucursal código→nombre. | ✅ smoke **27/27**: briefing con cards+sugerencias, `maat_buscar_documentos`/`maat_alertas` invocadas, follow-ups presentes, deep-link (tool) gated por data local. En vivo Maat detectó **631 facturas $52.2M sin recepción** sin que se lo pidieran. |
| **MAAT.4 — Aprendizaje L0/L1** | `save_knowledge` desde chat · cron baselines nocturno · detectores 1/2/7/14 consumen baselines (dejan de usar umbrales fijos) | baseline coverage ≥ 80% cuentas activas; z-scores estables en re-runs |
| **MAAT.5 — Aprendizaje L2** | precision_score + auto-supresión + pin · panel mini de salud de reglas en la bandeja | regla ruidosa sintética se auto-suprime en test; pinned nunca |
| **MAAT.6 — Proactividad** | Parte financiero semanal (1 llamada LLM que narra los findings top de la semana) · alertas WS para findings `critical` (reusa AlertsGateway) | parte generado con números correctos; alerta llega al Command Center |

**Ruta crítica:** MAAT.0 → MAAT.1 → MAAT.2 → MAAT.3. (4-5 sesiones al ritmo actual del proyecto; MAAT.4-6 incrementales después.)

> **Nota de orden real:** MAAT.3 se **adelantó** (2026-07-06, pedido de Edgar: chat primero, replicando /thot-chat) y opera sobre la data existente. Cuando MAAT.1 aporte balanza (`ledger_monthly`) y cadena (`expense_doc_chain`), se suman como tools nuevas (`maat_balanza`, `maat_pnl`, `maat_cadena`) sin tocar el loop.

---

## 7.bis Roadmap evolutivo: Maat 2.0 (ReAct) → 3.0 (CFO virtual)

> Plan integrado (2026-07-07, propuesta de Edgar). Principio rector: **valor por unidad de complejidad para ESTE contexto** (distribuidora de dulces, single-tenant beta, 1 dev, Kepler on-prem read-only). Tier-1 ≠ apilar tecnología; es entregar cada capacidad en la forma que funciona en nuestro stack sin cargar deuda de infra.

### Estado base (ya shippeado, local)
| | Capacidad | Estado |
|---|---|---|
| 1.0 | Chat tool-use + conocimiento + balanza/cadena + navegable/proactiva/visual/confiable + motor de 10 detectores + bandeja + aprendizaje L2 | ✅ MAAT.0/1/2/3/3.1 (commits 0ee4b64…cce2435) |

**Corrección de diagnóstico:** el "Maat 1.0 = enrutador semántico de 1 tool" NO aplica — `MaatChatService.ask()` ya es un **bucle ReAct** (`while`, multi-tool, feedback al modelo; evidencia en smoke: `iter=5`, encadena `maat_proveedor`→`maat_alertas`). El salto a 2.0 es **endurecer** ese loop, no crearlo.

### Maat 2.0 — Endurecimiento ReAct (MAAT.7) · 🔨 EN CURSO
Cambios sobre el loop que ya existe:
1. **Ejecución paralela** de tools por turno (`Promise.all`) — antes secuencial. ✅ aplicado.
2. **`render_response`** (Structured Output): tool obligatoria de respuesta final con `narrative` + `suggested_follow_ups[]` tipados. Reemplaza el hack `[[SEGUIR]]` (regex frágil). Fallback a texto plano + `[[SEGUIR]]` legacy si el modelo no la usa. ✅ aplicado (backend); FE ya consume `suggestions`.
3. **Prompt de causa-raíz**: directiva de investigar como analista (encadenar hasta la causa, pedir varias tools por turno), +iteraciones (6→8). ✅ aplicado.
4. **Token diet columnar** `{columns,data}` en tools de lista (egresos/balanza/serie/buscar/hallazgos) — ~½ tokens. ✅ backend; **falta** `extractRows` del FE re-expandir.
5. **Z-score estadístico** (`stddev_pop`) en `salto_precio` (reemplaza `1.3×avg`) — menos falsos positivos. **Falta** (tool `maat_alertas` + detector).
6. **`maat_tomar_nota`** (scratchpad): guarda observaciones intermedias en investigaciones largas. ✅ aplicado.
- **Cierre:** completar 4/5/FE + smoke (caso causa-raíz multi-tool) + build. **~0.5 sesión restante.**

### Maat 3.0 — CFO virtual (5 pilares, forma factible) · ✅ IMPLEMENTADO 2026-07-07 (smoke 42/42)
Cada pilar entrega su **valor central** en la forma correcta para NestJS/Postgres. Lo que se difiere se marca con gate explícito. **Estado:** MAAT.7 (2.0) + P1/P2/P3/P4/P5 ✅ en código local, verificados por smoke; pendiente prod (misma tanda acumulada + `ANTHROPIC_API_KEY`).

| # | Pilar (visión Edgar) | Implementación factible (lo que haremos) | Se DIFIERE (con gate) | Sprint |
|---|---|---|---|---|
| **P2** | Proactividad event-driven (BullMQ + push) | El cron de MAAT.2 (@3AM) ya escanea → al aparecer un hallazgo **crítico nuevo**, emite alerta `AlertsGateway` (Socket.IO) + Web Push (`commercial-push`) al gerente. Reusa infra existente. | Cola BullMQ/RabbitMQ (proyecto ya decidió "no queue hasta Fase F"); webhooks reales del ERP (Kepler on-prem sin push — llega por import) | **MAAT.8** |
| **P3** | HITL / escritura en ERP | `finance.proposed_actions` + tool `maat_proponer_accion` → estado `pending_approval` (ADR-013) → botón "Aprobar" → ejecuta efecto **en NUESTRAS tablas** + audit. Maat pasa de avisar a proponer trabajo rastreable. | **Escribir pólizas en Kepler** (read-only/on-prem/ofuscado — inseguro y no sancionado); la corrección contable real la hace un humano en Kepler | **MAAT.9** |
| **P4** | Prescriptiva / What-if | Tool `maat_simular_flujo`: proyección **determinista** de flujo de caja a 3 escenarios (optimista/realista/pesimista) desde `ap_provider`+`expense_doc_chain` (ej. "retrasar pagos 15 días"). | Monte Carlo estocástico (overkill v1; el determinista da el 80%) | **MAAT.10** |
| **P1** | Multi-agente (CrewAI/LangGraph) | Sub-agente **in-process**: tool `maat_investigar_a_fondo(tema)` corre un sub-loop ReAct con persona "Auditor" + toolset acotado y devuelve hallazgo estructurado. Delegación real sin framework. | CrewAI (es **Python**, no corre en runtime NestJS); LangGraph-JS (dep pesada). Gate: si el agente único + sub-agente se queda corto | **MAAT.11a** |
| **P5** | GraphRAG / Neo4j (colusión) | Tool `maat_red_proveedores`: grafo de proveedores con **CTE recursivo en Postgres** sobre la data que SÍ tenemos (RFC/nombre near-dup/patrones de beneficiario). | **Neo4j + GraphRAG**: el caso estrella (representante legal / cuenta bancaria / dirección compartida) exige data que NO ingerimos (201 es "plana"). Gate: cuando ingiramos esa data forense Y el SQL recursivo se quede corto | **MAAT.11b** |

### Secuencia y dependencias
```
MAAT.7 (2.0, base: render_response + loop) ──▶ MAAT.8 (push) ──▶ MAAT.9 (HITL) ──▶ MAAT.10 (what-if) ──▶ MAAT.11 (sub-agente + grafo)
        │                                          │                  │
        └ habilita structured output               └ reusa MAAT.2     └ reusa render_response para proponer acciones
```
- **P2/P4** son independientes entre sí y del resto (se pueden reordenar).
- **P3** se apoya en `render_response` (2.0) para proponer acciones tipadas → va después de 2.0.
- **P1** reusa `ask()` como sub-loop → va después de 2.0.
- **P5** necesita una auditoría previa de "qué aristas tenemos" (30 min) antes de codificar.
- Ritmo estimado: **~0.5–1 sesión por sprint** (5–6 sesiones para todo 3.0), commit + smoke por pilar.

### Gates de infra pesada (NO se hacen sin cruzar el gate)
| Tecnología | Gate para adoptarla |
|---|---|
| CrewAI / LangGraph (MAS framework) | El agente único + sub-agente in-process demuestra ser insuficiente en amplitud |
| BullMQ / RabbitMQ (cola) | Fase F (decisión de proyecto) o webhooks reales del ERP |
| Neo4j / GraphRAG | Ingesta de representante legal + cuenta bancaria + dirección, y el CTE recursivo se queda corto |
| pgvector en `finance.knowledge` | knowledge > ~100 entradas (hoy 27; ILIKE alcanza) |

---

## 8. Decisiones abiertas (necesitan OK de Edgar/negocio)

1. **Privacidad:** cada turno de chat envía filas financieras (las que devuelven las tools) a la API de Anthropic. Es la misma postura que Thot Chat y el OCR ya en producción — la API no entrena con datos de clientes — pero finanzas es más sensible: **confirmar explícitamente**.
2. **Nombre:** "Maat" (propuesto, consistente con Thot/Horus). Cambiable sin costo hasta MAAT.0.
3. **Costo LLM:** solo el chat y el parte semanal usan LLM (motor y feeds son SQL puro). Estimado: centavos por conversación con Sonnet 5; presupuesto mensual esperado bajo, se mide en `chat_messages.tokens_*` desde el día 1.
4. **`ANTHROPIC_API_KEY` en Railway** — mismo pendiente que Sprint VQ; MAAT.3 lo necesita en prod.
5. **GX.4.3b se absorbe en MAAT.1** (recomendado: la cadena sirve al detector #8 y al drill al mismo tiempo) — o se hace antes como quick-win independiente.

## 9. Riesgos

- **Calidad del feed = techo de la AI.** El bug conocido de existencia (kdil.c9) NO afecta estos feeds, pero toda familia nueva de la balanza necesita el mismo rigor de verificación contra Kepler que tuvo GX (spot-checks documentados).
- **Concurrencia de threads** sobre `/finanzas/*` — coordinar como en GX.4 (el otro thread ya movió egresos a Finanzas).
- **Confianza del usuario:** una alucinación de números mata el proyecto → el gate de MAAT.3 son las golden-questions verificadas; el system prompt prohíbe números sin tool.
- **Scope creep del motor:** 14 reglas v1 es el tope; nuevas reglas después de medir precisión de las primeras (no antes).

---

*Relación con lo existente: Maat NO toca `commercial-intelligence` (Thot) ni `libs/trade` (Horus). Reusa: infra AI Fase K (`ANTHROPIC_API_KEY`, patrón fetch), patrón chat de Fase TC, patrón learning de Horus L, feeds GX. Los endpoints `/commercial/analytics/expenses*` actuales siguen siendo la fuente del frontend de egresos — Maat los consume vía su propio query-service, no los duplica hacia fuera.*
