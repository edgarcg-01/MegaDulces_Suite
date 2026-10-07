# Análisis de patrones de comunicación — Trade Marketing

> Audit + roadmap de qué patrones de comunicación usa la app y cuáles necesitará para las fases pendientes (E/F/G/H/I).
>
> **Última actualización:** 2026-05-27 · **Decisión:** mantener stack actual; Redis+BullMQ se agrega cuando arranque Fase F.

---

## En uso hoy

| Patrón | Implementación | Casos |
|---|---|---|
| **REST HTTP** | Endpoints `/api/*` (Nest controllers) | Todo CRUD + Match-AI |
| **WebSockets** (Socket.IO 4.8) | `/reports` namespace + `/alerts` namespace | Realtime broadcast de capturas + alertas con tenant rooms |
| **Cron jobs** (`@nestjs/schedule`) | AnalyticsRefresh 15m · AlertsScanner 5m · RecommendationsRefresh nightly · EmbeddingSync 15m | Workers periódicos in-process |
| **Polling cliente** | `offline-sync.service.ts` + `geo-validation.service.ts` | Sync offline + GPS |
| **RxJS debounce** | Búsquedas y captura events | Throttle cliente |

## NO instalado (libs ausentes)

`redis`, `ioredis`, `bullmq`, `bull`, `kafkajs`, `amqplib`, `@nestjs/microservices`, `graphql`, `@grpc/grpc-js`.

## Roadmap por fase pendiente

| Fase | Necesidad | Patrón a sumar | Cuándo |
|---|---|---|---|
| **F — WhatsApp Bot** | Recibir webhooks Meta/360dialog · responder con Claude · queue para picos | **Webhooks receiver** + **BullMQ + Redis** + opcional **SSE** streaming | Al arrancar F |
| **H — Fintech wallet** | Webhooks Conekta/MercadoPago · idempotencia · retry partner caído | **Webhooks** + **Idempotency-Key middleware** + **BullMQ retry exponencial** | Al arrancar H |
| **I — WS scaling Railway** | Multi-instancia: WS no comparten estado | **socket.io-redis-adapter** | Al deploy multi-instance |
| **G — Growth campañas** | `order.confirmed` → trigger promo | **EventEmitter2** in-process o **Redis pub/sub** | Al formalizar event bus |
| **E — Remote Manager** | Leads a agentes en tiempo real | Ya cubierto con Socket.IO actual | — |
| **K.7 — AI vision** (deferred) | Embedding de fotos 2-5s | **BullMQ** para evitar bloqueo | Si se activa K.7 |

## Mejoras opcionales sobre lo actual

- **EmbeddingSyncService (K-sync)**: migrar de `@Cron` simple a **BullMQ con backoff exponencial** cuando exista Redis. Hoy: si Voyage cae 1h, reintenta cada 15m sin escalado.
- **Cloudinary photo upload**: subida síncrona en `addExhibicion()`. Mobile con red débil bloquea. Mitigado por Capacitor+Dexie offline-first, pero a queue ideal cuando exista BullMQ.
- **Alerts hooks**: `OrdersService.confirm/fulfill` llama directo a `AlertsService`. Acoplamiento. **EventEmitter2** desacopla cuando crezca a 3+ listeners.
- **Notificaciones WS solo "live"**: si colaborador estaba offline, no ve la alerta. Persistir en tabla `alerts_inbox` (pendiente en plan C, deferred).

## Descartado para este proyecto (con razón)

| Patrón | Razón |
|---|---|
| gRPC | Monolito Nest. Sin split de microservicios, no aporta sobre REST |
| GraphQL | Frontend interno con DTOs ya tipados. Adoptar = trabajo grande sin ROI |
| SOAP / XML-RPC / JSON-RPC | Sin integraciones legacy/banca |
| MQTT / CoAP | No es IoT (cambiaría si Mega Dulces pone sensores en exhibidores) |
| WebRTC | Sin audio/video peer-to-peer |
| OPC UA | No es manufactura industrial |

## Recomendación de inversión

**Una sola adquisición desbloquea 4 fases**: cuando arranque Fase F, agregar **Redis + BullMQ + socket.io-redis-adapter** en un solo sprint dedicado (½–1 día).

- Costo Railway: ~$5/mes plugin Redis.
- Beneficio: F (queue WhatsApp) + G (event bus) + H (idempotency fintech) + I (WS scaling) + bonus en K-sync (backoff exponencial).

Hasta entonces, el stack `REST + Socket.IO + Cron` cubre el MVP beta sin gaps reales.
