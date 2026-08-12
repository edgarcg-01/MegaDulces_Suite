# Fase INFRA — Endurecimiento de infra + worker-tier

> **ADR-043.** Activar/separar, no re-arquitecturar. Monolito modular + worker-tier + broker de colas. Todo por toggle, default OFF, prod intacto hasta validar. Complementa ADR-035 (`feeds-ingest`).

**Estado global:** 🔨 EN CURSO (arranque 2026-08-12)
**Persona:** único dev (Edgar) + plataforma (Railway + on-prem `.249`).

---

## Por qué (diagnóstico)

Un solo proceso NestJS carga REST + 6 gateways WS + ~40 `@Cron` + IA de minutos + refresh de MVs, desplegado como 1 servicio Railway. Efectos medidos/vividos:

- **OOM → ECONNRESET/502**: scans/IA/MV compiten por RAM con el tráfico web.
- **Clavado a 1 instancia**: con N instancias del API los ~40 crons se disparan N veces (doble GPS poll, doble scan Maat, doble refresh de MV).
- **IA en el request-path sin límite de concurrencia**: `POST /supervisor-ai/vision/scan` (N fotos × 30s), sub-agente deep de Maat (12 iter), extracción de tickets — cada uno ocupa un request minutos.
- **`nightly` = tren de ~55 importers en serie** (frágil: un paso atorado retrasa todo).
- **Secretos en `.env`** (incidente de creds expuestos, rotación pendiente).
- **Observabilidad = solo Sentry** (errores) → no hay métricas/traces para diagnosticar el OOM.
- **Media por Cloudinary** con egress caro.

## Qué NO se hace (anti-scope)

Microservicios por dominio · Kubernetes · Kafka/RabbitMQ/gRPC · Terraform · cambiar de motor de DB o meter ORM · migrar Express→Fastify (diferido, se revisita si el OOM persiste).

---

## Sprints (top-5 en orden)

Leyenda de estado: ⬜ TODO · 🔨 EN CÓDIGO · 🧪 PROBADO · 🚀 STAGING · ✅ PROD · ⚠️ BLOCKED

### INFRA.1 — Secretos → bóveda + rotación
- ⬜ **INFRA.1.1** Auditar `.env` / `.env.example`: inventario de secretos, cuáles están en git history / expuestos (cruzar con incidente de creds).
- ⬜ **INFRA.1.2** Elegir gestor (Infisical self-host en `.249` **o** Doppler cloud) — **PAUSA: cuenta/instancia de Edgar**.
- ⬜ **INFRA.1.3** Abstracción de config: la app ya lee `process.env` vía `@nestjs/config`; inyectar los secretos desde la bóveda al entorno de Railway/worker (sin tocar código de lectura).
- ⬜ **INFRA.1.4** Rotar todos los creds expuestos (DBs prod, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `MAGNI_*`, JWT secret, ContPAQi RO).
- ⬜ **INFRA.1.5** `gitleaks` ya corre en CI — verificar `.gitleaks.toml` cubre los patrones nuevos.

### INFRA.2 — Observabilidad (pino + OTel + Grafana)
- ⬜ **INFRA.2.1** `nestjs-pino`: logs JSON estructurados (reemplaza `Logger` en boot + request-context; mantener niveles). Correlación por request-id.
- ⬜ **INFRA.2.2** OpenTelemetry SDK en el API + worker: traces HTTP + DB (knex) + llamadas Anthropic/Voyage. Exportador OTLP.
- ⬜ **INFRA.2.3** Stack de colección: levantar `ops/observability/` (Grafana + Loki + Prometheus) en `.249` **o** Grafana Cloud free — **PAUSA si cloud: cuenta de Edgar**.
- ⬜ **INFRA.2.4** Métricas clave: RAM/heap del proceso, latencia p50/p95 por ruta, jobs de cola (backlog/duración/fallos), duración de crons vía `analytics.cron_runs` (ya existe heartbeat).
- ⬜ **INFRA.2.5** Dashboard "salud del proceso" + alerta de RAM > umbral (precursor del OOM).

### INFRA.3 — Worker-tier con pg-boss (núcleo)
- ⬜ **INFRA.3.1** `libs/platform-core/queue`: wrapper de `pg-boss` sobre el Postgres nuevo (schema `pgboss.*`). Provider + toggle `ENABLE_WORKER_QUEUE`. Null-safe si falta (como `feeds-ingest`).
- ⬜ **INFRA.3.2** Modo de arranque `WORKER=true`: mismo `main.ts`/AppModule, pero **no** levanta HTTP/WS — solo registra los handlers de cola + los `@Cron` migrados. `ScheduleModule` solo activo en el worker (el API deja de correr crons).
- ⬜ **INFRA.3.3** Migrar **1 cron pesado de prueba**: `EmbeddingSyncService` (cada 15 min, batch Voyage) → job pg-boss. Validar que corre en el worker y NO en el API.
- ⬜ **INFRA.3.4** 2º servicio Railway `worker` (mismo Dockerfile, `WORKER=true`, sin `PORT`/nginx). Verificar 1 sola ejecución del cron.
- ⬜ **INFRA.3.5** Migrar el resto de crons por dominio detrás del toggle (ráfaga nocturna 2-4 AM primero). API multi-instancia deja de duplicar.
- ⬜ **INFRA.3.6** Encolar la IA pesada del request-path (`vision/scan`, ReAct deep) → job + respuesta 202 + status por WS/SSE. Límite de concurrencia hacia Anthropic (`p-limit`/semáforo) en el worker.

### INFRA.4 — Media → Cloudflare R2
- ⬜ **INFRA.4.1** Bucket R2 + credenciales — **PAUSA: cuenta R2 de Edgar**.
- ⬜ **INFRA.4.2** Adapter de storage sobre `@aws-sdk/client-s3` (ya instalado); puerto `MEDIA_STORAGE_PORT` con impl Cloudinary (actual) y R2 (nueva), toggle.
- ⬜ **INFRA.4.3** Migrar subidas nuevas a R2; back-migración de assets existentes diferida.

### INFRA.5 — CI extendido
- ⬜ **INFRA.5.1** `ci.yml`: agregar job `nx affected -t lint,test` además del build actual.
- ⬜ **INFRA.5.2** Correr `node database/run-all-tests.js` (regression) en CI contra una DB efímera (service Postgres en Actions) o marcarla como job manual si necesita data.
- ⬜ **INFRA.5.3** Pin `engines.node` en `package.json` (Node 20) + plan Node 22 LTS.

---

## Orden de ejecución y pausas

1. INFRA.1 (secretos) → **pausa INFRA.1.2** (cuenta).
2. INFRA.2 (observabilidad) → **pausa INFRA.2.3** si cloud.
3. INFRA.3 (worker-tier) → **sin pausas externas** (núcleo, 100% código; ataca el OOM).
4. INFRA.4 (R2) → **pausa INFRA.4.1** (cuenta).
5. INFRA.5 (CI) → sin pausas.

Los pasos 100% código de cada sprint avanzan aunque su pausa esté pendiente; los bloqueados por cuenta se dejan en ⚠️ BLOCKED hasta que Edgar provisione.

---

## Riesgos

- pg-boss sobre el mismo Postgres suma carga de cola (aceptable al volumen; migrable a Redis en Fase F).
- Separar crons al worker exige que ninguna dependencia entre crons asuma estado in-process compartido con el API (revisar EventEmitter → mover a cola donde cruce procesos).
- Migración de secretos: riesgo de downtime si un cred se rota mal; hacer por par (nuevo activo antes de revocar viejo).
