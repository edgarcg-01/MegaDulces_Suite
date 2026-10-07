# Proyecto B — Customer Intelligence / CRM

> **Origen:** visión del Jefe Frank (WhatsApp 14-ago-2026) — "ERP + Customer Intelligence Platform" + "arquitectura de doble inteligencia" (BI presente + memoria histórica versionada del cliente).
> **Análisis:** 2026-08-15, verificado contra el código actual.
> **Tesis del proyecto:** una **sola inteligencia del cliente** que unifica todos los canales (vendedor general, vecinal, ruta directa, telemarketing). Que cada mañana el vendedor abra la app y el sistema ya haya razonado a quién atender, quién está en riesgo y qué canasta ofrecer.
> **Principio (= ADR-016, que Frank reinventó textualmente):** la DB construye la memoria comercial confiable → el ML predice → el LLM interpreta y comunica → el motor decide, el LLM **fuera del camino del dinero**. NO fine-tuning por cliente; **memoria versionada** servida a un LLM general.

Leyenda: ✅ **Completo** · 🟡 **Parcial** · ⬜ **No existe**

---

## 1. Customer 360 (la pieza central)

| # | Capacidad que pide Frank | Estado | Evidencia / brecha |
|---|---|---|---|
| 1.1 | `customer_id` único como eje de toda la memoria | ✅ | `commercial.customers` + `commercial.customer_360` (mig `20260610140000`), 1 fila/cliente, UPSERT, RLS. |
| 1.2 | Dimensiones (identidad, geografía, responsable, compra, temporalidad) | ✅ | `customer_360`: `orders_count, recency_days, frequency_90d, monetary_90d, aov, cadence_days, next_order_estimate, lifecycle_stage`. |
| 1.3 | Panel Customer 360 + drill-down | ✅ | `customer-360-panel.component`, `side-peek.component`, Command Center (`/command-center` bajo dashboard). |
| 1.4 | Lifecycle (new/active/at_risk/lost/reactivated) | ✅ | `lifecycle_stage` en `customer_360`. |

**Customer 360 está construido.** Es una vista derivada, las transacciones quedan intactas (como pide Frank §1).

---

## 2. Cadencia y comportamiento

| # | Capacidad | Estado | Evidencia / brecha |
|---|---|---|---|
| 2.1 | Cadencia natural del cliente (días entre compras, próxima esperada) | 🟡 | Existe a **nivel cliente**: `cadence_days` (mediana), `next_order_estimate`, `recency_days`, `days_since_last_order`. **Falta** nombrarlo/exponerlo como Frank lo pide y afinar promedio+desviación. |
| 2.2 | Día favorito de compra (ej. "68% los jueves") | ⬜ | `customers.visit_days` es el día **planeado de visita** (ruta), NO el **día derivado de compra**. Falta calcular `preferred_weekday`/`preferred_time_window` desde el historial. |
| 2.3 | **Canasta recurrente por cliente** | ✅ | `commercial.recommended_baskets` categoría `base` = productos que compra regularmente, con score + reason. |
| 2.4 | **`customer_sku_features` (cliente × SKU)** | ⬜ | **No existe** tabla cliente×SKU con `repurchase_probability`, `expected_repurchase_date`, `usual_quantity`, `missing_purchase_flag`. Es lo que permite "qué debería comprar y no está comprando" (§21). |
| 2.5 | **`customer_behavior_features` (feature store diario)** | 🟡 | Las features viven en `customer_360` (recalculado), no como feature store histórico diario con todos los campos que lista Frank (§20). |

---

## 3. Detección de ausencia (lo más valioso según Frank §5-6)

| # | Capacidad | Estado | Evidencia / brecha |
|---|---|---|---|
| 3.1 | Ausencia de **cliente** (dejó de comprar del todo) | ✅ | `lifecycle_stage` at_risk/lost + finding `churn_risk` (`commercial-findings.service.ts`, cadence + recency > 2× cadence) → acción `reorder_outreach`. |
| 3.2 | Ausencia de **SKU** (sigue comprando pero dejó un producto) | ⬜ | **No existe** `SKU_AUSENTE`/`missing_purchase_flag` a nivel cliente×SKU. Frank la marca como "mucho más difícil de detectar manualmente y donde la IA brilla" (§6). Depende de 2.4. |

---

## 4. Motor de señales comerciales (Commercial Signal Engine = Thot)

| # | Capacidad | Estado | Evidencia / brecha |
|---|---|---|---|
| 4.1 | Motor multi-señal que corre y genera eventos | ✅ | **Thot** (ADR-018): `intelligence.product_affinity` (market-basket lift/confidence), `zone_demand`, `pdv_presence`, `push_directives`. `thot.service.ts`. |
| 4.2 | Señales tipo RECOMPRA/ATRASO/RIESGO/CROSS-SELL/UPSELL | 🟡 | Existen: afinidad, zona, whitespace, recompra, churn_risk, reorder. **Faltan como eventos nombrados**: SKU_AUSENTE, CAÍDA_TICKET, CAÍDA_FRECUENCIA, CAMBIO_DE_PATRÓN. |
| 4.3 | El LLM recibe **contexto/señales**, no millones de tickets | ✅ | Thot Chat (`thot-chat/`, ReAct + tool providers admin/portal/vendor/compras), `thot/chat`. |
| 4.4 | Empuje dirigido (el negocio decide qué empujar) | ✅ | `push_directives` (focus_brand/new_launch/overstock_clear/promo). |
| 4.5 | Feedback loop (oferta → resultado) | 🟡 | `commerce_signals` (append-only) + `conversionByReason` atribuido a producto. **`signal_weights` NO es tabla** (solo docs); la calibración vive en `thot_commercial_rule_stats`. El loop **mide pero aún no reajusta pesos automáticamente** (bandit = pendiente). |

---

## 5. Forecasting

| # | Capacidad | Estado | Evidencia / brecha |
|---|---|---|---|
| 5.1 | Nivel Empresa+SKU y Sucursal+SKU (para compras/abasto) | 🟡 | `commercial.reorder_policy` (reorder point + safety stock + ABC-XYZ nivel de servicio) + IAD aceleración de demanda (`analytics.demand_acceleration`, Welch-Z). Es **reorden estadístico, no forecast de serie de tiempo**. |
| 5.2 | Nivel **Cliente+SKU** (para CRM) | ⬜ | No existe. Depende de 2.4 y del limitante de datos (§8). Frank pide explícitamente NO usar el LLM para pronosticar (§9): serie de tiempo/ML → el LLM solo explica. |
| 5.3 | Modelo ML de serie de tiempo dedicado | ⬜ | No hay modelo/tabla de forecast; la matemática de demanda es SKU/red vía ERP. |

---

## 6. Next Best Action / agenda

| # | Capacidad | Estado | Evidencia / brecha |
|---|---|---|---|
| 6.1 | Motor de Próxima Mejor Acción | ✅ | `decision-engine.service.ts`: `nextBestAction`, `suggestedBasket`, `listDueForReorder` (urgencia por days_overdue). Endpoints `nba`, `nba/:id`, `nba/:id/basket`, `nba/:id/message`. |
| 6.2 | Acciones con confianza/impacto$/prioridad + HITL | ✅ | `commercial-actions.service.ts` (co-piloto T.R2): approve/reject/explain. Autonomy dial (`autonomy.service.ts`, mig `20260619170000`). |
| 6.3 | **Opportunity Priority Score** (prob × valor × riesgo × urgencia ÷ costo) | 🟡 | Hay priorización por urgencia e impacto$; **falta la fórmula compuesta explícita** que pondere valor esperado vs costo de visita para ordenar la agenda (§22). |
| 6.4 | Agenda comercial diaria priorizada por oportunidad | 🟡 | `daily-assignments` + "Por visitar" del vendedor (cobertura de cartera + check-in). Es **cobertura de ruta**, no agenda **ordenada por oportunidad económica**. |

---

## 7. Agentes IA

| # | Capacidad | Estado | Evidencia / brecha |
|---|---|---|---|
| 7.1 | Agente que **comunica** (redacta, no decide) | ✅ | `commerce-agent.service.ts` (`composeReorderMessage`, Haiku + fallback determinista). |
| 7.2 | Vigilante de clientes (busca anomalías diario) | 🟡 | `commercial-findings` (churn_risk) + supervisor Horus (`libs/trade/.../supervisor-agent.service.ts`, parte diario/briefing). Cubre supervisión; falta el vigilante **por cartera de vendedor** que crea tareas CRM proactivas. |
| 7.3 | Planificador comercial (agenda de la mañana) | ⬜ | No hay servicio dedicado; la agenda es UI-driven (cobertura). |
| 7.4 | Preparador de visitas (brief pre-visita) | 🟡 | Vía `vendor/thot/chat` (bajo demanda); **no un generador de brief pre-visita** automático (§13). |
| 7.5 | Recuperación de canasta / cross-sell contextual | ✅ | `recommended_baskets` (focus/exploración/innovación) + Thot afinidad cart-aware. |
| 7.6 | La visita **regresa** información (dictado → estructura) | 🟡 | `vendor_visits` (check-in/outcome) existe; **falta el dictado de resultado → IA lo estructura** (motivo pérdida SKU, seguimiento, competencia) que pide Frank (§17). |

---

## 8. Memoria comercial versionada (la segunda mitad de Frank)

| # | Capacidad | Estado | Evidencia / brecha |
|---|---|---|---|
| 8.1 | **`customer_intelligence_memory` versionada** (v36→v37, nunca sobrescribir) | ⬜ | **No existe.** Es el concepto más diferenciador de Frank (§"versionar la memoria"). Hay log de señales y de chat, pero no una **memoria narrativa + estructurada versionada por cliente**. |
| 8.2 | Memoria en dos partes: estructurada + narrativa | ⬜ | No existe (§"la memoria debería tener dos partes"). |
| 8.3 | "Customer Commercial DNA" (ritmo/canasta/valor/sensibilidad/estrategia) | 🟡 | Piezas dispersas (customer_360 + baskets + findings); **no consolidado** como objeto único. |
| 8.4 | "¿Cómo cambió nuestra interpretación del cliente en 6 meses?" | ⬜ | Depende de 8.1 (requiere historial versionado). |
| 8.5 | Gobernanza: **por qué cambió de opinión** (riesgo medio→alto con causas) | 🟡 | Los findings tienen evidencia/motivo; **falta el registro de cambio de interpretación versionado**. |
| 8.6 | Regla: el LLM reinterpreta datos pero **nunca modifica los hechos** | ✅ | Es exactamente ADR-016, ya invariante del proyecto. |
| 8.7 | Aprender de decisiones (recomendación → acción → resultado) | 🟡 | Existe medición (`conversionByReason`, `thot_commercial_rule_stats`, Horus-L / ADR-021); falta cerrar el lazo de reajuste automático de pesos. |

**Nuevo y diferenciador:** todo el bloque 8. La memoria versionada por cliente es el mayor aporte conceptual de Frank que **no** está en el repo.

---

## 9. Unificación de canales

| # | Capacidad | Estado | Evidencia / brecha |
|---|---|---|---|
| 9.1 | Vendedor / portal / televenta comparten identidad de cliente | ✅ | Los tres escriben `commercial.orders.customer_id` (apps/vendor, portal B2B, `commercial-televenta` con `call_logs`/`lead_reservations`). |
| 9.2 | **Venta ERP/ruta/mostrador unificada por cliente** | ⬜ | **NO.** `analytics.sales_by_channel_monthly` es sucursal×canal×plaza×mes; vecinal/ruta es route-grained. La venta física ERP/Wincaja **no se persiste a nivel cliente**. |
| 9.3 | Historia de venta unificada cliente × SKU (todos los canales) | ⬜ | No existe tabla materializada cliente×SKU. El ERP `ventas` **sí** tiene `tercero_id`+`producto_id` en origen, pero no se persiste a esa granularidad en la plataforma. |

---

## 10. El limitante de datos que hay que decir en voz alta

Toda la **capacidad predictiva por cliente** (cadencia fina §2.1-2.2, ausencia de SKU §3.2, forecast cliente×SKU §5.2, agenda por oportunidad §6.4, memoria versionada §8) **descansa sobre una granularidad que hoy no existe de forma unificada**:

- **App-nativo (portal / vendedor / televenta):** venta identificada por cliente ✅.
- **ERP / ruta / mostrador / vecinal:** venta agregada por ruta/sucursal/canal ⬜ — **la mayor parte del volumen físico**.

El propio sondeo de Thot ya lo documentó: *"cadencia per-tienda dormida — la venta es ruta/CEDIS, solo ~250/2945 clientes matchean `tercero_id`"*.

**Consecuencia (no invalida la visión, define la secuencia):** sin cerrar la **identidad de venta por cliente en los canales físicos**, los agentes predictivos por cliente tendrán poca base. Frank concluye lo mismo al final de su mensaje: *"primero Customer 360 + Cliente×SKU + cadencia + ausencia; cuando eso tenga calidad, forecast; al final los agentes. Si empiezan por 'un chatbot con nuestros datos' tendrán una demo bonita pero comercialmente débil."*

---

## 11. Resumen ejecutivo — qué falta realmente

**Ya lo tienes (no hay que construirlo):** Customer 360 con cadencia y lifecycle, motor Thot multi-señal (afinidad/zona/whitespace/push dirigido), Thot Chat (ReAct), canasta recomendada (base/focus/exploración/innovación), motor NBA + acciones HITL + autonomy dial, feedback medido, churn a nivel cliente, agente comunicador, supervisor Horus, identidad unificada en canales app-nativos.

**Genuinamente nuevo, ordenado:**

1. 🥇 **Cerrar identidad de venta por cliente en canales físicos** (9.2/9.3) — *desbloquea todo lo demás.* Persistir venta cliente×SKU desde el ERP `ventas` (`tercero_id` ya existe) + empujar captura de `customer_id` en ruta/tienda.
2. 🥈 **`customer_sku_features` + ausencia de SKU (2.4/3.2) + día favorito (2.2)** — sobre la base del punto 1.
3. 🥉 **Memoria comercial versionada `customer_intelligence_memory` (bloque 8)** — el diferenciador conceptual de Frank.
4. **Opportunity Priority Score + agenda por oportunidad (6.3/6.4)** + **dictado de resultado de visita (7.6)** + **planificador/preparador de visitas (7.3/7.4)**.
5. **Forecast cliente×SKU (5.2)** — al final, cuando 1-2 tengan calidad.

**El error a evitar (lo dice Frank y coincide con tu ADR-016):** no poner el agente/LLM primero. Primero la memoria y las señales; el agente razona sobre algo real.

---

## 12. Relación con otras fases del repo

`FASE_M_MOTOR_INTELIGENCIA` (ADR-016) · `FASE_THOT_MOTOR` (ADR-018) · `FASE_TC_THOT_CHAT` · `FASE_HORUS_SUPERVISOR_AI` / `FASE_HORUS_IQ` (ADR-020/021, aprendizaje) · `FASE_E_TELEVENTA` · `FASE_VR_VENTA_EN_RUTA` (ADR-032) · `FASE_RA_REABASTECIMIENTO` (reorden estadístico) · Modo Vendedor (apps/vendor).
