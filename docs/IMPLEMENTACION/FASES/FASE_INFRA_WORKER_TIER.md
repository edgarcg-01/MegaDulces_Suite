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

### INFRA.2 — Observabilidad (pino + OTel + Grafana) · Decisión: **self-host .249**
- 🧪 **INFRA.2.1** `nestjs-pino`: logs JSON (toggle `LOG_JSON=true`, default OFF). Mixin inyecta `trace_id`/`span_id` del span OTel → enlaza log↔trace. Redacta authorization/cookie/ingest-key. Build verde. (`app.module.ts` + `main.ts`)
- 🧪 **INFRA.2.2** OpenTelemetry SDK (`apps/api/src/otel.ts`, import-first, inerte sin `OTEL_EXPORTER_OTLP_ENDPOINT`). Auto-instrumenta HTTP/Express/pg/socket.io. Build verde.
- 🔨 **INFRA.2.3** Stack LGTM self-host en `.249`: `ops/observability/grafana-stack.yml` (Grafana+Loki+Tempo+Prometheus+otel-collector) + configs provisionadas. **Tu acción**: `docker compose up` + exponer `:4318` por Cloudflare Tunnel (resuelve LAN→nube) + setear envs en Railway.
- ⬜ **INFRA.2.4** Métricas clave: RAM/heap, latencia p50/p95 por ruta, jobs de cola, duración de crons (`analytics.cron_runs`).
- ⬜ **INFRA.2.5** Dashboard "salud del proceso" + alerta de RAM > umbral (precursor del OOM).

### INFRA.3 — Worker-tier con pg-boss (núcleo) · **sin cuentas externas**
- 🧪 **INFRA.3.1** `libs/platform-core/queue`: `QueueService` (pg-boss v12 sobre `DATABASE_URL_NEW`, schema `pgboss`, self-migra). Toggle `ENABLE_WORKER_QUEUE`, null-safe/inerte por default, produce en cualquier proceso, consume/agenda solo en worker. Build verde.
- 🧪 **INFRA.3.2** Modo `WORKER=true`: `bootstrapWorker()` en `main.ts` usa `createApplicationContext` (sin HTTP/WS; los `@Cron` disparan igual). Mismo binario. Build verde.
- 🧪 **INFRA.3.3** Migrado **1 cron de prueba**: `EmbeddingSyncService.tick()` (cada 15 min) con `shouldRunInProcessCron()` — patrón de 1 línea para el resto. Con worker-tier ON el API lo saltea.
- 🔨 **INFRA.3.4** 2º servicio Railway `worker`: `railway.worker.json` (mismo Dockerfile, `startCommand=node dist/apps/api/main.js`, sin healthcheck/preDeploy). **Tu acción**: crear el servicio + env `WORKER=true`+`ENABLE_WORKER_QUEUE=true` + verificar 1 sola ejecución del cron. **⚠️ falta verificación en runtime** (no automatizable desde CLI; correr `WORKER=true ENABLE_WORKER_QUEUE=true node dist/apps/api/main.js` local primero).
- ⬜ **INFRA.3.5** Migrar el resto de crons por dominio con el mismo `shouldRunInProcessCron()` (ráfaga nocturna 2-4 AM primero). API multi-instancia deja de duplicar.
- ⬜ **INFRA.3.6** Encolar la IA pesada del request-path (`vision/scan`, ReAct deep) → `send()` + respuesta 202 + status por WS/SSE. Límite de concurrencia hacia Anthropic (`p-limit`/semáforo) en el worker.

### INFRA.4 — Media → Cloudflare R2 · **adapter ya existe**
- ✅ **INFRA.4.2** Adapter `ObjectStorageService` (`libs/platform-core/src/lib/storage/object-storage.service.ts`) YA construido: S3-compatible (`forcePathStyle`+`region:'auto'`+`endpoint` = R2), `isConfigured()`-gated, URLs prefirmadas, ya reemplaza Cloudinary en comprobantes financieros. R2 = flip de config (`S3_ENDPOINT`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`/`S3_BUCKET`).
- ⬜ **INFRA.4.1** Bucket R2 + credenciales — **PAUSA: cuenta R2 de Edgar** (endpoint `https://<accountid>.r2.cloudflarestorage.com`, region `auto`).
- ⬜ **INFRA.4.3** (opcional) Migrar a R2 el resto de media aún en Cloudinary (fotos de captures/visión). Diferido — no es del path crítico del OOM.

### INFRA.5 — CI extendido
- ✅ **INFRA.5.1** `ci.yml`: job `verify` con `nx affected -t lint test` (+ `nx-set-shas`). Blast radius acotado a lo tocado (no revienta por deuda de lint ajena).
- 🔵 **INFRA.5.2** Regression `run-all-tests.js`: se deja como gate local/manual (necesita API arriba + multi-DB sembrada; no encaja en el gate de Actions sin infra pesada).
- ✅ **INFRA.5.3** `engines.node` pineado (`>=20 <21`) en `package.json`. Plan Node 22 LTS diferido.

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

---

## Apéndice INFRA.1 — Auditoría de secretos (2026-08-12)

**Estado del `.env`:** ✅ NO trackeado por git, ✅ en `.gitignore`. 47 llaves. Drift corregido: 15 llaves que estaban en `.env` sin documentar se agregaron a `.env.example` como placeholders.

**Postura de gitleaks (ya en CI):** `.gitleaks.toml` extiende default + regla propia para connection strings con password. **Allowlist deliberado** de creds LAN/dev (`superoot`/`postgres`/`kepler123` sobre `localhost`/`127.0.0.1`/`192.168.*`) — no son secretos de prod. Los creds de prod (`*.proxy.rlwy.net` con password real) SÍ se marcan. Postura correcta.

**Reencuadre del "incidente":** los ~456 matches de `kepler123`/`superoot` en ~40 scripts importer son **creds RO de LAN embebidos como fallback** (`process.env.X || 'postgresql://platform_ro:...@192.168.x'`) + topología LAN. Riesgo bajo mientras el repo sea privado, pero: exponen IPs internas + password RO si el repo se filtra. Los secretos **de prod** (los que importan) viven solo en `.env` (local) y en Railway env vars.

### Inventario de SECRETOS reales (viven en `.env` / Railway) — a mover a bóveda + rotar
| Secreto | Uso | Rotable sin downtime |
|---|---|---|
| `DATABASE_URL` (legacy prod), `DATABASE_URL_NEW`, `_NEW_RUNTIME`, `APP_RUNTIME_PASSWORD` | Postgres prod | Sí, por par (crear rol/pass nuevo → cambiar env → revocar viejo) |
| `JWT_SECRET` | Firma de tokens | ⚠️ rotarlo invalida sesiones activas → re-login masivo (coordinar) |
| `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `GROQ_API_KEY` | LLM / embeddings / STT | Sí (regenerar en el dashboard del proveedor) |
| `CLOUDINARY_API_SECRET` / `CLOUDINARY_URL` | Media actual | Sí (hasta migrar a R2, INFRA.4) |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | Storage R2/S3 | Sí |
| `MAGNI_USER` / `MAGNI_PASS` | GPS flota (compartido) | Sí — rotar el compartido (ADR-034 ya lo pide) |
| `STORE_INGEST_KEY` | Auth M2M poller↔ingest | Sí, por par (cambiar en ambos lados) |
| `DENUE_TOKEN`, `MAPBOX_TOKEN` | INEGI / Mapbox | Sí |
| `SW_TOKEN` / `SW_USER`+`SW_PASSWORD` | PAC timbrado CFDI | Sí (regenerar en SW) |
| WhatsApp: `WHATSAPP_ACCESS_TOKEN` / `_APP_SECRET` / `_VERIFY_TOKEN` | Bot Meta | Sí (Meta app) |

### ⚠️ PAUSA para Edgar (bloquea el resto de INFRA.1)
1. **Elegir bóveda**: Infisical self-host en `.249` (Docker, sin costo, alinea con Jenkins) **vs** Doppler cloud (0-config, free tier 1 dev). Recomendación: **Infisical self-host** (ya tienes `.249` + Docker; los secretos no salen de tu infra).
2. **Rotar** los secretos de la tabla de arriba (empezar por los de proveedor externo — API keys — que son sin-downtime; dejar `JWT_SECRET` para una ventana coordinada).
3. Cargar los secretos en la bóveda e **inyectarlos al env de Railway/worker** (Infisical/Doppler tienen integración nativa con Railway).

### Diferido (post-bóveda, code-only pero coordinado)
- **Codemod de fallbacks**: reemplazar los `|| 'postgresql://...'` hardcodeados de los ~40 importers por un helper compartido `database/importers/lib/branch-db.js` que lea la topología+creds de env. NO hacer antes de garantizar que el runner on-prem tiene el env seteado (rompería los feeds). Es la deuda que cierra el hardcodeo de LAN.
