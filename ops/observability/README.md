# Observabilidad + uptime (self-hosted en .249)

## Uptime Kuma — usalo ya

Monitorea la URL pública de Railway y te avisa cuando se cae.

```bash
docker compose -f ops/observability/docker-compose.yml up -d uptime-kuma
```

1. Abrí `http://localhost:3001`, creá el usuario admin.
2. Add New Monitor → tipo HTTP(s) → URL = `https://<tu-app>.railway.app/api/health` → intervalo 60s.
3. Settings → Notifications → WhatsApp/Telegram/Email para las alertas.

## Error tracking

**Ahora (prod en Railway): usá Sentry SaaS free tier.** Railway (nube) no alcanza
un GlitchTip en tu LAN. Creá un proyecto en [sentry.io](https://sentry.io) (free:
5K eventos/mes), copiá los DSN (uno para el API Node, uno para Angular) y seteálos
como env en Railway (`SENTRY_DSN`) + en el build de Angular (`view` environment).
El SDK ya está wireado en el código (inerte sin DSN).

**Después (prod on-prem): GlitchTip.** Mismo SDK, solo cambiás el DSN al de GlitchTip.

```bash
# generá el secret y el dominio primero (ver .env.example)
export GLITCHTIP_SECRET_KEY=$(openssl rand -hex 32)
docker compose -f ops/observability/docker-compose.yml up -d gt-postgres gt-redis glitchtip-migrate glitchtip-web glitchtip-worker
```

Abrí `http://localhost:8000`, creá la cuenta + organización + proyecto, y usá ese DSN.

---

## Métricas + logs + traces — stack LGTM (INFRA.2, ADR-043)

Grafana + Loki (logs) + Tempo (traces) + Prometheus (métricas) + OTel Collector, en **un solo servicio** (`grafana/otel-lgtm`). Es lo que deja de debuggear el OOM a ciegas.

### ✅ Camino elegido: en **Railway** (decisión Edgar)

Ventaja: el API y el worker le hablan por la **red privada de Railway** → tráfico interno gratis, **sin Cloudflare Tunnel**. Solo Grafana se expone público para verlo.

**Deploy (dashboard Railway):**
1. Nuevo servicio en el MISMO proyecto → source = este repo → `Config Path = railway.observability.json` (usa `ops/observability/railway/Dockerfile`, imagen `grafana/otel-lgtm`).
2. Variables del servicio: `GF_SECURITY_ADMIN_PASSWORD=<algo fuerte>` (usuario `admin`).
3. **Volume** para persistir: montá un Railway Volume en el dir de datos de la imagen (Grafana/Prometheus/Loki/Tempo) — sin él, cada redeploy borra el histórico. Para un tablero de diagnóstico, efímero también sirve al arranque.
4. **Networking → Public**: exponé el puerto **3000** (Grafana UI). Dejá `4317`/`4318` SIN dominio público (solo red privada).
5. Copiá el hostname interno del servicio: `<nombre>.railway.internal`.

**En los servicios API y worker (Railway), seteá:**
```
OTEL_EXPORTER_OTLP_ENDPOINT=http://<nombre>.railway.internal:4318
OTEL_SERVICE_NAME=trade-api          # trade-worker en el worker-tier
LOG_JSON=true                        # logs JSON pino → OTLP → Loki
LOG_LEVEL=info
```

Con eso: **traces** (auto-instrumentación http/pg/socket.io) + **logs** (pino shippea por OTLP a Loki, con `trace_id` para saltar log↔trace) + **métricas** aterrizan en Grafana. Sin `OTEL_EXPORTER_OTLP_ENDPOINT` el API es inerte; sin `LOG_JSON=true` los logs siguen en formato Nest clásico → opt-in, prod no cambia hasta prenderlos.

> **Nota:** `grafana/otel-lgtm` es el arranque pragmático (Grafana lo marca para dev/test: storage local, sin HA). Para 1 API sobra. Si crece → partir en servicios separados o Grafana Cloud.
>
> **Feeds/worker on-prem** (corren en `.249`): pueden apuntar a este mismo servicio por su **dominio público** de Railway (`https://<obs>.railway.app`, OTLP `:4318` si lo exponés) o quedarse solo con logs de stdout.

### Alternativa: self-host en `.249`

`ops/observability/grafana-stack.yml` (5 servicios separados) + `docker compose up -d`. Requiere exponer `:4318` por Cloudflare Tunnel para que Railway lo alcance. Quedó como fallback; el camino primario es Railway (arriba).

### Dashboard provisionado (aparece solo)

Al levantar el servicio, Grafana carga el dashboard **"Trade — Salud del proceso (OOM)"** (carpeta *Trade*), horneado en la imagen: RAM del proceso (RSS = señal del OOM), memoria del sistema, CPU, HTTP req/s y latencia p95, por `service_name` (trade-api / trade-worker). Requiere que el API exporte métricas → ya cableado en `apps/api/src/otel.ts` (metricReader OTLP + host-metrics). Si un panel dice *No data*, el nombre exacto de la métrica difiere por versión → ajustá la query (el propio panel lo explica).

### Qué ver primero (para el OOM)

- **RAM del proceso** (`process_memory_usage_bytes`): la curva que sube hasta el ECONNRESET/502. Armá una alerta de umbral = el precursor del OOM.
- **Loki**: filtrá por `level=error` y por `trace_id` (cada log lleva el trace_id del span activo → click salta a Tempo).
