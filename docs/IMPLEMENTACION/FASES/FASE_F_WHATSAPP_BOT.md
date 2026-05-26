# Fase F — Comercio Conversacional (WhatsApp Bot)

**Duración estimada:** 12-16 semanas
**Objetivo:** clientes B2B piden por WhatsApp con bot IA. Atiende dudas, sugiere productos, deriva a humano si es necesario.

> ⚠️ **Stub — completar al cierre de Fase D**.

---

## Pre-requisitos

- ✅ Fase D cerrada.
- ✅ WhatsApp Business verification ya aprobada (trámite iniciado en Sprint A.0.4 — debería estar listo).
- ✅ ADR-006 (BSP elegido).
- ✅ ADR-007 (LLM elegido).
- ✅ Cuenta Anthropic/OpenAI con presupuesto asignado.

## Resumen de sprints

| Sprint | Tema | Semanas |
|---|---|---|
| F.0 | Integración con BSP (webhook + envío) | 2 |
| F.1 | Motor conversacional v1 (rules-based) | 4 |
| F.2 | Motor conversacional v2 (LLM + tool calling) | 8 |
| F.3 | Recomendaciones proactivas | 4 |
| F.4 | Checkpoint | — |

## Arquitectura propuesta

- **Nueva app:** `apps/conversational-api` — webhooks aislados del API principal.
- Compartido con `apps/api` vía libs y misma DB.
- Queue dedicada `whatsapp-out` con rate limiting (80 msg/s tier inicial).
- Vector search con **pgvector** en Postgres para RAG sobre catálogo + FAQs.
- Tabla `conversation_threads` por número de teléfono.

## Decisiones técnicas pendientes

- **F.0.1**: ¿BSP final? Probablemente 360dialog o Wati.
- **F.2.1**: ¿Claude vs GPT? Probablemente Claude Haiku 4.5 por costo.
- **F.2.5**: ¿Cuándo se hace handoff a humano? Threshold de "no entendí" o palabra clave.

## Entregables clave

- `POST /webhooks/whatsapp` recibe mensajes.
- Bot responde por WhatsApp con:
  - Búsqueda de productos en lenguaje natural.
  - Agregar al carrito.
  - Confirmar pedido.
  - Estado de pedido.
  - FAQs comunes.
  - Recomendaciones de canasta estratégica.
- Handoff a operador (Fase E) cuando bot no entiende.
- Dashboard de conversaciones para admin.

## Dependencias

- Catálogo + pedidos (Fase D).
- Canasta estratégica (Fase D.4).
- Remote Manager (Fase E) para handoff.

## Métricas

- % conversaciones autocompletadas sin humano.
- Tiempo medio de respuesta del bot.
- Costo medio por conversación (tokens LLM + WhatsApp fees).
- NPS de la conversación (encuesta post-pedido).

## Referencias

`PLAN_PLATAFORMA_B2B.md` sección 3 — Fase 3.
